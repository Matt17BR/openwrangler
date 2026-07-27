import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import {
  assertRemoteWorkspaceDisplayReceipt,
  captureRemoteWorkspaceDisplayReceipt,
  spawnMonitoredRemoteWorkspaceChild
} from "./remote-workspace-processes.mjs";

test("monitored remote children latch process errors instead of treating them as exit", async () => {
  const child = new EventEmitter();
  Object.assign(child, { pid: 41, exitCode: null, signalCode: null });
  const monitored = spawnMonitoredRemoteWorkspaceChild(
    "test child",
    "unused",
    [],
    {},
    {
      spawnProcess: () => child
    }
  );
  assert.equal(monitored.assertRunning(), 41);
  const failure = new Error("late spawn failure");
  child.emit("error", failure);
  assert.throws(() => monitored.assertRunning(), { cause: failure });
  child.exitCode = 1;
  child.emit("close", 1, null);
  await assert.rejects(monitored.waitForClose(100), { cause: failure });
  assert.throws(() => monitored.assertSettled(), { cause: failure });
});

test("private display receipts reject socket replacement and PID drift", () => {
  const paths = {
    directoryPath: "/tmp/.X11-unix",
    socketPath: "/tmp/.X11-unix/X99",
    lockPath: "/tmp/.X99-lock",
    expectedEntry: "X99",
    uid: 1001,
    pid: 73
  };
  const state = {
    directory: metadata("directory", 11n, { mode: 0o041777n }),
    socket: metadata("socket", 12n),
    lock: metadata("file", 13n, { mode: 0o100600n, size: 3n, mtimeNs: 5n, ctimeNs: 6n }),
    pid: "73\n"
  };
  const filesystem = {
    closeSync() {},
    fstatSync: () => state.lock,
    lstatSync(path) {
      if (path === paths.directoryPath) return state.directory;
      if (path === paths.socketPath) return state.socket;
      if (path === paths.lockPath) return state.lock;
      throw new Error("unexpected path");
    },
    openSync: () => 17,
    readFileSync: () => state.pid,
    readdirSync: () => ["X99"]
  };
  const receipt = captureRemoteWorkspaceDisplayReceipt(paths, filesystem);
  assert.equal(assertRemoteWorkspaceDisplayReceipt(receipt, filesystem), receipt);
  state.socket = metadata("socket", 99n);
  assert.throws(
    () => assertRemoteWorkspaceDisplayReceipt(receipt, filesystem),
    /identity changed before namespace shutdown/u
  );
  state.socket = metadata("socket", 12n);
  state.pid = "74\n";
  assert.throws(
    () => assertRemoteWorkspaceDisplayReceipt(receipt, filesystem),
    /lost its isolated process, lock, or socket identity/u
  );
});

test("private display lock reads reject a same-path replacement during the descriptor read", () => {
  const paths = {
    directoryPath: "/tmp/.X11-unix",
    socketPath: "/tmp/.X11-unix/X99",
    lockPath: "/tmp/.X99-lock",
    expectedEntry: "X99",
    uid: 1001,
    pid: 73
  };
  const originalLock = metadata("file", 13n, { mode: 0o100600n, size: 3n, mtimeNs: 5n, ctimeNs: 6n });
  let namedLock = originalLock;
  const filesystem = {
    closeSync() {},
    fstatSync: () => originalLock,
    lstatSync(path) {
      if (path === paths.directoryPath) return metadata("directory", 11n, { mode: 0o041777n });
      if (path === paths.socketPath) return metadata("socket", 12n);
      if (path === paths.lockPath) return namedLock;
      throw new Error("unexpected path");
    },
    openSync: () => 19,
    readFileSync() {
      namedLock = metadata("file", 99n, { mode: 0o100600n, size: 3n, mtimeNs: 7n, ctimeNs: 8n });
      return "73\n";
    },
    readdirSync: () => ["X99"]
  };
  assert.throws(() => captureRemoteWorkspaceDisplayReceipt(paths, filesystem), /lock changed while its PID was read/u);
});

function metadata(kind, inode, overrides = {}) {
  return {
    dev: 9n,
    ino: inode,
    uid: 1001n,
    mode: kind === "directory" ? 0o041777n : kind === "file" ? 0o100600n : 0o140777n,
    nlink: 1n,
    size: kind === "file" ? 3n : 0n,
    mtimeNs: 1n,
    ctimeNs: 2n,
    isDirectory: () => kind === "directory",
    isSocket: () => kind === "socket",
    isFile: () => kind === "file",
    isSymbolicLink: () => false,
    ...overrides
  };
}
