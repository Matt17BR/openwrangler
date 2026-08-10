import {
  DATA_WRANGLER_STUDY_TOOL_NAMES,
  buildDataWranglerComparisonStudyReport,
  summarizeStudyPssSamples
} from "./data-wrangler-comparison-report.mjs";
import { TRIAL_RESULT_PROTOCOL, buildStudyManifest } from "./data-wrangler-comparison-study.mjs";

export const COMPARISON_TEST_SHA = "a".repeat(64);

export function createReleaseComparisonReport({
  generatedAtUtc = "2026-08-04T12:00:00.000Z",
  pssSampleCount = 2,
  sha256 = COMPARISON_TEST_SHA,
  version = "2.0.0"
} = {}) {
  const manifest = buildStudyManifest({
    createdAtUtc: "2026-08-04T10:00:00.000Z",
    candidate: { version, sha256 },
    editor: {
      version: "1.131.0",
      sha256: COMPARISON_TEST_SHA,
      cliSha256: COMPARISON_TEST_SHA,
      productSha256: COMPARISON_TEST_SHA,
      distribution: "Visual Studio Code"
    },
    python: {
      version: "3.12.11",
      sha256: COMPARISON_TEST_SHA,
      implementation: "cpython",
      packages: {}
    },
    fixtures: {
      csv: { rows: 100_000, columns: 50, valuesValidated: true, sha256: COMPARISON_TEST_SHA },
      parquet: { rows: 1_000_000, columns: 20, valuesValidated: true, sha256: COMPARISON_TEST_SHA }
    },
    machine: {
      os: "linux",
      osRelease: "6.8",
      architecture: "x64",
      cpuModel: "Example CPU",
      logicalCpuCount: 8,
      totalMemoryBytes: 16_000_000_000,
      powerSource: "ac",
      cpuGovernor: "performance"
    },
    toolHashes: Object.fromEntries(DATA_WRANGLER_STUDY_TOOL_NAMES.map((name) => [name, COMPARISON_TEST_SHA]))
  });
  return buildDataWranglerComparisonStudyReport({
    generatedAtUtc,
    manifest,
    trials: manifest.schedule.map((entry) => comparisonSession(entry, manifest, pssSampleCount))
  });
}

function comparisonSession(entry, manifest, pssSampleCount) {
  return {
    protocol: TRIAL_RESULT_PROTOCOL,
    trialId: entry.id,
    product: entry.product,
    engine: entry.engine,
    format: entry.format,
    kind: "warm",
    order: entry.order,
    samples: Array.from({ length: 5 }, (_unused, index) => successfulSample(index + 1, entry.columns, pssSampleCount)),
    provenance: {
      candidate: {
        version: manifest.provenance.openWrangler.version,
        sha256: manifest.provenance.openWrangler.sha256
      },
      dataWranglerVersion: manifest.provenance.dataWrangler.version,
      editor: { version: manifest.provenance.editor.version, sha256: manifest.provenance.editor.sha256 },
      python: { version: manifest.provenance.python.version, sha256: manifest.provenance.python.sha256 }
    }
  };
}

function successfulSample(index, columns, pssSampleCount) {
  if (!Number.isSafeInteger(pssSampleCount) || pssSampleCount < 2 || pssSampleCount > 2_000) {
    throw new TypeError("Comparison test PSS sample count must be between 2 and 2,000.");
  }
  const start = 11_000_000_000;
  const profileStart = start + 32_000_000;
  const end = Math.max(start + 62_000_000, start + (pssSampleCount - 1) * 200_000_000);
  const milestones = [
    mark("run-cell-click", start),
    mark("inline-ready", start + 10_000_000),
    mark("launch-click", start + 11_000_000),
    mark("workbench-ready", start + 31_000_000),
    mark("profile-click", profileStart),
    mark("first-profile-ready", profileStart + 5_000_000),
    mark("profiles-complete", end)
  ];
  const pssSamples = Array.from({ length: pssSampleCount }, (_unused, offset) => {
    const monotonicNs = pssSampleCount === 2 ? (offset === 0 ? start : end) : start + offset * 200_000_000;
    return { monotonicNs: String(monotonicNs), pssBytes: 150 + index, processCount: 4 };
  });
  return {
    index,
    status: "success",
    failure: null,
    metrics: {
      inlinePreviewMs: 10,
      workbenchOpenMs: 20,
      firstProfileMs: 5,
      completeProfileMs: (end - profileStart) / 1_000_000
    },
    milestones,
    publicUi: {
      runCell: action("Run Cell"),
      inline: { ...action("Open in Open Wrangler"), tableReady: true },
      workbench: {
        rootRole: "grid",
        fullShape: "visible-label",
        ariaRowCount: null,
        ariaColumnCount: null,
        verticalOverflow: 100,
        horizontalOverflow: 100,
        pointerUsable: true
      },
      profiling: { ...action("Column profiles and filters"), expectedColumns: columns, completedColumns: columns }
    },
    memory: summarizeStudyPssSamples(pssSamples, milestones)
  };
}

const action = (accessibleName) => ({ accessibleName, unique: true, pointer: true });
const mark = (name, monotonicNs) => ({ name, monotonicNs: String(monotonicNs) });
