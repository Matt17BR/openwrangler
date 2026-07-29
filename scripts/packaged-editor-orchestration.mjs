import { randomUUID } from "node:crypto";
import { lstatSync, realpathSync, renameSync, rmSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { clearEditorAcceptanceEvidence } from "./editor-acceptance-evidence.mjs";

const PRIVATE_ROOT_CLEANUP_WITHHELD_CODE = "EDITOR_PRIVATE_ROOT_CLEANUP_WITHHELD";
const PRIVATE_ROOT_IDENTITY_LOST_CODE = "EDITOR_PRIVATE_ROOT_IDENTITY_LOST";
const WINDOWS_QUARANTINE_MOVE_RETRY_DELAYS_MS = Object.freeze([250, 500, 1_000, 2_000, 4_000, 8_000]);
const WINDOWS_QUARANTINE_MOVE_RETRY_ERRORS = new Set(["EACCES", "EBUSY", "EPERM"]);
const WINDOWS_QUARANTINE_MOVE_RETRY_STATE = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
const PRIVATE_ROOT_IDENTITY_CHECKPOINTS = new Set([
  "capture-metadata",
  "capture-containment",
  "receipt-shape",
  "receipt-read",
  "receipt-mismatch",
  "receipt-containment",
  "cleanup-already-unverified",
  "quarantine-id",
  "quarantine-path",
  "quarantine-absence",
  "source-recheck",
  "quarantine-move",
  "post-move-attestation",
  "pre-delete-attestation",
  "quarantine-delete",
  "evidence-staging-identity",
  "unclassified"
]);
const PRIVATE_ROOT_IDENTITY_SCOPES = new Set([
  "evidence-staging",
  "temporary-root",
  "orchestration-profile",
  "editor-profile",
  "jupyter-kernel",
  "cursor-acquisition",
  "display-runtime",
  "orchestration-evidence",
  "orchestration"
]);
const PRIVATE_ROOT_IDENTITY_EDITORS = new Set(["vscode", "cursor", "orchestration"]);
const PRIVATE_ROOT_IDENTITY_ORIGIN_PHASES = new Set([
  "setup",
  "restricted",
  "platform-smoke",
  "python-environment",
  "jupyter-deny",
  "jupyter-allow",
  "jupyter-pyspark",
  "jupyter-remote-setup",
  "jupyter-remote",
  "jupyter-remote-cleanup",
  "seed",
  "verify"
]);

export async function runPackagedEditorOrchestration(
  { evidenceRoot, run, retainFailure, cleanup, failureMessage = "Packaged editor acceptance failed." },
  {
    clearEvidence = clearEditorAcceptanceEvidence,
    finalizeSuccess = async () => undefined,
    reportSuccess = () => undefined
  } = {}
) {
  const value = await runWithRetainedFailure({
    run: async () => {
      clearEvidence(evidenceRoot);
      return run();
    },
    retainFailure,
    cleanup,
    failureMessage
  });
  await finalizeSuccess(value);
  reportSuccess(value);
  return value;
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

export async function cleanupPackagedCursorAcquisition(
  acquisition,
  { processTreeVerifiedStopped, privatePathsVerified } = {}
) {
  if (typeof processTreeVerifiedStopped !== "boolean") {
    throw new Error("Packaged Cursor cleanup requires one explicit process-tree ownership decision.");
  }
  if (typeof privatePathsVerified !== "boolean") {
    throw new Error("Packaged Cursor cleanup requires one explicit private-path identity decision.");
  }
  if (!privatePathsVerified) {
    return Object.freeze({ cleaned: false, withheld: true });
  }
  if (!processTreeVerifiedStopped) {
    return Object.freeze({ cleaned: false, withheld: acquisition !== undefined });
  }
  if (acquisition === undefined) return Object.freeze({ cleaned: false, withheld: false });
  if (!acquisition || typeof acquisition !== "object" || typeof acquisition.cleanup !== "function") {
    throw new Error("Packaged Cursor cleanup received a malformed private acquisition.");
  }
  await acquisition.cleanup();
  return Object.freeze({ cleaned: true, withheld: false });
}

export function packagedEditorFailureLeaves(error, seen = new Set()) {
  return [...packagedEditorFailureLeafIterator(error, seen)];
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
    throw privateRootIdentityLostError("capture-metadata");
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
      throw privateRootIdentityLostError("capture-containment");
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
    throw privateRootIdentityLostError("receipt-shape");
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
    throw privateRootIdentityLostError("receipt-read");
  }
  if (
    canonicalPath !== receipt.canonicalPath ||
    !samePrivateRootSnapshot(privateRootSnapshot(metadata), receipt.snapshot) ||
    canonicalDirectoryParent !== receipt.canonicalDirectoryParent ||
    !samePrivateRootSnapshot(privateRootSnapshot(parentMetadata), receipt.parentSnapshot)
  ) {
    throw privateRootIdentityLostError("receipt-mismatch");
  }
  if (receipt.canonicalParent !== undefined) {
    try {
      requireContainedPrivateRoot(receipt.canonicalParent, canonicalPath);
    } catch {
      throw privateRootIdentityLostError("receipt-containment");
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
    removeQuarantine = rmSync,
    quarantinePathFor = (parentPath, id) => join(parentPath, `.openwrangler-remove-${id}`),
    beforeRemove,
    cleanupId = randomUUID,
    platform = process.platform,
    waitForQuarantineMoveRetry = waitForWindowsQuarantineMoveRetry
  } = {}
) {
  if (!processTreeVerifiedStopped) throw privateRootCleanupWithheldError();
  if (!privatePathsVerified) throw privateRootIdentityLostError("cleanup-already-unverified");
  const path = assertEditorAcceptancePrivateRootReceipt(receipt);
  const id = cleanupId();
  if (typeof id !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(id)) {
    throw privateRootIdentityLostError("quarantine-id");
  }
  let quarantinePath;
  try {
    quarantinePath = quarantinePathFor(receipt.parentPath, id);
  } catch {
    throw privateRootIdentityLostError("quarantine-path");
  }
  if (typeof quarantinePath !== "string" || !isAbsolute(quarantinePath)) {
    throw privateRootIdentityLostError("quarantine-path");
  }
  requireDirectPrivateRootChild(receipt.parentPath, quarantinePath, "quarantine-path");
  requireAbsentPrivateRootPath(quarantinePath, "quarantine-absence");
  try {
    assertEditorAcceptancePrivateRootReceipt(receipt);
  } catch {
    throw privateRootIdentityLostError("source-recheck");
  }
  movePrivateRootToQuarantine(receipt, path, quarantinePath, {
    moveToQuarantine,
    platform,
    waitForQuarantineMoveRetry
  });
  try {
    assertQuarantinedPrivateRootReceipt(receipt, quarantinePath);
  } catch {
    throw privateRootIdentityLostError("post-move-attestation");
  }
  beforeRemove?.(quarantinePath);
  try {
    assertQuarantinedPrivateRootReceipt(receipt, quarantinePath);
  } catch {
    throw privateRootIdentityLostError("pre-delete-attestation");
  }
  // The original public pathname is no longer used for deletion. Recursive
  // cleanup targets one unadvertised, random sibling whose post-rename
  // identity is still the captured private root.
  try {
    removeQuarantine(quarantinePath, { recursive: true, force: true });
  } catch {
    throw privateRootIdentityLostError("quarantine-delete");
  }
}

function movePrivateRootToQuarantine(
  receipt,
  path,
  quarantinePath,
  { moveToQuarantine, platform, waitForQuarantineMoveRetry }
) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      moveToQuarantine(path, quarantinePath);
      return;
    } catch (error) {
      if (
        platform !== "win32" ||
        !WINDOWS_QUARANTINE_MOVE_RETRY_ERRORS.has(error?.code) ||
        attempt >= WINDOWS_QUARANTINE_MOVE_RETRY_DELAYS_MS.length
      ) {
        throw privateRootIdentityLostError("quarantine-move");
      }
    }

    revalidatePrivateRootMoveRetry(receipt, quarantinePath);
    try {
      waitForQuarantineMoveRetry(WINDOWS_QUARANTINE_MOVE_RETRY_DELAYS_MS[attempt]);
    } catch {
      throw privateRootIdentityLostError("quarantine-move");
    }
    revalidatePrivateRootMoveRetry(receipt, quarantinePath);
  }
}

function revalidatePrivateRootMoveRetry(receipt, quarantinePath) {
  requireAbsentPrivateRootPath(quarantinePath, "quarantine-absence");
  try {
    assertEditorAcceptancePrivateRootReceipt(receipt);
  } catch {
    throw privateRootIdentityLostError("source-recheck");
  }
}

function waitForWindowsQuarantineMoveRetry(delayMs) {
  if (Atomics.wait(WINDOWS_QUARANTINE_MOVE_RETRY_STATE, 0, 0, delayMs) !== "timed-out") {
    throw new Error("The Windows quarantine-move retry wait ended unexpectedly.");
  }
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

export function editorAcceptancePrivateRootIdentityLossDetails(error, seen = new Set()) {
  if ((typeof error !== "object" && typeof error !== "function") || error === null || seen.has(error)) {
    return undefined;
  }
  seen.add(error);
  if (error.code === PRIVATE_ROOT_IDENTITY_LOST_CODE || error.details?.privateRootIdentity === "lost") {
    const checkpoint = PRIVATE_ROOT_IDENTITY_CHECKPOINTS.has(error.details?.privateRootCheckpoint)
      ? error.details.privateRootCheckpoint
      : "unclassified";
    return Object.freeze({ checkpoint });
  }
  if (error instanceof AggregateError) {
    for (const nested of error.errors) {
      const details = editorAcceptancePrivateRootIdentityLossDetails(nested, seen);
      if (details) return details;
    }
  }
  return "cause" in error ? editorAcceptancePrivateRootIdentityLossDetails(error.cause, seen) : undefined;
}

export function createEditorAcceptancePrivatePathIdentityLatch({ reporter = console.error } = {}) {
  if (typeof reporter !== "function") {
    throw new Error("Private-path identity reporting requires one callable reporter.");
  }
  let firstLoss;
  let reported = false;
  return Object.freeze({
    latch(error, context) {
      if (firstLoss !== undefined) return true;
      const details = editorAcceptancePrivateRootIdentityLossDetails(error);
      if (!details) return false;
      const scope = context?.scope ?? "orchestration";
      const editor = context?.editor ?? "orchestration";
      const cleanupOfPhase = context?.cleanupOfPhase ?? "setup";
      if (
        !PRIVATE_ROOT_IDENTITY_SCOPES.has(scope) ||
        !PRIVATE_ROOT_IDENTITY_EDITORS.has(editor) ||
        !PRIVATE_ROOT_IDENTITY_ORIGIN_PHASES.has(cleanupOfPhase)
      ) {
        throw new Error("Private-path identity loss requires fixed scope, editor, and phase classifiers.");
      }
      firstLoss = Object.freeze({
        scope,
        editor,
        phase: "cleanup",
        cleanupOfPhase,
        checkpoint: details.checkpoint
      });
      return true;
    },
    isVerified() {
      return firstLoss === undefined;
    },
    details() {
      return firstLoss;
    },
    reportWithheld() {
      if (!firstLoss || reported) return false;
      reported = true;
      reporter(
        `Packaged-editor diagnostics were withheld because private-path identity is unverified (scope=${firstLoss.scope}, editor=${firstLoss.editor}, phase=${firstLoss.phase}, cleanupOfPhase=${firstLoss.cleanupOfPhase}, checkpoint=${firstLoss.checkpoint}).`
      );
      return true;
    },
    publishIfSafe(
      { processTreeMayBeLive, evidenceCollectionSafe, hasTemporaryRootReceipt, evidenceReceiptCount },
      publish
    ) {
      if (
        typeof processTreeMayBeLive !== "boolean" ||
        typeof evidenceCollectionSafe !== "boolean" ||
        typeof hasTemporaryRootReceipt !== "boolean" ||
        !Number.isSafeInteger(evidenceReceiptCount) ||
        evidenceReceiptCount < 0 ||
        typeof publish !== "function"
      ) {
        throw new Error("Private-path evidence publication requires one fixed safety context.");
      }
      if (
        processTreeMayBeLive ||
        firstLoss !== undefined ||
        !evidenceCollectionSafe ||
        !hasTemporaryRootReceipt ||
        evidenceReceiptCount === 0
      ) {
        return undefined;
      }
      return publish();
    }
  });
}

export function createEditorAcceptancePrivatePathSafetyPolicy({ identityLatch, processTreeMayBeLive } = {}) {
  if (
    !identityLatch ||
    typeof identityLatch.isVerified !== "function" ||
    typeof identityLatch.publishIfSafe !== "function" ||
    typeof processTreeMayBeLive !== "function"
  ) {
    throw new Error("Private-path terminal safety requires one identity latch and process-ownership reader.");
  }
  const verifiedState = () => {
    if (!identityLatch.isVerified()) {
      return Object.freeze({ privatePathsVerified: false, processTreeMayBeLive: true });
    }
    const treeMayBeLive = processTreeMayBeLive();
    if (typeof treeMayBeLive !== "boolean") {
      throw new Error("Private-path terminal safety requires one boolean process-ownership decision.");
    }
    return Object.freeze({ privatePathsVerified: true, processTreeMayBeLive: treeMayBeLive });
  };
  return Object.freeze({
    displayStopOptions() {
      const state = verifiedState();
      return Object.freeze({
        preservePrivateFiles: state.processTreeMayBeLive || !state.privatePathsVerified
      });
    },
    runCleanupIfSafe(cleanup) {
      if (!identityLatch.isVerified()) return false;
      if (typeof cleanup !== "function") {
        throw new Error("Private-path cleanup requires one callback.");
      }
      const state = verifiedState();
      if (state.processTreeMayBeLive) return false;
      cleanup();
      return true;
    },
    runRequired(action) {
      if (!identityLatch.isVerified()) {
        throw privateRootIdentityLostError("cleanup-already-unverified");
      }
      if (typeof action !== "function") {
        throw new Error("Private-path finalization requires one callback.");
      }
      const state = verifiedState();
      if (state.processTreeMayBeLive) throw privateRootCleanupWithheldError();
      return action();
    },
    failureOwnershipMayBeUnsafe(error, inspectProcessOwnership) {
      if (!identityLatch.isVerified()) return true;
      if (typeof inspectProcessOwnership !== "function") {
        throw new Error("Failure ownership classification requires one inspector.");
      }
      const result = inspectProcessOwnership(error);
      if (typeof result !== "boolean") {
        throw new Error("Failure ownership classification requires one boolean decision.");
      }
      return result;
    },
    publishIfSafe(context, publish) {
      if (!identityLatch.isVerified()) return undefined;
      const state = verifiedState();
      return identityLatch.publishIfSafe(
        {
          ...context,
          processTreeMayBeLive: state.processTreeMayBeLive
        },
        publish
      );
    }
  });
}

export function retainPackagedEditorFailureLeaves(
  error,
  {
    handledFailures,
    retainLeaf,
    identityLatch,
    identityContext,
    onIdentityWithheld = () => undefined,
    onRetentionError = () => undefined,
    failureMessage = "Multiple packaged-editor diagnostics could not be retained."
  } = {}
) {
  if (!(handledFailures instanceof Set) || typeof retainLeaf !== "function") {
    throw new Error("Packaged-editor failure retention requires a handled set and leaf callback.");
  }
  if (!identityLatch || typeof identityLatch.isVerified !== "function" || typeof identityLatch.latch !== "function") {
    throw new Error("Packaged-editor failure retention requires one private-path identity latch.");
  }
  if (!identityLatch.isVerified()) {
    handledFailures.add(error);
    onIdentityWithheld();
    return;
  }
  const retentionErrors = [];
  for (const leaf of packagedEditorFailureLeafIterator(error)) {
    if (!identityLatch.isVerified()) {
      handledFailures.add(error);
      onIdentityWithheld();
      break;
    }
    try {
      retainLeaf(leaf);
      handledFailures.add(leaf);
    } catch (retentionError) {
      const identityLost = identityLatch.latch(retentionError, identityContext);
      onRetentionError(retentionError, { identityLost });
      retentionErrors.push(retentionError);
      if (identityLost) {
        handledFailures.add(leaf);
        handledFailures.add(error);
        onIdentityWithheld();
        break;
      }
    }
  }
  if (retentionErrors.length === 1) throw retentionErrors[0];
  if (retentionErrors.length > 1) {
    throw new AggregateError(retentionErrors, failureMessage);
  }
}

function* packagedEditorFailureLeafIterator(error, seen = new Set()) {
  if (seen.has(error)) return;
  seen.add(error);
  if (!(error instanceof AggregateError)) {
    yield error;
    return;
  }
  let yielded = false;
  for (const nested of error.errors) {
    for (const leaf of packagedEditorFailureLeafIterator(nested, seen)) {
      yielded = true;
      yield leaf;
    }
  }
  // Empty, self-cyclic, and duplicate-only aggregates are still real failures.
  if (!yielded) yield error;
}

function privateRootMetadata(path) {
  const metadata = lstatSync(path, { bigint: true });
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw privateRootIdentityLostError("receipt-read");
  }
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

function requireDirectPrivateRootChild(parent, candidate, checkpoint = "quarantine-path") {
  const relation = relative(parent, candidate);
  if (
    !relation ||
    relation === ".." ||
    relation.startsWith(`..${sep}`) ||
    isAbsolute(relation) ||
    relation.includes(sep)
  ) {
    throw privateRootIdentityLostError(checkpoint);
  }
}

function requireAbsentPrivateRootPath(path, checkpoint = "quarantine-absence") {
  try {
    lstatSync(path);
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") return;
    throw privateRootIdentityLostError(checkpoint);
  }
  throw privateRootIdentityLostError(checkpoint);
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
    throw privateRootIdentityLostError("post-move-attestation");
  }
  requireDirectPrivateRootChild(receipt.parentPath, quarantinePath, "post-move-attestation");
  if (
    dirname(canonicalPath) !== receipt.canonicalDirectoryParent ||
    canonicalDirectoryParent !== receipt.canonicalDirectoryParent ||
    !samePrivateRootSnapshot(privateRootSnapshot(metadata), receipt.snapshot) ||
    !samePrivateRootSnapshot(privateRootSnapshot(parentMetadata), receipt.parentSnapshot)
  ) {
    throw privateRootIdentityLostError("post-move-attestation");
  }
  return quarantinePath;
}

function privateRootIdentityLostError(checkpoint) {
  if (!PRIVATE_ROOT_IDENTITY_CHECKPOINTS.has(checkpoint)) {
    throw new Error("Private-root identity loss requires one fixed checkpoint.");
  }
  const deletionCompletionUnverified = checkpoint === "quarantine-delete";
  const error = new Error(
    deletionCompletionUnverified
      ? "Private editor cleanup completion could not be verified; no further private-path access was attempted."
      : "Private editor files were intentionally left untouched because their captured filesystem identity was lost."
  );
  error.code = PRIVATE_ROOT_IDENTITY_LOST_CODE;
  error.details = {
    phase: "cleanup",
    privateRootCleanup: deletionCompletionUnverified ? "uncertain" : "withheld",
    privateRootIdentity: "lost",
    privateRootCheckpoint: checkpoint
  };
  return error;
}

function privateRootCleanupWithheldError() {
  const error = new Error(
    "Private editor files were intentionally left untouched because the owning process tree could not be verified as stopped."
  );
  error.code = PRIVATE_ROOT_CLEANUP_WITHHELD_CODE;
  error.details = {
    phase: "cleanup",
    treeVerifiedStopped: false,
    privateRootCleanup: "withheld"
  };
  return error;
}
