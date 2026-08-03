import { createHash, randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fchmodSync,
  fstatSync,
  ftruncateSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  opendirSync,
  readFileSync,
  readlinkSync,
  readSync,
  realpathSync,
  renameSync,
  rmdirSync,
  rmSync,
  statfsSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
  writeSync
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, posix, relative, resolve, sep, win32 } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual, parseArgs } from "node:util";

const ENTRY_PROTOCOL = "openwrangler-managed-checkout-v2";
const LOCK_PROTOCOL = "openwrangler-checkout-operation-lock-v2";
const LOCK_RELEASE_PROTOCOL = "openwrangler-checkout-operation-lock-release-v2";
const RECEIPT_PROTOCOL = "openwrangler-checkout-receipt-v2";
const CLEANUP_REQUEST_PROTOCOL = "openwrangler-cleanup-request-v2";
const RETIREMENT_PLAN_PROTOCOL = "openwrangler-retirement-plan-v1";
const RETIREMENT_CHECKS_PROTOCOL = "openwrangler-retirement-deferred-checks-v1";
const ARCHIVE_RECEIPT_PROTOCOL_V1 = "openwrangler-checkout-archive-v1";
const ARCHIVE_RECEIPT_PROTOCOL = "openwrangler-checkout-archive-v2";
const ARCHIVE_COMPLETION_PROTOCOL = "openwrangler-checkout-archive-completion-v1";
const QUARANTINE_EVENT_PROTOCOL = "openwrangler-checkout-quarantine-event-v1";
const MANAGER_BOOTSTRAP_PROTOCOL = "openwrangler-checkout-manager-bootstrap-v1";
const LEGACY_ADOPTION_PROTOCOL = "openwrangler-legacy-checkout-adoption-v1";
const LEGACY_ADOPTION_PROTOCOL_V2 = "openwrangler-legacy-checkout-adoption-v2";
const LEGACY_ADOPTION_REQUEST_PROTOCOL = "openwrangler-legacy-checkout-adoption-request-v1";
const LEGACY_ADOPTION_REQUEST_PROTOCOL_V2 = "openwrangler-legacy-checkout-adoption-request-v2";
const LEGACY_ADOPTION_COMPLETION_PROTOCOL = "openwrangler-legacy-checkout-adoption-completion-v1";
const LEGACY_ADOPTION_COMPLETION_PROTOCOL_V2 = "openwrangler-legacy-checkout-adoption-completion-v2";
const LEGACY_BATCH_MANIFEST_PROTOCOL = "openwrangler-legacy-checkout-batch-v1";
const LEGACY_BATCH_MANIFEST_PROTOCOL_V2 = "openwrangler-legacy-checkout-batch-v2";
const LEGACY_BATCH_REVIEW_PROTOCOL = "openwrangler-legacy-checkout-batch-review-v1";
const LEGACY_BATCH_REVIEW_PROTOCOL_V2 = "openwrangler-legacy-checkout-batch-review-v2";
const LEGACY_DEPENDENCY_CATALOG_PROTOCOL = "openwrangler-legacy-dependency-catalog-v1";
const LEGACY_DEPENDENCY_UNIVERSE_PROTOCOL = "openwrangler-legacy-dependency-universe-v2";
const LEGACY_ARCHIVE_REQUEST_PROTOCOL_V1 = "openwrangler-legacy-recovery-archive-request-v1";
const LEGACY_ARCHIVE_REQUEST_PROTOCOL = "openwrangler-legacy-recovery-archive-request-v2";
const LEGACY_ARCHIVE_RECEIPT_PROTOCOL_V1 = "openwrangler-legacy-recovery-archive-v1";
const LEGACY_ARCHIVE_RECEIPT_PROTOCOL = "openwrangler-legacy-recovery-archive-v2";
const LEGACY_ARCHIVE_COMPLETION_PROTOCOL_V1 = "openwrangler-legacy-recovery-archive-completion-v1";
const LEGACY_ARCHIVE_COMPLETION_PROTOCOL = "openwrangler-legacy-recovery-archive-completion-v2";
const RETIREMENT_SWEEP_PROTOCOL = "openwrangler-checkout-retirement-sweep-v1";
const LEGACY_RETIREMENT_SWEEP_PROTOCOL = "openwrangler-checkout-retirement-sweep-v2";
const RETIREMENT_TOMBSTONE_PROTOCOL = "openwrangler-checkout-retirement-tombstone-v1";
const ARTIFACT_REVIEW_PROTOCOL = "openwrangler-generated-artifact-review-v1";
const ARTIFACT_REQUEST_PROTOCOL = "openwrangler-generated-artifact-retirement-request-v1";
const ARTIFACT_ARCHIVE_PROTOCOL = "openwrangler-generated-artifact-archive-v1";
const ARTIFACT_COMPLETION_PROTOCOL = "openwrangler-generated-artifact-retirement-completion-v1";
const ARTIFACT_SWEEP_PROTOCOL = "openwrangler-generated-artifact-retirement-sweep-v1";
const ARTIFACT_RENAME_HELPER_SOURCE = String.raw`import ctypes
import os
import stat
import sys

if len(sys.argv) != 3:
    raise SystemExit(12)
source = sys.argv[1].encode("ascii", "strict")
destination = sys.argv[2].encode("ascii", "strict")
if not source or not destination or b"/" in source or b"/" in destination or b"\0" in source or b"\0" in destination:
    raise SystemExit(12)
if not stat.S_ISDIR(os.fstat(3).st_mode) or not stat.S_ISDIR(os.fstat(4).st_mode):
    raise SystemExit(12)
libc = ctypes.CDLL(None, use_errno=True)
renameat2 = getattr(libc, "renameat2", None)
if renameat2 is None:
    raise SystemExit(11)
renameat2.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]
renameat2.restype = ctypes.c_int
if renameat2(3, source, 4, destination, 1) != 0:
    os.write(2, (str(ctypes.get_errno()) + "\n").encode("ascii"))
    raise SystemExit(10)
os.write(1, b"ok\n")
`;
const MAXIMUM_COMMAND_OUTPUT_BYTES = 4 * 1024 * 1024;
const MAXIMUM_BUNDLE_HEADER_BYTES = 4 * 1024 * 1024;
const ARCHIVE_SPACE_MULTIPLIER = 8n;
const ARCHIVE_SPACE_RESERVE_BYTES = 512n * 1024n * 1024n;
const MAXIMUM_ENTRY_BYTES = 64 * 1024;
const MAXIMUM_LOCK_BYTES = 2048;
const MAXIMUM_ENTRIES = 256;
const MAXIMUM_REGISTRY_FILES = 4096;
const MAXIMUM_ENTRY_GENERATIONS = 1024;
const MAXIMUM_LOCK_FILES = 32_768;
const MAXIMUM_LOCK_GENERATIONS = 16_384;
const MAXIMUM_JSON_DEPTH = 64;
const MAXIMUM_JSON_NODES = 4096;
const MAXIMUM_GENERATED_ROOTS = 16;
const MAXIMUM_WORKTREE_RECORDS = 4096;
const MAXIMUM_WORKTREE_FIELDS = 16;
const MAXIMUM_WORKTREE_FIELD_BYTES = 8192;
const MAXIMUM_ARCHIVE_ATTEMPTS = 8;
const MAXIMUM_QUARANTINE_RECORDS = 128;
const MAXIMUM_MANAGER_BOOTSTRAP_ATTEMPTS = 8;
const MAXIMUM_LEGACY_ADOPTION_ATTEMPTS = 8;
const MAXIMUM_LEGACY_ARCHIVE_ATTEMPTS = 8;
const MAXIMUM_RETIREMENT_PLAN_ATTEMPTS = 8;
const MAXIMUM_RETIREMENT_SWEEP_RECORDS = 5;
const MAXIMUM_RETIREMENT_TREE_ENTRIES = 2_000_000;
const MAXIMUM_RETIREMENT_TREE_DEPTH = 128;
const MAXIMUM_LEGACY_OBJECTS = 1_000_000;
const MAXIMUM_LEGACY_OBJECT_MANIFEST_BYTES = 128 * 1024 * 1024;
const MAXIMUM_LEGACY_RECOVERY_METADATA_BYTES = 16 * 1024 * 1024;
const MAXIMUM_LEGACY_OBJECT_BYTES = 1024n * 1024n * 1024n * 1024n;
const MAXIMUM_LEGACY_REFLOG_FILES = 32_768;
const MAXIMUM_LEGACY_REFLOG_BYTES = 64n * 1024n * 1024n;
const MAXIMUM_LEGACY_GENERATED_ITEMS = 64;
const MAXIMUM_LEGACY_GENERATED_ENTRIES = 1_000_000;
const MAXIMUM_LEGACY_GENERATED_DEPTH = 32;
const MAXIMUM_LEGACY_GENERATED_BYTES = 32n * 1024n * 1024n * 1024n;
const MAXIMUM_DISCOVERY_ROOTS = 16;
const MAXIMUM_DISCOVERY_DEPTH = 8;
const MAXIMUM_DISCOVERY_ENTRIES = 50_000;
const MAXIMUM_DISCOVERY_CANDIDATES = 2_048;
const MAXIMUM_LEGACY_BATCH_MANIFEST_BYTES = 1024 * 1024;
const MAXIMUM_LEGACY_BATCH_CANDIDATES = MAXIMUM_ENTRIES;
const MAXIMUM_LEGACY_BATCH_DEPENDENCY_ENTRIES = 2_000_000;
const MAXIMUM_LEGACY_EXPLICIT_CATALOG_ENTRIES = 4_096;
const MAXIMUM_LEGACY_EXPLICIT_DIRECTORY_ENTRIES = 50_000;
const MAXIMUM_LEGACY_EXPLICIT_REPOSITORIES = 16;
const MAXIMUM_DEPENDENCY_REPOSITORIES = 2_048;
const MAXIMUM_REPOSITORY_ROOTS = 256;
const MAXIMUM_LEGACY_ADMIN_ENTRIES = 1_000_000;
const MAXIMUM_LEGACY_ADMIN_DEPTH = 64;
const MAXIMUM_LEGACY_CONFIG_BYTES = 4 * 1024 * 1024;
const MAXIMUM_LEGACY_INDEX_BYTES = 512 * 1024 * 1024;
const MAXIMUM_LEGACY_PACKED_REFS_BYTES = 64 * 1024 * 1024;
const MAXIMUM_LEGACY_REF_BYTES = 64 * 1024;
const MAXIMUM_MANAGER_REPOSITORY_ENTRIES = 1_000_000;
const MAXIMUM_MANAGER_REPOSITORY_DEPTH = 16;
const MAXIMUM_ARCHIVE_DIRECTORIES = MAXIMUM_ENTRIES * MAXIMUM_ARCHIVE_ATTEMPTS;
const MAXIMUM_ARCHIVE_REFS = 32_768;
const MAXIMUM_ARCHIVE_PACK_FILES = 16_384;
const MAXIMUM_ARCHIVE_FETCH_HEAD_BYTES = 4 * 1024 * 1024;
const MAXIMUM_ARCHIVE_FETCH_HEAD_ENTRIES = 32_768;
const MAXIMUM_ARCHIVE_REFLOG_BYTES = 16 * 1024 * 1024;
const MAXIMUM_ARCHIVE_REFLOG_ENTRIES = 262_144;
const MAXIMUM_VERIFICATION_FILES = 4096;
const MAXIMUM_VERIFICATION_DEPTH = 16;
const MAXIMUM_ARTIFACT_ATTEMPTS = 8;
const MAXIMUM_ARTIFACT_ENTRIES = 1_000_000;
const MAXIMUM_ARTIFACT_DEPTH = 128;
const MAXIMUM_ARTIFACT_BYTES = 32n * 1024n * 1024n * 1024n;
const MAXIMUM_ARTIFACT_MANIFEST_BYTES = 256n * 1024n * 1024n;
const MAXIMUM_ARTIFACT_SYMLINK_BYTES = 64 * 1024;
const SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/u;
const REMOTE_PATTERN = /^[A-Za-z0-9._-]{1,80}$/u;
const GENERATED_ROOT_PATTERN = /^(?!\.\.?$)[A-Za-z0-9._-]{1,80}$/u;
const SHA_PATTERN = /^[0-9a-f]{40,64}$/u;
const IDENTITY_PATTERN = /^(?:0|[1-9][0-9]{0,39})$/u;
const ENTRY_FILE_PATTERN = /^([a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?)\.([1-9][0-9]{0,8})\.json$/u;
const LOCK_FILE_PATTERN = /^([1-9][0-9]{0,8})\.(claim|release)\.json$/u;
const ARCHIVE_ATTEMPT_PATTERN = /^([a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?)\.([1-9][0-9]{0,8})\.([1-8])$/u;
const QUARANTINE_JOURNAL_PATTERN = /^([a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?)\.([1-9][0-9]{0,8})$/u;
const QUARANTINE_RECORD_PATTERN =
  /^([0-9]{8})\.(quarantine-intent|quarantine-result|restore-intent|restore-result)\.([0-9a-f]{32})\.json$/u;
const MANAGER_BOOTSTRAP_ATTEMPT_PATTERN = /^[0-9]{8}-[0-9a-f]{32}$/u;
const MANAGER_BOOTSTRAP_SLOT_PATTERN = /^slot-([0-9]{8})$/u;
const LEGACY_ADOPTION_ATTEMPT_PATTERN = /^([a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?)\.([0-9]{8})$/u;
const LEGACY_ADOPTION_ENTRY_PATTERN = /^([a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?)\.json$/u;
const LEGACY_ARCHIVE_ATTEMPT_PATTERN = /^([a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?)\.([0-9]{8})\.([1-8])$/u;
const LEGACY_ARCHIVE_ENTRY_PATTERN = /^([a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?)\.json$/u;
const RETIREMENT_PLAN_FILE_PATTERN = /^([a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?)\.([1-9][0-9]{0,8})(?:\.([2-8]))?\.json$/u;
const RETIREMENT_SWEEP_DIRECTORY_PATTERN = /^([a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?)\.([1-9][0-9]{0,8})$/u;
const RETIREMENT_QUARANTINE_DIRECTORY_PATTERN =
  /^([a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?)\.([1-9][0-9]{0,8})\.([0-9a-f]{32})$/u;
const RETIREMENT_SWEEP_RECORD_PATTERN =
  /^([0-9]{8})\.(eligible|quarantine-intent|quarantine-result|purge-intent|retired)\.([0-9a-f]{32})\.json$/u;
const ARTIFACT_ATTEMPT_PATTERN = /^([a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?)\.([1-9][0-9]{0,8})\.([1-8])$/u;
const ARTIFACT_ENTRY_PATTERN = /^([a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?)\.([1-9][0-9]{0,8})\.json$/u;
const ARTIFACT_SWEEP_DIRECTORY_PATTERN = /^([a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?)\.([1-9][0-9]{0,8})$/u;
const ARTIFACT_SWEEP_RECORD_PATTERN =
  /^([0-9]{8})\.(eligible|quarantine-intent|quarantine-result|purge-intent|retired)\.([0-9a-f]{32})\.json$/u;
const BOOT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const MANAGER_REMOTE_FETCH = "+refs/heads/*:refs/remotes/origin/*";

export class CheckoutLifecycleError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "CheckoutLifecycleError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new CheckoutLifecycleError(code, message);
}

function randomToken() {
  return randomBytes(16).toString("hex");
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function currentUserOwns(metadata) {
  return typeof process.getuid !== "function" || metadata.uid === BigInt(process.getuid());
}

function identityOf(metadata) {
  return Object.freeze({ device: metadata.dev.toString(), inode: metadata.ino.toString() });
}

function sameIdentity(left, right) {
  return left?.device === right?.device && left?.inode === right?.inode;
}

function exactKeys(value, keys, label) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).sort().join("\0") !== [...keys].sort().join("\0")
  ) {
    fail("invalid-registry", `${label} has unknown or missing fields.`);
  }
}

function quarantineExactKeys(value, keys, label) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).sort().join("\0") !== [...keys].sort().join("\0")
  ) {
    fail("invalid-quarantine-observation", `${label} has unknown or missing fields.`);
  }
}

function validateObservedRoot(value, label) {
  quarantineExactKeys(value, ["present", "identityMatches"], label);
  if (
    typeof value.present !== "boolean" ||
    typeof value.identityMatches !== "boolean" ||
    (!value.present && value.identityMatches)
  ) {
    fail("invalid-quarantine-observation", `${label} is malformed.`);
  }
}

/**
 * Classifies one already-collected quarantine/restore observation without
 * reading the filesystem, invoking Git, or authorizing a follow-up action.
 */
export function classifyQuarantineObservation(observation) {
  quarantineExactKeys(
    observation,
    [
      "direction",
      "original",
      "quarantine",
      "worktreeRegistry",
      "checkoutGitFile",
      "adminBacklink",
      "repositoryStateMatches"
    ],
    "Quarantine observation"
  );
  if (!["quarantine", "restore"].includes(observation.direction)) {
    fail("invalid-quarantine-observation", "Quarantine observation direction is malformed.");
  }
  validateObservedRoot(observation.original, "Observed original root");
  validateObservedRoot(observation.quarantine, "Observed quarantine root");
  const locations = [observation.worktreeRegistry, observation.checkoutGitFile, observation.adminBacklink];
  if (
    locations.some((value) => !["original", "quarantine", "missing", "other"].includes(value)) ||
    typeof observation.repositoryStateMatches !== "boolean"
  ) {
    fail("invalid-quarantine-observation", "Quarantine observation links are malformed.");
  }

  const finish = (state, location, reason) => Object.freeze({ state, location, reason, authorizesCleanup: false });
  const { original, quarantine, direction } = observation;
  const originalOnly = original.present && !quarantine.present && original.identityMatches;
  const quarantineOnly = quarantine.present && !original.present && quarantine.identityMatches;
  if (
    !observation.repositoryStateMatches ||
    locations.includes("other") ||
    (original.present && !original.identityMatches) ||
    (quarantine.present && !quarantine.identityMatches) ||
    (!originalOnly && !quarantineOnly)
  ) {
    return finish("indeterminate", "unknown", "identity-or-repository-mismatch");
  }

  const rootLocation = originalOnly ? "original" : "quarantine";
  if (![rootLocation, "missing"].includes(observation.checkoutGitFile)) {
    return finish("indeterminate", "unknown", "git-file-on-absent-root");
  }
  if (locations.every((value) => value === rootLocation)) {
    const isPre =
      (direction === "quarantine" && rootLocation === "original") ||
      (direction === "restore" && rootLocation === "quarantine");
    return finish(isPre ? "pre" : "post", `${rootLocation}-coherent`, "coherent");
  }
  if (locations.every((value) => value === "missing")) {
    return finish("indeterminate", "unknown", "all-links-missing");
  }
  const otherLocation = rootLocation === "original" ? "quarantine" : "original";
  if (
    observation.checkoutGitFile === rootLocation &&
    observation.worktreeRegistry === otherLocation &&
    observation.adminBacklink === otherLocation
  ) {
    return finish("partial", rootLocation, `${direction}-rename-before-backlink`);
  }
  if (locations.every((value) => [rootLocation, otherLocation, "missing"].includes(value))) {
    return finish("partial", rootLocation, `${direction}-backlinks-incomplete`);
  }
  return finish("indeterminate", "unknown", "unrecognized-layout");
}

function boundedPrintable(value, maximum, label) {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > maximum ||
    [...value].some((character) => character.charCodeAt(0) <= 31 || character.charCodeAt(0) === 127)
  ) {
    fail("invalid-registry", `${label} must be one bounded printable string.`);
  }
  return value;
}

function validateIdentity(value, label) {
  exactKeys(value, ["device", "inode"], label);
  if (!IDENTITY_PATTERN.test(value.device) || !IDENTITY_PATTERN.test(value.inode)) {
    fail("invalid-registry", `${label} is malformed.`);
  }
}

function fsyncDirectory(path) {
  let descriptor;
  try {
    descriptor = openSync(path, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0));
    fsyncSync(descriptor);
  } catch (error) {
    if (process.platform !== "win32" || !["EINVAL", "EISDIR", "EPERM"].includes(error.code)) throw error;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function assertPrivateDirectory(path, label) {
  const metadata = lstatSync(path, { bigint: true });
  if (
    !metadata.isDirectory() ||
    metadata.isSymbolicLink() ||
    !currentUserOwns(metadata) ||
    (typeof process.getuid === "function" && (metadata.mode & 0o777n) !== 0o700n) ||
    realpathSync(path) !== resolve(path)
  ) {
    fail("unsafe-manager", `${label} must be a current-user-owned, canonical mode-0700 directory.`);
  }
  return identityOf(metadata);
}

function ensurePrivateDirectory(path) {
  if (!existsSync(path)) {
    mkdirSync(path, { recursive: true, mode: 0o700 });
    chmodSync(path, 0o700);
    fsyncDirectory(dirname(path));
  }
  return assertPrivateDirectory(path, path);
}

function readBoundedBytes(path, maximumBytes, label, privateMode = undefined, expectedLinks = 1n) {
  let descriptor;
  try {
    descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const before = fstatSync(descriptor, { bigint: true });
    if (
      !before.isFile() ||
      before.nlink !== expectedLinks ||
      !currentUserOwns(before) ||
      before.size > BigInt(maximumBytes) ||
      (privateMode !== undefined && typeof process.getuid === "function" && (before.mode & 0o777n) !== privateMode)
    ) {
      fail("unsafe-registry", `${label} is not one bounded owned file.`);
    }
    const buffer = Buffer.allocUnsafe(Number(before.size));
    let offset = 0;
    while (offset < buffer.length) {
      const count = readSync(descriptor, buffer, offset, buffer.length - offset, offset);
      if (count === 0) fail("registry-changed", `${label} changed while it was read.`);
      offset += count;
    }
    const after = fstatSync(descriptor, { bigint: true });
    if (!sameIdentity(identityOf(before), identityOf(after)) || before.size !== after.size) {
      fail("registry-changed", `${label} changed while it was read.`);
    }
    return Object.freeze({ bytes: buffer, identity: identityOf(before) });
  } catch (error) {
    if (error instanceof CheckoutLifecycleError) throw error;
    fail("unsafe-registry", `${label} could not be read safely: ${error.message}`);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function readBoundedFile(path, maximumBytes, label, privateMode = undefined, expectedLinks = 1n) {
  const file = readBoundedBytes(path, maximumBytes, label, privateMode, expectedLinks);
  try {
    return Object.freeze({
      text: new TextDecoder("utf-8", { fatal: true }).decode(file.bytes),
      identity: file.identity
    });
  } catch (error) {
    fail("unsafe-registry", `${label} could not be read safely: ${error.message}`);
  }
}

function validateOwnedRegularFile(metadata, label, privateMode = undefined) {
  if (
    !metadata.isFile() ||
    metadata.nlink !== 1n ||
    !currentUserOwns(metadata) ||
    metadata.size < 1n ||
    metadata.size > BigInt(Number.MAX_SAFE_INTEGER) ||
    (privateMode !== undefined && typeof process.getuid === "function" && (metadata.mode & 0o777n) !== privateMode)
  ) {
    fail("unsafe-archive", `${label} is not one non-empty owned regular file.`);
  }
}

function hashDescriptor(descriptor, label, privateMode = undefined) {
  const before = fstatSync(descriptor, { bigint: true });
  validateOwnedRegularFile(before, label, privateMode);
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  const size = Number(before.size);
  let offset = 0;
  while (offset < size) {
    const count = readSync(descriptor, buffer, 0, Math.min(buffer.length, size - offset), offset);
    if (count === 0) fail("archive-changed", `${label} changed while it was hashed.`);
    hash.update(buffer.subarray(0, count));
    offset += count;
  }
  const after = fstatSync(descriptor, { bigint: true });
  if (!sameIdentity(identityOf(before), identityOf(after)) || before.size !== after.size) {
    fail("archive-changed", `${label} changed while it was hashed.`);
  }
  return Object.freeze({ identity: identityOf(before), byteLength: size, sha256: hash.digest("hex") });
}

function captureArchiveFile(path, label) {
  let descriptor;
  try {
    descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const receipt = hashDescriptor(descriptor, label, 0o600n);
    revalidatePathIdentity(path, receipt.identity, label);
    return receipt;
  } catch (error) {
    if (error instanceof CheckoutLifecycleError) throw error;
    fail("unsafe-archive", `${label} could not be read safely: ${error.message}`);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function openEmptyPrivateFile(path, label) {
  let descriptor;
  try {
    descriptor = openSync(
      path,
      constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | (constants.O_NOFOLLOW ?? 0),
      0o600
    );
    if (typeof process.getuid === "function") fchmodSync(descriptor, 0o600);
    const metadata = fstatSync(descriptor, { bigint: true });
    if (
      !metadata.isFile() ||
      metadata.isSymbolicLink() ||
      metadata.nlink !== 1n ||
      metadata.size !== 0n ||
      !currentUserOwns(metadata) ||
      (typeof process.getuid === "function" && (metadata.mode & 0o777n) !== 0o600n)
    ) {
      fail("unsafe-legacy-archive", `${label} is not one empty private file.`);
    }
    return Object.freeze({ descriptor, identity: identityOf(metadata) });
  } catch (error) {
    if (descriptor !== undefined) closeSync(descriptor);
    if (error instanceof CheckoutLifecycleError) throw error;
    if (error.code === "EEXIST") fail("legacy-archive-changed", `${label} already exists.`);
    fail("unsafe-legacy-archive", `${label} could not be created safely: ${error.message}`);
  }
}

function privatizeOwnedFile(path, label) {
  let descriptor;
  try {
    descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const before = fstatSync(descriptor, { bigint: true });
    const identity = identityOf(before);
    if (!before.isFile() || before.nlink !== 1n || !currentUserOwns(before)) {
      fail("unsafe-legacy-archive", `${label} is not one owned regular file.`);
    }
    fchmodSync(descriptor, 0o600);
    fsyncSync(descriptor);
    const after = fstatSync(descriptor, { bigint: true });
    if (
      !sameIdentity(identity, identityOf(after)) ||
      before.size !== after.size ||
      (typeof process.getuid === "function" && (after.mode & 0o777n) !== 0o600n)
    ) {
      fail("unsafe-legacy-archive", `${label} could not be made private.`);
    }
    revalidatePathIdentity(path, identity, label);
    return identity;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function privatizeOwnedDirectory(path, label) {
  let descriptor;
  try {
    descriptor = openSync(path, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0));
    const before = fstatSync(descriptor, { bigint: true });
    const identity = identityOf(before);
    if (!before.isDirectory() || !currentUserOwns(before)) {
      fail("unsafe-legacy-archive", `${label} is not one owned directory.`);
    }
    fchmodSync(descriptor, 0o700);
    try {
      fsyncSync(descriptor);
    } catch (error) {
      if (process.platform !== "win32" || !["EINVAL", "EPERM"].includes(error.code)) throw error;
    }
    const after = fstatSync(descriptor, { bigint: true });
    if (
      !sameIdentity(identity, identityOf(after)) ||
      (typeof process.getuid === "function" && (after.mode & 0o777n) !== 0o700n)
    ) {
      fail("unsafe-legacy-archive", `${label} could not be made private.`);
    }
    revalidatePathIdentity(path, identity, label, "directory");
    return identity;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function parseLegacyObjectManifest(manifestPath, oidPath, objectFormat) {
  const objectIdLength = objectFormat === "sha1" ? 40 : objectFormat === "sha256" ? 64 : 0;
  if (objectIdLength === 0) fail("invalid-legacy-archive", "The object manifest has an unsupported object format.");
  let manifestDescriptor;
  let oidDescriptor;
  try {
    manifestDescriptor = openSync(manifestPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const metadata = fstatSync(manifestDescriptor, { bigint: true });
    validateOwnedRegularFile(metadata, "Legacy object manifest", 0o600n);
    if (metadata.size > BigInt(MAXIMUM_LEGACY_OBJECT_MANIFEST_BYTES)) {
      fail("legacy-archive-too-large", "The exact object manifest exceeds its fixed size limit.");
    }
    const output = openEmptyPrivateFile(oidPath, "Legacy object-name stream");
    oidDescriptor = output.descriptor;
    const manifestHash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let carry = Buffer.alloc(0);
    let offset = 0;
    let count = 0;
    let totalObjectBytes = 0n;
    let priorOid;
    const consume = (lineBytes) => {
      if (lineBytes.length === 0 || lineBytes.length > 160) {
        fail("invalid-legacy-archive", "The exact object manifest contains an invalid line.");
      }
      const line = lineBytes.toString("ascii");
      const match = new RegExp(`^([0-9a-f]{${objectIdLength}}) (blob|tree|commit|tag) (0|[1-9][0-9]{0,39})$`, "u").exec(
        line
      );
      if (match === null || (priorOid !== undefined && match[1] <= priorOid)) {
        fail("invalid-legacy-archive", "The exact object manifest is malformed or not strictly sorted.");
      }
      const size = BigInt(match[3]);
      count += 1;
      totalObjectBytes += size;
      if (count > MAXIMUM_LEGACY_OBJECTS || totalObjectBytes > MAXIMUM_LEGACY_OBJECT_BYTES) {
        fail("legacy-archive-too-large", "The legacy object store exceeds its fixed archive limits.");
      }
      writeSync(oidDescriptor, `${match[1]}\n`, undefined, "ascii");
      priorOid = match[1];
    };
    while (offset < Number(metadata.size)) {
      const bytesRead = readSync(
        manifestDescriptor,
        buffer,
        0,
        Math.min(buffer.length, Number(metadata.size) - offset),
        offset
      );
      if (bytesRead === 0) fail("legacy-archive-changed", "The exact object manifest changed while it was parsed.");
      const bytes = buffer.subarray(0, bytesRead);
      manifestHash.update(bytes);
      const combined = carry.length === 0 ? bytes : Buffer.concat([carry, bytes]);
      let start = 0;
      for (;;) {
        const newline = combined.indexOf(0x0a, start);
        if (newline === -1) break;
        consume(combined.subarray(start, newline));
        start = newline + 1;
      }
      carry = Buffer.from(combined.subarray(start));
      if (carry.length > 160) fail("invalid-legacy-archive", "The exact object manifest has an overlong line.");
      offset += bytesRead;
    }
    if (carry.length !== 0 || count === 0) {
      fail("invalid-legacy-archive", "The exact object manifest is empty or lacks its final newline.");
    }
    fsyncSync(oidDescriptor);
    const after = fstatSync(manifestDescriptor, { bigint: true });
    if (!sameIdentity(identityOf(metadata), identityOf(after)) || metadata.size !== after.size) {
      fail("legacy-archive-changed", "The exact object manifest changed while it was parsed.");
    }
    const oidReceipt = hashDescriptor(oidDescriptor, "Legacy object-name stream", 0o600n);
    return Object.freeze({
      manifest: Object.freeze({
        identity: identityOf(metadata),
        byteLength: Number(metadata.size),
        sha256: manifestHash.digest("hex")
      }),
      oids: oidReceipt,
      objectCount: count,
      objectBytes: totalObjectBytes.toString()
    });
  } finally {
    if (oidDescriptor !== undefined) closeSync(oidDescriptor);
    if (manifestDescriptor !== undefined) closeSync(manifestDescriptor);
  }
}

function rejectDuplicateJsonKeys(text, label) {
  let offset = 0;
  let nodes = 0;
  const whitespace = () => {
    while (/\s/u.test(text[offset] ?? "")) offset += 1;
  };
  const stringToken = () => {
    const start = offset;
    offset += 1;
    while (offset < text.length) {
      if (text[offset] === "\\") {
        offset += 2;
      } else if (text[offset] === '"') {
        offset += 1;
        return text.slice(start, offset);
      } else offset += 1;
    }
    fail("invalid-registry", `${label} contains an unterminated string.`);
  };
  const value = (depth) => {
    nodes += 1;
    if (nodes > MAXIMUM_JSON_NODES || depth > MAXIMUM_JSON_DEPTH) {
      fail("invalid-registry", `${label} exceeds the JSON structure limit.`);
    }
    whitespace();
    if (text[offset] === "{") object(depth);
    else if (text[offset] === "[") array(depth);
    else if (text[offset] === '"') stringToken();
    else {
      const start = offset;
      while (offset < text.length && !/[\s,}\]]/u.test(text[offset])) offset += 1;
      if (start === offset) fail("invalid-registry", `${label} contains invalid JSON syntax.`);
    }
    whitespace();
  };
  const object = (depth) => {
    const keys = new Set();
    offset += 1;
    whitespace();
    if (text[offset] === "}") {
      offset += 1;
      return;
    }
    while (offset < text.length) {
      if (text[offset] !== '"') fail("invalid-registry", `${label} contains an invalid object key.`);
      let key;
      try {
        key = JSON.parse(stringToken());
      } catch {
        fail("invalid-registry", `${label} contains an invalid object key.`);
      }
      if (keys.has(key)) fail("duplicate-json-key", `${label} contains duplicate key ${JSON.stringify(key)}.`);
      keys.add(key);
      whitespace();
      if (text[offset] !== ":") fail("invalid-registry", `${label} contains invalid object syntax.`);
      offset += 1;
      value(depth + 1);
      if (text[offset] === "}") {
        offset += 1;
        return;
      }
      if (text[offset] !== ",") fail("invalid-registry", `${label} contains invalid object syntax.`);
      offset += 1;
      whitespace();
    }
    fail("invalid-registry", `${label} contains an unterminated object.`);
  };
  const array = (depth) => {
    offset += 1;
    whitespace();
    if (text[offset] === "]") {
      offset += 1;
      return;
    }
    while (offset < text.length) {
      value(depth + 1);
      if (text[offset] === "]") {
        offset += 1;
        return;
      }
      if (text[offset] !== ",") fail("invalid-registry", `${label} contains invalid array syntax.`);
      offset += 1;
    }
    fail("invalid-registry", `${label} contains an unterminated array.`);
  };
  whitespace();
  value(0);
  if (offset !== text.length) fail("invalid-registry", `${label} contains trailing JSON content.`);
}

function readJson(path, maximumBytes, label, privateMode = 0o600n, expectedLinks = 1n) {
  const file = readBoundedFile(path, maximumBytes, label, privateMode, expectedLinks);
  try {
    rejectDuplicateJsonKeys(file.text, label);
    return Object.freeze({ value: JSON.parse(file.text), identity: file.identity });
  } catch (error) {
    if (error instanceof CheckoutLifecycleError) throw error;
    fail("invalid-registry", `${label} is not valid JSON: ${error.message}`);
  }
}

function readJsonReceipt(path, maximumBytes, label, expectedLinks = 1n) {
  const file = readBoundedFile(path, maximumBytes, label, 0o600n, expectedLinks);
  try {
    rejectDuplicateJsonKeys(file.text, label);
    return Object.freeze({
      value: JSON.parse(file.text),
      identity: file.identity,
      byteLength: Buffer.byteLength(file.text, "utf8"),
      sha256: sha256(file.text)
    });
  } catch (error) {
    if (error instanceof CheckoutLifecycleError) throw error;
    fail("invalid-registry", `${label} is not valid JSON: ${error.message}`);
  }
}

function revalidatePathIdentity(path, expected, label, kind = "file") {
  const metadata = lstatSync(path, { bigint: true });
  const expectedKind = kind === "directory" ? metadata.isDirectory() : metadata.isFile();
  if (
    !expectedKind ||
    metadata.isSymbolicLink() ||
    !currentUserOwns(metadata) ||
    !sameIdentity(identityOf(metadata), expected)
  ) {
    fail("registry-changed", `${label} changed filesystem identity.`);
  }
}

function writeJsonExclusive(path, value, expectedParentIdentity = undefined) {
  const parent = dirname(path);
  assertPrivateDirectory(parent, parent);
  if (expectedParentIdentity !== undefined) {
    revalidatePathIdentity(parent, expectedParentIdentity, parent, "directory");
  }
  writeFileSync(path, `${JSON.stringify(value)}\n`, {
    encoding: "utf8",
    flag: "wx",
    flush: true,
    mode: 0o600
  });
  fsyncDirectory(parent);
  if (expectedParentIdentity !== undefined) {
    revalidatePathIdentity(parent, expectedParentIdentity, parent, "directory");
  }
}

function assertPersistedJsonFits(
  value,
  label,
  errorCode = "legacy-adoption-record-too-large",
  maximumBytes = MAXIMUM_ENTRY_BYTES
) {
  let byteLength;
  try {
    byteLength = Buffer.byteLength(JSON.stringify(value), "utf8") + 1;
  } catch {
    fail(errorCode, `${label} cannot be serialized safely.`);
  }
  if (byteLength > maximumBytes) {
    fail(errorCode, `${label} exceeds the persistent journal limit.`);
  }
  return byteLength;
}

function defaultRun(command, args, options = {}) {
  const stdoutFd = options.stdoutFd;
  const stdinFd = options.stdinFd;
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    encoding: "utf8",
    env: options.env ?? process.env,
    input: stdinFd === undefined ? options.input : undefined,
    maxBuffer: MAXIMUM_COMMAND_OUTPUT_BYTES,
    stdio: [
      stdinFd === undefined ? (options.input === undefined ? "ignore" : "pipe") : stdinFd,
      stdoutFd === undefined ? "pipe" : stdoutFd,
      "pipe"
    ]
  });
  if (result.error !== undefined) fail("command-failed", `${command} could not start: ${result.error.message}`);
  const normalized = Object.freeze({ status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" });
  if (!options.allowFailure && normalized.status !== 0) {
    fail("command-failed", `${command} failed: ${normalized.stderr.trim() || `exit ${normalized.status}`}`);
  }
  return normalized;
}

function withPrivateUmask(callback) {
  if (typeof process.umask !== "function") return callback();
  const previous = process.umask(0o077);
  try {
    return callback();
  } finally {
    process.umask(previous);
  }
}

export function requireSynchronousLifecycleResult(value) {
  if (
    value !== null &&
    (typeof value === "object" || typeof value === "function") &&
    typeof value.then === "function"
  ) {
    fail("async-lifecycle-operation", "A synchronous lifecycle lock callback returned a Promise or thenable.");
  }
  return value;
}

function discoverRawRepository(run, cwd) {
  const environment = auditGitEnvironment();
  const topLevel = resolve(run("git", ["rev-parse", "--show-toplevel"], { cwd, env: environment }).stdout.trim());
  const commonGitDirectory = realpathSync(
    run("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd, env: environment }).stdout.trim()
  );
  const metadata = lstatSync(commonGitDirectory, { bigint: true });
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || !currentUserOwns(metadata)) {
    fail("unsafe-repository", "The Git common directory is not a current-user-owned directory.");
  }
  return Object.freeze({ topLevel, commonGitDirectory, identity: identityOf(metadata) });
}

function bootstrapLayout(topLevel) {
  const root = join(topLevel, "tmp", "agent-checkouts", "manager");
  const attempts = join(root, "attempts");
  return Object.freeze({
    root,
    attempts,
    receipt: join(attempts, "current.json")
  });
}

function inspectBootstrapJournal(attemptsPath) {
  const entries = readDirectoryBounded(
    attemptsPath,
    MAXIMUM_MANAGER_BOOTSTRAP_ATTEMPTS * 2 + 1,
    "Checkout manager bootstrap attempts"
  );
  const slots = new Map();
  const attempts = new Map();
  let currentReceipts = 0;
  for (const item of entries) {
    if (item.name === "current.json") {
      if (!item.isFile() || item.isSymbolicLink()) {
        fail("invalid-manager-bootstrap", "The fixed checkout manager receipt is not a regular file.");
      }
      currentReceipts += 1;
      continue;
    }
    const slotMatch = MANAGER_BOOTSTRAP_SLOT_PATTERN.exec(item.name);
    if (slotMatch !== null) {
      const generation = Number(slotMatch[1]);
      if (
        generation < 1 ||
        generation > MAXIMUM_MANAGER_BOOTSTRAP_ATTEMPTS ||
        !item.isDirectory() ||
        item.isSymbolicLink() ||
        slots.has(generation)
      ) {
        fail("invalid-manager-bootstrap", "The checkout manager bootstrap slot journal is malformed.");
      }
      const slotPath = join(attemptsPath, item.name);
      const identity = assertPrivateDirectory(slotPath, "Checkout manager bootstrap slot");
      if (readDirectoryBounded(slotPath, 1, "Checkout manager bootstrap slot").length !== 0) {
        fail("invalid-manager-bootstrap", "A checkout manager bootstrap slot is not empty.");
      }
      slots.set(generation, Object.freeze({ path: slotPath, identity }));
      continue;
    }
    const attemptMatch = MANAGER_BOOTSTRAP_ATTEMPT_PATTERN.exec(item.name);
    if (!item.isDirectory() || item.isSymbolicLink() || attemptMatch === null) {
      fail("invalid-manager-bootstrap", "The checkout manager attempt journal contains an unknown entry.");
    }
    const generation = Number(item.name.slice(0, 8));
    if (generation < 1 || generation > MAXIMUM_MANAGER_BOOTSTRAP_ATTEMPTS || attempts.has(generation)) {
      fail("invalid-manager-bootstrap", "The checkout manager bootstrap attempt journal is malformed.");
    }
    const attemptPath = join(attemptsPath, item.name);
    attempts.set(
      generation,
      Object.freeze({ name: item.name, path: attemptPath, identity: assertPrivateDirectory(attemptPath, item.name) })
    );
  }
  if (
    currentReceipts > 1 ||
    slots.size > MAXIMUM_MANAGER_BOOTSTRAP_ATTEMPTS ||
    attempts.size > slots.size ||
    [...slots.keys()].sort((left, right) => left - right).some((generation, index) => generation !== index + 1) ||
    [...attempts.keys()].some((generation) => !slots.has(generation))
  ) {
    fail("invalid-manager-bootstrap", "The checkout manager bootstrap attempt journal is incomplete or ambiguous.");
  }
  return Object.freeze({ entries, slots, attempts, currentReceipts });
}

function pathEntryExists(path) {
  try {
    lstatSync(path, { bigint: true });
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    fail("unsafe-manager-bootstrap", "The checkout manager bootstrap path could not be inspected safely.");
  }
}

function validateManagerRemoteUrl(value) {
  boundedPrintable(value, 4096, "Manager remote URL");
  if (/\s/u.test(value) || value.includes("#") || value.includes("?")) {
    fail("unsafe-manager-remote", "The repository remote is not safe to record in a private manager receipt.");
  }
  const scheme = /^([A-Za-z][A-Za-z0-9+.-]*):\/\//u.exec(value)?.[1]?.toLowerCase();
  if (scheme !== undefined) {
    let parsed;
    try {
      parsed = new URL(value);
    } catch {
      fail("unsafe-manager-remote", "The repository remote URL is malformed.");
    }
    if (parsed.password !== "" || (["http", "https"].includes(scheme) && parsed.username !== "")) {
      fail("unsafe-manager-remote", "Credential-bearing repository remotes cannot be recorded.");
    }
  }
  return value;
}

function managerGit(run, repositoryPath, args, label) {
  let result;
  try {
    result = withPrivateUmask(() =>
      run("git", ["--git-dir", repositoryPath, ...args], {
        cwd: dirname(repositoryPath),
        allowFailure: true,
        env: auditGitEnvironment()
      })
    );
  } catch {
    fail("manager-bootstrap-command-failed", `${label} could not start.`);
  }
  if (result.status !== 0) fail("manager-bootstrap-command-failed", `${label} failed.`);
  return result.stdout;
}

function managerGitProbe(run, repositoryPath, args) {
  try {
    return run("git", ["--git-dir", repositoryPath, ...args], {
      cwd: dirname(repositoryPath),
      allowFailure: true,
      env: auditGitEnvironment()
    });
  } catch {
    fail("unsafe-manager-bootstrap", "The checkout manager repository could not be inspected.");
  }
}

function assertSelfContainedManagerRepository(run, repositoryPath, expectedRemote, expectedObjectFormat) {
  const metadata = lstatSync(repositoryPath, { bigint: true });
  if (
    !metadata.isDirectory() ||
    metadata.isSymbolicLink() ||
    !currentUserOwns(metadata) ||
    (typeof process.getuid === "function" && (metadata.mode & 0o777n) !== 0o700n) ||
    realpathSync(repositoryPath) !== resolve(repositoryPath)
  ) {
    fail("unsafe-manager-bootstrap", "The checkout manager repository is not one private bare repository.");
  }
  inspectManagerRepositoryTree(repositoryPath, false);
  const bare = managerGitProbe(run, repositoryPath, ["rev-parse", "--is-bare-repository"]);
  const shallow = managerGitProbe(run, repositoryPath, ["rev-parse", "--is-shallow-repository"]);
  const objectFormat = managerGitProbe(run, repositoryPath, ["rev-parse", "--show-object-format"]);
  if (
    bare.status !== 0 ||
    bare.stdout.trim() !== "true" ||
    shallow.status !== 0 ||
    shallow.stdout.trim() !== "false" ||
    objectFormat.status !== 0 ||
    !["sha1", "sha256"].includes(objectFormat.stdout.trim()) ||
    (expectedObjectFormat !== undefined && objectFormat.stdout.trim() !== expectedObjectFormat)
  ) {
    fail("unsafe-manager-bootstrap", "The checkout manager repository has an unsupported object layout.");
  }
  for (const path of [
    join(repositoryPath, "shallow"),
    join(repositoryPath, "objects", "info", "alternates"),
    join(repositoryPath, "objects", "info", "http-alternates")
  ]) {
    if (pathEntryExists(path)) {
      fail("unsafe-manager-bootstrap", "The checkout manager repository is shallow or uses object alternates.");
    }
  }
  const partial = managerGitProbe(run, repositoryPath, [
    "config",
    "--get-regexp",
    "^(extensions\\.partialclone|remote\\..*\\.(promisor|partialclonefilter))$"
  ]);
  if (![0, 1].includes(partial.status) || partial.status === 0 || partial.stdout !== "") {
    fail("unsafe-manager-bootstrap", "The checkout manager repository uses partial or promisor objects.");
  }
  const packPath = join(repositoryPath, "objects", "pack");
  if (
    readDirectoryBounded(packPath, MAXIMUM_MANAGER_REPOSITORY_ENTRIES, "The checkout manager pack directory").some(
      (item) => item.name.endsWith(".promisor")
    )
  ) {
    fail("unsafe-manager-bootstrap", "The checkout manager repository contains a promisor pack.");
  }
  const remote = managerGitProbe(run, repositoryPath, ["remote", "get-url", "origin"]);
  const fetch = managerGitProbe(run, repositoryPath, ["config", "--get-all", "remote.origin.fetch"]);
  if (
    remote.status !== 0 ||
    remote.stdout.trim() !== expectedRemote ||
    fetch.status !== 0 ||
    fetch.stdout.trim() !== MANAGER_REMOTE_FETCH
  ) {
    fail("manager-bootstrap-drift", "The checkout manager origin changed.");
  }
  return Object.freeze({ identity: identityOf(metadata), objectFormat: objectFormat.stdout.trim() });
}

function validateManagerReceipt(receiptPath, rawRepository, run, route) {
  const receipt = readJsonReceipt(receiptPath, MAXIMUM_ENTRY_BYTES, "Checkout manager bootstrap receipt", 2n);
  exactKeys(
    receipt.value,
    [
      "protocol",
      "source",
      "root",
      "attempts",
      "allocation",
      "attempt",
      "repository",
      "state",
      "template",
      "remote",
      "objectFormat"
    ],
    "Checkout manager bootstrap receipt"
  );
  const value = receipt.value;
  exactKeys(
    value.source,
    ["topLevel", "topLevelIdentity", "commonGitDirectory", "commonGitIdentity", "refsSha256"],
    "Manager source"
  );
  exactKeys(value.root, ["path", "identity"], "Manager root");
  exactKeys(value.attempts, ["path", "identity"], "Manager attempts directory");
  exactKeys(value.allocation, ["path", "identity"], "Manager bootstrap allocation");
  exactKeys(value.attempt, ["name", "path", "identity"], "Manager bootstrap attempt");
  exactKeys(value.repository, ["path", "identity"], "Manager repository");
  exactKeys(value.state, ["path", "identity"], "Manager state");
  exactKeys(value.template, ["path", "identity"], "Manager template");
  exactKeys(value.remote, ["name", "url", "fetch"], "Manager remote");
  for (const [identity, label] of [
    [value.source.topLevelIdentity, "Manager source root identity"],
    [value.source.commonGitIdentity, "Manager source Git identity"],
    [value.root.identity, "Manager root identity"],
    [value.attempts.identity, "Manager attempts identity"],
    [value.allocation.identity, "Manager allocation identity"],
    [value.attempt.identity, "Manager attempt identity"],
    [value.repository.identity, "Manager repository identity"],
    [value.state.identity, "Manager state identity"],
    [value.template.identity, "Manager template identity"]
  ]) {
    validateIdentity(identity, label);
  }
  const attemptsPath = dirname(value.attempt.path);
  const rootPath = dirname(attemptsPath);
  const generation = Number(value.attempt.name.slice(0, 8));
  const expectedAllocationPath = join(attemptsPath, `slot-${String(generation).padStart(8, "0")}`);
  const expectedReceiptPath = join(value.attempt.path, "receipt.json");
  const fixedReceiptPath = join(attemptsPath, "current.json");
  const expectedLayout = {
    repository: join(value.attempt.path, "repository.git"),
    state: join(value.attempt.path, "state"),
    template: join(value.attempt.path, "template")
  };
  const receiptPaths = [
    value.source.topLevel,
    value.source.commonGitDirectory,
    value.root.path,
    value.attempts.path,
    value.allocation.path,
    value.attempt.path,
    value.repository.path,
    value.state.path,
    value.template.path
  ];
  if (
    value.protocol !== MANAGER_BOOTSTRAP_PROTOCOL ||
    value.root.path !== rootPath ||
    value.attempts.path !== attemptsPath ||
    rootPath !== join(value.source.topLevel, "tmp", "agent-checkouts", "manager") ||
    !MANAGER_BOOTSTRAP_ATTEMPT_PATTERN.test(value.attempt.name) ||
    !Number.isSafeInteger(generation) ||
    generation < 1 ||
    generation > MAXIMUM_MANAGER_BOOTSTRAP_ATTEMPTS ||
    value.allocation.path !== expectedAllocationPath ||
    value.attempt.path !== join(attemptsPath, value.attempt.name) ||
    basename(attemptsPath) !== "attempts" ||
    (route === "source" ? receiptPath !== fixedReceiptPath : receiptPath !== expectedReceiptPath) ||
    value.repository.path !== expectedLayout.repository ||
    value.state.path !== expectedLayout.state ||
    value.template.path !== expectedLayout.template ||
    value.remote.name !== "origin" ||
    value.remote.fetch !== MANAGER_REMOTE_FETCH ||
    receiptPaths.some((path) => typeof path !== "string" || !isAbsolute(path) || resolve(path) !== path) ||
    !/^[0-9a-f]{64}$/u.test(value.source.refsSha256) ||
    !["sha1", "sha256"].includes(value.objectFormat)
  ) {
    fail("invalid-manager-bootstrap", "The checkout manager bootstrap receipt does not match its fixed layout.");
  }
  validateManagerRemoteUrl(value.remote.url);
  const rootIdentity = assertPrivateDirectory(rootPath, "Checkout manager root");
  const attemptsIdentity = assertPrivateDirectory(attemptsPath, "Checkout manager attempts directory");
  const allocationIdentity = assertPrivateDirectory(value.allocation.path, "Checkout manager bootstrap allocation");
  const attemptIdentity = assertPrivateDirectory(value.attempt.path, "Checkout manager attempt");
  if (
    !sameIdentity(rootIdentity, value.root.identity) ||
    !sameIdentity(attemptsIdentity, value.attempts.identity) ||
    !sameIdentity(allocationIdentity, value.allocation.identity) ||
    !sameIdentity(attemptIdentity, value.attempt.identity)
  ) {
    fail("manager-bootstrap-drift", "The checkout manager directory chain changed.");
  }
  const journal = inspectBootstrapJournal(attemptsPath);
  if (
    journal.currentReceipts !== 1 ||
    journal.attempts.get(generation)?.name !== value.attempt.name ||
    !sameIdentity(journal.slots.get(generation)?.identity, value.allocation.identity)
  ) {
    fail("invalid-manager-bootstrap", "The checkout manager attempt journal is incomplete or ambiguous.");
  }
  const receiptMetadata = lstatSync(receiptPath, { bigint: true });
  const attemptReceipt = readJsonReceipt(expectedReceiptPath, MAXIMUM_ENTRY_BYTES, "Manager attempt receipt", 2n);
  const fixedReceipt = readJsonReceipt(fixedReceiptPath, MAXIMUM_ENTRY_BYTES, "Manager fixed receipt", 2n);
  if (
    receiptMetadata.nlink !== 2n ||
    !sameIdentity(attemptReceipt.identity, fixedReceipt.identity) ||
    !isDeepStrictEqual(attemptReceipt.value, fixedReceipt.value) ||
    attemptReceipt.byteLength !== fixedReceipt.byteLength ||
    attemptReceipt.sha256 !== fixedReceipt.sha256
  ) {
    fail("manager-bootstrap-drift", "The checkout manager receipt lost its exact publication link.");
  }
  revalidatePathIdentity(expectedReceiptPath, attemptReceipt.identity, "Manager attempt receipt");
  revalidatePathIdentity(fixedReceiptPath, fixedReceipt.identity, "Manager fixed receipt");
  revalidatePathIdentity(
    expectedLayout.repository,
    value.repository.identity,
    "Checkout manager repository",
    "directory"
  );
  const stateIdentity = assertPrivateDirectory(expectedLayout.state, "Checkout manager state");
  if (!sameIdentity(stateIdentity, value.state.identity)) {
    fail("manager-bootstrap-drift", "The checkout manager state changed filesystem identity.");
  }
  const templateIdentity = assertPrivateDirectory(value.template.path, "Checkout manager empty template");
  if (
    !sameIdentity(templateIdentity, value.template.identity) ||
    readDirectoryBounded(value.template.path, 1, "Checkout manager empty template").length !== 0
  ) {
    fail("manager-bootstrap-drift", "The checkout manager empty template changed.");
  }
  const managerRepository = assertSelfContainedManagerRepository(
    run,
    expectedLayout.repository,
    value.remote.url,
    value.objectFormat
  );
  if (!sameIdentity(managerRepository.identity, value.repository.identity)) {
    fail("manager-bootstrap-drift", "The checkout manager repository changed filesystem identity.");
  }
  if (route === "source") {
    if (
      rawRepository.topLevel !== value.source.topLevel ||
      rawRepository.commonGitDirectory !== value.source.commonGitDirectory ||
      !sameIdentity(rawRepository.identity, value.source.commonGitIdentity)
    ) {
      fail("manager-bootstrap-drift", "The source repository no longer matches the checkout manager receipt.");
    }
    if (readSourceRemote(run, rawRepository.topLevel) !== value.remote.url) {
      fail("manager-bootstrap-drift", "The source repository origin no longer matches the checkout manager.");
    }
    revalidatePathIdentity(value.source.topLevel, value.source.topLevelIdentity, "Manager source root", "directory");
  } else if (rawRepository.commonGitDirectory !== expectedLayout.repository) {
    fail("manager-bootstrap-drift", "The child checkout is not backed by the recorded checkout manager.");
  }
  revalidatePathIdentity(receiptPath, receipt.identity, "Checkout manager bootstrap receipt");
  return Object.freeze({
    topLevel: route === "child" ? rawRepository.topLevel : expectedLayout.repository,
    commonGitDirectory: expectedLayout.repository,
    identity: managerRepository.identity,
    managerRoot: expectedLayout.state,
    bootstrapReceipt: fixedReceiptPath,
    bootstrapPublication: Object.freeze({
      path: fixedReceiptPath,
      identity: fixedReceipt.identity,
      byteLength: fixedReceipt.byteLength,
      sha256: fixedReceipt.sha256
    }),
    managerRemote: value.remote.url,
    bootstrapSourceRepository: Object.freeze({
      topLevel: value.source.topLevel,
      topLevelIdentity: value.source.topLevelIdentity,
      commonGitDirectory: value.source.commonGitDirectory,
      commonGitIdentity: value.source.commonGitIdentity
    }),
    sourceRepository:
      route === "source"
        ? Object.freeze({
            topLevel: value.source.topLevel,
            topLevelIdentity: value.source.topLevelIdentity,
            commonGitDirectory: value.source.commonGitDirectory,
            commonGitIdentity: value.source.commonGitIdentity
          })
        : undefined
  });
}

function discoverRepository(run, cwd, allowBootstrapRoute = true) {
  const rawRepository = discoverRawRepository(run, cwd);
  if (!allowBootstrapRoute) return rawRepository;
  const siblingReceipt = join(dirname(rawRepository.commonGitDirectory), "receipt.json");
  const sourceLayout = bootstrapLayout(rawRepository.topLevel);
  const sourceReceipt = sourceLayout.receipt;
  const commonParent = dirname(rawRepository.commonGitDirectory);
  const hasExactSiblingLayout =
    basename(rawRepository.commonGitDirectory) === "repository.git" &&
    MANAGER_BOOTSTRAP_ATTEMPT_PATTERN.test(basename(commonParent)) &&
    basename(dirname(commonParent)) === "attempts";
  const hasSibling = hasExactSiblingLayout && pathEntryExists(siblingReceipt);
  const hasSource = sourceReceipt !== siblingReceipt && pathEntryExists(sourceReceipt);
  if (hasSibling && hasSource) {
    fail("ambiguous-manager-bootstrap", "Both source and child checkout manager receipts are present.");
  }
  if (hasSibling) return validateManagerReceipt(siblingReceipt, rawRepository, run, "child");
  if (hasSource) return validateManagerReceipt(sourceReceipt, rawRepository, run, "source");
  if (pathEntryExists(sourceLayout.attempts)) {
    const journal = inspectBootstrapJournal(sourceLayout.attempts);
    if (journal.entries.length > 0) {
      fail("manager-bootstrap-incomplete", "A checkout manager bootstrap attempt exists without a published receipt.");
    }
  }
  return rawRepository;
}

function runBootstrapCommand(run, args, cwd, label) {
  let result;
  try {
    result = withPrivateUmask(() => run("git", args, { cwd, allowFailure: true, env: auditGitEnvironment() }));
  } catch {
    fail("manager-bootstrap-command-failed", `${label} could not start.`);
  }
  if (result.status !== 0) fail("manager-bootstrap-command-failed", `${label} failed.`);
  return result.stdout;
}

function inspectManagerRepositoryTree(path, privatize) {
  let entries = 0;
  const visit = (directory, depth, expectedIdentity = undefined) => {
    if (depth > MAXIMUM_MANAGER_REPOSITORY_DEPTH) {
      fail("unsafe-manager-bootstrap", "The checkout manager repository is nested too deeply.");
    }
    const directoryMetadata = lstatSync(directory, { bigint: true });
    const directoryIdentity = identityOf(directoryMetadata);
    if (
      !directoryMetadata.isDirectory() ||
      directoryMetadata.isSymbolicLink() ||
      !currentUserOwns(directoryMetadata) ||
      realpathSync(directory) !== resolve(directory) ||
      (expectedIdentity !== undefined && !sameIdentity(directoryIdentity, expectedIdentity))
    ) {
      fail("unsafe-manager-bootstrap", "The checkout manager repository contains an unsafe directory.");
    }
    // The root is mode 0700. Git may still apply the caller's umask to files it
    // creates below that boundary, so later reads validate ownership and type
    // instead of requiring every worktree index to remain mode 0600.
    if (privatize) chmodSync(directory, 0o700);
    revalidatePathIdentity(directory, directoryIdentity, "Checkout manager repository directory", "directory");
    for (const item of readDirectoryBounded(
      directory,
      MAXIMUM_MANAGER_REPOSITORY_ENTRIES,
      "The checkout manager repository"
    )) {
      entries += 1;
      if (entries > MAXIMUM_MANAGER_REPOSITORY_ENTRIES) {
        fail("unsafe-manager-bootstrap", "The checkout manager repository contains too many entries.");
      }
      const child = join(directory, item.name);
      const metadata = lstatSync(child, { bigint: true });
      const childIdentity = identityOf(metadata);
      if (metadata.isDirectory() && !metadata.isSymbolicLink()) {
        visit(child, depth + 1, childIdentity);
      } else if (
        !metadata.isFile() ||
        metadata.isSymbolicLink() ||
        !currentUserOwns(metadata) ||
        metadata.nlink !== 1n
      ) {
        fail("unsafe-manager-bootstrap", "The checkout manager repository contains a link or special file.");
      } else if (privatize) chmodSync(child, 0o600);
      if (!metadata.isDirectory()) {
        revalidatePathIdentity(child, childIdentity, "Checkout manager repository file");
      }
    }
    if (privatize) fsyncDirectory(directory);
    revalidatePathIdentity(directory, directoryIdentity, "Checkout manager repository directory", "directory");
  };
  const rootIdentity = identityOf(lstatSync(path, { bigint: true }));
  visit(path, 0, rootIdentity);
  revalidatePathIdentity(path, rootIdentity, "Checkout manager repository root", "directory");
}

function privatizeManagerRepository(path) {
  inspectManagerRepositoryTree(path, true);
}

function readSourceRemote(run, sourcePath) {
  const value = runBootstrapCommand(
    run,
    ["-C", sourcePath, "remote", "get-url", "origin"],
    sourcePath,
    "Remote inspection"
  ).trim();
  return validateManagerRemoteUrl(value);
}

function readSourceRefsSha256(run, sourcePath) {
  const refs = runBootstrapCommand(
    run,
    ["-C", sourcePath, "show-ref", "--head", "--dereference"],
    sourcePath,
    "Source reference inspection"
  );
  return sha256(refs);
}

function assertOrdinaryBootstrapSource(repository) {
  const sourceMetadata = lstatSync(repository.topLevel, { bigint: true });
  const dotGit = join(repository.topLevel, ".git");
  const gitMetadata = lstatSync(dotGit, { bigint: true });
  if (
    !sourceMetadata.isDirectory() ||
    sourceMetadata.isSymbolicLink() ||
    !currentUserOwns(sourceMetadata) ||
    realpathSync(repository.topLevel) !== repository.topLevel ||
    !gitMetadata.isDirectory() ||
    gitMetadata.isSymbolicLink() ||
    realpathSync(dotGit) !== repository.commonGitDirectory
  ) {
    fail(
      "invalid-manager-bootstrap-source",
      "Bootstrap must run from the ordinary source checkout, not a linked worktree."
    );
  }
  return identityOf(sourceMetadata);
}

function assertSourceUnchanged(run, before, remote) {
  let after;
  try {
    after = discoverRawRepository(run, before.topLevel);
  } catch {
    fail("manager-bootstrap-drift", "The source repository could not be revalidated during bootstrap.");
  }
  const rootMetadata = lstatSync(after.topLevel, { bigint: true });
  if (
    after.topLevel !== before.topLevel ||
    after.commonGitDirectory !== before.commonGitDirectory ||
    !sameIdentity(after.identity, before.identity) ||
    !sameIdentity(identityOf(rootMetadata), before.topLevelIdentity) ||
    readSourceRefsSha256(run, after.topLevel) !== before.refsSha256 ||
    readSourceRemote(run, after.topLevel) !== remote
  ) {
    fail("manager-bootstrap-drift", "The source repository changed during checkout manager bootstrap.");
  }
}

/**
 * Creates a private, self-contained bare repository and manager state. Failed
 * attempts are retained and a complete attempt is published through one
 * no-replace hard link to its immutable receipt.
 */
export function bootstrapCheckoutManager(options = {}) {
  const run = options.run ?? defaultRun;
  let source;
  try {
    source = discoverRawRepository(run, options.repositoryPath ?? options.cwd ?? process.cwd());
  } catch {
    fail("manager-bootstrap-command-failed", "The source repository could not be inspected.");
  }
  const sourceTopLevelIdentity = assertOrdinaryBootstrapSource(source);
  const sourceSnapshot = Object.freeze({
    ...source,
    topLevelIdentity: sourceTopLevelIdentity,
    refsSha256: readSourceRefsSha256(run, source.topLevel)
  });
  const layout = bootstrapLayout(source.topLevel);
  if (pathEntryExists(layout.receipt)) {
    fail("manager-bootstrap-exists", "A checkout manager bootstrap is already published.");
  }
  const remote = readSourceRemote(run, source.topLevel);
  const rootIdentity = ensurePrivateDirectory(layout.root);
  const attemptsIdentity = ensurePrivateDirectory(layout.attempts);
  revalidatePathIdentity(layout.root, rootIdentity, "Checkout manager bootstrap root", "directory");
  const prior = inspectBootstrapJournal(layout.attempts);
  if (prior.currentReceipts !== 0) {
    fail("manager-bootstrap-exists", "A checkout manager bootstrap is already published.");
  }
  options.hooks?.afterBootstrapAttemptsRead?.({
    attemptsPath: layout.attempts,
    attempts: Object.freeze([...prior.attempts.values()].map((item) => item.name).sort())
  });
  const token = (options.tokenFactory ?? randomToken)();
  if (!/^[0-9a-f]{32}$/u.test(token)) fail("unsafe-manager-bootstrap", "The bootstrap attempt token is malformed.");
  let generation;
  let allocationPath;
  for (let candidate = 1; candidate <= MAXIMUM_MANAGER_BOOTSTRAP_ATTEMPTS; candidate += 1) {
    const candidatePath = join(layout.attempts, `slot-${String(candidate).padStart(8, "0")}`);
    try {
      mkdirSync(candidatePath, { mode: 0o700 });
      chmodSync(candidatePath, 0o700);
      fsyncDirectory(layout.attempts);
      generation = candidate;
      allocationPath = candidatePath;
      break;
    } catch (error) {
      if (error.code !== "EEXIST") {
        fail("manager-bootstrap-allocation-failed", "A checkout manager bootstrap slot could not be claimed.");
      }
    }
  }
  if (generation === undefined || allocationPath === undefined) {
    fail("manager-bootstrap-attempts-exhausted", "Too many retained checkout manager bootstrap attempts exist.");
  }
  const allocationIdentity = assertPrivateDirectory(allocationPath, "Checkout manager bootstrap allocation");
  if (readDirectoryBounded(allocationPath, 1, "Checkout manager bootstrap allocation").length !== 0) {
    fail("unsafe-manager-bootstrap", "The claimed checkout manager bootstrap slot is not empty.");
  }
  const attemptName = `${String(generation).padStart(8, "0")}-${token}`;
  const attemptPath = join(layout.attempts, attemptName);
  mkdirSync(attemptPath, { mode: 0o700 });
  chmodSync(attemptPath, 0o700);
  fsyncDirectory(layout.attempts);
  const attemptIdentity = assertPrivateDirectory(attemptPath, "Checkout manager bootstrap attempt");
  const repositoryPath = join(attemptPath, "repository.git");
  const statePath = join(attemptPath, "state");
  const templatePath = join(attemptPath, "template");
  const templateIdentity = ensurePrivateDirectory(templatePath);
  runBootstrapCommand(
    run,
    [
      "clone",
      "--bare",
      "--quiet",
      "--no-local",
      "--no-hardlinks",
      `--template=${templatePath}`,
      "--origin",
      "origin",
      source.topLevel,
      repositoryPath
    ],
    attemptPath,
    "Bare repository seed"
  );
  options.hooks?.afterBootstrapClone?.({ attemptPath, repositoryPath, statePath, source: sourceSnapshot });
  privatizeManagerRepository(repositoryPath);
  managerGit(run, repositoryPath, ["config", "remote.origin.url", remote], "Manager remote configuration");
  managerGit(
    run,
    repositoryPath,
    ["config", "--replace-all", "remote.origin.fetch", MANAGER_REMOTE_FETCH],
    "Manager fetch configuration"
  );
  privatizeManagerRepository(repositoryPath);
  const seeded = assertSelfContainedManagerRepository(run, repositoryPath, remote);
  managerGit(run, repositoryPath, ["fsck", "--strict", "--full", "--no-dangling"], "Manager repository verification");
  const stateIdentity = ensurePrivateDirectory(statePath);
  for (const name of ["entries", "checkouts", "locks"]) ensurePrivateDirectory(join(statePath, name));
  assertSourceUnchanged(run, sourceSnapshot, remote);
  options.hooks?.beforeBootstrapReceipt?.({ attemptPath, repositoryPath, statePath, source: sourceSnapshot });
  const attemptReceiptPath = join(attemptPath, "receipt.json");
  const receiptValue = {
    protocol: MANAGER_BOOTSTRAP_PROTOCOL,
    source: {
      topLevel: source.topLevel,
      topLevelIdentity: sourceTopLevelIdentity,
      commonGitDirectory: source.commonGitDirectory,
      commonGitIdentity: source.identity,
      refsSha256: sourceSnapshot.refsSha256
    },
    root: { path: layout.root, identity: rootIdentity },
    attempts: { path: layout.attempts, identity: attemptsIdentity },
    allocation: { path: allocationPath, identity: allocationIdentity },
    attempt: { name: attemptName, path: attemptPath, identity: attemptIdentity },
    repository: { path: repositoryPath, identity: seeded.identity },
    state: { path: statePath, identity: stateIdentity },
    template: { path: templatePath, identity: templateIdentity },
    remote: { name: "origin", url: remote, fetch: MANAGER_REMOTE_FETCH },
    objectFormat: seeded.objectFormat
  };
  writeJsonExclusive(attemptReceiptPath, receiptValue, attemptIdentity);
  revalidatePathIdentity(repositoryPath, seeded.identity, "Seeded manager repository", "directory");
  revalidatePathIdentity(statePath, stateIdentity, "Seeded manager state", "directory");
  assertSourceUnchanged(run, sourceSnapshot, remote);
  options.hooks?.beforeBootstrapPublish?.({ attemptPath, repositoryPath, statePath, source: sourceSnapshot });
  assertSourceUnchanged(run, sourceSnapshot, remote);
  const finalRepository = assertSelfContainedManagerRepository(run, repositoryPath, remote, seeded.objectFormat);
  if (!sameIdentity(finalRepository.identity, seeded.identity)) {
    fail("manager-bootstrap-drift", "The seeded checkout manager repository changed before publication.");
  }
  managerGit(run, repositoryPath, ["fsck", "--strict", "--full", "--no-dangling"], "Final manager verification");
  revalidatePathIdentity(statePath, stateIdentity, "Seeded manager state", "directory");
  revalidatePathIdentity(layout.attempts, attemptsIdentity, "Checkout manager attempt journal", "directory");
  revalidatePathIdentity(allocationPath, allocationIdentity, "Checkout manager bootstrap allocation", "directory");
  revalidatePathIdentity(attemptPath, attemptIdentity, "Checkout manager bootstrap attempt", "directory");
  const finalAttemptReceipt = readJson(attemptReceiptPath, MAXIMUM_ENTRY_BYTES, "Manager attempt receipt");
  if (!isDeepStrictEqual(finalAttemptReceipt.value, receiptValue)) {
    fail("manager-bootstrap-drift", "The checkout manager receipt changed before publication.");
  }
  try {
    linkSync(attemptReceiptPath, layout.receipt);
  } catch (error) {
    if (error.code === "EEXIST") {
      fail("manager-bootstrap-changed", "Another checkout manager receipt is already published.");
    }
    fail("manager-bootstrap-publish-failed", "The checkout manager receipt could not be published.");
  }
  fsyncDirectory(layout.attempts);
  const published = validateManagerReceipt(layout.receipt, source, run, "source");
  return Object.freeze({
    status: "checkout-manager-bootstrapped",
    repositoryPath: published.commonGitDirectory,
    statePath: published.managerRoot,
    receiptPath: published.bootstrapReceipt
  });
}

function commonGit(run, paths, repository, args, options = {}) {
  return withPrivateUmask(() =>
    run("git", ["--git-dir", repository.commonGitDirectory, ...args], {
      cwd: paths.root,
      allowFailure: options.allowFailure,
      env: options.env ?? auditGitEnvironment(),
      stdoutFd: options.stdoutFd,
      input: options.input
    })
  );
}

function checkoutGit(run, paths, checkoutPath, args, options = {}) {
  return run("git", ["-C", checkoutPath, ...args], {
    cwd: paths.root,
    allowFailure: options.allowFailure,
    env: options.env ?? auditGitEnvironment()
  });
}

function auditGitEnvironment() {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !name.toUpperCase().startsWith("GIT_"))
  );
  return {
    ...env,
    GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_ATTR_NOSYSTEM: "1",
    GIT_NO_LAZY_FETCH: "1",
    GIT_NO_REPLACE_OBJECTS: "1",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_TERMINAL_PROMPT: "0"
  };
}

function auditCheckoutGit(run, paths, checkoutPath, gitAdminPath, args) {
  return run(
    "git",
    [
      "--git-dir",
      gitAdminPath,
      "--work-tree",
      checkoutPath,
      "-c",
      "core.fsmonitor=false",
      "-c",
      `core.hooksPath=${process.platform === "win32" ? "NUL" : "/dev/null"}`,
      "-c",
      "submodule.recurse=false",
      ...args
    ],
    {
      cwd: paths.root,
      allowFailure: true,
      env: auditGitEnvironment()
    }
  );
}

function assertSlug(slug) {
  if (typeof slug !== "string" || !SLUG_PATTERN.test(slug)) {
    fail("invalid-slug", "The checkout slug must contain 1-64 lowercase letters, digits, or hyphens.");
  }
}

function assertOwner(ownerTask, label = "owner") {
  try {
    boundedPrintable(ownerTask, 200, `The ${label} task name`);
  } catch {
    fail("invalid-owner", `The ${label} task name must be one bounded printable string.`);
  }
}

function assertRevision(revision) {
  if (!Number.isSafeInteger(revision) || revision < 1) {
    fail("invalid-revision", "The expected checkout revision must be a positive integer.");
  }
}

function assertGeneration(generation) {
  if (!Number.isSafeInteger(generation) || generation < 1 || generation > MAXIMUM_ENTRY_GENERATIONS) {
    fail("invalid-generation", "The expected checkout generation must be a positive bounded integer.");
  }
}

function assertRemote(remote) {
  if (typeof remote !== "string" || !REMOTE_PATTERN.test(remote)) fail("invalid-remote", "The remote name is invalid.");
}

function normalizeGeneratedRoots(roots) {
  if (
    !Array.isArray(roots) ||
    roots.length > MAXIMUM_GENERATED_ROOTS ||
    new Set(roots).size !== roots.length ||
    roots.some(
      (root) => typeof root !== "string" || !GENERATED_ROOT_PATTERN.test(root) || root.toLowerCase() === ".git"
    )
  ) {
    fail("invalid-generated-roots", "Generated roots must be unique, exact top-level directory names.");
  }
  return Object.freeze([...roots].sort());
}

function isContained(root, candidate) {
  const pathRelative = relative(root, candidate);
  return (
    pathRelative !== "" && pathRelative !== ".." && !pathRelative.startsWith(`..${sep}`) && !isAbsolute(pathRelative)
  );
}

function isSameOrContained(root, candidate) {
  return resolve(root) === resolve(candidate) || isContained(resolve(root), resolve(candidate));
}

function canonicalRepositoryRemote(value, basePath) {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 4096 ||
    [...value].some((character) => character.charCodeAt(0) <= 31 || character.charCodeAt(0) === 127)
  ) {
    return null;
  }
  const scp = win32.isAbsolute(value) ? null : /^(?:git@)?([A-Za-z0-9.-]+):([^:]+)$/u.exec(value);
  if (scp !== null) {
    const path = scp[2].replace(/^\/+|\/+$/gu, "").replace(/\.git$/u, "");
    return path === "" ? null : `network:${scp[1].toLowerCase()}/${path}`;
  }
  const scheme = /^([A-Za-z][A-Za-z0-9+.-]*):\/\//u.exec(value)?.[1]?.toLowerCase();
  if (scheme !== undefined) {
    let parsed;
    try {
      parsed = new URL(value);
    } catch {
      return null;
    }
    if (parsed.password !== "" || parsed.search !== "" || parsed.hash !== "") return null;
    if (["https", "ssh"].includes(scheme)) {
      if (scheme === "https" && parsed.username !== "") return null;
      if (scheme === "ssh" && !["", "git"].includes(parsed.username)) return null;
      let decodedPath;
      try {
        decodedPath = decodeURIComponent(parsed.pathname);
      } catch {
        return null;
      }
      const path = decodedPath.replace(/^\/+|\/+$/gu, "").replace(/\.git$/u, "");
      return parsed.hostname === "" || path === "" ? null : `network:${parsed.host.toLowerCase()}/${path}`;
    }
    if (scheme !== "file" || parsed.username !== "" || parsed.hostname !== "") return null;
    try {
      value = fileURLToPath(parsed);
    } catch {
      return null;
    }
  }
  const localPath = resolve(basePath, value);
  let metadata;
  try {
    metadata = lstatSync(localPath, { bigint: true });
  } catch {
    return null;
  }
  if (
    !metadata.isDirectory() ||
    metadata.isSymbolicLink() ||
    !currentUserOwns(metadata) ||
    realpathSync(localPath) !== localPath
  ) {
    return null;
  }
  return `local:${localPath}`;
}

export function normalizeWorktreeRegistryPath(value, platform = process.platform) {
  if (typeof value !== "string" || value === "") {
    fail("invalid-worktree-registry", "Git returned a non-canonical worktree path.");
  }
  const pathApi = platform === "win32" ? win32 : posix;
  const platformFormatted = platform === "win32" ? value.replaceAll("/", "\\") : value;
  if (!pathApi.isAbsolute(platformFormatted) || pathApi.normalize(platformFormatted) !== platformFormatted) {
    fail("invalid-worktree-registry", "Git returned a non-canonical worktree path.");
  }
  return platformFormatted;
}

function parseWorktreeList(output) {
  if (typeof output !== "string" || output === "" || !output.endsWith("\0")) {
    fail("invalid-worktree-registry", "Git returned a malformed worktree registry.");
  }
  const records = [];
  let record;
  let fields = 0;
  const finishRecord = () => {
    if (record === undefined) fail("invalid-worktree-registry", "Git returned an empty worktree record.");
    if (records.length === MAXIMUM_WORKTREE_RECORDS) {
      fail("invalid-worktree-registry", "Git returned too many worktree records.");
    }
    records.push(Object.freeze(record));
    record = undefined;
  };
  const items = output.split("\0");
  items.pop();
  for (const item of items) {
    if (item === "") {
      finishRecord();
      continue;
    }
    if (Buffer.byteLength(item, "utf8") > MAXIMUM_WORKTREE_FIELD_BYTES) {
      fail("invalid-worktree-registry", "Git returned a malformed worktree field.");
    }
    const space = item.indexOf(" ");
    const key = space === -1 ? item : item.slice(0, space);
    const value = space === -1 ? true : item.slice(space + 1);
    if (key === "worktree") {
      if (record !== undefined) {
        fail("invalid-worktree-registry", "Git returned a worktree without a record separator.");
      }
      record = { path: normalizeWorktreeRegistryPath(value) };
      fields = 1;
      continue;
    }
    if (record === undefined || !/^[A-Za-z][A-Za-z0-9-]{0,63}$/u.test(key) || key in record) {
      fail("invalid-worktree-registry", "Git returned a duplicate or misplaced worktree field.");
    }
    fields += 1;
    if (fields > MAXIMUM_WORKTREE_FIELDS) {
      fail("invalid-worktree-registry", "Git returned too many fields for one worktree.");
    }
    record[key] = value;
  }
  if (record !== undefined) fail("invalid-worktree-registry", "Git omitted the final worktree record separator.");
  if (records.length === 0 || new Set(records.map((item) => item.path)).size !== records.length) {
    fail("invalid-worktree-registry", "Git returned duplicate or missing worktree records.");
  }
  return Object.freeze(records);
}

function parseRefList(output, objectFormat, label, options = {}) {
  if (typeof output !== "string" || !["sha1", "sha256"].includes(objectFormat)) {
    fail("invalid-archive", `${label} is malformed.`);
  }
  const oidLength = objectFormat === "sha1" ? 40 : 64;
  const refs =
    output === ""
      ? []
      : output
          .split("\n")
          .filter(Boolean)
          .map((line) => {
            const space = line.indexOf(" ");
            const oid = space === -1 ? "" : line.slice(0, space);
            const ref = space === -1 ? "" : line.slice(space + 1);
            if (
              oid.length !== oidLength ||
              !/^[0-9a-f]+$/u.test(oid) ||
              !(
                ref.startsWith("refs/") ||
                (options.allowHead === true && ref === "HEAD") ||
                (options.allowWorktreeHeads === true && /^worktrees\/[A-Za-z0-9._-]{1,240}\/HEAD$/u.test(ref)) ||
                (options.allowArchivePseudorefs === true &&
                  (ref === "ORIG_HEAD" || /^worktrees\/[A-Za-z0-9._-]{1,240}\/ORIG_HEAD$/u.test(ref)))
              ) ||
              Buffer.byteLength(ref, "utf8") > 4096 ||
              [...ref].some((character) => character.charCodeAt(0) <= 32 || character.charCodeAt(0) === 127)
            ) {
              fail("invalid-archive", `${label} contains an invalid reference.`);
            }
            return Object.freeze({ oid, ref });
          });
  if (
    (refs.length < 1 && options.allowEmpty !== true) ||
    refs.length > MAXIMUM_ARCHIVE_REFS ||
    new Set(refs.map((item) => item.ref)).size !== refs.length
  ) {
    fail("invalid-archive", `${label} contains duplicate, missing, or too many references.`);
  }
  return Object.freeze([...refs].sort((left, right) => Buffer.compare(Buffer.from(left.ref), Buffer.from(right.ref))));
}

function refsReceipt(refs) {
  const canonical = refs.map(({ oid, ref }) => `${oid} ${ref}`).join("\n") + "\n";
  return Object.freeze({ count: refs.length, sha256: sha256(canonical) });
}

function parseBundleHeader(path, expectedObjectFormat) {
  let descriptor;
  try {
    descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const chunks = [];
    let length = 0;
    let headerEnd = -1;
    while (length < MAXIMUM_BUNDLE_HEADER_BYTES && (headerEnd === -1 || length < headerEnd + 6)) {
      const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, MAXIMUM_BUNDLE_HEADER_BYTES - length));
      const count = readSync(descriptor, buffer, 0, buffer.length, length);
      if (count === 0) break;
      chunks.push(buffer.subarray(0, count));
      length += count;
      headerEnd = Buffer.concat(chunks).indexOf("\n\n");
    }
    const bytes = Buffer.concat(chunks);
    headerEnd = bytes.indexOf("\n\n");
    if (
      headerEnd === -1 ||
      bytes.length < headerEnd + 6 ||
      bytes.subarray(headerEnd + 2, headerEnd + 6).toString() !== "PACK"
    ) {
      fail("invalid-archive", "The Git bundle has no bounded complete header or pack payload.");
    }
    let text;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, headerEnd));
    } catch {
      fail("invalid-archive", "The Git bundle header is not valid UTF-8.");
    }
    const lines = text.split("\n");
    const signature = lines.shift();
    const version = signature === "# v2 git bundle" ? 2 : signature === "# v3 git bundle" ? 3 : 0;
    if (version === 0) fail("invalid-archive", "The Git bundle version is unsupported.");
    const capabilities = [];
    const referenceLines = [];
    let prerequisiteCount = 0;
    for (const line of lines) {
      if (line.startsWith("@")) capabilities.push(line.slice(1));
      else if (line.startsWith("-")) prerequisiteCount += 1;
      else referenceLines.push(line);
    }
    if (prerequisiteCount !== 0) fail("archive-not-self-contained", "The Git bundle has prerequisites.");
    const expectedCapability = `object-format=${expectedObjectFormat}`;
    if (
      (version === 2 && (expectedObjectFormat !== "sha1" || capabilities.length !== 0)) ||
      (version === 3 && (capabilities.length !== 1 || capabilities[0] !== expectedCapability))
    ) {
      fail("archive-not-self-contained", "The Git bundle has an unexpected object format or capability.");
    }
    const refs = parseRefList(`${referenceLines.join("\n")}\n`, expectedObjectFormat, "Git bundle header", {
      allowHead: true,
      allowWorktreeHeads: true,
      allowArchivePseudorefs: true
    });
    return Object.freeze({ version, objectFormat: expectedObjectFormat, capabilities, prerequisiteCount, refs });
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function parseStatus(output) {
  return Object.freeze(
    output
      .split("\0")
      .filter(Boolean)
      .map((line) =>
        line.startsWith("? ")
          ? Object.freeze({ kind: "untracked", path: line.slice(2) })
          : line.startsWith("! ")
            ? Object.freeze({ kind: "ignored", path: line.slice(2) })
            : Object.freeze({ kind: "tracked", path: null })
      )
  );
}

function configuredContentFilterKeys(output) {
  return Object.freeze(
    output
      .split("\0")
      .filter(Boolean)
      .map((key) => key.toLowerCase())
      .filter((key) => /^filter\..+\.(?:clean|process|required)$/u.test(key))
  );
}

function unsafeArchiveConfigKeys(output) {
  return Object.freeze(
    output
      .split("\0")
      .filter(Boolean)
      .map((key) => key.toLowerCase())
      .filter(
        (key) =>
          key === "extensions.partialclone" ||
          /^remote\..+\.(?:promisor|partialclonefilter)$/u.test(key) ||
          /^filter\..+\.(?:clean|process|required)$/u.test(key)
      )
  );
}

function unsafeLegacyConfigKeys(output) {
  return Object.freeze(
    output
      .split("\0")
      .filter(Boolean)
      .map((key) => key.toLowerCase())
      .filter(
        (key) =>
          key === "include.path" ||
          /^includeif\..+\.path$/u.test(key) ||
          key === "extensions.worktreeconfig" ||
          key === "core.worktree" ||
          key === "core.attributesfile" ||
          key === "core.excludesfile" ||
          key === "core.sparsecheckout" ||
          key === "core.sparsecheckoutcone" ||
          key === "core.splitindex" ||
          key === "index.sparse"
      )
  );
}

function entryExistsNoFollow(path, label) {
  try {
    lstatSync(path, { bigint: true });
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    fail("archive-not-eligible", `${label} could not be inspected safely: ${error.message}`);
  }
}

function decimalBigInt(value, label) {
  const trimmed = typeof value === "string" ? value.trim() : "";
  if (!/^(?:0|[1-9][0-9]{0,39})$/u.test(trimmed)) {
    fail("archive-not-eligible", `${label} is malformed.`);
  }
  return BigInt(trimmed);
}

function belongsToGeneratedRoot(path, roots) {
  const normalized = path.endsWith("/") ? path.slice(0, -1) : path;
  return roots.some((root) => normalized === root || normalized.startsWith(`${root}/`));
}

function normalizeLegacyGeneratedPath(value, label) {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 1024 ||
    value.includes("\\") ||
    [...value].some((character) => {
      const codePoint = character.codePointAt(0);
      return codePoint <= 0x1f || codePoint === 0x7f || character === ":";
    }) ||
    posix.isAbsolute(value) ||
    posix.normalize(value) !== value
  ) {
    fail("invalid-legacy-generated-path", `${label} must be one canonical repository-relative path.`);
  }
  const components = value.split("/");
  if (
    components.length > 32 ||
    components.some(
      (component) =>
        component === "" ||
        component === "." ||
        component === ".." ||
        component.toLowerCase() === ".git" ||
        component.endsWith(".") ||
        component.endsWith(" ")
    )
  ) {
    fail("invalid-legacy-generated-path", `${label} contains an unsafe path component.`);
  }
  return value;
}

function normalizeLegacyGeneratedAllowlist(generatedRoots = [], generatedFiles = []) {
  if (
    !Array.isArray(generatedRoots) ||
    !Array.isArray(generatedFiles) ||
    generatedRoots.length + generatedFiles.length > MAXIMUM_LEGACY_GENERATED_ITEMS
  ) {
    fail("invalid-legacy-generated-path", "The legacy generated allowlist is too large.");
  }
  const items = [
    ...generatedRoots.map((path) => ({
      kind: "directory",
      path: normalizeLegacyGeneratedPath(path, "Generated root")
    })),
    ...generatedFiles.map((path) => ({ kind: "file", path: normalizeLegacyGeneratedPath(path, "Generated file") }))
  ]
    .map((item) => ({ ...item, comparisonKey: item.path.toLowerCase() }))
    .sort(
      (left, right) =>
        Buffer.compare(Buffer.from(left.comparisonKey), Buffer.from(right.comparisonKey)) ||
        Buffer.compare(Buffer.from(left.path), Buffer.from(right.path))
    );
  if (new Set(items.map(({ comparisonKey }) => comparisonKey)).size !== items.length) {
    fail("invalid-legacy-generated-path", "The legacy generated allowlist contains a duplicate path.");
  }
  for (const [index, item] of items.entries()) {
    for (const other of items.slice(index + 1)) {
      if (
        other.comparisonKey.startsWith(`${item.comparisonKey}/`) ||
        item.comparisonKey.startsWith(`${other.comparisonKey}/`)
      ) {
        fail("invalid-legacy-generated-path", "Legacy generated allowlist entries may not overlap.");
      }
    }
  }
  return Object.freeze(items.map(({ kind, path }) => Object.freeze({ kind, path })));
}

export function validateLegacyIndexStages(output) {
  if (typeof output !== "string") {
    fail("legacy-audit-not-eligible", "The candidate index stage output is malformed.");
  }
  const stages = output.split("\0").filter(Boolean);
  if (
    stages.some((line) => {
      const match = /^(\d{6}) [0-9a-f]{40,64} ([0-3])\t/u.exec(line);
      return match === null || ["040000", "160000"].includes(match[1]) || match[2] !== "0";
    })
  ) {
    fail("legacy-audit-not-eligible", "The candidate index contains a directory, gitlink, or unresolved stage.");
  }
  return stages.length;
}

function copyLegacyAdminFile(sourcePath, destinationPath, label, maximumBytes) {
  let sourceDescriptor;
  let destinationDescriptor;
  try {
    sourceDescriptor = openSync(sourcePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const before = fstatSync(sourceDescriptor, { bigint: true });
    if (
      !before.isFile() ||
      before.nlink !== 1n ||
      !currentUserOwns(before) ||
      before.size < 0n ||
      before.size > BigInt(maximumBytes) ||
      before.size > BigInt(Number.MAX_SAFE_INTEGER)
    ) {
      fail("legacy-audit-not-eligible", `${label} is not one bounded owned regular file.`);
    }
    destinationDescriptor = openSync(
      destinationPath,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0),
      0o600
    );
    fchmodSync(destinationDescriptor, 0o600);
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    const size = Number(before.size);
    let offset = 0;
    while (offset < size) {
      const count = readSync(sourceDescriptor, buffer, 0, Math.min(buffer.length, size - offset), offset);
      if (count === 0) fail("legacy-checkout-changed", `${label} changed while it was snapshotted.`);
      hash.update(buffer.subarray(0, count));
      let written = 0;
      while (written < count) {
        written += writeSync(destinationDescriptor, buffer, written, count - written);
      }
      offset += count;
    }
    fsyncSync(destinationDescriptor);
    const after = fstatSync(sourceDescriptor, { bigint: true });
    if (
      !sameIdentity(identityOf(before), identityOf(after)) ||
      before.size !== after.size ||
      before.mode !== after.mode ||
      before.mtimeNs !== after.mtimeNs ||
      before.ctimeNs !== after.ctimeNs
    ) {
      fail("legacy-checkout-changed", `${label} changed while it was snapshotted.`);
    }
    revalidatePathIdentity(sourcePath, identityOf(before), label);
    return Object.freeze({
      path: sourcePath,
      identity: identityOf(before),
      size: before.size.toString(),
      mode: before.mode.toString(),
      mtimeNs: before.mtimeNs.toString(),
      ctimeNs: before.ctimeNs.toString(),
      sha256: hash.digest("hex"),
      maximumBytes
    });
  } catch (error) {
    if (error instanceof CheckoutLifecycleError) throw error;
    fail("legacy-audit-not-eligible", `${label} could not be snapshotted safely: ${error.message}`);
  } finally {
    if (destinationDescriptor !== undefined) closeSync(destinationDescriptor);
    if (sourceDescriptor !== undefined) closeSync(sourceDescriptor);
  }
}

function revalidateLegacyAdminFile(receipt, label) {
  let descriptor;
  try {
    descriptor = openSync(receipt.path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const before = fstatSync(descriptor, { bigint: true });
    if (
      !before.isFile() ||
      before.nlink !== 1n ||
      !currentUserOwns(before) ||
      !sameIdentity(identityOf(before), receipt.identity) ||
      before.size.toString() !== receipt.size ||
      before.mode.toString() !== receipt.mode ||
      before.mtimeNs.toString() !== receipt.mtimeNs ||
      before.ctimeNs.toString() !== receipt.ctimeNs ||
      before.size > BigInt(receipt.maximumBytes) ||
      before.size > BigInt(Number.MAX_SAFE_INTEGER)
    ) {
      fail("legacy-checkout-changed", `${label} changed after its snapshot.`);
    }
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    const size = Number(before.size);
    let offset = 0;
    while (offset < size) {
      const count = readSync(descriptor, buffer, 0, Math.min(buffer.length, size - offset), offset);
      if (count === 0) fail("legacy-checkout-changed", `${label} changed while it was revalidated.`);
      hash.update(buffer.subarray(0, count));
      offset += count;
    }
    const after = fstatSync(descriptor, { bigint: true });
    if (
      !sameIdentity(identityOf(before), identityOf(after)) ||
      before.size !== after.size ||
      before.mode !== after.mode ||
      before.mtimeNs !== after.mtimeNs ||
      before.ctimeNs !== after.ctimeNs ||
      hash.digest("hex") !== receipt.sha256
    ) {
      fail("legacy-checkout-changed", `${label} changed while it was revalidated.`);
    }
    revalidatePathIdentity(receipt.path, receipt.identity, label);
  } catch (error) {
    if (error instanceof CheckoutLifecycleError) throw error;
    fail("legacy-checkout-changed", `${label} could not be revalidated safely: ${error.message}`);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function inspectLegacyAdminTree(sourceRoot, label, gitDirectory, options = {}) {
  const { destinationRoot, copyFiles = false, maximumFileBytes = MAXIMUM_LEGACY_REF_BYTES } = options;
  let entryCount = 0;
  const files = [];

  function visit(sourcePath, destinationPath, depth) {
    if (depth > MAXIMUM_LEGACY_ADMIN_DEPTH) {
      fail("legacy-audit-not-eligible", `${label} is nested too deeply.`);
    }
    const metadata = lstatSync(sourcePath, { bigint: true });
    if (
      !metadata.isDirectory() ||
      metadata.isSymbolicLink() ||
      !currentUserOwns(metadata) ||
      realpathSync(sourcePath) !== resolve(sourcePath) ||
      !(sourcePath === gitDirectory || isContained(gitDirectory, sourcePath))
    ) {
      fail("legacy-audit-not-eligible", `${label} contains an external or unsafe directory.`);
    }
    entryCount += 1;
    if (entryCount > MAXIMUM_LEGACY_ADMIN_ENTRIES) {
      fail("legacy-audit-not-eligible", `${label} contains too many entries.`);
    }
    if (destinationPath !== undefined) {
      mkdirSync(destinationPath, { mode: 0o700 });
      chmodSync(destinationPath, 0o700);
    }
    const identity = identityOf(metadata);
    const entries = readDirectoryBounded(sourcePath, MAXIMUM_LEGACY_ADMIN_ENTRIES, label).sort((left, right) =>
      Buffer.compare(Buffer.from(left.name), Buffer.from(right.name))
    );
    for (const item of entries) {
      const childSource = join(sourcePath, item.name);
      const childDestination = destinationPath === undefined ? undefined : join(destinationPath, item.name);
      const child = lstatSync(childSource, { bigint: true });
      entryCount += 1;
      if (entryCount > MAXIMUM_LEGACY_ADMIN_ENTRIES) {
        fail("legacy-audit-not-eligible", `${label} contains too many entries.`);
      }
      if (!currentUserOwns(child) || child.isSymbolicLink()) {
        fail("legacy-audit-not-eligible", `${label} contains an external or unsafe entry.`);
      }
      if (child.isDirectory()) {
        entryCount -= 1;
        visit(childSource, childDestination, depth + 1);
      } else if (child.isFile()) {
        if (copyFiles) {
          files.push(copyLegacyAdminFile(childSource, childDestination, `${label} file`, maximumFileBytes));
        }
      } else {
        fail("legacy-audit-not-eligible", `${label} contains a special file.`);
      }
    }
    revalidatePathIdentity(sourcePath, identity, label, "directory");
    return identity;
  }

  const identity = visit(sourceRoot, destinationRoot, 0);
  return Object.freeze({ identity, files: Object.freeze(files), entryCount });
}

function legacyPathIsAllowed(path, allowlist) {
  const normalized = path.endsWith("/") ? path.slice(0, -1) : path;
  return allowlist.some(
    (item) => normalized === item.path || (item.kind === "directory" && normalized.startsWith(`${item.path}/`))
  );
}

function legacyGeneratedAllowlistSuggestion(paths, directories = new Set()) {
  const roots = [
    ...new Set(paths.filter((path) => directories.has(path)).map((path) => path.replace(/\/$/u, "")))
  ].sort();
  const files = [
    ...new Set(
      paths
        .filter((path) => !directories.has(path))
        .map((path) => path.replace(/\/$/u, ""))
        .filter((path) => !roots.some((root) => path === root || path.startsWith(`${root}/`)))
    )
  ].sort();
  const maximumSuggestions = 16;
  const shownRoots = roots.slice(0, maximumSuggestions);
  const shownFiles = files.slice(0, Math.max(0, maximumSuggestions - shownRoots.length));
  const omitted = roots.length + files.length - shownRoots.length - shownFiles.length;
  return ` Review before declaring generatedRoots=${JSON.stringify(shownRoots)} and generatedFiles=${JSON.stringify(shownFiles)}${omitted === 0 ? "." : `; ${omitted} more path(s) were omitted.`}`;
}

function captureLegacyGeneratedFile(path, relativePath) {
  let descriptor;
  try {
    const parent = dirname(path);
    const parentMetadata = lstatSync(parent, { bigint: true });
    const parentIdentity = identityOf(parentMetadata);
    if (
      !parentMetadata.isDirectory() ||
      parentMetadata.isSymbolicLink() ||
      !currentUserOwns(parentMetadata) ||
      realpathSync(parent) !== resolve(parent)
    ) {
      fail("legacy-generated-inventory-unsafe", "A generated file has an unsafe parent directory.");
    }
    descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const before = fstatSync(descriptor, { bigint: true });
    if (
      !before.isFile() ||
      before.nlink !== 1n ||
      !currentUserOwns(before) ||
      before.size < 0n ||
      before.size > MAXIMUM_LEGACY_GENERATED_BYTES ||
      before.size > BigInt(Number.MAX_SAFE_INTEGER)
    ) {
      fail("legacy-generated-inventory-unsafe", "A generated file is not one bounded owned regular file.");
    }
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    const size = Number(before.size);
    let offset = 0;
    while (offset < size) {
      const count = readSync(descriptor, buffer, 0, Math.min(buffer.length, size - offset), offset);
      if (count === 0) fail("legacy-generated-inventory-changed", "A generated file changed while it was read.");
      hash.update(buffer.subarray(0, count));
      offset += count;
    }
    const after = fstatSync(descriptor, { bigint: true });
    if (
      !sameIdentity(identityOf(before), identityOf(after)) ||
      before.size !== after.size ||
      before.mode !== after.mode ||
      before.mtimeNs !== after.mtimeNs ||
      before.ctimeNs !== after.ctimeNs
    ) {
      fail("legacy-generated-inventory-changed", "A generated file changed while it was read.");
    }
    revalidatePathIdentity(path, identityOf(before), "Generated file");
    revalidatePathIdentity(parent, parentIdentity, "Generated file parent", "directory");
    return Object.freeze({
      record: Object.freeze({
        kind: "file",
        path: relativePath,
        mode: Number(before.mode & 0o7777n),
        byteLength: size.toString(),
        sha256: hash.digest("hex")
      }),
      byteLength: before.size
    });
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function captureLegacyGeneratedInventory(checkoutPath, allowlist) {
  const aggregate = createHash("sha256");
  let entryCount = 0;
  let byteLength = 0n;
  const add = (record, bytes = 0n) => {
    entryCount += 1;
    byteLength += bytes;
    if (entryCount > MAXIMUM_LEGACY_GENERATED_ENTRIES || byteLength > MAXIMUM_LEGACY_GENERATED_BYTES) {
      fail("legacy-generated-inventory-too-large", "The generated inventory exceeds its fixed limits.");
    }
    aggregate.update(`${JSON.stringify(record)}\n`);
  };

  function visitDirectory(path, relativePath, depth) {
    if (depth > MAXIMUM_LEGACY_GENERATED_DEPTH) {
      fail("legacy-generated-inventory-too-deep", "The generated inventory is nested too deeply.");
    }
    const before = lstatSync(path, { bigint: true });
    if (
      !before.isDirectory() ||
      before.isSymbolicLink() ||
      !currentUserOwns(before) ||
      realpathSync(path) !== resolve(path)
    ) {
      fail("legacy-generated-inventory-unsafe", "A generated root contains an unsafe directory.");
    }
    const identity = identityOf(before);
    add({ kind: "directory", path: relativePath, mode: Number(before.mode & 0o7777n) });
    const entries = readDirectoryBounded(path, MAXIMUM_LEGACY_GENERATED_ENTRIES, "The generated inventory").sort(
      (left, right) => Buffer.compare(Buffer.from(left.name), Buffer.from(right.name))
    );
    for (const item of entries) {
      const childPath = join(path, item.name);
      const childRelative = `${relativePath}/${item.name}`;
      const metadata = lstatSync(childPath, { bigint: true });
      if (!currentUserOwns(metadata)) {
        fail("legacy-generated-inventory-unsafe", "A generated root contains an entry owned by another user.");
      }
      if (metadata.isDirectory() && !metadata.isSymbolicLink()) {
        visitDirectory(childPath, childRelative, depth + 1);
      } else if (metadata.isFile() && !metadata.isSymbolicLink()) {
        const file = captureLegacyGeneratedFile(childPath, childRelative);
        add(file.record, file.byteLength);
      } else if (metadata.isSymbolicLink()) {
        const target = readlinkSync(childPath, { encoding: "buffer" });
        const after = lstatSync(childPath, { bigint: true });
        if (
          metadata.nlink !== 1n ||
          !sameIdentity(identityOf(metadata), identityOf(after)) ||
          metadata.mtimeNs !== after.mtimeNs ||
          metadata.ctimeNs !== after.ctimeNs
        ) {
          fail("legacy-generated-inventory-changed", "A generated symbolic link changed while it was read.");
        }
        add(
          {
            kind: "symlink",
            path: childRelative,
            byteLength: target.byteLength.toString(),
            sha256: sha256(target)
          },
          BigInt(target.byteLength)
        );
      } else {
        fail("legacy-generated-inventory-unsafe", "A generated root contains a special file.");
      }
    }
    revalidatePathIdentity(path, identity, "Generated directory", "directory");
  }

  for (const item of allowlist) {
    const path = join(checkoutPath, ...item.path.split("/"));
    if (item.kind === "directory") {
      visitDirectory(path, item.path, 0);
    } else {
      const file = captureLegacyGeneratedFile(path, item.path);
      add(file.record, file.byteLength);
    }
  }
  return Object.freeze({ entryCount, byteLength: byteLength.toString(), sha256: aggregate.digest("hex") });
}

function readDirectoryBounded(path, maximumEntries, label) {
  const directory = opendirSync(path);
  const entries = [];
  try {
    let item;
    while ((item = directory.readSync()) !== null) {
      if (entries.length === maximumEntries) fail("too-many-checkouts", `${label} contains too many entries.`);
      entries.push(item);
    }
  } finally {
    directory.closeSync();
  }
  return entries;
}

function captureVerificationRepository(path, expectedIdentity) {
  revalidatePathIdentity(path, expectedIdentity, "Verification repository", "directory");
  const records = [];
  let fileCount = 0;
  let directoryCount = 0;
  let byteLength = 0n;

  function visit(directoryPath, relativePath, depth) {
    if (depth > MAXIMUM_VERIFICATION_DEPTH) {
      fail("unsafe-archive", "The verification repository is nested too deeply.");
    }
    const metadata = lstatSync(directoryPath, { bigint: true });
    if (
      !metadata.isDirectory() ||
      metadata.isSymbolicLink() ||
      !currentUserOwns(metadata) ||
      realpathSync(directoryPath) !== resolve(directoryPath)
    ) {
      fail("unsafe-archive", "The verification repository contains an unsafe directory.");
    }
    directoryCount += 1;
    if (directoryCount + fileCount > MAXIMUM_VERIFICATION_FILES) {
      fail("unsafe-archive", "The verification repository contains too many entries.");
    }
    const directoryIdentity = identityOf(metadata);
    records.push(`d\0${relativePath}\0${directoryIdentity.device}\0${directoryIdentity.inode}\n`);
    const entries = readDirectoryBounded(directoryPath, MAXIMUM_VERIFICATION_FILES, "The verification repository").sort(
      (left, right) => Buffer.compare(Buffer.from(left.name), Buffer.from(right.name))
    );
    for (const item of entries) {
      if ([...item.name].some((character) => character.charCodeAt(0) === 0)) {
        fail("unsafe-archive", "The verification repository contains an invalid path.");
      }
      const childPath = join(directoryPath, item.name);
      const childRelative = relativePath === "" ? item.name : `${relativePath}/${item.name}`;
      if (item.isDirectory() && !item.isSymbolicLink()) {
        visit(childPath, childRelative, depth + 1);
        continue;
      }
      if (!item.isFile() || item.isSymbolicLink()) {
        fail("unsafe-archive", "The verification repository contains a symlink or special file.");
      }
      let descriptor;
      try {
        descriptor = openSync(childPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
        try {
          fsyncSync(descriptor);
        } catch (error) {
          if (process.platform !== "win32" || !["EINVAL", "EPERM"].includes(error.code)) throw error;
        }
        const receipt = hashDescriptor(descriptor, `Verification repository file ${childRelative}`);
        revalidatePathIdentity(childPath, receipt.identity, `Verification repository file ${childRelative}`);
        fileCount += 1;
        byteLength += BigInt(receipt.byteLength);
        if (directoryCount + fileCount > MAXIMUM_VERIFICATION_FILES) {
          fail("unsafe-archive", "The verification repository contains too many entries.");
        }
        records.push(
          `f\0${childRelative}\0${receipt.identity.device}\0${receipt.identity.inode}\0${receipt.byteLength}\0${receipt.sha256}\n`
        );
      } finally {
        if (descriptor !== undefined) closeSync(descriptor);
      }
    }
    fsyncDirectory(directoryPath);
    revalidatePathIdentity(directoryPath, directoryIdentity, "Verification repository directory", "directory");
  }

  visit(path, "", 0);
  revalidatePathIdentity(path, expectedIdentity, "Verification repository", "directory");
  return Object.freeze({
    path,
    identity: expectedIdentity,
    directoryCount,
    fileCount,
    byteLength: byteLength.toString(),
    sha256: sha256(records.join(""))
  });
}

function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === "ESRCH") return false;
    if (error.code === "EPERM") return true;
    throw error;
  }
}

function normalizePaths(root) {
  const managerRoot = resolve(root);
  return Object.freeze({
    root: managerRoot,
    entries: join(managerRoot, "entries"),
    checkouts: join(managerRoot, "checkouts"),
    locks: join(managerRoot, "locks"),
    retirements: join(managerRoot, "retirements"),
    archives: join(managerRoot, "archives"),
    quarantines: join(managerRoot, "quarantines"),
    quarantinedCheckouts: join(managerRoot, "quarantined-checkouts"),
    legacyAdoptions: join(managerRoot, "legacy-adoptions"),
    legacyAdoptionAttempts: join(managerRoot, "legacy-adoptions", "attempts"),
    legacyAdoptionEntries: join(managerRoot, "legacy-adoptions", "entries"),
    legacyArchives: join(managerRoot, "legacy-archives"),
    legacyArchiveAttempts: join(managerRoot, "legacy-archives", "attempts"),
    legacyArchiveEntries: join(managerRoot, "legacy-archives", "entries"),
    retirementSweeps: join(managerRoot, "retirement-sweeps"),
    managedRetirementSweeps: join(managerRoot, "retirement-sweeps", "managed"),
    legacyRetirementSweeps: join(managerRoot, "retirement-sweeps", "legacy"),
    retirementQuarantine: join(managerRoot, "retirement-quarantine"),
    managedRetirementQuarantine: join(managerRoot, "retirement-quarantine", "managed"),
    legacyRetirementQuarantine: join(managerRoot, "retirement-quarantine", "legacy"),
    artifactRetirements: join(managerRoot, "artifact-retirements"),
    artifactAttempts: join(managerRoot, "artifact-retirements", "attempts"),
    artifactEntries: join(managerRoot, "artifact-retirements", "entries"),
    artifactSweeps: join(managerRoot, "artifact-retirement-sweeps"),
    artifactQuarantine: join(managerRoot, "artifact-retirement-quarantine"),
    artifactPins: join(managerRoot, "artifact-retirement-pins")
  });
}

export function createCheckoutManager(options = {}) {
  const run = options.run ?? defaultRun;
  const repository = discoverRepository(
    run,
    options.repositoryPath ?? options.cwd ?? process.cwd(),
    options.managerRoot === undefined
  );
  const paths = normalizePaths(
    options.managerRoot ??
      repository.managerRoot ??
      join(dirname(repository.commonGitDirectory), "tmp", "agent-checkouts")
  );
  const tokenFactory = options.tokenFactory ?? randomToken;
  const isProcessAlive = options.isProcessAlive ?? processIsAlive;
  const statFilesystem = options.statfs ?? statfsSync;
  const readBootId = options.readBootId ?? (() => readFileSync("/proc/sys/kernel/random/boot_id", "utf8"));
  const readMountInfo = options.readMountInfo ?? (() => readFileSync("/proc/self/mountinfo", "utf8"));
  const syncArtifactDescriptor = options.syncArtifactDescriptor ?? fsyncSync;
  const syncArtifactDirectoryHook = options.syncArtifactDirectory;
  const hooks = options.hooks;
  const entryIdentities = new WeakMap();
  const managedIdentities = new Map();

  function validateRoutedSource() {
    const expected = repository.sourceRepository;
    if (expected === undefined) return undefined;
    let current;
    try {
      current = discoverRawRepository(run, expected.topLevel);
    } catch {
      fail("manager-source-changed", "The source repository could not be revalidated before checkout creation.");
    }
    const topLevelMetadata = lstatSync(current.topLevel, { bigint: true });
    if (
      current.topLevel !== expected.topLevel ||
      current.commonGitDirectory !== expected.commonGitDirectory ||
      !sameIdentity(current.identity, expected.commonGitIdentity) ||
      !sameIdentity(identityOf(topLevelMetadata), expected.topLevelIdentity) ||
      readSourceRemote(run, current.topLevel) !== repository.managerRemote
    ) {
      fail("manager-source-changed", "The source repository changed before checkout creation.");
    }
    return current;
  }

  function resolveCreateBase(base) {
    const source = validateRoutedSource();
    if (source === undefined) {
      return checkoutGit(run, paths, repository.topLevel, ["rev-parse", "--verify", `${base}^{commit}`]).stdout.trim();
    }
    const before = checkoutGit(run, paths, source.topLevel, [
      "rev-parse",
      "--verify",
      `${base}^{commit}`
    ]).stdout.trim();
    if (!SHA_PATTERN.test(before)) fail("manager-source-changed", "The source base revision is malformed.");
    const synchronized = commonGit(
      run,
      paths,
      repository,
      [
        "-c",
        "protocol.file.allow=always",
        "-c",
        "maintenance.auto=false",
        "-c",
        `core.hooksPath=${process.platform === "win32" ? "NUL" : "/dev/null"}`,
        "fetch",
        "--quiet",
        "--force",
        "--no-tags",
        "--no-write-fetch-head",
        "--no-recurse-submodules",
        source.topLevel,
        `+${before}:refs/openwrangler/source-base`
      ],
      { allowFailure: true, env: auditGitEnvironment() }
    );
    if (synchronized.status !== 0) {
      fail("manager-source-sync-failed", "The local source commit could not be copied into the checkout manager.");
    }
    const afterSource = validateRoutedSource();
    const after = checkoutGit(run, paths, afterSource.topLevel, [
      "rev-parse",
      "--verify",
      `${base}^{commit}`
    ]).stdout.trim();
    if (after !== before) fail("manager-source-changed", "The source base changed while the manager was synchronized.");
    const managerCommit = commonGit(run, paths, repository, ["rev-parse", "--verify", `${before}^{commit}`], {
      env: auditGitEnvironment()
    }).stdout.trim();
    if (managerCommit !== before) fail("manager-source-sync-failed", "The checkout manager received the wrong commit.");
    const verified = assertSelfContainedManagerRepository(run, repository.commonGitDirectory, repository.managerRemote);
    if (!sameIdentity(verified.identity, repository.identity)) {
      fail("manager-bootstrap-drift", "The checkout manager repository changed during source synchronization.");
    }
    managerGit(
      run,
      repository.commonGitDirectory,
      ["fsck", "--strict", "--full", "--no-dangling"],
      "Synchronized manager verification"
    );
    return before;
  }

  function initializeManager(allowCreate) {
    if (managedIdentities.size > 0) return;
    for (const path of [paths.root, paths.entries, paths.checkouts, paths.locks]) {
      if (!allowCreate && !existsSync(path)) {
        fail("checkout-not-found", "The managed checkout registry does not exist.");
      }
      managedIdentities.set(path, allowCreate ? ensurePrivateDirectory(path) : assertPrivateDirectory(path, path));
    }
  }

  function initializeRetirementJournal() {
    const identity = managedIdentities.get(paths.retirements);
    if (identity === undefined) {
      managedIdentities.set(paths.retirements, ensurePrivateDirectory(paths.retirements));
      return;
    }
    assertPrivateDirectory(paths.retirements, paths.retirements);
    revalidatePathIdentity(paths.retirements, identity, paths.retirements, "directory");
  }

  function initializeArchiveJournal() {
    const identity = managedIdentities.get(paths.archives);
    if (identity === undefined) {
      managedIdentities.set(paths.archives, ensurePrivateDirectory(paths.archives));
      return;
    }
    assertPrivateDirectory(paths.archives, paths.archives);
    revalidatePathIdentity(paths.archives, identity, paths.archives, "directory");
  }

  function initializeRetirementSweepJournal() {
    for (const path of [
      paths.retirementSweeps,
      paths.managedRetirementSweeps,
      paths.legacyRetirementSweeps,
      paths.retirementQuarantine,
      paths.managedRetirementQuarantine,
      paths.legacyRetirementQuarantine
    ]) {
      const identity = managedIdentities.get(path);
      if (identity === undefined) managedIdentities.set(path, ensurePrivateDirectory(path));
      else {
        assertPrivateDirectory(path, path);
        revalidatePathIdentity(path, identity, path, "directory");
      }
    }
  }

  function currentBootId() {
    if (process.platform !== "linux" && options.readBootId === undefined) {
      fail("retirement-unsupported", "Automatic checkout retirement currently requires Linux boot IDs.");
    }
    let value;
    try {
      value = String(readBootId()).trim().toLowerCase();
    } catch (error) {
      fail("boot-id-unavailable", `The current Linux boot ID could not be read: ${error.message}`);
    }
    if (!BOOT_ID_PATTERN.test(value)) {
      fail("boot-id-unavailable", "The current Linux boot ID is malformed.");
    }
    return value;
  }

  function decodeMountInfoPath(value) {
    if (typeof value !== "string" || value === "" || /\\(?!(?:040|011|012|134))/u.test(value)) {
      fail("mount-info-unavailable", "Linux mount information contains a malformed path.");
    }
    return value.replace(/\\(040|011|012|134)/gu, (_match, octal) => String.fromCharCode(Number.parseInt(octal, 8)));
  }

  function linuxMountPoints() {
    if (process.platform !== "linux" && options.readMountInfo === undefined) {
      fail("retirement-unsupported", "Automatic legacy checkout retirement requires Linux mount information.");
    }
    let text;
    try {
      text = String(readMountInfo());
    } catch (error) {
      fail("mount-info-unavailable", `Linux mount information could not be read: ${error.message}`);
    }
    if (Buffer.byteLength(text, "utf8") > MAXIMUM_COMMAND_OUTPUT_BYTES || (text !== "" && !text.endsWith("\n"))) {
      fail("mount-info-unavailable", "Linux mount information is too large or truncated.");
    }
    const points = [];
    for (const line of text.split("\n")) {
      if (line === "") continue;
      const separator = line.indexOf(" - ");
      const fields = separator === -1 ? [] : line.slice(0, separator).split(" ");
      if (fields.length < 6 || !/^[1-9][0-9]*$/u.test(fields[0]) || !/^[1-9][0-9]*$/u.test(fields[1])) {
        fail("mount-info-unavailable", "Linux mount information is malformed.");
      }
      const decoded = decodeMountInfoPath(fields[4]);
      if (!isAbsolute(decoded)) fail("mount-info-unavailable", "Linux mount information has a relative mount point.");
      points.push(resolve(decoded));
    }
    return Object.freeze(points);
  }

  function assertNoMountAtOrBelow(path) {
    const target = resolve(path);
    if (linuxMountPoints().some((point) => point === target || isContained(target, point))) {
      fail(
        "retirement-mount-present",
        "The legacy checkout contains a mount point and cannot be retired automatically."
      );
    }
  }

  function initializeLegacyAdoptionJournal() {
    for (const path of [paths.legacyAdoptions, paths.legacyAdoptionAttempts, paths.legacyAdoptionEntries]) {
      const identity = managedIdentities.get(path);
      if (identity === undefined) managedIdentities.set(path, ensurePrivateDirectory(path));
      else {
        assertPrivateDirectory(path, path);
        revalidatePathIdentity(path, identity, path, "directory");
      }
    }
  }

  function initializeLegacyArchiveJournal() {
    for (const path of [paths.legacyArchives, paths.legacyArchiveAttempts, paths.legacyArchiveEntries]) {
      const identity = managedIdentities.get(path);
      if (identity === undefined) managedIdentities.set(path, ensurePrivateDirectory(path));
      else {
        assertPrivateDirectory(path, path);
        revalidatePathIdentity(path, identity, path, "directory");
      }
    }
  }

  function initializeArtifactJournal() {
    for (const path of [
      paths.artifactRetirements,
      paths.artifactAttempts,
      paths.artifactEntries,
      paths.artifactSweeps,
      paths.artifactQuarantine,
      paths.artifactPins
    ]) {
      const identity = managedIdentities.get(path);
      if (identity === undefined) managedIdentities.set(path, ensurePrivateDirectory(path));
      else {
        assertPrivateDirectory(path, path);
        revalidatePathIdentity(path, identity, path, "directory");
      }
    }
  }

  function captureLegacyDirectory(path, label, expectedIdentity = undefined) {
    let metadata;
    try {
      metadata = lstatSync(path, { bigint: true });
    } catch {
      fail("legacy-checkout-not-found", `${label} is missing.`);
    }
    const identity = identityOf(metadata);
    if (
      !metadata.isDirectory() ||
      metadata.isSymbolicLink() ||
      !currentUserOwns(metadata) ||
      realpathSync(path) !== resolve(path) ||
      (expectedIdentity !== undefined && !sameIdentity(identity, expectedIdentity))
    ) {
      fail("legacy-checkout-unsafe", `${label} is not the expected owned canonical directory.`);
    }
    return identity;
  }

  function legacyProhibitedAdminPaths(gitDirectory) {
    return Object.freeze([
      join(gitDirectory, "modules"),
      join(gitDirectory, "worktrees"),
      join(gitDirectory, "shallow"),
      join(gitDirectory, "index.lock"),
      join(gitDirectory, "HEAD.lock"),
      join(gitDirectory, "config.lock"),
      join(gitDirectory, "packed-refs.lock"),
      join(gitDirectory, "shallow.lock"),
      join(gitDirectory, "MERGE_HEAD"),
      join(gitDirectory, "MERGE_MSG"),
      join(gitDirectory, "MERGE_MODE"),
      join(gitDirectory, "MERGE_AUTOSTASH"),
      join(gitDirectory, "MERGE_RR"),
      join(gitDirectory, "AUTO_MERGE"),
      join(gitDirectory, "CHERRY_PICK_HEAD"),
      join(gitDirectory, "REVERT_HEAD"),
      join(gitDirectory, "REBASE_HEAD"),
      join(gitDirectory, "REBASE_AUTOSTASH"),
      join(gitDirectory, "SQUASH_MSG"),
      join(gitDirectory, "BISECT_LOG"),
      join(gitDirectory, "BISECT_HEAD"),
      join(gitDirectory, "BISECT_START"),
      join(gitDirectory, "BISECT_NAMES"),
      join(gitDirectory, "BISECT_TERMS"),
      join(gitDirectory, "BISECT_EXPECTED_REV"),
      join(gitDirectory, "BISECT_ANCESTORS_OK"),
      join(gitDirectory, "BISECT_RUN"),
      join(gitDirectory, "REWRITTEN_LIST"),
      join(gitDirectory, "REWRITTEN_PENDING"),
      join(gitDirectory, "rebase-merge"),
      join(gitDirectory, "rebase-apply"),
      join(gitDirectory, "sequencer")
    ]);
  }

  function createLegacyAuditSnapshot(candidate) {
    const gitRootEntries = readDirectoryBounded(
      candidate.gitDirectory,
      MAXIMUM_LEGACY_ADMIN_ENTRIES,
      "The legacy Git directory"
    );
    if (
      gitRootEntries.some(
        (item) => item.name.toLowerCase() === "config.worktree" || item.name.toLowerCase().startsWith("sharedindex.")
      ) ||
      legacyProhibitedAdminPaths(candidate.gitDirectory).some((path) =>
        entryExistsNoFollow(path, "Legacy Git metadata")
      )
    ) {
      fail("legacy-audit-not-eligible", "The candidate has unsupported local Git or operation state.");
    }

    const auditRoot = withPrivateUmask(() => mkdtempSync(join(paths.root, ".legacy-audit-")));
    chmodSync(auditRoot, 0o700);
    const auditRootIdentity = assertPrivateDirectory(auditRoot, "Legacy audit workspace");
    const shadowGitDirectory = join(auditRoot, "git");
    mkdirSync(shadowGitDirectory, { mode: 0o700 });
    chmodSync(shadowGitDirectory, 0o700);
    const shadowGitIdentity = assertPrivateDirectory(shadowGitDirectory, "Legacy audit Git snapshot");
    try {
      const objectDirectory = join(candidate.gitDirectory, "objects");
      const refsDirectory = join(candidate.gitDirectory, "refs");
      const logsDirectory = join(candidate.gitDirectory, "logs");
      const infoDirectory = join(candidate.gitDirectory, "info");
      const objects = inspectLegacyAdminTree(objectDirectory, "The legacy object store", candidate.gitDirectory);
      const refs = inspectLegacyAdminTree(refsDirectory, "The legacy refs", candidate.gitDirectory, {
        destinationRoot: join(shadowGitDirectory, "refs"),
        copyFiles: true,
        maximumFileBytes: MAXIMUM_LEGACY_REF_BYTES
      });
      const logs = inspectLegacyAdminTree(logsDirectory, "The legacy reflogs", candidate.gitDirectory);
      const info = entryExistsNoFollow(infoDirectory, "The legacy Git info directory")
        ? inspectLegacyAdminTree(infoDirectory, "The legacy Git info directory", candidate.gitDirectory)
        : undefined;
      if (
        [
          join(objectDirectory, "info", "alternates"),
          join(objectDirectory, "info", "http-alternates"),
          join(infoDirectory, "grafts")
        ].some((path) => entryExistsNoFollow(path, "Legacy Git metadata"))
      ) {
        fail("legacy-audit-not-eligible", "The candidate uses external or replacement object state.");
      }
      const config = copyLegacyAdminFile(
        join(candidate.gitDirectory, "config"),
        join(shadowGitDirectory, "config"),
        "Legacy configuration",
        MAXIMUM_LEGACY_CONFIG_BYTES
      );
      const index = copyLegacyAdminFile(
        join(candidate.gitDirectory, "index"),
        join(shadowGitDirectory, "index"),
        "Legacy index",
        MAXIMUM_LEGACY_INDEX_BYTES
      );
      const head = copyLegacyAdminFile(
        join(candidate.gitDirectory, "HEAD"),
        join(shadowGitDirectory, "HEAD"),
        "Legacy HEAD file",
        MAXIMUM_WORKTREE_FIELD_BYTES
      );
      let packedRefs;
      const packedRefsPath = join(candidate.gitDirectory, "packed-refs");
      if (entryExistsNoFollow(packedRefsPath, "Legacy packed refs")) {
        packedRefs = copyLegacyAdminFile(
          packedRefsPath,
          join(shadowGitDirectory, "packed-refs"),
          "Legacy packed refs",
          MAXIMUM_LEGACY_PACKED_REFS_BYTES
        );
      }
      const packDirectory = join(objectDirectory, "pack");
      if (
        entryExistsNoFollow(packDirectory, "Legacy pack directory") &&
        readDirectoryBounded(packDirectory, MAXIMUM_ARCHIVE_PACK_FILES, "The legacy pack directory").some((item) =>
          item.name.toLowerCase().endsWith(".promisor")
        )
      ) {
        fail("legacy-audit-not-eligible", "The candidate contains a promisor pack.");
      }
      fsyncDirectory(shadowGitDirectory);
      revalidatePathIdentity(auditRoot, auditRootIdentity, "Legacy audit workspace", "directory");
      revalidatePathIdentity(shadowGitDirectory, shadowGitIdentity, "Legacy audit Git snapshot", "directory");
      return Object.freeze({
        root: auditRoot,
        rootIdentity: auditRootIdentity,
        gitDirectory: shadowGitDirectory,
        gitIdentity: shadowGitIdentity,
        checkout: candidate.checkout,
        sourceGitDirectory: candidate.gitDirectory,
        sourceGitIdentity: candidate.gitIdentity,
        objectDirectory,
        objectsIdentity: objects.identity,
        refsDirectory,
        refsIdentity: refs.identity,
        logsDirectory,
        logsIdentity: logs.identity,
        infoDirectory: info === undefined ? undefined : infoDirectory,
        infoIdentity: info?.identity,
        config,
        index,
        head,
        packedRefs,
        refFiles: refs.files,
        worktreeReceipt: JSON.stringify({
          kind: "standalone-dot-git-directory",
          checkout: candidate.checkout,
          checkoutIdentity: candidate.checkoutIdentity,
          gitDirectory: candidate.gitDirectory,
          gitDirectoryIdentity: candidate.gitIdentity
        })
      });
    } catch (error) {
      revalidatePathIdentity(auditRoot, auditRootIdentity, "Legacy audit workspace", "directory");
      rmSync(auditRoot, { recursive: true, force: false });
      fsyncDirectory(paths.root);
      throw error;
    }
  }

  function revalidateLegacyAuditSnapshot(snapshot) {
    revalidatePathIdentity(
      snapshot.sourceGitDirectory,
      snapshot.sourceGitIdentity,
      "The legacy Git directory",
      "directory"
    );
    revalidatePathIdentity(snapshot.objectDirectory, snapshot.objectsIdentity, "The legacy object store", "directory");
    revalidatePathIdentity(snapshot.refsDirectory, snapshot.refsIdentity, "The legacy refs", "directory");
    revalidatePathIdentity(snapshot.logsDirectory, snapshot.logsIdentity, "The legacy reflogs", "directory");
    if (snapshot.infoDirectory !== undefined) {
      revalidatePathIdentity(
        snapshot.infoDirectory,
        snapshot.infoIdentity,
        "The legacy Git info directory",
        "directory"
      );
    }
    revalidateLegacyAdminFile(snapshot.config, "Legacy configuration");
    revalidateLegacyAdminFile(snapshot.index, "Legacy index");
    revalidateLegacyAdminFile(snapshot.head, "Legacy HEAD file");
    if (snapshot.packedRefs !== undefined) revalidateLegacyAdminFile(snapshot.packedRefs, "Legacy packed refs");
    for (const ref of snapshot.refFiles) revalidateLegacyAdminFile(ref, "Legacy ref");
    revalidatePathIdentity(snapshot.root, snapshot.rootIdentity, "Legacy audit workspace", "directory");
    revalidatePathIdentity(snapshot.gitDirectory, snapshot.gitIdentity, "Legacy audit Git snapshot", "directory");
  }

  function removeLegacyAuditSnapshot(snapshot) {
    revalidatePathIdentity(snapshot.root, snapshot.rootIdentity, "Legacy audit workspace", "directory");
    if (!isContained(paths.root, snapshot.root) || dirname(snapshot.root) !== paths.root) {
      fail("legacy-checkout-changed", "The legacy audit workspace escaped its private parent.");
    }
    rmSync(snapshot.root, { recursive: true, force: false });
    fsyncDirectory(paths.root);
  }

  function legacyCandidatePaths(slug, explicitTarget = undefined) {
    assertSlug(slug);
    const source = repository.bootstrapSourceRepository;
    if (source === undefined) {
      fail("legacy-bootstrap-required", "Legacy checkout inspection requires the self-contained checkout manager.");
    }
    captureLegacyDirectory(source.topLevel, "The bootstrap source", source.topLevelIdentity);
    revalidatePathIdentity(
      source.commonGitDirectory,
      source.commonGitIdentity,
      "The bootstrap source Git directory",
      "directory"
    );
    const parent =
      explicitTarget === undefined
        ? join(source.topLevel, "tmp", "codex-checkpoints")
        : resolve(explicitTarget.approvedRoot);
    const parentIdentity = captureLegacyDirectory(parent, "The legacy checkout parent");
    const checkout = explicitTarget === undefined ? join(parent, slug) : resolve(explicitTarget.checkoutPath);
    if (
      (explicitTarget === undefined && (dirname(checkout) !== parent || !isContained(parent, checkout))) ||
      (explicitTarget !== undefined &&
        (dirname(checkout) !== parent || !isContained(parent, checkout) || basename(checkout) !== slug))
    ) {
      fail("legacy-checkout-unsafe", "The legacy checkout path is outside its approved root.");
    }
    if (
      explicitTarget !== undefined &&
      (checkout === source.topLevel ||
        isSameOrContained(paths.root, checkout) ||
        isSameOrContained(checkout, paths.root))
    ) {
      fail("legacy-checkout-unsafe", "The source and checkout-manager trees cannot be adopted as legacy checkouts.");
    }
    const checkoutIdentity = captureLegacyDirectory(checkout, "The legacy checkout");
    const gitDirectory = join(checkout, ".git");
    let gitMetadata;
    try {
      gitMetadata = lstatSync(gitDirectory, { bigint: true });
    } catch {
      fail("legacy-checkout-not-found", "The legacy checkout Git metadata is missing.");
    }
    if (explicitTarget !== undefined && gitMetadata.isFile()) {
      fail(
        "legacy-linked-worktree-not-adoptable",
        "Linked worktrees require their original manager or a future registered-worktree retirement protocol."
      );
    }
    const gitIdentity = captureLegacyDirectory(gitDirectory, "The legacy checkout Git directory");
    revalidatePathIdentity(parent, parentIdentity, "The legacy checkout parent", "directory");
    if (explicitTarget !== undefined) {
      if (
        explicitTarget.approvedRoot !== parent ||
        explicitTarget.checkoutPath !== checkout ||
        (explicitTarget.approvedRootIdentity !== undefined &&
          !sameIdentity(explicitTarget.approvedRootIdentity, parentIdentity)) ||
        (explicitTarget.checkoutIdentity !== undefined &&
          !sameIdentity(explicitTarget.checkoutIdentity, checkoutIdentity)) ||
        (explicitTarget.gitDirectoryIdentity !== undefined &&
          !sameIdentity(explicitTarget.gitDirectoryIdentity, gitIdentity))
      ) {
        fail("legacy-checkout-changed", "The explicit legacy checkout target changed identity.");
      }
    }
    return Object.freeze({
      source,
      parent,
      parentIdentity,
      checkout,
      checkoutIdentity,
      gitDirectory,
      gitIdentity,
      explicit: explicitTarget !== undefined
    });
  }

  function requireLegacyGit(snapshot, args, label, options = {}) {
    const result = run(
      "git",
      [
        "--git-dir",
        snapshot.gitDirectory,
        "--work-tree",
        snapshot.checkout,
        "-c",
        "core.fsmonitor=false",
        "-c",
        `core.hooksPath=${process.platform === "win32" ? "NUL" : "/dev/null"}`,
        "-c",
        "submodule.recurse=false",
        ...args
      ],
      {
        cwd: paths.root,
        allowFailure: true,
        env: { ...auditGitEnvironment(), GIT_OBJECT_DIRECTORY: snapshot.objectDirectory },
        input: options.input,
        stdinFd: options.stdinFd,
        stdoutFd: options.stdoutFd
      }
    );
    if (options.statuses?.includes(result.status)) return result;
    if (result.status !== 0) fail("legacy-audit-not-eligible", `${label} could not be proven.`);
    return result;
  }

  function captureLegacyRepositoryProof(snapshot) {
    const remote = requireLegacyGit(
      snapshot,
      ["config", "--local", "--no-includes", "--get", "remote.origin.url"],
      "Legacy origin remote",
      { statuses: [0, 1] }
    );
    const expectedRemote = canonicalRepositoryRemote(
      repository.managerRemote,
      repository.bootstrapSourceRepository.topLevel
    );
    const candidateRemote =
      remote.status === 0 ? canonicalRepositoryRemote(remote.stdout.trim(), snapshot.checkout) : null;
    if (expectedRemote === null || candidateRemote === null || candidateRemote !== expectedRemote) {
      fail("legacy-repository-mismatch", "The explicit checkout does not use the same canonical origin repository.");
    }
    const roots = requireLegacyGit(snapshot, ["rev-list", "--max-parents=0", "--all"], "Legacy repository roots")
      .stdout.split("\n")
      .filter(Boolean)
      .sort();
    if (
      roots.length < 1 ||
      roots.length > MAXIMUM_REPOSITORY_ROOTS ||
      new Set(roots).size !== roots.length ||
      roots.some((root) => !SHA_PATTERN.test(root))
    ) {
      fail("legacy-repository-mismatch", "The explicit checkout has an unsupported repository-root set.");
    }
    const sharedRoots = roots.filter(
      (root) =>
        commonGit(run, paths, repository, ["cat-file", "-e", `${root}^{commit}`], {
          allowFailure: true,
          env: auditGitEnvironment()
        }).status === 0
    );
    if (sharedRoots.length < 1) {
      fail("legacy-repository-mismatch", "The explicit checkout shares no verified root commit with the manager.");
    }
    return Object.freeze({
      remoteSha256: sha256(candidateRemote),
      rootCount: roots.length,
      rootsSha256: sha256(`${roots.join("\n")}\n`),
      sharedRootCount: sharedRoots.length,
      sharedRootsSha256: sha256(`${sharedRoots.join("\n")}\n`)
    });
  }

  function captureLegacyAudit(
    slug,
    generatedRoots = [],
    generatedFiles = [],
    explicitTarget = undefined,
    dependencyCatalog = undefined
  ) {
    const allowlist = normalizeLegacyGeneratedAllowlist(generatedRoots, generatedFiles);
    const candidate = legacyCandidatePaths(slug, explicitTarget);
    const snapshot = createLegacyAuditSnapshot(candidate);
    try {
      const configNames = requireLegacyGit(
        snapshot,
        ["config", "--local", "--no-includes", "--null", "--name-only", "--list"],
        "Legacy configuration"
      ).stdout;
      if (
        configuredContentFilterKeys(configNames).length !== 0 ||
        unsafeArchiveConfigKeys(configNames).length !== 0 ||
        unsafeLegacyConfigKeys(configNames).length !== 0
      ) {
        fail(
          "legacy-audit-not-eligible",
          "The candidate has an include, external, sparse, split, partial, promisor, or content-filter configuration."
        );
      }
      const config = requireLegacyGit(
        snapshot,
        ["config", "--local", "--no-includes", "--null", "--list"],
        "Legacy configuration capture"
      ).stdout;
      const sharedIndexPath = requireLegacyGit(
        snapshot,
        ["rev-parse", "--shared-index-path"],
        "Legacy split-index extension"
      ).stdout.trim();
      if (sharedIndexPath !== "") {
        fail("legacy-audit-not-eligible", "The candidate index contains a split-index extension.");
      }
      const topLevel = resolve(
        requireLegacyGit(snapshot, ["rev-parse", "--show-toplevel"], "Legacy checkout root").stdout.trim()
      );
      if (topLevel !== candidate.checkout) {
        fail("legacy-audit-not-eligible", "The candidate is not one standalone checkout.");
      }
      const bareRepository = requireLegacyGit(
        snapshot,
        ["rev-parse", "--is-bare-repository"],
        "Legacy bare-repository inspection"
      ).stdout.trim();
      const shallowRepository = requireLegacyGit(
        snapshot,
        ["rev-parse", "--is-shallow-repository"],
        "Legacy shallow-repository inspection"
      ).stdout.trim();
      if (bareRepository !== "false" || shallowRepository !== "false") {
        fail("legacy-audit-not-eligible", "The candidate is not one complete standalone worktree.");
      }
      const worktreeOutput = snapshot.worktreeReceipt;
      const privateRefsOutput = requireLegacyGit(
        snapshot,
        [
          "for-each-ref",
          "--sort=refname",
          "--format=%(objectname) %(refname)",
          "refs/worktree/",
          "refs/bisect/",
          "refs/rewritten/"
        ],
        "Legacy private references"
      ).stdout;
      if (privateRefsOutput !== "") {
        fail("legacy-audit-not-eligible", "The candidate has private operation references.");
      }

      const flags = requireLegacyGit(snapshot, ["ls-files", "-v", "-z"], "Legacy index flags")
        .stdout.split("\0")
        .filter(Boolean);
      if (flags.some((line) => line[0] !== "H")) {
        fail("legacy-audit-not-eligible", "The candidate index uses unsafe path flags.");
      }
      validateLegacyIndexStages(
        requireLegacyGit(snapshot, ["ls-files", "--stage", "-z"], "Legacy index stages").stdout
      );
      if (
        requireLegacyGit(
          snapshot,
          ["diff-files", "--quiet", "--no-ext-diff", "--no-textconv", "--ignore-submodules=none", "--"],
          "Legacy tracked worktree",
          { statuses: [0, 1] }
        ).status !== 0 ||
        requireLegacyGit(
          snapshot,
          [
            "diff-index",
            "--cached",
            "--quiet",
            "--no-ext-diff",
            "--no-textconv",
            "--ignore-submodules=none",
            "HEAD",
            "--"
          ],
          "Legacy staged index",
          { statuses: [0, 1] }
        ).status !== 0
      ) {
        fail("legacy-audit-not-eligible", "The candidate has tracked or staged changes.");
      }

      for (const item of allowlist) {
        if (requireLegacyGit(snapshot, ["ls-files", "-z", "--", item.path], "Generated path tracking").stdout !== "") {
          fail("legacy-audit-not-eligible", "A generated allowlist path contains tracked content.");
        }
        const ignored = requireLegacyGit(
          snapshot,
          ["check-ignore", "--no-index", "--quiet", "--", item.path],
          "Generated ignore rule",
          { statuses: [0, 1] }
        );
        if (ignored.status !== 0) {
          fail("legacy-audit-not-eligible", "A generated allowlist path is not ignored by Git.");
        }
      }

      const statusOutput = requireLegacyGit(
        snapshot,
        ["status", "--porcelain=v2", "-z", "--untracked-files=all", "--ignored=matching", "--ignore-submodules=none"],
        "Legacy status"
      ).stdout;
      const status = parseStatus(statusOutput);
      if (status.some((item) => item.kind !== "ignored")) {
        fail("legacy-audit-not-eligible", "The candidate has tracked or untracked work.");
      }
      const unexpectedIgnoredStatus = status.filter((item) => !legacyPathIsAllowed(item.path, allowlist));
      if (unexpectedIgnoredStatus.length !== 0) {
        fail(
          "legacy-audit-not-eligible",
          `The candidate has ignored content outside the generated allowlist.${legacyGeneratedAllowlistSuggestion(
            unexpectedIgnoredStatus.map((item) => item.path),
            new Set(unexpectedIgnoredStatus.filter((item) => item.path.endsWith("/")).map((item) => item.path))
          )}`
        );
      }
      if (allowlist.some((allowed) => !status.some((item) => legacyPathIsAllowed(item.path, [allowed])))) {
        fail("legacy-audit-not-eligible", "A generated allowlist path was not reported as ignored.");
      }
      const ignoredListing = requireLegacyGit(
        snapshot,
        ["ls-files", "--others", "--ignored", "--exclude-standard", "-z"],
        "Legacy ignored-file listing"
      )
        .stdout.split("\0")
        .filter(Boolean);
      const unexpectedIgnoredFiles = ignoredListing.filter((path) => !legacyPathIsAllowed(path, allowlist));
      if (unexpectedIgnoredFiles.length !== 0) {
        fail(
          "legacy-audit-not-eligible",
          `The candidate has an ignored file outside the generated allowlist.${legacyGeneratedAllowlistSuggestion(
            unexpectedIgnoredFiles
          )}`
        );
      }

      const objectFormat = requireLegacyGit(
        snapshot,
        ["rev-parse", "--show-object-format"],
        "Legacy object format"
      ).stdout.trim();
      if (!["sha1", "sha256"].includes(objectFormat)) {
        fail("legacy-audit-not-eligible", "The candidate uses an unsupported object format.");
      }
      const fsck = requireLegacyGit(
        snapshot,
        ["fsck", "--strict", "--full", "--no-dangling"],
        "Legacy object-store verification"
      );
      const head = requireLegacyGit(snapshot, ["rev-parse", "--verify", "HEAD^{commit}"], "Legacy HEAD").stdout.trim();
      const headTree = requireLegacyGit(
        snapshot,
        ["rev-parse", "--verify", "HEAD^{tree}"],
        "Legacy HEAD tree"
      ).stdout.trim();
      if (!SHA_PATTERN.test(head) || !SHA_PATTERN.test(headTree)) {
        fail("legacy-audit-not-eligible", "The candidate HEAD is malformed.");
      }
      const symbolic = requireLegacyGit(snapshot, ["symbolic-ref", "--quiet", "--short", "HEAD"], "Legacy branch", {
        statuses: [0, 1]
      });
      const refs = parseRefList(
        requireLegacyGit(
          snapshot,
          ["for-each-ref", "--sort=refname", "--format=%(objectname) %(refname)", "refs/"],
          "Legacy references"
        ).stdout,
        objectFormat,
        "Legacy references",
        { allowEmpty: true }
      );
      const generatedInventory = captureLegacyGeneratedInventory(candidate.checkout, allowlist);
      const repositoryProof = candidate.explicit ? captureLegacyRepositoryProof(snapshot) : undefined;
      const dependencyUniverse = candidate.explicit
        ? dependencyCatalog === undefined
          ? captureRecordedLegacyDependencyUniverse(candidate.checkout, slug, explicitTarget)
          : dependencyCatalog.proofFor(candidate.checkout, slug, explicitTarget.dependencyUniverse)
        : undefined;
      revalidatePathIdentity(
        candidate.source.topLevel,
        candidate.source.topLevelIdentity,
        "The bootstrap source",
        "directory"
      );
      revalidatePathIdentity(candidate.parent, candidate.parentIdentity, "The legacy checkout parent", "directory");
      revalidatePathIdentity(candidate.checkout, candidate.checkoutIdentity, "The legacy checkout", "directory");
      revalidatePathIdentity(candidate.gitDirectory, candidate.gitIdentity, "The legacy Git directory", "directory");
      revalidateLegacyAuditSnapshot(snapshot);
      return Object.freeze({
        protocol: candidate.explicit ? LEGACY_ADOPTION_PROTOCOL_V2 : LEGACY_ADOPTION_PROTOCOL,
        slug,
        state: "adopted-review-required",
        source: Object.freeze({
          bootstrapPublication: repository.bootstrapPublication,
          topLevel: candidate.source.topLevel,
          topLevelIdentity: candidate.source.topLevelIdentity,
          legacyParent: candidate.parent,
          legacyParentIdentity: candidate.parentIdentity,
          checkout: candidate.checkout,
          checkoutIdentity: candidate.checkoutIdentity,
          gitDirectory: candidate.gitDirectory,
          gitDirectoryIdentity: candidate.gitIdentity
        }),
        git: Object.freeze({
          head,
          headTree,
          branch: symbolic.status === 0 ? symbolic.stdout.trim() : null,
          objectFormat,
          refs: refsReceipt(refs),
          fsck: Object.freeze({
            mode: "strict-full-no-dangling",
            stdoutSha256: sha256(fsck.stdout),
            stderrSha256: sha256(fsck.stderr)
          }),
          worktreeRegistrySha256: sha256(worktreeOutput),
          configNamesSha256: sha256(configNames),
          configSha256: sha256(config),
          trackedClean: true,
          stagedClean: true,
          untrackedCount: 0,
          ignoredCount: ignoredListing.length,
          ignoredListingSha256: sha256(`${ignoredListing.sort().join("\0")}\0`),
          ...(repositoryProof === undefined ? {} : { repositoryProof, dependencyUniverse })
        }),
        generated: Object.freeze({ allowlist, inventory: generatedInventory }),
        deferredChecks: Object.freeze({
          archive: "not-created-recheck-required",
          processUse: "not-checked-recheck-required",
          mounts: "not-checked-recheck-required"
        }),
        authorizesMove: false,
        authorizesCleanup: false
      });
    } finally {
      removeLegacyAuditSnapshot(snapshot);
    }
  }

  function validateLegacyRequest(value, slug, generation) {
    const explicit = value?.protocol === LEGACY_ADOPTION_REQUEST_PROTOCOL_V2;
    exactKeys(
      value,
      explicit
        ? [
            "protocol",
            "slug",
            "generation",
            "ownerTask",
            "ownerRevision",
            "token",
            "generatedRoots",
            "generatedFiles",
            "target"
          ]
        : ["protocol", "slug", "generation", "ownerTask", "token", "generatedRoots", "generatedFiles"],
      "Legacy adoption request"
    );
    assertOwner(value.ownerTask);
    const allowlist = normalizeLegacyGeneratedAllowlist(value.generatedRoots, value.generatedFiles);
    const normalizedRoots = allowlist.filter((item) => item.kind === "directory").map((item) => item.path);
    const normalizedFiles = allowlist.filter((item) => item.kind === "file").map((item) => item.path);
    if (
      ![LEGACY_ADOPTION_REQUEST_PROTOCOL, LEGACY_ADOPTION_REQUEST_PROTOCOL_V2].includes(value.protocol) ||
      value.slug !== slug ||
      value.generation !== generation ||
      !/^[0-9a-f]{32}$/u.test(value.token) ||
      !isDeepStrictEqual(value.generatedRoots, normalizedRoots) ||
      !isDeepStrictEqual(value.generatedFiles, normalizedFiles)
    ) {
      fail("invalid-legacy-adoption", "The legacy adoption request is malformed.");
    }
    if (explicit) {
      if (value.ownerRevision !== 1) fail("invalid-legacy-adoption", "The explicit adoption revision is malformed.");
      exactKeys(
        value.target,
        [
          "approvedRoot",
          "approvedRootIdentity",
          "checkoutPath",
          "checkoutIdentity",
          "gitDirectoryIdentity",
          "repositoryProof",
          "dependencyUniverse"
        ],
        "Explicit legacy target"
      );
      for (const [identity, label] of [
        [value.target.approvedRootIdentity, "Approved root identity"],
        [value.target.checkoutIdentity, "Explicit checkout identity"],
        [value.target.gitDirectoryIdentity, "Explicit Git identity"]
      ]) {
        validateIdentity(identity, label);
      }
      validateLegacyRepositoryProof(value.target.repositoryProof);
      validateLegacyDependencyUniverse(value.target.dependencyUniverse, value.target.checkoutPath);
      if (
        !isAbsolute(value.target.approvedRoot) ||
        resolve(value.target.approvedRoot) !== value.target.approvedRoot ||
        !isAbsolute(value.target.checkoutPath) ||
        resolve(value.target.checkoutPath) !== value.target.checkoutPath ||
        dirname(value.target.checkoutPath) !== value.target.approvedRoot ||
        !isContained(value.target.approvedRoot, value.target.checkoutPath) ||
        basename(value.target.checkoutPath) !== slug ||
        value.target.checkoutPath === repository.bootstrapSourceRepository?.topLevel ||
        isSameOrContained(paths.root, value.target.checkoutPath) ||
        isSameOrContained(value.target.checkoutPath, paths.root)
      ) {
        fail("invalid-legacy-adoption", "The explicit adoption target paths are malformed.");
      }
    }
    return value;
  }

  function validateLegacyRepositoryProof(value) {
    exactKeys(
      value,
      ["remoteSha256", "rootCount", "rootsSha256", "sharedRootCount", "sharedRootsSha256"],
      "Legacy repository proof"
    );
    if (
      !Number.isSafeInteger(value.rootCount) ||
      value.rootCount < 1 ||
      value.rootCount > MAXIMUM_REPOSITORY_ROOTS ||
      !Number.isSafeInteger(value.sharedRootCount) ||
      value.sharedRootCount < 1 ||
      value.sharedRootCount > value.rootCount ||
      [value.remoteSha256, value.rootsSha256, value.sharedRootsSha256].some(
        (hash) => typeof hash !== "string" || !/^[0-9a-f]{64}$/u.test(hash)
      )
    ) {
      fail("invalid-legacy-adoption", "The legacy repository proof is malformed.");
    }
  }

  function validateLegacyEvidence(value, slug, request) {
    const explicit = request.protocol === LEGACY_ADOPTION_REQUEST_PROTOCOL_V2;
    exactKeys(
      value,
      [
        "protocol",
        "slug",
        "state",
        "source",
        "git",
        "generated",
        "deferredChecks",
        "authorizesMove",
        "authorizesCleanup"
      ],
      "Legacy adoption evidence"
    );
    exactKeys(
      value.source,
      [
        "bootstrapPublication",
        "topLevel",
        "topLevelIdentity",
        "legacyParent",
        "legacyParentIdentity",
        "checkout",
        "checkoutIdentity",
        "gitDirectory",
        "gitDirectoryIdentity"
      ],
      "Legacy adoption source"
    );
    exactKeys(
      value.source.bootstrapPublication,
      ["path", "identity", "byteLength", "sha256"],
      "Legacy bootstrap publication"
    );
    validateIdentity(value.source.bootstrapPublication.identity, "Legacy bootstrap publication identity");
    for (const [identity, label] of [
      [value.source.topLevelIdentity, "Legacy source identity"],
      [value.source.legacyParentIdentity, "Legacy parent identity"],
      [value.source.checkoutIdentity, "Legacy checkout identity"],
      [value.source.gitDirectoryIdentity, "Legacy Git identity"]
    ]) {
      validateIdentity(identity, label);
    }
    const source = repository.bootstrapSourceRepository;
    if (source === undefined) fail("legacy-bootstrap-required", "Legacy adoption requires a bootstrap source.");
    const expectedParent = explicit ? request.target.approvedRoot : join(source.topLevel, "tmp", "codex-checkpoints");
    const expectedCheckout = explicit ? request.target.checkoutPath : join(expectedParent, slug);
    if (
      value.protocol !== (explicit ? LEGACY_ADOPTION_PROTOCOL_V2 : LEGACY_ADOPTION_PROTOCOL) ||
      value.slug !== slug ||
      value.state !== "adopted-review-required" ||
      !isDeepStrictEqual(value.source.bootstrapPublication, repository.bootstrapPublication) ||
      value.source.topLevel !== source.topLevel ||
      !sameIdentity(value.source.topLevelIdentity, source.topLevelIdentity) ||
      value.source.legacyParent !== expectedParent ||
      value.source.checkout !== expectedCheckout ||
      value.source.gitDirectory !== join(expectedCheckout, ".git") ||
      (explicit &&
        (!sameIdentity(value.source.legacyParentIdentity, request.target.approvedRootIdentity) ||
          !sameIdentity(value.source.checkoutIdentity, request.target.checkoutIdentity) ||
          !sameIdentity(value.source.gitDirectoryIdentity, request.target.gitDirectoryIdentity))) ||
      value.authorizesMove !== false ||
      value.authorizesCleanup !== false
    ) {
      fail("invalid-legacy-adoption", "The legacy adoption evidence has an invalid source or authority.");
    }
    exactKeys(
      value.git,
      [
        "head",
        "headTree",
        "branch",
        "objectFormat",
        "refs",
        "fsck",
        "worktreeRegistrySha256",
        "configNamesSha256",
        "configSha256",
        "trackedClean",
        "stagedClean",
        "untrackedCount",
        "ignoredCount",
        "ignoredListingSha256",
        ...(explicit ? ["repositoryProof", "dependencyUniverse"] : [])
      ],
      "Legacy Git evidence"
    );
    exactKeys(value.git.refs, ["count", "sha256"], "Legacy ref receipt");
    exactKeys(value.git.fsck, ["mode", "stdoutSha256", "stderrSha256"], "Legacy fsck receipt");
    if (explicit) {
      validateLegacyRepositoryProof(value.git.repositoryProof);
      validateLegacyDependencyUniverse(value.git.dependencyUniverse, request.target.checkoutPath);
      if (
        !isDeepStrictEqual(value.git.repositoryProof, request.target.repositoryProof) ||
        !isDeepStrictEqual(value.git.dependencyUniverse, request.target.dependencyUniverse)
      ) {
        fail("invalid-legacy-adoption", "The explicit repository proof changed.");
      }
    }
    if (
      !SHA_PATTERN.test(value.git.head) ||
      !SHA_PATTERN.test(value.git.headTree) ||
      (value.git.branch !== null &&
        (typeof value.git.branch !== "string" || value.git.branch.length < 1 || value.git.branch.length > 1024)) ||
      !["sha1", "sha256"].includes(value.git.objectFormat) ||
      !Number.isSafeInteger(value.git.refs.count) ||
      value.git.refs.count < 0 ||
      !Number.isSafeInteger(value.git.ignoredCount) ||
      value.git.ignoredCount < 0 ||
      value.git.trackedClean !== true ||
      value.git.stagedClean !== true ||
      value.git.untrackedCount !== 0 ||
      value.git.fsck.mode !== "strict-full-no-dangling" ||
      [
        value.git.refs.sha256,
        value.git.fsck.stdoutSha256,
        value.git.fsck.stderrSha256,
        value.git.worktreeRegistrySha256,
        value.git.configNamesSha256,
        value.git.configSha256,
        value.git.ignoredListingSha256
      ].some((hash) => typeof hash !== "string" || !/^[0-9a-f]{64}$/u.test(hash))
    ) {
      fail("invalid-legacy-adoption", "The legacy Git evidence is malformed.");
    }
    exactKeys(value.generated, ["allowlist", "inventory"], "Legacy generated evidence");
    exactKeys(value.generated.inventory, ["entryCount", "byteLength", "sha256"], "Legacy generated inventory");
    const expectedAllowlist = normalizeLegacyGeneratedAllowlist(request.generatedRoots, request.generatedFiles);
    if (
      !isDeepStrictEqual(value.generated.allowlist, expectedAllowlist) ||
      !Number.isSafeInteger(value.generated.inventory.entryCount) ||
      value.generated.inventory.entryCount < 0 ||
      typeof value.generated.inventory.byteLength !== "string" ||
      !/^(?:0|[1-9][0-9]{0,39})$/u.test(value.generated.inventory.byteLength) ||
      !/^[0-9a-f]{64}$/u.test(value.generated.inventory.sha256)
    ) {
      fail("invalid-legacy-adoption", "The legacy generated inventory is malformed.");
    }
    exactKeys(value.deferredChecks, ["archive", "processUse", "mounts"], "Legacy deferred checks");
    if (
      value.deferredChecks.archive !== "not-created-recheck-required" ||
      value.deferredChecks.processUse !== "not-checked-recheck-required" ||
      value.deferredChecks.mounts !== "not-checked-recheck-required"
    ) {
      fail("invalid-legacy-adoption", "The legacy deferred checks are malformed.");
    }
    return value;
  }

  function revalidateLegacyEvidenceSource(evidence) {
    const publication = readJsonReceipt(
      evidence.source.bootstrapPublication.path,
      MAXIMUM_ENTRY_BYTES,
      "Legacy bootstrap publication",
      2n
    );
    if (
      !sameIdentity(publication.identity, evidence.source.bootstrapPublication.identity) ||
      publication.byteLength !== evidence.source.bootstrapPublication.byteLength ||
      publication.sha256 !== evidence.source.bootstrapPublication.sha256
    ) {
      fail("legacy-checkout-changed", "The canonical bootstrap publication changed.");
    }
    revalidatePathIdentity(
      evidence.source.topLevel,
      evidence.source.topLevelIdentity,
      "The bootstrap source",
      "directory"
    );
    revalidatePathIdentity(
      evidence.source.legacyParent,
      evidence.source.legacyParentIdentity,
      "The legacy checkout parent",
      "directory"
    );
    revalidatePathIdentity(
      evidence.source.checkout,
      evidence.source.checkoutIdentity,
      "The legacy checkout",
      "directory"
    );
    revalidatePathIdentity(
      evidence.source.gitDirectory,
      evidence.source.gitDirectoryIdentity,
      "The legacy Git directory",
      "directory"
    );
  }

  function validateLegacyCompletion(value, slug, generation) {
    const explicit = value?.protocol === LEGACY_ADOPTION_COMPLETION_PROTOCOL_V2;
    exactKeys(
      value,
      explicit
        ? ["protocol", "slug", "generation", "ownerTask", "ownerRevision", "request", "evidence"]
        : ["protocol", "slug", "generation", "ownerTask", "request", "evidence"],
      "Legacy completion"
    );
    exactKeys(value.request, ["path", "identity", "byteLength", "sha256"], "Legacy request receipt");
    validateIdentity(value.request.identity, "Legacy request file identity");
    assertOwner(value.ownerTask);
    const expectedRequestPath = join(legacyAttemptPath(slug, generation), "request.json");
    if (
      ![LEGACY_ADOPTION_COMPLETION_PROTOCOL, LEGACY_ADOPTION_COMPLETION_PROTOCOL_V2].includes(value.protocol) ||
      value.slug !== slug ||
      value.generation !== generation ||
      value.request.path !== expectedRequestPath ||
      !Number.isSafeInteger(value.request.byteLength) ||
      value.request.byteLength < 1 ||
      !/^[0-9a-f]{64}$/u.test(value.request.sha256)
    ) {
      fail("invalid-legacy-adoption", "The legacy adoption completion is malformed.");
    }
    const requestFile = readJsonReceipt(value.request.path, MAXIMUM_ENTRY_BYTES, "Legacy adoption request");
    validateLegacyRequest(requestFile.value, slug, generation);
    if (
      explicit !== (requestFile.value.protocol === LEGACY_ADOPTION_REQUEST_PROTOCOL_V2) ||
      (explicit && (value.ownerRevision !== 1 || requestFile.value.ownerRevision !== value.ownerRevision)) ||
      !sameIdentity(requestFile.identity, value.request.identity) ||
      requestFile.byteLength !== value.request.byteLength ||
      requestFile.sha256 !== value.request.sha256 ||
      requestFile.value.ownerTask !== value.ownerTask
    ) {
      fail("invalid-legacy-adoption", "The legacy adoption request changed.");
    }
    validateLegacyEvidence(value.evidence, slug, requestFile.value);
    return value;
  }

  function legacyAttemptPath(slug, generation) {
    assertSlug(slug);
    if (!Number.isSafeInteger(generation) || generation < 1 || generation > MAXIMUM_LEGACY_ADOPTION_ATTEMPTS) {
      fail("invalid-legacy-adoption", "The legacy adoption attempt is out of range.");
    }
    return join(paths.legacyAdoptionAttempts, `${slug}.${String(generation).padStart(8, "0")}`);
  }

  function legacyEntryPath(slug) {
    assertSlug(slug);
    return join(paths.legacyAdoptionEntries, `${slug}.json`);
  }

  function listLegacyAttempts(slug = undefined) {
    if (!existsSync(paths.legacyAdoptions)) return Object.freeze([]);
    const rootIdentity = assertPrivateDirectory(paths.legacyAdoptions, "Legacy adoption journal");
    const attemptsIdentity = assertPrivateDirectory(paths.legacyAdoptionAttempts, "Legacy adoption attempts");
    const entriesIdentity = assertPrivateDirectory(paths.legacyAdoptionEntries, "Legacy adoption entries");
    const attempts = [];
    for (const item of readDirectoryBounded(
      paths.legacyAdoptionAttempts,
      MAXIMUM_ENTRIES * MAXIMUM_LEGACY_ADOPTION_ATTEMPTS,
      "The legacy adoption journal"
    )) {
      const match = LEGACY_ADOPTION_ATTEMPT_PATTERN.exec(item.name);
      if (!item.isDirectory() || item.isSymbolicLink() || match === null) {
        fail("invalid-legacy-adoption", "The legacy adoption journal contains an unknown entry.");
      }
      const attemptSlug = match[1];
      const generation = Number(match[2]);
      if (generation < 1 || generation > MAXIMUM_LEGACY_ADOPTION_ATTEMPTS) {
        fail("invalid-legacy-adoption", "A legacy adoption generation is out of range.");
      }
      if (slug === undefined || slug === attemptSlug) {
        const path = join(paths.legacyAdoptionAttempts, item.name);
        const identity = assertPrivateDirectory(path, "Legacy adoption attempt");
        const names = readDirectoryBounded(path, 2, "Legacy adoption attempt")
          .map((entry) => entry.name)
          .sort();
        if (names.some((name) => !["request.json", "complete.json"].includes(name))) {
          fail("invalid-legacy-adoption", "A legacy adoption attempt contains an unknown file.");
        }
        let request;
        if (names.includes("request.json")) {
          request = readJsonReceipt(join(path, "request.json"), MAXIMUM_ENTRY_BYTES, "Legacy adoption request");
          validateLegacyRequest(request.value, attemptSlug, generation);
        }
        let completion;
        if (names.includes("complete.json")) {
          if (request === undefined) fail("invalid-legacy-adoption", "A legacy completion has no request.");
          const completionPath = join(path, "complete.json");
          const links = lstatSync(completionPath, { bigint: true }).nlink;
          if (![1n, 2n].includes(links)) fail("invalid-legacy-adoption", "A legacy completion has unsafe links.");
          completion = readJsonReceipt(completionPath, MAXIMUM_ENTRY_BYTES, "Legacy adoption completion", links);
          validateLegacyCompletion(completion.value, attemptSlug, generation);
        }
        revalidatePathIdentity(path, identity, "Legacy adoption attempt", "directory");
        attempts.push(Object.freeze({ slug: attemptSlug, generation, path, identity, request, completion }));
      }
    }
    attempts.sort((left, right) => left.slug.localeCompare(right.slug) || left.generation - right.generation);
    if (
      new Set(attempts.map((attempt) => `${attempt.slug}:${attempt.generation}`)).size !== attempts.length ||
      attempts.some((attempt, index) => {
        const prior = attempts[index - 1];
        return prior?.slug === attempt.slug && attempt.generation !== prior.generation + 1;
      })
    ) {
      fail("invalid-legacy-adoption", "The legacy adoption journal has a duplicate or generation gap.");
    }
    revalidatePathIdentity(paths.legacyAdoptions, rootIdentity, "Legacy adoption journal", "directory");
    revalidatePathIdentity(paths.legacyAdoptionAttempts, attemptsIdentity, "Legacy adoption attempts", "directory");
    revalidatePathIdentity(paths.legacyAdoptionEntries, entriesIdentity, "Legacy adoption entries", "directory");
    return Object.freeze(attempts);
  }

  function readLegacyEntry(slug, attempts) {
    const path = legacyEntryPath(slug);
    if (!existsSync(path)) return undefined;
    const entry = readJsonReceipt(path, MAXIMUM_ENTRY_BYTES, "Legacy adoption entry", 2n);
    validateLegacyCompletion(entry.value, slug, entry.value.generation);
    const matching = attempts.filter(
      (attempt) =>
        attempt.generation === entry.value.generation &&
        attempt.completion !== undefined &&
        sameIdentity(attempt.completion.identity, entry.identity) &&
        isDeepStrictEqual(attempt.completion.value, entry.value)
    );
    if (matching.length !== 1) {
      fail("invalid-legacy-adoption", "The legacy adoption entry has no exact completed attempt.");
    }
    revalidatePathIdentity(path, entry.identity, "Legacy adoption entry");
    return Object.freeze({ path, ...entry });
  }

  function legacyEntrySlugs(slug = undefined) {
    if (!existsSync(paths.legacyAdoptions)) return Object.freeze([]);
    const names = readDirectoryBounded(paths.legacyAdoptionEntries, MAXIMUM_ENTRIES, "Legacy adoption entries");
    const slugs = names.map((item) => {
      const match = LEGACY_ADOPTION_ENTRY_PATTERN.exec(item.name);
      if (!item.isFile() || item.isSymbolicLink() || match === null) {
        fail("invalid-legacy-adoption", "The legacy adoption entries contain an unknown file.");
      }
      return match[1];
    });
    if (new Set(slugs).size !== slugs.length) fail("invalid-legacy-adoption", "A legacy adoption entry is duplicated.");
    return Object.freeze(slug === undefined ? slugs.sort() : slugs.filter((value) => value === slug));
  }

  function allocateLegacyAttempt(slug) {
    const attempts = listLegacyAttempts(slug);
    const generation = (attempts.at(-1)?.generation ?? 0) + 1;
    if (generation > MAXIMUM_LEGACY_ADOPTION_ATTEMPTS) {
      fail("legacy-adoption-attempts-exhausted", "The legacy adoption journal has no remaining attempt slots.");
    }
    const path = legacyAttemptPath(slug, generation);
    const parentIdentity = managedIdentities.get(paths.legacyAdoptionAttempts);
    if (parentIdentity === undefined) fail("unsafe-manager", "The legacy adoption journal was not initialized.");
    revalidatePathIdentity(paths.legacyAdoptionAttempts, parentIdentity, "Legacy adoption attempts", "directory");
    try {
      mkdirSync(path, { mode: 0o700 });
      chmodSync(path, 0o700);
      fsyncDirectory(paths.legacyAdoptionAttempts);
    } catch (error) {
      if (error.code === "EEXIST") fail("legacy-adoption-changed", "The next legacy adoption attempt already exists.");
      throw error;
    }
    const identity = assertPrivateDirectory(path, "Legacy adoption attempt");
    revalidatePathIdentity(paths.legacyAdoptionAttempts, parentIdentity, "Legacy adoption attempts", "directory");
    return Object.freeze({ slug, generation, path, identity });
  }

  function legacyStatusRows(slug = undefined) {
    const attempts = listLegacyAttempts(slug);
    const archiveAttempts = listLegacyArchiveAttempts(slug);
    const slugs = [
      ...new Set([
        ...attempts.map((attempt) => attempt.slug),
        ...legacyEntrySlugs(slug),
        ...archiveAttempts.map((attempt) => attempt.slug),
        ...legacyArchiveEntrySlugs(slug)
      ])
    ].sort();
    return Object.freeze(
      slugs.map((entrySlug) => {
        const matching = attempts.filter((attempt) => attempt.slug === entrySlug);
        const entry = readLegacyEntry(entrySlug, matching);
        for (const attempt of matching) {
          if (attempt.completion !== undefined && attempt.completion.value.generation === entry?.value.generation) {
            if (
              attempt.completion.identity.device !== entry.identity.device ||
              attempt.completion.identity.inode !== entry.identity.inode
            ) {
              fail("invalid-legacy-adoption", "The published legacy completion changed identity.");
            }
          } else if (
            attempt.completion !== undefined &&
            lstatSync(join(attempt.path, "complete.json"), { bigint: true }).nlink !== 1n
          ) {
            fail("invalid-legacy-adoption", "An unpublished legacy completion has an unexpected hard link.");
          }
        }
        const current = entry?.value;
        const archive = legacyArchiveStatus(entrySlug);
        const retirement = retirementOverlay(
          "legacy",
          entrySlug,
          current?.generation ?? null,
          current?.evidence.source.checkout ?? candidateOriginalPath("legacy", entrySlug)
        );
        return Object.freeze({
          slug: entrySlug,
          state: current === undefined ? "interrupted-review-required" : current.evidence.state,
          generation: current?.generation ?? null,
          ownerTask: current?.ownerTask ?? null,
          checkout: current?.evidence.source.checkout ?? null,
          head: current?.evidence.git.head ?? null,
          generatedInventorySha256: current?.evidence.generated.inventory.sha256 ?? null,
          attempts: Object.freeze(
            matching.map((attempt) =>
              Object.freeze({
                generation: attempt.generation,
                state:
                  entry?.value.generation === attempt.generation
                    ? "published-review-required"
                    : attempt.completion !== undefined
                      ? "completed-unpublished-review-required"
                      : attempt.request !== undefined
                        ? "requested-review-required"
                        : "allocated-review-required"
              })
            )
          ),
          ...(archive === undefined ? {} : { archive }),
          ...(retirement.state === "not-enrolled" ? {} : { retirement }),
          authorizesMove: false,
          authorizesCleanup: false
        });
      })
    );
  }

  function legacyArchiveAttemptPath(slug, adoptionGeneration, attempt) {
    assertSlug(slug);
    if (
      !Number.isSafeInteger(adoptionGeneration) ||
      adoptionGeneration < 1 ||
      adoptionGeneration > MAXIMUM_LEGACY_ADOPTION_ATTEMPTS ||
      !Number.isSafeInteger(attempt) ||
      attempt < 1 ||
      attempt > MAXIMUM_LEGACY_ARCHIVE_ATTEMPTS
    ) {
      fail("invalid-legacy-archive", "The legacy recovery-archive attempt is out of range.");
    }
    return join(paths.legacyArchiveAttempts, `${slug}.${String(adoptionGeneration).padStart(8, "0")}.${attempt}`);
  }

  function legacyArchiveEntryPath(slug) {
    assertSlug(slug);
    return join(paths.legacyArchiveEntries, `${slug}.json`);
  }

  function retainedLegacyAdoption(slug) {
    const attempts = listLegacyAttempts(slug);
    const entry = readLegacyEntry(slug, attempts);
    if (entry === undefined) {
      fail("legacy-adoption-required", `Legacy checkout ${slug} has no completed adoption record.`);
    }
    const request = readJsonReceipt(entry.value.request.path, MAXIMUM_ENTRY_BYTES, "Legacy adoption request");
    validateLegacyRequest(request.value, slug, entry.value.generation);
    if (
      !sameIdentity(request.identity, entry.value.request.identity) ||
      request.byteLength !== entry.value.request.byteLength ||
      request.sha256 !== entry.value.request.sha256
    ) {
      fail("invalid-legacy-adoption", "The adopted legacy request no longer matches its completion.");
    }
    return Object.freeze({ entry, request });
  }

  function currentLegacyAdoption(slug) {
    const adoption = retainedLegacyAdoption(slug);
    revalidateLegacyEvidenceSource(adoption.entry.value.evidence);
    return adoption;
  }

  function legacyAdoptionAuthority(adoption) {
    if (
      adoption.entry.value.protocol !== LEGACY_ADOPTION_COMPLETION_PROTOCOL_V2 ||
      adoption.request.value.protocol !== LEGACY_ADOPTION_REQUEST_PROTOCOL_V2 ||
      adoption.entry.value.ownerRevision !== 1 ||
      adoption.request.value.ownerRevision !== 1 ||
      adoption.entry.value.ownerTask !== adoption.request.value.ownerTask
    ) {
      fail(
        "legacy-authority-required",
        "This adoption predates owner-revision binding and cannot be archived or retired automatically."
      );
    }
    return Object.freeze({ ownerTask: adoption.entry.value.ownerTask, ownerRevision: 1 });
  }

  function legacyRetirementAuthority(adoption, archiveRequest, archiveReceipt, archiveCompletion) {
    const historical =
      adoption.entry.value.protocol === LEGACY_ADOPTION_COMPLETION_PROTOCOL &&
      adoption.request.value.protocol === LEGACY_ADOPTION_REQUEST_PROTOCOL &&
      archiveRequest.value.protocol === LEGACY_ARCHIVE_REQUEST_PROTOCOL_V1 &&
      archiveReceipt.value.protocol === LEGACY_ARCHIVE_RECEIPT_PROTOCOL_V1 &&
      archiveCompletion.value.protocol === LEGACY_ARCHIVE_COMPLETION_PROTOCOL_V1;
    const current =
      adoption.entry.value.protocol === LEGACY_ADOPTION_COMPLETION_PROTOCOL_V2 &&
      adoption.request.value.protocol === LEGACY_ADOPTION_REQUEST_PROTOCOL_V2 &&
      archiveRequest.value.protocol === LEGACY_ARCHIVE_REQUEST_PROTOCOL &&
      archiveReceipt.value.protocol === LEGACY_ARCHIVE_RECEIPT_PROTOCOL &&
      archiveCompletion.value.protocol === LEGACY_ARCHIVE_COMPLETION_PROTOCOL;
    if (!historical && !current) {
      fail("retirement-source-changed", "The legacy retirement authority crosses incompatible journal generations.");
    }
    const ownerTask = adoption.entry.value.ownerTask;
    if (
      adoption.request.value.ownerTask !== ownerTask ||
      archiveRequest.value.ownerTask !== ownerTask ||
      archiveReceipt.value.ownerTask !== ownerTask ||
      archiveCompletion.value.ownerTask !== ownerTask
    ) {
      fail("retirement-source-changed", "The legacy owner changed inside the archived retirement authority.");
    }
    if (current) {
      const authority = legacyAdoptionAuthority(adoption);
      if (
        archiveRequest.value.ownerRevision !== authority.ownerRevision ||
        archiveReceipt.value.ownerRevision !== authority.ownerRevision ||
        archiveCompletion.value.ownerRevision !== authority.ownerRevision
      ) {
        fail("retirement-source-changed", "The legacy owner revision changed after retirement enrollment.");
      }
    }
    // The historical v1 model had one immutable owner generation and no revision field. Revision 1 is inferred only
    // after every linked adoption and archive record above has proved that complete, unmixed generation model.
    return Object.freeze({ ownerTask, ownerRevision: 1, historical });
  }

  function assertLegacyAdoptionAuthority(adoption, ownerTask, expectedRevision) {
    assertOwner(ownerTask);
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) {
      fail("invalid-revision", "The expected legacy owner revision is invalid.");
    }
    const authority = legacyAdoptionAuthority(adoption);
    if (authority.ownerTask !== ownerTask || authority.ownerRevision !== expectedRevision) {
      fail("owner-conflict", "The legacy checkout owner or revision changed.");
    }
    return authority;
  }

  function legacyArchiveAdoptionAnchor(adoption) {
    return Object.freeze({
      path: adoption.entry.path,
      identity: adoption.entry.identity,
      byteLength: adoption.entry.byteLength,
      sha256: adoption.entry.sha256,
      generation: adoption.entry.value.generation
    });
  }

  function revalidateLegacyAdoptionAnchor(adoption, anchor) {
    const attempts = listLegacyAttempts(adoption.entry.value.slug);
    const current = readLegacyEntry(adoption.entry.value.slug, attempts);
    if (
      current === undefined ||
      current.path !== anchor.path ||
      !sameIdentity(current.identity, anchor.identity) ||
      current.byteLength !== anchor.byteLength ||
      current.sha256 !== anchor.sha256 ||
      current.value.generation !== anchor.generation ||
      !isDeepStrictEqual(current.value, adoption.entry.value)
    ) {
      fail("legacy-adoption-changed", "The completed legacy adoption changed while its archive was prepared.");
    }
    revalidateLegacyEvidenceSource(current.value.evidence);
  }

  function revalidateLegacyArchiveAdoptionAnchor(request) {
    const attempts = listLegacyAttempts(request.value.slug);
    const current = readLegacyEntry(request.value.slug, attempts);
    if (current === undefined) {
      fail("legacy-adoption-changed", "The adoption anchored by the legacy archive is no longer published.");
    }
    const anchor = legacyArchiveAdoptionAnchor({ entry: current });
    const historical = request.value.protocol === LEGACY_ARCHIVE_REQUEST_PROTOCOL_V1;
    if (
      historical !== (current.value.protocol === LEGACY_ADOPTION_COMPLETION_PROTOCOL) ||
      !isDeepStrictEqual(request.value.adoption, anchor)
    ) {
      fail("legacy-adoption-changed", "The legacy archive no longer belongs to the current adoption record.");
    }
  }

  function assertAuditMatchesAdoption(audit, adoption) {
    if (!isDeepStrictEqual(audit, adoption.entry.value.evidence)) {
      fail("legacy-checkout-changed", "The legacy checkout no longer matches its completed adoption audit.");
    }
  }

  function explicitLegacyTargetFromEvidence(evidence) {
    if (evidence.protocol !== LEGACY_ADOPTION_PROTOCOL_V2) return undefined;
    return Object.freeze({
      approvedRoot: evidence.source.legacyParent,
      approvedRootIdentity: evidence.source.legacyParentIdentity,
      checkoutPath: evidence.source.checkout,
      checkoutIdentity: evidence.source.checkoutIdentity,
      gitDirectoryIdentity: evidence.source.gitDirectoryIdentity,
      repositoryProof: evidence.git.repositoryProof,
      dependencyUniverse: evidence.git.dependencyUniverse
    });
  }

  function legacyTargetFromRequest(request) {
    return request.protocol === LEGACY_ADOPTION_REQUEST_PROTOCOL_V2 ? request.target : undefined;
  }

  function preflightLegacyAdoptionRecords({
    slug,
    generation,
    ownerTask,
    token,
    generatedRoots,
    generatedFiles,
    target,
    evidence
  }) {
    const requestValue = {
      protocol: LEGACY_ADOPTION_REQUEST_PROTOCOL_V2,
      slug,
      generation,
      ownerTask,
      ownerRevision: 1,
      token,
      generatedRoots,
      generatedFiles,
      target
    };
    validateLegacyRequest(requestValue, slug, generation);
    const requestByteLength = assertPersistedJsonFits(requestValue, "The legacy adoption request");
    assertPersistedJsonFits(
      {
        protocol: LEGACY_ADOPTION_COMPLETION_PROTOCOL_V2,
        slug,
        generation,
        ownerTask,
        ownerRevision: 1,
        request: {
          path: join(legacyAttemptPath(slug, generation), "request.json"),
          identity: { device: "9".repeat(20), inode: "9".repeat(20) },
          byteLength: requestByteLength,
          sha256: "f".repeat(64)
        },
        evidence
      },
      "The legacy adoption completion"
    );
    return requestValue;
  }

  function requestedExplicitLegacyTarget(slug, checkoutPath, approvedRoot, dependencyRoots) {
    const source = repository.bootstrapSourceRepository;
    if (source === undefined) {
      fail("legacy-bootstrap-required", "Legacy checkout inspection requires the self-contained checkout manager.");
    }
    const defaultRoot = join(source.topLevel, "tmp", "codex-checkpoints");
    const targetRoot = approvedRoot ?? defaultRoot;
    const targetPath = checkoutPath ?? join(targetRoot, slug);
    if (!Array.isArray(dependencyRoots)) {
      fail(
        "legacy-dependency-universe-required",
        "Legacy adoption requires explicit dependency roots from a bounded discovery."
      );
    }
    if (
      typeof targetPath !== "string" ||
      typeof targetRoot !== "string" ||
      !isAbsolute(targetPath) ||
      !isAbsolute(targetRoot) ||
      resolve(targetPath) !== targetPath ||
      resolve(targetRoot) !== targetRoot
    ) {
      fail(
        "invalid-legacy-adoption",
        "Legacy adoption requires canonical checkout, approved-root, and dependency-root values."
      );
    }
    return Object.freeze({ checkoutPath: targetPath, approvedRoot: targetRoot, dependencyRoots });
  }

  function captureAdoptedLegacyAudit(adoption) {
    const request = adoption.request.value;
    return captureLegacyAudit(
      adoption.entry.value.slug,
      request.generatedRoots,
      request.generatedFiles,
      legacyTargetFromRequest(request)
    );
  }

  function adoptedLegacyCandidate(adoption) {
    return legacyCandidatePaths(adoption.entry.value.slug, legacyTargetFromRequest(adoption.request.value));
  }

  function validateLegacyArchiveRequest(value, slug, adoptionGeneration, attempt) {
    const historical = value?.protocol === LEGACY_ARCHIVE_REQUEST_PROTOCOL_V1;
    const current = value?.protocol === LEGACY_ARCHIVE_REQUEST_PROTOCOL;
    exactKeys(
      value,
      [
        "protocol",
        "slug",
        "adoptionGeneration",
        "attempt",
        "ownerTask",
        ...(current ? ["ownerRevision"] : []),
        "token",
        "adoption"
      ],
      "Legacy recovery-archive request"
    );
    exactKeys(value.adoption, ["path", "identity", "byteLength", "sha256", "generation"], "Legacy adoption anchor");
    validateIdentity(value.adoption.identity, "Legacy adoption anchor identity");
    assertOwner(value.ownerTask);
    if (
      (!historical && !current) ||
      value.slug !== slug ||
      value.adoptionGeneration !== adoptionGeneration ||
      value.attempt !== attempt ||
      (current && value.ownerRevision !== 1) ||
      value.adoption.generation !== adoptionGeneration ||
      !Number.isSafeInteger(value.adoption.byteLength) ||
      value.adoption.byteLength < 1 ||
      !/^[0-9a-f]{64}$/u.test(value.adoption.sha256) ||
      !/^[0-9a-f]{32}$/u.test(value.token)
    ) {
      fail("invalid-legacy-archive", "The legacy recovery-archive request is malformed.");
    }
    return value;
  }

  function allocateLegacyArchiveAttempt(slug, adoptionGeneration) {
    const prior = listLegacyArchiveAttempts(slug).filter((item) => item.adoptionGeneration === adoptionGeneration);
    const attemptNumber = (prior.at(-1)?.attempt ?? 0) + 1;
    if (attemptNumber > MAXIMUM_LEGACY_ARCHIVE_ATTEMPTS) {
      fail("legacy-archive-attempts-exhausted", "The legacy archive journal has no remaining attempt slots.");
    }
    const path = legacyArchiveAttemptPath(slug, adoptionGeneration, attemptNumber);
    const parentIdentity = managedIdentities.get(paths.legacyArchiveAttempts);
    if (parentIdentity === undefined) fail("unsafe-manager", "The legacy archive journal was not initialized.");
    revalidatePathIdentity(paths.legacyArchiveAttempts, parentIdentity, "Legacy archive attempts", "directory");
    try {
      mkdirSync(path, { mode: 0o700 });
      chmodSync(path, 0o700);
      fsyncDirectory(paths.legacyArchiveAttempts);
    } catch (error) {
      if (error.code === "EEXIST") fail("legacy-archive-changed", "The next legacy archive attempt already exists.");
      throw error;
    }
    const identity = assertPrivateDirectory(path, "Legacy recovery-archive attempt");
    revalidatePathIdentity(paths.legacyArchiveAttempts, parentIdentity, "Legacy archive attempts", "directory");
    return Object.freeze({ slug, adoptionGeneration, attempt: attemptNumber, path, identity });
  }

  function captureLegacyArchiveReflogs(snapshot, destinationRoot) {
    const sourceRoot = snapshot.logsDirectory;
    const rootEntries = readDirectoryBounded(sourceRoot, 3, "The legacy reflog root").sort((left, right) =>
      Buffer.compare(Buffer.from(left.name), Buffer.from(right.name))
    );
    if (rootEntries.some((item) => !["HEAD", "refs"].includes(item.name))) {
      fail("legacy-archive-not-eligible", "The legacy reflog root contains unsupported files.");
    }
    mkdirSync(destinationRoot, { mode: 0o700 });
    chmodSync(destinationRoot, 0o700);
    const destinationIdentity = assertPrivateDirectory(destinationRoot, "Archived legacy reflogs");
    const records = [];
    let fileCount = 0;
    let totalBytes = 0n;

    const visit = (sourceDirectory, destinationDirectory, relativeDirectory, depth) => {
      if (depth > MAXIMUM_LEGACY_ADMIN_DEPTH) {
        fail("legacy-archive-not-eligible", "The legacy reflogs are nested too deeply.");
      }
      const sourceIdentity = captureLegacyDirectory(sourceDirectory, "Legacy reflog directory");
      if (destinationDirectory !== destinationRoot) {
        mkdirSync(destinationDirectory, { mode: 0o700 });
        chmodSync(destinationDirectory, 0o700);
      }
      const destinationDirectoryIdentity = assertPrivateDirectory(destinationDirectory, "Archived reflog directory");
      const entries = readDirectoryBounded(sourceDirectory, MAXIMUM_LEGACY_REFLOG_FILES, "The legacy reflogs").sort(
        (left, right) => Buffer.compare(Buffer.from(left.name), Buffer.from(right.name))
      );
      for (const item of entries) {
        const sourcePath = join(sourceDirectory, item.name);
        const destinationPath = join(destinationDirectory, item.name);
        const relativePath = relativeDirectory === "" ? item.name : `${relativeDirectory}/${item.name}`;
        const metadata = lstatSync(sourcePath, { bigint: true });
        if (!currentUserOwns(metadata) || metadata.isSymbolicLink()) {
          fail("legacy-archive-not-eligible", "A legacy reflog entry is unsafe.");
        }
        if (metadata.isDirectory()) {
          visit(sourcePath, destinationPath, relativePath, depth + 1);
          continue;
        }
        if (!metadata.isFile()) fail("legacy-archive-not-eligible", "A legacy reflog entry is not a file.");
        fileCount += 1;
        totalBytes += metadata.size;
        if (fileCount > MAXIMUM_LEGACY_REFLOG_FILES || totalBytes > MAXIMUM_LEGACY_REFLOG_BYTES) {
          fail("legacy-archive-too-large", "The legacy reflogs exceed their fixed archive limits.");
        }
        copyLegacyAdminFile(
          sourcePath,
          destinationPath,
          `Legacy reflog ${relativePath}`,
          Number(MAXIMUM_LEGACY_REFLOG_BYTES)
        );
        const receipt = captureArchiveFile(destinationPath, `Archived legacy reflog ${relativePath}`);
        records.push(
          Object.freeze({
            path: relativePath,
            byteLength: receipt.byteLength,
            sha256: receipt.sha256
          })
        );
      }
      fsyncDirectory(destinationDirectory);
      revalidatePathIdentity(sourceDirectory, sourceIdentity, "Legacy reflog directory", "directory");
      revalidatePathIdentity(
        destinationDirectory,
        destinationDirectoryIdentity,
        "Archived reflog directory",
        "directory"
      );
    };

    const headEntry = rootEntries.find((item) => item.name === "HEAD");
    if (headEntry !== undefined) {
      if (!headEntry.isFile() || headEntry.isSymbolicLink()) {
        fail("legacy-archive-not-eligible", "The legacy HEAD reflog is unsafe.");
      }
      const sourcePath = join(sourceRoot, "HEAD");
      const destinationPath = join(destinationRoot, "HEAD");
      const metadata = lstatSync(sourcePath, { bigint: true });
      totalBytes += metadata.size;
      fileCount += 1;
      if (totalBytes > MAXIMUM_LEGACY_REFLOG_BYTES) {
        fail("legacy-archive-too-large", "The legacy reflogs exceed their fixed archive limits.");
      }
      copyLegacyAdminFile(sourcePath, destinationPath, "Legacy HEAD reflog", Number(MAXIMUM_LEGACY_REFLOG_BYTES));
      const receipt = captureArchiveFile(destinationPath, "Archived legacy HEAD reflog");
      records.push(Object.freeze({ path: "HEAD", byteLength: receipt.byteLength, sha256: receipt.sha256 }));
    }
    const refsEntry = rootEntries.find((item) => item.name === "refs");
    if (refsEntry !== undefined) {
      if (!refsEntry.isDirectory() || refsEntry.isSymbolicLink()) {
        fail("legacy-archive-not-eligible", "The legacy ref reflogs are unsafe.");
      }
      visit(join(sourceRoot, "refs"), join(destinationRoot, "refs"), "refs", 0);
    }
    fsyncDirectory(destinationRoot);
    revalidatePathIdentity(destinationRoot, destinationIdentity, "Archived legacy reflogs", "directory");
    revalidatePathIdentity(sourceRoot, snapshot.logsIdentity, "The legacy reflogs", "directory");
    records.sort((left, right) => Buffer.compare(Buffer.from(left.path), Buffer.from(right.path)));
    return Object.freeze({
      path: destinationRoot,
      identity: destinationIdentity,
      fileCount,
      byteLength: totalBytes.toString(),
      files: Object.freeze(records)
    });
  }

  function captureLegacyRecoveryMetadata(snapshot, destinationRoot) {
    const objectFormat = requireLegacyGit(
      snapshot,
      ["rev-parse", "--show-object-format"],
      "Legacy archive object format"
    ).stdout.trim();
    const refs = parseRefList(
      requireLegacyGit(
        snapshot,
        ["for-each-ref", "--sort=refname", "--format=%(objectname) %(refname)", "refs/"],
        "Legacy archive references"
      ).stdout,
      objectFormat,
      "Legacy archive references",
      { allowEmpty: true }
    );
    const refNames = new Set(refs.map(({ ref }) => ref));
    for (const file of snapshot.refFiles) {
      const localPath = relative(snapshot.refsDirectory, file.path);
      const components = localPath.split(sep);
      if (
        localPath === "" ||
        isAbsolute(localPath) ||
        components.some((component) => component === "" || component === "." || component === "..")
      ) {
        fail("legacy-archive-not-eligible", "The legacy loose-reference path is unsafe.");
      }
      const ref = `refs/${components.join("/")}`;
      if (!refNames.has(ref)) {
        fail("legacy-archive-not-eligible", "A legacy loose reference is malformed or hidden from Git.");
      }
    }
    const headFile = readBoundedFile(join(snapshot.gitDirectory, "HEAD"), MAXIMUM_WORKTREE_FIELD_BYTES, "Legacy HEAD");
    const symbolic = /^ref: (refs\/[A-Za-z0-9._/-]+)\n$/u.exec(headFile.text);
    const detached = new RegExp(`^([0-9a-f]{${objectFormat === "sha1" ? 40 : 64}})\\n$`, "u").exec(headFile.text);
    if ((symbolic === null) === (detached === null)) {
      fail("legacy-archive-not-eligible", "The legacy HEAD file is malformed.");
    }
    if (symbolic !== null) {
      requireLegacyGit(snapshot, ["check-ref-format", symbolic[1]], "Legacy symbolic HEAD target");
    }
    let origHead = null;
    const origHeadPath = join(snapshot.sourceGitDirectory, "ORIG_HEAD");
    if (entryExistsNoFollow(origHeadPath, "Legacy ORIG_HEAD")) {
      const file = readBoundedFile(origHeadPath, 256, "Legacy ORIG_HEAD");
      const match = new RegExp(`^([0-9a-f]{${objectFormat === "sha1" ? 40 : 64}})\\n?$`, "u").exec(file.text);
      if (match === null) fail("legacy-archive-not-eligible", "The legacy ORIG_HEAD file is malformed.");
      origHead = file.text;
    }
    const reflogs = captureLegacyArchiveReflogs(snapshot, destinationRoot);
    revalidateLegacyAuditSnapshot(snapshot);
    return Object.freeze({
      objectFormat,
      head: Object.freeze({
        text: headFile.text,
        kind: symbolic === null ? "detached" : "symbolic",
        target: symbolic?.[1] ?? detached[1]
      }),
      refs,
      origHead,
      reflogs
    });
  }

  function normalizedLegacyRecoveryMetadata(metadata) {
    return Object.freeze({
      objectFormat: metadata.objectFormat,
      head: metadata.head,
      refs: metadata.refs,
      origHead: metadata.origHead,
      reflogs: Object.freeze({
        fileCount: metadata.reflogs.fileCount,
        byteLength: metadata.reflogs.byteLength,
        files: metadata.reflogs.files
      })
    });
  }

  function parseLegacyObjectStorePreflight(output, label) {
    const values = new Map();
    for (const line of output.trim().split("\n")) {
      const match = /^([a-z-]+): (0|[1-9][0-9]{0,39})$/u.exec(line);
      if (match === null || values.has(match[1])) {
        fail("legacy-archive-not-eligible", `${label} returned malformed object-store size data.`);
      }
      values.set(match[1], BigInt(match[2]));
    }
    for (const key of ["count", "in-pack", "packs", "size", "size-pack", "prune-packable", "garbage", "size-garbage"]) {
      if (!values.has(key)) fail("legacy-archive-not-eligible", `${label} omitted required object-store size data.`);
    }
    if (values.get("garbage") !== 0n || values.get("prune-packable") !== 0n) {
      fail("legacy-archive-not-eligible", "The legacy object store contains garbage or duplicate loose objects.");
    }
    const storedObjects = values.get("count") + values.get("in-pack");
    if (storedObjects < 1n || storedObjects > BigInt(MAXIMUM_LEGACY_OBJECTS)) {
      fail("legacy-archive-too-large", "The legacy object store exceeds the fixed object-count limit.");
    }
    const maximumManifestBytes = storedObjects * 160n;
    if (maximumManifestBytes > BigInt(MAXIMUM_LEGACY_OBJECT_MANIFEST_BYTES)) {
      fail("legacy-archive-too-large", "The bounded object manifest could exceed its fixed byte limit.");
    }
    return Object.freeze({
      storedObjects: storedObjects.toString(),
      maximumManifestBytes: maximumManifestBytes.toString()
    });
  }

  function preflightLegacyObjectManifest(snapshot) {
    return parseLegacyObjectStorePreflight(
      requireLegacyGit(snapshot, ["--no-pager", "count-objects", "-v"], "Legacy object-store size preflight").stdout,
      "Git"
    );
  }

  function createLegacyObjectManifest(snapshot, directory, stem) {
    preflightLegacyObjectManifest(snapshot);
    const manifestPath = join(directory, `${stem}.manifest`);
    const namesPath = join(directory, `${stem}.oids`);
    const output = openEmptyPrivateFile(manifestPath, "Legacy object manifest");
    try {
      requireLegacyGit(
        snapshot,
        ["--no-pager", "cat-file", "--batch-check=%(objectname) %(objecttype) %(objectsize)", "--batch-all-objects"],
        "Legacy all-object enumeration",
        { stdoutFd: output.descriptor }
      );
      fsyncSync(output.descriptor);
    } finally {
      closeSync(output.descriptor);
    }
    hooks?.beforeLegacyObjectManifestParse?.(stem, manifestPath);
    revalidatePathIdentity(manifestPath, output.identity, "Legacy object manifest");
    const parsed = parseLegacyObjectManifest(manifestPath, namesPath, snapshotObjectFormat(snapshot));
    fsyncDirectory(directory);
    return Object.freeze({
      manifestPath,
      namesPath,
      objectFormat: snapshotObjectFormat(snapshot),
      ...parsed
    });
  }

  function snapshotObjectFormat(snapshot) {
    const value = requireLegacyGit(
      snapshot,
      ["rev-parse", "--show-object-format"],
      "Legacy archive object format"
    ).stdout.trim();
    if (!["sha1", "sha256"].includes(value)) {
      fail("legacy-archive-not-eligible", "The legacy repository has an unsupported object format.");
    }
    return value;
  }

  function createLegacyObjectPack(snapshot, attempt, objects) {
    const packPath = join(attempt.path, "objects.pack");
    const namesDescriptor = openSync(objects.namesPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const pack = openEmptyPrivateFile(packPath, "Legacy all-object pack");
    try {
      requireLegacyGit(
        snapshot,
        [
          "--no-pager",
          "-c",
          "pack.threads=1",
          "-c",
          "pack.window=4",
          "-c",
          "pack.depth=10",
          "-c",
          "pack.windowMemory=32m",
          "-c",
          "pack.deltaCacheSize=16m",
          "-c",
          "core.bigFileThreshold=16m",
          "pack-objects",
          "--stdout"
        ],
        "Legacy all-object pack creation",
        { stdinFd: namesDescriptor, stdoutFd: pack.descriptor }
      );
      fsyncSync(pack.descriptor);
    } finally {
      closeSync(pack.descriptor);
      closeSync(namesDescriptor);
    }
    const packReceipt = captureArchiveFile(packPath, "Legacy all-object pack");
    fsyncDirectory(attempt.path);
    revalidateLegacyAuditSnapshot(snapshot);
    return Object.freeze({
      pack: Object.freeze({ path: packPath, ...packReceipt })
    });
  }

  function compareLegacyObjectManifests(left, right, label) {
    if (
      left.objectFormat !== right.objectFormat ||
      left.objectCount !== right.objectCount ||
      left.objectBytes !== right.objectBytes ||
      left.manifest.byteLength !== right.manifest.byteLength ||
      left.manifest.sha256 !== right.manifest.sha256
    ) {
      fail("legacy-checkout-changed", `${label} did not contain the same exact Git objects.`);
    }
  }

  function captureLegacyRecoveryObjectManifest(repositoryPath, directory, objectFormat) {
    parseLegacyObjectStorePreflight(
      requireArchiveGitCommand(
        repositoryPath,
        ["--no-pager", "count-objects", "-v"],
        "Recovered object-store size preflight"
      ).stdout,
      "Recovered Git"
    );
    const manifestPath = join(directory, "current.manifest");
    const output = openEmptyPrivateFile(manifestPath, "Current recovered object manifest");
    try {
      requireArchiveGitCommand(
        repositoryPath,
        ["--no-pager", "cat-file", "--batch-check=%(objectname) %(objecttype) %(objectsize)", "--batch-all-objects"],
        "Current recovered all-object enumeration",
        { stdoutFd: output.descriptor }
      );
      fsyncSync(output.descriptor);
    } finally {
      closeSync(output.descriptor);
    }
    hooks?.beforeLegacyStatusRecoveryManifestParse?.(manifestPath);
    const parsed = parseLegacyObjectManifest(manifestPath, join(directory, "current.oids"), objectFormat);
    return Object.freeze({
      objectFormat,
      objectCount: parsed.objectCount,
      objectBytes: parsed.objectBytes,
      manifest: parsed.manifest
    });
  }

  function withLegacyRecoveryStatusWorkspace(callback) {
    const path = withPrivateUmask(() => mkdtempSync(join(tmpdir(), "ow-legacy-recovery-status-")));
    chmodSync(path, 0o700);
    const identity = assertPrivateDirectory(path, "Legacy recovery status workspace");
    try {
      return callback(path);
    } finally {
      revalidatePathIdentity(path, identity, "Legacy recovery status workspace", "directory");
      rmSync(path, { recursive: true, force: false });
    }
  }

  function revalidateLegacyRecoveryRepository(receipt, attempt) {
    const recovery = receipt.recovery;
    const repositoryPath = recovery.repository.path;
    revalidatePathIdentity(repositoryPath, recovery.repository.identity, "Legacy verification repository", "directory");
    const objectsPath = join(repositoryPath, "objects");
    const objectsIdentity = assertPrivateDirectory(objectsPath, "Legacy verification object store");
    const infoPath = join(objectsPath, "info");
    const infoIdentity = assertPrivateDirectory(infoPath, "Legacy verification object info");
    const packPath = join(objectsPath, "pack");
    const packIdentity = assertPrivateDirectory(packPath, "Legacy verification pack directory");
    const expectedPackNames = [`pack-${recovery.packId}.idx`, `pack-${recovery.packId}.pack`];
    const metadataReceipt = readJsonReceipt(
      receipt.metadata.path,
      MAXIMUM_LEGACY_RECOVERY_METADATA_BYTES,
      "Recovery metadata"
    );
    if (
      !sameIdentity(metadataReceipt.identity, receipt.metadata.identity) ||
      metadataReceipt.byteLength !== receipt.metadata.byteLength ||
      metadataReceipt.sha256 !== receipt.metadata.sha256
    ) {
      fail("legacy-archive-changed", "The recovery metadata changed before status verification.");
    }
    validatePersistedLegacyRecoveryMetadata(metadataReceipt.value, attempt);
    const assertExactObjectLayout = () => {
      const objectEntries = readDirectoryBounded(objectsPath, 3, "Legacy verification object store")
        .map((entry) => ({ name: entry.name, directory: entry.isDirectory(), symlink: entry.isSymbolicLink() }))
        .sort((left, right) => left.name.localeCompare(right.name));
      if (
        !isDeepStrictEqual(objectEntries, [
          { name: "info", directory: true, symlink: false },
          { name: "pack", directory: true, symlink: false }
        ])
      ) {
        fail("legacy-archive-changed", "The recovered object store gained loose or unknown state.");
      }
      if (readDirectoryBounded(infoPath, 1, "Legacy verification object info").length !== 0) {
        fail("legacy-archive-changed", "The recovered object info directory changed.");
      }
      const packEntries = readDirectoryBounded(packPath, 3, "Legacy verification pack directory")
        .map((entry) => ({ name: entry.name, file: entry.isFile(), symlink: entry.isSymbolicLink() }))
        .sort((left, right) => left.name.localeCompare(right.name));
      if (
        !isDeepStrictEqual(
          packEntries,
          [...expectedPackNames].sort().map((name) => ({ name, file: true, symlink: false }))
        )
      ) {
        fail("legacy-archive-changed", "The recovered pack directory changed.");
      }
    };
    const assertExactRepositoryLayout = () => {
      const expected = new Map();
      const add = (relativePath, type) => {
        const prior = expected.get(relativePath);
        if (prior !== undefined && prior !== type) {
          fail("invalid-legacy-archive", "The recovery metadata describes a conflicting repository layout.");
        }
        expected.set(relativePath, type);
      };
      const addFileWithParents = (relativePath) => {
        const components = relativePath.split("/");
        for (let index = 1; index < components.length; index += 1) {
          add(components.slice(0, index).join("/"), "directory");
        }
        add(relativePath, "file");
      };
      for (const [relativePath, type] of [
        ["HEAD", "file"],
        ["config", "file"],
        ["objects", "directory"],
        ["objects/info", "directory"],
        ["objects/pack", "directory"],
        [`objects/pack/pack-${recovery.packId}.idx`, "file"],
        [`objects/pack/pack-${recovery.packId}.pack`, "file"],
        ["refs", "directory"],
        ["refs/heads", "directory"],
        ["refs/tags", "directory"]
      ]) {
        add(relativePath, type);
      }
      if (metadataReceipt.value.origHead !== null) add("ORIG_HEAD", "file");
      for (const { ref } of metadataReceipt.value.refs) addFileWithParents(ref);
      for (const reflog of metadataReceipt.value.reflogs.files) addFileWithParents(`logs/${reflog.path}`);
      if (expected.size > MAXIMUM_LEGACY_ADMIN_ENTRIES) {
        fail("invalid-legacy-archive", "The recovery repository layout is too large to verify.");
      }

      const seen = new Set();
      const visit = (directory, relativeDirectory, depth) => {
        if (depth > MAXIMUM_LEGACY_ADMIN_DEPTH) {
          fail("legacy-archive-changed", "The recovery repository is nested too deeply.");
        }
        const entries = readDirectoryBounded(
          directory,
          MAXIMUM_LEGACY_ADMIN_ENTRIES,
          "Legacy verification repository layout"
        );
        for (const entry of entries) {
          const relativePath = relativeDirectory === "" ? entry.name : `${relativeDirectory}/${entry.name}`;
          const expectedType = expected.get(relativePath);
          if (expectedType === undefined || seen.has(relativePath)) {
            fail("legacy-archive-changed", "The recovery repository gained unknown or duplicate state.");
          }
          let metadata;
          try {
            metadata = lstatSync(join(directory, entry.name), { bigint: true });
          } catch {
            fail("legacy-archive-changed", "The recovery repository changed while its layout was verified.");
          }
          const isExpectedDirectory =
            expectedType === "directory" &&
            entry.isDirectory() &&
            !entry.isSymbolicLink() &&
            metadata.isDirectory() &&
            !metadata.isSymbolicLink() &&
            currentUserOwns(metadata);
          const isExpectedFile =
            expectedType === "file" &&
            entry.isFile() &&
            !entry.isSymbolicLink() &&
            metadata.isFile() &&
            !metadata.isSymbolicLink() &&
            metadata.nlink === 1n &&
            currentUserOwns(metadata);
          if (!isExpectedDirectory && !isExpectedFile) {
            fail("legacy-archive-changed", "The recovery repository layout changed type or ownership.");
          }
          seen.add(relativePath);
          if (seen.size > MAXIMUM_LEGACY_ADMIN_ENTRIES) {
            fail("legacy-archive-changed", "The recovery repository layout is too large to verify.");
          }
          if (expectedType === "directory") visit(join(directory, entry.name), relativePath, depth + 1);
        }
      };
      visit(repositoryPath, "", 0);
      if (seen.size !== expected.size) {
        fail("legacy-archive-changed", "The recovery repository is missing required Git state.");
      }
    };
    assertExactObjectLayout();
    assertExactRepositoryLayout();
    hooks?.beforeLegacyStatusRecoveryFsck?.(attempt, receipt);
    requireArchiveGitCommand(
      repositoryPath,
      ["--no-pager", "fsck", "--strict", "--full", "--no-dangling"],
      "Current recovered repository verification"
    );
    withLegacyRecoveryStatusWorkspace((workspace) => {
      const current = captureLegacyRecoveryObjectManifest(repositoryPath, workspace, receipt.objects.objectFormat);
      compareLegacyObjectManifests(
        {
          objectFormat: receipt.objects.objectFormat,
          objectCount: receipt.objects.objectCount,
          objectBytes: receipt.objects.objectBytes,
          manifest: receipt.objects.manifest
        },
        current,
        "The current recovered object manifest"
      );
    });
    requireArchiveGitCommand(
      repositoryPath,
      ["--no-pager", "fsck", "--strict", "--full", "--no-dangling"],
      "Final recovered repository verification"
    );
    for (const [file, label] of [
      [recovery.pack, "Recovered object pack"],
      [recovery.index, "Recovered object index"]
    ]) {
      assertLegacyArchiveFileMatches(file, label);
    }
    assertExactObjectLayout();
    assertExactRepositoryLayout();
    revalidatePathIdentity(objectsPath, objectsIdentity, "Legacy verification object store", "directory");
    revalidatePathIdentity(infoPath, infoIdentity, "Legacy verification object info", "directory");
    revalidatePathIdentity(packPath, packIdentity, "Legacy verification pack directory", "directory");
    revalidatePathIdentity(repositoryPath, recovery.repository.identity, "Legacy verification repository", "directory");
  }

  function writeOwnedPrivateFile(path, bytes, label, expectedIdentity = undefined) {
    let descriptor;
    try {
      const flags =
        expectedIdentity === undefined
          ? constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0)
          : constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0);
      descriptor = openSync(path, flags, 0o600);
      const before = fstatSync(descriptor, { bigint: true });
      if (
        !before.isFile() ||
        before.nlink !== 1n ||
        !currentUserOwns(before) ||
        (expectedIdentity !== undefined && !sameIdentity(identityOf(before), expectedIdentity))
      ) {
        fail("unsafe-legacy-archive", `${label} is not the exact expected output file.`);
      }
      fchmodSync(descriptor, 0o600);
      ftruncateSync(descriptor, 0);
      const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes, "utf8");
      let offset = 0;
      while (offset < buffer.length) offset += writeSync(descriptor, buffer, offset, buffer.length - offset, null);
      fsyncSync(descriptor);
      const metadata = fstatSync(descriptor, { bigint: true });
      if (
        !metadata.isFile() ||
        metadata.nlink !== 1n ||
        !currentUserOwns(metadata) ||
        !sameIdentity(identityOf(before), identityOf(metadata))
      ) {
        fail("unsafe-legacy-archive", `${label} could not be restored safely.`);
      }
      revalidatePathIdentity(path, identityOf(before), label);
    } catch (error) {
      if (error instanceof CheckoutLifecycleError) throw error;
      if (error.code === "EEXIST") fail("legacy-archive-changed", `${label} was planted before recovery.`);
      fail("unsafe-legacy-archive", `${label} could not be written safely: ${error.message}`);
    } finally {
      if (descriptor !== undefined) closeSync(descriptor);
    }
  }

  function copyArchivedReflogsToRecovery(metadata, verificationPath) {
    const sourceRoot = metadata.reflogs.path;
    for (const record of metadata.reflogs.files) {
      const components = record.path.split("/");
      if (
        components.some((component) => component === "" || component === "." || component === "..") ||
        !(record.path === "HEAD" || record.path.startsWith("refs/"))
      ) {
        fail("invalid-legacy-archive", "Archived reflog metadata contains an unsafe path.");
      }
      const sourcePath = join(sourceRoot, ...components);
      let destinationParent = join(verificationPath, "logs");
      ensurePrivateDirectory(destinationParent);
      for (const component of components.slice(0, -1)) {
        destinationParent = join(destinationParent, component);
        ensurePrivateDirectory(destinationParent);
      }
      const destinationPath = join(destinationParent, components.at(-1));
      let sourceDescriptor;
      let destination;
      try {
        sourceDescriptor = openSync(sourcePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
        const before = fstatSync(sourceDescriptor, { bigint: true });
        validateOwnedRegularFile(before, `Archived reflog ${record.path}`, 0o600n);
        if (
          before.size !== BigInt(record.byteLength) ||
          before.size > MAXIMUM_LEGACY_REFLOG_BYTES ||
          record.byteLength > Number(MAXIMUM_LEGACY_REFLOG_BYTES)
        ) {
          fail("legacy-archive-changed", `Archived reflog ${record.path} changed before recovery.`);
        }
        hooks?.afterLegacyReflogOpen?.(record, sourcePath, identityOf(before));
        revalidatePathIdentity(sourcePath, identityOf(before), `Archived reflog ${record.path}`);
        destination = openEmptyPrivateFile(destinationPath, `Recovered reflog ${record.path}`);
        const hash = createHash("sha256");
        const buffer = Buffer.allocUnsafe(Math.min(1024 * 1024, record.byteLength));
        let offset = 0;
        while (offset < record.byteLength) {
          const count = readSync(
            sourceDescriptor,
            buffer,
            0,
            Math.min(buffer.length, record.byteLength - offset),
            offset
          );
          if (count === 0) fail("legacy-archive-changed", "An archived reflog changed while it was restored.");
          hash.update(buffer.subarray(0, count));
          let written = 0;
          while (written < count) {
            written += writeSync(destination.descriptor, buffer, written, count - written);
          }
          offset += count;
        }
        fsyncSync(destination.descriptor);
        const after = fstatSync(sourceDescriptor, { bigint: true });
        const recovered = hashDescriptor(destination.descriptor, `Recovered reflog ${record.path}`, 0o600n);
        if (
          !sameIdentity(identityOf(before), identityOf(after)) ||
          before.size !== after.size ||
          before.mode !== after.mode ||
          before.mtimeNs !== after.mtimeNs ||
          before.ctimeNs !== after.ctimeNs ||
          hash.digest("hex") !== record.sha256 ||
          !sameIdentity(destination.identity, recovered.identity) ||
          recovered.byteLength !== record.byteLength ||
          recovered.sha256 !== record.sha256
        ) {
          fail("legacy-archive-recovery-failed", `Recovered reflog ${record.path} differs from the archive.`);
        }
        revalidatePathIdentity(sourcePath, identityOf(before), `Archived reflog ${record.path}`);
        revalidatePathIdentity(destinationPath, destination.identity, `Recovered reflog ${record.path}`);
      } finally {
        if (destination !== undefined) closeSync(destination.descriptor);
        if (sourceDescriptor !== undefined) closeSync(sourceDescriptor);
      }
    }
  }

  function proveLegacyArchiveRecovery(attempt, objects, packed, metadata) {
    const template = createPrivateAttemptDirectory(attempt, "verification-template", "Legacy verification template");
    const verification = createPrivateAttemptDirectory(attempt, "verification.git", "Legacy verification repository");
    requireStandaloneArchiveGitCommand(
      [
        "init",
        "--bare",
        "--quiet",
        `--object-format=${objects.objectFormat}`,
        `--template=${template.path}`,
        verification.path
      ],
      attempt.path,
      "Legacy verification repository initialization"
    );
    revalidatePathIdentity(template.path, template.identity, "Legacy verification template", "directory");
    if (readDirectoryBounded(template.path, 1, "Legacy verification template").length !== 0) {
      fail("legacy-archive-changed", "The empty legacy verification template changed.");
    }
    revalidatePathIdentity(verification.path, verification.identity, "Legacy verification repository", "directory");
    const verificationHeadIdentity = privatizeOwnedFile(join(verification.path, "HEAD"), "Legacy verification HEAD");
    const verificationObjectsDirectory = join(verification.path, "objects");
    privatizeOwnedDirectory(verificationObjectsDirectory, "Legacy verification object store");
    privatizeOwnedDirectory(join(verificationObjectsDirectory, "info"), "Legacy verification object info");
    const verificationPackDirectory = join(verificationObjectsDirectory, "pack");
    const verificationPackIdentity = privatizeOwnedDirectory(
      verificationPackDirectory,
      "Legacy verification pack directory"
    );
    hooks?.beforeLegacyRecoveryIndexPack?.(attempt, verificationPackDirectory);
    if (readDirectoryBounded(verificationPackDirectory, 1, "Legacy verification pack directory").length !== 0) {
      fail("legacy-archive-changed", "The isolated recovery pack directory is not empty.");
    }
    const packDescriptor = openSync(packed.pack.path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    let installed;
    try {
      const currentPack = hashDescriptor(packDescriptor, "Legacy all-object pack", 0o600n);
      if (
        !sameIdentity(currentPack.identity, packed.pack.identity) ||
        currentPack.byteLength !== packed.pack.byteLength ||
        currentPack.sha256 !== packed.pack.sha256
      ) {
        fail("legacy-archive-changed", "The legacy all-object pack changed before recovery.");
      }
      revalidatePathIdentity(packed.pack.path, currentPack.identity, "Legacy all-object pack");
      installed = requireArchiveGitCommand(
        verification.path,
        ["--no-pager", "index-pack", "--stdin", "--strict", "--no-rev-index", "--index-version=2"],
        "Legacy verification pack installation",
        { stdinFd: packDescriptor }
      ).stdout.trim();
    } finally {
      closeSync(packDescriptor);
    }
    const expectedLength = objects.objectFormat === "sha1" ? 40 : 64;
    const installedMatch = new RegExp(`^pack\\t([0-9a-f]{${expectedLength}})$`, "u").exec(installed);
    if (installedMatch === null) {
      fail("legacy-archive-recovery-failed", "The recovered pack identity does not match the archived pack.");
    }
    const packId = installedMatch[1];
    revalidatePathIdentity(
      verificationPackDirectory,
      verificationPackIdentity,
      "Legacy verification pack directory",
      "directory"
    );
    const recoveredPackPath = join(verification.path, "objects", "pack", `pack-${packId}.pack`);
    const recoveredIndexPath = join(verification.path, "objects", "pack", `pack-${packId}.idx`);
    const installedNames = readDirectoryBounded(verificationPackDirectory, 3, "Legacy verification pack directory")
      .map((item) => item.name)
      .sort();
    if (!isDeepStrictEqual(installedNames, [`pack-${packId}.idx`, `pack-${packId}.pack`])) {
      fail("legacy-archive-recovery-failed", "Git produced unexpected recovery pack files.");
    }
    privatizeOwnedFile(recoveredPackPath, "Recovered legacy object pack");
    privatizeOwnedFile(recoveredIndexPath, "Recovered legacy object index");
    const recoveredPack = captureArchiveFile(recoveredPackPath, "Recovered legacy object pack");
    const recoveredIndex = captureArchiveFile(recoveredIndexPath, "Recovered legacy object index");
    if (recoveredPack.byteLength !== packed.pack.byteLength || recoveredPack.sha256 !== packed.pack.sha256) {
      fail("legacy-archive-recovery-failed", "The recovered pack differs from the archived artifact.");
    }

    const refInput = metadata.refs.map(({ oid, ref }) => `update ${ref} ${oid}\n`).join("");
    requireArchiveGitCommand(verification.path, ["--no-pager", "update-ref", "--stdin"], "Legacy reference recovery", {
      input: refInput
    });
    writeOwnedPrivateFile(
      join(verification.path, "HEAD"),
      metadata.head.text,
      "Recovered legacy HEAD",
      verificationHeadIdentity
    );
    if (metadata.origHead !== null) {
      writeOwnedPrivateFile(join(verification.path, "ORIG_HEAD"), metadata.origHead, "Recovered legacy ORIG_HEAD");
    }
    copyArchivedReflogsToRecovery(metadata, verification.path);
    const recoveredRefs = parseRefList(
      requireArchiveGitCommand(
        verification.path,
        ["--no-pager", "for-each-ref", "--sort=refname", "--format=%(objectname) %(refname)", "refs/"],
        "Recovered legacy references"
      ).stdout,
      objects.objectFormat,
      "Recovered legacy references",
      { allowEmpty: true }
    );
    if (!isDeepStrictEqual(recoveredRefs, metadata.refs)) {
      fail("legacy-archive-recovery-failed", "The recovered refs differ from the archived ref map.");
    }
    const recoveredHead = readBoundedFile(
      join(verification.path, "HEAD"),
      MAXIMUM_WORKTREE_FIELD_BYTES,
      "Recovered legacy HEAD",
      0o600n
    );
    if (recoveredHead.text !== metadata.head.text) {
      fail("legacy-archive-recovery-failed", "The recovered HEAD differs from the archived HEAD.");
    }
    const recoveredOrigHeadPath = join(verification.path, "ORIG_HEAD");
    if (metadata.origHead === null) {
      if (existsSync(recoveredOrigHeadPath)) {
        fail("legacy-archive-recovery-failed", "The recovered repository gained an unexpected ORIG_HEAD.");
      }
    } else {
      const recoveredOrigHead = readBoundedFile(recoveredOrigHeadPath, 256, "Recovered legacy ORIG_HEAD", 0o600n);
      if (recoveredOrigHead.text !== metadata.origHead) {
        fail("legacy-archive-recovery-failed", "The recovered ORIG_HEAD differs from the archived pseudoref.");
      }
    }
    const manifestPath = join(attempt.path, "recovered.manifest");
    const manifestOutput = openEmptyPrivateFile(manifestPath, "Recovered object manifest");
    try {
      requireArchiveGitCommand(
        verification.path,
        ["--no-pager", "cat-file", "--batch-check=%(objectname) %(objecttype) %(objectsize)", "--batch-all-objects"],
        "Recovered all-object enumeration",
        { stdoutFd: manifestOutput.descriptor }
      );
      fsyncSync(manifestOutput.descriptor);
    } finally {
      closeSync(manifestOutput.descriptor);
    }
    hooks?.beforeLegacyObjectManifestParse?.("recovered", manifestPath);
    const recoveredObjects = parseLegacyObjectManifest(
      manifestPath,
      join(attempt.path, "recovered.oids"),
      objects.objectFormat
    );
    const normalizedRecoveredObjects = Object.freeze({
      objectFormat: objects.objectFormat,
      objectCount: recoveredObjects.objectCount,
      objectBytes: recoveredObjects.objectBytes,
      manifest: recoveredObjects.manifest
    });
    compareLegacyObjectManifests(objects, normalizedRecoveredObjects, "The recovered object manifest");
    const fsck = requireArchiveGitCommand(
      verification.path,
      ["--no-pager", "fsck", "--strict", "--full", "--no-dangling"],
      "Recovered legacy repository verification"
    );
    revalidatePathIdentity(verification.path, verification.identity, "Legacy verification repository", "directory");
    return Object.freeze({
      repository: Object.freeze({ path: verification.path, identity: verification.identity }),
      packId,
      pack: Object.freeze({ path: recoveredPackPath, ...recoveredPack }),
      index: Object.freeze({ path: recoveredIndexPath, ...recoveredIndex }),
      manifest: Object.freeze({ path: manifestPath, ...recoveredObjects.manifest }),
      names: Object.freeze({ path: join(attempt.path, "recovered.oids"), ...recoveredObjects.oids }),
      refs: refsReceipt(recoveredRefs),
      fsck: Object.freeze({
        mode: "strict-full-no-dangling",
        stdoutSha256: sha256(fsck.stdout),
        stderrSha256: sha256(fsck.stderr)
      })
    });
  }

  function persistLegacyRecoveryMetadata(attempt, metadata) {
    const value = normalizedLegacyRecoveryMetadata(metadata);
    assertPersistedJsonFits(
      value,
      "Legacy recovery metadata",
      "legacy-archive-record-too-large",
      MAXIMUM_LEGACY_RECOVERY_METADATA_BYTES
    );
    const path = join(attempt.path, "recovery-metadata.json");
    writeJsonExclusive(path, value, attempt.identity);
    const receipt = readJsonReceipt(path, MAXIMUM_LEGACY_RECOVERY_METADATA_BYTES, "Legacy recovery metadata");
    if (!isDeepStrictEqual(receipt.value, value)) {
      fail("legacy-archive-changed", "The recovery metadata changed while it was recorded.");
    }
    return Object.freeze({ path, ...receipt });
  }

  function validateLegacyArchiveFileReceipt(value, expectedPath, label) {
    exactKeys(value, ["path", "identity", "byteLength", "sha256"], label);
    validateIdentity(value.identity, `${label} identity`);
    if (
      value.path !== expectedPath ||
      !Number.isSafeInteger(value.byteLength) ||
      value.byteLength < 1 ||
      !/^[0-9a-f]{64}$/u.test(value.sha256)
    ) {
      fail("invalid-legacy-archive", `${label} is malformed.`);
    }
  }

  function assertLegacyArchiveFileMatches(value, label) {
    const current = captureArchiveFile(value.path, label);
    if (
      !sameIdentity(current.identity, value.identity) ||
      current.byteLength !== value.byteLength ||
      current.sha256 !== value.sha256
    ) {
      fail("legacy-archive-changed", `${label} changed after it was recorded.`);
    }
  }

  function validatePersistedLegacyRecoveryMetadata(value, attempt) {
    exactKeys(value, ["objectFormat", "head", "refs", "origHead", "reflogs"], "Legacy recovery metadata");
    exactKeys(value.head, ["text", "kind", "target"], "Legacy recovery HEAD");
    exactKeys(value.reflogs, ["fileCount", "byteLength", "files"], "Legacy recovery reflogs");
    const objectIdLength = value.objectFormat === "sha1" ? 40 : value.objectFormat === "sha256" ? 64 : 0;
    if (
      objectIdLength === 0 ||
      !["symbolic", "detached"].includes(value.head.kind) ||
      typeof value.head.text !== "string" ||
      typeof value.head.target !== "string" ||
      (value.origHead !== null &&
        (typeof value.origHead !== "string" ||
          new RegExp(`^[0-9a-f]{${objectIdLength}}\\n?$`, "u").exec(value.origHead) === null)) ||
      !Array.isArray(value.refs) ||
      value.refs.length > MAXIMUM_ARCHIVE_REFS ||
      !Array.isArray(value.reflogs.files) ||
      !Number.isSafeInteger(value.reflogs.fileCount) ||
      value.reflogs.fileCount !== value.reflogs.files.length ||
      value.reflogs.fileCount > MAXIMUM_LEGACY_REFLOG_FILES ||
      !/^(?:0|[1-9][0-9]{0,39})$/u.test(value.reflogs.byteLength)
    ) {
      fail("invalid-legacy-archive", "The persisted recovery metadata is malformed.");
    }
    const symbolicHead = /^ref: (refs\/[A-Za-z0-9._/-]+)\n$/u.exec(value.head.text);
    const detachedHead = new RegExp(`^([0-9a-f]{${objectIdLength}})\\n$`, "u").exec(value.head.text);
    if (
      (value.head.kind === "symbolic" &&
        (symbolicHead === null || detachedHead !== null || symbolicHead[1] !== value.head.target)) ||
      (value.head.kind === "detached" &&
        (detachedHead === null || symbolicHead !== null || detachedHead[1] !== value.head.target))
    ) {
      fail("invalid-legacy-archive", "The persisted recovery HEAD is malformed.");
    }
    const parsedRefs = parseRefList(
      value.refs.map(({ oid, ref }) => `${oid} ${ref}`).join("\n") + "\n",
      value.objectFormat,
      "Persisted legacy refs",
      { allowEmpty: true }
    );
    if (!isDeepStrictEqual(parsedRefs, value.refs)) {
      fail("invalid-legacy-archive", "The persisted legacy refs are not canonical.");
    }
    const pathsSeen = new Set();
    let reflogBytes = 0n;
    for (const record of value.reflogs.files) {
      exactKeys(record, ["path", "byteLength", "sha256"], "Archived reflog record");
      if (
        typeof record.path !== "string" ||
        !(record.path === "HEAD" || record.path.startsWith("refs/")) ||
        record.path.split("/").some((component) => component === "" || component === "." || component === "..") ||
        pathsSeen.has(record.path) ||
        !Number.isSafeInteger(record.byteLength) ||
        record.byteLength < 1 ||
        !/^[0-9a-f]{64}$/u.test(record.sha256)
      ) {
        fail("invalid-legacy-archive", "An archived reflog record is malformed.");
      }
      pathsSeen.add(record.path);
      reflogBytes += BigInt(record.byteLength);
      if (reflogBytes > MAXIMUM_LEGACY_REFLOG_BYTES) {
        fail("invalid-legacy-archive", "The archived reflogs exceed their fixed byte limit.");
      }
      for (const [root, label] of [
        [join(attempt.path, "recovery-logs"), "Archived"],
        [join(attempt.path, "verification.git", "logs"), "Recovered"]
      ]) {
        const path = join(root, ...record.path.split("/"));
        const current = captureArchiveFile(path, `${label} reflog ${record.path}`);
        if (current.byteLength !== record.byteLength || current.sha256 !== record.sha256) {
          fail("legacy-archive-changed", `${label} reflog ${record.path} changed.`);
        }
      }
    }
    if (reflogBytes.toString() !== value.reflogs.byteLength) {
      fail("invalid-legacy-archive", "The archived reflog byte count is malformed.");
    }
    const verificationPath = join(attempt.path, "verification.git");
    if (value.head.kind === "symbolic") {
      requireArchiveGitCommand(
        verificationPath,
        ["check-ref-format", value.head.target],
        "Persisted legacy symbolic HEAD target"
      );
    }
    const recoveredHead = readBoundedFile(
      join(verificationPath, "HEAD"),
      MAXIMUM_WORKTREE_FIELD_BYTES,
      "Recovered legacy HEAD",
      0o600n
    );
    if (recoveredHead.text !== value.head.text) {
      fail("legacy-archive-changed", "The recovered legacy HEAD changed.");
    }
    const origHeadPath = join(verificationPath, "ORIG_HEAD");
    if (value.origHead === null ? existsSync(origHeadPath) : !existsSync(origHeadPath)) {
      fail("legacy-archive-changed", "The recovered legacy ORIG_HEAD presence changed.");
    }
    if (value.origHead !== null) {
      const recoveredOrigHead = readBoundedFile(origHeadPath, 256, "Recovered legacy ORIG_HEAD", 0o600n);
      if (recoveredOrigHead.text !== value.origHead) {
        fail("legacy-archive-changed", "The recovered legacy ORIG_HEAD changed.");
      }
    }
    const recoveredRefs = parseRefList(
      requireArchiveGitCommand(
        verificationPath,
        ["--no-pager", "for-each-ref", "--sort=refname", "--format=%(objectname) %(refname)", "refs/"],
        "Recovered legacy references"
      ).stdout,
      value.objectFormat,
      "Recovered legacy references",
      { allowEmpty: true }
    );
    if (!isDeepStrictEqual(recoveredRefs, value.refs)) {
      fail("legacy-archive-changed", "The recovered legacy refs changed.");
    }
    return value;
  }

  function validateLegacyArchiveReceiptAuthority(value, attempt, request) {
    const historical = value?.protocol === LEGACY_ARCHIVE_RECEIPT_PROTOCOL_V1;
    const current = value?.protocol === LEGACY_ARCHIVE_RECEIPT_PROTOCOL;
    exactKeys(
      value,
      [
        "protocol",
        "slug",
        "adoptionGeneration",
        "attempt",
        "ownerTask",
        ...(current ? ["ownerRevision"] : []),
        "request",
        "adoptionAuditSha256",
        "objects",
        "metadata",
        "recovery",
        "storage",
        "state",
        "authorizesMove",
        "authorizesCleanup"
      ],
      "Legacy recovery-archive receipt"
    );
    assertOwner(value.ownerTask);
    if (
      (!historical && !current) ||
      historical !== (request.value.protocol === LEGACY_ARCHIVE_REQUEST_PROTOCOL_V1) ||
      current !== (request.value.protocol === LEGACY_ARCHIVE_REQUEST_PROTOCOL) ||
      value.slug !== attempt.slug ||
      value.adoptionGeneration !== attempt.adoptionGeneration ||
      value.attempt !== attempt.attempt ||
      value.ownerTask !== request.value.ownerTask ||
      (current && value.ownerRevision !== request.value.ownerRevision) ||
      value.state !== "verified-review-required" ||
      value.authorizesMove !== false ||
      value.authorizesCleanup !== false ||
      !/^[0-9a-f]{64}$/u.test(value.adoptionAuditSha256)
    ) {
      fail("invalid-legacy-archive", "The legacy recovery-archive receipt is malformed.");
    }
    validateLegacyArchiveFileReceipt(
      value.request,
      join(attempt.path, "request.json"),
      "Legacy archive request receipt"
    );
    if (
      !sameIdentity(value.request.identity, request.identity) ||
      value.request.byteLength !== request.byteLength ||
      value.request.sha256 !== request.sha256
    ) {
      fail("invalid-legacy-archive", "The legacy archive request receipt changed.");
    }
    return value;
  }

  function validateLegacyArchiveReceipt(value, attempt, request) {
    validateLegacyArchiveReceiptAuthority(value, attempt, request);
    exactKeys(
      value.objects,
      [
        "objectFormat",
        "objectCount",
        "objectBytes",
        "manifest",
        "names",
        "confirmedManifest",
        "confirmedNames",
        "pack",
        "index",
        "packId"
      ],
      "Archived Git objects"
    );
    if (
      !["sha1", "sha256"].includes(value.objects.objectFormat) ||
      !Number.isSafeInteger(value.objects.objectCount) ||
      value.objects.objectCount < 1 ||
      !/^(?:0|[1-9][0-9]{0,39})$/u.test(value.objects.objectBytes) ||
      !new RegExp(`^[0-9a-f]{${value.objects.objectFormat === "sha1" ? 40 : 64}}$`, "u").test(value.objects.packId)
    ) {
      fail("invalid-legacy-archive", "The archived Git object receipt is malformed.");
    }
    for (const [item, name, label] of [
      [value.objects.manifest, "objects.manifest", "Archived object manifest"],
      [value.objects.names, "objects.oids", "Archived object-name stream"],
      [value.objects.confirmedManifest, "source-confirmed.manifest", "Confirmed source object manifest"],
      [value.objects.confirmedNames, "source-confirmed.oids", "Confirmed source object-name stream"],
      [value.objects.pack, "objects.pack", "Archived object pack"]
    ]) {
      validateLegacyArchiveFileReceipt(item, join(attempt.path, name), label);
      assertLegacyArchiveFileMatches(item, label);
    }
    exactKeys(
      value.recovery,
      ["repository", "packId", "pack", "index", "manifest", "names", "refs", "fsck"],
      "Recovery proof"
    );
    exactKeys(value.recovery.repository, ["path", "identity"], "Recovery repository");
    validateIdentity(value.recovery.repository.identity, "Recovery repository identity");
    if (
      value.recovery.repository.path !== join(attempt.path, "verification.git") ||
      value.recovery.packId !== value.objects.packId
    ) {
      fail("invalid-legacy-archive", "The recovery repository path or pack identity is invalid.");
    }
    revalidatePathIdentity(
      value.recovery.repository.path,
      value.recovery.repository.identity,
      "Recovery repository",
      "directory"
    );
    validateLegacyArchiveFileReceipt(value.metadata, join(attempt.path, "recovery-metadata.json"), "Recovery metadata");
    assertLegacyArchiveFileMatches(value.metadata, "Recovery metadata");
    const metadata = readJsonReceipt(value.metadata.path, MAXIMUM_LEGACY_RECOVERY_METADATA_BYTES, "Recovery metadata");
    validatePersistedLegacyRecoveryMetadata(metadata.value, attempt);
    validateLegacyArchiveFileReceipt(
      value.recovery.pack,
      join(attempt.path, "verification.git", "objects", "pack", `pack-${value.objects.packId}.pack`),
      "Recovered object pack"
    );
    validateLegacyArchiveFileReceipt(
      value.recovery.index,
      join(attempt.path, "verification.git", "objects", "pack", `pack-${value.objects.packId}.idx`),
      "Recovered object index"
    );
    validateLegacyArchiveFileReceipt(
      value.objects.index,
      join(attempt.path, "verification.git", "objects", "pack", `pack-${value.objects.packId}.idx`),
      "Archived object index"
    );
    if (!isDeepStrictEqual(value.objects.index, value.recovery.index)) {
      fail("invalid-legacy-archive", "The archive index is not the exact recovery-produced index.");
    }
    validateLegacyArchiveFileReceipt(
      value.recovery.manifest,
      join(attempt.path, "recovered.manifest"),
      "Recovered object manifest"
    );
    validateLegacyArchiveFileReceipt(value.recovery.names, join(attempt.path, "recovered.oids"), "Recovered names");
    for (const [item, label] of [
      [value.recovery.pack, "Recovered object pack"],
      [value.recovery.index, "Recovered object index"],
      [value.objects.index, "Archived object index"],
      [value.recovery.manifest, "Recovered object manifest"],
      [value.recovery.names, "Recovered names"]
    ]) {
      assertLegacyArchiveFileMatches(item, label);
    }
    exactKeys(value.recovery.refs, ["count", "sha256"], "Recovered refs");
    exactKeys(value.recovery.fsck, ["mode", "stdoutSha256", "stderrSha256"], "Recovery fsck");
    if (
      value.recovery.fsck.mode !== "strict-full-no-dangling" ||
      !Number.isSafeInteger(value.recovery.refs.count) ||
      value.recovery.refs.count < 0 ||
      !isDeepStrictEqual(value.recovery.refs, refsReceipt(metadata.value.refs)) ||
      [value.recovery.refs.sha256, value.recovery.fsck.stdoutSha256, value.recovery.fsck.stderrSha256].some(
        (hash) => !/^[0-9a-f]{64}$/u.test(hash)
      )
    ) {
      fail("invalid-legacy-archive", "The legacy recovery proof is malformed.");
    }
    exactKeys(
      value.storage,
      ["objectDiskBytes", "multiplier", "reserveBytes", "requiredBytes", "availableBytes"],
      "Archive storage proof"
    );
    for (const field of ["objectDiskBytes", "reserveBytes", "requiredBytes", "availableBytes"]) {
      if (!/^(?:0|[1-9][0-9]{0,39})$/u.test(value.storage[field])) {
        fail("invalid-legacy-archive", "The archive storage proof is malformed.");
      }
    }
    if (value.storage.multiplier !== Number(ARCHIVE_SPACE_MULTIPLIER)) {
      fail("invalid-legacy-archive", "The archive storage multiplier is malformed.");
    }
    return value;
  }

  function validateLegacyArchiveCompletion(value, attempt, receipt) {
    const historical = value?.protocol === LEGACY_ARCHIVE_COMPLETION_PROTOCOL_V1;
    const current = value?.protocol === LEGACY_ARCHIVE_COMPLETION_PROTOCOL;
    exactKeys(
      value,
      [
        "protocol",
        "slug",
        "adoptionGeneration",
        "attempt",
        "ownerTask",
        ...(current ? ["ownerRevision"] : []),
        "receipt",
        "state",
        "authorizesMove",
        "authorizesCleanup"
      ],
      "Legacy archive completion"
    );
    assertOwner(value.ownerTask);
    validateLegacyArchiveFileReceipt(value.receipt, join(attempt.path, "receipt.json"), "Legacy archive receipt file");
    if (
      (!historical && !current) ||
      historical !== (receipt.value.protocol === LEGACY_ARCHIVE_RECEIPT_PROTOCOL_V1) ||
      current !== (receipt.value.protocol === LEGACY_ARCHIVE_RECEIPT_PROTOCOL) ||
      value.slug !== attempt.slug ||
      value.adoptionGeneration !== attempt.adoptionGeneration ||
      value.attempt !== attempt.attempt ||
      value.ownerTask !== receipt.value.ownerTask ||
      (current && value.ownerRevision !== receipt.value.ownerRevision) ||
      !sameIdentity(value.receipt.identity, receipt.identity) ||
      value.receipt.byteLength !== receipt.byteLength ||
      value.receipt.sha256 !== receipt.sha256 ||
      value.state !== "archived-review-required" ||
      value.authorizesMove !== false ||
      value.authorizesCleanup !== false
    ) {
      fail("invalid-legacy-archive", "The legacy archive completion is malformed.");
    }
    return value;
  }

  function listLegacyArchiveAttempts(slug = undefined) {
    if (!existsSync(paths.legacyArchives)) return Object.freeze([]);
    const rootIdentity = assertPrivateDirectory(paths.legacyArchives, "Legacy archive journal");
    const attemptsIdentity = assertPrivateDirectory(paths.legacyArchiveAttempts, "Legacy archive attempts");
    const entriesIdentity = assertPrivateDirectory(paths.legacyArchiveEntries, "Legacy archive entries");
    const attempts = [];
    const knownFiles = new Set([
      "request.json",
      "objects.manifest",
      "objects.oids",
      "objects.pack",
      "source-confirmed.manifest",
      "source-confirmed.oids",
      "recovery-metadata.json",
      "recovered.manifest",
      "recovered.oids",
      "receipt.json",
      "complete.json"
    ]);
    const knownDirectories = new Set(["recovery-logs", "verification-template", "verification.git"]);
    for (const item of readDirectoryBounded(
      paths.legacyArchiveAttempts,
      MAXIMUM_ENTRIES * MAXIMUM_LEGACY_ADOPTION_ATTEMPTS * MAXIMUM_LEGACY_ARCHIVE_ATTEMPTS,
      "The legacy archive journal"
    )) {
      const match = LEGACY_ARCHIVE_ATTEMPT_PATTERN.exec(item.name);
      if (!item.isDirectory() || item.isSymbolicLink() || match === null) {
        fail("invalid-legacy-archive", "The legacy archive journal contains an unknown entry.");
      }
      const attemptSlug = match[1];
      const adoptionGeneration = Number(match[2]);
      const attemptNumber = Number(match[3]);
      if (
        adoptionGeneration < 1 ||
        adoptionGeneration > MAXIMUM_LEGACY_ADOPTION_ATTEMPTS ||
        attemptNumber < 1 ||
        attemptNumber > MAXIMUM_LEGACY_ARCHIVE_ATTEMPTS
      ) {
        fail("invalid-legacy-archive", "A legacy archive attempt is out of range.");
      }
      const path = join(paths.legacyArchiveAttempts, item.name);
      const identity = assertPrivateDirectory(path, "Legacy archive attempt");
      const children = readDirectoryBounded(
        path,
        knownFiles.size + knownDirectories.size + 1,
        "Legacy archive attempt"
      );
      if (
        children.some(
          (child) =>
            child.isSymbolicLink() ||
            (child.isFile()
              ? !knownFiles.has(child.name)
              : child.isDirectory()
                ? !knownDirectories.has(child.name)
                : true)
        )
      ) {
        fail("invalid-legacy-archive", "A legacy archive attempt contains an unknown or unsafe entry.");
      }
      const names = new Set(children.map((child) => child.name));
      let request;
      const attempt = Object.freeze({
        slug: attemptSlug,
        adoptionGeneration,
        attempt: attemptNumber,
        path,
        identity
      });
      if (names.has("request.json")) {
        request = readJsonReceipt(join(path, "request.json"), MAXIMUM_ENTRY_BYTES, "Legacy archive request");
        validateLegacyArchiveRequest(request.value, attemptSlug, adoptionGeneration, attemptNumber);
        revalidateLegacyArchiveAdoptionAnchor(request);
      } else if (children.length !== 0) {
        fail("invalid-legacy-archive", "A legacy archive attempt has artifacts without a request.");
      }
      let receipt;
      if (names.has("receipt.json")) {
        if (request === undefined) fail("invalid-legacy-archive", "A legacy archive receipt has no request.");
        receipt = readJsonReceipt(join(path, "receipt.json"), MAXIMUM_ENTRY_BYTES, "Legacy archive receipt");
        validateLegacyArchiveReceipt(receipt.value, attempt, request);
      }
      let completion;
      if (names.has("complete.json")) {
        if (receipt === undefined) fail("invalid-legacy-archive", "A legacy archive completion has no receipt.");
        const completionPath = join(path, "complete.json");
        const links = lstatSync(completionPath, { bigint: true }).nlink;
        if (![1n, 2n].includes(links)) fail("invalid-legacy-archive", "A legacy archive completion has unsafe links.");
        completion = readJsonReceipt(completionPath, MAXIMUM_ENTRY_BYTES, "Legacy archive completion", links);
        validateLegacyArchiveCompletion(completion.value, attempt, receipt);
      }
      revalidatePathIdentity(path, identity, "Legacy archive attempt", "directory");
      if (slug === undefined || slug === attemptSlug)
        attempts.push(Object.freeze({ ...attempt, request, receipt, completion }));
    }
    attempts.sort(
      (left, right) =>
        left.slug.localeCompare(right.slug) ||
        left.adoptionGeneration - right.adoptionGeneration ||
        left.attempt - right.attempt
    );
    if (
      new Set(attempts.map((attempt) => `${attempt.slug}:${attempt.adoptionGeneration}:${attempt.attempt}`)).size !==
        attempts.length ||
      attempts.some((attempt, index) => {
        const prior = attempts[index - 1];
        return (
          prior?.slug === attempt.slug &&
          prior.adoptionGeneration === attempt.adoptionGeneration &&
          attempt.attempt !== prior.attempt + 1
        );
      })
    ) {
      fail("invalid-legacy-archive", "The legacy archive journal has a duplicate or attempt gap.");
    }
    revalidatePathIdentity(paths.legacyArchives, rootIdentity, "Legacy archive journal", "directory");
    revalidatePathIdentity(paths.legacyArchiveAttempts, attemptsIdentity, "Legacy archive attempts", "directory");
    revalidatePathIdentity(paths.legacyArchiveEntries, entriesIdentity, "Legacy archive entries", "directory");
    return Object.freeze(attempts);
  }

  function readLegacyArchiveEntry(slug, attempts) {
    const path = legacyArchiveEntryPath(slug);
    if (!existsSync(path)) return undefined;
    const entry = readJsonReceipt(path, MAXIMUM_ENTRY_BYTES, "Legacy archive entry", 2n);
    const attempt = attempts.find(
      (item) =>
        item.adoptionGeneration === entry.value.adoptionGeneration &&
        item.attempt === entry.value.attempt &&
        item.completion !== undefined &&
        sameIdentity(item.completion.identity, entry.identity)
    );
    if (attempt === undefined)
      fail("invalid-legacy-archive", "The legacy archive entry has no exact completed attempt.");
    validateLegacyArchiveCompletion(entry.value, attempt, attempt.receipt);
    if (!isDeepStrictEqual(entry.value, attempt.completion.value)) {
      fail("invalid-legacy-archive", "The published legacy archive completion changed.");
    }
    return Object.freeze({ path, ...entry, attempt });
  }

  function legacyArchiveEntrySlugs(slug = undefined) {
    if (!existsSync(paths.legacyArchives)) return Object.freeze([]);
    const slugs = readDirectoryBounded(paths.legacyArchiveEntries, MAXIMUM_ENTRIES, "Legacy archive entries").map(
      (item) => {
        const match = LEGACY_ARCHIVE_ENTRY_PATTERN.exec(item.name);
        if (!item.isFile() || item.isSymbolicLink() || match === null) {
          fail("invalid-legacy-archive", "The legacy archive entries contain an unknown file.");
        }
        return match[1];
      }
    );
    if (new Set(slugs).size !== slugs.length) fail("invalid-legacy-archive", "A legacy archive entry is duplicated.");
    return Object.freeze(slug === undefined ? slugs.sort() : slugs.filter((value) => value === slug));
  }

  function legacyArchiveStatus(slug) {
    if (!existsSync(paths.legacyArchives)) return undefined;
    const attempts = listLegacyArchiveAttempts(slug);
    const entry = readLegacyArchiveEntry(slug, attempts);
    for (const attempt of attempts) {
      if (attempt.request !== undefined) revalidateLegacyArchiveAdoptionAnchor(attempt.request);
      if (attempt.receipt !== undefined) {
        revalidateLegacyRecoveryRepository(attempt.receipt.value, attempt);
      }
      if (attempt.request !== undefined) revalidateLegacyArchiveAdoptionAnchor(attempt.request);
      if (attempt.completion !== undefined && attempt === entry?.attempt) {
        if (lstatSync(join(attempt.path, "complete.json"), { bigint: true }).nlink !== 2n) {
          fail("invalid-legacy-archive", "The published legacy archive completion lost its hard link.");
        }
      } else if (
        attempt.completion !== undefined &&
        lstatSync(join(attempt.path, "complete.json"), { bigint: true }).nlink !== 1n
      ) {
        fail("invalid-legacy-archive", "An unpublished legacy archive completion has an unexpected hard link.");
      }
    }
    if (attempts.length === 0 && legacyArchiveEntrySlugs(slug).length === 0) return undefined;
    return Object.freeze({
      state: entry === undefined ? "interrupted-review-required" : entry.value.state,
      adoptionGeneration: entry?.value.adoptionGeneration ?? null,
      attempt: entry?.value.attempt ?? null,
      objectCount: entry?.attempt.receipt.value.objects.objectCount ?? null,
      objectBytes: entry?.attempt.receipt.value.objects.objectBytes ?? null,
      packSha256: entry?.attempt.receipt.value.objects.pack.sha256 ?? null,
      attempts: Object.freeze(
        attempts.map((attempt) =>
          Object.freeze({
            adoptionGeneration: attempt.adoptionGeneration,
            attempt: attempt.attempt,
            state:
              attempt === entry?.attempt
                ? "published-review-required"
                : attempt.completion !== undefined
                  ? "completed-unpublished-review-required"
                  : attempt.receipt !== undefined
                    ? "verified-unpublished-review-required"
                    : attempt.request !== undefined
                      ? "requested-review-required"
                      : "allocated-review-required"
          })
        )
      ),
      authorizesMove: false,
      authorizesCleanup: false
    });
  }

  function confirmLegacyArchiveSource(adoption, objects, metadata) {
    const audit = captureAdoptedLegacyAudit(adoption);
    assertAuditMatchesAdoption(audit, adoption);
    const candidate = adoptedLegacyCandidate(adoption);
    const snapshot = createLegacyAuditSnapshot(candidate);
    try {
      const proveObjects = (stem, label) => {
        requireLegacyGit(snapshot, ["--no-pager", "fsck", "--strict", "--full", "--no-dangling"], label);
        const current = createLegacyObjectManifest(snapshot, snapshot.root, stem);
        compareLegacyObjectManifests(objects, current, "The final source object manifest");
      };
      const proveMetadata = (directory) => {
        const current = captureLegacyRecoveryMetadata(snapshot, join(snapshot.root, directory));
        if (!isDeepStrictEqual(normalizedLegacyRecoveryMetadata(current), normalizedLegacyRecoveryMetadata(metadata))) {
          fail("legacy-checkout-changed", "The legacy refs, HEAD, ORIG_HEAD, or reflogs changed during archiving.");
        }
      };

      proveObjects("confirmed-before-metadata", "Legacy object verification before metadata confirmation");
      proveMetadata("confirmed-logs-before");
      hooks?.afterLegacySourceMetadataCapture?.(adoption.entry.value.slug);
      proveObjects("confirmed-after-metadata", "Legacy object verification after metadata confirmation");
      proveMetadata("confirmed-logs-after");
      hooks?.afterLegacySourceMetadataRecheck?.(adoption.entry.value.slug);
      proveObjects("confirmed-final", "Final legacy object verification after metadata recheck");
      revalidateLegacyAuditSnapshot(snapshot);
    } finally {
      removeLegacyAuditSnapshot(snapshot);
    }
    revalidateLegacyAdoptionAnchor(adoption, legacyArchiveAdoptionAnchor(adoption));
  }

  function checkoutPathFor(slug) {
    assertSlug(slug);
    const path = resolve(paths.checkouts, slug);
    if (!isContained(paths.root, path) || dirname(path) !== paths.checkouts) {
      fail("outside-manager", `Checkout ${slug} is outside the manager.`);
    }
    return path;
  }

  function entryPath(slug, generation) {
    assertSlug(slug);
    if (!Number.isSafeInteger(generation) || generation < 1 || generation > MAXIMUM_ENTRY_GENERATIONS) {
      fail("invalid-registry", "The checkout entry generation is out of range.");
    }
    return join(paths.entries, `${slug}.${generation}.json`);
  }

  function lockPath(generation, kind) {
    if (
      !Number.isSafeInteger(generation) ||
      generation < 1 ||
      generation > MAXIMUM_LOCK_GENERATIONS ||
      !["claim", "release"].includes(kind)
    ) {
      fail("invalid-lock", "The operation lock generation is out of range.");
    }
    return join(paths.locks, `${generation}.${kind}.json`);
  }

  function retirementPath(slug, generation, attempt = 1) {
    assertSlug(slug);
    assertGeneration(generation);
    if (!Number.isSafeInteger(attempt) || attempt < 1 || attempt > MAXIMUM_RETIREMENT_PLAN_ATTEMPTS) {
      fail("invalid-registry", "The retirement-plan attempt is out of range.");
    }
    return join(paths.retirements, `${slug}.${generation}${attempt === 1 ? "" : `.${attempt}`}.json`);
  }

  function listRetirementPlans(entry) {
    initializeRetirementJournal();
    const rootIdentity = managedIdentities.get(paths.retirements);
    if (rootIdentity === undefined) fail("unsafe-manager", "The retirement journal was not initialized.");
    const matches = [];
    for (const item of readDirectoryBounded(
      paths.retirements,
      MAXIMUM_ENTRIES * MAXIMUM_RETIREMENT_PLAN_ATTEMPTS,
      "The retirement journal"
    )) {
      const match = RETIREMENT_PLAN_FILE_PATTERN.exec(item.name);
      if (!item.isFile() || item.isSymbolicLink() || match === null) {
        fail("invalid-registry", "The retirement journal contains an unknown entry.");
      }
      if (match[1] !== entry.slug || Number(match[2]) !== entry.generation) continue;
      const attempt = match[3] === undefined ? 1 : Number(match[3]);
      const path = join(paths.retirements, item.name);
      const loaded = readJsonReceipt(path, MAXIMUM_ENTRY_BYTES, `Retirement evidence for ${entry.slug}`);
      validateRetirementEvidence(loaded.value, entry);
      revalidatePathIdentity(path, loaded.identity, `Retirement evidence for ${entry.slug}`);
      matches.push(Object.freeze({ attempt, path, ...loaded }));
    }
    matches.sort((left, right) => left.attempt - right.attempt);
    if (matches.some((plan, index) => plan.attempt !== index + 1)) {
      fail("invalid-registry", "The retirement journal contains an attempt gap.");
    }
    revalidatePathIdentity(paths.retirements, rootIdentity, "The retirement journal", "directory");
    return Object.freeze(matches);
  }

  function archiveAttemptPath(slug, generation, attempt) {
    assertSlug(slug);
    assertGeneration(generation);
    if (!Number.isSafeInteger(attempt) || attempt < 1 || attempt > MAXIMUM_ARCHIVE_ATTEMPTS) {
      fail("invalid-archive", "The archive attempt is out of range.");
    }
    return join(paths.archives, `${slug}.${generation}.${attempt}`);
  }

  function validateLockClaim(value, generation, label) {
    exactKeys(value, ["protocol", "generation", "pid", "token"], label);
    if (
      value.protocol !== LOCK_PROTOCOL ||
      value.generation !== generation ||
      !Number.isSafeInteger(value.pid) ||
      value.pid < 1 ||
      !/^[0-9a-f]{32}$/u.test(value.token)
    ) {
      fail("invalid-lock", `${label} is malformed.`);
    }
    return value;
  }

  function validateLockRelease(value, claim, label) {
    exactKeys(value, ["protocol", "generation", "pid", "token", "claimIdentity", "releasedByPid", "reason"], label);
    validateIdentity(value.claimIdentity, `${label} claim identity`);
    if (
      value.protocol !== LOCK_RELEASE_PROTOCOL ||
      value.generation !== claim.value.generation ||
      value.pid !== claim.value.pid ||
      value.token !== claim.value.token ||
      !sameIdentity(value.claimIdentity, claim.identity) ||
      !Number.isSafeInteger(value.releasedByPid) ||
      value.releasedByPid < 1 ||
      !["released", "recovered"].includes(value.reason)
    ) {
      fail("invalid-lock", `${label} is malformed or does not match its claim.`);
    }
    return value;
  }

  function readLockJournal() {
    const files = readDirectoryBounded(paths.locks, MAXIMUM_LOCK_FILES, "The operation lock journal").map((item) => {
      const match = LOCK_FILE_PATTERN.exec(item.name);
      if (!item.isFile() || item.isSymbolicLink() || match === null) {
        fail("invalid-lock", "The operation lock journal contains an unknown entry.");
      }
      return Object.freeze({ generation: Number(match[1]), kind: match[2] });
    });
    const byGeneration = new Map();
    for (const file of files) {
      if (file.generation > MAXIMUM_LOCK_GENERATIONS) fail("invalid-lock", "The lock journal is too long.");
      const record = byGeneration.get(file.generation) ?? {};
      if (record[file.kind] !== undefined) fail("invalid-lock", "The lock journal contains a duplicate entry.");
      record[file.kind] = file;
      byGeneration.set(file.generation, record);
    }
    const generations = [...byGeneration.keys()].sort((left, right) => left - right);
    const journal = [];
    for (const [index, generation] of generations.entries()) {
      if (generation !== index + 1) fail("invalid-lock", "The lock journal contains a generation gap.");
      const filesForGeneration = byGeneration.get(generation);
      if (filesForGeneration.claim === undefined) fail("invalid-lock", "A lock release has no claim.");
      const claimPath = lockPath(generation, "claim");
      const claim = readJson(claimPath, MAXIMUM_LOCK_BYTES, `Operation lock claim ${generation}`);
      validateLockClaim(claim.value, generation, `Operation lock claim ${generation}`);
      revalidatePathIdentity(claimPath, claim.identity, `Operation lock claim ${generation}`);
      let release;
      if (filesForGeneration.release !== undefined) {
        const releasePath = lockPath(generation, "release");
        release = readJson(releasePath, MAXIMUM_LOCK_BYTES, `Operation lock release ${generation}`);
        validateLockRelease(release.value, claim, `Operation lock release ${generation}`);
        revalidatePathIdentity(releasePath, release.identity, `Operation lock release ${generation}`);
      }
      if (index < generations.length - 1 && release === undefined) {
        fail("invalid-lock", "A newer lock claim follows an unreleased claim.");
      }
      journal.push(Object.freeze({ claimPath, releasePath: lockPath(generation, "release"), claim, release }));
    }
    return Object.freeze(journal);
  }

  function verifyLockClaimSnapshot(lock) {
    try {
      revalidatePathIdentity(lock.claimPath, lock.claim.identity, "Operation lock claim");
      const current = readJson(lock.claimPath, MAXIMUM_LOCK_BYTES, "Operation lock claim");
      validateLockClaim(current.value, lock.claim.value.generation, "Operation lock claim");
      if (!sameIdentity(current.identity, lock.claim.identity) || !isDeepStrictEqual(current.value, lock.claim.value)) {
        fail("lock-changed", "The operation lock claim changed before release.");
      }
      revalidatePathIdentity(lock.claimPath, current.identity, "Operation lock claim");
    } catch (error) {
      if (error instanceof CheckoutLifecycleError && error.code === "lock-changed") throw error;
      fail("lock-changed", `The operation lock claim changed before release: ${error.message}`);
    }
  }

  function releaseOperationLock(lock, reason, invokeHook = true) {
    verifyLockClaimSnapshot(lock);
    if (invokeHook) hooks?.beforeOperationLockRelease?.(lock);
    const release = {
      protocol: LOCK_RELEASE_PROTOCOL,
      generation: lock.claim.value.generation,
      pid: lock.claim.value.pid,
      token: lock.claim.value.token,
      claimIdentity: lock.claim.identity,
      releasedByPid: process.pid,
      reason
    };
    try {
      writeJsonExclusive(lock.releasePath, release);
    } catch (error) {
      if (error.code === "EEXIST") fail("lock-changed", "The operation lock release path already exists.");
      throw error;
    }
    verifyLockClaimSnapshot(lock);
    const written = readJson(lock.releasePath, MAXIMUM_LOCK_BYTES, "Operation lock release");
    validateLockRelease(written.value, lock.claim, "Operation lock release");
    if (!isDeepStrictEqual(written.value, release)) {
      fail("lock-changed", "The operation lock release changed while it was recorded.");
    }
    revalidatePathIdentity(lock.releasePath, written.identity, "Operation lock release");
  }

  function acquireOperationLock() {
    const token = tokenFactory();
    if (!/^[0-9a-f]{32}$/u.test(token)) fail("invalid-lock", "The generated lock token is malformed.");
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const journal = readLockJournal();
      const latest = journal.at(-1);
      if (latest !== undefined && latest.release === undefined) {
        if (isProcessAlive(latest.claim.value.pid)) fail("manager-busy", "Another lifecycle operation is active.");
        releaseOperationLock(latest, "recovered", false);
        continue;
      }
      const generation = (latest?.claim.value.generation ?? 0) + 1;
      if (generation > MAXIMUM_LOCK_GENERATIONS) fail("invalid-lock", "The operation lock journal is full.");
      const claimPath = lockPath(generation, "claim");
      const value = { protocol: LOCK_PROTOCOL, generation, pid: process.pid, token };
      try {
        writeJsonExclusive(claimPath, value);
      } catch (error) {
        if (error.code === "EEXIST") continue;
        throw error;
      }
      const claim = readJson(claimPath, MAXIMUM_LOCK_BYTES, "Operation lock claim");
      validateLockClaim(claim.value, generation, "Operation lock claim");
      if (!isDeepStrictEqual(claim.value, value)) fail("lock-changed", "The operation lock claim changed.");
      revalidatePathIdentity(claimPath, claim.identity, "Operation lock claim");
      return Object.freeze({ claimPath, releasePath: lockPath(generation, "release"), claim });
    }
    fail("manager-busy", "The operation lock journal changed repeatedly during acquisition.");
  }

  function withLock(callback) {
    initializeManager(true);
    for (const [path, identity] of managedIdentities) {
      assertPrivateDirectory(path, path);
      revalidatePathIdentity(path, identity, path, "directory");
    }
    revalidatePathIdentity(repository.commonGitDirectory, repository.identity, "Git common directory", "directory");
    const lock = acquireOperationLock();
    try {
      hooks?.afterOperationLockAcquired?.(lock);
      return requireSynchronousLifecycleResult(callback());
    } finally {
      releaseOperationLock(lock, "released");
    }
  }

  function validateCheckoutReceipt(value, entry) {
    exactKeys(value, ["protocol", "directory", "gitFile", "gitAdmin", "branch", "head"], "Checkout receipt");
    if (value.protocol !== RECEIPT_PROTOCOL || value.branch !== entry.branch || !SHA_PATTERN.test(value.head)) {
      fail("invalid-registry", "The checkout receipt is malformed.");
    }
    validateIdentity(value.directory, "Checkout directory identity");
    exactKeys(value.gitFile, ["identity", "content"], "Checkout Git file receipt");
    validateIdentity(value.gitFile.identity, "Checkout Git file identity");
    exactKeys(value.gitAdmin, ["path", "identity", "gitdir"], "Checkout Git admin receipt");
    validateIdentity(value.gitAdmin.identity, "Checkout Git admin identity");
    exactKeys(value.gitAdmin.gitdir, ["identity", "content"], "Checkout Git admin backlink receipt");
    validateIdentity(value.gitAdmin.gitdir.identity, "Checkout Git admin backlink identity");
    const adminRoot = join(repository.commonGitDirectory, "worktrees");
    if (
      typeof value.gitFile.content !== "string" ||
      value.gitFile.content.length > 8192 ||
      typeof value.gitAdmin.gitdir.content !== "string" ||
      value.gitAdmin.gitdir.content.length > 8192 ||
      resolve(value.gitAdmin.path) !== value.gitAdmin.path ||
      dirname(value.gitAdmin.path) !== adminRoot ||
      !isContained(adminRoot, value.gitAdmin.path) ||
      value.gitFile.content !== `gitdir: ${value.gitAdmin.path}\n`
    ) {
      fail("invalid-registry", "The checkout Git receipt is malformed.");
    }
  }

  function validateRetirementEvidence(value, entry) {
    exactKeys(
      value,
      ["protocol", "slug", "source", "checkout", "git", "deferredChecks", "authorizesCleanup"],
      "Retirement evidence"
    );
    if (value.protocol !== RETIREMENT_PLAN_PROTOCOL || value.slug !== entry.slug || value.authorizesCleanup !== false) {
      fail("invalid-registry", "The retirement evidence is malformed.");
    }
    exactKeys(
      value.source,
      ["generation", "ownerTask", "revision", "cleanupRequest", "entryIdentity", "entryByteLength", "entrySha256"],
      "Retirement plan source"
    );
    validateIdentity(value.source.entryIdentity, "Retirement plan source identity");
    if (
      !Number.isSafeInteger(value.source.generation) ||
      value.source.generation !== entry.generation ||
      value.source.ownerTask !== entry.ownerTask ||
      value.source.revision !== entry.revision ||
      !isDeepStrictEqual(value.source.cleanupRequest, entry.cleanupRequest) ||
      !Number.isSafeInteger(value.source.entryByteLength) ||
      value.source.entryByteLength < 1 ||
      value.source.entryByteLength > MAXIMUM_ENTRY_BYTES ||
      !/^[0-9a-f]{64}$/u.test(value.source.entrySha256)
    ) {
      fail("invalid-registry", "The retirement plan source is malformed.");
    }
    validateCheckoutReceipt(value.checkout, entry);
    if (!isDeepStrictEqual(value.checkout, entry.checkout)) {
      fail("invalid-registry", "The retirement plan changes the checkout receipt.");
    }
    exactKeys(
      value.git,
      [
        "worktreeListSha256",
        "worktreeRecordCount",
        "nestedWorktreeCount",
        "checkoutPath",
        "targetRecord",
        "commonDir",
        "branch",
        "head",
        "headTree",
        "configNamesSha256",
        "contentFilterConfigKeyCount",
        "statusSha256",
        "statusRecordCount",
        "indexFlagsSha256",
        "unsafeIndexFlags",
        "indexStagesSha256",
        "gitlinkCount",
        "trackedWorktreeClean",
        "stagedClean"
      ],
      "Retirement Git receipt"
    );
    if (
      !/^[0-9a-f]{64}$/u.test(value.git.worktreeListSha256) ||
      !Number.isSafeInteger(value.git.worktreeRecordCount) ||
      value.git.worktreeRecordCount < 1 ||
      value.git.worktreeRecordCount > MAXIMUM_WORKTREE_RECORDS ||
      value.git.nestedWorktreeCount !== 0 ||
      value.git.checkoutPath !== checkoutPathFor(entry.slug) ||
      value.git.branch !== entry.branch ||
      !SHA_PATTERN.test(value.git.head) ||
      !SHA_PATTERN.test(value.git.headTree) ||
      !/^[0-9a-f]{64}$/u.test(value.git.configNamesSha256) ||
      value.git.contentFilterConfigKeyCount !== 0 ||
      !/^[0-9a-f]{64}$/u.test(value.git.statusSha256) ||
      value.git.statusRecordCount !== 0 ||
      !/^[0-9a-f]{64}$/u.test(value.git.indexFlagsSha256) ||
      value.git.unsafeIndexFlags !== 0 ||
      !/^[0-9a-f]{64}$/u.test(value.git.indexStagesSha256) ||
      value.git.gitlinkCount !== 0 ||
      value.git.trackedWorktreeClean !== true ||
      value.git.stagedClean !== true
    ) {
      fail("invalid-registry", "The retirement Git receipt is malformed.");
    }
    exactKeys(value.git.targetRecord, ["path", "HEAD", "branch"], "Retirement target worktree record");
    if (
      value.git.targetRecord.path !== value.git.checkoutPath ||
      value.git.targetRecord.HEAD !== value.git.head ||
      value.git.targetRecord.branch !== `refs/heads/${entry.branch}`
    ) {
      fail("invalid-registry", "The retirement target worktree record is malformed.");
    }
    validateGitAdminCommondirReceipt(value.git.commonDir, entry);
    exactKeys(value.deferredChecks, ["protocol", "recovery", "processUse", "mounts"], "Retirement deferred checks");
    if (
      value.deferredChecks.protocol !== RETIREMENT_CHECKS_PROTOCOL ||
      value.deferredChecks.recovery !== "not-checked-recheck-required" ||
      value.deferredChecks.processUse !== "not-checked-recheck-required" ||
      value.deferredChecks.mounts !== "not-checked-recheck-required"
    ) {
      fail("invalid-registry", "The retirement deferred checks are malformed.");
    }
  }

  function validateEntry(value, slug) {
    const base = [
      "protocol",
      "slug",
      "generation",
      "state",
      "ownerTask",
      "revision",
      "branch",
      "baseCommit",
      "remote",
      "generatedRoots",
      "repository"
    ];
    const keys =
      value?.state === "active"
        ? [...base, "checkout"]
        : value?.state === "cleanup-pending"
          ? [...base, "checkout", "cleanupRequest"]
          : value?.state === "retired"
            ? [...base, "checkout", "cleanupRequest", "tombstone"]
            : value?.state === "abandoned-review-required"
              ? [...base, "cleanupRequest"]
              : base;
    exactKeys(value, keys, `Managed checkout ${slug}`);
    if (
      value.protocol !== ENTRY_PROTOCOL ||
      value.slug !== slug ||
      !Number.isSafeInteger(value.generation) ||
      value.generation < 1 ||
      value.generation > MAXIMUM_ENTRY_GENERATIONS ||
      !["creating", "active", "cleanup-pending", "retired", "abandoned-review-required"].includes(value.state) ||
      !Number.isSafeInteger(value.revision) ||
      value.revision < 1 ||
      !SHA_PATTERN.test(value.baseCommit)
    ) {
      fail("invalid-registry", `Managed checkout ${slug} is malformed.`);
    }
    assertOwner(value.ownerTask);
    assertRemote(value.remote);
    boundedPrintable(value.branch, 240, "Branch name");
    normalizeGeneratedRoots(value.generatedRoots);
    exactKeys(value.repository, ["path", "identity"], "Repository receipt");
    validateIdentity(value.repository.identity, "Repository identity");
    if (
      value.repository.path !== repository.commonGitDirectory ||
      !sameIdentity(value.repository.identity, repository.identity)
    ) {
      fail("repository-changed", "The managed checkout belongs to another repository.");
    }
    if (["active", "cleanup-pending", "retired"].includes(value.state)) validateCheckoutReceipt(value.checkout, value);
    if (["cleanup-pending", "retired", "abandoned-review-required"].includes(value.state)) {
      exactKeys(value.cleanupRequest, ["protocol", "requestedBy", "requestedRevision", "reason"], "Cleanup request");
      if (
        value.cleanupRequest.protocol !== CLEANUP_REQUEST_PROTOCOL ||
        !["finish", "abandon"].includes(value.cleanupRequest.reason) ||
        !Number.isSafeInteger(value.cleanupRequest.requestedRevision) ||
        value.cleanupRequest.requestedRevision < 1 ||
        value.cleanupRequest.requestedRevision > value.revision
      ) {
        fail("invalid-registry", "The cleanup request is malformed.");
      }
      assertOwner(value.cleanupRequest.requestedBy, "cleanup requester");
    }
    if (value.state === "retired") {
      exactKeys(value.tombstone, ["protocol", "record"], "Retirement tombstone");
      exactKeys(value.tombstone.record, ["path", "identity", "byteLength", "sha256"], "Retirement tombstone record");
      validateIdentity(value.tombstone.record.identity, "Retirement tombstone record identity");
      if (
        value.tombstone.protocol !== RETIREMENT_TOMBSTONE_PROTOCOL ||
        typeof value.tombstone.record.path !== "string" ||
        !Number.isSafeInteger(value.tombstone.record.byteLength) ||
        value.tombstone.record.byteLength < 1 ||
        !/^[0-9a-f]{64}$/u.test(value.tombstone.record.sha256)
      ) {
        fail("invalid-registry", "The retirement tombstone is malformed.");
      }
    }
    return value;
  }

  function registryFiles() {
    const items = readDirectoryBounded(paths.entries, MAXIMUM_REGISTRY_FILES, "The checkout registry");
    return items.map((item) => {
      const match = ENTRY_FILE_PATTERN.exec(item.name);
      if (!item.isFile() || item.isSymbolicLink() || match === null) {
        fail("invalid-registry", "The checkout registry contains an unknown entry.");
      }
      return Object.freeze({ name: item.name, slug: match[1], generation: Number(match[2]) });
    });
  }

  function reservationSlugsFromDirectory({ path, label, pattern, type, maximum }) {
    const rootIdentity = optionalPrivateDirectory(path, label);
    if (rootIdentity === null) return Object.freeze([]);
    const snapshots = [];
    for (const item of readDirectoryBounded(path, maximum, label)) {
      const match = pattern.exec(item.name);
      const childPath = join(path, item.name);
      let metadata;
      try {
        metadata = lstatSync(childPath, { bigint: true });
      } catch {
        fail("slug-reservation-changed", `${label} changed while slug reservations were checked.`);
      }
      const expectedType = type === "directory" ? metadata.isDirectory() : metadata.isFile();
      if (
        match === null ||
        !expectedType ||
        metadata.isSymbolicLink() ||
        !currentUserOwns(metadata) ||
        (type === "directory" && realpathSync(childPath) !== resolve(childPath))
      ) {
        fail("invalid-slug-reservation", `${label} contains an unsafe or unrecognized reservation.`);
      }
      snapshots.push(Object.freeze({ path: childPath, identity: identityOf(metadata), slug: match[1], type }));
    }
    for (const snapshot of snapshots) {
      revalidatePathIdentity(snapshot.path, snapshot.identity, `${label} reservation`, snapshot.type);
    }
    revalidatePathIdentity(path, rootIdentity, label, "directory");
    return Object.freeze(snapshots.map((snapshot) => snapshot.slug));
  }

  function slugAuthorityReservations(slug = undefined) {
    if (slug !== undefined) assertSlug(slug);
    const managedSpecifications = [
      {
        path: paths.entries,
        label: "Managed checkout entries",
        pattern: ENTRY_FILE_PATTERN,
        type: "file",
        maximum: MAXIMUM_REGISTRY_FILES
      },
      {
        path: paths.retirements,
        label: "Managed retirement plans",
        pattern: RETIREMENT_PLAN_FILE_PATTERN,
        type: "file",
        maximum: MAXIMUM_ENTRIES * MAXIMUM_RETIREMENT_PLAN_ATTEMPTS
      },
      {
        path: paths.archives,
        label: "Managed recovery archives",
        pattern: ARCHIVE_ATTEMPT_PATTERN,
        type: "directory",
        maximum: MAXIMUM_ARCHIVE_DIRECTORIES
      },
      {
        path: paths.quarantines,
        label: "Managed quarantine journals",
        pattern: QUARANTINE_JOURNAL_PATTERN,
        type: "directory",
        maximum: MAXIMUM_ENTRIES
      },
      {
        path: paths.quarantinedCheckouts,
        label: "Managed quarantined checkouts",
        pattern: RETIREMENT_QUARANTINE_DIRECTORY_PATTERN,
        type: "directory",
        maximum: MAXIMUM_ENTRIES
      },
      {
        path: paths.managedRetirementSweeps,
        label: "Managed retirement sweeps",
        pattern: RETIREMENT_SWEEP_DIRECTORY_PATTERN,
        type: "directory",
        maximum: MAXIMUM_ENTRIES
      },
      {
        path: paths.managedRetirementQuarantine,
        label: "Managed retirement quarantine",
        pattern: RETIREMENT_QUARANTINE_DIRECTORY_PATTERN,
        type: "directory",
        maximum: MAXIMUM_ENTRIES
      }
    ];
    const legacySpecifications = [
      {
        path: paths.legacyAdoptionAttempts,
        label: "Legacy adoption attempts",
        pattern: LEGACY_ADOPTION_ATTEMPT_PATTERN,
        type: "directory",
        maximum: MAXIMUM_ENTRIES * MAXIMUM_LEGACY_ADOPTION_ATTEMPTS
      },
      {
        path: paths.legacyAdoptionEntries,
        label: "Legacy adoption entries",
        pattern: LEGACY_ADOPTION_ENTRY_PATTERN,
        type: "file",
        maximum: MAXIMUM_ENTRIES
      },
      {
        path: paths.legacyArchiveAttempts,
        label: "Legacy recovery-archive attempts",
        pattern: LEGACY_ARCHIVE_ATTEMPT_PATTERN,
        type: "directory",
        maximum: MAXIMUM_ENTRIES * MAXIMUM_LEGACY_ADOPTION_ATTEMPTS * MAXIMUM_LEGACY_ARCHIVE_ATTEMPTS
      },
      {
        path: paths.legacyArchiveEntries,
        label: "Legacy recovery-archive entries",
        pattern: LEGACY_ARCHIVE_ENTRY_PATTERN,
        type: "file",
        maximum: MAXIMUM_ENTRIES
      },
      {
        path: paths.legacyRetirementSweeps,
        label: "Legacy retirement sweeps",
        pattern: RETIREMENT_SWEEP_DIRECTORY_PATTERN,
        type: "directory",
        maximum: MAXIMUM_ENTRIES
      },
      {
        path: paths.legacyRetirementQuarantine,
        label: "Legacy retirement quarantine",
        pattern: RETIREMENT_QUARANTINE_DIRECTORY_PATTERN,
        type: "directory",
        maximum: MAXIMUM_ENTRIES
      }
    ];
    const collect = (specifications) => {
      const values = new Set();
      for (const specification of specifications) {
        for (const value of reservationSlugsFromDirectory(specification)) values.add(value);
      }
      return Object.freeze([...values].filter((value) => slug === undefined || value === slug).sort());
    };
    return Object.freeze({ managed: collect(managedSpecifications), legacy: collect(legacySpecifications) });
  }

  function assertSlugAuthorityAvailable(slug, requestedKind) {
    const reservations = slugAuthorityReservations(slug);
    const conflictingKind = requestedKind === "managed" ? "legacy" : "managed";
    if (reservations[conflictingKind].length !== 0) {
      fail(
        "checkout-slug-reserved",
        `Checkout ${slug} is permanently reserved by ${conflictingKind} lifecycle history.`
      );
    }
    return reservations;
  }

  function validateEntryTransition(previous, next) {
    for (const key of ["protocol", "slug", "branch", "baseCommit", "remote", "generatedRoots", "repository"]) {
      if (!isDeepStrictEqual(previous[key], next[key])) {
        fail("invalid-registry", `Managed checkout ${previous.slug} changes immutable field ${key}.`);
      }
    }
    if (next.generation !== previous.generation + 1) {
      fail("invalid-registry", `Managed checkout ${previous.slug} skips an entry generation.`);
    }
    const handoff = next.revision === previous.revision + 1;
    const sameOwnerRevision = next.revision === previous.revision && next.ownerTask === previous.ownerTask;
    if (previous.state === "creating") {
      if (!sameOwnerRevision || !["active", "abandoned-review-required"].includes(next.state)) {
        fail("invalid-registry", `Managed checkout ${previous.slug} has an invalid creation transition.`);
      }
    } else if (previous.state === "active") {
      if (!((next.state === "active" && handoff) || (next.state === "cleanup-pending" && sameOwnerRevision))) {
        fail("invalid-registry", `Managed checkout ${previous.slug} has an invalid active transition.`);
      }
    } else if (previous.state === "retired") {
      fail("invalid-registry", `Managed checkout ${previous.slug} changes after its terminal tombstone.`);
    } else if (previous.state === "cleanup-pending" && next.state === "retired" && sameOwnerRevision) {
      // Terminal retirement is the only cleanup transition that does not hand off ownership.
    } else if (next.state !== previous.state || !handoff) {
      fail("invalid-registry", `Managed checkout ${previous.slug} has an invalid review transition.`);
    }
    if (handoff && next.ownerTask === previous.ownerTask) {
      fail("invalid-registry", `Managed checkout ${previous.slug} handoff does not change owner.`);
    }
    if (["active", "cleanup-pending", "retired"].includes(previous.state)) {
      if (!isDeepStrictEqual(previous.checkout, next.checkout)) {
        fail("invalid-registry", `Managed checkout ${previous.slug} changes its checkout receipt.`);
      }
    }
    if (["cleanup-pending", "retired", "abandoned-review-required"].includes(previous.state)) {
      if (!isDeepStrictEqual(previous.cleanupRequest, next.cleanupRequest)) {
        fail("invalid-registry", `Managed checkout ${previous.slug} changes its cleanup request.`);
      }
    }
  }

  function readEntryHistory(slug) {
    assertSlug(slug);
    const files = registryFiles()
      .filter((file) => file.slug === slug)
      .sort((left, right) => left.generation - right.generation);
    if (files.length === 0) fail("checkout-not-found", `Managed checkout ${slug} does not exist.`);
    if (files.length > MAXIMUM_ENTRY_GENERATIONS) {
      fail("invalid-registry", `Managed checkout ${slug} has too many generations.`);
    }
    const history = [];
    for (const [index, file] of files.entries()) {
      if (file.generation !== index + 1) {
        fail("invalid-registry", `Managed checkout ${slug} has a missing or duplicate generation.`);
      }
      const loaded = readJson(entryPath(slug, file.generation), MAXIMUM_ENTRY_BYTES, `Managed checkout ${slug}`);
      revalidatePathIdentity(entryPath(slug, file.generation), loaded.identity, `Managed checkout ${slug}`);
      const value = validateEntry(loaded.value, slug);
      if (value.generation !== file.generation) {
        fail("invalid-registry", `Managed checkout ${slug} has a mismatched entry generation.`);
      }
      if (index > 0) validateEntryTransition(history[index - 1], value);
      entryIdentities.set(value, loaded.identity);
      history.push(value);
    }
    return Object.freeze(history);
  }

  function readEntry(slug) {
    return readEntryHistory(slug).at(-1);
  }

  function writeInitialEntry(entry) {
    validateEntry(entry, entry.slug);
    if (entry.generation !== 1 || registryFiles().some((file) => file.slug === entry.slug)) {
      fail("checkout-exists", `Checkout ${entry.slug} exists.`);
    }
    try {
      writeJsonExclusive(entryPath(entry.slug, 1), entry);
    } catch (error) {
      if (error.code === "EEXIST") fail("registry-changed", `Managed checkout ${entry.slug} appeared concurrently.`);
      throw error;
    }
    const written = readJson(entryPath(entry.slug, 1), MAXIMUM_ENTRY_BYTES, `Managed checkout ${entry.slug}`);
    if (!isDeepStrictEqual(written.value, entry)) {
      fail("registry-changed", `Managed checkout ${entry.slug} changed while it was created.`);
    }
    revalidatePathIdentity(entryPath(entry.slug, 1), written.identity, `Managed checkout ${entry.slug}`);
    entryIdentities.set(entry, written.identity);
    return entry;
  }

  function verifyEntrySnapshot(entry) {
    const identity = entryIdentities.get(entry);
    if (identity === undefined) fail("registry-changed", `Managed checkout ${entry.slug} has no read receipt.`);
    revalidatePathIdentity(entryPath(entry.slug, entry.generation), identity, `Managed checkout ${entry.slug}`);
    const current = readJson(
      entryPath(entry.slug, entry.generation),
      MAXIMUM_ENTRY_BYTES,
      `Managed checkout ${entry.slug}`
    );
    if (!sameIdentity(current.identity, identity) || !isDeepStrictEqual(current.value, entry)) {
      fail("registry-changed", `Managed checkout ${entry.slug} changed before its update was recorded.`);
    }
    return identity;
  }

  function appendEntry(previous, value) {
    const next = { ...value, generation: previous.generation + 1 };
    validateEntry(next, previous.slug);
    validateEntryTransition(previous, next);
    const previousIdentity = verifyEntrySnapshot(previous);
    try {
      writeJsonExclusive(entryPath(next.slug, next.generation), next);
    } catch (error) {
      if (error.code === "EEXIST") {
        fail("registry-changed", `Managed checkout ${next.slug} changed before its update was recorded.`);
      }
      throw error;
    }
    revalidatePathIdentity(
      entryPath(previous.slug, previous.generation),
      previousIdentity,
      `Managed checkout ${previous.slug}`
    );
    const written = readJson(
      entryPath(next.slug, next.generation),
      MAXIMUM_ENTRY_BYTES,
      `Managed checkout ${next.slug}`
    );
    if (!isDeepStrictEqual(written.value, next)) {
      fail("registry-changed", `Managed checkout ${next.slug} changed while its update was recorded.`);
    }
    revalidatePathIdentity(entryPath(next.slug, next.generation), written.identity, `Managed checkout ${next.slug}`);
    entryIdentities.set(next, written.identity);
    return next;
  }

  function worktreeRegistry(readOnly = false) {
    const output = commonGit(run, paths, repository, ["worktree", "list", "--porcelain", "-z"], {
      env: readOnly ? auditGitEnvironment() : undefined
    }).stdout;
    return Object.freeze({ output, records: parseWorktreeList(output) });
  }

  function worktreeRecords(readOnly = false) {
    return worktreeRegistry(readOnly).records;
  }

  function worktreeRecord(checkoutPath, readOnly = false) {
    const matches = worktreeRecords(readOnly).filter((record) => record.path === checkoutPath);
    if (matches.length > 1) fail("ambiguous-checkout", "Git reported the managed checkout more than once.");
    return matches[0];
  }

  function readGitFile(checkoutPath) {
    return readBoundedFile(join(checkoutPath, ".git"), 8192, "Checkout .git file");
  }

  function captureCheckoutReceipt(entry) {
    const checkoutPath = checkoutPathFor(entry.slug);
    const metadata = lstatSync(checkoutPath, { bigint: true });
    if (
      !metadata.isDirectory() ||
      metadata.isSymbolicLink() ||
      !currentUserOwns(metadata) ||
      realpathSync(checkoutPath) !== checkoutPath
    ) {
      fail("unsafe-checkout", "The new checkout is not one owned canonical directory.");
    }
    const gitFile = readGitFile(checkoutPath);
    const match = /^gitdir: (.+)\n$/u.exec(gitFile.text);
    if (match === null) fail("unsafe-checkout", "The checkout .git file is malformed.");
    const adminPath = realpathSync(match[1]);
    const admin = lstatSync(adminPath, { bigint: true });
    const adminGitdir = readBoundedFile(join(adminPath, "gitdir"), 8192, "Checkout Git admin backlink");
    const receipt = {
      protocol: RECEIPT_PROTOCOL,
      directory: identityOf(metadata),
      gitFile: { identity: gitFile.identity, content: gitFile.text },
      gitAdmin: {
        path: adminPath,
        identity: identityOf(admin),
        gitdir: { identity: adminGitdir.identity, content: adminGitdir.text }
      },
      branch: checkoutGit(run, paths, checkoutPath, ["symbolic-ref", "--quiet", "--short", "HEAD"]).stdout.trim(),
      head: checkoutGit(run, paths, checkoutPath, ["rev-parse", "HEAD"]).stdout.trim()
    };
    validateCheckoutReceipt(receipt, entry);
    return receipt;
  }

  function reconcileCreating(entry) {
    if (entry.state !== "creating") return entry;
    assertNoQuarantineHistoryForSlug(entry.slug);
    const checkoutPath = checkoutPathFor(entry.slug);
    const present = existsSync(checkoutPath);
    const record = worktreeRecord(checkoutPath, true);
    if (!present && record === undefined) return entry;
    if (!present || record === undefined) fail("interrupted-create-mismatch", "Creation is only partly registered.");
    const checkout = captureCheckoutReceipt(entry);
    const recordBranch = record.branch?.replace(/^refs\/heads\//u, "") ?? null;
    if (checkout.branch !== entry.branch || recordBranch !== entry.branch || checkout.head !== record.HEAD) {
      fail("interrupted-create-mismatch", "The adopted checkout differs from its registry entry.");
    }
    for (const root of entry.generatedRoots) {
      if (existsSync(join(checkoutPath, root)))
        fail("interrupted-create-mismatch", `Generated root ${root} already exists.`);
    }
    return appendEntry(entry, { ...entry, state: "active", checkout });
  }

  function assertOwnerRevision(entry, ownerTask, revision) {
    assertOwner(ownerTask);
    assertRevision(revision);
    if (entry.ownerTask !== ownerTask || entry.revision !== revision) {
      fail("ownership-changed", `Managed checkout ${entry.slug} belongs to another task or revision.`);
    }
  }

  function auditEntry(entry) {
    const checkoutPath = checkoutPathFor(entry.slug);
    const record = worktreeRecord(checkoutPath, true);
    const issues = [];
    let receiptMatches = false;
    let branch = record?.branch?.replace(/^refs\/heads\//u, "") ?? null;
    let head = record?.HEAD ?? null;
    let unsafeIndexFlags = null;
    let registrationMatches = false;
    let porcelainClean = null;
    let generatedOnly = null;
    let trackedWorktreeClean = null;
    let stagedClean = null;
    let gitlinkCount = null;
    let contentFilterConfigKeys = null;
    if (entry.state === "creating") issues.push("creation-incomplete");
    else if (entry.state === "abandoned-review-required") issues.push("abandoned-review-required");
    else if (!existsSync(checkoutPath)) issues.push("checkout-path-missing");
    else {
      try {
        revalidatePathIdentity(checkoutPath, entry.checkout.directory, "Managed checkout", "directory");
        const gitFile = readGitFile(checkoutPath);
        revalidatePathIdentity(
          entry.checkout.gitAdmin.path,
          entry.checkout.gitAdmin.identity,
          "Git admin",
          "directory"
        );
        const adminGitdir = readBoundedFile(
          join(entry.checkout.gitAdmin.path, "gitdir"),
          8192,
          "Checkout Git admin backlink"
        );
        if (
          !sameIdentity(gitFile.identity, entry.checkout.gitFile.identity) ||
          gitFile.text !== entry.checkout.gitFile.content
        ) {
          fail("checkout-changed", "The checkout .git file changed.");
        }
        if (
          !sameIdentity(adminGitdir.identity, entry.checkout.gitAdmin.gitdir.identity) ||
          adminGitdir.text !== entry.checkout.gitAdmin.gitdir.content
        ) {
          fail("checkout-changed", "The checkout Git admin backlink changed.");
        }
        receiptMatches = true;
      } catch {
        issues.push("filesystem-receipt-mismatch");
      }
      if (receiptMatches) {
        const gitAdminPath = entry.checkout.gitAdmin.path;
        const observedBranch = auditCheckoutGit(run, paths, checkoutPath, gitAdminPath, [
          "symbolic-ref",
          "--quiet",
          "--short",
          "HEAD"
        ]);
        const observedHead = auditCheckoutGit(run, paths, checkoutPath, gitAdminPath, [
          "rev-parse",
          "--verify",
          "HEAD"
        ]);
        branch = observedBranch.status === 0 ? observedBranch.stdout.trim() : null;
        head = observedHead.status === 0 ? observedHead.stdout.trim() : null;
        registrationMatches =
          branch === entry.branch && record?.branch === `refs/heads/${entry.branch}` && record?.HEAD === head;
        if (!registrationMatches) {
          issues.push("git-registration-mismatch");
        }
        const configNames = auditCheckoutGit(run, paths, checkoutPath, gitAdminPath, [
          "config",
          "--null",
          "--name-only",
          "--list"
        ]);
        if (configNames.status === 0) {
          contentFilterConfigKeys = configuredContentFilterKeys(configNames.stdout).length;
          if (contentFilterConfigKeys > 0) issues.push("external-content-filter-configured");
        } else issues.push("git-config-unreadable");
        const flags = auditCheckoutGit(run, paths, checkoutPath, gitAdminPath, ["ls-files", "-v", "-z"]);
        if (flags.status === 0) {
          unsafeIndexFlags = flags.stdout
            .split("\0")
            .filter(Boolean)
            .filter((item) => item[0] !== "H").length;
          if (unsafeIndexFlags > 0) issues.push("assume-unchanged-or-skip-worktree");
        } else issues.push("index-flags-unreadable");
        const stages = auditCheckoutGit(run, paths, checkoutPath, gitAdminPath, ["ls-files", "--stage", "-z"]);
        if (stages.status === 0) {
          gitlinkCount = stages.stdout
            .split("\0")
            .filter(Boolean)
            .filter((item) => item.startsWith("160000 ")).length;
          if (gitlinkCount > 0) issues.push("submodule-present");
        } else issues.push("index-stages-unreadable");
        if (contentFilterConfigKeys === 0) {
          const status = auditCheckoutGit(run, paths, checkoutPath, gitAdminPath, [
            "status",
            "--porcelain=v2",
            "-z",
            "--untracked-files=all",
            "--ignored=matching",
            "--ignore-submodules=all"
          ]);
          if (status.status === 0) {
            const records = parseStatus(status.stdout);
            porcelainClean = records.length === 0;
            generatedOnly = records.every(
              (item) => item.kind === "ignored" && belongsToGeneratedRoot(item.path, entry.generatedRoots)
            );
            if (!generatedOnly) issues.push("tracked-or-user-work-present");
          } else issues.push("status-unreadable");
          const worktreeDiff = auditCheckoutGit(run, paths, checkoutPath, gitAdminPath, [
            "diff-files",
            "--quiet",
            "--no-ext-diff",
            "--no-textconv",
            "--ignore-submodules=all",
            "--"
          ]);
          trackedWorktreeClean = worktreeDiff.status === 0 && unsafeIndexFlags === 0 && gitlinkCount === 0;
          if (!trackedWorktreeClean) issues.push("tracked-worktree-not-proven-clean");
          const stagedDiff = auditCheckoutGit(run, paths, checkoutPath, gitAdminPath, [
            "diff-index",
            "--cached",
            "--quiet",
            "--no-ext-diff",
            "--no-textconv",
            "--ignore-submodules=all",
            "HEAD",
            "--"
          ]);
          stagedClean = stagedDiff.status === 0;
          if (!stagedClean) issues.push("index-not-clean");
        }
      }
    }
    return Object.freeze({
      slug: entry.slug,
      state: entry.state,
      ownerTask: entry.ownerTask,
      revision: entry.revision,
      checkoutPath,
      pathPresent: existsSync(checkoutPath),
      registered: record !== undefined,
      registrationMatches,
      receiptMatches,
      branch,
      head,
      unsafeIndexFlags,
      gitlinkCount,
      contentFilterConfigKeys,
      porcelainClean,
      generatedOnly,
      trackedWorktreeClean,
      stagedClean,
      candidateForReviewedCleanup:
        receiptMatches &&
        registrationMatches &&
        unsafeIndexFlags === 0 &&
        gitlinkCount === 0 &&
        contentFilterConfigKeys === 0 &&
        generatedOnly === true &&
        trackedWorktreeClean === true &&
        stagedClean === true,
      issues: Object.freeze([...new Set(issues)])
    });
  }

  function requireAuditCommand(entry, checkoutPath, args, label) {
    const result = auditCheckoutGit(run, paths, checkoutPath, entry.checkout.gitAdmin.path, args);
    if (result.status !== 0) fail("retirement-not-eligible", `${label} could not be proven.`);
    return result.stdout;
  }

  function captureSourceEntryReceipt(entry) {
    const expectedIdentity = verifyEntrySnapshot(entry);
    const source = readBoundedFile(
      entryPath(entry.slug, entry.generation),
      MAXIMUM_ENTRY_BYTES,
      `Managed checkout ${entry.slug}`,
      0o600n
    );
    if (!sameIdentity(source.identity, expectedIdentity)) {
      fail("registry-changed", "The cleanup-pending entry changed while retirement evidence was collected.");
    }
    return Object.freeze({
      generation: entry.generation,
      ownerTask: entry.ownerTask,
      revision: entry.revision,
      cleanupRequest: entry.cleanupRequest,
      entryIdentity: expectedIdentity,
      entryByteLength: Buffer.byteLength(source.text, "utf8"),
      entrySha256: sha256(source.text)
    });
  }

  function verifyCheckoutFilesystemReceipt(entry) {
    const checkoutPath = checkoutPathFor(entry.slug);
    revalidatePathIdentity(checkoutPath, entry.checkout.directory, "Managed checkout", "directory");
    const gitFile = readGitFile(checkoutPath);
    revalidatePathIdentity(entry.checkout.gitAdmin.path, entry.checkout.gitAdmin.identity, "Git admin", "directory");
    const backlink = readBoundedFile(join(entry.checkout.gitAdmin.path, "gitdir"), 8192, "Checkout Git admin backlink");
    if (
      !sameIdentity(gitFile.identity, entry.checkout.gitFile.identity) ||
      gitFile.text !== entry.checkout.gitFile.content ||
      !sameIdentity(backlink.identity, entry.checkout.gitAdmin.gitdir.identity) ||
      backlink.text !== entry.checkout.gitAdmin.gitdir.content
    ) {
      fail("retirement-not-eligible", "The checkout filesystem receipt no longer matches.");
    }
    return captureGitAdminCommondir(entry);
  }

  function captureGitAdminCommondir(entry) {
    const path = join(entry.checkout.gitAdmin.path, "commondir");
    const file = readBoundedFile(path, 8192, "Checkout Git admin common-directory link");
    const match = /^([^\0\r\n]+)\n$/u.exec(file.text);
    if (match === null) {
      fail("retirement-not-eligible", "The checkout Git common-directory link is malformed.");
    }
    const configuredTarget = resolve(entry.checkout.gitAdmin.path, match[1]);
    if (configuredTarget !== repository.commonGitDirectory) {
      fail("retirement-not-eligible", "The checkout Git common-directory link targets another repository.");
    }
    let target;
    try {
      target = realpathSync(configuredTarget);
    } catch {
      fail("retirement-not-eligible", "The checkout Git common directory cannot be resolved.");
    }
    revalidatePathIdentity(target, repository.identity, "Git common directory", "directory");
    return Object.freeze({ path, identity: file.identity, content: file.text, target });
  }

  function validateGitAdminCommondirReceipt(value, entry) {
    exactKeys(value, ["path", "identity", "content", "target"], "Checkout Git common-directory receipt");
    validateIdentity(value.identity, "Checkout Git common-directory file identity");
    const match = typeof value.content === "string" ? /^([^\0\r\n]+)\n$/u.exec(value.content) : null;
    if (
      value.path !== join(entry.checkout.gitAdmin.path, "commondir") ||
      value.target !== repository.commonGitDirectory ||
      match === null ||
      resolve(entry.checkout.gitAdmin.path, match[1]) !== repository.commonGitDirectory
    ) {
      fail("invalid-registry", "The checkout Git common-directory receipt is malformed.");
    }
  }

  function captureRetirementEvidence(entry) {
    if (entry.state !== "cleanup-pending") {
      fail("checkout-not-cleanup-pending", "Only a cleanup-pending checkout can be planned for retirement.");
    }
    const source = captureSourceEntryReceipt(entry);
    const commonDir = verifyCheckoutFilesystemReceipt(entry);
    const checkoutPath = checkoutPathFor(entry.slug);
    const registry = worktreeRegistry(true);
    const records = registry.records.filter((record) => record.path === checkoutPath);
    if (records.length !== 1) fail("retirement-not-eligible", "The checkout has no exact Git worktree record.");
    const record = records[0];
    if (Object.keys(record).sort().join("\0") !== ["HEAD", "branch", "path"].sort().join("\0")) {
      fail("retirement-not-eligible", "The checkout worktree record is detached, locked, or otherwise ambiguous.");
    }
    const nestedWorktrees = registry.records.filter(
      (candidate) => candidate.path !== checkoutPath && isContained(checkoutPath, candidate.path)
    );
    if (nestedWorktrees.length !== 0) {
      fail("retirement-not-eligible", "Another registered worktree is nested below the checkout.");
    }
    const branch = requireAuditCommand(
      entry,
      checkoutPath,
      ["symbolic-ref", "--quiet", "--short", "HEAD"],
      "The checkout branch"
    ).trim();
    const head = requireAuditCommand(
      entry,
      checkoutPath,
      ["rev-parse", "--verify", "HEAD"],
      "The checkout head"
    ).trim();
    const headTree = requireAuditCommand(
      entry,
      checkoutPath,
      ["rev-parse", "--verify", "HEAD^{tree}"],
      "The checkout tree"
    ).trim();
    const configNames = requireAuditCommand(
      entry,
      checkoutPath,
      ["config", "--null", "--name-only", "--list"],
      "The checkout Git configuration"
    );
    const contentFilterConfigKeyCount = configuredContentFilterKeys(configNames).length;
    if (contentFilterConfigKeyCount !== 0) {
      fail("retirement-not-eligible", "The checkout configures an external Git content filter.");
    }
    const status = requireAuditCommand(
      entry,
      checkoutPath,
      ["status", "--porcelain=v2", "-z", "--untracked-files=all", "--ignored=matching", "--ignore-submodules=all"],
      "The checkout status"
    );
    const flags = requireAuditCommand(entry, checkoutPath, ["ls-files", "-v", "-z"], "The checkout index flags");
    const stages = requireAuditCommand(entry, checkoutPath, ["ls-files", "--stage", "-z"], "The checkout index stages");
    const statusRecords = parseStatus(status);
    const unsafeIndexFlags = flags
      .split("\0")
      .filter(Boolean)
      .filter((item) => item[0] !== "H").length;
    const gitlinkCount = stages
      .split("\0")
      .filter(Boolean)
      .filter((item) => item.startsWith("160000 ")).length;
    const trackedWorktreeClean =
      auditCheckoutGit(run, paths, checkoutPath, entry.checkout.gitAdmin.path, [
        "diff-files",
        "--quiet",
        "--no-ext-diff",
        "--no-textconv",
        "--ignore-submodules=all",
        "--"
      ]).status === 0 && unsafeIndexFlags === 0;
    const stagedClean =
      auditCheckoutGit(run, paths, checkoutPath, entry.checkout.gitAdmin.path, [
        "diff-index",
        "--cached",
        "--quiet",
        "--no-ext-diff",
        "--no-textconv",
        "--ignore-submodules=all",
        "HEAD",
        "--"
      ]).status === 0;
    if (
      branch !== entry.branch ||
      record.branch !== `refs/heads/${entry.branch}` ||
      record.HEAD !== head ||
      !SHA_PATTERN.test(head) ||
      !SHA_PATTERN.test(headTree) ||
      statusRecords.length !== 0 ||
      unsafeIndexFlags !== 0 ||
      gitlinkCount !== 0 ||
      !trackedWorktreeClean ||
      !stagedClean
    ) {
      fail("retirement-not-eligible", "The checkout changed while retirement evidence was collected.");
    }
    const confirmedCommonDir = captureGitAdminCommondir(entry);
    if (!isDeepStrictEqual(confirmedCommonDir, commonDir)) {
      fail("registry-changed", "The checkout Git common-directory link changed during evidence collection.");
    }
    const evidence = {
      protocol: RETIREMENT_PLAN_PROTOCOL,
      slug: entry.slug,
      source,
      checkout: entry.checkout,
      git: {
        worktreeListSha256: sha256(registry.output),
        worktreeRecordCount: registry.records.length,
        nestedWorktreeCount: nestedWorktrees.length,
        checkoutPath,
        targetRecord: record,
        commonDir,
        branch,
        head,
        headTree,
        configNamesSha256: sha256(configNames),
        contentFilterConfigKeyCount,
        statusSha256: sha256(status),
        statusRecordCount: statusRecords.length,
        indexFlagsSha256: sha256(flags),
        unsafeIndexFlags,
        indexStagesSha256: sha256(stages),
        gitlinkCount,
        trackedWorktreeClean,
        stagedClean
      },
      deferredChecks: {
        protocol: RETIREMENT_CHECKS_PROTOCOL,
        recovery: "not-checked-recheck-required",
        processUse: "not-checked-recheck-required",
        mounts: "not-checked-recheck-required"
      },
      authorizesCleanup: false
    };
    validateRetirementEvidence(evidence, entry);
    return evidence;
  }

  function readRetirementPlan(entry) {
    const plans = listRetirementPlans(entry);
    if (plans.length === 0) fail("retirement-evidence-missing", "Retirement evidence must be recorded first.");
    return plans.at(-1);
  }

  function revalidateRetirementPlan(plan, entry) {
    revalidatePathIdentity(plan.path, plan.identity, `Retirement evidence for ${entry.slug}`);
    const current = readRetirementPlan(entry);
    if (
      !sameIdentity(current.identity, plan.identity) ||
      current.byteLength !== plan.byteLength ||
      current.sha256 !== plan.sha256 ||
      !isDeepStrictEqual(current.value, plan.value)
    ) {
      fail("registry-changed", "The retirement evidence changed while the archive was prepared.");
    }
  }

  function requireCommonArchiveCommand(args, label, options = {}) {
    const result = commonGit(run, paths, repository, args, {
      allowFailure: true,
      env: auditGitEnvironment(),
      stdoutFd: options.stdoutFd,
      input: options.input
    });
    if (result.status !== 0) fail("archive-command-failed", `${label} failed.`);
    return result;
  }

  function requireArchiveGitCommand(gitDirectory, args, label, options = {}) {
    const result = run("git", ["--git-dir", gitDirectory, ...args], {
      cwd: options.cwd ?? paths.root,
      allowFailure: true,
      env: auditGitEnvironment(),
      input: options.input,
      stdinFd: options.stdinFd,
      stdoutFd: options.stdoutFd
    });
    if (result.status !== 0) fail("archive-command-failed", `${label} failed.`);
    return result;
  }

  function requireStandaloneArchiveGitCommand(args, cwd, label, options = {}) {
    const result = run("git", args, {
      cwd,
      allowFailure: true,
      env: auditGitEnvironment(),
      input: options.input,
      stdinFd: options.stdinFd,
      stdoutFd: options.stdoutFd
    });
    if (result.status !== 0) fail("archive-command-failed", `${label} failed.`);
    return result;
  }

  function archiveFreeSpace(objectDiskBytes) {
    let filesystem;
    try {
      filesystem = statFilesystem(paths.root, { bigint: true });
    } catch (error) {
      fail("archive-not-eligible", `Archive free space could not be inspected: ${error.message}`);
    }
    if (filesystem.bsize <= 0n || filesystem.bavail < 0n) {
      fail("archive-not-eligible", "Archive free space reporting is malformed.");
    }
    const availableBytes = filesystem.bsize * filesystem.bavail;
    const requiredBytes = objectDiskBytes * ARCHIVE_SPACE_MULTIPLIER + ARCHIVE_SPACE_RESERVE_BYTES;
    if (availableBytes < requiredBytes) {
      fail(
        "archive-space-insufficient",
        `The archive needs a conservative ${requiredBytes}-byte free-space budget; ${availableBytes} bytes are available.`
      );
    }
    return Object.freeze({
      objectDiskBytes: objectDiskBytes.toString(),
      multiplier: Number(ARCHIVE_SPACE_MULTIPLIER),
      reserveBytes: ARCHIVE_SPACE_RESERVE_BYTES.toString(),
      requiredBytes: requiredBytes.toString(),
      availableBytes: availableBytes.toString()
    });
  }

  function captureOrigHead(gitDirectory, ref, objectIdLength, label) {
    const path = join(gitDirectory, "ORIG_HEAD");
    if (!entryExistsNoFollow(path, `${label} ORIG_HEAD`)) return null;
    const file = readBoundedFile(path, 256, `${label} ORIG_HEAD`);
    const match = new RegExp(`^([0-9a-f]{${objectIdLength}})\\n?$`, "u").exec(file.text);
    if (match === null) fail("archive-not-eligible", `${label} ORIG_HEAD is malformed.`);
    return Object.freeze({
      oid: match[1],
      ref,
      state: Object.freeze({
        path,
        identity: file.identity,
        byteLength: Buffer.byteLength(file.text, "utf8"),
        sha256: sha256(file.text)
      })
    });
  }

  function captureFetchHead(gitDirectory, objectIdLength, label) {
    const path = join(gitDirectory, "FETCH_HEAD");
    if (!entryExistsNoFollow(path, `${label} FETCH_HEAD`)) {
      return Object.freeze({ objectIds: Object.freeze([]), state: null });
    }
    const file = readBoundedBytes(path, MAXIMUM_ARCHIVE_FETCH_HEAD_BYTES, `${label} FETCH_HEAD`);
    if (file.bytes.length !== 0 && file.bytes.at(-1) !== 0x0a) {
      fail("archive-not-eligible", `${label} FETCH_HEAD is malformed.`);
    }
    const objectIds = [];
    let entryCount = 0;
    let lineStart = 0;
    for (let offset = 0; offset < file.bytes.length; offset += 1) {
      if (file.bytes[offset] !== 0x0a) continue;
      entryCount += 1;
      if (entryCount > MAXIMUM_ARCHIVE_FETCH_HEAD_ENTRIES) {
        fail("archive-not-eligible", `${label} FETCH_HEAD contains too many entries.`);
      }
      const line = file.bytes.subarray(lineStart, offset);
      lineStart = offset + 1;
      const firstTab = line.indexOf(0x09);
      const secondTab = firstTab === -1 ? -1 : line.indexOf(0x09, firstTab + 1);
      const oidBytes = firstTab === -1 ? Buffer.alloc(0) : line.subarray(0, firstTab);
      const marker = secondTab === -1 ? Buffer.alloc(0) : line.subarray(firstTab + 1, secondTab);
      const description = secondTab === -1 ? Buffer.alloc(0) : line.subarray(secondTab + 1);
      if (
        oidBytes.length !== objectIdLength ||
        [...oidBytes].some((byte) => !(byte >= 0x30 && byte <= 0x39) && !(byte >= 0x61 && byte <= 0x66)) ||
        !(marker.length === 0 || (marker.length === 13 && marker.equals(Buffer.from("not-for-merge", "ascii")))) ||
        description.includes(0x00)
      ) {
        fail("archive-not-eligible", `${label} FETCH_HEAD is malformed.`);
      }
      objectIds.push(oidBytes.toString("ascii"));
    }
    return Object.freeze({
      objectIds: Object.freeze([...new Set(objectIds)].sort()),
      state: Object.freeze({
        path,
        identity: file.identity,
        byteLength: file.bytes.length,
        sha256: sha256(file.bytes),
        entryCount
      })
    });
  }

  function objectIdsReceipt(objectIds) {
    const canonical = objectIds.length === 0 ? "" : `${objectIds.join("\n")}\n`;
    return Object.freeze({ count: objectIds.length, sha256: sha256(canonical) });
  }

  function fetchHeadReceipt(fetchHead) {
    return Object.freeze({
      present: fetchHead.state !== null,
      byteLength: fetchHead.state?.byteLength ?? 0,
      sha256: fetchHead.state?.sha256 ?? sha256(""),
      entryCount: fetchHead.state?.entryCount ?? 0,
      objectIds: objectIdsReceipt(fetchHead.objectIds)
    });
  }

  function captureTargetAdminState(entry, objectIdLength) {
    const adminPath = entry.checkout.gitAdmin.path;
    revalidatePathIdentity(adminPath, entry.checkout.gitAdmin.identity, "Target Git admin", "directory");
    const allowedFiles = new Set(["COMMIT_EDITMSG", "FETCH_HEAD", "HEAD", "ORIG_HEAD", "commondir", "gitdir", "index"]);
    const allowedDirectories = new Set(["logs", "refs"]);
    const records = [];
    const entries = readDirectoryBounded(adminPath, 32, "The target Git admin directory").sort((left, right) =>
      Buffer.compare(Buffer.from(left.name), Buffer.from(right.name))
    );
    let fetchHead = Object.freeze({ objectIds: Object.freeze([]), state: null });
    for (const item of entries) {
      const path = join(adminPath, item.name);
      const metadata = lstatSync(path, { bigint: true });
      if (item.isSymbolicLink() || !currentUserOwns(metadata)) {
        fail("archive-not-eligible", "The target Git admin directory contains an unsafe entry.");
      }
      if (item.isFile() && allowedFiles.has(item.name)) {
        if (!metadata.isFile() || metadata.nlink !== 1n) {
          fail("archive-not-eligible", "The target Git admin directory contains an unsafe file.");
        }
        const identity = identityOf(metadata);
        if (item.name === "FETCH_HEAD") {
          fetchHead = captureFetchHead(adminPath, objectIdLength, "Target worktree");
          if (fetchHead.state === null || !sameIdentity(fetchHead.state.identity, identity)) {
            fail("registry-changed", "Target worktree FETCH_HEAD changed while it was inspected.");
          }
          records.push(
            `f\0${item.name}\0${identity.device}\0${identity.inode}\0${metadata.size}\0${metadata.mtimeNs}\0${metadata.ctimeNs}\0${fetchHead.state.byteLength}\0${fetchHead.state.sha256}\0${fetchHead.state.entryCount}\n`
          );
        } else {
          records.push(
            `f\0${item.name}\0${identity.device}\0${identity.inode}\0${metadata.size}\0${metadata.mtimeNs}\0${metadata.ctimeNs}\n`
          );
        }
        continue;
      }
      if (item.isDirectory() && allowedDirectories.has(item.name)) {
        if (!metadata.isDirectory() || realpathSync(path) !== resolve(path)) {
          fail("archive-not-eligible", "The target Git admin directory contains an unsafe directory.");
        }
        const identity = identityOf(metadata);
        records.push(`d\0${item.name}\0${identity.device}\0${identity.inode}\n`);
        continue;
      }
      fail(
        "archive-not-eligible",
        `Unsupported operation or private metadata exists in the target Git admin directory: ${item.name}.`
      );
    }

    const privateRefsPath = join(adminPath, "refs");
    if (
      entryExistsNoFollow(privateRefsPath, "The target private-ref directory") &&
      readDirectoryBounded(privateRefsPath, 1, "The target private-ref directory").length !== 0
    ) {
      fail("archive-not-eligible", "Private target-worktree refs would not survive cleanup.");
    }

    const logsPath = join(adminPath, "logs");
    const reflogObjectIds = [];
    let reflogEntryCount = 0;
    if (entryExistsNoFollow(logsPath, "The target reflog directory")) {
      const logEntries = readDirectoryBounded(logsPath, 2, "The target reflog directory");
      if (
        logEntries.length !== 1 ||
        logEntries[0].name !== "HEAD" ||
        !logEntries[0].isFile() ||
        logEntries[0].isSymbolicLink()
      ) {
        fail("archive-not-eligible", "The target reflog directory contains unsupported state.");
      }
      const reflog = readBoundedFile(join(logsPath, "HEAD"), MAXIMUM_ARCHIVE_REFLOG_BYTES, "Target HEAD reflog");
      const lines = reflog.text === "" ? [] : reflog.text.split("\n");
      if (lines.at(-1) !== "") fail("archive-not-eligible", "The target HEAD reflog is malformed.");
      lines.pop();
      if (lines.length > MAXIMUM_ARCHIVE_REFLOG_ENTRIES) {
        fail("archive-not-eligible", "The target HEAD reflog contains too many entries.");
      }
      const pattern = new RegExp(`^([0-9a-f]{${objectIdLength}}) ([0-9a-f]{${objectIdLength}}) .+$`, "u");
      const zero = "0".repeat(objectIdLength);
      for (const line of lines) {
        const match = pattern.exec(line);
        if (match === null) fail("archive-not-eligible", "The target HEAD reflog is malformed.");
        if (match[1] !== zero) reflogObjectIds.push(match[1]);
        if (match[2] !== zero) reflogObjectIds.push(match[2]);
      }
      reflogEntryCount = lines.length;
      records.push(
        `l\0logs/HEAD\0${reflog.identity.device}\0${reflog.identity.inode}\0${Buffer.byteLength(reflog.text, "utf8")}\0${sha256(reflog.text)}\n`
      );
    }
    revalidatePathIdentity(adminPath, entry.checkout.gitAdmin.identity, "Target Git admin", "directory");
    return Object.freeze({
      sha256: sha256(records.join("")),
      fetchHead: fetchHeadReceipt(fetchHead),
      fetchHeadObjectIds: fetchHead.objectIds,
      reflogEntryCount,
      reflogObjectIds: Object.freeze([...new Set(reflogObjectIds)].sort())
    });
  }

  function assertCommonArchiveObjectsResolve(objectIds, objectFormat, label) {
    if (objectIds.length === 0) return;
    const expectedLength = objectFormat === "sha1" ? 40 : 64;
    const output = requireCommonArchiveCommand(
      ["--no-pager", "cat-file", "--batch-check=%(objectname) %(objecttype) %(objectsize)"],
      label,
      { input: `${objectIds.join("\n")}\n` }
    ).stdout;
    const lines = output.split("\n");
    if (lines.at(-1) !== "") fail("archive-not-eligible", `${label} returned malformed output.`);
    lines.pop();
    if (
      lines.length !== objectIds.length ||
      lines.some((line, index) => {
        const match = /^([0-9a-f]+) (blob|commit|tag|tree) (0|[1-9][0-9]*)$/u.exec(line);
        return match === null || match[1].length !== expectedLength || match[1] !== objectIds[index];
      })
    ) {
      fail("archive-not-eligible", `${label} contains an object that cannot be resolved.`);
    }
  }

  function resolveArchiveCommitIds(objectIds, objectFormat, label, requireEveryObject) {
    const unique = [...new Set(objectIds)].sort();
    if (unique.length === 0) return Object.freeze([]);
    const resolved = requireCommonArchiveCommand(
      ["--no-pager", "cat-file", "--batch-check=%(objectname) %(objecttype) %(objectsize)"],
      label,
      { input: `${unique.map((oid) => `${oid}^{commit}`).join("\n")}\n` }
    ).stdout.split("\n");
    resolved.pop();
    if (resolved.length !== unique.length) fail("archive-not-eligible", `${label} returned malformed output.`);
    const expectedLength = objectFormat === "sha1" ? 40 : 64;
    const commitIds = [];
    for (const line of resolved) {
      const match = /^([0-9a-f]+) commit (?:0|[1-9][0-9]*)$/u.exec(line);
      if (match === null || match[1].length !== expectedLength) {
        if (requireEveryObject) fail("archive-not-eligible", `${label} contains a missing or non-commit object.`);
        continue;
      }
      commitIds.push(match[1]);
    }
    return Object.freeze([...new Set(commitIds)].sort());
  }

  function assertTargetReflogReachable(reflogObjectIds, bundleHeads, objectFormat) {
    const reflogCommits = resolveArchiveCommitIds(
      reflogObjectIds,
      objectFormat,
      "Target HEAD reflog object inspection",
      true
    );
    if (reflogCommits.length === 0) return;
    const rootCommits = resolveArchiveCommitIds(
      bundleHeads.map(({ oid }) => oid),
      objectFormat,
      "Recovery-root commit inspection",
      false
    );
    if (rootCommits.length === 0) fail("archive-not-eligible", "The recovery archive has no commit root.");
    const unreachable = requireCommonArchiveCommand(
      ["--no-pager", "rev-list", "--max-count=1", "--stdin"],
      "Target HEAD reflog reachability inspection",
      { input: `${reflogCommits.join("\n")}\n${rootCommits.map((oid) => `^${oid}`).join("\n")}\n` }
    ).stdout.trim();
    if (unreachable !== "") {
      fail("archive-not-eligible", "The target HEAD reflog is the only recovery path to one or more commits.");
    }
  }

  function captureRepositoryArchiveState(entry, expectedGit) {
    if (!SHA_PATTERN.test(expectedGit?.head) || !SHA_PATTERN.test(expectedGit?.headTree)) {
      fail("archive-not-eligible", "The retirement plan has no valid Git head to archive.");
    }
    const objectFormat = requireCommonArchiveCommand(
      ["--no-pager", "rev-parse", "--show-object-format"],
      "Git object-format inspection"
    ).stdout.trim();
    if (!["sha1", "sha256"].includes(objectFormat)) {
      fail("archive-not-eligible", "The repository object format is unsupported.");
    }
    const shallow = requireCommonArchiveCommand(
      ["--no-pager", "rev-parse", "--is-shallow-repository"],
      "Git shallow-repository inspection"
    ).stdout.trim();
    if (shallow !== "false") fail("archive-not-eligible", "A shallow repository cannot produce this recovery archive.");
    const configNames = requireCommonArchiveCommand(
      ["--no-pager", "config", "--local", "--null", "--name-only", "--list"],
      "Git archive configuration inspection"
    ).stdout;
    const unsafeConfigKeys = unsafeArchiveConfigKeys(configNames);
    if (unsafeConfigKeys.length !== 0) {
      fail(
        "archive-not-eligible",
        "Partial-clone, promisor, or content-filter configuration cannot be archived safely."
      );
    }
    const config = requireCommonArchiveCommand(
      ["--no-pager", "config", "--local", "--null", "--list"],
      "Git archive configuration capture"
    ).stdout;
    const prohibitedObjectMetadata = [
      [join(repository.commonGitDirectory, "info", "grafts"), "Git grafts"],
      [join(repository.commonGitDirectory, "objects", "info", "alternates"), "Git object alternates"],
      [join(repository.commonGitDirectory, "objects", "info", "http-alternates"), "Git HTTP object alternates"]
    ];
    for (const [path, label] of prohibitedObjectMetadata) {
      if (entryExistsNoFollow(path, label)) {
        fail("archive-not-eligible", `${label} are unsupported by the recovery archive.`);
      }
    }
    const packDirectory = join(repository.commonGitDirectory, "objects", "pack");
    let packStateSha256 = sha256("");
    let promisorMarkerCount = 0;
    if (entryExistsNoFollow(packDirectory, "The Git pack directory")) {
      const packMetadata = lstatSync(packDirectory, { bigint: true });
      if (
        !packMetadata.isDirectory() ||
        packMetadata.isSymbolicLink() ||
        !currentUserOwns(packMetadata) ||
        realpathSync(packDirectory) !== resolve(packDirectory)
      ) {
        fail("archive-not-eligible", "The Git pack directory is unsafe.");
      }
      const packRecords = [];
      const packEntries = readDirectoryBounded(
        packDirectory,
        MAXIMUM_ARCHIVE_PACK_FILES,
        "The Git pack directory"
      ).sort((left, right) => Buffer.compare(Buffer.from(left.name), Buffer.from(right.name)));
      for (const item of packEntries) {
        const path = join(packDirectory, item.name);
        const metadata = lstatSync(path, { bigint: true });
        if (!metadata.isFile() || metadata.isSymbolicLink() || !currentUserOwns(metadata)) {
          fail("archive-not-eligible", "The Git pack directory contains an unsafe entry.");
        }
        if (item.name.toLowerCase().endsWith(".promisor")) promisorMarkerCount += 1;
        const identity = identityOf(metadata);
        packRecords.push(`${item.name}\0${identity.device}\0${identity.inode}\0${metadata.size}\n`);
      }
      packStateSha256 = sha256(packRecords.join(""));
    }
    if (promisorMarkerCount !== 0) {
      fail("archive-not-eligible", "A promisor pack cannot be used for a self-contained recovery archive.");
    }
    const refs = parseRefList(
      requireCommonArchiveCommand(
        ["--no-pager", "for-each-ref", "--sort=refname", "--format=%(objectname) %(refname)", "refs/"],
        "Git reference inspection"
      ).stdout,
      objectFormat,
      "Repository references"
    );
    const branchRef = `refs/heads/${entry.branch}`;
    const branch = refs.find((item) => item.ref === branchRef);
    if (branch?.oid !== expectedGit.head) {
      fail("archive-not-eligible", "The checkout branch no longer points to the head recorded for retirement.");
    }
    const commonHead = requireCommonArchiveCommand(
      ["--no-pager", "rev-parse", "--verify", "HEAD"],
      "Git common HEAD inspection"
    ).stdout.trim();
    const expectedLength = objectFormat === "sha1" ? 40 : 64;
    if (commonHead.length !== expectedLength || !/^[0-9a-f]+$/u.test(commonHead)) {
      fail("archive-not-eligible", "The Git common HEAD is malformed.");
    }
    const symbolic = commonGit(run, paths, repository, ["--no-pager", "symbolic-ref", "--quiet", "HEAD"], {
      allowFailure: true,
      env: auditGitEnvironment()
    });
    if (![0, 1].includes(symbolic.status)) fail("archive-command-failed", "Git common HEAD inspection failed.");
    const commonHeadTarget = symbolic.status === 0 ? symbolic.stdout.trim() : null;
    if (commonHeadTarget !== null && !commonHeadTarget.startsWith("refs/")) {
      fail("archive-not-eligible", "The Git common HEAD target is malformed.");
    }
    const linkedHeads = [];
    const worktreeGitDirectories = [
      { path: repository.commonGitDirectory, label: "main worktree", refPrefix: "", target: false }
    ];
    const worktreeAdminRoot = join(repository.commonGitDirectory, "worktrees");
    if (existsSync(worktreeAdminRoot)) {
      const rootMetadata = lstatSync(worktreeAdminRoot, { bigint: true });
      if (
        !rootMetadata.isDirectory() ||
        rootMetadata.isSymbolicLink() ||
        !currentUserOwns(rootMetadata) ||
        realpathSync(worktreeAdminRoot) !== worktreeAdminRoot
      ) {
        fail("archive-not-eligible", "The Git linked-worktree registry is unsafe.");
      }
      for (const item of readDirectoryBounded(
        worktreeAdminRoot,
        MAXIMUM_WORKTREE_RECORDS,
        "The Git worktree registry"
      )) {
        if (!item.isDirectory() || item.isSymbolicLink() || !/^[A-Za-z0-9._-]{1,240}$/u.test(item.name)) {
          fail("archive-not-eligible", "The Git linked-worktree registry is malformed.");
        }
        const adminPath = join(worktreeAdminRoot, item.name);
        const adminMetadata = lstatSync(adminPath, { bigint: true });
        if (
          !adminMetadata.isDirectory() ||
          adminMetadata.isSymbolicLink() ||
          !currentUserOwns(adminMetadata) ||
          realpathSync(adminPath) !== adminPath
        ) {
          fail("archive-not-eligible", "A Git linked-worktree entry is unsafe.");
        }
        worktreeGitDirectories.push({
          path: adminPath,
          label: `linked worktree ${item.name}`,
          refPrefix: `worktrees/${item.name}/`,
          target: adminPath === entry.checkout.gitAdmin.path
        });
        const ref = `worktrees/${item.name}/HEAD`;
        const oid = requireCommonArchiveCommand(
          ["--no-pager", "rev-parse", "--verify", ref],
          "Git linked-worktree HEAD inspection"
        ).stdout.trim();
        if (oid.length !== expectedLength || !/^[0-9a-f]+$/u.test(oid)) {
          fail("archive-not-eligible", "A Git linked-worktree HEAD is malformed.");
        }
        linkedHeads.push(Object.freeze({ oid, ref }));
      }
    }
    if (worktreeGitDirectories.filter(({ target }) => target).length !== 1) {
      fail("archive-not-eligible", "The target Git admin directory is not registered exactly once.");
    }
    const pseudorefs = [];
    for (const gitDirectory of worktreeGitDirectories) {
      const origHead = captureOrigHead(
        gitDirectory.path,
        `${gitDirectory.refPrefix}ORIG_HEAD`,
        expectedLength,
        gitDirectory.label
      );
      if (origHead !== null) pseudorefs.push(origHead);
      const privateRefsOutput = requireArchiveGitCommand(
        gitDirectory.path,
        [
          "--no-pager",
          "for-each-ref",
          "--sort=refname",
          "--format=%(objectname) %(refname)",
          "refs/worktree/",
          "refs/bisect/",
          "refs/rewritten/"
        ],
        `Private ref inspection for ${gitDirectory.label}`
      ).stdout;
      if (privateRefsOutput !== "") {
        parseRefList(privateRefsOutput, objectFormat, `Private refs for ${gitDirectory.label}`);
        fail("archive-not-eligible", `Private refs exist for ${gitDirectory.label} and would not survive cleanup.`);
      }
    }
    linkedHeads.sort((left, right) => Buffer.compare(Buffer.from(left.ref), Buffer.from(right.ref)));
    pseudorefs.sort((left, right) => Buffer.compare(Buffer.from(left.ref), Buffer.from(right.ref)));
    const targetAdminState = captureTargetAdminState(entry, expectedLength);
    assertCommonArchiveObjectsResolve(
      targetAdminState.fetchHeadObjectIds,
      objectFormat,
      "Target FETCH_HEAD object inspection"
    );
    const bundleHeads = Object.freeze(
      [
        ...refs,
        Object.freeze({ oid: commonHead, ref: "HEAD" }),
        ...linkedHeads,
        ...pseudorefs.map(({ oid, ref }) => Object.freeze({ oid, ref }))
      ].sort((left, right) => Buffer.compare(Buffer.from(left.ref), Buffer.from(right.ref)))
    );
    if (new Set(bundleHeads.map(({ ref }) => ref)).size !== bundleHeads.length) {
      fail("archive-not-eligible", "Recovery roots contain duplicate names.");
    }
    if (
      new Set([...bundleHeads.map(({ oid }) => oid), ...targetAdminState.fetchHeadObjectIds]).size >
      MAXIMUM_ARCHIVE_REFS
    ) {
      fail("archive-not-eligible", "The recovery archive would need too many retained objects.");
    }
    assertTargetReflogReachable(targetAdminState.reflogObjectIds, bundleHeads, objectFormat);
    const objectDiskBytes = decimalBigInt(
      requireCommonArchiveCommand(
        ["--no-pager", "rev-list", "--disk-usage", "--objects", "--all", ...pseudorefs.map(({ ref }) => ref)],
        "Reachable Git object-size inspection"
      ).stdout,
      "Reachable Git object size"
    );
    return Object.freeze({
      objectFormat,
      shallow: false,
      branchRef,
      refs,
      refsReceipt: refsReceipt(refs),
      commonHead: Object.freeze({ oid: commonHead, symbolicTarget: commonHeadTarget }),
      linkedHeads: Object.freeze(linkedHeads),
      pseudorefs: Object.freeze(pseudorefs),
      pseudorefsReceipt: refsReceipt(pseudorefs),
      fetchHead: targetAdminState.fetchHead,
      fetchHeadObjectIds: targetAdminState.fetchHeadObjectIds,
      bundleHeads,
      bundleHeadsReceipt: refsReceipt(bundleHeads),
      safety: Object.freeze({
        configSha256: sha256(config),
        configNamesSha256: sha256(configNames),
        unsafeConfigKeyCount: unsafeConfigKeys.length,
        graftsPresent: false,
        alternatesPresent: false,
        httpAlternatesPresent: false,
        promisorMarkerCount,
        packStateSha256,
        privateRefCount: 0,
        targetAdminStateSha256: targetAdminState.sha256,
        targetReflogEntryCount: targetAdminState.reflogEntryCount,
        unreachableTargetReflogCommitCount: 0
      }),
      objectDiskBytes
    });
  }

  function archiveAttempts(slug, generation) {
    const entries = readDirectoryBounded(paths.archives, MAXIMUM_ARCHIVE_DIRECTORIES, "The archive journal");
    const attempts = [];
    for (const item of entries) {
      const match = ARCHIVE_ATTEMPT_PATTERN.exec(item.name);
      if (!item.isDirectory() || item.isSymbolicLink() || match === null) {
        fail("invalid-archive", "The archive journal contains an unknown entry.");
      }
      if (match[1] === slug && Number(match[2]) === generation) {
        const attempt = Number(match[3]);
        if (attempt < 1 || attempt > MAXIMUM_ARCHIVE_ATTEMPTS) {
          fail("invalid-archive", "The archive journal contains an invalid attempt.");
        }
        attempts.push(attempt);
      }
    }
    if (new Set(attempts).size !== attempts.length) fail("invalid-archive", "The archive journal is ambiguous.");
    return attempts.sort((left, right) => left - right);
  }

  function retirementPlanFileReceipt(plan) {
    return Object.freeze({
      path: plan.path,
      identity: plan.identity,
      byteLength: plan.byteLength,
      sha256: plan.sha256
    });
  }

  function archiveReceiptBindsPlan(receipt, plan) {
    return isDeepStrictEqual(receipt?.source?.retirementPlan, retirementPlanFileReceipt(plan));
  }

  function createArchiveAttempt(slug, generation, plan) {
    const prior = archiveAttempts(slug, generation);
    for (const priorAttempt of prior) {
      const priorPath = archiveAttemptPath(slug, generation, priorAttempt);
      if (!existsSync(join(priorPath, "complete.json"))) continue;
      const receipt = readJsonReceipt(join(priorPath, "receipt.json"), MAXIMUM_ENTRY_BYTES, "Archive receipt");
      if (archiveReceiptBindsPlan(receipt.value, plan)) {
        fail("archive-evidence-exists", "A completed recovery archive already exists for this retirement plan.");
      }
    }
    const attempt = (prior.at(-1) ?? 0) + 1;
    if (attempt > MAXIMUM_ARCHIVE_ATTEMPTS) fail("archive-attempts-exhausted", "Too many archive attempts exist.");
    const path = archiveAttemptPath(slug, generation, attempt);
    const archiveRootIdentity = managedIdentities.get(paths.archives);
    if (archiveRootIdentity === undefined) fail("unsafe-manager", "The archive journal was not initialized.");
    revalidatePathIdentity(paths.archives, archiveRootIdentity, paths.archives, "directory");
    try {
      mkdirSync(path, { mode: 0o700 });
      chmodSync(path, 0o700);
    } catch (error) {
      if (error.code === "EEXIST") fail("archive-changed", "The next archive attempt appeared concurrently.");
      throw error;
    }
    fsyncDirectory(paths.archives);
    const identity = assertPrivateDirectory(path, "Archive attempt directory");
    revalidatePathIdentity(paths.archives, archiveRootIdentity, paths.archives, "directory");
    return Object.freeze({ attempt, path, identity });
  }

  function createBundle(attempt, pseudorefs) {
    const path = join(attempt.path, "archive.bundle");
    revalidatePathIdentity(attempt.path, attempt.identity, "Archive attempt directory", "directory");
    let descriptor;
    try {
      descriptor = openSync(
        path,
        constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | (constants.O_NOFOLLOW ?? 0),
        0o600
      );
      if (typeof process.getuid === "function") fchmodSync(descriptor, 0o600);
      const empty = fstatSync(descriptor, { bigint: true });
      if (
        !empty.isFile() ||
        empty.isSymbolicLink() ||
        empty.nlink !== 1n ||
        empty.size !== 0n ||
        !currentUserOwns(empty) ||
        (typeof process.getuid === "function" && (empty.mode & 0o777n) !== 0o600n)
      ) {
        fail("unsafe-archive", "The new bundle file is unsafe.");
      }
      const result = commonGit(
        run,
        paths,
        repository,
        [
          "--no-pager",
          "-c",
          "core.fsmonitor=false",
          "-c",
          `core.hooksPath=${process.platform === "win32" ? "NUL" : "/dev/null"}`,
          "-c",
          "submodule.recurse=false",
          "-c",
          "pack.threads=1",
          "-c",
          "pack.window=4",
          "-c",
          "pack.depth=10",
          "-c",
          "pack.windowMemory=32m",
          "-c",
          "pack.deltaCacheSize=16m",
          "-c",
          "core.bigFileThreshold=16m",
          "bundle",
          "create",
          "-q",
          "-",
          "--all",
          ...pseudorefs.map(({ ref }) => ref)
        ],
        {
          allowFailure: true,
          env: auditGitEnvironment(),
          stdoutFd: descriptor
        }
      );
      fsyncSync(descriptor);
      if (result.status !== 0) fail("archive-command-failed", "Git bundle creation failed.");
      const receipt = hashDescriptor(descriptor, "Recovery bundle", 0o600n);
      revalidatePathIdentity(path, receipt.identity, "Recovery bundle");
      revalidatePathIdentity(attempt.path, attempt.identity, "Archive attempt directory", "directory");
      return Object.freeze({ path, ...receipt });
    } catch (error) {
      if (error instanceof CheckoutLifecycleError) throw error;
      fail("archive-command-failed", `The recovery bundle could not be created safely: ${error.message}`);
    } finally {
      if (descriptor !== undefined) closeSync(descriptor);
      fsyncDirectory(attempt.path);
    }
  }

  function createPrivateAttemptDirectory(attempt, name, label) {
    const path = join(attempt.path, name);
    revalidatePathIdentity(attempt.path, attempt.identity, "Archive attempt directory", "directory");
    try {
      mkdirSync(path, { mode: 0o700 });
      chmodSync(path, 0o700);
    } catch (error) {
      if (error.code === "EEXIST") fail("archive-changed", `${label} appeared concurrently.`);
      throw error;
    }
    fsyncDirectory(attempt.path);
    const identity = assertPrivateDirectory(path, label);
    revalidatePathIdentity(attempt.path, attempt.identity, "Archive attempt directory", "directory");
    return Object.freeze({ path, identity });
  }

  function proveBundleRecovery(attempt, bundle, expectedHeads, objectFormat, requiredObjectIds = []) {
    const template = createPrivateAttemptDirectory(attempt, "verification-template", "Verification template");
    const verification = createPrivateAttemptDirectory(attempt, "verification.git", "Verification repository");
    requireStandaloneArchiveGitCommand(
      [
        "init",
        "--bare",
        "--quiet",
        `--object-format=${objectFormat}`,
        `--template=${template.path}`,
        verification.path
      ],
      attempt.path,
      "Verification repository initialization"
    );
    revalidatePathIdentity(template.path, template.identity, "Verification template", "directory");
    if (readDirectoryBounded(template.path, 1, "The verification template").length !== 0) {
      fail("archive-changed", "The empty verification template changed during initialization.");
    }
    revalidatePathIdentity(verification.path, verification.identity, "Verification repository", "directory");
    const isBare = requireArchiveGitCommand(
      verification.path,
      ["--no-pager", "rev-parse", "--is-bare-repository"],
      "Verification repository bare-state inspection"
    ).stdout.trim();
    const verifiedObjectFormat = requireArchiveGitCommand(
      verification.path,
      ["--no-pager", "rev-parse", "--show-object-format"],
      "Verification repository object-format inspection"
    ).stdout.trim();
    if (isBare !== "true" || verifiedObjectFormat !== objectFormat) {
      fail("invalid-archive", "The verification repository has the wrong format.");
    }
    const unbundle = requireArchiveGitCommand(
      verification.path,
      ["--no-pager", "bundle", "unbundle", bundle.path],
      "Recovery bundle unbundle"
    );
    const unbundledHeads = parseRefList(unbundle.stdout, objectFormat, "Recovery bundle unbundle", {
      allowHead: true,
      allowWorktreeHeads: true,
      allowArchivePseudorefs: true
    });
    if (!isDeepStrictEqual(unbundledHeads, expectedHeads)) {
      fail("archive-ref-mismatch", "The recovery repository did not receive every advertised bundle head.");
    }
    const advertisedObjectIds = [...new Set(expectedHeads.map((head) => head.oid))].sort((left, right) =>
      Buffer.compare(Buffer.from(left), Buffer.from(right))
    );
    const uniqueObjectIds = [...new Set([...advertisedObjectIds, ...requiredObjectIds])].sort((left, right) =>
      Buffer.compare(Buffer.from(left), Buffer.from(right))
    );
    const resolved = requireArchiveGitCommand(
      verification.path,
      ["--no-pager", "cat-file", "--batch-check=%(objectname) %(objecttype) %(objectsize)"],
      "Recovery head resolution",
      { input: `${uniqueObjectIds.join("\n")}\n` }
    ).stdout;
    const resolvedLines = resolved.split("\n").filter(Boolean);
    const expectedObjectIdLength = objectFormat === "sha1" ? 40 : 64;
    const requiredObjectIdSet = new Set(requiredObjectIds);
    let unresolvedRequiredObject = false;
    let unresolvedAdvertisedObject = resolvedLines.length > uniqueObjectIds.length;
    for (const [index, objectId] of uniqueObjectIds.entries()) {
      const match = /^([0-9a-f]+) (blob|commit|tag|tree) (0|[1-9][0-9]*)$/u.exec(resolvedLines[index] ?? "");
      const invalid = match === null || match[1].length !== expectedObjectIdLength || match[1] !== objectId;
      if (invalid && requiredObjectIdSet.has(objectId)) unresolvedRequiredObject = true;
      if (invalid && !requiredObjectIdSet.has(objectId)) unresolvedAdvertisedObject = true;
    }
    if (unresolvedRequiredObject || unresolvedAdvertisedObject) {
      if (unresolvedRequiredObject) {
        fail("archive-not-eligible", "A target FETCH_HEAD object is not reachable from the recovery archive roots.");
      }
      fail("invalid-archive", "An advertised recovery head cannot be resolved in the verification repository.");
    }
    const rootRefs = Object.freeze(
      uniqueObjectIds.map((oid, index) =>
        Object.freeze({ oid, ref: `refs/openwrangler-recovery/${String(index).padStart(8, "0")}` })
      )
    );
    requireArchiveGitCommand(verification.path, ["--no-pager", "update-ref", "--stdin"], "Recovery root publication", {
      input: `${rootRefs.map(({ oid, ref }) => `create ${ref} ${oid}`).join("\n")}\n`
    });
    const publishedRoots = parseRefList(
      requireArchiveGitCommand(
        verification.path,
        [
          "--no-pager",
          "for-each-ref",
          "--sort=refname",
          "--format=%(objectname) %(refname)",
          "refs/openwrangler-recovery/"
        ],
        "Recovery root verification"
      ).stdout,
      objectFormat,
      "Recovery roots"
    );
    if (!isDeepStrictEqual(publishedRoots, rootRefs)) {
      fail("invalid-archive", "The verification repository did not retain every recovery root.");
    }
    requireArchiveGitCommand(
      verification.path,
      ["--no-pager", "pack-refs", "--all", "--prune"],
      "Recovery root packing"
    );
    const packedRoots = parseRefList(
      requireArchiveGitCommand(
        verification.path,
        [
          "--no-pager",
          "for-each-ref",
          "--sort=refname",
          "--format=%(objectname) %(refname)",
          "refs/openwrangler-recovery/"
        ],
        "Packed recovery root verification"
      ).stdout,
      objectFormat,
      "Packed recovery roots"
    );
    if (!isDeepStrictEqual(packedRoots, rootRefs)) {
      fail("invalid-archive", "Packing changed the retained recovery roots.");
    }
    const fsck = requireArchiveGitCommand(
      verification.path,
      [
        "--no-pager",
        "fsck",
        "--full",
        "--strict",
        "--no-reflogs",
        "--no-progress",
        "--no-dangling",
        "--no-name-objects"
      ],
      "Recovery repository integrity check"
    );
    const repositoryReceipt = captureVerificationRepository(verification.path, verification.identity);
    revalidatePathIdentity(template.path, template.identity, "Verification template", "directory");
    if (readDirectoryBounded(template.path, 1, "The verification template").length !== 0) {
      fail("archive-changed", "The verification template is no longer empty.");
    }
    return Object.freeze({
      template,
      repository: repositoryReceipt,
      objectFormat,
      advertisedHeads: refsReceipt(unbundledHeads),
      resolvedObjects: Object.freeze({ count: uniqueObjectIds.length, sha256: sha256(resolved) }),
      requiredObjects: objectIdsReceipt(requiredObjectIds),
      rootRefs: refsReceipt(rootRefs),
      unbundle: Object.freeze({ stdoutSha256: sha256(unbundle.stdout), stderrSha256: sha256(unbundle.stderr) }),
      fsck: Object.freeze({ stdoutSha256: sha256(fsck.stdout), stderrSha256: sha256(fsck.stderr) })
    });
  }

  function validateArchiveFileReceipt(value, expectedPath, label) {
    exactKeys(value, ["path", "identity", "byteLength", "sha256"], label);
    validateIdentity(value.identity, `${label} identity`);
    if (
      value.path !== expectedPath ||
      !Number.isSafeInteger(value.byteLength) ||
      value.byteLength < 1 ||
      !/^[0-9a-f]{64}$/u.test(value.sha256)
    ) {
      fail("invalid-archive", `${label} is malformed.`);
    }
  }

  function validateObjectIdsReceipt(value, label) {
    exactKeys(value, ["count", "sha256"], label);
    if (
      !Number.isSafeInteger(value.count) ||
      value.count < 0 ||
      value.count > MAXIMUM_ARCHIVE_FETCH_HEAD_ENTRIES ||
      !/^[0-9a-f]{64}$/u.test(value.sha256)
    ) {
      fail("invalid-archive", `${label} is malformed.`);
    }
  }

  function validateFetchHeadReceipt(value, label) {
    exactKeys(value, ["present", "byteLength", "sha256", "entryCount", "objectIds"], label);
    validateObjectIdsReceipt(value.objectIds, `${label} object IDs`);
    if (
      typeof value.present !== "boolean" ||
      !Number.isSafeInteger(value.byteLength) ||
      value.byteLength < 0 ||
      value.byteLength > MAXIMUM_ARCHIVE_FETCH_HEAD_BYTES ||
      !/^[0-9a-f]{64}$/u.test(value.sha256) ||
      !Number.isSafeInteger(value.entryCount) ||
      value.entryCount < 0 ||
      value.entryCount > MAXIMUM_ARCHIVE_FETCH_HEAD_ENTRIES ||
      (!value.present &&
        (value.byteLength !== 0 ||
          value.sha256 !== sha256("") ||
          value.entryCount !== 0 ||
          value.objectIds.count !== 0 ||
          value.objectIds.sha256 !== sha256(""))) ||
      (value.present &&
        ((value.byteLength === 0) !== (value.entryCount === 0) ||
          (value.entryCount === 0) !== (value.objectIds.count === 0) ||
          (value.byteLength === 0 && value.sha256 !== sha256("")) ||
          value.entryCount < value.objectIds.count ||
          (value.objectIds.count === 0 && value.objectIds.sha256 !== sha256(""))))
    ) {
      fail("invalid-archive", `${label} is malformed.`);
    }
  }

  function absentFetchHeadReceipt() {
    return Object.freeze({
      present: false,
      byteLength: 0,
      sha256: sha256(""),
      entryCount: 0,
      objectIds: Object.freeze({ count: 0, sha256: sha256("") })
    });
  }

  function archiveFetchHeadReceipt(archiveReceipt) {
    return archiveReceipt.protocol === ARCHIVE_RECEIPT_PROTOCOL
      ? archiveReceipt.git.safety.targetFetchHead
      : absentFetchHeadReceipt();
  }

  function validateArchiveReceipt(value, entry, attempt, plan) {
    exactKeys(
      value,
      [
        "protocol",
        "slug",
        "generation",
        "attempt",
        "source",
        "archive",
        "storage",
        "git",
        "verification",
        "deferredChecks",
        "authorizesCleanup"
      ],
      "Archive receipt"
    );
    if (
      ![ARCHIVE_RECEIPT_PROTOCOL_V1, ARCHIVE_RECEIPT_PROTOCOL].includes(value.protocol) ||
      value.slug !== entry.slug ||
      value.generation !== entry.generation ||
      value.attempt !== attempt.attempt ||
      value.authorizesCleanup !== false
    ) {
      fail("invalid-archive", "The archive receipt is malformed.");
    }
    exactKeys(value.source, ["entry", "retirementPlan"], "Archive source receipt");
    if (!isDeepStrictEqual(value.source.entry, plan.value.source)) {
      fail("invalid-archive", "The archive source entry does not match its retirement plan.");
    }
    validateArchiveFileReceipt(value.source.retirementPlan, plan.path, "Retirement plan file receipt");
    if (
      !sameIdentity(value.source.retirementPlan.identity, plan.identity) ||
      value.source.retirementPlan.byteLength !== plan.byteLength ||
      value.source.retirementPlan.sha256 !== plan.sha256
    ) {
      fail("invalid-archive", "The retirement plan file receipt changed.");
    }
    exactKeys(value.archive, ["directory", "bundle", "verification"], "Archive artifact receipt");
    exactKeys(value.archive.directory, ["path", "identity"], "Archive directory receipt");
    validateIdentity(value.archive.directory.identity, "Archive directory identity");
    if (
      value.archive.directory.path !== attempt.path ||
      !sameIdentity(value.archive.directory.identity, attempt.identity)
    ) {
      fail("invalid-archive", "The archive directory receipt changed.");
    }
    validateArchiveFileReceipt(value.archive.bundle, join(attempt.path, "archive.bundle"), "Bundle file receipt");
    exactKeys(value.archive.verification, ["template", "repository"], "Archive recovery repository receipt");
    exactKeys(value.archive.verification.template, ["path", "identity"], "Archive verification template receipt");
    validateIdentity(value.archive.verification.template.identity, "Archive verification template identity");
    exactKeys(
      value.archive.verification.repository,
      ["path", "identity", "directoryCount", "fileCount", "byteLength", "sha256"],
      "Archive verification repository receipt"
    );
    validateIdentity(value.archive.verification.repository.identity, "Archive verification repository identity");
    if (
      value.archive.verification.template.path !== join(attempt.path, "verification-template") ||
      value.archive.verification.repository.path !== join(attempt.path, "verification.git") ||
      !Number.isSafeInteger(value.archive.verification.repository.directoryCount) ||
      value.archive.verification.repository.directoryCount < 1 ||
      !Number.isSafeInteger(value.archive.verification.repository.fileCount) ||
      value.archive.verification.repository.fileCount < 1 ||
      typeof value.archive.verification.repository.byteLength !== "string" ||
      !/^(?:0|[1-9][0-9]{0,39})$/u.test(value.archive.verification.repository.byteLength) ||
      !/^[0-9a-f]{64}$/u.test(value.archive.verification.repository.sha256)
    ) {
      fail("invalid-archive", "The verification repository receipt is malformed.");
    }
    exactKeys(
      value.storage,
      ["objectDiskBytes", "multiplier", "reserveBytes", "requiredBytes", "availableBytes"],
      "Archive storage receipt"
    );
    const storageFields = [
      value.storage.objectDiskBytes,
      value.storage.reserveBytes,
      value.storage.requiredBytes,
      value.storage.availableBytes
    ];
    if (
      storageFields.some((field) => typeof field !== "string" || !/^(?:0|[1-9][0-9]{0,39})$/u.test(field)) ||
      value.storage.multiplier !== Number(ARCHIVE_SPACE_MULTIPLIER) ||
      BigInt(value.storage.requiredBytes) !==
        BigInt(value.storage.objectDiskBytes) * ARCHIVE_SPACE_MULTIPLIER + BigInt(value.storage.reserveBytes) ||
      BigInt(value.storage.reserveBytes) !== ARCHIVE_SPACE_RESERVE_BYTES ||
      BigInt(value.storage.availableBytes) < BigInt(value.storage.requiredBytes)
    ) {
      fail("invalid-archive", "The archive storage receipt is malformed.");
    }
    exactKeys(
      value.git,
      [
        "repository",
        "objectFormat",
        "shallow",
        "branchRef",
        "head",
        "headTree",
        "commonHead",
        "refs",
        "linkedHeads",
        "pseudorefs",
        "bundleHeads",
        "safety"
      ],
      "Archive Git receipt"
    );
    exactKeys(value.git.repository, ["path", "identity"], "Archive repository receipt");
    validateIdentity(value.git.repository.identity, "Archive repository identity");
    exactKeys(value.git.commonHead, ["oid", "symbolicTarget"], "Archive common HEAD receipt");
    exactKeys(value.git.refs, ["count", "sha256"], "Archive reference receipt");
    exactKeys(value.git.linkedHeads, ["count", "sha256"], "Archive linked-worktree-head receipt");
    exactKeys(value.git.pseudorefs, ["count", "sha256"], "Archive pseudoref receipt");
    exactKeys(value.git.bundleHeads, ["count", "sha256"], "Archive bundle-head receipt");
    exactKeys(
      value.git.safety,
      [
        "configSha256",
        "configNamesSha256",
        "unsafeConfigKeyCount",
        "graftsPresent",
        "alternatesPresent",
        "httpAlternatesPresent",
        "promisorMarkerCount",
        "packStateSha256",
        "privateRefCount",
        "targetAdminStateSha256",
        ...(value.protocol === ARCHIVE_RECEIPT_PROTOCOL ? ["targetFetchHead"] : []),
        "targetReflogEntryCount",
        "unreachableTargetReflogCommitCount"
      ],
      "Archive repository safety receipt"
    );
    if (value.protocol === ARCHIVE_RECEIPT_PROTOCOL) {
      validateFetchHeadReceipt(value.git.safety.targetFetchHead, "Archive target FETCH_HEAD receipt");
    }
    const objectIdLength = value.git.objectFormat === "sha256" ? 64 : 40;
    if (
      value.git.repository.path !== repository.commonGitDirectory ||
      !sameIdentity(value.git.repository.identity, repository.identity) ||
      !["sha1", "sha256"].includes(value.git.objectFormat) ||
      value.git.shallow !== false ||
      value.git.branchRef !== `refs/heads/${entry.branch}` ||
      value.git.head !== plan.value.git.head ||
      value.git.headTree !== plan.value.git.headTree ||
      typeof value.git.commonHead.oid !== "string" ||
      value.git.commonHead.oid.length !== objectIdLength ||
      !/^[0-9a-f]+$/u.test(value.git.commonHead.oid) ||
      !(
        value.git.commonHead.symbolicTarget === null ||
        (typeof value.git.commonHead.symbolicTarget === "string" &&
          value.git.commonHead.symbolicTarget.startsWith("refs/"))
      ) ||
      !Number.isSafeInteger(value.git.refs.count) ||
      value.git.refs.count < 1 ||
      !/^[0-9a-f]{64}$/u.test(value.git.refs.sha256) ||
      !Number.isSafeInteger(value.git.linkedHeads.count) ||
      value.git.linkedHeads.count < 0 ||
      !/^[0-9a-f]{64}$/u.test(value.git.linkedHeads.sha256) ||
      !Number.isSafeInteger(value.git.pseudorefs.count) ||
      value.git.pseudorefs.count < 0 ||
      !/^[0-9a-f]{64}$/u.test(value.git.pseudorefs.sha256) ||
      !Number.isSafeInteger(value.git.bundleHeads.count) ||
      value.git.bundleHeads.count !==
        value.git.refs.count + value.git.linkedHeads.count + value.git.pseudorefs.count + 1 ||
      !/^[0-9a-f]{64}$/u.test(value.git.bundleHeads.sha256) ||
      !/^[0-9a-f]{64}$/u.test(value.git.safety.configSha256) ||
      !/^[0-9a-f]{64}$/u.test(value.git.safety.configNamesSha256) ||
      value.git.safety.unsafeConfigKeyCount !== 0 ||
      value.git.safety.graftsPresent !== false ||
      value.git.safety.alternatesPresent !== false ||
      value.git.safety.httpAlternatesPresent !== false ||
      value.git.safety.promisorMarkerCount !== 0 ||
      !/^[0-9a-f]{64}$/u.test(value.git.safety.packStateSha256) ||
      value.git.safety.privateRefCount !== 0 ||
      !/^[0-9a-f]{64}$/u.test(value.git.safety.targetAdminStateSha256) ||
      !Number.isSafeInteger(value.git.safety.targetReflogEntryCount) ||
      value.git.safety.targetReflogEntryCount < 0 ||
      value.git.safety.targetReflogEntryCount > MAXIMUM_ARCHIVE_REFLOG_ENTRIES ||
      value.git.safety.unreachableTargetReflogCommitCount !== 0
    ) {
      fail("invalid-archive", "The archive Git receipt is malformed.");
    }
    exactKeys(
      value.verification,
      ["header", "bundleVerify", "listHeads", "recovery", "eligibilitySha256"],
      "Archive verification receipt"
    );
    exactKeys(
      value.verification.header,
      ["version", "objectFormat", "capabilities", "prerequisiteCount", "heads"],
      "Bundle header receipt"
    );
    exactKeys(value.verification.header.heads, ["count", "sha256"], "Bundle header heads receipt");
    exactKeys(value.verification.bundleVerify, ["stdoutSha256", "stderrSha256"], "Bundle verification command receipt");
    exactKeys(value.verification.listHeads, ["count", "sha256"], "Bundle list-heads receipt");
    exactKeys(
      value.verification.recovery,
      [
        "objectFormat",
        "advertisedHeads",
        "resolvedObjects",
        ...(value.protocol === ARCHIVE_RECEIPT_PROTOCOL ? ["requiredObjects"] : []),
        "rootRefs",
        "unbundle",
        "fsck"
      ],
      "Bundle recovery proof"
    );
    exactKeys(value.verification.recovery.advertisedHeads, ["count", "sha256"], "Recovered bundle heads");
    exactKeys(value.verification.recovery.resolvedObjects, ["count", "sha256"], "Resolved recovery objects");
    if (value.protocol === ARCHIVE_RECEIPT_PROTOCOL) {
      validateObjectIdsReceipt(value.verification.recovery.requiredObjects, "Required recovery objects");
    }
    exactKeys(value.verification.recovery.rootRefs, ["count", "sha256"], "Published recovery roots");
    exactKeys(value.verification.recovery.unbundle, ["stdoutSha256", "stderrSha256"], "Unbundle proof");
    exactKeys(value.verification.recovery.fsck, ["stdoutSha256", "stderrSha256"], "Recovery fsck proof");
    const expectedCapabilities =
      value.verification.header.version === 2 ? [] : [`object-format=${value.git.objectFormat}`];
    if (
      ![2, 3].includes(value.verification.header.version) ||
      value.verification.header.objectFormat !== value.git.objectFormat ||
      !isDeepStrictEqual(value.verification.header.capabilities, expectedCapabilities) ||
      value.verification.header.prerequisiteCount !== 0 ||
      !isDeepStrictEqual(value.verification.header.heads, value.git.bundleHeads) ||
      !isDeepStrictEqual(value.verification.listHeads, value.git.bundleHeads) ||
      value.verification.recovery.objectFormat !== value.git.objectFormat ||
      !isDeepStrictEqual(value.verification.recovery.advertisedHeads, value.git.bundleHeads) ||
      (value.protocol === ARCHIVE_RECEIPT_PROTOCOL &&
        !isDeepStrictEqual(value.verification.recovery.requiredObjects, value.git.safety.targetFetchHead.objectIds)) ||
      !Number.isSafeInteger(value.verification.recovery.resolvedObjects.count) ||
      value.verification.recovery.resolvedObjects.count < 1 ||
      (value.protocol === ARCHIVE_RECEIPT_PROTOCOL_V1
        ? value.verification.recovery.resolvedObjects.count > value.git.bundleHeads.count
        : value.verification.recovery.resolvedObjects.count > MAXIMUM_ARCHIVE_REFS ||
          value.verification.recovery.requiredObjects.count > value.verification.recovery.resolvedObjects.count) ||
      !/^[0-9a-f]{64}$/u.test(value.verification.recovery.resolvedObjects.sha256) ||
      !Number.isSafeInteger(value.verification.recovery.rootRefs.count) ||
      value.verification.recovery.rootRefs.count !== value.verification.recovery.resolvedObjects.count ||
      !/^[0-9a-f]{64}$/u.test(value.verification.recovery.rootRefs.sha256) ||
      !/^[0-9a-f]{64}$/u.test(value.verification.recovery.unbundle.stdoutSha256) ||
      !/^[0-9a-f]{64}$/u.test(value.verification.recovery.unbundle.stderrSha256) ||
      !/^[0-9a-f]{64}$/u.test(value.verification.recovery.fsck.stdoutSha256) ||
      !/^[0-9a-f]{64}$/u.test(value.verification.recovery.fsck.stderrSha256) ||
      !/^[0-9a-f]{64}$/u.test(value.verification.bundleVerify.stdoutSha256) ||
      !/^[0-9a-f]{64}$/u.test(value.verification.bundleVerify.stderrSha256) ||
      !/^[0-9a-f]{64}$/u.test(value.verification.eligibilitySha256)
    ) {
      fail("invalid-archive", "The archive verification receipt is malformed.");
    }
    exactKeys(value.deferredChecks, ["recovery", "processUse", "mounts"], "Archive deferred checks");
    if (
      value.deferredChecks.recovery !== "bundle-unbundled-and-fsck-verified" ||
      value.deferredChecks.processUse !== "not-checked-recheck-required" ||
      value.deferredChecks.mounts !== "not-checked-recheck-required"
    ) {
      fail("invalid-archive", "The archive deferred checks are malformed.");
    }
  }

  function validateCompletion(value, entry, attempt, bundle, receipt, verification) {
    exactKeys(
      value,
      [
        "protocol",
        "slug",
        "generation",
        "attempt",
        "directory",
        "bundle",
        "receipt",
        "verification",
        "authorizesCleanup"
      ],
      "Archive completion"
    );
    if (
      value.protocol !== ARCHIVE_COMPLETION_PROTOCOL ||
      value.slug !== entry.slug ||
      value.generation !== entry.generation ||
      value.attempt !== attempt.attempt ||
      value.authorizesCleanup !== false
    ) {
      fail("invalid-archive", "The archive completion marker is malformed.");
    }
    exactKeys(value.directory, ["path", "identity"], "Completed archive directory");
    validateIdentity(value.directory.identity, "Completed archive directory identity");
    if (value.directory.path !== attempt.path || !sameIdentity(value.directory.identity, attempt.identity)) {
      fail("invalid-archive", "The completed archive directory changed.");
    }
    validateArchiveFileReceipt(value.bundle, bundle.path, "Completed bundle receipt");
    validateArchiveFileReceipt(value.receipt, receipt.path, "Completed receipt file");
    exactKeys(value.verification, ["template", "repository"], "Completed verification repository receipt");
    if (
      !isDeepStrictEqual(value.bundle, bundle) ||
      !isDeepStrictEqual(value.receipt, receipt) ||
      !isDeepStrictEqual(value.verification, verification)
    ) {
      fail("invalid-archive", "The completed archive files changed.");
    }
  }

  function assertArchiveAttemptContents(attempt, expectedFiles, expectedDirectories = []) {
    revalidatePathIdentity(attempt.path, attempt.identity, "Archive attempt directory", "directory");
    const entries = readDirectoryBounded(attempt.path, 8, "The archive attempt");
    const actualFiles = entries
      .filter((item) => item.isFile() && !item.isSymbolicLink())
      .map((item) => item.name)
      .sort();
    const actualDirectories = entries
      .filter((item) => item.isDirectory() && !item.isSymbolicLink())
      .map((item) => item.name)
      .sort();
    if (
      entries.some((item) => item.isSymbolicLink() || (!item.isFile() && !item.isDirectory())) ||
      !isDeepStrictEqual(actualFiles, [...expectedFiles].sort()) ||
      !isDeepStrictEqual(actualDirectories, [...expectedDirectories].sort())
    ) {
      fail("archive-changed", "The archive attempt contains unexpected files.");
    }
  }

  function optionalPrivateDirectory(path, label) {
    try {
      lstatSync(path, { bigint: true });
    } catch (error) {
      if (error.code === "ENOENT") return null;
      fail("unsafe-manager", `${label} could not be inspected safely: ${error.message}`);
    }
    return assertPrivateDirectory(path, label);
  }

  function readCompletedArchiveBinding(entry, attempt, plans) {
    assertArchiveAttemptContents(
      attempt,
      ["archive.bundle", "receipt.json", "complete.json"],
      ["verification-template", "verification.git"]
    );
    const receiptPath = join(attempt.path, "receipt.json");
    const receipt = readJsonReceipt(receiptPath, MAXIMUM_ENTRY_BYTES, "Archive receipt");
    const matchingPlans = plans.filter((plan) => archiveReceiptBindsPlan(receipt.value, plan));
    if (matchingPlans.length !== 1) {
      fail("invalid-archive", "A completed recovery archive is not bound to one exact retained retirement plan.");
    }
    const plan = matchingPlans[0];
    validateArchiveReceipt(receipt.value, entry, attempt, plan);
    const receiptFile = Object.freeze({
      path: receiptPath,
      identity: receipt.identity,
      byteLength: receipt.byteLength,
      sha256: receipt.sha256
    });
    const completionPath = join(attempt.path, "complete.json");
    const completion = readJsonReceipt(completionPath, MAXIMUM_ENTRY_BYTES, "Archive completion");
    validateCompletion(
      completion.value,
      entry,
      attempt,
      receipt.value.archive.bundle,
      receiptFile,
      receipt.value.archive.verification
    );
    return Object.freeze({ plan, receiptPath, receipt, receiptFile, completionPath, completion });
  }

  function readCompletedArchiveAnchor(entry) {
    const rootIdentity = optionalPrivateDirectory(paths.archives, "The archive journal");
    if (rootIdentity === null) fail("retirement-archive-missing", "This checkout has no completed recovery archive.");
    const matches = [];
    for (const item of readDirectoryBounded(paths.archives, MAXIMUM_ARCHIVE_DIRECTORIES, "The archive journal")) {
      const match = ARCHIVE_ATTEMPT_PATTERN.exec(item.name);
      if (!item.isDirectory() || item.isSymbolicLink() || match === null) {
        fail("invalid-archive", "The archive journal contains an unknown entry.");
      }
      const path = join(paths.archives, item.name);
      const identity = assertPrivateDirectory(path, `Archive attempt ${item.name}`);
      if (match[1] === entry.slug && Number(match[2]) === entry.generation) {
        matches.push(
          Object.freeze({
            attempt: Number(match[3]),
            path,
            identity,
            completed: existsSync(join(path, "complete.json"))
          })
        );
      }
    }
    matches.sort((left, right) => left.attempt - right.attempt);
    if (matches.some((candidate, index) => candidate.attempt !== index + 1)) {
      fail("invalid-archive", "The archive journal contains an attempt gap.");
    }
    const plans = listRetirementPlans(entry);
    const currentPlan = plans.at(-1);
    const completedAttempts = matches
      .filter(({ completed }) => completed)
      .map((attempt) => Object.freeze({ attempt, binding: readCompletedArchiveBinding(entry, attempt, plans) }));
    if (completedAttempts.length === 0 || currentPlan === undefined) {
      fail("retirement-archive-missing", "This checkout has no completed recovery archive.");
    }
    const currentCompleted = completedAttempts.filter(({ binding }) => binding.plan.attempt === currentPlan.attempt);
    if (currentCompleted.length === 0) {
      fail("retirement-archive-stale", "The current retirement plan needs its own completed recovery archive.");
    }
    const authoritative = currentCompleted.at(-1);
    const attempt = authoritative.attempt;
    const plan = authoritative.binding.plan;
    const bundle = {
      path: join(attempt.path, "archive.bundle"),
      ...captureArchiveFile(join(attempt.path, "archive.bundle"), "Recovery bundle")
    };
    const { receiptPath, receipt, receiptFile, completionPath, completion } = authoritative.binding;
    const verification = {
      template: receipt.value.archive.verification.template,
      repository: captureVerificationRepository(
        receipt.value.archive.verification.repository.path,
        receipt.value.archive.verification.repository.identity
      )
    };
    revalidatePathIdentity(
      verification.template.path,
      verification.template.identity,
      "Verification template",
      "directory"
    );
    if (readDirectoryBounded(verification.template.path, 1, "The verification template").length !== 0) {
      fail("archive-changed", "The verification template is no longer empty.");
    }
    if (
      !isDeepStrictEqual(bundle, receipt.value.archive.bundle) ||
      !isDeepStrictEqual(verification.repository, receipt.value.archive.verification.repository)
    ) {
      fail("archive-changed", "The completed recovery archive no longer matches its receipt.");
    }
    validateCompletion(completion.value, entry, attempt, bundle, receiptFile, verification);
    const anchor = Object.freeze({
      attempt: attempt.attempt,
      directory: Object.freeze({ path: attempt.path, identity: attempt.identity }),
      completion: Object.freeze({
        path: completionPath,
        identity: completion.identity,
        byteLength: completion.byteLength,
        sha256: completion.sha256
      }),
      receipt: Object.freeze(receiptFile),
      bundle: Object.freeze(bundle)
    });
    const finalBundle = { path: bundle.path, ...captureArchiveFile(bundle.path, "Recovery bundle") };
    const finalPlan = readJsonReceipt(plan.path, MAXIMUM_ENTRY_BYTES, `Retirement evidence for ${entry.slug}`);
    const finalReceipt = readJsonReceipt(receiptPath, MAXIMUM_ENTRY_BYTES, "Archive receipt");
    const finalCompletion = readJsonReceipt(completionPath, MAXIMUM_ENTRY_BYTES, "Archive completion");
    if (
      !isDeepStrictEqual(finalBundle, bundle) ||
      !sameIdentity(finalPlan.identity, plan.identity) ||
      finalPlan.byteLength !== plan.byteLength ||
      finalPlan.sha256 !== plan.sha256 ||
      !isDeepStrictEqual(finalPlan.value, plan.value) ||
      !sameIdentity(finalReceipt.identity, receipt.identity) ||
      finalReceipt.byteLength !== receipt.byteLength ||
      finalReceipt.sha256 !== receipt.sha256 ||
      !isDeepStrictEqual(finalReceipt.value, receipt.value) ||
      !sameIdentity(finalCompletion.identity, completion.identity) ||
      finalCompletion.byteLength !== completion.byteLength ||
      finalCompletion.sha256 !== completion.sha256 ||
      !isDeepStrictEqual(finalCompletion.value, completion.value)
    ) {
      fail("archive-changed", "The completed recovery archive changed while its anchor was read.");
    }
    revalidatePathIdentity(attempt.path, attempt.identity, "Archive attempt directory", "directory");
    revalidatePathIdentity(paths.archives, rootIdentity, "The archive journal", "directory");
    return anchor;
  }

  function completedArchiveFetchHead(archive) {
    const receipt = readJsonReceipt(archive.receipt.path, MAXIMUM_ENTRY_BYTES, "Managed archive receipt");
    if (
      !sameIdentity(receipt.identity, archive.receipt.identity) ||
      receipt.byteLength !== archive.receipt.byteLength ||
      receipt.sha256 !== archive.receipt.sha256
    ) {
      fail("archive-changed", "The managed recovery archive receipt changed.");
    }
    const fetchHead = archiveFetchHeadReceipt(receipt.value);
    validateFetchHeadReceipt(fetchHead, "Completed archive target FETCH_HEAD receipt");
    return Object.freeze({ objectFormat: receipt.value.git.objectFormat, fetchHead });
  }

  function assertTargetFetchHeadMatchesArchive(entry, archive) {
    const expected = completedArchiveFetchHead(archive);
    const objectIdLength = expected.objectFormat === "sha256" ? 64 : 40;
    revalidatePathIdentity(entry.checkout.gitAdmin.path, entry.checkout.gitAdmin.identity, "Git admin", "directory");
    const current = fetchHeadReceipt(captureFetchHead(entry.checkout.gitAdmin.path, objectIdLength, "Target worktree"));
    revalidatePathIdentity(entry.checkout.gitAdmin.path, entry.checkout.gitAdmin.identity, "Git admin", "directory");
    if (!isDeepStrictEqual(current, expected.fetchHead)) {
      fail("retirement-source-changed", "Target worktree FETCH_HEAD changed after recovery was archived.");
    }
    return current;
  }

  function validateQuarantineDeferredChecks(value) {
    exactKeys(value, ["recovery", "processUse", "mounts"], "Quarantine deferred checks");
    if (
      value.recovery !== "completed-archive-revalidated" ||
      value.processUse !== "not-checked-recheck-required" ||
      value.mounts !== "not-checked-recheck-required"
    ) {
      fail("invalid-quarantine-journal", "Quarantine deferred checks are malformed.");
    }
  }

  function validateQuarantinePrevious(value, previous) {
    exactKeys(
      value,
      ["sequence", "kind", "operationId", "path", "identity", "byteLength", "sha256"],
      "Previous quarantine record"
    );
    validateIdentity(value.identity, "Previous quarantine record identity");
    if (
      value.sequence !== previous.sequence ||
      value.kind !== previous.kind ||
      value.operationId !== previous.operationId ||
      value.path !== previous.path ||
      !sameIdentity(value.identity, previous.identity) ||
      value.byteLength !== previous.byteLength ||
      value.sha256 !== previous.sha256
    ) {
      fail("invalid-quarantine-journal", "The quarantine journal hash chain is broken.");
    }
  }

  function quarantineRecordReceipt(record) {
    return Object.freeze({
      sequence: record.sequence,
      kind: record.kind,
      operationId: record.operationId,
      path: record.path,
      identity: record.loaded.identity,
      byteLength: record.loaded.byteLength,
      sha256: record.loaded.sha256
    });
  }

  function validateQuarantineRecord(record, entry, previous, archiveAnchor, originalPath, quarantinePath) {
    const result = record.kind.endsWith("-result");
    exactKeys(
      record.loaded.value,
      [
        "protocol",
        "kind",
        "slug",
        "entryGeneration",
        "sequence",
        "operationId",
        "previous",
        "anchor",
        "originalPath",
        "quarantinePath",
        "deferredChecks",
        "authorizesCleanup",
        ...(result ? ["observation", "classification"] : [])
      ],
      `Quarantine record ${record.sequence}`
    );
    const value = record.loaded.value;
    if (
      value.protocol !== QUARANTINE_EVENT_PROTOCOL ||
      value.kind !== record.kind ||
      value.slug !== entry.slug ||
      value.entryGeneration !== entry.generation ||
      value.sequence !== record.sequence ||
      value.operationId !== record.operationId ||
      value.authorizesCleanup !== false ||
      value.originalPath !== originalPath ||
      value.quarantinePath !== quarantinePath ||
      !isDeepStrictEqual(value.anchor, archiveAnchor)
    ) {
      fail("invalid-quarantine-journal", `Quarantine record ${record.sequence} is malformed.`);
    }
    validateQuarantineDeferredChecks(value.deferredChecks);
    if (previous === undefined) {
      if (value.previous !== null || record.kind !== "quarantine-intent") {
        fail("invalid-quarantine-journal", "The quarantine journal must begin with one quarantine intent.");
      }
    } else {
      validateQuarantinePrevious(value.previous, quarantineRecordReceipt(previous));
    }
    if (result) {
      const direction = record.kind.startsWith("quarantine-") ? "quarantine" : "restore";
      if (value.observation?.direction !== direction) {
        fail("invalid-quarantine-journal", "A quarantine result has the wrong observation direction.");
      }
      const classification = classifyQuarantineObservation(value.observation);
      if (!isDeepStrictEqual(value.classification, classification)) {
        fail("invalid-quarantine-journal", "A quarantine result has an invalid classification.");
      }
    }
  }

  function allowedQuarantineIntent(previous) {
    if (previous.kind === "quarantine-result") {
      if (previous.loaded.value.classification.state === "pre") return "quarantine-intent";
      if (previous.loaded.value.classification.state === "post") return "restore-intent";
    }
    if (previous.kind === "restore-result") {
      if (previous.loaded.value.classification.state === "pre") return "restore-intent";
      if (previous.loaded.value.classification.state === "post") return "quarantine-intent";
    }
    return null;
  }

  function readQuarantineOverlay(entry) {
    const rootIdentity = optionalPrivateDirectory(paths.quarantines, "The quarantine journal");
    if (rootIdentity === null) {
      return Object.freeze({ state: "none", authorizesCleanup: false });
    }
    let currentDirectory = null;
    for (const item of readDirectoryBounded(paths.quarantines, MAXIMUM_ENTRIES, "The quarantine journal")) {
      const match = QUARANTINE_JOURNAL_PATTERN.exec(item.name);
      if (!item.isDirectory() || item.isSymbolicLink() || match === null) {
        fail("invalid-quarantine-journal", "The quarantine journal contains an unknown entry.");
      }
      const path = join(paths.quarantines, item.name);
      const identity = assertPrivateDirectory(path, `Quarantine journal ${item.name}`);
      if (match[1] === entry.slug && Number(match[2]) === entry.generation) {
        currentDirectory = Object.freeze({ path, identity });
      }
    }
    if (currentDirectory === null) {
      revalidatePathIdentity(paths.quarantines, rootIdentity, "The quarantine journal", "directory");
      return Object.freeze({ state: "none", authorizesCleanup: false });
    }
    const archiveAnchor = readCompletedArchiveAnchor(entry);
    const initialNames = readDirectoryBounded(
      currentDirectory.path,
      MAXIMUM_QUARANTINE_RECORDS,
      `Quarantine journal for ${entry.slug}`
    )
      .map((item) => {
        const match = QUARANTINE_RECORD_PATTERN.exec(item.name);
        if (!item.isFile() || item.isSymbolicLink() || match === null) {
          fail("invalid-quarantine-journal", "The quarantine journal contains an unknown record.");
        }
        return Object.freeze({ name: item.name, sequence: Number(match[1]), kind: match[2], operationId: match[3] });
      })
      .sort((left, right) => left.sequence - right.sequence);
    if (initialNames.length === 0) fail("invalid-quarantine-journal", "The quarantine journal is empty.");
    const records = [];
    const operationIds = new Set();
    const originalPath = checkoutPathFor(entry.slug);
    const quarantinePath = join(
      paths.quarantinedCheckouts,
      `${entry.slug}.${entry.generation}.${initialNames[0].operationId}`
    );
    for (const [index, named] of initialNames.entries()) {
      if (
        named.sequence !== index + 1 ||
        named.name !== `${String(index + 1).padStart(8, "0")}.${named.kind}.${named.operationId}.json`
      ) {
        fail("invalid-quarantine-journal", "The quarantine journal contains a sequence gap or noncanonical name.");
      }
      const path = join(currentDirectory.path, named.name);
      const loaded = readJsonReceipt(path, MAXIMUM_ENTRY_BYTES, `Quarantine record ${named.sequence}`);
      const record = Object.freeze({ ...named, path, loaded });
      const previous = records.at(-1);
      if (named.kind.endsWith("-intent")) {
        if (operationIds.has(named.operationId))
          fail("invalid-quarantine-journal", "A quarantine operation ID was reused.");
        operationIds.add(named.operationId);
        const allowed = previous === undefined ? "quarantine-intent" : allowedQuarantineIntent(previous);
        if (named.kind !== allowed)
          fail("invalid-quarantine-journal", "The quarantine journal state transition is invalid.");
      } else {
        const expectedKind = previous?.kind.replace("-intent", "-result");
        if (previous === undefined || named.kind !== expectedKind || named.operationId !== previous.operationId) {
          fail("invalid-quarantine-journal", "A quarantine result does not immediately follow its intent.");
        }
      }
      validateQuarantineRecord(record, entry, previous, archiveAnchor, originalPath, quarantinePath);
      records.push(record);
    }
    hooks?.afterQuarantineRecordsRead?.(entry, records);
    const finalNames = readDirectoryBounded(
      currentDirectory.path,
      MAXIMUM_QUARANTINE_RECORDS,
      `Quarantine journal for ${entry.slug}`
    )
      .map((item) => item.name)
      .sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)));
    const expectedNames = initialNames
      .map(({ name }) => name)
      .sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)));
    if (!isDeepStrictEqual(finalNames, expectedNames))
      fail("registry-changed", "The quarantine journal changed while it was read.");
    for (const record of records) {
      const reread = readJsonReceipt(record.path, MAXIMUM_ENTRY_BYTES, `Quarantine record ${record.sequence}`);
      if (
        !sameIdentity(reread.identity, record.loaded.identity) ||
        reread.byteLength !== record.loaded.byteLength ||
        reread.sha256 !== record.loaded.sha256 ||
        !isDeepStrictEqual(reread.value, record.loaded.value)
      ) {
        fail("registry-changed", "The quarantine journal changed while it was read.");
      }
    }
    const finalArchiveAnchor = readCompletedArchiveAnchor(entry);
    if (!isDeepStrictEqual(finalArchiveAnchor, archiveAnchor)) {
      fail("archive-changed", "The completed recovery archive changed while the quarantine journal was read.");
    }
    verifyEntrySnapshot(entry);
    const finalEntry = readEntry(entry.slug);
    if (!isDeepStrictEqual(finalEntry, entry)) {
      fail("registry-changed", "The managed checkout entry changed while the quarantine journal was read.");
    }
    verifyEntrySnapshot(finalEntry);
    revalidatePathIdentity(
      currentDirectory.path,
      currentDirectory.identity,
      "The checkout quarantine journal",
      "directory"
    );
    revalidatePathIdentity(paths.quarantines, rootIdentity, "The quarantine journal", "directory");
    const latest = records.at(-1);
    const classification = latest.kind.endsWith("-result") ? latest.loaded.value.classification : null;
    const state =
      classification === null
        ? "intent-pending"
        : classification.location === "original-coherent"
          ? "original"
          : classification.location === "quarantine-coherent"
            ? "quarantined"
            : classification.state;
    return Object.freeze({
      state,
      latestKind: latest.kind,
      sequence: latest.sequence,
      operationId: latest.operationId,
      originalPath,
      quarantinePath,
      classification,
      archive: archiveAnchor,
      deferredChecks: latest.loaded.value.deferredChecks,
      authorizesCleanup: false
    });
  }

  function assertNoQuarantineHistoryForSlug(slug) {
    const rootIdentity = optionalPrivateDirectory(paths.quarantines, "The quarantine journal");
    if (rootIdentity === null) return;
    for (const item of readDirectoryBounded(paths.quarantines, MAXIMUM_ENTRIES, "The quarantine journal")) {
      const match = QUARANTINE_JOURNAL_PATTERN.exec(item.name);
      if (!item.isDirectory() || item.isSymbolicLink() || match === null) {
        fail("invalid-quarantine-journal", "The quarantine journal contains an unknown entry.");
      }
      assertPrivateDirectory(join(paths.quarantines, item.name), `Quarantine journal ${item.name}`);
      if (match[1] === slug) {
        fail("quarantine-overlay-active", `Managed checkout ${slug} has retained quarantine history.`);
      }
    }
    revalidatePathIdentity(paths.quarantines, rootIdentity, "The quarantine journal", "directory");
  }

  function requestCleanup(entry, reason) {
    if (entry.state === "cleanup-pending") return entry;
    if (entry.state !== "active") fail("checkout-not-active", "Only an active checkout can request cleanup.");
    hooks?.beforeCleanupPendingWrite?.(entry);
    return appendEntry(entry, {
      ...entry,
      state: "cleanup-pending",
      cleanupRequest: {
        protocol: CLEANUP_REQUEST_PROTOCOL,
        requestedBy: entry.ownerTask,
        requestedRevision: entry.revision,
        reason
      }
    });
  }

  function requestAbandonedReview(entry) {
    if (entry.state === "abandoned-review-required") return entry;
    if (entry.state !== "creating") {
      fail("checkout-not-active", "Only an interrupted create can request absence review.");
    }
    hooks?.beforeAbandonPendingWrite?.(entry);
    return appendEntry(entry, {
      ...entry,
      state: "abandoned-review-required",
      cleanupRequest: {
        protocol: CLEANUP_REQUEST_PROTOCOL,
        requestedBy: entry.ownerTask,
        requestedRevision: entry.revision,
        reason: "abandon"
      }
    });
  }

  function sweepRoot(kind) {
    if (kind === "managed") return paths.managedRetirementSweeps;
    if (kind === "legacy") return paths.legacyRetirementSweeps;
    fail("invalid-retirement-kind", "Retirement kind must be managed or legacy.");
  }

  function sweepQuarantineRoot(kind) {
    if (kind === "managed") return paths.managedRetirementQuarantine;
    if (kind === "legacy") return paths.legacyRetirementQuarantine;
    fail("invalid-retirement-kind", "Retirement kind must be managed or legacy.");
  }

  function sweepJournalPath(kind, slug, generation) {
    assertSlug(slug);
    assertGeneration(generation);
    return join(sweepRoot(kind), `${slug}.${generation}`);
  }

  function sweepQuarantinePath(kind, slug, generation, operationId) {
    assertSlug(slug);
    assertGeneration(generation);
    if (!/^[0-9a-f]{32}$/u.test(operationId)) fail("invalid-retirement-journal", "Operation ID is malformed.");
    return join(sweepQuarantineRoot(kind), `${slug}.${generation}.${operationId}`);
  }

  function sweepRecordReceipt(record) {
    return Object.freeze({
      path: record.path,
      identity: record.loaded.identity,
      byteLength: record.loaded.byteLength,
      sha256: record.loaded.sha256
    });
  }

  function validateSweepPrevious(value, previous) {
    exactKeys(value, ["path", "identity", "byteLength", "sha256"], "Previous retirement record");
    validateIdentity(value.identity, "Previous retirement record identity");
    const receipt = sweepRecordReceipt(previous);
    if (!isDeepStrictEqual(value, receipt)) {
      fail("invalid-retirement-journal", "The retirement record chain is broken.");
    }
  }

  function validateSweepSource(kind, source) {
    if (kind === "managed") {
      exactKeys(source, ["entry", "plan", "archiveCompletion"], "Managed retirement source");
    } else {
      exactKeys(source, ["adoption", "archiveCompletion", "archiveReceipt"], "Legacy retirement source");
    }
    for (const [label, record] of Object.entries(source)) {
      exactKeys(record, ["path", "identity", "byteLength", "sha256"], `${label} retirement receipt`);
      validateIdentity(record.identity, `${label} retirement receipt identity`);
      if (
        typeof record.path !== "string" ||
        !Number.isSafeInteger(record.byteLength) ||
        record.byteLength < 1 ||
        !/^[0-9a-f]{64}$/u.test(record.sha256)
      ) {
        fail("invalid-retirement-journal", `${label} retirement receipt is malformed.`);
      }
    }
  }

  function validateSweepRecord(record, previous, expected) {
    const value = record.loaded.value;
    const legacyV1 = expected.kind === "legacy" && value.protocol === RETIREMENT_SWEEP_PROTOCOL;
    const legacyV2 = expected.kind === "legacy" && value.protocol === LEGACY_RETIREMENT_SWEEP_PROTOCOL;
    const validProtocol =
      expected.kind === "legacy" ? legacyV1 || legacyV2 : value.protocol === RETIREMENT_SWEEP_PROTOCOL;
    const common = [
      "protocol",
      "kind",
      "candidateKind",
      "slug",
      "generation",
      "sequence",
      "operationId",
      "previous",
      ...(legacyV2 ? ["ownerTask", "ownerRevision"] : [])
    ];
    const extra =
      record.kind === "eligible"
        ? ["eligibleBootId", "originalPath", "originalIdentity", "source"]
        : record.kind === "quarantine-intent"
          ? ["bootId", "originalPath", "quarantinePath"]
          : record.kind === "quarantine-result"
            ? ["bootId", "quarantinePath", "location"]
            : record.kind === "purge-intent"
              ? ["bootId", "quarantinePath"]
              : ["bootId", "quarantinePath", "branchPreserved"];
    exactKeys(value, [...common, ...extra], `Retirement ${record.kind} record`);
    if (
      !validProtocol ||
      value.kind !== record.kind ||
      value.candidateKind !== expected.kind ||
      value.slug !== expected.slug ||
      value.generation !== expected.generation ||
      value.sequence !== record.sequence ||
      value.operationId !== record.operationId
    ) {
      fail("invalid-retirement-journal", `Retirement ${record.kind} record is malformed.`);
    }
    if (expected.kind === "legacy") {
      if (previous?.loaded.value.protocol === LEGACY_RETIREMENT_SWEEP_PROTOCOL && legacyV1) {
        fail("invalid-retirement-journal", "A legacy retirement journal cannot return to its v1 record format.");
      }
      if (legacyV2) {
        assertOwner(value.ownerTask);
        assertRevision(value.ownerRevision);
        const authority = expected.legacyAuthority;
        if (
          (authority !== undefined &&
            (value.ownerTask !== authority.ownerTask || value.ownerRevision !== authority.ownerRevision)) ||
          (previous?.loaded.value.protocol === LEGACY_RETIREMENT_SWEEP_PROTOCOL &&
            (value.ownerTask !== previous.loaded.value.ownerTask ||
              value.ownerRevision !== previous.loaded.value.ownerRevision))
        ) {
          fail("invalid-retirement-journal", "The legacy owner revision changed inside the retirement journal.");
        }
      }
    }
    if (previous === undefined) {
      if (record.kind !== "eligible" || value.previous !== null) {
        fail("invalid-retirement-journal", "A retirement journal must begin with eligibility.");
      }
    } else validateSweepPrevious(value.previous, previous);
    if (record.kind === "eligible") {
      if (!BOOT_ID_PATTERN.test(value.eligibleBootId)) {
        fail("invalid-retirement-journal", "The eligibility boot ID is malformed.");
      }
      validateIdentity(value.originalIdentity, "Retirement source identity");
      if (value.originalPath !== expected.originalPath) {
        fail("invalid-retirement-journal", "The retirement source path changed.");
      }
      validateSweepSource(expected.kind, value.source);
    } else {
      if (!BOOT_ID_PATTERN.test(value.bootId) || value.quarantinePath !== expected.quarantinePath) {
        fail("invalid-retirement-journal", `Retirement ${record.kind} record has an invalid boot or path.`);
      }
      if (record.kind === "quarantine-intent" && value.originalPath !== expected.originalPath) {
        fail("invalid-retirement-journal", "The quarantine intent changes the original path.");
      }
      if (record.kind === "quarantine-result" && value.location !== "quarantine") {
        fail("invalid-retirement-journal", "The quarantine result is not coherent.");
      }
      if (record.kind === "retired" && typeof value.branchPreserved !== "boolean") {
        fail("invalid-retirement-journal", "The retirement tombstone has an invalid branch result.");
      }
    }
  }

  function readSweepRecords(kind, slug, generation, originalPath) {
    const path = sweepJournalPath(kind, slug, generation);
    if (!existsSync(path)) return Object.freeze([]);
    const identity = assertPrivateDirectory(path, "Retirement sweep journal");
    const names = readDirectoryBounded(path, MAXIMUM_RETIREMENT_SWEEP_RECORDS, "Retirement sweep journal")
      .map((item) => {
        const match = RETIREMENT_SWEEP_RECORD_PATTERN.exec(item.name);
        if (!item.isFile() || item.isSymbolicLink() || match === null) {
          fail("invalid-retirement-journal", "A retirement journal contains an unknown entry.");
        }
        return Object.freeze({ name: item.name, sequence: Number(match[1]), kind: match[2], operationId: match[3] });
      })
      .sort((left, right) => left.sequence - right.sequence);
    const records = [];
    const operationId = names[0]?.operationId;
    const quarantinePath = operationId === undefined ? null : sweepQuarantinePath(kind, slug, generation, operationId);
    for (const [index, named] of names.entries()) {
      if (
        named.sequence !== index + 1 ||
        named.operationId !== operationId ||
        named.name !== `${String(named.sequence).padStart(8, "0")}.${named.kind}.${named.operationId}.json`
      ) {
        fail("invalid-retirement-journal", "The retirement journal has a sequence gap or operation mismatch.");
      }
      const recordPath = join(path, named.name);
      const loaded = readJsonReceipt(recordPath, MAXIMUM_ENTRY_BYTES, `Retirement record ${named.sequence}`);
      const record = Object.freeze({ ...named, path: recordPath, loaded });
      records.push(record);
    }
    const expectedKinds = ["eligible", "quarantine-intent", "quarantine-result", "purge-intent", "retired"];
    if (records.some((record, index) => record.kind !== expectedKinds[index])) {
      fail("invalid-retirement-journal", "The retirement journal has an invalid state transition.");
    }
    let legacyAuthority;
    if (kind === "legacy" && records.length !== 0) {
      validateSweepRecord(records[0], undefined, { kind, slug, generation, originalPath, quarantinePath });
      legacyAuthority = legacyRetirementSourceAnchors(records[0].loaded.value).authority;
    }
    const expected = { kind, slug, generation, originalPath, quarantinePath, legacyAuthority };
    for (const [index, record] of records.entries()) {
      validateSweepRecord(record, records[index - 1], expected);
    }
    revalidatePathIdentity(path, identity, "Retirement sweep journal", "directory");
    if (legacyAuthority === undefined) return Object.freeze(records);
    return Object.freeze(
      records.map((record) => {
        if (record.loaded.value.protocol !== RETIREMENT_SWEEP_PROTOCOL) return record;
        return Object.freeze({
          ...record,
          loaded: Object.freeze({
            ...record.loaded,
            value: Object.freeze({ ...record.loaded.value, ...legacyAuthority })
          })
        });
      })
    );
  }

  function appendSweepRecord(kind, slug, generation, originalPath, value) {
    initializeRetirementSweepJournal();
    const journal = sweepJournalPath(kind, slug, generation);
    const parent = sweepRoot(kind);
    const parentIdentity = managedIdentities.get(parent);
    if (parentIdentity === undefined) fail("unsafe-manager", "The retirement sweep journal was not initialized.");
    if (!existsSync(journal)) {
      if (value.sequence !== 1) fail("invalid-retirement-journal", "A retirement journal is missing eligibility.");
      mkdirSync(journal, { mode: 0o700 });
      chmodSync(journal, 0o700);
      fsyncDirectory(parent);
    }
    const journalIdentity = assertPrivateDirectory(journal, "Retirement sweep journal");
    revalidatePathIdentity(parent, parentIdentity, "Retirement sweep parent", "directory");
    const records = readSweepRecords(kind, slug, generation, originalPath);
    if (records.length + 1 !== value.sequence) {
      fail("retirement-state-changed", "The retirement journal advanced concurrently.");
    }
    const expectedPrevious = records.length === 0 ? null : sweepRecordReceipt(records.at(-1));
    if (!isDeepStrictEqual(value.previous, expectedPrevious)) {
      fail("invalid-retirement-journal", "The new retirement record has the wrong predecessor.");
    }
    const name = `${String(value.sequence).padStart(8, "0")}.${value.kind}.${value.operationId}.json`;
    const destination = join(journal, name);
    writeJsonExclusive(destination, value, journalIdentity);
    const loaded = readJsonReceipt(destination, MAXIMUM_ENTRY_BYTES, `Retirement ${value.kind} record`);
    const record = Object.freeze({
      sequence: value.sequence,
      kind: value.kind,
      operationId: value.operationId,
      path: destination,
      loaded
    });
    const quarantinePath = sweepQuarantinePath(kind, slug, generation, value.operationId);
    const legacyAuthority =
      kind !== "legacy"
        ? undefined
        : records.length === 0
          ? legacyRetirementSourceAnchors(value).authority
          : Object.freeze({
              ownerTask: records[0].loaded.value.ownerTask,
              ownerRevision: records[0].loaded.value.ownerRevision
            });
    validateSweepRecord(record, records.at(-1), {
      kind,
      slug,
      generation,
      originalPath,
      quarantinePath,
      legacyAuthority
    });
    return record;
  }

  function receiptFromLoaded(path, loaded) {
    return Object.freeze({
      path,
      identity: loaded.identity,
      byteLength: loaded.byteLength,
      sha256: loaded.sha256
    });
  }

  function sameRetirementTargetEvidence(left, right) {
    const withoutRegistryInventory = (value) => ({
      ...value,
      git: {
        ...value.git,
        worktreeListSha256: "unrelated-worktrees-ignored",
        worktreeRecordCount: 0
      }
    });
    return isDeepStrictEqual(withoutRegistryInventory(left), withoutRegistryInventory(right));
  }

  function assertReceiptMatches(expected, loaded, label) {
    if (
      loaded.path !== expected.path ||
      !sameIdentity(loaded.identity, expected.identity) ||
      loaded.byteLength !== expected.byteLength ||
      loaded.sha256 !== expected.sha256
    ) {
      fail("retirement-source-changed", `${label} changed after enrollment.`);
    }
  }

  function captureManagedEnrollment(slug) {
    const entry = readEntry(slug);
    if (entry.state !== "cleanup-pending" || entry.cleanupRequest.reason !== "finish") {
      fail("retirement-not-eligible", "Only an explicitly finished managed checkout can be enrolled.");
    }
    const plan = readRetirementPlan(entry);
    const first = captureRetirementEvidence(entry);
    if (!sameRetirementTargetEvidence(first, plan.value)) {
      fail("retirement-evidence-stale", "The current retirement evidence is stale; record a superseding plan first.");
    }
    const archive = readCompletedArchiveAnchor(entry);
    assertTargetFetchHeadMatchesArchive(entry, archive);
    const second = captureRetirementEvidence(entry);
    if (!sameRetirementTargetEvidence(second, plan.value)) {
      fail("retirement-evidence-stale", "The checkout changed while retirement enrollment was checked.");
    }
    assertTargetFetchHeadMatchesArchive(entry, archive);
    const entryLoaded = readJsonReceipt(
      entryPath(entry.slug, entry.generation),
      MAXIMUM_ENTRY_BYTES,
      `Managed checkout ${entry.slug}`
    );
    const source = Object.freeze({
      entry: receiptFromLoaded(entryPath(entry.slug, entry.generation), entryLoaded),
      plan: Object.freeze({
        path: plan.path,
        identity: plan.identity,
        byteLength: plan.byteLength,
        sha256: plan.sha256
      }),
      archiveCompletion: archive.completion
    });
    return Object.freeze({
      kind: "managed",
      slug,
      generation: entry.generation,
      originalPath: checkoutPathFor(slug),
      originalIdentity: entry.checkout.directory,
      source,
      entry,
      plan,
      archive
    });
  }

  function providerScanObjectsDirectory(candidate, name) {
    const gitPath = join(candidate, ".git");
    let metadata;
    try {
      metadata = lstatSync(gitPath, { bigint: true });
    } catch (error) {
      if (error.code === "ENOENT") return null;
      fail("legacy-provider-scan-unsafe", "A known checkout Git path could not be inspected safely.");
    }
    if (metadata.isSymbolicLink() || !currentUserOwns(metadata)) {
      fail("legacy-provider-scan-unsafe", "A known checkout has an unsafe Git path.");
    }
    let gitDirectory;
    if (metadata.isDirectory()) gitDirectory = gitPath;
    else if (metadata.isFile()) {
      const file = readBoundedFile(gitPath, 8192, `Linked-worktree Git file for ${name}`);
      const match = /^gitdir: ([^\0\r\n]+)\n$/u.exec(file.text);
      if (match === null) fail("legacy-provider-scan-unsafe", "A known linked worktree has a malformed Git file.");
      gitDirectory = resolve(candidate, match[1]);
    } else fail("legacy-provider-scan-unsafe", "A known checkout has an unsupported Git path.");
    const gitMetadata = lstatSync(gitDirectory, { bigint: true });
    if (
      !gitMetadata.isDirectory() ||
      gitMetadata.isSymbolicLink() ||
      !currentUserOwns(gitMetadata) ||
      realpathSync(gitDirectory) !== resolve(gitDirectory)
    ) {
      fail("legacy-provider-scan-unsafe", "A known checkout has an unsafe Git directory.");
    }
    const commondirPath = join(gitDirectory, "commondir");
    let hasCommondir;
    try {
      lstatSync(commondirPath, { bigint: true });
      hasCommondir = true;
    } catch (error) {
      if (error.code !== "ENOENT") {
        fail("legacy-provider-scan-unsafe", "A known checkout common directory could not be inspected safely.");
      }
      hasCommondir = false;
    }
    if (!hasCommondir) return join(gitDirectory, "objects");
    const commondir = readBoundedFile(commondirPath, 8192, `Linked-worktree common directory for ${name}`);
    const match = /^([^\0\r\n]+)\n$/u.exec(commondir.text);
    if (match === null)
      fail("legacy-provider-scan-unsafe", "A known linked worktree has a malformed common directory.");
    const commonDirectory = resolve(gitDirectory, match[1]);
    const commonMetadata = lstatSync(commonDirectory, { bigint: true });
    if (
      !commonMetadata.isDirectory() ||
      commonMetadata.isSymbolicLink() ||
      !currentUserOwns(commonMetadata) ||
      realpathSync(commonDirectory) !== resolve(commonDirectory)
    ) {
      fail("legacy-provider-scan-unsafe", "A known linked worktree has an unsafe common Git directory.");
    }
    return join(commonDirectory, "objects");
  }

  function captureBareDependencyRepository(directoryPath, directoryIdentity, entries) {
    const entriesByName = new Map(entries.map((entry) => [entry.name, entry]));
    const requiredMarkerNames = ["HEAD", "objects", "refs"];
    const present = requiredMarkerNames.filter((name) => entriesByName.has(name));
    const looksBare = present.length === requiredMarkerNames.length;
    if (!looksBare) return null;
    if (entriesByName.has(".git")) {
      fail("legacy-provider-scan-unsafe", "A dependency path has an ambiguous bare-repository layout.");
    }
    const headEntry = entriesByName.get("HEAD");
    const configEntry = entriesByName.get("config");
    const objectsEntry = entriesByName.get("objects");
    const refsEntry = entriesByName.get("refs");
    if (
      !headEntry.isFile() ||
      headEntry.isSymbolicLink() ||
      (configEntry !== undefined && (!configEntry.isFile() || configEntry.isSymbolicLink())) ||
      !objectsEntry.isDirectory() ||
      objectsEntry.isSymbolicLink() ||
      !refsEntry.isDirectory() ||
      refsEntry.isSymbolicLink()
    ) {
      fail("legacy-provider-scan-unsafe", "A dependency path has an unsafe bare-repository signature.");
    }
    const headPath = join(directoryPath, "HEAD");
    const configPath = join(directoryPath, "config");
    const objectsPath = join(directoryPath, "objects");
    const refsPath = join(directoryPath, "refs");
    const head = readBoundedFile(headPath, MAXIMUM_LEGACY_REF_BYTES, "Bare dependency HEAD");
    const config =
      configEntry === undefined
        ? null
        : readBoundedFile(configPath, MAXIMUM_LEGACY_CONFIG_BYTES, "Bare dependency configuration");
    const objectsIdentity = captureLegacyDirectory(objectsPath, "Bare dependency object directory");
    const refsIdentity = captureLegacyDirectory(refsPath, "Bare dependency refs directory");
    const symbolicHead = /^ref: ([^\0\r\n]+)\n$/u.exec(head.text);
    if (symbolicHead === null) {
      if (!new RegExp(`^[0-9a-f]{40}(?:[0-9a-f]{24})?\\n$`, "u").test(head.text)) {
        fail("legacy-provider-scan-unsafe", "A bare dependency has a malformed HEAD.");
      }
    } else {
      const checked = run("git", ["check-ref-format", symbolicHead[1]], {
        cwd: directoryPath,
        allowFailure: true,
        env: auditGitEnvironment()
      });
      if (checked.status !== 0) fail("legacy-provider-scan-unsafe", "A bare dependency has an invalid HEAD ref.");
    }
    if (config !== null) {
      const bare = run("git", ["config", "--file", configPath, "--no-includes", "--type=bool", "--get", "core.bare"], {
        cwd: directoryPath,
        allowFailure: true,
        env: auditGitEnvironment()
      });
      if (bare.status !== 0 || bare.stdout.trim() !== "true") {
        fail("legacy-provider-scan-unsafe", "A dependency path has bare-repository markers without core.bare=true.");
      }
    }
    const repositorySelector = config === null ? ["-C", directoryPath] : [`--git-dir=${directoryPath}`];
    const gitDirectory = run("git", [...repositorySelector, "rev-parse", "--absolute-git-dir"], {
      cwd: directoryPath,
      allowFailure: true,
      env: auditGitEnvironment()
    });
    const bareProof = run("git", [...repositorySelector, "rev-parse", "--is-bare-repository"], {
      cwd: directoryPath,
      allowFailure: true,
      env: auditGitEnvironment()
    });
    if (
      gitDirectory.status !== 0 ||
      resolve(gitDirectory.stdout.trim()) !== directoryPath ||
      bareProof.status !== 0 ||
      bareProof.stdout.trim() !== "true"
    ) {
      fail("legacy-provider-scan-unsafe", "A dependency path does not prove one exact bare Git directory.");
    }
    revalidatePathIdentity(headPath, head.identity, "Bare dependency HEAD");
    if (config === null) {
      try {
        lstatSync(configPath, { bigint: true });
        fail("legacy-dependency-universe-changed", "A bare dependency configuration appeared during inspection.");
      } catch (error) {
        if (error instanceof CheckoutLifecycleError) throw error;
        if (error.code !== "ENOENT") {
          fail("legacy-provider-scan-unsafe", "A bare dependency configuration could not be checked safely.");
        }
      }
    } else {
      revalidatePathIdentity(configPath, config.identity, "Bare dependency configuration");
    }
    revalidatePathIdentity(objectsPath, objectsIdentity, "Bare dependency object directory", "directory");
    revalidatePathIdentity(refsPath, refsIdentity, "Bare dependency refs directory", "directory");
    captureLegacyDirectory(directoryPath, "Bare dependency repository", directoryIdentity);
    return Object.freeze({
      kind: "bare",
      objectsDirectory: objectsPath,
      objectsIdentity,
      head: Object.freeze({ path: headPath, identity: head.identity, sha256: sha256(head.text) }),
      config:
        config === null
          ? Object.freeze({ path: configPath, present: false })
          : Object.freeze({
              path: configPath,
              present: true,
              identity: config.identity,
              sha256: sha256(config.text)
            }),
      refs: Object.freeze({ path: refsPath, identity: refsIdentity })
    });
  }

  function revalidateDependencyRepository(repositoryState) {
    revalidatePathIdentity(
      repositoryState.objectsDirectory,
      repositoryState.objectsIdentity,
      "Legacy dependency object directory",
      "directory"
    );
    if (repositoryState.kind !== "bare") return;
    const head = readBoundedFile(repositoryState.head.path, MAXIMUM_LEGACY_REF_BYTES, "Bare dependency HEAD");
    if (
      !sameIdentity(head.identity, repositoryState.head.identity) ||
      sha256(head.text) !== repositoryState.head.sha256
    ) {
      fail("legacy-dependency-universe-changed", "A bare dependency changed while it was inspected.");
    }
    if (repositoryState.config.present) {
      const config = readBoundedFile(
        repositoryState.config.path,
        MAXIMUM_LEGACY_CONFIG_BYTES,
        "Bare dependency configuration"
      );
      if (
        !sameIdentity(config.identity, repositoryState.config.identity) ||
        sha256(config.text) !== repositoryState.config.sha256
      ) {
        fail("legacy-dependency-universe-changed", "A bare dependency changed while it was inspected.");
      }
    } else {
      try {
        lstatSync(repositoryState.config.path, { bigint: true });
        fail("legacy-dependency-universe-changed", "A bare dependency configuration appeared during inspection.");
      } catch (error) {
        if (error instanceof CheckoutLifecycleError) throw error;
        if (error.code !== "ENOENT") {
          fail("legacy-provider-scan-unsafe", "A bare dependency configuration could not be checked safely.");
        }
      }
    }
    revalidatePathIdentity(
      repositoryState.refs.path,
      repositoryState.refs.identity,
      "Bare dependency refs",
      "directory"
    );
  }

  function validateLegacyDependencyUniverse(value, providerPath) {
    if (value?.protocol === LEGACY_DEPENDENCY_UNIVERSE_PROTOCOL) {
      exactKeys(
        value,
        [
          "protocol",
          "roots",
          "cleanupCandidates",
          "cohortSha256",
          "repositoryGroups",
          "providerObjectsPath",
          "repositoryCount",
          "repositoriesSha256"
        ],
        "Explicit legacy dependency universe"
      );
      if (
        !Array.isArray(value.roots) ||
        value.roots.length < 1 ||
        value.roots.length > MAXIMUM_DISCOVERY_ROOTS ||
        !Array.isArray(value.cleanupCandidates) ||
        value.cleanupCandidates.length < 1 ||
        value.cleanupCandidates.length > MAXIMUM_LEGACY_BATCH_CANDIDATES ||
        !/^[0-9a-f]{64}$/u.test(value.cohortSha256) ||
        !Array.isArray(value.repositoryGroups) ||
        value.repositoryGroups.length < 1 ||
        value.repositoryGroups.length > MAXIMUM_DEPENDENCY_REPOSITORIES ||
        value.providerObjectsPath !== resolve(providerPath, ".git", "objects") ||
        !Number.isSafeInteger(value.repositoryCount) ||
        value.repositoryCount < 0 ||
        value.repositoryCount > MAXIMUM_DEPENDENCY_REPOSITORIES ||
        !/^[0-9a-f]{64}$/u.test(value.repositoriesSha256)
      ) {
        fail("invalid-legacy-adoption", "The explicit legacy dependency universe is malformed.");
      }
      const catalogRoots = value.roots.map((root) => {
        exactKeys(
          root,
          ["path", "identity", "entries", "entryReceipts", "entriesSha256"],
          "Explicit dependency root proof"
        );
        validateIdentity(root.identity, "Explicit dependency root identity");
        if (
          !Array.isArray(root.entryReceipts) ||
          root.entryReceipts.length !== root.entries.length ||
          root.entryReceipts.some((receipt, index) => {
            exactKeys(receipt, ["name", "sha256"], "Explicit dependency entry receipt");
            return receipt.name !== root.entries[index]?.name || !/^[0-9a-f]{64}$/u.test(receipt.sha256);
          }) ||
          root.entriesSha256 !== explicitCatalogEntryReceiptsSha256(root.entryReceipts)
        ) {
          fail("invalid-legacy-adoption", "An explicit dependency root proof is malformed.");
        }
        return Object.freeze({ path: root.path, entries: root.entries });
      });
      const normalized = normalizeLegacyDependencyCatalog({
        protocol: LEGACY_DEPENDENCY_CATALOG_PROTOCOL,
        roots: catalogRoots
      });
      if (
        !isDeepStrictEqual(
          normalized.roots,
          Object.freeze(value.roots.map((root) => Object.freeze({ path: root.path, entries: root.entries })))
        )
      ) {
        fail("invalid-legacy-adoption", "Explicit dependency roots are not in canonical order.");
      }
      const providerRoot = value.roots.find((root) => root.path === dirname(providerPath));
      if (
        providerRoot === undefined ||
        !providerRoot.entries.some((entry) => entry.name === basename(providerPath) && entry.kind === "repository")
      ) {
        fail("invalid-legacy-adoption", "The explicit dependency universe omits its provider repository.");
      }
      const repositoryPaths = value.roots.flatMap((root) =>
        root.entries.filter((entry) => entry.kind === "repository").map((entry) => join(root.path, entry.name))
      );
      const cleanupCandidates = [...value.cleanupCandidates].sort((left, right) =>
        Buffer.compare(Buffer.from(left), Buffer.from(right))
      );
      if (
        new Set(value.cleanupCandidates).size !== value.cleanupCandidates.length ||
        !isDeepStrictEqual(value.cleanupCandidates, cleanupCandidates) ||
        !value.cleanupCandidates.includes(providerPath) ||
        value.cleanupCandidates.some(
          (path) =>
            typeof path !== "string" || !isAbsolute(path) || resolve(path) !== path || !repositoryPaths.includes(path)
        )
      ) {
        fail("invalid-legacy-adoption", "The explicit dependency cleanup cohort is malformed.");
      }
      const groupedPaths = [];
      for (const group of value.repositoryGroups) {
        exactKeys(group, ["memberPaths", "recordSha256"], "Explicit dependency repository group");
        if (
          !Array.isArray(group.memberPaths) ||
          group.memberPaths.length < 1 ||
          group.memberPaths.length > MAXIMUM_WORKTREE_RECORDS ||
          !/^[0-9a-f]{64}$/u.test(group.recordSha256) ||
          new Set(group.memberPaths).size !== group.memberPaths.length ||
          !isDeepStrictEqual(group.memberPaths, [...group.memberPaths].sort()) ||
          group.memberPaths.some((path) => !repositoryPaths.includes(path))
        ) {
          fail("invalid-legacy-adoption", "An explicit dependency repository group is malformed.");
        }
        groupedPaths.push(...group.memberPaths);
      }
      if (
        new Set(groupedPaths).size !== groupedPaths.length ||
        !isDeepStrictEqual([...groupedPaths].sort(), [...repositoryPaths].sort())
      ) {
        fail("invalid-legacy-adoption", "Explicit dependency repository groups are incomplete.");
      }
      if (
        value.cohortSha256 !== explicitCatalogCohortSha256(value.roots, value.cleanupCandidates, value.repositoryGroups)
      ) {
        fail("invalid-legacy-adoption", "The explicit dependency cleanup cohort digest is malformed.");
      }
      const providerGroups = value.repositoryGroups.filter((group) => group.memberPaths.includes(providerPath));
      const otherGroups = value.repositoryGroups.filter((group) => !group.memberPaths.includes(providerPath));
      if (
        providerGroups.length !== 1 ||
        providerGroups[0].memberPaths.length !== 1 ||
        value.repositoryCount !== otherGroups.length ||
        value.repositoriesSha256 !== explicitCatalogRepositoryGroupsSha256(otherGroups)
      ) {
        fail("invalid-legacy-adoption", "The explicit dependency repository proof is malformed.");
      }
      return value;
    }
    exactKeys(
      value,
      ["roots", "maxDepth", "providerObjectsPath", "repositoryCount", "repositoriesSha256"],
      "Legacy dependency universe"
    );
    if (
      !Array.isArray(value.roots) ||
      value.roots.length < 1 ||
      value.roots.length > MAXIMUM_DISCOVERY_ROOTS ||
      value.maxDepth !== MAXIMUM_DISCOVERY_DEPTH ||
      value.providerObjectsPath !== resolve(providerPath, ".git", "objects") ||
      !Number.isSafeInteger(value.repositoryCount) ||
      value.repositoryCount < 0 ||
      value.repositoryCount > MAXIMUM_DEPENDENCY_REPOSITORIES ||
      !/^[0-9a-f]{64}$/u.test(value.repositoriesSha256)
    ) {
      fail("invalid-legacy-adoption", "The legacy dependency universe is malformed.");
    }
    const pathsSeen = new Set();
    for (const root of value.roots) {
      exactKeys(root, ["path", "identity"], "Legacy dependency root");
      validateIdentity(root.identity, "Legacy dependency root identity");
      if (
        typeof root.path !== "string" ||
        !isAbsolute(root.path) ||
        resolve(root.path) !== root.path ||
        root.path === providerPath ||
        pathsSeen.has(root.path)
      ) {
        fail("invalid-legacy-adoption", "A legacy dependency root is malformed.");
      }
      pathsSeen.add(root.path);
    }
    const rootPaths = [...pathsSeen];
    if (
      rootPaths.some((left, index) =>
        rootPaths.some((right, other) => index !== other && isSameOrContained(right, left))
      ) ||
      !rootPaths.some((root) => isContained(root, providerPath))
    ) {
      fail("invalid-legacy-adoption", "Legacy dependency roots must be non-overlapping and contain the checkout.");
    }
    return value;
  }

  function normalizeLegacyDependencyRoots(roots, providerPath, expected = undefined) {
    const requested = expected === undefined ? roots : expected.roots.map((root) => root.path);
    if (!Array.isArray(requested) || requested.length < 1 || requested.length > MAXIMUM_DISCOVERY_ROOTS) {
      fail(
        "legacy-dependency-universe-required",
        `Legacy adoption requires 1-${MAXIMUM_DISCOVERY_ROOTS} explicit dependency roots.`
      );
    }
    const normalized = requested.map((root) => {
      if (typeof root !== "string" || !isAbsolute(root) || resolve(root) !== root || root === providerPath) {
        fail("legacy-provider-scan-unsafe", "Legacy dependency roots must be canonical parent directories.");
      }
      const identity = captureLegacyDirectory(root, `Legacy dependency root ${root}`);
      return Object.freeze({ path: root, identity });
    });
    normalized.sort((left, right) => left.path.localeCompare(right.path));
    const rootPaths = normalized.map((root) => root.path);
    if (
      new Set(rootPaths).size !== rootPaths.length ||
      rootPaths.some((left, index) =>
        rootPaths.some((right, other) => index !== other && isSameOrContained(right, left))
      ) ||
      !rootPaths.some((root) => isContained(root, providerPath))
    ) {
      fail("legacy-provider-scan-unsafe", "Legacy dependency roots must be unique, non-overlapping parents.");
    }
    if (
      expected !== undefined &&
      normalized.some(
        (root, index) =>
          root.path !== expected.roots[index]?.path || !sameIdentity(root.identity, expected.roots[index]?.identity)
      )
    ) {
      fail("legacy-dependency-universe-changed", "A recorded legacy dependency root changed identity.");
    }
    return Object.freeze(normalized);
  }

  function normalizeLegacyDependencyCatalog(value, options = {}) {
    exactKeys(value, ["protocol", "roots"], "Legacy dependency catalog");
    if (
      value.protocol !== LEGACY_DEPENDENCY_CATALOG_PROTOCOL ||
      !Array.isArray(value.roots) ||
      value.roots.length < 1 ||
      value.roots.length > MAXIMUM_DISCOVERY_ROOTS
    ) {
      fail("invalid-legacy-batch", "The explicit dependency catalog has an unsupported protocol or root count.");
    }
    let entryCount = 0;
    const roots = value.roots.map((root) => {
      exactKeys(root, ["path", "entries"], "Legacy dependency catalog root");
      if (
        typeof root.path !== "string" ||
        !isAbsolute(root.path) ||
        resolve(root.path) !== root.path ||
        !Array.isArray(root.entries) ||
        (options.allowEmptyRoots !== true && root.entries.length < 1)
      ) {
        fail("invalid-legacy-batch", "Every explicit dependency root needs a canonical path and entries.");
      }
      const entries = root.entries.map((entry) => {
        exactKeys(entry, ["name", "kind"], "Legacy dependency catalog entry");
        if (
          typeof entry.name !== "string" ||
          entry.name === "" ||
          entry.name === "." ||
          entry.name === ".." ||
          entry.name.includes("\0") ||
          entry.name.includes("/") ||
          entry.name.includes("\\") ||
          Buffer.byteLength(entry.name, "utf8") > 255 ||
          !["repository", "directory", "file", "symlink"].includes(entry.kind)
        ) {
          fail("invalid-legacy-batch", "An explicit dependency entry has an unsafe name or kind.");
        }
        entryCount += 1;
        if (entryCount > MAXIMUM_LEGACY_EXPLICIT_CATALOG_ENTRIES) {
          fail("invalid-legacy-batch", "The explicit dependency catalog has too many entries.");
        }
        return Object.freeze({ name: entry.name, kind: entry.kind });
      });
      entries.sort((left, right) => Buffer.compare(Buffer.from(left.name), Buffer.from(right.name)));
      if (new Set(entries.map((entry) => entry.name)).size !== entries.length) {
        fail("invalid-legacy-batch", "Explicit dependency entry names must be unique within each root.");
      }
      return Object.freeze({ path: root.path, entries: Object.freeze(entries) });
    });
    roots.sort((left, right) => left.path.localeCompare(right.path));
    const rootPaths = roots.map((root) => root.path);
    if (
      new Set(rootPaths).size !== rootPaths.length ||
      rootPaths.some((left, index) =>
        rootPaths.some((right, other) => index !== other && isSameOrContained(right, left))
      )
    ) {
      fail("invalid-legacy-batch", "Explicit dependency roots must be unique and non-overlapping.");
    }
    return Object.freeze({
      protocol: LEGACY_DEPENDENCY_CATALOG_PROTOCOL,
      roots: Object.freeze(roots)
    });
  }

  function readLegacyBatchManifest(manifestPath) {
    let canonicalPath;
    try {
      canonicalPath = typeof manifestPath === "string" ? realpathSync(manifestPath) : undefined;
    } catch {
      fail("invalid-legacy-batch", "The legacy batch manifest is missing or unreadable.");
    }
    if (
      typeof manifestPath !== "string" ||
      !isAbsolute(manifestPath) ||
      resolve(manifestPath) !== manifestPath ||
      canonicalPath !== manifestPath
    ) {
      fail("invalid-legacy-batch", "The legacy batch manifest must be one canonical absolute regular-file path.");
    }
    const loaded = readJson(manifestPath, MAXIMUM_LEGACY_BATCH_MANIFEST_BYTES, "Legacy batch manifest", undefined);
    const value = loaded.value;
    const catalogManifest = value?.protocol === LEGACY_BATCH_MANIFEST_PROTOCOL_V2;
    exactKeys(
      value,
      catalogManifest ? ["protocol", "dependencyCatalog", "candidates"] : ["protocol", "dependencyRoots", "candidates"],
      "Legacy batch manifest"
    );
    if (
      ![LEGACY_BATCH_MANIFEST_PROTOCOL, LEGACY_BATCH_MANIFEST_PROTOCOL_V2].includes(value.protocol) ||
      !Array.isArray(value.candidates) ||
      value.candidates.length < 1 ||
      value.candidates.length > MAXIMUM_LEGACY_BATCH_CANDIDATES
    ) {
      fail("invalid-legacy-batch", "The legacy batch manifest has an unsupported protocol or item count.");
    }
    const dependencyCatalog = catalogManifest ? normalizeLegacyDependencyCatalog(value.dependencyCatalog) : undefined;
    const dependencyRoots = catalogManifest
      ? dependencyCatalog.roots.map((root) => root.path)
      : value.dependencyRoots.map((root) => {
          if (typeof root !== "string" || !isAbsolute(root) || resolve(root) !== root) {
            fail("invalid-legacy-batch", "Every dependency root must be an explicit canonical absolute path.");
          }
          return root;
        });
    if (!catalogManifest) {
      if (
        dependencyRoots.length < 1 ||
        dependencyRoots.length > MAXIMUM_DISCOVERY_ROOTS ||
        new Set(dependencyRoots).size !== dependencyRoots.length ||
        dependencyRoots.some((left, index) =>
          dependencyRoots.some((right, other) => index !== other && isSameOrContained(right, left))
        )
      ) {
        fail("invalid-legacy-batch", "Dependency roots must be unique and non-overlapping.");
      }
    }
    const candidates = value.candidates.map((candidate) => {
      exactKeys(
        candidate,
        ["slug", "path", "root", "ownerTask", "generatedRoots", "generatedFiles"],
        "Legacy batch candidate"
      );
      assertSlug(candidate.slug);
      assertOwner(candidate.ownerTask);
      if (
        typeof candidate.path !== "string" ||
        typeof candidate.root !== "string" ||
        !isAbsolute(candidate.path) ||
        !isAbsolute(candidate.root) ||
        resolve(candidate.path) !== candidate.path ||
        resolve(candidate.root) !== candidate.root ||
        dirname(candidate.path) !== candidate.root ||
        basename(candidate.path) !== candidate.slug ||
        (catalogManifest
          ? !dependencyRoots.includes(candidate.root) ||
            !dependencyCatalog.roots
              .find((root) => root.path === candidate.root)
              ?.entries.some((entry) => entry.name === candidate.slug && entry.kind === "repository")
          : !dependencyRoots.some((root) => isContained(root, candidate.path)))
      ) {
        fail(
          "invalid-legacy-batch",
          "Every candidate must be the named direct child of an explicit root inside the dependency scope."
        );
      }
      const allowlist = normalizeLegacyGeneratedAllowlist(candidate.generatedRoots, candidate.generatedFiles);
      return Object.freeze({
        slug: candidate.slug,
        path: candidate.path,
        root: candidate.root,
        ownerTask: candidate.ownerTask,
        generatedRoots: Object.freeze(allowlist.filter((item) => item.kind === "directory").map((item) => item.path)),
        generatedFiles: Object.freeze(allowlist.filter((item) => item.kind === "file").map((item) => item.path))
      });
    });
    candidates.sort((left, right) => left.slug.localeCompare(right.slug));
    if (
      new Set(candidates.map((candidate) => candidate.slug)).size !== candidates.length ||
      new Set(candidates.map((candidate) => candidate.path)).size !== candidates.length
    ) {
      fail("invalid-legacy-batch", "Legacy batch candidate slugs and paths must be unique.");
    }
    const normalized = Object.freeze({
      protocol: value.protocol,
      dependencyRoots: Object.freeze([...dependencyRoots].sort()),
      ...(dependencyCatalog === undefined ? {} : { dependencyCatalog }),
      candidates: Object.freeze(candidates)
    });
    revalidatePathIdentity(manifestPath, loaded.identity, "Legacy batch manifest");
    return Object.freeze({
      path: manifestPath,
      identity: loaded.identity,
      normalized,
      sha256: sha256(`${JSON.stringify(normalized)}\n`)
    });
  }

  function revalidateLegacyBatchManifest(manifest) {
    const current = readLegacyBatchManifest(manifest.path);
    if (!sameIdentity(current.identity, manifest.identity) || current.sha256 !== manifest.sha256) {
      fail("legacy-batch-review-changed", "The reviewed batch manifest changed.");
    }
    return current;
  }

  function dependencyDirectoryListing(entries) {
    const kind = (entry) =>
      entry.isDirectory()
        ? "d"
        : entry.isFile()
          ? "f"
          : entry.isSymbolicLink()
            ? "l"
            : entry.isBlockDevice()
              ? "b"
              : entry.isCharacterDevice()
                ? "c"
                : entry.isFIFO()
                  ? "p"
                  : entry.isSocket()
                    ? "s"
                    : "?";
    return sha256(
      entries
        .map((entry) => `${kind(entry)}\0${entry.name}\n`)
        .sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)))
        .join("")
    );
  }

  function explicitCatalogEntryKind(metadata) {
    if (metadata.isSymbolicLink()) return "symlink";
    if (metadata.isDirectory()) return "directory";
    if (metadata.isFile()) return "file";
    return "special";
  }

  function explicitCatalogEntryReceiptsSha256(receipts) {
    return sha256(receipts.map((receipt) => `${receipt.name}\0${receipt.sha256}\n`).join(""));
  }

  function explicitCatalogRepositoryGroupsSha256(groups) {
    return sha256(
      groups
        .map((group) => `${group.memberPaths.join("\0")}\0${group.recordSha256}\n`)
        .sort()
        .join("")
    );
  }

  function explicitCatalogCohortSha256(roots, cleanupCandidates, repositoryGroups) {
    return sha256(
      `${JSON.stringify({
        protocol: "openwrangler-legacy-dependency-cohort-v1",
        roots: roots.map((root) => ({
          path: root.path,
          identity: root.identity,
          entriesSha256: root.entriesSha256
        })),
        cleanupCandidates,
        repositoryGroups
      })}\n`
    );
  }

  function assertCatalogDirectoryEntriesAreNotRepository(entries, directoryPath) {
    const names = new Set(entries.map((entry) => entry.name));
    if (names.has(".git")) {
      fail(
        "legacy-provider-scan-unsafe",
        `Explicit dependency entry ${directoryPath} is a repository but was cataloged as an ordinary directory.`
      );
    }
    if (["HEAD", "objects", "refs"].every((name) => names.has(name))) {
      fail(
        "legacy-provider-scan-unsafe",
        `Explicit dependency entry ${directoryPath} has a bare-repository signature but was cataloged as ordinary.`
      );
    }
  }

  function assertCatalogMount(descriptor, expectedMountId, label) {
    if (descriptorMountId(descriptor, label) !== expectedMountId) {
      fail("legacy-provider-scan-unsafe", `${label} crosses a mount boundary.`);
    }
  }

  function openExplicitCatalogDirectoryAt(parentDescriptor, name, observed, expectedMountId, label) {
    let opened;
    try {
      opened = openArtifactChildDirectoryDescriptor(parentDescriptor, name, observed, label);
      assertCatalogMount(opened.descriptor, expectedMountId, label);
      return opened;
    } catch (error) {
      if (opened !== undefined) closeSync(opened.descriptor);
      if (!(error instanceof CheckoutLifecycleError)) throw error;
      if (error.code === "artifact-changed") {
        fail("legacy-dependency-universe-changed", `${label} changed before descriptor-relative inspection.`);
      }
      if (error.code.startsWith("artifact-")) {
        fail("legacy-provider-scan-unsafe", `${label} is unsafe: ${error.message}`);
      }
      throw error;
    }
  }

  function openExplicitCatalogAbsoluteDirectory(path, label, expectedIdentity = undefined, retainParent = false) {
    if (path === "/" || dirname(path) === path) {
      fail("legacy-provider-scan-unsafe", `${label} cannot be a filesystem root.`);
    }
    hooks?.beforeExplicitCatalogAbsoluteDirectoryOpen?.(Object.freeze({ path, label }));
    let parent;
    try {
      parent = openArtifactDirectoryDescriptor(dirname(path), `${label} parent`, undefined, false);
      const parentMountId = descriptorMountId(parent.descriptor, `${label} parent`);
      const observed = lstatSync(artifactDescriptorPath(parent.descriptor, basename(path)), { bigint: true });
      if (
        !observed.isDirectory() ||
        observed.isSymbolicLink() ||
        !currentUserOwns(observed) ||
        (expectedIdentity !== undefined && !sameIdentity(identityOf(observed), expectedIdentity))
      ) {
        fail("legacy-provider-scan-unsafe", `${label} is not the expected owned directory.`);
      }
      const opened = openExplicitCatalogDirectoryAt(parent.descriptor, basename(path), observed, parentMountId, label);
      const result = Object.freeze({
        ...opened,
        mountId: parentMountId,
        parentMetadata: parent.metadata,
        ...(retainParent ? { parentDescriptor: parent.descriptor } : {})
      });
      if (retainParent) parent = undefined;
      return result;
    } catch (error) {
      if (error instanceof CheckoutLifecycleError) {
        if (error.code === "artifact-changed") {
          fail("legacy-dependency-universe-changed", `${label} changed before descriptor-relative inspection.`);
        }
        if (error.code.startsWith("artifact-")) {
          fail("legacy-provider-scan-unsafe", `${label} is unsafe: ${error.message}`);
        }
        throw error;
      }
      fail("legacy-provider-scan-unsafe", `${label} could not be opened without following links: ${error.message}`);
    } finally {
      if (parent !== undefined) closeSync(parent.descriptor);
    }
  }

  function openExplicitCatalogFileDescriptor(parentDescriptor, name, observed, expectedMountId, label) {
    let descriptor;
    try {
      descriptor = openSync(
        artifactDescriptorPath(parentDescriptor, name),
        constants.O_RDONLY | constants.O_NOFOLLOW | (constants.O_NONBLOCK ?? 0) | (constants.O_CLOEXEC ?? 0)
      );
      const metadata = fstatSync(descriptor, { bigint: true });
      if (!metadata.isFile() || !currentUserOwns(metadata) || !sameArtifactStat(metadata, observed)) {
        fail("legacy-dependency-universe-changed", `${label} changed before descriptor-relative inspection.`);
      }
      assertCatalogMount(descriptor, expectedMountId, label);
      return Object.freeze({ descriptor, metadata });
    } catch (error) {
      if (descriptor !== undefined) closeSync(descriptor);
      if (error instanceof CheckoutLifecycleError) throw error;
      fail("legacy-dependency-universe-changed", `${label} could not be opened without following links.`);
    }
  }

  function readExplicitCatalogFile(parentDescriptor, name, observed, expectedMountId, maximumBytes, label) {
    const opened = openExplicitCatalogFileDescriptor(parentDescriptor, name, observed, expectedMountId, label);
    try {
      if (opened.metadata.size > BigInt(maximumBytes)) {
        fail("legacy-provider-scan-unsafe", `${label} exceeds its fixed byte limit.`);
      }
      const bytes = Buffer.allocUnsafe(Number(opened.metadata.size));
      let offset = 0;
      while (offset < bytes.length) {
        const count = readSync(opened.descriptor, bytes, offset, bytes.length - offset, offset);
        if (count === 0) fail("legacy-dependency-universe-changed", `${label} changed while it was read.`);
        offset += count;
      }
      const after = fstatSync(opened.descriptor, { bigint: true });
      const named = lstatSync(artifactDescriptorPath(parentDescriptor, name), { bigint: true });
      if (!sameArtifactStat(opened.metadata, after) || !sameArtifactStat(opened.metadata, named)) {
        fail("legacy-dependency-universe-changed", `${label} changed while it was read.`);
      }
      let text;
      try {
        text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      } catch {
        fail("legacy-provider-scan-unsafe", `${label} is not strict UTF-8.`);
      }
      return Object.freeze({
        text,
        bytes,
        identity: identityOf(opened.metadata),
        stat: opened.metadata,
        sha256: sha256(bytes)
      });
    } finally {
      closeSync(opened.descriptor);
    }
  }

  function explicitCatalogStatRecord(metadata) {
    return Object.freeze({
      ...artifactStatRecord(metadata),
      nlink: metadata.nlink.toString()
    });
  }

  function captureExplicitCatalogDirectoryTree(
    directoryDescriptor,
    directoryPath,
    directoryMetadata,
    budget,
    expectedMountId
  ) {
    const hash = createHash("sha256");
    const rootDevice = directoryMetadata.dev;
    let entryCount = 0;

    const add = (record, countAgainstBudget = true) => {
      entryCount += 1;
      if (countAgainstBudget) budget.visitedEntries += 1;
      if (budget.visitedEntries > MAXIMUM_LEGACY_EXPLICIT_DIRECTORY_ENTRIES) {
        fail(
          "legacy-provider-scan-unsafe",
          "The recursively attested ordinary-directory catalog exceeded its fixed entry limit."
        );
      }
      hash.update(`${JSON.stringify(record)}\n`);
    };

    const visit = (descriptor, logicalPath, observed, relativePath, depth) => {
      if (depth > MAXIMUM_DISCOVERY_DEPTH) {
        fail("legacy-provider-scan-unsafe", "An ordinary dependency directory exceeds its fixed depth limit.");
      }
      const before = fstatSync(descriptor, { bigint: true });
      if (
        !before.isDirectory() ||
        !currentUserOwns(before) ||
        before.dev !== rootDevice ||
        !sameArtifactStat(before, observed)
      ) {
        fail("legacy-dependency-universe-changed", `Ordinary dependency directory ${logicalPath} changed.`);
      }
      assertCatalogMount(descriptor, expectedMountId, `Ordinary dependency directory ${logicalPath}`);
      add({ kind: "directory", path: relativePath, ...explicitCatalogStatRecord(before) }, relativePath !== "");
      hooks?.beforeExplicitCatalogDirectoryRead?.(Object.freeze({ rootPath: directoryPath, relativePath }));
      const entries = readArtifactDirectoryBounded(
        descriptor,
        `Ordinary dependency directory ${logicalPath}`,
        MAXIMUM_LEGACY_EXPLICIT_DIRECTORY_ENTRIES - budget.visitedEntries + 1
      ).sort((left, right) => Buffer.compare(left.nameBytes, right.nameBytes));
      assertCatalogDirectoryEntriesAreNotRepository(entries, logicalPath);
      for (const entry of entries) {
        const reference = artifactDescriptorPath(descriptor, entry.name);
        const childPath = join(logicalPath, entry.name);
        const childRelative = relativePath === "" ? entry.name : `${relativePath}/${entry.name}`;
        const metadata = lstatSync(reference, { bigint: true });
        if (!currentUserOwns(metadata) || metadata.dev !== rootDevice) {
          fail("legacy-provider-scan-unsafe", `Ordinary dependency entry ${childPath} is not locally owned.`);
        }
        if (metadata.isDirectory() && !metadata.isSymbolicLink()) {
          const child = openExplicitCatalogDirectoryAt(
            descriptor,
            entry.name,
            metadata,
            expectedMountId,
            `Ordinary dependency directory ${childPath}`
          );
          try {
            visit(child.descriptor, childPath, child.metadata, childRelative, depth + 1);
          } finally {
            closeSync(child.descriptor);
          }
          const named = lstatSync(reference, { bigint: true });
          if (!sameArtifactStat(metadata, named)) {
            fail("legacy-dependency-universe-changed", `Ordinary dependency directory ${childPath} changed.`);
          }
          continue;
        }
        if (metadata.isFile() && !metadata.isSymbolicLink()) {
          const file = openExplicitCatalogFileDescriptor(
            descriptor,
            entry.name,
            metadata,
            expectedMountId,
            `Ordinary dependency file ${childPath}`
          );
          try {
            const after = fstatSync(file.descriptor, { bigint: true });
            const named = lstatSync(reference, { bigint: true });
            if (!sameArtifactStat(metadata, after) || !sameArtifactStat(metadata, named)) {
              fail("legacy-dependency-universe-changed", `Ordinary dependency file ${childPath} changed.`);
            }
            add({ kind: "file", path: childRelative, ...explicitCatalogStatRecord(metadata) });
          } finally {
            closeSync(file.descriptor);
          }
          continue;
        }
        if (metadata.isSymbolicLink()) {
          const target = readlinkSync(reference, { encoding: "buffer" });
          if (target.byteLength > MAXIMUM_ARTIFACT_SYMLINK_BYTES) {
            fail("legacy-provider-scan-unsafe", `Ordinary dependency symlink ${childPath} is too long.`);
          }
          const after = lstatSync(reference, { bigint: true });
          if (!sameArtifactStat(metadata, after)) {
            fail("legacy-dependency-universe-changed", `Ordinary dependency symlink ${childPath} changed.`);
          }
          add({
            kind: "symlink",
            path: childRelative,
            ...explicitCatalogStatRecord(metadata),
            targetBase64: target.toString("base64")
          });
          continue;
        }
        fail("legacy-provider-scan-unsafe", `Ordinary dependency entry ${childPath} is a special file.`);
      }
      const after = fstatSync(descriptor, { bigint: true });
      if (!sameArtifactStat(before, after)) {
        fail("legacy-dependency-universe-changed", `Ordinary dependency directory ${logicalPath} changed.`);
      }
      assertCatalogMount(descriptor, expectedMountId, `Ordinary dependency directory ${logicalPath}`);
    };

    assertNoMountAtOrBelow(directoryPath);
    visit(directoryDescriptor, directoryPath, directoryMetadata, "", 0);
    assertNoMountAtOrBelow(directoryPath);
    return Object.freeze({ entryCount: entryCount - 1, sha256: hash.digest("hex") });
  }

  function captureExplicitCatalogRepository(directoryPath, directoryHandle, directoryMountId) {
    const directoryIdentity = identityOf(directoryHandle.metadata);
    const entries = readArtifactDirectoryBounded(
      directoryHandle.descriptor,
      `Explicit dependency repository ${directoryPath}`,
      MAXIMUM_DISCOVERY_ENTRIES
    );
    const entriesByName = new Map(entries.map((entry) => [entry.name, entry]));
    const metadataFor = (name) => {
      try {
        return lstatSync(artifactDescriptorPath(directoryHandle.descriptor, name), { bigint: true });
      } catch (error) {
        if (error.code === "ENOENT") return undefined;
        throw error;
      }
    };
    const dotGitMetadata = metadataFor(".git");
    const looksBare = ["HEAD", "objects", "refs"].every((name) => entriesByName.has(name));
    if (looksBare && dotGitMetadata !== undefined) {
      fail("legacy-provider-scan-unsafe", "An explicit dependency is ambiguous between bare and worktree layouts.");
    }
    const descriptorReceipts = [];
    const pointerReceipts = [];

    if (looksBare) {
      const headMetadata = metadataFor("HEAD");
      const configMetadata = metadataFor("config");
      const objectsMetadata = metadataFor("objects");
      const refsMetadata = metadataFor("refs");
      if (
        !headMetadata?.isFile() ||
        headMetadata.isSymbolicLink() ||
        (configMetadata !== undefined && (!configMetadata.isFile() || configMetadata.isSymbolicLink())) ||
        !objectsMetadata?.isDirectory() ||
        objectsMetadata.isSymbolicLink() ||
        !refsMetadata?.isDirectory() ||
        refsMetadata.isSymbolicLink()
      ) {
        fail("legacy-provider-scan-unsafe", "An explicit dependency has an unsafe bare-repository signature.");
      }
      const head = readExplicitCatalogFile(
        directoryHandle.descriptor,
        "HEAD",
        headMetadata,
        directoryMountId,
        MAXIMUM_LEGACY_REF_BYTES,
        "Bare dependency HEAD"
      );
      descriptorReceipts.push(
        Object.freeze({
          parentDescriptor: directoryHandle.descriptor,
          name: "HEAD",
          observed: head.stat,
          mountId: directoryMountId,
          maximumBytes: MAXIMUM_LEGACY_REF_BYTES,
          sha256: head.sha256,
          label: "Bare dependency HEAD"
        })
      );
      const symbolicHead = /^ref: ([^\0\r\n]+)\n$/u.exec(head.text);
      if (symbolicHead === null) {
        if (!/^[0-9a-f]{40}(?:[0-9a-f]{24})?\n$/u.test(head.text)) {
          fail("legacy-provider-scan-unsafe", "A bare dependency has a malformed HEAD.");
        }
      } else {
        const checked = run("git", ["check-ref-format", symbolicHead[1]], {
          cwd: inheritedDescriptorPath(directoryHandle.descriptor),
          allowFailure: true,
          env: auditGitEnvironment()
        });
        if (checked.status !== 0) fail("legacy-provider-scan-unsafe", "A bare dependency has an invalid HEAD ref.");
      }
      let config = null;
      if (configMetadata !== undefined) {
        config = readExplicitCatalogFile(
          directoryHandle.descriptor,
          "config",
          configMetadata,
          directoryMountId,
          MAXIMUM_LEGACY_CONFIG_BYTES,
          "Bare dependency configuration"
        );
        descriptorReceipts.push(
          Object.freeze({
            parentDescriptor: directoryHandle.descriptor,
            name: "config",
            observed: config.stat,
            mountId: directoryMountId,
            maximumBytes: MAXIMUM_LEGACY_CONFIG_BYTES,
            sha256: config.sha256,
            label: "Bare dependency configuration"
          })
        );
        const configFile = openExplicitCatalogFileDescriptor(
          directoryHandle.descriptor,
          "config",
          configMetadata,
          directoryMountId,
          "Bare dependency configuration"
        );
        try {
          const bare = run(
            "git",
            [
              "config",
              "--file",
              inheritedDescriptorPath(configFile.descriptor),
              "--no-includes",
              "--type=bool",
              "--get",
              "core.bare"
            ],
            {
              cwd: inheritedDescriptorPath(directoryHandle.descriptor),
              allowFailure: true,
              env: auditGitEnvironment()
            }
          );
          if (bare.status !== 0 || bare.stdout.trim() !== "true") {
            fail("legacy-provider-scan-unsafe", "A dependency has bare markers without core.bare=true.");
          }
        } finally {
          closeSync(configFile.descriptor);
        }
      }
      const objects = openExplicitCatalogDirectoryAt(
        directoryHandle.descriptor,
        "objects",
        objectsMetadata,
        directoryMountId,
        "Bare dependency object directory"
      );
      let refs;
      try {
        refs = openExplicitCatalogDirectoryAt(
          directoryHandle.descriptor,
          "refs",
          refsMetadata,
          directoryMountId,
          "Bare dependency refs directory"
        );
      } catch (error) {
        closeSync(objects.descriptor);
        throw error;
      }
      let transferredObjects = false;
      try {
        assertCatalogMount(objects.descriptor, directoryMountId, "Bare dependency object directory");
        assertCatalogMount(refs.descriptor, directoryMountId, "Bare dependency refs directory");
        const result = Object.freeze({
          path: directoryPath,
          pathIdentity: directoryIdentity,
          pathMetadata: directoryHandle.metadata,
          pathDescriptor: directoryHandle.descriptor,
          pathMountId: directoryMountId,
          kind: "bare",
          gitDirectory: directoryPath,
          gitIdentity: directoryIdentity,
          gitDescriptor: directoryHandle.descriptor,
          gitMountId: directoryMountId,
          commonGitDirectory: directoryPath,
          commonGitIdentity: directoryIdentity,
          commonGitDescriptor: directoryHandle.descriptor,
          commonGitMountId: directoryMountId,
          objectsDirectory: join(directoryPath, "objects"),
          objectsIdentity: identityOf(objects.metadata),
          objectsMetadata: objects.metadata,
          objectsDescriptor: objects.descriptor,
          objectsMountId: directoryMountId,
          repositoryState: Object.freeze({
            kind: "bare",
            objectsDirectory: join(directoryPath, "objects"),
            objectsIdentity: identityOf(objects.metadata),
            head: Object.freeze({ path: join(directoryPath, "HEAD"), identity: head.identity, sha256: head.sha256 }),
            config:
              config === null
                ? Object.freeze({ path: join(directoryPath, "config"), present: false })
                : Object.freeze({
                    path: join(directoryPath, "config"),
                    present: true,
                    identity: config.identity,
                    sha256: config.sha256
                  }),
            refs: Object.freeze({ path: join(directoryPath, "refs"), identity: identityOf(refs.metadata) })
          }),
          pointerReceipts: Object.freeze(pointerReceipts),
          descriptorReceipts: Object.freeze(descriptorReceipts),
          ownedDescriptors: Object.freeze([objects.descriptor])
        });
        transferredObjects = true;
        return result;
      } finally {
        closeSync(refs.descriptor);
        if (!transferredObjects) closeSync(objects.descriptor);
      }
    }

    if (
      dotGitMetadata === undefined ||
      dotGitMetadata.isSymbolicLink() ||
      !currentUserOwns(dotGitMetadata) ||
      (!dotGitMetadata.isDirectory() && !dotGitMetadata.isFile())
    ) {
      fail("legacy-provider-scan-unsafe", "An explicit repository has an unsafe or missing .git entry.");
    }
    hooks?.beforeExplicitRepositoryGitOpen?.(
      Object.freeze({ repositoryPath: directoryPath, gitKind: dotGitMetadata.isDirectory() ? "directory" : "file" })
    );
    if (dotGitMetadata.isFile()) {
      const pointer = readExplicitCatalogFile(
        directoryHandle.descriptor,
        ".git",
        dotGitMetadata,
        directoryMountId,
        MAXIMUM_WORKTREE_FIELD_BYTES,
        "Explicit worktree .git pointer"
      );
      const match = /^gitdir: ([^\0\r\n]+)\n$/u.exec(pointer.text);
      if (match === null) fail("legacy-provider-scan-unsafe", "An explicit worktree has a malformed .git pointer.");
      const gitDirectory = resolve(directoryPath, match[1]);
      if (match[1] !== gitDirectory) {
        fail("legacy-provider-scan-unsafe", "An explicit worktree .git pointer is not an exact canonical path.");
      }
      pointerReceipts.push(
        Object.freeze({ path: join(directoryPath, ".git"), identity: pointer.identity, sha256: pointer.sha256 })
      );
      descriptorReceipts.push(
        Object.freeze({
          parentDescriptor: directoryHandle.descriptor,
          name: ".git",
          observed: pointer.stat,
          mountId: directoryMountId,
          maximumBytes: MAXIMUM_WORKTREE_FIELD_BYTES,
          sha256: pointer.sha256,
          label: "Explicit worktree .git pointer"
        })
      );
      return Object.freeze({
        path: directoryPath,
        pathIdentity: directoryIdentity,
        pathMetadata: directoryHandle.metadata,
        pathDescriptor: directoryHandle.descriptor,
        pathMountId: directoryMountId,
        kind: "linked-worktree-pending",
        gitDirectory,
        pointerReceipts: Object.freeze(pointerReceipts),
        descriptorReceipts: Object.freeze(descriptorReceipts),
        ownedDescriptors: Object.freeze([])
      });
    }

    const gitDirectory = join(directoryPath, ".git");
    const gitHandle = openExplicitCatalogDirectoryAt(
      directoryHandle.descriptor,
      ".git",
      dotGitMetadata,
      directoryMountId,
      "Explicit dependency Git directory"
    );
    let objects;
    let transferredDescriptors = false;
    try {
      assertCatalogMount(gitHandle.descriptor, directoryMountId, "Explicit dependency Git directory");
      let commondirMetadata;
      try {
        commondirMetadata = lstatSync(artifactDescriptorPath(gitHandle.descriptor, "commondir"), { bigint: true });
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      if (commondirMetadata !== undefined) {
        fail("legacy-provider-scan-unsafe", "A standalone explicit repository has an unexpected commondir pointer.");
      }
      let objectsMetadata;
      try {
        objectsMetadata = lstatSync(artifactDescriptorPath(gitHandle.descriptor, "objects"), { bigint: true });
      } catch {
        fail("legacy-provider-scan-unsafe", "An explicit dependency object directory is missing.");
      }
      if (!objectsMetadata.isDirectory() || objectsMetadata.isSymbolicLink() || !currentUserOwns(objectsMetadata)) {
        fail("legacy-provider-scan-unsafe", "An explicit dependency object directory is unsafe.");
      }
      objects = openExplicitCatalogDirectoryAt(
        gitHandle.descriptor,
        "objects",
        objectsMetadata,
        directoryMountId,
        "Explicit dependency object directory"
      );
      assertCatalogMount(objects.descriptor, directoryMountId, "Explicit dependency object directory");
      const result = Object.freeze({
        path: directoryPath,
        pathIdentity: directoryIdentity,
        pathMetadata: directoryHandle.metadata,
        pathDescriptor: directoryHandle.descriptor,
        pathMountId: directoryMountId,
        kind: "standalone",
        gitDirectory,
        gitIdentity: identityOf(gitHandle.metadata),
        gitMetadata: gitHandle.metadata,
        gitDescriptor: gitHandle.descriptor,
        gitMountId: directoryMountId,
        commonGitDirectory: gitDirectory,
        commonGitIdentity: identityOf(gitHandle.metadata),
        commonGitMetadata: gitHandle.metadata,
        commonGitDescriptor: gitHandle.descriptor,
        commonGitMountId: directoryMountId,
        objectsDirectory: join(gitDirectory, "objects"),
        objectsIdentity: identityOf(objects.metadata),
        objectsMetadata: objects.metadata,
        objectsDescriptor: objects.descriptor,
        objectsMountId: directoryMountId,
        repositoryState: Object.freeze({
          kind: "worktree",
          objectsDirectory: join(gitDirectory, "objects"),
          objectsIdentity: identityOf(objects.metadata)
        }),
        pointerReceipts: Object.freeze(pointerReceipts),
        descriptorReceipts: Object.freeze(descriptorReceipts),
        ownedDescriptors: Object.freeze([gitHandle.descriptor, objects.descriptor])
      });
      transferredDescriptors = true;
      return result;
    } finally {
      if (!transferredDescriptors) {
        if (objects !== undefined) closeSync(objects.descriptor);
        closeSync(gitHandle.descriptor);
      }
    }
  }

  function resolveExplicitCatalogLinkedRepository(repository, baseGroupsByWorktreesPath) {
    const registryPath = dirname(repository.gitDirectory);
    const baseGroup = baseGroupsByWorktreesPath.get(registryPath);
    const adminName = basename(repository.gitDirectory);
    if (
      baseGroup === undefined ||
      adminName === "" ||
      adminName === "." ||
      adminName === ".." ||
      join(registryPath, adminName) !== repository.gitDirectory
    ) {
      fail("legacy-provider-scan-unsafe", "A linked worktree points outside the reviewed Git registries.");
    }
    let registryMetadata;
    try {
      registryMetadata = lstatSync(artifactDescriptorPath(baseGroup.commonGitDescriptor, "worktrees"), {
        bigint: true
      });
    } catch {
      fail("legacy-provider-scan-unsafe", "A linked worktree points to a missing reviewed Git registry.");
    }
    if (!registryMetadata.isDirectory() || registryMetadata.isSymbolicLink() || !currentUserOwns(registryMetadata)) {
      fail("legacy-provider-scan-unsafe", "A linked worktree points to an unsafe reviewed Git registry.");
    }
    const registry = openExplicitCatalogDirectoryAt(
      baseGroup.commonGitDescriptor,
      "worktrees",
      registryMetadata,
      baseGroup.commonGitMountId,
      "Explicit Git linked-worktree registry"
    );
    let gitHandle;
    let transferred = false;
    try {
      let gitMetadata;
      try {
        gitMetadata = lstatSync(artifactDescriptorPath(registry.descriptor, adminName), { bigint: true });
      } catch {
        fail("legacy-provider-scan-unsafe", "A linked worktree points to a missing reviewed registry entry.");
      }
      if (!gitMetadata.isDirectory() || gitMetadata.isSymbolicLink() || !currentUserOwns(gitMetadata)) {
        fail("legacy-provider-scan-unsafe", "A linked worktree points to an unsafe reviewed registry entry.");
      }
      gitHandle = openExplicitCatalogDirectoryAt(
        registry.descriptor,
        adminName,
        gitMetadata,
        baseGroup.commonGitMountId,
        `Explicit linked-worktree entry ${adminName}`
      );
      let commondirMetadata;
      try {
        commondirMetadata = lstatSync(artifactDescriptorPath(gitHandle.descriptor, "commondir"), { bigint: true });
      } catch {
        fail("legacy-provider-scan-unsafe", "An explicit worktree has no common-directory pointer.");
      }
      if (!commondirMetadata.isFile() || commondirMetadata.isSymbolicLink() || !currentUserOwns(commondirMetadata)) {
        fail("legacy-provider-scan-unsafe", "An explicit worktree has an unsafe common-directory pointer.");
      }
      const pointer = readExplicitCatalogFile(
        gitHandle.descriptor,
        "commondir",
        commondirMetadata,
        baseGroup.commonGitMountId,
        MAXIMUM_WORKTREE_FIELD_BYTES,
        "Explicit worktree common-directory pointer"
      );
      const match = /^([^\0\r\n]+)\n$/u.exec(pointer.text);
      if (
        match === null ||
        match[1] !== "../.." ||
        resolve(repository.gitDirectory, match[1]) !== baseGroup.commonGitDirectory
      ) {
        fail("legacy-provider-scan-unsafe", "An explicit worktree points outside its reviewed common Git directory.");
      }
      const pointerReceipts = Object.freeze([
        ...repository.pointerReceipts,
        Object.freeze({
          path: join(repository.gitDirectory, "commondir"),
          identity: pointer.identity,
          sha256: pointer.sha256
        })
      ]);
      const descriptorReceipts = Object.freeze([
        ...repository.descriptorReceipts,
        Object.freeze({
          parentDescriptor: gitHandle.descriptor,
          name: "commondir",
          observed: pointer.stat,
          mountId: baseGroup.commonGitMountId,
          maximumBytes: MAXIMUM_WORKTREE_FIELD_BYTES,
          sha256: pointer.sha256,
          label: "Explicit worktree common-directory pointer"
        })
      ]);
      const result = Object.freeze({
        ...repository,
        kind: "linked-worktree",
        gitIdentity: identityOf(gitHandle.metadata),
        gitMetadata: gitHandle.metadata,
        gitDescriptor: gitHandle.descriptor,
        gitMountId: baseGroup.commonGitMountId,
        commonGitDirectory: baseGroup.commonGitDirectory,
        commonGitIdentity: baseGroup.commonGitIdentity,
        commonGitMetadata: baseGroup.commonGitMetadata ?? baseGroup.pathMetadata,
        commonGitDescriptor: baseGroup.commonGitDescriptor,
        commonGitMountId: baseGroup.commonGitMountId,
        objectsDirectory: baseGroup.objectsDirectory,
        objectsIdentity: baseGroup.objectsIdentity,
        objectsMetadata: baseGroup.objectsMetadata,
        objectsDescriptor: baseGroup.objectsDescriptor,
        objectsMountId: baseGroup.objectsMountId,
        repositoryState: Object.freeze({
          kind: "worktree",
          objectsDirectory: baseGroup.objectsDirectory,
          objectsIdentity: baseGroup.objectsIdentity
        }),
        pointerReceipts,
        descriptorReceipts,
        ownedDescriptors: Object.freeze([gitHandle.descriptor])
      });
      transferred = true;
      return result;
    } finally {
      closeSync(registry.descriptor);
      if (!transferred && gitHandle !== undefined) closeSync(gitHandle.descriptor);
    }
  }

  function readExplicitRepositoryAlternates(repository, objectsToGroup) {
    const alternatesPath = join(repository.objectsDirectory, "info", "alternates");
    let infoMetadata;
    try {
      infoMetadata = lstatSync(artifactDescriptorPath(repository.objectsDescriptor, "info"), { bigint: true });
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    let infoHandle;
    let file = null;
    if (infoMetadata !== undefined) {
      if (!infoMetadata.isDirectory() || infoMetadata.isSymbolicLink() || !currentUserOwns(infoMetadata)) {
        fail("legacy-provider-scan-unsafe", "An explicit repository has an unsafe objects/info directory.");
      }
      infoHandle = openExplicitCatalogDirectoryAt(
        repository.objectsDescriptor,
        "info",
        infoMetadata,
        repository.objectsMountId,
        "Explicit dependency objects/info directory"
      );
      assertCatalogMount(
        infoHandle.descriptor,
        repository.objectsMountId,
        "Explicit dependency objects/info directory"
      );
      let alternatesMetadata;
      try {
        alternatesMetadata = lstatSync(artifactDescriptorPath(infoHandle.descriptor, "alternates"), { bigint: true });
      } catch (error) {
        if (error.code !== "ENOENT") {
          closeSync(infoHandle.descriptor);
          throw error;
        }
      }
      if (alternatesMetadata !== undefined) {
        if (
          !alternatesMetadata.isFile() ||
          alternatesMetadata.isSymbolicLink() ||
          !currentUserOwns(alternatesMetadata)
        ) {
          closeSync(infoHandle.descriptor);
          fail("legacy-provider-scan-unsafe", "An explicit repository has an unsafe alternates file.");
        }
        hooks?.beforeExplicitAlternatesOpen?.(Object.freeze({ objectsPath: repository.objectsDirectory }));
        try {
          file = readExplicitCatalogFile(
            infoHandle.descriptor,
            "alternates",
            alternatesMetadata,
            repository.objectsMountId,
            MAXIMUM_LEGACY_CONFIG_BYTES,
            "Explicit dependency object alternates"
          );
        } catch (error) {
          closeSync(infoHandle.descriptor);
          throw error;
        }
      }
    }
    let retainedInfo = false;
    try {
      const text = file?.text ?? "";
      if (text !== "" && !text.endsWith("\n")) {
        fail("legacy-provider-scan-unsafe", "An explicit repository has malformed object alternates.");
      }
      const targets = text
        .split("\n")
        .filter(Boolean)
        .map((line) => {
          if (line.includes("\0") || line.includes("\r")) {
            fail("legacy-provider-scan-unsafe", "An explicit repository has malformed object alternates.");
          }
          const requested = resolve(repository.objectsDirectory, line);
          if (line !== requested) {
            fail("legacy-provider-scan-unsafe", "An explicit repository alternate is not an exact canonical path.");
          }
          const targetGroup = objectsToGroup.get(requested);
          if (targetGroup === undefined) {
            fail("legacy-provider-scan-unsafe", "An explicit repository alternate is outside the reviewed catalog.");
          }
          let namedMetadata;
          try {
            namedMetadata = lstatSync(artifactDescriptorPath(targetGroup.commonGitDescriptor, "objects"), {
              bigint: true
            });
          } catch {
            fail("legacy-dependency-universe-changed", "A reviewed alternate object directory disappeared.");
          }
          if (
            !namedMetadata.isDirectory() ||
            namedMetadata.isSymbolicLink() ||
            !sameArtifactStat(namedMetadata, targetGroup.objectsMetadata)
          ) {
            fail("legacy-dependency-universe-changed", "A reviewed alternate object directory changed.");
          }
          hooks?.beforeExplicitAlternateTargetOpen?.(
            Object.freeze({
              objectsPath: repository.objectsDirectory,
              targetObjectsPath: targetGroup.objectsDirectory
            })
          );
          const target = openExplicitCatalogDirectoryAt(
            targetGroup.commonGitDescriptor,
            "objects",
            namedMetadata,
            targetGroup.commonGitMountId,
            "Explicit dependency alternate object directory"
          );
          closeSync(target.descriptor);
          return Object.freeze({
            requested,
            canonical: targetGroup.objectsDirectory,
            identity: targetGroup.objectsIdentity
          });
        });
      const result = Object.freeze({
        path: alternatesPath,
        present: file !== null,
        identity: file?.identity ?? null,
        text,
        targets: Object.freeze(targets),
        runtime: Object.freeze({
          infoDescriptor: infoHandle?.descriptor,
          infoMetadata,
          fileStat: file?.stat,
          mountId: repository.objectsMountId
        })
      });
      retainedInfo = true;
      return result;
    } finally {
      if (!retainedInfo && infoHandle !== undefined) closeSync(infoHandle.descriptor);
    }
  }

  function revalidateExplicitCatalogRepository(repository) {
    for (const receipt of repository.descriptorReceipts) {
      const current = readExplicitCatalogFile(
        receipt.parentDescriptor,
        receipt.name,
        receipt.observed,
        receipt.mountId,
        receipt.maximumBytes,
        receipt.label
      );
      if (current.sha256 !== receipt.sha256) {
        fail("legacy-dependency-universe-changed", `${receipt.label} changed during inspection.`);
      }
    }
    const descriptorChecks = [
      {
        descriptor: repository.pathDescriptor,
        metadata: repository.pathMetadata,
        mountId: repository.pathMountId,
        path: repository.path,
        identity: repository.pathIdentity,
        label: "Explicit dependency repository"
      },
      {
        descriptor: repository.gitDescriptor,
        metadata: repository.gitMetadata ?? repository.pathMetadata,
        mountId: repository.gitMountId,
        path: repository.gitDirectory,
        identity: repository.gitIdentity,
        label: "Explicit dependency Git directory",
        anchoredByGroup: repository.kind === "linked-worktree"
      },
      {
        descriptor: repository.commonGitDescriptor,
        metadata: repository.commonGitMetadata ?? repository.pathMetadata,
        mountId: repository.commonGitMountId,
        path: repository.commonGitDirectory,
        identity: repository.commonGitIdentity,
        label: "Explicit dependency common Git directory",
        anchoredByGroup: repository.kind === "linked-worktree"
      },
      {
        descriptor: repository.objectsDescriptor,
        metadata: repository.objectsMetadata,
        mountId: repository.objectsMountId,
        path: repository.objectsDirectory,
        identity: repository.objectsIdentity,
        label: "Explicit dependency object directory",
        anchoredByGroup: repository.kind === "linked-worktree"
      }
    ];
    const seen = new Set();
    for (const check of descriptorChecks) {
      if (!seen.has(check.descriptor)) {
        const current = fstatSync(check.descriptor, { bigint: true });
        if (!sameArtifactStat(check.metadata, current)) {
          fail("legacy-dependency-universe-changed", `${check.label} changed during inspection.`);
        }
        assertCatalogMount(check.descriptor, check.mountId, check.label);
        seen.add(check.descriptor);
      }
      if (!check.anchoredByGroup) {
        const reopened = openExplicitCatalogAbsoluteDirectory(check.path, check.label, check.identity);
        try {
          if (descriptorMountId(reopened.descriptor, check.label) !== check.mountId) {
            fail("legacy-dependency-universe-changed", `${check.label} changed mounts during inspection.`);
          }
        } finally {
          closeSync(reopened.descriptor);
        }
      }
    }
  }

  function revalidateExplicitRepositoryAlternates(repository, prior, objectsToGroup) {
    if (prior.runtime.infoDescriptor !== undefined) {
      const current = fstatSync(prior.runtime.infoDescriptor, { bigint: true });
      if (!sameArtifactStat(prior.runtime.infoMetadata, current)) {
        fail("legacy-dependency-universe-changed", "An explicit objects/info directory changed.");
      }
      assertCatalogMount(
        prior.runtime.infoDescriptor,
        prior.runtime.mountId,
        "Explicit dependency objects/info directory"
      );
    }
    const next = readExplicitRepositoryAlternates(repository, objectsToGroup);
    try {
      const comparable = (value) =>
        Object.freeze({
          path: value.path,
          present: value.present,
          identity: value.identity,
          text: value.text,
          targets: value.targets
        });
      if (!isDeepStrictEqual(comparable(prior), comparable(next))) {
        fail("legacy-dependency-universe-changed", "Explicit dependency object alternates changed.");
      }
    } finally {
      if (next.runtime.infoDescriptor !== undefined) closeSync(next.runtime.infoDescriptor);
    }
  }

  function validateExplicitCatalogGitConfiguration(group) {
    let metadata;
    try {
      metadata = lstatSync(artifactDescriptorPath(group.commonGitDescriptor, "config"), { bigint: true });
    } catch {
      fail("legacy-provider-scan-unsafe", "An explicit Git group has no readable common configuration.");
    }
    if (!metadata.isFile() || metadata.isSymbolicLink() || !currentUserOwns(metadata)) {
      fail("legacy-provider-scan-unsafe", "An explicit Git group has an unsafe common configuration.");
    }
    const initial = readExplicitCatalogFile(
      group.commonGitDescriptor,
      "config",
      metadata,
      group.commonGitMountId,
      MAXIMUM_LEGACY_CONFIG_BYTES,
      "Explicit Git common configuration"
    );
    const opened = openExplicitCatalogFileDescriptor(
      group.commonGitDescriptor,
      "config",
      metadata,
      group.commonGitMountId,
      "Explicit Git common configuration"
    );
    try {
      const selector = ["config", "--file", inheritedDescriptorPath(opened.descriptor), "--no-includes"];
      const keys = run("git", [...selector, "--name-only", "--list"], {
        cwd: inheritedDescriptorPath(group.commonGitDescriptor),
        allowFailure: true,
        env: auditGitEnvironment()
      });
      if (
        keys.status !== 0 ||
        keys.stdout
          .split("\n")
          .filter(Boolean)
          .some((key) => {
            const normalized = key.toLowerCase();
            return normalized.startsWith("include.") || normalized.startsWith("includeif.");
          })
      ) {
        fail("legacy-provider-scan-unsafe", "An explicit Git group uses unsupported configuration includes.");
      }
      const worktreeConfig = run("git", [...selector, "--type=bool", "--get", "extensions.worktreeConfig"], {
        cwd: inheritedDescriptorPath(group.commonGitDescriptor),
        allowFailure: true,
        env: auditGitEnvironment()
      });
      if (
        ![0, 1].includes(worktreeConfig.status) ||
        (worktreeConfig.status === 0 && worktreeConfig.stdout.trim() !== "false")
      ) {
        fail("legacy-provider-scan-unsafe", "An explicit Git group uses unsupported per-worktree configuration.");
      }
    } finally {
      closeSync(opened.descriptor);
    }
    return initial;
  }

  function captureExplicitCatalogWorktreeRegistry(group) {
    const baseMembers = group.members.filter(
      (member) =>
        (member.kind === "standalone" && member.gitDirectory === group.commonGitDirectory) ||
        (member.kind === "bare" && member.path === group.commonGitDirectory)
    );
    if (baseMembers.length !== 1) {
      fail("legacy-provider-scan-unsafe", "An explicit Git group must catalog exactly one common base repository.");
    }
    const linkedMembers = group.members.filter((member) => member.kind === "linked-worktree");
    const worktreesPath = join(group.commonGitDirectory, "worktrees");
    let worktreesMetadata;
    try {
      worktreesMetadata = lstatSync(artifactDescriptorPath(group.commonGitDescriptor, "worktrees"), { bigint: true });
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    if (worktreesMetadata === undefined) {
      if (linkedMembers.length !== 0) {
        fail("legacy-provider-scan-unsafe", "An explicit Git group is missing its linked-worktree registry.");
      }
      return Object.freeze(group.members.map((member) => member.path).sort());
    }
    if (!worktreesMetadata.isDirectory() || worktreesMetadata.isSymbolicLink() || !currentUserOwns(worktreesMetadata)) {
      fail("legacy-provider-scan-unsafe", "An explicit Git group has an unsafe linked-worktree registry.");
    }
    const registry = openExplicitCatalogDirectoryAt(
      group.commonGitDescriptor,
      "worktrees",
      worktreesMetadata,
      group.commonGitMountId,
      "Explicit Git linked-worktree registry"
    );
    try {
      const entries = readArtifactDirectoryBounded(
        registry.descriptor,
        "Explicit Git linked-worktree registry",
        MAXIMUM_LEGACY_EXPLICIT_REPOSITORIES
      ).sort((left, right) => Buffer.compare(left.nameBytes, right.nameBytes));
      const membersByAdminName = new Map();
      for (const member of linkedMembers) {
        if (dirname(member.gitDirectory) !== worktreesPath) {
          fail("legacy-provider-scan-unsafe", "A linked worktree points outside its common registry.");
        }
        const name = basename(member.gitDirectory);
        if (membersByAdminName.has(name)) {
          fail("legacy-provider-scan-unsafe", "Linked worktrees claim the same registry entry.");
        }
        membersByAdminName.set(name, member);
      }
      if (
        !isDeepStrictEqual(
          entries.map((entry) => entry.name),
          [...membersByAdminName.keys()].sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)))
        )
      ) {
        fail("legacy-provider-scan-unsafe", "An explicit Git group omits or invents a linked-worktree entry.");
      }
      for (const entry of entries) {
        const member = membersByAdminName.get(entry.name);
        const adminReference = artifactDescriptorPath(registry.descriptor, entry.name);
        const adminMetadata = lstatSync(adminReference, { bigint: true });
        if (
          member === undefined ||
          !adminMetadata.isDirectory() ||
          adminMetadata.isSymbolicLink() ||
          !currentUserOwns(adminMetadata) ||
          !sameIdentity(identityOf(adminMetadata), member.gitIdentity)
        ) {
          fail("legacy-provider-scan-unsafe", "A linked-worktree registry entry is unsafe or misbound.");
        }
        const admin = openExplicitCatalogDirectoryAt(
          registry.descriptor,
          entry.name,
          adminMetadata,
          group.commonGitMountId,
          `Explicit linked-worktree entry ${entry.name}`
        );
        try {
          const adminEntries = readArtifactDirectoryBounded(
            admin.descriptor,
            `Explicit linked-worktree entry ${entry.name}`,
            MAXIMUM_DISCOVERY_ENTRIES
          );
          const gitdirEntry = adminEntries.find((item) => item.name === "gitdir");
          if (gitdirEntry === undefined) {
            fail("legacy-provider-scan-unsafe", "A linked-worktree registry entry has no reciprocal gitdir file.");
          }
          for (const adminEntry of adminEntries) {
            const reference = artifactDescriptorPath(admin.descriptor, adminEntry.name);
            const metadata = lstatSync(reference, { bigint: true });
            if (!currentUserOwns(metadata) || metadata.isSymbolicLink()) {
              fail("legacy-provider-scan-unsafe", "A linked-worktree registry entry contains an unsafe path.");
            }
            if (metadata.isDirectory()) {
              const child = openExplicitCatalogDirectoryAt(
                admin.descriptor,
                adminEntry.name,
                metadata,
                group.commonGitMountId,
                `Explicit linked-worktree directory ${adminEntry.name}`
              );
              closeSync(child.descriptor);
            } else if (metadata.isFile()) {
              const file = openExplicitCatalogFileDescriptor(
                admin.descriptor,
                adminEntry.name,
                metadata,
                group.commonGitMountId,
                `Explicit linked-worktree file ${adminEntry.name}`
              );
              closeSync(file.descriptor);
            } else {
              fail("legacy-provider-scan-unsafe", "A linked-worktree registry entry contains a special file.");
            }
          }
          const gitdirMetadata = lstatSync(artifactDescriptorPath(admin.descriptor, "gitdir"), { bigint: true });
          const gitdir = readExplicitCatalogFile(
            admin.descriptor,
            "gitdir",
            gitdirMetadata,
            group.commonGitMountId,
            MAXIMUM_WORKTREE_FIELD_BYTES,
            "Explicit linked-worktree reciprocal pointer"
          );
          if (gitdir.text !== `${join(member.path, ".git")}\n`) {
            fail("legacy-provider-scan-unsafe", "A linked-worktree reciprocal pointer does not match its member.");
          }
          const adminAfter = fstatSync(admin.descriptor, { bigint: true });
          const namedAdmin = lstatSync(adminReference, { bigint: true });
          if (!sameArtifactStat(adminMetadata, adminAfter) || !sameArtifactStat(adminMetadata, namedAdmin)) {
            fail("legacy-dependency-universe-changed", "A linked-worktree registry entry changed during inspection.");
          }
        } finally {
          closeSync(admin.descriptor);
        }
      }
      const registryAfter = fstatSync(registry.descriptor, { bigint: true });
      const namedRegistry = lstatSync(artifactDescriptorPath(group.commonGitDescriptor, "worktrees"), {
        bigint: true
      });
      if (!sameArtifactStat(worktreesMetadata, registryAfter) || !sameArtifactStat(worktreesMetadata, namedRegistry)) {
        fail("legacy-dependency-universe-changed", "The linked-worktree registry changed during inspection.");
      }
      return Object.freeze(group.members.map((member) => member.path).sort());
    } finally {
      closeSync(registry.descriptor);
    }
  }

  function captureExplicitLegacyDependencyCatalog(
    dependencyCatalog,
    candidates,
    expectedCatalogSha256 = undefined,
    options = {}
  ) {
    const normalizedCatalog = normalizeLegacyDependencyCatalog(dependencyCatalog, options);
    const candidatePaths = new Set(candidates.map((candidate) => candidate.path));
    const rootEvidence = [];
    const repositories = [];
    const repositoryPathSet = new Set(
      normalizedCatalog.roots.flatMap((root) =>
        root.entries.filter((entry) => entry.kind === "repository").map((entry) => join(root.path, entry.name))
      )
    );
    if (repositoryPathSet.size > MAXIMUM_LEGACY_EXPLICIT_REPOSITORIES) {
      fail(
        "legacy-provider-scan-unsafe",
        `An explicit dependency catalog may name at most ${MAXIMUM_LEGACY_EXPLICIT_REPOSITORIES} repositories.`
      );
    }
    const traversalBudget = { visitedEntries: 0 };
    const ownedDescriptors = new Set();
    try {
      for (const root of normalizedCatalog.roots) {
        assertNoMountAtOrBelow(root.path);
        const rootHandle = openExplicitCatalogAbsoluteDirectory(
          root.path,
          `Explicit dependency root ${root.path}`,
          undefined,
          true
        );
        const rootIdentity = identityOf(rootHandle.metadata);
        let rootMountId;
        try {
          rootMountId = descriptorMountId(rootHandle.descriptor, `Explicit dependency root ${root.path}`);
          hooks?.afterExplicitCatalogRootOpen?.(Object.freeze({ rootPath: root.path }));
          const actualEntries = readArtifactDirectoryBounded(
            rootHandle.descriptor,
            "Explicit dependency root",
            MAXIMUM_LEGACY_EXPLICIT_CATALOG_ENTRIES
          ).sort((left, right) => Buffer.compare(left.nameBytes, right.nameBytes));
          assertCatalogDirectoryEntriesAreNotRepository(actualEntries, root.path);
          traversalBudget.visitedEntries += actualEntries.length;
          if (traversalBudget.visitedEntries > MAXIMUM_LEGACY_EXPLICIT_DIRECTORY_ENTRIES) {
            fail("legacy-provider-scan-unsafe", "The explicit dependency catalog has too many observed entries.");
          }
          const expectedNames = root.entries.map((entry) => entry.name);
          const actualNames = actualEntries.map((entry) => entry.name);
          if (!isDeepStrictEqual(actualNames, expectedNames)) {
            fail(
              "legacy-dependency-universe-changed",
              "An explicit dependency root no longer has its reviewed entries."
            );
          }
          const entryReceipts = [];
          for (const entry of root.entries) {
            const entryPath = join(root.path, entry.name);
            const entryReference = artifactDescriptorPath(rootHandle.descriptor, entry.name);
            const metadata = lstatSync(entryReference, { bigint: true });
            const actualKind = explicitCatalogEntryKind(metadata);
            const kindMatches =
              actualKind === entry.kind || (entry.kind === "repository" && actualKind === "directory");
            if (!kindMatches || actualKind === "special" || !currentUserOwns(metadata)) {
              fail(
                "legacy-provider-scan-unsafe",
                `Explicit dependency entry ${entryPath} has an unexpected type or owner.`
              );
            }
            hooks?.beforeExplicitCatalogEntryOpen?.(
              Object.freeze({ rootPath: root.path, entryName: entry.name, entryKind: entry.kind })
            );
            const identity = identityOf(metadata);
            let symlink = null;
            let directoryTree = null;
            if (entry.kind === "symlink") {
              const target = readlinkSync(entryReference, { encoding: "buffer" });
              if (target.byteLength > MAXIMUM_ARTIFACT_SYMLINK_BYTES) {
                fail("legacy-provider-scan-unsafe", "An explicit dependency symbolic link target is too large.");
              }
              const after = lstatSync(entryReference, { bigint: true });
              if (!sameArtifactStat(metadata, after)) {
                fail("legacy-dependency-universe-changed", "An explicit dependency symbolic link changed while read.");
              }
              symlink = Object.freeze({ byteLength: target.byteLength, sha256: sha256(target) });
            } else if (entry.kind === "file") {
              const file = openExplicitCatalogFileDescriptor(
                rootHandle.descriptor,
                entry.name,
                metadata,
                rootMountId,
                `Explicit dependency file ${entryPath}`
              );
              try {
                const after = fstatSync(file.descriptor, { bigint: true });
                const named = lstatSync(entryReference, { bigint: true });
                if (!sameArtifactStat(metadata, after) || !sameArtifactStat(metadata, named)) {
                  fail("legacy-dependency-universe-changed", `Explicit dependency file ${entryPath} changed.`);
                }
              } finally {
                closeSync(file.descriptor);
              }
            } else {
              const child = openExplicitCatalogDirectoryAt(
                rootHandle.descriptor,
                entry.name,
                metadata,
                rootMountId,
                `Explicit dependency directory ${entryPath}`
              );
              if (entry.kind === "directory") {
                try {
                  directoryTree = captureExplicitCatalogDirectoryTree(
                    child.descriptor,
                    entryPath,
                    child.metadata,
                    traversalBudget,
                    rootMountId
                  );
                } finally {
                  closeSync(child.descriptor);
                }
              } else {
                let transferredRepository = false;
                try {
                  const repository = captureExplicitCatalogRepository(entryPath, child, rootMountId);
                  repositories.push(repository);
                  ownedDescriptors.add(repository.pathDescriptor);
                  for (const descriptor of repository.ownedDescriptors) ownedDescriptors.add(descriptor);
                  transferredRepository = true;
                } finally {
                  if (!transferredRepository) closeSync(child.descriptor);
                }
              }
              const named = lstatSync(entryReference, { bigint: true });
              if (!sameArtifactStat(metadata, named)) {
                fail("legacy-dependency-universe-changed", `Explicit dependency directory ${entryPath} changed.`);
              }
            }
            const entryRecord = `${entry.kind}\0${entry.name}\0${identity.device}\0${identity.inode}\0${metadata.mode.toString()}\0${metadata.nlink.toString()}\0${metadata.size.toString()}\0${metadata.mtimeNs.toString()}\0${metadata.ctimeNs.toString()}\0${symlink === null ? "-" : `${symlink.byteLength}\0${symlink.sha256}`}\0${directoryTree === null ? "-" : `${directoryTree.entryCount}\0${directoryTree.sha256}`}\n`;
            entryReceipts.push(Object.freeze({ name: entry.name, sha256: sha256(entryRecord) }));
          }
          const confirmedEntries = readArtifactDirectoryBounded(
            rootHandle.descriptor,
            "Explicit dependency root",
            MAXIMUM_LEGACY_EXPLICIT_CATALOG_ENTRIES
          )
            .sort((left, right) => Buffer.compare(left.nameBytes, right.nameBytes))
            .map((entry) => entry.name);
          const rootAfter = fstatSync(rootHandle.descriptor, { bigint: true });
          if (
            !isDeepStrictEqual(confirmedEntries, expectedNames) ||
            !sameArtifactStat(rootHandle.metadata, rootAfter)
          ) {
            fail("legacy-dependency-universe-changed", `Explicit dependency root ${root.path} changed.`);
          }
          assertCatalogMount(rootHandle.descriptor, rootMountId, `Explicit dependency root ${root.path}`);
          const parentAfter = fstatSync(rootHandle.parentDescriptor, { bigint: true });
          const namedRoot = lstatSync(artifactDescriptorPath(rootHandle.parentDescriptor, basename(root.path)), {
            bigint: true
          });
          if (
            !sameArtifactStat(rootHandle.parentMetadata, parentAfter) ||
            !sameArtifactStat(rootHandle.metadata, namedRoot)
          ) {
            fail(
              "legacy-dependency-universe-changed",
              `Explicit dependency root ${root.path} moved during inspection.`
            );
          }
          const anchoredConfirmation = openExplicitCatalogDirectoryAt(
            rootHandle.parentDescriptor,
            basename(root.path),
            namedRoot,
            rootMountId,
            `Explicit dependency root ${root.path}`
          );
          closeSync(anchoredConfirmation.descriptor);
          rootEvidence.push(
            Object.freeze({
              path: root.path,
              identity: rootIdentity,
              entries: root.entries,
              entryReceipts: Object.freeze(entryReceipts),
              entriesSha256: explicitCatalogEntryReceiptsSha256(entryReceipts)
            })
          );
        } finally {
          closeSync(rootHandle.descriptor);
          closeSync(rootHandle.parentDescriptor);
        }
        const confirmedRoot = openExplicitCatalogAbsoluteDirectory(
          root.path,
          `Explicit dependency root ${root.path}`,
          rootIdentity
        );
        try {
          if (descriptorMountId(confirmedRoot.descriptor, `Explicit dependency root ${root.path}`) !== rootMountId) {
            fail("legacy-dependency-universe-changed", `Explicit dependency root ${root.path} changed mounts.`);
          }
        } finally {
          closeSync(confirmedRoot.descriptor);
        }
        assertNoMountAtOrBelow(root.path);
      }
      if ([...candidatePaths].some((path) => !repositoryPathSet.has(path))) {
        fail("legacy-provider-scan-unsafe", "Every batch candidate must be a repository in the explicit catalog.");
      }
      const baseGroupsByWorktreesPath = new Map();
      for (const repositoryState of repositories) {
        if (repositoryState.kind === "linked-worktree-pending") continue;
        const worktreesPath = join(repositoryState.commonGitDirectory, "worktrees");
        if (baseGroupsByWorktreesPath.has(worktreesPath)) {
          fail("legacy-provider-scan-unsafe", "An explicit Git registry has more than one cataloged base.");
        }
        baseGroupsByWorktreesPath.set(worktreesPath, repositoryState);
      }
      for (let index = 0; index < repositories.length; index += 1) {
        const repositoryState = repositories[index];
        if (repositoryState.kind !== "linked-worktree-pending") continue;
        const resolved = resolveExplicitCatalogLinkedRepository(repositoryState, baseGroupsByWorktreesPath);
        repositories[index] = resolved;
        for (const descriptor of resolved.ownedDescriptors) ownedDescriptors.add(descriptor);
      }
      const groupsByCommonPath = new Map();
      for (const repositoryState of repositories) {
        const prior = groupsByCommonPath.get(repositoryState.commonGitDirectory);
        if (prior !== undefined && !sameIdentity(prior.commonGitIdentity, repositoryState.commonGitIdentity)) {
          fail("legacy-provider-scan-unsafe", "One explicit Git group changed common-directory identity.");
        }
        if (prior === undefined) {
          groupsByCommonPath.set(repositoryState.commonGitDirectory, {
            commonGitDirectory: repositoryState.commonGitDirectory,
            commonGitIdentity: repositoryState.commonGitIdentity,
            commonGitMetadata: repositoryState.commonGitMetadata ?? repositoryState.pathMetadata,
            commonGitDescriptor: repositoryState.commonGitDescriptor,
            commonGitMountId: repositoryState.commonGitMountId,
            objectsDirectory: repositoryState.objectsDirectory,
            objectsIdentity: repositoryState.objectsIdentity,
            objectsMetadata: repositoryState.objectsMetadata,
            objectsDescriptor: repositoryState.objectsDescriptor,
            objectsMountId: repositoryState.objectsMountId,
            members: [repositoryState]
          });
        } else {
          if (
            prior.objectsDirectory !== repositoryState.objectsDirectory ||
            !sameIdentity(prior.objectsIdentity, repositoryState.objectsIdentity)
          ) {
            fail("legacy-provider-scan-unsafe", "One explicit Git group has inconsistent object storage.");
          }
          prior.members.push(repositoryState);
        }
      }
      const groups = [];
      const objectsToGroup = new Map();
      for (const group of groupsByCommonPath.values()) {
        if (objectsToGroup.has(group.objectsDirectory)) {
          fail("legacy-provider-scan-unsafe", "Distinct explicit Git groups claim the same object directory.");
        }
        objectsToGroup.set(group.objectsDirectory, group);
      }
      for (const group of groupsByCommonPath.values()) {
        const commonConfiguration = validateExplicitCatalogGitConfiguration(group);
        const worktreePaths = captureExplicitCatalogWorktreeRegistry(group);
        const memberPaths = group.members.map((member) => member.path).sort();
        if (!isDeepStrictEqual(worktreePaths, memberPaths)) {
          fail(
            "legacy-provider-scan-unsafe",
            `Explicit Git group ${group.commonGitDirectory} does not enumerate every registered worktree.`
          );
        }
        const alternates = readExplicitRepositoryAlternates(group, objectsToGroup);
        if (alternates.runtime.infoDescriptor !== undefined) ownedDescriptors.add(alternates.runtime.infoDescriptor);
        for (const target of alternates.targets) {
          const targetGroup = objectsToGroup.get(target.canonical);
          if (
            target.requested !== target.canonical ||
            targetGroup === undefined ||
            !sameIdentity(target.identity, targetGroup.objectsIdentity)
          ) {
            fail(
              "legacy-provider-scan-unsafe",
              `Explicit Git group ${group.commonGitDirectory} has an alternate outside the reviewed catalog.`
            );
          }
        }
        const memberRecords = group.members
          .map((member) => {
            const pointers = member.pointerReceipts
              .map(
                (pointer) => `${pointer.path}\0${pointer.identity.device}\0${pointer.identity.inode}\0${pointer.sha256}`
              )
              .sort()
              .join("\0");
            const bare =
              member.kind === "bare"
                ? `${member.repositoryState.head.identity.device}\0${member.repositoryState.head.identity.inode}\0${member.repositoryState.head.sha256}\0${member.repositoryState.config.present ? `${member.repositoryState.config.identity.device}\0${member.repositoryState.config.identity.inode}\0${member.repositoryState.config.sha256}` : "config-absent"}\0${member.repositoryState.refs.identity.device}\0${member.repositoryState.refs.identity.inode}`
                : "-";
            return `${member.kind}\0${member.path}\0${member.pathIdentity.device}\0${member.pathIdentity.inode}\0${member.gitDirectory}\0${member.gitIdentity.device}\0${member.gitIdentity.inode}\0${pointers}\0${bare}`;
          })
          .sort();
        const worktreePathsSha256 = sha256(`${worktreePaths.join("\0")}\0`);
        const record = `${group.commonGitDirectory}\0${group.commonGitIdentity.device}\0${group.commonGitIdentity.inode}\0${group.objectsDirectory}\0${group.objectsIdentity.device}\0${group.objectsIdentity.inode}\0${memberRecords.join("\n")}\0${worktreePathsSha256}\0${alternates.present ? `${alternates.identity.device}\0${alternates.identity.inode}` : "absent"}\0${sha256(alternates.text)}\n`;
        groups.push(
          Object.freeze({
            ...group,
            members: Object.freeze(group.members),
            memberPaths: Object.freeze(memberPaths),
            worktreePathsSha256,
            alternates,
            record
          })
        );
        const confirmedConfiguration = readExplicitCatalogFile(
          group.commonGitDescriptor,
          "config",
          commonConfiguration.stat,
          group.commonGitMountId,
          MAXIMUM_LEGACY_CONFIG_BYTES,
          "Explicit Git common configuration"
        );
        if (confirmedConfiguration.sha256 !== commonConfiguration.sha256) {
          fail("legacy-dependency-universe-changed", "An explicit Git common configuration changed.");
        }
      }
      for (const group of groups) {
        revalidateExplicitRepositoryAlternates(group, group.alternates, objectsToGroup);
        for (const member of group.members) revalidateExplicitCatalogRepository(member);
      }
      groups.sort((left, right) => left.commonGitDirectory.localeCompare(right.commonGitDirectory));
      const repositoryGroups = Object.freeze(
        groups.map((group) => Object.freeze({ memberPaths: group.memberPaths, recordSha256: sha256(group.record) }))
      );
      const repositoryRecordsSha256 = explicitCatalogRepositoryGroupsSha256(repositoryGroups);
      const catalogSha256 = sha256(
        `${rootEvidence
          .map((root) => `${root.path}\0${root.identity.device}\0${root.identity.inode}\0${root.entriesSha256}\n`)
          .join("")}${groups.map((group) => group.record).join("")}`
      );
      if (expectedCatalogSha256 !== undefined && catalogSha256 !== expectedCatalogSha256) {
        fail("legacy-dependency-universe-changed", "The reviewed explicit dependency catalog changed.");
      }
      const groupForPath = new Map(groups.flatMap((group) => group.memberPaths.map((path) => [path, group])));
      const proofFor = (providerPath, providerSlug, expected = undefined) => {
        const providerGroup = groupForPath.get(providerPath);
        if (providerGroup === undefined) {
          fail("legacy-provider-scan-unsafe", "The explicit dependency catalog omitted the candidate repository.");
        }
        if (providerGroup.memberPaths.length !== 1 || providerGroup.members[0].kind !== "standalone") {
          fail(
            "legacy-linked-worktree-not-adoptable",
            `Legacy checkout ${providerSlug} belongs to a linked-worktree provider group and stays on hold.`
          );
        }
        for (const group of groups) {
          if (group === providerGroup) continue;
          if (group.alternates.targets.some((target) => target.canonical === providerGroup.objectsDirectory)) {
            fail(
              "legacy-provider-in-use",
              `Legacy checkout ${providerSlug} still provides Git objects to ${group.commonGitDirectory}.`
            );
          }
        }
        const otherGroups = groups.filter((group) => group !== providerGroup);
        const otherGroupProofs = repositoryGroups.filter((group) => !group.memberPaths.includes(providerPath));
        const proof = Object.freeze({
          protocol: LEGACY_DEPENDENCY_UNIVERSE_PROTOCOL,
          roots: Object.freeze(rootEvidence),
          cleanupCandidates: Object.freeze(
            [...candidatePaths].sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)))
          ),
          cohortSha256: explicitCatalogCohortSha256(
            rootEvidence,
            [...candidatePaths].sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right))),
            repositoryGroups
          ),
          repositoryGroups,
          providerObjectsPath: providerGroup.objectsDirectory,
          repositoryCount: otherGroups.length,
          repositoriesSha256: explicitCatalogRepositoryGroupsSha256(otherGroupProofs)
        });
        validateLegacyDependencyUniverse(proof, providerPath);
        if (expected !== undefined && !isDeepStrictEqual(proof, expected)) {
          fail("legacy-dependency-universe-changed", "The reviewed explicit dependency catalog changed.");
        }
        return proof;
      };
      return Object.freeze({
        mode: "explicit-catalog",
        roots: Object.freeze(rootEvidence),
        visitedEntries: traversalBudget.visitedEntries,
        repositoryCount: groups.length,
        repositoryGroups,
        repositoryRecordsSha256,
        catalogEntryCount: normalizedCatalog.roots.reduce((count, root) => count + root.entries.length, 0),
        catalogSha256,
        proofFor,
        revalidate() {
          captureExplicitLegacyDependencyCatalog(normalizedCatalog, [], catalogSha256, options);
        }
      });
    } finally {
      for (const descriptor of ownedDescriptors) closeSync(descriptor);
    }
  }

  function captureLegacyBatchDependencyCatalog(dependencyRoots, candidates) {
    const providerPaths = candidates.map((candidate) => candidate.path);
    const normalized = normalizeLegacyDependencyRoots(dependencyRoots, providerPaths[0]);
    if (providerPaths.some((provider) => !normalized.some((root) => isContained(root.path, provider)))) {
      fail("legacy-provider-scan-unsafe", "Every batch candidate must be contained by the dependency roots.");
    }
    const records = [];
    const repositories = [];
    const directories = [];
    let visitedEntries = 0;

    const visit = (directoryPath, directoryIdentity, depth) => {
      captureLegacyDirectory(directoryPath, "Legacy batch dependency directory", directoryIdentity);
      const entries = readDirectoryBounded(
        directoryPath,
        MAXIMUM_DISCOVERY_ENTRIES,
        "Legacy batch dependency directory"
      ).sort((left, right) => Buffer.compare(Buffer.from(left.name), Buffer.from(right.name)));
      visitedEntries += entries.length;
      if (visitedEntries > MAXIMUM_LEGACY_BATCH_DEPENDENCY_ENTRIES) {
        fail("legacy-provider-scan-unsafe", "The batch dependency scan exceeded its fixed global entry limit.");
      }
      directories.push(
        Object.freeze({
          path: directoryPath,
          identity: directoryIdentity,
          listingSha256: dependencyDirectoryListing(entries)
        })
      );
      let isBareRepository = false;
      const hasDotGit = entries.some((item) => item.name === ".git");
      const bareRepository = captureBareDependencyRepository(directoryPath, directoryIdentity, entries);
      isBareRepository = bareRepository !== null;
      let repositoryState = bareRepository;
      if (hasDotGit) {
        if (bareRepository !== null) {
          fail("legacy-provider-scan-unsafe", "A dependency path is ambiguous between bare and worktree layouts.");
        }
        const objectsDirectory = providerScanObjectsDirectory(directoryPath, basename(directoryPath));
        if (objectsDirectory !== null) {
          repositoryState = Object.freeze({
            kind: "worktree",
            objectsDirectory,
            objectsIdentity: captureLegacyDirectory(objectsDirectory, "Legacy dependency object directory")
          });
        }
      }
      if (repositoryState !== null) {
        const { objectsDirectory, objectsIdentity } = repositoryState;
        const alternatesPath = join(objectsDirectory, "info", "alternates");
        let alternatesText = "";
        let alternatesIdentity = null;
        try {
          const metadata = lstatSync(alternatesPath, { bigint: true });
          if (!metadata.isFile() || metadata.isSymbolicLink() || !currentUserOwns(metadata)) {
            fail("legacy-provider-scan-unsafe", "A dependency repository has an unsafe alternates file.");
          }
          const alternates = readBoundedFile(
            alternatesPath,
            MAXIMUM_LEGACY_CONFIG_BYTES,
            `Legacy alternates for ${directoryPath}`
          );
          alternatesText = alternates.text;
          alternatesIdentity = alternates.identity;
        } catch (error) {
          if (error.code !== "ENOENT") throw error;
        }
        if (alternatesText !== "" && !alternatesText.endsWith("\n")) {
          fail("legacy-provider-scan-unsafe", "A dependency repository has malformed object alternates.");
        }
        const alternates = alternatesText
          .split("\n")
          .filter(Boolean)
          .map((line) => {
            if (line.includes("\0") || line.includes("\r")) {
              fail("legacy-provider-scan-unsafe", "A dependency repository has malformed object alternates.");
            }
            const requested = resolve(objectsDirectory, line);
            let canonical = requested;
            try {
              canonical = realpathSync(requested);
            } catch (error) {
              if (error.code !== "ENOENT") {
                fail("legacy-provider-scan-unsafe", "A dependency repository alternate could not be resolved.");
              }
            }
            return Object.freeze({ requested, canonical });
          });
        const bareConfigRecord =
          repositoryState.kind === "bare"
            ? repositoryState.config.present
              ? `present\0${repositoryState.config.identity.device}\0${repositoryState.config.identity.inode}\0${repositoryState.config.sha256}`
              : "absent"
            : "-";
        const record = `${repositoryState.kind}\0${directoryPath}\0${directoryIdentity.device}\0${directoryIdentity.inode}\0${objectsDirectory}\0${objectsIdentity.device}\0${objectsIdentity.inode}\0${repositoryState.kind === "bare" ? `${repositoryState.head.identity.device}\0${repositoryState.head.identity.inode}\0${repositoryState.head.sha256}\0${bareConfigRecord}\0${repositoryState.refs.identity.device}\0${repositoryState.refs.identity.inode}` : "-"}\0${sha256(alternatesText)}\n`;
        records.push(Object.freeze({ directoryPath, record }));
        repositories.push(
          Object.freeze({
            directoryPath,
            repositoryState,
            alternatesPath,
            alternatesText,
            alternatesIdentity,
            alternates: Object.freeze(alternates)
          })
        );
        if (repositories.length > MAXIMUM_DEPENDENCY_REPOSITORIES) {
          fail("legacy-provider-scan-unsafe", "The batch dependency scan found too many repositories.");
        }
        revalidateDependencyRepository(repositoryState);
      }
      const terminalWorktree = repositoryState?.kind === "worktree";
      if (!terminalWorktree && entries.some((item) => item.isSymbolicLink())) {
        fail("legacy-provider-scan-unsafe", "A legacy dependency root contains a symbolic link.");
      }
      const children = terminalWorktree
        ? []
        : entries.filter(
            (item) =>
              item.name !== ".git" &&
              item.isDirectory() &&
              !item.isSymbolicLink() &&
              (!isBareRepository || !["objects", "refs"].includes(item.name))
          );
      if (depth === MAXIMUM_DISCOVERY_DEPTH && children.length !== 0) {
        fail("legacy-provider-scan-unsafe", "The legacy dependency universe exceeds its fixed depth.");
      }
      if (depth < MAXIMUM_DISCOVERY_DEPTH) {
        for (const item of children) {
          const childPath = join(directoryPath, item.name);
          visit(childPath, captureLegacyDirectory(childPath, "Legacy batch dependency directory"), depth + 1);
        }
      }
      captureLegacyDirectory(directoryPath, "Legacy batch dependency directory", directoryIdentity);
    };

    for (const root of normalized) visit(root.path, root.identity, 0);
    const repositoryPaths = new Set(repositories.map((repository) => repository.directoryPath));
    if (providerPaths.some((provider) => !repositoryPaths.has(provider))) {
      fail("legacy-provider-scan-unsafe", "Every batch candidate must be one repository in the dependency scan.");
    }
    const proofFor = (providerPath, providerSlug, expected = undefined) => {
      const providerObjects = resolve(providerPath, ".git", "objects");
      for (const repository of repositories) {
        if (repository.directoryPath === providerPath) continue;
        for (const alternate of repository.alternates) {
          if (
            alternate.requested === providerObjects ||
            isContained(providerObjects, alternate.requested) ||
            alternate.canonical === providerObjects ||
            isContained(providerObjects, alternate.canonical)
          ) {
            fail(
              "legacy-provider-in-use",
              `Legacy checkout ${providerSlug} still provides Git objects to ${repository.directoryPath}.`
            );
          }
        }
      }
      const providerRecords = records
        .filter((record) => record.directoryPath !== providerPath)
        .map((record) => record.record)
        .sort();
      const proof = Object.freeze({
        roots: normalized,
        maxDepth: MAXIMUM_DISCOVERY_DEPTH,
        providerObjectsPath: providerObjects,
        repositoryCount: providerRecords.length,
        repositoriesSha256: sha256(providerRecords.join(""))
      });
      validateLegacyDependencyUniverse(proof, providerPath);
      if (expected !== undefined && !isDeepStrictEqual(proof, expected)) {
        fail("legacy-dependency-universe-changed", "The recorded legacy dependency universe changed.");
      }
      return proof;
    };
    const revalidate = () => {
      for (const directory of directories) {
        captureLegacyDirectory(directory.path, "Legacy batch dependency directory", directory.identity);
        const entries = readDirectoryBounded(
          directory.path,
          MAXIMUM_DISCOVERY_ENTRIES,
          "Legacy batch dependency directory"
        );
        if (dependencyDirectoryListing(entries) !== directory.listingSha256) {
          fail("legacy-dependency-universe-changed", "The batch dependency universe changed after its global scan.");
        }
      }
      for (const repository of repositories) {
        revalidateDependencyRepository(repository.repositoryState);
        if (repository.alternatesIdentity === null) {
          try {
            lstatSync(repository.alternatesPath, { bigint: true });
            fail("legacy-dependency-universe-changed", "A dependency alternates file appeared after the scan.");
          } catch (error) {
            if (error instanceof CheckoutLifecycleError) throw error;
            if (error.code !== "ENOENT") throw error;
          }
        } else {
          const current = readBoundedFile(
            repository.alternatesPath,
            MAXIMUM_LEGACY_CONFIG_BYTES,
            "Legacy dependency alternates"
          );
          if (
            !sameIdentity(current.identity, repository.alternatesIdentity) ||
            current.text !== repository.alternatesText
          ) {
            fail("legacy-dependency-universe-changed", "A dependency alternates file changed after the scan.");
          }
        }
      }
      for (const root of normalized) captureLegacyDirectory(root.path, "Legacy dependency root", root.identity);
    };
    return Object.freeze({
      roots: normalized,
      visitedEntries,
      repositoryCount: repositories.length,
      proofFor,
      revalidate
    });
  }

  function captureLegacyDependencyUniverse(providerPath, providerSlug, roots, expected = undefined) {
    const normalized = normalizeLegacyDependencyRoots(roots, providerPath, expected);
    const providerObjects = resolve(providerPath, ".git", "objects");
    const records = [];
    let visitedEntries = 0;
    let repositoryCount = 0;

    const visit = (directoryPath, directoryIdentity, depth) => {
      captureLegacyDirectory(directoryPath, "Legacy dependency directory", directoryIdentity);
      const entries = readDirectoryBounded(
        directoryPath,
        MAXIMUM_DISCOVERY_ENTRIES,
        "Legacy dependency directory"
      ).sort((left, right) => Buffer.compare(Buffer.from(left.name), Buffer.from(right.name)));
      visitedEntries += entries.length;
      if (visitedEntries > MAXIMUM_DISCOVERY_ENTRIES) {
        fail("legacy-provider-scan-unsafe", "The legacy dependency scan exceeded its fixed entry limit.");
      }
      let isBareRepository = false;
      let terminalWorktree = directoryPath === providerPath;
      if (directoryPath !== providerPath) {
        const hasDotGit = entries.some((item) => item.name === ".git");
        const bareRepository = captureBareDependencyRepository(directoryPath, directoryIdentity, entries);
        isBareRepository = bareRepository !== null;
        let repositoryState = bareRepository;
        if (hasDotGit) {
          if (bareRepository !== null) {
            fail("legacy-provider-scan-unsafe", "A dependency path is ambiguous between bare and worktree layouts.");
          }
          const objectsDirectory = providerScanObjectsDirectory(directoryPath, basename(directoryPath));
          if (objectsDirectory !== null) {
            repositoryState = Object.freeze({
              kind: "worktree",
              objectsDirectory,
              objectsIdentity: captureLegacyDirectory(objectsDirectory, "Legacy dependency object directory")
            });
          }
        }
        if (repositoryState !== null) {
          terminalWorktree = repositoryState.kind === "worktree";
          const { objectsDirectory, objectsIdentity } = repositoryState;
          let alternatesText = "";
          const alternatesPath = join(objectsDirectory, "info", "alternates");
          try {
            const metadata = lstatSync(alternatesPath, { bigint: true });
            if (!metadata.isFile() || metadata.isSymbolicLink() || !currentUserOwns(metadata)) {
              fail("legacy-provider-scan-unsafe", "A dependency repository has an unsafe alternates file.");
            }
            alternatesText = readBoundedFile(
              alternatesPath,
              MAXIMUM_LEGACY_CONFIG_BYTES,
              `Legacy alternates for ${directoryPath}`
            ).text;
          } catch (error) {
            if (error.code !== "ENOENT") throw error;
          }
          if (alternatesText !== "" && !alternatesText.endsWith("\n")) {
            fail("legacy-provider-scan-unsafe", "A dependency repository has malformed object alternates.");
          }
          for (const line of alternatesText.split("\n").filter(Boolean)) {
            if (line.includes("\0") || line.includes("\r")) {
              fail("legacy-provider-scan-unsafe", "A dependency repository has malformed object alternates.");
            }
            const alternate = resolve(objectsDirectory, line);
            let target = alternate;
            try {
              target = realpathSync(alternate);
            } catch (error) {
              if (error.code !== "ENOENT") {
                fail("legacy-provider-scan-unsafe", "A dependency repository alternate could not be resolved.");
              }
            }
            if (
              alternate === providerObjects ||
              isContained(providerObjects, alternate) ||
              target === providerObjects ||
              isContained(providerObjects, target)
            ) {
              fail(
                "legacy-provider-in-use",
                `Legacy checkout ${providerSlug} still provides Git objects to ${directoryPath}.`
              );
            }
          }
          repositoryCount += 1;
          if (repositoryCount > MAXIMUM_DEPENDENCY_REPOSITORIES) {
            fail("legacy-provider-scan-unsafe", "The legacy dependency scan found too many repositories.");
          }
          const bareConfigRecord =
            repositoryState.kind === "bare"
              ? repositoryState.config.present
                ? `present\0${repositoryState.config.identity.device}\0${repositoryState.config.identity.inode}\0${repositoryState.config.sha256}`
                : "absent"
              : "-";
          records.push(
            `${repositoryState.kind}\0${directoryPath}\0${directoryIdentity.device}\0${directoryIdentity.inode}\0${objectsDirectory}\0${objectsIdentity.device}\0${objectsIdentity.inode}\0${repositoryState.kind === "bare" ? `${repositoryState.head.identity.device}\0${repositoryState.head.identity.inode}\0${repositoryState.head.sha256}\0${bareConfigRecord}\0${repositoryState.refs.identity.device}\0${repositoryState.refs.identity.inode}` : "-"}\0${sha256(alternatesText)}\n`
          );
          revalidateDependencyRepository(repositoryState);
        }
      }
      const children = terminalWorktree
        ? []
        : entries.filter(
            (item) =>
              item.name !== ".git" &&
              item.isDirectory() &&
              !item.isSymbolicLink() &&
              (!isBareRepository || !["objects", "refs"].includes(item.name))
          );
      if (!terminalWorktree && entries.some((item) => item.isSymbolicLink())) {
        fail("legacy-provider-scan-unsafe", "A legacy dependency root contains a symbolic link.");
      }
      if (
        depth === MAXIMUM_DISCOVERY_DEPTH &&
        children.some((item) => join(directoryPath, item.name) !== providerPath)
      ) {
        fail("legacy-provider-scan-unsafe", "The legacy dependency universe exceeds its fixed depth.");
      }
      if (depth < MAXIMUM_DISCOVERY_DEPTH) {
        for (const item of children) {
          const childPath = join(directoryPath, item.name);
          if (childPath === providerPath) continue;
          const childIdentity = captureLegacyDirectory(childPath, "Legacy dependency directory");
          visit(childPath, childIdentity, depth + 1);
        }
      }
      captureLegacyDirectory(directoryPath, "Legacy dependency directory", directoryIdentity);
    };

    for (const root of normalized) visit(root.path, root.identity, 0);
    for (const root of normalized) captureLegacyDirectory(root.path, "Legacy dependency root", root.identity);
    records.sort();
    const proof = Object.freeze({
      roots: normalized,
      maxDepth: MAXIMUM_DISCOVERY_DEPTH,
      providerObjectsPath: providerObjects,
      repositoryCount,
      repositoriesSha256: sha256(records.join(""))
    });
    validateLegacyDependencyUniverse(proof, providerPath);
    if (expected !== undefined && !isDeepStrictEqual(proof, expected)) {
      fail("legacy-dependency-universe-changed", "The recorded legacy dependency universe changed.");
    }
    return proof;
  }

  function captureRecordedLegacyDependencyUniverse(providerPath, providerSlug, explicitTarget) {
    const expected = explicitTarget.dependencyUniverse;
    if (expected?.protocol === LEGACY_DEPENDENCY_UNIVERSE_PROTOCOL) {
      return revalidateExplicitLegacyDependencyUniverse(providerPath, providerSlug, expected, true);
    }
    return captureLegacyDependencyUniverse(
      providerPath,
      providerSlug,
      explicitTarget.dependencyRoots ?? expected?.roots.map((root) => root.path),
      expected
    );
  }

  function catalogPeerHasTerminalRetirement(candidatePath, cohortSha256) {
    const slug = basename(candidatePath);
    let adoption;
    try {
      adoption = retainedLegacyAdoption(slug);
      const dependencyUniverse = legacyDependencyUniverse(adoption);
      if (
        dependencyUniverse.protocol !== LEGACY_DEPENDENCY_UNIVERSE_PROTOCOL ||
        dependencyUniverse.cohortSha256 !== cohortSha256
      ) {
        return false;
      }
    } catch {
      return false;
    }
    if (adoption.entry.value.evidence.source.checkout !== candidatePath) return false;
    const records = readSweepRecords("legacy", slug, adoption.entry.value.generation, candidatePath);
    return records.at(-1)?.kind === "retired";
  }

  function revalidateExplicitLegacyDependencyUniverse(providerPath, providerSlug, expected, providerPresent) {
    const removed = new Set();
    for (const candidatePath of expected.cleanupCandidates) {
      let present;
      try {
        lstatSync(candidatePath, { bigint: true });
        present = true;
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
        present = false;
      }
      if (candidatePath === providerPath) {
        if (present !== providerPresent) {
          fail("legacy-dependency-universe-changed", "The provider path does not match its retirement stage.");
        }
        if (!present) removed.add(candidatePath);
      } else if (!present) {
        if (!catalogPeerHasTerminalRetirement(candidatePath, expected.cohortSha256)) {
          fail("legacy-cohort-peer-not-retired", "A cleanup cohort peer disappeared without terminal retirement.");
        }
        removed.add(candidatePath);
      }
    }
    const catalog = Object.freeze({
      protocol: LEGACY_DEPENDENCY_CATALOG_PROTOCOL,
      roots: Object.freeze(
        expected.roots.map((root) =>
          Object.freeze({
            path: root.path,
            entries: Object.freeze(root.entries.filter((entry) => !removed.has(join(root.path, entry.name))))
          })
        )
      )
    });
    const remainingCandidates = expected.cleanupCandidates
      .filter((candidatePath) => !removed.has(candidatePath))
      .map((path) => Object.freeze({ path }));
    const captured = captureExplicitLegacyDependencyCatalog(catalog, remainingCandidates, undefined, {
      allowEmptyRoots: true
    });
    const expectedGroups = expected.repositoryGroups.filter(
      (group) => !group.memberPaths.some((path) => removed.has(path))
    );
    if (
      captured.roots.length !== expected.roots.length ||
      !isDeepStrictEqual(captured.repositoryGroups, expectedGroups) ||
      captured.repositoryRecordsSha256 !== explicitCatalogRepositoryGroupsSha256(expectedGroups) ||
      captured.roots.some((root, index) => {
        const prior = expected.roots[index];
        const retainedNames = new Set(
          prior.entries.filter((entry) => !removed.has(join(prior.path, entry.name))).map((entry) => entry.name)
        );
        const expectedEntries = prior.entries.filter((entry) => retainedNames.has(entry.name));
        const expectedReceipts = prior.entryReceipts.filter((receipt) => retainedNames.has(receipt.name));
        return (
          root.path !== prior.path ||
          !sameIdentity(root.identity, prior.identity) ||
          !isDeepStrictEqual(root.entries, expectedEntries) ||
          !isDeepStrictEqual(root.entryReceipts, expectedReceipts) ||
          root.entriesSha256 !== explicitCatalogEntryReceiptsSha256(expectedReceipts)
        );
      })
    ) {
      fail("legacy-cohort-proof-changed", "The dependency catalog changed during cohort retirement.");
    }
    if (providerPresent) captured.proofFor(providerPath, providerSlug);
    captured.revalidate();
    return expected;
  }

  function legacyDependencyUniverse(adoption) {
    const target = legacyTargetFromRequest(adoption.request.value);
    if (target?.dependencyUniverse === undefined) {
      fail(
        "legacy-dependency-universe-required",
        "This adoption predates the recorded dependency-universe safety check and cannot be retired automatically."
      );
    }
    validateLegacyDependencyUniverse(target.dependencyUniverse, target.checkoutPath);
    return target.dependencyUniverse;
  }

  function revalidateLegacyDependencyUniverse(adoption, providerPresent = true) {
    const expected = legacyDependencyUniverse(adoption);
    if (expected.protocol === LEGACY_DEPENDENCY_UNIVERSE_PROTOCOL) {
      return revalidateExplicitLegacyDependencyUniverse(
        adoption.entry.value.evidence.source.checkout,
        adoption.entry.value.slug,
        expected,
        providerPresent
      );
    }
    return captureRecordedLegacyDependencyUniverse(
      adoption.entry.value.evidence.source.checkout,
      adoption.entry.value.slug,
      Object.freeze({ dependencyUniverse: expected })
    );
  }

  function captureLegacyEnrollment(slug, requestedAuthority = undefined) {
    const adoption = currentLegacyAdoption(slug);
    const authority =
      requestedAuthority === undefined
        ? legacyAdoptionAuthority(adoption)
        : assertLegacyAdoptionAuthority(adoption, requestedAuthority.ownerTask, requestedAuthority.expectedRevision);
    const attempts = listLegacyArchiveAttempts(slug);
    const archiveEntry = readLegacyArchiveEntry(slug, attempts);
    if (
      archiveEntry === undefined ||
      archiveEntry.value.adoptionGeneration !== adoption.entry.value.generation ||
      archiveEntry.value.state !== "archived-review-required"
    ) {
      fail("retirement-not-eligible", "The legacy checkout needs one exact completed recovery archive.");
    }
    if (
      archiveEntry.value.ownerTask !== authority.ownerTask ||
      archiveEntry.value.ownerRevision !== authority.ownerRevision
    ) {
      fail("retirement-source-changed", "The legacy archive belongs to another owner revision.");
    }
    revalidateLegacyDependencyUniverse(adoption);
    legacyArchiveStatus(slug);
    const first = captureAdoptedLegacyAudit(adoption);
    assertAuditMatchesAdoption(first, adoption);
    legacyArchiveStatus(slug);
    const second = captureAdoptedLegacyAudit(adoption);
    assertAuditMatchesAdoption(second, adoption);
    revalidateLegacyDependencyUniverse(adoption);
    const source = Object.freeze({
      adoption: receiptFromLoaded(adoption.entry.path, adoption.entry),
      archiveCompletion: receiptFromLoaded(archiveEntry.path, archiveEntry),
      archiveReceipt: receiptFromLoaded(join(archiveEntry.attempt.path, "receipt.json"), archiveEntry.attempt.receipt)
    });
    return Object.freeze({
      kind: "legacy",
      slug,
      generation: adoption.entry.value.generation,
      originalPath: adoption.entry.value.evidence.source.checkout,
      originalIdentity: adoption.entry.value.evidence.source.checkoutIdentity,
      source,
      ownerTask: authority.ownerTask,
      ownerRevision: authority.ownerRevision,
      adoption,
      archiveEntry
    });
  }

  function enrollmentFor(kind, slug, authority = undefined) {
    return kind === "managed" ? captureManagedEnrollment(slug) : captureLegacyEnrollment(slug, authority);
  }

  function revalidateManagedEnrollment(eligible) {
    exactReceiptRead(eligible.source.entry, "Managed retirement entry");
    exactReceiptRead(eligible.source.plan, "Managed retirement plan");
    exactReceiptRead(eligible.source.archiveCompletion, "Managed recovery archive completion");
    const current = captureManagedEnrollment(eligible.slug);
    if (
      current.generation !== eligible.generation ||
      current.originalPath !== eligible.originalPath ||
      !sameIdentity(current.originalIdentity, eligible.originalIdentity) ||
      !isDeepStrictEqual(current.source, eligible.source)
    ) {
      fail("retirement-source-changed", "The managed checkout no longer matches its enrollment.");
    }
    return current;
  }

  function revalidateLegacyEnrollment(eligible) {
    const anchors = legacyRetirementSourceAnchors(eligible);
    if (anchors.historical) {
      revalidateLegacyArchiveReceipts(eligible);
      legacyArchiveStatus(eligible.slug);
      const first = captureAdoptedLegacyAudit(anchors.adoptionRecord);
      assertAuditMatchesAdoption(first, anchors.adoptionRecord);
      legacyArchiveStatus(eligible.slug);
      const second = captureAdoptedLegacyAudit(anchors.adoptionRecord);
      assertAuditMatchesAdoption(second, anchors.adoptionRecord);
      revalidateLegacyArchiveReceipts(eligible);
      if (
        anchors.adoption.value.evidence.source.checkout !== eligible.originalPath ||
        !sameIdentity(anchors.adoption.value.evidence.source.checkoutIdentity, eligible.originalIdentity)
      ) {
        fail("retirement-source-changed", "The historical legacy checkout no longer matches its enrollment.");
      }
      return Object.freeze({
        kind: "legacy",
        slug: eligible.slug,
        generation: eligible.generation,
        originalPath: eligible.originalPath,
        originalIdentity: eligible.originalIdentity,
        source: eligible.source,
        ownerTask: anchors.authority.ownerTask,
        ownerRevision: anchors.authority.ownerRevision,
        adoption: anchors.adoptionRecord
      });
    }
    const current = captureLegacyEnrollment(eligible.slug, {
      ownerTask: eligible.ownerTask,
      expectedRevision: eligible.ownerRevision
    });
    if (
      current.generation !== eligible.generation ||
      current.originalPath !== eligible.originalPath ||
      !sameIdentity(current.originalIdentity, eligible.originalIdentity) ||
      !isDeepStrictEqual(current.source, eligible.source)
    ) {
      fail("retirement-source-changed", "The legacy checkout no longer matches its enrollment.");
    }
    return current;
  }

  function exactReceiptRead(expected, label, expectedLinks = 1n) {
    const loaded = readJsonReceipt(expected.path, MAXIMUM_ENTRY_BYTES, label, expectedLinks);
    assertReceiptMatches(expected, { path: expected.path, ...loaded }, label);
    return loaded;
  }

  function requireRetirementGit(entry, worktreePath, args, label, statuses = [0]) {
    const result = auditCheckoutGit(run, paths, worktreePath, entry.checkout.gitAdmin.path, args);
    if (!statuses.includes(result.status)) fail("retirement-not-eligible", `${label} could not be proven.`);
    return result;
  }

  function revalidateManagedQuarantine(eligible, quarantinePath) {
    const entryLoaded = exactReceiptRead(eligible.source.entry, "Managed retirement entry");
    const entry = validateEntry(entryLoaded.value, eligible.slug);
    if (
      entry.state !== "cleanup-pending" ||
      entry.cleanupRequest.reason !== "finish" ||
      entry.generation !== eligible.generation
    ) {
      fail("retirement-source-changed", "The managed retirement entry is no longer eligible.");
    }
    const planLoaded = exactReceiptRead(eligible.source.plan, "Managed retirement plan");
    validateRetirementEvidence(planLoaded.value, entry);
    const archive = readCompletedArchiveAnchor(entry);
    if (!isDeepStrictEqual(archive.completion, eligible.source.archiveCompletion)) {
      fail("retirement-source-changed", "The managed recovery archive changed after enrollment.");
    }
    assertTargetFetchHeadMatchesArchive(entry, archive);
    revalidatePathIdentity(quarantinePath, eligible.originalIdentity, "Quarantined managed checkout", "directory");
    const registry = worktreeRegistry(true);
    const records = registry.records.filter((record) => record.path === quarantinePath);
    if (
      records.length !== 1 ||
      Object.keys(records[0]).sort().join("\0") !== ["HEAD", "branch", "path"].sort().join("\0") ||
      registry.records.some((record) => record.path !== quarantinePath && isContained(quarantinePath, record.path))
    ) {
      fail("retirement-layout-blocked", "The quarantined managed worktree registration is ambiguous.");
    }
    const record = records[0];
    const gitFile = readGitFile(quarantinePath);
    if (
      !sameIdentity(gitFile.identity, entry.checkout.gitFile.identity) ||
      gitFile.text !== entry.checkout.gitFile.content
    ) {
      fail("retirement-source-changed", "The quarantined checkout Git file changed.");
    }
    revalidatePathIdentity(entry.checkout.gitAdmin.path, entry.checkout.gitAdmin.identity, "Git admin", "directory");
    const backlink = readBoundedFile(join(entry.checkout.gitAdmin.path, "gitdir"), 8192, "Checkout Git admin backlink");
    if (backlink.text !== `${quarantinePath}${sep}.git\n` && backlink.text !== `${quarantinePath}/.git\n`) {
      fail("retirement-layout-blocked", "The quarantined checkout backlink is incoherent.");
    }
    const branch = requireRetirementGit(
      entry,
      quarantinePath,
      ["symbolic-ref", "--quiet", "--short", "HEAD"],
      "Branch"
    ).stdout.trim();
    const head = requireRetirementGit(entry, quarantinePath, ["rev-parse", "--verify", "HEAD"], "HEAD").stdout.trim();
    const config = requireRetirementGit(
      entry,
      quarantinePath,
      ["config", "--null", "--name-only", "--list"],
      "Git configuration"
    ).stdout;
    const status = requireRetirementGit(
      entry,
      quarantinePath,
      ["status", "--porcelain=v2", "-z", "--untracked-files=all", "--ignored=matching", "--ignore-submodules=all"],
      "Status"
    ).stdout;
    const flags = requireRetirementGit(entry, quarantinePath, ["ls-files", "-v", "-z"], "Index flags").stdout;
    const stages = requireRetirementGit(entry, quarantinePath, ["ls-files", "--stage", "-z"], "Index stages").stdout;
    const unsafeFlags = flags
      .split("\0")
      .filter(Boolean)
      .filter((line) => line[0] !== "H").length;
    const gitlinks = stages
      .split("\0")
      .filter(Boolean)
      .filter((line) => line.startsWith("160000 ")).length;
    const tracked = requireRetirementGit(
      entry,
      quarantinePath,
      ["diff-files", "--quiet", "--no-ext-diff", "--no-textconv", "--ignore-submodules=all", "--"],
      "Tracked worktree",
      [0, 1]
    ).status;
    const staged = requireRetirementGit(
      entry,
      quarantinePath,
      ["diff-index", "--cached", "--quiet", "--no-ext-diff", "--no-textconv", "--ignore-submodules=all", "HEAD", "--"],
      "Staged worktree",
      [0, 1]
    ).status;
    if (
      branch !== entry.branch ||
      head !== planLoaded.value.git.head ||
      record.HEAD !== head ||
      record.branch !== `refs/heads/${entry.branch}` ||
      parseStatus(status).length !== 0 ||
      configuredContentFilterKeys(config).length !== 0 ||
      unsafeFlags !== 0 ||
      gitlinks !== 0 ||
      tracked !== 0 ||
      staged !== 0
    ) {
      fail("retirement-not-eligible", "The quarantined managed checkout is no longer clean and exact.");
    }
    const confirmedArchive = readCompletedArchiveAnchor(entry);
    if (!isDeepStrictEqual(confirmedArchive.completion, eligible.source.archiveCompletion)) {
      fail("retirement-source-changed", "The managed recovery archive changed during purge checks.");
    }
    assertTargetFetchHeadMatchesArchive(entry, confirmedArchive);
    return Object.freeze({ entry, branchRef: `refs/heads/${entry.branch}`, head });
  }

  function requireLegacyRetirementGit(checkoutPath, args, label, statuses = [0]) {
    const result = run("git", args, {
      cwd: checkoutPath,
      allowFailure: true,
      env: auditGitEnvironment()
    });
    if (!statuses.includes(result.status)) fail("retirement-not-eligible", `${label} could not be proven.`);
    return result;
  }

  function legacyRetirementSourceAnchors(eligible) {
    validateSweepSource("legacy", eligible.source);
    const adoption = exactReceiptRead(eligible.source.adoption, "Legacy adoption entry", 2n);
    const archiveCompletion = exactReceiptRead(eligible.source.archiveCompletion, "Legacy archive completion", 2n);
    const archiveReceipt = exactReceiptRead(eligible.source.archiveReceipt, "Legacy archive receipt");
    if (
      adoption.value.generation !== eligible.generation ||
      archiveCompletion.value.adoptionGeneration !== eligible.generation ||
      archiveReceipt.value.adoptionGeneration !== eligible.generation
    ) {
      fail("retirement-source-changed", "The legacy archive no longer belongs to the enrolled adoption.");
    }
    const attempt = {
      slug: eligible.slug,
      adoptionGeneration: eligible.generation,
      attempt: archiveCompletion.value.attempt,
      path: dirname(eligible.source.archiveReceipt.path),
      identity: assertPrivateDirectory(dirname(eligible.source.archiveReceipt.path), "Legacy archive attempt directory")
    };
    const adoptionRequest = exactReceiptRead(adoption.value.request, "Legacy adoption request");
    validateLegacyCompletion(adoption.value, eligible.slug, eligible.generation);
    const adoptionRecord = Object.freeze({
      entry: Object.freeze({ path: eligible.source.adoption.path, ...adoption }),
      request: Object.freeze({ path: adoption.value.request.path, ...adoptionRequest })
    });
    const archiveRequest = exactReceiptRead(archiveReceipt.value.request, "Legacy archive request");
    validateLegacyArchiveRequest(
      archiveRequest.value,
      eligible.slug,
      eligible.generation,
      archiveCompletion.value.attempt
    );
    if (!isDeepStrictEqual(archiveRequest.value.adoption, legacyArchiveAdoptionAnchor(adoptionRecord))) {
      fail("retirement-source-changed", "The legacy archive no longer links to the enrolled adoption receipt.");
    }
    validateLegacyArchiveReceiptAuthority(archiveReceipt.value, attempt, archiveRequest);
    validateLegacyArchiveCompletion(archiveCompletion.value, attempt, archiveReceipt);
    const authority = legacyRetirementAuthority(adoptionRecord, archiveRequest, archiveReceipt, archiveCompletion);
    return Object.freeze({
      adoption,
      archiveCompletion,
      archiveReceipt,
      archiveRequest,
      attempt,
      adoptionRecord,
      authority: Object.freeze({ ownerTask: authority.ownerTask, ownerRevision: authority.ownerRevision }),
      historical: authority.historical
    });
  }

  function revalidateLegacyArchiveReceipts(eligible) {
    const anchors = legacyRetirementSourceAnchors(eligible);
    if (
      anchors.authority.ownerTask !== eligible.ownerTask ||
      anchors.authority.ownerRevision !== eligible.ownerRevision
    ) {
      fail("retirement-source-changed", "The legacy owner revision changed after retirement enrollment.");
    }
    try {
      validateLegacyArchiveReceipt(anchors.archiveReceipt.value, anchors.attempt, anchors.archiveRequest);
    } catch (error) {
      if (
        error instanceof CheckoutLifecycleError &&
        ["unsafe-archive", "invalid-legacy-archive", "legacy-archive-changed"].includes(error.code)
      ) {
        fail("legacy-archive-changed", "The recorded legacy recovery archive changed after enrollment.");
      }
      throw error;
    }
    if (anchors.historical) {
      const providerPath = anchors.adoption.value.evidence.source.checkout;
      captureLegacyDependencyUniverse(providerPath, eligible.slug, [dirname(providerPath)]);
    } else {
      const providerPath = anchors.adoption.value.evidence.source.checkout;
      let providerPresent;
      try {
        lstatSync(providerPath, { bigint: true });
        providerPresent = true;
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
        providerPresent = false;
      }
      revalidateLegacyDependencyUniverse(anchors.adoptionRecord, providerPresent);
    }
    // The standard archive status path performs the expensive recovery proof while the source still exists.
    // After quarantine, the three immutable anchors above remain the authority for purge reconciliation.
    return anchors;
  }

  function revalidateLegacyQuarantine(eligible, quarantinePath) {
    const anchors = revalidateLegacyArchiveReceipts(eligible);
    const evidence = anchors.adoption.value.evidence;
    assertNoMountAtOrBelow(quarantinePath);
    revalidatePathIdentity(quarantinePath, eligible.originalIdentity, "Quarantined legacy checkout", "directory");
    revalidatePathIdentity(
      join(quarantinePath, ".git"),
      evidence.source.gitDirectoryIdentity,
      "Legacy Git directory",
      "directory"
    );
    const configNames = requireLegacyRetirementGit(
      quarantinePath,
      ["config", "--local", "--no-includes", "--null", "--name-only", "--list"],
      "Legacy configuration"
    ).stdout;
    if (
      configuredContentFilterKeys(configNames).length !== 0 ||
      unsafeArchiveConfigKeys(configNames).length !== 0 ||
      unsafeLegacyConfigKeys(configNames).length !== 0
    ) {
      fail("retirement-not-eligible", "The quarantined legacy checkout has unsafe Git configuration.");
    }
    const head = requireLegacyRetirementGit(
      quarantinePath,
      ["rev-parse", "--verify", "HEAD^{commit}"],
      "Legacy HEAD"
    ).stdout.trim();
    const tree = requireLegacyRetirementGit(
      quarantinePath,
      ["rev-parse", "--verify", "HEAD^{tree}"],
      "Legacy tree"
    ).stdout.trim();
    const branchResult = requireLegacyRetirementGit(
      quarantinePath,
      ["symbolic-ref", "--quiet", "--short", "HEAD"],
      "Legacy branch",
      [0, 1]
    );
    const branch = branchResult.status === 0 ? branchResult.stdout.trim() : null;
    const status = requireLegacyRetirementGit(
      quarantinePath,
      ["status", "--porcelain=v2", "-z", "--untracked-files=all", "--ignored=matching", "--ignore-submodules=none"],
      "Legacy status"
    ).stdout;
    const statusRecords = parseStatus(status);
    const allowlist = evidence.generated.allowlist;
    if (
      head !== evidence.git.head ||
      tree !== evidence.git.headTree ||
      branch !== evidence.git.branch ||
      statusRecords.some((item) => item.kind !== "ignored" || !legacyPathIsAllowed(item.path, allowlist))
    ) {
      fail("retirement-not-eligible", "The quarantined legacy checkout changed after enrollment.");
    }
    const flags = requireLegacyRetirementGit(quarantinePath, ["ls-files", "-v", "-z"], "Legacy index flags").stdout;
    const stages = requireLegacyRetirementGit(
      quarantinePath,
      ["ls-files", "--stage", "-z"],
      "Legacy index stages"
    ).stdout;
    if (
      flags
        .split("\0")
        .filter(Boolean)
        .some((line) => line[0] !== "H")
    ) {
      fail("retirement-not-eligible", "The quarantined legacy checkout has unsafe index flags.");
    }
    validateLegacyIndexStages(stages);
    if (
      requireLegacyRetirementGit(
        quarantinePath,
        ["diff-files", "--quiet", "--no-ext-diff", "--no-textconv", "--ignore-submodules=none", "--"],
        "Legacy tracked worktree",
        [0, 1]
      ).status !== 0 ||
      requireLegacyRetirementGit(
        quarantinePath,
        [
          "diff-index",
          "--cached",
          "--quiet",
          "--no-ext-diff",
          "--no-textconv",
          "--ignore-submodules=none",
          "HEAD",
          "--"
        ],
        "Legacy staged worktree",
        [0, 1]
      ).status !== 0
    ) {
      fail("retirement-not-eligible", "The quarantined legacy checkout is not clean.");
    }
    const inventory = captureLegacyGeneratedInventory(quarantinePath, allowlist);
    if (!isDeepStrictEqual(inventory, evidence.generated.inventory)) {
      fail("retirement-not-eligible", "Generated legacy content changed after enrollment.");
    }
    requireLegacyRetirementGit(quarantinePath, ["fsck", "--strict", "--full", "--no-dangling"], "Legacy fsck");
    assertNoMountAtOrBelow(quarantinePath);
    revalidateLegacyArchiveReceipts(eligible);
    return Object.freeze({ branchPreserved: evidence.git.branch !== null, head });
  }

  function revalidateLegacyPurgeContinuation(eligible, quarantinePath) {
    const anchors = revalidateLegacyArchiveReceipts(eligible);
    revalidatePathIdentity(quarantinePath, eligible.originalIdentity, "Legacy purge quarantine", "directory");
    assertNoMountAtOrBelow(quarantinePath);
    revalidateLegacyRecoveryRepository(anchors.archiveReceipt.value, anchors.attempt);
    revalidateLegacyArchiveReceipts(eligible);
    return Object.freeze({ branchPreserved: anchors.adoption.value.evidence.git.branch !== null });
  }

  function verifyManagedBranchPreserved(eligible) {
    const entryLoaded = exactReceiptRead(eligible.source.entry, "Managed retirement entry");
    const entry = validateEntry(entryLoaded.value, eligible.slug);
    const planLoaded = exactReceiptRead(eligible.source.plan, "Managed retirement plan");
    validateRetirementEvidence(planLoaded.value, entry);
    const archive = readCompletedArchiveAnchor(entry);
    if (!isDeepStrictEqual(archive.completion, eligible.source.archiveCompletion)) {
      fail("retirement-source-changed", "The managed recovery archive changed after the worktree was removed.");
    }
    const branchRef = `refs/heads/${entry.branch}`;
    const preserved = commonGit(run, paths, repository, ["rev-parse", "--verify", `${branchRef}^{commit}`], {
      allowFailure: true,
      env: auditGitEnvironment()
    });
    if (preserved.status !== 0 || preserved.stdout.trim() !== planLoaded.value.git.head) {
      fail("retirement-branch-lost", "Git did not preserve the managed checkout branch.");
    }
    return true;
  }

  function legacyBranchPreserved(eligible) {
    const anchors = revalidateLegacyArchiveReceipts(eligible);
    revalidateLegacyRecoveryRepository(anchors.archiveReceipt.value, anchors.attempt);
    return anchors.adoption.value.evidence.git.branch !== null;
  }

  function removeTreeNoFollow(rootPath, expectedIdentity) {
    revalidatePathIdentity(rootPath, expectedIdentity, "Retirement quarantine", "directory");
    assertNoMountAtOrBelow(rootPath);
    const rootMetadata = lstatSync(rootPath, { bigint: true });
    const rootDevice = rootMetadata.dev;
    let entries = 0;
    const visit = (path, depth) => {
      if (depth > MAXIMUM_RETIREMENT_TREE_DEPTH) {
        fail("retirement-tree-too-large", "The retirement quarantine exceeds the depth limit.");
      }
      const directory = opendirSync(path);
      try {
        for (;;) {
          const item = directory.readSync();
          if (item === null) break;
          entries += 1;
          if (entries > MAXIMUM_RETIREMENT_TREE_ENTRIES) {
            fail("retirement-tree-too-large", "The retirement quarantine exceeds the entry limit.");
          }
          const child = join(path, item.name);
          const metadata = lstatSync(child, { bigint: true });
          if (!currentUserOwns(metadata) || metadata.dev !== rootDevice) {
            fail("unsafe-retirement-tree", "The retirement quarantine crosses ownership or filesystem boundaries.");
          }
          if (metadata.isDirectory() && !metadata.isSymbolicLink()) {
            visit(child, depth + 1);
            rmdirSync(child);
          } else unlinkSync(child);
          hooks?.afterLegacyRetirementEntryRemoved?.(rootPath, child, entries);
        }
      } finally {
        directory.closeSync();
      }
    };
    visit(rootPath, 0);
    revalidatePathIdentity(rootPath, expectedIdentity, "Retirement quarantine", "directory");
    rmdirSync(rootPath);
    fsyncDirectory(dirname(rootPath));
  }

  function enrollRetirement(kind, slug, authority = undefined) {
    const enrollment = enrollmentFor(kind, slug, authority);
    const existing = readSweepRecords(kind, slug, enrollment.generation, enrollment.originalPath);
    if (existing.length !== 0) {
      fail("retirement-already-enrolled", `${kind} checkout ${slug} is already enrolled for retirement.`);
    }
    const operationId = tokenFactory();
    if (!/^[0-9a-f]{32}$/u.test(operationId)) fail("invalid-retirement-journal", "Operation ID is malformed.");
    const quarantinePath = sweepQuarantinePath(kind, slug, enrollment.generation, operationId);
    if (existsSync(quarantinePath)) {
      fail("retirement-layout-blocked", "The retirement quarantine destination already exists.");
    }
    const bootId = currentBootId();
    hooks?.beforeRetirementEnrollment?.(enrollment, bootId);
    const confirmed = enrollmentFor(kind, slug, authority);
    if (
      confirmed.generation !== enrollment.generation ||
      confirmed.originalPath !== enrollment.originalPath ||
      !sameIdentity(confirmed.originalIdentity, enrollment.originalIdentity) ||
      !isDeepStrictEqual(confirmed.source, enrollment.source)
    ) {
      fail("retirement-source-changed", "The checkout changed while retirement enrollment was prepared.");
    }
    if (currentBootId() !== bootId) {
      fail("retirement-boot-changed", "The Linux boot ID changed while retirement enrollment was prepared.");
    }
    const record = appendSweepRecord(kind, slug, enrollment.generation, enrollment.originalPath, {
      protocol: kind === "legacy" ? LEGACY_RETIREMENT_SWEEP_PROTOCOL : RETIREMENT_SWEEP_PROTOCOL,
      kind: "eligible",
      candidateKind: kind,
      slug,
      generation: enrollment.generation,
      sequence: 1,
      operationId,
      previous: null,
      eligibleBootId: bootId,
      originalPath: enrollment.originalPath,
      originalIdentity: enrollment.originalIdentity,
      source: enrollment.source,
      ...(kind === "legacy" ? { ownerTask: enrollment.ownerTask, ownerRevision: enrollment.ownerRevision } : {})
    });
    return Object.freeze({
      status: "enrolled-next-boot",
      kind,
      slug,
      generation: enrollment.generation,
      eligibleBootId: bootId,
      record: sweepRecordReceipt(record),
      moved: false,
      removed: false
    });
  }

  function verifyExistingRetirementEnrollment(kind, slug) {
    if (!["managed", "legacy"].includes(kind)) {
      fail("invalid-retirement-kind", "Retirement kind must be managed or legacy.");
    }
    const managedEntry = kind === "managed" ? readEntry(slug) : undefined;
    const legacyAdoption = kind === "legacy" ? retainedLegacyAdoption(slug) : undefined;
    const generation = managedEntry?.generation ?? legacyAdoption.entry.value.generation;
    const originalPath =
      kind === "managed" ? checkoutPathFor(slug) : legacyAdoption.entry.value.evidence.source.checkout;
    const records = readSweepRecords(kind, slug, generation, originalPath);
    if (records.length === 0) fail("retirement-not-enrolled", `${kind} checkout ${slug} is not enrolled.`);
    const eligible = records[0].loaded.value;
    const candidate = { kind, slug, generation, originalPath };
    const layout = candidateLayout(candidate, records[0]);
    try {
      const allowedLayouts = {
        eligible: ["original"],
        "quarantine-intent": ["original", "quarantine"],
        "quarantine-result": ["quarantine"],
        "purge-intent": ["quarantine", "absent"],
        retired: ["absent"]
      };
      if (!allowedLayouts[records.at(-1).kind].includes(layout.state)) {
        fail("retirement-layout-blocked", "The enrolled checkout layout does not match its durable journal stage.");
      }
      if (layout.state === "original") {
        if (kind === "managed") revalidateManagedEnrollment(eligible);
        else revalidateLegacyEnrollment(eligible);
      } else if (layout.state === "quarantine") {
        if (kind === "managed") revalidateManagedQuarantine(eligible, layout.quarantinePath);
        else if (records.length >= 4) revalidateLegacyPurgeContinuation(eligible, layout.quarantinePath);
        else revalidateLegacyQuarantine(eligible, layout.quarantinePath);
      } else if (layout.state === "absent") {
        if (kind === "managed") verifyManagedBranchPreserved(eligible);
        else legacyBranchPreserved(eligible);
      } else fail("retirement-layout-blocked", "The enrolled checkout layout is ambiguous.");
    } catch (error) {
      if (
        error instanceof CheckoutLifecycleError &&
        [
          "checkout-changed",
          "archive-changed",
          "legacy-adoption-changed",
          "legacy-archive-changed",
          "legacy-audit-not-eligible",
          "legacy-checkout-changed",
          "legacy-dependency-universe-changed",
          "legacy-provider-in-use",
          "legacy-provider-scan-unsafe",
          "retirement-archive-missing",
          "retirement-archive-stale",
          "retirement-evidence-stale",
          "retirement-layout-blocked",
          "retirement-not-eligible",
          "retirement-source-changed"
        ].includes(error.code)
      ) {
        fail(
          "retirement-enrolled-source-changed",
          "The checkout no longer matches its immutable retirement enrollment. Resume or review it explicitly."
        );
      }
      throw error;
    }
    const progress = retirementHoldResult(candidate, records, layout, "retirement-already-enrolled");
    return Object.freeze({
      status: "already-enrolled",
      kind,
      slug,
      generation,
      layout: progress.layout,
      journal: progress.journal,
      moved: progress.moved,
      removed: progress.removed
    });
  }

  function candidateOriginalPath(kind, slug) {
    if (kind === "managed") return checkoutPathFor(slug);
    const attempts = listLegacyAttempts(slug);
    const entry = readLegacyEntry(slug, attempts);
    if (entry !== undefined) return entry.value.evidence.source.checkout;
    const source = repository.bootstrapSourceRepository;
    if (source === undefined) fail("legacy-bootstrap-required", "Legacy retirement requires a bootstrap source.");
    return join(source.topLevel, "tmp", "codex-checkpoints", slug);
  }

  function listSweepCandidates(kind) {
    const root = sweepRoot(kind);
    if (!existsSync(root)) return Object.freeze([]);
    const identity = assertPrivateDirectory(root, `${kind} retirement sweep journal`);
    const candidates = readDirectoryBounded(root, MAXIMUM_ENTRIES, `${kind} retirement sweep journal`).map((item) => {
      const match = RETIREMENT_SWEEP_DIRECTORY_PATTERN.exec(item.name);
      if (!item.isDirectory() || item.isSymbolicLink() || match === null) {
        fail("invalid-retirement-journal", `The ${kind} retirement journal contains an unknown entry.`);
      }
      const slug = match[1];
      const generation = Number(match[2]);
      return Object.freeze({ kind, slug, generation, originalPath: candidateOriginalPath(kind, slug) });
    });
    revalidatePathIdentity(root, identity, `${kind} retirement sweep journal`, "directory");
    return Object.freeze(candidates.sort((left, right) => left.slug.localeCompare(right.slug)));
  }

  function candidateLayout(candidate, eligible) {
    const records = candidate.kind === "managed" ? worktreeRecords(true) : [];
    const operationId = eligible.loaded.value.operationId;
    const quarantinePath = sweepQuarantinePath(candidate.kind, candidate.slug, candidate.generation, operationId);
    const inspect = (path) => {
      let metadata;
      try {
        metadata = lstatSync(path, { bigint: true });
      } catch (error) {
        if (error.code === "ENOENT") return "absent";
        throw error;
      }
      return metadata.isDirectory() &&
        !metadata.isSymbolicLink() &&
        currentUserOwns(metadata) &&
        sameIdentity(identityOf(metadata), eligible.loaded.value.originalIdentity)
        ? "exact"
        : "mismatch";
    };
    const originalObservation = inspect(candidate.originalPath);
    const quarantineObservation = inspect(quarantinePath);
    const original = originalObservation === "exact";
    const quarantine = quarantineObservation === "exact";
    const observations = { original: originalObservation, quarantine: quarantineObservation };
    if (originalObservation === "mismatch" || quarantineObservation === "mismatch") {
      return Object.freeze({ state: "blocked", original, quarantine, quarantinePath, records, observations });
    }
    if (candidate.kind === "managed") {
      const atOriginal = records.filter((record) => record.path === candidate.originalPath);
      const atQuarantine = records.filter((record) => record.path === quarantinePath);
      if (atOriginal.length > 1 || atQuarantine.length > 1) {
        return Object.freeze({ state: "blocked", original, quarantine, quarantinePath, records, observations });
      }
      if (original && !quarantine && atOriginal.length === 1 && atQuarantine.length === 0)
        return Object.freeze({ state: "original", original, quarantine, quarantinePath, records, observations });
      if (!original && quarantine && atOriginal.length === 0 && atQuarantine.length === 1)
        return Object.freeze({ state: "quarantine", original, quarantine, quarantinePath, records, observations });
      if (!original && !quarantine && atOriginal.length === 0 && atQuarantine.length === 0)
        return Object.freeze({ state: "absent", original, quarantine, quarantinePath, records, observations });
      return Object.freeze({ state: "blocked", original, quarantine, quarantinePath, records, observations });
    }
    if (original && !quarantine)
      return Object.freeze({ state: "original", original, quarantine, quarantinePath, observations });
    if (!original && quarantine)
      return Object.freeze({ state: "quarantine", original, quarantine, quarantinePath, observations });
    if (!original && !quarantine)
      return Object.freeze({ state: "absent", original, quarantine, quarantinePath, observations });
    return Object.freeze({ state: "blocked", original, quarantine, quarantinePath, observations });
  }

  function appendCandidateRecord(candidate, records, kind, fields) {
    const eligible = records[0];
    return appendSweepRecord(candidate.kind, candidate.slug, candidate.generation, candidate.originalPath, {
      protocol: candidate.kind === "legacy" ? LEGACY_RETIREMENT_SWEEP_PROTOCOL : RETIREMENT_SWEEP_PROTOCOL,
      kind,
      candidateKind: candidate.kind,
      slug: candidate.slug,
      generation: candidate.generation,
      sequence: records.length + 1,
      operationId: eligible.operationId,
      previous: sweepRecordReceipt(records.at(-1)),
      ...(candidate.kind === "legacy"
        ? {
            ownerTask: eligible.loaded.value.ownerTask,
            ownerRevision: eligible.loaded.value.ownerRevision
          }
        : {}),
      ...fields
    });
  }

  function appendManagedTombstone(entry, retiredRecord) {
    if (entry.state === "retired") return entry;
    if (entry.state !== "cleanup-pending" || entry.cleanupRequest.reason !== "finish") {
      fail("retirement-source-changed", "The managed checkout cannot receive a retirement tombstone.");
    }
    return appendEntry(entry, {
      ...entry,
      state: "retired",
      tombstone: {
        protocol: RETIREMENT_TOMBSTONE_PROTOCOL,
        record: sweepRecordReceipt(retiredRecord)
      }
    });
  }

  function retirementHoldResult(candidate, records, layout, code) {
    const latest = records.at(-1).kind;
    const moved =
      latest === "retired" || records.length >= 3 || layout.state === "quarantine"
        ? true
        : layout.state === "original"
          ? false
          : null;
    const removed =
      latest === "retired" || (records.length >= 4 && layout.state === "absent")
        ? true
        : ["original", "quarantine"].includes(layout.state)
          ? false
          : null;
    const state =
      layout.state === "quarantine"
        ? "held-after-move"
        : layout.state === "absent" && ["purge-intent", "retired"].includes(latest)
          ? "held-after-purge"
          : ["absent", "blocked"].includes(layout.state)
            ? "held-ambiguous-layout"
            : "held";
    return Object.freeze({
      kind: candidate.kind,
      slug: candidate.slug,
      state,
      code,
      layout: layout.state,
      journal: latest,
      moved,
      removed
    });
  }

  function observeRetirementHold(candidate, code) {
    const records = readSweepRecords(candidate.kind, candidate.slug, candidate.generation, candidate.originalPath);
    if (records.length === 0) fail("invalid-retirement-journal", "The held candidate lost its eligibility record.");
    return retirementHoldResult(candidate, records, candidateLayout(candidate, records[0]), code);
  }

  function sweepOne(candidate, bootId) {
    let records = [...readSweepRecords(candidate.kind, candidate.slug, candidate.generation, candidate.originalPath)];
    if (records.length === 0) fail("invalid-retirement-journal", "The retirement journal has no eligibility record.");
    const eligible = records[0];
    if (eligible.loaded.value.eligibleBootId === bootId) {
      return Object.freeze({
        kind: candidate.kind,
        slug: candidate.slug,
        state: "waiting-for-next-boot",
        moved: false,
        removed: false
      });
    }
    let layout = candidateLayout(candidate, eligible);
    if (layout.state === "blocked") {
      return retirementHoldResult(candidate, records, layout, "retirement-layout-blocked");
    }

    if (records.length === 1 || (records.length === 2 && layout.state === "original")) {
      if (layout.state !== "original") {
        if (records.length === 2 && layout.state === "quarantine") {
          // The move committed before its result record was published; reconcile below.
        } else {
          return retirementHoldResult(candidate, records, layout, "retirement-layout-blocked");
        }
      } else {
        const expected = eligible.loaded.value;
        if (candidate.kind === "managed") revalidateManagedEnrollment(expected);
        else revalidateLegacyEnrollment(expected);
        if (records.length === 1) {
          const intent = appendCandidateRecord(candidate, records, "quarantine-intent", {
            bootId,
            originalPath: candidate.originalPath,
            quarantinePath: layout.quarantinePath
          });
          records.push(intent);
        }
        hooks?.beforeRetirementMove?.(candidate, layout);
        if (candidate.kind === "managed") {
          revalidateManagedEnrollment(expected);
          const result = commonGit(
            run,
            paths,
            repository,
            ["worktree", "move", candidate.originalPath, layout.quarantinePath],
            { allowFailure: true, env: auditGitEnvironment() }
          );
          hooks?.afterRetirementMoveCommand?.(candidate, result);
        } else {
          revalidateLegacyEnrollment(expected);
          assertNoMountAtOrBelow(candidate.originalPath);
          try {
            renameSync(candidate.originalPath, layout.quarantinePath);
            fsyncDirectory(dirname(candidate.originalPath));
            fsyncDirectory(dirname(layout.quarantinePath));
          } catch (error) {
            if (error.code === "EXDEV") {
              fail("retirement-cross-device", "Legacy quarantine must stay on the source filesystem.");
            }
            if (error.code !== "ENOENT") throw error;
          }
          hooks?.afterRetirementMoveCommand?.(candidate, { status: 0 });
        }
        layout = candidateLayout(candidate, eligible);
      }
    }
    if (records.length === 2) {
      if (layout.state !== "quarantine") {
        return retirementHoldResult(candidate, records, layout, "retirement-layout-blocked");
      }
      const result = appendCandidateRecord(candidate, records, "quarantine-result", {
        bootId,
        quarantinePath: layout.quarantinePath,
        location: "quarantine"
      });
      records.push(result);
      hooks?.afterRetirementQuarantineRecorded?.(candidate, result);
    }

    layout = candidateLayout(candidate, eligible);
    if (records.length === 3 || (records.length === 4 && layout.state === "quarantine")) {
      if (layout.state !== "quarantine") {
        if (records.length === 4 && layout.state === "absent") {
          // The purge committed before its tombstone record was published; reconcile below.
        } else {
          return retirementHoldResult(candidate, records, layout, "retirement-layout-blocked");
        }
      } else {
        const expected = eligible.loaded.value;
        if (candidate.kind === "managed") revalidateManagedQuarantine(expected, layout.quarantinePath);
        else if (records.length === 4) revalidateLegacyPurgeContinuation(expected, layout.quarantinePath);
        else revalidateLegacyQuarantine(expected, layout.quarantinePath);
        if (records.length === 3) {
          const intent = appendCandidateRecord(candidate, records, "purge-intent", {
            bootId,
            quarantinePath: layout.quarantinePath
          });
          records.push(intent);
        }
        hooks?.beforeRetirementPurge?.(candidate, layout);
        if (candidate.kind === "managed") {
          revalidateManagedQuarantine(expected, layout.quarantinePath);
          const result = commonGit(run, paths, repository, ["worktree", "remove", layout.quarantinePath], {
            allowFailure: true,
            env: auditGitEnvironment()
          });
          hooks?.afterRetirementPurgeCommand?.(candidate, result);
        } else {
          revalidateLegacyPurgeContinuation(expected, layout.quarantinePath);
          removeTreeNoFollow(layout.quarantinePath, expected.originalIdentity);
          hooks?.afterRetirementPurgeCommand?.(candidate, { status: 0 });
        }
        layout = candidateLayout(candidate, eligible);
        if (layout.state === "absent" && candidate.kind === "managed") verifyManagedBranchPreserved(expected);
      }
    }
    if (records.length === 4) {
      if (layout.state !== "absent") {
        return retirementHoldResult(candidate, records, layout, "retirement-layout-blocked");
      }
      const expected = eligible.loaded.value;
      const branchPreserved =
        candidate.kind === "managed" ? verifyManagedBranchPreserved(expected) : legacyBranchPreserved(expected);
      const retired = appendCandidateRecord(candidate, records, "retired", {
        bootId,
        quarantinePath: layout.quarantinePath,
        branchPreserved
      });
      records.push(retired);
      if (candidate.kind === "managed") {
        appendManagedTombstone(readEntry(candidate.slug), retired);
      }
    } else if (records.length === 5 && candidate.kind === "managed") {
      appendManagedTombstone(readEntry(candidate.slug), records[4]);
    }
    return Object.freeze({ kind: candidate.kind, slug: candidate.slug, state: "retired", moved: true, removed: true });
  }

  function sweepRetirements() {
    initializeRetirementSweepJournal();
    const bootId = currentBootId();
    const candidates = [...listSweepCandidates("managed"), ...listSweepCandidates("legacy")];
    const heldCodes = new Set([
      "checkout-changed",
      "legacy-adoption-changed",
      "legacy-archive-changed",
      "legacy-audit-not-eligible",
      "legacy-checkout-changed",
      "legacy-cohort-peer-not-retired",
      "legacy-cohort-proof-changed",
      "legacy-dependency-universe-changed",
      "legacy-provider-in-use",
      "legacy-provider-scan-unsafe",
      "retirement-archive-missing",
      "retirement-archive-stale",
      "retirement-cross-device",
      "retirement-layout-blocked",
      "retirement-mount-present",
      "retirement-not-eligible",
      "retirement-source-changed",
      "retirement-state-changed",
      "retirement-tree-too-large",
      "unsafe-retirement-tree"
    ]);

    const checkoutResults = candidates.map((candidate) => {
      try {
        return sweepOne(candidate, bootId);
      } catch (error) {
        if (!(error instanceof CheckoutLifecycleError) || !heldCodes.has(error.code)) throw error;
        return observeRetirementHold(candidate, error.code);
      }
    });
    const results = [...checkoutResults, ...sweepArtifactRetirements(bootId)];
    return Object.freeze({
      bootId,
      results: Object.freeze(results)
    });
  }

  function retirementOverlay(kind, slug, generation, originalPath) {
    if (generation === null || generation === undefined) return Object.freeze({ state: "not-enrolled" });
    const records = readSweepRecords(kind, slug, generation, originalPath);
    if (records.length === 0) return Object.freeze({ state: "not-enrolled" });
    const eligible = records[0].loaded.value;
    const latest = records.at(-1);
    return Object.freeze({
      state: latest.kind,
      eligibleBootId: eligible.eligibleBootId,
      recordCount: records.length,
      terminal: latest.kind === "retired"
    });
  }

  function captureDiscoveryDirectory(path, label, expectedIdentity = undefined) {
    let metadata;
    try {
      metadata = lstatSync(path, { bigint: true });
    } catch {
      fail("discovery-root-unsafe", `${label} is missing or unreadable.`);
    }
    const identity = identityOf(metadata);
    if (
      !metadata.isDirectory() ||
      metadata.isSymbolicLink() ||
      !currentUserOwns(metadata) ||
      realpathSync(path) !== resolve(path) ||
      (expectedIdentity !== undefined && !sameIdentity(identity, expectedIdentity))
    ) {
      fail("discovery-root-unsafe", `${label} is not the expected owned canonical directory.`);
    }
    return identity;
  }

  function normalizeDiscoveryRoots(roots) {
    if (!Array.isArray(roots) || roots.length < 1 || roots.length > MAXIMUM_DISCOVERY_ROOTS) {
      fail("invalid-discovery-root", `Discovery requires 1-${MAXIMUM_DISCOVERY_ROOTS} explicit roots.`);
    }
    const normalized = roots.map((root) => {
      if (typeof root !== "string" || !isAbsolute(root) || resolve(root) !== root) {
        fail("invalid-discovery-root", "Discovery roots must be canonical absolute paths.");
      }
      return Object.freeze({ path: root, identity: captureDiscoveryDirectory(root, `Discovery root ${root}`) });
    });
    const paths = normalized.map((item) => item.path);
    if (
      new Set(paths).size !== paths.length ||
      paths.some((left, index) => paths.some((right, other) => index !== other && isSameOrContained(right, left)))
    ) {
      fail("invalid-discovery-root", "Discovery roots must be unique and non-overlapping.");
    }
    return Object.freeze(normalized.sort((left, right) => left.path.localeCompare(right.path)));
  }

  function revalidateDiscoveryFile(path, identity, label) {
    try {
      revalidatePathIdentity(path, identity, label);
    } catch {
      fail("discovery-candidate-unsafe", `${label} changed while discovery was reading it.`);
    }
  }

  function readGitDirectoryPointer(checkoutPath, dotGitPath) {
    const pointer = readBoundedFile(dotGitPath, MAXIMUM_WORKTREE_FIELD_BYTES, "Discovered .git pointer");
    const match = /^gitdir: ([^\0\r\n]+)\n$/u.exec(pointer.text);
    if (match === null) fail("discovery-candidate-unsafe", "A discovered .git pointer is malformed.");
    const gitDirectory = resolve(checkoutPath, match[1]);
    const gitIdentity = captureDiscoveryDirectory(gitDirectory, "Discovered worktree Git directory");
    revalidateDiscoveryFile(dotGitPath, pointer.identity, "Discovered .git pointer");
    const commonPointerPath = join(gitDirectory, "commondir");
    const commonPointer = readBoundedFile(
      commonPointerPath,
      MAXIMUM_WORKTREE_FIELD_BYTES,
      "Discovered common Git pointer"
    );
    const commonMatch = /^([^\0\r\n]+)\n$/u.exec(commonPointer.text);
    if (commonMatch === null) {
      fail("discovery-candidate-unsafe", "A discovered common Git pointer is malformed.");
    }
    const commonGitDirectory = resolve(gitDirectory, commonMatch[1]);
    const commonIdentity = captureDiscoveryDirectory(commonGitDirectory, "Discovered common Git directory");
    revalidateDiscoveryFile(commonPointerPath, commonPointer.identity, "Discovered common Git pointer");
    revalidatePathIdentity(gitDirectory, gitIdentity, "Discovered worktree Git directory", "directory");
    revalidatePathIdentity(commonGitDirectory, commonIdentity, "Discovered common Git directory", "directory");
    return Object.freeze({ gitDirectory, commonGitDirectory, commonIdentity });
  }

  function inspectDiscoveredRepository(checkoutPath, checkoutIdentity, dotGitMetadata) {
    const dotGitPath = join(checkoutPath, ".git");
    let kind;
    let commonGitDirectory;
    let commonIdentity;
    if (dotGitMetadata.isDirectory() && !dotGitMetadata.isSymbolicLink()) {
      kind = "standalone-clone";
      commonGitDirectory = dotGitPath;
      commonIdentity = captureDiscoveryDirectory(commonGitDirectory, "Discovered standalone Git directory");
    } else if (dotGitMetadata.isFile() && !dotGitMetadata.isSymbolicLink()) {
      kind = "linked-worktree";
      ({ commonGitDirectory, commonIdentity } = readGitDirectoryPointer(checkoutPath, dotGitPath));
    } else {
      fail("discovery-candidate-unsafe", "A discovered .git entry is a symbolic link or special file.");
    }
    const configPath = join(commonGitDirectory, "config");
    const config = readBoundedFile(configPath, MAXIMUM_LEGACY_CONFIG_BYTES, "Discovered repository configuration");
    const remote = run("git", ["config", "--file", configPath, "--no-includes", "--get", "remote.origin.url"], {
      cwd: checkoutPath,
      allowFailure: true,
      env: auditGitEnvironment()
    });
    const expectedRemote = canonicalRepositoryRemote(
      repository.managerRemote,
      repository.bootstrapSourceRepository?.topLevel ?? repository.topLevel
    );
    const candidateRemote =
      remote.status === 0 && remote.stdout.endsWith("\n")
        ? canonicalRepositoryRemote(remote.stdout.slice(0, -1), checkoutPath)
        : null;
    revalidateDiscoveryFile(configPath, config.identity, "Discovered repository configuration");
    revalidatePathIdentity(commonGitDirectory, commonIdentity, "Discovered common Git directory", "directory");
    revalidatePathIdentity(checkoutPath, checkoutIdentity, "Discovered checkout", "directory");
    if (expectedRemote === null || candidateRemote === null || candidateRemote !== expectedRemote) return undefined;
    const rootsResult = run("git", ["--git-dir", commonGitDirectory, "rev-list", "--max-parents=0", "--all"], {
      cwd: checkoutPath,
      allowFailure: true,
      env: auditGitEnvironment()
    });
    const roots = rootsResult.stdout.split("\n").filter(Boolean).sort();
    if (
      rootsResult.status !== 0 ||
      roots.length < 1 ||
      roots.length > MAXIMUM_REPOSITORY_ROOTS ||
      new Set(roots).size !== roots.length ||
      roots.some((root) => !SHA_PATTERN.test(root))
    ) {
      fail("discovery-candidate-unsafe", "A discovered repository has an unsupported root set.");
    }
    const sharedRoots = roots.filter(
      (root) =>
        commonGit(run, paths, repository, ["cat-file", "-e", `${root}^{commit}`], {
          allowFailure: true,
          env: auditGitEnvironment()
        }).status === 0
    );
    if (sharedRoots.length < 1) return undefined;
    revalidateDiscoveryFile(configPath, config.identity, "Discovered repository configuration");
    revalidatePathIdentity(commonGitDirectory, commonIdentity, "Discovered common Git directory", "directory");
    revalidatePathIdentity(checkoutPath, checkoutIdentity, "Discovered checkout", "directory");
    const isSource = checkoutPath === repository.bootstrapSourceRepository?.topLevel;
    const insideManager = isSameOrContained(paths.root, checkoutPath) || isSameOrContained(checkoutPath, paths.root);
    const sameCommonGitDirectory =
      kind === "linked-worktree" &&
      (sameIdentity(commonIdentity, repository.identity) ||
        (repository.bootstrapSourceRepository !== undefined &&
          sameIdentity(commonIdentity, repository.bootstrapSourceRepository.commonGitIdentity)));
    const supported = kind === "standalone-clone" && !isSource && !insideManager;
    return Object.freeze({
      path: checkoutPath,
      kind,
      sameRepository: true,
      adoptable: supported,
      adoptionProtocolSupported: supported,
      eligibility: supported ? "requires-explicit-audit" : "not-adoptable",
      owningCommonGitDirectory: kind === "linked-worktree" ? commonGitDirectory : null,
      sameCommonGitDirectory,
      repositoryProof: Object.freeze({
        remoteSha256: sha256(candidateRemote),
        rootCount: roots.length,
        rootsSha256: sha256(`${roots.join("\n")}\n`),
        sharedRootCount: sharedRoots.length,
        sharedRootsSha256: sha256(`${sharedRoots.join("\n")}\n`)
      }),
      reason:
        kind === "linked-worktree"
          ? sameCommonGitDirectory
            ? "same-common-dir-worktree-requires-owning-registry"
            : "requires-original-worktree-manager"
          : isSource
            ? "bootstrap-source"
            : insideManager
              ? "managed-checkout"
              : null
    });
  }

  function discoverRepositories({ roots, maxDepth = MAXIMUM_DISCOVERY_DEPTH }) {
    if (!Number.isSafeInteger(maxDepth) || maxDepth < 0 || maxDepth > MAXIMUM_DISCOVERY_DEPTH) {
      fail("invalid-discovery-depth", `Discovery depth must be between 0 and ${MAXIMUM_DISCOVERY_DEPTH}.`);
    }
    const normalizedRoots = normalizeDiscoveryRoots(roots);
    const results = [];
    let visitedEntries = 0;
    let repositoriesInspected = 0;
    let unsafeCandidates = 0;
    const visit = (directoryPath, directoryIdentity, depth) => {
      captureDiscoveryDirectory(directoryPath, "Discovery directory", directoryIdentity);
      const entries = readDirectoryBounded(directoryPath, MAXIMUM_DISCOVERY_ENTRIES, "A discovery directory").sort(
        (left, right) => Buffer.compare(Buffer.from(left.name), Buffer.from(right.name))
      );
      visitedEntries += entries.length;
      if (visitedEntries > MAXIMUM_DISCOVERY_ENTRIES) {
        fail("discovery-limit-exceeded", "Discovery exceeded its fixed entry limit.");
      }
      const dotGit = entries.find((item) => item.name === ".git");
      if (dotGit !== undefined) {
        repositoriesInspected += 1;
        if (repositoriesInspected > MAXIMUM_DISCOVERY_CANDIDATES) {
          fail("discovery-limit-exceeded", "Discovery exceeded its fixed repository limit.");
        }
        try {
          const metadata = lstatSync(join(directoryPath, ".git"), { bigint: true });
          const result = inspectDiscoveredRepository(directoryPath, directoryIdentity, metadata);
          if (result !== undefined) results.push(result);
        } catch (error) {
          if (!(error instanceof CheckoutLifecycleError) || !error.code.startsWith("discovery-")) throw error;
          unsafeCandidates += 1;
        }
        captureDiscoveryDirectory(directoryPath, "Discovery directory", directoryIdentity);
      }
      if (depth < maxDepth) {
        for (const item of entries) {
          if (item.name === ".git" || !item.isDirectory() || item.isSymbolicLink()) continue;
          const childPath = join(directoryPath, item.name);
          let childIdentity;
          try {
            childIdentity = captureDiscoveryDirectory(childPath, "Discovered directory");
          } catch (error) {
            if (!(error instanceof CheckoutLifecycleError) || error.code !== "discovery-root-unsafe") throw error;
            continue;
          }
          visit(childPath, childIdentity, depth + 1);
        }
      }
      captureDiscoveryDirectory(directoryPath, "Discovery directory", directoryIdentity);
    };
    for (const root of normalizedRoots) visit(root.path, root.identity, 0);
    for (const root of normalizedRoots) captureDiscoveryDirectory(root.path, "Discovery root", root.identity);
    const nameCounts = new Map();
    for (const result of results) {
      const name = basename(result.path);
      nameCounts.set(name, (nameCounts.get(name) ?? 0) + 1);
    }
    const reservations = slugAuthorityReservations();
    const occupiedNames = new Set([...reservations.managed, ...reservations.legacy]);
    const classified = results.map((result) => {
      const proposedSlug = basename(result.path);
      const nameReason = !SLUG_PATTERN.test(proposedSlug)
        ? "invalid-checkout-name"
        : nameCounts.get(proposedSlug) !== 1
          ? "duplicate-checkout-name"
          : occupiedNames.has(proposedSlug)
            ? "checkout-name-in-use"
            : null;
      const reason = result.reason ?? nameReason;
      const adoptable = result.adoptable && reason === null;
      return Object.freeze({
        ...result,
        proposedSlug,
        adoptable,
        adoptionProtocolSupported: adoptable,
        eligibility: adoptable ? "requires-explicit-audit" : "not-adoptable",
        reason
      });
    });
    return Object.freeze({
      roots: Object.freeze(normalizedRoots.map((root) => root.path)),
      maxDepth,
      visitedEntries,
      repositoriesInspected,
      unsafeCandidates,
      traversalGuarantee: "observed-symlinks-skipped-path-identities-revalidated",
      discovered: Object.freeze(classified.sort((left, right) => left.path.localeCompare(right.path))),
      authorizesAdoption: false,
      authorizesCleanup: false
    });
  }

  function captureLegacyBatchReview(manifest) {
    const explicitCatalog = manifest.normalized.dependencyCatalog !== undefined;
    const catalog = explicitCatalog
      ? captureExplicitLegacyDependencyCatalog(manifest.normalized.dependencyCatalog, manifest.normalized.candidates)
      : captureLegacyBatchDependencyCatalog(manifest.normalized.dependencyRoots, manifest.normalized.candidates);
    hooks?.afterLegacyBatchDependencyScan?.({
      mode: catalog.mode ?? "recursive-roots",
      visitedEntries: catalog.visitedEntries,
      repositoryCount: catalog.repositoryCount,
      ...(catalog.catalogEntryCount === undefined ? {} : { catalogEntryCount: catalog.catalogEntryCount })
    });
    const reservations = slugAuthorityReservations();
    const classified = manifest.normalized.candidates.map((candidate) => {
      if (reservations.managed.includes(candidate.slug)) {
        return Object.freeze({
          candidate,
          status: "blocked",
          code: "checkout-slug-reserved",
          message: `Checkout slug ${candidate.slug} already has retained lifecycle authority.`
        });
      }
      try {
        let existingAdoption;
        let resumableAttempt;
        const attempts = listLegacyAttempts(candidate.slug);
        const entry = readLegacyEntry(candidate.slug, attempts);
        if (entry !== undefined) {
          existingAdoption = retainedLegacyAdoption(candidate.slug);
        } else if (reservations.legacy.includes(candidate.slug) && attempts.length === 0) {
          fail("checkout-slug-reserved", `Checkout slug ${candidate.slug} belongs to other retained legacy history.`);
        }
        const evidence = captureLegacyAudit(
          candidate.slug,
          candidate.generatedRoots,
          candidate.generatedFiles,
          requestedExplicitLegacyTarget(
            candidate.slug,
            candidate.path,
            candidate.root,
            manifest.normalized.dependencyRoots
          ),
          catalog
        );
        const requestMatches = (request) =>
          request.protocol === LEGACY_ADOPTION_REQUEST_PROTOCOL_V2 &&
          request.ownerTask === candidate.ownerTask &&
          request.ownerRevision === 1 &&
          isDeepStrictEqual(request.generatedRoots, candidate.generatedRoots) &&
          isDeepStrictEqual(request.generatedFiles, candidate.generatedFiles) &&
          isDeepStrictEqual(request.target, explicitLegacyTargetFromEvidence(evidence));
        if (existingAdoption !== undefined) {
          if (
            !requestMatches(existingAdoption.request.value) ||
            !isDeepStrictEqual(existingAdoption.entry.value.evidence, evidence)
          ) {
            fail("checkout-slug-reserved", `Checkout slug ${candidate.slug} belongs to another retained adoption.`);
          }
        } else if (attempts.length !== 0) {
          if (attempts.length !== 1 || attempts[0].request === undefined) {
            fail(
              "checkout-slug-reserved",
              `Checkout slug ${candidate.slug} has ambiguous interrupted adoption history.`
            );
          }
          const [attempt] = attempts;
          if (!requestMatches(attempt.request.value)) {
            fail("checkout-slug-reserved", `Checkout slug ${candidate.slug} has a conflicting adoption request.`);
          }
          if (attempt.completion !== undefined) {
            if (
              lstatSync(join(attempt.path, "complete.json"), { bigint: true }).nlink !== 1n ||
              !isDeepStrictEqual(attempt.completion.value.evidence, evidence)
            ) {
              fail(
                "checkout-slug-reserved",
                `Checkout slug ${candidate.slug} has a conflicting unpublished completion.`
              );
            }
          }
          resumableAttempt = attempt;
        }
        if (existingAdoption === undefined && resumableAttempt === undefined) {
          preflightLegacyAdoptionRecords({
            slug: candidate.slug,
            generation: (attempts.at(-1)?.generation ?? 0) + 1,
            ownerTask: candidate.ownerTask,
            token: "0".repeat(32),
            generatedRoots: candidate.generatedRoots,
            generatedFiles: candidate.generatedFiles,
            target: explicitLegacyTargetFromEvidence(evidence),
            evidence
          });
        }
        return Object.freeze({
          candidate,
          status: "eligible",
          alreadyAdopted: existingAdoption !== undefined,
          resumableAttempt,
          evidence,
          evidenceSha256: sha256(`${JSON.stringify(evidence)}\n`)
        });
      } catch (error) {
        if (!(error instanceof CheckoutLifecycleError)) throw error;
        return Object.freeze({
          candidate,
          status: "blocked",
          code: error.code,
          message: error.message
        });
      }
    });
    catalog.revalidate();
    revalidatePathIdentity(manifest.path, manifest.identity, "Legacy batch manifest");
    const publicCandidates = Object.freeze(
      classified.map((item) =>
        Object.freeze({
          slug: item.candidate.slug,
          path: item.candidate.path,
          status: item.status,
          ...(item.status === "eligible"
            ? { evidenceSha256: item.evidenceSha256 }
            : { code: item.code, message: item.message })
        })
      )
    );
    const reviewCore = Object.freeze({
      protocol: explicitCatalog ? LEGACY_BATCH_REVIEW_PROTOCOL_V2 : LEGACY_BATCH_REVIEW_PROTOCOL,
      manifestSha256: manifest.sha256,
      dependencyScan: Object.freeze({
        ...(explicitCatalog ? { mode: "explicit-catalog", catalogEntryCount: catalog.catalogEntryCount } : {}),
        rootCount: catalog.roots.length,
        visitedEntries: catalog.visitedEntries,
        repositoryCount: catalog.repositoryCount
      }),
      candidates: publicCandidates
    });
    const reviewSha256 = sha256(`${JSON.stringify(reviewCore)}\n`);
    return Object.freeze({
      catalog,
      classified: Object.freeze(classified),
      public: Object.freeze({
        ...reviewCore,
        reviewSha256,
        eligibleCount: classified.filter((item) => item.status === "eligible").length,
        blockedCount: classified.filter((item) => item.status === "blocked").length,
        authorizesAdoption: false,
        authorizesCleanup: false
      })
    });
  }

  function listEntrySlugs(slug) {
    if (slug !== undefined) {
      readEntry(slug);
      return [slug];
    }
    const slugs = [...new Set(registryFiles().map((file) => file.slug))].sort();
    if (slugs.length > MAXIMUM_ENTRIES) fail("too-many-checkouts", "The checkout registry has too many checkouts.");
    return slugs;
  }

  function adoptLegacyInternal({
    slug,
    ownerTask,
    generatedRoots = [],
    generatedFiles = [],
    checkoutPath,
    approvedRoot,
    dependencyRoots,
    dependencyCatalog = undefined,
    resumeAttempt = undefined,
    expectedEvidence = undefined
  }) {
    assertSlug(slug);
    assertOwner(ownerTask);
    const requestedTarget = requestedExplicitLegacyTarget(slug, checkoutPath, approvedRoot, dependencyRoots);
    const allowlist = normalizeLegacyGeneratedAllowlist(generatedRoots, generatedFiles);
    const normalizedRoots = allowlist.filter((item) => item.kind === "directory").map((item) => item.path);
    const normalizedFiles = allowlist.filter((item) => item.kind === "file").map((item) => item.path);
    const reservations = assertSlugAuthorityAvailable(slug, "legacy");
    const priorAttempts = listLegacyAttempts(slug);
    if (legacyEntrySlugs(slug).length !== 0) {
      readLegacyEntry(slug, priorAttempts);
      fail("legacy-adoption-exists", `Legacy checkout ${slug} is already adopted for review.`);
    }
    if (reservations.legacy.length !== 0 && priorAttempts.length === 0) {
      fail("legacy-adoption-exists", `Legacy checkout ${slug} has retained lifecycle history.`);
    }

    let attempt;
    let request;
    let explicitTarget;
    if (resumeAttempt === undefined) {
      const generation = (priorAttempts.at(-1)?.generation ?? 0) + 1;
      if (generation > MAXIMUM_LEGACY_ADOPTION_ATTEMPTS) {
        fail("legacy-adoption-attempts-exhausted", "The legacy adoption journal has no remaining attempt slots.");
      }
      const token = tokenFactory();
      if (!/^[0-9a-f]{32}$/u.test(token)) fail("invalid-legacy-adoption", "The adoption token is malformed.");
      const preflightEvidence = captureLegacyAudit(
        slug,
        normalizedRoots,
        normalizedFiles,
        requestedTarget,
        dependencyCatalog
      );
      explicitTarget = explicitLegacyTargetFromEvidence(preflightEvidence);
      const requestValue = preflightLegacyAdoptionRecords({
        slug,
        generation,
        ownerTask,
        token,
        generatedRoots: normalizedRoots,
        generatedFiles: normalizedFiles,
        target: explicitTarget,
        evidence: preflightEvidence
      });
      initializeLegacyAdoptionJournal();
      attempt = allocateLegacyAttempt(slug);
      if (attempt.generation !== generation) {
        fail("legacy-adoption-changed", "The next legacy adoption attempt changed after preflight.");
      }
      const requestPath = join(attempt.path, "request.json");
      writeJsonExclusive(requestPath, requestValue, attempt.identity);
      request = readJsonReceipt(requestPath, MAXIMUM_ENTRY_BYTES, "Legacy adoption request");
      validateLegacyRequest(request.value, slug, attempt.generation);
      if (!isDeepStrictEqual(request.value, requestValue)) {
        fail("legacy-adoption-changed", "The legacy adoption request changed while it was recorded.");
      }
      hooks?.afterLegacyAdoptionRequest?.(attempt, requestValue);
    } else {
      initializeLegacyAdoptionJournal();
      if (expectedEvidence === undefined || dependencyCatalog === undefined || priorAttempts.length !== 1) {
        fail("legacy-adoption-changed", "The interrupted batch adoption no longer has one exact resumable attempt.");
      }
      const [retainedAttempt] = priorAttempts;
      if (
        retainedAttempt.request === undefined ||
        retainedAttempt.slug !== resumeAttempt.slug ||
        retainedAttempt.generation !== resumeAttempt.generation ||
        retainedAttempt.path !== resumeAttempt.path ||
        !sameIdentity(retainedAttempt.identity, resumeAttempt.identity) ||
        !isDeepStrictEqual(retainedAttempt.request, resumeAttempt.request) ||
        !isDeepStrictEqual(retainedAttempt.completion, resumeAttempt.completion)
      ) {
        fail("legacy-adoption-changed", "The interrupted batch adoption attempt changed before it could resume.");
      }
      attempt = retainedAttempt;
      request = retainedAttempt.request;
      explicitTarget = legacyTargetFromRequest(request.value);
      if (
        request.value.protocol !== LEGACY_ADOPTION_REQUEST_PROTOCOL_V2 ||
        request.value.ownerTask !== ownerTask ||
        request.value.ownerRevision !== 1 ||
        !isDeepStrictEqual(request.value.generatedRoots, normalizedRoots) ||
        !isDeepStrictEqual(request.value.generatedFiles, normalizedFiles) ||
        !isDeepStrictEqual(explicitTarget, explicitLegacyTargetFromEvidence(expectedEvidence))
      ) {
        fail(
          "legacy-adoption-changed",
          "The interrupted batch adoption request conflicts with the reviewed candidate."
        );
      }
    }

    const firstEvidence = captureLegacyAudit(slug, normalizedRoots, normalizedFiles, explicitTarget, dependencyCatalog);
    hooks?.afterFirstLegacyAudit?.(attempt, firstEvidence);
    const secondEvidence = captureLegacyAudit(
      slug,
      normalizedRoots,
      normalizedFiles,
      explicitTarget,
      dependencyCatalog
    );
    if (
      !isDeepStrictEqual(firstEvidence, secondEvidence) ||
      (expectedEvidence !== undefined && !isDeepStrictEqual(secondEvidence, expectedEvidence))
    ) {
      fail("legacy-checkout-changed", "The legacy checkout changed between its reviewed adoption audits.");
    }

    const requestPath = join(attempt.path, "request.json");
    revalidatePathIdentity(requestPath, request.identity, "Legacy adoption request");
    revalidatePathIdentity(attempt.path, attempt.identity, "Legacy adoption attempt", "directory");
    const completionValue = {
      protocol: LEGACY_ADOPTION_COMPLETION_PROTOCOL_V2,
      slug,
      generation: attempt.generation,
      ownerTask,
      ownerRevision: 1,
      request: {
        path: requestPath,
        identity: request.identity,
        byteLength: request.byteLength,
        sha256: request.sha256
      },
      evidence: secondEvidence
    };
    validateLegacyCompletion(completionValue, slug, attempt.generation);
    assertPersistedJsonFits(completionValue, "The legacy adoption completion");
    const completionPath = join(attempt.path, "complete.json");
    let completion;
    if (attempt.completion === undefined) {
      hooks?.beforeLegacyAdoptionCompletion?.(attempt, secondEvidence);
      writeJsonExclusive(completionPath, completionValue, attempt.identity);
      completion = readJsonReceipt(completionPath, MAXIMUM_ENTRY_BYTES, "Legacy adoption completion");
      validateLegacyCompletion(completion.value, slug, attempt.generation);
      if (!isDeepStrictEqual(completion.value, completionValue)) {
        fail("legacy-adoption-changed", "The legacy completion changed while it was recorded.");
      }
    } else {
      completion = attempt.completion;
      if (
        lstatSync(completionPath, { bigint: true }).nlink !== 1n ||
        !isDeepStrictEqual(completion.value, completionValue)
      ) {
        fail("legacy-adoption-changed", "The unpublished legacy completion conflicts with the reviewed candidate.");
      }
    }

    const entriesIdentity = managedIdentities.get(paths.legacyAdoptionEntries);
    if (entriesIdentity === undefined) fail("unsafe-manager", "The legacy adoption entries were not initialized.");
    revalidatePathIdentity(paths.legacyAdoptionEntries, entriesIdentity, "Legacy adoption entries", "directory");
    hooks?.beforeLegacyAdoptionPublish?.(attempt, completionValue);
    const publicationEvidence = captureLegacyAudit(
      slug,
      normalizedRoots,
      normalizedFiles,
      explicitTarget,
      dependencyCatalog
    );
    if (!isDeepStrictEqual(publicationEvidence, secondEvidence)) {
      fail("legacy-checkout-changed", "The legacy checkout changed before adoption publication.");
    }
    revalidatePathIdentity(requestPath, request.identity, "Legacy adoption request");
    revalidatePathIdentity(completionPath, completion.identity, "Legacy adoption completion");
    revalidatePathIdentity(attempt.path, attempt.identity, "Legacy adoption attempt", "directory");
    revalidatePathIdentity(paths.legacyAdoptionEntries, entriesIdentity, "Legacy adoption entries", "directory");
    try {
      linkSync(completionPath, legacyEntryPath(slug));
      fsyncDirectory(paths.legacyAdoptionEntries);
    } catch (error) {
      if (error.code === "EEXIST") {
        fail("legacy-adoption-exists", `Legacy checkout ${slug} was adopted concurrently.`);
      }
      throw error;
    }
    hooks?.afterLegacyAdoptionPublish?.(attempt, completionValue);
    revalidateLegacyEvidenceSource(secondEvidence);
    revalidatePathIdentity(paths.legacyAdoptionEntries, entriesIdentity, "Legacy adoption entries", "directory");
    const recordedAttempts = listLegacyAttempts(slug);
    const entry = readLegacyEntry(slug, recordedAttempts);
    if (entry === undefined || !isDeepStrictEqual(entry.value, completionValue)) {
      fail("legacy-adoption-changed", "The published legacy adoption record changed.");
    }
    revalidatePathIdentity(attempt.path, attempt.identity, "Legacy adoption attempt", "directory");
    return Object.freeze({
      status: resumeAttempt === undefined ? "adopted-review-required" : "resumed-adoption-review-required",
      slug,
      generation: attempt.generation,
      ownerTask,
      ownerRevision: 1,
      evidence: entry.value.evidence,
      authorizesMove: false,
      authorizesCleanup: false
    });
  }

  function artifactStatRecord(metadata) {
    return Object.freeze({
      identity: identityOf(metadata),
      mode: Number(metadata.mode & 0o7777n),
      size: metadata.size.toString(),
      mtimeNs: metadata.mtimeNs.toString(),
      ctimeNs: metadata.ctimeNs.toString()
    });
  }

  function sameArtifactStat(left, right) {
    return (
      sameIdentity(identityOf(left), identityOf(right)) &&
      left.mode === right.mode &&
      left.size === right.size &&
      left.nlink === right.nlink &&
      left.mtimeNs === right.mtimeNs &&
      left.ctimeNs === right.ctimeNs
    );
  }

  function requireArtifactDescriptorTraversal() {
    if (
      process.platform !== "linux" ||
      typeof constants.O_DIRECTORY !== "number" ||
      typeof constants.O_NOFOLLOW !== "number"
    ) {
      fail(
        "artifact-platform-unsupported",
        "Generated-artifact review and retirement require Linux descriptor-relative filesystem operations."
      );
    }
  }

  function artifactDescriptorPath(descriptor, name = undefined) {
    const base = `/proc/self/fd/${descriptor}`;
    if (name === undefined) return base;
    if (name === "" || name === "." || name === ".." || name.includes("/") || name.includes("\0")) {
      fail("artifact-unsafe", "A generated artifact contains an invalid entry name.");
    }
    return `${base}/${name}`;
  }

  function inheritedDescriptorPath(descriptor) {
    return `/proc/${process.pid}/fd/${descriptor}`;
  }

  function descriptorMountId(descriptor, label) {
    requireArtifactDescriptorTraversal();
    let infoDescriptor;
    try {
      infoDescriptor = openSync(`/proc/self/fdinfo/${descriptor}`, constants.O_RDONLY | (constants.O_CLOEXEC ?? 0));
      const buffer = Buffer.allocUnsafe(8193);
      const count = readSync(infoDescriptor, buffer, 0, buffer.length, 0);
      if (count === buffer.length) fail("artifact-unsafe", `${label} has oversized descriptor metadata.`);
      const text = new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, count));
      const matches = [...text.matchAll(/^mnt_id:\s+([1-9][0-9]*)$/gmu)];
      if (matches.length !== 1) fail("artifact-unsafe", `${label} has ambiguous mount identity.`);
      return matches[0][1];
    } catch (error) {
      if (error instanceof CheckoutLifecycleError) throw error;
      fail("artifact-unsafe", `${label} mount identity could not be read: ${error.message}`);
    } finally {
      if (infoDescriptor !== undefined) closeSync(infoDescriptor);
    }
  }

  function openArtifactDirectoryDescriptor(path, label, expectedIdentity = undefined, requireOwned = true) {
    requireArtifactDescriptorTraversal();
    if (!isAbsolute(path) || resolve(path) !== path) {
      fail("artifact-unsafe", `${label} is not an absolute canonical path.`);
    }
    const flags = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW | (constants.O_CLOEXEC ?? 0);
    let descriptor;
    try {
      descriptor = openSync("/", flags);
      for (const component of path.split("/").filter((value) => value !== "")) {
        const next = openSync(artifactDescriptorPath(descriptor, component), flags);
        closeSync(descriptor);
        descriptor = next;
      }
      const metadata = fstatSync(descriptor, { bigint: true });
      if (
        !metadata.isDirectory() ||
        (requireOwned && !currentUserOwns(metadata)) ||
        (expectedIdentity !== undefined && !sameIdentity(identityOf(metadata), expectedIdentity))
      ) {
        fail("artifact-unsafe", `${label} is not the expected owned directory.`);
      }
      return Object.freeze({ descriptor, metadata });
    } catch (error) {
      if (descriptor !== undefined) closeSync(descriptor);
      if (error instanceof CheckoutLifecycleError) throw error;
      fail("artifact-unsafe", `${label} could not be opened without following links: ${error.message}`);
    }
  }

  function openArtifactChildDirectoryDescriptor(parentDescriptor, name, observed, label) {
    requireArtifactDescriptorTraversal();
    let descriptor;
    try {
      descriptor = openSync(
        artifactDescriptorPath(parentDescriptor, name),
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW | (constants.O_CLOEXEC ?? 0)
      );
      const metadata = fstatSync(descriptor, { bigint: true });
      if (!metadata.isDirectory() || !currentUserOwns(metadata) || !sameArtifactStat(metadata, observed)) {
        fail("artifact-changed", `${label} changed before descriptor-relative traversal.`);
      }
      return Object.freeze({ descriptor, metadata });
    } catch (error) {
      if (descriptor !== undefined) closeSync(descriptor);
      if (error instanceof CheckoutLifecycleError) throw error;
      fail("artifact-changed", `${label} could not be opened without following links: ${error.message}`);
    }
  }

  function openArtifactPrivateChildDirectory(parentDescriptor, name, expectedIdentity, label) {
    requireArtifactDescriptorTraversal();
    let descriptor;
    try {
      descriptor = openSync(
        artifactDescriptorPath(parentDescriptor, name),
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW | (constants.O_CLOEXEC ?? 0)
      );
      const metadata = fstatSync(descriptor, { bigint: true });
      if (
        !metadata.isDirectory() ||
        !currentUserOwns(metadata) ||
        (typeof process.getuid === "function" && (metadata.mode & 0o777n) !== 0o700n) ||
        !sameIdentity(identityOf(metadata), expectedIdentity)
      ) {
        fail("artifact-purge-unsafe", `${label} changed before descriptor-relative traversal.`);
      }
      return Object.freeze({ descriptor, metadata });
    } catch (error) {
      if (descriptor !== undefined) closeSync(descriptor);
      if (error instanceof CheckoutLifecycleError) throw error;
      fail("artifact-purge-unsafe", `${label} could not be opened without following links: ${error.message}`);
    }
  }

  function synchronizeArtifactDirectory(descriptor, path) {
    if (syncArtifactDirectoryHook === undefined) syncArtifactDescriptor(descriptor);
    else syncArtifactDirectoryHook(path, descriptor);
  }

  function readArtifactDirectoryBounded(directoryDescriptor, label, maximumEntries = MAXIMUM_ARTIFACT_ENTRIES) {
    const directory = opendirSync(artifactDescriptorPath(directoryDescriptor), { encoding: "buffer" });
    const entries = [];
    try {
      let item;
      while ((item = directory.readSync()) !== null) {
        if (entries.length === maximumEntries) {
          fail("artifact-too-large", `${label} exceeds its fixed entry limit.`);
        }
        let name;
        try {
          name = new TextDecoder("utf-8", { fatal: true }).decode(item.name);
        } catch {
          fail("artifact-unsafe", `${label} contains a filename that is not strict UTF-8.`);
        }
        if (!Buffer.from(name, "utf8").equals(item.name)) {
          fail("artifact-unsafe", `${label} contains a filename that cannot round-trip exactly.`);
        }
        entries.push(Object.freeze({ name, nameBytes: Buffer.from(item.name) }));
      }
    } finally {
      directory.closeSync();
    }
    return entries;
  }

  function validateArtifactRoot(path, label, expectedIdentity = undefined) {
    let metadata;
    try {
      metadata = lstatSync(path, { bigint: true });
    } catch {
      fail("artifact-not-found", `${label} is missing.`);
    }
    if (
      !metadata.isDirectory() ||
      metadata.isSymbolicLink() ||
      !currentUserOwns(metadata) ||
      realpathSync(path) !== path ||
      (expectedIdentity !== undefined && !sameIdentity(identityOf(metadata), expectedIdentity))
    ) {
      fail("artifact-unsafe", `${label} is not the expected owned canonical directory.`);
    }
    return Object.freeze({ identity: identityOf(metadata), device: metadata.dev });
  }

  function normalizedManagedArtifactStem(value) {
    return value
      .toLowerCase()
      .replace(/[^a-z0-9]+/gu, "-")
      .replace(/^-+|-+$/gu, "");
  }

  function managedArtifactJournalSlug(checkoutSlug, generatedRoot) {
    const normalizedRoot = normalizedManagedArtifactStem(generatedRoot) || "generated";
    const stem = `${checkoutSlug}-${normalizedRoot}`;
    const digest = sha256(Buffer.from(`${checkoutSlug}\0${generatedRoot}`, "utf8")).slice(0, 24);
    const prefix = stem.slice(0, 39).replace(/-+$/gu, "") || "managed-artifact";
    const journalSlug = `${prefix}-${digest}`;
    assertSlug(journalSlug);
    return journalSlug;
  }

  function validateManagedArtifactAuthority({ slug, artifactPath, approvedRoot, ownerTask, ownerRevision }) {
    if (dirname(approvedRoot) !== paths.checkouts) return undefined;
    const checkoutSlug = basename(approvedRoot);
    if (!SLUG_PATTERN.test(checkoutSlug) || checkoutPathFor(checkoutSlug) !== approvedRoot) {
      fail("invalid-artifact-target", "The reviewed manager path is not an exact managed checkout.");
    }
    const generatedRoot = basename(artifactPath);
    const entry = readEntry(checkoutSlug);
    assertOwnerRevision(entry, ownerTask, ownerRevision);
    if (
      entry.state !== "cleanup-pending" ||
      entry.cleanupRequest.reason !== "finish" ||
      !entry.generatedRoots.includes(generatedRoot)
    ) {
      fail(
        "artifact-not-eligible",
        "Only a registered generated root in a finished managed checkout can use artifact retirement."
      );
    }
    const journalSlug = managedArtifactJournalSlug(checkoutSlug, generatedRoot);
    if (slug !== generatedRoot && slug !== journalSlug) {
      fail(
        "invalid-artifact-target",
        `Use ${generatedRoot} (or its checkout-scoped journal ID ${journalSlug}) for this generated root.`
      );
    }
    const audit = auditEntry(entry);
    if (!audit.candidateForReviewedCleanup) {
      fail(
        "artifact-not-eligible",
        "The managed checkout contains work other than its registered generated roots or no longer matches its receipt."
      );
    }
    const tracked = auditCheckoutGit(run, paths, approvedRoot, entry.checkout.gitAdmin.path, [
      "ls-files",
      "-z",
      "--",
      generatedRoot
    ]);
    if (tracked.status !== 0 || tracked.stdout !== "") {
      fail("artifact-not-eligible", "A registered generated root contains tracked repository files.");
    }
    const status = auditCheckoutGit(run, paths, approvedRoot, entry.checkout.gitAdmin.path, [
      "status",
      "--porcelain=v2",
      "-z",
      "--untracked-files=all",
      "--ignored=matching",
      "--ignore-submodules=all",
      "--",
      generatedRoot
    ]);
    const records = status.status === 0 ? parseStatus(status.stdout) : [];
    if (
      records.length === 0 ||
      records.some((record) => record.kind !== "ignored" || !belongsToGeneratedRoot(record.path, [generatedRoot]))
    ) {
      fail("artifact-not-eligible", "The registered generated root is not proven to be ignored generated content.");
    }
    return Object.freeze({ checkoutSlug, generatedRoot, journalSlug });
  }

  function revalidateManagedArtifactAuthority(args) {
    try {
      return validateManagedArtifactAuthority(args);
    } catch (error) {
      if (
        error instanceof CheckoutLifecycleError &&
        ["artifact-not-eligible", "checkout-not-found", "invalid-artifact-target", "ownership-changed"].includes(
          error.code
        )
      ) {
        fail("artifact-source-changed", "The managed checkout no longer grants this artifact retirement authority.");
      }
      throw error;
    }
  }

  function normalizeArtifactTarget({ slug, artifactPath, approvedRoot, ownerTask, ownerRevision }) {
    assertOwner(ownerTask);
    assertRevision(ownerRevision);
    if (
      typeof slug !== "string" ||
      typeof artifactPath !== "string" ||
      typeof approvedRoot !== "string" ||
      !isAbsolute(artifactPath) ||
      !isAbsolute(approvedRoot) ||
      resolve(artifactPath) !== artifactPath ||
      resolve(approvedRoot) !== approvedRoot ||
      dirname(artifactPath) !== approvedRoot
    ) {
      fail(
        "invalid-artifact-target",
        "Generated-artifact retirement requires one canonical direct child of its reviewed root."
      );
    }
    const managed = validateManagedArtifactAuthority({
      slug,
      artifactPath,
      approvedRoot,
      ownerTask,
      ownerRevision
    });
    if (managed === undefined) {
      assertSlug(slug);
      if (basename(artifactPath) !== slug) {
        fail("invalid-artifact-target", "A standalone generated artifact must have the same basename as its slug.");
      }
      if (
        isSameOrContained(paths.root, approvedRoot) ||
        isSameOrContained(approvedRoot, paths.root) ||
        isSameOrContained(paths.root, artifactPath) ||
        isSameOrContained(artifactPath, paths.root)
      ) {
        fail(
          "invalid-artifact-target",
          "Manager state may contain only an exact registered generated root from a finished managed checkout."
        );
      }
    }
    const root = validateArtifactRoot(approvedRoot, "Reviewed artifact root");
    const artifact = validateArtifactRoot(artifactPath, "Generated artifact");
    if (root.device !== artifact.device) {
      fail("artifact-unsafe", "The generated artifact crosses a filesystem boundary at its reviewed root.");
    }
    assertNoMountAtOrBelow(artifactPath);
    return Object.freeze({
      slug: managed?.journalSlug ?? slug,
      artifactPath,
      approvedRoot,
      ownerTask,
      ownerRevision,
      rootIdentity: root.identity,
      artifactIdentity: artifact.identity,
      device: artifact.device
    });
  }

  function writeArtifactManifestRecord(descriptor, state, record) {
    const line = Buffer.from(`${JSON.stringify(record)}\n`, "utf8");
    state.manifestBytes += BigInt(line.byteLength);
    if (state.manifestBytes > MAXIMUM_ARTIFACT_MANIFEST_BYTES) {
      fail("artifact-too-large", "The exact generated-artifact manifest exceeds its fixed size limit.");
    }
    let offset = 0;
    while (offset < line.length) offset += writeSync(descriptor, line, offset, line.length - offset);
  }

  function scanArtifactTree(rootPath, expectedIdentity, options = {}) {
    const rootHandle = openArtifactDirectoryDescriptor(rootPath, "Generated artifact", expectedIdentity);
    let destinationHandle;
    if (options.destinationRoot !== undefined) {
      if (options.destinationIdentity === undefined) {
        closeSync(rootHandle.descriptor);
        fail("artifact-unsafe", "Generated-artifact recovery requires its exact destination identity.");
      }
      try {
        destinationHandle = openArtifactDirectoryDescriptor(
          options.destinationRoot,
          "Generated-artifact recovery destination",
          options.destinationIdentity
        );
      } catch (error) {
        closeSync(rootHandle.descriptor);
        throw error;
      }
    }
    const root = Object.freeze({ identity: identityOf(rootHandle.metadata), device: rootHandle.metadata.dev });
    const identityHash = createHash("sha256");
    const semanticHash = createHash("sha256");
    const state = { entries: 0, directories: 0, files: 0, symlinks: 0, bytes: 0n, manifestBytes: 0n };
    const manifestDescriptor = options.manifestDescriptor;
    const destinationRoot = options.destinationRoot;

    const add = (identityRecord, semanticRecord) => {
      state.entries += 1;
      if (state.entries > MAXIMUM_ARTIFACT_ENTRIES) {
        fail("artifact-too-large", "The generated artifact exceeds its fixed entry limit.");
      }
      const identityLine = `${JSON.stringify(identityRecord)}\n`;
      const semanticLine = `${JSON.stringify(semanticRecord)}\n`;
      identityHash.update(identityLine);
      semanticHash.update(semanticLine);
      if (manifestDescriptor !== undefined) writeArtifactManifestRecord(manifestDescriptor, state, identityRecord);
    };

    const copyFile = (sourceReference, destinationPath, observed, relativePath) => {
      let sourceDescriptor;
      let destinationDescriptor;
      try {
        sourceDescriptor = openSync(sourceReference, constants.O_RDONLY | constants.O_NOFOLLOW);
        const before = fstatSync(sourceDescriptor, { bigint: true });
        if (
          !before.isFile() ||
          before.isSymbolicLink() ||
          before.nlink !== 1n ||
          !currentUserOwns(before) ||
          before.dev !== root.device ||
          !sameIdentity(identityOf(before), identityOf(observed)) ||
          before.size > MAXIMUM_ARTIFACT_BYTES
        ) {
          fail("artifact-unsafe", `Generated artifact file ${relativePath} is unsafe.`);
        }
        if (destinationPath !== undefined) {
          destinationDescriptor = openSync(
            destinationPath,
            constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0),
            0o600
          );
        }
        const hash = createHash("sha256");
        const buffer = Buffer.allocUnsafe(1024 * 1024);
        let offset = 0n;
        while (offset < before.size) {
          const length = Number(
            before.size - offset > BigInt(buffer.length) ? BigInt(buffer.length) : before.size - offset
          );
          const count = readSync(sourceDescriptor, buffer, 0, length, Number(offset));
          if (count === 0) fail("artifact-changed", `Generated artifact file ${relativePath} changed while read.`);
          hash.update(buffer.subarray(0, count));
          if (destinationDescriptor !== undefined) {
            let written = 0;
            while (written < count) {
              written += writeSync(destinationDescriptor, buffer, written, count - written);
            }
          }
          offset += BigInt(count);
        }
        if (destinationDescriptor !== undefined) {
          fchmodSync(destinationDescriptor, Number(before.mode & 0o7777n));
          syncArtifactDescriptor(destinationDescriptor);
        }
        const after = fstatSync(sourceDescriptor, { bigint: true });
        const named = lstatSync(sourceReference, { bigint: true });
        if (!sameArtifactStat(before, after) || !sameArtifactStat(before, named)) {
          fail("artifact-changed", `Generated artifact file ${relativePath} changed while read.`);
        }
        return Object.freeze({ stat: artifactStatRecord(before), sha256: hash.digest("hex") });
      } finally {
        if (destinationDescriptor !== undefined) closeSync(destinationDescriptor);
        if (sourceDescriptor !== undefined) closeSync(sourceDescriptor);
      }
    };

    const visit = (
      directoryDescriptor,
      namedReference,
      relativePath,
      depth,
      destinationDescriptor,
      destinationNamedReference,
      destinationPath
    ) => {
      if (depth > MAXIMUM_ARTIFACT_DEPTH) {
        fail("artifact-too-large", "The generated artifact exceeds its fixed depth limit.");
      }
      const before = fstatSync(directoryDescriptor, { bigint: true });
      if (
        !before.isDirectory() ||
        !currentUserOwns(before) ||
        before.dev !== root.device ||
        (relativePath === "" && !sameIdentity(identityOf(before), expectedIdentity))
      ) {
        fail("artifact-unsafe", `Generated artifact directory ${relativePath || "."} is unsafe.`);
      }
      state.directories += 1;
      const stat = artifactStatRecord(before);
      add(
        { kind: "directory", path: relativePath, ...stat },
        { kind: "directory", path: relativePath, mode: stat.mode }
      );
      if (destinationDescriptor !== undefined) {
        hooks?.beforeArtifactRecoveryDirectoryWrite?.(Object.freeze({ destinationRoot, relativePath }));
      }
      hooks?.beforeArtifactDirectoryRead?.(Object.freeze({ rootPath, relativePath }));
      const entries = readArtifactDirectoryBounded(directoryDescriptor, "The generated artifact").sort((left, right) =>
        Buffer.compare(left.nameBytes, right.nameBytes)
      );
      for (const item of entries) {
        if (item.name === ".git") {
          fail("artifact-repository-marker", "A generated artifact contains a prohibited .git marker.");
        }
        if (
          item.name === "" ||
          item.name === "." ||
          item.name === ".." ||
          item.name.includes("/") ||
          item.name.includes("\0")
        ) {
          fail("artifact-unsafe", "A generated artifact contains an invalid entry name.");
        }
        const childReference = artifactDescriptorPath(directoryDescriptor, item.name);
        const childRelative = relativePath === "" ? item.name : `${relativePath}/${item.name}`;
        const childDestination =
          destinationDescriptor === undefined ? undefined : artifactDescriptorPath(destinationDescriptor, item.name);
        const childDestinationPath = destinationPath === undefined ? undefined : join(destinationPath, item.name);
        const metadata = lstatSync(childReference, { bigint: true });
        if (!currentUserOwns(metadata) || metadata.dev !== root.device) {
          fail(
            "artifact-unsafe",
            `Generated artifact entry ${childRelative} crosses ownership or filesystem boundaries.`
          );
        }
        if (metadata.isDirectory() && !metadata.isSymbolicLink()) {
          if (childDestination !== undefined) mkdirSync(childDestination, { mode: 0o700 });
          const child = openArtifactChildDirectoryDescriptor(
            directoryDescriptor,
            item.name,
            metadata,
            `Generated artifact directory ${childRelative}`
          );
          let destinationChild;
          try {
            if (childDestination !== undefined) {
              const destinationMetadata = lstatSync(childDestination, { bigint: true });
              destinationChild = openArtifactChildDirectoryDescriptor(
                destinationDescriptor,
                item.name,
                destinationMetadata,
                `Generated-artifact recovery directory ${childRelative}`
              );
            }
            visit(
              child.descriptor,
              childReference,
              childRelative,
              depth + 1,
              destinationChild?.descriptor,
              childDestination,
              childDestinationPath
            );
          } finally {
            if (destinationChild !== undefined) closeSync(destinationChild.descriptor);
            closeSync(child.descriptor);
          }
        } else if (metadata.isFile() && !metadata.isSymbolicLink()) {
          const file = copyFile(childReference, childDestination, metadata, childRelative);
          state.files += 1;
          state.bytes += BigInt(file.stat.size);
          if (state.bytes > MAXIMUM_ARTIFACT_BYTES) {
            fail("artifact-too-large", "The generated artifact exceeds its fixed byte limit.");
          }
          add(
            { kind: "file", path: childRelative, ...file.stat, sha256: file.sha256 },
            {
              kind: "file",
              path: childRelative,
              mode: file.stat.mode,
              size: file.stat.size,
              sha256: file.sha256
            }
          );
        } else if (metadata.isSymbolicLink()) {
          if (metadata.nlink !== 1n) {
            fail("artifact-unsafe", `Generated artifact symlink ${childRelative} has multiple hard links.`);
          }
          const target = readlinkSync(childReference, { encoding: "buffer" });
          if (target.byteLength > MAXIMUM_ARTIFACT_SYMLINK_BYTES) {
            fail("artifact-too-large", `Generated artifact symlink ${childRelative} is too long.`);
          }
          const after = lstatSync(childReference, { bigint: true });
          if (!sameArtifactStat(metadata, after)) {
            fail("artifact-changed", `Generated artifact symlink ${childRelative} changed while read.`);
          }
          const targetBase64 = target.toString("base64");
          if (childDestination !== undefined) symlinkSync(target, childDestination);
          state.symlinks += 1;
          state.bytes += BigInt(target.byteLength);
          if (state.bytes > MAXIMUM_ARTIFACT_BYTES) {
            fail("artifact-too-large", "The generated artifact exceeds its fixed byte limit.");
          }
          const linkStat = artifactStatRecord(metadata);
          add(
            {
              kind: "symlink",
              path: childRelative,
              ...linkStat,
              targetBytes: target.byteLength.toString(),
              targetBase64,
              targetSha256: sha256(target)
            },
            { kind: "symlink", path: childRelative, targetBytes: target.byteLength.toString(), targetBase64 }
          );
        } else {
          fail("artifact-special-file", `Generated artifact entry ${childRelative} is a special file.`);
        }
      }
      const after = fstatSync(directoryDescriptor, { bigint: true });
      const named = namedReference === undefined ? after : lstatSync(namedReference, { bigint: true });
      if (!sameArtifactStat(before, after) || !sameArtifactStat(before, named)) {
        fail("artifact-changed", `Generated artifact directory ${relativePath || "."} changed while scanned.`);
      }
      if (destinationDescriptor !== undefined) {
        fchmodSync(destinationDescriptor, Number(before.mode & 0o7777n));
        synchronizeArtifactDirectory(destinationDescriptor, destinationPath);
        const destinationAfter = fstatSync(destinationDescriptor, { bigint: true });
        const destinationNamed =
          destinationNamedReference === undefined
            ? destinationAfter
            : lstatSync(destinationNamedReference, { bigint: true });
        if (
          !destinationAfter.isDirectory() ||
          !destinationNamed.isDirectory() ||
          destinationNamed.isSymbolicLink() ||
          !sameIdentity(identityOf(destinationAfter), identityOf(destinationNamed))
        ) {
          fail("artifact-archive-changed", "A generated-artifact recovery directory changed during publication.");
        }
      }
    };

    try {
      visit(rootHandle.descriptor, undefined, "", 0, destinationHandle?.descriptor, undefined, destinationRoot);
    } finally {
      if (destinationHandle !== undefined) closeSync(destinationHandle.descriptor);
      closeSync(rootHandle.descriptor);
    }
    const confirmed = openArtifactDirectoryDescriptor(rootPath, "Generated artifact", expectedIdentity);
    closeSync(confirmed.descriptor);
    return Object.freeze({
      identity: expectedIdentity,
      entryCount: state.entries,
      directoryCount: state.directories,
      fileCount: state.files,
      symlinkCount: state.symlinks,
      byteLength: state.bytes.toString(),
      manifestByteLength: state.manifestBytes.toString(),
      identitySha256: identityHash.digest("hex"),
      semanticSha256: semanticHash.digest("hex")
    });
  }

  function captureArtifactReview(args) {
    const target = normalizeArtifactTarget(args);
    const first = scanArtifactTree(target.artifactPath, target.artifactIdentity);
    hooks?.betweenArtifactAuditPasses?.(target, first);
    validateArtifactRoot(target.approvedRoot, "Reviewed artifact root", target.rootIdentity);
    const second = scanArtifactTree(target.artifactPath, target.artifactIdentity);
    validateArtifactRoot(target.approvedRoot, "Reviewed artifact root", target.rootIdentity);
    if (!isDeepStrictEqual(first, second)) {
      fail("artifact-changed", "The generated artifact changed between its two dry-audit passes.");
    }
    const core = Object.freeze({
      protocol: ARTIFACT_REVIEW_PROTOCOL,
      slug: target.slug,
      ownerTask: target.ownerTask,
      ownerRevision: target.ownerRevision,
      approvedRoot: target.approvedRoot,
      rootIdentity: target.rootIdentity,
      artifactPath: target.artifactPath,
      artifactIdentity: target.artifactIdentity,
      snapshot: second
    });
    return Object.freeze({
      target,
      public: Object.freeze({
        ...core,
        reviewSha256: sha256(`${JSON.stringify(core)}\n`),
        authorizesArchive: false,
        authorizesMove: false,
        authorizesCleanup: false
      })
    });
  }

  function artifactAttemptPath(slug, ownerRevision, attempt) {
    assertSlug(slug);
    assertRevision(ownerRevision);
    if (!Number.isSafeInteger(attempt) || attempt < 1 || attempt > MAXIMUM_ARTIFACT_ATTEMPTS) {
      fail("invalid-artifact-journal", "The generated-artifact attempt is out of range.");
    }
    return join(paths.artifactAttempts, `${slug}.${ownerRevision}.${attempt}`);
  }

  function artifactEntryPath(slug, ownerRevision) {
    assertSlug(slug);
    assertRevision(ownerRevision);
    return join(paths.artifactEntries, `${slug}.${ownerRevision}.json`);
  }

  function artifactSnapshotCore(snapshot) {
    return Object.freeze({
      identity: snapshot.identity,
      entryCount: snapshot.entryCount,
      directoryCount: snapshot.directoryCount,
      fileCount: snapshot.fileCount,
      symlinkCount: snapshot.symlinkCount,
      byteLength: snapshot.byteLength,
      identitySha256: snapshot.identitySha256,
      semanticSha256: snapshot.semanticSha256
    });
  }

  function validateArtifactRequest(value, slug, ownerRevision, attempt) {
    exactKeys(
      value,
      ["protocol", "slug", "ownerTask", "ownerRevision", "attempt", "token", "reviewSha256", "review"],
      "Generated-artifact retirement request"
    );
    if (
      value.protocol !== ARTIFACT_REQUEST_PROTOCOL ||
      value.slug !== slug ||
      value.ownerRevision !== ownerRevision ||
      value.attempt !== attempt ||
      !/^[0-9a-f]{32}$/u.test(value.token) ||
      !/^[0-9a-f]{64}$/u.test(value.reviewSha256)
    ) {
      fail("invalid-artifact-journal", "A generated-artifact retirement request is malformed.");
    }
    assertOwner(value.ownerTask);
    if (
      value.review?.protocol !== ARTIFACT_REVIEW_PROTOCOL ||
      value.review.slug !== slug ||
      value.review.ownerTask !== value.ownerTask ||
      value.review.ownerRevision !== ownerRevision ||
      value.review.reviewSha256 !== value.reviewSha256
    ) {
      fail("invalid-artifact-journal", "A generated-artifact request does not carry its exact reviewed audit.");
    }
  }

  function artifactReceiptAnchor(path, loaded) {
    return Object.freeze({
      path,
      identity: loaded.identity,
      byteLength: loaded.byteLength,
      sha256: loaded.sha256
    });
  }

  function listArtifactAttempts(slug, ownerRevision) {
    initializeArtifactJournal();
    const parentIdentity = managedIdentities.get(paths.artifactAttempts);
    if (parentIdentity === undefined) fail("unsafe-manager", "The artifact attempt journal was not initialized.");
    const attempts = [];
    for (const item of readDirectoryBounded(
      paths.artifactAttempts,
      MAXIMUM_ENTRIES * MAXIMUM_ARTIFACT_ATTEMPTS,
      "The generated-artifact attempt journal"
    )) {
      const match = ARTIFACT_ATTEMPT_PATTERN.exec(item.name);
      if (!item.isDirectory() || item.isSymbolicLink() || match === null) {
        fail("invalid-artifact-journal", "The generated-artifact attempt journal contains an unknown entry.");
      }
      if (match[1] !== slug || Number(match[2]) !== ownerRevision) continue;
      const attempt = Number(match[3]);
      const path = join(paths.artifactAttempts, item.name);
      const identity = assertPrivateDirectory(path, "Generated-artifact attempt");
      const names = readDirectoryBounded(path, 5, "Generated-artifact attempt");
      const allowed = new Set([
        "request.json",
        "source-manifest.jsonl",
        "recovery",
        "archive-receipt.json",
        "complete.json"
      ]);
      if (
        names.some((entry) => !allowed.has(entry.name)) ||
        new Set(names.map((entry) => entry.name)).size !== names.length
      ) {
        fail("invalid-artifact-journal", "A generated-artifact attempt contains an unknown entry.");
      }
      const requestPath = join(path, "request.json");
      const request = existsSync(requestPath)
        ? readJsonReceipt(requestPath, MAXIMUM_ENTRY_BYTES, "Generated-artifact retirement request")
        : undefined;
      if (request !== undefined) validateArtifactRequest(request.value, slug, ownerRevision, attempt);
      const manifestPath = join(path, "source-manifest.jsonl");
      const manifest = existsSync(manifestPath)
        ? captureArchiveFile(manifestPath, "Generated-artifact source manifest")
        : undefined;
      const recoveryPath = join(path, "recovery");
      const recoveryIdentity = existsSync(recoveryPath)
        ? validateArtifactRoot(recoveryPath, "Generated-artifact recovery tree").identity
        : undefined;
      const receiptPath = join(path, "archive-receipt.json");
      const receipt = existsSync(receiptPath)
        ? readJsonReceipt(receiptPath, MAXIMUM_ENTRY_BYTES, "Generated-artifact archive receipt")
        : undefined;
      const completionPath = join(path, "complete.json");
      let completion;
      if (existsSync(completionPath)) {
        const links = lstatSync(completionPath, { bigint: true }).nlink;
        if (![1n, 2n].includes(links)) {
          fail("invalid-artifact-journal", "A generated-artifact completion has an unexpected link count.");
        }
        completion = readJsonReceipt(completionPath, MAXIMUM_ENTRY_BYTES, "Generated-artifact completion", links);
      }
      revalidatePathIdentity(path, identity, "Generated-artifact attempt", "directory");
      attempts.push(
        Object.freeze({
          attempt,
          path,
          identity,
          requestPath,
          request,
          manifestPath,
          manifest,
          recoveryPath,
          recoveryIdentity,
          receiptPath,
          receipt,
          completionPath,
          completion
        })
      );
    }
    attempts.sort((left, right) => left.attempt - right.attempt);
    if (attempts.some((item, index) => item.attempt !== index + 1)) {
      fail("invalid-artifact-journal", "The generated-artifact attempt journal contains a gap.");
    }
    revalidatePathIdentity(paths.artifactAttempts, parentIdentity, "Generated-artifact attempts", "directory");
    return Object.freeze(attempts);
  }

  function readArtifactEntry(slug, ownerRevision, attempts = listArtifactAttempts(slug, ownerRevision)) {
    initializeArtifactJournal();
    const names = readDirectoryBounded(paths.artifactEntries, MAXIMUM_ENTRIES, "Generated-artifact entries");
    for (const item of names) {
      if (!item.isFile() || item.isSymbolicLink() || ARTIFACT_ENTRY_PATTERN.exec(item.name) === null) {
        fail("invalid-artifact-journal", "The generated-artifact entry journal contains an unknown entry.");
      }
    }
    const path = artifactEntryPath(slug, ownerRevision);
    if (!existsSync(path)) return undefined;
    const entry = readJsonReceipt(path, MAXIMUM_ENTRY_BYTES, "Generated-artifact entry", 2n);
    const attempt = attempts.find(
      (candidate) => candidate.completion !== undefined && sameIdentity(candidate.completion.identity, entry.identity)
    );
    if (attempt === undefined || !isDeepStrictEqual(attempt.completion.value, entry.value)) {
      fail("invalid-artifact-journal", "The generated-artifact entry lost its exact completed archive.");
    }
    return Object.freeze({ path, ...entry, attempt });
  }

  function compareArtifactReview(review, expected) {
    return (
      review.reviewSha256 === expected.reviewSha256 &&
      review.slug === expected.slug &&
      review.ownerTask === expected.ownerTask &&
      review.ownerRevision === expected.ownerRevision &&
      review.approvedRoot === expected.approvedRoot &&
      review.artifactPath === expected.artifactPath &&
      isDeepStrictEqual(review.rootIdentity, expected.rootIdentity) &&
      isDeepStrictEqual(review.artifactIdentity, expected.artifactIdentity) &&
      isDeepStrictEqual(review.snapshot, expected.snapshot)
    );
  }

  function validateArtifactArchiveAttempt(attempt, review) {
    if (
      attempt.request === undefined ||
      attempt.manifest === undefined ||
      attempt.recoveryIdentity === undefined ||
      attempt.receipt === undefined
    ) {
      fail("artifact-archive-incomplete", "The generated-artifact archive attempt is incomplete.");
    }
    validateArtifactRequest(attempt.request.value, review.slug, review.ownerRevision, attempt.attempt);
    if (
      attempt.request.value.ownerTask !== review.ownerTask ||
      attempt.request.value.reviewSha256 !== review.reviewSha256 ||
      !compareArtifactReview(attempt.request.value.review, review)
    ) {
      fail("artifact-review-changed", "The generated-artifact archive request does not match the reviewed audit.");
    }
    const value = attempt.receipt.value;
    exactKeys(
      value,
      [
        "protocol",
        "slug",
        "ownerTask",
        "ownerRevision",
        "attempt",
        "reviewSha256",
        "request",
        "manifest",
        "recovery",
        "source"
      ],
      "Generated-artifact archive receipt"
    );
    const archiveSnapshot = scanArtifactTree(attempt.recoveryPath, attempt.recoveryIdentity);
    if (
      value.protocol !== ARTIFACT_ARCHIVE_PROTOCOL ||
      value.slug !== review.slug ||
      value.ownerTask !== review.ownerTask ||
      value.ownerRevision !== review.ownerRevision ||
      value.attempt !== attempt.attempt ||
      value.reviewSha256 !== review.reviewSha256 ||
      !isDeepStrictEqual(value.request, artifactReceiptAnchor(attempt.requestPath, attempt.request)) ||
      !isDeepStrictEqual(value.manifest, artifactReceiptAnchor(attempt.manifestPath, attempt.manifest)) ||
      value.recovery.path !== attempt.recoveryPath ||
      !sameIdentity(value.recovery.identity, attempt.recoveryIdentity) ||
      !isDeepStrictEqual(value.recovery.snapshot, archiveSnapshot) ||
      value.source.identitySha256 !== review.snapshot.identitySha256 ||
      value.source.semanticSha256 !== archiveSnapshot.semanticSha256 ||
      value.source.semanticSha256 !== review.snapshot.semanticSha256 ||
      value.source.entryCount !== archiveSnapshot.entryCount ||
      value.source.byteLength !== archiveSnapshot.byteLength
    ) {
      fail("artifact-archive-changed", "The generated-artifact recovery archive does not match its exact receipt.");
    }
    return Object.freeze({ archiveSnapshot, value });
  }

  function validateArtifactCompletion(attempt, review) {
    if (attempt.completion === undefined) {
      fail("artifact-archive-incomplete", "The generated-artifact archive lacks a completion record.");
    }
    const { value } = attempt.completion;
    exactKeys(
      value,
      ["protocol", "state", "slug", "ownerTask", "ownerRevision", "attempt", "reviewSha256", "request", "archive"],
      "Generated-artifact completion"
    );
    if (
      value.protocol !== ARTIFACT_COMPLETION_PROTOCOL ||
      value.state !== "archived-review-required" ||
      value.slug !== review.slug ||
      value.ownerTask !== review.ownerTask ||
      value.ownerRevision !== review.ownerRevision ||
      value.attempt !== attempt.attempt ||
      value.reviewSha256 !== review.reviewSha256 ||
      !isDeepStrictEqual(value.request, artifactReceiptAnchor(attempt.requestPath, attempt.request)) ||
      !isDeepStrictEqual(value.archive, artifactReceiptAnchor(attempt.receiptPath, attempt.receipt))
    ) {
      fail("invalid-artifact-journal", "The generated-artifact completion is malformed or detached.");
    }
    return value;
  }

  function publishArtifactCompletion(attempt, review) {
    validateArtifactArchiveAttempt(attempt, review);
    validateArtifactCompletion(attempt, review);
    const entryPath = artifactEntryPath(review.slug, review.ownerRevision);
    const entriesIdentity = managedIdentities.get(paths.artifactEntries);
    if (entriesIdentity === undefined) fail("unsafe-manager", "The generated-artifact entries were not initialized.");
    revalidatePathIdentity(paths.artifactEntries, entriesIdentity, "Generated-artifact entries", "directory");
    hooks?.beforeArtifactPublish?.(attempt, review);
    if (!existsSync(entryPath)) {
      linkSync(attempt.completionPath, entryPath);
      fsyncDirectory(paths.artifactEntries);
    }
    const entry = readArtifactEntry(
      review.slug,
      review.ownerRevision,
      listArtifactAttempts(review.slug, review.ownerRevision)
    );
    if (entry === undefined || !sameIdentity(entry.identity, attempt.completion.identity)) {
      fail("artifact-journal-changed", "The generated-artifact completion was not published exactly once.");
    }
    return entry;
  }

  function allocateArtifactAttempt(review) {
    const attempts = listArtifactAttempts(review.slug, review.ownerRevision);
    if (attempts.length >= MAXIMUM_ARTIFACT_ATTEMPTS) {
      fail("artifact-attempts-exhausted", "The generated-artifact archive has no remaining attempt slots.");
    }
    const attempt = attempts.length + 1;
    const path = artifactAttemptPath(review.slug, review.ownerRevision, attempt);
    mkdirSync(path, { mode: 0o700 });
    chmodSync(path, 0o700);
    fsyncDirectory(paths.artifactAttempts);
    return Object.freeze({ attempt, path, identity: assertPrivateDirectory(path, "Generated-artifact attempt") });
  }

  function createArtifactArchive(review) {
    const allocation = allocateArtifactAttempt(review);
    const token = tokenFactory();
    if (!/^[0-9a-f]{32}$/u.test(token)) fail("invalid-artifact-journal", "The artifact token is malformed.");
    const requestValue = Object.freeze({
      protocol: ARTIFACT_REQUEST_PROTOCOL,
      slug: review.slug,
      ownerTask: review.ownerTask,
      ownerRevision: review.ownerRevision,
      attempt: allocation.attempt,
      token,
      reviewSha256: review.reviewSha256,
      review
    });
    assertPersistedJsonFits(requestValue, "Generated-artifact retirement request", "artifact-record-too-large");
    const requestPath = join(allocation.path, "request.json");
    writeJsonExclusive(requestPath, requestValue, allocation.identity);
    const request = readJsonReceipt(requestPath, MAXIMUM_ENTRY_BYTES, "Generated-artifact retirement request");
    validateArtifactRequest(request.value, review.slug, review.ownerRevision, allocation.attempt);
    hooks?.afterArtifactRequest?.(allocation, requestValue);

    archiveFreeSpace(BigInt(review.snapshot.byteLength));
    const recoveryPath = join(allocation.path, "recovery");
    mkdirSync(recoveryPath, { mode: 0o700 });
    const recoveryIdentity = validateArtifactRoot(recoveryPath, "Generated-artifact recovery tree").identity;
    const manifestPath = join(allocation.path, "source-manifest.jsonl");
    const manifestFile = openEmptyPrivateFile(manifestPath, "Generated-artifact source manifest");
    let copied;
    try {
      copied = scanArtifactTree(review.artifactPath, review.artifactIdentity, {
        destinationRoot: recoveryPath,
        destinationIdentity: recoveryIdentity,
        manifestDescriptor: manifestFile.descriptor
      });
      syncArtifactDescriptor(manifestFile.descriptor);
    } finally {
      closeSync(manifestFile.descriptor);
    }
    const attemptHandle = openArtifactDirectoryDescriptor(
      allocation.path,
      "Generated-artifact archive attempt",
      allocation.identity
    );
    try {
      synchronizeArtifactDirectory(attemptHandle.descriptor, allocation.path);
    } finally {
      closeSync(attemptHandle.descriptor);
    }
    hooks?.afterArtifactRecoveryDurable?.(allocation, copied);
    hooks?.afterArtifactArchiveCopy?.(allocation, copied);
    const manifest = captureArchiveFile(manifestPath, "Generated-artifact source manifest");
    hooks?.beforeArtifactSourceRecheck?.(allocation, copied);
    const sourceConfirmed = scanArtifactTree(review.artifactPath, review.artifactIdentity);
    const archiveConfirmed = scanArtifactTree(recoveryPath, recoveryIdentity);
    if (
      !isDeepStrictEqual(artifactSnapshotCore(copied), artifactSnapshotCore(sourceConfirmed)) ||
      !isDeepStrictEqual(artifactSnapshotCore(sourceConfirmed), artifactSnapshotCore(review.snapshot)) ||
      sourceConfirmed.semanticSha256 !== archiveConfirmed.semanticSha256 ||
      sourceConfirmed.entryCount !== archiveConfirmed.entryCount ||
      sourceConfirmed.byteLength !== archiveConfirmed.byteLength
    ) {
      fail("artifact-archive-changed", "The generated artifact or its recovery copy changed during archiving.");
    }
    const receiptValue = Object.freeze({
      protocol: ARTIFACT_ARCHIVE_PROTOCOL,
      slug: review.slug,
      ownerTask: review.ownerTask,
      ownerRevision: review.ownerRevision,
      attempt: allocation.attempt,
      reviewSha256: review.reviewSha256,
      request: artifactReceiptAnchor(requestPath, request),
      manifest: artifactReceiptAnchor(manifestPath, manifest),
      recovery: Object.freeze({ path: recoveryPath, identity: recoveryIdentity, snapshot: archiveConfirmed }),
      source: artifactSnapshotCore(sourceConfirmed)
    });
    assertPersistedJsonFits(receiptValue, "Generated-artifact archive receipt", "artifact-record-too-large");
    const receiptPath = join(allocation.path, "archive-receipt.json");
    writeJsonExclusive(receiptPath, receiptValue, allocation.identity);
    const receipt = readJsonReceipt(receiptPath, MAXIMUM_ENTRY_BYTES, "Generated-artifact archive receipt");
    hooks?.afterArtifactArchiveReceipt?.(allocation, receiptValue);

    const loaded = Object.freeze({
      ...allocation,
      requestPath,
      request,
      manifestPath,
      manifest,
      recoveryPath,
      recoveryIdentity,
      receiptPath,
      receipt,
      completionPath: join(allocation.path, "complete.json")
    });
    validateArtifactArchiveAttempt(loaded, review);
    const finalSource = scanArtifactTree(review.artifactPath, review.artifactIdentity);
    if (!isDeepStrictEqual(artifactSnapshotCore(finalSource), artifactSnapshotCore(review.snapshot))) {
      fail("artifact-changed", "The generated artifact changed before archive completion.");
    }
    const completionValue = Object.freeze({
      protocol: ARTIFACT_COMPLETION_PROTOCOL,
      state: "archived-review-required",
      slug: review.slug,
      ownerTask: review.ownerTask,
      ownerRevision: review.ownerRevision,
      attempt: allocation.attempt,
      reviewSha256: review.reviewSha256,
      request: artifactReceiptAnchor(requestPath, request),
      archive: artifactReceiptAnchor(receiptPath, receipt)
    });
    assertPersistedJsonFits(completionValue, "Generated-artifact completion", "artifact-record-too-large");
    hooks?.beforeArtifactCompletion?.(allocation, completionValue);
    writeJsonExclusive(loaded.completionPath, completionValue, allocation.identity);
    const completion = readJsonReceipt(loaded.completionPath, MAXIMUM_ENTRY_BYTES, "Generated-artifact completion");
    return publishArtifactCompletion(Object.freeze({ ...loaded, completion }), review);
  }

  function ensureArtifactArchive(review) {
    const attempts = listArtifactAttempts(review.slug, review.ownerRevision);
    if (
      attempts.some(
        (attempt) =>
          attempt.request !== undefined &&
          (attempt.request.value.ownerTask !== review.ownerTask ||
            attempt.request.value.reviewSha256 !== review.reviewSha256 ||
            !compareArtifactReview(attempt.request.value.review, review))
      )
    ) {
      fail(
        "artifact-review-changed",
        "An interrupted artifact attempt at this owner revision belongs to another dry review."
      );
    }
    const existing = readArtifactEntry(review.slug, review.ownerRevision, attempts);
    if (existing !== undefined) {
      validateArtifactArchiveAttempt(existing.attempt, review);
      validateArtifactCompletion(existing.attempt, review);
      return existing;
    }
    const completed = attempts.find((attempt) => attempt.completion !== undefined);
    if (completed !== undefined) return publishArtifactCompletion(completed, review);
    return createArtifactArchive(review);
  }

  function artifactSweepPath(slug, ownerRevision) {
    return join(paths.artifactSweeps, `${slug}.${ownerRevision}`);
  }

  function artifactQuarantinePath(slug, ownerRevision, operationId) {
    return join(paths.artifactQuarantine, `${slug}.${ownerRevision}.${operationId}`);
  }

  function artifactPinRootPath(slug, ownerRevision, operationId) {
    return join(paths.artifactPins, `${slug}.${ownerRevision}.${operationId}`);
  }

  function artifactPinName(relativePath) {
    return sha256(Buffer.from(relativePath, "utf8"));
  }

  function artifactPinPaths(slug, ownerRevision, operationId) {
    const root = artifactPinRootPath(slug, ownerRevision, operationId);
    return Object.freeze({
      root,
      active: join(root, "active"),
      releasing: join(root, "releasing")
    });
  }

  function artifactPinBinding(paths, root, active, releasing) {
    return Object.freeze({
      root: Object.freeze({ path: paths.root, identity: identityOf(root) }),
      active: Object.freeze({ path: paths.active, identity: identityOf(active) }),
      releasing: Object.freeze({ path: paths.releasing, identity: identityOf(releasing) })
    });
  }

  function validateArtifactPinBinding(value, expectedPaths) {
    exactKeys(value, ["root", "active", "releasing"], "Generated-artifact pin binding");
    for (const [label, expectedPath] of [
      ["root", expectedPaths.root],
      ["active", expectedPaths.active],
      ["releasing", expectedPaths.releasing]
    ]) {
      const candidate = value[label];
      exactKeys(candidate, ["path", "identity"], `Generated-artifact pin ${label}`);
      if (candidate.path !== expectedPath) {
        fail("invalid-artifact-journal", `Generated-artifact pin ${label} has the wrong path.`);
      }
      validateIdentity(candidate.identity, `Generated-artifact pin ${label} identity`);
    }
  }

  function validateArtifactSweepRecord(record, previous, expected) {
    const value = record.loaded.value;
    const common = ["protocol", "kind", "slug", "ownerTask", "ownerRevision", "sequence", "operationId", "previous"];
    const fields =
      record.kind === "eligible"
        ? [
            ...common,
            "eligibleBootId",
            "originalPath",
            "originalIdentity",
            "approvedRoot",
            "rootIdentity",
            "reviewSha256",
            "entry"
          ]
        : record.kind === "quarantine-intent"
          ? [...common, "bootId", "originalPath", "quarantinePath"]
          : record.kind === "quarantine-result"
            ? [...common, "bootId", "quarantinePath", "location", "pins"]
            : record.kind === "purge-intent"
              ? [...common, "bootId", "quarantinePath"]
              : [...common, "bootId", "quarantinePath", "archivePreserved"];
    exactKeys(value, fields, `Generated-artifact ${record.kind} record`);
    if (
      value.protocol !== ARTIFACT_SWEEP_PROTOCOL ||
      value.kind !== record.kind ||
      value.slug !== expected.slug ||
      value.ownerRevision !== expected.ownerRevision ||
      value.sequence !== record.sequence ||
      value.operationId !== expected.operationId ||
      value.ownerTask !== expected.ownerTask ||
      !isDeepStrictEqual(
        value.previous,
        previous === undefined ? null : artifactReceiptAnchor(previous.path, previous.loaded)
      )
    ) {
      fail("invalid-artifact-journal", "A generated-artifact sweep record is malformed or detached.");
    }
    if (record.kind === "eligible") {
      if (
        !BOOT_ID_PATTERN.test(value.eligibleBootId) ||
        value.originalPath !== expected.originalPath ||
        value.approvedRoot !== expected.approvedRoot ||
        !sameIdentity(value.originalIdentity, expected.originalIdentity) ||
        !sameIdentity(value.rootIdentity, expected.rootIdentity) ||
        value.reviewSha256 !== expected.reviewSha256 ||
        !isDeepStrictEqual(value.entry, expected.entry)
      ) {
        fail("invalid-artifact-journal", "Generated-artifact eligibility changed its reviewed authority.");
      }
    } else if (
      !BOOT_ID_PATTERN.test(value.bootId) ||
      value.quarantinePath !== expected.quarantinePath ||
      (record.kind === "quarantine-intent" && value.originalPath !== expected.originalPath) ||
      (record.kind === "quarantine-result" && value.location !== "quarantine") ||
      (record.kind === "retired" && value.archivePreserved !== true)
    ) {
      fail("invalid-artifact-journal", `Generated-artifact ${record.kind} has an invalid path or result.`);
    }
    if (record.kind === "quarantine-result") validateArtifactPinBinding(value.pins, expected.pinPaths);
  }

  function readArtifactSweepRecords(slug, ownerRevision) {
    initializeArtifactJournal();
    const journal = artifactSweepPath(slug, ownerRevision);
    if (!existsSync(journal)) return Object.freeze([]);
    const journalIdentity = assertPrivateDirectory(journal, "Generated-artifact sweep journal");
    const named = readDirectoryBounded(journal, 5, "Generated-artifact sweep journal")
      .map((item) => {
        const match = ARTIFACT_SWEEP_RECORD_PATTERN.exec(item.name);
        if (!item.isFile() || item.isSymbolicLink() || match === null) {
          fail("invalid-artifact-journal", "A generated-artifact sweep journal contains an unknown entry.");
        }
        return Object.freeze({ name: item.name, sequence: Number(match[1]), kind: match[2], operationId: match[3] });
      })
      .sort((left, right) => left.sequence - right.sequence);
    const expectedKinds = ["eligible", "quarantine-intent", "quarantine-result", "purge-intent", "retired"];
    if (
      named.some(
        (item, index) =>
          item.sequence !== index + 1 ||
          item.kind !== expectedKinds[index] ||
          item.operationId !== named[0]?.operationId
      )
    ) {
      fail("invalid-artifact-journal", "A generated-artifact sweep journal has an invalid transition.");
    }
    const records = named.map((item) => {
      const path = join(journal, item.name);
      return Object.freeze({
        ...item,
        path,
        loaded: readJsonReceipt(path, MAXIMUM_ENTRY_BYTES, `Artifact ${item.kind}`)
      });
    });
    if (records.length !== 0) {
      const eligible = records[0].loaded.value;
      const expected = Object.freeze({
        slug,
        ownerTask: eligible.ownerTask,
        ownerRevision,
        operationId: eligible.operationId,
        originalPath: eligible.originalPath,
        originalIdentity: eligible.originalIdentity,
        approvedRoot: eligible.approvedRoot,
        rootIdentity: eligible.rootIdentity,
        reviewSha256: eligible.reviewSha256,
        entry: eligible.entry,
        quarantinePath: artifactQuarantinePath(slug, ownerRevision, eligible.operationId),
        pinPaths: artifactPinPaths(slug, ownerRevision, eligible.operationId)
      });
      for (const [index, record] of records.entries())
        validateArtifactSweepRecord(record, records[index - 1], expected);
    }
    revalidatePathIdentity(journal, journalIdentity, "Generated-artifact sweep journal", "directory");
    return Object.freeze(records);
  }

  function appendArtifactSweepRecord(slug, ownerRevision, value) {
    initializeArtifactJournal();
    const journal = artifactSweepPath(slug, ownerRevision);
    const parentIdentity = managedIdentities.get(paths.artifactSweeps);
    if (parentIdentity === undefined) fail("unsafe-manager", "The artifact sweep journal was not initialized.");
    if (!existsSync(journal)) {
      if (value.sequence !== 1) fail("invalid-artifact-journal", "Artifact eligibility is missing.");
      mkdirSync(journal, { mode: 0o700 });
      chmodSync(journal, 0o700);
      fsyncDirectory(paths.artifactSweeps);
    }
    const journalIdentity = assertPrivateDirectory(journal, "Generated-artifact sweep journal");
    const records = readArtifactSweepRecords(slug, ownerRevision);
    if (records.length + 1 !== value.sequence) {
      fail("artifact-state-changed", "The generated-artifact sweep journal advanced concurrently.");
    }
    const prior = records.at(-1);
    if (
      !isDeepStrictEqual(value.previous, prior === undefined ? null : artifactReceiptAnchor(prior.path, prior.loaded))
    ) {
      fail("invalid-artifact-journal", "The generated-artifact sweep record has the wrong predecessor.");
    }
    const destination = join(
      journal,
      `${String(value.sequence).padStart(8, "0")}.${value.kind}.${value.operationId}.json`
    );
    assertPersistedJsonFits(value, "Generated-artifact sweep record", "artifact-record-too-large");
    writeJsonExclusive(destination, value, journalIdentity);
    const loaded = readJsonReceipt(destination, MAXIMUM_ENTRY_BYTES, `Generated-artifact ${value.kind} record`);
    return Object.freeze({
      sequence: value.sequence,
      kind: value.kind,
      operationId: value.operationId,
      path: destination,
      loaded
    });
  }

  function artifactAuthority(slug, ownerRevision) {
    const attempts = listArtifactAttempts(slug, ownerRevision);
    const entry = readArtifactEntry(slug, ownerRevision, attempts);
    if (entry === undefined)
      fail("artifact-archive-missing", "Generated-artifact retirement requires a completed archive.");
    const review = entry.attempt.request.value.review;
    validateArtifactArchiveAttempt(entry.attempt, review);
    validateArtifactCompletion(entry.attempt, review);
    return Object.freeze({ entry, review });
  }

  function enrollArtifactRetirement(authority) {
    const { entry, review } = authority;
    const existing = readArtifactSweepRecords(review.slug, review.ownerRevision);
    if (existing.length !== 0) return Object.freeze({ status: "already-enrolled", records: existing.length });
    const operationId = tokenFactory();
    if (!/^[0-9a-f]{32}$/u.test(operationId)) fail("invalid-artifact-journal", "Artifact operation ID is malformed.");
    const quarantinePath = artifactQuarantinePath(review.slug, review.ownerRevision, operationId);
    if (existsSync(quarantinePath)) fail("artifact-layout-blocked", "The artifact quarantine path already exists.");
    const bootId = currentBootId();
    hooks?.beforeArtifactEnrollment?.(authority, bootId);
    const confirmed = captureArtifactReview({
      slug: review.slug,
      artifactPath: review.artifactPath,
      approvedRoot: review.approvedRoot,
      ownerTask: review.ownerTask,
      ownerRevision: review.ownerRevision
    }).public;
    if (!compareArtifactReview(confirmed, review) || currentBootId() !== bootId) {
      fail("artifact-changed", "The generated artifact or boot changed before retirement enrollment.");
    }
    const record = appendArtifactSweepRecord(review.slug, review.ownerRevision, {
      protocol: ARTIFACT_SWEEP_PROTOCOL,
      kind: "eligible",
      slug: review.slug,
      ownerTask: review.ownerTask,
      ownerRevision: review.ownerRevision,
      sequence: 1,
      operationId,
      previous: null,
      eligibleBootId: bootId,
      originalPath: review.artifactPath,
      originalIdentity: review.artifactIdentity,
      approvedRoot: review.approvedRoot,
      rootIdentity: review.rootIdentity,
      reviewSha256: review.reviewSha256,
      entry: artifactReceiptAnchor(entry.path, entry)
    });
    return Object.freeze({
      status: "enrolled-next-boot",
      eligibleBootId: bootId,
      record: artifactReceiptAnchor(record.path, record.loaded),
      moved: false,
      removed: false
    });
  }

  function artifactLayout(eligible) {
    const quarantinePath = artifactQuarantinePath(eligible.slug, eligible.ownerRevision, eligible.operationId);
    const inspect = (path) => {
      try {
        const metadata = lstatSync(path, { bigint: true });
        return metadata.isDirectory() &&
          !metadata.isSymbolicLink() &&
          currentUserOwns(metadata) &&
          sameIdentity(identityOf(metadata), eligible.originalIdentity)
          ? "exact"
          : "mismatch";
      } catch (error) {
        if (error.code === "ENOENT") return "absent";
        throw error;
      }
    };
    const original = inspect(eligible.originalPath);
    const quarantine = inspect(quarantinePath);
    if (original === "exact" && quarantine === "absent") return Object.freeze({ state: "original", quarantinePath });
    if (original === "absent" && quarantine === "exact") return Object.freeze({ state: "quarantine", quarantinePath });
    if (original === "absent" && quarantine === "absent") return Object.freeze({ state: "absent", quarantinePath });
    return Object.freeze({ state: "blocked", quarantinePath });
  }

  function hashArtifactRegularFile(path, observed, label, expectedLinks = 1n) {
    let descriptor;
    try {
      descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      const before = fstatSync(descriptor, { bigint: true });
      if (
        !before.isFile() ||
        before.nlink !== expectedLinks ||
        !currentUserOwns(before) ||
        !sameIdentity(identityOf(before), identityOf(observed))
      ) {
        fail("artifact-purge-unsafe", `${label} is not the expected regular file.`);
      }
      const hash = createHash("sha256");
      const buffer = Buffer.allocUnsafe(1024 * 1024);
      let offset = 0n;
      while (offset < before.size) {
        const length = Number(
          before.size - offset > BigInt(buffer.length) ? BigInt(buffer.length) : before.size - offset
        );
        const count = readSync(descriptor, buffer, 0, length, Number(offset));
        if (count === 0) fail("artifact-purge-unsafe", `${label} changed while read.`);
        hash.update(buffer.subarray(0, count));
        offset += BigInt(count);
      }
      const after = fstatSync(descriptor, { bigint: true });
      if (!sameArtifactStat(before, after)) fail("artifact-purge-unsafe", `${label} changed while read.`);
      return Object.freeze({ sha256: hash.digest("hex"), metadata: before });
    } finally {
      if (descriptor !== undefined) closeSync(descriptor);
    }
  }

  function artifactManifestMatcher(manifestPath, expectedReceipt, options = {}) {
    let descriptor;
    let iterator;
    function* records() {
      try {
        descriptor = openSync(manifestPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
        const before = fstatSync(descriptor, { bigint: true });
        if (
          !before.isFile() ||
          before.nlink !== 1n ||
          !currentUserOwns(before) ||
          !sameIdentity(identityOf(before), expectedReceipt.identity) ||
          before.size !== BigInt(expectedReceipt.byteLength) ||
          before.size > MAXIMUM_ARTIFACT_MANIFEST_BYTES ||
          (typeof process.getuid === "function" && (before.mode & 0o777n) !== 0o600n)
        ) {
          fail("artifact-purge-unsafe", "The source manifest changed before artifact purge.");
        }
        const hash = createHash("sha256");
        const buffer = Buffer.allocUnsafe(1024 * 1024);
        let carry = Buffer.alloc(0);
        let offset = 0n;
        let count = 0;
        while (offset < before.size) {
          const length = Number(
            before.size - offset > BigInt(buffer.length) ? BigInt(buffer.length) : before.size - offset
          );
          const bytesRead = readSync(descriptor, buffer, 0, length, Number(offset));
          if (bytesRead === 0) fail("artifact-purge-unsafe", "The source manifest changed while read.");
          const bytes = buffer.subarray(0, bytesRead);
          hash.update(bytes);
          const combined = carry.length === 0 ? bytes : Buffer.concat([carry, bytes]);
          let start = 0;
          for (;;) {
            const newline = combined.indexOf(0x0a, start);
            if (newline === -1) break;
            const line = combined.subarray(start, newline);
            if (line.length === 0 || line.length > MAXIMUM_ARTIFACT_SYMLINK_BYTES * 2 + 16 * 1024) {
              fail("artifact-purge-unsafe", "The source manifest contains an invalid record length.");
            }
            let text;
            let value;
            try {
              text = new TextDecoder("utf-8", { fatal: true }).decode(line);
              rejectDuplicateJsonKeys(text, "Generated-artifact source manifest record");
              value = JSON.parse(text);
            } catch (error) {
              if (error instanceof CheckoutLifecycleError) throw error;
              fail("artifact-purge-unsafe", `The source manifest is malformed: ${error.message}`);
            }
            if (
              value === null ||
              typeof value !== "object" ||
              Array.isArray(value) ||
              !["directory", "file", "symlink"].includes(value.kind) ||
              typeof value.path !== "string" ||
              value.path.includes("\0") ||
              value.path.split("/").some((part) => (part === "" && value.path !== "") || part === "." || part === "..")
            ) {
              fail("artifact-purge-unsafe", "The source manifest contains an invalid path or entry kind.");
            }
            validateIdentity(value.identity, "Generated-artifact manifest identity");
            count += 1;
            if (count > MAXIMUM_ARTIFACT_ENTRIES) {
              fail("artifact-too-large", "The source manifest exceeds its fixed entry limit.");
            }
            yield Object.freeze(value);
            start = newline + 1;
          }
          carry = Buffer.from(combined.subarray(start));
          if (carry.length > MAXIMUM_ARTIFACT_SYMLINK_BYTES * 2 + 16 * 1024) {
            fail("artifact-purge-unsafe", "The source manifest contains an overlong record.");
          }
          offset += BigInt(bytesRead);
        }
        if (carry.length !== 0 || count === 0 || hash.digest("hex") !== expectedReceipt.sha256) {
          fail("artifact-purge-unsafe", "The source manifest is truncated, empty, or changed.");
        }
        const after = fstatSync(descriptor, { bigint: true });
        if (!sameArtifactStat(before, after)) {
          fail("artifact-purge-unsafe", "The source manifest changed while it was consumed.");
        }
      } finally {
        if (descriptor !== undefined) closeSync(descriptor);
      }
    }
    iterator = records();
    let current = iterator.next();
    const skip = () => {
      options.onSkipped?.(current.value);
      current = iterator.next();
    };
    const nextMatching = (path, kind) => {
      while (!current.done && current.value.path !== path) skip();
      if (current.done || current.value.kind !== kind) {
        fail("artifact-purge-unsafe", `The quarantine entry ${path || "."} is absent from the source manifest.`);
      }
      const value = current.value;
      current = iterator.next();
      return value;
    };
    return Object.freeze({
      match(path, kind, metadata) {
        const value = nextMatching(path, kind);
        if (!sameIdentity(value.identity, identityOf(metadata)) || value.mode !== Number(metadata.mode & 0o7777n)) {
          fail("artifact-purge-unsafe", `The quarantine entry ${path || "."} changed identity or mode.`);
        }
        return value;
      },
      finish() {
        while (!current.done) skip();
      },
      consumeMissingChildren(parentPath) {
        while (
          !current.done &&
          (posix.dirname(current.value.path) === "." ? "" : posix.dirname(current.value.path)) === parentPath
        ) {
          skip();
        }
      },
      close() {
        iterator.return?.();
      }
    });
  }

  function ensureArtifactPinDirectory(parentDescriptor, parentPath, name, label) {
    const reference = artifactDescriptorPath(parentDescriptor, name);
    let metadata;
    try {
      metadata = lstatSync(reference, { bigint: true });
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      mkdirSync(reference, { mode: 0o700 });
      synchronizeArtifactDirectory(parentDescriptor, parentPath);
      metadata = lstatSync(reference, { bigint: true });
    }
    if (
      !metadata.isDirectory() ||
      metadata.isSymbolicLink() ||
      !currentUserOwns(metadata) ||
      (typeof process.getuid === "function" && (metadata.mode & 0o777n) !== 0o700n)
    ) {
      fail("artifact-purge-unsafe", `${label} is not one private directory.`);
    }
    return openArtifactChildDirectoryDescriptor(parentDescriptor, name, metadata, label);
  }

  function readArtifactPin(directoryDescriptor, name, label) {
    const reference = artifactDescriptorPath(directoryDescriptor, name);
    try {
      return Object.freeze({ reference, metadata: lstatSync(reference, { bigint: true }) });
    } catch (error) {
      if (error.code === "ENOENT") return undefined;
      fail("artifact-purge-unsafe", `${label} could not be inspected safely: ${error.message}`);
    }
  }

  function assertArtifactPinMetadata(metadata, source, kind, links, label) {
    const validKind = kind === "file" ? metadata.isFile() && !metadata.isSymbolicLink() : metadata.isSymbolicLink();
    if (
      !validKind ||
      !currentUserOwns(metadata) ||
      metadata.nlink !== links ||
      !sameIdentity(identityOf(metadata), source.identity) ||
      Number(metadata.mode & 0o7777n) !== source.mode
    ) {
      fail("artifact-purge-unsafe", `${label} does not match the sealed generated-artifact entry.`);
    }
  }

  function assertArtifactPinPair(sourceMetadata, pinMetadata, source, kind, sourceLinks, pinLinks, label) {
    assertArtifactPinMetadata(sourceMetadata, source, kind, sourceLinks, `${label} source`);
    assertArtifactPinMetadata(pinMetadata, source, kind, pinLinks, `${label} pin`);
    if (!sameIdentity(identityOf(sourceMetadata), identityOf(pinMetadata))) {
      fail("artifact-purge-unsafe", `${label} source and pin differ.`);
    }
  }

  function ensureArtifactPins(quarantinePath, expectedIdentity, manifestPath, manifestReceipt, pinPaths) {
    const pinParentIdentity = managedIdentities.get(paths.artifactPins);
    if (pinParentIdentity === undefined || dirname(pinPaths.root) !== paths.artifactPins) {
      fail("artifact-purge-unsafe", "The generated-artifact pin parent is not manager-owned.");
    }
    const pinParent = openArtifactDirectoryDescriptor(
      paths.artifactPins,
      "Generated-artifact pin parent",
      pinParentIdentity
    );
    let pinRoot;
    let active;
    let releasing;
    let sourceRoot;
    let manifest;
    try {
      pinRoot = ensureArtifactPinDirectory(
        pinParent.descriptor,
        paths.artifactPins,
        basename(pinPaths.root),
        "Generated-artifact pin root"
      );
      active = ensureArtifactPinDirectory(
        pinRoot.descriptor,
        pinPaths.root,
        "active",
        "Generated-artifact active pins"
      );
      releasing = ensureArtifactPinDirectory(
        pinRoot.descriptor,
        pinPaths.root,
        "releasing",
        "Generated-artifact releasing pins"
      );
      sourceRoot = openArtifactDirectoryDescriptor(quarantinePath, "Generated-artifact quarantine", expectedIdentity);
      manifest = artifactManifestMatcher(manifestPath, manifestReceipt, {
        onSkipped() {
          fail("artifact-purge-unsafe", "The quarantined artifact changed while its pins were prepared.");
        }
      });
      let pinCount = 0;
      const ensurePin = (sourceReference, sourceMetadata, source, kind, relativePath) => {
        const name = artifactPinName(relativePath);
        const activePin = readArtifactPin(active.descriptor, name, "Generated-artifact active pin");
        const releasingPin = readArtifactPin(releasing.descriptor, name, "Generated-artifact releasing pin");
        if (activePin !== undefined && releasingPin !== undefined) {
          fail("artifact-purge-unsafe", "A generated-artifact pin is in two release states.");
        }
        if (releasingPin !== undefined) {
          fail("artifact-purge-unsafe", "A generated-artifact pin was released before purge began.");
        }
        const sourceLinks = activePin === undefined ? 1n : 2n;
        if (kind === "file") {
          const current = hashArtifactRegularFile(
            sourceReference,
            sourceMetadata,
            "Quarantined artifact file while pinning",
            sourceLinks
          );
          if (current.sha256 !== source.sha256 || current.metadata.size.toString() !== source.size) {
            fail("artifact-purge-unsafe", "A quarantined file changed before its identity pin was created.");
          }
        } else {
          const target = readlinkSync(sourceReference, { encoding: "buffer" });
          if (
            target.toString("base64") !== source.targetBase64 ||
            sha256(target) !== source.targetSha256 ||
            target.byteLength.toString() !== source.targetBytes
          ) {
            fail("artifact-purge-unsafe", "A quarantined symlink changed before its identity pin was created.");
          }
        }
        if (activePin === undefined) {
          linkSync(sourceReference, artifactDescriptorPath(active.descriptor, name));
          synchronizeArtifactDirectory(active.descriptor, pinPaths.active);
          const linkedSource = lstatSync(sourceReference, { bigint: true });
          const linkedPin = readArtifactPin(active.descriptor, name, "Generated-artifact active pin");
          if (linkedPin === undefined)
            fail("artifact-purge-unsafe", "A generated-artifact pin disappeared after creation.");
          assertArtifactPinPair(linkedSource, linkedPin.metadata, source, kind, 2n, 2n, "Generated-artifact pin");
        } else {
          assertArtifactPinPair(sourceMetadata, activePin.metadata, source, kind, 2n, 2n, "Generated-artifact pin");
        }
        pinCount += 1;
      };
      const visit = (directoryDescriptor, directoryReference, relativePath, depth) => {
        if (depth > MAXIMUM_ARTIFACT_DEPTH)
          fail("artifact-too-large", "The generated-artifact pin tree exceeds its depth limit.");
        const directoryMetadata = fstatSync(directoryDescriptor, { bigint: true });
        manifest.match(relativePath, "directory", directoryMetadata);
        for (const item of readArtifactDirectoryBounded(directoryDescriptor, "Generated-artifact pin source").sort(
          (left, right) => Buffer.compare(left.nameBytes, right.nameBytes)
        )) {
          const childReference = artifactDescriptorPath(directoryDescriptor, item.name);
          const childRelative = relativePath === "" ? item.name : `${relativePath}/${item.name}`;
          const metadata = lstatSync(childReference, { bigint: true });
          if (metadata.isDirectory() && !metadata.isSymbolicLink()) {
            const child = openArtifactChildDirectoryDescriptor(
              directoryDescriptor,
              item.name,
              metadata,
              `Quarantined artifact directory ${childRelative}`
            );
            try {
              visit(child.descriptor, childReference, childRelative, depth + 1);
            } finally {
              closeSync(child.descriptor);
            }
          } else if (metadata.isFile() && !metadata.isSymbolicLink()) {
            ensurePin(childReference, metadata, manifest.match(childRelative, "file", metadata), "file", childRelative);
          } else if (metadata.isSymbolicLink()) {
            ensurePin(
              childReference,
              metadata,
              manifest.match(childRelative, "symlink", metadata),
              "symlink",
              childRelative
            );
          } else {
            fail("artifact-purge-unsafe", "The quarantined artifact contains a special file while pinning.");
          }
        }
      };
      visit(sourceRoot.descriptor, artifactDescriptorPath(sourceRoot.descriptor), "", 0);
      manifest.finish();
      const activeEntries = readArtifactDirectoryBounded(active.descriptor, "Generated-artifact active pins");
      const releasingEntries = readArtifactDirectoryBounded(releasing.descriptor, "Generated-artifact releasing pins");
      if (
        activeEntries.length !== pinCount ||
        releasingEntries.length !== 0 ||
        activeEntries.some(
          (entry) =>
            !/^[0-9a-f]{64}$/u.test(entry.name) ||
            (() => {
              const metadata = lstatSync(artifactDescriptorPath(active.descriptor, entry.name), { bigint: true });
              return !((metadata.isFile() && !metadata.isSymbolicLink()) || metadata.isSymbolicLink());
            })()
        )
      ) {
        fail("artifact-purge-unsafe", "The generated-artifact pin set is incomplete or has unknown entries.");
      }
      synchronizeArtifactDirectory(active.descriptor, pinPaths.active);
      synchronizeArtifactDirectory(releasing.descriptor, pinPaths.releasing);
      synchronizeArtifactDirectory(pinRoot.descriptor, pinPaths.root);
      synchronizeArtifactDirectory(pinParent.descriptor, paths.artifactPins);
      return artifactPinBinding(pinPaths, pinRoot.metadata, active.metadata, releasing.metadata);
    } finally {
      manifest?.close();
      if (sourceRoot !== undefined) closeSync(sourceRoot.descriptor);
      if (releasing !== undefined) closeSync(releasing.descriptor);
      if (active !== undefined) closeSync(active.descriptor);
      if (pinRoot !== undefined) closeSync(pinRoot.descriptor);
      closeSync(pinParent.descriptor);
    }
  }

  function openArtifactPins(binding) {
    const pinPaths = Object.freeze({
      root: binding.root.path,
      active: binding.active.path,
      releasing: binding.releasing.path
    });
    validateArtifactPinBinding(binding, pinPaths);
    const pinParentIdentity = managedIdentities.get(paths.artifactPins);
    if (
      pinParentIdentity === undefined ||
      dirname(binding.root.path) !== paths.artifactPins ||
      dirname(binding.active.path) !== binding.root.path ||
      dirname(binding.releasing.path) !== binding.root.path ||
      basename(binding.active.path) !== "active" ||
      basename(binding.releasing.path) !== "releasing"
    ) {
      fail("artifact-purge-unsafe", "The generated-artifact pin parent is not manager-owned.");
    }
    const parent = openArtifactDirectoryDescriptor(
      paths.artifactPins,
      "Generated-artifact pin parent",
      pinParentIdentity
    );
    let root;
    let active;
    let releasing;
    try {
      root = openArtifactPrivateChildDirectory(
        parent.descriptor,
        basename(binding.root.path),
        binding.root.identity,
        "Generated-artifact pin root"
      );
      active = openArtifactPrivateChildDirectory(
        root.descriptor,
        "active",
        binding.active.identity,
        "Generated-artifact active pins"
      );
      releasing = openArtifactPrivateChildDirectory(
        root.descriptor,
        "releasing",
        binding.releasing.identity,
        "Generated-artifact releasing pins"
      );
      return Object.freeze({ parent, root, active, releasing, paths: pinPaths });
    } catch (error) {
      if (releasing !== undefined) closeSync(releasing.descriptor);
      if (active !== undefined) closeSync(active.descriptor);
      if (root !== undefined) closeSync(root.descriptor);
      closeSync(parent.descriptor);
      throw error;
    }
  }

  function closeArtifactPins(pins) {
    closeSync(pins.releasing.descriptor);
    closeSync(pins.active.descriptor);
    closeSync(pins.root.descriptor);
    closeSync(pins.parent.descriptor);
  }

  function removeEmptyArtifactPins(binding) {
    const pinPaths = Object.freeze({
      root: binding.root.path,
      active: binding.active.path,
      releasing: binding.releasing.path
    });
    validateArtifactPinBinding(binding, pinPaths);
    if (
      dirname(pinPaths.root) !== paths.artifactPins ||
      dirname(pinPaths.active) !== pinPaths.root ||
      dirname(pinPaths.releasing) !== pinPaths.root ||
      basename(pinPaths.active) !== "active" ||
      basename(pinPaths.releasing) !== "releasing"
    ) {
      fail("artifact-purge-unsafe", "The generated-artifact pin paths are not manager-owned.");
    }
    const parentIdentity = managedIdentities.get(paths.artifactPins);
    if (parentIdentity === undefined)
      fail("artifact-purge-unsafe", "The generated-artifact pin parent is not manager-owned.");
    const parent = openArtifactDirectoryDescriptor(paths.artifactPins, "Generated-artifact pin parent", parentIdentity);
    const rootReference = artifactDescriptorPath(parent.descriptor, basename(pinPaths.root));
    let rootMetadata;
    try {
      rootMetadata = lstatSync(rootReference, { bigint: true });
    } catch (error) {
      closeSync(parent.descriptor);
      if (error.code === "ENOENT") return;
      throw error;
    }
    let root;
    try {
      if (!sameIdentity(identityOf(rootMetadata), binding.root.identity)) {
        fail("artifact-purge-unsafe", "The generated-artifact pin root changed before cleanup.");
      }
      root = openArtifactPrivateChildDirectory(
        parent.descriptor,
        basename(pinPaths.root),
        binding.root.identity,
        "Generated-artifact pin root"
      );
      for (const [name, expected] of [
        ["active", binding.active.identity],
        ["releasing", binding.releasing.identity]
      ]) {
        const reference = artifactDescriptorPath(root.descriptor, name);
        let metadata;
        try {
          metadata = lstatSync(reference, { bigint: true });
        } catch (error) {
          if (error.code === "ENOENT") continue;
          throw error;
        }
        if (!metadata.isDirectory() || metadata.isSymbolicLink() || !sameIdentity(identityOf(metadata), expected)) {
          fail("artifact-purge-unsafe", `The generated-artifact ${name} pin directory changed before cleanup.`);
        }
        const child = openArtifactPrivateChildDirectory(
          root.descriptor,
          name,
          expected,
          `Generated-artifact ${name} pins`
        );
        try {
          if (readArtifactDirectoryBounded(child.descriptor, `Generated-artifact ${name} pins`).length !== 0) {
            fail("artifact-purge-unsafe", `The generated-artifact ${name} pins are not empty after purge.`);
          }
        } finally {
          closeSync(child.descriptor);
        }
        rmdirSync(reference);
        synchronizeArtifactDirectory(root.descriptor, pinPaths.root);
      }
      if (readArtifactDirectoryBounded(root.descriptor, "Generated-artifact pin root").length !== 0) {
        fail("artifact-purge-unsafe", "The generated-artifact pin root has unknown entries.");
      }
      rmdirSync(rootReference);
      synchronizeArtifactDirectory(parent.descriptor, paths.artifactPins);
    } finally {
      if (root !== undefined) closeSync(root.descriptor);
      closeSync(parent.descriptor);
    }
  }

  function removeArtifactTreeNoFollow(
    quarantinePath,
    expectedIdentity,
    recoveryPath,
    recoveryIdentity,
    manifestPath,
    manifestReceipt,
    pinBinding
  ) {
    assertNoMountAtOrBelow(quarantinePath);
    const quarantineParentIdentity = managedIdentities.get(paths.artifactQuarantine);
    if (dirname(quarantinePath) !== paths.artifactQuarantine || quarantineParentIdentity === undefined) {
      fail("artifact-purge-unsafe", "The generated-artifact quarantine parent is not manager-owned.");
    }
    const quarantineParent = openArtifactDirectoryDescriptor(
      paths.artifactQuarantine,
      "Generated-artifact quarantine parent",
      quarantineParentIdentity
    );
    const quarantineName = basename(quarantinePath);
    const quarantineReference = artifactDescriptorPath(quarantineParent.descriptor, quarantineName);
    let quarantineObserved;
    try {
      quarantineObserved = lstatSync(quarantineReference, { bigint: true });
    } catch (error) {
      closeSync(quarantineParent.descriptor);
      throw error;
    }
    if (
      !quarantineObserved.isDirectory() ||
      quarantineObserved.isSymbolicLink() ||
      !sameIdentity(identityOf(quarantineObserved), expectedIdentity)
    ) {
      closeSync(quarantineParent.descriptor);
      fail("artifact-purge-unsafe", "The generated-artifact quarantine changed before purge.");
    }
    let quarantineRoot;
    try {
      quarantineRoot = openArtifactChildDirectoryDescriptor(
        quarantineParent.descriptor,
        quarantineName,
        quarantineObserved,
        "Generated-artifact quarantine"
      );
    } catch (error) {
      closeSync(quarantineParent.descriptor);
      throw error;
    }
    let recoveryRoot;
    try {
      recoveryRoot = openArtifactDirectoryDescriptor(
        recoveryPath,
        "Generated-artifact recovery tree",
        recoveryIdentity
      );
    } catch (error) {
      closeSync(quarantineRoot.descriptor);
      closeSync(quarantineParent.descriptor);
      throw error;
    }
    let pins;
    let manifest;
    let sourceParents;
    let assertPinnedContent;
    try {
      pins = openArtifactPins(pinBinding);
      sourceParents = new Map();
      assertPinnedContent = (pin, record, expectedLinks, label) => {
        assertArtifactPinMetadata(pin.metadata, record, record.kind, expectedLinks, label);
        if (record.kind === "file") {
          const pinned = hashArtifactRegularFile(pin.reference, pin.metadata, label, expectedLinks);
          if (pinned.sha256 !== record.sha256 || pinned.metadata.size.toString() !== record.size) {
            fail("artifact-purge-unsafe", `${label} differs from the sealed source.`);
          }
          return;
        }
        const target = readlinkSync(pin.reference, { encoding: "buffer" });
        if (target.toString("base64") !== record.targetBase64 || sha256(target) !== record.targetSha256) {
          fail("artifact-purge-unsafe", `${label} differs from the sealed source.`);
        }
      };
      const releaseMissingPin = (record) => {
        if (record.kind !== "file" && record.kind !== "symlink") return;
        const parentPath = posix.dirname(record.path) === "." ? "" : posix.dirname(record.path);
        const parent = sourceParents.get(parentPath);
        const pinName = artifactPinName(record.path);
        const activePin = readArtifactPin(pins.active.descriptor, pinName, "Generated-artifact active pin");
        const releasingPin = readArtifactPin(pins.releasing.descriptor, pinName, "Generated-artifact releasing pin");
        if (parent === undefined) {
          fail("artifact-purge-unsafe", "A generated-artifact identity pin outlived its parent directory.");
        }
        if (activePin === undefined && releasingPin === undefined) return;
        if (activePin !== undefined && releasingPin !== undefined) {
          assertArtifactPinPair(
            activePin.metadata,
            releasingPin.metadata,
            record,
            record.kind,
            2n,
            2n,
            "Released generated-artifact pins"
          );
          assertPinnedContent(activePin, record, 2n, "Active generated-artifact pin");
          assertPinnedContent(releasingPin, record, 2n, "Released generated-artifact pin");
          synchronizeArtifactDirectory(parent.descriptor, parent.reference);
          unlinkSync(releasingPin.reference);
          synchronizeArtifactDirectory(pins.releasing.descriptor, pins.paths.releasing);
          const remaining = readArtifactPin(pins.active.descriptor, pinName, "Generated-artifact active pin");
          if (remaining === undefined) fail("artifact-purge-unsafe", "An active generated-artifact pin disappeared.");
          assertPinnedContent(remaining, record, 1n, "Active generated-artifact pin");
          unlinkSync(remaining.reference);
          synchronizeArtifactDirectory(pins.active.descriptor, pins.paths.active);
          return;
        }
        if (releasingPin !== undefined) {
          fail("artifact-purge-unsafe", "A released generated-artifact pin has no active identity pin.");
        }
        assertPinnedContent(activePin, record, 1n, "Active generated-artifact pin");
        synchronizeArtifactDirectory(parent.descriptor, parent.reference);
        unlinkSync(activePin.reference);
        synchronizeArtifactDirectory(pins.active.descriptor, pins.paths.active);
      };
      manifest = artifactManifestMatcher(manifestPath, manifestReceipt, { onSkipped: releaseMissingPin });
    } catch (error) {
      if (pins !== undefined) closeArtifactPins(pins);
      closeSync(recoveryRoot.descriptor);
      closeSync(quarantineRoot.descriptor);
      closeSync(quarantineParent.descriptor);
      throw error;
    }
    let entries = 0;
    const visit = (currentDescriptor, currentReference, recoveryDescriptor, recoveryReference, relativePath, depth) => {
      if (depth > MAXIMUM_ARTIFACT_DEPTH) fail("artifact-too-large", "The artifact purge exceeds its depth limit.");
      const currentMetadata = fstatSync(currentDescriptor, { bigint: true });
      const recoveryMetadata = fstatSync(recoveryDescriptor, { bigint: true });
      if (
        !currentMetadata.isDirectory() ||
        !recoveryMetadata.isDirectory() ||
        !currentUserOwns(currentMetadata) ||
        !currentUserOwns(recoveryMetadata)
      ) {
        fail("artifact-purge-unsafe", "Artifact purge encountered an unsafe directory.");
      }
      sourceParents.set(relativePath, Object.freeze({ descriptor: currentDescriptor, reference: currentReference }));
      try {
        manifest.match(relativePath, "directory", currentMetadata);
        hooks?.beforeArtifactPurgeDirectoryRead?.(Object.freeze({ quarantinePath, relativePath }));
        const children = readArtifactDirectoryBounded(currentDescriptor, "Artifact purge directory").sort(
          (left, right) => Buffer.compare(left.nameBytes, right.nameBytes)
        );
        for (const item of children) {
          entries += 1;
          if (entries > MAXIMUM_ARTIFACT_ENTRIES)
            fail("artifact-too-large", "The artifact purge exceeds its entry limit.");
          const child = artifactDescriptorPath(currentDescriptor, item.name);
          const recoveryChild = artifactDescriptorPath(recoveryDescriptor, item.name);
          const childRelative = relativePath === "" ? item.name : `${relativePath}/${item.name}`;
          const metadata = lstatSync(child, { bigint: true });
          let recoveryEntry;
          try {
            recoveryEntry = lstatSync(recoveryChild, { bigint: true });
          } catch {
            fail("artifact-purge-unsafe", "The quarantine contains an entry absent from the verified archive.");
          }
          if (metadata.isDirectory() && !metadata.isSymbolicLink()) {
            if (!recoveryEntry.isDirectory() || recoveryEntry.isSymbolicLink()) {
              fail("artifact-purge-unsafe", "A quarantined directory does not match the verified archive.");
            }
            const currentChild = openArtifactChildDirectoryDescriptor(
              currentDescriptor,
              item.name,
              metadata,
              `Quarantined artifact directory ${childRelative}`
            );
            let archivedChild;
            try {
              archivedChild = openArtifactChildDirectoryDescriptor(
                recoveryDescriptor,
                item.name,
                recoveryEntry,
                `Archived artifact directory ${childRelative}`
              );
              try {
                visit(
                  currentChild.descriptor,
                  child,
                  archivedChild.descriptor,
                  recoveryChild,
                  childRelative,
                  depth + 1
                );
              } finally {
                closeSync(archivedChild.descriptor);
              }
            } finally {
              closeSync(currentChild.descriptor);
            }
            const confirmed = lstatSync(child, { bigint: true });
            if (
              !confirmed.isDirectory() ||
              confirmed.isSymbolicLink() ||
              !sameIdentity(identityOf(confirmed), identityOf(metadata))
            ) {
              fail("artifact-purge-unsafe", "A quarantined directory changed before removal.");
            }
            rmdirSync(child);
            synchronizeArtifactDirectory(currentDescriptor, currentReference);
            hooks?.afterArtifactEntryRemoved?.(quarantinePath, child, entries);
          } else if (metadata.isFile() && !metadata.isSymbolicLink()) {
            if (!recoveryEntry.isFile() || recoveryEntry.isSymbolicLink()) {
              fail("artifact-purge-unsafe", "A quarantined file does not match the verified archive.");
            }
            const source = manifest.match(childRelative, "file", metadata);
            const pinName = artifactPinName(childRelative);
            const activePin = readArtifactPin(pins.active.descriptor, pinName, "Generated-artifact active pin");
            const releasingPin = readArtifactPin(
              pins.releasing.descriptor,
              pinName,
              "Generated-artifact releasing pin"
            );
            if (activePin === undefined || releasingPin !== undefined) {
              fail("artifact-purge-unsafe", "A generated-artifact file does not have one active identity pin.");
            }
            assertArtifactPinPair(metadata, activePin.metadata, source, "file", 2n, 2n, "Generated-artifact file pin");
            const currentFile = hashArtifactRegularFile(child, metadata, "Quarantined artifact file", 2n);
            const archivedFile = hashArtifactRegularFile(recoveryChild, recoveryEntry, "Archived artifact file");
            if (
              currentFile.sha256 !== archivedFile.sha256 ||
              currentFile.sha256 !== source.sha256 ||
              source.size !== metadata.size.toString() ||
              currentFile.metadata.size !== archivedFile.metadata.size ||
              (currentFile.metadata.mode & 0o7777n) !== (archivedFile.metadata.mode & 0o7777n)
            ) {
              fail("artifact-purge-unsafe", "A quarantined file does not match the verified archive.");
            }
            hooks?.beforeArtifactEntryUnlink?.(quarantinePath, child, entries);
            renameArtifactNoReplace(currentDescriptor, item.name, pins.releasing.descriptor, pinName);
            synchronizeArtifactDirectory(currentDescriptor, currentReference);
            synchronizeArtifactDirectory(pins.releasing.descriptor, pins.paths.releasing);
            const releasedPin = readArtifactPin(pins.releasing.descriptor, pinName, "Generated-artifact releasing pin");
            const retainedPin = readArtifactPin(pins.active.descriptor, pinName, "Generated-artifact active pin");
            if (releasedPin === undefined || retainedPin === undefined)
              fail("artifact-purge-unsafe", "A generated-artifact file pin disappeared during retirement.");
            assertArtifactPinPair(
              releasedPin.metadata,
              retainedPin.metadata,
              source,
              "file",
              2n,
              2n,
              "Released generated-artifact file pins"
            );
            const releasedFile = hashArtifactRegularFile(
              releasedPin.reference,
              releasedPin.metadata,
              "Released generated-artifact file pin",
              2n
            );
            const retainedFile = hashArtifactRegularFile(
              retainedPin.reference,
              retainedPin.metadata,
              "Active generated-artifact file pin",
              2n
            );
            if (releasedFile.sha256 !== source.sha256 || retainedFile.sha256 !== source.sha256) {
              fail("artifact-purge-unsafe", "A quarantined file changed before identity-bound removal.");
            }
            hooks?.afterArtifactSourceUnlink?.(quarantinePath, child, entries);
            const releasedAfter = readArtifactPin(
              pins.releasing.descriptor,
              pinName,
              "Generated-artifact releasing pin"
            );
            if (releasedAfter === undefined)
              fail("artifact-purge-unsafe", "A generated-artifact file pin disappeared.");
            assertPinnedContent(releasedAfter, source, 2n, "Released generated-artifact file pin");
            unlinkSync(releasedAfter.reference);
            synchronizeArtifactDirectory(pins.releasing.descriptor, pins.paths.releasing);
            const retainedAfter = readArtifactPin(pins.active.descriptor, pinName, "Generated-artifact active pin");
            if (retainedAfter === undefined)
              fail("artifact-purge-unsafe", "An active generated-artifact file pin disappeared.");
            assertPinnedContent(retainedAfter, source, 1n, "Active generated-artifact file pin");
            unlinkSync(retainedAfter.reference);
            synchronizeArtifactDirectory(pins.active.descriptor, pins.paths.active);
            hooks?.afterArtifactEntryRemoved?.(quarantinePath, child, entries);
          } else if (metadata.isSymbolicLink()) {
            if (!recoveryEntry.isSymbolicLink() || recoveryEntry.nlink !== 1n) {
              fail("artifact-purge-unsafe", "A quarantined symlink does not match the verified archive.");
            }
            const source = manifest.match(childRelative, "symlink", metadata);
            const pinName = artifactPinName(childRelative);
            const activePin = readArtifactPin(pins.active.descriptor, pinName, "Generated-artifact active pin");
            const releasingPin = readArtifactPin(
              pins.releasing.descriptor,
              pinName,
              "Generated-artifact releasing pin"
            );
            if (activePin === undefined || releasingPin !== undefined) {
              fail("artifact-purge-unsafe", "A generated-artifact symlink does not have one active identity pin.");
            }
            assertArtifactPinPair(
              metadata,
              activePin.metadata,
              source,
              "symlink",
              2n,
              2n,
              "Generated-artifact symlink pin"
            );
            hooks?.beforeArtifactEntryUnlink?.(quarantinePath, child, entries);
            renameArtifactNoReplace(currentDescriptor, item.name, pins.releasing.descriptor, pinName);
            synchronizeArtifactDirectory(currentDescriptor, currentReference);
            synchronizeArtifactDirectory(pins.releasing.descriptor, pins.paths.releasing);
            const releasedPin = readArtifactPin(pins.releasing.descriptor, pinName, "Generated-artifact releasing pin");
            const retainedPin = readArtifactPin(pins.active.descriptor, pinName, "Generated-artifact active pin");
            if (releasedPin === undefined || retainedPin === undefined)
              fail("artifact-purge-unsafe", "A generated-artifact symlink pin disappeared during retirement.");
            assertArtifactPinPair(
              releasedPin.metadata,
              retainedPin.metadata,
              source,
              "symlink",
              2n,
              2n,
              "Released generated-artifact symlink pins"
            );
            assertPinnedContent(releasedPin, source, 2n, "Released generated-artifact symlink pin");
            assertPinnedContent(retainedPin, source, 2n, "Active generated-artifact symlink pin");
            hooks?.afterArtifactSourceUnlink?.(quarantinePath, child, entries);
            const releasedAfter = readArtifactPin(
              pins.releasing.descriptor,
              pinName,
              "Generated-artifact releasing pin"
            );
            if (releasedAfter === undefined)
              fail("artifact-purge-unsafe", "A generated-artifact symlink pin disappeared.");
            assertPinnedContent(releasedAfter, source, 2n, "Released generated-artifact symlink pin");
            unlinkSync(releasedAfter.reference);
            synchronizeArtifactDirectory(pins.releasing.descriptor, pins.paths.releasing);
            const retainedAfter = readArtifactPin(pins.active.descriptor, pinName, "Generated-artifact active pin");
            if (retainedAfter === undefined)
              fail("artifact-purge-unsafe", "An active generated-artifact symlink pin disappeared.");
            assertPinnedContent(retainedAfter, source, 1n, "Active generated-artifact symlink pin");
            unlinkSync(retainedAfter.reference);
            synchronizeArtifactDirectory(pins.active.descriptor, pins.paths.active);
            hooks?.afterArtifactEntryRemoved?.(quarantinePath, child, entries);
          } else {
            fail("artifact-purge-unsafe", "Artifact purge encountered a special file.");
          }
        }
        manifest.consumeMissingChildren(relativePath);
        const currentAfter = fstatSync(currentDescriptor, { bigint: true });
        const currentNamed = lstatSync(currentReference, { bigint: true });
        const recoveryAfter = fstatSync(recoveryDescriptor, { bigint: true });
        const recoveryNamed =
          recoveryReference === undefined ? recoveryAfter : lstatSync(recoveryReference, { bigint: true });
        if (
          !currentAfter.isDirectory() ||
          !currentNamed.isDirectory() ||
          currentNamed.isSymbolicLink() ||
          !sameIdentity(identityOf(currentAfter), identityOf(currentMetadata)) ||
          !sameIdentity(identityOf(currentNamed), identityOf(currentMetadata)) ||
          !sameArtifactStat(recoveryMetadata, recoveryAfter) ||
          !sameArtifactStat(recoveryMetadata, recoveryNamed)
        ) {
          fail("artifact-purge-unsafe", "An artifact directory changed during descriptor-relative purge.");
        }
      } finally {
        sourceParents.delete(relativePath);
      }
    };
    try {
      visit(quarantineRoot.descriptor, quarantineReference, recoveryRoot.descriptor, undefined, "", 0);
      sourceParents.set("", Object.freeze({ descriptor: quarantineRoot.descriptor, reference: quarantineReference }));
      try {
        manifest.finish();
      } finally {
        sourceParents.delete("");
      }
      if (
        readArtifactDirectoryBounded(pins.active.descriptor, "Generated-artifact active pins").length !== 0 ||
        readArtifactDirectoryBounded(pins.releasing.descriptor, "Generated-artifact releasing pins").length !== 0
      ) {
        fail("artifact-purge-unsafe", "Generated-artifact identity pins remain after source purge.");
      }
      const finalRoot = lstatSync(quarantineReference, { bigint: true });
      if (
        !finalRoot.isDirectory() ||
        finalRoot.isSymbolicLink() ||
        !sameIdentity(identityOf(finalRoot), expectedIdentity)
      ) {
        fail("artifact-purge-unsafe", "The artifact quarantine changed before final removal.");
      }
      rmdirSync(quarantineReference);
      synchronizeArtifactDirectory(quarantineParent.descriptor, paths.artifactQuarantine);
    } finally {
      closeSync(recoveryRoot.descriptor);
      closeSync(quarantineRoot.descriptor);
      closeSync(quarantineParent.descriptor);
      manifest.close();
      closeArtifactPins(pins);
    }
  }

  function appendArtifactProgress(records, eligible, kind, fields) {
    return appendArtifactSweepRecord(eligible.slug, eligible.ownerRevision, {
      protocol: ARTIFACT_SWEEP_PROTOCOL,
      kind,
      slug: eligible.slug,
      ownerTask: eligible.ownerTask,
      ownerRevision: eligible.ownerRevision,
      sequence: records.length + 1,
      operationId: eligible.operationId,
      previous: artifactReceiptAnchor(records.at(-1).path, records.at(-1).loaded),
      ...fields
    });
  }

  function renameArtifactNoReplace(sourceParentDescriptor, sourceName, destinationParentDescriptor, destinationName) {
    requireArtifactDescriptorTraversal();
    let interpreter;
    let interpreterMetadata;
    try {
      interpreter = realpathSync("/usr/bin/python3");
      interpreterMetadata = lstatSync(interpreter, { bigint: true });
    } catch {
      fail("artifact-platform-unsupported", "Atomic generated-artifact quarantine requires /usr/bin/python3.");
    }
    if (
      !interpreterMetadata.isFile() ||
      interpreterMetadata.isSymbolicLink() ||
      interpreterMetadata.nlink !== 1n ||
      (interpreterMetadata.mode & 0o111n) === 0n
    ) {
      fail("artifact-platform-unsupported", "The fixed atomic-rename helper interpreter is unsafe.");
    }
    const result = spawnSync(
      interpreter,
      ["-I", "-S", "-c", ARTIFACT_RENAME_HELPER_SOURCE, sourceName, destinationName],
      {
        encoding: "utf8",
        env: Object.freeze({ LC_ALL: "C", PYTHONIOENCODING: "utf-8" }),
        maxBuffer: 4096,
        stdio: ["ignore", "pipe", "pipe", sourceParentDescriptor, destinationParentDescriptor],
        timeout: 5000,
        windowsHide: true
      }
    );
    const interpreterAfter = lstatSync(interpreter, { bigint: true });
    if (!sameArtifactStat(interpreterMetadata, interpreterAfter)) {
      fail("artifact-platform-unsupported", "The atomic-rename helper interpreter changed while it ran.");
    }
    if (result.status === 0 && result.stdout === "ok\n" && result.stderr === "") return;
    if (result.status === 10 && /^[0-9]{1,5}\n$/u.test(result.stderr) && result.stdout === "") {
      const errorNumber = Number(result.stderr.trim());
      if (errorNumber === 17) fail("artifact-layout-blocked", "The artifact quarantine destination already exists.");
      if (errorNumber === 2) fail("artifact-source-changed", "The generated artifact disappeared before quarantine.");
      if (errorNumber === 18) fail("artifact-cross-device", "Artifact quarantine must stay on one filesystem.");
    }
    if (result.status === 11) {
      fail("artifact-platform-unsupported", "Linux renameat2 with RENAME_NOREPLACE is unavailable.");
    }
    fail("artifact-unsafe", "The bounded atomic-rename helper failed or returned an invalid response.");
  }

  function moveArtifactToQuarantine(eligible, quarantinePath) {
    const quarantineParentIdentity = managedIdentities.get(paths.artifactQuarantine);
    if (
      dirname(eligible.originalPath) !== eligible.approvedRoot ||
      dirname(quarantinePath) !== paths.artifactQuarantine ||
      quarantineParentIdentity === undefined
    ) {
      fail("artifact-layout-blocked", "The artifact move no longer has its exact reviewed parent directories.");
    }
    const sourceParent = openArtifactDirectoryDescriptor(
      eligible.approvedRoot,
      "Reviewed artifact root",
      eligible.rootIdentity
    );
    let destinationParent;
    try {
      destinationParent = openArtifactDirectoryDescriptor(
        paths.artifactQuarantine,
        "Generated-artifact quarantine parent",
        quarantineParentIdentity
      );
    } catch (error) {
      closeSync(sourceParent.descriptor);
      throw error;
    }
    const sourceReference = artifactDescriptorPath(sourceParent.descriptor, basename(eligible.originalPath));
    const destinationReference = artifactDescriptorPath(destinationParent.descriptor, basename(quarantinePath));
    try {
      const source = lstatSync(sourceReference, { bigint: true });
      if (
        !source.isDirectory() ||
        source.isSymbolicLink() ||
        !currentUserOwns(source) ||
        !sameIdentity(identityOf(source), eligible.originalIdentity)
      ) {
        fail("artifact-source-changed", "The generated artifact changed before descriptor-relative quarantine.");
      }
      try {
        lstatSync(destinationReference, { bigint: true });
        fail("artifact-layout-blocked", "The artifact quarantine destination already exists.");
      } catch (error) {
        if (error instanceof CheckoutLifecycleError) throw error;
        if (error.code !== "ENOENT") throw error;
      }
      hooks?.beforeArtifactRenameNoReplace?.(Object.freeze({ eligible, quarantinePath }));
      renameArtifactNoReplace(
        sourceParent.descriptor,
        basename(eligible.originalPath),
        destinationParent.descriptor,
        basename(quarantinePath)
      );
      const moved = lstatSync(destinationReference, { bigint: true });
      if (
        !moved.isDirectory() ||
        moved.isSymbolicLink() ||
        !sameIdentity(identityOf(moved), eligible.originalIdentity)
      ) {
        fail("artifact-layout-blocked", "The descriptor-relative artifact move did not preserve exact identity.");
      }
      synchronizeArtifactDirectory(destinationParent.descriptor, paths.artifactQuarantine);
      synchronizeArtifactDirectory(sourceParent.descriptor, eligible.approvedRoot);
    } finally {
      closeSync(destinationParent.descriptor);
      closeSync(sourceParent.descriptor);
    }
  }

  function sweepArtifactOne(slug, ownerRevision, bootId) {
    let records = [...readArtifactSweepRecords(slug, ownerRevision)];
    if (records.length === 0) fail("invalid-artifact-journal", "The artifact sweep lost its eligibility record.");
    const eligible = records[0].loaded.value;
    if (eligible.eligibleBootId === bootId) {
      return Object.freeze({ kind: "artifact", slug, state: "waiting-for-next-boot", moved: false, removed: false });
    }
    const authority = artifactAuthority(slug, ownerRevision);
    if (
      authority.review.reviewSha256 !== eligible.reviewSha256 ||
      !isDeepStrictEqual(artifactReceiptAnchor(authority.entry.path, authority.entry), eligible.entry)
    ) {
      fail("artifact-source-changed", "The generated-artifact archive authority changed after enrollment.");
    }
    let layout = artifactLayout(eligible);
    if (layout.state === "blocked") fail("artifact-layout-blocked", "The artifact retirement layout is ambiguous.");
    if (records.length <= 2 && layout.state === "original") {
      revalidateManagedArtifactAuthority({
        slug: eligible.slug,
        artifactPath: eligible.originalPath,
        approvedRoot: eligible.approvedRoot,
        ownerTask: eligible.ownerTask,
        ownerRevision: eligible.ownerRevision
      });
      const current = scanArtifactTree(eligible.originalPath, eligible.originalIdentity);
      validateArtifactRoot(eligible.approvedRoot, "Reviewed artifact root", eligible.rootIdentity);
      if (!isDeepStrictEqual(artifactSnapshotCore(current), artifactSnapshotCore(authority.review.snapshot))) {
        fail("artifact-source-changed", "The generated artifact changed after retirement enrollment.");
      }
      validateArtifactArchiveAttempt(authority.entry.attempt, authority.review);
      if (records.length === 1) {
        records.push(
          appendArtifactProgress(records, eligible, "quarantine-intent", {
            bootId,
            originalPath: eligible.originalPath,
            quarantinePath: layout.quarantinePath
          })
        );
      }
      hooks?.beforeArtifactMove?.(eligible, layout);
      const confirmed = scanArtifactTree(eligible.originalPath, eligible.originalIdentity);
      if (!isDeepStrictEqual(artifactSnapshotCore(confirmed), artifactSnapshotCore(authority.review.snapshot))) {
        fail("artifact-source-changed", "The generated artifact changed immediately before quarantine.");
      }
      revalidateManagedArtifactAuthority({
        slug: eligible.slug,
        artifactPath: eligible.originalPath,
        approvedRoot: eligible.approvedRoot,
        ownerTask: eligible.ownerTask,
        ownerRevision: eligible.ownerRevision
      });
      moveArtifactToQuarantine(eligible, layout.quarantinePath);
      hooks?.afterArtifactMove?.(eligible);
      layout = artifactLayout(eligible);
    }
    if (records.length === 2) {
      if (layout.state !== "quarantine")
        fail("artifact-layout-blocked", "Artifact quarantine did not complete exactly.");
      const pins = ensureArtifactPins(
        layout.quarantinePath,
        eligible.originalIdentity,
        authority.entry.attempt.manifestPath,
        authority.entry.attempt.manifest,
        artifactPinPaths(eligible.slug, eligible.ownerRevision, eligible.operationId)
      );
      records.push(
        appendArtifactProgress(records, eligible, "quarantine-result", {
          bootId,
          quarantinePath: layout.quarantinePath,
          location: "quarantine",
          pins
        })
      );
    }
    layout = artifactLayout(eligible);
    if ((records.length === 3 || records.length === 4) && layout.state === "quarantine") {
      validateArtifactArchiveAttempt(authority.entry.attempt, authority.review);
      if (records.length === 3) {
        records.push(
          appendArtifactProgress(records, eligible, "purge-intent", {
            bootId,
            quarantinePath: layout.quarantinePath
          })
        );
      }
      hooks?.beforeArtifactPurge?.(eligible, layout);
      removeArtifactTreeNoFollow(
        layout.quarantinePath,
        eligible.originalIdentity,
        authority.entry.attempt.recoveryPath,
        authority.entry.attempt.recoveryIdentity,
        authority.entry.attempt.manifestPath,
        authority.entry.attempt.manifest,
        records[2].loaded.value.pins
      );
      hooks?.afterArtifactPurge?.(eligible);
      layout = artifactLayout(eligible);
    }
    if (records.length === 4 && layout.state === "absent") {
      validateArtifactArchiveAttempt(authority.entry.attempt, authority.review);
      removeEmptyArtifactPins(records[2].loaded.value.pins);
      records.push(
        appendArtifactProgress(records, eligible, "retired", {
          bootId,
          quarantinePath: layout.quarantinePath,
          archivePreserved: true
        })
      );
    }
    if (records.length === 5 && layout.state === "absent") {
      return Object.freeze({ kind: "artifact", slug, state: "retired", moved: true, removed: true });
    }
    return Object.freeze({
      kind: "artifact",
      slug,
      state: layout.state === "quarantine" ? "held-after-move" : "held",
      moved: layout.state !== "original",
      removed: layout.state === "absent"
    });
  }

  function sweepArtifactRetirements(bootId) {
    initializeArtifactJournal();
    const candidates = readDirectoryBounded(paths.artifactSweeps, MAXIMUM_ENTRIES, "Artifact sweep journal")
      .map((item) => {
        const match = ARTIFACT_SWEEP_DIRECTORY_PATTERN.exec(item.name);
        if (!item.isDirectory() || item.isSymbolicLink() || match === null) {
          fail("invalid-artifact-journal", "The artifact sweep journal contains an unknown entry.");
        }
        return Object.freeze({ slug: match[1], ownerRevision: Number(match[2]) });
      })
      .sort((left, right) => left.slug.localeCompare(right.slug));
    const held = new Set([
      "artifact-archive-changed",
      "artifact-archive-incomplete",
      "artifact-changed",
      "artifact-cross-device",
      "artifact-layout-blocked",
      "artifact-platform-unsupported",
      "artifact-purge-unsafe",
      "artifact-source-changed",
      "artifact-too-large",
      "artifact-unsafe",
      "retirement-mount-present"
    ]);
    return Object.freeze(
      candidates.map((candidate) => {
        try {
          return sweepArtifactOne(candidate.slug, candidate.ownerRevision, bootId);
        } catch (error) {
          if (!(error instanceof CheckoutLifecycleError) || !held.has(error.code)) throw error;
          const records = readArtifactSweepRecords(candidate.slug, candidate.ownerRevision);
          const layout = artifactLayout(records[0].loaded.value);
          return Object.freeze({
            kind: "artifact",
            slug: candidate.slug,
            state: "held",
            code: error.code,
            layout: layout.state,
            moved: layout.state === "quarantine",
            removed: layout.state === "absent"
          });
        }
      })
    );
  }

  const managerApi = Object.freeze({
    paths,

    artifactAudit({ slug, artifactPath, approvedRoot, ownerTask, ownerRevision }) {
      initializeManager(false);
      for (const [path, identity] of managedIdentities) {
        assertPrivateDirectory(path, path);
        revalidatePathIdentity(path, identity, path, "directory");
      }
      revalidatePathIdentity(repository.commonGitDirectory, repository.identity, "Git common directory", "directory");
      return captureArtifactReview({ slug, artifactPath, approvedRoot, ownerTask, ownerRevision }).public;
    },

    artifactRetire({ slug, artifactPath, approvedRoot, ownerTask, ownerRevision, expectedReviewSha256 }) {
      if (typeof expectedReviewSha256 !== "string" || !/^[0-9a-f]{64}$/u.test(expectedReviewSha256)) {
        fail("invalid-artifact-review", "Artifact retirement requires the exact SHA-256 from artifact-audit.");
      }
      return withLock(() => {
        const review = captureArtifactReview({ slug, artifactPath, approvedRoot, ownerTask, ownerRevision }).public;
        if (review.reviewSha256 !== expectedReviewSha256) {
          fail("artifact-review-changed", "The artifact dry audit changed; review a new audit before retirement.");
        }
        const entry = ensureArtifactArchive(review);
        const enrollment = enrollArtifactRetirement(Object.freeze({ entry, review }));
        return Object.freeze({
          status: "artifact-retirement-enrolled",
          slug: review.slug,
          ownerTask,
          ownerRevision,
          reviewSha256: expectedReviewSha256,
          archive: Object.freeze({
            attempt: entry.attempt.attempt,
            recoveryPath: entry.attempt.recoveryPath,
            manifestPath: entry.attempt.manifestPath,
            sourceBytes: entry.attempt.receipt.value.source.byteLength,
            entryCount: entry.attempt.receipt.value.source.entryCount
          }),
          enrollment,
          movement: "deferred-until-a-later-boot",
          authorizesImmediateMove: false
        });
      });
    },

    discover({ roots, maxDepth = MAXIMUM_DISCOVERY_DEPTH }) {
      revalidatePathIdentity(repository.commonGitDirectory, repository.identity, "Git common directory", "directory");
      return discoverRepositories({ roots, maxDepth });
    },

    legacyAudit({ slug, generatedRoots = [], generatedFiles = [], checkoutPath, approvedRoot, dependencyRoots }) {
      assertSlug(slug);
      initializeManager(false);
      for (const [path, identity] of managedIdentities) {
        assertPrivateDirectory(path, path);
        revalidatePathIdentity(path, identity, path, "directory");
      }
      revalidatePathIdentity(repository.commonGitDirectory, repository.identity, "Git common directory", "directory");
      return captureLegacyAudit(
        slug,
        generatedRoots,
        generatedFiles,
        requestedExplicitLegacyTarget(slug, checkoutPath, approvedRoot, dependencyRoots)
      );
    },

    legacyBatchAudit({ manifestPath }) {
      initializeManager(false);
      for (const [path, identity] of managedIdentities) {
        assertPrivateDirectory(path, path);
        revalidatePathIdentity(path, identity, path, "directory");
      }
      revalidatePathIdentity(repository.commonGitDirectory, repository.identity, "Git common directory", "directory");
      return captureLegacyBatchReview(readLegacyBatchManifest(manifestPath)).public;
    },

    legacyBatchAdopt({ manifestPath, expectedReviewSha256 }) {
      if (typeof expectedReviewSha256 !== "string" || !/^[0-9a-f]{64}$/u.test(expectedReviewSha256)) {
        fail("invalid-legacy-batch", "Batch adoption requires the exact reviewed SHA-256 from a dry run.");
      }
      return withLock(() => {
        initializeManager(false);
        const manifest = readLegacyBatchManifest(manifestPath);
        const review = captureLegacyBatchReview(manifest);
        if (review.public.reviewSha256 !== expectedReviewSha256) {
          fail(
            "legacy-batch-review-changed",
            "The batch dry-run result changed; review a new dry run before adoption."
          );
        }
        if (review.public.blockedCount !== 0) {
          fail("legacy-batch-not-eligible", "The reviewed batch contains blocked candidates and cannot be adopted.");
        }
        const adopted = [];
        for (const item of review.classified) {
          const candidate = item.candidate;
          const result = item.alreadyAdopted
            ? Object.freeze({
                status: "already-adopted",
                slug: candidate.slug,
                generation: currentLegacyAdoption(candidate.slug).entry.value.generation,
                ownerTask: candidate.ownerTask,
                ownerRevision: 1,
                authorizesMove: false,
                authorizesCleanup: false
              })
            : adoptLegacyInternal({
                slug: candidate.slug,
                ownerTask: candidate.ownerTask,
                generatedRoots: candidate.generatedRoots,
                generatedFiles: candidate.generatedFiles,
                checkoutPath: candidate.path,
                approvedRoot: candidate.root,
                dependencyRoots: manifest.normalized.dependencyRoots,
                dependencyCatalog: review.catalog,
                resumeAttempt: item.resumableAttempt,
                expectedEvidence: item.evidence
              });
          adopted.push(result);
          hooks?.afterLegacyBatchCandidateAdopt?.(candidate, result);
          revalidateLegacyBatchManifest(manifest);
        }
        review.catalog.revalidate();
        revalidateLegacyBatchManifest(manifest);
        return Object.freeze({
          status: "batch-adopted-review-required",
          manifestSha256: manifest.sha256,
          reviewSha256: expectedReviewSha256,
          adopted: Object.freeze(adopted),
          nextStep: "archive-each-before-retirement-enrollment",
          authorizesMove: false,
          authorizesCleanup: false
        });
      });
    },

    legacyBatchRetire({ manifestPath, expectedReviewSha256 }) {
      const adoption = managerApi.legacyBatchAdopt({ manifestPath, expectedReviewSha256 });
      const manifest = readLegacyBatchManifest(manifestPath);
      if (manifest.sha256 !== adoption.manifestSha256) {
        fail("legacy-batch-review-changed", "The batch manifest changed after adoption.");
      }
      const candidates = [];
      for (const candidate of manifest.normalized.candidates) {
        revalidateLegacyBatchManifest(manifest);
        let status = managerApi.legacyStatus(candidate.slug)[0];
        let archive;
        if (status.archive?.state === "archived-review-required") {
          archive = Object.freeze({ status: "already-archived", ...status.archive });
        } else {
          archive = managerApi.legacyArchive({
            slug: candidate.slug,
            ownerTask: candidate.ownerTask,
            expectedRevision: 1
          });
        }
        revalidateLegacyBatchManifest(manifest);
        status = managerApi.legacyStatus(candidate.slug)[0];
        const enrollment =
          status.retirement === undefined
            ? managerApi.enrollRetirement({
                kind: "legacy",
                slug: candidate.slug,
                ownerTask: candidate.ownerTask,
                expectedRevision: 1
              })
            : managerApi.verifyRetirementEnrollment({ kind: "legacy", slug: candidate.slug });
        const result = Object.freeze({
          slug: candidate.slug,
          adoption: adoption.adopted.find((item) => item.slug === candidate.slug),
          archive,
          enrollment
        });
        candidates.push(result);
        hooks?.afterLegacyBatchCandidateRetire?.(candidate, result);
        revalidateLegacyBatchManifest(manifest);
      }
      revalidateLegacyBatchManifest(manifest);
      return Object.freeze({
        status: "batch-retirement-enrolled",
        manifestSha256: manifest.sha256,
        reviewSha256: expectedReviewSha256,
        candidates: Object.freeze(candidates),
        movement: "deferred-until-a-later-boot",
        authorizesImmediateMove: false
      });
    },

    legacyStatus(slug = undefined) {
      if (slug !== undefined) assertSlug(slug);
      initializeManager(false);
      for (const [path, identity] of managedIdentities) {
        assertPrivateDirectory(path, path);
        revalidatePathIdentity(path, identity, path, "directory");
      }
      revalidatePathIdentity(repository.commonGitDirectory, repository.identity, "Git common directory", "directory");
      return legacyStatusRows(slug);
    },

    legacyAdopt({
      slug,
      ownerTask,
      generatedRoots = [],
      generatedFiles = [],
      checkoutPath,
      approvedRoot,
      dependencyRoots
    }) {
      return withLock(() =>
        adoptLegacyInternal({
          slug,
          ownerTask,
          generatedRoots,
          generatedFiles,
          checkoutPath,
          approvedRoot,
          dependencyRoots
        })
      );
    },
    legacyArchive({ slug, ownerTask, expectedRevision }) {
      assertSlug(slug);
      assertOwner(ownerTask);
      assertRevision(expectedRevision);
      return withLock(() => {
        initializeLegacyAdoptionJournal();
        initializeLegacyArchiveJournal();
        const adoption = currentLegacyAdoption(slug);
        const authority = assertLegacyAdoptionAuthority(adoption, ownerTask, expectedRevision);
        revalidateLegacyDependencyUniverse(adoption);
        const adoptionAnchor = legacyArchiveAdoptionAnchor(adoption);
        const priorArchives = listLegacyArchiveAttempts(slug);
        if (legacyArchiveEntrySlugs(slug).length !== 0) {
          readLegacyArchiveEntry(slug, priorArchives);
          fail("legacy-archive-exists", `Legacy checkout ${slug} already has a published recovery archive.`);
        }
        const attempt = allocateLegacyArchiveAttempt(slug, adoption.entry.value.generation);
        const token = tokenFactory();
        if (!/^[0-9a-f]{32}$/u.test(token)) fail("invalid-legacy-archive", "The archive token is malformed.");
        const requestValue = {
          protocol: LEGACY_ARCHIVE_REQUEST_PROTOCOL,
          slug,
          adoptionGeneration: adoption.entry.value.generation,
          attempt: attempt.attempt,
          ownerTask,
          ownerRevision: authority.ownerRevision,
          token,
          adoption: adoptionAnchor
        };
        validateLegacyArchiveRequest(requestValue, slug, adoption.entry.value.generation, attempt.attempt);
        assertPersistedJsonFits(requestValue, "Legacy archive request", "legacy-archive-record-too-large");
        const requestPath = join(attempt.path, "request.json");
        writeJsonExclusive(requestPath, requestValue, attempt.identity);
        const request = readJsonReceipt(requestPath, MAXIMUM_ENTRY_BYTES, "Legacy archive request");
        validateLegacyArchiveRequest(request.value, slug, adoption.entry.value.generation, attempt.attempt);
        if (!isDeepStrictEqual(request.value, requestValue)) {
          fail("legacy-archive-changed", "The legacy archive request changed while it was recorded.");
        }
        hooks?.afterLegacyArchiveRequest?.(attempt, requestValue);
        const firstAudit = captureAdoptedLegacyAudit(adoption);
        assertAuditMatchesAdoption(firstAudit, adoption);
        revalidateLegacyAdoptionAnchor(adoption, adoptionAnchor);

        const candidate = adoptedLegacyCandidate(adoption);
        const snapshot = createLegacyAuditSnapshot(candidate);
        let objects;
        let confirmedObjects;
        let packed;
        let metadata;
        let metadataReceipt;
        let storage;
        try {
          requireLegacyGit(
            snapshot,
            ["--no-pager", "fsck", "--strict", "--full", "--no-dangling"],
            "Legacy pre-archive object-store verification"
          );
          objects = createLegacyObjectManifest(snapshot, attempt.path, "objects");
          hooks?.afterLegacyObjectManifest?.(attempt, objects);
          storage = archiveFreeSpace(BigInt(objects.objectBytes));
          packed = createLegacyObjectPack(snapshot, attempt, objects);
          metadata = captureLegacyRecoveryMetadata(snapshot, join(attempt.path, "recovery-logs"));
          metadataReceipt = persistLegacyRecoveryMetadata(attempt, metadata);
          confirmedObjects = createLegacyObjectManifest(snapshot, attempt.path, "source-confirmed");
          compareLegacyObjectManifests(objects, confirmedObjects, "The source object store after packing");
          requireLegacyGit(
            snapshot,
            ["--no-pager", "fsck", "--strict", "--full", "--no-dangling"],
            "Legacy post-pack object-store verification"
          );
          revalidateLegacyAuditSnapshot(snapshot);
        } finally {
          removeLegacyAuditSnapshot(snapshot);
        }

        const recovery = proveLegacyArchiveRecovery(attempt, objects, packed, metadata);
        const secondAudit = captureAdoptedLegacyAudit(adoption);
        assertAuditMatchesAdoption(secondAudit, adoption);
        confirmLegacyArchiveSource(adoption, objects, metadata);
        const receiptValue = {
          protocol: LEGACY_ARCHIVE_RECEIPT_PROTOCOL,
          slug,
          adoptionGeneration: adoption.entry.value.generation,
          attempt: attempt.attempt,
          ownerTask,
          ownerRevision: authority.ownerRevision,
          request: {
            path: requestPath,
            identity: request.identity,
            byteLength: request.byteLength,
            sha256: request.sha256
          },
          adoptionAuditSha256: sha256(JSON.stringify(secondAudit)),
          objects: {
            objectFormat: objects.objectFormat,
            objectCount: objects.objectCount,
            objectBytes: objects.objectBytes,
            manifest: { path: objects.manifestPath, ...objects.manifest },
            names: { path: objects.namesPath, ...objects.oids },
            confirmedManifest: { path: confirmedObjects.manifestPath, ...confirmedObjects.manifest },
            confirmedNames: { path: confirmedObjects.namesPath, ...confirmedObjects.oids },
            pack: packed.pack,
            index: recovery.index,
            packId: recovery.packId
          },
          metadata: {
            path: metadataReceipt.path,
            identity: metadataReceipt.identity,
            byteLength: metadataReceipt.byteLength,
            sha256: metadataReceipt.sha256
          },
          recovery,
          storage,
          state: "verified-review-required",
          authorizesMove: false,
          authorizesCleanup: false
        };
        validateLegacyArchiveReceipt(receiptValue, attempt, request);
        assertPersistedJsonFits(receiptValue, "Legacy archive receipt", "legacy-archive-record-too-large");
        const receiptPath = join(attempt.path, "receipt.json");
        writeJsonExclusive(receiptPath, receiptValue, attempt.identity);
        const receipt = readJsonReceipt(receiptPath, MAXIMUM_ENTRY_BYTES, "Legacy archive receipt");
        validateLegacyArchiveReceipt(receipt.value, attempt, request);
        if (!isDeepStrictEqual(receipt.value, receiptValue)) {
          fail("legacy-archive-changed", "The legacy archive receipt changed while it was recorded.");
        }
        hooks?.beforeLegacyArchivePublish?.(attempt, receiptValue);
        confirmLegacyArchiveSource(adoption, objects, metadata);
        validateLegacyArchiveReceipt(receipt.value, attempt, request);
        revalidatePathIdentity(requestPath, request.identity, "Legacy archive request");
        revalidatePathIdentity(receiptPath, receipt.identity, "Legacy archive receipt");
        const completionValue = {
          protocol: LEGACY_ARCHIVE_COMPLETION_PROTOCOL,
          slug,
          adoptionGeneration: adoption.entry.value.generation,
          attempt: attempt.attempt,
          ownerTask,
          ownerRevision: authority.ownerRevision,
          receipt: {
            path: receiptPath,
            identity: receipt.identity,
            byteLength: receipt.byteLength,
            sha256: receipt.sha256
          },
          state: "archived-review-required",
          authorizesMove: false,
          authorizesCleanup: false
        };
        validateLegacyArchiveCompletion(completionValue, attempt, receipt);
        assertPersistedJsonFits(completionValue, "Legacy archive completion", "legacy-archive-record-too-large");
        const completionPath = join(attempt.path, "complete.json");
        writeJsonExclusive(completionPath, completionValue, attempt.identity);
        const completion = readJsonReceipt(completionPath, MAXIMUM_ENTRY_BYTES, "Legacy archive completion");
        validateLegacyArchiveCompletion(completion.value, attempt, receipt);
        if (!isDeepStrictEqual(completion.value, completionValue)) {
          fail("legacy-archive-changed", "The legacy archive completion changed while it was recorded.");
        }
        const entriesIdentity = managedIdentities.get(paths.legacyArchiveEntries);
        if (entriesIdentity === undefined) fail("unsafe-manager", "The legacy archive entries were not initialized.");
        revalidatePathIdentity(paths.legacyArchiveEntries, entriesIdentity, "Legacy archive entries", "directory");
        confirmLegacyArchiveSource(adoption, objects, metadata);
        try {
          linkSync(completionPath, legacyArchiveEntryPath(slug));
          fsyncDirectory(paths.legacyArchiveEntries);
        } catch (error) {
          if (error.code === "EEXIST")
            fail("legacy-archive-exists", `Legacy checkout ${slug} was archived concurrently.`);
          throw error;
        }
        confirmLegacyArchiveSource(adoption, objects, metadata);
        hooks?.afterLegacyArchivePublish?.(attempt, completionValue);
        confirmLegacyArchiveSource(adoption, objects, metadata);
        const recordedAttempts = listLegacyArchiveAttempts(slug);
        const entry = readLegacyArchiveEntry(slug, recordedAttempts);
        if (entry === undefined || !isDeepStrictEqual(entry.value, completionValue)) {
          fail("legacy-archive-changed", "The published legacy archive record changed.");
        }
        return Object.freeze({
          status: "archived-review-required",
          slug,
          adoptionGeneration: adoption.entry.value.generation,
          attempt: attempt.attempt,
          ownerTask,
          ownerRevision: authority.ownerRevision,
          objectCount: objects.objectCount,
          objectBytes: objects.objectBytes,
          packSha256: packed.pack.sha256,
          archivePath: attempt.path,
          recoveryPath: recovery.repository.path,
          authorizesMove: false,
          authorizesCleanup: false
        });
      });
    },

    enrollRetirement({ kind, slug, ownerTask, expectedRevision }) {
      assertSlug(slug);
      if (!["managed", "legacy"].includes(kind)) {
        fail("invalid-retirement-kind", "Retirement kind must be managed or legacy.");
      }
      let authority;
      if (kind === "legacy") {
        assertOwner(ownerTask);
        assertRevision(expectedRevision);
        authority = { ownerTask, expectedRevision };
      }
      return withLock(() => enrollRetirement(kind, slug, authority));
    },

    verifyRetirementEnrollment({ kind, slug }) {
      assertSlug(slug);
      return withLock(() => verifyExistingRetirementEnrollment(kind, slug));
    },

    sweep() {
      return withLock(() => sweepRetirements());
    },

    create({ slug, ownerTask, branch, base = "HEAD", remote = "origin", generatedRoots = [] }) {
      assertSlug(slug);
      assertOwner(ownerTask);
      assertRemote(remote);
      boundedPrintable(base, 512, "Base revision");
      const roots = normalizeGeneratedRoots(generatedRoots);
      return withLock(() => {
        const reservations = assertSlugAuthorityAvailable(slug, "managed");
        assertNoQuarantineHistoryForSlug(slug);
        const checkoutPath = checkoutPathFor(slug);
        if (registryFiles().some((file) => file.slug === slug)) {
          if (readEntry(slug).state === "retired") {
            fail(
              "checkout-slug-retired",
              `Checkout ${slug} is permanently tombstoned; choose a new slug so its recovery history stays unambiguous.`
            );
          }
          fail("checkout-exists", `Checkout ${slug} exists.`);
        }
        if (reservations.managed.length !== 0) {
          fail("checkout-slug-reserved", `Checkout ${slug} has retained managed lifecycle history.`);
        }
        if (existsSync(checkoutPath)) fail("checkout-exists", `Checkout ${slug} exists.`);
        const selectedBranch = branch ?? `agent/${slug}-${tokenFactory().slice(0, 8)}`;
        if (
          run("git", ["check-ref-format", "--branch", selectedBranch], {
            cwd: paths.root,
            allowFailure: true,
            env: auditGitEnvironment()
          }).status !== 0
        ) {
          fail("invalid-branch", "The managed branch name is invalid.");
        }
        const branchCheck = commonGit(
          run,
          paths,
          repository,
          ["show-ref", "--verify", "--quiet", `refs/heads/${selectedBranch}`],
          { allowFailure: true }
        );
        if (branchCheck.status === 0) fail("branch-exists", `Branch ${selectedBranch} already exists.`);
        if (branchCheck.status !== 1) fail("command-failed", `Git could not inspect branch ${selectedBranch}.`);
        commonGit(run, paths, repository, ["remote", "get-url", remote]);
        const baseCommit = resolveCreateBase(base);
        let entry = writeInitialEntry({
          protocol: ENTRY_PROTOCOL,
          slug,
          generation: 1,
          state: "creating",
          ownerTask,
          revision: 1,
          branch: selectedBranch,
          baseCommit,
          remote,
          generatedRoots: roots,
          repository: { path: repository.commonGitDirectory, identity: repository.identity }
        });
        hooks?.afterRegistryBeforeGit?.(entry);
        commonGit(run, paths, repository, ["worktree", "add", "-b", selectedBranch, checkoutPath, baseCommit]);
        hooks?.afterGitBeforeActive?.(entry);
        entry = reconcileCreating(entry);
        return Object.freeze({ slug, branch: entry.branch, ownerTask, revision: 1, checkoutPath });
      });
    },

    status(slug = undefined) {
      if (slug !== undefined) assertSlug(slug);
      return withLock(() =>
        Object.freeze(
          listEntrySlugs(slug).map((entrySlug) => {
            const current = readEntry(entrySlug);
            if (current.state === "creating") assertNoQuarantineHistoryForSlug(current.slug);
            const entry = reconcileCreating(current);
            const checkoutPath = checkoutPathFor(entry.slug);
            const record = worktreeRecord(checkoutPath);
            const quarantine = readQuarantineOverlay(entry);
            const retirement = retirementOverlay(
              "managed",
              entry.slug,
              entry.state === "retired" ? entry.generation - 1 : entry.generation,
              checkoutPath
            );
            return Object.freeze({
              slug: entry.slug,
              state: entry.state,
              ownerTask: entry.ownerTask,
              revision: entry.revision,
              branch: entry.branch,
              checkoutPath,
              present: existsSync(checkoutPath),
              registered: record !== undefined,
              head: record?.HEAD ?? null,
              cleanupReviewRequired: ["cleanup-pending", "abandoned-review-required"].includes(entry.state),
              quarantine,
              ...(retirement.state === "not-enrolled" ? {} : { retirement })
            });
          })
        )
      );
    },

    audit(slug) {
      assertSlug(slug);
      initializeManager(false);
      for (const [path, identity] of managedIdentities) {
        assertPrivateDirectory(path, path);
        revalidatePathIdentity(path, identity, path, "directory");
      }
      revalidatePathIdentity(repository.commonGitDirectory, repository.identity, "Git common directory", "directory");
      const entry = readEntry(slug);
      return Object.freeze({ ...auditEntry(entry), quarantine: readQuarantineOverlay(entry) });
    },

    quarantineStatus(slug = undefined) {
      if (slug !== undefined) assertSlug(slug);
      initializeManager(false);
      for (const [path, identity] of managedIdentities) {
        assertPrivateDirectory(path, path);
        revalidatePathIdentity(path, identity, path, "directory");
      }
      revalidatePathIdentity(repository.commonGitDirectory, repository.identity, "Git common directory", "directory");
      return Object.freeze(
        listEntrySlugs(slug).map((entrySlug) => {
          const entry = readEntry(entrySlug);
          return Object.freeze({
            slug: entry.slug,
            generation: entry.generation,
            entryState: entry.state,
            quarantine: readQuarantineOverlay(entry)
          });
        })
      );
    },

    handoff({ slug, ownerTask, nextOwnerTask, expectedRevision }) {
      assertSlug(slug);
      assertOwner(nextOwnerTask, "next owner");
      return withLock(() => {
        const current = readEntry(slug);
        assertNoQuarantineHistoryForSlug(slug);
        const entry = reconcileCreating(current);
        assertOwnerRevision(entry, ownerTask, expectedRevision);
        if (entry.state === "creating") fail("checkout-not-active", "An incomplete create cannot be handed off.");
        const next = appendEntry(entry, { ...entry, ownerTask: nextOwnerTask, revision: entry.revision + 1 });
        return Object.freeze({
          slug,
          ownerTask: next.ownerTask,
          revision: next.revision,
          checkoutPath: checkoutPathFor(slug)
        });
      });
    },

    finish({ slug, ownerTask, expectedRevision }) {
      assertSlug(slug);
      return withLock(() => {
        let entry = readEntry(slug);
        assertNoQuarantineHistoryForSlug(slug);
        entry = reconcileCreating(entry);
        assertOwnerRevision(entry, ownerTask, expectedRevision);
        if (entry.state !== "active" && entry.state !== "cleanup-pending") {
          fail("checkout-not-active", "An incomplete create cannot request cleanup.");
        }
        entry = requestCleanup(entry, "finish");
        return Object.freeze({
          status: "cleanup-review-required",
          slug,
          generation: entry.generation,
          audit: auditEntry(entry)
        });
      });
    },

    planRetirement({ slug, ownerTask, expectedRevision, expectedGeneration }) {
      assertSlug(slug);
      assertGeneration(expectedGeneration);
      return withLock(() => {
        const entry = readEntry(slug);
        assertNoQuarantineHistoryForSlug(slug);
        assertOwnerRevision(entry, ownerTask, expectedRevision);
        if (entry.generation !== expectedGeneration) {
          fail("registry-changed", `Managed checkout ${slug} is no longer at the expected generation.`);
        }
        initializeRetirementJournal();
        const retirementJournalIdentity = managedIdentities.get(paths.retirements);
        if (retirementJournalIdentity === undefined) {
          fail("unsafe-manager", "The retirement journal was not initialized.");
        }
        const priorPlans = listRetirementPlans(entry);
        const firstEvidence = captureRetirementEvidence(entry);
        if (isDeepStrictEqual(priorPlans.at(-1)?.value, firstEvidence)) {
          fail(
            "retirement-evidence-exists",
            "Current retirement evidence already exists for this checkout generation."
          );
        }
        if (priorPlans.length >= MAXIMUM_RETIREMENT_PLAN_ATTEMPTS) {
          fail(
            "retirement-evidence-attempts-exhausted",
            "The retirement evidence journal has no remaining attempt slots."
          );
        }
        const attempt = priorPlans.length + 1;
        const destination = retirementPath(slug, entry.generation, attempt);
        hooks?.beforeRetirementEvidenceWrite?.(entry, firstEvidence);
        const secondEvidence = captureRetirementEvidence(entry);
        if (!isDeepStrictEqual(firstEvidence, secondEvidence)) {
          fail("checkout-changed", "The checkout changed while its retirement plan was prepared.");
        }
        hooks?.beforeRetirementEvidencePublish?.(entry, secondEvidence);
        revalidatePathIdentity(paths.retirements, retirementJournalIdentity, paths.retirements, "directory");
        try {
          writeJsonExclusive(destination, secondEvidence, retirementJournalIdentity);
        } catch (error) {
          if (error.code === "EEXIST") {
            fail("retirement-evidence-exists", "Retirement evidence appeared concurrently.");
          }
          throw error;
        }
        revalidatePathIdentity(paths.retirements, retirementJournalIdentity, paths.retirements, "directory");
        const written = readJson(destination, MAXIMUM_ENTRY_BYTES, `Retirement evidence for ${slug}`);
        validateRetirementEvidence(written.value, entry);
        if (
          !isDeepStrictEqual(written.value, secondEvidence) ||
          !isDeepStrictEqual(written.value.source, captureSourceEntryReceipt(entry))
        ) {
          fail("registry-changed", "The retirement evidence or its source changed while it was recorded.");
        }
        revalidatePathIdentity(destination, written.identity, `Retirement evidence for ${slug}`);
        return Object.freeze({
          status: "retirement-evidence-recorded",
          slug,
          ownerTask: entry.ownerTask,
          revision: entry.revision,
          generation: entry.generation,
          attempt,
          checkoutState: entry.state,
          authorizesCleanup: false,
          evidence: written.value
        });
      });
    },

    archiveRetirement({ slug, ownerTask, expectedRevision, expectedGeneration }) {
      assertSlug(slug);
      assertGeneration(expectedGeneration);
      return withLock(() => {
        const entry = readEntry(slug);
        assertNoQuarantineHistoryForSlug(slug);
        assertOwnerRevision(entry, ownerTask, expectedRevision);
        if (entry.generation !== expectedGeneration) {
          fail("registry-changed", `Managed checkout ${slug} is no longer at the expected generation.`);
        }
        if (entry.state !== "cleanup-pending") {
          fail("checkout-not-cleanup-pending", "Only a cleanup-pending checkout can be archived.");
        }
        const plan = readRetirementPlan(entry);
        const firstEligibility = captureRetirementEvidence(entry);
        if (!isDeepStrictEqual(firstEligibility, plan.value)) {
          fail("retirement-evidence-stale", "The checkout no longer matches its retirement evidence.");
        }
        const firstGit = captureRepositoryArchiveState(entry, plan.value.git);
        const storage = archiveFreeSpace(firstGit.objectDiskBytes);
        initializeArchiveJournal();
        const archiveRootIdentity = managedIdentities.get(paths.archives);
        if (archiveRootIdentity === undefined) fail("unsafe-manager", "The archive journal was not initialized.");
        const attempt = createArchiveAttempt(slug, entry.generation, plan);
        const bundle = createBundle(attempt, firstGit.pseudorefs);
        hooks?.afterArchiveBundleWrite?.(entry, attempt, bundle);
        const namedBundle = captureArchiveFile(bundle.path, "Recovery bundle");
        if (
          !isDeepStrictEqual(namedBundle, {
            identity: bundle.identity,
            byteLength: bundle.byteLength,
            sha256: bundle.sha256
          })
        ) {
          fail("archive-changed", "The recovery bundle changed after Git finished.");
        }
        hooks?.beforeArchiveHeaderParse?.(entry, attempt, bundle);
        const header = parseBundleHeader(bundle.path, firstGit.objectFormat);
        const headerHeads = refsReceipt(header.refs);
        if (
          !isDeepStrictEqual(headerHeads, firstGit.bundleHeadsReceipt) ||
          !isDeepStrictEqual(header.refs, firstGit.bundleHeads)
        ) {
          fail("archive-ref-mismatch", "The Git bundle header does not contain the exact repository refs.");
        }
        const verification = requireCommonArchiveCommand(
          ["--no-pager", "bundle", "verify", "-q", bundle.path],
          "Git bundle verification"
        );
        const listHeadsOutput = requireCommonArchiveCommand(
          ["--no-pager", "bundle", "list-heads", bundle.path],
          "Git bundle head inspection"
        ).stdout;
        const listedRefs = parseRefList(listHeadsOutput, firstGit.objectFormat, "Git bundle list-heads", {
          allowHead: true,
          allowWorktreeHeads: true,
          allowArchivePseudorefs: true
        });
        const listedHeads = refsReceipt(listedRefs);
        if (
          !isDeepStrictEqual(listedRefs, firstGit.bundleHeads) ||
          !isDeepStrictEqual(listedHeads, firstGit.bundleHeadsReceipt)
        ) {
          fail("archive-ref-mismatch", "The verified Git bundle does not contain the exact repository refs.");
        }
        hooks?.beforeArchiveRecoveryProof?.(entry, attempt, bundle);
        const recovery = proveBundleRecovery(
          attempt,
          bundle,
          firstGit.bundleHeads,
          firstGit.objectFormat,
          firstGit.fetchHeadObjectIds
        );
        const secondEligibility = captureRetirementEvidence(entry);
        const secondGit = captureRepositoryArchiveState(entry, plan.value.git);
        if (!isDeepStrictEqual(secondEligibility, firstEligibility) || !isDeepStrictEqual(secondGit, firstGit)) {
          fail("checkout-changed", "The checkout or repository refs changed while the bundle was created.");
        }
        revalidateRetirementPlan(plan, entry);
        const confirmedBundle = captureArchiveFile(bundle.path, "Recovery bundle");
        if (!isDeepStrictEqual(confirmedBundle, namedBundle)) {
          fail("archive-changed", "The recovery bundle changed while it was verified.");
        }
        assertArchiveAttemptContents(attempt, ["archive.bundle"], ["verification-template", "verification.git"]);
        const eligibilitySha256 = sha256(JSON.stringify(firstEligibility));
        const receiptValue = {
          protocol: ARCHIVE_RECEIPT_PROTOCOL,
          slug,
          generation: entry.generation,
          attempt: attempt.attempt,
          source: {
            entry: plan.value.source,
            retirementPlan: {
              path: plan.path,
              identity: plan.identity,
              byteLength: plan.byteLength,
              sha256: plan.sha256
            }
          },
          archive: {
            directory: { path: attempt.path, identity: attempt.identity },
            bundle: { path: bundle.path, ...confirmedBundle },
            verification: {
              template: recovery.template,
              repository: recovery.repository
            }
          },
          storage,
          git: {
            repository: { path: repository.commonGitDirectory, identity: repository.identity },
            objectFormat: firstGit.objectFormat,
            shallow: firstGit.shallow,
            branchRef: firstGit.branchRef,
            head: plan.value.git.head,
            headTree: plan.value.git.headTree,
            commonHead: firstGit.commonHead,
            refs: firstGit.refsReceipt,
            linkedHeads: refsReceipt(firstGit.linkedHeads),
            pseudorefs: firstGit.pseudorefsReceipt,
            bundleHeads: firstGit.bundleHeadsReceipt,
            safety: {
              ...firstGit.safety,
              targetFetchHead: firstGit.fetchHead
            }
          },
          verification: {
            header: {
              version: header.version,
              objectFormat: header.objectFormat,
              capabilities: header.capabilities,
              prerequisiteCount: header.prerequisiteCount,
              heads: headerHeads
            },
            bundleVerify: {
              stdoutSha256: sha256(verification.stdout),
              stderrSha256: sha256(verification.stderr)
            },
            listHeads: listedHeads,
            recovery: {
              objectFormat: recovery.objectFormat,
              advertisedHeads: recovery.advertisedHeads,
              resolvedObjects: recovery.resolvedObjects,
              requiredObjects: recovery.requiredObjects,
              rootRefs: recovery.rootRefs,
              unbundle: recovery.unbundle,
              fsck: recovery.fsck
            },
            eligibilitySha256
          },
          deferredChecks: {
            recovery: "bundle-unbundled-and-fsck-verified",
            processUse: "not-checked-recheck-required",
            mounts: "not-checked-recheck-required"
          },
          authorizesCleanup: false
        };
        validateArchiveReceipt(receiptValue, entry, attempt, plan);
        hooks?.beforeArchiveReceiptWrite?.(entry, attempt, receiptValue);
        const receiptPath = join(attempt.path, "receipt.json");
        try {
          writeJsonExclusive(receiptPath, receiptValue, attempt.identity);
        } catch (error) {
          if (error.code === "EEXIST") fail("archive-changed", "The archive receipt appeared concurrently.");
          throw error;
        }
        const receiptFile = captureArchiveFile(receiptPath, "Archive receipt file");
        const writtenReceipt = readJsonReceipt(receiptPath, MAXIMUM_ENTRY_BYTES, "Archive receipt");
        validateArchiveReceipt(writtenReceipt.value, entry, attempt, plan);
        if (!isDeepStrictEqual(writtenReceipt.value, receiptValue)) {
          fail("archive-changed", "The archive receipt changed while it was recorded.");
        }
        assertArchiveAttemptContents(
          attempt,
          ["archive.bundle", "receipt.json"],
          ["verification-template", "verification.git"]
        );
        hooks?.beforeArchiveCompletionWrite?.(entry, attempt, receiptValue);
        const finalEligibility = captureRetirementEvidence(entry);
        const finalGit = captureRepositoryArchiveState(entry, plan.value.git);
        revalidateRetirementPlan(plan, entry);
        if (!isDeepStrictEqual(finalEligibility, firstEligibility) || !isDeepStrictEqual(finalGit, firstGit)) {
          fail("checkout-changed", "The checkout or repository refs changed before archive completion.");
        }
        const finalBundle = captureArchiveFile(bundle.path, "Recovery bundle");
        const finalReceipt = captureArchiveFile(receiptPath, "Archive receipt file");
        const finalVerificationRepository = captureVerificationRepository(
          recovery.repository.path,
          recovery.repository.identity
        );
        revalidatePathIdentity(
          recovery.template.path,
          recovery.template.identity,
          "Verification template",
          "directory"
        );
        if (
          readDirectoryBounded(recovery.template.path, 1, "The verification template").length !== 0 ||
          !isDeepStrictEqual(finalBundle, confirmedBundle) ||
          !isDeepStrictEqual(finalReceipt, receiptFile) ||
          !isDeepStrictEqual(finalVerificationRepository, recovery.repository)
        ) {
          fail("archive-changed", "The archive files changed before completion.");
        }
        const completionVerification = {
          template: recovery.template,
          repository: finalVerificationRepository
        };
        const completionValue = {
          protocol: ARCHIVE_COMPLETION_PROTOCOL,
          slug,
          generation: entry.generation,
          attempt: attempt.attempt,
          directory: { path: attempt.path, identity: attempt.identity },
          bundle: { path: bundle.path, ...finalBundle },
          receipt: { path: receiptPath, ...finalReceipt },
          verification: completionVerification,
          authorizesCleanup: false
        };
        validateCompletion(
          completionValue,
          entry,
          attempt,
          completionValue.bundle,
          completionValue.receipt,
          completionVerification
        );
        const completionPath = join(attempt.path, "complete.json");
        try {
          writeJsonExclusive(completionPath, completionValue, attempt.identity);
        } catch (error) {
          if (error.code === "EEXIST") fail("archive-changed", "The completion marker appeared concurrently.");
          throw error;
        }
        fsyncDirectory(attempt.path);
        fsyncDirectory(paths.archives);
        revalidatePathIdentity(paths.archives, archiveRootIdentity, paths.archives, "directory");
        assertArchiveAttemptContents(
          attempt,
          ["archive.bundle", "receipt.json", "complete.json"],
          ["verification-template", "verification.git"]
        );
        const completed = readJsonReceipt(completionPath, MAXIMUM_ENTRY_BYTES, "Archive completion");
        validateCompletion(
          completed.value,
          entry,
          attempt,
          completionValue.bundle,
          completionValue.receipt,
          completionVerification
        );
        if (!isDeepStrictEqual(completed.value, completionValue)) {
          fail("archive-changed", "The completion marker changed while it was recorded.");
        }
        revalidatePathIdentity(completionPath, completed.identity, "Archive completion");
        const completedBundle = captureArchiveFile(bundle.path, "Recovery bundle");
        const completedReceipt = captureArchiveFile(receiptPath, "Archive receipt file");
        const completedVerificationRepository = captureVerificationRepository(
          recovery.repository.path,
          recovery.repository.identity
        );
        revalidatePathIdentity(
          recovery.template.path,
          recovery.template.identity,
          "Verification template",
          "directory"
        );
        revalidateRetirementPlan(plan, entry);
        if (
          readDirectoryBounded(recovery.template.path, 1, "The verification template").length !== 0 ||
          !isDeepStrictEqual(completedBundle, finalBundle) ||
          !isDeepStrictEqual(completedReceipt, finalReceipt) ||
          !isDeepStrictEqual(completedVerificationRepository, finalVerificationRepository)
        ) {
          fail("archive-changed", "The retained recovery proof changed after completion was recorded.");
        }
        return Object.freeze({
          status: "recovery-archive-recorded",
          slug,
          ownerTask: entry.ownerTask,
          revision: entry.revision,
          generation: entry.generation,
          attempt: attempt.attempt,
          archivePath: bundle.path,
          bundleSha256: bundle.sha256,
          authorizesCleanup: false
        });
      });
    },

    abandon({ slug, expectedOwnerTask, expectedHead, expectedRevision }) {
      assertSlug(slug);
      return withLock(() => {
        let entry = readEntry(slug);
        assertNoQuarantineHistoryForSlug(slug);
        assertOwnerRevision(entry, expectedOwnerTask, expectedRevision);
        if (expectedHead === "absent") {
          entry = requestAbandonedReview(entry);
          return Object.freeze({ status: "abandoned-review-required", slug, audit: auditEntry(entry) });
        }
        if (typeof expectedHead !== "string" || !SHA_PATTERN.test(expectedHead)) {
          fail("invalid-head", "Abandon requires the exact observed head or absent.");
        }
        entry = reconcileCreating(entry);
        const audit = auditEntry(entry);
        if (audit.head !== expectedHead) fail("checkout-changed", "The observed head changed.");
        if (entry.state === "creating") fail("checkout-not-active", "An incomplete create cannot request cleanup.");
        entry = requestCleanup(entry, "abandon");
        return Object.freeze({ status: "cleanup-review-required", slug, audit: auditEntry(entry) });
      });
    }
  });
  return managerApi;
}

function parseRevision(value) {
  const revision = Number(value);
  assertRevision(revision);
  return revision;
}

function parseGeneration(value) {
  const generation = Number(value);
  assertGeneration(generation);
  return generation;
}

function validateCliInvocation(positionals, values) {
  const command = positionals[0];
  const specifications = new Map([
    ["bootstrap", { minimum: 1, maximum: 1, options: [] }],
    ["discover", { minimum: 1, maximum: 1, options: ["root", "max-depth"] }],
    ["task-begin", { minimum: 1, maximum: 1, options: ["root", "max-depth"] }],
    ["task-end", { minimum: 2, maximum: 2, options: ["owner", "revision"] }],
    ["resume", { minimum: 1, maximum: 1, options: ["root", "max-depth"] }],
    ["artifact-audit", { minimum: 2, maximum: 2, options: ["owner", "revision", "path", "root"] }],
    ["artifact-retire", { minimum: 2, maximum: 2, options: ["owner", "revision", "path", "root", "review"] }],
    ["legacy-batch-audit", { minimum: 1, maximum: 1, options: ["manifest"] }],
    ["legacy-batch-adopt", { minimum: 1, maximum: 1, options: ["manifest", "review"] }],
    ["legacy-batch-retire", { minimum: 1, maximum: 1, options: ["manifest", "review"] }],
    [
      "legacy-audit",
      { minimum: 2, maximum: 2, options: ["generated-root", "generated-file", "path", "root", "dependency-root"] }
    ],
    [
      "legacy-adopt",
      {
        minimum: 2,
        maximum: 2,
        options: ["owner", "generated-root", "generated-file", "path", "root", "dependency-root"]
      }
    ],
    ["legacy-archive", { minimum: 2, maximum: 2, options: ["owner", "revision"] }],
    ["legacy-status", { minimum: 1, maximum: 2, options: [] }],
    ["create", { minimum: 2, maximum: 2, options: ["owner", "branch", "base", "remote", "generated-root"] }],
    ["status", { minimum: 1, maximum: 2, options: [] }],
    ["audit", { minimum: 2, maximum: 2, options: [] }],
    ["quarantine-status", { minimum: 1, maximum: 2, options: [] }],
    ["handoff", { minimum: 2, maximum: 2, options: ["owner", "to", "revision"] }],
    ["finish", { minimum: 2, maximum: 2, options: ["owner", "revision"] }],
    ["retire", { minimum: 2, maximum: 2, options: ["owner", "revision"] }],
    ["enroll-retirement", { minimum: 2, maximum: 2, options: ["kind", "owner", "revision"] }],
    ["sweep", { minimum: 1, maximum: 1, options: [] }],
    ["plan-retirement", { minimum: 2, maximum: 2, options: ["owner", "revision", "generation"] }],
    ["archive-retirement", { minimum: 2, maximum: 2, options: ["owner", "revision", "generation"] }],
    ["abandon", { minimum: 2, maximum: 2, options: ["expect-owner", "expect-head", "revision"] }]
  ]);
  const specification = specifications.get(command);
  if (specification === undefined) {
    fail(
      "invalid-cli",
      "Use bootstrap, discover, task-begin, task-end, resume, artifact-audit, artifact-retire, legacy-batch-audit, legacy-batch-adopt, legacy-batch-retire, legacy-audit, legacy-adopt, legacy-archive, legacy-status, create, status, audit, quarantine-status, handoff, finish, retire, enroll-retirement, sweep, plan-retirement, archive-retirement, or abandon."
    );
  }
  const suppliedOptions = Object.entries(values)
    .filter(([, value]) => value !== undefined)
    .map(([name]) => name);
  if (
    positionals.length < specification.minimum ||
    positionals.length > specification.maximum ||
    suppliedOptions.some((name) => !specification.options.includes(name))
  ) {
    fail("invalid-cli", `The ${command} command received an extra, missing, or irrelevant argument.`);
  }
}

export function runCheckoutLifecycleCli(argv = process.argv.slice(2), options = {}) {
  const { positionals, values } = parseArgs({
    args: argv,
    allowPositionals: true,
    strict: true,
    options: {
      owner: { type: "string" },
      to: { type: "string" },
      revision: { type: "string" },
      generation: { type: "string" },
      branch: { type: "string" },
      base: { type: "string" },
      remote: { type: "string" },
      kind: { type: "string" },
      "expect-owner": { type: "string" },
      "expect-head": { type: "string" },
      "generated-root": { type: "string", multiple: true },
      "generated-file": { type: "string", multiple: true },
      "dependency-root": { type: "string", multiple: true },
      root: { type: "string", multiple: true },
      path: { type: "string" },
      manifest: { type: "string" },
      review: { type: "string" },
      "max-depth": { type: "string" }
    }
  });
  validateCliInvocation(positionals, values);
  const [command, slug] = positionals;
  if (
    ["legacy-batch-audit", "legacy-batch-adopt", "legacy-batch-retire"].includes(command) &&
    values.manifest === undefined
  ) {
    fail("invalid-cli", `${command} requires --manifest with one reviewed canonical manifest path.`);
  }
  if (["legacy-batch-adopt", "legacy-batch-retire"].includes(command) && values.review === undefined) {
    fail("invalid-cli", `${command} requires --review with the exact dry-run SHA-256.`);
  }
  if (command === "bootstrap") {
    const result = bootstrapCheckoutManager(options);
    (options.stdout ?? process.stdout).write(`${JSON.stringify(result, null, 2)}\n`);
    return result;
  }
  const manager = createCheckoutManager(options);
  let result;
  const roots = values.root ?? [];
  const maximumDepth = values["max-depth"] === undefined ? undefined : Number(values["max-depth"]);
  const approvedRoot = roots.length === 1 ? roots[0] : undefined;
  if (["legacy-audit", "legacy-adopt", "artifact-audit", "artifact-retire"].includes(command) && roots.length > 1) {
    fail("invalid-cli", "The command accepts exactly one --root value.");
  }
  if (command === "discover") {
    result = manager.discover({ roots, ...(maximumDepth === undefined ? {} : { maxDepth: maximumDepth }) });
  } else if (["task-begin", "resume"].includes(command)) {
    const sweep = manager.sweep();
    const managed = manager.status();
    const legacy = manager.legacyStatus();
    const discovery = manager.discover({ roots, ...(maximumDepth === undefined ? {} : { maxDepth: maximumDepth }) });
    result = Object.freeze({
      status: command,
      sweep,
      active: Object.freeze(managed.filter((item) => item.state === "active")),
      pending: Object.freeze([
        ...managed.filter((item) => !["active", "retired"].includes(item.state)),
        ...legacy.filter((item) => item.retirement?.terminal !== true)
      ]),
      managed,
      legacy,
      discovery
    });
  } else if (command === "artifact-audit") {
    result = manager.artifactAudit({
      slug,
      artifactPath: values.path,
      approvedRoot,
      ownerTask: values.owner,
      ownerRevision: parseRevision(values.revision)
    });
  } else if (command === "artifact-retire") {
    result = manager.artifactRetire({
      slug,
      artifactPath: values.path,
      approvedRoot,
      ownerTask: values.owner,
      ownerRevision: parseRevision(values.revision),
      expectedReviewSha256: values.review
    });
  } else if (command === "legacy-batch-audit") {
    result = manager.legacyBatchAudit({ manifestPath: values.manifest });
  } else if (command === "legacy-batch-adopt") {
    result = manager.legacyBatchAdopt({
      manifestPath: values.manifest,
      expectedReviewSha256: values.review
    });
  } else if (command === "legacy-batch-retire") {
    result = manager.legacyBatchRetire({
      manifestPath: values.manifest,
      expectedReviewSha256: values.review
    });
  } else if (command === "legacy-audit") {
    result = manager.legacyAudit({
      slug,
      generatedRoots: values["generated-root"] ?? [],
      generatedFiles: values["generated-file"] ?? [],
      checkoutPath: values.path,
      approvedRoot,
      dependencyRoots: values["dependency-root"]
    });
  } else if (command === "legacy-adopt") {
    result = manager.legacyAdopt({
      slug,
      ownerTask: values.owner,
      generatedRoots: values["generated-root"] ?? [],
      generatedFiles: values["generated-file"] ?? [],
      checkoutPath: values.path,
      approvedRoot,
      dependencyRoots: values["dependency-root"]
    });
  } else if (command === "legacy-archive") {
    result = manager.legacyArchive({
      slug,
      ownerTask: values.owner,
      expectedRevision: parseRevision(values.revision)
    });
  } else if (command === "legacy-status") result = manager.legacyStatus(slug);
  else if (command === "create") {
    manager.sweep();
    result = manager.create({
      slug,
      ownerTask: values.owner,
      branch: values.branch,
      base: values.base ?? "HEAD",
      remote: values.remote ?? "origin",
      generatedRoots: values["generated-root"] ?? []
    });
  } else if (command === "status") {
    manager.sweep();
    result = manager.status(slug);
  } else if (command === "audit") result = manager.audit(slug);
  else if (command === "quarantine-status") result = manager.quarantineStatus(slug);
  else if (command === "handoff") {
    result = manager.handoff({
      slug,
      ownerTask: values.owner,
      nextOwnerTask: values.to,
      expectedRevision: parseRevision(values.revision)
    });
  } else if (command === "finish") {
    result = manager.finish({ slug, ownerTask: values.owner, expectedRevision: parseRevision(values.revision) });
  } else if (["retire", "task-end"].includes(command)) {
    manager.sweep();
    const initial = manager.status(slug)[0];
    if (initial.state === "retired") {
      result = Object.freeze({ status: "already-retired", slug, retirement: initial.retirement });
    } else if (initial.retirement !== undefined) {
      result = manager.verifyRetirementEnrollment({ kind: "managed", slug });
    } else {
      const finished = manager.finish({
        slug,
        ownerTask: values.owner,
        expectedRevision: parseRevision(values.revision)
      });
      try {
        manager.planRetirement({
          slug,
          ownerTask: values.owner,
          expectedRevision: parseRevision(values.revision),
          expectedGeneration: finished.generation
        });
      } catch (error) {
        if (!(error instanceof CheckoutLifecycleError) || error.code !== "retirement-evidence-exists") throw error;
      }
      let enrollment;
      try {
        enrollment = manager.enrollRetirement({ kind: "managed", slug });
      } catch (error) {
        if (error instanceof CheckoutLifecycleError && error.code === "retirement-already-enrolled") {
          enrollment = manager.verifyRetirementEnrollment({ kind: "managed", slug });
        } else if (
          error instanceof CheckoutLifecycleError &&
          ["retirement-archive-missing", "retirement-archive-stale"].includes(error.code)
        ) {
          manager.archiveRetirement({
            slug,
            ownerTask: values.owner,
            expectedRevision: parseRevision(values.revision),
            expectedGeneration: finished.generation
          });
          enrollment = manager.enrollRetirement({ kind: "managed", slug });
        } else throw error;
      }
      result = Object.freeze({ status: "retirement-enrolled", slug, finished, enrollment });
    }
  } else if (command === "enroll-retirement") {
    result = manager.enrollRetirement({
      kind: values.kind,
      slug,
      ...(values.kind === "legacy" ? { ownerTask: values.owner, expectedRevision: parseRevision(values.revision) } : {})
    });
  } else if (command === "sweep") {
    result = manager.sweep();
  } else if (command === "plan-retirement") {
    result = manager.planRetirement({
      slug,
      ownerTask: values.owner,
      expectedRevision: parseRevision(values.revision),
      expectedGeneration: parseGeneration(values.generation)
    });
  } else if (command === "archive-retirement") {
    result = manager.archiveRetirement({
      slug,
      ownerTask: values.owner,
      expectedRevision: parseRevision(values.revision),
      expectedGeneration: parseGeneration(values.generation)
    });
  } else if (command === "abandon") {
    result = manager.abandon({
      slug,
      expectedOwnerTask: values["expect-owner"],
      expectedHead: values["expect-head"],
      expectedRevision: parseRevision(values.revision)
    });
  } else {
    fail("invalid-cli", "The lifecycle command was not dispatched.");
  }
  (options.stdout ?? process.stdout).write(`${JSON.stringify(result, null, 2)}\n`);
  return result;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    runCheckoutLifecycleCli();
  } catch (error) {
    process.stderr.write(
      `${error instanceof CheckoutLifecycleError ? error.code : "unexpected-error"}: ${error.message}\n`
    );
    process.exitCode = 1;
  }
}
