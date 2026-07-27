import { spawn } from "node:child_process";
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, readdirSync } from "node:fs";

const DISPLAY_LOCK_MAX_BYTES = 32n;

export function spawnMonitoredRemoteWorkspaceChild(label, executable, args, options, { spawnProcess = spawn } = {}) {
  if (typeof label !== "string" || !label || typeof spawnProcess !== "function") {
    throw new Error("Remote workspace child monitoring requires one bounded process label.");
  }
  const child = spawnProcess(executable, args, options);
  let processError;
  let closed = false;
  let closeResult;
  let resolveClosed;
  const closedPromise = new Promise((resolve) => {
    resolveClosed = resolve;
  });
  child.on("error", (error) => {
    if (processError === undefined) processError = error;
  });
  child.once("close", (code, signal) => {
    closed = true;
    closeResult = Object.freeze({ code, signal });
    resolveClosed(closeResult);
  });
  const monitored = {
    label,
    child,
    assertRunning() {
      assertNoProcessError(label, processError);
      if (closed || child.exitCode !== null || child.signalCode !== null || child.pid === undefined) {
        throw new Error(`${label} exited before its acceptance work completed.`);
      }
      return child.pid;
    },
    assertSettled() {
      assertNoProcessError(label, processError);
      if (!closed || closeResult === undefined) {
        throw new Error(`${label} did not publish one terminal close event.`);
      }
      return closeResult;
    },
    async waitForClose(timeoutMs) {
      if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
        throw new Error("Remote workspace child close timeout is invalid.");
      }
      if (!closed) {
        await waitForCloseWithTimeout(closedPromise, timeoutMs, label);
      }
      return monitored.assertSettled();
    }
  };
  return Object.freeze(monitored);
}

export function captureRemoteWorkspaceDisplayReceipt(
  { directoryPath, socketPath, lockPath, expectedEntry, uid, pid },
  filesystem = { closeSync, fstatSync, lstatSync, openSync, readFileSync, readdirSync }
) {
  if (
    typeof directoryPath !== "string" ||
    typeof socketPath !== "string" ||
    typeof lockPath !== "string" ||
    typeof expectedEntry !== "string" ||
    !expectedEntry ||
    !Number.isSafeInteger(uid) ||
    !Number.isSafeInteger(pid) ||
    uid <= 0 ||
    pid <= 0
  ) {
    throw new Error("The private Xvfb display receipt request is malformed.");
  }
  const directory = filesystem.lstatSync(directoryPath, { bigint: true });
  const socket = filesystem.lstatSync(socketPath, { bigint: true });
  const { lock, recordedPid } = readPinnedDisplayLock(lockPath, filesystem);
  const entries = [...filesystem.readdirSync(directoryPath)].sort();
  if (
    !directory.isDirectory() ||
    directory.isSymbolicLink() ||
    Number(directory.uid) !== uid ||
    Number(directory.mode & 0o7777n) !== 0o1777 ||
    entries.length !== 1 ||
    entries[0] !== expectedEntry ||
    !socket.isSocket() ||
    socket.isSymbolicLink() ||
    Number(socket.uid) !== uid ||
    !lock.isFile() ||
    lock.isSymbolicLink() ||
    lock.nlink !== 1n ||
    Number(lock.uid) !== uid ||
    lock.size <= 0n ||
    lock.size > DISPLAY_LOCK_MAX_BYTES ||
    !/^[1-9][0-9]*$/u.test(recordedPid) ||
    Number(recordedPid) !== pid
  ) {
    throw new Error("The private Xvfb display lost its isolated process, lock, or socket identity.");
  }
  return Object.freeze({
    directoryPath,
    socketPath,
    lockPath,
    expectedEntry,
    uid,
    pid,
    recordedPid,
    directory: identity(directory),
    socket: identity(socket),
    lock: Object.freeze({
      ...identity(lock),
      size: lock.size,
      mtimeNs: lock.mtimeNs,
      ctimeNs: lock.ctimeNs
    })
  });
}

export function assertRemoteWorkspaceDisplayReceipt(receipt, filesystem) {
  const current = captureRemoteWorkspaceDisplayReceipt(receipt, filesystem);
  if (
    current.recordedPid !== receipt.recordedPid ||
    !sameIdentity(current.directory, receipt.directory) ||
    !sameIdentity(current.socket, receipt.socket) ||
    !sameIdentity(current.lock, receipt.lock) ||
    current.lock.size !== receipt.lock.size ||
    current.lock.mtimeNs !== receipt.lock.mtimeNs ||
    current.lock.ctimeNs !== receipt.lock.ctimeNs
  ) {
    throw new Error("The private Xvfb display identity changed before namespace shutdown.");
  }
  return receipt;
}

function assertNoProcessError(label, processError) {
  if (processError !== undefined) {
    throw new Error(`${label} emitted a child-process error.`, { cause: processError });
  }
}

function identity(metadata) {
  return Object.freeze({ device: metadata.dev, inode: metadata.ino });
}

function sameIdentity(left, right) {
  return left.device === right.device && left.inode === right.inode;
}

function readPinnedDisplayLock(lockPath, filesystem) {
  const namedBefore = filesystem.lstatSync(lockPath, { bigint: true });
  const descriptor = filesystem.openSync(lockPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = filesystem.fstatSync(descriptor, { bigint: true });
    if (!sameLockSnapshot(namedBefore, opened)) {
      throw new Error("The private Xvfb lock changed before its PID could be read.");
    }
    const recordedPid = filesystem.readFileSync(descriptor, "utf8").trim();
    const completed = filesystem.fstatSync(descriptor, { bigint: true });
    const namedAfter = filesystem.lstatSync(lockPath, { bigint: true });
    if (!sameLockSnapshot(opened, completed) || !sameLockSnapshot(opened, namedAfter)) {
      throw new Error("The private Xvfb lock changed while its PID was read.");
    }
    return { lock: opened, recordedPid };
  } finally {
    filesystem.closeSync(descriptor);
  }
}

function sameLockSnapshot(left, right) {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.nlink === right.nlink &&
    left.uid === right.uid &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

async function waitForCloseWithTimeout(closedPromise, timeoutMs, label) {
  let timeout;
  try {
    await Promise.race([
      closedPromise,
      new Promise((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error(`${label} did not close within its bounded grace period.`)),
          timeoutMs
        );
      })
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}
