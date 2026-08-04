import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DATA_WRANGLER_STUDY_TOOL_NAMES, summarizeStudyPssSamples } from "./data-wrangler-comparison-report.mjs";
import {
  DATA_WRANGLER_VERSION,
  SMOKE_REPETITIONS,
  STUDY_CELLS,
  STUDY_PROTOCOL,
  TRIAL_REQUEST_PROTOCOL,
  TRIAL_RESULT_PROTOCOL,
  WARM_REPETITIONS,
  buildStudyManifest,
  createDataWranglerComparisonSchedule,
  loadStudyResults,
  prepareTrial,
  removeStaleTrialDirectories,
  runDataWranglerComparisonSmoke,
  runDataWranglerComparisonStudy,
  runOneTrial,
  terminalTrialIds,
  writeDataWranglerComparisonStudyReport
} from "./data-wrangler-comparison-study.mjs";

const SHA = "a".repeat(64);

test("writes diagnostic report bytes before enforcing release completeness", () => {
  const root = mkdtempSync(join(tmpdir(), "ow-comparison-report-"));
  const output = join(root, "report.json");
  const report = { protocol: "openwrangler-data-wrangler-study-report-v2", completedSessions: 1 };
  try {
    assert.throws(() => writeDataWranglerComparisonStudyReport(output, report), /eight complete sessions/u);
    assert.deepEqual(JSON.parse(readFileSync(output, "utf8")), report);
    assert.throws(() => writeDataWranglerComparisonStudyReport(output, report), /new output path/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("schedule has one ten-sample session per product and workload and no cold launches", () => {
  const schedule = createDataWranglerComparisonSchedule();
  assert.equal(schedule.length, 8);
  assert.deepEqual(
    schedule.map(({ order }) => order),
    [...Array(8).keys()]
  );
  assert.equal(new Set(schedule.map(({ id }) => id)).size, 8);
  assert.equal(
    schedule.every(({ kind }) => kind === "warm"),
    true
  );
  for (const cell of STUDY_CELLS) {
    const sessions = schedule.filter(({ cellId }) => cellId === cell.id);
    assert.equal(sessions.length, 2);
    assert.deepEqual(new Set(sessions.map(({ product }) => product)), new Set(["open-wrangler", "data-wrangler"]));
  }
  assert.deepEqual(
    schedule.filter(({ order }) => order % 2 === 0).map(({ product }) => product),
    ["open-wrangler", "data-wrangler", "data-wrangler", "open-wrangler"]
  );
});

test("manifest records eight sessions, ten repetitions, fixed workloads, and public provenance", () => {
  const manifest = manifestFixture();
  assert.equal(manifest.protocol, STUDY_PROTOCOL);
  assert.equal(manifest.schedule.length, 8);
  assert.equal(manifest.method.repetitionsPerSession, 10);
  assert.equal(Object.hasOwn(manifest.method, "coldOrder"), false);
  assert.equal(manifest.provenance.dataWrangler.version, DATA_WRANGLER_VERSION);
  assert.equal(manifest.provenance.dataWrangler.implementationInspection, "none");
  assert.equal(Object.hasOwn(manifest.provenance.dataWrangler, "sha256"), false);
});

test("study resumes at session granularity without replacing completed samples", async () => {
  const root = mkdtempSync(join(tmpdir(), "ow-batched-study-"));
  const calls = [];
  try {
    const dependencies = fakeDependencies(calls);
    const options = studyOptions(root);
    const first = await runDataWranglerComparisonStudy({ ...options, limit: 2 }, dependencies);
    assert.equal(first.completed, 2);
    assert.equal(first.remaining, 6);
    const second = await runDataWranglerComparisonStudy({ ...options, limit: 1 }, dependencies);
    assert.equal(second.completed, 3);
    assert.equal(second.remaining, 5);
    assert.deepEqual(
      calls,
      first.manifest.schedule.slice(0, 3).map(({ id }) => id)
    );
    assert.deepEqual(
      [...terminalTrialIds(join(root, "trials"), first.manifest)].sort(),
      first.manifest.schedule
        .slice(0, 3)
        .map(({ id }) => id)
        .sort()
    );
    assert.equal(loadStudyResults(root).trials[0].samples.length, 10);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("smoke runs the two product sessions for one workload", async () => {
  const root = join(tmpdir(), `ow-batched-smoke-${process.pid}-${Date.now()}`);
  const calls = [];
  try {
    const result = await runDataWranglerComparisonSmoke(studyOptions(root), fakeDependencies(calls));
    assert.equal(result.completed, 2);
    assert.equal(result.remaining, 6);
    assert.equal(new Set(calls).size, 2);
    assert.equal(result.manifest.method.repetitionsPerSession, SMOKE_REPETITIONS);
    assert.equal(
      loadStudyResults(root).trials.every(({ samples }) => samples.length === SMOKE_REPETITIONS),
      true
    );
    assert.deepEqual(
      new Set(result.manifest.schedule.slice(0, 2).map(({ product }) => product)),
      new Set(["open-wrangler", "data-wrangler"])
    );
    const resumedCalls = [];
    const resumed = await runDataWranglerComparisonSmoke(studyOptions(root), fakeDependencies(resumedCalls));
    assert.equal(resumed.completed, 2);
    assert.deepEqual(resumedCalls, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an interrupted session is recorded and rerun without replacing successful sessions", async () => {
  const root = mkdtempSync(join(tmpdir(), "ow-batched-failure-"));
  try {
    const dependencies = fakeDependencies([]);
    dependencies.runTrial = async () => {
      throw new Error("file:///private/source.csv $HOME /home/alice/source.csv");
    };
    const status = await runDataWranglerComparisonStudy({ ...studyOptions(root), limit: 1 }, dependencies);
    assert.equal(status.completed, 0);
    assert.equal(status.remaining, 8);
    const [trial] = loadStudyResults(root).trials;
    assert.equal(trial.samples.length, 10);
    assert.equal(
      trial.samples.every(({ status: sampleStatus }) => sampleStatus === "failure"),
      true
    );
    assert.equal(JSON.stringify(trial).includes("/private"), false);
    assert.equal(JSON.stringify(trial).includes("$HOME"), false);

    const calls = [];
    const resumed = await runDataWranglerComparisonStudy({ ...studyOptions(root), limit: 1 }, fakeDependencies(calls));
    assert.equal(resumed.completed, 1);
    assert.equal(resumed.remaining, 7);
    assert.deepEqual(calls, [resumed.manifest.schedule[0].id]);
    assert.equal(
      loadStudyResults(root).trials[0].samples.every(({ status: sampleStatus }) => sampleStatus === "success"),
      true
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a measured product failure remains in the study instead of being retried", async () => {
  const root = mkdtempSync(join(tmpdir(), "ow-batched-product-failure-"));
  try {
    const manifest = manifestFixture();
    const dependencies = fakeDependencies([]);
    dependencies.runTrial = async (request) => {
      const entry = manifest.schedule.find(({ id }) => id === request.trialId);
      const result = sessionResult(entry, manifest, request.repetitions);
      result.samples[0] = failedProductSample(1);
      return result;
    };
    const first = await runDataWranglerComparisonStudy({ ...studyOptions(root), limit: 1 }, dependencies);
    assert.equal(first.completed, 1);
    assert.equal(first.remaining, 7);

    const calls = [];
    const resumed = await runDataWranglerComparisonStudy({ ...studyOptions(root), limit: 1 }, fakeDependencies(calls));
    assert.equal(resumed.completed, 2);
    assert.deepEqual(calls, [resumed.manifest.schedule[1].id]);
    const retained = loadStudyResults(root).trials.find(({ trialId }) => trialId === resumed.manifest.schedule[0].id);
    assert.equal(retained.samples[0].failure.kind, "product");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("session deadline yields ten timeout samples", async () => {
  const manifest = manifestFixture();
  const entry = manifest.schedule[0];
  const request = requestForEntry(entry, manifest);
  const result = await runOneTrial({ entry, request, runTrial: () => new Promise(() => {}), timeoutMs: 5 });
  assert.equal(result.protocol, TRIAL_RESULT_PROTOCOL);
  assert.equal(result.samples.length, 10);
  assert.equal(
    result.samples.every(({ status }) => status === "timeout"),
    true
  );
});

test("prepared request loads one resident dataframe and asks the host for ten measured samples", () => {
  const root = mkdtempSync(join(tmpdir(), "ow-batched-prepare-"));
  const csv = join(root, "fixture.csv");
  const parquet = join(root, "fixture.parquet");
  writeFileSync(csv, "c00\n0\n");
  writeFileSync(parquet, "parquet fixture");
  const manifest = manifestFixture({ csvHash: hashFile(csv), parquetHash: hashFile(parquet) });
  const trialRoot = join(root, "session");
  try {
    const prepared = prepareTrial({
      entry: manifest.schedule[0],
      manifest,
      options: { ...studyOptions(root), csv, parquet },
      trialRoot
    });
    assert.equal(prepared.request.protocol, TRIAL_REQUEST_PROTOCOL);
    assert.equal(prepared.request.kind, "warm");
    assert.equal(prepared.request.repetitions, WARM_REPETITIONS);
    const notebook = JSON.parse(readFileSync(prepared.request.notebookPath, "utf8"));
    assert.equal(notebook.cells.length, 2);
    assert.match(notebook.cells[0].source.join(""), /study_frame = pd\.read_csv/u);
    assert.equal(notebook.cells[1].source.join(""), "study_frame");
    assert.doesNotThrow(prepared.verifySources);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("stale temporary session roots are removed without touching unrelated entries", () => {
  const root = mkdtempSync(join(tmpdir(), "ow-batched-stale-"));
  try {
    mkdirSync(join(root, "trial-001-AbCd12"));
    mkdirSync(join(root, "keep-me"));
    removeStaleTrialDirectories(root);
    assert.equal(existsSync(join(root, "trial-001-AbCd12")), false);
    assert.equal(existsSync(join(root, "keep-me")), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function fakeDependencies(calls) {
  const manifest = manifestFixture();
  return {
    now: () => manifest.createdAtUtc,
    prepareTools: async () => {},
    inspectCandidate: async () => manifest.provenance.openWrangler,
    inspectEditor: async () => manifest.provenance.editor,
    inspectPython: async () => manifest.provenance.python,
    inspectMachine: () => manifest.provenance.machine,
    validateFixtures: async () => manifest.provenance.fixtures,
    hashFile: () => SHA,
    prepareTrial: ({ entry, manifest: activeManifest, trialRoot }) => ({
      request: requestForEntry(entry, activeManifest, trialRoot),
      verifySources() {}
    }),
    runTrial: async (request) => {
      calls.push(request.trialId);
      const entry = manifest.schedule.find(({ id }) => id === request.trialId);
      return sessionResult(entry, manifest, request.repetitions);
    }
  };
}

function studyOptions(output) {
  return {
    candidate: "/tmp/openwrangler.vsix",
    python: "/tmp/python3.12",
    editor: "/tmp/code",
    editorCli: "/tmp/code-cli",
    csv: "/tmp/study.csv",
    parquet: "/tmp/study.parquet",
    output
  };
}

function manifestFixture({ csvHash = SHA, parquetHash = SHA } = {}) {
  return buildStudyManifest({
    createdAtUtc: "2026-08-04T10:00:00.000Z",
    candidate: { version: "1.2.1", sha256: SHA },
    editor: {
      version: "1.131.0",
      sha256: SHA,
      cliSha256: SHA,
      productSha256: SHA,
      distribution: "Visual Studio Code"
    },
    python: { version: "3.12.11", sha256: SHA, implementation: "cpython", packages: {} },
    fixtures: {
      csv: { rows: 100_000, columns: 50, valuesValidated: true, sha256: csvHash },
      parquet: { rows: 1_000_000, columns: 20, valuesValidated: true, sha256: parquetHash }
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
    toolHashes: Object.fromEntries(DATA_WRANGLER_STUDY_TOOL_NAMES.map((name) => [name, SHA]))
  });
}

function requestForEntry(entry, manifest, isolatedRoot = "/tmp/ow-comparison-session") {
  return {
    protocol: TRIAL_REQUEST_PROTOCOL,
    trialId: entry.id,
    product: entry.product,
    kind: "warm",
    order: entry.order,
    repetitions: manifest.method.repetitionsPerSession,
    isolatedRoot,
    candidate: { path: "/tmp/openwrangler.vsix", ...manifest.provenance.openWrangler },
    dataWranglerVersion: manifest.provenance.dataWrangler.version,
    editor: { path: "/tmp/code", cliPath: "/tmp/code-cli", ...manifest.provenance.editor },
    python: { path: "/tmp/python", ...manifest.provenance.python }
  };
}

function sessionResult(entry, manifest, repetitions = manifest.method.repetitionsPerSession) {
  return {
    protocol: TRIAL_RESULT_PROTOCOL,
    trialId: entry.id,
    product: entry.product,
    engine: entry.engine,
    format: entry.format,
    kind: "warm",
    order: entry.order,
    samples: Array.from({ length: repetitions }, (_unused, index) => successfulSample(index + 1, entry.columns)),
    provenance: {
      candidate: { version: manifest.provenance.openWrangler.version, sha256: manifest.provenance.openWrangler.sha256 },
      dataWranglerVersion: manifest.provenance.dataWrangler.version,
      editor: { version: manifest.provenance.editor.version, sha256: manifest.provenance.editor.sha256 },
      python: { version: manifest.provenance.python.version, sha256: manifest.provenance.python.sha256 }
    }
  };
}

function successfulSample(index, columns) {
  const milestones = [
    mark("run-cell-click", 11_000_000_000),
    mark("inline-ready", 11_010_000_000),
    mark("launch-click", 11_011_000_000),
    mark("workbench-ready", 11_031_000_000),
    mark("profile-click", 11_032_000_000),
    mark("first-profile-ready", 11_037_000_000),
    mark("profiles-complete", 11_062_000_000)
  ];
  const memory = summarizeStudyPssSamples([pss(11_000_000_000, 150), pss(11_062_000_000, 149)], milestones);
  return {
    index,
    status: "success",
    failure: null,
    metrics: { inlinePreviewMs: 10, workbenchOpenMs: 20, firstProfileMs: 5, completeProfileMs: 30 },
    milestones,
    publicUi: {
      runCell: action("Run Cell"),
      inline: { ...action("Open in viewer"), tableReady: true },
      workbench: {
        rootRole: "grid",
        fullShape: "visible-label",
        ariaRowCount: null,
        ariaColumnCount: null,
        verticalOverflow: 100,
        horizontalOverflow: 100,
        pointerUsable: true
      },
      profiling: { ...action("Column profiles"), expectedColumns: columns, completedColumns: columns }
    },
    memory
  };
}

function failedProductSample(index) {
  return {
    index,
    status: "failure",
    failure: { stage: "inline-preview", kind: "product", message: "The inline preview failed." },
    metrics: { inlinePreviewMs: null, workbenchOpenMs: null, firstProfileMs: null, completeProfileMs: null },
    milestones: [mark("run-cell-click", 11_000_000_000)],
    publicUi: { runCell: action("Run Cell"), inline: null, workbench: null, profiling: null },
    memory: null
  };
}

const action = (accessibleName) => ({ accessibleName, unique: true, pointer: true });
const mark = (name, monotonicNs) => ({ name, monotonicNs: String(monotonicNs) });
const pss = (monotonicNs, pssBytes) => ({ monotonicNs: String(monotonicNs), pssBytes, processCount: 4 });
const hashFile = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");
