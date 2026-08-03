import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  watch as watchFileSystem,
  writeFileSync
} from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";

export const LINUX_INOTIFY_WATCH_HEADROOM_PROTOCOL = "openwrangler-linux-inotify-watch-headroom-v1";
export const MINIMUM_INOTIFY_WATCH_HEADROOM = 256;
const WATCH_READINESS_DEADLINE_MS = 1_000;

function fail(message) {
  throw new TypeError(message);
}

function privateOwnedDirectory(path) {
  const target = resolve(path);
  const metadata = lstatSync(target, { bigint: true });
  if (
    !isAbsolute(path) ||
    target !== path ||
    realpathSync(target) !== target ||
    !metadata.isDirectory() ||
    metadata.isSymbolicLink() ||
    (metadata.mode & 0o777n) !== 0o700n ||
    (typeof process.getuid === "function" && metadata.uid !== BigInt(process.getuid()))
  ) {
    fail("The inotify watch-headroom probe requires one caller-owned mode-0700 private run root.");
  }
  return target;
}

function isStrictDescendant(parent, child) {
  const value = relative(parent, child);
  return value.length > 0 && value !== ".." && !value.startsWith(`..${sep}`) && !isAbsolute(value);
}

function receipt(acquiredWatchSlots, passed, failure) {
  return Object.freeze({
    protocol: LINUX_INOTIFY_WATCH_HEADROOM_PROTOCOL,
    requiredWatchSlots: MINIMUM_INOTIFY_WATCH_HEADROOM,
    acquiredWatchSlots,
    passed,
    failure
  });
}

function aggregate(operationError, cleanupError) {
  if (operationError !== undefined && cleanupError !== undefined) {
    return new AggregateError(
      [operationError, cleanupError],
      "The inotify watch-headroom probe failed and did not clean up."
    );
  }
  return operationError ?? cleanupError;
}

async function waitForReadiness(promises, deadlineMs) {
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(new Error("The inotify watch-headroom probe could not prove watcher readiness in time.")),
      deadlineMs
    );
  });
  try {
    await Promise.race([Promise.all(promises), deadline]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Prove that Linux can still acquire the fixed number of directory watches
 * required before a comparison editor starts. The returned receipt contains
 * no path or host detail.
 */
export async function probeLinuxInotifyWatchHeadroom(
  { runRoot },
  {
    platform = process.platform,
    inspectRunRoot = privateOwnedDirectory,
    makeProbeRoot = (root) => mkdtempSync(resolve(root, ".inotify-watch-headroom-")),
    makeDirectory = (path) => mkdirSync(path, { mode: 0o700 }),
    watch = (path, options) => watchFileSystem(path, options),
    triggerReadiness = (sentinel) => writeFileSync(resolve(sentinel, ".watch-ready"), "", { flag: "wx", mode: 0o600 }),
    readinessDeadlineMs = WATCH_READINESS_DEADLINE_MS,
    nextTurn = () => new Promise((resolvePromise) => setImmediate(resolvePromise)),
    remove = (path) => rmSync(path, { recursive: true, force: false })
  } = {}
) {
  if (platform !== "linux") {
    fail("The inotify watch-headroom probe is Linux-only.");
  }
  const parent = inspectRunRoot(runRoot);
  let probeRoot;
  const sentinels = [];
  const watchers = [];
  const readiness = [];
  let acquiredWatchSlots = 0;
  let capacityFailure = false;
  let operationError;
  let cleanupError;
  if (
    typeof triggerReadiness !== "function" ||
    !Number.isSafeInteger(readinessDeadlineMs) ||
    readinessDeadlineMs < 1 ||
    readinessDeadlineMs > WATCH_READINESS_DEADLINE_MS
  ) {
    fail("The inotify watch-headroom probe requires a bounded readiness trigger and deadline.");
  }
  try {
    probeRoot = makeProbeRoot(parent);
    if (!isStrictDescendant(parent, probeRoot)) {
      fail("The inotify watch-headroom probe root escaped its private run root.");
    }
    chmodSync(probeRoot, 0o700);
    for (let index = 0; index < MINIMUM_INOTIFY_WATCH_HEADROOM; index += 1) {
      const sentinel = resolve(probeRoot, `sentinel-${String(index).padStart(3, "0")}`);
      makeDirectory(sentinel);
      sentinels.push(sentinel);
    }
    for (const sentinel of sentinels) {
      let watcher;
      try {
        watcher = watch(sentinel, { persistent: false });
      } catch (error) {
        if (error?.code === "ENOSPC") {
          capacityFailure = true;
          break;
        }
        throw error;
      }
      let close;
      const watcherHasMethods = watcher !== null && (typeof watcher === "object" || typeof watcher === "function");
      if (watcherHasMethods) {
        close = watcher.close;
        if (typeof close === "function") watchers.push({ watcher, close });
      }
      if (!watcherHasMethods || typeof watcher.once !== "function" || typeof close !== "function") {
        fail("The inotify watch-headroom probe received an invalid watcher.");
      }
      let ready = false;
      let failed = false;
      let readinessSettled = false;
      let settleReadiness;
      const readinessPromise = new Promise((resolvePromise) => {
        settleReadiness = resolvePromise;
      });
      const settle = () => {
        if (readinessSettled) return;
        readinessSettled = true;
        settleReadiness();
      };
      watcher.once("error", (error) => {
        failed = true;
        if (ready) {
          ready = false;
          acquiredWatchSlots -= 1;
        }
        if (error?.code === "ENOSPC") capacityFailure = true;
        else operationError ??= error;
        settle();
      });
      watcher.once("change", () => {
        if (!failed && !ready) {
          ready = true;
          acquiredWatchSlots += 1;
        }
        settle();
      });
      readiness.push({ sentinel, promise: readinessPromise });
    }
    for (const entry of readiness) triggerReadiness(entry.sentinel);
    await waitForReadiness(
      readiness.map((entry) => entry.promise),
      readinessDeadlineMs
    );
    await nextTurn();
  } catch (error) {
    operationError ??= error;
  } finally {
    for (const { watcher, close } of watchers) {
      try {
        close.call(watcher);
      } catch (error) {
        cleanupError ??= error;
      }
    }
    if (probeRoot !== undefined) {
      try {
        remove(probeRoot);
      } catch (error) {
        cleanupError ??= error;
      }
    }
  }
  const hardFailure = aggregate(operationError, cleanupError);
  if (hardFailure !== undefined) throw hardFailure;
  if (capacityFailure || acquiredWatchSlots !== MINIMUM_INOTIFY_WATCH_HEADROOM) {
    return receipt(acquiredWatchSlots, false, "inotify-watch-headroom");
  }
  return receipt(acquiredWatchSlots, true, null);
}

export function assertLinuxInotifyWatchHeadroomReceipt(value) {
  const keys = value && typeof value === "object" && !Array.isArray(value) ? Object.keys(value).sort() : [];
  if (
    keys.join("\0") !==
      ["protocol", "requiredWatchSlots", "acquiredWatchSlots", "passed", "failure"].sort().join("\0") ||
    value.protocol !== LINUX_INOTIFY_WATCH_HEADROOM_PROTOCOL ||
    value.requiredWatchSlots !== MINIMUM_INOTIFY_WATCH_HEADROOM ||
    !Number.isSafeInteger(value.acquiredWatchSlots) ||
    value.acquiredWatchSlots < 0 ||
    value.acquiredWatchSlots > MINIMUM_INOTIFY_WATCH_HEADROOM ||
    typeof value.passed !== "boolean" ||
    (value.passed
      ? value.acquiredWatchSlots !== MINIMUM_INOTIFY_WATCH_HEADROOM || value.failure !== null
      : value.failure !== "inotify-watch-headroom")
  ) {
    fail("The inotify watch-headroom receipt is invalid.");
  }
  return value;
}

export async function requireLinuxInotifyWatchHeadroom(options, dependencies) {
  const value = assertLinuxInotifyWatchHeadroomReceipt(await probeLinuxInotifyWatchHeadroom(options, dependencies));
  if (!value.passed) {
    const error = new Error("The Linux comparison requires 256 free inotify watch slots before an editor can start.");
    error.code = "inotify-watch-headroom";
    error.receipt = value;
    throw error;
  }
  return value;
}
