import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import {
  DATA_WRANGLER_STUDY_COMMON_EXTENSIONS,
  DATA_WRANGLER_STUDY_METHOD_PROTOCOL,
  DATA_WRANGLER_STUDY_PRODUCTS,
  createEmptyStudyMilestones,
  createStudyFragmentIdentity,
  digestStudyValue
} from "./data-wrangler-comparison-study.mjs";
import {
  parseDataWranglerComparisonStudyArguments,
  runDataWranglerComparisonStudy
} from "./run-data-wrangler-comparison-study.mjs";

const digest = (value) => value.repeat(64);

test("study command arguments are explicit and reject missing or repeated paths", () => {
  assert.deepEqual(
    parseDataWranglerComparisonStudyArguments(["plan", "--spec", "spec.json", "--out", "manifest.json"], "/work"),
    { command: "plan", spec: "/work/spec.json", out: "/work/manifest.json" }
  );
  assert.throws(
    () => parseDataWranglerComparisonStudyArguments(["plan", "--spec", "spec.json"], "/work"),
    /requires --out/u
  );
  assert.throws(
    () =>
      parseDataWranglerComparisonStudyArguments(
        ["status", "--manifest", "one.json", "--manifest", "two.json", "--fragments", "fragments"],
        "/work"
      ),
    /only once/u
  );
  assert.throws(() => parseDataWranglerComparisonStudyArguments(["launch"], "/work"), /Usage/u);
});

test("plan, record, and status preserve one immutable manifest and append-only fragment", () => {
  withDirectory((directory) => {
    const specificationPath = resolve(directory, "spec.json");
    const manifestPath = resolve(directory, "manifest.json");
    const fragmentInputPath = resolve(directory, "fragment-input.json");
    const fragments = resolve(directory, "fragments");
    writeFileSync(specificationPath, JSON.stringify(studySpecification()));

    const planned = runDataWranglerComparisonStudy(["plan", "--spec", specificationPath, "--out", manifestPath], {
      cwd: directory
    });
    assert.equal(planned.output.schedule.length, 96);
    assert.equal(JSON.parse(readFileSync(manifestPath, "utf8")).studyId, planned.output.studyId);
    assert.throws(
      () =>
        runDataWranglerComparisonStudy(["plan", "--spec", specificationPath, "--out", manifestPath], {
          cwd: directory
        }),
      /EEXIST/u
    );

    const entry = planned.output.schedule[0];
    const fragment = {
      ...createStudyFragmentIdentity({
        manifest: planned.output,
        scheduleEntry: entry,
        executionIndex: 0,
        recordedAtUtc: "2026-08-02T11:00:00.000Z"
      }),
      outcome: {
        status: "pre-action-invalid",
        reasonClass: "setup",
        actionStarted: false,
        correctness: "not-reached",
        timeout: null,
        unsupported: null
      },
      milestones: createEmptyStudyMilestones(),
      cacheProof: null,
      engineEvidence: null,
      environmentGate: failedEnvironmentGate(planned.output),
      sourceLoad: { status: "not-reached", durationMs: null, includedInInlineTiming: false },
      uiEvidence: null,
      processProofs: null,
      resourceObservation: null,
      cleanupProof: null,
      trialProvenance: null
    };
    writeFileSync(fragmentInputPath, JSON.stringify(fragment));
    const recorded = runDataWranglerComparisonStudy(
      ["record", "--manifest", manifestPath, "--fragments", fragments, "--fragment", fragmentInputPath],
      { cwd: directory }
    );
    assert.equal(recorded.output.fragmentId, fragment.fragmentId);
    const status = runDataWranglerComparisonStudy(["status", "--manifest", manifestPath, "--fragments", fragments], {
      cwd: directory
    });
    assert.equal(status.output.fragmentCount, 1);
    assert.equal(status.output.pendingCount, 96);
    assert.throws(
      () =>
        runDataWranglerComparisonStudy(
          ["finalize", "--manifest", manifestPath, "--fragments", fragments, "--out", "result.json"],
          { cwd: directory }
        ),
      /planned pair work remains/u
    );
  });
});

function studySpecification() {
  const controlReceipt = {
    openWranglerInstalled: false,
    dataWranglerInstalled: false,
    surfaceOwner: "host-jupyter"
  };
  const capabilityReceipt = {
    publicSurface: "data-wrangler-polars",
    availability: "available",
    observedVia: "public-ui"
  };
  return {
    studyId: "11111111-1111-4111-8111-111111111111",
    createdAtUtc: "2026-08-02T10:00:00.000Z",
    method: { protocol: DATA_WRANGLER_STUDY_METHOD_PROTOCOL, sha256: digest("1") },
    candidate: {
      extensionId: "Matt17BR.openwrangler",
      version: "1.2.1",
      sha256: digest("2"),
      filesystemIdentity: { device: "2049", inode: "2001", sizeBytes: 1024, mtimeNs: "1754100000000000000" }
    },
    baseline: { extensionId: "ms-toolsai.datawrangler", version: "1.24.2" },
    editor: { id: "Microsoft.VisualStudioCode", version: "1.130.0", sha256: digest("3") },
    python: {
      implementation: "CPython",
      version: "3.12.10",
      executableSha256: digest("4"),
      environmentSha256: digest("5"),
      packages: [
        { name: "pandas", version: "2.2.3" },
        { name: "polars", version: "1.27.1" },
        { name: "pyarrow", version: "19.0.1" },
        { name: "jupyter_core", version: "5.7.2" },
        { name: "ipykernel", version: "6.29.5" }
      ],
      kernel: {
        implementation: "ipykernel",
        version: "6.29.5",
        kernelspecName: "python3",
        kernelspecSha256: digest("a")
      }
    },
    fixtures: [
      studyFixture("csv-100k-50", "csv", 100_000, 50, digest("6"), "6001"),
      studyFixture("parquet-1m-20", "parquet", 1_000_000, 20, digest("7"), "7001")
    ],
    provenance: {
      machine: {
        platform: "linux",
        architecture: "x64",
        osRelease: "Ubuntu 24.04.2 LTS",
        kernelRelease: "6.8.0-64-generic",
        machineIdSha256: digest("8"),
        totalMemoryBytes: 32 * 1024 * 1024 * 1024
      },
      cpu: {
        vendorId: "GenuineIntel",
        model: "Example 8-core CPU",
        logicalProcessorCount: 8,
        onlineCpuList: "0-7",
        affinity: [2, 3, 4, 5],
        governors: [2, 3, 4, 5].map((processor) => ({ processor, governor: "performance" }))
      },
      power: { source: "ac" },
      storage: {
        deviceModel: "Example NVMe SSD",
        deviceIdentitySha256: digest("b"),
        filesystemType: "ext4",
        mountOptionsSha256: digest("c"),
        fixtureVolumeIdentitySha256: digest("d"),
        rotational: false
      },
      display: { mode: "headless-ozone", widthPx: 1920, heightPx: 1080, deviceScaleFactor: 1, colorDepth: 24 },
      zoom: {
        level: 0,
        theme: "Default Dark Modern",
        viewportWidthPx: 1920,
        viewportHeightPx: 1080,
        rowPageSize: 50,
        notebookLayoutSha256: digest("9")
      },
      commonExtensions: DATA_WRANGLER_STUDY_COMMON_EXTENSIONS.map((extension) => ({ ...extension })),
      templates: DATA_WRANGLER_STUDY_PRODUCTS.map((product, index) => ({
        product,
        configuredOnlyReceiptSha256: digest(String(index + 1)),
        warmedReceiptSha256: digest(String(index + 3)),
        publicConfigurationCompleted: true,
        publicWarmupCompleted: true,
        targetStateAbsent: true
      })),
      capabilities: [
        {
          product: "data-wrangler",
          engine: "polars",
          availability: "available",
          method: "public-capability",
          timed: false,
          receiptSha256: digestStudyValue(capabilityReceipt),
          receipt: capabilityReceipt
        }
      ],
      controlProfile: {
        method: "neither-product",
        receiptSha256: digestStudyValue(controlReceipt),
        receipt: controlReceipt
      },
      containmentLauncher: {
        executable: "/usr/bin/bwrap",
        version: "bubblewrap 0.11.1",
        sha256: "a".repeat(64),
        filesystemIdentity: {
          device: "8",
          inode: "42",
          sizeBytes: 125_000,
          mtimeNs: "1000000000"
        }
      }
    }
  };
}

function studyFixture(id, format, rows, columns, sha256, inode) {
  return {
    id,
    format,
    rows,
    columns,
    sha256,
    filesystemIdentity: { device: "2049", inode, sizeBytes: rows * columns, mtimeNs: "1754100000000000000" },
    schema: [...Array(columns).keys()].map((index) => ({
      name: `c${String(index).padStart(2, "0")}`,
      dtype: "int64"
    })),
    sentinels: [
      { rowIndex: 0, column: "c00", value: 0 },
      { rowIndex: 1, column: "c01", value: 2 },
      {
        rowIndex: rows - 1,
        column: `c${String(columns - 1).padStart(2, "0")}`,
        value: rows - 1 + columns - 1
      }
    ]
  };
}

function failedEnvironmentGate(manifest) {
  return {
    protocol: "openwrangler-linux-data-wrangler-study-gate-v1",
    selectionPolicy: "accept the first complete passing window and retain every attempted window",
    thresholds: {
      windowMs: 10_000,
      intervalMs: 1_000,
      maximumMeanNonIdleCpuPercent: 10,
      maximumOneSecondNonIdleCpuPercent: 25,
      maximumCpuSomeAvg10Percent: 1,
      maximumMemoryFullAvg10Percent: 0,
      maximumSwapPageDelta: 0,
      maximumThermalThrottleDelta: 0,
      requireExactAcPowerState: true,
      requireExactGovernorSet: true,
      requireExactAffinity: true,
      maximumSampleLatenessMs: 250
    },
    provenance: {
      protocol: "openwrangler-linux-data-wrangler-study-provenance-v1",
      platform: "linux",
      architecture: "x64",
      kernelRelease: manifest.provenance.machine.kernelRelease,
      cpu: {
        vendorId: manifest.provenance.cpu.vendorId,
        modelName: manifest.provenance.cpu.model,
        logicalCpuCount: manifest.provenance.cpu.logicalProcessorCount,
        onlineCpuList: manifest.provenance.cpu.onlineCpuList,
        pinnedCpuIds: [...manifest.provenance.cpu.affinity]
      },
      affinity: { cpuList: "2-5" },
      power: {
        externalSupplies: [{ name: "AC", type: "Mains", online: true }],
        governors: manifest.provenance.cpu.governors.map((governor) => ({
          cpuId: governor.processor,
          governor: governor.governor
        })),
        thermalThrottleCounters: [{ id: "core:2", cpuId: 2, kind: "core" }]
      },
      display: {
        mode: manifest.provenance.display.mode,
        width: manifest.provenance.display.widthPx,
        height: manifest.provenance.display.heightPx,
        scaleFactor: manifest.provenance.display.deviceScaleFactor,
        zoomLevel: manifest.provenance.zoom.level,
        theme: manifest.provenance.zoom.theme,
        hostEnvironment: { displaySet: false, waylandDisplaySet: false, xdgSessionTypeSet: false }
      }
    },
    maximumWaitMs: 300_000,
    waitMs: 300_000,
    acceptedAttempt: null,
    passed: false,
    terminalFailure: "deadline-no-complete-window",
    attempts: [...Array(30).keys()].map((attemptIndex) => ({
      attempt: attemptIndex + 1,
      startedAtOffsetMs: attemptIndex * 10_000,
      durationMs: 10_000,
      passed: false,
      failureCodes: ["cpu-mean", "cpu-window", "cpu-pressure"],
      summary: {
        cpuIds: [...manifest.provenance.cpu.affinity],
        meanNonIdleCpuPercent: 26,
        maximumOneSecondNonIdleCpuPercent: 26,
        maximumCpuSomeAvg10Percent: 1.1,
        maximumMemoryFullAvg10Percent: 0,
        swapPageDelta: { pagesIn: 0, pagesOut: 0 },
        thermalThrottleDeltas: [{ id: "core:2", delta: 0 }],
        acPowerMatched: true,
        governorsMatched: true,
        affinityMatched: true
      },
      intervals: [...Array(10).keys()].map((intervalIndex) => ({
        index: intervalIndex,
        elapsedMs: (intervalIndex + 1) * 1_000,
        durationMs: 1_000,
        nonIdleCpuPercent: 26,
        cpuSomeAvg10Percent: 1.1,
        memoryFullAvg10Percent: 0,
        acPowerMatched: true,
        governorsMatched: true,
        affinityMatched: true,
        available: true
      }))
    }))
  };
}

function withDirectory(callback) {
  const directory = mkdtempSync(resolve(tmpdir(), "ow-study-command-"));
  try {
    return callback(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
