import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";

const MAXIMUM_BOUNDED_FILE_BYTES = 32 * 1024 * 1024;

export function readBoundedRegularFile(
  path,
  maximumBytes,
  { afterOpenForTest, containedBy, label = "Bounded file" } = {}
) {
  if (
    typeof path !== "string" ||
    !isAbsolute(path) ||
    resolve(path) !== path ||
    !Number.isSafeInteger(maximumBytes) ||
    maximumBytes <= 0 ||
    maximumBytes > MAXIMUM_BOUNDED_FILE_BYTES ||
    typeof label !== "string" ||
    label.length <= 0 ||
    label.length > 128 ||
    /[\0\r\n]/u.test(label) ||
    (afterOpenForTest !== undefined && typeof afterOpenForTest !== "function")
  ) {
    throw new Error("A bounded descriptor-file read policy is malformed.");
  }
  const canonicalRoot =
    containedBy === undefined ? undefined : assertCanonicalDirectory(containedBy, "bounded descriptor-file root");
  let descriptor;
  try {
    descriptor = openSync(
      path,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0) | (constants.O_CLOEXEC ?? 0)
    );
  } catch (error) {
    throw new Error(`${label} is not one no-follow regular file.`, { cause: error });
  }
  try {
    const opened = boundedFileSnapshot(fstatSync(descriptor, { bigint: true }), maximumBytes, label);
    const namedBefore = boundedFileSnapshot(lstatSync(path, { bigint: true }), maximumBytes, label);
    const canonicalBefore = realpathSync(path);
    if (
      !sameBoundedFileSnapshot(opened, namedBefore) ||
      (canonicalRoot !== undefined && !isContained(canonicalRoot, canonicalBefore))
    ) {
      throw new Error(`${label} changed before its descriptor-bound read.`);
    }
    afterOpenForTest?.(Object.freeze({ descriptor, path }));
    const bytes = Buffer.alloc(Number(opened.size));
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(descriptor, bytes, offset, bytes.length - offset, null);
      if (!Number.isSafeInteger(count) || count <= 0) {
        throw new Error(`${label} ended before its pinned byte size.`);
      }
      offset += count;
    }
    const completed = boundedFileSnapshot(fstatSync(descriptor, { bigint: true }), maximumBytes, label);
    const namedAfter = boundedFileSnapshot(lstatSync(path, { bigint: true }), maximumBytes, label);
    const canonicalAfter = realpathSync(path);
    if (
      !sameBoundedFileSnapshot(opened, completed) ||
      !sameBoundedFileSnapshot(opened, namedAfter) ||
      canonicalAfter !== canonicalBefore ||
      (canonicalRoot !== undefined && !isContained(canonicalRoot, canonicalAfter))
    ) {
      throw new Error(`${label} changed during its descriptor-bound read.`);
    }
    return bytes;
  } finally {
    closeSync(descriptor);
  }
}

function boundedFileSnapshot(metadata, maximumBytes, label) {
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.nlink !== 1n ||
    metadata.size <= 0n ||
    metadata.size > BigInt(maximumBytes)
  ) {
    throw new Error(`${label} is not one bounded single-link regular file.`);
  }
  return Object.freeze({
    dev: metadata.dev,
    ino: metadata.ino,
    mode: metadata.mode,
    nlink: metadata.nlink,
    uid: metadata.uid,
    gid: metadata.gid,
    size: metadata.size,
    mtimeNs: metadata.mtimeNs,
    ctimeNs: metadata.ctimeNs,
    birthtimeNs: metadata.birthtimeNs
  });
}

function sameBoundedFileSnapshot(left, right) {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.nlink === right.nlink &&
    left.uid === right.uid &&
    left.gid === right.gid &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs &&
    left.birthtimeNs === right.birthtimeNs
  );
}

function assertCanonicalDirectory(path, label) {
  if (typeof path !== "string" || !isAbsolute(path) || resolve(path) !== path) {
    throw new Error(`A ${label} is malformed.`);
  }
  const canonical = realpathSync(path);
  const metadata = lstatSync(path);
  if (canonical !== path || !metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error(`A ${label} is not canonical.`);
  }
  return canonical;
}

function isContained(parent, candidate) {
  const relation = relative(parent, candidate);
  return relation.length > 0 && relation !== ".." && !relation.startsWith(`..${sep}`) && !isAbsolute(relation);
}
