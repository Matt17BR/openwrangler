import assert from "node:assert/strict";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, relative, resolve, sep } from "node:path";
import test from "node:test";
import {
  createDataWranglerComparisonCleanupUnsettledError,
  dataWranglerComparisonCleanupMayBeUnsettled
} from "./data-wrangler-comparison-cleanup-safety.mjs";
import { createDataWranglerComparisonTemplateInventory } from "./data-wrangler-comparison-inventory.mjs";
import { createDataWranglerComparisonSourceCopy } from "./data-wrangler-comparison-source-copy.mjs";
import {
  captureDataWranglerPreparationFile,
  retireDataWranglerComparisonOwnedDirectory
} from "./data-wrangler-comparison-preparation.mjs";
import {
  DATA_WRANGLER_PUBLIC_WARMUP_BRIDGE_TIMEOUT_MS,
  DATA_WRANGLER_PUBLIC_WARMUP_BRIDGE_KINDS,
  DATA_WRANGLER_PUBLIC_WARMUP_PHASE_PROTOCOL,
  capturePreparedProductWarmups as capturePreparedProductWarmupsImplementation,
  controlDataWranglerPublicWarmup,
  runPreparedProductWarmupJourney
} from "./data-wrangler-comparison-warmup.mjs";
import { createDataWranglerStudyBridgeController } from "./data-wrangler-study-control-bridge.mjs";

const digest = "a".repeat(64);

function capturePreparedProductWarmups(input, environment, overrides = {}) {
  return capturePreparedProductWarmupsImplementation(input, environment, {
    requireWatchHeadroom: async () => ({ passed: true }),
    installOpaqueExtension: async () => ({ status: "test-install" }),
    cleanupSourceCopy: () => undefined,
    captureTemplate(_sourceRoot, targetRoot) {
      privateDirectory(targetRoot);
      return {
        root: targetRoot,
        rootIdentity: { device: "1", inode: "2", mode: 0o700, owner: "1", group: "1" },
        entryCount: 0,
        totalBytes: 0,
        treeSha256: digest
      };
    },
    retireClone(clone) {
      rmSync(clone.root, { recursive: true, force: false });
      return { status: "retired", treeEmpty: true };
    },
    ...overrides
  });
}

function privateDirectory(path) {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  chmodSync(path, 0o700);
  return path;
}

function testKernel(root) {
  const name = "dataframe-comparison-study-private";
  const displayName = "Dataframe comparison study CPython 3.12.10 (private trial)";
  const directory = privateDirectory(resolve(root, "canonical-jupyter", "data", "kernels", name));
  const path = resolve(directory, "kernel.json");
  writeFileSync(
    path,
    `${JSON.stringify({
      argv: ["/python", "-I", "-m", "ipykernel_launcher", "-f", "{connection_file}"],
      display_name: displayName,
      language: "python",
      metadata: { debugger: false }
    })}\n`,
    { mode: 0o600, flag: "wx" }
  );
  const captured = captureDataWranglerPreparationFile(path, "Warm-up test kernelspec", {
    maximumBytes: 64 * 1024
  });
  return {
    path,
    name,
    displayName,
    sha256: captured.sha256,
    jupyterEnvironment: {
      dataDir: resolve(root, "canonical-jupyter", "data"),
      runtimeDir: privateDirectory(resolve(root, "canonical-jupyter", "runtime")),
      configDir: privateDirectory(resolve(root, "canonical-jupyter", "config")),
      path: privateDirectory(resolve(root, "canonical-jupyter", "path"))
    }
  };
}

function isInside(root, path) {
  const value = relative(root, path);
  return value.length > 0 && value !== ".." && !value.startsWith(`..${sep}`);
}

function receipt(product, editor, fixture, kernel, sourceReceipt, exchanges) {
  return {
    protocol: DATA_WRANGLER_PUBLIC_WARMUP_PHASE_PROTOCOL,
    product,
    untimed: true,
    locale: "en",
    editorVersion: editor.version,
    study: {
      engine: "polars",
      format: "csv",
      kind: "warm",
      fixture: { id: fixture.id, sha256: fixture.sha256, rows: fixture.rows, columns: fixture.columns },
      kernel: { name: kernel.name, displayName: kernel.displayName },
      sourceReceipt,
      pythonImplementation: "CPython",
      pythonVersion: "3.12.10"
    },
    milestones: {
      inlineActionMs: 1,
      inlineReadyMs: 2,
      workbenchActionMs: 3,
      workbenchReadyMs: 4,
      profileActionMs: 5,
      firstProfileReadyMs: 6,
      profilesCompleteMs: 7
    },
    profiles: { expectedColumnCount: fixture.columns, completedColumnCount: fixture.columns, canonicalOrder: true },
    controlBridge: {
      clock: "process-hrtime-bigint",
      authoritativeForStudy: true,
      requestProtocol: "openwrangler-data-wrangler-study-bridge-request-v1",
      acknowledgementProtocol: "openwrangler-data-wrangler-study-bridge-ack-v1",
      exchanges
    },
    cleanup: { closeStatus: "succeeded", afterVerification: "matched" }
  };
}

async function runRealWarmupController(options) {
  const controller = createDataWranglerStudyBridgeController(
    {
      requestPath: options.comparisonStudyEnvironment.requestPath,
      acknowledgementPath: options.comparisonStudyEnvironment.acknowledgementPath,
      runId: options.runId,
      phase: options.phase
    },
    { timeoutMs: 2_000, pollIntervalMs: 1 }
  );
  const exchanges = [];
  for (const kind of DATA_WRANGLER_PUBLIC_WARMUP_BRIDGE_KINDS) {
    exchanges.push(await controller.exchange(kind));
  }
  controller.close();
  return exchanges;
}

test("public warm-up gives a clean notebook launch a bounded startup window", async () => {
  const expectedError = new Error("stop after capturing responder options");
  let observedOptions;
  await assert.rejects(
    controlDataWranglerPublicWarmup(
      {
        requestPath: "/private/bridge/request.json",
        acknowledgementPath: "/private/bridge/acknowledgement.json",
        runId: "00000000-0000-4000-8000-000000000000",
        phase: "comparison-study-open-wrangler-warmup"
      },
      {
        createResponder(_input, options) {
          observedOptions = options;
          throw expectedError;
        }
      }
    ),
    (error) => error === expectedError
  );
  assert.deepEqual(observedOptions, { timeoutMs: DATA_WRANGLER_PUBLIC_WARMUP_BRIDGE_TIMEOUT_MS });
});

test("watch headroom failure prevents the warm-up controller and editor phase", async () => {
  const root = mkdtempSync(resolve(tmpdir(), "ow-study-warmup-headroom-"));
  try {
    chmodSync(root, 0o700);
    const fixture = { id: "csv-100k-50", format: "csv", sha256: digest, rows: 100_000, columns: 50 };
    const kernel = testKernel(root);
    const events = [];
    await assert.rejects(
      capturePreparedProductWarmups(
        {
          specification: {
            candidate: { extensionId: "Matt17BR.openwrangler", version: "1.2.1" },
            baseline: { extensionId: "ms-toolsai.datawrangler", version: "1.24.2" },
            fixtures: [fixture],
            provenance: { comparisonDriver: {} }
          },
          templates: [
            { product: "open-wrangler", kind: "configured-only", root: resolve(root, "configured"), sandboxArgs: [] }
          ],
          templateTrees: new Map([["open-wrangler:configured-only", digest]]),
          studyRoot: root,
          editor: { version: "1.109.2" },
          pythonPath: "/python",
          kernel,
          fixturePath: "/fixture.csv",
          driverDirectory: "/driver",
          driverVsixPath: "/driver.vsix"
        },
        {},
        {
          id: () => "00000000-0000-4000-8000-000000000000",
          recoverDriver: () => undefined,
          cloneTemplate: (_template, { cloneRoot }) => ({
            root: privateDirectory(cloneRoot),
            userData: privateDirectory(resolve(cloneRoot, "user")),
            extensions: privateDirectory(resolve(cloneRoot, "extensions")),
            sandboxArgs: []
          }),
          createEnvironment: () => ({}),
          configureTempRoot: () => undefined,
          materializeKernel: () => ({ jupyterEnvironment: kernel.jupyterEnvironment }),
          readInventory: async () =>
            createDataWranglerComparisonTemplateInventory({
              extensionId: "Matt17BR.openwrangler",
              version: "1.2.1"
            }),
          createSourceCopy: () => ({
            copyPath: "/private/source.csv",
            copyReceipt: {
              sha256: digest,
              filesystemIdentity: { device: "1", inode: "2", sizeBytes: 1, mtimeNs: "3" }
            }
          }),
          writeNotebook: () => undefined,
          requireWatchHeadroom: async () => {
            events.push("watch-headroom");
            throw new Error("warm-up watch headroom unavailable");
          },
          retireRunRoot(value, label) {
            events.push("retire-run-root");
            return retireDataWranglerComparisonOwnedDirectory(value, label);
          },
          controlWarmup: async () => {
            events.push("controller");
          },
          runPhase: async () => {
            events.push("editor-phase");
          }
        }
      ),
      /warm-up watch headroom unavailable/u
    );
    assert.deepEqual(events, ["watch-headroom", "retire-run-root"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("prepared warm-up drives the real request/acknowledgement controller for both measured products", async () => {
  const root = mkdtempSync(resolve(tmpdir(), "ow-study-warmup-"));
  try {
    const editor = { version: "1.109.2" };
    const fixture = { id: "csv-100k-50", format: "csv", sha256: digest, rows: 100_000, columns: 50 };
    const kernel = testKernel(root);
    const configured = ["open-wrangler", "data-wrangler"].map((product) => ({
      product,
      kind: "configured-only",
      root: resolve(root, product, "configured"),
      sandboxArgs: ["--no-sandbox"]
    }));
    const templateTrees = new Map(configured.map((entry) => [`${entry.product}:configured-only`, digest]));
    const phases = [];
    const localKernelLayouts = [];
    const recovered = [];
    const retiredRunRoots = [];
    let nextId = 0;
    const result = await capturePreparedProductWarmups(
      {
        specification: {
          candidate: { extensionId: "Matt17BR.openwrangler", version: "1.2.1" },
          baseline: { extensionId: "ms-toolsai.datawrangler", version: "1.24.2" },
          fixtures: [fixture],
          provenance: { comparisonDriver: { protocol: "driver" } }
        },
        templates: configured,
        templateTrees,
        studyRoot: root,
        editor,
        pythonPath: "/python",
        kernel,
        fixturePath: "/fixture.csv",
        driverDirectory: "/driver",
        driverVsixPath: "/driver.vsix"
      },
      {},
      {
        id: () => `00000000-0000-4000-8000-00000000000${nextId++}`,
        recoverDriver: (value) => recovered.push(value),
        cloneTemplate: (template, { cloneRoot }) => {
          mkdirSync(resolve(cloneRoot, "user"), { recursive: true });
          mkdirSync(resolve(cloneRoot, "extensions"), { recursive: true });
          return {
            root: cloneRoot,
            userData: resolve(cloneRoot, "user"),
            extensions: resolve(cloneRoot, "extensions"),
            sandboxArgs: template.sandboxArgs
          };
        },
        createEnvironment: (_environment, values) => values,
        configureTempRoot: () => undefined,
        retireRunRoot(value, label) {
          retiredRunRoots.push(value.root);
          return retireDataWranglerComparisonOwnedDirectory(value, label);
        },
        createSourceCopy: () => ({
          copyPath: "/private/source.csv",
          copyReceipt: {
            sha256: digest,
            filesystemIdentity: { device: "1", inode: "2", sizeBytes: 1, mtimeNs: "3" }
          }
        }),
        cleanupSourceCopy: () => undefined,
        writeNotebook: () => undefined,
        runPhase: async (options) => {
          phases.push(options);
          const phaseRoot = dirname(options.workspace);
          localKernelLayouts.push(
            Object.values(options.jupyterEnvironment).every(
              (path) => isInside(phaseRoot, path) && Number(lstatSync(path, { bigint: true }).mode & 0o777n) === 0o700
            )
          );
          const product = options.phase.includes("open-wrangler") ? "open-wrangler" : "data-wrangler";
          const exchanges = await runRealWarmupController(options);
          return receipt(
            product,
            editor,
            fixture,
            kernel,
            {
              sha256: digest,
              filesystemIdentity: { device: "1", inode: "2", sizeBytes: 1, mtimeNs: "3" }
            },
            exchanges
          );
        },
        readInventory: async ({ userData }) => {
          const product = userData.includes("open-wrangler") ? "open-wrangler" : "data-wrangler";
          return createDataWranglerComparisonTemplateInventory(
            product === "open-wrangler"
              ? { extensionId: "Matt17BR.openwrangler", version: "1.2.1" }
              : { extensionId: "ms-toolsai.datawrangler", version: "1.24.2" }
          );
        },
        remove() {
          assert.fail("A warm-up run root must be retired only with its identity-owned clone.");
        },
        captureTree: () => ({ treeSha256: digest, fileCount: 1, totalBytes: 1 })
      }
    );
    assert.deepEqual(
      result.templates.map(({ product, kind }) => ({ product, kind })),
      [
        { product: "open-wrangler", kind: "warmed" },
        { product: "data-wrangler", kind: "warmed" }
      ]
    );
    assert.equal(phases.length, 2);
    assert.ok(phases.every((phase) => phase.developmentPaths[0] === "/driver"));
    assert.ok(phases.every((phase) => phase.requiresWorkbenchCdp === true));
    assert.deepEqual(localKernelLayouts, [true, true]);
    assert.ok(phases.every((phase) => phase.jupyterEnvironment.dataDir !== kernel.jupyterEnvironment.dataDir));
    assert.ok(
      phases.every(
        (phase) =>
          phase.comparisonStudyEnvironment.requestPath.endsWith("/bridge/request.json") &&
          phase.comparisonStudyEnvironment.acknowledgementPath.endsWith("/bridge/acknowledgement.json")
      )
    );
    assert.ok(
      result.provenance.every(
        (entry) => entry.receipt.controlBridge.exchanges.length === DATA_WRANGLER_PUBLIC_WARMUP_BRIDGE_KINDS.length
      )
    );
    assert.equal(recovered.length, 5);
    assert.equal(retiredRunRoots.length, 2);
    assert.ok(retiredRunRoots.every((path) => !existsSync(path)));
    assert.ok(result.provenance.every((entry) => entry.receipt.untimed === true));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a successful warm-up attempts source-copy cleanup only once when cleanup throws", async () => {
  const root = mkdtempSync(resolve(tmpdir(), "ow-study-warmup-cleanup-once-"));
  try {
    chmodSync(root, 0o700);
    const editor = { version: "1.109.2" };
    const fixture = { id: "csv-100k-50", format: "csv", sha256: digest, rows: 100_000, columns: 50 };
    const kernel = testKernel(root);
    const sourceReceipt = {
      sha256: digest,
      filesystemIdentity: { device: "1", inode: "2", sizeBytes: 1, mtimeNs: "3" }
    };
    const cleanupError = new Error("source cleanup failed once");
    let cleanupCalls = 0;
    await assert.rejects(
      runPreparedProductWarmupJourney(
        {
          product: "open-wrangler",
          runId: "10000000-0000-4000-8000-000000000000",
          runRoot: resolve(root, "clone", "public-warmup"),
          profile: { userData: "/user", extensions: "/extensions", sandboxArgs: [] },
          editor,
          pythonPath: "/python",
          kernel,
          fixture,
          fixturePath: "/fixture.csv",
          driverDirectory: "/driver",
          driverVsixPath: "/driver.vsix",
          expectedDriver: {},
          expectedInventory: [],
          developmentPaths: []
        },
        {},
        {
          createEnvironment: (_environment, values) => values,
          configureTempRoot() {},
          materializeKernel({ runRoot }) {
            const jupyterRoot = privateDirectory(resolve(runRoot, "jupyter"));
            return {
              jupyterEnvironment: {
                dataDir: privateDirectory(resolve(jupyterRoot, "data")),
                runtimeDir: privateDirectory(resolve(jupyterRoot, "runtime")),
                configDir: privateDirectory(resolve(jupyterRoot, "config")),
                path: privateDirectory(resolve(jupyterRoot, "path"))
              }
            };
          },
          recoverDriver() {},
          readInventory: async () => [],
          requireWatchHeadroom: async () => ({ passed: true }),
          createSourceCopy: () => ({ copyPath: "/private/source.csv", copyReceipt: sourceReceipt }),
          cleanupSourceCopy() {
            cleanupCalls += 1;
            throw cleanupError;
          },
          writeNotebook() {},
          runPhase: async (options) => {
            const exchanges = await runRealWarmupController(options);
            return receipt("open-wrangler", editor, fixture, kernel, sourceReceipt, exchanges);
          }
        }
      ),
      (error) =>
        error instanceof AggregateError &&
        dataWranglerComparisonCleanupMayBeUnsettled(error) &&
        error.errors.length === 1 &&
        error.errors[0] === cleanupError
    );
    assert.equal(cleanupCalls, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a safe warm-up failure attempts run-root retirement only once when retirement throws", async () => {
  const root = mkdtempSync(resolve(tmpdir(), "ow-study-warmup-root-retire-once-"));
  try {
    chmodSync(root, 0o700);
    const fixture = { id: "csv-100k-50", format: "csv", sha256: digest, rows: 100_000, columns: 50 };
    const kernel = testKernel(root);
    const journeyError = new Error("warm-up headroom failed safely");
    const retirementError = new Error("run-root retirement failed once");
    let retirementCalls = 0;
    await assert.rejects(
      runPreparedProductWarmupJourney(
        {
          product: "open-wrangler",
          runId: "15000000-0000-4000-8000-000000000000",
          runRoot: resolve(root, "clone", "public-warmup"),
          profile: { userData: "/user", extensions: "/extensions", sandboxArgs: [] },
          editor: { version: "1.109.2" },
          pythonPath: "/python",
          kernel,
          fixture,
          fixturePath: "/fixture.csv",
          driverDirectory: "/driver",
          driverVsixPath: "/driver.vsix",
          expectedDriver: {},
          expectedInventory: [],
          developmentPaths: []
        },
        {},
        {
          createEnvironment: () => ({}),
          configureTempRoot() {},
          materializeKernel: () => ({ jupyterEnvironment: kernel.jupyterEnvironment }),
          recoverDriver() {},
          readInventory: async () => [],
          requireWatchHeadroom: async () => {
            throw journeyError;
          },
          retireRunRoot() {
            retirementCalls += 1;
            throw retirementError;
          }
        }
      ),
      (error) =>
        error instanceof AggregateError &&
        dataWranglerComparisonCleanupMayBeUnsettled(error) &&
        error.errors.length === 2 &&
        error.errors[0] === journeyError &&
        error.errors[1] === retirementError
    );
    assert.equal(retirementCalls, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("source-copy cleanup uncertainty prevents the containing warm-up clone from being retired", async () => {
  const root = mkdtempSync(resolve(tmpdir(), "ow-study-warmup-source-ancestor-"));
  try {
    chmodSync(root, 0o700);
    const editor = { version: "1.109.2" };
    const fixture = { id: "csv-100k-50", format: "csv", sha256: digest, rows: 100_000, columns: 50 };
    const kernel = testKernel(root);
    const sourceReceipt = {
      sha256: digest,
      filesystemIdentity: { device: "1", inode: "2", sizeBytes: 1, mtimeNs: "3" }
    };
    const cleanupError = new Error("source-copy identity could not be confirmed");
    let cloneRetirementCalls = 0;
    let runRootRetirementCalls = 0;
    await assert.rejects(
      capturePreparedProductWarmups(
        {
          specification: {
            candidate: { extensionId: "Matt17BR.openwrangler", version: "1.2.1" },
            baseline: { extensionId: "ms-toolsai.datawrangler", version: "1.24.2" },
            fixtures: [fixture],
            provenance: { comparisonDriver: {} }
          },
          templates: [
            { product: "open-wrangler", kind: "configured-only", root: resolve(root, "configured"), sandboxArgs: [] }
          ],
          templateTrees: new Map([["open-wrangler:configured-only", digest]]),
          studyRoot: root,
          editor,
          pythonPath: "/python",
          kernel,
          fixturePath: "/fixture.csv",
          driverDirectory: "/driver",
          driverVsixPath: "/driver.vsix"
        },
        {},
        {
          id: () => "16000000-0000-4000-8000-000000000000",
          recoverDriver() {},
          cloneTemplate: (_template, { cloneRoot }) => ({
            root: privateDirectory(cloneRoot),
            userData: privateDirectory(resolve(cloneRoot, "user")),
            extensions: privateDirectory(resolve(cloneRoot, "extensions")),
            sandboxArgs: []
          }),
          retireClone() {
            cloneRetirementCalls += 1;
            return { status: "retired", treeEmpty: true };
          },
          retireRunRoot() {
            runRootRetirementCalls += 1;
            return { status: "retired", treeEmpty: true };
          },
          createEnvironment: (_environment, values) => values,
          configureTempRoot() {},
          materializeKernel({ runRoot }) {
            const jupyterRoot = privateDirectory(resolve(runRoot, "jupyter"));
            return {
              jupyterEnvironment: {
                dataDir: privateDirectory(resolve(jupyterRoot, "data")),
                runtimeDir: privateDirectory(resolve(jupyterRoot, "runtime")),
                configDir: privateDirectory(resolve(jupyterRoot, "config")),
                path: privateDirectory(resolve(jupyterRoot, "path"))
              }
            };
          },
          readInventory: async () =>
            createDataWranglerComparisonTemplateInventory({
              extensionId: "Matt17BR.openwrangler",
              version: "1.2.1"
            }),
          createSourceCopy: () => ({ copyPath: "/private/source.csv", copyReceipt: sourceReceipt }),
          cleanupSourceCopy() {
            throw cleanupError;
          },
          writeNotebook() {},
          runPhase: async (options) => {
            const exchanges = await runRealWarmupController(options);
            return receipt("open-wrangler", editor, fixture, kernel, sourceReceipt, exchanges);
          }
        }
      ),
      (error) =>
        error instanceof AggregateError &&
        dataWranglerComparisonCleanupMayBeUnsettled(error) &&
        error.errors[0] === cleanupError
    );
    assert.equal(runRootRetirementCalls, 0);
    assert.equal(cloneRetirementCalls, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("run-kernel cleanup uncertainty preserves the warm-up run root and clone", async () => {
  const root = mkdtempSync(resolve(tmpdir(), "ow-study-warmup-kernel-ancestor-"));
  try {
    chmodSync(root, 0o700);
    const fixture = { id: "csv-100k-50", format: "csv", sha256: digest, rows: 100_000, columns: 50 };
    const kernelCleanup = createDataWranglerComparisonCleanupUnsettledError(
      [new Error("run-kernel tree contains a foreign descendant")],
      "Run-kernel cleanup is unsettled."
    );
    const nestedError = new AggregateError([kernelCleanup], "Run-kernel materialization failed.");
    let cloneRetirementCalls = 0;
    let runRootRetirementCalls = 0;
    await assert.rejects(
      capturePreparedProductWarmups(
        {
          specification: {
            candidate: { extensionId: "Matt17BR.openwrangler", version: "1.2.1" },
            baseline: { extensionId: "ms-toolsai.datawrangler", version: "1.24.2" },
            fixtures: [fixture],
            provenance: { comparisonDriver: {} }
          },
          templates: [
            { product: "open-wrangler", kind: "configured-only", root: resolve(root, "configured"), sandboxArgs: [] }
          ],
          templateTrees: new Map([["open-wrangler:configured-only", digest]]),
          studyRoot: root,
          editor: { version: "1.109.2" },
          pythonPath: "/python",
          kernel: {},
          fixturePath: "/fixture.csv",
          driverDirectory: "/driver",
          driverVsixPath: "/driver.vsix"
        },
        {},
        {
          id: () => "16250000-0000-4000-8000-000000000000",
          recoverDriver() {},
          cloneTemplate: (_template, { cloneRoot }) => ({
            root: privateDirectory(cloneRoot),
            userData: privateDirectory(resolve(cloneRoot, "user")),
            extensions: privateDirectory(resolve(cloneRoot, "extensions")),
            sandboxArgs: []
          }),
          retireClone() {
            cloneRetirementCalls += 1;
            return { status: "retired", treeEmpty: true };
          },
          retireRunRoot() {
            runRootRetirementCalls += 1;
            return { status: "retired", treeEmpty: true };
          },
          createEnvironment: () => ({}),
          configureTempRoot() {},
          materializeKernel() {
            throw nestedError;
          }
        }
      ),
      (error) => error === nestedError && dataWranglerComparisonCleanupMayBeUnsettled(error)
    );
    assert.equal(runRootRetirementCalls, 0);
    assert.equal(cloneRetirementCalls, 0);
    assert.equal(
      existsSync(resolve(root, "warmup-clones", "open-wrangler-16250000-0000-4000-8000-000000000000")),
      true
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("source-copy creation rollback uncertainty preserves the warm-up run root and clone", async () => {
  const root = mkdtempSync(resolve(tmpdir(), "ow-study-warmup-create-ancestor-"));
  try {
    chmodSync(root, 0o700);
    const fixturePath = resolve(root, "fixture.csv");
    writeFileSync(fixturePath, "c00\n1\n", { flag: "wx", mode: 0o600 });
    const fixture = { id: "csv-100k-50", format: "csv", sha256: digest, rows: 100_000, columns: 50 };
    const kernel = testKernel(root);
    let cloneRetirementCalls = 0;
    let runRootRetirementCalls = 0;
    let replacementPath;
    await assert.rejects(
      capturePreparedProductWarmups(
        {
          specification: {
            candidate: { extensionId: "Matt17BR.openwrangler", version: "1.2.1" },
            baseline: { extensionId: "ms-toolsai.datawrangler", version: "1.24.2" },
            fixtures: [fixture],
            provenance: { comparisonDriver: {} }
          },
          templates: [
            { product: "open-wrangler", kind: "configured-only", root: resolve(root, "configured"), sandboxArgs: [] }
          ],
          templateTrees: new Map([["open-wrangler:configured-only", digest]]),
          studyRoot: root,
          editor: { version: "1.109.2" },
          pythonPath: "/python",
          kernel,
          fixturePath,
          driverDirectory: "/driver",
          driverVsixPath: "/driver.vsix"
        },
        {},
        {
          id: () => "16500000-0000-4000-8000-000000000000",
          recoverDriver() {},
          cloneTemplate: (_template, { cloneRoot }) => ({
            root: privateDirectory(cloneRoot),
            userData: privateDirectory(resolve(cloneRoot, "user")),
            extensions: privateDirectory(resolve(cloneRoot, "extensions")),
            sandboxArgs: []
          }),
          retireClone() {
            cloneRetirementCalls += 1;
            return { status: "retired", treeEmpty: true };
          },
          retireRunRoot() {
            runRootRetirementCalls += 1;
            return { status: "retired", treeEmpty: true };
          },
          createEnvironment: () => ({}),
          configureTempRoot() {},
          materializeKernel: () => ({ jupyterEnvironment: kernel.jupyterEnvironment }),
          readInventory: async () =>
            createDataWranglerComparisonTemplateInventory({
              extensionId: "Matt17BR.openwrangler",
              version: "1.2.1"
            }),
          createSourceCopy(options) {
            return createDataWranglerComparisonSourceCopy(options, {
              faultInjector(checkpoint) {
                if (checkpoint === "after-copy-created") throw new Error("injected source-copy creation failure");
                assert.equal(checkpoint, "before-rollback-unlink");
                replacementPath = resolve(options.privateRoot, options.name);
                unlinkSync(replacementPath);
                writeFileSync(replacementPath, "foreign replacement\n", { flag: "wx", mode: 0o600 });
                throw new Error("injected source-copy rollback failure");
              }
            });
          }
        }
      ),
      (error) => dataWranglerComparisonCleanupMayBeUnsettled(error)
    );
    assert.equal(runRootRetirementCalls, 0);
    assert.equal(cloneRetirementCalls, 0);
    assert.equal(existsSync(replacementPath), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("run-root cleanup uncertainty prevents the containing warm-up clone from being retired", async () => {
  const root = mkdtempSync(resolve(tmpdir(), "ow-study-warmup-root-ancestor-"));
  try {
    chmodSync(root, 0o700);
    const fixture = { id: "csv-100k-50", format: "csv", sha256: digest, rows: 100_000, columns: 50 };
    const kernel = testKernel(root);
    const journeyError = new Error("warm-up setup failed safely");
    const retirementError = new Error("run-root identity could not be confirmed");
    let cloneRetirementCalls = 0;
    let runRootRetirementCalls = 0;
    await assert.rejects(
      capturePreparedProductWarmups(
        {
          specification: {
            candidate: { extensionId: "Matt17BR.openwrangler", version: "1.2.1" },
            baseline: { extensionId: "ms-toolsai.datawrangler", version: "1.24.2" },
            fixtures: [fixture],
            provenance: { comparisonDriver: {} }
          },
          templates: [
            { product: "open-wrangler", kind: "configured-only", root: resolve(root, "configured"), sandboxArgs: [] }
          ],
          templateTrees: new Map([["open-wrangler:configured-only", digest]]),
          studyRoot: root,
          editor: { version: "1.109.2" },
          pythonPath: "/python",
          kernel,
          fixturePath: "/fixture.csv",
          driverDirectory: "/driver",
          driverVsixPath: "/driver.vsix"
        },
        {},
        {
          id: () => "17000000-0000-4000-8000-000000000000",
          recoverDriver() {},
          cloneTemplate: (_template, { cloneRoot }) => ({
            root: privateDirectory(cloneRoot),
            userData: privateDirectory(resolve(cloneRoot, "user")),
            extensions: privateDirectory(resolve(cloneRoot, "extensions")),
            sandboxArgs: []
          }),
          retireClone() {
            cloneRetirementCalls += 1;
            return { status: "retired", treeEmpty: true };
          },
          retireRunRoot() {
            runRootRetirementCalls += 1;
            throw retirementError;
          },
          createEnvironment: () => ({}),
          configureTempRoot() {},
          materializeKernel: () => ({ jupyterEnvironment: kernel.jupyterEnvironment }),
          readInventory: async () =>
            createDataWranglerComparisonTemplateInventory({
              extensionId: "Matt17BR.openwrangler",
              version: "1.2.1"
            }),
          requireWatchHeadroom: async () => {
            throw journeyError;
          }
        }
      ),
      (error) =>
        error instanceof AggregateError &&
        dataWranglerComparisonCleanupMayBeUnsettled(error) &&
        error.errors.length === 2 &&
        error.errors[0] === journeyError &&
        error.errors[1] === retirementError
    );
    assert.equal(runRootRetirementCalls, 1);
    assert.equal(cloneRetirementCalls, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a failed warm-up attempts clone retirement only once when retirement throws", async () => {
  const root = mkdtempSync(resolve(tmpdir(), "ow-study-warmup-retire-once-"));
  try {
    chmodSync(root, 0o700);
    const fixture = { id: "csv-100k-50", format: "csv", sha256: digest, rows: 100_000, columns: 50 };
    const kernel = testKernel(root);
    const journeyError = new Error("warm-up setup failed");
    const retirementError = new Error("clone retirement failed once");
    let retirementCalls = 0;
    await assert.rejects(
      capturePreparedProductWarmups(
        {
          specification: {
            candidate: { extensionId: "Matt17BR.openwrangler", version: "1.2.1" },
            baseline: { extensionId: "ms-toolsai.datawrangler", version: "1.24.2" },
            fixtures: [fixture],
            provenance: { comparisonDriver: {} }
          },
          templates: [
            { product: "open-wrangler", kind: "configured-only", root: resolve(root, "configured"), sandboxArgs: [] }
          ],
          templateTrees: new Map([["open-wrangler:configured-only", digest]]),
          studyRoot: root,
          editor: { version: "1.109.2" },
          pythonPath: "/python",
          kernel,
          fixturePath: "/fixture.csv",
          driverDirectory: "/driver",
          driverVsixPath: "/driver.vsix"
        },
        {},
        {
          id: () => "20000000-0000-4000-8000-000000000000",
          recoverDriver() {},
          cloneTemplate: (_template, { cloneRoot }) => ({
            root: privateDirectory(cloneRoot),
            userData: privateDirectory(resolve(cloneRoot, "user")),
            extensions: privateDirectory(resolve(cloneRoot, "extensions")),
            sandboxArgs: []
          }),
          createEnvironment: () => ({}),
          configureTempRoot() {},
          materializeKernel: () => ({ jupyterEnvironment: kernel.jupyterEnvironment }),
          readInventory: async () =>
            createDataWranglerComparisonTemplateInventory({
              extensionId: "Matt17BR.openwrangler",
              version: "1.2.1"
            }),
          requireWatchHeadroom: async () => {
            throw journeyError;
          },
          retireClone() {
            retirementCalls += 1;
            throw retirementError;
          }
        }
      ),
      (error) =>
        error instanceof AggregateError &&
        error.errors.length === 2 &&
        error.errors[0] === journeyError &&
        error.errors[1] === retirementError
    );
    assert.equal(retirementCalls, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("prepared warm-up rejects a journey that did not profile every column", async () => {
  const root = mkdtempSync(resolve(tmpdir(), "ow-study-warmup-invalid-"));
  try {
    const editor = { version: "1.109.2" };
    const fixture = { id: "csv-100k-50", format: "csv", sha256: digest, rows: 100_000, columns: 50 };
    const kernel = testKernel(root);
    const configured = ["open-wrangler", "data-wrangler"].map((product) => ({
      product,
      kind: "configured-only",
      root: resolve(root, product, "configured"),
      sandboxArgs: []
    }));
    await assert.rejects(
      capturePreparedProductWarmups(
        {
          specification: {
            candidate: { extensionId: "Matt17BR.openwrangler", version: "1.2.1" },
            baseline: { extensionId: "ms-toolsai.datawrangler", version: "1.24.2" },
            fixtures: [fixture],
            provenance: { comparisonDriver: {} }
          },
          templates: configured,
          templateTrees: new Map(configured.map((entry) => [`${entry.product}:configured-only`, digest])),
          studyRoot: root,
          editor,
          pythonPath: "/python",
          kernel,
          fixturePath: "/fixture.csv",
          driverDirectory: "/driver",
          driverVsixPath: "/driver.vsix"
        },
        {},
        {
          id: () => "00000000-0000-4000-8000-000000000000",
          recoverDriver: () => undefined,
          cloneTemplate: (template, { cloneRoot }) => {
            mkdirSync(resolve(cloneRoot, "user"), { recursive: true });
            mkdirSync(resolve(cloneRoot, "extensions"), { recursive: true });
            return {
              root: cloneRoot,
              userData: resolve(cloneRoot, "user"),
              extensions: resolve(cloneRoot, "extensions"),
              sandboxArgs: template.sandboxArgs
            };
          },
          createEnvironment: () => ({}),
          configureTempRoot: () => undefined,
          createSourceCopy: () => ({
            copyPath: "/private/source.csv",
            copyReceipt: {
              sha256: digest,
              filesystemIdentity: { device: "1", inode: "2", sizeBytes: 1, mtimeNs: "3" }
            }
          }),
          writeNotebook: () => undefined,
          runPhase: async (options) => {
            const exchanges = await runRealWarmupController(options);
            const value = receipt(
              "open-wrangler",
              editor,
              fixture,
              kernel,
              {
                sha256: digest,
                filesystemIdentity: { device: "1", inode: "2", sizeBytes: 1, mtimeNs: "3" }
              },
              exchanges
            );
            value.profiles.completedColumnCount = 49;
            return value;
          },
          readInventory: async () =>
            createDataWranglerComparisonTemplateInventory({ extensionId: "Matt17BR.openwrangler", version: "1.2.1" })
        }
      ),
      /did not complete inline preview, workbench, profiles, and cleanup exactly/u
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("prepared warm-up reports the phase failure instead of its derived controller abort", async () => {
  const root = mkdtempSync(resolve(tmpdir(), "ow-study-warmup-abort-"));
  try {
    chmodSync(root, 0o700);
    const fixture = { id: "csv-100k-50", format: "csv", sha256: digest, rows: 100_000, columns: 50 };
    const kernel = testKernel(root);
    const phaseError = new Error("editor phase failed");
    let caught;
    try {
      await capturePreparedProductWarmups(
        {
          specification: {
            candidate: { extensionId: "Matt17BR.openwrangler", version: "1.2.1" },
            baseline: { extensionId: "ms-toolsai.datawrangler", version: "1.24.2" },
            fixtures: [fixture],
            provenance: { comparisonDriver: {} }
          },
          templates: [
            { product: "open-wrangler", kind: "configured-only", root: resolve(root, "configured"), sandboxArgs: [] }
          ],
          templateTrees: new Map([["open-wrangler:configured-only", digest]]),
          studyRoot: root,
          editor: { version: "1.109.2" },
          pythonPath: "/python",
          kernel,
          fixturePath: "/fixture.csv",
          driverDirectory: "/driver",
          driverVsixPath: "/driver.vsix"
        },
        {},
        {
          id: () => "00000000-0000-4000-8000-000000000000",
          recoverDriver: () => undefined,
          cloneTemplate: (_template, { cloneRoot }) => ({
            root: privateDirectory(cloneRoot),
            userData: privateDirectory(resolve(cloneRoot, "user")),
            extensions: privateDirectory(resolve(cloneRoot, "extensions")),
            sandboxArgs: []
          }),
          createEnvironment: () => ({}),
          configureTempRoot: () => undefined,
          createSourceCopy: () => ({
            copyPath: "/private/source.csv",
            copyReceipt: {
              sha256: digest,
              filesystemIdentity: { device: "1", inode: "2", sizeBytes: 1, mtimeNs: "3" }
            }
          }),
          writeNotebook: () => undefined,
          readInventory: async () =>
            createDataWranglerComparisonTemplateInventory({
              extensionId: "Matt17BR.openwrangler",
              version: "1.2.1"
            }),
          runPhase: async () => {
            throw phaseError;
          },
          controlWarmup: ({ signal }) =>
            new Promise((_resolvePromise, reject) => {
              const rejectAbort = () => {
                const error = new Error("controller aborted after phase failure");
                error.code = "aborted";
                reject(error);
              };
              signal.addEventListener("abort", rejectAbort, { once: true });
              if (signal.aborted) rejectAbort();
            })
        }
      );
    } catch (error) {
      caught = error;
    }
    assert.equal(caught, phaseError);
    assert.equal(caught instanceof AggregateError, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an ownership-uncertain warm-up does not inspect its source copy or retire its clone", async () => {
  const root = mkdtempSync(resolve(tmpdir(), "ow-study-warmup-uncertain-"));
  try {
    chmodSync(root, 0o700);
    const fixture = { id: "csv-100k-50", format: "csv", sha256: digest, rows: 100_000, columns: 50 };
    const kernel = testKernel(root);
    const phaseError = new Error("editor ownership is uncertain");
    phaseError.details = { treeVerifiedStopped: false };
    let sourceCleanupCalls = 0;
    let runRootRetirementCalls = 0;
    let cloneRetirementCalls = 0;
    await assert.rejects(
      capturePreparedProductWarmups(
        {
          specification: {
            candidate: { extensionId: "Matt17BR.openwrangler", version: "1.2.1" },
            baseline: { extensionId: "ms-toolsai.datawrangler", version: "1.24.2" },
            fixtures: [fixture],
            provenance: { comparisonDriver: {} }
          },
          templates: [
            { product: "open-wrangler", kind: "configured-only", root: resolve(root, "configured"), sandboxArgs: [] }
          ],
          templateTrees: new Map([["open-wrangler:configured-only", digest]]),
          studyRoot: root,
          editor: { version: "1.109.2" },
          pythonPath: "/python",
          kernel,
          fixturePath: "/fixture.csv",
          driverDirectory: "/driver",
          driverVsixPath: "/driver.vsix"
        },
        {},
        {
          id: () => "00000000-0000-4000-8000-000000000000",
          recoverDriver: () => undefined,
          cloneTemplate: (_template, { cloneRoot }) => ({
            root: privateDirectory(cloneRoot),
            userData: privateDirectory(resolve(cloneRoot, "user")),
            extensions: privateDirectory(resolve(cloneRoot, "extensions")),
            sandboxArgs: []
          }),
          retireClone: () => {
            cloneRetirementCalls += 1;
            return { status: "retired", treeEmpty: true };
          },
          createEnvironment: () => ({}),
          configureTempRoot: () => undefined,
          createSourceCopy: () => ({
            copyPath: "/private/source.csv",
            copyReceipt: {
              sha256: digest,
              filesystemIdentity: { device: "1", inode: "2", sizeBytes: 1, mtimeNs: "3" }
            }
          }),
          cleanupSourceCopy: () => {
            sourceCleanupCalls += 1;
          },
          retireRunRoot: () => {
            runRootRetirementCalls += 1;
            return { status: "retired", treeEmpty: true };
          },
          writeNotebook: () => undefined,
          readInventory: async () =>
            createDataWranglerComparisonTemplateInventory({
              extensionId: "Matt17BR.openwrangler",
              version: "1.2.1"
            }),
          runPhase: async () => {
            throw phaseError;
          },
          controlWarmup: ({ signal }) =>
            new Promise((_resolvePromise, reject) => {
              const rejectAbort = () => {
                const error = new Error("controller aborted after uncertain phase failure");
                error.code = "aborted";
                reject(error);
              };
              signal.addEventListener("abort", rejectAbort, { once: true });
              if (signal.aborted) rejectAbort();
            })
        }
      ),
      (error) => error === phaseError
    );
    assert.equal(sourceCleanupCalls, 0);
    assert.equal(runRootRetirementCalls, 0);
    assert.equal(cloneRetirementCalls, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("prepared warm-up aggregates independent phase and controller failures", async () => {
  const root = mkdtempSync(resolve(tmpdir(), "ow-study-warmup-independent-"));
  try {
    chmodSync(root, 0o700);
    const fixture = { id: "csv-100k-50", format: "csv", sha256: digest, rows: 100_000, columns: 50 };
    const kernel = testKernel(root);
    await assert.rejects(
      capturePreparedProductWarmups(
        {
          specification: {
            candidate: { extensionId: "Matt17BR.openwrangler", version: "1.2.1" },
            baseline: { extensionId: "ms-toolsai.datawrangler", version: "1.24.2" },
            fixtures: [fixture],
            provenance: { comparisonDriver: {} }
          },
          templates: [
            { product: "open-wrangler", kind: "configured-only", root: resolve(root, "configured"), sandboxArgs: [] }
          ],
          templateTrees: new Map([["open-wrangler:configured-only", digest]]),
          studyRoot: root,
          editor: { version: "1.109.2" },
          pythonPath: "/python",
          kernel,
          fixturePath: "/fixture.csv",
          driverDirectory: "/driver",
          driverVsixPath: "/driver.vsix"
        },
        {},
        {
          id: () => "00000000-0000-4000-8000-000000000000",
          recoverDriver: () => undefined,
          cloneTemplate: (_template, { cloneRoot }) => ({
            root: privateDirectory(cloneRoot),
            userData: privateDirectory(resolve(cloneRoot, "user")),
            extensions: privateDirectory(resolve(cloneRoot, "extensions")),
            sandboxArgs: []
          }),
          createEnvironment: () => ({}),
          configureTempRoot: () => undefined,
          createSourceCopy: () => ({
            copyPath: "/private/source.csv",
            copyReceipt: {
              sha256: digest,
              filesystemIdentity: { device: "1", inode: "2", sizeBytes: 1, mtimeNs: "3" }
            }
          }),
          writeNotebook: () => undefined,
          readInventory: async () =>
            createDataWranglerComparisonTemplateInventory({
              extensionId: "Matt17BR.openwrangler",
              version: "1.2.1"
            }),
          runPhase: async () => {
            throw new Error("editor failed independently");
          },
          controlWarmup: async () => {
            throw new Error("controller failed independently");
          }
        }
      ),
      (error) => error instanceof AggregateError && error.errors.length === 2
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
