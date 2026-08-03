import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { DATA_WRANGLER_COMPARISON_DRIVER_INVENTORY_ENTRY } from "./data-wrangler-comparison-driver-contract.mjs";
import { digestStudyValue } from "./data-wrangler-comparison-study.mjs";
import {
  DATA_WRANGLER_COMPARISON_DIAGNOSTIC_PROTOCOL,
  createDataWranglerComparisonDiagnosticProvenance,
  parseDataWranglerComparisonDiagnosticArguments,
  runOneUnrecordedDataWranglerComparisonDiagnostic
} from "./run-data-wrangler-comparison-diagnostic.mjs";

function digest(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function identity(path) {
  const metadata = lstatSync(path, { bigint: true });
  return {
    device: metadata.dev.toString(),
    inode: metadata.ino.toString(),
    sizeBytes: Number(metadata.size),
    mtimeNs: metadata.mtimeNs.toString()
  };
}

function preparation(root) {
  return {
    protocol: DATA_WRANGLER_COMPARISON_DIAGNOSTIC_PROTOCOL,
    scheduleEntryId: "warm-pandas-parquet-r01-ow",
    candidatePath: resolve(root, "candidate.vsix"),
    sourcePath: resolve(root, "fixture.parquet"),
    editorArtifactPath: resolve(root, "code"),
    pythonExecutablePath: resolve(root, "python"),
    cacheControllerPath: resolve(root, "source-cache.py"),
    driver: {
      directory: resolve(root, "driver"),
      vsixPath: resolve(root, "notebook-comparison-driver.vsix")
    },
    profile: {
      privateRoot: root,
      userData: resolve(root, "user-data"),
      extensions: resolve(root, "extensions"),
      editor: { name: "VS Code" },
      sandboxArgs: ["--no-sandbox"],
      installLabel: "diagnostic-driver-install",
      inventoryLabel: "diagnostic-inventory"
    },
    selectedKernel: { name: "openwrangler-study-test", displayName: "Open Wrangler study CPython 3.12" },
    editorPhaseOptions: { jupyterEnvironment: { JUPYTER_PATH: resolve(root, "jupyter") } }
  };
}

function manifest(root) {
  const entry = {
    id: "warm-pandas-parquet-r01-ow",
    blockId: "warm-pandas-parquet-r01",
    kind: "warm",
    cellId: "pandas-parquet",
    engine: "pandas",
    format: "parquet",
    repetition: 1,
    product: "open-wrangler",
    orderInPair: 1,
    sequence: 0
  };
  return {
    candidate: {
      extensionId: "Matt17BR.openwrangler",
      version: "1.2.1",
      sha256: "a".repeat(64),
      filesystemIdentity: { device: "1", inode: "2", sizeBytes: 3, mtimeNs: "4" }
    },
    baseline: { extensionId: "ms-toolsai.datawrangler", version: "1.24.2" },
    editor: { id: "Microsoft.VisualStudioCode", version: "1.106.0", sha256: "b".repeat(64), uiLocale: "en" },
    python: {
      implementation: "CPython",
      version: "3.12.11",
      executableSha256: "c".repeat(64),
      environmentSha256: "d".repeat(64),
      kernel: {
        implementation: "ipykernel",
        version: "6.30.1",
        kernelspecName: "test",
        kernelspecSha256: "e".repeat(64)
      }
    },
    fixtures: [
      {
        id: "parquet-1m-20",
        format: "parquet",
        rows: 1_000_000,
        columns: 20,
        sha256: "f".repeat(64),
        filesystemIdentity: { device: "5", inode: "6", sizeBytes: 7, mtimeNs: "8" }
      }
    ],
    provenance: {
      cpu: { affinity: [0] },
      display: { mode: "headless-ozone", widthPx: 1920, heightPx: 1080, deviceScaleFactor: 1 },
      zoom: { level: 0, theme: "Default Dark Modern" },
      commonExtensions: [{ extensionId: "ms-python.python", version: "2026.8.0" }],
      comparisonDriver: { extensionId: "openwrangler-study.notebook-comparison-driver", version: "1.0.0" },
      cacheToolchain: {
        pythonExecutable: {
          implementation: "CPython",
          version: "3.12.11",
          sha256: "c".repeat(64),
          filesystemIdentity: { device: "9", inode: "10", sizeBytes: 11, mtimeNs: "12" }
        }
      },
      templates: [
        {
          product: "open-wrangler",
          configuredOnlyReceiptSha256: "1".repeat(64),
          warmedReceiptSha256: "2".repeat(64)
        }
      ]
    },
    schedule: [entry],
    testRoot: root
  };
}

test("diagnostic CLI requires exactly one manifest and prepared input", () => {
  assert.deepEqual(
    parseDataWranglerComparisonDiagnosticArguments(
      ["--manifest", "study/manifest.json", "--prepared", "study/prepared.json"],
      "/private"
    ),
    {
      manifestPath: "/private/study/manifest.json",
      preparationPath: "/private/study/prepared.json"
    }
  );
  assert.throws(() => parseDataWranglerComparisonDiagnosticArguments(["--manifest", "manifest.json"]), /--prepared/u);
  assert.throws(
    () =>
      parseDataWranglerComparisonDiagnosticArguments([
        "--manifest",
        "manifest.json",
        "--prepared",
        "prepared.json",
        "--out",
        "result.json"
      ]),
    /Usage/u
  );
});

test("one unrecorded diagnostic wires the disposable ledger to the existing measured trial and removes it", async (t) => {
  const root = mkdtempSync(resolve(tmpdir(), "ow-unrecorded-diagnostic-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(resolve(root, "user-data"), { mode: 0o700 });
  mkdirSync(resolve(root, "extensions"), { mode: 0o700 });
  const prepared = preparation(root);
  const study = manifest(root);
  const driver = { authentic: "driver" };
  const profile = { privateRoot: root, authentic: "profile" };
  const events = [];
  let scratchRoot;

  const result = await runOneUnrecordedDataWranglerComparisonDiagnostic(
    { manifestPath: resolve(root, "published-manifest.json"), preparationPath: resolve(root, "prepared.json") },
    {},
    {
      readManifest() {
        events.push("manifest-read");
        return study;
      },
      readPreparation() {
        events.push("preparation-read");
        return prepared;
      },
      createEnvironment() {
        return {};
      },
      configureTempRoot() {},
      createProfile(value) {
        assert.equal(value.templateKind, "warmed");
        assert.equal(value.templateReceiptSha256, "2".repeat(64));
        return profile;
      },
      recoverDriver(value) {
        assert.equal(value.expectedDriver, study.provenance.comparisonDriver);
        return driver;
      },
      createProvenance() {
        return {
          captureTrialProvenanceBefore() {},
          revalidateTrialProvenanceAfter() {}
        };
      },
      captureGateProvenance(value) {
        assert.deepEqual(value.cpuIds, [0]);
        return { protocol: "concrete-gate-v1" };
      },
      writeManifest(path, value) {
        events.push("scratch-manifest-written");
        assert.equal(value, study);
        writeFileSync(path, "{}", { flag: "wx" });
      },
      mkdtemp(prefix) {
        scratchRoot = mkdtempSync(prefix);
        return scratchRoot;
      },
      async recordTrial(input, options) {
        events.push("measured-trial-called");
        assert.equal(input.manifestPath, resolve(scratchRoot, "manifest.json"));
        assert.equal(input.preparedTrial.scheduleEntryId, study.schedule[0].id);
        assert.equal(input.preparedTrial.neutralDriver.receipt, driver);
        assert.equal(input.preparedTrial.neutralDriver.profile, profile);
        assert.equal(input.preparedTrial.publicSurfaceAvailability, "available");
        assert.equal(input.preparedTrial.editorPhaseOptions.requiresWorkbenchCdp, true);
        assert.equal(options.gateDependencies.environment.OPEN_WRANGLER_EDITOR_TEMP_ROOT, undefined);
        return {
          output: {
            outcome: { status: "success", actionStarted: true },
            resourceObservation: {
              valid: true,
              intervalMs: 200,
              missedSamples: 0,
              samples: [100, 120, 110, 140, 130].map((totalPssBytes) => ({ totalPssBytes }))
            },
            cleanupProof: { status: "complete", treeEmpty: true },
            sourceCopy: { cleanup: { removed: true } },
            trialProvenance: { revalidatedAfterCleanup: true }
          }
        };
      }
    }
  );

  assert.deepEqual(result, {
    protocol: DATA_WRANGLER_COMPARISON_DIAGNOSTIC_PROTOCOL,
    recorded: false,
    manifestSha256: digestStudyValue(study),
    scheduleEntryId: study.schedule[0].id,
    product: "open-wrangler",
    engine: "pandas",
    format: "parquet",
    outcome: "success",
    pssSampleCount: 5,
    memoryMetric: "maximum-observed-sampled-pss",
    maximumObservedSampledPssBytes: 140,
    samplingIntervalMs: 200,
    samplingLimitations: {
      betweenSampleSpikesMayBeMissed: true,
      processMeasurementsAreSequential: true
    },
    dataWranglerBackend: "unverified",
    cleanupVerified: true
  });
  assert.deepEqual(events, ["manifest-read", "preparation-read", "scratch-manifest-written", "measured-trial-called"]);
  assert.equal(existsSync(scratchRoot), false);
});

test("an incomplete diagnostic remains unrecorded and retains its private journal for inspection", async (t) => {
  const root = mkdtempSync(resolve(tmpdir(), "ow-unrecorded-failure-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(resolve(root, "user-data"), { mode: 0o700 });
  mkdirSync(resolve(root, "extensions"), { mode: 0o700 });
  const prepared = preparation(root);
  const study = manifest(root);
  let scratchRoot;
  await assert.rejects(
    runOneUnrecordedDataWranglerComparisonDiagnostic(
      { manifestPath: resolve(root, "manifest.json"), preparationPath: resolve(root, "prepared.json") },
      {},
      {
        readManifest: () => study,
        readPreparation: () => prepared,
        createEnvironment: () => ({}),
        configureTempRoot() {},
        createProfile: () => ({ privateRoot: root }),
        recoverDriver: () => ({}),
        createProvenance: () => ({ captureTrialProvenanceBefore() {}, revalidateTrialProvenanceAfter() {} }),
        captureGateProvenance: () => ({}),
        writeManifest(path) {
          writeFileSync(path, "{}", { flag: "wx" });
        },
        mkdtemp(prefix) {
          scratchRoot = mkdtempSync(prefix);
          return scratchRoot;
        },
        recordTrial: async () => ({
          output: {
            outcome: { status: "setup-failure", actionStarted: false },
            resourceObservation: null,
            cleanupProof: null
          }
        })
      }
    ),
    /did not complete public UI, PSS, provenance, and cleanup/u
  );
  assert.equal(existsSync(scratchRoot), true);
});

test("a caller cannot predeclare an absent public action as unsupported", async (t) => {
  const root = mkdtempSync(resolve(tmpdir(), "ow-unrecorded-undetermined-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const prepared = preparation(root);
  prepared.publicSurfaceAvailability = "unavailable";
  await assert.rejects(
    runOneUnrecordedDataWranglerComparisonDiagnostic(
      { manifestPath: resolve(root, "manifest.json"), preparationPath: resolve(root, "prepared.json") },
      {},
      { readManifest: () => manifest(root), readPreparation: () => prepared }
    ),
    /missing or unknown fields/u
  );
});

test("diagnostic provenance re-reads concrete candidate, fixture, editor, Python, inventory, and process evidence", async (t) => {
  const root = mkdtempSync(resolve(tmpdir(), "ow-unrecorded-provenance-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const prepared = preparation(root);
  for (const [path, contents] of [
    [prepared.candidatePath, "candidate"],
    [prepared.sourcePath, "fixture"],
    [prepared.editorArtifactPath, "editor"],
    [prepared.pythonExecutablePath, "python"]
  ]) {
    writeFileSync(path, contents, { mode: 0o700 });
  }
  const study = manifest(root);
  study.candidate.sha256 = digest("candidate");
  study.candidate.filesystemIdentity = identity(prepared.candidatePath);
  study.editor.sha256 = digest("editor");
  study.python.executableSha256 = digest("python");
  study.provenance.cacheToolchain.pythonExecutable.sha256 = digest("python");
  study.provenance.cacheToolchain.pythonExecutable.filesystemIdentity = identity(prepared.pythonExecutablePath);
  study.fixtures[0].sha256 = digest("fixture");
  study.fixtures[0].filesystemIdentity = identity(prepared.sourcePath);
  const driver = study.provenance.comparisonDriver;
  const sourceCopy = {
    protocol: "source-copy-v1",
    byteIdentical: true,
    mode: "0600",
    canonicalReceipt: { sha256: digest("fixture") },
    copyReceipt: { sha256: digest("fixture") }
  };
  const inventory = [
    ...study.provenance.commonExtensions,
    { extensionId: study.candidate.extensionId, version: study.candidate.version },
    DATA_WRANGLER_COMPARISON_DRIVER_INVENTORY_ENTRY
  ];
  const provenance = createDataWranglerComparisonDiagnosticProvenance({
    manifest: study,
    scheduleEntry: study.schedule[0],
    preparation: prepared,
    readInventory: async () => inventory
  });
  const before = await provenance.captureTrialProvenanceBefore({
    manifest: study,
    scheduleEntry: study.schedule[0],
    sourceCopy,
    driverBefore: driver
  });
  const result = await provenance.revalidateTrialProvenanceAfter({
    provenanceBefore: before,
    cleanupProof: { status: "complete", treeEmpty: true },
    sourceCopy,
    driverBefore: driver,
    driverAfter: driver,
    rawEvidence: {
      processProofs: {
        editorRoot: { pid: 100, startTimeTicks: "1000" },
        configuredKernel: { pid: 101, startTimeTicks: "1001", kernelIdSha256: "9".repeat(64) }
      }
    }
  });
  assert.deepEqual(result.editorProcess, { pid: 100, startTimeTicks: "1000" });
  assert.deepEqual(result.kernelProcess, {
    pid: 101,
    startTimeTicks: "1001",
    kernelIdSha256: "9".repeat(64)
  });
  assert.equal(result.revalidatedAfterCleanup, true);

  writeFileSync(prepared.sourcePath, "changed fixture");
  await assert.rejects(
    provenance.revalidateTrialProvenanceAfter({
      provenanceBefore: before,
      cleanupProof: { status: "complete", treeEmpty: true },
      sourceCopy,
      driverBefore: driver,
      driverAfter: driver,
      rawEvidence: { processProofs: { editorRoot: { pid: 100, startTimeTicks: "1000" }, configuredKernel: null } }
    }),
    /fixture does not match the manifest/u
  );
});
