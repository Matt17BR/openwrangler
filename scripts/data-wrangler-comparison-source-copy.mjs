import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
  unlinkSync,
  writeSync
} from "node:fs";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { createDataWranglerComparisonCleanupUnsettledError } from "./data-wrangler-comparison-cleanup-safety.mjs";

export const DATA_WRANGLER_COMPARISON_SOURCE_COPY_PROTOCOL = "openwrangler-data-wrangler-comparison-source-copy-v1";

const COPY_MODE = 0o600;
const MAXIMUM_SOURCE_BYTES = 4 * 1024 * 1024 * 1024;
const COPY_BLOCK_BYTES = 1024 * 1024;
const leases = new WeakMap();

function fail(message, cause) {
  throw new Error(message, cause === undefined ? undefined : { cause });
}

function absolutePath(value, label) {
  if (typeof value !== "string" || !isAbsolute(value) || resolve(value) !== value || /[\0\r\n]/u.test(value)) {
    fail(`${label} must be one canonical absolute single-line path.`);
  }
  return value;
}

function copyName(value) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 128 ||
    basename(value) !== value ||
    value === "." ||
    value === ".." ||
    /[\0\r\n/\\]/u.test(value)
  ) {
    fail("The comparison source-copy name must be one bounded path-free file name.");
  }
  return value;
}

function boundedMaximumBytes(value) {
  if (!Number.isSafeInteger(value) || value <= 0 || value > MAXIMUM_SOURCE_BYTES) {
    fail("The comparison source-copy byte bound is invalid.");
  }
  return value;
}

function fileSnapshot(metadata) {
  return Object.freeze({
    dev: metadata.dev,
    ino: metadata.ino,
    mode: metadata.mode,
    nlink: metadata.nlink,
    uid: metadata.uid,
    gid: metadata.gid,
    size: metadata.size,
    mtimeNs: metadata.mtimeNs,
    ctimeNs: metadata.ctimeNs
  });
}

function sameFileSnapshot(left, right) {
  return (
    left !== undefined &&
    right !== undefined &&
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.nlink === right.nlink &&
    left.uid === right.uid &&
    left.gid === right.gid &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

function sameFileIdentity(left, right) {
  return left !== undefined && right !== undefined && left.dev === right.dev && left.ino === right.ino;
}

function rootSnapshot(metadata) {
  return Object.freeze({
    dev: metadata.dev,
    ino: metadata.ino,
    mode: metadata.mode,
    uid: metadata.uid,
    gid: metadata.gid
  });
}

function sameRootSnapshot(left, right) {
  return (
    left !== undefined &&
    right !== undefined &&
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.uid === right.uid &&
    left.gid === right.gid
  );
}

function requireCurrentUser(metadata, label) {
  if (typeof process.getuid === "function" && metadata.uid !== BigInt(process.getuid())) {
    fail(`${label} must belong to the current user.`);
  }
}

function requirePrivateRoot(metadata) {
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || (metadata.mode & 0o777n) !== 0o700n) {
    fail("The comparison source-copy root must be one mode-0700 real directory.");
  }
  requireCurrentUser(metadata, "The comparison source-copy root");
}

function requireSourceFile(metadata, maximumBytes, label) {
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.nlink !== 1n ||
    metadata.size <= 0n ||
    metadata.size > BigInt(maximumBytes)
  ) {
    fail(`${label} must be one bounded, non-empty, single-link regular file.`);
  }
  requireCurrentUser(metadata, label);
}

function requirePrivateCopy(metadata, maximumBytes, { allowEmpty = false } = {}) {
  if (allowEmpty) {
    if (
      !metadata.isFile() ||
      metadata.isSymbolicLink() ||
      metadata.nlink !== 1n ||
      metadata.size < 0n ||
      metadata.size > BigInt(maximumBytes)
    ) {
      fail("The private comparison source copy must be one bounded, single-link regular file.");
    }
    requireCurrentUser(metadata, "The private comparison source copy");
  } else {
    requireSourceFile(metadata, maximumBytes, "The private comparison source copy");
  }
  if ((metadata.mode & 0o777n) !== 0o600n) {
    fail("The private comparison source copy must retain mode 0600.");
  }
}

function publicIdentity(snapshot) {
  return Object.freeze({
    device: snapshot.dev.toString(),
    inode: snapshot.ino.toString(),
    sizeBytes: Number(snapshot.size),
    mtimeNs: snapshot.mtimeNs.toString()
  });
}

function publicReceipt(snapshot, sha256) {
  return Object.freeze({
    sha256,
    filesystemIdentity: publicIdentity(snapshot)
  });
}

function hashDescriptor(descriptor, expectedSize, maximumBytes) {
  const digest = createHash("sha256");
  const buffer = Buffer.allocUnsafe(Math.min(COPY_BLOCK_BYTES, maximumBytes));
  let position = 0;
  while (position < expectedSize) {
    const length = Math.min(buffer.length, expectedSize - position);
    const count = readSync(descriptor, buffer, 0, length, position);
    if (!Number.isSafeInteger(count) || count <= 0 || count > length) {
      fail("The comparison source-copy receipt ended before its pinned byte size.");
    }
    digest.update(buffer.subarray(0, count));
    position += count;
  }
  const extra = readSync(descriptor, buffer, 0, 1, position);
  if (extra !== 0) {
    fail("The comparison source-copy receipt exceeded its pinned byte size.");
  }
  return digest.digest("hex");
}

function writeAll(descriptor, buffer, position, length) {
  let written = 0;
  while (written < length) {
    const count = writeSync(descriptor, buffer, written, length - written, position + written);
    if (!Number.isSafeInteger(count) || count <= 0 || count > length - written) {
      fail("The private comparison source copy could not be written completely.");
    }
    written += count;
  }
}

function assertRootState(state) {
  const opened = fstatSync(state.rootDescriptor, { bigint: true });
  const named = lstatSync(state.privateRoot, { bigint: true });
  requirePrivateRoot(opened);
  requirePrivateRoot(named);
  if (
    !sameRootSnapshot(state.rootSnapshot, rootSnapshot(opened)) ||
    !sameRootSnapshot(state.rootSnapshot, rootSnapshot(named))
  ) {
    fail("The private comparison source-copy root changed identity.");
  }
}

function assertCanonicalState(state) {
  let descriptor;
  try {
    descriptor = openSync(
      state.canonicalPath,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0)
    );
    const opened = fstatSync(descriptor, { bigint: true });
    const namedBefore = lstatSync(state.canonicalPath, { bigint: true });
    requireSourceFile(opened, state.maximumBytes, "The canonical comparison source");
    requireSourceFile(namedBefore, state.maximumBytes, "The canonical comparison source");
    if (
      !sameFileSnapshot(state.canonicalSnapshot, fileSnapshot(opened)) ||
      !sameFileSnapshot(state.canonicalSnapshot, fileSnapshot(namedBefore))
    ) {
      fail("The canonical comparison source changed identity.");
    }
    const sha256 = hashDescriptor(descriptor, Number(opened.size), state.maximumBytes);
    const completed = fstatSync(descriptor, { bigint: true });
    const namedAfter = lstatSync(state.canonicalPath, { bigint: true });
    if (
      sha256 !== state.canonicalReceipt.sha256 ||
      !sameFileSnapshot(state.canonicalSnapshot, fileSnapshot(completed)) ||
      !sameFileSnapshot(state.canonicalSnapshot, fileSnapshot(namedAfter))
    ) {
      fail("The canonical comparison source changed after its receipt was pinned.");
    }
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function assertCopyState(state, { hash = false } = {}) {
  const opened = fstatSync(state.copyDescriptor, { bigint: true });
  const named = lstatSync(state.copyPath, { bigint: true });
  requirePrivateCopy(opened, state.maximumBytes);
  requirePrivateCopy(named, state.maximumBytes);
  if (
    !sameFileSnapshot(state.copySnapshot, fileSnapshot(opened)) ||
    !sameFileSnapshot(state.copySnapshot, fileSnapshot(named))
  ) {
    fail("The private comparison source copy changed identity.");
  }
  if (hash) {
    const sha256 = hashDescriptor(state.copyDescriptor, Number(opened.size), state.maximumBytes);
    const completed = fstatSync(state.copyDescriptor, { bigint: true });
    const namedAfter = lstatSync(state.copyPath, { bigint: true });
    if (
      sha256 !== state.copyReceipt.sha256 ||
      !sameFileSnapshot(state.copySnapshot, fileSnapshot(completed)) ||
      !sameFileSnapshot(state.copySnapshot, fileSnapshot(namedAfter))
    ) {
      fail("The private comparison source copy changed after its receipt was pinned.");
    }
  }
}

function closeStateDescriptors(state, errors) {
  for (const key of ["copyDescriptor", "rootDescriptor"]) {
    if (state[key] === undefined) continue;
    try {
      closeSync(state[key]);
    } catch (error) {
      errors.push(error);
    }
    state[key] = undefined;
  }
}

function anchoredCopyPath(rootDescriptor, name) {
  if (process.platform !== "linux") {
    fail("The descriptor-anchored comparison source-copy contract currently requires Linux.");
  }
  return `/proc/self/fd/${rootDescriptor}/${name}`;
}

function pathIsInside(parent, candidate) {
  const difference = relative(parent, candidate);
  return (
    difference === "" ||
    (!difference.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) && difference !== "..")
  );
}

function assertRollbackIdentities({
  rootDescriptor,
  rootPath,
  sourcePath,
  targetPath,
  rootState,
  canonicalSnapshot,
  copySnapshot
}) {
  const rootOpened = fstatSync(rootDescriptor, { bigint: true });
  const rootNamed = lstatSync(rootPath, { bigint: true });
  const canonicalNamed = lstatSync(sourcePath, { bigint: true });
  const targetNamed = lstatSync(targetPath, { bigint: true });
  const targetSnapshot = fileSnapshot(targetNamed);
  if (
    rootState === undefined ||
    canonicalSnapshot === undefined ||
    !sameRootSnapshot(rootState, rootSnapshot(rootOpened)) ||
    !sameRootSnapshot(rootState, rootSnapshot(rootNamed)) ||
    !sameFileSnapshot(canonicalSnapshot, fileSnapshot(canonicalNamed)) ||
    !sameFileSnapshot(copySnapshot, targetSnapshot) ||
    sameFileIdentity(canonicalSnapshot, targetSnapshot)
  ) {
    fail("An incomplete comparison source copy could not be identified safely for cleanup.");
  }
}

/**
 * Copy one canonical fixture into a current-user-owned private root.
 *
 * The returned object is an opaque in-process cleanup lease. Durable study
 * evidence should retain only its canonicalReceipt and copyReceipt fields.
 */
export function createDataWranglerComparisonSourceCopy(
  { canonicalPath, privateRoot, name, maximumBytes = MAXIMUM_SOURCE_BYTES },
  { faultInjector } = {}
) {
  if (faultInjector !== undefined && typeof faultInjector !== "function") {
    fail("The comparison source-copy fault injector must be a function.");
  }
  const sourcePath = absolutePath(canonicalPath, "The canonical comparison source");
  const rootPath = absolutePath(privateRoot, "The comparison source-copy root");
  const targetName = copyName(name);
  const byteBound = boundedMaximumBytes(maximumBytes);
  const targetPath = resolve(rootPath, targetName);
  let physicalSource;
  let physicalRoot;
  try {
    physicalSource = realpathSync(sourcePath);
    physicalRoot = realpathSync(rootPath);
  } catch (error) {
    fail("The comparison source and private root must exist before copy preparation.", error);
  }
  if (
    targetPath !== join(rootPath, targetName) ||
    targetPath === sourcePath ||
    pathIsInside(physicalRoot, physicalSource)
  ) {
    fail("The private comparison source-copy path is not isolated from its canonical input.");
  }

  let rootDescriptor;
  let sourceDescriptor;
  let writableDescriptor;
  let copyDescriptor;
  let copySnapshot;
  let canonicalSnapshot;
  let rootState;
  let canonicalReceipt;
  let copyReceipt;
  let operationError;
  const cleanupErrors = [];

  try {
    rootDescriptor = openSync(rootPath, constants.O_RDONLY | constants.O_DIRECTORY | (constants.O_NOFOLLOW ?? 0));
    const rootOpened = fstatSync(rootDescriptor, { bigint: true });
    const rootNamed = lstatSync(rootPath, { bigint: true });
    requirePrivateRoot(rootOpened);
    requirePrivateRoot(rootNamed);
    rootState = rootSnapshot(rootOpened);
    if (!sameRootSnapshot(rootState, rootSnapshot(rootNamed))) {
      fail("The comparison source-copy root changed before it could be opened.");
    }

    sourceDescriptor = openSync(
      sourcePath,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0)
    );
    const sourceOpened = fstatSync(sourceDescriptor, { bigint: true });
    const sourceNamed = lstatSync(sourcePath, { bigint: true });
    requireSourceFile(sourceOpened, byteBound, "The canonical comparison source");
    requireSourceFile(sourceNamed, byteBound, "The canonical comparison source");
    canonicalSnapshot = fileSnapshot(sourceOpened);
    if (!sameFileSnapshot(canonicalSnapshot, fileSnapshot(sourceNamed))) {
      fail("The canonical comparison source changed before it could be copied.");
    }
    const openedRootPath = realpathSync(`/proc/self/fd/${rootDescriptor}`);
    const openedSourcePath = realpathSync(sourcePath);
    if (pathIsInside(openedRootPath, openedSourcePath)) {
      fail("The opened private root physically contains the canonical comparison source.");
    }

    const anchoredTarget = anchoredCopyPath(rootDescriptor, targetName);
    writableDescriptor = openSync(
      anchoredTarget,
      constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
      COPY_MODE
    );
    fchmodSync(writableDescriptor, COPY_MODE);
    const targetOpened = fstatSync(writableDescriptor, { bigint: true });
    requirePrivateCopy(targetOpened, byteBound, { allowEmpty: true });
    copySnapshot = fileSnapshot(targetOpened);
    if (sameFileIdentity(canonicalSnapshot, copySnapshot)) {
      fail("The private comparison source copy aliases its canonical input.");
    }

    const sourceDigest = createHash("sha256");
    const copyDigest = createHash("sha256");
    const buffer = Buffer.allocUnsafe(Math.min(COPY_BLOCK_BYTES, Number(sourceOpened.size)));
    let position = 0;
    while (position < Number(sourceOpened.size)) {
      const length = Math.min(buffer.length, Number(sourceOpened.size) - position);
      const count = readSync(sourceDescriptor, buffer, 0, length, position);
      if (!Number.isSafeInteger(count) || count <= 0 || count > length) {
        fail("The canonical comparison source ended before its pinned byte size.");
      }
      sourceDigest.update(buffer.subarray(0, count));
      copyDigest.update(buffer.subarray(0, count));
      writeAll(writableDescriptor, buffer, position, count);
      position += count;
    }
    if (readSync(sourceDescriptor, buffer, 0, 1, position) !== 0) {
      fail("The canonical comparison source exceeded its pinned byte size.");
    }
    fsyncSync(writableDescriptor);

    const sourceCompleted = fstatSync(sourceDescriptor, { bigint: true });
    const sourceNamedAfter = lstatSync(sourcePath, { bigint: true });
    if (
      !sameFileSnapshot(canonicalSnapshot, fileSnapshot(sourceCompleted)) ||
      !sameFileSnapshot(canonicalSnapshot, fileSnapshot(sourceNamedAfter))
    ) {
      fail("The canonical comparison source changed while it was copied.");
    }
    const targetCompleted = fstatSync(writableDescriptor, { bigint: true });
    const targetNamed = lstatSync(targetPath, { bigint: true });
    requirePrivateCopy(targetCompleted, byteBound);
    requirePrivateCopy(targetNamed, byteBound);
    copySnapshot = fileSnapshot(targetCompleted);
    if (targetCompleted.size !== sourceOpened.size || !sameFileSnapshot(copySnapshot, fileSnapshot(targetNamed))) {
      fail("The private comparison source copy did not retain its exact file identity and size.");
    }
    canonicalReceipt = publicReceipt(canonicalSnapshot, sourceDigest.digest("hex"));
    copyReceipt = publicReceipt(copySnapshot, copyDigest.digest("hex"));
    if (
      canonicalReceipt.sha256 !== copyReceipt.sha256 ||
      canonicalReceipt.filesystemIdentity.sizeBytes !== copyReceipt.filesystemIdentity.sizeBytes
    ) {
      fail("The private comparison source copy is not byte-identical to its canonical input.");
    }

    const retainedCreation = fstatSync(writableDescriptor, { bigint: true });
    if (!sameFileSnapshot(copySnapshot, fileSnapshot(retainedCreation))) {
      fail("The private comparison source copy changed on its creation descriptor.");
    }
    copyDescriptor = openSync(`/proc/self/fd/${writableDescriptor}`, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
    const retained = fstatSync(copyDescriptor, { bigint: true });
    if (!sameFileSnapshot(copySnapshot, fileSnapshot(retained))) {
      fail("The private comparison source copy changed while its read-only lease opened.");
    }
    closeSync(writableDescriptor);
    writableDescriptor = undefined;
    const copySha256 = hashDescriptor(copyDescriptor, Number(retained.size), byteBound);
    if (copySha256 !== copyReceipt.sha256) {
      fail("The private comparison source copy failed its descriptor-bound byte check.");
    }
    const rootCompleted = fstatSync(rootDescriptor, { bigint: true });
    const rootNamedAfter = lstatSync(rootPath, { bigint: true });
    if (
      !sameRootSnapshot(rootState, rootSnapshot(rootCompleted)) ||
      !sameRootSnapshot(rootState, rootSnapshot(rootNamedAfter))
    ) {
      fail("The comparison source-copy root changed while the copy was created.");
    }
    faultInjector?.("after-copy-created");
  } catch (error) {
    operationError = error;
  } finally {
    if (writableDescriptor !== undefined) {
      try {
        closeSync(writableDescriptor);
      } catch (error) {
        cleanupErrors.push(error);
      }
      writableDescriptor = undefined;
    }
    if (sourceDescriptor !== undefined) {
      try {
        closeSync(sourceDescriptor);
      } catch (error) {
        cleanupErrors.push(error);
      }
      sourceDescriptor = undefined;
    }
  }

  if (operationError !== undefined || cleanupErrors.length > 0) {
    if (copyDescriptor !== undefined) {
      try {
        closeSync(copyDescriptor);
      } catch (error) {
        cleanupErrors.push(error);
      }
      copyDescriptor = undefined;
    }
    if (rootDescriptor !== undefined && copySnapshot !== undefined) {
      try {
        const rollbackIdentity = {
          rootDescriptor,
          rootPath,
          sourcePath,
          targetPath,
          rootState,
          canonicalSnapshot,
          copySnapshot
        };
        assertRollbackIdentities(rollbackIdentity);
        faultInjector?.("before-rollback-unlink");
        assertRollbackIdentities(rollbackIdentity);
        unlinkSync(anchoredCopyPath(rootDescriptor, targetName));
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    if (rootDescriptor !== undefined) {
      try {
        closeSync(rootDescriptor);
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    const failures = operationError === undefined ? cleanupErrors : [operationError, ...cleanupErrors];
    if (cleanupErrors.length > 0) {
      throw createDataWranglerComparisonCleanupUnsettledError(
        failures,
        "Could not create the private comparison source copy or confirm its rollback."
      );
    }
    throw new AggregateError(failures, "Could not create the private comparison source copy.");
  }

  const handle = Object.freeze({
    protocol: DATA_WRANGLER_COMPARISON_SOURCE_COPY_PROTOCOL,
    canonicalPath: sourcePath,
    copyPath: targetPath,
    mode: "0600",
    byteIdentical: true,
    canonicalReceipt,
    copyReceipt
  });
  leases.set(handle, {
    canonicalPath: sourcePath,
    copyPath: targetPath,
    privateRoot: rootPath,
    name: targetName,
    maximumBytes: byteBound,
    canonicalSnapshot,
    copySnapshot,
    rootSnapshot: rootState,
    canonicalReceipt,
    copyReceipt,
    rootDescriptor,
    copyDescriptor,
    borrowed: false,
    settled: false
  });
  return handle;
}

/**
 * Reinspect the live copy lease without reading the private copy's bytes. This
 * is safe after cache preparation because it does not fault its pages back in.
 */
export function assertDataWranglerComparisonSourceCopy(handle) {
  const state = leases.get(handle);
  if (state === undefined || state.settled) {
    fail("The comparison source-copy lease is unknown or already settled.");
  }
  assertRootState(state);
  assertCanonicalState(state);
  assertCopyState(state);
  return handle;
}

/**
 * Run one synchronous operation with the exact retained copy descriptor.
 *
 * The descriptor is deliberately exposed only inside this callback. The
 * callback may pass it to a synchronous child process, but it may not retain
 * asynchronous work after returning. Both the descriptor and its public name
 * are revalidated before and after the operation.
 */
export function withDataWranglerComparisonSourceCopyDescriptor(handle, operation) {
  const state = leases.get(handle);
  if (state === undefined || state.settled) {
    fail("The comparison source-copy lease is unknown or already settled.");
  }
  if (typeof operation !== "function") {
    fail("The comparison source-copy descriptor operation must be a function.");
  }
  if (state.borrowed) {
    fail("The comparison source-copy descriptor is already in use.");
  }
  assertRootState(state);
  assertCanonicalState(state);
  assertCopyState(state);
  state.borrowed = true;
  let result;
  let operationError;
  try {
    result = operation(
      Object.freeze({
        descriptor: state.copyDescriptor,
        receipt: handle.copyReceipt
      })
    );
    if (result && typeof result.then === "function") {
      fail("The comparison source-copy descriptor operation must finish synchronously.");
    }
  } catch (error) {
    operationError = error;
  }
  state.borrowed = false;
  let validationError;
  try {
    assertRootState(state);
    assertCanonicalState(state);
    assertCopyState(state);
  } catch (error) {
    validationError = error;
  }
  if (operationError !== undefined || validationError !== undefined) {
    if (operationError !== undefined && validationError !== undefined) {
      throw new AggregateError(
        [operationError, validationError],
        "The private comparison source operation failed and its retained lease changed."
      );
    }
    throw operationError ?? validationError;
  }
  return result;
}

/**
 * Remove only the exact private inode created by this module.
 *
 * Any uncertain root, source, or copy identity closes the lease but leaves all
 * names untouched for inspection. In particular, this function never unlinks
 * the canonical source path.
 */
export function cleanupDataWranglerComparisonSourceCopy(handle, { faultInjector } = {}) {
  const state = leases.get(handle);
  if (state === undefined || state.settled) {
    fail("The comparison source-copy lease is unknown or already settled.");
  }
  if (faultInjector !== undefined && typeof faultInjector !== "function") {
    fail("The comparison source-copy cleanup fault injector must be a function.");
  }
  if (state.borrowed) {
    fail("The comparison source-copy descriptor is still in use.");
  }
  state.settled = true;
  let operationError;
  const cleanupErrors = [];
  try {
    assertRootState(state);
    assertCanonicalState(state);
    assertCopyState(state, { hash: true });
    if (sameFileIdentity(state.canonicalSnapshot, state.copySnapshot)) {
      fail("The private comparison source copy unexpectedly aliases its canonical input.");
    }
    faultInjector?.("before-unlink");
    assertRootState(state);
    assertCanonicalState(state);
    assertCopyState(state);
    unlinkSync(anchoredCopyPath(state.rootDescriptor, state.name));
    const retained = fstatSync(state.copyDescriptor, { bigint: true });
    if (
      !retained.isFile() ||
      retained.dev !== state.copySnapshot.dev ||
      retained.ino !== state.copySnapshot.ino ||
      retained.nlink !== 0n
    ) {
      fail("The private comparison source copy did not become one unlinked retained inode.");
    }
    try {
      lstatSync(state.copyPath, { bigint: true });
      fail("The private comparison source-copy name still exists after cleanup.");
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    assertCanonicalState(state);
  } catch (error) {
    operationError = error;
  }
  closeStateDescriptors(state, cleanupErrors);
  if (operationError !== undefined || cleanupErrors.length > 0) {
    throw new AggregateError(
      operationError === undefined ? cleanupErrors : [operationError, ...cleanupErrors],
      "Could not prove private comparison source-copy cleanup; uncertain names were left untouched."
    );
  }
  return Object.freeze({
    protocol: DATA_WRANGLER_COMPARISON_SOURCE_COPY_PROTOCOL,
    removed: true,
    copyReceipt: handle.copyReceipt
  });
}
