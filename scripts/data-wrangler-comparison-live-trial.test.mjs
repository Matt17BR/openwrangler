import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test, { after } from "node:test";
import { dataWranglerComparisonCleanupMayBeUnsettled } from "./data-wrangler-comparison-cleanup-safety.mjs";
import {
  collectDataWranglerComparisonCleanupProof,
  completeDataWranglerComparisonTrialEvidence,
  reinspectDataWranglerComparisonActionAuthorization,
  recordOnePreparedDataWranglerComparisonStudyTrial as recordOnePreparedDataWranglerComparisonStudyTrialImplementation
} from "./data-wrangler-comparison-live-trial.mjs";
import { createDataWranglerComparisonDriverProfile } from "./data-wrangler-comparison-driver.mjs";
import { DATA_WRANGLER_STUDY_SOURCE_CACHE_PROTOCOL, digestStudyValue } from "./data-wrangler-comparison-study.mjs";
import {
  DATA_WRANGLER_COMPARISON_CACHE_CONTROLLER_PROTOCOL,
  DATA_WRANGLER_COMPARISON_CACHE_TOOLCHAIN_PROTOCOL
} from "./data-wrangler-comparison-cache-controller.mjs";

const RUN_ID = "11111111-1111-4111-8111-111111111111";
const FRAGMENT_ID = "22222222-2222-4222-8222-222222222222";
const FIXTURE_SHA256 = "a".repeat(64);
const FIXTURE_IDENTITY = Object.freeze({ device: "1", inode: "2", sizeBytes: 100, mtimeNs: "3" });
const PROFILE_TEMPLATE_SHA256 = "d".repeat(64);
const PROFILE_ROOT = mkdtempSync(resolve(tmpdir(), "ow-live-trial-profile-"));
const PROFILE_USER_DATA = resolve(PROFILE_ROOT, "user-data");
const PROFILE_EXTENSIONS = resolve(PROFILE_ROOT, "extensions");
mkdirSync(PROFILE_USER_DATA, { mode: 0o700 });
mkdirSync(PROFILE_EXTENSIONS, { mode: 0o700 });
after(() => rmSync(PROFILE_ROOT, { recursive: true, force: true }));
const LIVE_TRIAL_PROFILE = createDataWranglerComparisonDriverProfile({
  product: "open-wrangler",
  privateRoot: PROFILE_ROOT,
  templateKind: "warmed",
  templateReceiptSha256: PROFILE_TEMPLATE_SHA256,
  editor: { name: "VS Code" },
  userData: PROFILE_USER_DATA,
  extensions: PROFILE_EXTENSIONS,
  sandboxArgs: [],
  environment: { OPEN_WRANGLER_EDITOR_TEMP_ROOT: PROFILE_ROOT },
  installLabel: "comparison-driver-install",
  inventoryLabel: "comparison-driver-inventory"
});
const DRIVER_RECEIPT = Object.freeze({
  extensionId: "openwrangler-study.notebook-comparison-driver",
  version: "1.0.0",
  vsix: Object.freeze({ sha256: "f".repeat(64) }),
  journeyGraph: Object.freeze({ graphSha256: "e".repeat(64) })
});
const SOURCE_COPY_CORE = Object.freeze({
  protocol: "openwrangler-data-wrangler-comparison-source-copy-v1",
  canonicalPath: "/fixtures/source.csv",
  copyPath: "/private/trial/source-copy.csv",
  mode: "0600",
  byteIdentical: true,
  canonicalReceipt: Object.freeze({ sha256: FIXTURE_SHA256, filesystemIdentity: FIXTURE_IDENTITY }),
  copyReceipt: Object.freeze({
    sha256: FIXTURE_SHA256,
    filesystemIdentity: Object.freeze({ ...FIXTURE_IDENTITY, inode: "20" })
  })
});
const SOURCE_COPY_EVIDENCE = Object.freeze({
  protocol: SOURCE_COPY_CORE.protocol,
  byteIdentical: true,
  mode: "0600",
  canonicalReceipt: SOURCE_COPY_CORE.canonicalReceipt,
  copyReceipt: SOURCE_COPY_CORE.copyReceipt,
  verifiedAfterProcessTreeEmpty: true,
  cleanup: Object.freeze({
    protocol: SOURCE_COPY_CORE.protocol,
    removed: true,
    copyReceipt: SOURCE_COPY_CORE.copyReceipt
  })
});
const CACHE_TOOLCHAIN = Object.freeze({
  protocol: DATA_WRANGLER_COMPARISON_CACHE_TOOLCHAIN_PROTOCOL,
  controller: Object.freeze({
    sha256: "7".repeat(64),
    filesystemIdentity: Object.freeze({ device: "1", inode: "30", sizeBytes: 1_000, mtimeNs: "31" })
  }),
  pythonExecutable: Object.freeze({
    implementation: "CPython",
    version: "3.12.11",
    sha256: "8".repeat(64),
    filesystemIdentity: Object.freeze({ device: "1", inode: "40", sizeBytes: 2_000, mtimeNs: "41" })
  })
});

function cacheProof(kind = "warm") {
  const totalPages = Math.ceil(SOURCE_COPY_CORE.copyReceipt.filesystemIdentity.sizeBytes / 4096);
  return {
    protocol: DATA_WRANGLER_COMPARISON_CACHE_CONTROLLER_PROTOCOL,
    toolchain: CACHE_TOOLCHAIN,
    proof: {
      protocol: DATA_WRANGLER_STUDY_SOURCE_CACHE_PROTOCOL,
      requestedState: kind === "warm" ? "resident" : "evicted",
      fdatasyncApplied: true,
      adviceAccepted: kind === "cold",
      verification: "linux-mincore",
      pageSizeBytes: 4096,
      totalPages,
      residentPagesBefore: kind === "warm" ? 0 : totalPages,
      residentPagesAfter: kind === "warm" ? totalPages : 0,
      identityStable: true,
      verified: true,
      sourceFilesystemIdentityBefore: SOURCE_COPY_CORE.copyReceipt.filesystemIdentity,
      sourceFilesystemIdentityAfter: SOURCE_COPY_CORE.copyReceipt.filesystemIdentity,
      controller: CACHE_TOOLCHAIN.controller,
      pythonExecutable: CACHE_TOOLCHAIN.pythonExecutable
    }
  };
}

function sourceCopyDependencies() {
  return {
    createSourceCopy(options) {
      assert.deepEqual(options, {
        canonicalPath: SOURCE_COPY_CORE.canonicalPath,
        privateRoot: PROFILE_ROOT,
        name: "source-copy.csv"
      });
      return SOURCE_COPY_CORE;
    },
    assertSourceCopy(value) {
      assert.equal(value, SOURCE_COPY_CORE);
      return value;
    },
    cleanupSourceCopy(value) {
      assert.equal(value, SOURCE_COPY_CORE);
      return SOURCE_COPY_EVIDENCE.cleanup;
    }
  };
}

function recordOnePreparedDataWranglerComparisonStudyTrial(value, options = {}) {
  return recordOnePreparedDataWranglerComparisonStudyTrialImplementation(value, {
    ...sourceCopyDependencies(),
    requireWatchHeadroom: async () => ({ passed: true }),
    ...options
  });
}

function input(overrides = {}) {
  return {
    manifestPath: "/private/study/manifest.json",
    fragmentsDirectory: "/private/study/fragments",
    intentsDirectory: "/private/study/intents",
    expectedProvenance: { protocol: "test-provenance-v1", comparisonDriver: DRIVER_RECEIPT },
    preparedTrial: {
      scheduleEntryId: "warm-000",
      sourcePath: SOURCE_COPY_CORE.canonicalPath,
      notebookPath: "/private/trial/study.ipynb",
      requestPath: "/private/trial/bridge/request.json",
      acknowledgementPath: "/private/trial/bridge/ack.json",
      selectedKernel: {
        name: "dataframe-comparison-study-test",
        displayName: "Dataframe comparison study CPython 3.12"
      },
      publicSurfaceAvailability: "available",
      editorPhaseOptions: {
        editor: { name: "VS Code" },
        testModule: "/private/test-module.js",
        jupyterEnvironment: {
          dataDir: `${PROFILE_ROOT}/trial/jupyter/data`,
          runtimeDir: `${PROFILE_ROOT}/trial/jupyter/runtime`,
          configDir: `${PROFILE_ROOT}/trial/jupyter/config`,
          path: `${PROFILE_ROOT}/trial/jupyter/path`
        }
      },
      supervisorOptions: { pythonExecutable: "/private/python" },
      processEvidenceOptions: { pythonExecutablePath: "/private/python" },
      samplerOptions: { procRoot: "/private/proc" },
      sourceCopy: {
        privateRoot: PROFILE_ROOT,
        name: "source-copy.csv"
      },
      sourceCache: {
        pythonExecutablePath: "/private/python",
        controlScriptPath: "/private/source-cache.py"
      },
      neutralDriver: {
        receipt: { protocol: "test-driver-receipt-v1" },
        expectedExtensions: [
          { extensionId: "openwrangler-study.notebook-comparison-driver", version: "1.0.0" },
          { extensionId: "Matt17BR.openwrangler", version: "1.2.0" }
        ],
        expectedTemplate: { kind: "warmed", receiptSha256: PROFILE_TEMPLATE_SHA256 },
        profile: LIVE_TRIAL_PROFILE
      }
    },
    ...overrides
  };
}

function context(overrides = {}) {
  const scheduleEntry = {
    id: "warm-000",
    blockId: "warm-block-000",
    effectiveBlockId: "warm-block-000~a00",
    attempt: 0,
    product: "open-wrangler",
    engine: "pandas",
    format: "csv",
    kind: "warm"
  };
  const manifest = {
    provenance: { comparisonDriver: DRIVER_RECEIPT, cacheToolchain: CACHE_TOOLCHAIN },
    fixtures: [
      {
        id: "csv-100k-50",
        format: "csv",
        rows: 100_000,
        columns: 50,
        sha256: FIXTURE_SHA256,
        filesystemIdentity: FIXTURE_IDENTITY,
        schema: [{ name: "c00", type: "signed-64-bit" }],
        sentinels: [{ rowIndex: 0, values: [0] }]
      }
    ]
  };
  return {
    manifest,
    scheduleEntry,
    executionIndex: 0,
    preparedIntent: {
      protocol: "test-intent-v1",
      stage: "prepared",
      runId: RUN_ID,
      manifestSha256: digestStudyValue(manifest),
      executionIndex: 0,
      scheduleEntryId: scheduleEntry.id,
      attempt: 0,
      effectiveBlockId: scheduleEntry.effectiveBlockId,
      product: scheduleEntry.product,
      ledgerSha256: "c".repeat(64),
      preparedAtUtc: "2026-08-02T10:59:00.000Z"
    },
    authorizeAction: () => ({ protocol: "test-authorization-v1", runId: RUN_ID }),
    reinspectActionAuthorization: () => Object.freeze({ status: "not-authorized" }),
    ...overrides
  };
}

function passedGate() {
  return { protocol: "test-gate-v1", passed: true };
}

function observedNotebookSource() {
  return {
    file: SOURCE_COPY_CORE.copyReceipt,
    semanticClass: "dataframe",
    rowCount: 100_000,
    columnCount: 50,
    schema: Array.from({ length: 50 }, (_value, index) => ({
      name: `c${String(index).padStart(2, "0")}`,
      dtype: "int64"
    })),
    sentinels: [
      { rowIndex: 0, column: "c00", value: 0 },
      { rowIndex: 1, column: "c01", value: 2 },
      { rowIndex: 99_999, column: "c49", value: 100_048 }
    ]
  };
}

function notebookPhaseReceipt() {
  const observedSource = observedNotebookSource();
  return {
    protocol: "test-notebook-v1",
    status: "success",
    study: {
      engine: "pandas",
      format: "csv",
      kind: "warm",
      fixture: { id: "csv-100k-50", sha256: FIXTURE_SHA256, rows: 100_000, columns: 50 },
      sourceReceipt: SOURCE_COPY_CORE.copyReceipt
    },
    verification: {
      before: { observedSource },
      after: { observedSource: structuredClone(observedSource) }
    }
  };
}

function rawEvidence(overrides = {}) {
  return {
    protocol: "openwrangler-data-wrangler-comparison-trial-executor-v1",
    status: "evidence",
    runId: RUN_ID,
    phase: "comparison-study-open-wrangler-trial",
    cacheState: "warm",
    product: "open-wrangler",
    trialBinding: {
      preparedIntentSha256: "d".repeat(64),
      manifestSha256: "e".repeat(64),
      executionIndex: 0,
      scheduleEntryId: "warm-000",
      baseBlockId: "warm-block-000",
      attempt: 0,
      effectiveBlockId: "warm-block-000~a00",
      product: "open-wrangler",
      engine: "pandas",
      format: "csv",
      cacheState: "warm"
    },
    actionAuthorized: true,
    authorizationAttempted: true,
    authorizationOutcome: "authorized",
    notebookPhaseReceipt: notebookPhaseReceipt(),
    controlReceipt: {
      protocol: "test-control-v1",
      status: "success",
      resourceObservation: {
        protocol: "test-resource-v1",
        retainedOwnedIdentities: [{ pid: 100, startTimeTicks: "1000" }]
      }
    },
    cacheProof: cacheProof(),
    processProofs: {
      protocol: "test-process-v1",
      editorRoot: { pid: 100, startTimeTicks: "1000" }
    },
    launchReceipt: { protocol: "test-launch-v1" },
    supervisorCompletion: {
      terminalReceipt: {
        protocol: "test-terminal-v1",
        retainedOwnedIdentities: [{ pid: 100, startTimeTicks: "1000", disposition: "exited" }]
      }
    },
    terminalEvidence: {
      cleanupProof: { protocol: "test-cleanup-v1" },
      sourceCopy: SOURCE_COPY_EVIDENCE,
      trialProvenance: { protocol: "test-trial-provenance-v1" }
    },
    outerEditorFailure: null,
    ...overrides
  };
}

function provenanceDependencies(events = []) {
  return {
    async captureTrialProvenanceBefore(value) {
      events.push("provenance-captured-before");
      assert.deepEqual(value.driverBefore, DRIVER_RECEIPT);
      assert.equal(value.sourcePath, SOURCE_COPY_CORE.copyPath);
      assert.equal(value.canonicalSourcePath, SOURCE_COPY_CORE.canonicalPath);
      assert.deepEqual(value.sourceCopy.copyReceipt, SOURCE_COPY_CORE.copyReceipt);
      return { protocol: "test-provenance-before-v1" };
    },
    async revalidateTrialProvenanceAfter(value) {
      events.push("provenance-revalidated-after");
      assert.equal(value.provenanceBefore.protocol, "test-provenance-before-v1");
      assert.deepEqual(value.driverBefore, DRIVER_RECEIPT);
      assert.deepEqual(value.driverAfter, DRIVER_RECEIPT);
      assert.equal(value.cleanupProof.status, "complete");
      assert.deepEqual(value.sourceCopy.copyReceipt, SOURCE_COPY_CORE.copyReceipt);
      return {
        protocol: "test-trial-provenance-v1",
        driverBefore: value.driverBefore,
        driverAfter: value.driverAfter,
        sourceCopyBefore: value.sourceCopy,
        sourceCopyAfter: value.sourceCopy
      };
    }
  };
}

function fakeRunNext(events, suppliedContext = context()) {
  return async (paths, options) => {
    events.push("ledger-opened");
    assert.deepEqual(paths, {
      manifestPath: "/private/study/manifest.json",
      fragmentsDirectory: "/private/study/fragments",
      intentsDirectory: "/private/study/intents"
    });
    assert.equal(options.expectedEntryId, "warm-000");
    const fragment = await options.executeTrial(suppliedContext);
    events.push("fragment-published");
    return { command: "run-next", status: "recorded", receipt: { sha256: "b".repeat(64) }, output: fragment };
  };
}

function fakeHeavyLease(events) {
  return async (label, callback) => {
    assert.equal(label, "data-wrangler-comparison-study-trial");
    events.push("heavy-lease-acquired");
    try {
      return await callback();
    } finally {
      events.push("heavy-lease-released");
    }
  };
}

function postLaunchTrialDependencies(events) {
  return {
    withHeavyLease: fakeHeavyLease(events),
    validateExecutorReceipt: acceptSyntheticExecutorReceipt,
    ...provenanceDependencies(events),
    runNext: fakeRunNext(events),
    runGate: async () => passedGate(),
    writeNotebook: (path) => ({ path, bytes: 100, mode: "0600" }),
    executorDependencies: {
      async runEditorPhase(_options, dependencies) {
        dependencies.spawnProcess();
        return { protocol: "test-editor-phase-v1" };
      }
    },
    neutralDriverDependencies: {
      captureDriverReceipt: () => DRIVER_RECEIPT,
      async installDriver() {},
      async readInventory() {
        return input().preparedTrial.neutralDriver.expectedExtensions;
      }
    },
    prepareSourceCache: () => cacheProof()
  };
}

async function launchSyntheticMeasuredPhase(executorDependencies) {
  return await executorDependencies.runEditorPhase(
    { runId: RUN_ID, phase: "comparison-study-open-wrangler-trial" },
    {
      spawnProcess: () => undefined,
      prepareWarmSourceCacheBeforeLaunch: () => executorDependencies.prepareSourceCache({ cacheState: "warm" })
    }
  );
}

const acceptSyntheticExecutorReceipt = (value) => value;

test("inotify headroom failure stops a measured trial before the quiet gate or scheduler", async () => {
  const events = [];
  await assert.rejects(
    recordOnePreparedDataWranglerComparisonStudyTrial(input(), {
      withHeavyLease: fakeHeavyLease(events),
      ...provenanceDependencies(events),
      requireWatchHeadroom: async ({ runRoot }) => {
        assert.equal(runRoot, PROFILE_ROOT);
        events.push("headroom-failed");
        const error = new Error("watch headroom unavailable");
        error.code = "inotify-watch-headroom";
        throw error;
      },
      runNext: async () => {
        events.push("ledger-opened");
      },
      runGate: async () => {
        events.push("quiet-gate-started");
      }
    }),
    /watch headroom unavailable/u
  );
  assert.deepEqual(events, ["heavy-lease-acquired", "headroom-failed", "heavy-lease-released"]);
});

test("one prepared entry gates, writes, executes, normalizes, then reaches the durable ledger", async () => {
  const events = [];
  let cleanupClock = 0;
  const normalized = { protocol: "test-fragment-v1", outcome: { actionStarted: true } };
  const result = await recordOnePreparedDataWranglerComparisonStudyTrial(input(), {
    withHeavyLease: fakeHeavyLease(events),
    validateExecutorReceipt: acceptSyntheticExecutorReceipt,
    ...provenanceDependencies(events),
    runNext: fakeRunNext(events),
    runGate: async ({ maximumWaitMs }) => {
      assert.equal(maximumWaitMs, 300_000);
      events.push("gate-passed");
      return passedGate();
    },
    writeNotebook(path, options) {
      events.push("notebook-written");
      assert.equal(path, "/private/trial/study.ipynb");
      assert.deepEqual(options.fixture, {
        id: "csv-100k-50",
        format: "csv",
        rows: 100_000,
        columns: 50,
        sha256: FIXTURE_SHA256
      });
      assert.deepEqual(options.sourceReceipt, SOURCE_COPY_CORE.copyReceipt);
      return { path, bytes: 100, mode: "0600" };
    },
    async executeTrial(executorInput, executorDependencies) {
      events.push("executor-started");
      assert.equal(executorInput.runId, RUN_ID);
      assert.equal(executorInput.editorPhaseOptions.workspace, "/private/trial/study.ipynb");
      assert.equal(executorInput.editorPhaseOptions.resultPath, "/private/trial/study.ipynb.result.json");
      assert.deepEqual(executorInput.editorPhaseOptions.comparisonStudyEnvironment, {
        requestPath: "/private/trial/bridge/request.json",
        acknowledgementPath: "/private/trial/bridge/ack.json",
        sourcePath: SOURCE_COPY_CORE.copyPath,
        publicSurfaceAvailability: "available"
      });
      assert.equal(executorInput.preparedIntent.runId, RUN_ID);
      assert.equal(executorInput.scheduleEntry.id, "warm-000");
      assert.equal(typeof executorInput.reinspectActionAuthorization, "function");
      assert.deepEqual(executorInput.reinspectActionAuthorization(), { status: "not-authorized" });
      let cache;
      const supervisorOwnedSpawn = () => undefined;
      const phaseReceipt = await executorDependencies.runEditorPhase(
        { runId: RUN_ID, phase: "comparison-study-open-wrangler-trial" },
        {
          spawnProcess: supervisorOwnedSpawn,
          async prepareWarmSourceCacheBeforeLaunch() {
            cache = await executorDependencies.prepareSourceCache({ cacheState: "warm" });
            return cache;
          }
        }
      );
      assert.deepEqual(phaseReceipt, { protocol: "test-editor-phase-v1" });
      assert.deepEqual(cache, cacheProof());
      events.push("supervisor-completed");
      const base = rawEvidence({ cacheProof: cache, terminalEvidence: null });
      const terminalEvidence = await executorDependencies.completeTerminalEvidence({
        input: executorInput,
        launchReceipt: base.launchReceipt,
        supervisorCompletion: base.supervisorCompletion,
        processProofs: base.processProofs,
        notebookPhaseReceipt: base.notebookPhaseReceipt,
        controlReceipt: base.controlReceipt,
        cacheProof: cache
      });
      return rawEvidence({ cacheProof: cache, terminalEvidence });
    },
    executorDependencies: {
      async runEditorPhase(options, dependencies) {
        events.push("editor-executed");
        assert.deepEqual(options.developmentPaths, []);
        assert.equal(typeof dependencies.spawnProcess, "function");
        assert.deepEqual(dependencies.environment, LIVE_TRIAL_PROFILE.environment);
        return { protocol: "test-editor-phase-v1" };
      }
    },
    neutralDriverDependencies: {
      captureDriverReceipt() {
        return DRIVER_RECEIPT;
      },
      async installDriver() {
        events.push("neutral-driver-installed");
      },
      async readInventory() {
        events.push("neutral-driver-inventory-read");
        return input().preparedTrial.neutralDriver.expectedExtensions;
      }
    },
    prepareSourceCache(options) {
      events.push("cache-prepared");
      assert.equal(options.cacheState, "warm");
      assert.equal(options.sourceCopy, SOURCE_COPY_CORE);
      assert.equal(options.controllerPath, "/private/source-cache.py");
      return cacheProof();
    },
    cleanupDependencies: {
      monotonicMilliseconds: () => cleanupClock,
      async wait(milliseconds) {
        cleanupClock += milliseconds;
      },
      readProcessIdentity(pid) {
        events.push("cleanup-polled");
        assert.equal(pid, 100);
        return null;
      }
    },
    normalizeTrial(value) {
      events.push("fragment-normalized");
      assert.equal(value.fragmentIdentity.fragmentId, FRAGMENT_ID);
      assert.equal(value.environmentGate.passed, true);
      assert.equal(value.sourceVerificationReceipt.fixtureSha256, FIXTURE_SHA256);
      assert.equal(value.sourceVerificationReceipt.schema.length, 50);
      assert.deepEqual(value.sourceVerificationReceipt.schema[49], { name: "c49", dtype: "int64" });
      assert.deepEqual(value.sourceVerificationReceipt.sentinelsBefore, [
        { rowIndex: 0, column: "c00", value: 0 },
        { rowIndex: 1, column: "c01", value: 2 },
        { rowIndex: 99_999, column: "c49", value: 100_048 }
      ]);
      assert.notDeepEqual(value.sourceVerificationReceipt.schema, context().manifest.fixtures[0].schema);
      assert.deepEqual(
        value.sourceVerificationReceipt.filesystemIdentityBefore,
        SOURCE_COPY_CORE.copyReceipt.filesystemIdentity
      );
      assert.equal(value.executorReceipt.supervisorCompletion.terminalReceipt.protocol, "test-terminal-v1");
      assert.equal(value.executorReceipt.terminalEvidence.cleanupProof.observations.length, 2);
      assert.equal(value.executorReceipt.terminalEvidence.trialProvenance.protocol, "test-trial-provenance-v1");
      return normalized;
    },
    fragmentIdFactory: () => FRAGMENT_ID,
    now: () => new Date("2026-08-02T11:00:00.000Z")
  });

  assert.equal(result.output, normalized);
  assert.deepEqual(events, [
    "heavy-lease-acquired",
    "ledger-opened",
    "notebook-written",
    "gate-passed",
    "executor-started",
    "neutral-driver-installed",
    "neutral-driver-inventory-read",
    "cache-prepared",
    "provenance-captured-before",
    "editor-executed",
    "neutral-driver-inventory-read",
    "supervisor-completed",
    "cleanup-polled",
    "cleanup-polled",
    "provenance-revalidated-after",
    "fragment-normalized",
    "fragment-published",
    "heavy-lease-released"
  ]);
});

test("a failed pre-action gate records only a validated launch-free fragment", async () => {
  const events = [];
  const gate = { protocol: "test-gate-v1", passed: false };
  let gateFinished = false;
  let sourceCopyCleanups = 0;
  let sourceCopyRevalidations = 0;
  let supervisorLaunches = 0;
  let validated;
  const result = await recordOnePreparedDataWranglerComparisonStudyTrial(input(), {
    withHeavyLease: fakeHeavyLease(events),
    validateExecutorReceipt: acceptSyntheticExecutorReceipt,
    ...provenanceDependencies(),
    runNext: fakeRunNext(events),
    runGate: async () => {
      events.push("gate-failed");
      gateFinished = true;
      return gate;
    },
    assertSourceCopy(value) {
      assert.equal(value, SOURCE_COPY_CORE);
      if (gateFinished) {
        sourceCopyRevalidations += 1;
        events.push("copy-revalidated");
      }
      return value;
    },
    cleanupSourceCopy(value) {
      assert.equal(value, SOURCE_COPY_CORE);
      sourceCopyCleanups += 1;
      events.push("copy-cleaned");
      return SOURCE_COPY_EVIDENCE.cleanup;
    },
    writeNotebook: (path) => {
      events.push("notebook-written");
      return { path, bytes: 100, mode: "0600" };
    },
    executeTrial: () => {
      supervisorLaunches += 1;
      return assert.fail("failed gate launched an editor");
    },
    completeTerminalEvidence: () => assert.fail("failed gate requested terminal evidence"),
    validateFragment(fragment) {
      events.push("fragment-validated");
      validated = fragment;
      return fragment;
    },
    fragmentIdFactory: () => FRAGMENT_ID,
    now: () => new Date("2026-08-02T11:00:00.000Z")
  });

  assert.equal(result.output, validated);
  assert.equal(validated.fragmentId, FRAGMENT_ID);
  assert.deepEqual(validated.outcome, {
    status: "pre-action-invalid",
    reasonClass: "setup",
    actionStarted: false,
    correctness: "not-reached",
    timeout: null,
    unsupported: null
  });
  assert.deepEqual(validated.environmentGate, gate);
  assert.equal(validated.cacheProof, null);
  assert.equal(validated.processProofs, null);
  assert.equal(sourceCopyRevalidations, 1);
  assert.equal(sourceCopyCleanups, 1);
  assert.equal(supervisorLaunches, 0);
  assert.deepEqual(events, [
    "heavy-lease-acquired",
    "ledger-opened",
    "notebook-written",
    "gate-failed",
    "fragment-validated",
    "copy-revalidated",
    "copy-cleaned",
    "fragment-published",
    "heavy-lease-released"
  ]);
});

test("a failed gate marks source-copy cleanup uncertainty without launching an editor", async () => {
  const gate = { protocol: "test-gate-v1", passed: false };
  const cleanupError = new Error("failed-gate source-copy identity could not be confirmed");
  let sourceCopyCleanups = 0;
  let sourceCopyRevalidations = 0;
  let supervisorLaunches = 0;
  await assert.rejects(
    recordOnePreparedDataWranglerComparisonStudyTrial(input(), {
      withHeavyLease: fakeHeavyLease([]),
      validateExecutorReceipt: acceptSyntheticExecutorReceipt,
      ...provenanceDependencies(),
      runNext: fakeRunNext([]),
      runGate: async () => gate,
      assertSourceCopy(value) {
        assert.equal(value, SOURCE_COPY_CORE);
        sourceCopyRevalidations += 1;
        return value;
      },
      cleanupSourceCopy(value) {
        assert.equal(value, SOURCE_COPY_CORE);
        sourceCopyCleanups += 1;
        throw cleanupError;
      },
      writeNotebook: (path) => ({ path, bytes: 100, mode: "0600" }),
      executeTrial: () => {
        supervisorLaunches += 1;
        return assert.fail("failed gate launched an editor");
      },
      completeTerminalEvidence: () => assert.fail("failed gate requested terminal evidence"),
      validateFragment: (fragment) => fragment,
      fragmentIdFactory: () => FRAGMENT_ID,
      now: () => new Date("2026-08-02T11:00:00.000Z")
    }),
    (error) =>
      error instanceof AggregateError &&
      dataWranglerComparisonCleanupMayBeUnsettled(error) &&
      error.errors.length === 1 &&
      error.errors[0] === cleanupError
  );
  assert.equal(sourceCopyRevalidations, 2);
  assert.equal(sourceCopyCleanups, 1);
  assert.equal(supervisorLaunches, 0);
});

test("incomplete terminal evidence cannot reach fragment publication", async () => {
  const events = [];
  await assert.rejects(
    recordOnePreparedDataWranglerComparisonStudyTrial(input(), {
      withHeavyLease: fakeHeavyLease(events),
      validateExecutorReceipt: acceptSyntheticExecutorReceipt,
      ...provenanceDependencies(),
      runNext: fakeRunNext(events),
      runGate: async () => passedGate(),
      writeNotebook: (path) => ({ path, bytes: 100, mode: "0600" }),
      executeTrial: async () => rawEvidence({ terminalEvidence: null })
    }),
    /omitted cleanup or post-cleanup provenance evidence/u
  );
  assert.equal(events.includes("fragment-published"), false);
});

test("a post-launch setup failure uses its dedicated normalizer", async () => {
  const events = [];
  const normalized = { protocol: "test-setup-failure-fragment-v1" };
  const result = await recordOnePreparedDataWranglerComparisonStudyTrial(input(), {
    withHeavyLease: fakeHeavyLease(events),
    validateExecutorReceipt: acceptSyntheticExecutorReceipt,
    ...provenanceDependencies(),
    runNext: fakeRunNext(events),
    runGate: async () => passedGate(),
    writeNotebook: (path) => ({ path, bytes: 100, mode: "0600" }),
    executeTrial: async () =>
      rawEvidence({
        status: "post-launch-setup-failure",
        actionAuthorized: false,
        authorizationAttempted: false,
        authorizationOutcome: "not-attempted",
        notebookPhaseReceipt: null,
        controlReceipt: null,
        processProofs: {
          protocol: "test-process-v1",
          editorRoot: { pid: 100, startTimeTicks: "1000" },
          configuredKernel: null,
          openWranglerRuntime: null
        },
        outerEditorFailure: { status: "failed", classification: "process-evidence-invalid" }
      }),
    normalizeTrial: () => assert.fail("setup failure reached the evidence normalizer"),
    normalizePreNotebookFailure: () => assert.fail("setup failure reached the pre-notebook normalizer"),
    normalizePostLaunchSetupFailure(value) {
      assert.equal(value.executorReceipt.status, "post-launch-setup-failure");
      assert.equal(value.executorReceipt.terminalEvidence.cleanupProof.protocol, "test-cleanup-v1");
      return normalized;
    }
  });
  assert.equal(result.output, normalized);
  assert.equal(events.includes("fragment-published"), true);
});

test("a pre-action process-proof failure reaches durable setup publication", async () => {
  const events = [];
  const normalized = {
    protocol: "test-pre-action-process-proof-fragment-v1",
    outcome: {
      status: "pre-action-invalid",
      reasonClass: "setup",
      actionStarted: false,
      correctness: "not-reached",
      timeout: null,
      unsupported: null
    }
  };
  const result = await recordOnePreparedDataWranglerComparisonStudyTrial(input(), {
    withHeavyLease: fakeHeavyLease(events),
    validateExecutorReceipt: acceptSyntheticExecutorReceipt,
    ...provenanceDependencies(),
    runNext: fakeRunNext(events),
    runGate: async () => passedGate(),
    writeNotebook: (path) => ({ path, bytes: 100, mode: "0600" }),
    executeTrial: async () =>
      rawEvidence({
        status: "pre-action-process-proof-failure",
        actionAuthorized: false,
        authorizationAttempted: false,
        authorizationOutcome: "not-attempted",
        notebookPhaseReceipt: null,
        controlReceipt: null,
        processProofs: {
          protocol: "test-process-v1",
          editorRoot: { pid: 100, startTimeTicks: "1000" },
          configuredKernel: null,
          openWranglerRuntime: null
        },
        outerEditorFailure: {
          status: "failed",
          classification: "pre-action-process-proof-test-error"
        }
      }),
    normalizeTrial: () => assert.fail("pre-action failure reached the evidence normalizer"),
    normalizePreNotebookFailure: () => assert.fail("pre-action failure reached the pre-notebook normalizer"),
    normalizePostLaunchSetupFailure: () => assert.fail("pre-action failure reached the setup normalizer"),
    normalizePreActionProcessProofFailure(value) {
      assert.equal(value.executorReceipt.status, "pre-action-process-proof-failure");
      assert.equal(value.executorReceipt.terminalEvidence.cleanupProof.protocol, "test-cleanup-v1");
      return normalized;
    }
  });
  assert.deepEqual(result.output.outcome, normalized.outcome);
  assert.equal(events.includes("fragment-published"), true);
});

test("terminal driver receipts survive a rejected measured editor phase", async () => {
  const events = [];
  let cleanupClock = 0;
  const normalized = { protocol: "test-retained-driver-failure-v1" };
  const result = await recordOnePreparedDataWranglerComparisonStudyTrial(input(), {
    withHeavyLease: fakeHeavyLease(events),
    validateExecutorReceipt: acceptSyntheticExecutorReceipt,
    ...provenanceDependencies(events),
    runNext: fakeRunNext(events),
    runGate: async () => passedGate(),
    writeNotebook: (path) => ({ path, bytes: 100, mode: "0600" }),
    async executeTrial(executorInput, executorDependencies) {
      await assert.rejects(
        executorDependencies.runEditorPhase(
          { runId: RUN_ID, phase: "comparison-study-open-wrangler-trial" },
          {
            spawnProcess: () => undefined,
            prepareWarmSourceCacheBeforeLaunch: () => executorDependencies.prepareSourceCache({ cacheState: "warm" })
          }
        ),
        /measured editor failed/u
      );
      events.push("supervisor-completed");
      const base = rawEvidence({
        status: "post-launch-setup-failure",
        actionAuthorized: false,
        authorizationAttempted: false,
        authorizationOutcome: "not-attempted",
        notebookPhaseReceipt: null,
        controlReceipt: null,
        processProofs: {
          protocol: "test-process-v1",
          editorRoot: { pid: 100, startTimeTicks: "1000" },
          configuredKernel: null,
          openWranglerRuntime: null
        },
        terminalEvidence: null,
        outerEditorFailure: { status: "failed", classification: "process-evidence-invalid" }
      });
      const terminalEvidence = await executorDependencies.completeTerminalEvidence({
        input: executorInput,
        launchReceipt: base.launchReceipt,
        supervisorCompletion: base.supervisorCompletion,
        processProofs: base.processProofs,
        notebookPhaseReceipt: base.notebookPhaseReceipt,
        controlReceipt: base.controlReceipt,
        cacheProof: base.cacheProof
      });
      return { ...base, terminalEvidence };
    },
    executorDependencies: {
      async runEditorPhase() {
        events.push("editor-rejected");
        throw new Error("measured editor failed");
      }
    },
    neutralDriverDependencies: {
      captureDriverReceipt: () => DRIVER_RECEIPT,
      async installDriver() {
        events.push("neutral-driver-installed");
      },
      async readInventory() {
        events.push("neutral-driver-inventory-read");
        return input().preparedTrial.neutralDriver.expectedExtensions;
      }
    },
    prepareSourceCache: () => cacheProof(),
    cleanupDependencies: {
      monotonicMilliseconds: () => cleanupClock,
      async wait(milliseconds) {
        cleanupClock += milliseconds;
      },
      readProcessIdentity: () => null
    },
    normalizePostLaunchSetupFailure(value) {
      assert.deepEqual(value.executorReceipt.terminalEvidence.trialProvenance.driverBefore, DRIVER_RECEIPT);
      assert.deepEqual(value.executorReceipt.terminalEvidence.trialProvenance.driverAfter, DRIVER_RECEIPT);
      return normalized;
    }
  });
  assert.equal(result.output, normalized);
  assert.equal(events.includes("fragment-published"), true);
  assert.equal(events.filter((event) => event === "neutral-driver-inventory-read").length, 2);
  assert.equal(events.indexOf("editor-rejected") < events.lastIndexOf("neutral-driver-inventory-read"), true);
  assert.equal(events.lastIndexOf("neutral-driver-inventory-read") < events.indexOf("supervisor-completed"), true);
});

test("a prepared trial cannot drift to another schedule entry", async () => {
  const events = [];
  const drifted = context({
    scheduleEntry: { ...context().scheduleEntry, id: "warm-001" },
    preparedIntent: { ...context().preparedIntent, scheduleEntryId: "warm-001" }
  });
  await assert.rejects(
    recordOnePreparedDataWranglerComparisonStudyTrial(input(), {
      withHeavyLease: fakeHeavyLease(events),
      validateExecutorReceipt: acceptSyntheticExecutorReceipt,
      ...provenanceDependencies(),
      runNext: fakeRunNext(events, drifted),
      runGate: () => assert.fail("schedule drift reached the gate"),
      completeTerminalEvidence: () => assert.fail("schedule drift requested evidence")
    }),
    /does not match the next study schedule entry/u
  );
  assert.equal(events.includes("fragment-published"), false);
});

test("a competing heavy command rejects the recorded run before gate or editor work", async () => {
  const events = [];
  await assert.rejects(
    recordOnePreparedDataWranglerComparisonStudyTrial(input(), {
      withHeavyLease: async () => {
        throw new Error(
          'Another Open Wrangler memory-intensive command is already running. Wait for it to finish before starting "data-wrangler-comparison-study-trial".'
        );
      },
      validateExecutorReceipt: acceptSyntheticExecutorReceipt,
      ...provenanceDependencies(),
      runNext: () => {
        events.push("ledger-opened");
        return assert.fail("overlapping run opened the study ledger");
      },
      runGate: () => {
        events.push("gate-started");
        return assert.fail("overlapping run reached the environment gate");
      },
      executeTrial: () => {
        events.push("editor-started");
        return assert.fail("overlapping run reached the editor");
      },
      completeTerminalEvidence: () => assert.fail("overlapping run requested cleanup evidence")
    }),
    /Another Open Wrangler memory-intensive command is already running/u
  );
  assert.deepEqual(events, []);
});

test("a recorded trial cannot load a repository extension development path", async () => {
  const prepared = input().preparedTrial;
  await assert.rejects(
    recordOnePreparedDataWranglerComparisonStudyTrial(
      input({
        preparedTrial: {
          ...prepared,
          editorPhaseOptions: { ...prepared.editorPhaseOptions, developmentPaths: ["/private/repository"] }
        }
      }),
      {}
    ),
    /cannot override developmentPaths/u
  );
});

test("a recorded trial rejects study-level Jupyter directories outside its private profile", async () => {
  const prepared = input().preparedTrial;
  await assert.rejects(
    recordOnePreparedDataWranglerComparisonStudyTrial(
      input({
        preparedTrial: {
          ...prepared,
          editorPhaseOptions: {
            ...prepared.editorPhaseOptions,
            jupyterEnvironment: {
              dataDir: "/private/study/jupyter/data",
              runtimeDir: "/private/study/jupyter/runtime",
              configDir: "/private/study/jupyter/config",
              path: "/private/study/jupyter/path"
            }
          }
        }
      }),
      {}
    ),
    /must stay inside the exact private trial root/u
  );
});

test("prepared output and bridge paths can never alias the immutable source", async () => {
  const prepared = input().preparedTrial;
  for (const conflictingPath of [prepared.notebookPath, prepared.requestPath, prepared.acknowledgementPath]) {
    await assert.rejects(
      recordOnePreparedDataWranglerComparisonStudyTrial(
        input({ preparedTrial: { ...prepared, sourcePath: conflictingPath } }),
        {}
      ),
      /source, notebook, result, and bridge paths must be distinct/u
    );
  }
  await assert.rejects(
    recordOnePreparedDataWranglerComparisonStudyTrial(
      input({ preparedTrial: { ...prepared, sourcePath: `${prepared.notebookPath}.result.json` } }),
      {}
    ),
    /source, notebook, result, and bridge paths must be distinct/u
  );
  await assert.rejects(
    recordOnePreparedDataWranglerComparisonStudyTrial(
      input({ preparedTrial: { ...prepared, notebookPath: "/private/study/manifest.json" } }),
      {}
    ),
    /writable paths cannot alias study, source, or runtime inputs/u
  );
  const sourceCopyPath = resolve(PROFILE_ROOT, prepared.sourceCopy.name);
  await assert.rejects(
    recordOnePreparedDataWranglerComparisonStudyTrial(
      input({ preparedTrial: { ...prepared, notebookPath: sourceCopyPath } }),
      {}
    ),
    /writable paths cannot alias/u
  );
  await assert.rejects(
    recordOnePreparedDataWranglerComparisonStudyTrial(
      input({ preparedTrial: { ...prepared, sourcePath: sourceCopyPath } }),
      {}
    ),
    /writable paths cannot alias/u
  );
  await assert.rejects(
    recordOnePreparedDataWranglerComparisonStudyTrial(
      input({ preparedTrial: { ...prepared, sourceCopy: { ...prepared.sourceCopy, name: "." } } }),
      {}
    ),
    /source-copy name is invalid/u
  );
});

test("cleanup evidence rejects a reused PID instead of treating it as absence", async () => {
  await assert.rejects(
    collectDataWranglerComparisonCleanupProof(rawEvidence(), {
      monotonicMilliseconds: () => 0,
      wait: () => assert.fail("PID reuse reached another cleanup poll"),
      readProcessIdentity: () => ({ pid: 100, startTimeTicks: "9999" })
    }),
    /detected PID reuse for 100/u
  );
});

test("cleanup evidence rejects a process that reappears after an empty poll", async () => {
  let clock = 0;
  let reads = 0;
  await assert.rejects(
    collectDataWranglerComparisonCleanupProof(rawEvidence(), {
      monotonicMilliseconds: () => clock,
      async wait(milliseconds) {
        clock += milliseconds;
      },
      readProcessIdentity() {
        reads += 1;
        return reads === 1 ? null : { pid: 100, startTimeTicks: "1000" };
      }
    }),
    /contradicted an earlier empty process-tree observation/u
  );
});

test("cleanup evidence uses launch identities when setup failed before control started", async () => {
  let clock = 0;
  const proof = await collectDataWranglerComparisonCleanupProof(
    rawEvidence({
      status: "post-launch-setup-failure",
      actionAuthorized: false,
      authorizationAttempted: false,
      authorizationOutcome: "not-attempted",
      notebookPhaseReceipt: null,
      controlReceipt: null,
      processProofs: {
        editorRoot: { pid: 100, startTimeTicks: "1000" },
        configuredKernel: null,
        openWranglerRuntime: null
      },
      outerEditorFailure: { status: "failed", classification: "process-evidence-invalid" },
      terminalEvidence: null
    }),
    {
      monotonicMilliseconds: () => clock,
      async wait(milliseconds) {
        clock += milliseconds;
      },
      readProcessIdentity: () => null
    }
  );
  assert.deepEqual(proof.retainedOwnedIdentities, [{ pid: 100, startTimeTicks: "1000" }]);
  assert.deepEqual(proof.supervisorLaunchReceipt, { protocol: "test-launch-v1" });
  assert.equal(proof.observations.length, 2);
});

test("authorization reinspection recovers only the exact unresolved prepared action", () => {
  const manifest = { protocol: "test-manifest-v1", schedule: ["warm-000"] };
  const preparedIntent = {
    protocol: "test-intent-v1",
    stage: "prepared",
    runId: RUN_ID,
    manifestSha256: digestStudyValue(manifest),
    executionIndex: 0,
    scheduleEntryId: "warm-000",
    attempt: 0,
    effectiveBlockId: "warm-block-000~a00",
    product: "open-wrangler",
    ledgerSha256: "c".repeat(64),
    preparedAtUtc: "2026-08-02T11:00:00.000Z"
  };
  const authorizedIntent = {
    protocol: "test-intent-v1",
    stage: "action-authorized",
    runId: preparedIntent.runId,
    manifestSha256: preparedIntent.manifestSha256,
    executionIndex: preparedIntent.executionIndex,
    scheduleEntryId: preparedIntent.scheduleEntryId,
    attempt: preparedIntent.attempt,
    effectiveBlockId: preparedIntent.effectiveBlockId,
    product: preparedIntent.product,
    ledgerSha256: preparedIntent.ledgerSha256,
    preparedSha256: digestStudyValue(preparedIntent),
    authorizedAtUtc: "2026-08-02T11:01:00.000Z"
  };
  const recovered = reinspectDataWranglerComparisonActionAuthorization(
    {
      manifestPath: "/private/study/manifest.json",
      fragmentsDirectory: "/private/study/fragments",
      intentsDirectory: "/private/study/intents",
      manifest,
      preparedIntent
    },
    {
      readManifest: () => manifest,
      loadFragments: () => [],
      inspectIntents: () => ({ unresolved: [authorizedIntent] })
    }
  );
  assert.deepEqual(recovered, {
    status: "authorized",
    authorization: {
      intent: authorizedIntent,
      publication: { status: "recovered", sha256: digestStudyValue(authorizedIntent) }
    }
  });
});

test("authorization reinspection fails closed on a foreign unresolved action", () => {
  const manifest = { protocol: "test-manifest-v1" };
  const preparedIntent = {
    stage: "prepared",
    runId: RUN_ID,
    manifestSha256: digestStudyValue(manifest),
    executionIndex: 0
  };
  assert.throws(
    () =>
      reinspectDataWranglerComparisonActionAuthorization(
        {
          manifestPath: "/private/study/manifest.json",
          fragmentsDirectory: "/private/study/fragments",
          intentsDirectory: "/private/study/intents",
          manifest,
          preparedIntent
        },
        {
          readManifest: () => manifest,
          loadFragments: () => [],
          inspectIntents: () => ({ unresolved: [{ runId: "33333333-3333-4333-8333-333333333333" }] })
        }
      ),
    /another unresolved product action/u
  );
});

test("private source cleanup starts only after the measured process tree is proven empty", async () => {
  const events = [];
  let clock = 0;
  const terminal = await completeDataWranglerComparisonTrialEvidence(
    {
      protocol: "openwrangler-data-wrangler-comparison-live-trial-v1",
      manifest: { provenance: { comparisonDriver: DRIVER_RECEIPT } },
      scheduleEntry: { id: "warm-000" },
      preparedIntent: { runId: RUN_ID },
      environmentGate: passedGate(),
      provenanceBefore: { protocol: "test-before-v1" },
      neutralDriverEvidence: { driverBefore: DRIVER_RECEIPT, driverAfter: DRIVER_RECEIPT },
      sourceCopy: SOURCE_COPY_CORE,
      rawEvidence: rawEvidence({ terminalEvidence: null })
    },
    {
      cleanupDependencies: {
        monotonicMilliseconds: () => clock,
        async wait(milliseconds) {
          clock += milliseconds;
        },
        readProcessIdentity() {
          events.push("tree-polled-empty");
          return null;
        }
      },
      assertSourceCopy(value) {
        events.push("copy-revalidated");
        return value;
      },
      async revalidateTrialProvenanceAfter(value) {
        events.push("provenance-revalidated");
        return {
          driverBefore: value.driverBefore,
          driverAfter: value.driverAfter,
          sourceCopyBefore: value.sourceCopy,
          sourceCopyAfter: value.sourceCopy
        };
      },
      cleanupSourceCopy() {
        events.push("copy-cleaned");
        return SOURCE_COPY_EVIDENCE.cleanup;
      }
    }
  );
  assert.deepEqual(events, [
    "tree-polled-empty",
    "tree-polled-empty",
    "copy-revalidated",
    "provenance-revalidated",
    "copy-revalidated",
    "copy-cleaned"
  ]);
  assert.deepEqual(terminal.sourceCopy, SOURCE_COPY_EVIDENCE);
});

test("terminal source-copy cleanup uncertainty is marked for the owning runner", async () => {
  let clock = 0;
  const cleanupError = new Error("terminal source-copy identity could not be confirmed");
  await assert.rejects(
    completeDataWranglerComparisonTrialEvidence(
      {
        protocol: "openwrangler-data-wrangler-comparison-live-trial-v1",
        manifest: { provenance: { comparisonDriver: DRIVER_RECEIPT } },
        scheduleEntry: { id: "warm-000" },
        preparedIntent: { runId: RUN_ID },
        environmentGate: passedGate(),
        provenanceBefore: { protocol: "test-before-v1" },
        neutralDriverEvidence: { driverBefore: DRIVER_RECEIPT, driverAfter: DRIVER_RECEIPT },
        sourceCopy: SOURCE_COPY_CORE,
        rawEvidence: rawEvidence({ terminalEvidence: null })
      },
      {
        cleanupDependencies: {
          monotonicMilliseconds: () => clock,
          async wait(milliseconds) {
            clock += milliseconds;
          },
          readProcessIdentity: () => null
        },
        assertSourceCopy: (value) => value,
        async revalidateTrialProvenanceAfter(value) {
          return {
            driverBefore: value.driverBefore,
            driverAfter: value.driverAfter,
            sourceCopyBefore: value.sourceCopy,
            sourceCopyAfter: value.sourceCopy
          };
        },
        cleanupSourceCopy() {
          throw cleanupError;
        }
      }
    ),
    (error) =>
      error instanceof AggregateError &&
      dataWranglerComparisonCleanupMayBeUnsettled(error) &&
      error.errors.includes(cleanupError)
  );
});

test("post-launch cleanup-proof failure is marked before source cleanup starts", async () => {
  const events = [];
  const cleanupProofError = new Error("terminal process-tree proof could not be completed");
  let sourceCopyCleanups = 0;
  await assert.rejects(
    recordOnePreparedDataWranglerComparisonStudyTrial(input(), {
      ...postLaunchTrialDependencies(events),
      cleanupSourceCopy() {
        sourceCopyCleanups += 1;
        return SOURCE_COPY_EVIDENCE.cleanup;
      },
      async executeTrial(executorInput, executorDependencies) {
        await launchSyntheticMeasuredPhase(executorDependencies);
        const base = rawEvidence({ terminalEvidence: null });
        await executorDependencies.completeTerminalEvidence({
          input: executorInput,
          launchReceipt: base.launchReceipt,
          supervisorCompletion: base.supervisorCompletion,
          processProofs: base.processProofs,
          notebookPhaseReceipt: base.notebookPhaseReceipt,
          controlReceipt: base.controlReceipt,
          cacheProof: base.cacheProof
        });
        return assert.fail("cleanup-proof failure returned terminal evidence");
      },
      completeTerminalEvidence() {
        throw cleanupProofError;
      }
    }),
    (error) =>
      error instanceof AggregateError &&
      dataWranglerComparisonCleanupMayBeUnsettled(error) &&
      error.errors[0] === cleanupProofError
  );
  assert.equal(sourceCopyCleanups, 0);
  assert.equal(events.includes("fragment-published"), false);
});

test("post-launch terminal source assertion failure is marked without removing the source", async () => {
  const events = [];
  const assertionError = new Error("terminal source-copy identity could not be confirmed");
  let terminalStarted = false;
  let sourceCopyCleanups = 0;
  let clock = 0;
  await assert.rejects(
    recordOnePreparedDataWranglerComparisonStudyTrial(input(), {
      ...postLaunchTrialDependencies(events),
      assertSourceCopy(value) {
        if (terminalStarted) throw assertionError;
        return value;
      },
      cleanupSourceCopy() {
        sourceCopyCleanups += 1;
        return SOURCE_COPY_EVIDENCE.cleanup;
      },
      cleanupDependencies: {
        monotonicMilliseconds: () => clock,
        async wait(milliseconds) {
          clock += milliseconds;
        },
        readProcessIdentity: () => null
      },
      async executeTrial(executorInput, executorDependencies) {
        await launchSyntheticMeasuredPhase(executorDependencies);
        terminalStarted = true;
        const base = rawEvidence({ terminalEvidence: null });
        await executorDependencies.completeTerminalEvidence({
          input: executorInput,
          launchReceipt: base.launchReceipt,
          supervisorCompletion: base.supervisorCompletion,
          processProofs: base.processProofs,
          notebookPhaseReceipt: base.notebookPhaseReceipt,
          controlReceipt: base.controlReceipt,
          cacheProof: base.cacheProof
        });
        return assert.fail("terminal source assertion failure returned evidence");
      }
    }),
    (error) =>
      error instanceof AggregateError &&
      dataWranglerComparisonCleanupMayBeUnsettled(error) &&
      error.errors[0] === assertionError
  );
  assert.equal(sourceCopyCleanups, 0);
  assert.equal(events.includes("fragment-published"), false);
});

test("a failure before supervisor launch removes the still-verified private source copy", async () => {
  let copyInspections = 0;
  let copyCleanups = 0;
  let executorStarted = false;
  await assert.rejects(
    recordOnePreparedDataWranglerComparisonStudyTrial(input(), {
      withHeavyLease: fakeHeavyLease([]),
      validateExecutorReceipt: acceptSyntheticExecutorReceipt,
      ...provenanceDependencies(),
      runNext: fakeRunNext([]),
      runGate: async () => passedGate(),
      createSourceCopy: () => SOURCE_COPY_CORE,
      assertSourceCopy(value) {
        copyInspections += 1;
        assert.equal(value, SOURCE_COPY_CORE);
        return value;
      },
      cleanupSourceCopy(value) {
        copyCleanups += 1;
        assert.equal(value, SOURCE_COPY_CORE);
        return SOURCE_COPY_EVIDENCE.cleanup;
      },
      writeNotebook() {
        throw new Error("injected notebook publication failure");
      },
      async executeTrial() {
        executorStarted = true;
        return assert.fail("a failed notebook publication reached the trial executor");
      }
    }),
    /injected notebook publication failure/u
  );
  assert.equal(copyInspections, 2);
  assert.equal(copyCleanups, 1);
  assert.equal(executorStarted, false);
});

test("an ambiguous supervisor launch never removes the private source copy", async () => {
  let copyCleanups = 0;
  await assert.rejects(
    recordOnePreparedDataWranglerComparisonStudyTrial(input(), {
      withHeavyLease: fakeHeavyLease([]),
      validateExecutorReceipt: acceptSyntheticExecutorReceipt,
      ...provenanceDependencies(),
      runNext: fakeRunNext([]),
      runGate: async () => passedGate(),
      createSourceCopy: () => SOURCE_COPY_CORE,
      assertSourceCopy: (value) => value,
      cleanupSourceCopy() {
        copyCleanups += 1;
        return SOURCE_COPY_EVIDENCE.cleanup;
      },
      writeNotebook: (path) => ({ path, bytes: 100, mode: "0600" }),
      async executeTrial(_executorInput, executorDependencies) {
        await executorDependencies.runEditorPhase(
          { runId: RUN_ID, phase: "comparison-study-open-wrangler-trial" },
          {
            spawnProcess() {
              throw new Error("injected ambiguous supervisor launch");
            },
            async prepareWarmSourceCacheBeforeLaunch() {
              return await executorDependencies.prepareSourceCache({ cacheState: "warm" });
            }
          }
        );
        return assert.fail("an ambiguous launch returned to the trial executor");
      },
      executorDependencies: {
        async runEditorPhase(_options, dependencies) {
          return await dependencies.spawnProcess();
        }
      },
      neutralDriverDependencies: {
        captureDriverReceipt: () => DRIVER_RECEIPT,
        async installDriver() {},
        async readInventory() {
          return input().preparedTrial.neutralDriver.expectedExtensions;
        }
      },
      prepareSourceCache: () => cacheProof()
    }),
    (error) =>
      error instanceof AggregateError &&
      dataWranglerComparisonCleanupMayBeUnsettled(error) &&
      error.errors.some((candidate) => candidate?.message === "injected ambiguous supervisor launch")
  );
  assert.equal(copyCleanups, 0);
});

test("a fake cache receipt cannot reach durable action authorization", async () => {
  let productAuthorizations = 0;
  await assert.rejects(
    recordOnePreparedDataWranglerComparisonStudyTrial(input(), {
      withHeavyLease: fakeHeavyLease([]),
      validateExecutorReceipt: acceptSyntheticExecutorReceipt,
      ...provenanceDependencies(),
      runNext: fakeRunNext(
        [],
        context({
          authorizeAction() {
            productAuthorizations += 1;
            return { protocol: "unexpected-authorization" };
          }
        })
      ),
      runGate: async () => passedGate(),
      writeNotebook: (path) => ({ path, bytes: 100, mode: "0600" }),
      prepareSourceCache: () => ({ protocol: "test-cache-v1" }),
      async executeTrial(executorInput, executorDependencies) {
        await assert.rejects(
          executorDependencies.prepareSourceCache({ cacheState: "warm" }),
          /source-cache proof has missing or unknown fields/u
        );
        assert.throws(() => executorInput.authorizeAction(), /requires one manifest-bound source-cache proof/u);
        throw new Error("fake cache receipt was blocked before product authorization");
      }
    }),
    /fake cache receipt was blocked before product authorization/u
  );
  assert.equal(productAuthorizations, 0);
});

test("a private source-copy drift closes action authorization before the product click", async () => {
  let inspections = 0;
  let productAuthorizations = 0;
  await assert.rejects(
    recordOnePreparedDataWranglerComparisonStudyTrial(input(), {
      withHeavyLease: fakeHeavyLease([]),
      validateExecutorReceipt: acceptSyntheticExecutorReceipt,
      ...provenanceDependencies(),
      runNext: fakeRunNext(
        [],
        context({
          authorizeAction() {
            productAuthorizations += 1;
            return { protocol: "unexpected-authorization" };
          }
        })
      ),
      runGate: async () => passedGate(),
      writeNotebook: (path) => ({ path, bytes: 100, mode: "0600" }),
      assertSourceCopy(value) {
        inspections += 1;
        if (inspections >= 2) throw new Error("private source copy changed identity");
        return value;
      },
      async executeTrial(executorInput) {
        executorInput.authorizeAction();
        return assert.fail("copy drift reached product execution");
      },
      runNextOptions: {},
      createSourceCopy: () => SOURCE_COPY_CORE
    }),
    /private source copy changed identity/u
  );
  assert.equal(productAuthorizations, 0);
});
