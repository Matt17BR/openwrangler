import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import {
  DATA_WRANGLER_COMPARISON_PREPARATION_PROTOCOL,
  captureDataWranglerProfileTree,
  cloneDataWranglerComparisonTemplate,
  queryDataWranglerTemplateInventory,
  retireDataWranglerComparisonTemplateClone
} from "./data-wrangler-comparison-preparation.mjs";
import { capturePreparedDataWranglerPublicUi } from "./data-wrangler-comparison-public-capture.mjs";
import {
  NEITHER_PRODUCT_CONTROL_RECEIPT_KIND,
  PUBLIC_UI_BASE_EXTENSION_INVENTORY,
  PUBLIC_UI_CAPABILITY_ABSENCE_WINDOW_MS,
  createExpectedPublicUiExtensionInventory
} from "./data-wrangler-public-ui-receipts.mjs";
import { digestStudyValue } from "./data-wrangler-comparison-study.mjs";
import {
  DATA_WRANGLER_COMPARISON_BASE_EXTENSIONS,
  createDataWranglerComparisonMeasuredInventory
} from "./data-wrangler-comparison-inventory.mjs";
import {
  runPreparedDataWranglerComparisonEntry,
  runUnrecordedPreparedDataWranglerComparisonDiagnostic
} from "./run-data-wrangler-comparison-prepared.mjs";
import { parseDataWranglerComparisonPreparationArguments } from "./run-data-wrangler-comparison-preparation.mjs";
import {
  parseDataWranglerComparisonStudyArguments,
  runDataWranglerComparisonStudy
} from "./run-data-wrangler-comparison-study.mjs";
import {
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

function privateDirectory(path) {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  return path;
}

function minimalPreparation(root, templates) {
  const path = (name) => resolve(root, name);
  return {
    protocol: DATA_WRANGLER_COMPARISON_PREPARATION_PROTOCOL,
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
        createSourceCopy: () => {
          const fixture = fixtures[(captureIndex - 1) % fixtures.length];
          return { copyPath: resolve(root, "source-copy"), copyReceipt: sourceReceiptForFixture(fixture) };
        },
        cleanupSourceCopy() {},
        writeNotebook() {},
        async runNeutralPhase(input) {
          const fixture = fixtures[captureIndex - 1];
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
    assert.ok(clones.every((clone) => !existsSync(clone.root)));
  });
});

test("public run-next derives the pending entry, clone, profile, paths, and retirement internally", async () => {
  await withDirectory(async (root) => {
    const manifest = {
      candidate: { extensionId: "Matt17BR.openwrangler", version: "1.2.1" },
      baseline: { extensionId: "ms-toolsai.datawrangler", version: "1.24.2" },
      editor: { version: "1.106.0" },
      python: { executableSha256: "b".repeat(64), environmentSha256: "f".repeat(64) },
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
      python: { executableSha256: "b".repeat(64), environmentSha256: "f".repeat(64) },
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
    "--spec",
    "spec.json",
    "--candidate",
    "openwrangler.vsix",
    "--python",
    "python",
    "--cache-controller",
    "cache.py",
    "--driver-directory",
    "driver",
    "--driver-vsix",
    "driver.vsix",
    "--csv",
    "fixture.csv",
    "--parquet",
    "fixture.parquet",
    "--manifest",
    "manifest.json",
    "--preparation",
    "preparation.json",
    "--smoke-report",
    "smoke.json"
  ];
  const parsed = parseDataWranglerComparisonPreparationArguments(flags, "/study");
  assert.equal(parsed.candidate, "/study/openwrangler.vsix");
  assert.equal(parsed.smokeReport, "/study/smoke.json");
  assert.throws(() => parseDataWranglerComparisonPreparationArguments(flags.slice(0, -2), "/study"), /Usage/u);
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
