import { createHash, randomBytes } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  openSync,
  readFileSync,
  readdirSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
import { basename, dirname, resolve } from "node:path";

const SHA256 = /^[0-9a-f]{64}$/u;
const TEMP_TOKEN = /^[0-9a-f]{32}$/u;
const MAXIMUM_TARGET_NAME_BYTES = 180;
const DEFAULT_MAXIMUM_JSON_BYTES = 32 * 1024 * 1024;
const FAULT_INJECTION = Symbol("durable-study-json-fault-injection");

export const DURABLE_JSON_PUBLICATION_FAULT_POINTS = Object.freeze([
  "temporary-opened",
  "temporary-written",
  "temporary-file-synced",
  "temporary-closed",
  "target-linked",
  "link-directory-synced",
  "temporary-unlinked",
  "unlink-directory-synced",
  "target-validated"
]);

export const DURABLE_JSON_RECOVERY_FAULT_POINTS = Object.freeze([
  "recovery-target-validated",
  "recovery-link-directory-synced",
  "recovery-temporary-unlinked",
  "recovery-unlink-directory-synced",
  "recovery-complete-directory-synced",
  "recovery-target-validated-final"
]);

export class DurableStudyJsonError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "DurableStudyJsonError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new DurableStudyJsonError(code, message);
}

function isPlainRecord(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function canonicalizeJsonValue(value, ancestors, label) {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      fail("invalid-json", `${label} contains a non-finite number.`);
    }
    return Object.is(value, -0) ? 0 : value;
  }
  if (Array.isArray(value)) {
    if (ancestors.has(value)) {
      fail("invalid-json", `${label} contains a cycle.`);
    }
    const ownKeys = Reflect.ownKeys(value);
    const keys = ownKeys.filter((key) => key !== "length");
    if (
      Object.getPrototypeOf(value) !== Array.prototype ||
      keys.some((key) => typeof key !== "string") ||
      keys.length !== value.length ||
      !keys.every((key, index) => key === String(index)) ||
      keys.some((key) => {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        return descriptor?.get !== undefined || descriptor?.set !== undefined;
      })
    ) {
      fail("invalid-json", `${label} contains a sparse array or extra array property.`);
    }
    ancestors.add(value);
    try {
      return Array.prototype.map.call(value, (item, index) =>
        canonicalizeJsonValue(item, ancestors, `${label}[${index}]`)
      );
    } finally {
      ancestors.delete(value);
    }
  }
  if (!isPlainRecord(value)) {
    fail("invalid-json", `${label} contains a non-JSON value.`);
  }
  if (ancestors.has(value)) {
    fail("invalid-json", `${label} contains a cycle.`);
  }
  const symbols = Object.getOwnPropertySymbols(value);
  if (symbols.length !== 0) {
    fail("invalid-json", `${label} contains a symbol-keyed field.`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (!descriptor.enumerable || descriptor.get !== undefined || descriptor.set !== undefined) {
      fail("invalid-json", `${label}.${key} is not one enumerable data field.`);
    }
  }
  ancestors.add(value);
  try {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalizeJsonValue(value[key], ancestors, `${label}.${key}`)])
    );
  } finally {
    ancestors.delete(value);
  }
}

export function canonicalDurableJson(value) {
  return `${JSON.stringify(canonicalizeJsonValue(value, new Set(), "JSON value"), null, 2)}\n`;
}

export function digestDurableJsonValue(value) {
  return createHash("sha256").update(canonicalDurableJson(value), "utf8").digest("hex");
}

function assertLinux(platform) {
  if (platform !== "linux") {
    fail("unsupported-platform", "Durable append-only study JSON publication requires Linux.");
  }
}

function assertMaximumBytes(maximumBytes) {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1 || maximumBytes > 64 * 1024 * 1024) {
    fail("invalid-bound", "The durable JSON byte bound must be between one byte and 64 MiB.");
  }
}

function assertTargetName(name) {
  if (
    name.length === 0 ||
    name === "." ||
    name === ".." ||
    Buffer.byteLength(name, "utf8") > MAXIMUM_TARGET_NAME_BYTES ||
    /[\0/\\\r\n]/u.test(name)
  ) {
    fail("invalid-target", "The durable JSON target name is invalid or exceeds its bound.");
  }
}

function sameIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function identityReceipt(metadata) {
  return Object.freeze({ device: metadata.dev.toString(), inode: metadata.ino.toString() });
}

function currentUserOwns(metadata) {
  return typeof process.getuid !== "function" || metadata.uid === BigInt(process.getuid());
}

function assertOwnedPrivateDirectory(metadata, label) {
  if (
    !metadata.isDirectory() ||
    metadata.isSymbolicLink() ||
    !currentUserOwns(metadata) ||
    (metadata.mode & 0o777n) !== 0o700n
  ) {
    fail("invalid-directory", `${label} must be one owned mode-0700 directory.`);
  }
}

function assertOwnedPrivateRegularFile(metadata, expectedLinks, label) {
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.nlink !== BigInt(expectedLinks) ||
    !currentUserOwns(metadata) ||
    (metadata.mode & 0o777n) !== 0o600n
  ) {
    fail("invalid-artifact", `${label} is not one private, owned regular file with the expected link count.`);
  }
}

function anchoredPath(directoryDescriptor, name = "") {
  return name.length === 0 ? `/proc/self/fd/${directoryDescriptor}` : `/proc/self/fd/${directoryDescriptor}/${name}`;
}

function openOwnedDirectory(path) {
  const before = lstatSync(path, { bigint: true });
  assertOwnedPrivateDirectory(before, "The durable JSON parent");
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    const opened = fstatSync(descriptor, { bigint: true });
    if (!sameIdentity(before, opened)) {
      fail("directory-rebound", "The durable JSON parent identity changed while it opened.");
    }
    assertOwnedPrivateDirectory(opened, "The opened durable JSON parent");
    return { descriptor, identity: opened };
  } catch (error) {
    const closeErrors = [];
    closeDescriptor(descriptor, closeErrors);
    if (closeErrors.length === 0) {
      throw error;
    }
    throw new AggregateError(
      [error, ...closeErrors],
      "The durable JSON parent failed validation and its descriptor did not close cleanly."
    );
  }
}

function lstatIfPresent(path) {
  try {
    return lstatSync(path, { bigint: true });
  } catch (error) {
    if (error?.code === "ENOENT") {
      return undefined;
    }
    fail("filesystem-read", "Could not inspect a durable JSON directory entry.");
  }
}

function closeDescriptor(descriptor, errors) {
  if (descriptor === undefined) {
    return;
  }
  try {
    closeSync(descriptor);
  } catch (error) {
    errors.push(error);
  }
}

function invokeFaultInjector(faultInjector, point) {
  if (faultInjector === undefined) {
    return;
  }
  if (typeof faultInjector !== "function") {
    fail("invalid-fault-injector", "The durable JSON fault injector must be a function.");
  }
  try {
    faultInjector(point);
  } catch (error) {
    const injected = error instanceof Error ? error : new Error("Injected durable JSON publication fault.");
    Object.defineProperty(injected, FAULT_INJECTION, { value: true });
    throw injected;
  }
}

function wasInjectedFault(error) {
  return error instanceof Error && error[FAULT_INJECTION] === true;
}

function escapeRegularExpression(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function temporaryName(targetName, token) {
  if (typeof token !== "string" || !TEMP_TOKEN.test(token)) {
    fail("invalid-token", "The durable JSON temporary token must be 32 lowercase hexadecimal characters.");
  }
  const name = `.${targetName}.ow-study-publish-${token}.tmp`;
  if (Buffer.byteLength(name, "utf8") > 255) {
    fail("invalid-target", "The durable JSON temporary name exceeds the Linux directory-entry bound.");
  }
  return name;
}

function temporaryPattern(targetName) {
  return new RegExp(`^\\.${escapeRegularExpression(targetName)}\\.ow-study-publish-[0-9a-f]{32}\\.tmp$`, "u");
}

function verifyDirectoryIdentity(directoryDescriptor, expected) {
  const current = fstatSync(directoryDescriptor, { bigint: true });
  if (!sameIdentity(current, expected)) {
    fail("directory-rebound", "The durable JSON parent identity changed during publication.");
  }
  assertOwnedPrivateDirectory(current, "The durable JSON parent");
}

function verifyFileBytes(path, expectedSha256, maximumBytes, expectedIdentity, expectedLinks) {
  let descriptor;
  let operationError;
  let result;
  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const before = fstatSync(descriptor, { bigint: true });
    assertOwnedPrivateRegularFile(before, expectedLinks, "The durable JSON artifact");
    if (expectedIdentity !== undefined && !sameIdentity(before, expectedIdentity)) {
      fail("identity-changed", "The durable JSON artifact identity changed.");
    }
    if (before.size < 1n || before.size > BigInt(maximumBytes)) {
      fail("invalid-artifact", "The durable JSON artifact size is missing or exceeds its bound.");
    }
    const bytes = readFileSync(descriptor);
    const after = fstatSync(descriptor, { bigint: true });
    if (!sameIdentity(before, after) || before.size !== after.size || before.mtimeNs !== after.mtimeNs) {
      fail("identity-changed", "The durable JSON artifact changed while it was verified.");
    }
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    if (sha256 !== expectedSha256) {
      fail("digest-mismatch", "The durable JSON artifact does not match its expected digest.");
    }
    const entry = lstatSync(path, { bigint: true });
    assertOwnedPrivateRegularFile(entry, expectedLinks, "The durable JSON artifact directory entry");
    if (
      !sameIdentity(after, entry) ||
      after.size !== entry.size ||
      after.mtimeNs !== entry.mtimeNs ||
      after.ctimeNs !== entry.ctimeNs
    ) {
      fail("identity-changed", "The durable JSON artifact directory entry changed while it was verified.");
    }
    result = { bytes: bytes.length, metadata: after, sha256 };
  } catch (error) {
    operationError =
      error instanceof DurableStudyJsonError
        ? error
        : new DurableStudyJsonError("filesystem-read", "Could not read the durable JSON artifact safely.");
  }
  const closeErrors = [];
  closeDescriptor(descriptor, closeErrors);
  if (operationError !== undefined || closeErrors.length !== 0) {
    if (operationError !== undefined && closeErrors.length === 0) {
      throw operationError;
    }
    throw new AggregateError(
      operationError === undefined ? closeErrors : [operationError, ...closeErrors],
      "Durable JSON verification failed and its descriptor did not close cleanly."
    );
  }
  return result;
}

function cleanOwnedPrelinkTemporary({ directoryDescriptor, directoryIdentity, name, identity }) {
  const path = anchoredPath(directoryDescriptor, name);
  const current = lstatIfPresent(path);
  if (current === undefined) {
    return;
  }
  assertOwnedPrivateRegularFile(current, 1, "The durable JSON temporary");
  if (!sameIdentity(current, identity)) {
    fail("ambiguous-temporary", "The durable JSON temporary identity changed before cleanup.");
  }
  verifyDirectoryIdentity(directoryDescriptor, directoryIdentity);
  unlinkSync(path);
  fsyncSync(directoryDescriptor);
}

function publicationContext(targetPath, platform) {
  assertLinux(platform);
  if (typeof targetPath !== "string" || targetPath.length === 0 || targetPath.includes("\0")) {
    fail("invalid-target", "The durable JSON target path is invalid.");
  }
  const target = resolve(targetPath);
  const targetName = basename(target);
  assertTargetName(targetName);
  const directory = openOwnedDirectory(dirname(target));
  return {
    ...directory,
    targetName,
    targetPath: anchoredPath(directory.descriptor, targetName)
  };
}

export function publishDurableStudyJsonExclusive(
  targetPath,
  value,
  {
    faultInjector,
    maximumBytes = DEFAULT_MAXIMUM_JSON_BYTES,
    platform = process.platform,
    tokenFactory = () => randomBytes(16).toString("hex")
  } = {}
) {
  assertMaximumBytes(maximumBytes);
  const text = canonicalDurableJson(value);
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length < 1 || bytes.length > maximumBytes) {
    fail("invalid-json-size", "The canonical durable JSON payload is missing or exceeds its byte bound.");
  }
  const expectedSha256 = createHash("sha256").update(bytes).digest("hex");
  const context = publicationContext(targetPath, platform);
  let temporaryDescriptor;
  let temporaryIdentity;
  let temporaryEntry;
  let targetLinked = false;
  let operationError;
  let result;
  try {
    if (lstatIfPresent(context.targetPath) !== undefined) {
      fail("target-exists", "The append-only durable JSON target already exists.");
    }
    temporaryEntry = temporaryName(context.targetName, tokenFactory());
    const temporaryPath = anchoredPath(context.descriptor, temporaryEntry);
    temporaryDescriptor = openSync(
      temporaryPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600
    );
    temporaryIdentity = fstatSync(temporaryDescriptor, { bigint: true });
    assertOwnedPrivateRegularFile(temporaryIdentity, 1, "The durable JSON temporary");
    invokeFaultInjector(faultInjector, "temporary-opened");

    writeFileSync(temporaryDescriptor, bytes);
    const written = fstatSync(temporaryDescriptor, { bigint: true });
    if (!sameIdentity(written, temporaryIdentity) || written.size !== BigInt(bytes.length)) {
      fail("identity-changed", "The durable JSON temporary changed while it was written.");
    }
    invokeFaultInjector(faultInjector, "temporary-written");

    fsyncSync(temporaryDescriptor);
    invokeFaultInjector(faultInjector, "temporary-file-synced");
    closeSync(temporaryDescriptor);
    temporaryDescriptor = undefined;
    invokeFaultInjector(faultInjector, "temporary-closed");

    verifyDirectoryIdentity(context.descriptor, context.identity);
    if (lstatIfPresent(context.targetPath) !== undefined) {
      fail("target-exists", "The append-only durable JSON target appeared before publication.");
    }
    linkSync(temporaryPath, context.targetPath);
    targetLinked = true;
    const linkedTemporary = lstatSync(temporaryPath, { bigint: true });
    const linkedTarget = lstatSync(context.targetPath, { bigint: true });
    assertOwnedPrivateRegularFile(linkedTemporary, 2, "The linked durable JSON temporary");
    assertOwnedPrivateRegularFile(linkedTarget, 2, "The linked durable JSON target");
    if (!sameIdentity(linkedTemporary, temporaryIdentity) || !sameIdentity(linkedTarget, temporaryIdentity)) {
      fail("identity-changed", "The durable JSON hard-link publication changed identity.");
    }
    invokeFaultInjector(faultInjector, "target-linked");

    fsyncSync(context.descriptor);
    invokeFaultInjector(faultInjector, "link-directory-synced");
    unlinkSync(temporaryPath);
    invokeFaultInjector(faultInjector, "temporary-unlinked");
    fsyncSync(context.descriptor);
    invokeFaultInjector(faultInjector, "unlink-directory-synced");

    const verified = verifyFileBytes(context.targetPath, expectedSha256, maximumBytes, temporaryIdentity, 1);
    verifyDirectoryIdentity(context.descriptor, context.identity);
    invokeFaultInjector(faultInjector, "target-validated");
    result = Object.freeze({
      protocol: "openwrangler-durable-study-json-publication-v1",
      status: "published",
      sha256: verified.sha256,
      bytes: verified.bytes,
      identity: identityReceipt(verified.metadata)
    });
  } catch (error) {
    operationError = error;
  }
  const closeErrors = [];
  closeDescriptor(temporaryDescriptor, closeErrors);
  if (
    operationError !== undefined &&
    !wasInjectedFault(operationError) &&
    !targetLinked &&
    temporaryEntry !== undefined &&
    temporaryIdentity !== undefined
  ) {
    try {
      cleanOwnedPrelinkTemporary({
        directoryDescriptor: context.descriptor,
        directoryIdentity: context.identity,
        name: temporaryEntry,
        identity: temporaryIdentity
      });
    } catch (error) {
      closeErrors.push(error);
    }
  }
  closeDescriptor(context.descriptor, closeErrors);
  if (operationError !== undefined || closeErrors.length !== 0) {
    if (operationError !== undefined && closeErrors.length === 0) {
      throw operationError;
    }
    throw new AggregateError(
      operationError === undefined ? closeErrors : [operationError, ...closeErrors],
      "Durable JSON publication failed and its exact cleanup did not fully settle."
    );
  }
  return result;
}

export function recoverDurableStudyJsonPublication(
  targetPath,
  expectedSha256,
  { faultInjector, maximumBytes = DEFAULT_MAXIMUM_JSON_BYTES, platform = process.platform } = {}
) {
  assertMaximumBytes(maximumBytes);
  if (typeof expectedSha256 !== "string" || !SHA256.test(expectedSha256)) {
    fail("invalid-digest", "Durable JSON recovery requires one lowercase SHA-256 digest.");
  }
  const context = publicationContext(targetPath, platform);
  let operationError;
  let result;
  try {
    const targetMetadata = lstatIfPresent(context.targetPath);
    if (targetMetadata === undefined) {
      result = Object.freeze({
        protocol: "openwrangler-durable-study-json-recovery-v1",
        status: "absent",
        recovered: false
      });
    } else if (targetMetadata.nlink !== 1n && targetMetadata.nlink !== 2n) {
      fail("ambiguous-target", "The durable JSON target has an ambiguous link count.");
    } else {
      verifyFileBytes(context.targetPath, expectedSha256, maximumBytes, targetMetadata, Number(targetMetadata.nlink));
      if (targetMetadata.nlink === 1n) {
        verifyDirectoryIdentity(context.descriptor, context.identity);
        fsyncSync(context.descriptor);
        invokeFaultInjector(faultInjector, "recovery-complete-directory-synced");
        const completed = verifyFileBytes(context.targetPath, expectedSha256, maximumBytes, targetMetadata, 1);
        verifyDirectoryIdentity(context.descriptor, context.identity);
        invokeFaultInjector(faultInjector, "recovery-target-validated-final");
        result = Object.freeze({
          protocol: "openwrangler-durable-study-json-recovery-v1",
          status: "complete",
          recovered: false,
          sha256: completed.sha256,
          bytes: completed.bytes,
          identity: identityReceipt(completed.metadata)
        });
      } else {
        invokeFaultInjector(faultInjector, "recovery-target-validated");

        const names = readdirSync(anchoredPath(context.descriptor), { encoding: "utf8" });
        if (!Array.isArray(names) || names.length > 131_072) {
          fail("ambiguous-directory", "The durable JSON directory listing is malformed or exceeds its bound.");
        }
        const pattern = temporaryPattern(context.targetName);
        const matching = [];
        for (const name of names) {
          if (typeof name !== "string" || Buffer.byteLength(name, "utf8") > 255 || !pattern.test(name)) {
            continue;
          }
          const metadata = lstatIfPresent(anchoredPath(context.descriptor, name));
          if (metadata !== undefined && sameIdentity(metadata, targetMetadata)) {
            matching.push({ metadata, name });
          }
        }
        if (matching.length !== 1) {
          fail("ambiguous-temporary", "The durable JSON target has no unique exact crash-recovery temporary.");
        }
        const [temporary] = matching;
        assertOwnedPrivateRegularFile(temporary.metadata, 2, "The recoverable durable JSON temporary");
        if (!sameIdentity(temporary.metadata, targetMetadata)) {
          fail("ambiguous-temporary", "The durable JSON recovery temporary does not match the target inode.");
        }

        verifyDirectoryIdentity(context.descriptor, context.identity);
        fsyncSync(context.descriptor);
        invokeFaultInjector(faultInjector, "recovery-link-directory-synced");
        unlinkSync(anchoredPath(context.descriptor, temporary.name));
        invokeFaultInjector(faultInjector, "recovery-temporary-unlinked");
        fsyncSync(context.descriptor);
        invokeFaultInjector(faultInjector, "recovery-unlink-directory-synced");

        const recovered = verifyFileBytes(context.targetPath, expectedSha256, maximumBytes, targetMetadata, 1);
        verifyDirectoryIdentity(context.descriptor, context.identity);
        invokeFaultInjector(faultInjector, "recovery-target-validated-final");
        result = Object.freeze({
          protocol: "openwrangler-durable-study-json-recovery-v1",
          status: "recovered",
          recovered: true,
          sha256: recovered.sha256,
          bytes: recovered.bytes,
          identity: identityReceipt(recovered.metadata)
        });
      }
    }
  } catch (error) {
    operationError = error;
  }
  const closeErrors = [];
  closeDescriptor(context.descriptor, closeErrors);
  if (operationError !== undefined || closeErrors.length !== 0) {
    if (operationError !== undefined && closeErrors.length === 0) {
      throw operationError;
    }
    throw new AggregateError(
      operationError === undefined ? closeErrors : [operationError, ...closeErrors],
      "Durable JSON recovery failed and its owned descriptor did not close cleanly."
    );
  }
  return result;
}
