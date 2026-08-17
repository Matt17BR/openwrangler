import { constants as fsConstants, type BigIntStats } from "node:fs";
import { chmod, lstat, mkdtemp, open, rename, type FileHandle } from "node:fs/promises";
import { dirname, join } from "node:path";

const PRIVATE_READ_FLAGS =
  fsConstants.O_RDONLY |
  (typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0) |
  (typeof fsConstants.O_NONBLOCK === "number" ? fsConstants.O_NONBLOCK : 0);

const PRIVATE_CLEANUP_FLAGS =
  fsConstants.O_RDWR |
  (typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0) |
  (typeof fsConstants.O_NONBLOCK === "number" ? fsConstants.O_NONBLOCK : 0);

export interface RPrivateArtifactSnapshot {
  readonly dev: bigint;
  readonly ino: bigint;
  readonly mode: bigint;
  readonly nlink: bigint;
  readonly uid: bigint;
  readonly gid: bigint;
  readonly size: bigint;
  readonly mtimeNs: bigint;
  readonly ctimeNs: bigint;
  readonly birthtimeNs: bigint;
}

export interface RPrivateArtifactHandle {
  stat(options: { bigint: true }): Promise<BigIntStats>;
  read(buffer: Buffer, offset: number, length: number, position: number): Promise<{ bytesRead: number }>;
  truncate(length: number): Promise<void>;
  close(): Promise<void>;
}

export interface RPrivateArtifactOperations {
  readonly platform?: NodeJS.Platform;
  open(filePath: string, flags: number): Promise<RPrivateArtifactHandle>;
  lstat(filePath: string): Promise<BigIntStats>;
  createCleanupDirectory(parentPath: string): Promise<string>;
  rename(sourcePath: string, destinationPath: string): Promise<void>;
}

export interface RPrivateArtifactOptions {
  readonly filePath: string;
  readonly maximumBytes: number;
  readonly label: string;
  readonly expectedBytes?: number;
  readonly missing?: "error" | "returnUndefined";
  readonly removeAfterRead?: "never" | "success" | "always";
  readonly operations?: RPrivateArtifactOperations;
  readonly onCleanupFailure?: (error: RPrivateArtifactCleanupError) => void;
}

export interface RPrivateArtifactReceipt {
  readonly path: string;
  readonly label: string;
  readonly snapshot: RPrivateArtifactSnapshot;
}

export class RPrivateArtifactCleanupError extends AggregateError {
  readonly preserveContainer: boolean;

  constructor(errors: readonly unknown[], message: string, preserveContainer: boolean) {
    super(errors, message);
    this.name = "RPrivateArtifactCleanupError";
    this.preserveContainer = preserveContainer;
  }
}

class RPrivateArtifactOwnershipError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "RPrivateArtifactOwnershipError";
  }
}

export function createNodeRPrivateArtifactOperations(openFile: typeof open = open): RPrivateArtifactOperations {
  return Object.freeze({
    platform: process.platform,
    async open(filePath: string, flags: number) {
      return (await openFile(filePath, flags)) as FileHandle;
    },
    async lstat(filePath: string) {
      return lstat(filePath, { bigint: true });
    },
    async createCleanupDirectory(parentPath: string) {
      const directoryPath = await mkdtemp(join(parentPath, ".openwrangler-cleanup-"));
      await chmod(directoryPath, 0o700);
      return directoryPath;
    },
    rename
  });
}

const nodeOperations = createNodeRPrivateArtifactOperations();

export async function readRPrivateArtifact(options: RPrivateArtifactOptions): Promise<Buffer | undefined> {
  return withRPrivateArtifact(options, async (handle, receipt) => {
    const bytes = Buffer.alloc(Number(receipt.snapshot.size));
    await readExact(handle, bytes, options.label);
    return bytes;
  });
}

export async function captureRPrivateArtifactReceipt(
  options: Omit<RPrivateArtifactOptions, "removeAfterRead" | "onCleanupFailure">
): Promise<RPrivateArtifactReceipt | undefined> {
  return withRPrivateArtifact({ ...options, removeAfterRead: "never" }, async (_handle, receipt) => receipt);
}

export async function captureOpenedRPrivateArtifactReceipt(options: {
  readonly filePath: string;
  readonly maximumBytes: number;
  readonly expectedBytes?: number;
  readonly label: string;
  readonly handle: RPrivateArtifactHandle;
  readonly operations?: RPrivateArtifactOperations;
}): Promise<RPrivateArtifactReceipt> {
  const normalized = normalizeOptions({
    filePath: options.filePath,
    maximumBytes: options.maximumBytes,
    expectedBytes: options.expectedBytes,
    label: options.label,
    operations: options.operations,
    removeAfterRead: "never"
  });
  const opened = artifactSnapshot(
    await options.handle.stat({ bigint: true }),
    normalized.maximumBytes,
    normalized.label,
    normalized.expectedBytes
  );
  const named = artifactSnapshot(
    await normalized.operations.lstat(normalized.filePath),
    normalized.maximumBytes,
    normalized.label,
    normalized.expectedBytes
  );
  if (!sameArtifactSnapshot(opened, named)) throw changingArtifactError(normalized.label, opened, named);
  return Object.freeze({ path: normalized.filePath, label: normalized.label, snapshot: opened });
}

export async function removeIdentifiedRPrivateArtifact(
  receipt: RPrivateArtifactReceipt,
  operations: RPrivateArtifactOperations = nodeOperations
): Promise<void> {
  await removeIdentifiedArtifact(receipt, operations);
}

export async function streamAndRemoveRPrivateArtifact(
  options: Omit<RPrivateArtifactOptions, "removeAfterRead"> & { readonly chunkBytes: number },
  writeChunk: (chunk: Uint8Array) => Promise<void>
): Promise<void> {
  if (!Number.isSafeInteger(options.chunkBytes) || options.chunkBytes < 1) {
    throw new TypeError("The private R artifact chunk limit must be a positive safe integer.");
  }
  await withRPrivateArtifact({ ...options, removeAfterRead: "always" }, async (handle, receipt) => {
    const totalBytes = Number(receipt.snapshot.size);
    let offset = 0;
    while (offset < totalBytes) {
      const length = Math.min(options.chunkBytes, totalBytes - offset);
      const chunk = Buffer.allocUnsafe(length);
      const { bytesRead } = await handle.read(chunk, 0, length, offset);
      if (!Number.isSafeInteger(bytesRead) || bytesRead <= 0 || bytesRead > length) {
        throw new Error(`Open Wrangler received a truncated ${options.label} artifact.`);
      }
      await writeChunk(chunk.subarray(0, bytesRead));
      offset += bytesRead;
    }
  });
}

export async function removeRPrivateArtifactAtPath(
  options: Omit<RPrivateArtifactOptions, "removeAfterRead" | "onCleanupFailure">
): Promise<void> {
  await withRPrivateArtifact({ ...options, removeAfterRead: "always" }, async () => undefined);
}

export function rPrivateArtifactCleanupFailed(error: unknown): error is RPrivateArtifactCleanupError {
  return error instanceof RPrivateArtifactCleanupError;
}

export function rPrivateArtifactFailureRequiresContainerPreservation(error: unknown): boolean {
  if (error instanceof RPrivateArtifactOwnershipError) return true;
  if (error instanceof RPrivateArtifactCleanupError && error.preserveContainer) return true;
  if (error instanceof AggregateError) {
    return error.errors.some((nested) => rPrivateArtifactFailureRequiresContainerPreservation(nested));
  }
  return false;
}

export function rPrivateCleanupDirectoryModeIsPrivate(
  mode: bigint,
  platform: NodeJS.Platform = process.platform
): boolean {
  return platform === "win32" || (mode & 0o077n) === 0n;
}

async function withRPrivateArtifact<T>(
  options: RPrivateArtifactOptions,
  consume: (handle: RPrivateArtifactHandle, receipt: RPrivateArtifactReceipt) => Promise<T>
): Promise<T | undefined> {
  const normalized = normalizeOptions(options);
  let handle: RPrivateArtifactHandle;
  try {
    handle = await normalized.operations.open(normalized.filePath, PRIVATE_READ_FLAGS);
  } catch (error) {
    if (normalized.missing === "returnUndefined" && isMissingFile(error)) return undefined;
    throw error;
  }

  let receipt: RPrivateArtifactReceipt | undefined;
  let result: T | undefined;
  let primaryError: unknown;
  const cleanupFailures: unknown[] = [];
  try {
    const opened = artifactSnapshot(
      await handle.stat({ bigint: true }),
      normalized.maximumBytes,
      normalized.label,
      normalized.expectedBytes
    );
    const namedBefore = artifactSnapshot(
      await normalized.operations.lstat(normalized.filePath),
      normalized.maximumBytes,
      normalized.label,
      normalized.expectedBytes
    );
    if (!sameArtifactSnapshot(opened, namedBefore)) {
      throw changingArtifactError(normalized.label, opened, namedBefore);
    }
    receipt = Object.freeze({
      path: normalized.filePath,
      label: normalized.label,
      snapshot: opened
    });
    result = await consume(handle, receipt);
    const completed = artifactSnapshot(
      await handle.stat({ bigint: true }),
      normalized.maximumBytes,
      normalized.label,
      normalized.expectedBytes
    );
    const namedAfter = artifactSnapshot(
      await normalized.operations.lstat(normalized.filePath),
      normalized.maximumBytes,
      normalized.label,
      normalized.expectedBytes
    );
    if (!sameArtifactSnapshot(opened, completed) || !sameArtifactSnapshot(opened, namedAfter)) {
      throw changingArtifactError(normalized.label, opened, completed, namedAfter);
    }
  } catch (error) {
    primaryError = error;
  }

  try {
    await handle.close();
  } catch (error) {
    cleanupFailures.push(error);
  }

  const shouldRemove =
    receipt !== undefined &&
    (normalized.removeAfterRead === "always" ||
      (normalized.removeAfterRead === "success" && primaryError === undefined));
  if (shouldRemove && receipt) {
    try {
      await removeIdentifiedArtifact(receipt, normalized.operations);
    } catch (error) {
      cleanupFailures.push(error);
    }
  }

  if (cleanupFailures.length > 0) {
    const cleanupError = new RPrivateArtifactCleanupError(
      primaryError === undefined ? cleanupFailures : [primaryError, ...cleanupFailures],
      `Open Wrangler could not completely clean up its ${normalized.label} artifact.`,
      cleanupFailures.some((failure) => rPrivateArtifactFailureRequiresContainerPreservation(failure))
    );
    if (normalized.onCleanupFailure) normalized.onCleanupFailure(cleanupError);
    else throw cleanupError;
  }
  if (primaryError !== undefined) throw primaryError;
  return result;
}

async function readExact(handle: RPrivateArtifactHandle, bytes: Buffer, label: string): Promise<void> {
  let offset = 0;
  while (offset < bytes.byteLength) {
    const { bytesRead } = await handle.read(bytes, offset, bytes.byteLength - offset, offset);
    if (!Number.isSafeInteger(bytesRead) || bytesRead <= 0 || bytesRead > bytes.byteLength - offset) {
      throw new Error(`Open Wrangler received a truncated ${label} artifact.`);
    }
    offset += bytesRead;
  }
}

async function removeIdentifiedArtifact(
  receipt: RPrivateArtifactReceipt,
  operations: RPrivateArtifactOperations
): Promise<void> {
  let namedBefore: RPrivateArtifactSnapshot;
  try {
    namedBefore = removalSnapshot(await operations.lstat(receipt.path), receipt.label);
  } catch (error) {
    if (isMissingFile(error)) return;
    throw new RPrivateArtifactOwnershipError(`Open Wrangler refused to remove a replaced ${receipt.label} artifact.`, {
      cause: error
    });
  }
  if (!sameArtifactIdentity(receipt.snapshot, namedBefore)) {
    throw new RPrivateArtifactOwnershipError(`Open Wrangler refused to remove a replaced ${receipt.label} artifact.`);
  }

  const parentPath = dirname(receipt.path);
  let cleanupDirectory: string;
  try {
    cleanupDirectory = await operations.createCleanupDirectory(parentPath);
  } catch (error) {
    throw new RPrivateArtifactOwnershipError(
      `Open Wrangler could not reserve private cleanup for its ${receipt.label} artifact.`,
      { cause: error }
    );
  }

  let cleanupIdentity: RPrivateDirectorySnapshot;
  try {
    cleanupIdentity = privateCleanupDirectorySnapshot(
      cleanupDirectory,
      parentPath,
      await operations.lstat(cleanupDirectory),
      receipt,
      operations.platform
    );
  } catch (error) {
    throw new RPrivateArtifactOwnershipError(
      `Open Wrangler rejected private cleanup for its ${receipt.label} artifact.`,
      {
        cause: error
      }
    );
  }

  const quarantinePath = join(cleanupDirectory, "artifact");
  try {
    await operations.rename(receipt.path, quarantinePath);
  } catch (error) {
    throw new RPrivateArtifactOwnershipError(`Open Wrangler could not quarantine its ${receipt.label} artifact.`, {
      cause: error
    });
  }

  let handle: RPrivateArtifactHandle;
  try {
    assertPrivateCleanupDirectory(
      cleanupDirectory,
      cleanupIdentity,
      parentPath,
      await operations.lstat(cleanupDirectory),
      receipt,
      operations.platform
    );
    await requireMissingNamedArtifact(receipt.path, receipt.label, operations);
    handle = await operations.open(quarantinePath, PRIVATE_CLEANUP_FLAGS);
  } catch (error) {
    throw new RPrivateArtifactOwnershipError(
      `Open Wrangler refused ambiguous cleanup of its ${receipt.label} artifact.`,
      {
        cause: error
      }
    );
  }

  let primaryError: unknown;
  try {
    const opened = removalSnapshot(await handle.stat({ bigint: true }), receipt.label);
    const named = removalSnapshot(await operations.lstat(quarantinePath), receipt.label);
    if (!sameArtifactIdentity(receipt.snapshot, opened) || !sameArtifactIdentity(receipt.snapshot, named)) {
      throw new RPrivateArtifactOwnershipError(`Open Wrangler refused to remove a replaced ${receipt.label} artifact.`);
    }
    assertPrivateCleanupDirectory(
      cleanupDirectory,
      cleanupIdentity,
      parentPath,
      await operations.lstat(cleanupDirectory),
      receipt,
      operations.platform
    );
    await requireMissingNamedArtifact(receipt.path, receipt.label, operations);
    await handle.truncate(0);
    const scrubbed = snapshotFromMetadata(await handle.stat({ bigint: true }));
    const namedScrubbed = removalSnapshot(await operations.lstat(quarantinePath), receipt.label);
    if (
      !sameArtifactObject(receipt.snapshot, scrubbed) ||
      !sameArtifactObject(receipt.snapshot, namedScrubbed) ||
      scrubbed.nlink !== 1n ||
      namedScrubbed.nlink !== 1n ||
      scrubbed.size !== 0n ||
      namedScrubbed.size !== 0n
    ) {
      throw new RPrivateArtifactOwnershipError(
        `Open Wrangler could not prove descriptor cleanup of its identified ${receipt.label} artifact.`
      );
    }
    assertPrivateCleanupDirectory(
      cleanupDirectory,
      cleanupIdentity,
      parentPath,
      await operations.lstat(cleanupDirectory),
      receipt,
      operations.platform
    );
    await requireMissingNamedArtifact(receipt.path, receipt.label, operations);
  } catch (error) {
    primaryError = error;
  }

  let closeError: unknown;
  try {
    await handle.close();
  } catch (error) {
    closeError = error;
  }
  if (primaryError !== undefined || closeError !== undefined) {
    if (primaryError !== undefined && closeError !== undefined) {
      throw new AggregateError(
        [primaryError, closeError],
        `Open Wrangler could not remove its identified ${receipt.label} artifact.`
      );
    }
    throw primaryError ?? closeError;
  }
}

interface RPrivateDirectorySnapshot {
  readonly dev: bigint;
  readonly ino: bigint;
  readonly mode: bigint;
  readonly nlink: bigint;
  readonly uid: bigint;
  readonly gid: bigint;
}

function privateCleanupDirectorySnapshot(
  directoryPath: string,
  parentPath: string,
  metadata: BigIntStats,
  receipt: RPrivateArtifactReceipt,
  platform: NodeJS.Platform = process.platform
): RPrivateDirectorySnapshot {
  if (
    dirname(directoryPath) !== parentPath ||
    !metadata.isDirectory() ||
    metadata.isSymbolicLink() ||
    metadata.dev !== receipt.snapshot.dev ||
    metadata.uid !== receipt.snapshot.uid ||
    metadata.gid !== receipt.snapshot.gid ||
    !rPrivateCleanupDirectoryModeIsPrivate(metadata.mode, platform)
  ) {
    throw new Error(`Open Wrangler rejected an invalid ${receipt.label} cleanup directory.`);
  }
  return Object.freeze({
    dev: metadata.dev,
    ino: metadata.ino,
    mode: metadata.mode,
    nlink: metadata.nlink,
    uid: metadata.uid,
    gid: metadata.gid
  });
}

function assertPrivateCleanupDirectory(
  directoryPath: string,
  expected: RPrivateDirectorySnapshot,
  parentPath: string,
  metadata: BigIntStats,
  receipt: RPrivateArtifactReceipt,
  platform: NodeJS.Platform = process.platform
): void {
  const current = privateCleanupDirectorySnapshot(directoryPath, parentPath, metadata, receipt, platform);
  if (
    current.dev !== expected.dev ||
    current.ino !== expected.ino ||
    current.mode !== expected.mode ||
    current.nlink !== expected.nlink ||
    current.uid !== expected.uid ||
    current.gid !== expected.gid
  ) {
    throw new Error(`Open Wrangler rejected a replaced ${receipt.label} cleanup directory.`);
  }
}

async function requireMissingNamedArtifact(
  filePath: string,
  label: string,
  operations: RPrivateArtifactOperations
): Promise<void> {
  try {
    await operations.lstat(filePath);
  } catch (error) {
    if (isMissingFile(error)) return;
    throw error;
  }
  throw new RPrivateArtifactOwnershipError(`Open Wrangler refused to remove a replaced ${label} artifact.`);
}

function removalSnapshot(metadata: BigIntStats, label: string): RPrivateArtifactSnapshot {
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1n) {
    throw new Error(`Open Wrangler rejected an invalid ${label} artifact.`);
  }
  return snapshotFromMetadata(metadata);
}

function artifactSnapshot(
  metadata: BigIntStats,
  maximumBytes: bigint,
  label: string,
  expectedBytes?: bigint
): RPrivateArtifactSnapshot {
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1n) {
    throw new RPrivateArtifactOwnershipError(`Open Wrangler rejected an invalid ${label} artifact.`);
  }
  if (
    metadata.size < 0n ||
    metadata.size > maximumBytes ||
    metadata.size > BigInt(Number.MAX_SAFE_INTEGER) ||
    (expectedBytes !== undefined && metadata.size !== expectedBytes)
  ) {
    throw new Error(`Open Wrangler rejected an invalid ${label} artifact.`);
  }
  return snapshotFromMetadata(metadata);
}

function snapshotFromMetadata(metadata: BigIntStats): RPrivateArtifactSnapshot {
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

function sameArtifactIdentity(left: RPrivateArtifactSnapshot, right: RPrivateArtifactSnapshot): boolean {
  // Size and timestamps prove read stability, but they do not define cleanup
  // ownership. A rejected same-inode rewrite is still the exact file to remove.
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.nlink === right.nlink &&
    left.uid === right.uid &&
    left.gid === right.gid
  );
}

function sameArtifactObject(left: RPrivateArtifactSnapshot, right: RPrivateArtifactSnapshot): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.uid === right.uid && left.gid === right.gid;
}

function sameArtifactSnapshot(left: RPrivateArtifactSnapshot, right: RPrivateArtifactSnapshot): boolean {
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

function changingArtifactError(
  label: string,
  expected: RPrivateArtifactSnapshot,
  ...current: readonly RPrivateArtifactSnapshot[]
): Error {
  const message = `Open Wrangler rejected a changing ${label} artifact.`;
  return current.every((snapshot) => sameArtifactIdentity(expected, snapshot))
    ? new Error(message)
    : new RPrivateArtifactOwnershipError(message);
}

function normalizeOptions(options: RPrivateArtifactOptions): Readonly<{
  filePath: string;
  maximumBytes: bigint;
  expectedBytes?: bigint;
  label: string;
  missing: "error" | "returnUndefined";
  removeAfterRead: "never" | "success" | "always";
  operations: RPrivateArtifactOperations;
  onCleanupFailure?: (error: RPrivateArtifactCleanupError) => void;
}> {
  if (!Number.isSafeInteger(options.maximumBytes) || options.maximumBytes < 0) {
    throw new TypeError("The private R artifact byte limit must be a non-negative safe integer.");
  }
  if (
    options.expectedBytes !== undefined &&
    (!Number.isSafeInteger(options.expectedBytes) ||
      options.expectedBytes < 0 ||
      options.expectedBytes > options.maximumBytes)
  ) {
    throw new TypeError("The private R artifact expected size must fit its byte limit.");
  }
  if (options.filePath.length === 0 || options.label.length === 0) {
    throw new TypeError("The private R artifact path and label must be non-empty.");
  }
  return Object.freeze({
    filePath: options.filePath,
    maximumBytes: BigInt(options.maximumBytes),
    ...(options.expectedBytes === undefined ? {} : { expectedBytes: BigInt(options.expectedBytes) }),
    label: options.label,
    missing: options.missing ?? "error",
    removeAfterRead: options.removeAfterRead ?? "never",
    operations: options.operations ?? nodeOperations,
    ...(options.onCleanupFailure === undefined ? {} : { onCleanupFailure: options.onCleanupFailure })
  });
}

function isMissingFile(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
