import assert from "node:assert/strict";
import {
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  LARGE_COLUMNS,
  LARGE_FIXTURE_PROTOCOL,
  LARGE_REPETITIONS,
  LARGE_REPORT_PROTOCOL,
  LARGE_ROWS,
  assertLargeRunEnvironment,
  assertCompleteLargeReport,
  buildLargeComparisonReport,
  buildLargeStudyManifest,
  buildLargeTrialResult,
  createLargeComparisonSchedule,
  hashLargeFile,
  prepareLargeTrial,
  runLargeComparisonStudy,
  summarizeLargeValues
} from "./data-wrangler-large-comparison-study.mjs";

const SHA = "a".repeat(64);

test("large comparison schedule creates five fresh sessions per product and engine", () => {
  const schedule = createLargeComparisonSchedule();
  assert.equal(schedule.length, 20);
  assert.equal(new Set(schedule.map(({ id }) => id)).size, 20);
  assert.deepEqual(
    schedule.map(({ order }) => order),
    [...Array(20).keys()]
  );
  for (const engine of ["pandas", "polars"]) {
    for (const product of ["open-wrangler", "data-wrangler"]) {
      const group = schedule.filter((entry) => entry.engine === engine && entry.product === product);
      assert.equal(group.length, LARGE_REPETITIONS);
      assert.deepEqual(group.map(({ repetition }) => repetition).sort(), [1, 2, 3, 4, 5]);
    }
  }
});

test("large summaries report median and range without p95", () => {
  assert.deepEqual(summarizeLargeValues([9, 1, 7, 3, 5]), {
    count: 5,
    minimum: 1,
    median: 5,
    maximum: 9
  });
  assert.equal(Object.hasOwn(summarizeLargeValues([1, 2, 3]), "p95"), false);
});

test("large fixture hashing streams the file", async () => {
  const root = mkdtempSync(join(tmpdir(), "ow-large-hash-"));
  const source = join(root, "fixture.parquet");
  try {
    writeFileSync(source, "streamed synthetic fixture");
    assert.equal(await hashLargeFile(source), "63d84da9d1559c5b87de22674b044c8ee2a9ea29713e7c3e6c9a2b5cf9d7822d");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("large report requires five successful independent sessions in every group", () => {
  const manifest = manifestFixture();
  const trials = manifest.schedule.map((entry) =>
    buildLargeTrialResult(entry, loadFixture(entry.engine), journeyFixture())
  );
  const report = buildLargeComparisonReport({
    generatedAtUtc: "2026-08-05T10:00:00.000Z",
    manifest,
    trials
  });

  assert.equal(report.protocol, LARGE_REPORT_PROTOCOL);
  assert.equal(report.completedTrials, 20);
  assert.equal(report.summaries.length, 4);
  assert.equal(report.loadSummaries.length, 2);
  assert.equal(
    report.summaries.every(({ successful }) => successful === 5),
    true
  );
  assert.equal(
    report.loadSummaries.every(({ successful }) => successful === 10),
    true
  );
  assert.equal(
    report.loadSummaries.every((summary) => Object.hasOwn(summary, "product") === false),
    true
  );
  assert.equal(
    report.summaries.every(({ metrics }) => Object.hasOwn(metrics, "fileLoadMs") === false),
    true
  );
  assert.equal(
    report.loadSummaries.every(({ metrics }) => Object.hasOwn(metrics.fileLoadMs, "p95") === false),
    true
  );
  assert.doesNotThrow(() => assertCompleteLargeReport(report));
  assert.throws(
    () =>
      assertCompleteLargeReport(
        buildLargeComparisonReport({ generatedAtUtc: report.generatedAtUtc, manifest, trials: trials.slice(1) })
      ),
    /five successful fresh sessions/u
  );
});

test("manual study resumes one fresh editor session at a time", async () => {
  const root = mkdtempSync(join(tmpdir(), "ow-large-study-"));
  const calls = [];
  try {
    const dependencies = {
      now: () => "2026-08-05T10:00:00.000Z",
      captureProvenance: async () => provenanceFixture(),
      prepareTools: async () => {},
      inspectRunEnvironment: async () => runEnvironmentFixture(),
      prepareTrial: ({ entry, trialRoot }) => ({
        request: { trialId: entry.id, cell: { engine: entry.engine }, isolatedRoot: trialRoot },
        verifySource() {}
      }),
      runLoad: async (request) => loadFixture(request.cell.engine),
      runJourney: async (request) => {
        calls.push(request.trialId);
        return { samples: [journeyFixture()] };
      }
    };
    const first = await runLargeComparisonStudy({ output: root, confirmLargeStudy: true, limit: 2 }, dependencies);
    assert.deepEqual(first, { completed: 2, remaining: 18 });
    const second = await runLargeComparisonStudy({ output: root, confirmLargeStudy: true, limit: 1 }, dependencies);
    assert.deepEqual(second, { completed: 3, remaining: 17 });
    assert.deepEqual(
      calls,
      createLargeComparisonSchedule()
        .slice(0, 3)
        .map(({ id }) => id)
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an abrupt interruption is cleaned before fixture provenance is checked", async () => {
  const root = mkdtempSync(join(tmpdir(), "ow-large-interrupted-"));
  const fixture = join(root, "large.parquet");
  const stale = join(root, "trial-000-AbCd12");
  writeFileSync(fixture, "generated fixture");
  mkdirSync(stale);
  linkSync(fixture, join(stale, "large.parquet"));
  assert.equal(lstatSync(fixture).nlink, 2);
  try {
    const calls = [];
    const dependencies = fakeStudyDependencies(calls, {
      captureProvenance: async () => {
        assert.equal(lstatSync(fixture).nlink, 1);
        return provenanceFixture();
      }
    });
    const result = await runLargeComparisonStudy(
      { output: root, parquet: fixture, confirmLargeStudy: true, limit: 1 },
      dependencies
    );
    assert.deepEqual(result, { completed: 1, remaining: 19 });
    assert.equal(existsSync(stale), false);
    assert.equal(
      readdirSync(root).some((name) => name.startsWith("trial-")),
      false
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("memory and disk are rechecked immediately before every fresh editor run", async () => {
  const root = mkdtempSync(join(tmpdir(), "ow-large-preflight-"));
  const calls = [];
  let checks = 0;
  try {
    const dependencies = fakeStudyDependencies(calls, {
      inspectRunEnvironment: async () => {
        checks += 1;
        if (checks === 3) {
          return runEnvironmentFixture({ availableMemoryBytes: 1 });
        }
        return runEnvironmentFixture();
      }
    });
    await assert.rejects(
      runLargeComparisonStudy({ output: root, confirmLargeStudy: true, limit: 2 }, dependencies),
      /memory or disk space/iu
    );
    assert.deepEqual(calls, [createLargeComparisonSchedule()[0].id]);
    assert.equal(readdirSync(join(root, "trials")).filter((name) => name.endsWith(".json")).length, 1);
    assert.equal(
      readdirSync(root).some((name) => name.startsWith("trial-")),
      false
    );

    dependencies.inspectRunEnvironment = async () => runEnvironmentFixture();
    const resumed = await runLargeComparisonStudy({ output: root, confirmLargeStudy: true, limit: 1 }, dependencies);
    assert.deepEqual(resumed, { completed: 2, remaining: 18 });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("large-run preflight rejects low capacity, battery power, and governor changes", () => {
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
});

test("large trial hard-links the fixture and asks for one editor journey", () => {
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
    assert.equal(prepared.request.cell.rows, LARGE_ROWS);
    assert.equal(prepared.request.cell.columns, LARGE_COLUMNS);
    assert.equal(prepared.request.cell.profileContract, "mixed-sentinels-v1");
    assert.match(prepared.request.cell.sourceIdentity.inode, /^\d+$/u);
    const notebook = JSON.parse(readFileSync(prepared.request.notebookPath, "utf8"));
    assert.equal(notebook.cells.length, 2);
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

function fakeStudyDependencies(calls, overrides = {}) {
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
    runJourney: async (request) => {
      calls.push(request.trialId);
      return { samples: [journeyFixture()] };
    },
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
    milestones: [],
    publicUi: {},
    memory: {
      peakPssBytes: 600,
      sampleCount: 2,
      intervalMs: 200,
      samples: [
        { monotonicNs: "100", pssBytes: 200, processCount: 1 },
        { monotonicNs: "200", pssBytes: 600, processCount: 2 }
      ]
    }
  };
}
