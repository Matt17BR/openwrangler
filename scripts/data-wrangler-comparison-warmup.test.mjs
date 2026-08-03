import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { createDataWranglerComparisonTemplateInventory } from "./data-wrangler-comparison-inventory.mjs";
import {
  DATA_WRANGLER_PUBLIC_WARMUP_BRIDGE_KINDS,
  DATA_WRANGLER_PUBLIC_WARMUP_PHASE_PROTOCOL,
  capturePreparedProductWarmups
} from "./data-wrangler-comparison-warmup.mjs";
import { createDataWranglerStudyBridgeController } from "./data-wrangler-study-control-bridge.mjs";

const digest = "a".repeat(64);

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

test("prepared warm-up drives the real request/acknowledgement controller for both measured products", async () => {
  const root = mkdtempSync(resolve(tmpdir(), "ow-study-warmup-"));
  try {
    const editor = { version: "1.109.2" };
    const fixture = { id: "csv-100k-50", format: "csv", sha256: digest, rows: 100_000, columns: 50 };
    const kernel = {
      name: "dataframe-comparison-study-private",
      displayName: "Dataframe comparison study CPython 3.12.10 (private trial)",
      jupyterEnvironment: { dataDir: "/j/data", runtimeDir: "/j/runtime", configDir: "/j/config", path: "/j/path" }
    };
    const configured = ["open-wrangler", "data-wrangler"].map((product) => ({
      product,
      kind: "configured-only",
      root: resolve(root, product, "configured"),
      sandboxArgs: ["--no-sandbox"]
    }));
    const templateTrees = new Map(configured.map((entry) => [`${entry.product}:configured-only`, digest]));
    const phases = [];
    const recovered = [];
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
    assert.ok(
      result.provenance.every(
        (entry) => entry.receipt.controlBridge.exchanges.length === DATA_WRANGLER_PUBLIC_WARMUP_BRIDGE_KINDS.length
      )
    );
    assert.equal(recovered.length, 3);
    assert.ok(result.provenance.every((entry) => entry.receipt.untimed === true));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("prepared warm-up rejects a journey that did not profile every column", async () => {
  const root = mkdtempSync(resolve(tmpdir(), "ow-study-warmup-invalid-"));
  try {
    const editor = { version: "1.109.2" };
    const fixture = { id: "csv-100k-50", format: "csv", sha256: digest, rows: 100_000, columns: 50 };
    const kernel = {
      name: "dataframe-comparison-study-private",
      displayName: "Dataframe comparison study CPython 3.12.10 (private trial)",
      jupyterEnvironment: { dataDir: "/j/data", runtimeDir: "/j/runtime", configDir: "/j/config", path: "/j/path" }
    };
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
