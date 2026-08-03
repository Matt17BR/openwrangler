import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { EventEmitter } from "node:events";
import test from "node:test";
import {
  LINUX_INOTIFY_WATCH_HEADROOM_PROTOCOL,
  MINIMUM_INOTIFY_WATCH_HEADROOM,
  assertLinuxInotifyWatchHeadroomReceipt,
  probeLinuxInotifyWatchHeadroom,
  requireLinuxInotifyWatchHeadroom
} from "./linux-inotify-watch-headroom.mjs";

const linuxTest = process.platform === "linux" ? test : test.skip;

function privateRoot(t) {
  const root = mkdtempSync(resolve(tmpdir(), "ow-inotify-headroom-"));
  chmodSync(root, 0o700);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function fakeWatcher({ asyncError, asyncDelayMs, closeError } = {}) {
  const emitter = new EventEmitter();
  let closed = false;
  const watcher = Object.assign(emitter, {
    close() {
      closed = true;
      if (closeError) throw closeError;
    }
  });
  Object.defineProperty(watcher, "closed", { get: () => closed });
  if (asyncError) {
    if (asyncDelayMs === undefined) setImmediate(() => emitter.emit("error", asyncError));
    else setTimeout(() => emitter.emit("error", asyncError), asyncDelayMs);
  }
  return watcher;
}

linuxTest("watch-headroom probe acquires and closes all 256 sentinels with a path-free receipt", async (t) => {
  const root = privateRoot(t);
  const sentinels = new Set();
  const watchers = [];
  const watchersBySentinel = new Map();
  let probeRoot;
  const value = await probeLinuxInotifyWatchHeadroom(
    { runRoot: root },
    {
      makeProbeRoot(parent) {
        probeRoot = mkdtempSync(resolve(parent, ".probe-"));
        return probeRoot;
      },
      makeDirectory(path) {
        sentinels.add(path);
        mkdirSync(path, { mode: 0o700 });
      },
      watch(sentinel) {
        const watcher = fakeWatcher();
        watchers.push(watcher);
        watchersBySentinel.set(sentinel, watcher);
        return watcher;
      },
      triggerReadiness(sentinel) {
        watchersBySentinel.get(sentinel).emit("change", "rename", ".watch-ready");
      }
    }
  );
  assert.deepEqual(value, {
    protocol: LINUX_INOTIFY_WATCH_HEADROOM_PROTOCOL,
    requiredWatchSlots: MINIMUM_INOTIFY_WATCH_HEADROOM,
    acquiredWatchSlots: MINIMUM_INOTIFY_WATCH_HEADROOM,
    passed: true,
    failure: null
  });
  assert.equal(sentinels.size, MINIMUM_INOTIFY_WATCH_HEADROOM);
  assert.equal(
    watchers.every((watcher) => watcher.closed),
    true
  );
  assert.equal(existsSync(probeRoot), false);
  assert.doesNotMatch(JSON.stringify(value), /[/\\]|ow-inotify/u);
  assert.equal(assertLinuxInotifyWatchHeadroomReceipt(value), value);
});

linuxTest("watch-headroom probe reports synchronous and asynchronous partial ENOSPC without paths", async (t) => {
  for (const [mode, failingSlot] of [
    ["sync", 0],
    ["sync", 17],
    ["sync", 255],
    ["async", 0],
    ["async", 17],
    ["async", 255]
  ]) {
    const root = privateRoot(t);
    const sentinels = new Set();
    const watchers = [];
    const watchersBySentinel = new Map();
    let calls = 0;
    let probeRoot;
    const value = await probeLinuxInotifyWatchHeadroom(
      { runRoot: root },
      {
        makeProbeRoot(parent) {
          probeRoot = mkdtempSync(resolve(parent, ".probe-"));
          return probeRoot;
        },
        makeDirectory(path) {
          sentinels.add(path);
          mkdirSync(path, { mode: 0o700 });
        },
        watch(sentinel) {
          const slot = calls;
          calls += 1;
          if (mode === "sync" && slot === failingSlot) {
            const error = new Error("private path detail");
            error.code = "ENOSPC";
            throw error;
          }
          const asyncError =
            mode === "async" && slot === failingSlot
              ? Object.assign(new Error("private path detail"), { code: "ENOSPC" })
              : undefined;
          const watcher = fakeWatcher({ asyncError });
          watchers.push(watcher);
          watchersBySentinel.set(sentinel, watcher);
          return watcher;
        },
        triggerReadiness(sentinel) {
          watchersBySentinel.get(sentinel).emit("change", "rename", ".watch-ready");
        }
      }
    );
    assert.equal(value.passed, false);
    assert.equal(sentinels.size, MINIMUM_INOTIFY_WATCH_HEADROOM);
    assert.equal(value.failure, "inotify-watch-headroom");
    assert.equal(value.acquiredWatchSlots, mode === "async" ? MINIMUM_INOTIFY_WATCH_HEADROOM - 1 : failingSlot);
    assert.equal(JSON.stringify(value).includes("private path detail"), false);
    assert.equal(
      watchers.every((watcher) => watcher.closed),
      true
    );
    assert.equal(existsSync(probeRoot), false);
  }
});

linuxTest("watch-headroom probe waits for readiness long enough to observe delayed asynchronous ENOSPC", async (t) => {
  const root = privateRoot(t);
  const failingSlot = 17;
  const watchersBySentinel = new Map();
  let calls = 0;
  const value = await probeLinuxInotifyWatchHeadroom(
    { runRoot: root },
    {
      watch(sentinel) {
        const slot = calls;
        calls += 1;
        const asyncError =
          slot === failingSlot ? Object.assign(new Error("delayed private detail"), { code: "ENOSPC" }) : undefined;
        const watcher = fakeWatcher({ asyncError, asyncDelayMs: 5 });
        watchersBySentinel.set(sentinel, { slot, watcher });
        return watcher;
      },
      triggerReadiness(sentinel) {
        const entry = watchersBySentinel.get(sentinel);
        if (entry.slot !== failingSlot) entry.watcher.emit("change", "rename", ".watch-ready");
      }
    }
  );
  assert.equal(value.passed, false);
  assert.equal(value.failure, "inotify-watch-headroom");
  assert.equal(value.acquiredWatchSlots, MINIMUM_INOTIFY_WATCH_HEADROOM - 1);
  assert.equal(JSON.stringify(value).includes("delayed private detail"), false);
});

linuxTest("watch-headroom probe hard-fails unexpected and cleanup faults", async (t) => {
  const root = privateRoot(t);
  await assert.rejects(
    probeLinuxInotifyWatchHeadroom(
      { runRoot: root },
      {
        watch() {
          const error = new Error("unexpected watcher failure");
          error.code = "EMFILE";
          throw error;
        }
      }
    ),
    /unexpected watcher failure/u
  );
  const cleanupWatchers = new Map();
  await assert.rejects(
    probeLinuxInotifyWatchHeadroom(
      { runRoot: root },
      {
        watch(sentinel) {
          const watcher = fakeWatcher();
          cleanupWatchers.set(sentinel, watcher);
          return watcher;
        },
        triggerReadiness(sentinel) {
          cleanupWatchers.get(sentinel).emit("change", "rename", ".watch-ready");
        },
        remove() {
          throw new Error("cleanup failed");
        }
      }
    ),
    /cleanup failed/u
  );
});

linuxTest("watch-headroom probe reports close faults and aggregates operation with cleanup", async (t) => {
  const root = privateRoot(t);
  const watchersBySentinel = new Map();
  let calls = 0;
  await assert.rejects(
    probeLinuxInotifyWatchHeadroom(
      { runRoot: root },
      {
        watch(sentinel) {
          const watcher = fakeWatcher({ closeError: calls === 0 ? new Error("close cleanup failed") : undefined });
          calls += 1;
          watchersBySentinel.set(sentinel, watcher);
          return watcher;
        },
        triggerReadiness(sentinel) {
          watchersBySentinel.get(sentinel).emit("change", "rename", ".watch-ready");
        }
      }
    ),
    /close cleanup failed/u
  );

  let invalidWatcherClosed = false;
  await assert.rejects(
    probeLinuxInotifyWatchHeadroom(
      { runRoot: root },
      {
        watch() {
          return {
            close() {
              invalidWatcherClosed = true;
              throw new Error("invalid watcher cleanup failed");
            }
          };
        }
      }
    ),
    (error) => {
      assert.equal(error instanceof AggregateError, true);
      assert.deepEqual(
        error.errors.map((entry) => entry.message),
        ["The inotify watch-headroom probe received an invalid watcher.", "invalid watcher cleanup failed"]
      );
      return true;
    }
  );
  assert.equal(invalidWatcherClosed, true);
});

linuxTest("required watch headroom throws one path-free classified error on capacity failure", async (t) => {
  const root = privateRoot(t);
  await assert.rejects(
    requireLinuxInotifyWatchHeadroom(
      { runRoot: root },
      {
        watch() {
          const error = new Error("sensitive path");
          error.code = "ENOSPC";
          throw error;
        }
      }
    ),
    (error) => {
      assert.equal(error.code, "inotify-watch-headroom");
      assert.equal(error.receipt.failure, "inotify-watch-headroom");
      assert.equal(JSON.stringify(error.receipt).includes("sensitive path"), false);
      return true;
    }
  );
});
