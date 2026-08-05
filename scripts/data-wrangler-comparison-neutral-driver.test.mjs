import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { linkSync, lstatSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  attachComparisonSampleMemory,
  comparisonEditorPhaseTimeout,
  comparisonProductSettings,
  comparisonHostRequest,
  summarizePss,
  verifyComparisonRequestSource,
  verifyComparisonSource
} from "./data-wrangler-comparison-neutral-driver.mjs";
import { LARGE_STUDY_MAX_PSS_SAMPLES } from "./data-wrangler-comparison-report.mjs";

test("uses the study-specific editor cap for each profile contract", () => {
  assert.equal(comparisonEditorPhaseTimeout("integer-sentinel"), 600_000);
  assert.equal(comparisonEditorPhaseTimeout("mixed-sentinels-v1"), 1_260_000);
  assert.throws(() => comparisonEditorPhaseTimeout("unknown"), /profile contract is unknown/u);
});

test("enables each product's public notebook renderer for Pandas and Polars", () => {
  assert.deepEqual(comparisonProductSettings("open-wrangler"), {
    "openWrangler.notebookPreviewProvider": "openWrangler"
  });
  assert.deepEqual(comparisonProductSettings("data-wrangler"), {
    "dataWrangler.outputRenderer.enabled": true,
    "dataWrangler.outputRenderer.enabledTypes": {
      "pandas.core.frame.DataFrame": true,
      "pandas.DataFrame": true,
      "polars.dataframe.frame.DataFrame": true
    }
  });
});

test("host request omits the launcher-only VS Code CLI path", () => {
  const request = {
    protocol: "openwrangler-comparison-trial-request-v2",
    repetitions: 10,
    timeoutsMs: {
      preAction: 75_000,
      inlinePreview: 30_000,
      workbenchOpen: 40_000,
      completeProfile: 110_000,
      editorPhase: 600_000
    },
    editor: {
      path: "/code",
      cliPath: "/code-cli",
      version: "1.131.0",
      sha256: "a".repeat(64),
      cliSha256: "b".repeat(64)
    },
    cell: {
      id: "pandas-csv",
      engine: "pandas",
      format: "csv",
      rows: 100_000,
      columns: 50,
      columnNames: Array.from({ length: 50 }, (_unused, index) => `c${String(index).padStart(2, "0")}`),
      source: "/source.csv",
      sourceSha256: "c".repeat(64),
      variableName: "study_frame",
      profileContract: "integer-sentinel"
    }
  };
  const host = comparisonHostRequest(request);
  assert.deepEqual(host.editor, {
    path: "/code",
    version: "1.131.0",
    sha256: "a".repeat(64)
  });
  assert.equal(request.editor.cliPath, "/code-cli");
  assert.equal(host.repetitions, 10);
  assert.equal(Object.hasOwn(host.timeoutsMs, "editorPhase"), false);
  assert.equal(Object.hasOwn(host.cell, "sourceSha256"), false);
  assert.deepEqual(host.cell.columnNames, request.cell.columnNames);
  assert.equal(host.cell.profileContract, "integer-sentinel");
});

test("private trial sources are checked before and after editor use", () => {
  const root = mkdtempSync(join(tmpdir(), "ow-comparison-source-"));
  const source = join(root, "source.csv");
  try {
    writeFileSync(source, "value\n1\n");
    const expected = createHash("sha256").update("value\n1\n").digest("hex");
    assert.doesNotThrow(() => verifyComparisonSource(source, expected));
    writeFileSync(source, "value\n2\n");
    assert.throws(() => verifyComparisonSource(source, expected), /SHA-256 changed/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("large synthetic fixtures can use a pinned hard-link identity instead of hashing gigabytes per session", () => {
  const root = mkdtempSync(join(tmpdir(), "ow-comparison-source-identity-"));
  const fixture = join(root, "fixture.parquet");
  const source = join(root, "source.parquet");
  try {
    writeFileSync(fixture, "generated fixture");
    linkSync(fixture, source);
    const metadata = lstatSync(source, { bigint: true });
    const cell = {
      source,
      sourceSha256: "0".repeat(64),
      sourceIdentity: {
        device: metadata.dev.toString(),
        inode: metadata.ino.toString(),
        size: metadata.size.toString(),
        mtimeNs: metadata.mtimeNs.toString()
      }
    };
    assert.doesNotThrow(() => verifyComparisonRequestSource(cell));
    writeFileSync(fixture, "changed fixture");
    assert.throws(() => verifyComparisonRequestSource(cell), /identity changed/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("PSS summary uses measured-action samples and excludes later peaks", () => {
  const samples = [
    sample(10_800_000_000, 100),
    sample(11_000_000_000, 180),
    sample(11_200_000_000, 160),
    sample(11_400_000_000, 999)
  ];
  const summary = summarizePss(samples, [
    { name: "run-cell-click", monotonicNs: "11000000000" },
    { name: "profiles-complete", monotonicNs: "11300000000" }
  ]);
  assert.deepEqual(summary, {
    peakPssBytes: 180,
    sampleCount: 4,
    intervalMs: 200,
    samples: samples.map(({ monotonicNs, pssBytes }) => sanitizedSample(monotonicNs, pssBytes))
  });
  assert.equal(JSON.stringify(summary).includes("rootPid"), false);
  assert.equal(JSON.stringify(summary).includes("processes"), false);
});

test("PSS evidence rejects an out-of-order raw series", () => {
  assert.throws(() => summarizePss([sample(200, 100), sample(100, 200)], []), /increase strictly/u);
});

test("PSS evidence retains a rising process tree during the measured action", () => {
  const samples = [
    sample(11_000_000_000, 100_000_000, 1),
    sample(11_200_000_000, 200_000_000, 2),
    sample(11_400_000_000, 300_000_000, 3)
  ];
  assert.equal(
    summarizePss(samples, [
      { name: "run-cell-click", monotonicNs: "11000000000" },
      { name: "profiles-complete", monotonicNs: "11400000000" }
    ]).peakPssBytes,
    300_000_000
  );
});

test("the large study keeps bounded PSS evidence for its longer profiling window", () => {
  const samples = Array.from({ length: 2_001 }, (_unused, index) => sample(1_000_000_000 + index * 200_000_000, 100));
  const milestones = [
    { name: "run-cell-click", monotonicNs: samples[0].monotonicNs },
    { name: "profiles-complete", monotonicNs: samples.at(-1).monotonicNs }
  ];
  assert.throws(() => summarizePss(samples, milestones), /between 1 and 2000 samples/u);
  assert.equal(summarizePss(samples, milestones, LARGE_STUDY_MAX_PSS_SAMPLES).sampleCount, samples.length);
});

test("session PSS is split into one bounded memory record per measured sample", () => {
  const firstPss = [sample(11_000_000_000, 180), sample(11_200_000_000, 160), sample(11_400_000_000, 150)];
  const secondPss = [sample(30_000_000_000, 280), sample(30_200_000_000, 260), sample(30_400_000_000, 250)];
  const milestones = (run, complete) => [
    { name: "run-cell-click", monotonicNs: String(run) },
    { name: "profiles-complete", monotonicNs: String(complete) }
  ];
  const samples = attachComparisonSampleMemory(
    [
      { index: 1, status: "success", milestones: milestones(11_000_000_000, 11_400_000_000) },
      { index: 2, status: "success", milestones: milestones(30_000_000_000, 30_400_000_000) },
      { index: 3, status: "failure", milestones: [] }
    ],
    [...firstPss, sample(20_000_000_000, 999), ...secondPss]
  );

  assert.equal(samples[0].memory.peakPssBytes, 180);
  assert.deepEqual(samples[0].memory.samples, firstPss.map(toSanitizedSample));
  assert.equal(samples[1].memory.peakPssBytes, 280);
  assert.deepEqual(samples[1].memory.samples, secondPss.map(toSanitizedSample));
  assert.equal(samples[2].memory, null);
});

function sample(monotonicNs, pssBytes, processCount = 1) {
  return { monotonicNs: String(monotonicNs), rootPid: 10, processCount, pssBytes, processes: [] };
}

function sanitizedSample(monotonicNs, pssBytes) {
  return { monotonicNs: String(monotonicNs), pssBytes, processCount: 1 };
}

function toSanitizedSample({ monotonicNs, pssBytes, processCount }) {
  return { monotonicNs, pssBytes, processCount };
}
