import assert from "node:assert/strict";
import { chmodSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  INSTALLED_PERFORMANCE_BOUNDARY,
  INSTALLED_PERFORMANCE_FIXTURE_PROTOCOL,
  INSTALLED_PERFORMANCE_OUTLIER_POLICY,
  INSTALLED_PERFORMANCE_PHASE_PROTOCOL,
  assertInstalledPerformanceReleaseGate,
  buildInstalledPerformanceReport,
  revalidateInstalledPerformanceReport,
  summarizeInstalledDurationSamples,
  validateInstalledFixtureManifest,
  validateInstalledPerformancePhase,
  writeInstalledPerformanceReport
} from "./installed-performance-report.mjs";

const sha = (digit) => digit.repeat(64);
const sample = (value) => Array.from({ length: 10 }, (_, index) => value + index / 100);

test("duration summaries retain every sample and use nearest-rank p95", () => {
  const samples = [10, 1, 8, 3, 9, 2, 7, 4, 6, 5];
  assert.deepEqual(summarizeInstalledDurationSamples(samples), {
    count: 10,
    samplesMs: samples,
    excludedSamples: 0,
    outlierPolicy: INSTALLED_PERFORMANCE_OUTLIER_POLICY,
    minMs: 1,
    medianMs: 5.5,
    p95Ms: 10,
    maxMs: 10
  });
  assert.throws(() => summarizeInstalledDurationSamples(samples.slice(1)), /at least|between 10 and 1,000/u);
  assert.throws(() => summarizeInstalledDurationSamples([...sample(1), Number.NaN]), /finite non-negative/u);
});

test("fixture manifests are exact, path-free, and release-sized", () => {
  const manifest = fixtureManifest();
  assert.equal(validateInstalledFixtureManifest(manifest), manifest);
  assert.throws(
    () => validateInstalledFixtureManifest({ ...manifest, privatePath: "/tmp/fixture" }),
    /missing or unknown fields/u
  );
  assert.throws(
    () =>
      validateInstalledFixtureManifest({
        ...manifest,
        fixtures: { ...manifest.fixtures, csv: { ...manifest.fixtures.csv, sha256: "bad" } }
      }),
    /SHA-256/u
  );
});

test("phase validation rejects provenance drift and source data disclosure", () => {
  const phase = firstGridPhase("vscode", "csv", "cold", 100);
  assert.equal(validateInstalledPerformancePhase(phase, { runId: phase.runId, phase: phase.phase }), phase);
  assert.throws(
    () => validateInstalledPerformancePhase({ ...phase, protocol: "openwrangler-installed-performance-phase-v3" }),
    /installed performance phase protocol/u
  );
  assert.throws(
    () => validateInstalledPerformancePhase({ ...phase, envelopeRevision: 2 }),
    /missing or unknown fields/u
  );
  assert.throws(
    () =>
      validateInstalledPerformancePhase({
        ...phase,
        measurement: { ...phase.measurement, sourcePath: "/home/alice/data.csv" }
      }),
    /missing or unknown fields/u
  );
  assert.throws(
    () =>
      validateInstalledPerformancePhase({
        ...phase,
        editor: { ...phase.editor, appName: "VS Code", profile: "/home/alice/.config" }
      }),
    /missing or unknown fields/u
  );
  assert.throws(
    () =>
      validateInstalledPerformancePhase({
        ...phase,
        productConfiguration: { ...phase.productConfiguration, fileStartMode: "viewing" }
      }),
    /shipped product configuration/u
  );
});

test("cache evidence retains every proof and rejects forged eviction verification", () => {
  const phase = firstGridPhase("vscode", "csv", "cold", 100);
  const forged = structuredClone(phase);
  forged.measurement.cacheProofs[4].residentPagesAfter = 1;
  assert.throws(() => validateInstalledPerformancePhase(forged), /does not match its retained residency/u);

  const run = editorRun("vscode");
  const residual = run.phases[0].measurement.cacheProofs[4];
  residual.residentPagesAfter = 1;
  residual.verified = false;
  const report = buildInstalledPerformanceReport({
    generatedAtUtc: "2026-07-27T00:00:00.000Z",
    candidate: candidate(),
    source: { commit: "b".repeat(40), trackedWorktreeDirty: false },
    fixtureManifest: fixtureManifest(),
    editorRuns: [run]
  });
  assert.ok(
    report.releaseGate.failures.includes("vscode csv cold source-cache residency was not proven for every sample")
  );
});

test("release evidence gates responsiveness while filter, sort, and profiling remain outstanding", () => {
  const run = editorRun("vscode");
  const interaction = run.phases.at(-1).measurement;
  interaction.filter.responsiveness.foregroundPageLatencyMs = 500;
  interaction.sort.responsiveness.rendererHeartbeatMs = 100;
  const report = buildInstalledPerformanceReport({
    generatedAtUtc: "2026-07-27T00:00:00.000Z",
    candidate: candidate(),
    source: { commit: "b".repeat(40), trackedWorktreeDirty: false },
    fixtureManifest: fixtureManifest(),
    editorRuns: [run]
  });

  assert.ok(report.releaseGate.failures.includes("vscode filter outstanding foreground page 500ms >= 500ms"));
  assert.ok(report.releaseGate.failures.includes("vscode sort outstanding renderer heartbeat 100ms >= 100ms"));
});

test("queued profiling cannot impersonate an accepted active scheduler request", () => {
  const phase = interactionPhase("vscode");
  phase.measurement.profiling.activeCheckpoint.state = "queued";

  assert.throws(
    () => validateInstalledPerformancePhase(phase),
    /active profiling scheduler checkpoint state must be "active"/u
  );
});

test("the aggregate report gates both editors and every cold/warm/grid case", () => {
  const report = passingReport();
  assert.equal(report.releaseGate.passed, true);
  assert.equal(assertInstalledPerformanceReleaseGate(report), report);
  assert.throws(
    () =>
      assertInstalledPerformanceReleaseGate({ ...report, protocol: "openwrangler-installed-performance-report-v4" }),
    /installed performance report protocol/u
  );
  assert.throws(
    () => assertInstalledPerformanceReleaseGate({ ...report, envelopeRevision: 2 }),
    /missing or unknown fields/u
  );

  const failed = structuredClone(report);
  failed.editors[1].results.firstGrid.parquet.cold.timing.samplesMs[9] = 5_000;
  failed.editors[1].results.firstGrid.parquet.cold.timing.p95Ms = 5_000;
  failed.editors[1].results.firstGrid.parquet.cold.timing.maxMs = 5_000;
  failed.releaseGate = {
    passed: false,
    failures: ["cursor parquet cold first-grid p95 5000ms >= 5000ms"]
  };
  assert.throws(() => assertInstalledPerformanceReleaseGate(failed), /parquet cold first-grid p95/u);
});

test("aggregate evidence rejects a runtime that does not match the VSIX candidate", () => {
  const run = editorRun("vscode");
  run.provenance.runtime.openWranglerRuntimeVersion = "0.3.1";
  assert.throws(
    () =>
      buildInstalledPerformanceReport({
        generatedAtUtc: "2026-07-27T00:00:00.000Z",
        candidate: candidate(),
        source: { commit: "b".repeat(40), trackedWorktreeDirty: false },
        fixtureManifest: fixtureManifest(),
        editorRuns: [run]
      }),
    /runtime version does not match/u
  );
});

test("candidate provenance enforces numeric versions and a matching release channel", () => {
  const run = editorRun("vscode");
  for (const [invalidCandidate, expectedError] of [
    [{ ...candidate(), channel: "stable" }, /release channel does not match/u],
    [{ ...candidate(), extensionVersion: "0.3.0-alpha.1" }, /candidate extension version/u],
    [{ ...candidate(), preview: false }, /preview flag does not match/u],
    [
      { ...candidate(), extensionVersion: "0.9.0", preview: false, channel: "stable" },
      /release channel does not match/u
    ],
    [{ ...candidate(), extensionVersion: "0.2.0", preview: false, channel: "stable" }, /version 1\.0\.0 or newer/u]
  ]) {
    assert.throws(
      () =>
        buildInstalledPerformanceReport({
          generatedAtUtc: "2026-07-27T00:00:00.000Z",
          candidate: invalidCandidate,
          source: { commit: "b".repeat(40), trackedWorktreeDirty: false },
          fixtureManifest: fixtureManifest(),
          editorRuns: [run]
        }),
      expectedError
    );
  }
});

test("candidate build provenance is bound to its release channel", () => {
  const previewRun = editorRun("vscode");
  assert.throws(
    () =>
      buildInstalledPerformanceReport({
        generatedAtUtc: "2026-07-27T00:00:00.000Z",
        candidate: { ...candidate(), buildMethod: "canonical-release-artifact-v1" },
        source: { commit: "b".repeat(40), trackedWorktreeDirty: false },
        fixtureManifest: fixtureManifest(),
        editorRuns: [previewRun]
      }),
    /candidate build method must be "guarded-clean-head-v1"/u
  );

  const stableRun = editorRun("vscode");
  stableRun.provenance.runtime.openWranglerRuntimeVersion = "1.0.0";
  for (const phase of stableRun.phases) phase.runtime.openWranglerRuntimeVersion = "1.0.0";
  const stableCandidate = {
    ...candidate(),
    extensionVersion: "1.0.0",
    preview: false,
    channel: "stable"
  };
  assert.throws(
    () =>
      buildInstalledPerformanceReport({
        generatedAtUtc: "2026-07-27T00:00:00.000Z",
        candidate: stableCandidate,
        source: { commit: "b".repeat(40), trackedWorktreeDirty: false },
        fixtureManifest: fixtureManifest(),
        editorRuns: [stableRun]
      }),
    /candidate build method must be "canonical-release-artifact-v1"/u
  );

  const report = buildInstalledPerformanceReport({
    generatedAtUtc: "2026-07-27T00:00:00.000Z",
    candidate: {
      ...stableCandidate,
      buildMethod: "canonical-release-artifact-v1"
    },
    source: { commit: "b".repeat(40), trackedWorktreeDirty: false },
    fixtureManifest: fixtureManifest(),
    editorRuns: [stableRun]
  });
  assert.equal(report.candidate.channel, "stable");
  assert.equal(report.candidate.buildMethod, "canonical-release-artifact-v1");
});

test("aggregate verdicts retain dirty-source and missing-editor release failures", () => {
  const report = buildInstalledPerformanceReport({
    generatedAtUtc: "2026-07-27T00:00:00.000Z",
    candidate: candidate(),
    source: { commit: "b".repeat(40), trackedWorktreeDirty: true },
    fixtureManifest: fixtureManifest(),
    editorRuns: [editorRun("vscode")]
  });
  assert.deepEqual(report.releaseGate, {
    passed: false,
    failures: ["candidate source worktree has tracked changes", "missing cursor installed performance evidence"]
  });
  assert.throws(() => assertInstalledPerformanceReleaseGate(report), /tracked changes.*missing cursor/su);
});

test("aggregate evidence rejects a candidate attributed to another checkout commit", () => {
  assert.throws(
    () =>
      buildInstalledPerformanceReport({
        generatedAtUtc: "2026-07-27T00:00:00.000Z",
        candidate: { ...candidate(), sourceCommit: "c".repeat(40) },
        source: { commit: "b".repeat(40), trackedWorktreeDirty: false },
        fixtureManifest: fixtureManifest(),
        editorRuns: [editorRun("vscode")]
      }),
    /guarded source commit/u
  );
});

test("report publication is bounded, atomic, and refuses a symlink destination", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ow-installed-report-"));
  try {
    const destination = join(directory, "report.json");
    const report = passingReport();
    const receipt = writeInstalledPerformanceReport(destination, report);
    assert.deepEqual(JSON.parse(await readFile(destination, "utf8")), report);
    assert.equal(receipt.path, destination);
    assert.equal(receipt.bytes, Buffer.byteLength(await readFile(destination, "utf8"), "utf8"));
    assert.match(receipt.sha256, /^[0-9a-f]{64}$/u);
    assert.equal(Object.isFrozen(receipt), true);
    assert.equal(Object.isFrozen(receipt.fileIdentity), true);
    assert.equal(revalidateInstalledPerformanceReport(receipt), receipt);

    const outside = join(directory, "outside.json");
    const linked = join(directory, "linked.json");
    await writeFile(outside, "unchanged\n", "utf8");
    await symlink(outside, linked);
    assert.throws(() => writeInstalledPerformanceReport(linked, report), /single-link regular file/u);
    assert.equal(await readFile(outside, "utf8"), "unchanged\n");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("report receipt rejects same-path replacement and in-place mutation after publication", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ow-installed-report-"));
  try {
    const destination = join(directory, "report.json");
    const retained = join(directory, "retained.json");
    const report = passingReport();
    const receipt = writeInstalledPerformanceReport(destination, report);
    const original = await readFile(destination);

    renameSync(destination, retained);
    writeFileSync(destination, original, { flag: "wx", mode: 0o600 });
    assert.throws(() => revalidateInstalledPerformanceReport(receipt), /changed after publication/u);

    unlinkSync(destination);
    renameSync(retained, destination);
    chmodSync(destination, 0o600);
    const mutated = Buffer.from(original);
    mutated[mutated.length - 2] ^= 1;
    writeFileSync(destination, mutated);
    assert.throws(() => revalidateInstalledPerformanceReport(receipt), /changed after publication|no longer matches/u);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("report receipt rejects a named-path swap during descriptor revalidation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ow-installed-report-"));
  try {
    const destination = join(directory, "report.json");
    const retained = join(directory, "retained.json");
    const receipt = writeInstalledPerformanceReport(destination, passingReport());
    const original = await readFile(destination);

    assert.throws(
      () =>
        revalidateInstalledPerformanceReport(receipt, {
          afterOpen() {
            renameSync(destination, retained);
            writeFileSync(destination, original, { flag: "wx", mode: 0o600 });
          }
        }),
      /changed while its descriptor snapshot was read/u
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("report revalidation rejects an unminted receipt", () => {
  assert.throws(
    () =>
      revalidateInstalledPerformanceReport({
        path: "/tmp/report.json",
        bytes: 1,
        sha256: "0".repeat(64),
        fileIdentity: {}
      }),
    /minted publication receipt/u
  );
});

test("report publication withholds cleanup when its closed temporary is substituted", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ow-installed-report-"));
  try {
    const destination = join(directory, "report.json");
    const retained = join(directory, "retained-owned-temporary.json");
    let substituted;

    assert.throws(
      () =>
        writeInstalledPerformanceReport(destination, passingReport(), {
          beforePublish(temporary) {
            substituted = temporary;
            renameSync(temporary, retained);
            writeFileSync(temporary, "foreign replacement\n", { mode: 0o600 });
          }
        }),
      /cleanup was withheld after an identity change/u
    );
    assert.equal(await readFile(substituted, "utf8"), "foreign replacement\n");
    await assert.rejects(readFile(destination), /ENOENT/u);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

function passingReport() {
  return buildInstalledPerformanceReport({
    generatedAtUtc: "2026-07-27T00:00:00.000Z",
    candidate: candidate(),
    source: { commit: "b".repeat(40), trackedWorktreeDirty: false },
    fixtureManifest: fixtureManifest(),
    editorRuns: [editorRun("vscode"), editorRun("cursor")]
  });
}

function editorRun(key) {
  return {
    provenance: {
      editor: editor(key),
      runtime: runtime(),
      productConfiguration: productConfiguration(),
      platform: {
        operatingSystem: "Linux",
        operatingSystemRelease: "6.8.0",
        architecture: "x64",
        cpuModel: "Acceptance CPU",
        logicalCpuCount: 8,
        totalMemoryBytes: 16_000_000_000,
        editorDisplayMode: key === "cursor" ? "xvfb" : "headless"
      },
      storage: {
        filesystemType: "ext4",
        blockSizeBytes: 4_096,
        deviceModel: "Acceptance SSD",
        firmwareVersion: "1.0",
        rotational: false
      }
    },
    resources: {
      supported: true,
      sampler: "linux-proc-process-group",
      peakEditorTreeRssBytes: 500_000_000,
      peakPythonRuntimeRssBytes: 200_000_000,
      samples: [{ stage: "peak", editorTreeRssBytes: 500_000_000, pythonRuntimeRssBytes: 200_000_000 }]
    },
    phases: [
      firstGridPhase(key, "csv", "cold", 100),
      firstGridPhase(key, "csv", "warm", 80),
      firstGridPhase(key, "parquet", "cold", 200),
      firstGridPhase(key, "parquet", "warm", 150),
      interactionPhase(key)
    ]
  };
}

function candidate() {
  return {
    extensionId: "Matt17BR.openwrangler",
    extensionVersion: "0.3.0",
    preview: true,
    channel: "preview",
    buildMethod: "guarded-clean-head-v1",
    sourceCommit: "b".repeat(40),
    vsixSha256: sha("a"),
    vsixBytes: 1_000_000
  };
}

function firstGridPhase(key, format, sourceCache, duration) {
  const fixture = fixtureManifest().fixtures[format];
  return {
    protocol: INSTALLED_PERFORMANCE_PHASE_PROTOCOL,
    runId: "11111111-1111-4111-8111-111111111111",
    phase: `first-grid-${format}-${sourceCache}`,
    editor: editor(key),
    runtime: runtime(),
    productConfiguration: productConfiguration(),
    fixture: { format, rows: fixture.rows, columns: fixture.columns, sha256: fixture.sha256 },
    measurement: {
      kind: "first-grid",
      boundary: INSTALLED_PERFORMANCE_BOUNDARY,
      sourceCache,
      cacheProofs: Array.from({ length: 10 }, () => cacheProof(sourceCache)),
      samplesMs: sample(duration)
    }
  };
}

function cacheProof(sourceCache) {
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

function interactionPhase(key) {
  const fixture = fixtureManifest().fixtures.parquet;
  return {
    protocol: INSTALLED_PERFORMANCE_PHASE_PROTOCOL,
    runId: "22222222-2222-4222-8222-222222222222",
    phase: "grid-interaction-parquet",
    editor: editor(key),
    runtime: runtime(),
    productConfiguration: productConfiguration(),
    fixture: { format: "parquet", rows: fixture.rows, columns: fixture.columns, sha256: fixture.sha256 },
    measurement: {
      kind: "grid-interaction",
      cachedSamplesMs: sample(10),
      uncachedSamplesMs: sample(50),
      heartbeatSamplesMs: sample(5),
      filter: { completed: true, latencyMs: 100, responsiveness: responsiveness() },
      sort: { completed: true, latencyMs: 110, responsiveness: responsiveness() },
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
        responsiveness: responsiveness()
      }
    }
  };
}

function responsiveness() {
  return {
    outstandingObserved: true,
    rendererHeartbeatMs: 5,
    foregroundPageLatencyMs: 50,
    foregroundResponseKind: "page"
  };
}

function productConfiguration() {
  return {
    defaultBackend: "auto",
    fileStartMode: "editing",
    insightsOnOpen: true,
    fetchBlockSize: 200,
    fetchColumnBlockSize: 16
  };
}

function editor(key) {
  return {
    key,
    appName: key === "vscode" ? "Visual Studio Code" : "Cursor",
    productVersion: key === "vscode" ? "1.130.0" : "3.13.10",
    vscodeApiVersion: key === "vscode" ? "1.130.0" : "1.109.5"
  };
}

function runtime() {
  return {
    pythonVersion: "3.12.13",
    pythonImplementation: "CPython",
    pythonExecutableSha256: sha("c"),
    polarsVersion: "1.43.0",
    openWranglerRuntimeVersion: "0.3.0"
  };
}

function fixtureManifest() {
  return {
    protocol: INSTALLED_PERFORMANCE_FIXTURE_PROTOCOL,
    smoke: false,
    generator: {
      contractVersion: 1,
      implementation: "polars",
      implementationVersion: "1.43.0"
    },
    license: "CC0-1.0",
    redistribution: "Deterministic synthetic integer fixtures generated by Open Wrangler.",
    fixtures: {
      csv: fixture("csv", 100_000, 50, "d"),
      parquet: fixture("parquet", 1_000_000, 20, "e")
    }
  };
}

function fixture(format, rows, columns, digestDigit) {
  return {
    fileName: `${rows}-${columns}.${format}`,
    format,
    rows,
    columns,
    columnType: "Int64",
    columnNamePattern: "c followed by a zero-padded zero-based integer",
    sentinelRows: [0, Math.floor(rows / 2), rows - 1],
    sha256: sha(digestDigit),
    bytes: 1_000
  };
}
