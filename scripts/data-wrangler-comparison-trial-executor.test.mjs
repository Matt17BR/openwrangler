import assert from "node:assert/strict";
import test from "node:test";
import {
  DATA_WRANGLER_COMPARISON_TRIAL_EXECUTOR_PROTOCOL,
  executeDataWranglerComparisonTrial,
  validateDataWranglerComparisonTrialExecutorReceipt
} from "./data-wrangler-comparison-trial-executor.mjs";

const RUN_ID = "11111111-1111-4111-8111-111111111111";
const PHASE = "comparison-study-open-wrangler-trial";
const KERNEL = Object.freeze({
  name: "openwrangler-study-executor",
  displayName: "Open Wrangler study CPython 3.12"
});
const SCHEDULE_ENTRY = Object.freeze({
  id: "warm-pandas-csv-r00-ow",
  blockId: "warm-pandas-csv-r00",
  kind: "warm",
  engine: "pandas",
  format: "csv",
  product: "open-wrangler"
});

function preparedIntent(scheduleEntry = SCHEDULE_ENTRY) {
  return Object.freeze({
    protocol: "openwrangler-data-wrangler-study-trial-intent-v1",
    stage: "prepared",
    runId: RUN_ID,
    manifestSha256: "a".repeat(64),
    executionIndex: 0,
    scheduleEntryId: scheduleEntry.id,
    attempt: 0,
    effectiveBlockId: `${scheduleEntry.blockId}~a00`,
    product: scheduleEntry.product,
    ledgerSha256: "b".repeat(64),
    preparedAtUtc: "2026-08-02T12:00:00.000Z"
  });
}

function deferred() {
  let resolvePromise;
  let rejectPromise;
  const promise = new Promise((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  void promise.catch(() => {});
  return { promise, resolve: resolvePromise, reject: rejectPromise };
}

function input(overrides = {}) {
  const cacheState = overrides.cacheState ?? "warm";
  const product = overrides.product ?? "open-wrangler";
  const scheduleEntry =
    overrides.scheduleEntry ??
    Object.freeze({
      ...SCHEDULE_ENTRY,
      id: `${cacheState}-pandas-csv-r00-${product === "open-wrangler" ? "ow" : "dw"}`,
      blockId: `${cacheState}-pandas-csv-r00`,
      kind: cacheState,
      product
    });
  return {
    runId: RUN_ID,
    phase: PHASE,
    cacheState,
    product,
    requestPath: "/private/bridge/request.json",
    acknowledgementPath: "/private/bridge/acknowledgement.json",
    selectedKernel: KERNEL,
    editorPhaseOptions: { editor: { name: "VS Code" } },
    supervisorOptions: { pythonExecutable: "/private/python" },
    processEvidenceOptions: { pythonExecutablePath: "/private/python" },
    authorizeAction: () => Object.freeze({ protocol: "test-authorization-v1", runId: RUN_ID }),
    reinspectActionAuthorization: () => Object.freeze({ status: "not-authorized" }),
    ...overrides,
    scheduleEntry,
    preparedIntent: overrides.preparedIntent ?? preparedIntent(scheduleEntry)
  };
}

function launchReceipt() {
  return Object.freeze({
    protocol: "test-supervisor-v1",
    kind: "launch",
    supervisor: Object.freeze({ pid: 40, startTimeTicks: "400" }),
    editorRoot: Object.freeze({ pid: 41, startTimeTicks: "410" })
  });
}

function completionReceipt(launch = launchReceipt()) {
  return Object.freeze({
    launchReceipt: launch,
    terminalReceipt: Object.freeze({ protocol: "test-supervisor-v1", kind: "terminal-cleanup" }),
    exit: Object.freeze({ code: 0, signal: null, error: undefined })
  });
}

function createHarness({
  runEditorPhase,
  controlTrial,
  createProcessEvidence,
  signalSupervisor,
  completeTerminalEvidence
} = {}) {
  const events = [];
  const launch = launchReceipt();
  const completion = completionReceipt(launch);
  const child = Object.freeze({
    kill(signal) {
      events.push(`child-kill:${signal}`);
      return true;
    }
  });
  const adapter = Object.freeze({
    spawnProcess() {
      events.push("spawn");
      return child;
    },
    async waitForLaunch() {
      events.push("launch-receipt");
      return launch;
    },
    async waitForCompletion() {
      events.push("terminal-receipt");
      return completion;
    },
    child() {
      return child;
    }
  });
  return {
    events,
    launch,
    completion,
    dependencies: {
      createSupervisorAdapter() {
        events.push("create-supervisor");
        return adapter;
      },
      async runEditorPhase(options, { spawnProcess }) {
        assert.equal(options.runId, RUN_ID);
        assert.equal(options.phase, PHASE);
        spawnProcess("code", [], {});
        events.push("editor-started");
        return runEditorPhase
          ? runEditorPhase({ options, events })
          : Object.freeze({
              protocol: "test-notebook-phase-v1",
              status: "success",
              product: "open-wrangler",
              study: Object.freeze({ engine: "pandas", format: "csv", kind: "warm" })
            });
      },
      createProcessEvidence() {
        if (createProcessEvidence) return createProcessEvidence({ events });
        return Object.freeze({
          classify() {
            return "other-owned-child";
          },
          snapshotLaunchProcessProofs() {
            events.push("launch-process-proof");
            return Object.freeze({
              editorRoot: Object.freeze({ pid: 41, startTimeTicks: "410", capturedAtLaunch: true }),
              configuredKernel: null,
              openWranglerRuntime: null
            });
          },
          snapshotPreActionProcessProofs() {
            events.push("pre-action-process-proof");
            return Object.freeze({
              editorRoot: Object.freeze({ pid: 41, startTimeTicks: "410", capturedAtLaunch: true }),
              configuredKernel: null,
              openWranglerRuntime: null
            });
          },
          snapshotProcessProofs({ selectedKernel }) {
            assert.deepEqual(selectedKernel, KERNEL);
            events.push("process-proof");
            return Object.freeze({ protocol: "test-process-proof-v1" });
          }
        });
      },
      createSampler({ launchReceipt: receivedLaunch, classify }) {
        assert.equal(receivedLaunch, launch);
        assert.equal(typeof classify, "function");
        events.push("create-sampler");
        return Object.freeze({ protocol: "test-sampler-v1" });
      },
      async controlTrial(options) {
        return controlTrial
          ? controlTrial({ options, events })
          : Object.freeze({ protocol: "test-control-v1", status: "success", abandonedRequest: null });
      },
      validateControlReceipt(receipt) {
        events.push("validate-control");
        return receipt;
      },
      async prepareSourceCache({ cacheState, request }) {
        events.push(`cache:${cacheState}${request ? `:${request.kind}` : ""}`);
        return Object.freeze({ protocol: "test-cache-v1", requestedState: cacheState });
      },
      async signalSupervisor(receivedAdapter, reason) {
        assert.equal(receivedAdapter, adapter);
        events.push(`signal:${reason}`);
        if (signalSupervisor) await signalSupervisor({ reason, events });
      },
      async completeTerminalEvidence(context) {
        events.push("complete-terminal-evidence");
        return completeTerminalEvidence ? await completeTerminalEvidence({ context, events }) : null;
      }
    }
  };
}

test("one warm trial keeps launch, action, process, notebook, control, and cleanup evidence separate", async () => {
  const harness = createHarness({
    controlTrial: ({ options, events }) => {
      assert.equal(options.cacheState, "warm");
      const authorization = options.authorizeAction();
      events.push("control-complete");
      return Object.freeze({
        protocol: "test-control-v1",
        status: "success",
        runId: RUN_ID,
        phase: PHASE,
        cacheState: "warm",
        abandonedRequest: null,
        authorization
      });
    }
  });
  const authorizationInput = input({
    authorizeAction() {
      harness.events.push("durable-authorization");
      return Object.freeze({ protocol: "test-authorization-v1", runId: RUN_ID });
    }
  });

  const result = await executeDataWranglerComparisonTrial(authorizationInput, harness.dependencies);

  assert.equal(result.protocol, DATA_WRANGLER_COMPARISON_TRIAL_EXECUTOR_PROTOCOL);
  assert.equal(result.status, "evidence");
  assert.equal(result.actionAuthorized, true);
  assert.equal(result.authorizationAttempted, true);
  assert.equal(result.authorizationOutcome, "authorized");
  assert.equal(result.trialBinding.scheduleEntryId, SCHEDULE_ENTRY.id);
  assert.equal(result.trialBinding.preparedIntentSha256.length, 64);
  assert.equal(result.notebookPhaseReceipt.status, "success");
  assert.equal(result.controlReceipt.status, "success");
  assert.equal(result.cacheProof.requestedState, "warm");
  assert.deepEqual(result.processProofs, { protocol: "test-process-proof-v1" });
  assert.equal(result.launchReceipt, harness.launch);
  assert.equal(result.supervisorCompletion, harness.completion);
  assert.equal(result.terminalEvidence, null);
  assert.equal(result.outerEditorFailure, null);
  assert.ok(harness.events.indexOf("cache:warm") < harness.events.indexOf("spawn"));
  assert.ok(harness.events.indexOf("process-proof") < harness.events.indexOf("durable-authorization"));
  assert.ok(harness.events.indexOf("durable-authorization") < harness.events.indexOf("control-complete"));
  assert.equal(harness.events.filter((event) => event === "durable-authorization").length, 1);
  assert.deepEqual(harness.events.slice(-2), ["terminal-receipt", "complete-terminal-evidence"]);
  assert.equal(
    validateDataWranglerComparisonTrialExecutorReceipt(result, {
      validateControlReceipt: (receipt) => receipt
    }),
    result
  );
});

test("cold cache preparation stays behind the controller's source-verification fence", async () => {
  const harness = createHarness({
    runEditorPhase: async ({ events }) => {
      events.push("child-timeout-finished");
      return Object.freeze({ protocol: "test-notebook-phase-v1", status: "failed" });
    }
  });
  harness.dependencies.controlTrial = async (options, dependencies) => {
    harness.events.push("source-verified");
    const cacheProof = await dependencies.evictColdCache({ request: { kind: "cold-cache-evicted" } });
    return Object.freeze({
      protocol: "test-control-v1",
      status: "failed",
      abandonedRequest: Object.freeze({ request: { kind: "measurement-ready" } }),
      coldCacheProof: cacheProof
    });
  };

  const result = await executeDataWranglerComparisonTrial(input({ cacheState: "cold" }), harness.dependencies);

  assert.equal(result.status, "evidence");
  assert.equal(result.cacheProof.requestedState, "cold");
  assert.deepEqual(
    harness.events.filter((event) => event.startsWith("cache:")),
    ["cache:cold:cold-cache-evicted"]
  );
  assert.ok(harness.events.indexOf("source-verified") < harness.events.indexOf("cache:cold:cold-cache-evicted"));
  assert.equal(
    harness.events.some((event) => event.startsWith("signal:")),
    false
  );
});

test("post-terminal cleanup and provenance evidence stays inside the executor receipt", async () => {
  const terminalEvidence = Object.freeze({
    cleanupProof: Object.freeze({ protocol: "test-cleanup-v1" }),
    trialProvenance: Object.freeze({ protocol: "test-provenance-v1" })
  });
  const harness = createHarness({
    completeTerminalEvidence: ({ context, events }) => {
      assert.equal(context.supervisorCompletion, harness.completion);
      assert.equal(context.launchReceipt, harness.launch);
      assert.equal(context.notebookPhaseReceipt.status, "success");
      assert.ok(events.includes("terminal-receipt"));
      return terminalEvidence;
    }
  });

  const result = await executeDataWranglerComparisonTrial(input(), harness.dependencies);

  assert.equal(result.terminalEvidence, terminalEvidence);
});

test("a failed notebook receipt aborts a waiting controller immediately", async () => {
  const harness = createHarness({
    runEditorPhase: () => Object.freeze({ protocol: "test-notebook-phase-v1", status: "failed" }),
    controlTrial: ({ options, events }) =>
      new Promise((resolve) => {
        const finish = () => {
          events.push("control-aborted");
          resolve(Object.freeze({ protocol: "test-control-v1", status: "failed", abandonedRequest: null }));
        };
        options.signal.addEventListener("abort", finish, { once: true });
        if (options.signal.aborted) finish();
      })
  });

  const result = await executeDataWranglerComparisonTrial(input(), harness.dependencies);

  assert.equal(result.notebookPhaseReceipt.status, "failed");
  assert.equal(result.controlReceipt.status, "failed");
  assert.ok(harness.events.includes("control-aborted"));
  assert.equal(
    harness.events.some((event) => event.startsWith("signal:")),
    false
  );
});

test("an abandoned controller request lets the child reach its own bounded bridge failure", async () => {
  const childFinished = deferred();
  const harness = createHarness({
    runEditorPhase: async ({ events }) => {
      await childFinished.promise;
      events.push("child-bounded-timeout");
      return Object.freeze({ protocol: "test-notebook-phase-v1", status: "failed" });
    },
    controlTrial: ({ events }) => {
      events.push("control-abandoned");
      setImmediate(() => childFinished.resolve());
      return Object.freeze({
        protocol: "test-control-v1",
        status: "failed",
        abandonedRequest: Object.freeze({ request: { kind: "inline-baseline" } })
      });
    }
  });

  const result = await executeDataWranglerComparisonTrial(input(), harness.dependencies);

  assert.equal(result.status, "evidence");
  assert.ok(harness.events.indexOf("control-abandoned") < harness.events.indexOf("child-bounded-timeout"));
  assert.equal(
    harness.events.some((event) => event.startsWith("signal:")),
    false
  );
});

test("a controller failure without abandonment terminates the supervisor and returns pre-action evidence", async () => {
  const stopEditor = deferred();
  const harness = createHarness({
    runEditorPhase: async () => {
      await stopEditor.promise;
      throw new Error("private editor failure detail");
    },
    controlTrial: () =>
      Object.freeze({
        protocol: "test-control-v1",
        status: "failed",
        abandonedRequest: null
      }),
    signalSupervisor: () => stopEditor.resolve()
  });

  const result = await executeDataWranglerComparisonTrial(input(), harness.dependencies);

  assert.equal(result.status, "pre-notebook-failure");
  assert.equal(result.actionAuthorized, false);
  assert.equal(result.authorizationAttempted, false);
  assert.equal(result.authorizationOutcome, "not-attempted");
  assert.equal(result.notebookPhaseReceipt, null);
  assert.deepEqual(result.processProofs, {
    editorRoot: { pid: 41, startTimeTicks: "410", capturedAtLaunch: true },
    configuredKernel: null,
    openWranglerRuntime: null
  });
  assert.deepEqual(result.outerEditorFailure, { status: "failed", classification: "error" });
  assert.equal(JSON.stringify(result).includes("private editor failure detail"), false);
  assert.ok(harness.events.includes("signal:trial-control-failed-before-a-retained-abandonment"));
  assert.deepEqual(harness.events.slice(-2), ["terminal-receipt", "complete-terminal-evidence"]);
});

test("post-launch setup failure is path-free and waits for terminal cleanup", async () => {
  const stopEditor = deferred();
  const harness = createHarness({
    runEditorPhase: async () => {
      await stopEditor.promise;
      throw new Error("private editor failure detail");
    },
    createProcessEvidence: () => {
      throw new TypeError("private /proc setup detail");
    },
    signalSupervisor: () => stopEditor.resolve(),
    completeTerminalEvidence: () => ({ cleanupProof: {}, trialProvenance: {} })
  });

  const result = await executeDataWranglerComparisonTrial(input(), harness.dependencies);

  assert.equal(result.status, "post-launch-setup-failure");
  assert.equal(result.controlReceipt, null);
  assert.deepEqual(result.processProofs, {
    editorRoot: { pid: 41, startTimeTicks: "410", capturedAtLaunch: true },
    configuredKernel: null,
    openWranglerRuntime: null
  });
  assert.deepEqual(result.outerEditorFailure, {
    status: "failed",
    classification: "process-evidence-type-error"
  });
  assert.equal(validateDataWranglerComparisonTrialExecutorReceipt(result), result);
  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes("private /proc setup detail"), false);
  assert.equal(serialized.includes("private editor failure detail"), false);
  assert.ok(harness.events.includes("signal:post-launch-setup-failure"));
  assert.deepEqual(harness.events.slice(-2), ["terminal-receipt", "complete-terminal-evidence"]);
});

test("sampler setup failure retains launch proof without inventing a resource observation", async () => {
  const stopEditor = deferred();
  const harness = createHarness({
    runEditorPhase: async () => {
      await stopEditor.promise;
      throw new Error("private editor failure detail");
    },
    signalSupervisor: () => stopEditor.resolve(),
    completeTerminalEvidence: () => ({ cleanupProof: {}, trialProvenance: {} })
  });
  harness.dependencies.createSampler = () => {
    throw new Error("private sampler setup detail");
  };

  const result = await executeDataWranglerComparisonTrial(input(), harness.dependencies);

  assert.equal(result.status, "post-launch-setup-failure");
  assert.equal(result.controlReceipt, null);
  assert.equal(result.authorizationAttempted, false);
  assert.equal(result.authorizationOutcome, "not-attempted");
  assert.deepEqual(result.outerEditorFailure, {
    status: "failed",
    classification: "resource-sampler-error"
  });
  assert.equal(validateDataWranglerComparisonTrialExecutorReceipt(result), result);
  assert.equal(JSON.stringify(result).includes("private sampler setup detail"), false);
});

test("a failed pre-action snapshot returns determinate evidence after verified cleanup", async () => {
  const harness = createHarness({
    runEditorPhase: () => Object.freeze({ protocol: "test-notebook-phase-v1", status: "failed" }),
    createProcessEvidence: ({ events }) =>
      Object.freeze({
        classify: () => "other-owned-child",
        snapshotLaunchProcessProofs() {
          events.push("launch-process-proof");
          return Object.freeze({
            editorRoot: Object.freeze({ pid: 41, startTimeTicks: "410", capturedAtLaunch: true }),
            configuredKernel: null,
            openWranglerRuntime: null
          });
        },
        snapshotPreActionProcessProofs() {
          events.push("pre-action-process-proof");
          throw new TypeError("private pre-action /proc detail");
        },
        snapshotProcessProofs: () => assert.fail("the product action reached its authorization proof")
      }),
    controlTrial: ({ options, events }) =>
      new Promise((resolve) => {
        options.signal.addEventListener(
          "abort",
          () => {
            events.push("control-aborted");
            resolve(
              Object.freeze({
                protocol: "test-control-v1",
                status: "failed",
                runId: RUN_ID,
                phase: PHASE,
                cacheState: "warm",
                authorization: null,
                abandonedRequest: null
              })
            );
          },
          { once: true }
        );
      }),
    completeTerminalEvidence: () => ({ cleanupProof: {}, trialProvenance: {} })
  });

  const result = await executeDataWranglerComparisonTrial(input(), harness.dependencies);

  assert.equal(result.status, "pre-action-process-proof-failure");
  assert.equal(result.notebookPhaseReceipt, null);
  assert.equal(result.controlReceipt.status, "failed");
  assert.equal(result.actionAuthorized, false);
  assert.equal(result.authorizationAttempted, false);
  assert.equal(result.authorizationOutcome, "not-attempted");
  assert.deepEqual(result.processProofs, {
    editorRoot: { pid: 41, startTimeTicks: "410", capturedAtLaunch: true },
    configuredKernel: null,
    openWranglerRuntime: null
  });
  assert.deepEqual(result.outerEditorFailure, {
    status: "failed",
    classification: "pre-action-process-proof-type-error"
  });
  assert.equal(
    validateDataWranglerComparisonTrialExecutorReceipt(result, { validateControlReceipt: (receipt) => receipt }),
    result
  );
  assert.equal(JSON.stringify(result).includes("private pre-action /proc detail"), false);
  assert.ok(harness.events.includes("signal:pre-action-process-proof-failed"));
  assert.deepEqual(harness.events.slice(-2), ["terminal-receipt", "complete-terminal-evidence"]);
});

test("a product-action proof failure cannot fall through to durable authorization", async () => {
  const stopEditor = deferred();
  let durableAuthorizationCalls = 0;
  const harness = createHarness({
    runEditorPhase: async () => {
      await stopEditor.promise;
      throw new Error("editor stopped");
    },
    createProcessEvidence: ({ events }) =>
      Object.freeze({
        classify: () => "other-owned-child",
        snapshotLaunchProcessProofs() {
          return Object.freeze({
            editorRoot: Object.freeze({ pid: 41, startTimeTicks: "410", capturedAtLaunch: true }),
            configuredKernel: null,
            openWranglerRuntime: null
          });
        },
        snapshotPreActionProcessProofs: () => assert.fail("a second process-proof path ran"),
        snapshotProcessProofs() {
          events.push("product-action-process-proof");
          throw new Error("configured kernel disappeared");
        }
      }),
    controlTrial: ({ options }) => {
      assert.throws(() => options.authorizeAction(), /configured kernel disappeared/u);
      return Object.freeze({
        protocol: "test-control-v1",
        status: "failed",
        runId: RUN_ID,
        phase: PHASE,
        cacheState: "warm",
        authorization: null,
        abandonedRequest: null
      });
    },
    signalSupervisor: () => stopEditor.resolve(),
    completeTerminalEvidence: () => ({ cleanupProof: {}, trialProvenance: {} })
  });

  const result = await executeDataWranglerComparisonTrial(
    input({
      authorizeAction() {
        durableAuthorizationCalls += 1;
        return Object.freeze({ protocol: "test-authorization-v1" });
      }
    }),
    harness.dependencies
  );

  assert.equal(result.status, "pre-action-process-proof-failure");
  assert.equal(result.outerEditorFailure.classification, "pre-action-process-proof-error");
  assert.equal(result.authorizationAttempted, false);
  assert.equal(durableAuthorizationCalls, 0);
  assert.equal(
    validateDataWranglerComparisonTrialExecutorReceipt(result, { validateControlReceipt: (receipt) => receipt }),
    result
  );
});

test("authorized action without notebook evidence throws after verified cleanup and cannot be retried", async () => {
  const stopEditor = deferred();
  let authorizations = 0;
  const harness = createHarness({
    runEditorPhase: async () => {
      await stopEditor.promise;
      throw new Error("lost notebook evidence");
    },
    controlTrial: ({ options }) => {
      options.authorizeAction();
      return Object.freeze({ protocol: "test-control-v1", status: "failed", abandonedRequest: null });
    },
    signalSupervisor: () => stopEditor.resolve()
  });

  await assert.rejects(
    executeDataWranglerComparisonTrial(
      input({
        authorizeAction() {
          authorizations += 1;
          return Object.freeze({ protocol: "test-authorization-v1", runId: RUN_ID });
        }
      }),
      harness.dependencies
    ),
    /must not be retried/u
  );
  assert.equal(authorizations, 1);
  assert.ok(harness.events.indexOf("process-proof") < harness.events.indexOf("terminal-receipt"));
  assert.ok(harness.events.includes("signal:trial-control-failed-before-a-retained-abandonment"));
});

test("a journal reinspection recovers an authorization callback that threw after publication", async () => {
  const recoveredAuthorization = Object.freeze({ protocol: "test-authorization-v1", runId: RUN_ID });
  let inspections = 0;
  const harness = createHarness({
    controlTrial: ({ options }) => {
      const authorization = options.authorizeAction();
      return Object.freeze({
        protocol: "test-control-v1",
        status: "success",
        abandonedRequest: null,
        authorization
      });
    }
  });

  const result = await executeDataWranglerComparisonTrial(
    input({
      authorizeAction() {
        throw new Error("post-publication inspection failed");
      },
      reinspectActionAuthorization() {
        inspections += 1;
        return Object.freeze({ status: "authorized", authorization: recoveredAuthorization });
      }
    }),
    harness.dependencies
  );

  assert.equal(inspections, 1);
  assert.equal(result.actionAuthorized, true);
  assert.equal(result.authorizationAttempted, true);
  assert.equal(result.authorizationOutcome, "authorized");
  assert.equal(result.controlReceipt.authorization, recoveredAuthorization);
});

test("an authorization attempt with an unreadable journal stays indeterminate after cleanup", async () => {
  const harness = createHarness({
    controlTrial: ({ options }) => {
      try {
        options.authorizeAction();
      } catch {
        return Object.freeze({ protocol: "test-control-v1", status: "failed", abandonedRequest: null });
      }
      assert.fail("authorization unexpectedly succeeded");
    }
  });

  await assert.rejects(
    executeDataWranglerComparisonTrial(
      input({
        authorizeAction() {
          throw new Error("publication outcome unknown");
        },
        reinspectActionAuthorization() {
          throw new Error("journal unavailable");
        }
      }),
      harness.dependencies
    ),
    /indeterminate/u
  );
  assert.deepEqual(harness.events.slice(-2), ["terminal-receipt", "complete-terminal-evidence"]);
});

test("a malformed authorization result is resolved from the journal before retry classification", async () => {
  let inspections = 0;
  const harness = createHarness({
    controlTrial: ({ options }) => {
      options.authorizeAction();
      return Object.freeze({ protocol: "test-control-v1", status: "failed", abandonedRequest: null });
    }
  });
  harness.dependencies.validateControlReceipt = () => {
    throw new TypeError("authorization evidence is malformed");
  };

  await assert.rejects(
    executeDataWranglerComparisonTrial(
      input({
        authorizeAction: () => Object.freeze({ malformed: true }),
        reinspectActionAuthorization() {
          inspections += 1;
          return Object.freeze({ status: "not-authorized" });
        }
      }),
      harness.dependencies
    ),
    /control failed without publishable raw evidence/u
  );
  assert.equal(inspections, 1);
  assert.deepEqual(harness.events.slice(-2), ["terminal-receipt", "complete-terminal-evidence"]);
});

test("control evidence is validated before its abandonment field affects lifecycle", async () => {
  const stopEditor = deferred();
  const harness = createHarness({
    runEditorPhase: async () => {
      await stopEditor.promise;
      throw new Error("editor stopped");
    },
    controlTrial: () =>
      Object.freeze({
        protocol: "malformed-control",
        status: "failed",
        abandonedRequest: Object.freeze({ request: Object.freeze({ kind: "inline-baseline" }) })
      }),
    signalSupervisor: () => stopEditor.resolve()
  });
  harness.dependencies.validateControlReceipt = () => {
    throw new TypeError("invalid control receipt");
  };

  await assert.rejects(
    executeDataWranglerComparisonTrial(input(), harness.dependencies),
    /control failed without publishable raw evidence/u
  );
  assert.ok(harness.events.includes("signal:trial-control-failed-before-a-retained-abandonment"));
  assert.deepEqual(harness.events.slice(-2), ["terminal-receipt", "complete-terminal-evidence"]);
});

test("warm cache failure happens before any editor or supervisor launch", async () => {
  const harness = createHarness();
  harness.dependencies.prepareSourceCache = async () => {
    throw new Error("cache preparation failed");
  };

  await assert.rejects(executeDataWranglerComparisonTrial(input(), harness.dependencies), /cache preparation failed/u);
  assert.deepEqual(harness.events, []);
});
