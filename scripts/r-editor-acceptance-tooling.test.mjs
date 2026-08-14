import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { acquireExactArtifact, R_EDITOR_ACCEPTANCE_TOOLING } from "./r-editor-acceptance-tooling.mjs";

const PAYLOAD = Buffer.from("reviewed R tooling fixture", "utf8");
const TEST_PIN = Object.freeze({
  fileName: "reviewed-tooling.bin",
  url: "https://artifacts.example.test/reviewed-tooling.bin",
  bytes: PAYLOAD.length,
  sha256: createHash("sha256").update(PAYLOAD).digest("hex")
});

test("native R and Quarto acceptance pins one reviewed toolchain", () => {
  assert.deepEqual(
    Object.fromEntries(
      Object.entries(R_EDITOR_ACCEPTANCE_TOOLING).map(([key, value]) => [key, "id" in value ? value.id : value.version])
    ),
    {
      rSyntax: "reditorsupport.r-syntax@0.1.4",
      r: "reditorsupport.r@2.8.8",
      quartoExtension: "quarto.quarto@1.135.0",
      quartoCli: "1.10.18"
    }
  );
  for (const pin of Object.values(R_EDITOR_ACCEPTANCE_TOOLING)) {
    assert.equal(Object.isFrozen(pin), true);
    assert.match(pin.url, /^https:\/\//u);
    assert.match(pin.sha256, /^[0-9a-f]{64}$/u);
    assert.ok(Number.isSafeInteger(pin.bytes) && pin.bytes > 0);
  }
  assert.equal(R_EDITOR_ACCEPTANCE_TOOLING.quartoCli.pandocRelativePath, "bin/tools/x86_64/pandoc");
});

test("R tooling artifact fetch recovers after either one or two initial promise rejections", async () => {
  for (const rejectedAttempts of [1, 2]) {
    await withPrivateRoot(`recover-${rejectedAttempts}`, async (root) => {
      const clock = fakeTimers();
      const signals = [];
      const attempts = [];
      const delays = [];
      let fetchCalls = 0;
      const destination = await acquireExactArtifact(root, "reviewedTooling", TEST_PIN, {
        fetchImpl: async (_url, { signal }) => {
          fetchCalls += 1;
          signals.push(signal);
          if (fetchCalls <= rejectedAttempts) {
            throw new Error(`private transport failure ${fetchCalls}`);
          }
          return exactResponse();
        },
        onAttempt: (attempt) => attempts.push(attempt),
        timeoutMs: 10_000,
        timersForTest: clock.api,
        waitForRetryForTest: async (delay, signal) => {
          assert.equal(signal.aborted, false);
          delays.push(delay);
        }
      });

      assert.deepEqual(readFileSync(destination), PAYLOAD);
      assert.equal(fetchCalls, rejectedAttempts + 1);
      assert.deepEqual(delays, [2_000, 4_000].slice(0, rejectedAttempts));
      assert.deepEqual(
        attempts.map(({ key, fileName, attempt, maximumAttempts }) => ({ key, fileName, attempt, maximumAttempts })),
        Array.from({ length: rejectedAttempts + 1 }, (_value, index) => ({
          key: "reviewedTooling",
          fileName: TEST_PIN.fileName,
          attempt: index + 1,
          maximumAttempts: 3
        }))
      );
      assert.ok(attempts.every(Object.isFrozen));
      assertDistinctAbortedSignals(signals);
      assert.deepEqual(clock.scheduledDelays, [10_000]);
      assert.equal(clock.pendingCount(), 0);
      assert.equal(clock.clearCalls.length, 1);
    });
  }
});

test("R tooling artifact fetch uses deterministic cancellable 2s and 4s backoffs", async () => {
  await withPrivateRoot("backoffs", async (root) => {
    const clock = fakeTimers();
    const signals = [];
    let fetchCalls = 0;
    const acquisition = acquireExactArtifact(root, "reviewedTooling", TEST_PIN, {
      fetchImpl: async (_url, { signal }) => {
        fetchCalls += 1;
        signals.push(signal);
        if (fetchCalls < 3) throw new Error("retryable transport rejection");
        return exactResponse();
      },
      timeoutMs: 20_000,
      timersForTest: clock.api
    });

    await waitUntil(() => clock.hasDelay(2_000));
    clock.fireDelay(2_000);
    await waitUntil(() => clock.hasDelay(4_000));
    clock.fireDelay(4_000);
    const destination = await acquisition;

    assert.deepEqual(readFileSync(destination), PAYLOAD);
    assert.equal(fetchCalls, 3);
    assert.deepEqual(clock.scheduledDelays, [20_000, 2_000, 4_000]);
    assert.equal(clock.pendingCount(), 0);
    assert.equal(clock.clearCalls.length, 3);
    assertDistinctAbortedSignals(signals);
  });
});

test("R tooling artifact fetch exhausts exactly three attempts with one fixed redacted error", async () => {
  await withPrivateRoot("exhausted", async (root) => {
    const clock = fakeTimers();
    const signals = [];
    const delays = [];
    const secretCause = "token=private-credential at https://internal.invalid/download";
    let fetchCalls = 0;
    const message = await rejectionMessage(
      acquireExactArtifact(root, "reviewedTooling", TEST_PIN, {
        fetchImpl: async (_url, { signal }) => {
          fetchCalls += 1;
          signals.push(signal);
          throw new Error(secretCause);
        },
        timeoutMs: 10_000,
        timersForTest: clock.api,
        waitForRetryForTest: async (delay) => delays.push(delay)
      })
    );

    assert.equal(fetchCalls, 3);
    assert.deepEqual(delays, [2_000, 4_000]);
    assert.equal(
      message,
      `R editor tooling artifact reviewedTooling (${TEST_PIN.fileName}) attempt 3/3 exhausted its fetch attempts.`
    );
    assert.doesNotMatch(message, /private-credential|internal\.invalid|artifacts\.example\.test/u);
    assertDistinctAbortedSignals(signals);
    assert.equal(clock.pendingCount(), 0);
    assert.equal(clock.clearCalls.length, 1);
  });
});

test("R tooling retries promise rejection only, not a synchronous fetch failure", async () => {
  await withPrivateRoot("sync-fetch", async (root) => {
    const clock = fakeTimers();
    let fetchCalls = 0;
    const message = await rejectionMessage(
      acquireExactArtifact(root, "reviewedTooling", TEST_PIN, {
        fetchImpl() {
          fetchCalls += 1;
          throw new Error("raw synchronous URL and credential");
        },
        timeoutMs: 10_000,
        timersForTest: clock.api,
        waitForRetryForTest: async () => assert.fail("synchronous fetch failure must not retry")
      })
    );

    assert.equal(fetchCalls, 1);
    assert.equal(
      message,
      `R editor tooling artifact reviewedTooling (${TEST_PIN.fileName}) attempt 1/3 could not start its fetch.`
    );
    assert.doesNotMatch(message, /credential|raw synchronous|artifacts\.example\.test/u);
    assert.equal(clock.pendingCount(), 0);
  });
});

test("R tooling aggregate deadline bounds a pending fetch even when its promise ignores abort", async () => {
  await withPrivateRoot("deadline-fetch", async (root) => {
    const clock = fakeTimers();
    const signals = [];
    let fetchCalls = 0;
    const acquisition = acquireExactArtifact(root, "reviewedTooling", TEST_PIN, {
      fetchImpl: (_url, { signal }) => {
        fetchCalls += 1;
        signals.push(signal);
        return new Promise(() => {});
      },
      timeoutMs: 100,
      timersForTest: clock.api
    });

    await waitUntil(() => fetchCalls === 1);
    clock.fireDelay(100);
    const message = await rejectionMessage(acquisition);
    assert.equal(
      message,
      `R editor tooling artifact reviewedTooling (${TEST_PIN.fileName}) attempt 1/3 exceeded its aggregate download deadline.`
    );
    assert.equal(fetchCalls, 1);
    assertDistinctAbortedSignals(signals);
    assert.equal(clock.pendingCount(), 0);
  });
});

test("R tooling aggregate deadline bounds an injected backoff that ignores abort", async () => {
  await withPrivateRoot("deadline-injected-backoff", async (root) => {
    const clock = fakeTimers();
    let fetchCalls = 0;
    let backoffCalls = 0;
    const acquisition = acquireExactArtifact(root, "reviewedTooling", TEST_PIN, {
      fetchImpl: async () => {
        fetchCalls += 1;
        throw new Error("retryable transport rejection");
      },
      timeoutMs: 100,
      timersForTest: clock.api,
      waitForRetryForTest: () => {
        backoffCalls += 1;
        return new Promise(() => {});
      }
    });

    await waitUntil(() => backoffCalls === 1);
    clock.fireDelay(100);
    const message = await rejectionMessage(acquisition);
    assert.equal(
      message,
      `R editor tooling artifact reviewedTooling (${TEST_PIN.fileName}) attempt 1/3 exceeded its aggregate download deadline.`
    );
    assert.equal(fetchCalls, 1);
    assert.equal(backoffCalls, 1);
    assert.equal(clock.pendingCount(), 0);
  });
});

test("R tooling aggregate deadline cancels an active retry backoff", async () => {
  await withPrivateRoot("deadline-backoff", async (root) => {
    const clock = fakeTimers();
    let fetchCalls = 0;
    const acquisition = acquireExactArtifact(root, "reviewedTooling", TEST_PIN, {
      fetchImpl: async () => {
        fetchCalls += 1;
        throw new Error("retryable transport rejection");
      },
      timeoutMs: 100,
      timersForTest: clock.api
    });

    await waitUntil(() => clock.hasDelay(2_000));
    clock.fireDelay(100);
    const message = await rejectionMessage(acquisition);
    assert.equal(
      message,
      `R editor tooling artifact reviewedTooling (${TEST_PIN.fileName}) attempt 1/3 exceeded its aggregate download deadline.`
    );
    assert.equal(fetchCalls, 1);
    assert.equal(clock.pendingCount(), 0);
    assert.ok(clock.clearCalls.length >= 2);
  });
});

test("R tooling aggregate deadline aborts an accepted response body and removes partial bytes", async () => {
  await withPrivateRoot("deadline-body", async (root) => {
    const clock = fakeTimers();
    const signals = [];
    let pulls = 0;
    let cancellations = 0;
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(PAYLOAD.subarray(0, 2));
      },
      pull() {
        pulls += 1;
      },
      cancel() {
        cancellations += 1;
      }
    });
    const acquisition = acquireExactArtifact(root, "reviewedTooling", TEST_PIN, {
      fetchImpl: async (_url, { signal }) => {
        signals.push(signal);
        return { ok: true, body };
      },
      timeoutMs: 100,
      timersForTest: clock.api
    });

    await waitUntil(() => pulls > 0);
    clock.fireDelay(100);
    const message = await rejectionMessage(acquisition);
    assert.equal(
      message,
      `R editor tooling artifact reviewedTooling (${TEST_PIN.fileName}) attempt 1/3 exceeded its aggregate download deadline.`
    );
    assert.equal(cancellations, 1);
    assert.equal(existsSync(join(root, TEST_PIN.fileName)), false);
    assertDistinctAbortedSignals(signals);
    assert.equal(clock.pendingCount(), 0);
  });
});

test("R tooling aggregate deadline bounds disposal of a rejected HTTP body", async () => {
  await withPrivateRoot("deadline-cancel", async (root) => {
    const clock = fakeTimers();
    let cancelCalls = 0;
    const acquisition = acquireExactArtifact(root, "reviewedTooling", TEST_PIN, {
      fetchImpl: async () => ({
        ok: false,
        status: 503,
        body: {
          cancel() {
            cancelCalls += 1;
            return new Promise(() => {});
          }
        }
      }),
      timeoutMs: 100,
      timersForTest: clock.api
    });

    await waitUntil(() => cancelCalls === 1);
    clock.fireDelay(100);
    const message = await rejectionMessage(acquisition);
    assert.equal(
      message,
      `R editor tooling artifact reviewedTooling (${TEST_PIN.fileName}) attempt 1/3 exceeded its aggregate download deadline.`
    );
    assert.equal(cancelCalls, 1);
    assert.equal(clock.pendingCount(), 0);
  });
});

test("R tooling HTTP failures are never retried and always dispose their response body", async () => {
  for (const status of [404, 429, 503]) {
    await withPrivateRoot(`http-${status}`, async (root) => {
      const clock = fakeTimers();
      const signals = [];
      let fetchCalls = 0;
      let cancelCalls = 0;
      const message = await rejectionMessage(
        acquireExactArtifact(root, "reviewedTooling", TEST_PIN, {
          fetchImpl: async (_url, { signal }) => {
            fetchCalls += 1;
            signals.push(signal);
            return {
              ok: false,
              status,
              body: {
                async cancel() {
                  cancelCalls += 1;
                }
              }
            };
          },
          timeoutMs: 10_000,
          timersForTest: clock.api,
          waitForRetryForTest: async () => assert.fail("HTTP failures must not retry")
        })
      );

      assert.equal(fetchCalls, 1);
      assert.equal(cancelCalls, 1);
      assert.equal(
        message,
        `R editor tooling artifact reviewedTooling (${TEST_PIN.fileName}) attempt 1/3 returned a non-success HTTP response.`
      );
      assert.doesNotMatch(message, new RegExp(String(status), "u"));
      assert.doesNotMatch(message, /artifacts\.example\.test/u);
      assertDistinctAbortedSignals(signals);
      assert.equal(clock.pendingCount(), 0);
    });
  }
});

test("R tooling reports rejected-body disposal failure without retrying or leaking its cause", async () => {
  await withPrivateRoot("cancel-failure", async (root) => {
    const clock = fakeTimers();
    let fetchCalls = 0;
    const message = await rejectionMessage(
      acquireExactArtifact(root, "reviewedTooling", TEST_PIN, {
        fetchImpl: async () => {
          fetchCalls += 1;
          return {
            ok: false,
            body: {
              async cancel() {
                throw new Error("authorization=private cancellation cause");
              }
            }
          };
        },
        timeoutMs: 10_000,
        timersForTest: clock.api
      })
    );

    assert.equal(fetchCalls, 1);
    assert.equal(
      message,
      `R editor tooling artifact reviewedTooling (${TEST_PIN.fileName}) attempt 1/3 could not dispose its rejected response body.`
    );
    assert.doesNotMatch(message, /authorization|cancellation cause|artifacts\.example\.test/u);
    assert.equal(clock.pendingCount(), 0);
  });
});

test("R tooling missing and invalid response bodies fail once and invalid bodies are disposed", async () => {
  for (const fixture of [
    {
      label: "missing",
      response: () => ({ ok: true, body: null }),
      expected: "returned no response body",
      expectedCancels: 0
    },
    {
      label: "invalid",
      response: (incrementCancel) => ({
        ok: true,
        body: {
          async cancel() {
            incrementCancel();
          }
        }
      }),
      expected: "returned an invalid response body",
      expectedCancels: 1
    }
  ]) {
    let fixtureCancelCount = 0;
    await withPrivateRoot(`body-${fixture.label}`, async (root) => {
      const clock = fakeTimers();
      let fetchCalls = 0;
      const message = await rejectionMessage(
        acquireExactArtifact(root, "reviewedTooling", TEST_PIN, {
          fetchImpl: async () => {
            fetchCalls += 1;
            return fixture.response(() => {
              fixtureCancelCount += 1;
            });
          },
          timeoutMs: 10_000,
          timersForTest: clock.api,
          waitForRetryForTest: async () => assert.fail("body failures must not retry")
        })
      );
      assert.equal(fetchCalls, 1);
      assert.equal(fixtureCancelCount, fixture.expectedCancels);
      assert.equal(
        message,
        `R editor tooling artifact reviewedTooling (${TEST_PIN.fileName}) attempt 1/3 ${fixture.expected}.`
      );
      assert.equal(clock.pendingCount(), 0);
    });
  }
});

test("R tooling checksum, body-stream, and filesystem failures each fetch exactly once", async () => {
  const fixtures = [
    {
      label: "checksum",
      response: () => exactResponse(Buffer.from(PAYLOAD.map((byte, index) => (index === 0 ? byte ^ 0xff : byte)))),
      rawCause: "altered"
    },
    {
      label: "body-stream",
      response: () => ({
        ok: true,
        body: new ReadableStream({
          start(controller) {
            controller.error(new Error("private streamed URL and credential"));
          }
        })
      }),
      rawCause: "credential"
    },
    {
      label: "filesystem",
      before: (root) => mkdirSync(join(root, TEST_PIN.fileName)),
      response: () => exactResponse(),
      rawCause: "EISDIR"
    }
  ];

  for (const fixture of fixtures) {
    await withPrivateRoot(fixture.label, async (root) => {
      fixture.before?.(root);
      const clock = fakeTimers();
      const signals = [];
      let fetchCalls = 0;
      const message = await rejectionMessage(
        acquireExactArtifact(root, "reviewedTooling", TEST_PIN, {
          fetchImpl: async (_url, { signal }) => {
            fetchCalls += 1;
            signals.push(signal);
            return fixture.response();
          },
          timeoutMs: 10_000,
          timersForTest: clock.api,
          waitForRetryForTest: async () => assert.fail(`${fixture.label} failure must not retry`)
        })
      );

      assert.equal(fetchCalls, 1);
      assert.equal(
        message,
        `R editor tooling artifact reviewedTooling (${TEST_PIN.fileName}) attempt 1/3 failed exact response-body verification.`
      );
      assert.doesNotMatch(message, new RegExp(fixture.rawCause, "iu"));
      assert.doesNotMatch(message, /artifacts\.example\.test/u);
      if (fixture.label !== "filesystem") {
        assert.equal(existsSync(join(root, TEST_PIN.fileName)), false);
      }
      assertDistinctAbortedSignals(signals);
      assert.equal(clock.pendingCount(), 0);
    });
  }
});

test("R tooling exact local override performs no fetch, attempt checkpoint, or timer scheduling", async () => {
  await withPrivateRoot("override", async (parent) => {
    const root = join(parent, "destination");
    mkdirSync(root, { mode: 0o700 });
    const sourcePath = join(parent, "reviewed-source.bin");
    writeFileSync(sourcePath, PAYLOAD, { mode: 0o600 });
    let fetchCalls = 0;
    let attemptCalls = 0;
    let timerCalls = 0;
    const destination = await acquireExactArtifact(root, "reviewedTooling", TEST_PIN, {
      fetchImpl: async () => {
        fetchCalls += 1;
        throw new Error("override unexpectedly fetched");
      },
      onAttempt: () => {
        attemptCalls += 1;
      },
      sourcePath,
      timersForTest: {
        setTimeout() {
          timerCalls += 1;
          throw new Error("override unexpectedly scheduled a timer");
        },
        clearTimeout() {
          timerCalls += 1;
        }
      }
    });

    assert.deepEqual(readFileSync(destination), PAYLOAD);
    assert.equal(fetchCalls, 0);
    assert.equal(attemptCalls, 0);
    assert.equal(timerCalls, 0);
  });
});

test("R tooling artifact pin validation rejects path and URL ambiguity before fetch", async () => {
  await withPrivateRoot("pin-validation", async (root) => {
    for (const invalidPin of [
      { ...TEST_PIN, fileName: "../escaped.bin" },
      { ...TEST_PIN, url: "https://user:secret@artifacts.example.test/reviewed-tooling.bin" },
      { ...TEST_PIN, url: `${TEST_PIN.url}?token=private` }
    ]) {
      let fetchCalls = 0;
      await assert.rejects(
        acquireExactArtifact(root, "reviewedTooling", invalidPin, {
          fetchImpl: async () => {
            fetchCalls += 1;
            return exactResponse();
          }
        }),
        /^Error: R editor tooling artifact acquisition requires one valid pinned artifact\.$/u
      );
      assert.equal(fetchCalls, 0);
    }
  });
});

test("packaged editor runner publishes a correlated checkpoint for every R tooling artifact attempt", () => {
  const toolingSource = readFileSync(new URL("./r-editor-acceptance-tooling.mjs", import.meta.url), "utf8");
  const prepareTooling = toolingSource.slice(
    toolingSource.indexOf("export async function prepareREditorAcceptanceTooling"),
    toolingSource.indexOf("export async function acquireExactArtifact")
  );
  assert.match(
    prepareTooling,
    /for \(const key of \["rSyntax", "r", "quartoExtension"\]\)[\s\S]+acquireExactArtifact\(root, key, pin, \{[\s\S]+fetchImpl,[\s\S]+onAttempt: onArtifactAttempt,[\s\S]+sourcePath: artifactPaths\[key\][\s\S]+\}\)/u
  );
  assert.match(
    prepareTooling,
    /acquireExactArtifact\(root, "quartoCli", R_EDITOR_ACCEPTANCE_TOOLING\.quartoCli, \{[\s\S]+fetchImpl,[\s\S]+onAttempt: onArtifactAttempt,[\s\S]+sourcePath: artifactPaths\.quartoCli[\s\S]+\}\)/u
  );

  const runnerSource = readFileSync(new URL("./run-packaged-editor-tests.mjs", import.meta.url), "utf8");
  const toolingGuard = runnerSource.lastIndexOf(
    "if (rJupyterSelection.nativeEditorTooling)",
    runnerSource.indexOf("rEditorTooling = await prepareREditorAcceptanceTooling")
  );
  const toolingCall = runnerSource.slice(
    runnerSource.indexOf("rEditorTooling = await prepareREditorAcceptanceTooling"),
    runnerSource.indexOf('"setup:r-jupyter-environment-ready"')
  );
  assert.ok(toolingGuard >= 0, "Only a focused native-editor selector may acquire R and Quarto tooling.");
  assert.match(
    runnerSource.slice(toolingGuard, runnerSource.indexOf("rEditorTooling = await prepareREditorAcceptanceTooling")),
    /process\.platform !== "linux" \|\| process\.arch !== "x64"/u
  );
  assert.match(toolingCall, /onArtifactAttempt:\s*\(\{ key, fileName, attempt \}\)\s*=>/u);
  assert.match(
    toolingCall,
    /writeCorrelatedProgress\(\s*orchestrationProgressPath,\s*orchestrationRunId,\s*"setup",\s*`setup:fetch-r-editor-tooling-\$\{key\}-\$\{fileName\}-attempt-\$\{attempt\}`\s*\)/u
  );
  assert.doesNotMatch(toolingCall, /pin\.url|\$\{url\}/u);
  const installGuard = runnerSource.indexOf(
    'if (acceptanceMode === "r-jupyter" && rJupyterSelection.nativeEditorTooling)'
  );
  const installCall = runnerSource.indexOf("for (const target of rEditorTooling.extensionVsixes)", installGuard);
  assert.ok(installGuard >= 0 && installCall > installGuard);
});

function exactResponse(payload = PAYLOAD) {
  return new Response(payload, { status: 200 });
}

async function withPrivateRoot(label, callback) {
  const root = mkdtempSync(join(tmpdir(), `openwrangler-r-tooling-${label}-`));
  try {
    return await callback(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function fakeTimers() {
  let nextId = 1;
  const pending = new Map();
  const scheduledDelays = [];
  const clearCalls = [];
  const api = {
    setTimeout(callback, delay) {
      const id = nextId;
      nextId += 1;
      scheduledDelays.push(delay);
      pending.set(id, { callback, delay });
      return id;
    },
    clearTimeout(id) {
      clearCalls.push(id);
      pending.delete(id);
    }
  };
  return {
    api,
    clearCalls,
    scheduledDelays,
    fireDelay(delay) {
      const match = [...pending.entries()].find(([, entry]) => entry.delay === delay);
      assert.ok(match, `expected one pending ${delay} ms timer`);
      const [id, entry] = match;
      pending.delete(id);
      entry.callback();
    },
    hasDelay: (delay) => [...pending.values()].some((entry) => entry.delay === delay),
    pendingCount: () => pending.size
  };
}

function assertDistinctAbortedSignals(signals) {
  assert.equal(new Set(signals).size, signals.length);
  assert.ok(signals.length > 0);
  assert.ok(signals.every((signal) => signal.aborted));
}

async function rejectionMessage(promise) {
  let rejection;
  try {
    await promise;
  } catch (error) {
    rejection = error;
  }
  assert.ok(rejection instanceof Error, "expected an Error rejection");
  return rejection.message;
}

async function waitUntil(predicate) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolvePromise) => setImmediate(resolvePromise));
  }
  assert.fail("timed out waiting for the deterministic test checkpoint");
}
