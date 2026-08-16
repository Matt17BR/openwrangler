import { randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  openSync,
  readSync,
  writeSync,
  type BigIntStats
} from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { removeIdentifiedFile } from "./identifiedTemporary";

const MAX_REQUEST_BYTES = 64 * 1024;
const MAX_RESULT_BYTES = 64 * 1024;
const O_CLOEXEC = (constants as typeof constants & { readonly O_CLOEXEC?: number }).O_CLOEXEC ?? 0;

export interface ComparisonRequestReadHooks {
  readonly afterDescriptorPinned?: (path: string) => void;
  readonly afterReadProgress?: (path: string, bytesRead: number) => void;
}

export interface ComparisonResultPublicationHooks {
  readonly beforeLink?: (temporary: string, destination: string) => void;
  readonly afterLink?: (temporary: string, destination: string) => void;
  readonly beforeTemporaryRemoval?: (temporary: string, destination: string) => void;
}

type ComparisonFileSnapshot = Pick<
  BigIntStats,
  "birthtimeNs" | "ctimeNs" | "dev" | "gid" | "ino" | "mode" | "mtimeNs" | "nlink" | "size" | "uid"
>;

type Validator<Value> = (value: unknown) => Value;

function fail(message: string): never {
  throw new Error(message);
}

function absolutePath(value: string, label: string): string {
  if (!isAbsolute(value) || resolve(value) !== value || /[\0\r\n]/u.test(value)) {
    fail(`${label} must be one normalized absolute path.`);
  }
  return value;
}

function containedPath(root: string, value: string, label: string): string {
  const normalizedRoot = absolutePath(root, "Comparison isolated root");
  const path = absolutePath(value, label);
  const child = relative(normalizedRoot, path);
  if (child === "" || child === ".." || child.startsWith(`..${sep}`) || isAbsolute(child)) {
    fail(`${label} must be below the isolated trial root.`);
  }
  return path;
}

function comparisonRequestReadFlags(): number {
  let flags = constants.O_RDONLY | O_CLOEXEC;
  if (process.platform !== "win32") {
    if (typeof constants.O_NOFOLLOW !== "number" || typeof constants.O_NONBLOCK !== "number") {
      fail("Comparison request reads require no-follow and non-blocking descriptor support on this platform.");
    }
    flags |= constants.O_NOFOLLOW | constants.O_NONBLOCK;
  }
  return flags;
}

function comparisonFileSnapshot(
  metadata: BigIntStats,
  minimumBytes: bigint,
  maximumBytes: number,
  label: string
): ComparisonFileSnapshot {
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.nlink !== 1n ||
    metadata.size < minimumBytes ||
    metadata.size > BigInt(maximumBytes) ||
    (metadata.dev === 0n && metadata.ino === 0n)
  ) {
    fail(`${label} must be one bounded single-link regular file with a usable identity.`);
  }
  return Object.freeze({
    birthtimeNs: metadata.birthtimeNs,
    ctimeNs: metadata.ctimeNs,
    dev: metadata.dev,
    gid: metadata.gid,
    ino: metadata.ino,
    mode: metadata.mode,
    mtimeNs: metadata.mtimeNs,
    nlink: metadata.nlink,
    size: metadata.size,
    uid: metadata.uid
  });
}

function sameComparisonFileSnapshot(left: ComparisonFileSnapshot, right: ComparisonFileSnapshot): boolean {
  return (
    left.birthtimeNs === right.birthtimeNs &&
    left.ctimeNs === right.ctimeNs &&
    left.dev === right.dev &&
    left.gid === right.gid &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.mtimeNs === right.mtimeNs &&
    left.nlink === right.nlink &&
    left.size === right.size &&
    left.uid === right.uid
  );
}

function sameComparisonPublicationIdentity(left: BigIntStats, right: BigIntStats): boolean {
  return (
    left.isFile() &&
    !left.isSymbolicLink() &&
    right.isFile() &&
    !right.isSymbolicLink() &&
    left.birthtimeNs === right.birthtimeNs &&
    left.dev === right.dev &&
    left.gid === right.gid &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.uid === right.uid
  );
}

function sameComparisonPublicationFile(left: BigIntStats, right: BigIntStats): boolean {
  return sameComparisonPublicationIdentity(left, right) && left.mtimeNs === right.mtimeNs && left.size === right.size;
}

function readPublishedComparisonResult(path: string, expectedBytes: Buffer, expected: BigIntStats): void {
  let descriptor: number | undefined;
  let operationError: unknown;
  try {
    descriptor = openSync(path, comparisonRequestReadFlags());
    const opened = comparisonFileSnapshot(
      fstatSync(descriptor, { bigint: true }),
      1n,
      MAX_RESULT_BYTES,
      "Comparison result"
    );
    const namedBefore = comparisonFileSnapshot(
      lstatSync(path, { bigint: true }),
      1n,
      MAX_RESULT_BYTES,
      "Comparison result"
    );
    const firstPublished = comparisonFileSnapshot(expected, 1n, MAX_RESULT_BYTES, "Comparison result");
    if (
      !sameComparisonFileSnapshot(firstPublished, opened) ||
      !sameComparisonFileSnapshot(firstPublished, namedBefore)
    ) {
      fail("Comparison result changed before its published descriptor was pinned.");
    }

    const actualBytes = Buffer.alloc(expectedBytes.length);
    let offset = 0;
    while (offset < actualBytes.length) {
      const count = readSync(descriptor, actualBytes, offset, actualBytes.length - offset, offset);
      if (!Number.isSafeInteger(count) || count <= 0) {
        fail("Comparison result ended before its published byte size.");
      }
      offset += count;
    }
    const completed = comparisonFileSnapshot(
      fstatSync(descriptor, { bigint: true }),
      1n,
      MAX_RESULT_BYTES,
      "Comparison result"
    );
    const namedAfter = comparisonFileSnapshot(
      lstatSync(path, { bigint: true }),
      1n,
      MAX_RESULT_BYTES,
      "Comparison result"
    );
    if (
      !sameComparisonFileSnapshot(opened, completed) ||
      !sameComparisonFileSnapshot(opened, namedAfter) ||
      !actualBytes.equals(expectedBytes)
    ) {
      fail("Comparison result changed while its published descriptor was read.");
    }
  } catch (error) {
    operationError = error;
  }

  let closeError: unknown;
  if (descriptor !== undefined) {
    try {
      closeSync(descriptor);
    } catch (error) {
      closeError = error;
    }
  }
  if (operationError !== undefined && closeError !== undefined) {
    throw new AggregateError(
      [operationError, closeError],
      "Comparison result validation and descriptor close both failed."
    );
  }
  if (operationError !== undefined) throw operationError;
  if (closeError !== undefined) throw closeError;
}

export function readComparisonRequestFile<Value>(
  path: string,
  validate: Validator<Value>,
  hooks: ComparisonRequestReadHooks = {}
): Value {
  if (
    (hooks.afterDescriptorPinned !== undefined && typeof hooks.afterDescriptorPinned !== "function") ||
    (hooks.afterReadProgress !== undefined && typeof hooks.afterReadProgress !== "function")
  ) {
    fail("Comparison request read hooks are invalid.");
  }
  let descriptor: number | undefined;
  let result: Value | undefined;
  let operationError: unknown;
  try {
    descriptor = openSync(path, comparisonRequestReadFlags());
    const opened = comparisonFileSnapshot(
      fstatSync(descriptor, { bigint: true }),
      2n,
      MAX_REQUEST_BYTES,
      "Comparison request"
    );
    hooks.afterDescriptorPinned?.(path);
    const namedBefore = comparisonFileSnapshot(
      lstatSync(path, { bigint: true }),
      2n,
      MAX_REQUEST_BYTES,
      "Comparison request"
    );
    if (!sameComparisonFileSnapshot(opened, namedBefore)) {
      fail("Comparison request path changed before its descriptor-bound read.");
    }

    const bytes = Buffer.alloc(Number(opened.size));
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(descriptor, bytes, offset, Math.min(4096, bytes.length - offset), offset);
      if (!Number.isSafeInteger(count) || count <= 0) {
        fail("Comparison request ended before its pinned byte size.");
      }
      offset += count;
      hooks.afterReadProgress?.(path, offset);
    }

    const completed = comparisonFileSnapshot(
      fstatSync(descriptor, { bigint: true }),
      2n,
      MAX_REQUEST_BYTES,
      "Comparison request"
    );
    const namedAfter = comparisonFileSnapshot(
      lstatSync(path, { bigint: true }),
      2n,
      MAX_REQUEST_BYTES,
      "Comparison request"
    );
    if (!sameComparisonFileSnapshot(opened, completed) || !sameComparisonFileSnapshot(opened, namedAfter)) {
      fail("Comparison request changed during its descriptor-bound read.");
    }

    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    result = validate(JSON.parse(text));
  } catch (error) {
    operationError = error;
  }

  let closeError: unknown;
  if (descriptor !== undefined) {
    try {
      closeSync(descriptor);
    } catch (error) {
      closeError = error;
    }
  }
  if (operationError !== undefined && closeError !== undefined) {
    throw new AggregateError([operationError, closeError], "Comparison request read and descriptor close both failed.");
  }
  if (operationError !== undefined) throw operationError;
  if (closeError !== undefined) throw closeError;
  if (result === undefined) fail("Comparison request read completed without a validated result.");
  return result;
}

export function writeComparisonResultFile<Value>(
  path: string,
  root: string,
  result: Value,
  validate: Validator<Value>,
  hooks: ComparisonResultPublicationHooks = {}
): void {
  if (
    (hooks.beforeLink !== undefined && typeof hooks.beforeLink !== "function") ||
    (hooks.afterLink !== undefined && typeof hooks.afterLink !== "function") ||
    (hooks.beforeTemporaryRemoval !== undefined && typeof hooks.beforeTemporaryRemoval !== "function")
  ) {
    fail("Comparison result publication hooks are invalid.");
  }
  containedPath(root, path, "Comparison result path");
  const serialized = `${JSON.stringify(validate(result), null, 2)}\n`;
  const bytes = Buffer.from(serialized, "utf8");
  if (bytes.length === 0 || bytes.length > MAX_RESULT_BYTES) fail("Comparison result exceeded 64 KiB.");
  const temporary = `${path}.${randomUUID()}.tmp`;
  let descriptor: number | undefined;
  let temporaryIdentity: BigIntStats | undefined;
  let linked = false;
  let temporaryRemoved = false;
  let published = false;
  let operationError: unknown;
  try {
    descriptor = openSync(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0) | O_CLOEXEC,
      0o600
    );
    temporaryIdentity = fstatSync(descriptor, { bigint: true });
    if (
      !temporaryIdentity.isFile() ||
      temporaryIdentity.isSymbolicLink() ||
      temporaryIdentity.nlink !== 1n ||
      temporaryIdentity.size !== 0n ||
      (temporaryIdentity.dev === 0n && temporaryIdentity.ino === 0n)
    ) {
      fail("Comparison result temporary must be one exclusive single-link regular file with a usable identity.");
    }
    let offset = 0;
    while (offset < bytes.length) {
      const count = writeSync(descriptor, bytes, offset, bytes.length - offset, offset);
      if (!Number.isSafeInteger(count) || count <= 0) fail("Comparison result write made no progress.");
      offset += count;
    }
    fsyncSync(descriptor);
    const completed = fstatSync(descriptor, { bigint: true });
    if (
      !sameComparisonPublicationIdentity(temporaryIdentity, completed) ||
      completed.nlink !== 1n ||
      completed.size !== BigInt(bytes.length)
    ) {
      fail("Comparison result temporary changed while it was written.");
    }
    const closingDescriptor = descriptor;
    descriptor = undefined;
    closeSync(closingDescriptor);

    const temporaryBeforeLink = lstatSync(temporary, { bigint: true });
    if (!sameComparisonPublicationFile(completed, temporaryBeforeLink) || temporaryBeforeLink.nlink !== 1n) {
      fail("Comparison result temporary changed before publication.");
    }
    hooks.beforeLink?.(temporary, path);
    linkSync(temporary, path);
    linked = true;
    hooks.afterLink?.(temporary, path);

    const linkedTemporary = lstatSync(temporary, { bigint: true });
    const linkedResult = lstatSync(path, { bigint: true });
    if (
      !sameComparisonPublicationFile(completed, linkedTemporary) ||
      !sameComparisonPublicationFile(completed, linkedResult) ||
      linkedTemporary.nlink !== 2n ||
      linkedResult.nlink !== 2n
    ) {
      fail("Comparison result changed during exclusive publication.");
    }
    hooks.beforeTemporaryRemoval?.(temporary, path);
    if (
      !removeIdentifiedFile(temporary, completed, {
        allowedLinkCounts: [2n],
        description: "comparison result temporary"
      })
    ) {
      fail("Comparison result temporary disappeared before identified removal.");
    }
    temporaryRemoved = true;

    const publishedResult = lstatSync(path, { bigint: true });
    if (!sameComparisonPublicationFile(completed, publishedResult) || publishedResult.nlink !== 1n) {
      fail("Comparison result changed after exclusive publication.");
    }
    readPublishedComparisonResult(path, bytes, publishedResult);
    published = true;
  } catch (error) {
    operationError = error;
  }

  const cleanupErrors: unknown[] = [];
  if (descriptor !== undefined) {
    try {
      closeSync(descriptor);
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  if (!published && linked && temporaryIdentity !== undefined) {
    try {
      removeIdentifiedFile(path, temporaryIdentity, {
        allowedLinkCounts: temporaryRemoved ? [1n] : [1n, 2n],
        description: "comparison result"
      });
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  if (!published && !temporaryRemoved && temporaryIdentity !== undefined) {
    try {
      removeIdentifiedFile(temporary, temporaryIdentity, {
        allowedLinkCounts: [1n, 2n],
        description: "comparison result temporary"
      });
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  if (operationError !== undefined && cleanupErrors.length > 0) {
    throw new AggregateError(
      [operationError, ...cleanupErrors],
      "Comparison result publication and identified cleanup both failed."
    );
  }
  if (operationError !== undefined) throw operationError;
  if (cleanupErrors.length === 1) throw cleanupErrors[0];
  if (cleanupErrors.length > 1) {
    throw new AggregateError(cleanupErrors, "Comparison result identified cleanup failed.");
  }
}
