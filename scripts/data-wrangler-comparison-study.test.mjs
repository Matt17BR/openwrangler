import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { DATA_WRANGLER_STUDY_TOOL_NAMES } from "./data-wrangler-comparison-report.mjs";
import {
  DATA_WRANGLER_VERSION,
  STUDY_CELLS,
  STUDY_PROTOCOL,
  TRIAL_REQUEST_PROTOCOL,
  TRIAL_RESULT_PROTOCOL,
  WARM_REPETITIONS,
  buildStudyManifest,
  completedTrialIds,
  createDataWranglerComparisonSchedule,
  prepareTrial,
  removeStaleTrialDirectories,
  runDataWranglerComparisonStudy,
  runDataWranglerComparisonSmoke,
  runOneTrial,
  validateTrialResult
} from "./data-wrangler-comparison-study.mjs";

const hash = (character) => character.repeat(64);

test("schedule contains ten counterbalanced warm pairs and AB/BA cold pairs for all four cells", () => {
  const schedule = createDataWranglerComparisonSchedule();
  assert.equal(schedule.length, 96);
  assert.deepEqual(
    schedule.map(({ order }) => order),
    [...Array(96).keys()]
  );
  assert.equal(new Set(schedule.map(({ id }) => id)).size, 96);
  for (const cell of STUDY_CELLS) {
    const warm = schedule.filter((entry) => entry.cellId === cell.id && entry.kind === "warm");
    assert.equal(warm.length, WARM_REPETITIONS * 2);
    const firstProducts = warm.filter(({ orderInPair }) => orderInPair === 0).map(({ product }) => product);
    assert.equal(firstProducts.filter((product) => product === "open-wrangler").length, 5);
    assert.equal(firstProducts.filter((product) => product === "data-wrangler").length, 5);
    const cold = schedule.filter((entry) => entry.cellId === cell.id && entry.kind === "cold");
    assert.deepEqual(
      [...Map.groupBy(cold, ({ pairId }) => pairId).values()].map((entries) => entries.map(({ product }) => product)),
      [
        ["open-wrangler", "data-wrangler"],
        ["data-wrangler", "open-wrangler"]
      ]
    );
  }
});

test("manifest records public boundaries, exact provenance, and no Microsoft package hash", () => {
  const manifest = manifestFixture();
  assert.equal(manifest.protocol, STUDY_PROTOCOL);
  assert.equal(manifest.schedule.length, 96);
  assert.equal(manifest.provenance.dataWrangler.version, DATA_WRANGLER_VERSION);
  assert.equal(manifest.provenance.dataWrangler.implementationInspection, "none");
  assert.equal(Object.hasOwn(manifest.provenance.dataWrangler, "sha256"), false);
  assert.equal(manifest.provenance.editor.distribution, "Visual Studio Code");
  assert.equal(manifest.provenance.python.implementation, "cpython");
  assert.equal(manifest.provenance.machine.powerSource, "ac");
  assert.match(manifest.method.timingBoundaries.inlinePreview, /Run Cell click/u);
  assert.match(manifest.method.timingBoundaries.workbenchOpen, /public launch-action click/u);
  assert.match(manifest.method.timingBoundaries.completeProfile, /every column/u);
});

test("study resumes from completed trial IDs without repeating an earlier trial", async () => {
  const root = mkdtempSync(join(tmpdir(), "ow-simple-study-"));
  const calls = [];
  try {
    const dependencies = fakeDependencies(calls);
    const options = studyOptions(root);
    const first = await runDataWranglerComparisonStudy({ ...options, limit: 2 }, dependencies);
    assert.equal(first.completed, 2);
    assert.equal(first.remaining, 94);
    const second = await runDataWranglerComparisonStudy({ ...options, limit: 1 }, dependencies);
    assert.equal(second.completed, 3);
    assert.equal(second.remaining, 93);
    assert.deepEqual(
      calls,
      first.manifest.schedule.slice(0, 3).map(({ id }) => id)
    );
    assert.deepEqual(
      [...completedTrialIds(join(root, "trials"), first.manifest)].sort(),
      first.manifest.schedule
        .slice(0, 3)
        .map(({ id }) => id)
        .sort()
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("paired smoke requires a fresh output and runs both products in one pair", async () => {
  const root = join(tmpdir(), `ow-simple-smoke-${process.pid}-${Date.now()}`);
  const calls = [];
  try {
    const result = await runDataWranglerComparisonSmoke(studyOptions(root), fakeDependencies(calls));
    assert.equal(result.completed, 2);
    assert.equal(result.remaining, 94);
    assert.equal(result.manifest.schedule[0].pairId, result.manifest.schedule[1].pairId);
    assert.deepEqual(new Set(calls), new Set([result.manifest.schedule[0].id, result.manifest.schedule[1].id]));
    await assert.rejects(
      runDataWranglerComparisonSmoke(studyOptions(root), fakeDependencies([])),
      /requires a new output path/u
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("source verification still runs when the trial driver throws", async () => {
  const container = mkdtempSync(join(tmpdir(), "ow-simple-source-failure-"));
  const output = join(container, "study");
  const source = join(container, "source.csv");
  writeFileSync(source, "value\n1\n");
  try {
    const dependencies = fakeDependencies([]);
    dependencies.prepareTrial = ({ entry, manifest, trialRoot }) => ({
      request: { entry, manifest, isolatedRoot: trialRoot },
      verifySources: () => {
        if (readFileSync(source, "utf8") !== "value\n1\n") throw new Error("original fixture changed");
      }
    });
    dependencies.runTrial = async () => {
      writeFileSync(source, "value\n2\n");
      throw new Error("driver failed");
    };
    const result = await runDataWranglerComparisonStudy(
      { ...studyOptions(output), csv: source, limit: 1 },
      dependencies
    );
    const entry = result.manifest.schedule[0];
    const trial = JSON.parse(readFileSync(join(output, "trials", `${entry.id}.json`), "utf8"));
    assert.equal(trial.status, "failure");
    assert.match(trial.failure.message, /driver failed; original fixture changed/u);
  } finally {
    rmSync(container, { recursive: true, force: true });
  }
});

test("failed trial evidence redacts file URIs, paths, and environment references", async () => {
  const root = mkdtempSync(join(tmpdir(), "ow-simple-private-error-"));
  try {
    const dependencies = fakeDependencies([]);
    dependencies.runTrial = async () => {
      throw new Error(
        "failed file:///home/example/private.json from /tmp/private and $HOME ../relative ~/user C:\\private %2Fsecret"
      );
    };
    const result = await runDataWranglerComparisonStudy({ ...studyOptions(root), limit: 1 }, dependencies);
    const entry = result.manifest.schedule[0];
    const trial = JSON.parse(readFileSync(join(root, "trials", `${entry.id}.json`), "utf8"));
    assert.equal(trial.status, "failure");
    assert.equal(trial.failure.message, "failed <path> from <path> and <environment> <path> <path> <path> secret");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("study refuses to resume when a candidate or tool hash changes", async () => {
  const root = mkdtempSync(join(tmpdir(), "ow-simple-study-change-"));
  try {
    const options = studyOptions(root);
    await runDataWranglerComparisonStudy({ ...options, limit: 1 }, fakeDependencies([]));
    const changed = fakeDependencies([]);
    changed.hashFile = (path) => (path.endsWith("data-wrangler-comparison-study.mjs") ? hash("9") : hash("a"));
    await assert.rejects(runDataWranglerComparisonStudy({ ...options, limit: 1 }, changed), /Study inputs changed/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a complete study removes its temporary product extension directories", async () => {
  const root = mkdtempSync(join(tmpdir(), "ow-simple-study-complete-"));
  try {
    for (const product of ["open-wrangler", "data-wrangler"]) {
      mkdirSync(join(root, `prepared-extensions-${product}`));
    }
    const result = await runDataWranglerComparisonStudy(studyOptions(root), fakeDependencies([]));
    assert.equal(result.remaining, 0);
    assert.equal(existsSync(join(root, "prepared-extensions-open-wrangler")), false);
    assert.equal(existsSync(join(root, "prepared-extensions-data-wrangler")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("trial deadline is retained as a timeout result", async () => {
  const entry = createDataWranglerComparisonSchedule()[0];
  const manifest = manifestFixture();
  const result = await runOneTrial({
    entry,
    request: trialRequestProvenance(manifest),
    runTrial: () => new Promise(() => undefined),
    timeoutMs: 5
  });
  assert.equal(result.status, "timeout");
  assert.equal(result.failure.stage, "harness");
  assert.equal(validateTrialResult(result, entry, manifest), result);
});

test("warm trial preparation tags one untimed setup cell before one measured cell", () => {
  const root = mkdtempSync(join(tmpdir(), "ow-simple-trial-"));
  try {
    const csv = join(root, "source.csv");
    writeFileSync(csv, "c00,c01\n0,1\n1,2\n");
    const trialRoot = join(root, "isolated");
    const entry = createDataWranglerComparisonSchedule()[0];
    const manifest = manifestFixture();
    manifest.provenance.fixtures.csv.sha256 = sha256(csv);
    const prepared = prepareTrial({
      entry,
      manifest,
      options: { ...studyOptions(join(root, "study")), csv },
      trialRoot
    });
    assert.equal(prepared.request.protocol, TRIAL_REQUEST_PROTOCOL);
    assert.equal(prepared.request.cell.variableName, "study_frame");
    assert.ok(prepared.request.cell.source.startsWith(`${resolve(trialRoot)}/`));
    assert.ok(prepared.request.notebookPath.startsWith(`${resolve(trialRoot)}/`));
    const notebook = JSON.parse(readFileSync(prepared.request.notebookPath, "utf8"));
    const setup = notebook.cells.filter((cell) => cell.metadata.tags.includes(`ow-comparison-setup:${entry.cellId}`));
    const measured = notebook.cells.filter((cell) => cell.metadata.tags.includes(`ow-comparison-cell:${entry.cellId}`));
    assert.equal(setup.length, 1);
    assert.equal(measured.length, 1);
    assert.equal(notebook.cells.indexOf(setup[0]), 0);
    assert.equal(notebook.cells.indexOf(measured[0]), 1);
    assert.match(setup[0].source.join(""), /study_frame =/u);
    assert.match(measured[0].source.join(""), /study_frame/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("trial preparation rejects source drift and resume removes only stale trial roots", () => {
  const root = mkdtempSync(join(tmpdir(), "ow-simple-drift-"));
  try {
    const csv = join(root, "source.csv");
    writeFileSync(csv, "c00,c01\n0,1\n1,2\n");
    const manifest = manifestFixture();
    manifest.provenance.fixtures.csv.sha256 = hash("f");
    assert.throws(
      () =>
        prepareTrial({
          entry: createDataWranglerComparisonSchedule()[0],
          manifest,
          options: { ...studyOptions(join(root, "study")), csv },
          trialRoot: join(root, "trial")
        }),
      /fixture changed/u
    );

    mkdirSync(join(root, "trial-001-AbC123"));
    mkdirSync(join(root, "keep-me"));
    removeStaleTrialDirectories(root);
    assert.equal(existsSync(join(root, "trial-001-AbC123")), false);
    assert.equal(existsSync(join(root, "keep-me")), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("successful trial validation requires every timing and both absolute and adjusted PSS", () => {
  const manifest = manifestFixture();
  const entry = manifest.schedule[0];
  const result = successResult(entry, manifest);
  assert.equal(validateTrialResult(result, entry, manifest), result);
  assert.throws(
    () => validateTrialResult({ ...result, memory: { ...result.memory, peakPssBytes: -1 } }, entry, manifest),
    /peakPssBytes/u
  );
});

function manifestFixture() {
  return buildStudyManifest({
    createdAtUtc: "2026-08-04T10:00:00.000Z",
    candidate: { version: "1.2.1", sha256: hash("a") },
    editor: {
      version: "1.110.0",
      sha256: hash("b"),
      cliSha256: hash("4"),
      productSha256: hash("5"),
      distribution: "Visual Studio Code"
    },
    python: {
      version: "3.12.12",
      sha256: hash("c"),
      implementation: "cpython",
      packages: { pandas: "2.3.3", polars: "1.34.0", pyarrow: "22.0.0", jupyter_core: "5.9.1", ipykernel: "7.1.0" }
    },
    fixtures: {
      csv: { rows: 100_000, columns: 50, valuesValidated: true, sha256: hash("d") },
      parquet: { rows: 1_000_000, columns: 20, valuesValidated: true, sha256: hash("e") }
    },
    machine: {
      os: "linux",
      osRelease: "6.14.0",
      architecture: "x64",
      cpuModel: "Example CPU",
      logicalCpuCount: 16,
      totalMemoryBytes: 64 * 1024 ** 3,
      powerSource: "ac",
      cpuGovernor: "performance"
    },
    toolHashes: Object.fromEntries(
      DATA_WRANGLER_STUDY_TOOL_NAMES.map((name, index) => [name, hash("abcdef0123456789"[index % 16])])
    )
  });
}

function studyOptions(output) {
  return {
    candidate: "/tmp/openwrangler.vsix",
    python: "/tmp/python",
    editor: "/tmp/code",
    editorCli: "/tmp/code-cli",
    csv: "/tmp/study.csv",
    parquet: "/tmp/study.parquet",
    output
  };
}

function fakeDependencies(calls) {
  return {
    now: () => "2026-08-04T10:00:00.000Z",
    prepareTools: async () => undefined,
    hashFile: () => hash("a"),
    inspectCandidate: async () => ({ version: "1.2.1", sha256: hash("a") }),
    inspectEditor: async () => ({
      version: "1.110.0",
      sha256: hash("b"),
      cliSha256: hash("4"),
      productSha256: hash("5"),
      distribution: "Visual Studio Code"
    }),
    inspectPython: async () => ({
      version: "3.12.12",
      implementation: "cpython",
      packages: { pandas: "2.3.3", polars: "1.34.0", pyarrow: "22.0.0", jupyter_core: "5.9.1", ipykernel: "7.1.0" }
    }),
    inspectMachine: () => ({
      os: "linux",
      osRelease: "6.14.0",
      architecture: "x64",
      cpuModel: "Example CPU",
      logicalCpuCount: 16,
      totalMemoryBytes: 64 * 1024 ** 3,
      powerSource: "ac",
      cpuGovernor: "performance"
    }),
    validateFixtures: async () => ({
      csv: { rows: 100_000, columns: 50, valuesValidated: true },
      parquet: { rows: 1_000_000, columns: 20, valuesValidated: true }
    }),
    prepareTrial: ({ entry, manifest, trialRoot }) => ({ request: { entry, manifest, isolatedRoot: trialRoot } }),
    runTrial: async ({ entry, manifest }) => {
      calls.push(entry.id);
      return successResult(entry, manifest);
    }
  };
}

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function successResult(entry, manifest) {
  return {
    protocol: TRIAL_RESULT_PROTOCOL,
    trialId: entry.id,
    product: entry.product,
    engine: entry.engine,
    format: entry.format,
    kind: entry.kind,
    order: entry.order,
    status: "success",
    failure: null,
    metrics: { inlinePreviewMs: 10, workbenchOpenMs: 20, firstProfileMs: 5, completeProfileMs: 30 },
    milestones: [
      milestone("run-cell-click", 100_000_000),
      milestone("inline-ready", 110_000_000),
      milestone("launch-click", 120_000_000),
      milestone("workbench-ready", 140_000_000),
      milestone("profile-click", 150_000_000),
      milestone("first-profile-ready", 155_000_000),
      milestone("profiles-complete", 180_000_000)
    ],
    publicUi: publicUi(entry.columns),
    memory: {
      baselinePssBytes: 100,
      peakPssBytes: 160,
      adjustedPeakPssBytes: 60,
      sampleCount: 3,
      intervalMs: 200,
      samples: [pss(50_000_000, 100), pss(90_000_000, 100), pss(160_000_000, 160)]
    },
    provenance: trialRequestProvenance(manifest)
  };
}

function trialRequestProvenance(manifest) {
  return {
    candidate: {
      version: manifest.provenance.openWrangler.version,
      sha256: manifest.provenance.openWrangler.sha256
    },
    dataWranglerVersion: DATA_WRANGLER_VERSION,
    editor: { version: manifest.provenance.editor.version, sha256: manifest.provenance.editor.sha256 },
    python: { version: manifest.provenance.python.version, sha256: manifest.provenance.python.sha256 }
  };
}

function milestone(name, monotonicNs) {
  return { name, monotonicNs: String(monotonicNs) };
}

function pss(monotonicNs, pssBytes) {
  return { monotonicNs: String(monotonicNs), pssBytes, processCount: 3 };
}

function publicUi(columns) {
  const action = { accessibleName: "Open in product", unique: true, pointer: true };
  return {
    runCell: { ...action, accessibleName: "Run Cell" },
    inline: { ...action, tableReady: true },
    workbench: {
      rootRole: "grid",
      fullShape: "aria-counts",
      ariaRowCount: 100_000,
      ariaColumnCount: columns,
      verticalOverflow: 100,
      horizontalOverflow: 100,
      pointerUsable: true
    },
    profiling: { ...action, accessibleName: "Profile columns", expectedColumns: columns, completedColumns: columns }
  };
}
