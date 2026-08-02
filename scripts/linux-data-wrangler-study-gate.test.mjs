import assert from "node:assert/strict";
import test from "node:test";
import {
  LINUX_DATA_WRANGLER_STUDY_GATE_SELECTION_POLICY,
  captureLinuxDataWranglerStudyProvenance,
  formatLinuxCpuList,
  parseLinuxCpuList,
  runLinuxDataWranglerStudyGate
} from "./linux-data-wrangler-study-gate.mjs";

const DISPLAY = Object.freeze({
  mode: "headless-ozone",
  width: 1920,
  height: 1080,
  scaleFactor: 1,
  zoomLevel: 0,
  theme: "Default Dark Modern"
});

test("Linux provenance is path-free and pins CPU, power, governor, affinity, and headless display state", () => {
  const fixture = new LinuxStudyFixture();
  const provenance = captureLinuxDataWranglerStudyProvenance(
    { cpuIds: [0, 1], display: DISPLAY },
    fixture.dependencies()
  );
  assert.equal(provenance.platform, "linux");
  assert.equal(provenance.architecture, "x64");
  assert.equal(provenance.cpu.pinnedCpuIds.join(","), "0,1");
  assert.equal(provenance.cpu.onlineCpuList, "0-2");
  assert.equal(provenance.affinity.cpuList, "0-1");
  assert.deepEqual(provenance.power.externalSupplies, [{ name: "AC", type: "Mains", online: true }]);
  assert.deepEqual(provenance.power.governors, [
    { cpuId: 0, governor: "performance" },
    { cpuId: 1, governor: "performance" }
  ]);
  assert.deepEqual(
    provenance.power.thermalThrottleCounters.map((counter) => counter.id),
    ["cpu0-core", "cpu0-package", "cpu1-core", "cpu1-package"]
  );
  assert.deepEqual(provenance.display.hostEnvironment, {
    displaySet: false,
    waylandDisplaySet: false,
    xdgSessionTypeSet: false
  });
  const serialized = JSON.stringify(provenance);
  assert.doesNotMatch(serialized, /\/proc|\/sys|\/home|\/tmp/u);
});

test("Linux provenance accepts colon-bearing USB-C power-supply names", () => {
  const fixture = new LinuxStudyFixture();
  const dependencies = fixture.dependencies();
  const readDirectory = dependencies.readDirectory;
  const readText = dependencies.readText;
  const usbSupply = "ucsi-source-psy-USBC000:001";
  dependencies.readDirectory = (path) =>
    path === "/sys/class/power_supply" ? ["BAT0", "AC", usbSupply] : readDirectory(path);
  dependencies.readText = (path) => {
    if (path === `/sys/class/power_supply/${usbSupply}/type`) return "USB_C\n";
    if (path === `/sys/class/power_supply/${usbSupply}/online`) return "0\n";
    return readText(path);
  };
  const provenance = captureLinuxDataWranglerStudyProvenance({ cpuIds: [0, 1], display: DISPLAY }, dependencies);
  assert.deepEqual(provenance.power.externalSupplies, [
    { name: "AC", type: "Mains", online: true },
    { name: usbSupply, type: "USB_C", online: false }
  ]);
});

test("CPU-list parsing canonicalizes ranges and rejects overlap", () => {
  assert.deepEqual(parseLinuxCpuList("0-2,4,6-7"), [0, 1, 2, 4, 6, 7]);
  assert.equal(formatLinuxCpuList([0, 1, 2, 4, 6, 7]), "0-2,4,6-7");
  assert.throws(() => parseLinuxCpuList("0-2,2-3"), /overlapping/u);
  assert.throws(() => parseLinuxCpuList("2-1"), /invalid/u);
});

test("the gate uses only manifest-pinned cpuN lines", async () => {
  const fixture = new LinuxStudyFixture({
    cpuPercent: (_second, cpuId) => (cpuId === 2 ? 100 : 5)
  });
  const expectedProvenance = fixture.provenance();
  const result = await runLinuxDataWranglerStudyGate(
    { expectedProvenance, maximumWaitMs: 10_250 },
    fixture.dependencies()
  );
  assert.equal(result.passed, true);
  assert.equal(result.attempts[0].summary.meanNonIdleCpuPercent, 5);
  assert.equal(result.attempts[0].summary.maximumOneSecondNonIdleCpuPercent, 5);
  assert.deepEqual(result.attempts[0].summary.cpuIds, [0, 1]);
  assert.equal(result.attempts[0].summary.affinityMatched, true);
  assert.equal(result.waitMs, 10_000);
  assert.equal(result.terminalFailure, null);
});

test("the first passing ten-second window is accepted prospectively and every earlier window is retained", async () => {
  const fixture = new LinuxStudyFixture({
    cpuPercent: (second, cpuId) => {
      if (cpuId === 2) return 100;
      return second === 1 ? 30 : 5;
    }
  });
  const expectedProvenance = fixture.provenance();
  const result = await runLinuxDataWranglerStudyGate(
    { expectedProvenance, maximumWaitMs: 20_250 },
    fixture.dependencies()
  );
  assert.equal(result.selectionPolicy, LINUX_DATA_WRANGLER_STUDY_GATE_SELECTION_POLICY);
  assert.equal(result.passed, true);
  assert.equal(result.acceptedAttempt, 2);
  assert.equal(result.attempts.length, 2);
  assert.deepEqual(
    result.attempts.map((attempt) => attempt.startedAtOffsetMs),
    [0, 10_000]
  );
  assert.equal(result.attempts[0].durationMs, 10_000);
  assert.equal(result.attempts[1].durationMs, 10_000);
  assert.equal(result.attempts[0].intervals.length, 10);
  assert.equal(result.attempts[1].intervals.length, 10);
  assert.deepEqual(result.attempts[0].failureCodes, ["cpu-window"]);
  assert.equal(result.attempts[0].intervals[0].nonIdleCpuPercent, 30);
  assert.deepEqual(result.attempts[1].failureCodes, []);
  assert.equal(result.waitMs, 20_000);
  assert.equal(result.terminalFailure, null);
});

test("the monotonic deadline keeps provenance overhead in actual offsets and does not start a window that cannot fit", async () => {
  const retainedFixture = new LinuxStudyFixture({
    cpuPercent: (second, cpuId) => {
      if (cpuId === 2) return 100;
      return second === 1 ? 30 : 5;
    }
  });
  const retainedProvenance = retainedFixture.provenance();
  const retainedDependencies = retainedFixture.dependencies();
  const retainedReadText = retainedDependencies.readText;
  retainedDependencies.readText = (path) => {
    if (path === "/proc/cpuinfo") retainedFixture.timeMs += 125;
    return retainedReadText(path);
  };
  const retained = await runLinuxDataWranglerStudyGate(
    { expectedProvenance: retainedProvenance, maximumWaitMs: 22_000 },
    retainedDependencies
  );
  assert.equal(retained.passed, true);
  assert.deepEqual(
    retained.attempts.map((attempt) => attempt.startedAtOffsetMs),
    [125, 10_250]
  );
  assert.deepEqual(
    retained.attempts.map((attempt) => attempt.durationMs),
    [10_000, 10_000]
  );
  assert.equal(retained.waitMs, 20_250);

  const exhaustedFixture = new LinuxStudyFixture();
  const exhaustedProvenance = exhaustedFixture.provenance();
  const exhaustedDependencies = exhaustedFixture.dependencies();
  const exhaustedReadText = exhaustedDependencies.readText;
  exhaustedDependencies.readText = (path) => {
    if (path === "/proc/cpuinfo") exhaustedFixture.timeMs += 1;
    return exhaustedReadText(path);
  };
  const exhausted = await runLinuxDataWranglerStudyGate(
    { expectedProvenance: exhaustedProvenance, maximumWaitMs: 10_250 },
    exhaustedDependencies
  );
  assert.equal(exhausted.passed, false);
  assert.equal(exhausted.waitMs, 1);
  assert.equal(exhausted.attempts.length, 0);
  assert.equal(exhausted.terminalFailure, "deadline-no-complete-window");
});

test("the full 250 ms sampling-lateness allowance is reserved and its exact deadline boundary passes", async () => {
  const boundaryFixture = new LinuxStudyFixture();
  const boundaryProvenance = boundaryFixture.provenance();
  const boundaryDependencies = boundaryFixture.dependencies();
  const boundaryReadText = boundaryDependencies.readText;
  boundaryDependencies.readText = (path) => {
    const value = boundaryReadText(path);
    if (path === "/proc/self/status" && boundaryFixture.timeMs === 10_000) {
      boundaryFixture.timeMs += 250;
    }
    return value;
  };
  const boundary = await runLinuxDataWranglerStudyGate(
    { expectedProvenance: boundaryProvenance, maximumWaitMs: 10_250 },
    boundaryDependencies
  );
  assert.equal(boundary.passed, true);
  assert.equal(boundary.waitMs, 10_250);
  assert.equal(boundary.attempts[0].durationMs, 10_250);
  assert.equal(boundary.terminalFailure, null);

  const overrunFixture = new LinuxStudyFixture();
  const overrunProvenance = overrunFixture.provenance();
  const overrunDependencies = overrunFixture.dependencies();
  const overrunReadText = overrunDependencies.readText;
  overrunDependencies.readText = (path) => {
    const value = overrunReadText(path);
    if (path === "/proc/self/status" && overrunFixture.timeMs === 10_000) {
      overrunFixture.timeMs += 251;
    }
    return value;
  };
  const overrun = await runLinuxDataWranglerStudyGate(
    { expectedProvenance: overrunProvenance, maximumWaitMs: 10_250 },
    overrunDependencies
  );
  assert.equal(overrun.passed, false);
  assert.equal(overrun.waitMs, 10_251);
  assert.equal(overrun.attempts[0].failureCodes.includes("sample-timing"), true);
  assert.equal(overrun.terminalFailure, "deadline-no-complete-window");
});

test("an unavailable sampler still retains its full attempted window without raw diagnostics", async () => {
  const fixture = new LinuxStudyFixture();
  const expectedProvenance = fixture.provenance();
  const dependencies = fixture.dependencies();
  const readText = dependencies.readText;
  dependencies.readText = (path) => {
    if (path === "/proc/stat") {
      throw new Error("/private/sampling/source should not be retained");
    }
    return readText(path);
  };
  const result = await runLinuxDataWranglerStudyGate({ expectedProvenance, maximumWaitMs: 10_250 }, dependencies);
  assert.equal(result.passed, false);
  assert.equal(result.attempts.length, 1);
  assert.equal(result.attempts[0].durationMs, 10_000);
  assert.equal(result.attempts[0].intervals.length, 10);
  assert.deepEqual(result.attempts[0].failureCodes, ["sampling-unavailable"]);
  assert.equal(result.terminalFailure, "deadline-no-complete-window");
  assert.doesNotMatch(JSON.stringify(result), /private|\/proc|\/sys/u);
});

test("each preregistered resource and environment threshold fails its complete attempted window", async (t) => {
  const cases = [
    ["cpu-mean", { cpuPercent: () => 11 }],
    ["cpu-window", { cpuPercent: (second) => (second === 1 ? 26 : 0) }],
    ["cpu-pressure", { cpuSomeAvg10Percent: (time) => (time >= 1_000 ? 1.01 : 0) }],
    ["memory-pressure", { memoryFullAvg10Percent: (time) => (time >= 1_000 ? 0.01 : 0) }],
    ["swap-activity", { swapPagesIn: (time) => (time >= 10_000 ? 1 : 0) }],
    ["thermal-throttle", { thermalCount: (time) => (time >= 10_000 ? 1 : 0) }],
    ["ac-power-drift", { acOnline: (time) => time < 1_000 }],
    ["governor-drift", { governor: (time) => (time >= 1_000 ? "powersave" : "performance") }],
    ["affinity-drift", { affinity: (time) => (time >= 1_000 ? "0" : "0-1") }]
  ];
  for (const [failureCode, scenario] of cases) {
    await t.test(failureCode, async () => {
      const fixture = new LinuxStudyFixture(scenario);
      const expectedProvenance = fixture.provenance();
      const result = await runLinuxDataWranglerStudyGate(
        { expectedProvenance, maximumWaitMs: 10_250 },
        fixture.dependencies()
      );
      assert.equal(result.passed, false);
      assert.equal(result.acceptedAttempt, null);
      assert.equal(result.attempts.length, 1);
      assert.equal(result.attempts[0].durationMs, 10_000);
      assert.equal(result.attempts[0].intervals.length, 10);
      assert.equal(
        result.attempts[0].failureCodes.includes(failureCode),
        true,
        result.attempts[0].failureCodes.join(",")
      );
    });
  }
});

class LinuxStudyFixture {
  constructor(scenario = {}) {
    this.timeMs = 0;
    this.scenario = {
      cpuPercent: () => 5,
      cpuSomeAvg10Percent: () => 0,
      memoryFullAvg10Percent: () => 0,
      swapPagesIn: () => 0,
      swapPagesOut: () => 0,
      thermalCount: () => 0,
      acOnline: () => true,
      governor: () => "performance",
      affinity: () => "0-1",
      ...scenario
    };
  }

  dependencies() {
    return {
      platform: "linux",
      architecture: () => "x64",
      kernelRelease: () => "6.14.0-study",
      environment: {},
      readText: (path) => this.readText(path),
      readDirectory: (path) => this.readDirectory(path),
      clock: () => this.timeMs,
      wait: async (milliseconds) => {
        this.timeMs += milliseconds;
      }
    };
  }

  provenance() {
    return captureLinuxDataWranglerStudyProvenance({ cpuIds: [0, 1], display: DISPLAY }, this.dependencies());
  }

  readDirectory(path) {
    if (path === "/sys/class/power_supply") return ["BAT0", "AC"];
    if (/^\/sys\/devices\/system\/cpu\/cpu[01]\/thermal_throttle$/u.test(path)) {
      return ["package_throttle_count", "core_throttle_count"];
    }
    throw fileNotFound();
  }

  readText(path) {
    if (path === "/proc/cpuinfo") {
      return [0, 1, 2]
        .map((cpuId) => `processor\t: ${cpuId}\nvendor_id\t: GenuineIntel\nmodel name\t: Synthetic Study CPU\n`)
        .join("\n");
    }
    if (path === "/sys/devices/system/cpu/online") return "0-2\n";
    if (path === "/proc/self/status")
      return `Name:\tstudy\nCpus_allowed_list:\t${this.scenario.affinity(this.timeMs)}\n`;
    if (path === "/proc/stat") return this.procStat();
    if (path === "/proc/pressure/cpu") {
      return `some avg10=${this.scenario.cpuSomeAvg10Percent(this.timeMs).toFixed(2)} avg60=0.00 avg300=0.00 total=0\n`;
    }
    if (path === "/proc/pressure/memory") {
      return `some avg10=0.00 avg60=0.00 avg300=0.00 total=0\nfull avg10=${this.scenario
        .memoryFullAvg10Percent(this.timeMs)
        .toFixed(2)} avg60=0.00 avg300=0.00 total=0\n`;
    }
    if (path === "/proc/vmstat") {
      return `pswpin ${this.scenario.swapPagesIn(this.timeMs)}\npswpout ${this.scenario.swapPagesOut(this.timeMs)}\n`;
    }
    if (path === "/sys/class/power_supply/AC/type") return "Mains\n";
    if (path === "/sys/class/power_supply/AC/online") return this.scenario.acOnline(this.timeMs) ? "1\n" : "0\n";
    if (path === "/sys/class/power_supply/BAT0/type") return "Battery\n";
    if (/^\/sys\/devices\/system\/cpu\/cpu[01]\/cpufreq\/scaling_governor$/u.test(path)) {
      return `${this.scenario.governor(this.timeMs)}\n`;
    }
    if (/^\/sys\/devices\/system\/cpu\/cpu[01]\/thermal_throttle\/(?:core|package)_throttle_count$/u.test(path)) {
      return `${this.scenario.thermalCount(this.timeMs)}\n`;
    }
    throw fileNotFound();
  }

  procStat() {
    const seconds = Math.floor(this.timeMs / 1_000);
    const lines = ["cpu 0 0 0 0 0 0 0 0 0 0"];
    for (const cpuId of [0, 1, 2]) {
      let busy = 100;
      for (let second = 1; second <= seconds; second += 1) {
        busy += this.scenario.cpuPercent(second, cpuId);
      }
      const total = 1_000 + seconds * 100;
      const idle = total - busy;
      lines.push(`cpu${cpuId} ${busy} 0 0 ${idle} 0 0 0 0 0 0`);
    }
    return `${lines.join("\n")}\n`;
  }
}

function fileNotFound() {
  return Object.assign(new Error("synthetic entry is absent"), { code: "ENOENT" });
}
