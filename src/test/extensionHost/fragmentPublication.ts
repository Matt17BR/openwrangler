import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  unlinkSync,
  writeFileSync,
  type BigIntStats
} from "node:fs";
import * as path from "node:path";
import { removeIdentifiedFile } from "./identifiedTemporary";

export const INSTALLED_PERFORMANCE_ARTIFACT_RECEIPT_PROTOCOL = "openwrangler-editor-acceptance-artifact-receipt-v1";
const MAX_PRIVATE_JSON_BYTES = 16 * 1024;

export interface InstalledPerformanceArtifactReceipt {
  protocol: typeof INSTALLED_PERFORMANCE_ARTIFACT_RECEIPT_PROTOCOL;
  bytes: number;
  sha256: string;
}

export interface InstalledPerformanceFragmentPublicationHooks {
  beforeLink?: (temporary: string, destination: string) => void;
  afterLink?: (temporary: string, destination: string) => void;
  afterPublishedOpen?: (destination: string) => void;
}

interface PublishedFragmentSnapshot {
  bytes: Buffer;
}

type FragmentStableMetadata = Pick<
  BigIntStats,
  "birthtimeNs" | "ctimeNs" | "dev" | "gid" | "ino" | "mode" | "mtimeNs" | "size" | "uid"
>;

export function sameInstalledPerformanceFragmentMetadata(
  actual: FragmentStableMetadata,
  expected: FragmentStableMetadata,
  { compareCtime = true }: { compareCtime?: boolean } = {}
): boolean {
  return (
    actual.dev === expected.dev &&
    actual.ino === expected.ino &&
    actual.size === expected.size &&
    actual.mtimeNs === expected.mtimeNs &&
    actual.birthtimeNs === expected.birthtimeNs &&
    actual.mode === expected.mode &&
    actual.uid === expected.uid &&
    actual.gid === expected.gid &&
    (!compareCtime || actual.ctimeNs === expected.ctimeNs)
  );
}

export function publishInstalledPerformanceFragment(
  destination: string,
  value: unknown,
  hooks: InstalledPerformanceFragmentPublicationHooks = {}
): InstalledPerformanceArtifactReceipt {
  mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
  const temporary = `${destination}.${process.pid}.${randomUUID()}.tmp`;
  const serialized = JSON.stringify(value, null, 2);
  if (typeof serialized !== "string") {
    throw new TypeError("The installed performance fragment must be JSON-serializable.");
  }
  const expectedBytes = Buffer.from(`${serialized}\n`, "utf8");
  if (expectedBytes.length === 0 || expectedBytes.length > MAX_PRIVATE_JSON_BYTES) {
    throw new Error("The installed performance fragment must contain at most 16 KiB of UTF-8 JSON.");
  }

  let descriptor: number | undefined;
  let temporaryIdentity: BigIntStats | undefined;
  let linked = false;
  let temporaryUnlinked = false;
  let published = false;
  let result: InstalledPerformanceArtifactReceipt | undefined;
  let operationError: unknown;
  try {
    descriptor = openSync(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
      0o600
    );
    temporaryIdentity = fstatSync(descriptor, { bigint: true });
    requireOwnedRegularFile(temporaryIdentity, 1n, "temporary");
    writeFileSync(descriptor, expectedBytes);
    fsyncSync(descriptor);
    const complete = fstatSync(descriptor, { bigint: true });
    requireSameFragmentOwnership(
      complete,
      temporaryIdentity,
      "The installed performance fragment temporary changed while it was written."
    );
    if (complete.size !== BigInt(expectedBytes.length)) {
      throw new Error("The installed performance fragment temporary has an invalid byte size.");
    }
    closeSync(descriptor);
    descriptor = undefined;

    const atPath = lstatSync(temporary, { bigint: true });
    requireSameFragmentFile(
      atPath,
      complete,
      1n,
      true,
      "The installed performance fragment temporary path changed before publication."
    );
    hooks.beforeLink?.(temporary, destination);
    linkSync(temporary, destination);
    linked = true;
    hooks.afterLink?.(temporary, destination);

    const linkedDestination = lstatSync(destination, { bigint: true });
    requireSameFragmentFile(
      linkedDestination,
      complete,
      2n,
      false,
      "The installed performance fragment destination changed during publication."
    );
    const linkedTemporary = lstatSync(temporary, { bigint: true });
    requireSameFragmentFile(
      linkedTemporary,
      linkedDestination,
      2n,
      true,
      "The installed performance fragment temporary changed during publication."
    );
    unlinkSync(temporary);
    temporaryUnlinked = true;

    const firstPublishedIdentity = lstatSync(destination, { bigint: true });
    requireSameFragmentFile(
      firstPublishedIdentity,
      linkedDestination,
      1n,
      false,
      "The installed performance fragment destination changed while its temporary link was retired."
    );
    const snapshot = readPublishedFragmentSnapshot(destination, firstPublishedIdentity, hooks);
    if (!snapshot.bytes.equals(expectedBytes)) {
      throw new Error("The installed performance fragment destination bytes changed during publication.");
    }
    result = Object.freeze({
      protocol: INSTALLED_PERFORMANCE_ARTIFACT_RECEIPT_PROTOCOL,
      bytes: snapshot.bytes.length,
      sha256: createHash("sha256").update(snapshot.bytes).digest("hex")
    });
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
      removeIdentifiedFile(destination, temporaryIdentity, {
        allowedLinkCounts: temporaryUnlinked ? [1n] : [1n, 2n],
        description: "published destination"
      });
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  if (!published && !temporaryUnlinked && temporaryIdentity !== undefined) {
    try {
      removeIdentifiedFile(temporary, temporaryIdentity, {
        allowedLinkCounts: [1n, 2n],
        description: "temporary"
      });
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  if (operationError !== undefined && cleanupErrors.length > 0) {
    throw new AggregateError(
      [operationError, ...cleanupErrors],
      "Installed performance fragment publication and identified-link cleanup both failed."
    );
  }
  if (operationError !== undefined) throw operationError;
  if (cleanupErrors.length === 1) throw cleanupErrors[0];
  if (cleanupErrors.length > 1) {
    throw new AggregateError(cleanupErrors, "Installed performance fragment identified-link cleanup failed.");
  }
  if (result === undefined) {
    throw new Error("Installed performance fragment publication completed without a receipt.");
  }
  return result;
}

function readPublishedFragmentSnapshot(
  destination: string,
  firstPublishedIdentity: BigIntStats,
  hooks: InstalledPerformanceFragmentPublicationHooks
): PublishedFragmentSnapshot {
  let descriptor: number | undefined;
  let result: PublishedFragmentSnapshot | undefined;
  let operationError: unknown;
  try {
    descriptor = openSync(destination, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    const opened = fstatSync(descriptor, { bigint: true });
    const namedBefore = lstatSync(destination, { bigint: true });
    requireSameFragmentFile(
      opened,
      firstPublishedIdentity,
      1n,
      true,
      "The installed performance fragment changed before its published descriptor was pinned."
    );
    requireSameFragmentFile(
      namedBefore,
      opened,
      1n,
      true,
      "The installed performance fragment path changed before its published descriptor was pinned."
    );
    if (
      opened.size <= 0n ||
      opened.size > BigInt(MAX_PRIVATE_JSON_BYTES) ||
      opened.size > BigInt(Number.MAX_SAFE_INTEGER)
    ) {
      throw new Error("The installed performance fragment destination has an invalid byte size.");
    }

    hooks.afterPublishedOpen?.(destination);
    const bytes = Buffer.alloc(Number(opened.size));
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(descriptor, bytes, offset, bytes.length - offset, offset);
      if (!Number.isSafeInteger(count) || count <= 0) {
        throw new Error("The installed performance fragment ended before its validated byte size.");
      }
      offset += count;
    }
    const completed = fstatSync(descriptor, { bigint: true });
    const namedAfter = lstatSync(destination, { bigint: true });
    requireSameFragmentFile(
      completed,
      opened,
      1n,
      true,
      "The installed performance fragment changed while its published descriptor was read."
    );
    requireSameFragmentFile(
      namedAfter,
      opened,
      1n,
      true,
      "The installed performance fragment path changed while its published descriptor was read."
    );
    result = Object.freeze({ bytes });
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
      "Installed performance fragment publication failed and its read descriptor could not close."
    );
  }
  if (operationError !== undefined) throw operationError;
  if (closeError !== undefined) throw closeError;
  if (result === undefined) {
    throw new Error("Installed performance fragment publication completed without a pinned snapshot.");
  }
  return result;
}

function requireOwnedRegularFile(identity: BigIntStats, expectedLinkCount: bigint, description: string): void {
  if (!identity.isFile() || identity.isSymbolicLink() || identity.nlink !== expectedLinkCount) {
    throw new Error(`The installed performance fragment ${description} must have its expected regular-file link.`);
  }
}

function requireSameFragmentOwnership(actual: BigIntStats, expected: BigIntStats, message: string): void {
  requireOwnedRegularFile(actual, 1n, "file");
  if (actual.dev !== expected.dev || actual.ino !== expected.ino) {
    throw new Error(message);
  }
}

function requireSameFragmentFile(
  actual: BigIntStats,
  expected: BigIntStats,
  expectedLinkCount: bigint,
  compareCtime: boolean,
  message: string
): void {
  requireOwnedRegularFile(actual, expectedLinkCount, "file");
  if (!sameInstalledPerformanceFragmentMetadata(actual, expected, { compareCtime })) {
    throw new Error(message);
  }
}
