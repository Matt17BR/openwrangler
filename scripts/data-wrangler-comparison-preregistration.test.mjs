import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { linkSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import ts from "typescript";
import {
  assertCurrentDataWranglerComparisonPreregistration,
  DATA_WRANGLER_COMPARISON_CACHE_PYTHON_CONTROLLER_PATH,
  captureDataWranglerComparisonPreregistration,
  captureDataWranglerComparisonPreregistrationFile,
  createDataWranglerComparisonPreregistrationReceipt,
  proveDataWranglerComparisonExecutionGraph,
  readDataWranglerComparisonPreregistration,
  validateDataWranglerComparisonPreregistration,
  writeDataWranglerComparisonPreregistration
} from "./data-wrangler-comparison-preregistration.mjs";
import {
  generateDataWranglerComparisonPreregistration,
  parseDataWranglerComparisonPreregistrationArguments
} from "./generate-data-wrangler-comparison-preregistration.mjs";
import { digestStudyValue } from "./data-wrangler-comparison-study.mjs";

const ID = "11111111-1111-4111-8111-111111111111";
const CREATED = "2026-08-03T10:00:00.000Z";
const SHA = "a".repeat(64);

function privateDirectory() {
  const root = mkdtempSync(resolve(tmpdir(), "ow-preregistration-"));
  return {
    root,
    cleanup() {
      rmSync(root, { recursive: true, force: true });
    }
  };
}

function graph() {
  const modules = [
    {
      path: "test/extensionHost/dataWranglerComparisonNotebookTrial.js",
      sha256: "c".repeat(64)
    }
  ];
  return {
    entry: "test/extensionHost/dataWranglerComparisonNotebookTrial.js",
    moduleCount: 1,
    totalBytes: 100,
    graphSha256: createHash("sha256").update(JSON.stringify(modules), "utf8").digest("hex"),
    modules
  };
}

function executionGraph() {
  const entries = [
    "scripts/run-data-wrangler-comparison-preparation.mjs",
    "scripts/run-data-wrangler-comparison-study-entry.mjs"
  ];
  const modules = entries.map((path, index) => ({ path, sha256: String(index + 1).repeat(64) }));
  const edges = entries.map((from) => ({ from, kind: "import", specifier: "node:fs", target: "external:node:fs" }));
  const value = {
    protocol: "openwrangler-data-wrangler-comparison-execution-graph-v1",
    scope: ["scripts/", "src/shared/"],
    parser: {
      implementation: "typescript",
      version: ts.version,
      scriptKind: "JavaScript",
      scriptTarget: "Latest"
    },
    entries,
    moduleCount: modules.length,
    edgeCount: edges.length,
    totalBytes: 200,
    externalSpecifiers: ["node:fs"],
    modules,
    edges
  };
  return { ...value, graphSha256: digestStudyValue(value) };
}

function capture() {
  return captureDataWranglerComparisonPreregistration(
    { studyId: ID, createdAtUtc: CREATED, journeyPath: "/compiled/dataWranglerComparisonNotebookTrial.js" },
    {
      captureFile: () => ({ sha256: SHA }),
      captureMethodology: () => ({
        protocol: "openwrangler-data-wrangler-study-method-v1",
        sha256: "d".repeat(64)
      }),
      proveJourneyGraph: graph,
      proveExecutionGraph: executionGraph
    }
  );
}

test("preregistration captures the complete immutable design without dynamic study evidence", () => {
  const value = capture();
  assert.equal(value.studyId, ID);
  assert.equal(value.design.sampling.schedule.length, 96);
  assert.equal(value.design.fixtures[0].schema.length, 50);
  assert.equal(value.design.fixtures[1].schema.length, 20);
  assert.deepEqual(value.driverRecipe.journeyGraph, graph());
  assert.equal(value.toolRecipes.cacheHarnessSha256, SHA);
  assert.equal(value.toolRecipes.cachePythonControllerSha256, SHA);
  assert.deepEqual(value.toolRecipes.executionGraph, executionGraph());
  assert.equal(Object.hasOwn(value, "candidate"), false);
  assert.equal(Object.hasOwn(value, "provenance"), false);
  assert.match(createDataWranglerComparisonPreregistrationReceipt(value).sha256, /^[0-9a-f]{64}$/u);
});

test("preregistration rejects schedule drift and checked-in recipe drift", () => {
  const scheduleDrift = structuredClone(capture());
  scheduleDrift.design.sampling.schedule[0].product = "data-wrangler";
  assert.throws(() => validateDataWranglerComparisonPreregistration(scheduleDrift), /schedule or limits changed/u);

  const extra = structuredClone(capture());
  extra.pending = true;
  assert.throws(() => validateDataWranglerComparisonPreregistration(extra), /missing or unknown fields/u);

  const environmentDrift = structuredClone(capture());
  environmentDrift.design.environment.display.unreviewed = true;
  assert.throws(() => validateDataWranglerComparisonPreregistration(environmentDrift), /schedule or limits changed/u);

  const graphDrift = structuredClone(capture());
  graphDrift.driverRecipe.journeyGraph.modules[0].sha256 = "f".repeat(64);
  assert.throws(() => validateDataWranglerComparisonPreregistration(graphDrift), /journey graph digest is invalid/u);

  const recorded = capture();
  assert.throws(
    () =>
      assertCurrentDataWranglerComparisonPreregistration(
        recorded,
        { journeyPath: "/compiled/dataWranglerComparisonNotebookTrial.js" },
        {
          captureFile: () => ({ sha256: "e".repeat(64) }),
          captureMethodology: () => recorded.method,
          proveJourneyGraph: graph,
          proveExecutionGraph: executionGraph
        }
      ),
    /no longer matches/u
  );
});

test("preregistration publication is append-only and reads back the exact strict JSON", () => {
  const directory = privateDirectory();
  try {
    const path = resolve(directory.root, "preregistration.json");
    const value = capture();
    assert.equal(writeDataWranglerComparisonPreregistration(path, value).status, "published");
    assert.deepEqual(readDataWranglerComparisonPreregistration(path), value);
    assert.throws(
      () => writeDataWranglerComparisonPreregistration(path, { ...value, createdAtUtc: "2026-08-03T10:00:01.000Z" }),
      /does not match its expected digest|target/u
    );
  } finally {
    directory.cleanup();
  }
});

test("static file capture rejects links instead of blessing substituted recipe bytes", () => {
  const directory = privateDirectory();
  try {
    const source = resolve(directory.root, "source.js");
    const symbolic = resolve(directory.root, "symbolic.js");
    const hard = resolve(directory.root, "hard.js");
    writeFileSync(source, "export const audited = true;\n", { mode: 0o600 });
    const receipt = captureDataWranglerComparisonPreregistrationFile(source, "source");
    assert.match(receipt.sha256, /^[0-9a-f]{64}$/u);
    symlinkSync(source, symbolic);
    assert.throws(
      () => captureDataWranglerComparisonPreregistrationFile(symbolic, "symbolic"),
      /singly linked regular file/u
    );
    linkSync(source, hard);
    assert.throws(
      () => captureDataWranglerComparisonPreregistrationFile(source, "hard-linked"),
      /singly linked regular file/u
    );
  } finally {
    directory.cleanup();
  }
});

test("public preregistration CLI accepts only one output and publishes through injected audited capture", async () => {
  assert.deepEqual(parseDataWranglerComparisonPreregistrationArguments(["--out", "study.json"], "/tmp"), {
    out: "/tmp/study.json"
  });
  assert.throws(() => parseDataWranglerComparisonPreregistrationArguments([], "/tmp"), /Usage/u);

  const directory = privateDirectory();
  try {
    const out = resolve(directory.root, "study.json");
    const result = await generateDataWranglerComparisonPreregistration(
      { out },
      {
        identity: { studyId: ID, createdAtUtc: CREATED },
        captureFile: () => ({ sha256: SHA }),
        captureMethodology: () => ({
          protocol: "openwrangler-data-wrangler-study-method-v1",
          sha256: "d".repeat(64)
        }),
        proveJourneyGraph: graph,
        proveExecutionGraph: executionGraph
      }
    );
    assert.equal(result.publication.status, "published");
    assert.deepEqual(JSON.parse(readFileSync(out, "utf8")), result.value);
  } finally {
    directory.cleanup();
  }
});

test("the real cache harness and Python controller are distinct, explicitly bound tools", () => {
  const harness = captureDataWranglerComparisonPreregistrationFile(
    resolve("scripts/data-wrangler-comparison-cache-controller.mjs"),
    "cache harness"
  );
  const controller = captureDataWranglerComparisonPreregistrationFile(
    DATA_WRANGLER_COMPARISON_CACHE_PYTHON_CONTROLLER_PATH,
    "cache Python controller"
  );
  assert.notEqual(harness.sha256, controller.sha256);
  const value = captureDataWranglerComparisonPreregistration(
    { studyId: ID, createdAtUtc: CREATED, journeyPath: "/compiled/dataWranglerComparisonNotebookTrial.js" },
    {
      captureFile(path) {
        if (path.endsWith("data-wrangler-comparison-cache-controller.mjs")) return harness;
        if (path === DATA_WRANGLER_COMPARISON_CACHE_PYTHON_CONTROLLER_PATH) return controller;
        return { sha256: SHA };
      },
      captureMethodology: () => ({
        protocol: "openwrangler-data-wrangler-study-method-v1",
        sha256: "d".repeat(64)
      }),
      proveJourneyGraph: graph,
      proveExecutionGraph: executionGraph
    }
  );
  assert.equal(value.toolRecipes.cacheHarnessSha256, harness.sha256);
  assert.equal(value.toolRecipes.cachePythonControllerSha256, controller.sha256);
  assert.notEqual(value.toolRecipes.cacheHarnessSha256, value.toolRecipes.cachePythonControllerSha256);
});

test("current preregistration validation rejects execution-graph drift", () => {
  const recorded = capture();
  const changedGraph = structuredClone(executionGraph());
  changedGraph.modules[0].sha256 = "f".repeat(64);
  changedGraph.graphSha256 = digestStudyValue({
    protocol: changedGraph.protocol,
    scope: changedGraph.scope,
    parser: changedGraph.parser,
    entries: changedGraph.entries,
    moduleCount: changedGraph.moduleCount,
    edgeCount: changedGraph.edgeCount,
    totalBytes: changedGraph.totalBytes,
    externalSpecifiers: changedGraph.externalSpecifiers,
    modules: changedGraph.modules,
    edges: changedGraph.edges
  });
  assert.throws(
    () =>
      assertCurrentDataWranglerComparisonPreregistration(
        recorded,
        { journeyPath: "/compiled/dataWranglerComparisonNotebookTrial.js" },
        {
          captureFile: () => ({ sha256: SHA }),
          captureMethodology: () => recorded.method,
          proveJourneyGraph: graph,
          proveExecutionGraph: () => changedGraph
        }
      ),
    /no longer matches/u
  );
});

test("the bounded execution graph contains preparation, public capture, smoke, prepared, and live trial code", () => {
  const value = proveDataWranglerComparisonExecutionGraph();
  const paths = new Set(value.modules.map((entry) => entry.path));
  for (const path of [
    "scripts/run-data-wrangler-comparison-preparation.mjs",
    "scripts/data-wrangler-comparison-preparation.mjs",
    "scripts/data-wrangler-comparison-public-capture.mjs",
    "scripts/data-wrangler-comparison-warmup.mjs",
    "scripts/data-wrangler-comparison-fixtures.mjs",
    "scripts/editor-acceptance.mjs",
    "scripts/run-data-wrangler-comparison.mjs",
    "scripts/run-data-wrangler-comparison-study.mjs",
    "scripts/run-data-wrangler-comparison-study-entry.mjs",
    "scripts/run-data-wrangler-comparison-prepared.mjs",
    "scripts/data-wrangler-comparison-live-trial.mjs"
  ]) {
    assert.equal(paths.has(path), true, `${path} must be bound`);
  }
  assert.equal(value.edgeCount, value.edges.length);
  assert.equal(value.externalSpecifiers.includes("typescript"), true);
});
