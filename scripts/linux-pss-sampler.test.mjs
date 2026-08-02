import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import {
  DATA_WRANGLER_STUDY_MAXIMUM_RESOURCE_SAMPLES,
  validateDataWranglerStudyResourceObservation
} from "./data-wrangler-comparison-study.mjs";
import {
  LinuxPssTreeSampler as VerifiedLinuxPssTreeSampler,
  LINUX_PSS_OWNERSHIP_PROTOCOL,
  collectLinuxPssObservation
} from "./linux-pss-sampler.mjs";

function testOwnershipReceipt(
  { supervisorPid, supervisorStartTimeTicks, editorRootPid, editorRootStartTimeTicks },
  overrides = {}
) {
  return {
    protocol: LINUX_PSS_OWNERSHIP_PROTOCOL,
    kind: "launch",
    nonce: "0".repeat(64),
    supervisor: {
      pid: supervisorPid,
      startTimeTicks: supervisorStartTimeTicks,
      subreaperVerified: true,
      pidfdVerified: true
    },
    editorRoot: {
      pid: editorRootPid,
      startTimeTicks: editorRootStartTimeTicks,
      processGroupId: editorRootPid,
      sessionId: editorRootPid
    },
    supervisorSource: {
      sha256: "1".repeat(64),
      filesystemIdentity: testFilesystemIdentity()
    },
    pythonExecutable: {
      implementation: "CPython",
      version: "3.12.9",
      sha256: "2".repeat(64),
      filesystemIdentity: { ...testFilesystemIdentity(), inode: "43" }
    },
    invocationPolicySha256: "3".repeat(64),
    invocationSha256: "6".repeat(64),
    payloadArgvSha256: "4".repeat(64),
    payloadEnvironmentSha256: "5".repeat(64),
    ...overrides
  };
}

class LinuxPssTreeSampler extends VerifiedLinuxPssTreeSampler {
  constructor(options) {
    const supervisorPid = options.supervisorPid ?? options.rootPid - 1;
    const supervisorStartTimeTicks = options.supervisorStartTimeTicks ?? String(Number(options.rootStartTimeTicks) - 1);
    if (!existsProcess(options.procRoot, supervisorPid)) {
      writeProcess(options.procRoot, {
        pid: supervisorPid,
        start: supervisorStartTimeTicks,
        pssKb: 999,
        rssKb: 999
      });
    }
    reparentProcess(options.procRoot, options.rootPid, supervisorPid);
    super({
      ...options,
      supervisorPid,
      supervisorStartTimeTicks,
      editorRootPid: options.rootPid,
      editorRootStartTimeTicks: options.rootStartTimeTicks,
      ownershipReceipt:
        options.ownershipReceipt ??
        testOwnershipReceipt({
          supervisorPid,
          supervisorStartTimeTicks,
          editorRootPid: options.rootPid,
          editorRootStartTimeTicks: options.rootStartTimeTicks
        })
    });
  }
}

test("Linux PSS sampling fails closed without a driver-bound supervisor ownership receipt", () => {
  withProcFixture((procRoot) => {
    writeProcess(procRoot, { pid: 89, start: "899", pssKb: 999, rssKb: 999 });
    writeProcess(procRoot, { pid: 90, start: "900", pssKb: 10, rssKb: 20 });
    reparentProcess(procRoot, 90, 89);
    assert.throws(
      () =>
        new VerifiedLinuxPssTreeSampler({
          supervisorPid: 89,
          supervisorStartTimeTicks: "899",
          editorRootPid: 90,
          editorRootStartTimeTicks: "900",
          procRoot,
          clock: () => 0n,
          classify: () => "editor-main"
        }),
      /requires a verified Linux study-supervisor ownership receipt/u
    );
  });
});

test("Linux PSS sampling rejects tampered supervisor ownership receipts", () => {
  withProcFixture((procRoot) => {
    writeProcess(procRoot, { pid: 94, start: "949", pssKb: 999, rssKb: 999 });
    writeProcess(procRoot, { pid: 95, start: "950", pssKb: 10, rssKb: 20 });
    reparentProcess(procRoot, 95, 94);
    const receiptInput = {
      supervisorPid: 94,
      supervisorStartTimeTicks: "949",
      editorRootPid: 95,
      editorRootStartTimeTicks: "950"
    };
    const create = (overrides) =>
      new VerifiedLinuxPssTreeSampler({
        ...receiptInput,
        procRoot,
        clock: () => 0n,
        classify: () => "editor-main",
        ownershipReceipt: testOwnershipReceipt(receiptInput, overrides)
      });
    assert.throws(
      () => create({ supervisorSource: { ...testOwnershipReceipt(receiptInput).supervisorSource, sha256: "x" } }),
      /malformed or does not bind/u
    );
    assert.throws(
      () => create({ supervisor: { ...testOwnershipReceipt(receiptInput).supervisor, pid: 96 } }),
      /malformed or does not bind/u
    );
    assert.throws(
      () =>
        create({
          supervisor: { ...testOwnershipReceipt(receiptInput).supervisor, subreaperVerified: false }
        }),
      /malformed or does not bind/u
    );
    assert.throws(
      () =>
        create({
          editorRoot: { ...testOwnershipReceipt(receiptInput).editorRoot, processGroupId: 94 }
        }),
      /malformed or does not bind/u
    );
    assert.throws(() => create({ invocationPolicySha256: "a" }), /malformed or does not bind/u);
  });
});

test("Linux PSS sampling uses the PPid census when task children omit living and transitioning children", () => {
  withProcFixture((procRoot) => {
    writeProcess(procRoot, {
      pid: 100,
      start: "1000",
      taskChildren: [],
      workers: [{ tid: 110, start: "1010", children: [] }],
      pssKb: 100,
      rssKb: 150
    });
    writeProcess(procRoot, {
      pid: 101,
      parentPid: 100,
      start: "1001",
      state: "R",
      taskChildren: [],
      pssKb: 50,
      rssKb: 75
    });
    writeProcess(procRoot, {
      pid: 102,
      parentPid: 100,
      start: "1002",
      state: "D",
      taskChildren: [],
      pssKb: 20,
      rssKb: 30
    });
    writeProcess(procRoot, {
      pid: 103,
      parentPid: 101,
      start: "1003",
      taskChildren: [],
      pssKb: 10,
      rssKb: 15
    });
    const categories = new Map([
      [100, "editor-main"],
      [101, "extension-host"],
      [102, "renderer-gpu"],
      [103, "configured-kernel"]
    ]);
    const sampler = new LinuxPssTreeSampler({
      rootPid: 100,
      rootStartTimeTicks: "1000",
      procRoot,
      clock: sequentialClock([1_000, 1_250]),
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
      clock: sampler.clockReceipt(),
      ownershipTracker: sampler.ownershipReceipt(),
      valid: true,
      reasonClass: null,
      intervalMs: 200,
      maximumLatenessMs: 50,
      missedSamples: 0,
      terminalBoundary: null,
      retainedOwnedIdentities: sampler.retainedOwnedIdentities(),
      samples: [0, 200, 400, 600, 800].map((elapsedMs) => ({
        ...sample,
        scheduledMonotonicNanoseconds: msNanoseconds(1_000 + elapsedMs).toString(),
        startedMonotonicNanoseconds: msNanoseconds(1_000 + elapsedMs).toString(),
        endedMonotonicNanoseconds: msNanoseconds(1_000 + elapsedMs).toString(),
        latenessMs: 0,
        elapsedMs
      }))
    };
    assert.equal(validateDataWranglerStudyResourceObservation(observation), observation);
  });
});

test("Linux PSS sampling retains a live owned process after reparenting and discovers its children", () => {
  withProcFixture((procRoot) => {
    writeProcess(procRoot, { pid: 175, start: "1750", pssKb: 10, rssKb: 20 });
    writeProcess(procRoot, { pid: 176, parentPid: 175, start: "1751", pssKb: 5, rssKb: 10 });
    const sampler = new LinuxPssTreeSampler({
      rootPid: 175,
      rootStartTimeTicks: "1750",
      procRoot,
      clock: () => 0n,
      classify: ({ pid }) => {
        if (pid === 175) {
          return "editor-main";
        }
        return pid === 176 ? "extension-host" : "other-owned-child";
      }
    });
    assert.deepEqual(
      sampler.sample().processes.map((process) => process.pid),
      [175, 176]
    );

    writeProcess(procRoot, {
      pid: 176,
      parentPid: sampler.supervisorPid,
      start: "1751",
      pssKb: 5,
      rssKb: 10
    });
    writeProcess(procRoot, { pid: 177, parentPid: 176, start: "1752", pssKb: 2, rssKb: 4 });
    assert.deepEqual(
      sampler.sample().processes.map((process) => process.pid),
      [175, 176, 177]
    );
  });
});

test("Linux PSS sampling retains evidence for a helper that exits between samples without requiring it to stay live", () => {
  withProcFixture((procRoot) => {
    writeProcess(procRoot, { pid: 185, start: "1850", pssKb: 10, rssKb: 20 });
    writeProcess(procRoot, { pid: 186, parentPid: 185, start: "1851", pssKb: 5, rssKb: 10 });
    const sampler = new LinuxPssTreeSampler({
      rootPid: 185,
      rootStartTimeTicks: "1850",
      procRoot,
      clock: () => 0n,
      classify: ({ pid }) => (pid === 185 ? "editor-main" : "other-owned-child")
    });
    assert.deepEqual(
      sampler.sample().processes.map((process) => process.pid),
      [185, 186]
    );

    rmSync(resolve(procRoot, "186"), { recursive: true, force: true });
    assert.deepEqual(
      sampler.sample().processes.map((process) => process.pid),
      [185]
    );
    assert.deepEqual(sampler.retainedOwnedIdentities(), [
      { pid: 185, startTimeTicks: "1850" },
      { pid: 186, startTimeTicks: "1851" }
    ]);
  });
});

test("Linux PSS sampling rejects a retained identity that is reused or remains alive outside supervisor ownership", () => {
  withProcFixture((procRoot) => {
    writeProcess(procRoot, { pid: 187, start: "1870", pssKb: 10, rssKb: 20 });
    writeProcess(procRoot, { pid: 188, parentPid: 187, start: "1871", pssKb: 5, rssKb: 10 });
    const sampler = new LinuxPssTreeSampler({
      rootPid: 187,
      rootStartTimeTicks: "1870",
      procRoot,
      clock: () => 0n,
      classify: ({ pid }) => (pid === 187 ? "editor-main" : "other-owned-child")
    });
    sampler.sample();

    writeProcess(procRoot, { pid: 188, parentPid: 0, start: "1871", pssKb: 5, rssKb: 10 });
    assert.throws(() => sampler.sample(), /alive outside the supervisor-owned process closure/u);

    writeProcess(procRoot, { pid: 188, parentPid: 0, start: "9999", pssKb: 5, rssKb: 10 });
    assert.throws(() => sampler.sample(), /was reused/u);
  });
});

test("Linux PSS sampling includes a child first observed after setsid and subreaper reparenting", () => {
  withProcFixture((procRoot) => {
    writeProcess(procRoot, { pid: 180, start: "1800", pssKb: 10, rssKb: 20 });
    const sampler = new LinuxPssTreeSampler({
      rootPid: 180,
      rootStartTimeTicks: "1800",
      procRoot,
      clock: () => 0n,
      classify: ({ pid }) => (pid === 180 ? "editor-main" : "other-owned-child")
    });
    assert.deepEqual(
      sampler.sample().processes.map((process) => process.pid),
      [180]
    );

    writeProcess(procRoot, {
      pid: 181,
      parentPid: sampler.supervisorPid,
      processGroupId: 181,
      sessionId: 181,
      start: "1801",
      pssKb: 5,
      rssKb: 10
    });
    assert.deepEqual(
      sampler.sample().processes.map((process) => process.pid),
      [180, 181]
    );
    assert.deepEqual(sampler.retainedOwnedIdentities(), [
      { pid: 180, startTimeTicks: "1800" },
      { pid: 181, startTimeTicks: "1801" }
    ]);
  });
});

test("Linux PSS sampling excludes an unrelated process even when it reuses the editor process group", () => {
  withProcFixture((procRoot) => {
    writeProcess(procRoot, { pid: 190, start: "1900", pssKb: 10, rssKb: 20 });
    writeProcess(procRoot, {
      pid: 191,
      parentPid: 0,
      processGroupId: 190,
      sessionId: 999,
      start: "1901",
      pssKb: 5,
      rssKb: 10
    });
    const sampler = new LinuxPssTreeSampler({
      rootPid: 190,
      rootStartTimeTicks: "1900",
      procRoot,
      clock: () => 0n,
      classify: () => "editor-main"
    });
    assert.deepEqual(
      sampler.sample().processes.map((process) => process.pid),
      [190]
    );
  });
});

test("Linux PSS sampling rejects root PID reuse before its first sample", () => {
  withProcFixture((procRoot) => {
    writeProcess(procRoot, { pid: 150, start: "1599", pssKb: 10, rssKb: 20 });
    let classifications = 0;
    assert.throws(
      () =>
        new LinuxPssTreeSampler({
          rootPid: 150,
          rootStartTimeTicks: "1500",
          procRoot,
          clock: () => 0n,
          classify: () => {
            classifications += 1;
            return "editor-main";
          }
        }),
      /ownership receipt is malformed|does not bind/u
    );
    assert.equal(classifications, 0);
  });
});

test("Linux PSS sampling rejects PID reuse and category drift", () => {
  withProcFixture((procRoot) => {
    writeProcess(procRoot, { pid: 200, start: "2000", pssKb: 10, rssKb: 20 });
    let category = "editor-main";
    const sampler = new LinuxPssTreeSampler({
      rootPid: 200,
      rootStartTimeTicks: "2000",
      procRoot,
      clock: () => 0n,
      classify: () => category
    });
    sampler.sample();
    category = "extension-host";
    assert.throws(() => sampler.sample(), /changed PSS category/u);

    category = "editor-main";
    writeProcess(procRoot, { pid: 200, start: "2999", pssKb: 10, rssKb: 20 });
    assert.throws(() => sampler.sample(), /launch-time process identity/u);
  });
});

test("Linux PSS sampling fails closed when population changes between metric-sandwich censuses", () => {
  withProcFixture((procRoot) => {
    writeProcess(procRoot, { pid: 250, start: "2500", pssKb: 10, rssKb: 20 });
    writeProcess(procRoot, { pid: 251, parentPid: 250, start: "2501", pssKb: 5, rssKb: 10 });
    let directoryReads = 0;
    const sampler = new LinuxPssTreeSampler({
      rootPid: 250,
      rootStartTimeTicks: "2500",
      procRoot,
      clock: () => 0n,
      readDirectory: (path) => {
        const entries = readdirSync(path);
        directoryReads += 1;
        return directoryReads === 1 ? entries.filter((entry) => entry !== "251") : entries;
      },
      classify: () => "editor-main"
    });
    assert.throws(() => sampler.sample(), /population changed/u);
  });
});

test("Linux PSS sampling ignores unrelated process churn between full censuses", () => {
  withProcFixture((procRoot) => {
    writeProcess(procRoot, { pid: 260, start: "2600", pssKb: 10, rssKb: 20 });
    writeProcess(procRoot, { pid: 999, start: "9990", pssKb: 1, rssKb: 1 });
    let directoryReads = 0;
    const sampler = new LinuxPssTreeSampler({
      rootPid: 260,
      rootStartTimeTicks: "2600",
      procRoot,
      clock: () => 0n,
      readDirectory: (path) => {
        const entries = readdirSync(path);
        directoryReads += 1;
        return directoryReads === 1 ? entries.filter((entry) => entry !== "999") : entries;
      },
      classify: () => "editor-main"
    });
    assert.deepEqual(
      sampler.sample().processes.map((process) => process.pid),
      [260]
    );
  });
});

test("Linux PSS sampling fails closed when an owned identity changes around its metric read", () => {
  withProcFixture((procRoot) => {
    writeProcess(procRoot, { pid: 275, start: "2750", pssKb: 10, rssKb: 20 });
    writeProcess(procRoot, { pid: 276, parentPid: 275, start: "2751", pssKb: 5, rssKb: 10 });
    let childStatReads = 0;
    const sampler = new LinuxPssTreeSampler({
      rootPid: 275,
      rootStartTimeTicks: "2750",
      procRoot,
      clock: () => 0n,
      readFile: (path, encoding) => {
        if (path.endsWith("/276/stat")) {
          childStatReads += 1;
          return makeStat(276, 275, childStatReads < 3 ? "2751" : "2799");
        }
        return readFileSync(path, encoding);
      },
      classify: () => "editor-main"
    });
    assert.throws(() => sampler.sample(), /changed identity or parentage/u);
  });
});

test("Linux PSS sampling skips vanished unrelated and exited retained entries but rejects a vanished editor root", () => {
  withProcFixture((procRoot) => {
    writeProcess(procRoot, { pid: 280, start: "2800", pssKb: 10, rssKb: 20 });
    writeProcess(procRoot, { pid: 999, start: "9990", pssKb: 1, rssKb: 1 });
    const sampler = new LinuxPssTreeSampler({
      rootPid: 280,
      rootStartTimeTicks: "2800",
      procRoot,
      clock: () => 0n,
      readFile: (path, encoding) => {
        if (path.endsWith("/999/stat")) {
          throw procError("ENOENT");
        }
        return readFileSync(path, encoding);
      },
      classify: () => "editor-main"
    });
    assert.deepEqual(
      sampler.sample().processes.map((process) => process.pid),
      [280]
    );
  });

  withProcFixture((procRoot) => {
    writeProcess(procRoot, { pid: 285, start: "2850", pssKb: 10, rssKb: 20 });
    let rootMustVanish = false;
    const sampler = new LinuxPssTreeSampler({
      rootPid: 285,
      rootStartTimeTicks: "2850",
      procRoot,
      clock: () => 0n,
      readFile: (path, encoding) => {
        if (rootMustVanish && path.endsWith("/285/stat")) {
          throw procError("ESRCH");
        }
        return readFileSync(path, encoding);
      },
      classify: () => "editor-main"
    });
    rootMustVanish = true;
    assert.throws(() => sampler.sample(), /Owned Linux PID 285 vanished/u);
  });

  withProcFixture((procRoot) => {
    writeProcess(procRoot, { pid: 286, start: "2860", pssKb: 10, rssKb: 20 });
    writeProcess(procRoot, { pid: 288, parentPid: 286, start: "2861", pssKb: 5, rssKb: 10 });
    let childMustVanish = false;
    const sampler = new LinuxPssTreeSampler({
      rootPid: 286,
      rootStartTimeTicks: "2860",
      procRoot,
      clock: () => 0n,
      readFile: (path, encoding) => {
        if (childMustVanish && path.endsWith("/288/stat")) {
          throw procError("ENOENT");
        }
        return readFileSync(path, encoding);
      },
      classify: ({ pid }) => (pid === 286 ? "editor-main" : "other-owned-child")
    });
    assert.deepEqual(
      sampler.sample().processes.map((process) => process.pid),
      [286, 288]
    );
    childMustVanish = true;
    assert.deepEqual(
      sampler.sample().processes.map((process) => process.pid),
      [286]
    );
  });
});

test("Linux PSS sampling rejects an unreadable unrelated process without leaking its path", () => {
  withProcFixture((procRoot) => {
    writeProcess(procRoot, { pid: 287, start: "2870", pssKb: 10, rssKb: 20 });
    writeProcess(procRoot, { pid: 999, start: "9990", pssKb: 1, rssKb: 1 });
    const sampler = new LinuxPssTreeSampler({
      rootPid: 287,
      rootStartTimeTicks: "2870",
      procRoot,
      clock: () => 0n,
      readFile: (path, encoding) => {
        if (path.endsWith("/999/stat")) {
          throw procError("EACCES");
        }
        return readFileSync(path, encoding);
      },
      classify: () => "editor-main"
    });
    assert.throws(
      () => sampler.sample(),
      (error) =>
        error instanceof Error &&
        /Could not read process identity/u.test(error.message) &&
        !error.message.includes(procRoot)
    );
  });
});

test("Linux PSS sampling rejects safe-integer overflow in aggregate PSS", () => {
  withProcFixture((procRoot) => {
    writeProcess(procRoot, { pid: 290, start: "2900", pssKb: 5_000_000_000_000, rssKb: 1 });
    writeProcess(procRoot, {
      pid: 291,
      parentPid: 290,
      start: "2901",
      pssKb: 5_000_000_000_000,
      rssKb: 1
    });
    const sampler = new LinuxPssTreeSampler({
      rootPid: 290,
      rootStartTimeTicks: "2900",
      procRoot,
      clock: () => 0n,
      classify: ({ pid }) => (pid === 290 ? "editor-main" : "other-owned-child")
    });
    assert.throws(() => sampler.sample(), /Total PSS exceeds the safe integer range/u);
  });
});

test("Linux PSS sampling retains every discovered owned identity before a metric read fails", () => {
  withProcFixture((procRoot) => {
    writeProcess(procRoot, { pid: 275, start: "2750", pssKb: 10, rssKb: 20 });
    writeProcess(procRoot, { pid: 276, parentPid: 275, start: "2751", pssKb: 5, rssKb: 10 });
    const sampler = new LinuxPssTreeSampler({
      rootPid: 275,
      rootStartTimeTicks: "2750",
      procRoot,
      clock: () => 0n,
      readFile: (path, encoding) => {
        if (path === resolve(procRoot, "276", "smaps_rollup")) {
          const error = new Error("fixture metric failure");
          error.code = "EACCES";
          throw error;
        }
        return readFileSync(path, encoding);
      },
      classify: ({ pid }) => (pid === 275 ? "editor-main" : "extension-host")
    });
    assert.throws(() => sampler.sample(), /Could not read PSS rollup/u);
    assert.deepEqual(sampler.retainedOwnedIdentities(), [
      { pid: 275, startTimeTicks: "2750" },
      { pid: 276, startTimeTicks: "2751" }
    ]);
  });
});

test("the collector publishes cumulative ownership after a newly discovered child metric fails", async () => {
  await withProcFixture(async (procRoot) => {
    writeProcess(procRoot, { pid: 280, start: "2800", pssKb: 10, rssKb: 20 });
    writeProcess(procRoot, { pid: 281, parentPid: 280, start: "2801", pssKb: 5, rssKb: 10 });
    const sampler = new LinuxPssTreeSampler({
      rootPid: 280,
      rootStartTimeTicks: "2800",
      procRoot,
      clock: () => 0n,
      readFile: (path, encoding) => {
        if (path === resolve(procRoot, "281", "smaps_rollup")) {
          throw new Error("fixture child metric failure");
        }
        return readFileSync(path, encoding);
      },
      classify: ({ pid }) => (pid === 280 ? "editor-main" : "extension-host")
    });
    const observation = await collectLinuxPssObservation({
      sampler,
      signal: new AbortController().signal,
      scheduleClock: () => 0n
    });
    assert.equal(observation.valid, false);
    assert.deepEqual(observation.retainedOwnedIdentities, [
      { pid: 280, startTimeTicks: "2800" },
      { pid: 281, startTimeTicks: "2801" }
    ]);
  });
});

test("the 200 ms collector returns a bounded invalid resource observation on sampling failure", async () => {
  await withProcFixture(async (procRoot) => {
    writeProcess(procRoot, { pid: 300, start: "3000", pssKb: 10, rssKb: 20 });
    let now = 0;
    const sampler = new LinuxPssTreeSampler({
      rootPid: 300,
      rootStartTimeTicks: "3000",
      procRoot,
      clock: () => msNanoseconds(now),
      classify: () => "editor-main"
    });
    let waits = 0;
    const controller = new AbortController();
    const observation = await collectLinuxPssObservation({
      sampler,
      signal: controller.signal,
      scheduleClock: () => msNanoseconds(now),
      wait: async (milliseconds) => {
        waits += 1;
        now += milliseconds;
        if (waits === 1) {
          rmSync(resolve(procRoot, "300", "smaps_rollup"));
        }
      }
    });
    assert.equal(observation.valid, false);
    assert.equal(observation.reasonClass, "resource-sampling");
    assert.equal(observation.missedSamples, 1);
    assert.equal(observation.samples.length, 1);
    assert.equal(JSON.stringify(observation).includes(procRoot), false);
  });
});

test("the collector fails closed before exceeding the fixed maximum trial sample count", async () => {
  await withProcFixture(async (procRoot) => {
    writeProcess(procRoot, { pid: 305, start: "3050", pssKb: 10, rssKb: 20 });
    let now = 0;
    const sampler = new LinuxPssTreeSampler({
      rootPid: 305,
      rootStartTimeTicks: "3050",
      procRoot,
      clock: () => msNanoseconds(now),
      classify: () => "editor-main"
    });
    const observation = await collectLinuxPssObservation({
      sampler,
      signal: new AbortController().signal,
      scheduleClock: () => msNanoseconds(now),
      wait: async (milliseconds) => {
        now += milliseconds;
      }
    });
    assert.equal(observation.valid, false);
    assert.equal(observation.reasonClass, "resource-sampling");
    assert.equal(observation.missedSamples, 1);
    assert.equal(observation.samples.length, DATA_WRANGLER_STUDY_MAXIMUM_RESOURCE_SAMPLES);
  });
});

test("the collector reports a missed interval instead of hiding a sampling stall", async () => {
  await withProcFixture(async (procRoot) => {
    writeProcess(procRoot, { pid: 400, start: "4000", pssKb: 10, rssKb: 20 });
    const sampler = new LinuxPssTreeSampler({
      rootPid: 400,
      rootStartTimeTicks: "4000",
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

test("the collector derives multi-period sampler stalls from the absolute monotonic clock", async () => {
  await withProcFixture(async (procRoot) => {
    writeProcess(procRoot, { pid: 405, start: "4050", pssKb: 10, rssKb: 20 });
    let now = 0;
    const sampler = new LinuxPssTreeSampler({
      rootPid: 405,
      rootStartTimeTicks: "4050",
      procRoot,
      clock: () => msNanoseconds(now),
      readFile: (path, encoding) => {
        if (path === resolve(procRoot, "405", "smaps_rollup")) {
          now += 650;
          throw new Error("fixture read stall");
        }
        return readFileSync(path, encoding);
      },
      classify: () => "editor-main"
    });
    const observation = await collectLinuxPssObservation({
      sampler,
      signal: new AbortController().signal,
      scheduleClock: () => msNanoseconds(now)
    });
    assert.equal(observation.valid, false);
    assert.equal(observation.missedSamples, 3);
    assert.equal(observation.samples.length, 0);
  });
});

test("the collector derives multi-period callback stalls from the absolute monotonic clock", async () => {
  await withProcFixture(async (procRoot) => {
    writeProcess(procRoot, { pid: 410, start: "4100", pssKb: 10, rssKb: 20 });
    let now = 0;
    const sampler = new LinuxPssTreeSampler({
      rootPid: 410,
      rootStartTimeTicks: "4100",
      procRoot,
      clock: () => msNanoseconds(now),
      classify: () => "editor-main"
    });
    const observation = await collectLinuxPssObservation({
      sampler,
      signal: new AbortController().signal,
      scheduleClock: () => msNanoseconds(now),
      onSample: () => {
        now += 650;
        throw new Error("fixture callback stall");
      }
    });
    assert.equal(observation.valid, false);
    assert.equal(observation.missedSamples, 3);
    assert.equal(observation.samples.length, 1);
  });
});

test("the collector derives multi-period wait stalls from the absolute monotonic clock", async () => {
  await withProcFixture(async (procRoot) => {
    writeProcess(procRoot, { pid: 415, start: "4150", pssKb: 10, rssKb: 20 });
    let now = 0;
    const sampler = new LinuxPssTreeSampler({
      rootPid: 415,
      rootStartTimeTicks: "4150",
      procRoot,
      clock: () => msNanoseconds(now),
      classify: () => "editor-main"
    });
    const observation = await collectLinuxPssObservation({
      sampler,
      signal: new AbortController().signal,
      scheduleClock: () => msNanoseconds(now),
      wait: async (milliseconds) => {
        now += milliseconds + 650;
      }
    });
    assert.equal(observation.valid, false);
    assert.equal(observation.missedSamples, 3);
    assert.equal(observation.samples.length, 1);
  });
});

test("the collector invalidates a 199 ms wait overshoot under the retained 50 ms lateness bound", async () => {
  await withProcFixture(async (procRoot) => {
    writeProcess(procRoot, { pid: 425, start: "4250", pssKb: 10, rssKb: 20 });
    let now = 0;
    const sampler = new LinuxPssTreeSampler({
      rootPid: 425,
      rootStartTimeTicks: "4250",
      procRoot,
      clock: () => msNanoseconds(now),
      classify: () => "editor-main"
    });
    const observation = await collectLinuxPssObservation({
      sampler,
      signal: new AbortController().signal,
      scheduleClock: () => msNanoseconds(now),
      wait: async (milliseconds) => {
        now += milliseconds + 199;
      }
    });
    assert.equal(observation.valid, false);
    assert.equal(observation.maximumLatenessMs, 50);
    assert.equal(observation.missedSamples, 1);
    assert.equal(observation.samples.length, 1);
  });
});

test("the collector publishes a synchronous five-sample stable-baseline acknowledgement", async () => {
  await withProcFixture(async (procRoot) => {
    writeProcess(procRoot, { pid: 430, start: "4300", pssKb: 10, rssKb: 20 });
    let now = 0;
    let waits = 0;
    const acknowledgements = [];
    const controller = new AbortController();
    const sampler = new LinuxPssTreeSampler({
      rootPid: 430,
      rootStartTimeTicks: "4300",
      procRoot,
      clock: () => msNanoseconds(now),
      classify: () => "editor-main"
    });
    const observation = await collectLinuxPssObservation({
      sampler,
      signal: controller.signal,
      scheduleClock: () => msNanoseconds(now),
      onSample: (acknowledgement) => {
        acknowledgements.push(acknowledgement);
        if (acknowledgement.stableBaseline !== null) {
          controller.abort();
        }
      },
      wait: async (milliseconds) => {
        now += milliseconds;
        waits += 1;
        assert.ok(waits <= 4);
      }
    });
    assert.equal(observation.valid, true);
    assert.equal(acknowledgements.length, 5);
    assert.equal(acknowledgements[3].stableBaseline, null);
    assert.deepEqual(acknowledgements[4].stableBaseline, {
      sampleCount: 5,
      firstSampleIndex: 0,
      lastSampleIndex: 4,
      firstStartedMonotonicNanoseconds: "0",
      lastEndedMonotonicNanoseconds: "800000000",
      medianPssBytes: 10 * 1024,
      rangePssBytes: 0,
      maximumRangePssBytes: 64 * 1024 * 1024
    });
    assert.equal(Object.isFrozen(acknowledgements[4].stableBaseline), true);
  });
});

test("the collector stops on the first sample at or after its exact absolute terminal boundary", async () => {
  await withProcFixture(async (procRoot) => {
    writeProcess(procRoot, { pid: 440, start: "4400", pssKb: 10, rssKb: 20 });
    let now = 0;
    const sampler = new LinuxPssTreeSampler({
      rootPid: 440,
      rootStartTimeTicks: "4400",
      procRoot,
      clock: () => msNanoseconds(now),
      classify: () => "editor-main"
    });
    const observation = await collectLinuxPssObservation({
      sampler,
      signal: new AbortController().signal,
      scheduleClock: () => msNanoseconds(now),
      getTerminalBoundaryNanoseconds: () => msNanoseconds(850),
      wait: async (milliseconds) => {
        now += milliseconds;
      }
    });
    assert.equal(observation.valid, true);
    assert.equal(observation.samples.length, 6);
    assert.equal(observation.samples.at(-2).elapsedMs, 800);
    assert.equal(observation.samples.at(-1).elapsedMs, 1_000);
    assert.deepEqual(observation.terminalBoundary, {
      targetMonotonicNanoseconds: "850000000",
      firstEligibleSampleScheduledMonotonicNanoseconds: "1000000000",
      firstEligibleSampleStartedMonotonicNanoseconds: "1000000000",
      firstEligibleSampleEndedMonotonicNanoseconds: "1000000000",
      startOvershootMs: 150,
      sampleLatenessMs: 0,
      maximumOvershootMs: 250
    });
  });
});

test("the collector rejects a sample that only ends after the terminal target and waits for the next start", async () => {
  await withProcFixture(async (procRoot) => {
    writeProcess(procRoot, { pid: 445, start: "4450", pssKb: 10, rssKb: 20 });
    let now = 0;
    let expandedStraddlingRead = false;
    const sampler = new LinuxPssTreeSampler({
      rootPid: 445,
      rootStartTimeTicks: "4450",
      procRoot,
      clock: () => msNanoseconds(now),
      readFile: (path, encoding) => {
        if (!expandedStraddlingRead && now === 800 && path === resolve(procRoot, "445", "smaps_rollup")) {
          expandedStraddlingRead = true;
          now += 40;
        }
        return readFileSync(path, encoding);
      },
      classify: () => "editor-main"
    });
    const observation = await collectLinuxPssObservation({
      sampler,
      signal: new AbortController().signal,
      scheduleClock: () => msNanoseconds(now),
      getTerminalBoundaryNanoseconds: () => msNanoseconds(825),
      wait: async (milliseconds) => {
        now += milliseconds;
      }
    });
    assert.equal(observation.valid, true);
    assert.equal(observation.samples.length, 6);
    assert.equal(observation.samples.at(-2).startedMonotonicNanoseconds, "800000000");
    assert.equal(observation.samples.at(-2).endedMonotonicNanoseconds, "840000000");
    assert.equal(observation.samples.at(-1).startedMonotonicNanoseconds, "1000000000");
    assert.equal(observation.terminalBoundary.firstEligibleSampleStartedMonotonicNanoseconds, "1000000000");
  });
});

test("the collector rejects pre-aborted and sparse observations", async () => {
  await withProcFixture(async (procRoot) => {
    writeProcess(procRoot, { pid: 450, start: "4500", pssKb: 10, rssKb: 20 });
    let now = 0;
    const sampler = new LinuxPssTreeSampler({
      rootPid: 450,
      rootStartTimeTicks: "4500",
      procRoot,
      clock: () => msNanoseconds(now),
      classify: () => "editor-main"
    });

    const preAborted = new AbortController();
    preAborted.abort();
    const empty = await collectLinuxPssObservation({
      sampler,
      signal: preAborted.signal,
      scheduleClock: () => msNanoseconds(now)
    });
    assert.equal(empty.valid, false);
    assert.equal(empty.missedSamples, 0);
    assert.equal(empty.samples.length, 0);

    let waits = 0;
    const sparseController = new AbortController();
    const sparse = await collectLinuxPssObservation({
      sampler,
      signal: sparseController.signal,
      scheduleClock: () => msNanoseconds(now),
      wait: async (milliseconds) => {
        now += milliseconds;
        waits += 1;
        if (waits === 4) {
          sparseController.abort();
        }
      }
    });
    assert.equal(sparse.valid, false);
    assert.equal(sparse.missedSamples, 0);
    assert.equal(sparse.samples.length, 4);
  });
});

test("the collector returns a valid observation when terminal abort occurs exactly on the next due instant", async () => {
  await withProcFixture(async (procRoot) => {
    const { controller, observation } = await collectWithTerminalOffset(procRoot, 500, 0);
    assert.equal(controller.signal.aborted, true);
    assert.equal(observation.valid, true);
    assert.equal(observation.reasonClass, null);
    assert.equal(observation.missedSamples, 0);
    assert.equal(observation.samples.length, 5);
    assert.deepEqual(
      observation.samples.map((sample) => sample.elapsedMs),
      [0, 200, 400, 600, 800]
    );
  });
});

test("the collector rejects a terminal abort one millisecond after the next due instant", async () => {
  await withProcFixture(async (procRoot) => {
    const { observation } = await collectWithLoopTransitionAbort(procRoot, 550, 1);
    assert.equal(observation.valid, false);
    assert.equal(observation.reasonClass, "resource-sampling");
    assert.equal(observation.missedSamples, 1);
    assert.equal(observation.samples.length, 5);
  });
});

test("the collector rejects a terminal abort 199 milliseconds after the next due instant", async () => {
  await withProcFixture(async (procRoot) => {
    const { observation } = await collectWithLoopTransitionAbort(procRoot, 600, 199);
    assert.equal(observation.valid, false);
    assert.equal(observation.reasonClass, "resource-sampling");
    assert.equal(observation.missedSamples, 1);
    assert.equal(observation.samples.length, 5);
  });
});

async function collectWithLoopTransitionAbort(procRoot, pid, terminalOffsetMs) {
  writeProcess(procRoot, { pid, start: `${pid}0`, pssKb: 10, rssKb: 20 });
  let now = 0;
  let waits = 0;
  let armed = false;
  let postWaitChecksRemaining = 0;
  const controller = new AbortController();
  const signal = {
    get aborted() {
      if (armed && !controller.signal.aborted) {
        if (postWaitChecksRemaining > 0) {
          postWaitChecksRemaining -= 1;
        } else {
          now += terminalOffsetMs;
          controller.abort();
        }
      }
      return controller.signal.aborted;
    },
    addEventListener: (...arguments_) => controller.signal.addEventListener(...arguments_),
    removeEventListener: (...arguments_) => controller.signal.removeEventListener(...arguments_)
  };
  const sampler = new LinuxPssTreeSampler({
    rootPid: pid,
    rootStartTimeTicks: `${pid}0`,
    procRoot,
    clock: () => msNanoseconds(now),
    classify: () => "editor-main"
  });
  const observation = await collectLinuxPssObservation({
    sampler,
    signal,
    scheduleClock: () => msNanoseconds(now),
    wait: async (milliseconds) => {
      now += milliseconds;
      waits += 1;
      if (waits === 5) {
        armed = true;
        // The collector checks once after the wait and once after leaving the
        // wait loop. The following read is the next sample-loop transition.
        postWaitChecksRemaining = 2;
      }
    }
  });
  return { observation };
}

async function collectWithTerminalOffset(procRoot, pid, terminalOffsetMs) {
  writeProcess(procRoot, { pid, start: `${pid}0`, pssKb: 10, rssKb: 20 });
  let now = 0;
  let waits = 0;
  const controller = new AbortController();
  const sampler = new LinuxPssTreeSampler({
    rootPid: pid,
    rootStartTimeTicks: `${pid}0`,
    procRoot,
    clock: () => msNanoseconds(now),
    classify: () => "editor-main"
  });
  const observation = await collectLinuxPssObservation({
    sampler,
    signal: controller.signal,
    scheduleClock: () => msNanoseconds(now),
    wait: async (milliseconds) => {
      now += milliseconds;
      waits += 1;
      if (waits === 5) {
        now += terminalOffsetMs;
        controller.abort();
      }
    }
  });
  return { controller, observation };
}

function writeProcess(
  procRoot,
  { pid, parentPid = 0, processGroupId, sessionId, start, state = "S", taskChildren = [], workers = [], pssKb, rssKb }
) {
  const directory = resolve(procRoot, String(pid));
  rmSync(directory, { recursive: true, force: true });
  mkdirSync(directory, { recursive: true });
  const inherited = parentPid > 0 ? readFixtureOwnership(procRoot, parentPid) : null;
  const resolvedProcessGroupId = processGroupId ?? inherited?.processGroupId ?? pid;
  const resolvedSessionId = sessionId ?? inherited?.sessionId ?? pid;
  writeFileSync(
    resolve(directory, "stat"),
    makeStat(pid, parentPid, start, state, resolvedProcessGroupId, resolvedSessionId)
  );
  writeFileSync(resolve(directory, "status"), `Name:\tow-test-${pid}\nNSpid:\t${pid}\t1\n`);
  const tasks = [{ tid: pid, start, children: taskChildren }, ...workers];
  for (const task of tasks) {
    const taskDirectory = resolve(directory, "task", String(task.tid));
    mkdirSync(taskDirectory, { recursive: true });
    writeFileSync(
      resolve(taskDirectory, "stat"),
      makeStat(task.tid, parentPid, task.start, state, resolvedProcessGroupId, resolvedSessionId)
    );
    writeFileSync(resolve(taskDirectory, "children"), `${task.children.join(" ")}\n`);
  }
  writeFileSync(resolve(directory, "smaps_rollup"), `Rss: ${rssKb} kB\nPss: ${pssKb} kB\n`);
}

function readFixtureOwnership(procRoot, pid) {
  const stat = readFileSync(resolve(procRoot, String(pid), "stat"), "utf8");
  const fields = stat
    .slice(stat.lastIndexOf(")") + 2)
    .trim()
    .split(/\s+/u);
  return {
    processGroupId: Number(fields[2]),
    sessionId: Number(fields[3])
  };
}

function existsProcess(procRoot, pid) {
  try {
    readFileSync(resolve(procRoot, String(pid), "stat"), "utf8");
    return true;
  } catch {
    return false;
  }
}

function reparentProcess(procRoot, pid, parentPid) {
  const path = resolve(procRoot, String(pid), "stat");
  const stat = readFileSync(path, "utf8");
  const fields = stat
    .slice(stat.lastIndexOf(")") + 2)
    .trim()
    .split(/\s+/u);
  writeFileSync(path, makeStat(pid, parentPid, fields[19], fields[0], Number(fields[2]), Number(fields[3])));
}

function makeStat(id, parentPid, start, state = "S", processGroupId = id, sessionId = processGroupId) {
  const fieldsBeforeStart = Array(17).fill("0");
  fieldsBeforeStart[0] = String(processGroupId);
  fieldsBeforeStart[1] = String(sessionId);
  return `${id} (ow-test-${id}) ${state} ${parentPid} ${fieldsBeforeStart.join(" ")} ${start} 0 0\n`;
}

function sequentialClock(values) {
  let index = 0;
  return () => BigInt(values[Math.min(index++, values.length - 1)]) * 1_000_000n;
}

function msNanoseconds(value) {
  return BigInt(value) * 1_000_000n;
}

function procError(code) {
  const error = new Error("simulated procfs race");
  error.code = code;
  return error;
}

function testFilesystemIdentity() {
  return { device: "8", inode: "42", sizeBytes: 125_000, mtimeNs: "1000000000" };
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
