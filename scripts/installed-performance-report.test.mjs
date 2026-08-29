import assert from "node:assert/strict";
import test from "node:test";
import {
  INSTALLED_PERFORMANCE_BOUNDARY,
  INSTALLED_PERFORMANCE_CACHED_GRID_SAMPLE_COUNT,
  INSTALLED_PERFORMANCE_CACHED_GRID_WARMUP_TRANSITION_COUNT,
  INSTALLED_PERFORMANCE_FIRST_GRID_SAMPLE_COUNT,
  INSTALLED_PERFORMANCE_FIXTURE_PROTOCOL,
  INSTALLED_PERFORMANCE_GRID_INTERACTION_SAMPLE_COUNT,
  INSTALLED_PERFORMANCE_PHASE_PROTOCOL,
  INSTALLED_PERFORMANCE_REPORT_PROTOCOL,
  buildInstalledPerformanceReport,
  isInstalledPerformanceNumericGateError,
  summarizeInstalledDurationSamples
} from "./installed-performance-report.mjs";
import {
  PERFORMANCE_EVIDENCE_ARTIFACT_KIND,
  STABLE_RELEASE_ARTIFACT_KIND,
  installedPerformanceReportGateForOptions
} from "./run-installed-performance.mjs";

const digest = (digit) => digit.repeat(64);
const samples = (value, count) => Array(count).fill(value);
const editor = {
  key: "vscode",
  appName: "Visual Studio Code",
  productVersion: "1.130.0",
  vscodeApiVersion: "1.130.0"
};
const runtime = {
  pythonVersion: "3.12.13",
  pythonImplementation: "CPython",
  pythonExecutableSha256: digest("c"),
  polarsVersion: "1.43.0",
  openWranglerRuntimeVersion: "2.0.0"
};
const productConfiguration = {
  defaultBackend: "auto",
  fileStartMode: "editing",
  insightsOnOpen: true,
  fetchBlockSize: 200,
  fetchColumnBlockSize: 16
};

test("a VS Code-only gate derives its verdict from context-free report measurements", () => {
  const fixtureManifest = createFixtureManifest();
  const phases = [
    createFirstGridPhase(fixtureManifest, "csv", "cold", 100),
    createFirstGridPhase(fixtureManifest, "csv", "warm", 80),
    createFirstGridPhase(fixtureManifest, "parquet", "cold", 200),
    createFirstGridPhase(fixtureManifest, "parquet", "warm", 150),
    createInteractionPhase(fixtureManifest)
  ];
  const report = buildInstalledPerformanceReport({
    generatedAtUtc: "2026-08-29T00:00:00.000Z",
    candidate: {
      extensionId: "Matt17BR.openwrangler",
      extensionVersion: "2.0.0",
      preview: false,
      channel: "stable",
      buildMethod: "canonical-release-artifact-v1",
      releaseTag: "v2.0.0",
      provenanceSha256: digest("f"),
      sourceCommit: "b".repeat(40),
      vsixSha256: digest("a"),
      vsixBytes: 1_000_000
    },
    source: { commit: "b".repeat(40), trackedWorktreeDirty: false },
    fixtureManifest,
    editorRuns: [
      {
        provenance: {
          editor,
          runtime,
          productConfiguration,
          platform: {
            operatingSystem: "Linux",
            operatingSystemRelease: "6.8.0",
            architecture: "x64",
            cpuModel: "Acceptance CPU",
            logicalCpuCount: 8,
            totalMemoryBytes: 16_000_000_000,
            editorDisplayMode: "headless"
          },
          storage: {
            filesystemType: "ext4",
            blockSizeBytes: 4_096,
            deviceModel: "Acceptance SSD",
            firmwareVersion: "1.0",
            rotational: false
          }
        },
        phases
      }
    ]
  });
  const gate = installedPerformanceReportGateForOptions({
    artifactKind: STABLE_RELEASE_ARTIFACT_KIND,
    editors: ["vscode"]
  });

  assert.equal(gate(report), report);
  assert.equal(INSTALLED_PERFORMANCE_PHASE_PROTOCOL, "openwrangler-installed-performance-phase-v8");
  assert.equal(report.protocol, "openwrangler-installed-performance-report-v12");
  assert.equal(INSTALLED_PERFORMANCE_REPORT_PROTOCOL, report.protocol);
  assert.equal(Object.hasOwn(report, "releaseGate"), false);
  assert.equal(Object.hasOwn(report, "evidenceGate"), false);
  assert.deepEqual(Object.keys(report.editors[0].results.gridInteraction.filter.responsiveness), [
    "outstandingObserved",
    "rendererHeartbeatMs"
  ]);
  const evidenceGate = installedPerformanceReportGateForOptions(
    { artifactKind: PERFORMANCE_EVIDENCE_ARTIFACT_KIND, editors: ["vscode"] },
    { evidenceGate: (_report, options) => options.requiredEditors }
  );
  assert.deepEqual(evidenceGate(report), ["vscode"]);

  const numericFailure = structuredClone(report);
  numericFailure.editors[0].results.gridInteraction.filter.responsiveness.rendererHeartbeatMs = 100;
  let gateError;
  assert.throws(
    () => gate(numericFailure),
    (error) => {
      gateError = error;
      return /vscode filter outstanding renderer heartbeat 100ms >= 100ms/u.test(error.message);
    }
  );
  assert.equal(isInstalledPerformanceNumericGateError(gateError), true);
  assert.deepEqual(gateError.failures, ["vscode filter outstanding renderer heartbeat 100ms >= 100ms"]);

  const cachedGridFailure = structuredClone(report);
  cachedGridFailure.editors[0].results.gridInteraction.cached = summarizeInstalledDurationSamples(
    samples(100, INSTALLED_PERFORMANCE_CACHED_GRID_SAMPLE_COUNT)
  );
  const expectedCachedGridFailure =
    "vscode cached grid had 200 of 200 samples >= 100ms (failure threshold 16); " +
    "cached min/median/p95/max 100/100/100/100ms; " +
    "uncached min/median/p95/max 50/50/50/50ms; " +
    "renderer heartbeat min/median/p95/max 5/5/5/5ms";
  assert.throws(
    () => gate(cachedGridFailure),
    (error) => {
      gateError = error;
      return error.message.includes(expectedCachedGridFailure);
    }
  );
  assert.equal(isInstalledPerformanceNumericGateError(gateError), true);
  assert.deepEqual(gateError.failures, [expectedCachedGridFailure]);
});

function createFixtureManifest() {
  return {
    protocol: INSTALLED_PERFORMANCE_FIXTURE_PROTOCOL,
    smoke: false,
    generator: { contractVersion: 1, implementation: "polars", implementationVersion: "1.43.0" },
    license: "CC0-1.0",
    redistribution: "Deterministic synthetic integer fixtures generated by Open Wrangler.",
    fixtures: {
      csv: createFixture("csv", 100_000, 50, "d"),
      parquet: createFixture("parquet", 1_000_000, 20, "e")
    }
  };
}

function createFixture(format, rows, columns, digestDigit) {
  return {
    fileName: `${rows}-${columns}.${format}`,
    format,
    rows,
    columns,
    columnType: "Int64",
    columnNamePattern: "c followed by a zero-padded zero-based integer",
    sentinelRows: [0, Math.floor(rows / 2), rows - 1],
    sha256: digest(digestDigit),
    bytes: 1_000
  };
}

function createFirstGridPhase(fixtureManifest, format, sourceCache, duration) {
  const fixture = fixtureManifest.fixtures[format];
  return {
    protocol: INSTALLED_PERFORMANCE_PHASE_PROTOCOL,
    runId: "11111111-1111-4111-8111-111111111111",
    phase: `first-grid-${format}-${sourceCache}`,
    editor,
    runtime,
    productConfiguration,
    fixture: { format, rows: fixture.rows, columns: fixture.columns, sha256: fixture.sha256 },
    measurement: {
      kind: "first-grid",
      boundary: INSTALLED_PERFORMANCE_BOUNDARY,
      sourceCache,
      cacheProofs: Array.from({ length: INSTALLED_PERFORMANCE_FIRST_GRID_SAMPLE_COUNT }, () =>
        createCacheProof(sourceCache)
      ),
      samplesMs: samples(duration, INSTALLED_PERFORMANCE_FIRST_GRID_SAMPLE_COUNT)
    }
  };
}

function createCacheProof(sourceCache) {
  const totalPages = 2_048;
  return {
    protocol: "openwrangler-source-cache-proof-v1",
    requestedState: sourceCache === "cold" ? "evicted" : "resident",
    fdatasyncApplied: true,
    adviceAccepted: sourceCache === "cold",
    verification: "linux-mincore",
    pageSizeBytes: 4_096,
    totalPages,
    residentPagesBefore: sourceCache === "cold" ? totalPages : 0,
    residentPagesAfter: sourceCache === "cold" ? 0 : totalPages,
    identityStable: true,
    verified: true
  };
}

function createInteractionPhase(fixtureManifest) {
  const fixture = fixtureManifest.fixtures.parquet;
  const rendererResponsiveness = () => ({ outstandingObserved: true, rendererHeartbeatMs: 5 });
  return {
    protocol: INSTALLED_PERFORMANCE_PHASE_PROTOCOL,
    runId: "22222222-2222-4222-8222-222222222222",
    phase: "grid-interaction-parquet",
    editor,
    runtime,
    productConfiguration,
    fixture: {
      format: "parquet",
      rows: fixture.rows,
      columns: fixture.columns,
      sha256: fixture.sha256
    },
    measurement: {
      kind: "grid-interaction",
      cachedGridWarmupTransitionCount: INSTALLED_PERFORMANCE_CACHED_GRID_WARMUP_TRANSITION_COUNT,
      cachedSamplesMs: samples(10, INSTALLED_PERFORMANCE_CACHED_GRID_SAMPLE_COUNT),
      uncachedSamplesMs: samples(50, INSTALLED_PERFORMANCE_GRID_INTERACTION_SAMPLE_COUNT),
      heartbeatSamplesMs: samples(5, INSTALLED_PERFORMANCE_GRID_INTERACTION_SAMPLE_COUNT),
      filter: { completed: true, latencyMs: 100, responsiveness: rendererResponsiveness() },
      sort: { completed: true, latencyMs: 110, responsiveness: rendererResponsiveness() },
      profiling: {
        activeObserved: true,
        activeCheckpoint: {
          sessionId: "installed-session-a",
          state: "active",
          lane: "background",
          requestKind: "getSummary",
          viewRequestId: "installed-profile-active-a"
        },
        queuedCheckpoint: {
          sessionId: "installed-session-a",
          state: "queued",
          lane: "background",
          requestKind: "getDatasetStats",
          viewRequestId: "installed-profile-queued-a"
        },
        cancellationRequested: true,
        cancelAcknowledged: true,
        originalRequestSettled: true,
        originalResponseKind: "cancelled",
        responsiveness: {
          ...rendererResponsiveness(),
          foregroundPageLatencyMs: 50,
          foregroundResponseKind: "page"
        }
      }
    }
  };
}
