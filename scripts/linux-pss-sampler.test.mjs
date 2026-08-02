import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { validateDataWranglerStudyResourceObservation } from "./data-wrangler-comparison-study.mjs";
import { LinuxPssTreeSampler, collectLinuxPssObservation } from "./linux-pss-sampler.mjs";

test("Linux PSS sampling pins process identities and counts each owned descendant in one category", () => {
  withProcFixture((procRoot) => {
    writeProcess(procRoot, { pid: 100, start: "1000", children: [101, 102], pssKb: 100, rssKb: 150 });
    writeProcess(procRoot, { pid: 101, start: "1001", children: [103], pssKb: 50, rssKb: 75 });
    writeProcess(procRoot, { pid: 102, start: "1002", children: [], pssKb: 20, rssKb: 30 });
    writeProcess(procRoot, { pid: 103, start: "1003", children: [], pssKb: 10, rssKb: 15 });
    const categories = new Map([
      [100, "editor-main"],
      [101, "extension-host"],
      [102, "renderer-gpu"],
      [103, "configured-kernel"]
    ]);
    const clock = sequentialClock([1_000, 1_250]);
    const sampler = new LinuxPssTreeSampler({
      rootPid: 100,
      procRoot,
      clock,
      classify: ({ pid }) => categories.get(pid)
    });
    const sample = sampler.sample();
    assert.equal(sample.elapsedMs, 250);
    assert.equal(sample.totalPssBytes, 180 * 1024);
    assert.equal(sample.totalRssBytes, 270 * 1024);
    assert.equal(sample.categories["editor-main"], 100 * 1024);
    assert.equal(sample.categories["extension-host"], 50 * 1024);
    assert.equal(sample.categories["renderer-gpu"], 20 * 1024);
    assert.equal(sample.categories["configured-kernel"], 10 * 1024);
    assert.equal(sample.categories["open-wrangler-runtime"], 0);
    assert.equal(sample.categories["other-owned-child"], 0);
    assert.deepEqual(
      sample.processes.map((process) => process.pid),
      [100, 101, 102, 103]
    );

    const observation = {
      protocol: "openwrangler-linux-pss-observation-v1",
      valid: true,
      reasonClass: null,
      intervalMs: 200,
      missedSamples: 0,
      samples: [sample]
    };
    assert.equal(validateDataWranglerStudyResourceObservation(observation), observation);
  });
});

test("Linux PSS sampling rejects PID reuse and category drift", () => {
  withProcFixture((procRoot) => {
    writeProcess(procRoot, { pid: 200, start: "2000", children: [], pssKb: 10, rssKb: 20 });
    let category = "editor-main";
    const sampler = new LinuxPssTreeSampler({
      rootPid: 200,
      procRoot,
      clock: () => 0,
      classify: () => category
    });
    sampler.sample();
    category = "extension-host";
    assert.throws(() => sampler.sample(), /changed PSS category/u);

    category = "editor-main";
    writeProcess(procRoot, { pid: 200, start: "2999", children: [], pssKb: 10, rssKb: 20 });
    assert.throws(() => sampler.sample(), /reused/u);
  });
});

test("the 200 ms collector returns a bounded invalid resource observation on sampling failure", async () => {
  await withProcFixture(async (procRoot) => {
    writeProcess(procRoot, { pid: 300, start: "3000", children: [], pssKb: 10, rssKb: 20 });
    const sampler = new LinuxPssTreeSampler({
      rootPid: 300,
      procRoot,
      clock: sequentialClock([0, 1, 2, 3]),
      classify: () => "editor-main"
    });
    let waits = 0;
    const controller = new AbortController();
    const observationPromise = collectLinuxPssObservation({
      sampler,
      signal: controller.signal,
      wait: async () => {
        waits += 1;
        if (waits === 1) {
          rmSync(resolve(procRoot, "300", "smaps_rollup"));
        }
      }
    });
    const observation = await observationPromise;
    assert.equal(observation.valid, false);
    assert.equal(observation.reasonClass, "resource-sampling");
    assert.equal(observation.missedSamples, 1);
    assert.equal(observation.samples.length, 1);
  });
});

test("the collector reports a missed interval instead of hiding a sampling stall", async () => {
  await withProcFixture(async (procRoot) => {
    writeProcess(procRoot, { pid: 400, start: "4000", children: [], pssKb: 10, rssKb: 20 });
    const sampler = new LinuxPssTreeSampler({
      rootPid: 400,
      procRoot,
      clock: sequentialClock([0, 1]),
      classify: () => "editor-main"
    });
    const observation = await collectLinuxPssObservation({
      sampler,
      signal: new AbortController().signal,
      scheduleClock: sequentialClock([0, 250]),
      wait: async () => {
        throw new Error("A missed interval should stop before waiting.");
      }
    });
    assert.equal(observation.valid, false);
    assert.equal(observation.missedSamples, 1);
    assert.equal(observation.samples.length, 1);
  });
});

function writeProcess(procRoot, { pid, start, children, pssKb, rssKb }) {
  const directory = resolve(procRoot, String(pid));
  mkdirSync(resolve(directory, "task", String(pid)), { recursive: true });
  const preStartFields = Array(18).fill("0");
  writeFileSync(resolve(directory, "stat"), `${pid} (ow-test-${pid}) S ${preStartFields.join(" ")} ${start} 0 0\n`);
  writeFileSync(resolve(directory, "task", String(pid), "children"), `${children.join(" ")}\n`);
  writeFileSync(resolve(directory, "smaps_rollup"), `Rss: ${rssKb} kB\nPss: ${pssKb} kB\n`);
}

function sequentialClock(values) {
  let index = 0;
  return () => values[Math.min(index++, values.length - 1)];
}

function withProcFixture(callback) {
  const directory = mkdtempSync(resolve(tmpdir(), "ow-proc-fixture-"));
  try {
    const result = callback(directory);
    if (result instanceof Promise) {
      return result.finally(() => rmSync(directory, { recursive: true, force: true }));
    }
    rmSync(directory, { recursive: true, force: true });
    return result;
  } catch (error) {
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}
