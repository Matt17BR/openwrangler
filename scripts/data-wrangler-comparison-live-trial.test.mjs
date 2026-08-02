import assert from "node:assert/strict";
import test from "node:test";
import {
  collectDataWranglerComparisonCleanupProof,
  prepareManifestBoundDataWranglerSourceCache,
  reinspectDataWranglerComparisonActionAuthorization,
  recordOnePreparedDataWranglerComparisonStudyTrial
} from "./data-wrangler-comparison-live-trial.mjs";
import { createDataWranglerComparisonDriverProfile } from "./data-wrangler-comparison-driver.mjs";
import { digestStudyValue } from "./data-wrangler-comparison-study.mjs";

const RUN_ID = "11111111-1111-4111-8111-111111111111";
const FRAGMENT_ID = "22222222-2222-4222-8222-222222222222";
const FIXTURE_SHA256 = "a".repeat(64);
const FIXTURE_IDENTITY = Object.freeze({ device: "1", inode: "2", sizeBytes: 100, mtimeNs: "3" });
const DRIVER_RECEIPT = Object.freeze({
  extensionId: "openwrangler-study.notebook-comparison-driver",
  version: "1.0.0",
  vsix: Object.freeze({ sha256: "f".repeat(64) }),
  journeyGraph: Object.freeze({ graphSha256: "e".repeat(64) })
});

function input(overrides = {}) {
  return {
    manifestPath: "/private/study/manifest.json",
    fragmentsDirectory: "/private/study/fragments",
    intentsDirectory: "/private/study/intents",
    expectedProvenance: { protocol: "test-provenance-v1", comparisonDriver: DRIVER_RECEIPT },
    preparedTrial: {
      scheduleEntryId: "warm-000",
      sourcePath: "/private/trial/source.csv",
      notebookPath: "/private/trial/study.ipynb",
      requestPath: "/private/trial/bridge/request.json",
      acknowledgementPath: "/private/trial/bridge/ack.json",
      selectedKernel: {
        name: "openwrangler-study-test",
        displayName: "Open Wrangler study CPython 3.12"
      },
      publicSurfaceAvailability: "available",
      editorPhaseOptions: {
        editor: { name: "VS Code" },
        testModule: "/private/test-module.js"
      },
      supervisorOptions: { pythonExecutable: "/private/python" },
      processEvidenceOptions: { pythonExecutablePath: "/private/python" },
      samplerOptions: { procRoot: "/private/proc" },
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
        profile: createDataWranglerComparisonDriverProfile({
          editor: { name: "VS Code" },
          userData: "/private/user-data",
          extensions: "/private/extensions",
          sandboxArgs: [],
          environment: {},
          installLabel: "comparison-driver-install",
          inventoryLabel: "comparison-driver-inventory"
        })
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
    provenance: { comparisonDriver: DRIVER_RECEIPT },
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
    ...overrides
  };
}

function passedGate() {
  return { protocol: "test-gate-v1", passed: true };
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
    notebookPhaseReceipt: { protocol: "test-notebook-v1", status: "success" },
    controlReceipt: {
      protocol: "test-control-v1",
      status: "success",
      resourceObservation: {
        protocol: "test-resource-v1",
        retainedOwnedIdentities: [{ pid: 100, startTimeTicks: "1000" }]
      }
    },
    cacheProof: { protocol: "test-cache-v1" },
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
      return { protocol: "test-provenance-before-v1" };
    },
    async revalidateTrialProvenanceAfter(value) {
      events.push("provenance-revalidated-after");
      assert.equal(value.provenanceBefore.protocol, "test-provenance-before-v1");
      assert.deepEqual(value.driverBefore, DRIVER_RECEIPT);
      assert.deepEqual(value.driverAfter, DRIVER_RECEIPT);
      assert.equal(value.cleanupProof.status, "complete");
      return {
        protocol: "test-trial-provenance-v1",
        driverBefore: value.driverBefore,
        driverAfter: value.driverAfter
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

const acceptSyntheticExecutorReceipt = (value) => value;

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
        sourcePath: "/private/trial/source.csv",
        publicSurfaceAvailability: "available"
      });
      assert.equal(executorInput.preparedIntent.runId, RUN_ID);
      assert.equal(executorInput.scheduleEntry.id, "warm-000");
      assert.equal(typeof executorInput.reinspectActionAuthorization, "function");
      const phaseReceipt = await executorDependencies.runEditorPhase(
        { runId: RUN_ID, phase: "comparison-study-open-wrangler-trial" },
        { spawnProcess: "supervisor-owned-spawn" }
      );
      assert.deepEqual(phaseReceipt, { protocol: "test-editor-phase-v1" });
      const cache = await executorDependencies.prepareSourceCache({ cacheState: "warm" });
      assert.deepEqual(cache, { protocol: "test-cache-v1" });
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
        assert.equal(dependencies.spawnProcess, "supervisor-owned-spawn");
        assert.deepEqual(dependencies.environment, {});
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
      assert.equal(options.fixture.id, "csv-100k-50");
      return { protocol: "test-cache-v1" };
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
    "gate-passed",
    "notebook-written",
    "executor-started",
    "neutral-driver-installed",
    "neutral-driver-inventory-read",
    "provenance-captured-before",
    "editor-executed",
    "neutral-driver-inventory-read",
    "cache-prepared",
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
  let validated;
  const result = await recordOnePreparedDataWranglerComparisonStudyTrial(input(), {
    withHeavyLease: fakeHeavyLease(events),
    validateExecutorReceipt: acceptSyntheticExecutorReceipt,
    ...provenanceDependencies(),
    runNext: fakeRunNext(events),
    runGate: async () => {
      events.push("gate-failed");
      return gate;
    },
    writeNotebook: () => assert.fail("failed gate wrote a notebook"),
    executeTrial: () => assert.fail("failed gate launched an editor"),
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
  assert.deepEqual(events, [
    "heavy-lease-acquired",
    "ledger-opened",
    "gate-failed",
    "fragment-validated",
    "fragment-published",
    "heavy-lease-released"
  ]);
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
          { spawnProcess: "supervisor-owned-spawn" }
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

test("manifest-bound cache preparation proves the requested state and exact source identity", () => {
  const calls = [];
  const metadata = {
    dev: 1n,
    ino: 2n,
    size: 100n,
    mtimeNs: 3n,
    uid: typeof process.getuid === "function" ? BigInt(process.getuid()) : 1n,
    nlink: 1n,
    isFile: () => true,
    isSymbolicLink: () => false
  };
  const fixture = {
    id: "csv-100k-50",
    sha256: FIXTURE_SHA256,
    filesystemIdentity: FIXTURE_IDENTITY
  };
  const proof = prepareManifestBoundDataWranglerSourceCache(
    {
      cacheState: "cold",
      sourcePath: "/private/source.csv",
      fixture,
      pythonExecutablePath: "/private/python",
      controlScriptPath: "/private/cache.py"
    },
    {
      lstat: () => metadata,
      execFile(executable, arguments_, options) {
        calls.push({ executable, arguments_, options });
        return JSON.stringify({
          protocol: "openwrangler-source-cache-proof-v1",
          requestedState: "evicted",
          fdatasyncApplied: true,
          adviceAccepted: true,
          verification: "linux-mincore",
          pageSizeBytes: 4_096,
          totalPages: 2,
          residentPagesBefore: 2,
          residentPagesAfter: 0,
          identityStable: true,
          verified: true
        });
      }
    }
  );

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].arguments_, ["/private/cache.py", "--source", "/private/source.csv", "--mode", "cold"]);
  assert.equal(proof.fixtureId, fixture.id);
  assert.equal(proof.fixtureSha256, fixture.sha256);
  assert.deepEqual(proof.filesystemIdentityBefore, FIXTURE_IDENTITY);
  assert.deepEqual(proof.filesystemIdentityAfter, FIXTURE_IDENTITY);
  assert.equal(Object.hasOwn(proof, "identityStable"), false);
});

test("cache preparation rejects a controller claim that does not match the measured state", () => {
  const metadata = {
    dev: 1n,
    ino: 2n,
    size: 100n,
    mtimeNs: 3n,
    uid: typeof process.getuid === "function" ? BigInt(process.getuid()) : 1n,
    nlink: 1n,
    isFile: () => true,
    isSymbolicLink: () => false
  };
  assert.throws(
    () =>
      prepareManifestBoundDataWranglerSourceCache(
        {
          cacheState: "warm",
          sourcePath: "/private/source.csv",
          fixture: {
            id: "csv-100k-50",
            sha256: FIXTURE_SHA256,
            filesystemIdentity: FIXTURE_IDENTITY
          },
          pythonExecutablePath: "/private/python",
          controlScriptPath: "/private/cache.py"
        },
        {
          lstat: () => metadata,
          execFile: () =>
            JSON.stringify({
              protocol: "openwrangler-source-cache-proof-v1",
              requestedState: "resident",
              fdatasyncApplied: true,
              adviceAccepted: false,
              verification: "linux-mincore",
              pageSizeBytes: 4_096,
              totalPages: 2,
              residentPagesBefore: 0,
              residentPagesAfter: 1,
              identityStable: true,
              verified: true
            })
        }
      ),
    /did not prove the requested stable Linux cache state/u
  );
});
