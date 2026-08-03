import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { canonicalDurableJson } from "./durable-study-json.mjs";
import {
  DATA_WRANGLER_STUDY_BRIDGE_ACK_PROTOCOL,
  DATA_WRANGLER_STUDY_BRIDGE_ABANDONMENT_PROTOCOL,
  DATA_WRANGLER_STUDY_BRIDGE_ENVIRONMENT,
  DATA_WRANGLER_STUDY_BRIDGE_REQUEST_PROTOCOL,
  createDataWranglerStudyBridgeAcknowledgement,
  createDataWranglerStudyBridgeController,
  createDataWranglerStudyBridgeEnvironment,
  createDataWranglerStudyBridgeRequest,
  createDataWranglerStudyBridgeResponder,
  validateDataWranglerStudyBridgeAcknowledgement,
  validateDataWranglerStudyBridgeRequest
} from "./data-wrangler-study-control-bridge.mjs";

const RUN_ID = "12345678-1234-4123-8123-123456789abc";
const PHASE = "comparison-study-open-wrangler-trial";

test("study bridge envelopes carry one strict protocol and correlation shape", () => {
  const request = createDataWranglerStudyBridgeRequest({
    runId: RUN_ID,
    phase: PHASE,
    sequence: 3,
    kind: "profile-baseline",
    monotonicNanoseconds: "1000"
  });
  assert.deepEqual(validateDataWranglerStudyBridgeRequest(request), request);
  assert.equal(request.protocol, DATA_WRANGLER_STUDY_BRIDGE_REQUEST_PROTOCOL);
  const acknowledgement = createDataWranglerStudyBridgeAcknowledgement({
    ...request,
    monotonicNanoseconds: "1100"
  });
  assert.equal(acknowledgement.protocol, DATA_WRANGLER_STUDY_BRIDGE_ACK_PROTOCOL);
  assert.deepEqual(validateDataWranglerStudyBridgeAcknowledgement(acknowledgement), acknowledgement);
  assert.throws(
    () => validateDataWranglerStudyBridgeRequest({ ...request, extra: true }),
    /missing or unknown fields/u
  );
  assert.throws(
    () => validateDataWranglerStudyBridgeAcknowledgement({ ...acknowledgement, protocol: request.protocol }),
    /wrong protocol version/u
  );
  assert.throws(
    () => createDataWranglerStudyBridgeRequest({ ...request, kind: "arbitrary-checkpoint" }),
    /fixed handshake protocol/u
  );
});

test("controller and responder complete ordered handshakes and consume both files", async () => {
  await withBridgeDirectory(async ({ requestPath, acknowledgementPath }) => {
    const controllerClock = valuesClock([100n, 300n]);
    const responderClock = valuesClock([200n, 400n]);
    const controller = createDataWranglerStudyBridgeController(
      { requestPath, acknowledgementPath, runId: RUN_ID, phase: PHASE },
      { clock: controllerClock, pollIntervalMs: 1 }
    );
    const responder = createDataWranglerStudyBridgeResponder(
      { requestPath, acknowledgementPath, runId: RUN_ID, phase: PHASE },
      { clock: responderClock, pollIntervalMs: 1 }
    );

    const firstExchange = controller.exchange("measurement-ready");
    const firstRequest = await responder.waitForRequest(0, "measurement-ready");
    const firstAcknowledgement = responder.acknowledge(firstRequest);
    const first = await firstExchange;
    assert.deepEqual(first.request, firstRequest);
    assert.deepEqual(first.acknowledgement, firstAcknowledgement);
    assert.equal(controller.nextSequence(), 1);
    assert.equal(existsSync(requestPath), false);
    assert.equal(existsSync(acknowledgementPath), false);

    const secondExchange = controller.exchange("inline-baseline");
    const secondRequest = await responder.waitForRequest(1, "inline-baseline");
    responder.acknowledge(secondRequest);
    await secondExchange;
    assert.equal(controller.nextSequence(), 2);
    controller.close();
  });
});

test("controller fails on stale acknowledgements and a regressing monotonic clock", async (t) => {
  await t.test("stale sequence", async () => {
    await withBridgeDirectory(async ({ requestPath, acknowledgementPath }) => {
      const controller = createDataWranglerStudyBridgeController(
        { requestPath, acknowledgementPath, runId: RUN_ID, phase: PHASE },
        { clock: () => 100n, pollIntervalMs: 1 }
      );
      const exchange = controller.exchange("sampling-origin");
      await waitUntil(() => existsSync(requestPath));
      writeFileSync(
        acknowledgementPath,
        canonicalDurableJson(
          createDataWranglerStudyBridgeAcknowledgement({
            runId: RUN_ID,
            phase: PHASE,
            sequence: 1,
            kind: "sampling-origin",
            monotonicNanoseconds: "200"
          })
        ),
        { mode: 0o600, flag: "wx" }
      );
      await assert.rejects(exchange, /stale, out of order/u);
    });
  });

  await t.test("clock regression", async () => {
    await withBridgeDirectory(async ({ requestPath, acknowledgementPath }) => {
      const controller = createDataWranglerStudyBridgeController(
        { requestPath, acknowledgementPath, runId: RUN_ID, phase: PHASE },
        { clock: () => 300n, pollIntervalMs: 1 }
      );
      const exchange = controller.exchange("sampling-origin");
      await waitUntil(() => existsSync(requestPath));
      writeFileSync(
        acknowledgementPath,
        canonicalDurableJson(
          createDataWranglerStudyBridgeAcknowledgement({
            runId: RUN_ID,
            phase: PHASE,
            sequence: 0,
            kind: "sampling-origin",
            monotonicNanoseconds: "299"
          })
        ),
        { mode: 0o600, flag: "wx" }
      );
      await assert.rejects(exchange, /predates its request/u);
    });
  });
});

test("controller rejects acknowledgements that cross its deadline", async (t) => {
  await t.test("present before a late poll", async () => {
    await withBridgeDirectory(async ({ requestPath, acknowledgementPath }) => {
      const controller = createDataWranglerStudyBridgeController(
        { requestPath, acknowledgementPath, runId: RUN_ID, phase: PHASE },
        {
          clock: () => 200n,
          now: valuesNumberClock([0, 1, 2, 100]),
          timeoutMs: 100,
          pollIntervalMs: 1,
          wait: async () => {
            writeFileSync(
              acknowledgementPath,
              canonicalDurableJson(
                createDataWranglerStudyBridgeAcknowledgement({
                  runId: RUN_ID,
                  phase: PHASE,
                  sequence: 0,
                  kind: "sampling-origin",
                  monotonicNanoseconds: "300"
                })
              ),
              { mode: 0o600, flag: "wx" }
            );
          }
        }
      );
      await assert.rejects(controller.exchange("sampling-origin"), /within 100 ms/u);
    });
  });

  await t.test("becomes late while it is read", async () => {
    await withBridgeDirectory(async ({ requestPath, acknowledgementPath }) => {
      let call = 0;
      const controller = createDataWranglerStudyBridgeController(
        { requestPath, acknowledgementPath, runId: RUN_ID, phase: PHASE },
        {
          clock: () => 200n,
          now: () => {
            call += 1;
            if (call === 2) {
              writeFileSync(
                acknowledgementPath,
                canonicalDurableJson(
                  createDataWranglerStudyBridgeAcknowledgement({
                    runId: RUN_ID,
                    phase: PHASE,
                    sequence: 0,
                    kind: "sampling-origin",
                    monotonicNanoseconds: "300"
                  })
                ),
                { mode: 0o600, flag: "wx" }
              );
            }
            return call === 1 ? 0 : call === 2 ? 1 : 100;
          },
          timeoutMs: 100,
          pollIntervalMs: 1
        }
      );
      await assert.rejects(controller.exchange("sampling-origin"), /within 100 ms/u);
    });
  });
});

test("responder rejects requests that cross its deadline", async (t) => {
  const request = createDataWranglerStudyBridgeRequest({
    runId: RUN_ID,
    phase: PHASE,
    sequence: 0,
    kind: "measurement-ready",
    monotonicNanoseconds: "200"
  });

  await t.test("present before a late poll", async () => {
    await withBridgeDirectory(async ({ requestPath, acknowledgementPath }) => {
      const responder = createDataWranglerStudyBridgeResponder(
        { requestPath, acknowledgementPath, runId: RUN_ID, phase: PHASE },
        {
          now: valuesNumberClock([0, 1, 2, 100]),
          timeoutMs: 100,
          pollIntervalMs: 1,
          wait: async () => {
            writeFileSync(requestPath, canonicalDurableJson(request), { mode: 0o600, flag: "wx" });
          }
        }
      );
      await assert.rejects(responder.waitForRequest(0, "measurement-ready"), /within 100 ms/u);
    });
  });

  await t.test("becomes late while it is read", async () => {
    await withBridgeDirectory(async ({ requestPath, acknowledgementPath }) => {
      writeFileSync(requestPath, canonicalDurableJson(request), { mode: 0o600, flag: "wx" });
      const responder = createDataWranglerStudyBridgeResponder(
        { requestPath, acknowledgementPath, runId: RUN_ID, phase: PHASE },
        {
          now: valuesNumberClock([0, 1, 100]),
          timeoutMs: 100,
          pollIntervalMs: 1
        }
      );
      await assert.rejects(responder.waitForRequest(0, "measurement-ready"), /within 100 ms/u);
    });
  });
});

test("responder abandonment consumes one authenticated request without releasing child progress", async () => {
  await withBridgeDirectory(async ({ requestPath, acknowledgementPath }) => {
    const controller = createDataWranglerStudyBridgeController(
      { requestPath, acknowledgementPath, runId: RUN_ID, phase: PHASE },
      { clock: () => 100n, timeoutMs: 20, pollIntervalMs: 1 }
    );
    const responder = createDataWranglerStudyBridgeResponder(
      { requestPath, acknowledgementPath, runId: RUN_ID, phase: PHASE },
      { clock: () => 200n, pollIntervalMs: 1 }
    );

    let childProgressed = false;
    const exchange = controller.exchange("inline-baseline").then((value) => {
      childProgressed = true;
      return value;
    });
    const request = await responder.waitForRequest(0, "inline-baseline");
    const abandonment = responder.abandon(request);

    assert.deepEqual(abandonment, {
      protocol: DATA_WRANGLER_STUDY_BRIDGE_ABANDONMENT_PROTOCOL,
      runId: RUN_ID,
      phase: PHASE,
      sequence: 0,
      kind: "inline-baseline",
      requestMonotonicNanoseconds: "100",
      abandonedMonotonicNanoseconds: "200"
    });
    assert.equal(Object.isFrozen(abandonment), true);
    assert.equal(existsSync(requestPath), false);
    assert.equal(existsSync(acknowledgementPath), false);
    assert.throws(() => responder.acknowledge(request), /only a request it read itself/u);
    assert.throws(() => responder.abandon(request), /only a request it read itself/u);
    await assert.rejects(exchange, /acknowledgement did not arrive within 20 ms/u);
    assert.equal(childProgressed, false);
    assert.equal(controller.nextSequence(), 0);
    assert.doesNotThrow(() => controller.close());
  });
});

test("responder abandonment rejects cloned, foreign, changed, and already acknowledged requests", async (t) => {
  await t.test("cloned and foreign objects", async () => {
    await withBridgeDirectory(async ({ requestPath, acknowledgementPath }) => {
      const responder = createDataWranglerStudyBridgeResponder(
        { requestPath, acknowledgementPath, runId: RUN_ID, phase: PHASE },
        { clock: () => 200n, pollIntervalMs: 1 }
      );
      const published = createDataWranglerStudyBridgeRequest({
        runId: RUN_ID,
        phase: PHASE,
        sequence: 0,
        kind: "measurement-ready",
        monotonicNanoseconds: "100"
      });
      writeFileSync(requestPath, canonicalDurableJson(published), { mode: 0o600, flag: "wx" });
      const request = await responder.waitForRequest(0, "measurement-ready");
      assert.throws(() => responder.abandon({ ...request }), /only a request it read itself/u);
      assert.throws(
        () =>
          responder.abandon(
            createDataWranglerStudyBridgeRequest({
              runId: RUN_ID,
              phase: PHASE,
              sequence: 1,
              kind: "workbench-baseline",
              monotonicNanoseconds: "150"
            })
          ),
        /only a request it read itself/u
      );
      assert.equal(existsSync(requestPath), true);
      responder.abandon(request);
    });
  });

  await t.test("changed request", async () => {
    await withBridgeDirectory(async ({ requestPath, acknowledgementPath }) => {
      const responder = createDataWranglerStudyBridgeResponder(
        { requestPath, acknowledgementPath, runId: RUN_ID, phase: PHASE },
        { clock: () => 200n, pollIntervalMs: 1 }
      );
      const published = createDataWranglerStudyBridgeRequest({
        runId: RUN_ID,
        phase: PHASE,
        sequence: 0,
        kind: "measurement-ready",
        monotonicNanoseconds: "100"
      });
      writeFileSync(requestPath, canonicalDurableJson(published), { mode: 0o600, flag: "wx" });
      const request = await responder.waitForRequest(0, "measurement-ready");
      writeFileSync(
        requestPath,
        canonicalDurableJson(createDataWranglerStudyBridgeRequest({ ...published, monotonicNanoseconds: "101" }))
      );
      assert.throws(() => responder.abandon(request), /changed between validation and consumption|changed identity/u);
      assert.equal(existsSync(requestPath), true);
    });
  });

  await t.test("pre-existing acknowledgement", async () => {
    await withBridgeDirectory(async ({ requestPath, acknowledgementPath }) => {
      const responder = createDataWranglerStudyBridgeResponder(
        { requestPath, acknowledgementPath, runId: RUN_ID, phase: PHASE },
        { clock: () => 200n, pollIntervalMs: 1 }
      );
      const requestEnvelope = createDataWranglerStudyBridgeRequest({
        runId: RUN_ID,
        phase: PHASE,
        sequence: 0,
        kind: "measurement-ready",
        monotonicNanoseconds: "100"
      });
      writeFileSync(requestPath, canonicalDurableJson(requestEnvelope), { mode: 0o600, flag: "wx" });
      const request = await responder.waitForRequest(0, "measurement-ready");
      writeFileSync(
        acknowledgementPath,
        canonicalDurableJson(
          createDataWranglerStudyBridgeAcknowledgement({ ...requestEnvelope, monotonicNanoseconds: "150" })
        ),
        { mode: 0o600, flag: "wx" }
      );
      assert.throws(() => responder.abandon(request), /acknowledgement path is already occupied/u);
      assert.equal(existsSync(requestPath), true);
      assert.equal(existsSync(acknowledgementPath), true);
    });
  });
});

test("responder request waits stop promptly when their optional signal aborts", async (t) => {
  await t.test("already aborted", async () => {
    await withBridgeDirectory(async ({ requestPath, acknowledgementPath }) => {
      const controller = new AbortController();
      controller.abort("laptop-shutdown");
      const responder = createDataWranglerStudyBridgeResponder({
        requestPath,
        acknowledgementPath,
        runId: RUN_ID,
        phase: PHASE
      });
      await assert.rejects(responder.waitForRequest(0, "measurement-ready", controller.signal), {
        code: "aborted"
      });
    });
  });

  await t.test("while a poll is pending", async () => {
    await withBridgeDirectory(async ({ requestPath, acknowledgementPath }) => {
      const controller = new AbortController();
      let markWaiting;
      const waiting = new Promise((resolvePromise) => {
        markWaiting = resolvePromise;
      });
      const responder = createDataWranglerStudyBridgeResponder(
        { requestPath, acknowledgementPath, runId: RUN_ID, phase: PHASE },
        {
          pollIntervalMs: 1,
          wait: () => {
            markWaiting();
            return new Promise(() => {});
          }
        }
      );
      const request = responder.waitForRequest(0, "measurement-ready", controller.signal);
      await waiting;
      controller.abort("laptop-shutdown");
      await assert.rejects(request, { code: "aborted" });
    });
  });

  await t.test("immediately after a poll", async () => {
    await withBridgeDirectory(async ({ requestPath, acknowledgementPath }) => {
      const controller = new AbortController();
      const responder = createDataWranglerStudyBridgeResponder(
        { requestPath, acknowledgementPath, runId: RUN_ID, phase: PHASE },
        {
          pollIntervalMs: 1,
          wait: async () => controller.abort("laptop-shutdown")
        }
      );
      await assert.rejects(responder.waitForRequest(0, "measurement-ready", controller.signal), {
        code: "aborted"
      });
    });
  });

  await t.test("normalizes a concurrently rejected poll", async () => {
    await withBridgeDirectory(async ({ requestPath, acknowledgementPath }) => {
      const controller = new AbortController();
      let markWaiting;
      const waiting = new Promise((resolvePromise) => {
        markWaiting = resolvePromise;
      });
      const responder = createDataWranglerStudyBridgeResponder(
        { requestPath, acknowledgementPath, runId: RUN_ID, phase: PHASE },
        {
          pollIntervalMs: 1,
          wait: () =>
            new Promise((_, reject) => {
              controller.signal.addEventListener("abort", () => reject(new Error("unbounded injected wait failure")), {
                once: true
              });
              markWaiting();
            })
        }
      );
      const request = responder.waitForRequest(0, "measurement-ready", controller.signal);
      await waiting;
      controller.abort("laptop-shutdown");
      await assert.rejects(request, { code: "aborted" });
    });
  });

  await t.test("rejects a malformed optional signal", async () => {
    await withBridgeDirectory(async ({ requestPath, acknowledgementPath }) => {
      const responder = createDataWranglerStudyBridgeResponder({
        requestPath,
        acknowledgementPath,
        runId: RUN_ID,
        phase: PHASE
      });
      await assert.rejects(responder.waitForRequest(0, "measurement-ready", {}), /requires an AbortSignal/u);
    });
  });
});

test("bridge paths reject stale files, symlinks, non-private parents, and inauthentic acknowledgements", async (t) => {
  await t.test("stale file", async () => {
    await withBridgeDirectory(async ({ requestPath, acknowledgementPath }) => {
      writeFileSync(requestPath, "{}\n", { mode: 0o600 });
      assert.throws(
        () =>
          createDataWranglerStudyBridgeController({ requestPath, acknowledgementPath, runId: RUN_ID, phase: PHASE }),
        /unconsumed request/u
      );
    });
  });

  await t.test("symlink acknowledgement", async () => {
    await withBridgeDirectory(async ({ directory, requestPath, acknowledgementPath }) => {
      const controller = createDataWranglerStudyBridgeController(
        { requestPath, acknowledgementPath, runId: RUN_ID, phase: PHASE },
        { clock: () => 100n, pollIntervalMs: 1 }
      );
      const exchange = controller.exchange("sampling-origin");
      await waitUntil(() => existsSync(requestPath));
      const target = resolve(directory, "target.json");
      writeFileSync(target, "{}\n", { mode: 0o600 });
      symlinkSync(target, acknowledgementPath);
      await assert.rejects(exchange, /private bounded regular file/u);
    });
  });

  await t.test("non-private parent", async () => {
    await withBridgeDirectory(async ({ directory, requestPath, acknowledgementPath }) => {
      chmodSync(directory, 0o755);
      assert.throws(
        () =>
          createDataWranglerStudyBridgeController({ requestPath, acknowledgementPath, runId: RUN_ID, phase: PHASE }),
        /mode-0700/u
      );
    });
  });

  await t.test("inauthentic request", async () => {
    await withBridgeDirectory(async ({ requestPath, acknowledgementPath }) => {
      const responder = createDataWranglerStudyBridgeResponder({
        requestPath,
        acknowledgementPath,
        runId: RUN_ID,
        phase: PHASE
      });
      assert.throws(
        () =>
          responder.acknowledge(
            createDataWranglerStudyBridgeRequest({
              runId: RUN_ID,
              phase: PHASE,
              sequence: 0,
              kind: "measurement-ready",
              monotonicNanoseconds: "100"
            })
          ),
        /only a request it read itself/u
      );
    });
  });

  await t.test("request identity replacement", async () => {
    await withBridgeDirectory(async ({ directory, requestPath, acknowledgementPath }) => {
      const responder = createDataWranglerStudyBridgeResponder(
        { requestPath, acknowledgementPath, runId: RUN_ID, phase: PHASE },
        { clock: () => 200n, pollIntervalMs: 1 }
      );
      const publishedRequest = createDataWranglerStudyBridgeRequest({
        runId: RUN_ID,
        phase: PHASE,
        sequence: 0,
        kind: "measurement-ready",
        monotonicNanoseconds: "100"
      });
      writeFileSync(requestPath, canonicalDurableJson(publishedRequest), { mode: 0o600, flag: "wx" });
      const request = await responder.waitForRequest(0, "measurement-ready");
      renameSync(requestPath, resolve(directory, "displaced-request.json"));
      writeFileSync(requestPath, canonicalDurableJson(request), { mode: 0o600, flag: "wx" });
      assert.throws(() => responder.acknowledge(request), /changed identity/u);
    });
  });
});

test("study bridge environment exposes only its three absolute paths", async () => {
  await withBridgeDirectory(async ({ directory, requestPath, acknowledgementPath }) => {
    const sourcePath = resolve(directory, "fixture.csv");
    const environment = createDataWranglerStudyBridgeEnvironment({
      requestPath,
      acknowledgementPath,
      sourcePath
    });
    assert.deepEqual(environment, {
      [DATA_WRANGLER_STUDY_BRIDGE_ENVIRONMENT.request]: requestPath,
      [DATA_WRANGLER_STUDY_BRIDGE_ENVIRONMENT.acknowledgement]: acknowledgementPath,
      [DATA_WRANGLER_STUDY_BRIDGE_ENVIRONMENT.source]: sourcePath
    });
  });
});

async function withBridgeDirectory(callback) {
  const directory = mkdtempSync(resolve(tmpdir(), "ow-study-bridge-"));
  chmodSync(directory, 0o700);
  const requestPath = resolve(directory, "request.json");
  const acknowledgementPath = resolve(directory, "ack.json");
  try {
    await callback({ directory, requestPath, acknowledgementPath });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function valuesClock(values) {
  let index = 0;
  return () => {
    const value = values[index];
    if (value === undefined) throw new Error("clock exhausted");
    index += 1;
    return value;
  };
}

function valuesNumberClock(values) {
  let index = 0;
  return () => {
    const value = values[index];
    if (value === undefined) throw new Error("numeric clock exhausted");
    index += 1;
    return value;
  };
}

async function waitUntil(probe, timeoutMs = 1_000) {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    if (probe()) return;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 1));
  }
  assert.fail("Timed out waiting for bridge state.");
}
