import { randomUUID } from "node:crypto";
import { lstat, open, realpath, rename, stat, unlink, type FileHandle } from "node:fs/promises";
import * as path from "node:path";
import type * as vscode from "vscode";

const supportedSchemes = new Set(["file", "vscode-remote"]);
const TEMPORARY_FILE_ATTEMPTS = 16;

type FileIdentity = { dev: bigint; ino: bigint };

interface ProtectedSourceAnchor {
  path: string;
  canonicalPath: string;
  identity: FileIdentity;
}

interface DestinationAnchor {
  path: string;
  canonicalPath: string;
  identity?: FileIdentity;
  parentPath: string;
  canonicalParentPath: string;
  parentIdentity: FileIdentity;
}

export interface AtomicExportHandle {
  readonly identity: FileIdentity;
  write(contents: Uint8Array): Promise<void>;
  sync(): Promise<void>;
  close(): Promise<void>;
}

export interface AtomicExportFileSystem {
  realpath(target: string): Promise<string>;
  stat(target: string): Promise<FileIdentity>;
  lstat(target: string): Promise<{ isFile: boolean; isSymbolicLink: boolean }>;
  openExclusive(target: string): Promise<AtomicExportHandle>;
  replace(source: string, destination: string): Promise<void>;
  remove(target: string): Promise<void>;
}

export interface AtomicFileTransactionOptions {
  destination: vscode.Uri;
  protectedSources?: readonly vscode.Uri[];
  remoteAuthority?: string;
  fileSystem?: AtomicExportFileSystem;
  createTemporaryId?: () => string;
}

export interface AtomicFileTransaction {
  readonly temporaryPath: string;
  prepareExternalWriter(): Promise<AtomicExternalWriterTarget>;
  commit(): Promise<void>;
  rollback(): Promise<void>;
  abandon(): Promise<void>;
}

export interface AtomicExternalWriterTarget {
  readonly path: string;
  readonly identity: FileIdentity;
}

export interface SafeFileExportOptions extends AtomicFileTransactionOptions {
  contents: Uint8Array;
}

export function createNodeAtomicExportFileSystem(openFile: typeof open = open): AtomicExportFileSystem {
  return {
    realpath,
    async stat(target) {
      const details = await stat(target, { bigint: true });
      return { dev: details.dev, ino: details.ino };
    },
    async lstat(target) {
      const details = await lstat(target);
      return { isFile: details.isFile(), isSymbolicLink: details.isSymbolicLink() };
    },
    async openExclusive(target): Promise<AtomicExportHandle> {
      const handle = await openFile(target, "wx", 0o600);
      try {
        const details = await handle.stat({ bigint: true });
        return nodeHandle(handle, { dev: details.dev, ino: details.ino });
      } catch (error) {
        try {
          await handle.close();
        } catch (closeError) {
          throw new AggregateError(
            [error, closeError],
            "Open Wrangler could not inspect or close its newly created temporary export file."
          );
        }
        throw error;
      }
    },
    replace: rename,
    remove: unlink
  };
}

const nodeFileSystem = createNodeAtomicExportFileSystem();

export async function beginAtomicFileTransaction(
  options: AtomicFileTransactionOptions
): Promise<AtomicFileTransaction> {
  return createAtomicFileTransaction(options);
}

export async function exportFileSafely(options: SafeFileExportOptions): Promise<void> {
  const transaction = await createAtomicFileTransaction(options);
  try {
    await transaction.write(options.contents);
    await transaction.commit();
  } catch (error) {
    await transaction.rollbackAfterFailure(error);
  }
}

async function createAtomicFileTransaction({
  destination,
  protectedSources = [],
  remoteAuthority,
  fileSystem = nodeFileSystem,
  createTemporaryId = randomUUID
}: AtomicFileTransactionOptions): Promise<AtomicFileTransactionImplementation> {
  if (!supportedSchemes.has(destination.scheme)) {
    throw new Error("File export supports local and VS Code remote file-system destinations only.");
  }
  if (
    (destination.scheme === "vscode-remote" && (!remoteAuthority || destination.authority !== remoteAuthority)) ||
    (destination.scheme === "file" && remoteAuthority)
  ) {
    throw new Error("Choose an export destination on the current local host or VS Code remote authority.");
  }
  if (!destination.fsPath) throw new Error("Choose a concrete file-system destination for the export.");

  const protectedSourceAnchors = await captureProtectedSourceAnchors(fileSystem, protectedSources);
  const destinationAnchor = await captureDestinationAnchor(fileSystem, destination.fsPath, protectedSourceAnchors);
  await assertProtectedSourcesUnchanged(fileSystem, protectedSourceAnchors);
  await assertDestinationUnchanged(fileSystem, destinationAnchor);
  const resolvedDestination = destinationAnchor.canonicalPath;

  for (let attempt = 0; attempt < TEMPORARY_FILE_ATTEMPTS; attempt += 1) {
    const temporaryPath = path.join(
      path.dirname(resolvedDestination),
      `.openwrangler-${createTemporaryId()}-${attempt}.tmp`
    );
    let handle: AtomicExportHandle;
    try {
      handle = await fileSystem.openExclusive(temporaryPath);
    } catch (error) {
      if (isFileSystemError(error, "EEXIST")) continue;
      throw error;
    }
    if (!isUsableIdentity(handle.identity)) {
      const identityError = new Error(
        "The filesystem did not provide a usable identity for Open Wrangler's temporary export file; it was not published or removed."
      );
      try {
        await handle.close();
      } catch (closeError) {
        throw new AggregateError(
          [identityError, closeError],
          "File export failed and its temporary file could not be cleaned up completely."
        );
      }
      throw identityError;
    }
    return new AtomicFileTransactionImplementation({
      destinationAnchor,
      fileSystem,
      handle,
      protectedSourceAnchors,
      resolvedDestination,
      temporaryIdentity: { dev: handle.identity.dev, ino: handle.identity.ino },
      temporaryPath
    });
  }
  throw new Error("Could not reserve a unique sibling temporary file for the export.");
}

class AtomicFileTransactionImplementation implements AtomicFileTransaction {
  readonly temporaryPath: string;
  private readonly destinationAnchor: DestinationAnchor;
  private readonly fileSystem: AtomicExportFileSystem;
  private readonly protectedSourceAnchors: readonly ProtectedSourceAnchor[];
  private readonly resolvedDestination: string;
  private readonly temporaryIdentity: FileIdentity;
  private handle: AtomicExportHandle | undefined;
  private externalWriterPrepared = false;
  private settling = false;
  private state: "active" | "committed" | "rolledBack" | "abandoned" = "active";

  constructor({
    destinationAnchor,
    fileSystem,
    handle,
    protectedSourceAnchors,
    resolvedDestination,
    temporaryIdentity,
    temporaryPath
  }: {
    destinationAnchor: DestinationAnchor;
    fileSystem: AtomicExportFileSystem;
    handle: AtomicExportHandle;
    protectedSourceAnchors: readonly ProtectedSourceAnchor[];
    resolvedDestination: string;
    temporaryIdentity: FileIdentity;
    temporaryPath: string;
  }) {
    this.destinationAnchor = destinationAnchor;
    this.fileSystem = fileSystem;
    this.handle = handle;
    this.protectedSourceAnchors = protectedSourceAnchors;
    this.resolvedDestination = resolvedDestination;
    this.temporaryIdentity = temporaryIdentity;
    this.temporaryPath = temporaryPath;
  }

  async write(contents: Uint8Array): Promise<void> {
    this.assertActive();
    if (!this.handle) throw new Error("Open Wrangler's temporary export file is already closed.");
    await this.handle.write(contents);
  }

  async prepareExternalWriter(): Promise<AtomicExternalWriterTarget> {
    this.assertActive();
    if (this.externalWriterPrepared) {
      throw new Error("Open Wrangler's temporary export file is already prepared for an external writer.");
    }
    this.beginSettlement();
    try {
      if (!this.handle) throw new Error("Open Wrangler's temporary export file is already closed.");
      await this.handle.sync();
      await this.handle.close();
      this.handle = undefined;
      await assertKnownTemporary(this.fileSystem, this.temporaryPath, this.temporaryIdentity);
      this.externalWriterPrepared = true;
      return Object.freeze({
        path: this.temporaryPath,
        identity: Object.freeze({ ...this.temporaryIdentity })
      });
    } finally {
      this.settling = false;
    }
  }

  async commit(): Promise<void> {
    if (this.state === "committed") return;
    this.assertActive();
    this.beginSettlement();
    try {
      if (this.handle) {
        await this.handle.sync();
        await this.handle.close();
        this.handle = undefined;
      } else if (!this.externalWriterPrepared) {
        throw new Error("Open Wrangler's temporary export file is already closed.");
      }
      await assertKnownTemporary(this.fileSystem, this.temporaryPath, this.temporaryIdentity);
      await assertProtectedSourcesUnchanged(this.fileSystem, this.protectedSourceAnchors);
      await assertDestinationUnchanged(this.fileSystem, this.destinationAnchor);
      await assertKnownTemporary(this.fileSystem, this.temporaryPath, this.temporaryIdentity);
      await replaceAfterFinalValidation(
        this.fileSystem,
        this.temporaryPath,
        this.resolvedDestination,
        this.destinationAnchor
      );
      this.state = "committed";
    } finally {
      this.settling = false;
    }
  }

  async rollback(): Promise<void> {
    const cleanupErrors = await this.collectRollbackErrors();
    if (cleanupErrors.length > 0) {
      throw new AggregateError(cleanupErrors, "The atomic file transaction could not be rolled back completely.");
    }
  }

  async abandon(): Promise<void> {
    if (this.state === "abandoned") return;
    this.assertActive();
    this.beginSettlement();
    try {
      if (this.handle) {
        await this.handle.close();
        this.handle = undefined;
      }
      this.state = "abandoned";
    } finally {
      this.settling = false;
    }
  }

  async rollbackAfterFailure(error: unknown): Promise<never> {
    const cleanupErrors = await this.collectRollbackErrors();
    if (cleanupErrors.length > 0) {
      throw new AggregateError(
        [error, ...cleanupErrors],
        "File export failed and its temporary file could not be cleaned up completely."
      );
    }
    throw error;
  }

  private async collectRollbackErrors(): Promise<unknown[]> {
    if (this.state !== "active") return [];
    this.beginSettlement();
    const cleanupErrors: unknown[] = [];
    let handleClosed = !this.handle;
    let temporaryRemoved = false;
    try {
      if (this.handle) {
        try {
          await this.handle.close();
          this.handle = undefined;
          handleClosed = true;
        } catch (error) {
          cleanupErrors.push(error);
        }
      }
      try {
        await assertKnownTemporary(this.fileSystem, this.temporaryPath, this.temporaryIdentity);
        await this.fileSystem.remove(this.temporaryPath);
        temporaryRemoved = true;
      } catch (error) {
        if (isFileSystemError(error, "ENOENT")) {
          temporaryRemoved = true;
        } else {
          cleanupErrors.push(error);
        }
      }
      if (handleClosed && temporaryRemoved) this.state = "rolledBack";
      return cleanupErrors;
    } finally {
      this.settling = false;
    }
  }

  private assertActive(): void {
    if (this.state === "rolledBack") throw new Error("The atomic file transaction was already rolled back.");
    if (this.state === "committed") throw new Error("The atomic file transaction was already committed.");
    if (this.state === "abandoned") throw new Error("The atomic file transaction was already abandoned.");
  }

  private beginSettlement(): void {
    if (this.settling) throw new Error("The atomic file transaction is already being settled.");
    this.settling = true;
  }
}

async function captureProtectedSourceAnchors(
  fileSystem: AtomicExportFileSystem,
  protectedSources: readonly vscode.Uri[]
): Promise<ProtectedSourceAnchor[]> {
  const anchors: ProtectedSourceAnchor[] = [];
  for (const source of protectedSources) {
    if (!supportedSchemes.has(source.scheme) || !source.fsPath) continue;
    const identity = await optionalStat(fileSystem, source.fsPath);
    if (!identity || !isUsableIdentity(identity)) {
      throw new Error(
        "Open Wrangler could not establish a stable filesystem identity for the active source; nothing was exported."
      );
    }
    anchors.push({
      path: source.fsPath,
      canonicalPath: await canonicalPath(fileSystem, source.fsPath),
      identity
    });
  }
  return anchors;
}

async function assertProtectedSourcesUnchanged(
  fileSystem: AtomicExportFileSystem,
  anchors: readonly ProtectedSourceAnchor[]
): Promise<void> {
  for (const anchor of anchors) {
    const canonicalSource = await canonicalPath(fileSystem, anchor.path);
    const identity = await optionalStat(fileSystem, anchor.path);
    if (
      comparablePath(canonicalSource) !== comparablePath(anchor.canonicalPath) ||
      !identity ||
      !isUsableIdentity(identity) ||
      !sameIdentity(identity, anchor.identity)
    ) {
      throw new Error("A protected source changed while the file was being exported; nothing was published.");
    }
  }
}

async function captureDestinationAnchor(
  fileSystem: AtomicExportFileSystem,
  destination: string,
  protectedSources: readonly ProtectedSourceAnchor[]
): Promise<DestinationAnchor> {
  const entry = await optionalLstat(fileSystem, destination);
  const identity = await optionalStat(fileSystem, destination);
  if (Boolean(entry) !== Boolean(identity)) {
    throw destinationChangedError();
  }
  if (identity && !isUsableIdentity(identity)) {
    throw new Error(
      "Open Wrangler could not establish a stable filesystem identity for the existing export destination."
    );
  }

  const parentPath = path.dirname(path.resolve(destination));
  const parentIdentity = await optionalStat(fileSystem, parentPath);
  if (!parentIdentity || !isUsableIdentity(parentIdentity)) {
    throw new Error(
      "Open Wrangler could not establish a stable filesystem identity for the export destination folder."
    );
  }
  const anchor: DestinationAnchor = {
    path: destination,
    canonicalPath: await canonicalPath(fileSystem, destination),
    identity,
    parentPath,
    canonicalParentPath: await canonicalPath(fileSystem, parentPath),
    parentIdentity
  };

  assertDestinationDiffersFromSources(anchor, protectedSources);
  if (entry && (!entry.isFile || entry.isSymbolicLink)) {
    throw new Error("Choose a new or regular-file destination for the export.");
  }
  return anchor;
}

async function assertDestinationUnchanged(
  fileSystem: AtomicExportFileSystem,
  anchor: DestinationAnchor
): Promise<void> {
  const parentIdentity = await optionalStat(fileSystem, anchor.parentPath);
  const canonicalParentPath = await canonicalPath(fileSystem, anchor.parentPath);
  if (
    !parentIdentity ||
    !isUsableIdentity(parentIdentity) ||
    !sameIdentity(parentIdentity, anchor.parentIdentity) ||
    comparablePath(canonicalParentPath) !== comparablePath(anchor.canonicalParentPath)
  ) {
    throw destinationChangedError();
  }

  const entry = await optionalLstat(fileSystem, anchor.path);
  const identity = await optionalStat(fileSystem, anchor.path);
  if (
    (entry && (!entry.isFile || entry.isSymbolicLink)) ||
    Boolean(entry) !== Boolean(anchor.identity) ||
    Boolean(identity) !== Boolean(anchor.identity) ||
    (identity && (!isUsableIdentity(identity) || !sameIdentity(identity, anchor.identity!))) ||
    comparablePath(await canonicalPath(fileSystem, anchor.path)) !== comparablePath(anchor.canonicalPath)
  ) {
    throw destinationChangedError();
  }
}

function assertDestinationDiffersFromSources(
  destination: DestinationAnchor,
  protectedSources: readonly ProtectedSourceAnchor[]
): void {
  for (const source of protectedSources) {
    if (
      comparablePath(source.path) === comparablePath(destination.path) ||
      comparablePath(source.canonicalPath) === comparablePath(destination.canonicalPath) ||
      (destination.identity && sameIdentity(source.identity, destination.identity))
    ) {
      throw sourceCollisionError();
    }
  }
}

async function assertKnownTemporary(
  fileSystem: AtomicExportFileSystem,
  temporaryPath: string,
  expectedIdentity: { dev: bigint; ino: bigint }
): Promise<void> {
  if (!isUsableIdentity(expectedIdentity)) {
    throw new Error("Open Wrangler could not verify ownership of its temporary export file.");
  }
  const entry = await optionalLstat(fileSystem, temporaryPath);
  const identity = await optionalStat(fileSystem, temporaryPath);
  if (
    !entry ||
    !entry.isFile ||
    entry.isSymbolicLink ||
    !identity ||
    identity.dev !== expectedIdentity.dev ||
    identity.ino !== expectedIdentity.ino
  ) {
    throw new Error("Open Wrangler's temporary export file changed unexpectedly; it was not published or removed.");
  }
}

async function canonicalPath(fileSystem: AtomicExportFileSystem, target: string): Promise<string> {
  let current = path.resolve(target);
  const missingParts: string[] = [];
  while (true) {
    try {
      return path.join(await fileSystem.realpath(current), ...missingParts);
    } catch (error) {
      if (!isFileSystemError(error, "ENOENT")) throw error;
      const parent = path.dirname(current);
      if (parent === current) return path.resolve(target);
      missingParts.unshift(path.basename(current));
      current = parent;
    }
  }
}

async function optionalStat(fileSystem: AtomicExportFileSystem, target: string): Promise<FileIdentity | undefined> {
  try {
    return await fileSystem.stat(target);
  } catch (error) {
    if (isFileSystemError(error, "ENOENT")) return undefined;
    throw error;
  }
}

function isUsableIdentity(identity: FileIdentity): boolean {
  return identity.dev !== 0n || identity.ino !== 0n;
}

function sameIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

async function optionalLstat(
  fileSystem: AtomicExportFileSystem,
  target: string
): Promise<{ isFile: boolean; isSymbolicLink: boolean } | undefined> {
  try {
    return await fileSystem.lstat(target);
  } catch (error) {
    if (isFileSystemError(error, "ENOENT")) return undefined;
    throw error;
  }
}

function comparablePath(target: string): string {
  const normalized = path.resolve(target);
  return process.platform === "win32" ? normalized.toLocaleLowerCase("en-US") : normalized;
}

function sourceCollisionError(): Error {
  return new Error("Choose a separate export destination; Open Wrangler never overwrites the active source.");
}

function destinationChangedError(): Error {
  return new DestinationChangedError();
}

class DestinationChangedError extends Error {
  constructor(cause?: unknown) {
    super(
      "The selected export destination changed before it could be replaced safely.",
      cause === undefined ? undefined : { cause }
    );
    this.name = "DestinationChangedError";
  }
}

async function replaceAfterFinalValidation(
  fileSystem: AtomicExportFileSystem,
  temporaryPath: string,
  destinationPath: string,
  destinationAnchor: DestinationAnchor
): Promise<void> {
  try {
    await fileSystem.replace(temporaryPath, destinationPath);
  } catch (replaceError) {
    try {
      await assertDestinationUnchanged(fileSystem, destinationAnchor);
    } catch (validationError) {
      if (validationError instanceof DestinationChangedError) {
        throw new DestinationChangedError(replaceError);
      }
      throw new AggregateError(
        [replaceError, validationError],
        "File replacement failed and the destination state could not be verified."
      );
    }
    throw replaceError;
  }
}

function nodeHandle(handle: FileHandle, identity: AtomicExportHandle["identity"]): AtomicExportHandle {
  return {
    identity,
    write: async (contents) => handle.writeFile(contents),
    sync: async () => handle.sync(),
    close: async () => handle.close()
  };
}

function isFileSystemError(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}
