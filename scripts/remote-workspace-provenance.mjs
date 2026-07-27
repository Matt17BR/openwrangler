import { createHash } from "node:crypto";
import { chmodSync, closeSync, constants, copyFileSync, fstatSync, lstatSync, openSync, readSync } from "node:fs";
import { REMOTE_WORKSPACE_MAX_CANDIDATE_BYTES } from "./remote-workspace-contract.mjs";

const FILE_SNAPSHOT_KEYS = Object.freeze([
  "birthtimeNs",
  "ctimeNs",
  "dev",
  "gid",
  "ino",
  "mode",
  "mtimeNs",
  "nlink",
  "size",
  "uid"
]);
const FILE_RECEIPT_KEYS = Object.freeze([...FILE_SNAPSHOT_KEYS, "sha256"].sort());
const MAXIMUM_RECEIPT_BYTES = 4 * 1024 * 1024 * 1024;

export function acceptRemoteWorkspaceCandidate(path, expectation) {
  const receipt = captureRemoteWorkspaceFileReceipt(path);
  assertExpectedCandidate(receipt, expectation, "did not match");
  return receipt;
}

export function assertRemoteWorkspaceCandidateReceipt(path, receipt, expectation) {
  const current = assertRemoteWorkspaceFileReceipt(path, receipt);
  assertExpectedCandidate(current, expectation, "changed after");
  return current;
}

export function stageRemoteWorkspaceCandidate(source, destination, sourceReceipt, expectation) {
  assertRemoteWorkspaceCandidateReceipt(source, sourceReceipt, expectation);
  copyFileSync(source, destination, constants.COPYFILE_EXCL);
  chmodSync(destination, 0o600);
  assertRemoteWorkspaceCandidateReceipt(source, sourceReceipt, expectation);
  return acceptRemoteWorkspaceCandidate(destination, expectation);
}

export function captureRemoteWorkspaceFileReceipt(
  path,
  { allowEmpty = false, maximumBytes = REMOTE_WORKSPACE_MAX_CANDIDATE_BYTES } = {}
) {
  if (
    typeof allowEmpty !== "boolean" ||
    !Number.isSafeInteger(maximumBytes) ||
    maximumBytes <= 0 ||
    maximumBytes > MAXIMUM_RECEIPT_BYTES
  ) {
    throw new Error("Remote SSH acceptance requires one fixed bounded receipt-file policy.");
  }
  let descriptor;
  try {
    descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  } catch (error) {
    throw new Error("Remote SSH acceptance requires one bounded no-follow regular receipt file.", {
      cause: error
    });
  }
  try {
    const openedMetadata = fstatSync(descriptor, { bigint: true });
    if (
      !openedMetadata.isFile() ||
      openedMetadata.isSymbolicLink() ||
      openedMetadata.nlink !== 1n ||
      openedMetadata.size < (allowEmpty ? 0n : 1n) ||
      openedMetadata.size > BigInt(maximumBytes)
    ) {
      throw new Error("Remote SSH acceptance requires one bounded no-follow regular receipt file.");
    }
    const opened = fileReceiptSnapshot(openedMetadata);
    const namedBefore = lstatSync(path, { bigint: true });
    if (
      !namedBefore.isFile() ||
      namedBefore.isSymbolicLink() ||
      !sameFileReceiptSnapshot(fileReceiptSnapshot(namedBefore), opened)
    ) {
      throw new Error("A Remote SSH receipt path changed before it could be opened.");
    }
    const digest = createHash("sha256");
    const buffer = Buffer.alloc(64 * 1024);
    let bytesReadTotal = 0;
    while (true) {
      const bytesRead = readSync(descriptor, buffer, 0, buffer.length, null);
      if (!Number.isSafeInteger(bytesRead) || bytesRead < 0) {
        throw new Error("A Remote SSH receipt read returned an invalid byte count.");
      }
      if (bytesRead === 0) break;
      bytesReadTotal += bytesRead;
      if (bytesReadTotal > Number(opened.size) || bytesReadTotal > maximumBytes) {
        throw new Error("A Remote SSH receipt file exceeded its pinned read bound.");
      }
      digest.update(buffer.subarray(0, bytesRead));
    }
    if (bytesReadTotal !== Number(opened.size)) {
      throw new Error("A Remote SSH receipt file ended before its pinned byte size.");
    }
    const completed = fileReceiptSnapshot(fstatSync(descriptor, { bigint: true }));
    const namedAfter = lstatSync(path, { bigint: true });
    if (
      !sameFileReceiptSnapshot(opened, completed) ||
      !sameFileReceiptSnapshot(opened, fileReceiptSnapshot(namedAfter))
    ) {
      throw new Error("A Remote SSH receipt file changed while it was hashed.");
    }
    return Object.freeze({ ...opened, sha256: digest.digest("hex") });
  } finally {
    closeSync(descriptor);
  }
}

export function assertRemoteWorkspaceFileReceipt(path, receipt, policy) {
  const current = captureRemoteWorkspaceFileReceipt(path, policy);
  if (
    !receipt ||
    current.sha256 !== receipt?.sha256 ||
    !sameFileReceiptSnapshot(current, receipt) ||
    Object.keys(receipt).sort().join(",") !== FILE_RECEIPT_KEYS.join(",")
  ) {
    throw new Error("A Remote SSH receipt file changed after its identity was pinned.");
  }
  return current;
}

function assertExpectedCandidate(receipt, expectation, verb) {
  if (!expectation || receipt.sha256 !== expectation.sha256 || receipt.size !== BigInt(expectation.bytes)) {
    throw new Error(`The Remote SSH candidate ${verb} its caller-supplied size and SHA-256 receipt.`);
  }
}

function fileReceiptSnapshot(metadata) {
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

function sameFileReceiptSnapshot(left, right) {
  return left !== undefined && right !== undefined && FILE_SNAPSHOT_KEYS.every((key) => left[key] === right[key]);
}
