import assert from "node:assert/strict";
import test from "node:test";
import {
  DATA_WRANGLER_STUDY_BRIDGE_ACK_PROTOCOL,
  DATA_WRANGLER_STUDY_BRIDGE_ABANDONMENT_PROTOCOL,
  DATA_WRANGLER_STUDY_BRIDGE_REQUEST_PROTOCOL
} from "./data-wrangler-study-control-bridge.mjs";
import { digestStudyValue } from "./data-wrangler-comparison-study.mjs";
import { LINUX_PSS_BASELINE_ACKNOWLEDGEMENT_PROTOCOL } from "./linux-pss-sampler.mjs";
import {
  DATA_WRANGLER_COMPARISON_TERMINAL_DELAY_MS,
  DATA_WRANGLER_COMPARISON_TRIAL_CONTROL_PROTOCOL,
  controlDataWranglerComparisonMeasuredTrial,
  validateDataWranglerComparisonTrialControlReceipt
} from "./data-wrangler-comparison-trial-control.mjs";

const RUN_ID = "11111111-1111-4111-8111-111111111111";
const PHASE = "comparison-study-open-wrangler-trial";
const WARM_KINDS = [
  "source-verified",
  "measurement-ready",
  "sampling-origin",
  "inline-baseline",
  "workbench-baseline",
  "profile-baseline",
  "sampling-stop",
  "cleanup-census"
];
const COLD_KINDS = ["source-verified", "cold-cache-evicted", ...WARM_KINDS.slice(1)];
const MILLISECOND_NS = 1_000_000n;

test("warm control fences the first actions, releases profiling immediately, and retains the terminal sample", async () => {
  const harness = createHarness(WARM_KINDS);
  const receipt = await runControl(harness, {
    cacheState: "warm",
    authorizeAction: () => {
      harness.events.push("authorize:inline-baseline");
      return authorizationReceipt();
    }
  });

  assert.equal(receipt.protocol, DATA_WRANGLER_COMPARISON_TRIAL_CONTROL_PROTOCOL);
  assert.equal(receipt.status, "success");
  assert.equal(receipt.failure, null);
  assert.equal(receipt.cacheState, "warm");
  assert.equal(receipt.pendingRequest, null);
  assert.equal(receipt.abandonedRequest, null);
  assert.equal(receipt.coldCacheProof, null);
  assert.deepEqual(
    WARM_KINDS.map((kind) => [receiptForKind(receipt, kind).request.sequence, kind]),
    WARM_KINDS.map((kind, sequence) => [sequence, kind])
  );
  for (const baseline of [receipt.baselines.inline, receipt.baselines.workbench]) {
    assert.equal(baseline.receipt.stableBaseline.sampleCount, 5);
    assert.ok(
      BigInt(baseline.receipt.stableBaseline.lastEndedMonotonicNanoseconds) >=
        BigInt(baseline.request.monotonicNanoseconds)
    );
    assert.ok(
      BigInt(baseline.acknowledgement.monotonicNanoseconds) >=
        BigInt(baseline.receipt.stableBaseline.lastEndedMonotonicNanoseconds)
    );
  }
  assert.equal(receipt.baselines.profile.receipt, null);
  assert.notEqual(receipt.baselines.profile.acknowledgement, null);
  assert.equal(harness.events.includes("stable:profile-baseline"), false);
  assert.ok(
    eventIndex(harness.events, "request:profile-baseline") < eventIndex(harness.events, "ack:profile-baseline")
  );
  assert.ok(
    eventIndex(harness.events, "ack:profile-baseline") < eventIndex(harness.events, "child-action:profile-baseline")
  );
  assert.ok(
    eventIndex(harness.events, "stable:inline-baseline") < eventIndex(harness.events, "authorize:inline-baseline")
  );
  assert.ok(
    eventIndex(harness.events, "authorize:inline-baseline") < eventIndex(harness.events, "ack:inline-baseline")
  );
  assert.ok(
    eventIndex(harness.events, "ack:inline-baseline") < eventIndex(harness.events, "child-action:inline-baseline")
  );

  const expectedTerminal =
    BigInt(receipt.samplingStop.request.monotonicNanoseconds) +
    BigInt(DATA_WRANGLER_COMPARISON_TERMINAL_DELAY_MS) * MILLISECOND_NS;
  assert.equal(receipt.samplingStop.terminalTargetMonotonicNanoseconds, expectedTerminal.toString());
  assert.equal(receipt.resourceObservation.terminalBoundary.targetMonotonicNanoseconds, expectedTerminal.toString());
  assert.ok(
    BigInt(receipt.samplingStop.acknowledgement.monotonicNanoseconds) >=
      BigInt(receipt.resourceObservation.terminalBoundary.firstEligibleSampleEndedMonotonicNanoseconds)
  );
  assert.equal("supervisorTerminalReceipt" in receipt, false);
  assert.equal(receipt.completedExchanges.at(-1).request.kind, "cleanup-census");
  assert.equal(
    eventIndex(harness.events, "collector-terminal") < eventIndex(harness.events, "ack:sampling-stop"),
    true
  );
  assert.deepEqual(validateDataWranglerComparisonTrialControlReceipt(receipt), receipt);
  assert.equal(Object.isFrozen(receipt.resourceObservation.samples[0].processes[0]), true);
});

test("cold measured control evicts after source verification and before its acknowledgement", async () => {
  const harness = createHarness(COLD_KINDS);
  let evictions = 0;
  const receipt = await runControl(harness, {
    cacheState: "cold",
    evictColdCache: async ({ request }) => {
      evictions += 1;
      harness.events.push(`evict:${request.kind}`);
      return { protocol: "test-cache-proof-v1", requestedState: "evicted", verified: true };
    },
    authorizeAction: () => authorizationReceipt()
  });

  assert.equal(evictions, 1);
  assert.equal(receipt.status, "success");
  assert.equal(receiptForKind(receipt, "cold-cache-evicted").request.kind, "cold-cache-evicted");
  assert.equal(receipt.coldCacheProof.requestedState, "evicted");
  assert.ok(eventIndex(harness.events, "ack:source-verified") < eventIndex(harness.events, "evict:cold-cache-evicted"));
  assert.ok(
    eventIndex(harness.events, "evict:cold-cache-evicted") < eventIndex(harness.events, "ack:cold-cache-evicted")
  );
});

test("sequence drift and a duplicate inline authorization request fail closed", async (t) => {
  await t.test("warm child inserts the cold-only request", async () => {
    const harness = createHarness(["source-verified", "cold-cache-evicted"]);
    await assert.rejects(
      runControl(harness, { cacheState: "warm", authorizeAction: () => authorizationReceipt() }),
      (error) => aggregateContains(error, /expected measurement-ready/u)
    );
    assert.equal(harness.events.includes("ack:cold-cache-evicted"), false);
  });

  await t.test("child repeats inline-baseline after durable authorization", async () => {
    const kinds = [...WARM_KINDS];
    kinds[4] = "inline-baseline";
    const harness = createHarness(kinds);
    let authorizations = 0;
    await assert.rejects(
      runControl(harness, {
        cacheState: "warm",
        authorizeAction: () => {
          authorizations += 1;
          return authorizationReceipt();
        }
      }),
      (error) => aggregateContains(error, /request state is indeterminate/u)
    );
    assert.equal(authorizations, 1);
    assert.equal(harness.events.filter((event) => event === "ack:inline-baseline").length, 1);
  });
});

test("a pre-origin source timeout retains an explicitly invalid early-sampling receipt", async () => {
  const harness = createHarness(WARM_KINDS, { suppressRequestKind: "source-verified" });
  const receipt = await runControl(harness, {
    cacheState: "warm",
    authorizeAction: () => authorizationReceipt(),
    requestTimeoutMs: 15
  });
  assertFailedReceipt(receipt, "source-verified", "timeout");
  assert.deepEqual(completedKinds(receipt), []);
  assert.equal(receipt.abandonedRequest, null);
  assert.equal(receipt.resourceObservation.valid, false);
  assert.equal(receipt.resourceObservation.reasonClass, "resource-sampling");
  assert.equal(harness.events.includes("collector-abort"), true);
});

test("a request accepted concurrently with abort is abandoned exactly instead of becoming stale", async () => {
  const controller = new AbortController();
  const harness = createHarness(WARM_KINDS, {
    onRequest: (kind) => {
      if (kind === "source-verified") controller.abort("laptop-shutdown");
    }
  });
  const receipt = await runControl(harness, {
    cacheState: "warm",
    signal: controller.signal,
    authorizeAction: () => authorizationReceipt()
  });
  assertFailedReceipt(receipt, "source-verified", "aborted");
  assert.deepEqual(completedKinds(receipt), []);
  assert.equal(receipt.abandonedRequest.request.kind, "source-verified");
  assert.equal(harness.events.includes("ack:source-verified"), false);
  assert.equal(harness.events.includes("abandon:source-verified"), true);
  assert.equal(receipt.resourceObservation.valid, false);
});

test("an unstable blocking baseline returns the validated partial receipt accumulated before timeout", async (t) => {
  const cases = [
    {
      kind: "inline-baseline",
      completed: WARM_KINDS.slice(0, 3),
      retained: [],
      authorized: false
    },
    {
      kind: "workbench-baseline",
      completed: WARM_KINDS.slice(0, 4),
      retained: ["inline"],
      authorized: true
    }
  ];
  for (const scenario of cases) {
    await t.test(scenario.kind, async () => {
      const harness = createHarness(WARM_KINDS, { suppressBaselineKind: scenario.kind });
      let authorizations = 0;
      const receipt = await runControl(harness, {
        cacheState: "warm",
        authorizeAction: () => {
          authorizations += 1;
          return authorizationReceipt();
        },
        baselineTimeoutMs: 15
      });
      assertFailedReceipt(receipt, scenario.kind, "timeout");
      assert.deepEqual(completedKinds(receipt), scenario.completed);
      assert.equal(receipt.pendingRequest, null);
      assert.equal(receipt.abandonedRequest.request.kind, scenario.kind);
      assert.equal(receipt.abandonedRequest.abandonment.kind, scenario.kind);
      assert.equal(receipt.resourceObservation.valid, false);
      assert.equal(receipt.resourceObservation.reasonClass, "resource-sampling");
      assert.equal(authorizations, Number(scenario.authorized));
      for (const retained of scenario.retained) {
        assert.equal(receipt.baselines[retained].receipt.stableBaseline.sampleCount, 5);
        assert.notEqual(receipt.baselines[retained].acknowledgement, null);
      }
      const pendingBaseline = { inline: "inline-baseline", workbench: "workbench-baseline" };
      const key = Object.entries(pendingBaseline).find(([, kind]) => kind === scenario.kind)[0];
      assert.equal(receipt.baselines[key].request.kind, scenario.kind);
      assert.equal(receipt.baselines[key].acknowledgement, null);
      assert.equal(receipt.baselines[key].receipt, null);
      assert.equal(harness.events.includes(`ack:${scenario.kind}`), false);
      assert.equal(harness.events.includes(`abandon:${scenario.kind}`), true);
      assert.equal(harness.events.includes("collector-abort"), true);
    });
  }
});

test("authorization must finish durably and synchronously before the inline acknowledgement", async () => {
  const harness = createHarness(WARM_KINDS);
  const receipt = await runControl(harness, {
    cacheState: "warm",
    authorizeAction: () => Promise.resolve(authorizationReceipt())
  });
  assertFailedReceipt(receipt, "inline-baseline", "authorization");
  assert.deepEqual(completedKinds(receipt), WARM_KINDS.slice(0, 3));
  assert.equal(receipt.pendingRequest, null);
  assert.equal(receipt.abandonedRequest.request.kind, "inline-baseline");
  assert.notEqual(receipt.baselines.inline.receipt, null);
  assert.equal(receipt.baselines.inline.acknowledgement, null);
  assert.equal(receipt.authorization, null);
  assert.equal(harness.events.includes("ack:inline-baseline"), false);
  assert.equal(harness.events.includes("child-action:inline-baseline"), false);
});

test("an abort raised during durable authorization cannot publish the inline acknowledgement", async () => {
  const controller = new AbortController();
  const harness = createHarness(WARM_KINDS);
  const receipt = await runControl(harness, {
    cacheState: "warm",
    signal: controller.signal,
    authorizeAction: () => {
      controller.abort("laptop-shutdown");
      return authorizationReceipt();
    }
  });
  assertFailedReceipt(receipt, "inline-baseline", "aborted");
  assert.notEqual(receipt.authorization, null);
  assert.equal(receipt.abandonedRequest.request.kind, "inline-baseline");
  assert.equal(harness.events.includes("ack:inline-baseline"), false);
  assert.equal(harness.events.includes("child-action:inline-baseline"), false);
});

test("an abandonment failure throws instead of publishing unsafe partial evidence", async () => {
  const harness = createHarness(WARM_KINDS, {
    suppressBaselineKind: "inline-baseline",
    abandonThrowsKind: "inline-baseline"
  });
  await assert.rejects(
    runControl(harness, {
      cacheState: "warm",
      authorizeAction: () => authorizationReceipt(),
      baselineTimeoutMs: 15
    }),
    (error) => aggregateContains(error, /could not abandon its exact unacknowledged bridge request/u)
  );
  assert.equal(harness.events.includes("ack:inline-baseline"), false);
  assert.equal(harness.events.includes("child-action:inline-baseline"), false);
  assert.equal(harness.events.includes("collector-abort"), true);
});

test("an indeterminate acknowledgement publication throws instead of claiming an abandoned request", async () => {
  const harness = createHarness(WARM_KINDS, { acknowledgeThrowsKind: "measurement-ready" });
  await assert.rejects(
    runControl(harness, {
      cacheState: "warm",
      authorizeAction: () => authorizationReceipt()
    }),
    (error) => aggregateContains(error, /acknowledgement publication is indeterminate/u)
  );
  assert.equal(harness.events.includes("ack-attempt:measurement-ready"), true);
  assert.equal(harness.events.includes("abandon:measurement-ready"), false);
  assert.equal(harness.events.includes("collector-abort"), true);
});

test("sampler invalidity and terminal evidence mismatches prevent their acknowledgements", async (t) => {
  await t.test("collector ends invalid before sampling-origin acknowledgement", async () => {
    const harness = createHarness(WARM_KINDS, { settleInvalidImmediately: true });
    const receipt = await runControl(harness, {
      cacheState: "warm",
      authorizeAction: () => authorizationReceipt()
    });
    assertFailedReceipt(receipt, "sampling-start", "sampler-invalid");
    assert.deepEqual(completedKinds(receipt), []);
    assert.equal(receipt.pendingRequest, null);
    assert.equal(receipt.abandonedRequest, null);
    assert.equal(receipt.resourceObservation.valid, false);
    assert.equal(harness.events.includes("ack:sampling-origin"), false);
  });

  await t.test("terminal target differs from sampling-stop plus two seconds", async () => {
    const harness = createHarness(WARM_KINDS, { corruptTerminalTarget: true });
    const receipt = await runControl(harness, {
      cacheState: "warm",
      authorizeAction: () => authorizationReceipt()
    });
    assertFailedReceipt(receipt, "sampling-stop", "collector-mismatch");
    assert.deepEqual(completedKinds(receipt), WARM_KINDS.slice(0, 6));
    assert.equal(receipt.pendingRequest, null);
    assert.equal(receipt.abandonedRequest.request.kind, "sampling-stop");
    assert.equal(receipt.resourceObservation.valid, true);
    assert.equal(harness.events.includes("ack:sampling-stop"), false);
  });

  await t.test("retained baseline does not match final collector samples", async () => {
    const harness = createHarness(WARM_KINDS, { corruptBaselineSample: true });
    const receipt = await runControl(harness, {
      cacheState: "warm",
      authorizeAction: () => authorizationReceipt()
    });
    assertFailedReceipt(receipt, "sampling-stop", "collector-mismatch");
    assert.deepEqual(completedKinds(receipt), WARM_KINDS.slice(0, 6));
    assert.equal(receipt.pendingRequest, null);
    assert.equal(receipt.abandonedRequest.request.kind, "sampling-stop");
    assert.equal(receipt.resourceObservation.valid, true);
    assert.equal(harness.events.includes("ack:sampling-stop"), false);
  });
});

test("a laptop-shutdown abort cancels sampling and never releases the pending action fence", async () => {
  const controller = new AbortController();
  const harness = createHarness(WARM_KINDS, {
    suppressBaselineKind: "inline-baseline",
    onRequest: (kind) => {
      if (kind === "inline-baseline") setTimeout(() => controller.abort("laptop-shutdown"), 0);
    }
  });
  let authorized = false;
  const receipt = await runControl(harness, {
    cacheState: "warm",
    signal: controller.signal,
    authorizeAction: () => {
      authorized = true;
      return authorizationReceipt();
    }
  });
  assertFailedReceipt(receipt, "inline-baseline", "aborted");
  assert.deepEqual(completedKinds(receipt), WARM_KINDS.slice(0, 3));
  assert.equal(receipt.pendingRequest, null);
  assert.equal(receipt.abandonedRequest.request.kind, "inline-baseline");
  assert.equal(receipt.resourceObservation.valid, false);
  assert.equal(authorized, false);
  assert.equal(harness.events.includes("ack:inline-baseline"), false);
  assert.equal(harness.events.includes("collector-abort"), true);
});

function runControl(
  harness,
  {
    cacheState,
    authorizeAction,
    evictColdCache,
    signal = new AbortController().signal,
    requestTimeoutMs = 100,
    baselineTimeoutMs = 100
  }
) {
  return controlDataWranglerComparisonMeasuredTrial(
    {
      requestPath: "/unused/request.json",
      acknowledgementPath: "/unused/ack.json",
      runId: RUN_ID,
      phase: PHASE,
      cacheState,
      sampler: { kind: "fake-sampler" },
      authorizeAction,
      signal
    },
    {
      createResponder: () => harness.responder,
      collectObservation: harness.collectObservation,
      evictColdCache,
      requestTimeoutMs,
      baselineTimeoutMs,
      terminalTimeoutMs: 100,
      abortSettlementTimeoutMs: 100
    }
  );
}

function createHarness(kinds, options = {}) {
  const events = [];
  const clock = { now: 1_000_000_000_000n };
  let collector;
  let requestIndex = 0;
  const accepted = new WeakSet();
  const responder = {
    async waitForRequest(expectedSequence, expectedKind, signal) {
      if (options.suppressRequestKind === expectedKind) {
        return new Promise((_, reject) => {
          const rejectAbort = () =>
            reject(Object.assign(new Error("Fake responder wait aborted."), { code: "aborted" }));
          signal.addEventListener("abort", rejectAbort, { once: true });
          if (signal.aborted) rejectAbort();
        });
      }
      const actualKind = kinds[requestIndex];
      if (actualKind !== expectedKind || requestIndex !== expectedSequence) {
        throw new Error(
          `Fake child sequence drift: expected ${expectedKind} at ${expectedSequence}, received ${actualKind} at ${requestIndex}.`
        );
      }
      clock.now += 100n * MILLISECOND_NS;
      const request = bridgeEnvelope(DATA_WRANGLER_STUDY_BRIDGE_REQUEST_PROTOCOL, requestIndex, actualKind, clock.now);
      requestIndex += 1;
      accepted.add(request);
      events.push(`request:${actualKind}`);
      options.onRequest?.(actualKind, request);
      if (
        actualKind.endsWith("-baseline") &&
        actualKind !== "profile-baseline" &&
        actualKind !== options.suppressBaselineKind
      ) {
        collector?.emitBaseline(request);
      }
      if (actualKind === "sampling-stop") collector?.scheduleTerminal();
      return request;
    },
    acknowledge(request) {
      assert.equal(accepted.has(request), true);
      if (request.kind === options.acknowledgeThrowsKind) {
        events.push(`ack-attempt:${request.kind}`);
        throw new Error("Injected acknowledgement publication uncertainty.");
      }
      accepted.delete(request);
      clock.now += MILLISECOND_NS;
      events.push(`ack:${request.kind}`);
      const acknowledgement = bridgeEnvelope(
        DATA_WRANGLER_STUDY_BRIDGE_ACK_PROTOCOL,
        request.sequence,
        request.kind,
        clock.now
      );
      if (["inline-baseline", "profile-baseline"].includes(request.kind)) {
        events.push(`child-action:${request.kind}`);
      }
      return acknowledgement;
    },
    abandon(request) {
      assert.equal(accepted.has(request), true);
      if (request.kind === options.abandonThrowsKind) throw new Error("Injected abandonment failure.");
      accepted.delete(request);
      clock.now += MILLISECOND_NS;
      events.push(`abandon:${request.kind}`);
      return {
        protocol: DATA_WRANGLER_STUDY_BRIDGE_ABANDONMENT_PROTOCOL,
        runId: request.runId,
        phase: request.phase,
        sequence: request.sequence,
        kind: request.kind,
        requestMonotonicNanoseconds: request.monotonicNanoseconds,
        abandonedMonotonicNanoseconds: clock.now.toString()
      };
    }
  };
  const collectObservation = (arguments_) => {
    collector = createFakeCollector(arguments_, events, clock, options);
    if (options.settleInvalidImmediately) {
      return Promise.resolve(resourceObservation({ valid: false, missedSamples: 1, samples: [] }));
    }
    return collector.promise;
  };
  return { events, responder, collectObservation };
}

function createFakeCollector({ signal, intervalMs, onSample, getTerminalBoundaryNanoseconds }, events, clock, options) {
  assert.equal(intervalMs, 200);
  const samples = [];
  let settled = false;
  let resolveCollection;
  const promise = new Promise((resolve) => {
    resolveCollection = resolve;
  });
  const settle = (observation) => {
    if (settled) return;
    settled = true;
    resolveCollection(observation);
  };
  const emitSample = () => {
    const scheduled = PSS_ORIGIN_NANOSECONDS + BigInt(samples.length * 200) * MILLISECOND_NS;
    const started = scheduled + MILLISECOND_NS;
    const ended = started + MILLISECOND_NS;
    clock.now = clock.now > ended ? clock.now : ended;
    const sample = pssSample(scheduled, started, ended);
    samples.push(sample);
    return sample;
  };
  signal.addEventListener(
    "abort",
    () => {
      events.push("collector-abort");
      settle(resourceObservation({ valid: false, missedSamples: 1, samples }));
    },
    { once: true }
  );
  return {
    promise,
    emitBaseline(request) {
      for (let offset = 0; offset < 5; offset += 1) {
        emitSample();
        const receipt = baselineReceipt(samples, offset === 4);
        onSample(receipt);
      }
      assert.ok(BigInt(samples.at(-1).endedMonotonicNanoseconds) >= BigInt(request.monotonicNanoseconds));
      events.push(`stable:${request.kind}`);
    },
    scheduleTerminal() {
      setTimeout(() => {
        const target = getTerminalBoundaryNanoseconds();
        if (target === null) {
          this.scheduleTerminal();
          return;
        }
        let terminalSample;
        do {
          terminalSample = emitSample();
          onSample(baselineReceipt(samples, true));
        } while (BigInt(terminalSample.startedMonotonicNanoseconds) < target);
        const observationSamples = structuredClone(samples);
        if (options.corruptBaselineSample) {
          const sample = observationSamples[4];
          sample.totalPssBytes += 1_024;
          sample.totalRssBytes += 1_024;
          sample.categories["editor-main"] += 1_024;
          sample.processes[0].pssBytes += 1_024;
          sample.processes[0].rssBytes += 1_024;
        }
        const retainedTarget = options.corruptTerminalTarget ? target + MILLISECOND_NS : target;
        const scheduled = BigInt(terminalSample.scheduledMonotonicNanoseconds);
        const started = BigInt(terminalSample.startedMonotonicNanoseconds);
        const ended = BigInt(terminalSample.endedMonotonicNanoseconds);
        events.push("collector-terminal");
        settle(
          resourceObservation({
            valid: true,
            missedSamples: 0,
            samples: observationSamples,
            terminalBoundary: {
              targetMonotonicNanoseconds: retainedTarget.toString(),
              firstEligibleSampleScheduledMonotonicNanoseconds: scheduled.toString(),
              firstEligibleSampleStartedMonotonicNanoseconds: started.toString(),
              firstEligibleSampleEndedMonotonicNanoseconds: ended.toString(),
              startOvershootMs: Number(started - retainedTarget) / Number(MILLISECOND_NS),
              sampleLatenessMs: 1,
              maximumOvershootMs: 250
            }
          })
        );
      }, 0);
    }
  };
}

function pssSample(scheduled, started, ended) {
  const pssBytes = 100 * 1024 * 1024;
  return {
    scheduledMonotonicNanoseconds: scheduled.toString(),
    startedMonotonicNanoseconds: started.toString(),
    endedMonotonicNanoseconds: ended.toString(),
    latenessMs: 1,
    elapsedMs: Number(ended - PSS_ORIGIN_NANOSECONDS) / Number(MILLISECOND_NS),
    totalPssBytes: pssBytes,
    totalRssBytes: pssBytes + 1_024,
    categories: {
      "editor-main": pssBytes,
      "renderer-gpu": 0,
      "extension-host": 0,
      "configured-kernel": 0,
      "open-wrangler-runtime": 0,
      "other-owned-child": 0
    },
    processes: [
      {
        pid: 100,
        startTimeTicks: "12345",
        category: "editor-main",
        pssBytes,
        rssBytes: pssBytes + 1_024
      }
    ]
  };
}

const PSS_ORIGIN_NANOSECONDS = 1_000_000_000_000n;

function resourceObservation({ valid, missedSamples, samples, terminalBoundary = null }) {
  return {
    protocol: "openwrangler-linux-pss-observation-v1",
    clock: {
      source: "linux-process-hrtime-bigint",
      originNanoseconds: PSS_ORIGIN_NANOSECONDS.toString(),
      normalization: "elapsedMs=(endedMonotonicNanoseconds-originNanoseconds)/1000000"
    },
    ownershipTracker: pssOwnershipTracker(),
    valid,
    reasonClass: valid ? null : "resource-sampling",
    intervalMs: 200,
    maximumLatenessMs: 50,
    missedSamples,
    terminalBoundary,
    retainedOwnedIdentities: [{ pid: 100, startTimeTicks: "12345" }],
    samples
  };
}

function pssOwnershipTracker() {
  return {
    protocol: "openwrangler-linux-study-supervisor-v1",
    kind: "launch",
    nonce: "d".repeat(64),
    supervisor: { pid: 99, startTimeTicks: "12344", subreaperVerified: true, pidfdVerified: true },
    editorRoot: { pid: 100, startTimeTicks: "12345", processGroupId: 100, sessionId: 100 },
    supervisorSource: {
      sha256: "a".repeat(64),
      filesystemIdentity: { device: "8", inode: "42", sizeBytes: 125_000, mtimeNs: "1000000000" }
    },
    pythonExecutable: {
      implementation: "CPython",
      version: "3.12.10",
      sha256: "b".repeat(64),
      filesystemIdentity: { device: "8", inode: "43", sizeBytes: 6_000_000, mtimeNs: "1000000000" }
    },
    invocationPolicySha256: "c".repeat(64),
    invocationSha256: "0".repeat(64),
    payloadArgvSha256: "e".repeat(64),
    payloadEnvironmentSha256: "f".repeat(64)
  };
}

function baselineReceipt(samples, stable) {
  const sample = samples.at(-1);
  const sampleIndex = samples.length - 1;
  return {
    protocol: LINUX_PSS_BASELINE_ACKNOWLEDGEMENT_PROTOCOL,
    sampleIndex,
    sampleElapsedMs: sample.elapsedMs,
    sampleScheduledMonotonicNanoseconds: sample.scheduledMonotonicNanoseconds,
    sampleStartedMonotonicNanoseconds: sample.startedMonotonicNanoseconds,
    sampleEndedMonotonicNanoseconds: sample.endedMonotonicNanoseconds,
    stableBaseline: stable
      ? {
          sampleCount: 5,
          firstSampleIndex: sampleIndex - 4,
          lastSampleIndex: sampleIndex,
          firstStartedMonotonicNanoseconds: samples.at(-5).startedMonotonicNanoseconds,
          lastEndedMonotonicNanoseconds: sample.endedMonotonicNanoseconds,
          medianPssBytes: 100 * 1024 * 1024,
          rangePssBytes: 0,
          maximumRangePssBytes: 64 * 1024 * 1024
        }
      : null
  };
}

function bridgeEnvelope(protocol, sequence, kind, monotonicNanoseconds) {
  return {
    protocol,
    runId: RUN_ID,
    phase: PHASE,
    sequence,
    kind,
    monotonicNanoseconds: monotonicNanoseconds.toString()
  };
}

function authorizationReceipt() {
  const intent = {
    stage: "action-authorized",
    runId: RUN_ID,
    scheduleEntryId: "warm-pandas-parquet-r01-ow",
    effectiveBlockId: "warm-pandas-parquet-r01-b01~a00"
  };
  return {
    intent,
    publication: { sha256: digestStudyValue(intent), status: "published" }
  };
}

function receiptForKind(receipt, kind) {
  return receipt.completedExchanges.find((exchange) => exchange.request.kind === kind);
}

function completedKinds(receipt) {
  return receipt.completedExchanges.map((exchange) => exchange.request.kind);
}

function assertFailedReceipt(receipt, stage, kind) {
  assert.equal(receipt.protocol, DATA_WRANGLER_COMPARISON_TRIAL_CONTROL_PROTOCOL);
  assert.equal(receipt.status, "failed");
  assert.deepEqual(receipt.failure, { stage, kind });
}

function aggregateContains(error, pattern) {
  return error instanceof AggregateError && error.errors.some((candidate) => pattern.test(candidate.message));
}

function eventIndex(events, value) {
  const index = events.indexOf(value);
  assert.notEqual(index, -1, `missing event ${value}: ${events.join(", ")}`);
  return index;
}
