import assert from "node:assert/strict";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import { platform, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  R_PERFORMANCE_NO_THRESHOLD_PROFILE_FAILURE,
  R_PERFORMANCE_OUTLIER_POLICY,
  R_PERFORMANCE_REPORT_PROTOCOL,
  buildRPerformanceReport,
  parseRPerformanceReport,
  revalidateRPerformanceReport,
  rPerformanceFixtureEvidence,
  summarizeRPerformanceSamples,
  validateRPerformanceReport,
  writeRPerformanceReport
} from "./r-performance-report.mjs";

const hash = (character) => character.repeat(64);
const samples = (count, start = 1) => Array.from({ length: count }, (_, index) => start + index);

function commonSemanticProof() {
  return {
    passed: true,
    sourceUnchanged: true,
    freshPagesVerified: 5,
    projectedPagesVerified: 20,
    compoundFilterPagesVerified: 20,
    stableSortPagesVerified: 20,
    summariesVerified: 20,
    datasetStatsVerified: true,
    millionRowSampledSummaryVerified: true,
    keyedDataTableVerified: true
  };
}

function validInput() {
  const twenty = samples(20);
  const rssTwenty = samples(20, 100);
  return {
    generatedAtUtc: "2026-08-15T12:00:00.000Z",
    candidate: {
      artifactKind: "performance-evidence",
      extensionId: "Matt17BR.openwrangler",
      extensionVersion: "1.2.3",
      preview: false,
      releaseTag: "v1.2.3",
      sourceCommit: "1".repeat(40),
      vsixSha256: hash("a"),
      vsixBytes: 123_456,
      checksumSha256: hash("b"),
      provenanceProtocol: "openwrangler-performance-evidence-artifact-v1",
      provenanceSha256: hash("c")
    },
    packagedRuntime: {
      frameContract: { name: "frame_contract.R", bytes: 12_345, sha256: hash("d") },
      kernelAgent: { name: "kernel_agent.R", bytes: 23_456, sha256: hash("e") }
    },
    harness: {
      protocol: "openwrangler-native-r-performance-harness-v1",
      bytes: 34_567,
      sha256: hash("f"),
      sourceCommit: "1".repeat(40)
    },
    fixture: rPerformanceFixtureEvidence(),
    machine: {
      operatingSystem: "Linux",
      release: "6.8.0",
      architecture: "x64",
      cpuModel: "AMD Ryzen with Radeon Graphics",
      logicalCpuCount: 16,
      memoryBytes: 32 * 1024 * 1024 * 1024
    },
    runtime: {
      rVersion: "4.5.1",
      platform: "x86_64-pc-linux-gnu",
      architecture: "x86_64",
      operatingSystem: "Linux",
      libraryResolution: {
        protocol: "openwrangler-native-r-library-discovery-v1",
        directoryCount: 4,
        explicitDirectoriesVerified: true
      },
      nodeVersion: "v24.19.0",
      nodeExecutable: { bytes: 125_989_464, sha256: hash("1") },
      rscript: { bytes: 16_384, sha256: hash("2") },
      packages: {
        jsonlite: "2.0.0",
        dataTable: "1.17.8",
        rlang: "1.1.6",
        bit64: "4.6.0-1",
        tibble: "3.3.0",
        nanoparquet: null,
        collapse: null
      }
    },
    measurements: {
      directFrame: {
        freshOpenSamplesMs: samples(5),
        projectedPageSamplesMs: twenty,
        compoundFilterPageSamplesMs: twenty.map((value) => value + 20),
        stableMultiKeySortFirstUncachedMs: 80,
        stableMultiKeySortPageSamplesMs: twenty.map((value) => value + 40),
        eightColumnSummarySamplesMs: twenty.map((value) => value + 60),
        semanticProof: commonSemanticProof()
      },
      kernelRoundTrip: {
        freshOpenSamplesMs: samples(5, 10),
        projectedPageSamplesMs: twenty.map((value) => value + 100),
        compoundFilterPageSamplesMs: twenty.map((value) => value + 120),
        stableMultiKeySortFirstUncachedMs: 180,
        stableMultiKeySortPageSamplesMs: twenty.map((value) => value + 140),
        eightColumnSummarySamplesMs: twenty.map((value) => value + 160),
        semanticProof: {
          ...commonSemanticProof(),
          responseAccounting: {
            measured: {
              freshOpen: 5,
              projectedPage: 20,
              compoundFilterPage: 20,
              stableSortFirstUncached: 1,
              stableSortPage: 20,
              eightColumnSummary: 20
            },
            controls: {
              sessionClose: 8,
              workloadOpen: 1,
              datasetStats: 1,
              millionRowOpen: 1,
              millionRowSummary: 1,
              keyedDataTableOpen: 1
            },
            measuredTotal: 86,
            controlTotal: 13,
            allTotal: 99
          },
          readyFramesVerified: 6,
          closedSessions: 8
        }
      }
    },
    resources: {
      directMethod: "linux-proc-self-status-vmhwm-after-stage-v1",
      directProcessVmHwmKiB: 60_000,
      directStagesVmHwmKiB: {
        freshOpen: 10_000,
        projectedPage: 20_000,
        compoundFilterPage: 30_000,
        stableMultiKeySortPage: 40_000,
        eightColumnSummary: 50_000,
        semanticProof: 60_000
      },
      libraryProbeMethod: "linux-proc-status-vmrss-parent-sampled-v1",
      libraryProbeSamplingIntervalMs: 5,
      libraryProbeMaxObservedRssKiB: 8_000,
      kernelMethod: "linux-proc-status-vmrss-parent-sampled-v1",
      kernelSamplingIntervalMs: 5,
      freshKernelMaxObservedRssKiB: samples(5, 70_000),
      workloadKernelMaxObservedRssKiB: 130_000,
      kernelRequestsMaxObservedRssKiB: {
        projectedPage: rssTwenty,
        compoundFilterPage: rssTwenty.map((value) => value + 20),
        stableMultiKeySortFirstUncached: 125,
        stableMultiKeySortPage: rssTwenty.map((value) => value + 40),
        eightColumnSummary: rssTwenty.map((value) => value + 60),
        semanticControls: 129_000
      },
      everyProcessObserved: true,
      everyStageObserved: true
    },
    cleanup: {
      libraryProbeProcessExitedNaturally: true,
      directProcessExitedNaturally: true,
      freshKernelProcessesExitedNaturally: 5,
      workloadKernelProcessExitedNaturally: true,
      ownedRscriptProcessesExitedNaturally: 8,
      sessionsClosed: 8,
      processGroupsGone: true,
      privateRootRemoved: true
    }
  };
}

function validReport() {
  return buildRPerformanceReport(validInput());
}

test("native R summaries retain raw samples and recompute nearest-rank p95", () => {
  const summary = summarizeRPerformanceSamples(samples(20), "fixture", 20);
  assert.equal(summary.medianMs, 10.5);
  assert.equal(summary.p95Ms, 19);
  assert.equal(summary.excludedSamples, 0);
  assert.equal(summary.outlierPolicy, R_PERFORMANCE_OUTLIER_POLICY);
  assert.deepEqual(summary.samplesMs, samples(20));
});

test("native R report is structurally valid but cannot claim an unreviewed release gate", () => {
  const report = validReport();
  assert.equal(report.protocol, R_PERFORMANCE_REPORT_PROTOCOL);
  assert.deepEqual(report.measurementValid, { passed: true, failures: [] });
  assert.deepEqual(report.releaseGate, {
    thresholdProfileAttached: false,
    passed: false,
    failures: [R_PERFORMANCE_NO_THRESHOLD_PROFILE_FAILURE]
  });
  assert.equal(report.measurements.kernelRoundTrip.workloads.projectedPage.p95Ms, 119);
});

test("native R report rejects duplicate keys and recomputed-summary tampering", () => {
  const report = validReport();
  const encoded = JSON.stringify(report);
  const duplicate = encoded.replace(
    `"protocol":"${R_PERFORMANCE_REPORT_PROTOCOL}"`,
    `"protocol":"${R_PERFORMANCE_REPORT_PROTOCOL}","protocol":"${R_PERFORMANCE_REPORT_PROTOCOL}"`
  );
  assert.throws(() => parseRPerformanceReport(duplicate), /duplicate/iu);

  const tampered = structuredClone(report);
  tampered.measurements.directFrame.workloads.projectedPage.p95Ms += 1;
  assert.throws(() => validateRPerformanceReport(tampered), /raw samples/iu);
});

test("native R report rejects release claims, fixture drift, and executable-bound drift", () => {
  const releaseClaim = structuredClone(validReport());
  releaseClaim.releaseGate.thresholdProfileAttached = true;
  releaseClaim.releaseGate.passed = true;
  releaseClaim.releaseGate.failures = [];
  assert.throws(() => validateRPerformanceReport(releaseClaim), /cannot claim|release gate/iu);

  const fixtureDrift = structuredClone(validReport());
  fixtureDrift.fixture.expectedStats.missingValuesByColumn[0] = 1;
  assert.throws(() => validateRPerformanceReport(fixtureDrift), /fixture/iu);

  const nodeTooLarge = structuredClone(validReport());
  nodeTooLarge.environment.runtime.nodeExecutable.bytes = 256 * 1024 * 1024 + 1;
  assert.throws(() => validateRPerformanceReport(nodeTooLarge), /256 MiB/iu);
  const rscriptTooLarge = structuredClone(validReport());
  rscriptTooLarge.environment.runtime.rscript.bytes = 64 * 1024 * 1024 + 1;
  assert.throws(() => validateRPerformanceReport(rscriptTooLarge), /64 MiB/iu);
  const libraryResolutionDrift = structuredClone(validReport());
  libraryResolutionDrift.environment.runtime.libraryResolution.explicitDirectoriesVerified = false;
  assert.throws(() => validateRPerformanceReport(libraryResolutionDrift), /library-directory verification/iu);
});

test("native R report rejects contradictory resource maxima and vacuous proofs", () => {
  const resources = structuredClone(validReport());
  resources.resources.workloadKernelMaxObservedRssKiB = 1;
  assert.throws(() => validateRPerformanceReport(resources), /contradicts/iu);
  const probeMethod = structuredClone(validReport());
  probeMethod.resources.libraryProbeSamplingIntervalMs = 10;
  assert.throws(() => validateRPerformanceReport(probeMethod), /library-probe Rscript RSS sampling interval/iu);

  const proof = structuredClone(validReport());
  proof.measurements.kernelRoundTrip.semanticProof.keyedDataTableVerified = false;
  assert.throws(() => validateRPerformanceReport(proof), /must be proven/iu);
});

test("native R report globally rejects relative, Windows, URL, and encoded private paths", () => {
  for (const value of [
    "home/alice/data.csv",
    "secrets\\token.txt",
    "https://host.example/%2Fhome%2Falice",
    "%2Fhome%2Falice"
  ]) {
    const report = structuredClone(validReport());
    report.environment.machine.cpuModel = value;
    assert.throws(() => validateRPerformanceReport(report), /private path/iu, value);
  }
});

test("native R report publication is atomic, parent-bound, and revalidated", () => {
  const directory = mkdtempSync(join(tmpdir(), "ow-r-performance-report-test-"));
  try {
    const destination = join(directory, "report.json");
    const receipt = writeRPerformanceReport(destination, validReport());
    assert.equal(JSON.parse(readFileSync(destination, "utf8")).protocol, R_PERFORMANCE_REPORT_PROTOCOL);
    assert.equal(revalidateRPerformanceReport(receipt), receipt);

    const displaced = join(directory, "report.displaced.json");
    renameSync(destination, displaced);
    writeFileSync(destination, "{}\n", { encoding: "utf8", flag: "wx", mode: 0o600 });
    assert.throws(() => revalidateRPerformanceReport(receipt), /changed|receipt/iu);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("native R report rejects missing and symlinked output parents", () => {
  const directory = mkdtempSync(join(tmpdir(), "ow-r-performance-parent-test-"));
  try {
    assert.throws(
      () => writeRPerformanceReport(join(directory, "missing", "report.json"), validReport()),
      /canonical|ENOENT/iu
    );
    if (platform() !== "win32") {
      const real = join(directory, "real");
      const link = join(directory, "link");
      mkdirSync(real);
      symlinkSync(real, link, "dir");
      assert.throws(() => writeRPerformanceReport(join(link, "report.json"), validReport()), /canonical/iu);
      assert.equal(existsSync(join(real, "report.json")), false);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("post-rename failure removes only the still-identified unpublished report", () => {
  const directory = mkdtempSync(join(tmpdir(), "ow-r-performance-rename-test-"));
  try {
    const destination = join(directory, "report.json");
    assert.throws(
      () =>
        writeRPerformanceReport(destination, validReport(), {
          afterRename() {
            throw new Error("injected post-rename failure");
          }
        }),
      /injected post-rename failure/iu
    );
    assert.equal(existsSync(destination), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("report publication consumes the same pre-measurement parent receipt", () => {
  const directory = mkdtempSync(join(tmpdir(), "ow-r-performance-parent-receipt-test-"));
  const other = mkdtempSync(join(tmpdir(), "ow-r-performance-other-parent-test-"));
  try {
    const metadata = lstatSync(other, { bigint: true });
    const wrongReceipt = {
      path: other,
      dev: metadata.dev,
      ino: metadata.ino,
      mode: metadata.mode,
      uid: metadata.uid
    };
    const destination = join(directory, "report.json");
    assert.throws(
      () => writeRPerformanceReport(destination, validReport(), { parentReceipt: wrongReceipt }),
      /pre-measurement destination-parent/iu
    );
    assert.equal(existsSync(destination), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
    rmSync(other, { recursive: true, force: true });
  }
});

for (const hookName of ["afterRename", "afterPublishedOpen"]) {
  test(`parent replacement at ${hookName} fails closed without touching the replacement`, () => {
    const parent = mkdtempSync(join(tmpdir(), `ow-r-performance-${hookName}-`));
    const moved = `${parent}-moved`;
    const replacementSentinel = join(parent, "replacement-owned.txt");
    try {
      const destination = join(parent, "report.json");
      assert.throws(
        () =>
          writeRPerformanceReport(destination, validReport(), {
            [hookName]() {
              renameSync(parent, moved);
              mkdirSync(parent);
              writeFileSync(replacementSentinel, "preserve\n", "utf8");
            }
          }),
        /destination directory changed|cleanup/iu
      );
      assert.equal(readFileSync(replacementSentinel, "utf8"), "preserve\n");
      assert.equal(existsSync(join(parent, "report.json")), false);
      assert.equal(existsSync(join(moved, "report.json")), true);
    } finally {
      rmSync(parent, { recursive: true, force: true });
      rmSync(moved, { recursive: true, force: true });
    }
  });
}
