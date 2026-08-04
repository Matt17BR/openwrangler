import assert from "node:assert/strict";
import test from "node:test";
import { readLinuxPssTree, startLinuxPssSampler } from "./linux-pss-sampler.mjs";

function fakeProc() {
  const files = new Map([
    ["/proc/10/stat", stat(10, 1, 10, 100)],
    ["/proc/11/stat", stat(11, 10, 10, 101)],
    ["/proc/12/stat", stat(12, 11, 12, 102)],
    ["/proc/20/stat", stat(20, 1, 20, 200)],
    ["/proc/10/smaps_rollup", "Pss:              100 kB\n"],
    ["/proc/11/smaps_rollup", "Pss:               25 kB\n"],
    ["/proc/12/smaps_rollup", "Pss:                5 kB\n"],
    ["/proc/20/smaps_rollup", "Pss:              900 kB\n"]
  ]);
  return {
    readDirectory: () => ["10", "11", "12", "20", "self", "not-a-pid"],
    readFile: (path) => {
      if (!files.has(path)) throw Object.assign(new Error("missing"), { code: "ENOENT" });
      return files.get(path);
    }
  };
}

function stat(pid, parentPid, processGroupId, startTimeTicks) {
  const fields = ["S", String(parentPid), String(processGroupId), String(processGroupId)];
  while (fields.length <= 19) fields.push("0");
  fields[19] = String(startTimeTicks);
  return `${pid} (process ${pid}) ${fields.join(" ")}\n`;
}

test("reads PSS for the root and descendants without counting unrelated processes", () => {
  const sample = readLinuxPssTree(10, {
    ...fakeProc(),
    expectedRootStartTimeTicks: "100",
    now: () => 123n
  });
  assert.equal(sample.monotonicNs, "123");
  assert.equal(sample.rootStartTimeTicks, "100");
  assert.equal(sample.processCount, 3);
  assert.equal(sample.pssBytes, 130 * 1024);
  assert.deepEqual(
    sample.processes.map(({ pid }) => pid),
    [10, 11, 12]
  );
});

test("rejects a reused root PID", () => {
  assert.throws(
    () => readLinuxPssTree(10, { ...fakeProc(), expectedRootStartTimeTicks: "wrong" }),
    /Linux clock ticks/u
  );
  assert.throws(() => readLinuxPssTree(10, { ...fakeProc(), expectedRootStartTimeTicks: "999" }), /was replaced/u);
});

test("samples immediately, periodically, and once at stop", () => {
  let callback;
  let cleared;
  let sequence = 0;
  const sampler = startLinuxPssSampler(10, {
    intervalMs: 200,
    read: () => ({ monotonicNs: String(++sequence), rootPid: 10, processCount: 1, pssBytes: sequence }),
    setTimer: (value, interval) => {
      callback = value;
      assert.equal(interval, 200);
      return 17;
    },
    clearTimer: (timer) => {
      cleared = timer;
    }
  });
  callback();
  const samples = sampler.stop();
  assert.equal(cleared, 17);
  assert.deepEqual(
    samples.map(({ pssBytes }) => pssBytes),
    [1, 2, 3]
  );
});

test("pins the root process start time after the first sample", () => {
  const proc = fakeProc();
  let rootReused = false;
  let callback;
  const sampler = startLinuxPssSampler(10, {
    ...proc,
    now: () => 123n,
    setTimer: (value) => {
      callback = value;
      return 17;
    },
    clearTimer: () => undefined,
    readFile: (path) => (rootReused && path === "/proc/10/stat" ? stat(10, 1, 10, 999) : proc.readFile(path))
  });
  rootReused = true;
  callback();
  assert.throws(() => sampler.stop({ captureFinal: false }), /was replaced/u);
});

test("surfaces sampling errors when the caller stops", () => {
  const sampler = startLinuxPssSampler(10, {
    read: () => {
      throw new Error("procfs unavailable");
    },
    setTimer: () => 1,
    clearTimer: () => undefined
  });
  assert.throws(() => sampler.stop(), /procfs unavailable/u);
});
