import assert from "node:assert/strict";
import test from "node:test";
import {
  COMPARISON_PHASE_PROTOCOL,
  DATA_WRANGLER_COMPARISON_BOUNDARY,
  DATA_WRANGLER_COMPARISON_SMOKE_PROTOCOL,
  buildDataWranglerComparisonSmokeReport,
  validateDataWranglerComparisonPhase,
  validateDataWranglerComparisonSmokeReport
} from "./data-wrangler-comparison-report.mjs";

const digest = (value) => value.repeat(64);

test("builds one explicitly non-publishable smoke report with four matched phases", () => {
  const report = passingReport();

  assert.equal(report.protocol, DATA_WRANGLER_COMPARISON_SMOKE_PROTOCOL);
  assert.equal(report.feasibilityOnly, true);
  assert.equal(report.publishable, false);
  assert.deepEqual(report.studyDesign.executionOrder, ["open-wrangler", "data-wrangler"]);
  assert.equal(report.studyDesign.orderPolicy, "fixed");
  assert.equal(report.studyDesign.diagnosticLaunchesPerProductFormat, 1);
  assert.equal(report.studyDesign.durationInterpretation, "diagnostic-only-non-comparative");
  assert.equal(report.studyDesign.backendMatch, "not-established");
  assert.deepEqual(
    report.phases.map((phase) => `${phase.product.key}:${phase.fixture.format}`),
    ["open-wrangler:csv", "open-wrangler:parquet", "data-wrangler:csv", "data-wrangler:parquet"]
  );
  assert.equal(validateDataWranglerComparisonSmokeReport(report), report);
  assert.equal(report.phases[2].product.candidateSha256, null);
});

test("phase validation requires official VS Code, diagnostic readiness, source, process, and cleanup proofs", () => {
  const phase = comparisonPhase("open-wrangler", "csv");
  assert.equal(validateDataWranglerComparisonPhase(phase), phase);

  const mutations = [
    [{ ...phase, editor: { ...phase.editor, id: "cursor.cursor" } }, /editor ID/u],
    [{ ...phase, editor: { ...phase.editor, displayMode: "xvfb" } }, /editor display mode/u],
    [{ ...phase, editor: { ...phase.editor, displayMode: "current" } }, /editor display mode/u],
    [{ ...phase, diagnostic: { ...phase.diagnostic, warmupCompleted: false } }, /warm-up proof/u],
    [
      {
        ...phase,
        diagnostic: {
          ...phase.diagnostic,
          cacheProof: { ...phase.diagnostic.cacheProof, residentPagesAfter: 2 }
        }
      },
      /resident pages after/u
    ],
    [{ ...phase, proofs: { ...phase.proofs, sourceUnchanged: false } }, /source-content proof/u],
    [
      {
        ...phase,
        proofs: { ...phase.proofs, configuredPythonProcessObservedDuringProductRun: false }
      },
      /configured-Python-process/u
    ],
    [{ ...phase, proofs: { ...phase.proofs, cleanupVerified: false } }, /terminal-cleanup proof/u]
  ];
  for (const [value, expected] of mutations) {
    assert.throws(() => validateDataWranglerComparisonPhase(value), expected);
  }
});

test("Data Wrangler provenance can identify only the Marketplace version, never proprietary bytes", () => {
  const phase = comparisonPhase("data-wrangler", "csv");
  assert.equal(validateDataWranglerComparisonPhase(phase), phase);
  assert.throws(
    () =>
      validateDataWranglerComparisonPhase({
        ...phase,
        product: { ...phase.product, candidateSha256: digest("9") }
      }),
    /proprietary candidate digest/u
  );
  assert.throws(
    () =>
      validateDataWranglerComparisonPhase({
        ...phase,
        product: { ...phase.product, version: "1.25.0" },
        installedExtensions: phase.installedExtensions.map((entry) =>
          entry === "ms-toolsai.datawrangler@1.24.2" ? "ms-toolsai.datawrangler@1.25.0" : entry
        )
      }),
    /baseline version/u
  );
});

test("comparison evidence rejects paths, raw logs, screenshots, DOM dumps, and unknown marketing fields", () => {
  const phase = comparisonPhase("open-wrangler", "csv");
  for (const extra of [
    { sourcePath: "/home/alice/private.csv" },
    { rawLog: "extension output" },
    { screenshot: "capture.png" },
    { dom: "<table></table>" },
    { winner: "Open Wrangler" },
    { speedup: 2 }
  ]) {
    assert.throws(() => validateDataWranglerComparisonPhase({ ...phase, ...extra }), /missing or unknown fields/u);
  }
  assert.throws(
    () =>
      validateDataWranglerComparisonPhase({
        ...phase,
        installedExtensions: [...phase.installedExtensions, "/home/alice/extension.vsix"]
      }),
    /extension-id@version/u
  );
});

test("readiness evidence stays product-neutral and requires stable visible deterministic cells", () => {
  const phase = comparisonPhase("open-wrangler", "csv");
  const grid = phase.diagnostic.readiness.grid;
  const invalidReadiness = [
    [{ ...grid, rootRole: "treegrid" }, /root role/u],
    [{ ...grid, busy: "true" }, /aria-busy/u],
    [{ ...grid, visible: false }, /visible-grid proof/u],
    [{ ...grid, pointerUsable: false }, /pointer-usable grid proof/u],
    [{ ...grid, geometryStableFrames: 1 }, /stable-geometry/u],
    [{ ...grid, headers: ["c00", "sales"] }, /headers/u],
    [{ ...grid, sentinelsMatched: false }, /deterministic-sentinel proof/u]
  ];
  for (const [invalidGrid, expected] of invalidReadiness) {
    assert.throws(
      () =>
        validateDataWranglerComparisonPhase({
          ...phase,
          diagnostic: {
            ...phase.diagnostic,
            readiness: { ...phase.diagnostic.readiness, grid: invalidGrid }
          }
        }),
      expected
    );
  }

  for (const key of [
    "targetEditorSelected",
    "noVisibleQuickInput",
    "noVisibleDialog",
    "noVisibleModal",
    "rendererFramePointerUsable"
  ]) {
    assert.throws(
      () =>
        validateDataWranglerComparisonPhase({
          ...phase,
          diagnostic: {
            ...phase.diagnostic,
            readiness: {
              ...phase.diagnostic.readiness,
              workbench: { ...phase.diagnostic.readiness.workbench, [key]: false }
            }
          }
        }),
      /proof/u
    );
  }
  assert.equal(JSON.stringify(phase).includes("topLeftValues"), false);
  assert.equal(JSON.stringify(phase).includes('"0","1"'), false);
});

test("report validation requires exactly one phase per product and format with one configured environment", () => {
  const report = passingReport();
  const duplicate = structuredClone(report);
  duplicate.phases[3] = structuredClone(duplicate.phases[2]);
  assert.throws(() => validateDataWranglerComparisonSmokeReport(duplicate), /each product and format exactly once/u);

  const environmentDrift = structuredClone(report);
  environmentDrift.configuredPythonEnvironment.installedPandasVersion = "";
  assert.throws(() => validateDataWranglerComparisonSmokeReport(environmentDrift), /installed Pandas version/u);

  const fixtureDrift = structuredClone(report);
  fixtureDrift.phases[1].fixture.sha256 = digest("9");
  assert.throws(() => validateDataWranglerComparisonSmokeReport(fixtureDrift), /deterministic smoke fixture manifest/u);
});

test("smoke reports cannot be relabeled as publishable, statistical, or release-sized evidence", () => {
  const report = passingReport();
  assert.throws(() => validateDataWranglerComparisonSmokeReport({ ...report, publishable: true }), /publishable flag/u);
  assert.throws(
    () =>
      validateDataWranglerComparisonSmokeReport({
        ...report,
        studyDesign: { ...report.studyDesign, diagnosticLaunchesPerProductFormat: 10 }
      }),
    /diagnostic launches/u
  );
  assert.throws(
    () =>
      buildDataWranglerComparisonSmokeReport({
        generatedAtUtc: report.generatedAtUtc,
        configuredPythonEnvironment: report.configuredPythonEnvironment,
        fixtureManifest: { ...fixtureManifest(), smoke: false },
        phases: report.phases
      }),
    /fixture|smoke-sized/u
  );
});

function passingReport() {
  return buildDataWranglerComparisonSmokeReport({
    generatedAtUtc: "2026-07-28T00:00:00.000Z",
    configuredPythonEnvironment: comparisonConfiguredPythonEnvironment(),
    fixtureManifest: fixtureManifest(),
    phases: [
      comparisonPhase("data-wrangler", "parquet"),
      comparisonPhase("open-wrangler", "csv"),
      comparisonPhase("data-wrangler", "csv"),
      comparisonPhase("open-wrangler", "parquet")
    ]
  });
}

function comparisonPhase(productKey, format) {
  const product =
    productKey === "open-wrangler"
      ? {
          key: "open-wrangler",
          id: "Matt17BR.openwrangler",
          version: "1.0.0",
          installation: "candidate-vsix",
          candidateSha256: digest("a")
        }
      : {
          key: "data-wrangler",
          id: "ms-toolsai.datawrangler",
          version: "1.24.2",
          installation: "official-vscode-marketplace",
          candidateSha256: null
        };
  const entry = fixtureManifest().fixtures[format];
  return {
    protocol: COMPARISON_PHASE_PROTOCOL,
    runId:
      productKey === "open-wrangler"
        ? format === "csv"
          ? "11111111-1111-4111-8111-111111111111"
          : "22222222-2222-4222-8222-222222222222"
        : format === "csv"
          ? "33333333-3333-4333-8333-333333333333"
          : "44444444-4444-4444-8444-444444444444",
    product,
    editor: {
      id: "microsoft.vscode",
      version: "1.130.0",
      officialDistribution: true,
      displayMode: "headless"
    },
    fixture: {
      format,
      rows: entry.rows,
      columns: entry.columns,
      bytes: entry.bytes,
      sha256: entry.sha256
    },
    diagnostic: {
      boundary: DATA_WRANGLER_COMPARISON_BOUNDARY,
      warmupCompleted: true,
      diagnosticDurationMs: format === "csv" ? 750.25 : 1_250.5,
      cacheProof: {
        protocol: "openwrangler-source-cache-proof-v1",
        requestedState: "resident",
        fdatasyncApplied: true,
        adviceAccepted: false,
        verification: "linux-mincore",
        pageSizeBytes: 4_096,
        totalPages: 10,
        residentPagesBefore: 3,
        residentPagesAfter: 10,
        identityStable: true,
        verified: true
      },
      readiness: {
        grid: {
          rootRole: "grid",
          busy: "false",
          visible: true,
          pointerUsable: true,
          geometryStableFrames: 2,
          headers: ["c00", "c01"],
          sentinelsMatched: true,
          ariaRowCount: entry.rows + 1,
          ariaColumnCount: entry.columns + 1
        },
        workbench: {
          targetEditorSelected: true,
          noVisibleQuickInput: true,
          noVisibleDialog: true,
          noVisibleModal: true,
          rendererFramePointerUsable: true
        }
      }
    },
    proofs: {
      telemetryDisabled: true,
      sourceIdentityStable: true,
      sourceUnchanged: true,
      configuredPythonProcessObservedDuringProductRun: true,
      cleanupVerified: true
    },
    installedExtensions:
      productKey === "open-wrangler"
        ? ["matt17br.openwrangler@1.0.0", "openwrangler-tests.openwrangler-packaged-test-harness@0.0.0"]
        : [
            "ms-python.python@2026.10.0",
            "ms-toolsai.datawrangler@1.24.2",
            "ms-toolsai.jupyter@2026.7.0",
            "openwrangler-tests.openwrangler-packaged-test-harness@0.0.0"
          ]
  };
}

function comparisonConfiguredPythonEnvironment() {
  return {
    pythonVersion: "3.12.12",
    pythonImplementation: "CPython",
    pythonExecutableSha256: digest("b"),
    installedPandasVersion: "2.3.3",
    installedPyarrowVersion: "22.0.0",
    installedJupyterCoreVersion: "5.9.1",
    installedIpykernelVersion: "7.1.0"
  };
}

function fixtureManifest() {
  return {
    protocol: "openwrangler-installed-performance-fixtures-v1",
    smoke: true,
    generator: {
      contractVersion: 1,
      implementation: "polars",
      implementationVersion: "1.34.0"
    },
    license: "CC0-1.0",
    redistribution: "Deterministic synthetic integer fixtures generated by Open Wrangler.",
    fixtures: {
      csv: fixture("csv", 2_000, 8, "c"),
      parquet: fixture("parquet", 5_000, 8, "d")
    }
  };
}

function fixture(format, rows, columns, digestValue) {
  return {
    fileName: `${rows}-${columns}.${format}`,
    format,
    rows,
    columns,
    columnType: "Int64",
    columnNamePattern: "c followed by a zero-padded zero-based integer",
    sentinelRows: [0, Math.floor(rows / 2), rows - 1],
    sha256: digest(digestValue),
    bytes: format === "csv" ? 100_000 : 50_000
  };
}
