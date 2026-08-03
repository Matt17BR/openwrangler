import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, relative, resolve, sep } from "node:path";
import test from "node:test";
import ts from "typescript";
import {
  DATA_WRANGLER_COMPARISON_PREPARATION_PROTOCOL,
  captureDataWranglerProfileTree,
  cloneDataWranglerComparisonTemplate,
  queryDataWranglerTemplateInventory,
  retireDataWranglerComparisonTemplateClone
} from "./data-wrangler-comparison-preparation.mjs";
import { capturePreparedDataWranglerPublicUi as capturePreparedDataWranglerPublicUiImplementation } from "./data-wrangler-comparison-public-capture.mjs";
import {
  NEITHER_PRODUCT_CONTROL_RECEIPT_KIND,
  PUBLIC_UI_BASE_EXTENSION_INVENTORY,
  PUBLIC_UI_CAPABILITY_ABSENCE_WINDOW_MS,
  createExpectedPublicUiExtensionInventory
} from "./data-wrangler-public-ui-receipts.mjs";
import { digestStudyValue } from "./data-wrangler-comparison-study.mjs";
import { captureDataWranglerComparisonPreregistration } from "./data-wrangler-comparison-preregistration.mjs";
import {
  DATA_WRANGLER_COMPARISON_BASE_EXTENSIONS,
  createDataWranglerComparisonMeasuredInventory,
  createDataWranglerComparisonTemplateInventory
} from "./data-wrangler-comparison-inventory.mjs";
import {
  runPreparedDataWranglerComparisonEntry,
  runUnrecordedPreparedDataWranglerComparisonDiagnostic
} from "./run-data-wrangler-comparison-prepared.mjs";
import {
  parseDataWranglerComparisonPreparationArguments,
  prepareDataWranglerComparisonStudy,
  publishDataWranglerComparisonPreparationTransaction,
  validateDataWranglerComparisonConfiguredProfilesBootstrap
} from "./run-data-wrangler-comparison-preparation.mjs";
import {
  parseDataWranglerComparisonStudyArguments,
  runDataWranglerComparisonStudy
} from "./run-data-wrangler-comparison-study.mjs";
import {
  COMPARISON_CONFIGURED_PROFILES_PROTOCOL,
  createComparisonProductEditorPhasePlan,
  runComparisonProductEditorPhases
} from "./run-data-wrangler-comparison.mjs";

async function withDirectory(callback) {
  const directory = mkdtempSync(resolve(tmpdir(), "ow-prepared-runner-"));
  try {
    return await callback(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function capturePreparedDataWranglerPublicUi(input, environment, overrides = {}) {
  return capturePreparedDataWranglerPublicUiImplementation(input, environment, {
    requireWatchHeadroom: async () => ({ passed: true }),
    ...overrides
  });
}

function privateDirectory(path) {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  return path;
}

function isPathInside(root, path) {
  const value = relative(root, path);
  return value.length > 0 && value !== ".." && !value.startsWith(`..${sep}`) && !isAbsolute(value);
}

function minimalPreparation(root, templates) {
  const path = (name) => resolve(root, name);
  const specification = {
    preregistration: {
      protocol: "openwrangler-data-wrangler-comparison-preregistration-receipt-v3",
      sha256: "9".repeat(64),
      minimumInotifyWatchHeadroom: 256
    }
  };
  return {
    protocol: DATA_WRANGLER_COMPARISON_PREPARATION_PROTOCOL,
    preregistrationPath: path("preregistration.json"),
    preregistrationSha256: "9".repeat(64),
    specificationPath: path("specification.json"),
    specificationSha256: digestStudyValue(specification),
    specification,
    manifestPath: path("manifest.json"),
    manifestSha256: "a".repeat(64),
    studyRoot: root,
    candidate: { path: path("candidate.vsix") },
    editor: {
      installationRoot: path("editor"),
      executablePath: path("editor/code"),
      cliPath: path("editor/bin/code")
    },
    python: { path: path("python") },
    cacheController: { path: path("cache.py") },
    driver: { directory: path("driver"), vsixPath: path("driver/driver.vsix") },
    fixtures: [
      { id: "csv", format: "csv", path: path("fixture.csv") },
      { id: "parquet", format: "parquet", path: path("fixture.parquet") }
    ],
    selectedKernel: {
      path: path("jupyter/data/kernels/test/kernel.json"),
      jupyterEnvironment: {
        dataDir: path("jupyter/data"),
        runtimeDir: path("jupyter/runtime"),
        configDir: path("jupyter/config"),
        path: path("jupyter/path")
      }
    },
    templates,
    publicUiCaptures: [
      {
        kind: "capability",
        fixtureId: "csv",
        captureId: "11111111-1111-4111-8111-111111111111",
        editorSha256: "a".repeat(64),
        templateProduct: "data-wrangler",
        templateKind: "configured-only",
        templateTreeSha256: "b".repeat(64),
        phaseReceiptSha256: "c".repeat(64),
        phaseReceipt: {}
      },
      {
        kind: "capability",
        fixtureId: "parquet",
        captureId: "22222222-2222-4222-8222-222222222222",
        editorSha256: "a".repeat(64),
        templateProduct: "data-wrangler",
        templateKind: "configured-only",
        templateTreeSha256: "b".repeat(64),
        phaseReceiptSha256: "d".repeat(64),
        phaseReceipt: {}
      },
      {
        kind: "control",
        fixtureId: "csv",
        captureId: "33333333-3333-4333-8333-333333333333",
        editorSha256: "a".repeat(64),
        templateProduct: "data-wrangler",
        templateKind: "configured-only",
        templateTreeSha256: "b".repeat(64),
        phaseReceiptSha256: "e".repeat(64),
        phaseReceipt: {}
      }
    ],
    createdAtUtc: "2026-08-03T12:00:00.000Z"
  };
}

test("preparation receipt protocol accounts for its updated embedded study records", () => {
  assert.equal(DATA_WRANGLER_COMPARISON_PREPARATION_PROTOCOL, "openwrangler-data-wrangler-comparison-preparation-v3");
});

test("profile-tree receipts clone exactly and retire only their owned clone", async () => {
  await withDirectory((root) => {
    const templates = [];
    for (const product of ["open-wrangler", "data-wrangler"]) {
      for (const kind of ["configured-only", "warmed"]) {
        const templateRoot = privateDirectory(resolve(root, "templates", product, kind));
        privateDirectory(resolve(templateRoot, "user"));
        privateDirectory(resolve(templateRoot, "extensions"));
        writeFileSync(resolve(templateRoot, "user", "settings.json"), `${product}:${kind}\n`, { mode: 0o600 });
        const tree = captureDataWranglerProfileTree(templateRoot);
        templates.push({ product, kind, root: templateRoot, sandboxArgs: ["--no-sandbox"], ...tree });
      }
    }
    const preparation = minimalPreparation(root, templates);
    const cloneRoot = resolve(root, "clone");
    const clone = cloneDataWranglerComparisonTemplate(preparation, {
      product: "open-wrangler",
      kind: "warmed",
      cloneRoot
    });
    assert.equal(clone.cloneTreeSha256, templates[1].treeSha256);
    assert.equal(captureDataWranglerProfileTree(cloneRoot).treeSha256, templates[1].treeSha256);
    assert.equal(retireDataWranglerComparisonTemplateClone(clone).status, "retired");
    assert.throws(() => captureDataWranglerProfileTree(cloneRoot), /no such file|ENOENT/iu);
  });
});

test("profile-tree receipts reject links and detect a changed template before cloning", async () => {
  await withDirectory((root) => {
    const templateRoot = privateDirectory(resolve(root, "template"));
    privateDirectory(resolve(templateRoot, "user"));
    privateDirectory(resolve(templateRoot, "extensions"));
    writeFileSync(resolve(templateRoot, "user", "settings.json"), "one\n", { mode: 0o600 });
    const original = captureDataWranglerProfileTree(templateRoot);
    symlinkSync(resolve(templateRoot, "user", "settings.json"), resolve(templateRoot, "user", "linked.json"));
    assert.throws(() => captureDataWranglerProfileTree(templateRoot), /linked entry/u);
    rmSync(resolve(templateRoot, "user", "linked.json"));
    writeFileSync(resolve(templateRoot, "user", "settings.json"), "two\n");
    const templates = [
      ...["open-wrangler", "data-wrangler"].flatMap((product) =>
        ["configured-only", "warmed"].map((kind) => ({
          product,
          kind,
          root: templateRoot,
          sandboxArgs: [],
          ...original
        }))
      )
    ];
    assert.throws(
      () =>
        cloneDataWranglerComparisonTemplate(minimalPreparation(root, templates), {
          product: "open-wrangler",
          kind: "warmed",
          cloneRoot: resolve(root, "clone")
        }),
      /changed before cloning/u
    );
  });
});

test("template inventory queries run against a disposable clone and always remove it", async () => {
  await withDirectory(async (root) => {
    const templateRoot = privateDirectory(resolve(root, "template"));
    privateDirectory(resolve(templateRoot, "user"));
    privateDirectory(resolve(templateRoot, "extensions"));
    writeFileSync(resolve(templateRoot, "user", "settings.json"), "{}\n", { mode: 0o600 });
    const template = {
      product: "open-wrangler",
      kind: "configured-only",
      root: templateRoot,
      sandboxArgs: ["--no-sandbox"]
    };
    let scratchRoot;
    const result = await queryDataWranglerTemplateInventory(
      template,
      { cli: "/editor/code" },
      {},
      {
        async runCli({ args }) {
          const userIndex = args.indexOf("--user-data-dir");
          const extensionsIndex = args.indexOf("--extensions-dir");
          scratchRoot = resolve(args[userIndex + 1], "..");
          assert.notEqual(scratchRoot, templateRoot);
          assert.equal(resolve(args[extensionsIndex + 1], ".."), scratchRoot);
          assert.equal(existsSync(resolve(scratchRoot, "user", "settings.json")), true);
          return { stdout: "Matt17BR.openwrangler@1.2.1\n" };
        }
      }
    );
    assert.deepEqual(result, [{ extensionId: "Matt17BR.openwrangler", version: "1.2.1" }]);
    assert.equal(existsSync(scratchRoot), false);
    assert.equal(existsSync(resolve(templateRoot, "user", "settings.json")), true);

    let failedScratchRoot;
    await assert.rejects(
      queryDataWranglerTemplateInventory(
        template,
        { cli: "/editor/code" },
        {},
        {
          async runCli({ args }) {
            failedScratchRoot = resolve(args[args.indexOf("--user-data-dir") + 1], "..");
            throw new Error("CLI failed");
          }
        }
      ),
      /CLI failed/u
    );
    assert.equal(existsSync(failedScratchRoot), false);
  });
});

test("watch headroom failure prevents public capture actions and editor phases", async () => {
  await withDirectory(async (root) => {
    const editor = { version: "1.130.0" };
    const fixtures = [
      {
        id: "csv-100k-50",
        format: "csv",
        rows: 100_000,
        columns: 50,
        sha256: "b".repeat(64),
        schema: [{ name: "c00", dtype: "int64" }],
        sentinels: [{ rowIndex: 0, column: "c00", value: 0 }]
      },
      {
        id: "parquet-1m-20",
        format: "parquet",
        rows: 1_000_000,
        columns: 20,
        sha256: "c".repeat(64),
        schema: [{ name: "c00", dtype: "int64" }],
        sentinels: [{ rowIndex: 0, column: "c00", value: 0 }]
      }
    ];
    const templateRoot = privateDirectory(resolve(root, "template"));
    privateDirectory(resolve(templateRoot, "user"));
    privateDirectory(resolve(templateRoot, "extensions"));
    const events = [];
    await assert.rejects(
      capturePreparedDataWranglerPublicUi(
        {
          specification: {
            editor: {
              id: "Microsoft.VisualStudioCode",
              version: editor.version,
              sha256: "a".repeat(64),
              uiLocale: "en"
            },
            fixtures,
            provenance: {
              commonExtensions: PUBLIC_UI_BASE_EXTENSION_INVENTORY,
              comparisonDriver: {}
            }
          },
          templates: [
            {
              product: "data-wrangler",
              kind: "configured-only",
              root: templateRoot,
              editor,
              sandboxArgs: []
            }
          ],
          templateTrees: new Map([["data-wrangler:configured-only", "d".repeat(64)]]),
          studyRoot: root,
          editor,
          pythonPath: resolve(root, "python"),
          kernel: {
            name: "dataframe-comparison-study-test",
            displayName: "Study kernel",
            jupyterEnvironment: {}
          },
          fixturePaths: { csv: resolve(root, "fixture.csv"), parquet: resolve(root, "fixture.parquet") },
          driverDirectory: resolve(root, "driver"),
          driverVsixPath: resolve(root, "driver.vsix")
        },
        {},
        {
          id: () => "11111111-1111-4111-8111-111111111111",
          recoverDriver: () => ({}),
          cloneTemplate(_template, { cloneRoot }) {
            return {
              root: privateDirectory(cloneRoot),
              userData: privateDirectory(resolve(cloneRoot, "user")),
              extensions: privateDirectory(resolve(cloneRoot, "extensions")),
              sandboxArgs: []
            };
          },
          createEnvironment: () => ({}),
          configureTempRoot: () => undefined,
          createProfile: (value) => value,
          materializeKernel: () => ({ jupyterEnvironment: {} }),
          createSourceCopy: () => ({
            copyPath: resolve(root, "source-copy"),
            copyReceipt: {
              sha256: fixtures[0].sha256,
              filesystemIdentity: { device: "1", inode: "2", sizeBytes: 1, mtimeNs: "3" }
            }
          }),
          cleanupSourceCopy: () => undefined,
          writeNotebook: () => undefined,
          requireWatchHeadroom: async () => {
            events.push("watch-headroom");
            throw new Error("public capture watch headroom unavailable");
          },
          runNeutralPhase: async () => {
            events.push("public-action");
          },
          runEditorPhase: async () => {
            events.push("editor-phase");
          }
        }
      ),
      /public capture watch headroom unavailable/u
    );
    assert.deepEqual(events, ["watch-headroom"]);
  });
});

test("preparation captures real capability and control receipts from isolated disposable profiles", async () => {
  await withDirectory(async (root) => {
    const editor = {
      name: "VS Code",
      key: "vscode",
      executable: resolve(root, "code"),
      cli: resolve(root, "cli"),
      sharedDataDir: true,
      version: "1.130.0"
    };
    const publicEditor = {
      id: "Microsoft.VisualStudioCode",
      version: editor.version,
      sha256: "a".repeat(64),
      uiLocale: "en"
    };
    const fixtures = [
      {
        id: "csv-100k-50",
        format: "csv",
        rows: 100_000,
        columns: 50,
        sha256: "b".repeat(64),
        schema: Array.from({ length: 50 }, (_entry, index) => ({
          name: `c${String(index).padStart(2, "0")}`,
          dtype: "int64"
        })),
        sentinels: [{ rowIndex: 0, column: "c00", value: 0 }]
      },
      {
        id: "parquet-1m-20",
        format: "parquet",
        rows: 1_000_000,
        columns: 20,
        sha256: "c".repeat(64),
        schema: Array.from({ length: 20 }, (_entry, index) => ({
          name: `c${String(index).padStart(2, "0")}`,
          dtype: "int64"
        })),
        sentinels: [{ rowIndex: 0, column: "c00", value: 0 }]
      }
    ];
    const specification = {
      editor: publicEditor,
      fixtures,
      provenance: {
        commonExtensions: PUBLIC_UI_BASE_EXTENSION_INVENTORY,
        comparisonDriver: { exact: "driver" }
      }
    };
    const templateRoot = privateDirectory(resolve(root, "template"));
    privateDirectory(resolve(templateRoot, "user"));
    privateDirectory(resolve(templateRoot, "extensions"));
    const templateTreeSha256 = "d".repeat(64);
    const captureIds = [
      "11111111-1111-4111-8111-111111111111",
      "22222222-2222-4222-8222-222222222222",
      "33333333-3333-4333-8333-333333333333"
    ];
    const sourceReceiptForFixture = (fixture) => ({
      sha256: fixture.sha256,
      filesystemIdentity: {
        device: "8",
        inode: fixture.format === "csv" ? "9" : "10",
        sizeBytes: 1024,
        mtimeNs: "1000000000"
      }
    });
    let captureIndex = 0;
    let controlInventoryRead = 0;
    const clones = [];
    const localKernelLayouts = [];
    const rawPhase = (kind, captureId, fixture) => {
      const sourceReceipt = sourceReceiptForFixture(fixture);
      const start = 8_000_000 + captureIndex * 100_000;
      const times =
        kind === "capability"
          ? [start, start + 250]
          : Array.from({ length: 31 }, (_entry, index) => start + index * 1_000);
      const output = { ready: true, busy: false, obstructed: false, owner: "host-jupyter" };
      const actions = (available) => [
        {
          product: "open-wrangler",
          accessibleName: "Open in Open Wrangler",
          matchCount: 0,
          pointerUsable: false
        },
        {
          product: "data-wrangler",
          accessibleName: "Open 'study_frame' in Data Wrangler",
          matchCount: available ? 1 : 0,
          pointerUsable: available
        }
      ];
      const trace = times.map((atMonotonicMs) => ({
        atMonotonicMs,
        output,
        actions: actions(kind === "capability")
      }));
      return {
        protocol: "openwrangler-data-wrangler-public-ui-capture-phase-v1",
        captureId,
        kind,
        locale: "en",
        editorVersion: editor.version,
        study: {
          engine: "polars",
          format: fixture.format,
          kind: "warm",
          fixture: { id: fixture.id, sha256: fixture.sha256, rows: fixture.rows, columns: fixture.columns },
          kernel: { name: "dataframe-comparison-study-test", displayName: "Study kernel" },
          sourceReceipt
        },
        verification: {
          phase: "before-timing",
          pythonImplementation: "CPython",
          pythonVersion: "3.12.10",
          classMatched: true,
          shapeMatched: true,
          columnsMatched: true,
          integerDtypeMatched: true,
          sentinelsMatched: true,
          objectTokenContinuous: true,
          rowDataIncluded: false,
          observedSource: {
            file: sourceReceipt,
            semanticClass: "dataframe",
            rowCount: fixture.rows,
            columnCount: fixture.columns,
            schema: structuredClone(fixture.schema),
            sentinels: structuredClone(fixture.sentinels)
          }
        },
        observation: {
          clock: "linux-monotonic",
          startedAtMonotonicMs: start,
          endedAtMonotonicMs: times.at(-1),
          absenceDeadlineAtMonotonicMs: start + PUBLIC_UI_CAPABILITY_ABSENCE_WINDOW_MS,
          maxGapMs: 1_000,
          sampleCount: trace.length
        },
        trace,
        output,
        actions: actions(kind === "capability"),
        conclusion: kind === "capability" ? "available" : "neither-product-control"
      };
    };
    const result = await capturePreparedDataWranglerPublicUi(
      {
        specification,
        templates: [
          {
            product: "data-wrangler",
            kind: "configured-only",
            root: templateRoot,
            editor,
            sandboxArgs: []
          }
        ],
        templateTrees: new Map([["data-wrangler:configured-only", templateTreeSha256]]),
        studyRoot: root,
        editor,
        pythonPath: resolve(root, "python"),
        kernel: {
          name: "dataframe-comparison-study-test",
          displayName: "Study kernel",
          jupyterEnvironment: {
            dataDir: resolve(root, "jupyter", "data"),
            runtimeDir: resolve(root, "jupyter", "runtime"),
            configDir: resolve(root, "jupyter", "config"),
            path: resolve(root, "jupyter", "path")
          }
        },
        fixturePaths: { csv: resolve(root, "fixture.csv"), parquet: resolve(root, "fixture.parquet") },
        driverDirectory: resolve(root, "driver"),
        driverVsixPath: resolve(root, "driver.vsix")
      },
      {},
      {
        id: () => captureIds[captureIndex++],
        recoverDriver: () => ({ authentic: "driver" }),
        cloneTemplate(_template, { cloneRoot }) {
          const clone = {
            product: "data-wrangler",
            kind: "configured-only",
            root: privateDirectory(cloneRoot),
            userData: privateDirectory(resolve(cloneRoot, "user")),
            extensions: privateDirectory(resolve(cloneRoot, "extensions")),
            sandboxArgs: [],
            templateTreeSha256,
            cloneTreeSha256: templateTreeSha256
          };
          clones.push(clone);
          return clone;
        },
        retireClone(clone) {
          rmSync(clone.root, { recursive: true, force: false });
          return { status: "retired", treeEmpty: true };
        },
        createEnvironment: () => ({}),
        configureTempRoot() {},
        createProfile(value) {
          return { ...value };
        },
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
        createSourceCopy: () => {
          const fixture = fixtures[(captureIndex - 1) % fixtures.length];
          return { copyPath: resolve(root, "source-copy"), copyReceipt: sourceReceiptForFixture(fixture) };
        },
        cleanupSourceCopy() {},
        writeNotebook() {},
        async runNeutralPhase(input) {
          const fixture = fixtures[captureIndex - 1];
          const runRoot = resolve(input.editorPhaseOptions.workspace, "..");
          localKernelLayouts.push(
            Object.values(input.editorPhaseOptions.jupyterEnvironment).every((path) => isPathInside(runRoot, path))
          );
          return {
            installedExtensions: input.expectedExtensions,
            phaseResult: rawPhase("capability", input.editorPhaseOptions.runId, fixture)
          };
        },
        async uninstallDataWrangler() {},
        async installDriver() {},
        async readInventory() {
          controlInventoryRead += 1;
          const control = createExpectedPublicUiExtensionInventory(NEITHER_PRODUCT_CONTROL_RECEIPT_KIND).entries;
          return controlInventoryRead === 1
            ? control.filter((entry) => entry.extensionId !== "openwrangler-study.notebook-comparison-driver")
            : control;
        },
        async runEditorPhase(options) {
          const runRoot = resolve(options.workspace, "..");
          localKernelLayouts.push(
            Object.values(options.jupyterEnvironment).every((path) => isPathInside(runRoot, path))
          );
          return rawPhase("control", options.runId, fixtures[0]);
        }
      }
    );
    assert.deepEqual(
      result.capabilities.map((entry) => [entry.fixtureId, entry.availability, entry.timed]),
      [
        ["csv-100k-50", "available", false],
        ["parquet-1m-20", "available", false]
      ]
    );
    assert.equal(result.controlProfile.method, "neither-product");
    assert.equal(result.bindings.length, 3);
    assert.ok(result.bindings.every((entry) => entry.templateTreeSha256 === templateTreeSha256));
    assert.equal(controlInventoryRead, 3);
    assert.deepEqual(localKernelLayouts, [true, true, true]);
    assert.ok(clones.every((clone) => !existsSync(clone.root)));
  });
});

test("public run-next derives the pending entry, clone, profile, paths, and retirement internally", async () => {
  await withDirectory(async (root) => {
    const manifest = {
      candidate: { extensionId: "Matt17BR.openwrangler", version: "1.2.1" },
      baseline: { extensionId: "ms-toolsai.datawrangler", version: "1.24.2" },
      editor: { version: "1.106.0" },
      python: {
        executableSha256: "b".repeat(64),
        environmentSha256: "f".repeat(64),
        kernel: { kernelspecSha256: "a".repeat(64) }
      },
      fixtures: [{ id: "parquet", format: "parquet" }],
      provenance: {
        commonExtensions: DATA_WRANGLER_COMPARISON_BASE_EXTENSIONS,
        templates: [
          {
            product: "open-wrangler",
            configuredOnlyReceiptSha256: "c".repeat(64),
            warmedReceiptSha256: "d".repeat(64)
          }
        ],
        comparisonDriver: { exact: "driver" },
        cpu: { affinity: [2, 3] },
        display: { mode: "headless-ozone", widthPx: 1920, heightPx: 1080, deviceScaleFactor: 1 },
        zoom: { level: 0, theme: "Default Dark Modern" },
        capabilities: []
      }
    };
    const entry = {
      id: "warm-pandas-parquet-r01-ow",
      product: "open-wrangler",
      kind: "warm",
      engine: "pandas",
      format: "parquet"
    };
    const preparation = minimalPreparation(root, []);
    preparation.manifestPath = resolve(root, "manifest.json");
    preparation.manifestSha256 = digestStudyValue(manifest);
    preparation.editor.executablePath = resolve(root, "editor", "code");
    preparation.editor.cliPath = resolve(root, "editor", "cli");
    preparation.selectedKernel.name = "test";
    preparation.selectedKernel.displayName = "Study kernel";
    const events = [];
    const result = await runPreparedDataWranglerComparisonEntry(
      {
        manifestPath: preparation.manifestPath,
        fragmentsDirectory: resolve(root, "fragments"),
        intentsDirectory: resolve(root, "intents"),
        preparationPath: resolve(root, "preparation.json")
      },
      {},
      {
        readManifest: () => manifest,
        loadFragments: () => [],
        pendingTrials: () => [entry],
        loadPreparation: () => preparation,
        revalidatePreparation: async () => preparation,
        cloneTemplate(_receipt, input) {
          events.push(["clone", input.product, input.kind]);
          const cloneRoot = privateDirectory(input.cloneRoot);
          return {
            product: input.product,
            kind: input.kind,
            root: cloneRoot,
            userData: privateDirectory(resolve(cloneRoot, "user")),
            extensions: privateDirectory(resolve(cloneRoot, "extensions")),
            sandboxArgs: [],
            templateTreeSha256: "d".repeat(64),
            cloneTreeSha256: "d".repeat(64)
          };
        },
        createEnvironment: () => ({}),
        configureTempRoot() {},
        createProfile(value) {
          events.push(["profile", value.templateKind, value.templateReceiptSha256]);
          return { authentic: "profile" };
        },
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
        recoverDriver: () => ({ authentic: "driver" }),
        async installDriver() {},
        captureDriver: () => manifest.provenance.comparisonDriver,
        capturePythonEnvironment: () => ({ stateSha256: manifest.python.environmentSha256 }),
        captureGateProvenance: () => ({ authentic: "gate" }),
        readInventory: async () =>
          createDataWranglerComparisonMeasuredInventory({
            extensionId: manifest.candidate.extensionId,
            version: manifest.candidate.version
          }),
        async recordTrial(input) {
          events.push(["record", input.preparedTrial.scheduleEntryId]);
          assert.equal(input.preparedTrial.sourcePath, preparation.fixtures[1].path);
          assert.equal(input.preparedTrial.neutralDriver.profile.authentic, "profile");
          const trialRoot = resolve(input.preparedTrial.notebookPath, "..");
          assert.ok(
            Object.values(input.preparedTrial.editorPhaseOptions.jupyterEnvironment).every((path) =>
              isPathInside(trialRoot, path)
            )
          );
          assert.notDeepEqual(
            input.preparedTrial.editorPhaseOptions.jupyterEnvironment,
            preparation.selectedKernel.jupyterEnvironment
          );
          return {
            status: "recorded",
            receipt: { sha256: "e".repeat(64) },
            output: { outcome: { status: "success" } }
          };
        },
        retireClone(clone) {
          events.push(["retire", clone.kind]);
          rmSync(clone.root, { recursive: true, force: false });
          return { status: "retired", treeEmpty: true };
        },
        mkdir: mkdirSync,
        id: () => "11111111-1111-4111-8111-111111111111"
      }
    );
    assert.equal(result.command, "run-next");
    assert.equal(result.status, "recorded");
    assert.deepEqual(events, [
      ["clone", "open-wrangler", "warmed"],
      ["profile", "warmed", "d".repeat(64)],
      ["record", entry.id],
      ["retire", "warmed"]
    ]);
  });
});

test("public run-next retains its exact clone when measured execution is uncertain", async () => {
  await withDirectory(async (root) => {
    const manifest = {
      candidate: { extensionId: "Matt17BR.openwrangler", version: "1.2.1" },
      baseline: { extensionId: "ms-toolsai.datawrangler", version: "1.24.2" },
      editor: { version: "1.106.0" },
      python: {
        executableSha256: "b".repeat(64),
        environmentSha256: "f".repeat(64),
        kernel: { kernelspecSha256: "a".repeat(64) }
      },
      fixtures: [{ id: "csv", format: "csv" }],
      provenance: {
        commonExtensions: DATA_WRANGLER_COMPARISON_BASE_EXTENSIONS,
        templates: [
          {
            product: "data-wrangler",
            configuredOnlyReceiptSha256: "c".repeat(64),
            warmedReceiptSha256: "d".repeat(64)
          }
        ],
        comparisonDriver: { exact: "driver" },
        cpu: { affinity: [2] },
        display: { mode: "headless-ozone", widthPx: 1920, heightPx: 1080, deviceScaleFactor: 1 },
        zoom: { level: 0, theme: "Default Dark Modern" },
        capabilities: []
      }
    };
    const entry = {
      id: "cold-pandas-csv-r01-dw",
      product: "data-wrangler",
      kind: "cold",
      engine: "pandas",
      format: "csv"
    };
    const preparation = minimalPreparation(root, []);
    preparation.manifestSha256 = digestStudyValue(manifest);
    let cloneRoot;
    let retired = false;
    await assert.rejects(
      runPreparedDataWranglerComparisonEntry(
        {
          manifestPath: preparation.manifestPath,
          fragmentsDirectory: resolve(root, "fragments"),
          intentsDirectory: resolve(root, "intents"),
          preparationPath: resolve(root, "preparation.json")
        },
        {},
        {
          readManifest: () => manifest,
          loadFragments: () => [],
          pendingTrials: () => [entry],
          loadPreparation: () => preparation,
          revalidatePreparation: async () => preparation,
          cloneTemplate(_receipt, input) {
            cloneRoot = privateDirectory(input.cloneRoot);
            return {
              product: input.product,
              kind: input.kind,
              root: cloneRoot,
              userData: privateDirectory(resolve(cloneRoot, "user")),
              extensions: privateDirectory(resolve(cloneRoot, "extensions")),
              sandboxArgs: [],
              templateTreeSha256: "c".repeat(64),
              cloneTreeSha256: "c".repeat(64)
            };
          },
          createEnvironment: () => ({}),
          configureTempRoot() {},
          createProfile: () => ({ authentic: "profile" }),
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
          recoverDriver: () => ({ authentic: "driver" }),
          async installDriver() {},
          captureDriver: () => manifest.provenance.comparisonDriver,
          capturePythonEnvironment: () => ({ stateSha256: manifest.python.environmentSha256 }),
          captureGateProvenance: () => ({ authentic: "gate" }),
          readInventory: async () =>
            createDataWranglerComparisonMeasuredInventory({
              extensionId: manifest.baseline.extensionId,
              version: manifest.baseline.version
            }),
          async recordTrial() {
            throw new Error("measured boundary uncertain");
          },
          retireClone() {
            retired = true;
            throw new Error("must not retire uncertain evidence");
          },
          mkdir: mkdirSync,
          id: () => "22222222-2222-4222-8222-222222222222"
        }
      ),
      /measured boundary uncertain/u
    );
    assert.equal(retired, false);
    assert.equal(existsSync(cloneRoot), true);
  });
});

test("the prepared diagnostic removes its private journal only after complete success", async () => {
  await withDirectory(async (root) => {
    const entry = { id: "warm-polars-csv-r01-dw", product: "data-wrangler", engine: "polars", format: "csv" };
    const manifest = { schedule: [entry] };
    const preparation = { studyRoot: root };
    const memorySummary = {
      memoryMetric: "maximum-observed-sampled-pss",
      samplingLimitations: {
        configuredIntervalMs: 200,
        processMeasurementsAreSequential: true,
        betweenSampleSpikesMayBeMissed: true
      },
      status: "valid",
      reasonClass: null,
      intervalMs: 200,
      missedSamples: 0,
      processCountRange: { minimum: 2, maximum: 4 },
      segments: {
        inline: {
          baselinePssBytes: 10,
          maximumObservedSampledPssBytes: 30,
          deltaPssBytes: 20,
          processCountRange: { minimum: 2, maximum: 3 },
          categories: { "editor-main": { baselinePssBytes: 8, maximumObservedSampledPssBytes: 24, deltaPssBytes: 16 } }
        }
      }
    };
    let scratchRoot;
    const result = await runUnrecordedPreparedDataWranglerComparisonDiagnostic(
      { manifestPath: resolve(root, "manifest.json"), preparationPath: resolve(root, "preparation.json") },
      {},
      {
        readManifest: () => manifest,
        loadPreparation: () => preparation,
        revalidatePreparation: async () => preparation,
        writeManifest() {},
        writePreparation() {},
        summarizeResource(fragment) {
          assert.equal(existsSync(scratchRoot), true);
          assert.equal(fragment.outcome.status, "success");
          return memorySummary;
        },
        async runEntry(options) {
          scratchRoot = resolve(options.manifestPath, "..");
          assert.equal(options.retireOnlyAfterSuccessfulTrial, true);
          return {
            status: "recorded",
            receipt: null,
            cleanup: { status: "retired", treeEmpty: true },
            output: {
              outcome: { status: "success", actionStarted: true },
              resourceObservation: {
                valid: true,
                intervalMs: 200,
                missedSamples: 0,
                samples: [10, 20, 30, 40, 50].map((totalPssBytes) => ({ totalPssBytes }))
              },
              engineEvidence: {
                sourceEngine: "polars",
                workbenchEngine: "pandas",
                workbenchVerification: "public-ui-label"
              },
              cleanupProof: { status: "complete", treeEmpty: true },
              sourceCopy: { cleanup: { removed: true } },
              trialProvenance: { revalidatedAfterCleanup: true }
            }
          };
        }
      }
    );
    assert.equal(existsSync(scratchRoot), false);
    assert.equal(result.cleanupVerified, true);
    assert.equal(result.maximumObservedSampledPssBytes, 50);
    assert.deepEqual(result.resourceSummary, { valid: true, sampleCount: 5, ...memorySummary });
    assert.deepEqual(result.dataWranglerBackend, {
      sourceEngine: "polars",
      workbenchEngine: "pandas",
      workbenchVerification: "public-ui-label"
    });
    assert.equal(result.retainedFailureJournal, false);
  });
});

test("an incomplete prepared diagnostic retains its private journal without exposing its path", async () => {
  await withDirectory(async (root) => {
    const entry = { id: "warm-pandas-parquet-r01-ow", product: "open-wrangler", engine: "pandas", format: "parquet" };
    const manifest = { schedule: [entry] };
    let scratchRoot;
    const result = await runUnrecordedPreparedDataWranglerComparisonDiagnostic(
      { manifestPath: resolve(root, "manifest.json"), preparationPath: resolve(root, "preparation.json") },
      {},
      {
        readManifest: () => manifest,
        loadPreparation: () => ({ studyRoot: root }),
        revalidatePreparation: async () => {},
        writeManifest() {},
        writePreparation() {},
        summarizeResource: () => ({
          status: "valid",
          reasonClass: null,
          intervalMs: 200,
          missedSamples: 0,
          processCountRange: { minimum: 1, maximum: 1 },
          segments: null
        }),
        async runEntry(options) {
          scratchRoot = resolve(options.manifestPath, "..");
          return {
            status: "recorded",
            receipt: null,
            cleanup: null,
            output: {
              outcome: { status: "product-failure", actionStarted: true },
              resourceObservation: {
                valid: true,
                intervalMs: 200,
                missedSamples: 0,
                samples: [{ totalPssBytes: 10 }]
              },
              cleanupProof: { status: "complete", treeEmpty: true },
              sourceCopy: { cleanup: { removed: true } },
              trialProvenance: { revalidatedAfterCleanup: true }
            }
          };
        }
      }
    );
    assert.equal(existsSync(scratchRoot), true);
    assert.equal(result.cleanupVerified, false);
    assert.equal(result.retainedFailureJournal.retained, true);
    assert.equal(JSON.stringify(result).includes(scratchRoot), false);
    assert.equal(result.dataWranglerBackend, "not-applicable");
  });
});

test("a diagnostic retains its journal if full memory summarization fails", async () => {
  await withDirectory(async (root) => {
    const entry = { id: "warm-pandas-csv-r01-ow", product: "open-wrangler", engine: "pandas", format: "csv" };
    const manifest = { schedule: [entry] };
    let scratchRoot;
    await assert.rejects(
      runUnrecordedPreparedDataWranglerComparisonDiagnostic(
        { manifestPath: resolve(root, "manifest.json"), preparationPath: resolve(root, "preparation.json") },
        {},
        {
          readManifest: () => manifest,
          loadPreparation: () => ({ studyRoot: root }),
          revalidatePreparation: async () => {},
          writeManifest() {},
          writePreparation() {},
          summarizeResource() {
            throw new Error("memory summary rejected");
          },
          async runEntry(options) {
            scratchRoot = resolve(options.manifestPath, "..");
            return {
              cleanup: { treeEmpty: true },
              output: {
                outcome: { status: "success", actionStarted: true },
                resourceObservation: {
                  valid: true,
                  intervalMs: 200,
                  missedSamples: 0,
                  samples: [1, 2, 3, 4, 5].map((totalPssBytes) => ({ totalPssBytes }))
                },
                cleanupProof: { status: "complete", treeEmpty: true },
                sourceCopy: { cleanup: { removed: true } },
                trialProvenance: { revalidatedAfterCleanup: true }
              }
            };
          }
        }
      ),
      /memory summary rejected/u
    );
    assert.equal(existsSync(scratchRoot), true);
  });
});

test("study CLI exposes run-next while the synchronous library API refuses to fake it", () => {
  assert.deepEqual(
    parseDataWranglerComparisonStudyArguments(
      [
        "run-next",
        "--manifest",
        "manifest.json",
        "--fragments",
        "fragments",
        "--intents",
        "intents",
        "--preparation",
        "preparation.json"
      ],
      "/study"
    ),
    {
      command: "run-next",
      manifest: "/study/manifest.json",
      fragments: "/study/fragments",
      intents: "/study/intents",
      preparation: "/study/preparation.json"
    }
  );
  assert.throws(
    () =>
      runDataWranglerComparisonStudy(
        [
          "run-next",
          "--manifest",
          "manifest.json",
          "--fragments",
          "fragments",
          "--intents",
          "intents",
          "--preparation",
          "preparation.json"
        ],
        { cwd: "/study" }
      ),
    /asynchronous/u
  );
});

test("preparation CLI requires every path that it audits or publishes", () => {
  const flags = [
    "--preregistration",
    "preregistration.json",
    "--candidate",
    "openwrangler.vsix",
    "--python",
    "python",
    "--cache-controller",
    "cache.py",
    "--csv",
    "fixture.csv",
    "--parquet",
    "fixture.parquet",
    "--specification",
    "specification.json",
    "--manifest",
    "manifest.json",
    "--preparation",
    "preparation.json",
    "--cpu-list",
    "2-5"
  ];
  const parsed = parseDataWranglerComparisonPreparationArguments(flags, "/study");
  assert.equal(parsed.candidate, "/study/openwrangler.vsix");
  assert.equal(parsed.cpuList, "2-5");
  assert.throws(() => parseDataWranglerComparisonPreparationArguments(flags.slice(0, -2), "/study"), /Usage/u);
});

test("preparation rejects malformed configured-profile bootstrap trust bindings", async () => {
  await withDirectory(async (root) => {
    const studyRoot = privateDirectory(resolve(root, "study"));
    const editorRoot = privateDirectory(resolve(studyRoot, "vscode"));
    const editor = {
      name: "VS Code",
      key: "vscode",
      executable: resolve(editorRoot, "code"),
      cli: resolve(editorRoot, "bin", "code"),
      sharedDataDir: true,
      version: "1.130.0"
    };
    const profiles = ["open-wrangler", "data-wrangler"].map((product) => {
      const privateRoot = privateDirectory(resolve(studyRoot, `profile-${product}`));
      privateDirectory(resolve(privateRoot, "user"));
      privateDirectory(resolve(privateRoot, "extensions"));
      return {
        product,
        kind: "configured-only",
        privateRoot,
        userData: resolve(privateRoot, "user"),
        extensions: resolve(privateRoot, "extensions"),
        editor,
        sandboxArgs: ["--no-sandbox"],
        installedExtensions: [],
        configuredPythonProcessObservedDuringSetup: true
      };
    });
    const candidateSha256 = "d".repeat(64);
    const valid = {
      protocol: COMPARISON_CONFIGURED_PROFILES_PROTOCOL,
      candidateSha256,
      studyRoot,
      editor,
      profiles
    };
    assert.equal(validateDataWranglerComparisonConfiguredProfilesBootstrap(valid, candidateSha256), valid);

    const malformed = [
      (value) => {
        value.protocol = "wrong-protocol";
      },
      (value) => {
        value.candidateSha256 = "e".repeat(64);
      },
      (value) => {
        value.studyRoot = "relative-study-root";
      },
      (value) => {
        value.profiles[1].editor = { ...value.profiles[1].editor, version: "1.131.0" };
      },
      (value) => {
        value.profiles.pop();
      },
      (value) => {
        value.profiles[1].product = "open-wrangler";
      },
      (value) => {
        value.profiles[0].kind = "warmed";
      },
      (value) => {
        value.profiles[0].configuredPythonProcessObservedDuringSetup = false;
      },
      (value) => {
        value.profiles[0].privateRoot = resolve(root, "outside-study");
      }
    ];
    for (const corrupt of malformed) {
      const value = structuredClone(valid);
      corrupt(value);
      assert.throws(
        () => validateDataWranglerComparisonConfiguredProfilesBootstrap(value, candidateSha256),
        /malformed or mis-correlated/u
      );
    }
  });
});

test("preparation rejects the wrong Python cache controller before packaging or editor work", async () => {
  const expectedSha256 = "a".repeat(64);
  const preregistration = {
    toolRecipes: {
      cacheHarnessSha256: expectedSha256,
      cachePythonControllerSha256: expectedSha256
    }
  };
  let packageCalls = 0;
  let bootstrapCalls = 0;
  await assert.rejects(
    prepareDataWranglerComparisonStudy(
      {
        preregistration: "/study/preregistration.json",
        candidate: "/study/openwrangler.vsix",
        python: "/study/python",
        cacheController: "/study/source_cache_control.py",
        csv: "/study/fixture.csv",
        parquet: "/study/fixture.parquet",
        specification: "/study/specification.json",
        manifest: "/study/manifest.json",
        preparation: "/study/preparation.json",
        cpuList: "2-5"
      },
      {},
      {
        readPreregistration: () => preregistration,
        assertCurrentPreregistration: () => preregistration,
        captureFile(_path, label) {
          return {
            sha256: label.includes("JavaScript harness") ? expectedSha256 : "b".repeat(64)
          };
        },
        async packageDriver() {
          packageCalls += 1;
        },
        async bootstrapConfiguredProfiles() {
          bootstrapCalls += 1;
        }
      }
    ),
    /Python controller changed after preregistration/u
  );
  assert.equal(packageCalls, 0);
  assert.equal(bootstrapCalls, 0);
});

test("preparation publication resumes from its exact journal after every boundary crash", async (t) => {
  const preregistration = { studyId: "11111111-1111-4111-8111-111111111111" };
  const specification = { studyId: preregistration.studyId, prepared: true };
  const manifest = { authorized: true };
  const options = {
    preregistration: "/study/preregistration.json",
    specification: "/study/specification.json",
    manifest: "/study/manifest.json",
    preparation: "/study/preparation.json",
    cacheController: "/study/source_cache_control.py",
    python: "/study/python"
  };
  const receipt = {
    preregistrationPath: options.preregistration,
    preregistrationSha256: digestStudyValue(preregistration),
    specificationPath: options.specification,
    specificationSha256: digestStudyValue(specification),
    specification,
    manifestPath: options.manifest,
    manifestSha256: digestStudyValue(manifest)
  };

  for (const crashBoundary of ["preparation", "specification", "manifest"]) {
    await t.test(crashBoundary, async () => {
      const publications = new Map();
      const events = [];
      let injected = false;
      const publish = (kind, path, value) => {
        events.push(kind);
        const canonical = JSON.stringify(value);
        if (publications.has(path)) {
          assert.equal(publications.get(path), canonical);
          return { status: "recovered" };
        }
        publications.set(path, canonical);
        return { status: "published" };
      };
      const dependencies = {
        writeReceipt: (path, value) => publish("preparation", path, value),
        writeStudySpecification: (path, value) => publish("specification", path, value),
        plan() {
          publish("manifest", options.manifest, manifest);
          return { output: manifest, receipt: { status: "published" } };
        },
        publicationBoundary(boundary) {
          if (!injected && boundary === crashBoundary) {
            injected = true;
            throw new Error(`crash after ${boundary}`);
          }
        }
      };
      await assert.rejects(
        publishDataWranglerComparisonPreparationTransaction({ options, preregistration, receipt }, dependencies),
        new RegExp(`crash after ${crashBoundary}`, "u")
      );
      const recovered = await publishDataWranglerComparisonPreparationTransaction(
        { options, preregistration, receipt },
        dependencies
      );
      assert.deepEqual(recovered.manifest, manifest);
      assert.deepEqual([...publications.keys()], [options.preparation, options.specification, options.manifest]);
      assert.equal(events.indexOf("preparation") < events.indexOf("specification"), true);
      assert.equal(events.indexOf("specification") < events.indexOf("manifest"), true);
    });
  }
});

test("preparation stops on inotify headroom before packaging or editor bootstrap", async () => {
  await withDirectory(async (root) => {
    const output = privateDirectory(resolve(root, "output"));
    const method = {
      protocol: "openwrangler-data-wrangler-study-method-v2",
      sha256: "c".repeat(64),
      minimumInotifyWatchHeadroom: 256
    };
    const preregistration = {
      studyId: "11111111-1111-4111-8111-111111111111",
      createdAtUtc: "2026-08-03T12:00:00.000Z",
      method,
      design: {
        candidate: { extensionId: "Matt17BR.openwrangler", version: "1.2.1" },
        baseline: { extensionId: "ms-toolsai.datawrangler", version: "1.24.2" },
        editor: { id: "Microsoft.VisualStudioCode", uiLocale: "en" },
        fixtures: [],
        environment: { display: {}, zoom: {}, commonExtensions: [] }
      },
      toolRecipes: {
        cacheHarnessSha256: "a".repeat(64),
        cachePythonControllerSha256: "a".repeat(64)
      }
    };
    let packageCalls = 0;
    let bootstrapCalls = 0;
    await assert.rejects(
      prepareDataWranglerComparisonStudy(
        {
          preregistration: resolve(root, "preregistration.json"),
          candidate: resolve(root, "candidate.vsix"),
          python: resolve(root, "python"),
          cacheController: resolve(root, "cache.py"),
          csv: resolve(root, "fixture.csv"),
          parquet: resolve(root, "fixture.parquet"),
          specification: resolve(output, "specification.json"),
          manifest: resolve(output, "manifest.json"),
          preparation: resolve(output, "preparation.json"),
          cpuList: "2-5"
        },
        {},
        {
          readPreregistration: () => preregistration,
          assertCurrentPreregistration: () => preregistration,
          captureFile: () => ({ sha256: "a".repeat(64) }),
          captureCacheToolchain: () => ({ controller: { sha256: "a".repeat(64) } }),
          pathExists: () => false,
          captureMethodology: () => method,
          requireWatchHeadroom: async ({ runRoot }) => {
            assert.equal(runRoot, output);
            const error = new Error("no watch headroom");
            error.code = "inotify-watch-headroom";
            throw error;
          },
          async packageDriver() {
            packageCalls += 1;
          },
          async bootstrapConfiguredProfiles() {
            bootstrapCalls += 1;
          }
        }
      ),
      /no watch headroom/u
    );
    assert.equal(packageCalls, 0);
    assert.equal(bootstrapCalls, 0);
  });
});

test("a retained preparation journal resumes without rebuilding private editor state", async () => {
  const preregistration = {
    studyId: "11111111-1111-4111-8111-111111111111",
    toolRecipes: {
      cacheHarnessSha256: "a".repeat(64),
      cachePythonControllerSha256: "a".repeat(64)
    }
  };
  const specification = { studyId: preregistration.studyId, prepared: true };
  const manifest = { authorized: true };
  const options = {
    preregistration: "/study/preregistration.json",
    candidate: "/study/openwrangler.vsix",
    python: "/study/python",
    cacheController: "/study/source_cache_control.py",
    csv: "/study/fixture.csv",
    parquet: "/study/fixture.parquet",
    specification: "/study/specification.json",
    manifest: "/study/manifest.json",
    preparation: "/study/preparation.json",
    cpuList: "2-5"
  };
  const receipt = {
    preregistrationPath: options.preregistration,
    preregistrationSha256: digestStudyValue(preregistration),
    specificationPath: options.specification,
    specificationSha256: digestStudyValue(specification),
    specification,
    manifestPath: options.manifest,
    manifestSha256: digestStudyValue(manifest)
  };
  let packageCalls = 0;
  let bootstrapCalls = 0;
  let revalidationCalls = 0;
  const result = await prepareDataWranglerComparisonStudy(
    options,
    {},
    {
      readPreregistration: () => preregistration,
      assertCurrentPreregistration: () => preregistration,
      captureFile: () => ({ sha256: "a".repeat(64) }),
      captureCacheToolchain: () => ({ controller: { sha256: "a".repeat(64) } }),
      pathExists: () => true,
      loadReceipt: () => receipt,
      async revalidateReceipt(value) {
        revalidationCalls += 1;
        return value;
      },
      buildManifest: () => manifest,
      writeReceipt: () => ({ status: "recovered" }),
      writeStudySpecification: () => ({ status: "published" }),
      plan: () => ({ output: manifest, receipt: { status: "published" } }),
      async packageDriver() {
        packageCalls += 1;
      },
      async bootstrapConfiguredProfiles() {
        bootstrapCalls += 1;
      }
    }
  );
  assert.deepEqual(result.manifest, manifest);
  assert.equal(revalidationCalls, 1);
  assert.equal(packageCalls, 0);
  assert.equal(bootstrapCalls, 0);
});

test("preparation derives one complete specification from the reviewed preregistration", async () => {
  await withDirectory(async (root) => {
    const sha = "a".repeat(64);
    const filesystemIdentity = {
      device: "1",
      inode: "2",
      sizeBytes: 100,
      mtimeNs: "3"
    };
    const modules = [
      {
        path: "test/extensionHost/dataWranglerComparisonNotebookTrial.js",
        sha256: "b".repeat(64)
      }
    ];
    const journeyGraph = {
      entry: modules[0].path,
      moduleCount: 1,
      totalBytes: 100,
      graphSha256: createHash("sha256").update(JSON.stringify(modules), "utf8").digest("hex"),
      modules
    };
    const executionEntries = [
      "scripts/run-data-wrangler-comparison-preparation.mjs",
      "scripts/run-data-wrangler-comparison-study-entry.mjs"
    ];
    const executionModules = executionEntries.map((path, index) => ({
      path,
      sha256: String(index + 1).repeat(64)
    }));
    const executionEdges = executionEntries.map((from) => ({
      from,
      kind: "import",
      specifier: "node:fs",
      target: "external:node:fs"
    }));
    const executionGraphValue = {
      protocol: "openwrangler-data-wrangler-comparison-execution-graph-v1",
      scope: ["scripts/", "src/shared/"],
      parser: {
        implementation: "typescript",
        version: ts.version,
        scriptKind: "JavaScript",
        scriptTarget: "Latest"
      },
      entries: executionEntries,
      moduleCount: 2,
      edgeCount: executionEdges.length,
      totalBytes: 200,
      externalSpecifiers: ["node:fs"],
      modules: executionModules,
      edges: executionEdges
    };
    const executionGraph = {
      ...executionGraphValue,
      graphSha256: digestStudyValue(executionGraphValue)
    };
    const preregistration = captureDataWranglerComparisonPreregistration(
      {
        studyId: "11111111-1111-4111-8111-111111111111",
        createdAtUtc: "2026-08-03T12:00:00.000Z",
        journeyPath: "/compiled/dataWranglerComparisonNotebookTrial.js"
      },
      {
        captureFile: () => ({ sha256: sha }),
        captureMethodology: () => ({
          protocol: "openwrangler-data-wrangler-study-method-v2",
          sha256: "c".repeat(64),
          minimumInotifyWatchHeadroom: 256
        }),
        proveJourneyGraph: () => journeyGraph,
        proveExecutionGraph: () => executionGraph
      }
    );
    const outputRoot = privateDirectory(resolve(root, "output"));
    const studyRoot = privateDirectory(resolve(root, "retained-study"));
    const editorRoot = privateDirectory(resolve(studyRoot, "vscode"));
    const editor = {
      name: "VS Code",
      key: "vscode",
      executable: resolve(editorRoot, "code"),
      cli: resolve(editorRoot, "bin", "code"),
      sharedDataDir: true,
      version: "1.130.0"
    };
    const templateSources = new Map();
    for (const product of ["open-wrangler", "data-wrangler"]) {
      const source = privateDirectory(resolve(studyRoot, `profile-${product}`));
      const userData = privateDirectory(resolve(source, "user"));
      const extensions = privateDirectory(resolve(source, "extensions"));
      writeFileSync(resolve(userData, "settings.json"), "{}\n", { mode: 0o600 });
      templateSources.set(product, { privateRoot: source, userData, extensions });
    }
    const options = {
      preregistration: resolve(root, "preregistration.json"),
      candidate: resolve(root, "openwrangler.vsix"),
      python: resolve(root, "python"),
      cacheController: resolve(root, "cache.py"),
      csv: resolve(root, "fixture.csv"),
      parquet: resolve(root, "fixture.parquet"),
      specification: resolve(outputRoot, "specification.json"),
      manifest: resolve(outputRoot, "manifest.json"),
      preparation: resolve(outputRoot, "preparation.json"),
      cpuList: "2-5"
    };
    let publishedSpecification;
    const capturedEnvironmentFixtures = [];
    const result = await prepareDataWranglerComparisonStudy(options, process.env, {
      requireWatchHeadroom: async () => ({ passed: true }),
      readPreregistration: () => preregistration,
      assertCurrentPreregistration: () => preregistration,
      packageDriver: async ({ directory, vsixPath }) => ({ directory, vsixPath }),
      createDriverStudyReceipt: () => ({
        journeyGraph,
        runtimeDependencies: {
          playwrightCore: {
            version: preregistration.driverRecipe.playwrightCore.version,
            lockIntegrity: preregistration.driverRecipe.playwrightCore.lockIntegrity
          }
        }
      }),
      captureMethodology: () => preregistration.method,
      candidateIdentity: async () => ({
        version: "1.2.1",
        receipt: { sha256: "d".repeat(64), filesystemIdentity }
      }),
      probePython: () => ({
        implementation: "CPython",
        version: "3.12.10",
        packages: [
          { name: "pandas", version: "2.3.0" },
          { name: "polars", version: "1.32.0" },
          { name: "pyarrow", version: "21.0.0" },
          { name: "jupyter_core", version: "5.8.1" },
          { name: "ipykernel", version: "6.30.0" }
        ]
      }),
      captureFile: () => ({ sha256: sha, filesystemIdentity }),
      async bootstrapConfiguredProfiles() {
        return {
          protocol: COMPARISON_CONFIGURED_PROFILES_PROTOCOL,
          candidateSha256: "d".repeat(64),
          studyRoot,
          editor,
          profiles: ["open-wrangler", "data-wrangler"].map((product) => {
            const source = templateSources.get(product);
            return {
              product,
              kind: "configured-only",
              privateRoot: source.privateRoot,
              userData: source.userData,
              extensions: source.extensions,
              editor,
              sandboxArgs: [],
              installedExtensions: [],
              configuredPythonProcessObservedDuringSetup: true
            };
          })
        };
      },
      queryInventory: async (template) =>
        createDataWranglerComparisonTemplateInventory(
          template.product === "open-wrangler"
            ? { extensionId: "Matt17BR.openwrangler", version: "1.2.1" }
            : { extensionId: "ms-toolsai.datawrangler", version: "1.24.2" }
        ),
      captureTree: () => ({ treeSha256: "e".repeat(64) }),
      validateFixtures: () => ({
        toolchain: { generatorSha256: sha, contractSha256: sha },
        fixtures: [
          { format: "csv", sha256: "f".repeat(64), filesystemIdentity },
          { format: "parquet", sha256: "0".repeat(64), filesystemIdentity }
        ]
      }),
      captureEnvironment: ({ display, fixturePath, zoom }) => {
        capturedEnvironmentFixtures.push(fixturePath);
        return {
          machine: { captured: true },
          cpu: { affinity: [2, 3, 4, 5] },
          power: { source: "ac" },
          storage: { captured: true },
          display,
          zoom
        };
      },
      captureWarmups: async () => ({
        templates: ["open-wrangler", "data-wrangler"].map((product) => ({
          product,
          kind: "warmed",
          root: resolve(studyRoot, "warm", product),
          sandboxArgs: [],
          treeSha256: "1".repeat(64)
        })),
        provenance: ["open-wrangler", "data-wrangler"].map((product) => ({
          product,
          receiptSha256: "2".repeat(64),
          receipt: { product }
        }))
      }),
      capturePublicUi: async () => ({
        capabilities: [{ captured: true }],
        controlProfile: { captured: true },
        bindings: [{ captured: true }]
      }),
      captureCacheToolchain: () => ({ controller: { sha256: sha } }),
      buildManifest: () => ({ authorized: true }),
      writeStudySpecification(path, specification) {
        assert.equal(path, options.specification);
        assert.equal(JSON.stringify(specification).includes(":null"), false);
        assert.equal(specification.preregistration.sha256.length, 64);
        assert.deepEqual(specification.provenance.cpu.affinity, [2, 3, 4, 5]);
        publishedSpecification = structuredClone(specification);
        return { status: "published", sha256: "3".repeat(64) };
      },
      plan: () => ({ output: { authorized: true }, receipt: { sha256: "4".repeat(64) } }),
      createReceipt: async ({ driverDirectory, driverVsixPath, specification, manifest }) => {
        assert.equal(driverDirectory.startsWith(outputRoot), true);
        assert.equal(driverVsixPath.startsWith(outputRoot), true);
        return {
          prepared: true,
          preregistrationPath: options.preregistration,
          preregistrationSha256: digestStudyValue(preregistration),
          specificationPath: options.specification,
          specificationSha256: digestStudyValue(specification),
          specification,
          manifestPath: options.manifest,
          manifestSha256: digestStudyValue(manifest)
        };
      },
      writeReceipt: () => ({ status: "published", sha256: "5".repeat(64) })
    });
    assert.deepEqual(result.specification, publishedSpecification);
    assert.deepEqual(capturedEnvironmentFixtures, [options.csv, options.parquet]);
    assert.equal(result.preparation.prepared, true);
  });
});

test("comparison product phase observers capture configured state before warmed state", async () => {
  const plan = createComparisonProductEditorPhasePlan({
    productKey: "data-wrangler",
    diagnosticPhase: "comparison-data-wrangler",
    diagnosticResultPath: "/private/diagnostic.json",
    firstUseSetupResultPath: "/private/setup.json",
    userData: "/private/user",
    jupyterEnvironment: {
      dataDir: "/private/jupyter/data",
      runtimeDir: "/private/jupyter/runtime",
      configDir: "/private/jupyter/config",
      path: "/private/jupyter/path"
    }
  });
  const events = [];
  const result = await runComparisonProductEditorPhases({
    phasePlan: plan,
    async runPhase(phase) {
      events.push(`run:${phase.kind}`);
      return phase.kind;
    },
    async afterPhase(phase) {
      events.push(`after:${phase.kind}`);
    }
  });
  assert.equal(result, "diagnostic");
  assert.deepEqual(events, ["run:first-use-setup", "after:first-use-setup", "run:diagnostic", "after:diagnostic"]);
});
