import { randomUUID } from "node:crypto";
import { lstatSync, renameSync, unlinkSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  assertEditorAcceptancePrivateRootReceipt,
  createEditorAcceptancePrivateRootReceipt
} from "./packaged-editor-orchestration.mjs";
import { assertRemoteWorkspaceFileReceipt, captureRemoteWorkspaceFileReceipt } from "./remote-workspace-provenance.mjs";

const OWNED_FILE_IDENTITY_LOST_CODE = "REMOTE_WORKSPACE_OWNED_FILE_IDENTITY_LOST";
const FILE_RECEIPT_KEYS_EXCEPT_CTIME = Object.freeze([
  "birthtimeNs",
  "dev",
  "gid",
  "ino",
  "mode",
  "mtimeNs",
  "nlink",
  "sha256",
  "size",
  "uid"
]);

export function createRemoteWorkspaceOwnedFileCleanupReceipt(path, { parentContainedBy } = {}) {
  if (typeof path !== "string" || !isAbsolute(path)) throw ownedFileIdentityLostError();
  const resolvedPath = resolve(path);
  const parentPath = dirname(resolvedPath);
  let parentReceipt;
  let fileReceipt;
  try {
    parentReceipt = createEditorAcceptancePrivateRootReceipt(parentPath, {
      ...(parentContainedBy === undefined ? {} : { containedBy: parentContainedBy })
    });
    fileReceipt = captureRemoteWorkspaceFileReceipt(resolvedPath);
    assertEditorAcceptancePrivateRootReceipt(parentReceipt);
    assertRemoteWorkspaceFileReceipt(resolvedPath, fileReceipt);
    assertEditorAcceptancePrivateRootReceipt(parentReceipt);
  } catch {
    throw ownedFileIdentityLostError();
  }
  return Object.freeze({ path: resolvedPath, parentReceipt, fileReceipt });
}

export function assertRemoteWorkspaceOwnedFileCleanupReceipt(receipt) {
  if (
    !receipt ||
    typeof receipt !== "object" ||
    Object.keys(receipt).sort().join(",") !== "fileReceipt,parentReceipt,path" ||
    typeof receipt.path !== "string" ||
    !isAbsolute(receipt.path) ||
    dirname(resolve(receipt.path)) !== receipt.parentReceipt?.path
  ) {
    throw ownedFileIdentityLostError();
  }
  try {
    assertEditorAcceptancePrivateRootReceipt(receipt.parentReceipt);
    assertRemoteWorkspaceFileReceipt(receipt.path, receipt.fileReceipt);
    assertEditorAcceptancePrivateRootReceipt(receipt.parentReceipt);
  } catch {
    throw ownedFileIdentityLostError();
  }
  return receipt.path;
}

export function removeRemoteWorkspaceOwnedFile(
  receipt,
  {
    processTreeVerifiedStopped = true,
    privatePathsVerified = true,
    moveToQuarantine = renameSync,
    beforeRemove,
    cleanupId = randomUUID
  } = {}
) {
  if (!processTreeVerifiedStopped || !privatePathsVerified) throw ownedFileIdentityLostError();
  const path = assertRemoteWorkspaceOwnedFileCleanupReceipt(receipt);
  const id = cleanupId();
  if (typeof id !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(id)) {
    throw ownedFileIdentityLostError();
  }
  const quarantinePath = join(receipt.parentReceipt.path, `.openwrangler-remove-${id}`);
  requireDirectChild(receipt.parentReceipt.path, quarantinePath);
  requireAbsent(quarantinePath);
  assertRemoteWorkspaceOwnedFileCleanupReceipt(receipt);
  try {
    moveToQuarantine(path, quarantinePath);
  } catch {
    throw ownedFileIdentityLostError();
  }

  let quarantinedReceipt;
  try {
    assertEditorAcceptancePrivateRootReceipt(receipt.parentReceipt);
    quarantinedReceipt = captureRemoteWorkspaceFileReceipt(quarantinePath);
    assertSameFileAcrossRename(receipt.fileReceipt, quarantinedReceipt);
    assertEditorAcceptancePrivateRootReceipt(receipt.parentReceipt);
    beforeRemove?.(quarantinePath);
    assertEditorAcceptancePrivateRootReceipt(receipt.parentReceipt);
    assertRemoteWorkspaceFileReceipt(quarantinePath, quarantinedReceipt);
    assertEditorAcceptancePrivateRootReceipt(receipt.parentReceipt);
  } catch {
    throw ownedFileIdentityLostError();
  }
  unlinkSync(quarantinePath);
}

function requireDirectChild(parent, candidate) {
  const relation = relative(parent, candidate);
  if (
    !relation ||
    relation === ".." ||
    relation.startsWith(`..${sep}`) ||
    isAbsolute(relation) ||
    relation.includes(sep)
  ) {
    throw ownedFileIdentityLostError();
  }
}

function requireAbsent(path) {
  try {
    lstatSync(path);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw ownedFileIdentityLostError();
  }
  throw ownedFileIdentityLostError();
}

function assertSameFileAcrossRename(before, after) {
  if (!before || !after || FILE_RECEIPT_KEYS_EXCEPT_CTIME.some((key) => before[key] !== after[key])) {
    throw ownedFileIdentityLostError();
  }
}

function ownedFileIdentityLostError() {
  const error = new Error("The Remote SSH owned file changed identity before verified cleanup.");
  error.code = OWNED_FILE_IDENTITY_LOST_CODE;
  error.details = Object.freeze({ phase: "cleanup", ownedFileIdentity: "lost" });
  return error;
}
