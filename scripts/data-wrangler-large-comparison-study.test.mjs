import assert from "node:assert/strict";
import { lstatSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  LARGE_COLUMNS,
  LARGE_FIXTURE_PROTOCOL,
  LARGE_REPETITIONS,
  LARGE_REPORT_PROTOCOL,
  LARGE_ROWS,
  assertCompleteLargeReport,
  assertLargeRunEnvironment,
  buildLargeComparisonReport,
  buildLargeStudyManifest,
  buildLargeTrialResult,
  createLargeComparisonSchedule,
  prepareLargeTrial,
  runLargeComparisonStudy
} from "./data-wrangler-large-comparison-study.mjs";

const SHA = "a".repeat(64);

test("large schedule is counterbalanced and the report keeps every reached milestone", () => {
  const schedule = createLargeComparisonSchedule();
  assert.equal(schedule.length, 20);
  assert.equal(new Set(schedule.map(({ id }) => id)).size, 20);
  for (const engine of ["pandas", "polars"]) {
    const group = schedule.filter((entry) => entry.engine === engine);
    for (const product of ["open-wrangler", "data-wrangler"]) {
      assert.deepEqual(
        group.filter((entry) => entry.product === product).map(({ repetition }) => repetition),
        [1, 2, 3, 4, 5]
      );
    }
    assert.equal(group.filter(({ measureNativeLoad }) => measureNativeLoad).length, LARGE_REPETITIONS);
    const firstProducts = [...Array(LARGE_REPETITIONS)].map(
      (_unused, index) =>
        group.find(({ repetition, measureNativeLoad }) => repetition === index + 1 && measureNativeLoad).product
    );
    assert.deepEqual(
      firstProducts,
      engine === "pandas"
        ? ["open-wrangler", "data-wrangler", "open-wrangler", "data-wrangler", "open-wrangler"]
        : ["data-wrangler", "open-wrangler", "data-wrangler", "open-wrangler", "data-wrangler"]
    );
  }
  const manifest = manifestFixture();
  const partialId = manifest.schedule.find(
    ({ engine, product }) => engine === "pandas" && product === "open-wrangler"
  ).id;
  const trials = manifest.schedule.map((entry) =>
    buildLargeTrialResult(
      entry,
      entry.measureNativeLoad ? loadFixture(entry.engine) : null,
      entry.id === partialId ? partialJourneyFixture() : journeyFixture()
    )
  );
  const report = buildLargeComparisonReport({
    generatedAtUtc: "2026-08-05T10:00:00.000Z",
    manifest,
    trials
  });

  assert.equal(report.protocol, LARGE_REPORT_PROTOCOL);
  assert.deepEqual(
    report.loadSummaries.map(({ planned, completed, successful }) => [planned, completed, successful]),
    [
      [5, 5, 5],
      [5, 5, 5]
    ]
  );
  const pandasOpen = report.summaries.find(({ engine, product }) => engine === "pandas" && product === "open-wrangler");
  assert.equal(pandasOpen.successful, 4);
  assert.equal(pandasOpen.metrics.inlinePreviewMs.count, 5);
  assert.equal(pandasOpen.metrics.workbenchOpenMs.count, 5);
  assert.equal(pandasOpen.metrics.runCellToWorkbenchMs.count, 5);
  assert.equal(pandasOpen.metrics.runCellToWorkbenchMs.median, 800);
  assert.equal(pandasOpen.metrics.allProfilesMs.count, 4);
  assert.equal(pandasOpen.metrics.peakPssBytes.count, 4);
  assert.equal(Object.hasOwn(pandasOpen.metrics.inlinePreviewMs, "p95"), false);
  assert.doesNotThrow(() => assertCompleteLargeReport(report));
});

test("large study runs once, resumes, and rejects an unsuitable machine", async () => {
  const root = mkdtempSync(join(tmpdir(), "ow-large-run-"));
  const journeys = [];
  const loads = [];
  const failedId = createLargeComparisonSchedule().find(({ measureNativeLoad }) => measureNativeLoad).id;
  let environmentChecks = 0;
  try {
    const dependencies = fakeStudyDependencies({
      inspectRunEnvironment: async () => {
        environmentChecks += 1;
        return runEnvironmentFixture();
      },
      runLoad: async (request) => {
        loads.push(request.trialId);
        return loadFixture(request.cell.engine);
      },
      runJourney: async (request) => {
        journeys.push(request.trialId);
        if (request.trialId === failedId) throw new Error("synthetic editor failure");
        return { samples: [journeyFixture()] };
      }
    });
    assert.deepEqual(await runLargeComparisonStudy({ output: root, confirmLargeStudy: true }, dependencies), {
      completed: 20,
      remaining: 0
    });
    assert.equal(journeys.length, 20);
    assert.equal(loads.length, 10);
    assert.equal(environmentChecks, 40);
    const failed = JSON.parse(readFileSync(join(root, "trials", `${failedId}.json`), "utf8"));
    assert.match(failed.error, /synthetic editor failure/u);
    assert.equal(failed.load.engine, failed.engine);
    assert.deepEqual(await runLargeComparisonStudy({ output: root, confirmLargeStudy: true }, dependencies), {
      completed: 20,
      remaining: 0
    });
    assert.equal(journeys.length, 20);
    assert.equal(loads.length, 10);
    const expectedMachine = provenanceFixture().machine;
    assert.doesNotThrow(() => assertLargeRunEnvironment(runEnvironmentFixture(), expectedMachine));
    assert.throws(
      () => assertLargeRunEnvironment(runEnvironmentFixture({ freeDiskBytes: 1 }), expectedMachine),
      /memory or disk space/iu
    );
    assert.throws(
      () => assertLargeRunEnvironment(runEnvironmentFixture(undefined, { powerSource: "battery" }), expectedMachine),
      /power/iu
    );
    assert.throws(
      () => assertLargeRunEnvironment(runEnvironmentFixture(undefined, { cpuGovernor: "powersave" }), expectedMachine),
      /governor/iu
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("large trial hard-links the fixture and requests one mixed-profile journey", () => {
  const root = mkdtempSync(join(tmpdir(), "ow-large-prepare-"));
  const fixture = join(root, "large.parquet");
  const trialRoot = join(root, "trial");
  writeFileSync(fixture, "synthetic fixture");
  const manifest = manifestFixture({ bytes: Buffer.byteLength("synthetic fixture") });
  try {
    const prepared = prepareLargeTrial({
      entry: manifest.schedule[0],
      manifest,
      options: {
        parquet: fixture,
        candidate: "/tmp/openwrangler.vsix",
        editor: "/tmp/code",
        editorCli: "/tmp/code-cli",
        python: "/tmp/python"
      },
      trialRoot
    });
    assert.equal(prepared.request.repetitions, 1);
    assert.equal(prepared.request.cell.profileContract, "mixed-sentinels-v1");
    assert.equal(lstatSync(fixture).ino.toString(), prepared.request.cell.sourceIdentity.inode);
    const notebook = JSON.parse(readFileSync(prepared.request.notebookPath, "utf8"));
    assert.match(notebook.cells[0].source.join(""), /study_frame = pd\.read_parquet/u);
    assert.equal(notebook.cells[1].source.join(""), "study_frame");
    assert.doesNotThrow(prepared.verifySource);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function manifestFixture({ bytes = 5_000_000_000 } = {}) {
  return buildLargeStudyManifest({ createdAtUtc: "2026-08-05T10:00:00.000Z", ...provenanceFixture(bytes) });
}

function fakeStudyDependencies(overrides = {}) {
  return {
    now: () => "2026-08-05T10:00:00.000Z",
    captureProvenance: async () => provenanceFixture(),
    prepareTools: async () => {},
    inspectRunEnvironment: async () => runEnvironmentFixture(),
    prepareTrial: ({ entry, trialRoot }) => ({
      request: { trialId: entry.id, cell: { engine: entry.engine }, isolatedRoot: trialRoot },
      verifySource() {}
    }),
    runLoad: async (request) => loadFixture(request.cell.engine),
    runJourney: async () => ({ samples: [journeyFixture()] }),
    ...overrides
  };
}

function runEnvironmentFixture(capacity = {}, machine = {}) {
  return {
    machine: { ...provenanceFixture().machine, ...machine },
    capacity: {
      availableMemoryBytes: 48 * 1024 ** 3,
      freeDiskBytes: 20 * 1024 ** 3,
      ...capacity
    }
  };
}

function provenanceFixture(bytes = 5_000_000_000) {
  return {
    candidate: { version: "1.2.3", sha256: SHA },
    editor: {
      version: "1.132.0",
      sha256: SHA,
      cliSha256: SHA,
      productSha256: SHA,
      distribution: "Visual Studio Code"
    },
    python: { version: "3.12.13", sha256: SHA, implementation: "cpython", packages: {} },
    fixture: {
      protocol: LARGE_FIXTURE_PROTOCOL,
      rows: LARGE_ROWS,
      columns: LARGE_COLUMNS,
      rowGroupRows: 100_000,
      bytes,
      sha256: SHA,
      schema: Array.from({ length: LARGE_COLUMNS }, (_unused, index) => ({
        name: `c${String(index).padStart(2, "0")}`,
        role: index < 50 ? "number" : "other",
        arrowType: index < 50 ? "double" : "string"
      })),
      profileSentinels: {
        numericExtrema: [-900_000_000, 900_000_000],
        categoricalTopValue: "enterprise",
        highCardinalityTopValueTemplate: "popular-c{column}",
        datetimeExtrema: ["2000-01-01", "2099-12-31"],
        durationExtremaMs: [-86_400_000, 31_536_000_000],
        durationTopValueMs: 172_800_000,
        booleanValues: ["True", "False"]
      }
    },
    machine: {
      os: "linux",
      osRelease: "6.8",
      architecture: "x64",
      cpuModel: "Example CPU",
      logicalCpuCount: 16,
      totalMemoryBytes: 64 * 1024 ** 3,
      powerSource: "ac",
      cpuGovernor: "performance"
    },
    tools: { study: SHA, generator: SHA }
  };
}

function loadFixture(engine) {
  return {
    protocol: "openwrangler-large-parquet-load-v1",
    engine,
    elapsedMs: 1_000,
    rows: LARGE_ROWS,
    columns: LARGE_COLUMNS,
    baselinePeakRssBytes: 100,
    peakRssBytes: 300,
    peakRssIncreaseBytes: 200
  };
}

function journeyFixture() {
  return {
    index: 1,
    status: "success",
    failure: null,
    metrics: {
      inlinePreviewMs: 200,
      workbenchOpenMs: 500,
      firstProfileMs: 300,
      completeProfileMs: 8_000
    },
    milestones: [
      { name: "run-cell-click", monotonicNs: "100000000" },
      { name: "inline-ready", monotonicNs: "300000000" },
      { name: "launch-click", monotonicNs: "400000000" },
      { name: "workbench-ready", monotonicNs: "900000000" },
      { name: "profile-click", monotonicNs: "1000000000" },
      { name: "first-profile-ready", monotonicNs: "1300000000" },
      { name: "profiles-complete", monotonicNs: "9000000000" }
    ],
    publicUi: {},
    memory: {
      peakPssBytes: 600,
      sampleCount: 2,
      intervalMs: 200,
      samples: [
        { monotonicNs: "100000000", pssBytes: 200, processCount: 1 },
        { monotonicNs: "9000000000", pssBytes: 600, processCount: 2 }
      ]
    }
  };
}

function partialJourneyFixture() {
  return {
    ...journeyFixture(),
    status: "timeout",
    failure: { stage: "profile-all", kind: "timeout", message: "synthetic profile timeout" },
    metrics: { ...journeyFixture().metrics, completeProfileMs: null },
    milestones: journeyFixture().milestones.slice(0, -1),
    memory: null
  };
}
