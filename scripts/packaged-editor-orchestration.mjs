import { randomUUID } from "node:crypto";
import { lstatSync, realpathSync, renameSync, rmSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { clearEditorAcceptanceEvidence } from "./editor-acceptance-evidence.mjs";

const PRIVATE_ROOT_CLEANUP_WITHHELD_CODE = "EDITOR_PRIVATE_ROOT_CLEANUP_WITHHELD";
const PRIVATE_ROOT_IDENTITY_LOST_CODE = "EDITOR_PRIVATE_ROOT_IDENTITY_LOST";

export async function runPackagedEditorOrchestration(
  { evidenceRoot, run, retainFailure, cleanup, failureMessage = "Packaged editor acceptance failed." },
  { clearEvidence = clearEditorAcceptanceEvidence } = {}
) {
  return runWithRetainedFailure({
    run: async () => {
      clearEvidence(evidenceRoot);
      return run();
    },
    retainFailure,
    cleanup,
    failureMessage
  });
}

export async function runWithRetainedFailure({ run, retainFailure, cleanup, failureMessage }) {
  let value;
  let primaryError;
  let hasPrimaryError = false;
  const retentionErrors = [];
  let cleanupError;
  let hasCleanupError = false;

  try {
    value = await run();
  } catch (error) {
    primaryError = error;
    hasPrimaryError = true;
    try {
      await retainFailure(error, { stage: "run" });
    } catch (errorDuringRetention) {
      retentionErrors.push(errorDuringRetention);
    }
  }

  try {
    await cleanup();
  } catch (errorDuringCleanup) {
    cleanupError = errorDuringCleanup;
    hasCleanupError = true;
  }

  if (!hasPrimaryError && hasCleanupError) {
    try {
      await retainFailure(cleanupError, { stage: "cleanup" });
    } catch (errorDuringRetention) {
      retentionErrors.push(errorDuringRetention);
    }
    if (retentionErrors.length > 0) {
      throw new AggregateError(
        [cleanupError, ...retentionErrors],
        failureMessage ?? "Packaged editor acceptance cleanup failed and its evidence could not be retained."
      );
    }
    throw cleanupError;
  }

  if (hasPrimaryError) {
    if (hasCleanupError) {
      try {
        await retainFailure(cleanupError, { stage: "cleanup" });
      } catch (errorDuringRetention) {
        retentionErrors.push(errorDuringRetention);
      }
    }
    const secondaryErrors = [...retentionErrors, ...(hasCleanupError ? [cleanupError] : [])];
    if (secondaryErrors.length > 0) {
      throw new AggregateError(
        [primaryError, ...secondaryErrors],
        failureMessage ?? "Packaged editor acceptance failed during evidence retention or cleanup."
      );
    }
    throw primaryError;
  }
  return value;
}

export function packagedEditorFailureLeaves(error, seen = new Set()) {
  if (seen.has(error)) return [];
  seen.add(error);
  if (error instanceof AggregateError) {
    const leaves = error.errors.flatMap((nested) => packagedEditorFailureLeaves(nested, seen));
    // Empty and self-cyclic aggregates are still real failures. Retain the bounded
    // aggregate itself when traversal cannot produce a unique diagnostic leaf.
    return leaves.length > 0 ? leaves : [error];
  }
  return [error];
}

export function createEditorAcceptancePrivateRootReceipt(path, { containedBy } = {}) {
  if (typeof path !== "string" || !isAbsolute(path)) {
    throw new Error("An editor acceptance private root must be an absolute path.");
  }
  const resolvedPath = resolve(path);
  let metadata;
  let canonicalPath;
  let parentMetadata;
  let canonicalDirectoryParent;
  const parentPath = dirname(resolvedPath);
  try {
    metadata = privateRootMetadata(resolvedPath);
    canonicalPath = realpathSync(resolvedPath);
    parentMetadata = privateRootMetadata(parentPath);
    canonicalDirectoryParent = realpathSync(parentPath);
  } catch {
    throw privateRootIdentityLostError();
  }
  let canonicalParent;
  if (containedBy !== undefined) {
    if (typeof containedBy !== "string" || !isAbsolute(containedBy)) {
      throw new Error("An editor acceptance private-root parent must be an absolute path.");
    }
    try {
      canonicalParent = realpathSync(resolve(containedBy));
      requireContainedPrivateRoot(canonicalParent, canonicalPath);
    } catch {
      throw privateRootIdentityLostError();
    }
  }
  return Object.freeze({
    path: resolvedPath,
    canonicalPath,
    parentPath,
    canonicalDirectoryParent,
    parentSnapshot: Object.freeze(privateRootSnapshot(parentMetadata)),
    ...(canonicalParent === undefined ? {} : { canonicalParent }),
    snapshot: Object.freeze(privateRootSnapshot(metadata))
  });
}

export function assertEditorAcceptancePrivateRootReceipt(receipt) {
  if (
    !receipt ||
    typeof receipt !== "object" ||
    typeof receipt.path !== "string" ||
    typeof receipt.canonicalPath !== "string" ||
    typeof receipt.parentPath !== "string" ||
    typeof receipt.canonicalDirectoryParent !== "string" ||
    !receipt.parentSnapshot ||
    typeof receipt.parentSnapshot !== "object" ||
    !receipt.snapshot ||
    typeof receipt.snapshot !== "object"
  ) {
    throw privateRootIdentityLostError();
  }
  let metadata;
  let canonicalPath;
  let parentMetadata;
  let canonicalDirectoryParent;
  try {
    metadata = privateRootMetadata(receipt.path);
    canonicalPath = realpathSync(receipt.path);
    parentMetadata = privateRootMetadata(receipt.parentPath);
    canonicalDirectoryParent = realpathSync(receipt.parentPath);
  } catch {
    throw privateRootIdentityLostError();
  }
  if (
    canonicalPath !== receipt.canonicalPath ||
    !samePrivateRootSnapshot(privateRootSnapshot(metadata), receipt.snapshot) ||
    canonicalDirectoryParent !== receipt.canonicalDirectoryParent ||
    !samePrivateRootSnapshot(privateRootSnapshot(parentMetadata), receipt.parentSnapshot)
  ) {
    throw privateRootIdentityLostError();
  }
  if (receipt.canonicalParent !== undefined) {
    try {
      requireContainedPrivateRoot(receipt.canonicalParent, canonicalPath);
    } catch {
      throw privateRootIdentityLostError();
    }
  }
  return receipt.path;
}

export function removeEditorAcceptancePrivateRoot(
  receipt,
  {
    processTreeVerifiedStopped = true,
    privatePathsVerified = true,
    moveToQuarantine = renameSync,
    beforeRemove,
    cleanupId = randomUUID
  } = {}
) {
  if (!processTreeVerifiedStopped) {
    const error = new Error(
      "Private editor files were intentionally left untouched because the owning process tree could not be verified as stopped."
    );
    error.code = PRIVATE_ROOT_CLEANUP_WITHHELD_CODE;
    error.details = {
      phase: "cleanup",
      treeVerifiedStopped: false,
      privateRootCleanup: "withheld"
    };
    throw error;
  }
  if (!privatePathsVerified) throw privateRootIdentityLostError();
  const path = assertEditorAcceptancePrivateRootReceipt(receipt);
  const id = cleanupId();
  if (typeof id !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(id)) {
    throw privateRootIdentityLostError();
  }
  const quarantinePath = join(receipt.parentPath, `.openwrangler-remove-${id}`);
  requireDirectPrivateRootChild(receipt.parentPath, quarantinePath);
  requireAbsentPrivateRootPath(quarantinePath);
  assertEditorAcceptancePrivateRootReceipt(receipt);
  try {
    moveToQuarantine(path, quarantinePath);
  } catch {
    throw privateRootIdentityLostError();
  }
  assertQuarantinedPrivateRootReceipt(receipt, quarantinePath);
  beforeRemove?.(quarantinePath);
  assertQuarantinedPrivateRootReceipt(receipt, quarantinePath);
  // The original public pathname is no longer used for deletion. Recursive
  // cleanup targets one unadvertised, random sibling whose post-rename
  // identity is still the captured private root.
  rmSync(quarantinePath, { recursive: true, force: true });
}

export function editorAcceptancePrivateRootIdentityLost(error, seen = new Set()) {
  if ((typeof error !== "object" && typeof error !== "function") || error === null || seen.has(error)) return false;
  seen.add(error);
  if (error.code === PRIVATE_ROOT_IDENTITY_LOST_CODE || error.details?.privateRootIdentity === "lost") return true;
  if (error instanceof AggregateError) {
    for (const nested of error.errors) {
      if (editorAcceptancePrivateRootIdentityLost(nested, seen)) return true;
    }
  }
  return "cause" in error && editorAcceptancePrivateRootIdentityLost(error.cause, seen);
}

function privateRootMetadata(path) {
  const metadata = lstatSync(path, { bigint: true });
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw privateRootIdentityLostError();
  return metadata;
}

function privateRootSnapshot(metadata) {
  return {
    dev: metadata.dev,
    ino: metadata.ino,
    mode: metadata.mode,
    birthtimeNs: metadata.birthtimeNs
  };
}

function samePrivateRootSnapshot(left, right) {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.birthtimeNs === right.birthtimeNs
  );
}

function requireContainedPrivateRoot(parent, candidate) {
  const relation = relative(parent, candidate);
  if (!relation || relation === ".." || relation.startsWith(`..${sep}`) || isAbsolute(relation)) {
    throw new Error("An editor acceptance private root must remain inside its captured parent.");
  }
}

function requireDirectPrivateRootChild(parent, candidate) {
  const relation = relative(parent, candidate);
  if (
    !relation ||
    relation === ".." ||
    relation.startsWith(`..${sep}`) ||
    isAbsolute(relation) ||
    relation.includes(sep)
  ) {
    throw privateRootIdentityLostError();
  }
}

function requireAbsentPrivateRootPath(path) {
  try {
    lstatSync(path);
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") return;
    throw privateRootIdentityLostError();
  }
  throw privateRootIdentityLostError();
}

function assertQuarantinedPrivateRootReceipt(receipt, quarantinePath) {
  let metadata;
  let canonicalPath;
  let parentMetadata;
  let canonicalDirectoryParent;
  try {
    metadata = privateRootMetadata(quarantinePath);
    canonicalPath = realpathSync(quarantinePath);
    parentMetadata = privateRootMetadata(receipt.parentPath);
    canonicalDirectoryParent = realpathSync(receipt.parentPath);
  } catch {
    throw privateRootIdentityLostError();
  }
  requireDirectPrivateRootChild(receipt.parentPath, quarantinePath);
  if (
    dirname(canonicalPath) !== receipt.canonicalDirectoryParent ||
    canonicalDirectoryParent !== receipt.canonicalDirectoryParent ||
    !samePrivateRootSnapshot(privateRootSnapshot(metadata), receipt.snapshot) ||
    !samePrivateRootSnapshot(privateRootSnapshot(parentMetadata), receipt.parentSnapshot)
  ) {
    throw privateRootIdentityLostError();
  }
  return quarantinePath;
}

function privateRootIdentityLostError() {
  const error = new Error(
    "Private editor files were intentionally left untouched because their captured filesystem identity was lost."
  );
  error.code = PRIVATE_ROOT_IDENTITY_LOST_CODE;
  error.details = {
    phase: "cleanup",
    privateRootCleanup: "withheld",
    privateRootIdentity: "lost"
  };
  return error;
}
