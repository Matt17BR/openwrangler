import assert from "node:assert/strict";
import { spawn as spawnChild } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import {
  configureEditorAcceptanceTempRoot,
  createEditorAcceptanceEnvironmentForPlatform,
  EDITOR_HARNESS_ERROR_MAX_CHARACTERS,
  editorProcessTreeMayBeLive,
  prepareWindowsEditorProcessSupervisor,
  prepareWindowsEditorProcessSupervisorWithSignals,
  runBoundedEditorCommand,
  sanitizeEditorAcceptanceDiagnostic,
  spawnOwnedEditorProcess
} from "./editor-acceptance.mjs";

// These are load-tolerant correctness ceilings, not performance targets. The
// outer test limit is deliberately larger than the sum of every stage's own
// work and cleanup bounds so node:test cannot preempt Job Object attestation.
const WINDOWS_NATIVE_BUILD_TIMEOUT_MS = 300_000;
const WINDOWS_NATIVE_BUILD_SETTLEMENT_TIMEOUT_MS = 10_000;
const WINDOWS_NATIVE_COMPILER_TIMEOUT_PROBE_MS = 5_000;
const WINDOWS_NATIVE_COMMAND_CLEANUP = Object.freeze({
  terminationGraceMs: 5_000,
  killGraceMs: 5_000,
  windowsTreeKillTimeoutMs: 5_000
});
const WINDOWS_NATIVE_TEST_TIMEOUT_MS = 600_000;
const WINDOWS_NATIVE_SYNC_STAGE_TIMEOUT_MS = 15_000;
const WINDOWS_NATIVE_STAGE_SETTLEMENT_TIMEOUT_MS = 20_000;

function reporterSafeNativeStageCause(error) {
  const detail = sanitizeEditorAcceptanceDiagnostic(error);
  const cause = new Error(detail);
  cause.name = "NativeStageDiagnostic";
  cause.stack = `${cause.name}: ${detail}`;
  if (editorProcessTreeMayBeLive(error)) {
    cause.code = "EDITOR_PROCESS_TREE_UNVERIFIED";
    cause.details = Object.freeze({ treeVerifiedStopped: false });
  }
  return Object.freeze(cause);
}

function nativeStageClockValue(now) {
  const value = now();
  if (!Number.isFinite(value) || value < 0) {
    throw new Error("The native Windows supervisor stage clock returned an invalid value.");
  }
  return value;
}

function nativeStageRemainingMs(deadlineAt, now) {
  return Math.max(0, Math.ceil(deadlineAt - nativeStageClockValue(now)));
}

async function runWindowsNativeStage(
  stage,
  {
    timeoutMs,
    settlementTimeoutMs = WINDOWS_NATIVE_STAGE_SETTLEMENT_TIMEOUT_MS,
    outerAbortSignal,
    now = () => performance.now(),
    schedule = setTimeout,
    cancelSchedule = clearTimeout
  },
  operation
) {
  if (outerAbortSignal !== undefined && !(outerAbortSignal instanceof AbortSignal)) {
    throw new Error(`The native Windows supervisor ${stage} outer abort signal must be an AbortSignal.`);
  }
  if (typeof now !== "function" || typeof schedule !== "function" || typeof cancelSchedule !== "function") {
    throw new Error("The native Windows supervisor stage clock and scheduler must be functions.");
  }
  const stageStartedAt = nativeStageClockValue(now);
  const controller = new AbortController();
  let resolveOuterAbort;
  const outerAbortObservation = outerAbortSignal
    ? new Promise((resolve) => {
        resolveOuterAbort = resolve;
      })
    : undefined;
  const onOuterAbort = () => {
    if (!controller.signal.aborted) controller.abort(outerAbortSignal.reason);
    resolveOuterAbort?.({ kind: "outer-abort" });
  };
  if (outerAbortSignal) {
    outerAbortSignal.addEventListener("abort", onOuterAbort, { once: true });
    if (outerAbortSignal.aborted) onOuterAbort();
  }
  let releaseAfterSettlementDeadline;
  const execution = Promise.resolve().then(() => {
    const ownedOperation = operation(controller.signal);
    if (
      ownedOperation &&
      typeof ownedOperation === "object" &&
      ownedOperation.promise instanceof Promise &&
      typeof ownedOperation.releaseAfterSettlementDeadline === "function"
    ) {
      releaseAfterSettlementDeadline = ownedOperation.releaseAfterSettlementDeadline;
      return ownedOperation.promise;
    }
    return ownedOperation;
  });
  const observed = execution.then(
    (value) => ({ kind: "result", value }),
    (error) => ({ kind: "error", error })
  );
  let stageTimer;
  let observation;
  try {
    const observations = [
      observed,
      new Promise((resolveDeadline) => {
        const deadlineAt = stageStartedAt + timeoutMs;
        const observeDeadline = () => {
          const remainingMs = nativeStageRemainingMs(deadlineAt, now);
          if (remainingMs > 0) {
            stageTimer = schedule(observeDeadline, remainingMs);
            return;
          }
          if (!controller.signal.aborted) {
            controller.abort(Object.freeze({ reason: "deadline", timeoutMs }));
          }
          resolveDeadline({ kind: "deadline" });
        };
        stageTimer = schedule(observeDeadline, timeoutMs);
      })
    ];
    if (outerAbortObservation) observations.push(outerAbortObservation);
    observation = await Promise.race(observations);
  } finally {
    if (stageTimer !== undefined) cancelSchedule(stageTimer);
    if (outerAbortSignal) outerAbortSignal.removeEventListener("abort", onOuterAbort);
  }
  if (observation.kind === "result") return observation.value;
  if (observation.kind === "error") {
    const cause = reporterSafeNativeStageCause(observation.error);
    throw new Error(`The native Windows supervisor ${stage} stage failed: ${cause.message}`, { cause });
  }

  if (!controller.signal.aborted) controller.abort();
  const settlementStartedAt = nativeStageClockValue(now);
  let settlementTimer;
  let settlement;
  try {
    settlement = await Promise.race([
      observed,
      new Promise((resolveSettlementDeadline) => {
        const deadlineAt = settlementStartedAt + settlementTimeoutMs;
        const observeSettlementDeadline = () => {
          const remainingMs = nativeStageRemainingMs(deadlineAt, now);
          if (remainingMs > 0) {
            settlementTimer = schedule(observeSettlementDeadline, remainingMs);
            return;
          }
          resolveSettlementDeadline({ kind: "settlement-deadline" });
        };
        settlementTimer = schedule(observeSettlementDeadline, settlementTimeoutMs);
      })
    ]);
  } finally {
    if (settlementTimer !== undefined) cancelSchedule(settlementTimer);
  }
  if (settlement.kind === "settlement-deadline") {
    let releaseCause;
    try {
      releaseCause = releaseAfterSettlementDeadline?.();
    } catch (error) {
      releaseCause = error;
    }
    const reporterCause = releaseCause === undefined ? undefined : reporterSafeNativeStageCause(releaseCause);
    const failure = new Error(
      `The native Windows supervisor ${stage} stage exceeded ${timeoutMs} ms and did not settle within ${settlementTimeoutMs} ms after cancellation.`,
      reporterCause ? { cause: reporterCause } : undefined
    );
    failure.code = "EDITOR_PROCESS_TREE_UNVERIFIED";
    failure.details = {
      stage,
      reason: "settlement-deadline",
      elapsedMs: Math.max(0, nativeStageClockValue(now) - settlementStartedAt),
      limitMs: settlementTimeoutMs,
      stageElapsedMs: Math.max(0, nativeStageClockValue(now) - stageStartedAt),
      triggerReason: observation.kind === "outer-abort" ? "outer-abort" : "deadline",
      treeVerifiedStopped: false
    };
    throw failure;
  }
  const rawCause = settlement.kind === "error" ? settlement.error : undefined;
  const reporterCause = rawCause === undefined ? undefined : reporterSafeNativeStageCause(rawCause);
  if (observation.kind === "outer-abort") {
    const failure = new Error(`The native Windows supervisor ${stage} stage was cancelled by its enclosing test.`, {
      cause: reporterCause
    });
    failure.code = "EDITOR_ACCEPTANCE_STAGE_ABORTED";
    failure.details = {
      stage,
      reason: "outer-abort",
      elapsedMs: Math.max(0, nativeStageClockValue(now) - stageStartedAt),
      limitMs: timeoutMs,
      treeVerifiedStopped: !editorProcessTreeMayBeLive(rawCause)
    };
    throw failure;
  }
  const failure = new Error(
    `The native Windows supervisor ${stage} stage exceeded its ${timeoutMs} ms correctness bound.`,
    {
      cause: reporterCause
    }
  );
  failure.code = "EDITOR_ACCEPTANCE_STAGE_DEADLINE";
  failure.details = {
    stage,
    reason: "deadline",
    elapsedMs: Math.max(0, nativeStageClockValue(now) - stageStartedAt),
    limitMs: timeoutMs,
    treeVerifiedStopped: !editorProcessTreeMayBeLive(rawCause)
  };
  throw failure;
}

async function runWindowsNativeCommandStage(stage, stageOptions, command, commandOptions) {
  return runWindowsNativeStage(stage, stageOptions, async (abortSignal) => {
    const signalSource = new EventEmitter();
    const cancel = () => signalSource.emit("SIGTERM");
    abortSignal.addEventListener("abort", cancel, { once: true });
    if (abortSignal.aborted) queueMicrotask(cancel);
    try {
      return await runBoundedEditorCommand(command, { ...commandOptions, signalSource });
    } finally {
      abortSignal.removeEventListener("abort", cancel);
    }
  });
}

function aggregateWindowsNativeWorkerErrors(errors) {
  const retained = errors.filter((error) => error !== undefined);
  if (retained.length === 0) return undefined;
  if (retained.length === 1) return retained[0];
  return new AggregateError(retained, "The native Windows filesystem worker could not be released cleanly.");
}

async function runWindowsNativeFilesystemStage(
  stage,
  stageOptions,
  script,
  args,
  { spawnFilesystemWorker = spawnChild } = {}
) {
  return runWindowsNativeStage(stage, stageOptions, (abortSignal) => {
    const child = spawnFilesystemWorker(process.execPath, ["-e", script, ...args], {
      detached: false,
      windowsHide: true,
      stdio: "ignore"
    });
    let settled = false;
    let released = false;
    let cancellationError;
    let workerError;
    let onAbort;
    let onError;
    let onClose;
    const promise = new Promise((resolve, reject) => {
      const settle = (operation, value) => {
        if (settled) return;
        settled = true;
        abortSignal.removeEventListener("abort", onAbort);
        child.off("error", onError);
        child.off("close", onClose);
        operation(value);
      };
      onAbort = () => {
        try {
          child.kill("SIGKILL");
        } catch (error) {
          cancellationError = new Error(`The native Windows supervisor ${stage} worker could not be cancelled.`, {
            cause: error
          });
          cancellationError.code = "EDITOR_PROCESS_TREE_UNVERIFIED";
          cancellationError.details = { stage, treeVerifiedStopped: false };
        }
      };
      onError = (error) => {
        if (Number.isInteger(child.pid) && child.pid > 0) {
          workerError ??= error;
          return;
        }
        settle(reject, error);
      };
      onClose = (code, signal) => {
        if (cancellationError) settle(reject, cancellationError);
        else if (workerError) settle(reject, workerError);
        else if (code === 0 && signal === null) settle(resolve);
        else {
          settle(
            reject,
            new Error(
              `The native Windows supervisor ${stage} worker failed with code ${String(code ?? "unknown")} and signal ${String(signal ?? "none")}.`
            )
          );
        }
      };
      abortSignal.addEventListener("abort", onAbort, { once: true });
      child.on("error", onError);
      child.once("close", onClose);
      if (abortSignal.aborted) onAbort();
    });
    return {
      promise,
      releaseAfterSettlementDeadline() {
        if (settled || released) return;
        released = true;
        const onLateError = () => undefined;
        const onLateClose = () => {
          child.off("error", onLateError);
          child.off("close", onLateClose);
        };
        child.on("error", onLateError);
        child.once("close", onLateClose);
        abortSignal.removeEventListener("abort", onAbort);
        child.off("error", onError);
        child.off("close", onClose);
        let unrefError;
        try {
          child.unref?.();
        } catch (error) {
          unrefError = error;
        }
        return aggregateWindowsNativeWorkerErrors([workerError, cancellationError, unrefError]);
      }
    };
  });
}

function processIsRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    throw error;
  }
}

test("native stage deadlines cancel and settle their operation before reporting", { timeout: 5_000 }, async () => {
  let cancellationObserved = false;
  let operationSettled = false;
  await assert.rejects(
    runWindowsNativeStage(
      "deadline settlement probe",
      { timeoutMs: 10, settlementTimeoutMs: 100 },
      (abortSignal) =>
        new Promise((resolve) => {
          abortSignal.addEventListener(
            "abort",
            () => {
              cancellationObserved = true;
              setTimeout(() => {
                operationSettled = true;
                resolve();
              }, 10);
            },
            { once: true }
          );
        })
    ),
    (error) => {
      assert.equal(error.code, "EDITOR_ACCEPTANCE_STAGE_DEADLINE");
      assert.deepEqual(
        {
          stage: error.details?.stage,
          reason: error.details?.reason,
          limitMs: error.details?.limitMs,
          treeVerifiedStopped: error.details?.treeVerifiedStopped
        },
        {
          stage: "deadline settlement probe",
          reason: "deadline",
          limitMs: 10,
          treeVerifiedStopped: true
        }
      );
      assert.equal(error.details?.elapsedMs >= 10, true);
      assert.equal(error.details?.elapsedMs < 1_000, true);
      return true;
    }
  );
  assert.equal(cancellationObserved, true);
  assert.equal(operationSettled, true);
});

test("early native-stage wakes preserve the active and settlement absolute deadlines", async () => {
  const scheduled = [];
  let clock = 0;
  let released = false;
  const schedule = (callback, delay) => {
    const timer = { callback, cancelled: false, delay };
    scheduled.push(timer);
    return timer;
  };
  const cancelSchedule = (timer) => {
    timer.cancelled = true;
  };
  const stage = runWindowsNativeStage(
    "absolute deadline probe",
    { timeoutMs: 10, settlementTimeoutMs: 8, now: () => clock, schedule, cancelSchedule },
    () => ({
      promise: new Promise(() => undefined),
      releaseAfterSettlementDeadline() {
        released = true;
      }
    })
  );
  void stage.catch(() => undefined);
  await Promise.resolve();
  assert.equal(scheduled.length, 1);
  assert.equal(scheduled[0].delay, 10);

  clock = 4;
  scheduled[0].callback();
  assert.equal(scheduled.length, 2);
  assert.equal(scheduled[1].delay, 6);

  clock = 10;
  scheduled[1].callback();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(scheduled[1].cancelled, true);
  assert.equal(scheduled.length, 3);
  assert.equal(scheduled[2].delay, 8);

  clock = 13;
  scheduled[2].callback();
  assert.equal(scheduled.length, 4);
  assert.equal(scheduled[3].delay, 5);

  clock = 18;
  scheduled[3].callback();
  await assert.rejects(stage, (error) => {
    assert.equal(error.code, "EDITOR_PROCESS_TREE_UNVERIFIED");
    assert.equal(error.details?.reason, "settlement-deadline");
    assert.equal(error.details?.elapsedMs, 8);
    assert.equal(error.details?.stageElapsedMs, 18);
    return true;
  });
  assert.equal(released, true);
  assert.equal(scheduled[3].cancelled, true);
});

test("native stage failures retain only a bounded reporter-safe compiler cause", async () => {
  const compilerCause = new Error("synthetic underlying compiler cause");
  const compilerFailure = new Error("synthetic bounded compiler diagnostic", { cause: compilerCause });
  await assert.rejects(
    runWindowsNativeStage("compilation", { timeoutMs: 1_000 }, () => Promise.reject(compilerFailure)),
    (error) => {
      assert.match(error.message, /synthetic bounded compiler diagnostic/u);
      assert.notEqual(error.cause, compilerFailure);
      assert.equal(error.cause?.name, "NativeStageDiagnostic");
      assert.match(error.cause?.message, /synthetic bounded compiler diagnostic/u);
      assert.equal(error.cause?.cause, undefined);
      assert.doesNotMatch(error.cause?.stack, /windows-job-supervisor\.native\.test\.mjs:\d+/u);
      return true;
    }
  );
});

test("native stage diagnostics suppress oversized, credential, private-path, and malformed errors", async () => {
  const token = `ghp_${"c".repeat(32)}`;
  const privatePath = join(process.cwd(), "private-native-stage", "compiler.log");
  const malformedSentinel = "OW_MALFORMED_NATIVE_STAGE_SENTINEL";
  const malformed = new Error("unreachable malformed error detail");
  Object.defineProperty(malformed, "message", {
    configurable: true,
    get() {
      throw new Error(malformedSentinel);
    }
  });
  const cases = [
    {
      error: new Error("x".repeat(EDITOR_HARNESS_ERROR_MAX_CHARACTERS + 1)),
      absent: /x{32}/u,
      present: /complete value exceeded the fixed safety limit/u
    },
    {
      error: new Error(`Authorization: Bearer ${token} https://example.invalid/a?sig=${token}`),
      absent: new RegExp(token, "u"),
      present: /Authorization: <redacted>/u
    },
    {
      error: new Error(`compiler failed at ${privatePath}`),
      absent: new RegExp(privatePath.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"),
      present: /<repository>/u
    },
    {
      error: malformed,
      absent: new RegExp(malformedSentinel, "u"),
      present: /unreadable/iu
    }
  ];
  for (const [index, diagnosticCase] of cases.entries()) {
    await assert.rejects(
      runWindowsNativeStage(`diagnostic probe ${index}`, { timeoutMs: 1_000 }, () =>
        Promise.reject(diagnosticCase.error)
      ),
      (error) => {
        assert.match(error.message, diagnosticCase.present);
        assert.doesNotMatch(error.message, diagnosticCase.absent);
        assert.equal(error.cause?.name, "NativeStageDiagnostic");
        assert.match(error.cause?.message, diagnosticCase.present);
        assert.doesNotMatch(error.cause?.message, diagnosticCase.absent);
        assert.doesNotMatch(error.cause?.stack, diagnosticCase.absent);
        assert.equal(error.cause?.cause, undefined);
        return true;
      }
    );
  }
});

test("native stage cancellation and release failures publish only reporter-safe causes", async () => {
  const token = `ghp_${"r".repeat(32)}`;
  const privatePath = join(process.cwd(), "private-native-stage", "settlement.log");
  const stdoutSecret = "OW_HOSTILE_NATIVE_STDOUT";
  const stderrSecret = "OW_HOSTILE_NATIVE_STDERR";
  const nestedCauseSecret = "OW_HOSTILE_NATIVE_NESTED_CAUSE";
  const forbidden = [token, privatePath, stdoutSecret, stderrSecret, nestedCauseSecret];
  const hostileFailure = (label) => {
    const error = new AggregateError(
      [new Error(`Authorization: Bearer ${token}`), new Error(`native stage ${label} failed at ${privatePath}`)],
      `hostile ${label} failure`,
      { cause: new Error(nestedCauseSecret) }
    );
    error.stdout = stdoutSecret;
    error.stderr = stderrSecret;
    return error;
  };
  const assertSafeCause = (error, rawCause, label) => {
    assert.notEqual(error.cause, rawCause);
    assert.equal(error.cause?.name, "NativeStageDiagnostic");
    assert.equal(error.cause?.cause, undefined);
    assert.match(error.cause?.message, new RegExp(`hostile ${label} failure`, "u"));
    assert.match(error.cause?.message, /Authorization: <redacted>/u);
    assert.match(error.cause?.message, /<repository>/u);
    const published = [error.message, error.cause?.message, error.cause?.stack].join("\n");
    for (const secret of forbidden) assert.equal(published.includes(secret), false);
    return true;
  };

  const deadlineCause = hostileFailure("deadline settlement");
  await assert.rejects(
    runWindowsNativeStage(
      "deadline redaction probe",
      { timeoutMs: 5, settlementTimeoutMs: 100 },
      (abortSignal) =>
        new Promise((_resolve, reject) => {
          const rejectAfterAbort = () => queueMicrotask(() => reject(deadlineCause));
          abortSignal.addEventListener("abort", rejectAfterAbort, { once: true });
          if (abortSignal.aborted) rejectAfterAbort();
        })
    ),
    (error) => {
      assert.equal(error.code, "EDITOR_ACCEPTANCE_STAGE_DEADLINE");
      return assertSafeCause(error, deadlineCause, "deadline settlement");
    }
  );

  const outerCause = hostileFailure("outer abort settlement");
  const outerController = new AbortController();
  const outerStage = runWindowsNativeStage(
    "outer abort redaction probe",
    { timeoutMs: 1_000, settlementTimeoutMs: 100, outerAbortSignal: outerController.signal },
    (abortSignal) =>
      new Promise((_resolve, reject) => {
        const rejectAfterAbort = () => setImmediate(() => reject(outerCause));
        abortSignal.addEventListener("abort", rejectAfterAbort, { once: true });
        if (abortSignal.aborted) rejectAfterAbort();
      })
  );
  setImmediate(() => outerController.abort(new Error("synthetic enclosing abort")));
  await assert.rejects(outerStage, (error) => {
    assert.equal(error.code, "EDITOR_ACCEPTANCE_STAGE_ABORTED");
    return assertSafeCause(error, outerCause, "outer abort settlement");
  });

  const releaseCause = hostileFailure("bounded release");
  await assert.rejects(
    runWindowsNativeStage("release redaction probe", { timeoutMs: 5, settlementTimeoutMs: 5 }, () => ({
      promise: new Promise(() => undefined),
      releaseAfterSettlementDeadline() {
        throw releaseCause;
      }
    })),
    (error) => {
      assert.equal(error.code, "EDITOR_PROCESS_TREE_UNVERIFIED");
      return assertSafeCause(error, releaseCause, "bounded release");
    }
  );
});

test("native stage failures surface the bounded production compiler diagnostic", async () => {
  const directory = await mkdtemp(join(tmpdir(), "openwrangler-supervisor-compiler-diagnostic-"));
  const environment = createEditorAcceptanceEnvironmentForPlatform(process.env, {}, "win32");
  configureEditorAcceptanceTempRoot(directory, environment);
  const compiler = fakeWindowsCompiler({ closeOnKill: false, pid: 17939 });
  let stage;
  try {
    stage = runWindowsNativeStage("compilation", { timeoutMs: 1_000 }, () =>
      prepareWindowsEditorProcessSupervisor(environment, {
        platform: "win32",
        buildTimeoutMs: 1_000,
        spawnProcess: () => {
          queueMicrotask(() => {
            compiler.child.stderr.write("OPEN_WRANGLER_WINDOWS_SUPERVISOR_ERROR:bootstrap\n");
            compiler.child.exitCode = 125;
            compiler.child.stdout.end();
            compiler.child.stderr.end();
            compiler.child.emit("close", 125, null);
          });
          return compiler.child;
        }
      })
    );
    await assert.rejects(stage, (error) => {
      assert.match(error.message, /compilation stage failed \(nonzero-exit; code 125; signal none\)/u);
      assert.match(error.message, /OPEN_WRANGLER_WINDOWS_SUPERVISOR_ERROR:bootstrap/u);
      assert.equal(error.cause?.name, "NativeStageDiagnostic");
      assert.match(error.cause?.message, /compilation stage failed/u);
      assert.equal(error.cause?.cause, undefined);
      return true;
    });
  } finally {
    if (stage) await Promise.allSettled([stage]);
    await rm(directory, { recursive: true, force: true });
  }
});

test(
  "an enclosing native-test abort cancels and settles the active stage before reporting",
  { timeout: 5_000 },
  async () => {
    const outerController = new AbortController();
    let cancellationObserved = false;
    let operationSettled = false;
    const stage = runWindowsNativeStage(
      "outer cancellation probe",
      { timeoutMs: 1_000, settlementTimeoutMs: 100, outerAbortSignal: outerController.signal },
      (abortSignal) =>
        new Promise((resolve) => {
          abortSignal.addEventListener(
            "abort",
            () => {
              cancellationObserved = true;
              setTimeout(() => {
                operationSettled = true;
                resolve();
              }, 10);
            },
            { once: true }
          );
        })
    );
    setImmediate(() => outerController.abort(new Error("synthetic enclosing timeout")));
    await assert.rejects(stage, (error) => {
      assert.equal(error.code, "EDITOR_ACCEPTANCE_STAGE_ABORTED");
      assert.equal(error.details?.stage, "outer cancellation probe");
      assert.equal(error.details?.reason, "outer-abort");
      assert.equal(error.details?.limitMs, 1_000);
      assert.equal(error.details?.elapsedMs >= 0, true);
      assert.equal(error.details?.elapsedMs < 1_000, true);
      assert.equal(error.details?.treeVerifiedStopped, true);
      return true;
    });
    assert.equal(cancellationObserved, true);
    assert.equal(operationSettled, true);
  }
);

test("a never-closing filesystem worker releases ordinary callbacks and absorbs one late error", async () => {
  const worker = new EventEmitter();
  worker.pid = 17922;
  worker.exitCode = null;
  worker.signalCode = null;
  let killCount = 0;
  let unrefCount = 0;
  worker.kill = () => {
    killCount += 1;
    return true;
  };
  worker.unref = () => {
    unrefCount += 1;
  };
  const startedAt = performance.now();
  await assert.rejects(
    runWindowsNativeFilesystemStage(
      "never-close filesystem probe",
      { timeoutMs: 10, settlementTimeoutMs: 20 },
      "",
      [],
      { spawnFilesystemWorker: () => worker }
    ),
    (error) => {
      assert.equal(error.code, "EDITOR_PROCESS_TREE_UNVERIFIED");
      assert.deepEqual(
        {
          stage: error.details?.stage,
          reason: error.details?.reason,
          limitMs: error.details?.limitMs,
          triggerReason: error.details?.triggerReason,
          treeVerifiedStopped: error.details?.treeVerifiedStopped
        },
        {
          stage: "never-close filesystem probe",
          reason: "settlement-deadline",
          limitMs: 20,
          triggerReason: "deadline",
          treeVerifiedStopped: false
        }
      );
      assert.equal(error.details?.elapsedMs >= 20, true);
      assert.equal(error.details?.elapsedMs < 1_000, true);
      assert.equal(error.details?.stageElapsedMs >= 30, true);
      return true;
    }
  );
  assert.equal(performance.now() - startedAt < 1_000, true);
  assert.equal(killCount, 1);
  assert.equal(unrefCount, 1);
  assert.equal(worker.listenerCount("error"), 1);
  assert.equal(worker.listenerCount("close"), 1);
  assert.doesNotThrow(() => worker.emit("error", new Error("synthetic late filesystem worker error")));
  worker.emit("close", null, "SIGKILL");
  assert.equal(worker.listenerCount("error"), 0);
  assert.equal(worker.listenerCount("close"), 0);
});

test("a PID-bearing filesystem worker error retains close ownership until bounded release", async () => {
  const worker = new EventEmitter();
  worker.pid = 17924;
  worker.exitCode = null;
  worker.signalCode = null;
  const workerError = new Error("synthetic started-worker failure before close");
  let killCount = 0;
  let unrefCount = 0;
  let closeOwnershipRetainedAfterError = false;
  worker.kill = () => {
    killCount += 1;
    return true;
  };
  worker.unref = () => {
    unrefCount += 1;
  };

  const startedAt = performance.now();
  await assert.rejects(
    runWindowsNativeFilesystemStage(
      "error-before-close filesystem probe",
      { timeoutMs: 15, settlementTimeoutMs: 25 },
      "",
      [],
      {
        spawnFilesystemWorker: () => {
          queueMicrotask(() => {
            worker.emit("error", workerError);
            closeOwnershipRetainedAfterError =
              worker.listenerCount("error") === 1 && worker.listenerCount("close") === 1;
          });
          return worker;
        }
      }
    ),
    (error) => {
      assert.equal(error.code, "EDITOR_PROCESS_TREE_UNVERIFIED");
      assert.notEqual(error.cause, workerError);
      assert.equal(error.cause?.name, "NativeStageDiagnostic");
      assert.match(error.cause?.message, /synthetic started-worker failure before close/u);
      assert.equal(error.cause?.cause, undefined);
      assert.deepEqual(
        {
          stage: error.details?.stage,
          reason: error.details?.reason,
          limitMs: error.details?.limitMs,
          triggerReason: error.details?.triggerReason,
          treeVerifiedStopped: error.details?.treeVerifiedStopped
        },
        {
          stage: "error-before-close filesystem probe",
          reason: "settlement-deadline",
          limitMs: 25,
          triggerReason: "deadline",
          treeVerifiedStopped: false
        }
      );
      assert.equal(error.details?.elapsedMs >= 20, true);
      assert.equal(error.details?.stageElapsedMs >= 32, true);
      return true;
    }
  );
  const elapsedMs = performance.now() - startedAt;
  assert.equal(elapsedMs >= 32, true);
  assert.equal(elapsedMs < 1_000, true);
  assert.equal(closeOwnershipRetainedAfterError, true);
  assert.equal(killCount, 1);
  assert.equal(unrefCount, 1);
  assert.equal(worker.listenerCount("error"), 1);
  assert.equal(worker.listenerCount("close"), 1);
  assert.doesNotThrow(() => worker.emit("error", new Error("synthetic post-release worker error")));
  worker.emit("close", null, "SIGKILL");
  assert.equal(worker.listenerCount("error"), 0);
  assert.equal(worker.listenerCount("close"), 0);
});

test("a never-closing filesystem worker preserves its sole kill failure", async () => {
  const worker = new EventEmitter();
  worker.pid = 17925;
  worker.exitCode = null;
  worker.signalCode = null;
  const killError = new Error("synthetic filesystem worker kill failure");
  let killCount = 0;
  let unrefCount = 0;
  worker.kill = () => {
    killCount += 1;
    throw killError;
  };
  worker.unref = () => {
    unrefCount += 1;
  };

  await assert.rejects(
    runWindowsNativeFilesystemStage(
      "kill-failure filesystem probe",
      { timeoutMs: 10, settlementTimeoutMs: 20 },
      "",
      [],
      { spawnFilesystemWorker: () => worker }
    ),
    (error) => {
      assert.equal(error.code, "EDITOR_PROCESS_TREE_UNVERIFIED");
      assert.equal(error.details?.stage, "kill-failure filesystem probe");
      assert.equal(error.details?.reason, "settlement-deadline");
      assert.equal(error.details?.treeVerifiedStopped, false);
      assert.equal(error.cause?.code, "EDITOR_PROCESS_TREE_UNVERIFIED");
      assert.match(error.cause?.message, /worker could not be cancelled/u);
      assert.equal(error.cause?.cause, undefined);
      return true;
    }
  );
  assert.equal(killCount, 1);
  assert.equal(unrefCount, 1);
  assert.equal(worker.listenerCount("error"), 1);
  assert.equal(worker.listenerCount("close"), 1);
  worker.emit("close", null, "SIGKILL");
  assert.equal(worker.listenerCount("error"), 0);
  assert.equal(worker.listenerCount("close"), 0);
});

test("filesystem worker release aggregates worker, kill, and unref failures in order", async () => {
  const worker = new EventEmitter();
  worker.pid = 17926;
  worker.exitCode = null;
  worker.signalCode = null;
  const workerError = new Error("synthetic filesystem worker failure");
  const killError = new Error("synthetic filesystem worker cancellation failure");
  const unrefError = new Error("synthetic filesystem worker unref failure");
  let killCount = 0;
  let unrefCount = 0;
  worker.kill = () => {
    killCount += 1;
    throw killError;
  };
  worker.unref = () => {
    unrefCount += 1;
    throw unrefError;
  };

  await assert.rejects(
    runWindowsNativeFilesystemStage(
      "combined-failure filesystem probe",
      { timeoutMs: 10, settlementTimeoutMs: 20 },
      "",
      [],
      {
        spawnFilesystemWorker: () => {
          queueMicrotask(() => worker.emit("error", workerError));
          return worker;
        }
      }
    ),
    (error) => {
      assert.equal(error.code, "EDITOR_PROCESS_TREE_UNVERIFIED");
      assert.equal(error.details?.treeVerifiedStopped, false);
      assert.equal(error.cause?.name, "NativeStageDiagnostic");
      assert.equal(error.cause?.code, "EDITOR_PROCESS_TREE_UNVERIFIED");
      const workerIndex = error.cause.message.indexOf(workerError.message);
      const killIndex = error.cause.message.indexOf("worker could not be cancelled");
      const unrefIndex = error.cause.message.indexOf(unrefError.message);
      assert.equal(workerIndex >= 0, true);
      assert.equal(killIndex > workerIndex, true);
      assert.equal(unrefIndex > killIndex, true);
      assert.equal(error.cause?.cause, undefined);
      return true;
    }
  );
  assert.equal(killCount, 1);
  assert.equal(unrefCount, 1);
  assert.equal(worker.listenerCount("error"), 1);
  assert.equal(worker.listenerCount("close"), 1);
  assert.doesNotThrow(() => worker.emit("error", new Error("synthetic post-release combined failure")));
  worker.emit("close", null, "SIGKILL");
  assert.equal(worker.listenerCount("error"), 0);
  assert.equal(worker.listenerCount("close"), 0);
});

test("production signal ownership cancels supervisor compilation before target launch", async () => {
  const directory = await mkdtemp(join(tmpdir(), "openwrangler-supervisor-production-signal-"));
  const environment = createEditorAcceptanceEnvironmentForPlatform(process.env, {}, "win32");
  configureEditorAcceptanceTempRoot(directory, environment);
  const signalSource = new EventEmitter();
  const compiler = fakeWindowsCompiler({ closeOnKill: true, pid: 17923 });
  try {
    await assert.rejects(
      prepareWindowsEditorProcessSupervisorWithSignals(
        environment,
        {
          platform: "win32",
          buildTimeoutMs: 1_000,
          buildSettlementTimeoutMs: 100,
          spawnProcess: () => {
            queueMicrotask(() => signalSource.emit("SIGTERM"));
            return compiler.child;
          },
          terminateBuildProcessTree(child) {
            child.kill("SIGKILL");
            return { treeVerifiedStopped: true };
          }
        },
        signalSource
      ),
      (error) => {
        assert.equal(error.code, "EDITOR_ACCEPTANCE_STAGE_ABORTED");
        assert.equal(error.details?.stage, "windows-supervisor-compilation");
        assert.equal(error.details?.reason, "cancelled");
        assert.equal(error.details?.limitMs, 1_000);
        assert.equal(error.details?.elapsedMs >= 0, true);
        assert.equal(error.details?.elapsedMs < 1_000, true);
        assert.equal(error.details?.treeVerifiedStopped, true);
        assert.equal(error.details?.compilerClosed, true);
        assert.equal(error.details?.compilerTreeTerminated, true);
        return true;
      }
    );
    assert.equal(signalSource.listenerCount("SIGINT"), 0);
    assert.equal(signalSource.listenerCount("SIGTERM"), 0);
    assert.deepEqual(compiler.state(), { killCount: 1, closeCount: 1, closeTimerActive: false });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

function fakeWindowsCompiler({ closeOnKill, closeDelayMs = 0, pid }) {
  const child = new EventEmitter();
  child.pid = pid;
  child.exitCode = null;
  child.signalCode = null;
  child.stdin = undefined;
  child.stdout = new PassThrough({ autoDestroy: false });
  child.stderr = new PassThrough({ autoDestroy: false });
  let killCount = 0;
  let closeCount = 0;
  let unrefCount = 0;
  let closeTimer;
  child.kill = (signal) => {
    killCount += 1;
    if (closeOnKill && closeCount === 0 && closeTimer === undefined) {
      closeTimer = setTimeout(() => {
        closeTimer = undefined;
        closeCount += 1;
        child.signalCode = signal;
        child.stdout.end();
        child.stderr.end();
        child.emit("exit", null, signal);
        child.emit("close", null, signal);
      }, closeDelayMs);
    }
    return true;
  };
  child.unref = () => {
    unrefCount += 1;
  };
  return {
    child,
    lifecycle() {
      return {
        closeListeners: child.listenerCount("close"),
        errorListeners: child.listenerCount("error"),
        stderrDataListeners: child.stderr.listenerCount("data"),
        stdoutDataListeners: child.stdout.listenerCount("data"),
        unrefCount
      };
    },
    state() {
      return { killCount, closeCount, closeTimerActive: closeTimer !== undefined };
    }
  };
}

test("the Windows supervisor compiler stays attached while taskkill owns descendant termination", async () => {
  const directory = await mkdtemp(join(tmpdir(), "openwrangler-supervisor-compiler-spawn-options-"));
  const environment = createEditorAcceptanceEnvironmentForPlatform(process.env, {}, "win32");
  configureEditorAcceptanceTempRoot(directory, environment);
  const spawnFailure = new Error("synthetic compiler spawn failure");
  let spawnOptions;
  try {
    await assert.rejects(
      prepareWindowsEditorProcessSupervisor(environment, {
        platform: "win32",
        spawnProcess(_executable, _args, options) {
          spawnOptions = options;
          throw spawnFailure;
        }
      }),
      (error) => {
        assert.equal(error.cause, spawnFailure);
        return true;
      }
    );
    assert.deepEqual(
      {
        detached: spawnOptions.detached,
        windowsHide: spawnOptions.windowsHide,
        stdio: spawnOptions.stdio
      },
      {
        detached: false,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"]
      }
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("production compiler close preserves a PID-bearing error as authoritative", async () => {
  const directory = await mkdtemp(join(tmpdir(), "openwrangler-supervisor-pid-error-close-"));
  const environment = createEditorAcceptanceEnvironmentForPlatform(process.env, {}, "win32");
  configureEditorAcceptanceTempRoot(directory, environment);
  const compiler = fakeWindowsCompiler({ closeOnKill: false, pid: 17927 });
  const compilerError = new Error("synthetic PID-bearing compiler failure before close");
  try {
    await assert.rejects(
      prepareWindowsEditorProcessSupervisor(environment, {
        platform: "win32",
        buildTimeoutMs: 1_000,
        spawnProcess: () => {
          queueMicrotask(() => {
            compiler.child.emit("error", compilerError);
            compiler.child.exitCode = 0;
            compiler.child.stdout.end();
            compiler.child.stderr.end();
            compiler.child.emit("exit", 0, null);
            compiler.child.emit("close", 0, null);
          });
          return compiler.child;
        }
      }),
      (error) => {
        assert.equal(error.details?.stage, "windows-supervisor-compilation");
        assert.equal(error.details?.reason, "child-error");
        assert.equal(error.details?.treeVerifiedStopped, true);
        assert.equal(error.cause, compilerError);
        return true;
      }
    );
    assert.deepEqual(compiler.state(), { killCount: 0, closeCount: 0, closeTimerActive: false });
    assert.deepEqual(compiler.lifecycle(), {
      closeListeners: 0,
      errorListeners: 0,
      stderrDataListeners: 0,
      stdoutDataListeners: 0,
      unrefCount: 0
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("an asynchronous compiler error without a PID remains a spawn failure", async () => {
  const directory = await mkdtemp(join(tmpdir(), "openwrangler-supervisor-no-pid-error-close-"));
  const environment = createEditorAcceptanceEnvironmentForPlatform(process.env, {}, "win32");
  configureEditorAcceptanceTempRoot(directory, environment);
  const compiler = fakeWindowsCompiler({ closeOnKill: false, pid: undefined });
  const compilerError = new Error("synthetic asynchronous compiler spawn failure");
  try {
    await assert.rejects(
      prepareWindowsEditorProcessSupervisor(environment, {
        platform: "win32",
        buildTimeoutMs: 1_000,
        spawnProcess: () => {
          setTimeout(() => {
            compiler.child.emit("error", compilerError);
            compiler.child.stdout.end();
            compiler.child.stderr.end();
            compiler.child.emit("close", null, null);
          }, 0);
          return compiler.child;
        }
      }),
      (error) => {
        assert.equal(error.details?.stage, "windows-supervisor-compilation");
        assert.equal(error.details?.reason, "spawn-error");
        assert.equal(error.details?.treeVerifiedStopped, true);
        assert.equal(error.cause, compilerError);
        return true;
      }
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("forced compiler settlement preserves a PID-bearing error after successful close", async () => {
  const directory = await mkdtemp(join(tmpdir(), "openwrangler-supervisor-pid-error-forced-close-"));
  const environment = createEditorAcceptanceEnvironmentForPlatform(process.env, {}, "win32");
  configureEditorAcceptanceTempRoot(directory, environment);
  const compiler = fakeWindowsCompiler({ closeOnKill: true, pid: 17929 });
  const compilerError = new Error("synthetic compiler error before successful forced close");
  try {
    await assert.rejects(
      prepareWindowsEditorProcessSupervisor(environment, {
        platform: "win32",
        buildTimeoutMs: 10,
        buildSettlementTimeoutMs: 100,
        spawnProcess: () => {
          queueMicrotask(() => compiler.child.emit("error", compilerError));
          return compiler.child;
        },
        terminateBuildProcessTree(child) {
          child.kill("SIGKILL");
          return { treeVerifiedStopped: true };
        }
      }),
      (error) => {
        assert.equal(error.code, "EDITOR_ACCEPTANCE_STAGE_DEADLINE");
        assert.equal(error.details?.stage, "windows-supervisor-compilation");
        assert.equal(error.details?.compilerClosed, true);
        assert.equal(error.details?.compilerTreeTerminated, true);
        assert.equal(error.details?.treeVerifiedStopped, true);
        assert.equal(error.cause, compilerError);
        return true;
      }
    );
    assert.deepEqual(compiler.state(), { killCount: 1, closeCount: 1, closeTimerActive: false });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("settlement deadline retains prompt terminator and compiler errors in order", async () => {
  const directory = await mkdtemp(join(tmpdir(), "openwrangler-supervisor-terminator-error-order-"));
  const environment = createEditorAcceptanceEnvironmentForPlatform(process.env, {}, "win32");
  configureEditorAcceptanceTempRoot(directory, environment);
  const compiler = fakeWindowsCompiler({ closeOnKill: false, pid: 17930 });
  const compilerError = new Error("synthetic compiler error without close");
  const terminatorError = new Error("synthetic prompt compiler-tree termination failure");
  try {
    await assert.rejects(
      prepareWindowsEditorProcessSupervisor(environment, {
        platform: "win32",
        buildTimeoutMs: 10,
        buildSettlementTimeoutMs: 20,
        spawnProcess: () => {
          queueMicrotask(() => compiler.child.emit("error", compilerError));
          return compiler.child;
        },
        terminateBuildProcessTree: () => Promise.reject(terminatorError)
      }),
      (error) => {
        assert.equal(error.code, "EDITOR_PROCESS_TREE_UNVERIFIED");
        assert.equal(error.details?.compilerClosed, false);
        assert.equal(error.details?.treeVerifiedStopped, false);
        assert.equal(error.cause instanceof AggregateError, true);
        assert.equal(error.cause.errors.length, 3);
        assert.equal(error.cause.errors[0]?.code, "EDITOR_ACCEPTANCE_DEADLINE");
        assert.equal(error.cause.errors[1], terminatorError);
        assert.equal(error.cause.errors[2], compilerError);
        return true;
      }
    );
    assert.deepEqual(compiler.lifecycle(), {
      closeListeners: 1,
      errorListeners: 1,
      stderrDataListeners: 0,
      stdoutDataListeners: 0,
      unrefCount: 1
    });
    compiler.child.emit("close", null, "SIGKILL");
    assert.equal(compiler.child.listenerCount("error"), 0);
    assert.equal(compiler.child.listenerCount("close"), 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("production compiler bounded release preserves a prior PID-bearing error", async () => {
  const directory = await mkdtemp(join(tmpdir(), "openwrangler-supervisor-pid-error-release-"));
  const environment = createEditorAcceptanceEnvironmentForPlatform(process.env, {}, "win32");
  configureEditorAcceptanceTempRoot(directory, environment);
  const compiler = fakeWindowsCompiler({ closeOnKill: false, pid: 17928 });
  const compilerError = new Error("synthetic PID-bearing compiler failure before bounded release");
  try {
    await assert.rejects(
      prepareWindowsEditorProcessSupervisor(environment, {
        platform: "win32",
        buildTimeoutMs: 10,
        buildSettlementTimeoutMs: 20,
        spawnProcess: () => {
          queueMicrotask(() => compiler.child.emit("error", compilerError));
          return compiler.child;
        },
        terminateBuildProcessTree: () => new Promise(() => {})
      }),
      (error) => {
        assert.equal(error.code, "EDITOR_PROCESS_TREE_UNVERIFIED");
        assert.equal(error.details?.stage, "windows-supervisor-compilation");
        assert.equal(error.details?.treeVerifiedStopped, false);
        assert.equal(error.cause instanceof AggregateError, true);
        assert.equal(error.cause.errors.length, 2);
        assert.equal(error.cause.errors[0]?.code, "EDITOR_ACCEPTANCE_DEADLINE");
        assert.equal(error.cause.errors[1], compilerError);
        return true;
      }
    );
    assert.deepEqual(compiler.lifecycle(), {
      closeListeners: 1,
      errorListeners: 1,
      stderrDataListeners: 0,
      stdoutDataListeners: 0,
      unrefCount: 1
    });
    assert.doesNotThrow(() => compiler.child.emit("error", new Error("synthetic late compiler error")));
    compiler.child.emit("close", 0, null);
    assert.equal(compiler.child.listenerCount("error"), 0);
    assert.equal(compiler.child.listenerCount("close"), 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test(
  "the real Windows supervisor owns every native lifecycle stage",
  { skip: process.platform !== "win32", timeout: WINDOWS_NATIVE_TEST_TIMEOUT_MS },
  async (context) => {
    const outerAbortSignal = context.signal;
    const privateParent = join(tmpdir(), "ow");
    await mkdir(privateParent, { recursive: true, mode: 0o700 });
    const privateRoot = await mkdtemp(join(privateParent, "x-"));
    const environment = createEditorAcceptanceEnvironmentForPlatform(process.env, {}, "win32");
    configureEditorAcceptanceTempRoot(privateRoot, environment);
    let removePrivateRoot = true;
    try {
      const supervisorReceipt = await runWindowsNativeStage(
        "compilation",
        {
          timeoutMs: WINDOWS_NATIVE_BUILD_TIMEOUT_MS + WINDOWS_NATIVE_BUILD_SETTLEMENT_TIMEOUT_MS + 5_000,
          settlementTimeoutMs: WINDOWS_NATIVE_BUILD_SETTLEMENT_TIMEOUT_MS,
          outerAbortSignal
        },
        (buildAbortSignal) =>
          prepareWindowsEditorProcessSupervisor(environment, {
            platform: "win32",
            buildTimeoutMs: WINDOWS_NATIVE_BUILD_TIMEOUT_MS,
            buildSettlementTimeoutMs: WINDOWS_NATIVE_BUILD_SETTLEMENT_TIMEOUT_MS,
            buildAbortSignal
          })
      );
      const natural = await runWindowsNativeCommandStage(
        "natural containment",
        { timeoutMs: 60_000, outerAbortSignal },
        {
          executable: process.execPath,
          args: [
            "-e",
            [
              "const { spawn } = require('node:child_process');",
              "const targetStartedAt = Date.now();",
              "const descendant = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 1500)'], { detached: true, stdio: 'ignore' });",
              "descendant.unref();",
              "process.stdout.write(JSON.stringify({ targetStartedAt, descendantPid: descendant.pid }));",
              "process.stderr.write('native stderr');"
            ].join(" ")
          ],
          environment,
          label: "real Windows supervisor natural containment"
        },
        {
          platform: "win32",
          timeoutMs: 30_000,
          ...WINDOWS_NATIVE_COMMAND_CLEANUP
        }
      );
      assert.equal(natural.stderr, "native stderr");
      const naturalEnvelope = JSON.parse(natural.stdout);
      assert.equal(Number.isSafeInteger(naturalEnvelope.targetStartedAt), true);
      assert.equal(Number.isSafeInteger(naturalEnvelope.descendantPid), true);
      assert.equal(
        processIsRunning(naturalEnvelope.descendantPid),
        false,
        "the supervisor must not return while the naturally exiting descendant is still alive"
      );
      assert.ok(
        Date.now() - naturalEnvelope.targetStartedAt >= 500,
        "the load-tolerant lower bound must still reject a supervisor that returned with its descendant alive"
      );

      const timeoutRejection = await runWindowsNativeStage(
        "forced termination and attestation",
        { timeoutMs: 30_000, outerAbortSignal },
        async (abortSignal) => {
          const signalSource = new EventEmitter();
          const cancel = () => signalSource.emit("SIGTERM");
          abortSignal.addEventListener("abort", cancel, { once: true });
          let rejection;
          try {
            await runBoundedEditorCommand(
              {
                executable: process.execPath,
                args: [
                  "-e",
                  "const { spawn } = require('node:child_process'); spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' }).unref(); setInterval(() => {}, 1000);"
                ],
                environment,
                label: "real Windows supervisor forced termination"
              },
              {
                platform: "win32",
                timeoutMs: 2_000,
                ...WINDOWS_NATIVE_COMMAND_CLEANUP,
                signalSource
              }
            );
          } catch (error) {
            rejection = error;
          } finally {
            abortSignal.removeEventListener("abort", cancel);
          }
          if (editorProcessTreeMayBeLive(rejection)) removePrivateRoot = false;
          assert.ok(rejection && typeof rejection === "object");
          assert.equal("code" in rejection && rejection.code === "EDITOR_COMMAND_RESOURCE_RELEASE_FAILED", false);
          assert.equal("message" in rejection && typeof rejection.message === "string", true);
          assert.match(rejection.message, /timed out after 2000 ms/u);
          return rejection;
        }
      );
      assert.equal(editorProcessTreeMayBeLive(timeoutRejection), false);

      const malformedProbe = await runWindowsNativeCommandStage(
        "malformed-frame rejection",
        { timeoutMs: 60_000, outerAbortSignal },
        {
          executable: process.execPath,
          args: [
            "-e",
            [
              "const { spawn } = require('node:child_process');",
              "const child = spawn(process.argv[1], [], { env: process.env, windowsHide: true, stdio: ['pipe', 'ignore', 'pipe'] });",
              "let stderr = ''; let finished = false;",
              "const finish = (code, message) => { if (finished) return; finished = true; clearTimeout(timer); if (message) process.stderr.write(message); process.exitCode = code; };",
              "const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} finish(3, 'inner supervisor timeout'); }, 15000);",
              "child.stderr.setEncoding('utf8');",
              "child.stderr.on('data', chunk => { stderr += chunk; if (Buffer.byteLength(stderr, 'utf8') > 4096) { try { child.kill('SIGKILL'); } catch {} finish(4, 'inner supervisor output limit'); } });",
              "child.once('error', () => finish(5, 'inner supervisor spawn failure'));",
              "child.once('close', (code, signal) => { const normalized = stderr.replace(/\\r\\n/gu, '\\n'); if (code === 125 && signal === null && normalized === 'OPEN_WRANGLER_WINDOWS_SUPERVISOR_ERROR:protocol\\n') { process.stdout.write('malformed-frame-rejected'); finish(0); } else finish(6, 'inner supervisor protocol mismatch'); });",
              "child.stdin.end('{}\\n', 'utf8');"
            ].join(" "),
            supervisorReceipt.executable
          ],
          environment,
          label: "real Windows supervisor malformed-frame rejection"
        },
        {
          platform: "win32",
          timeoutMs: 30_000,
          ...WINDOWS_NATIVE_COMMAND_CLEANUP
        }
      );
      assert.deepEqual(malformedProbe, { stdout: "malformed-frame-rejected", stderr: "" });

      await runWindowsNativeFilesystemStage(
        "executable replacement rejection",
        {
          timeoutMs: WINDOWS_NATIVE_SYNC_STAGE_TIMEOUT_MS,
          settlementTimeoutMs: 5_000,
          outerAbortSignal
        },
        "const fs = require('node:fs'); fs.renameSync(process.argv[1], `${process.argv[1]}.original`); fs.writeFileSync(process.argv[1], 'replacement', 'utf8');",
        [supervisorReceipt.executable]
      );
      assert.throws(
        () =>
          spawnOwnedEditorProcess(
            process.execPath,
            ["--version"],
            { env: environment, stdio: ["ignore", "pipe", "pipe"] },
            {
              platform: "win32",
              supervisorReceipt,
              spawnProcess: () => assert.fail("a replaced supervisor must fail before spawn")
            }
          ),
        /changed before launch/u
      );
    } catch (error) {
      if (editorProcessTreeMayBeLive(error)) removePrivateRoot = false;
      throw error;
    } finally {
      if (removePrivateRoot) {
        await runWindowsNativeFilesystemStage(
          "private-root cleanup",
          {
            timeoutMs: WINDOWS_NATIVE_SYNC_STAGE_TIMEOUT_MS,
            settlementTimeoutMs: 5_000,
            outerAbortSignal
          },
          "require('node:fs').rmSync(process.argv[1], { recursive: true, force: true });",
          [privateRoot]
        );
      }
    }
  }
);

test(
  "a just-in-time Windows supervisor compiler close is observed before the settlement deadline",
  { timeout: 5_000 },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "openwrangler-supervisor-delayed-"));
    const environment = createEditorAcceptanceEnvironmentForPlatform(process.env, {}, "win32");
    configureEditorAcceptanceTempRoot(directory, environment);
    const compiler = fakeWindowsCompiler({ closeOnKill: true, closeDelayMs: 30, pid: 17911 });
    try {
      await assert.rejects(
        prepareWindowsEditorProcessSupervisor(environment, {
          platform: "win32",
          buildTimeoutMs: 10,
          buildSettlementTimeoutMs: 100,
          spawnProcess: () => compiler.child,
          terminateBuildProcessTree(child) {
            child.kill("SIGKILL");
            return { treeVerifiedStopped: false };
          }
        }),
        (error) => {
          assert.equal(editorProcessTreeMayBeLive(error), true);
          assert.equal(error.details?.stage, "windows-supervisor-compilation");
          assert.equal(error.details?.reason, "deadline");
          assert.equal(error.details?.limitMs, 10);
          assert.equal(error.details?.elapsedMs >= 10, true);
          assert.equal(error.details?.elapsedMs < 1_000, true);
          assert.equal(error.details?.treeVerifiedStopped, false);
          assert.equal(error.details?.compilerClosed, true);
          assert.match(error.message, /compilation stage exceeded 10 ms/u);
          return true;
        }
      );
      assert.deepEqual(compiler.state(), { killCount: 1, closeCount: 1, closeTimerActive: false });
      assert.equal(compiler.child.stdout.destroyed, true);
      assert.equal(compiler.child.stderr.destroyed, true);
      await assert.rejects(
        prepareWindowsEditorProcessSupervisor(environment, {
          platform: "win32",
          spawnProcess: () => assert.fail("a timed-out compiler root must never be reused")
        }),
        /previously involved in an unverified process tree/u
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
);

test(
  "a real Windows compiler timeout terminates and settles its complete native process tree",
  { skip: process.platform !== "win32", timeout: 30_000 },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "openwrangler-supervisor-native-timeout-"));
    const environment = createEditorAcceptanceEnvironmentForPlatform(process.env, {}, "win32");
    configureEditorAcceptanceTempRoot(directory, environment);
    let descendantPid;
    try {
      await assert.rejects(
        prepareWindowsEditorProcessSupervisor(environment, {
          platform: "win32",
          buildTimeoutMs: WINDOWS_NATIVE_COMPILER_TIMEOUT_PROBE_MS,
          buildSettlementTimeoutMs: 5_000,
          spawnProcess(_executable, _args, options) {
            const compiler = spawnChild(
              process.execPath,
              [
                "-e",
                [
                  "const { spawn } = require('node:child_process');",
                  "const descendant = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });",
                  "process.stderr.write(`descendant:${descendant.pid}\\n`);",
                  "setInterval(() => {}, 1000);"
                ].join(" ")
              ],
              options
            );
            compiler.stderr.on("data", (chunk) => {
              const match = /descendant:(\d+)/u.exec(chunk.toString("utf8"));
              if (match) descendantPid = Number(match[1]);
            });
            return compiler;
          }
        }),
        (error) => {
          assert.equal(error.code, "EDITOR_ACCEPTANCE_STAGE_DEADLINE");
          assert.equal(error.details?.stage, "windows-supervisor-compilation");
          assert.equal(error.details?.reason, "deadline");
          assert.equal(error.details?.treeVerifiedStopped, true);
          assert.equal(error.details?.compilerClosed, true);
          assert.equal(error.details?.compilerTreeTerminated, true);
          return true;
        }
      );
      assert.equal(Number.isSafeInteger(descendantPid), true);
      assert.equal(processIsRunning(descendantPid), false);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
);

test("verified taskkill settlement returns the correlated compiler deadline without a second kill", async () => {
  const directory = await mkdtemp(join(tmpdir(), "openwrangler-supervisor-taskkill-verified-"));
  const environment = createEditorAcceptanceEnvironmentForPlatform(process.env, {}, "win32");
  configureEditorAcceptanceTempRoot(directory, environment);
  const compiler = fakeWindowsCompiler({ closeOnKill: false, pid: 17937 });
  const taskkill = new EventEmitter();
  taskkill.pid = 17938;
  taskkill.exitCode = null;
  taskkill.signalCode = null;
  let taskkillUnrefCount = 0;
  let compilerRunningWhenTaskkillSettled = false;
  taskkill.kill = () => assert.fail("a promptly verified taskkill must not require cancellation");
  taskkill.unref = () => {
    taskkillUnrefCount += 1;
  };
  try {
    await assert.rejects(
      prepareWindowsEditorProcessSupervisor(environment, {
        platform: "win32",
        buildTimeoutMs: 10,
        buildSettlementTimeoutMs: 100,
        spawnProcess: () => compiler.child,
        spawnTaskkillProcess: () => {
          queueMicrotask(() => {
            taskkill.exitCode = 0;
            taskkill.emit("close", 0, null);
            compilerRunningWhenTaskkillSettled = compiler.child.exitCode === null && compiler.child.signalCode === null;
            setImmediate(() => {
              compiler.child.signalCode = "SIGKILL";
              compiler.child.stdout.end();
              compiler.child.stderr.end();
              compiler.child.emit("close", null, "SIGKILL");
            });
          });
          return taskkill;
        }
      }),
      (error) => {
        assert.equal(error.code, "EDITOR_ACCEPTANCE_STAGE_DEADLINE");
        assert.equal(error.details?.stage, "windows-supervisor-compilation");
        assert.equal(error.details?.reason, "deadline");
        assert.equal(error.details?.treeVerifiedStopped, true);
        assert.equal(error.details?.compilerClosed, true);
        assert.equal(error.details?.compilerTreeTerminated, true);
        return true;
      }
    );
    assert.equal(compilerRunningWhenTaskkillSettled, true);
    assert.deepEqual(compiler.state(), { killCount: 0, closeCount: 0, closeTimerActive: false });
    assert.equal(taskkillUnrefCount, 1);
    assert.equal(taskkill.listenerCount("error"), 0);
    assert.equal(taskkill.listenerCount("close"), 0);
    assert.equal(compiler.child.listenerCount("error"), 0);
    assert.equal(compiler.child.listenerCount("close"), 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test(
  "abort settlement retains a finite delayed terminator rejection before bounded release",
  { timeout: 5_000 },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "openwrangler-supervisor-stuck-"));
    const environment = createEditorAcceptanceEnvironmentForPlatform(process.env, {}, "win32");
    configureEditorAcceptanceTempRoot(directory, environment);
    const compiler = fakeWindowsCompiler({ closeOnKill: true, closeDelayMs: 100, pid: 17912 });
    const terminatorError = new Error("synthetic post-abort compiler-tree settlement failure");
    let reportedBeforeClose = false;
    try {
      const preparation = prepareWindowsEditorProcessSupervisor(environment, {
        platform: "win32",
        buildTimeoutMs: 10,
        buildSettlementTimeoutMs: 20,
        spawnProcess: () => compiler.child,
        terminateBuildProcessTree(child, { abortSignal }) {
          child.kill("SIGKILL");
          return new Promise((_resolve, reject) => {
            const rejectAfterAbort = () => setTimeout(() => reject(terminatorError), 5);
            abortSignal.addEventListener("abort", rejectAfterAbort, { once: true });
            if (abortSignal.aborted) rejectAfterAbort();
          });
        }
      });
      await assert.rejects(
        preparation.catch((error) => {
          reportedBeforeClose = compiler.state().closeCount === 0;
          throw error;
        }),
        (error) => {
          assert.equal(editorProcessTreeMayBeLive(error), true);
          assert.equal(error.code, "EDITOR_PROCESS_TREE_UNVERIFIED");
          assert.equal(error.details?.stage, "windows-supervisor-compilation");
          assert.equal(error.details?.reason, "deadline");
          assert.equal(error.details?.limitMs, 10);
          assert.equal(error.details?.elapsedMs >= 28, true);
          assert.equal(error.details?.elapsedMs < 1_000, true);
          assert.equal(error.details?.compilerClosed, false);
          assert.equal(error.details?.buildSettlementTimeoutMs, 20);
          assert.deepEqual(
            {
              code: error.details?.settlementDeadline?.code,
              stage: error.details?.settlementDeadline?.stage,
              reason: error.details?.settlementDeadline?.reason,
              limitMs: error.details?.settlementDeadline?.limitMs,
              treeVerifiedStopped: error.details?.settlementDeadline?.treeVerifiedStopped
            },
            {
              code: "EDITOR_ACCEPTANCE_DEADLINE",
              stage: "windows-supervisor-compilation-settlement",
              reason: "settlement-deadline",
              limitMs: 20,
              treeVerifiedStopped: false
            }
          );
          assert.equal(error.details?.settlementDeadline?.elapsedMs >= 15, true);
          assert.equal(error.details?.settlementDeadline?.elapsedMs < 1_000, true);
          assert.equal(error.details?.settlementDeadline?.abortSettlementLimitMs, 20);
          assert.equal(error.details?.settlementDeadline?.abortSettlementElapsedMs >= 15, true);
          assert.equal(error.details?.settlementDeadline?.abortSettlementElapsedMs < 1_000, true);
          assert.equal(error.cause instanceof AggregateError, true);
          assert.equal(error.cause.errors[0]?.code, "EDITOR_ACCEPTANCE_DEADLINE");
          assert.equal(error.cause.errors[1], terminatorError);
          return true;
        }
      );
      assert.equal(reportedBeforeClose, true);
      assert.deepEqual(compiler.state(), { killCount: 1, closeCount: 0, closeTimerActive: true });
      assert.deepEqual(compiler.lifecycle(), {
        closeListeners: 1,
        errorListeners: 1,
        stderrDataListeners: 0,
        stdoutDataListeners: 0,
        unrefCount: 1
      });
      assert.equal(compiler.child.stdout.destroyed, true);
      assert.equal(compiler.child.stderr.destroyed, true);
      await new Promise((resolve) => setTimeout(resolve, 100));
      assert.deepEqual(compiler.state(), { killCount: 1, closeCount: 1, closeTimerActive: false });
      assert.deepEqual(compiler.lifecycle(), {
        closeListeners: 0,
        errorListeners: 0,
        stderrDataListeners: 0,
        stdoutDataListeners: 0,
        unrefCount: 1
      });
      await assert.rejects(
        prepareWindowsEditorProcessSupervisor(environment, {
          platform: "win32",
          spawnProcess: () => assert.fail("an unsettled compiler root must never be reused")
        }),
        /previously involved in an unverified process tree/u
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
);

test("Windows supervisor compilation cancellation waits for child settlement", { timeout: 5_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "openwrangler-supervisor-cancelled-"));
  const environment = createEditorAcceptanceEnvironmentForPlatform(process.env, {}, "win32");
  configureEditorAcceptanceTempRoot(directory, environment);
  const compiler = fakeWindowsCompiler({ closeOnKill: true, pid: 17913 });
  const controller = new AbortController();
  try {
    await assert.rejects(
      prepareWindowsEditorProcessSupervisor(environment, {
        platform: "win32",
        buildTimeoutMs: 1_000,
        buildSettlementTimeoutMs: 100,
        buildAbortSignal: controller.signal,
        spawnProcess: () => {
          queueMicrotask(() => controller.abort());
          return compiler.child;
        },
        terminateBuildProcessTree(child) {
          child.kill("SIGKILL");
          return { treeVerifiedStopped: false };
        }
      }),
      (error) => {
        assert.equal(editorProcessTreeMayBeLive(error), true);
        assert.equal(error.details?.stage, "windows-supervisor-compilation");
        assert.equal(error.details?.reason, "cancelled");
        assert.equal(error.details?.compilerClosed, true);
        assert.match(error.message, /compilation stage was cancelled/u);
        return true;
      }
    );
    assert.deepEqual(compiler.state(), { killCount: 1, closeCount: 1, closeTimerActive: false });
    assert.equal(compiler.child.stdout.destroyed, true);
    assert.equal(compiler.child.stderr.destroyed, true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a caller deadline starts before synchronous private-root preparation", { timeout: 5_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "openwrangler-supervisor-preparation-deadline-"));
  const environment = createEditorAcceptanceEnvironmentForPlatform(process.env, {}, "win32");
  let clock = 0;
  Object.defineProperty(environment, "OPEN_WRANGLER_EDITOR_TEMP_ROOT", {
    configurable: true,
    enumerable: true,
    get() {
      clock = 11;
      return directory;
    }
  });
  try {
    await assert.rejects(
      prepareWindowsEditorProcessSupervisor(environment, {
        platform: "win32",
        buildTimeoutMs: 10,
        buildNow: () => clock,
        spawnProcess: () => assert.fail("expired root preparation must not launch a compiler")
      }),
      (error) => {
        assert.equal(error.code, "EDITOR_ACCEPTANCE_STAGE_DEADLINE");
        assert.equal(error.details?.stage, "windows-supervisor-compilation");
        assert.equal(error.details?.reason, "deadline");
        assert.equal(error.details?.elapsedMs, 11);
        assert.equal(error.details?.limitMs, 10);
        assert.equal(error.details?.treeVerifiedStopped, true);
        return true;
      }
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test(
  "an early caller-deadline wake re-observes the clock and rearms deterministically",
  { timeout: 5_000 },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "openwrangler-supervisor-rearmed-deadline-"));
    const environment = createEditorAcceptanceEnvironmentForPlatform(process.env, {}, "win32");
    configureEditorAcceptanceTempRoot(directory, environment);
    const compiler = fakeWindowsCompiler({ closeOnKill: true, pid: 17940 });
    const scheduled = [];
    let clock = 0;
    let outcome = "pending";
    const buildSchedule = (callback, delay) => {
      const timer = { callback, cancelled: false, delay };
      scheduled.push(timer);
      return timer;
    };
    const buildCancelSchedule = (timer) => {
      timer.cancelled = true;
    };
    try {
      const preparation = prepareWindowsEditorProcessSupervisor(environment, {
        platform: "win32",
        buildTimeoutMs: 10,
        buildSettlementTimeoutMs: 100,
        buildNow: () => clock,
        buildSchedule,
        buildCancelSchedule,
        spawnProcess: () => compiler.child,
        terminateBuildProcessTree(child) {
          child.kill("SIGKILL");
          return { treeVerifiedStopped: true };
        }
      });
      void preparation.then(
        () => {
          outcome = "resolved";
        },
        () => {
          outcome = "rejected";
        }
      );
      assert.equal(scheduled.length, 1);
      assert.equal(scheduled[0].delay, 10);

      clock = 4;
      scheduled[0].callback();
      await Promise.resolve();
      assert.equal(outcome, "pending");
      assert.equal(scheduled.length, 2);
      assert.equal(scheduled[1].delay, 6);

      clock = 10;
      scheduled[1].callback();
      await assert.rejects(preparation, (error) => {
        assert.equal(error.code, "EDITOR_ACCEPTANCE_STAGE_DEADLINE");
        assert.equal(error.details?.stage, "windows-supervisor-compilation");
        assert.equal(error.details?.reason, "deadline");
        assert.equal(error.details?.limitMs, 10);
        assert.equal(error.details?.treeVerifiedStopped, true);
        return true;
      });
      assert.equal(outcome, "rejected");
      assert.equal(scheduled[1].cancelled, true);
      assert.deepEqual(compiler.state(), { killCount: 1, closeCount: 1, closeTimerActive: false });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
);

test("a caller deadline includes synchronous compiler spawn and owns its settlement", { timeout: 5_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "openwrangler-supervisor-spawn-deadline-"));
  const environment = createEditorAcceptanceEnvironmentForPlatform(process.env, {}, "win32");
  configureEditorAcceptanceTempRoot(directory, environment);
  const compiler = fakeWindowsCompiler({ closeOnKill: true, pid: 17917 });
  let clock = 0;
  try {
    await assert.rejects(
      prepareWindowsEditorProcessSupervisor(environment, {
        platform: "win32",
        buildTimeoutMs: 10,
        buildSettlementTimeoutMs: 100,
        buildNow: () => clock,
        spawnProcess: () => {
          clock = 11;
          return compiler.child;
        },
        terminateBuildProcessTree(child) {
          child.kill("SIGKILL");
          return { treeVerifiedStopped: true };
        }
      }),
      (error) => {
        assert.equal(error.code, "EDITOR_ACCEPTANCE_STAGE_DEADLINE");
        assert.equal(error.details?.stage, "windows-supervisor-compilation");
        assert.equal(error.details?.reason, "deadline");
        assert.equal(error.details?.elapsedMs >= 0, true);
        assert.equal(error.details?.elapsedMs < 1_000, true);
        assert.equal(error.details?.limitMs, 10);
        assert.equal(error.details?.treeVerifiedStopped, true);
        assert.equal(error.details?.buildTimeoutMs, undefined);
        return true;
      }
    );
    assert.deepEqual(compiler.state(), { killCount: 1, closeCount: 1, closeTimerActive: false });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("joined Windows supervisor callers retain independent compilation deadlines", { timeout: 5_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "openwrangler-supervisor-joined-deadline-"));
  const environment = createEditorAcceptanceEnvironmentForPlatform(process.env, {}, "win32");
  configureEditorAcceptanceTempRoot(directory, environment);
  let compilerLaunches = 0;
  const spawnCompiler = (_executable, args) => {
    compilerLaunches += 1;
    const compiler = fakeWindowsCompiler({ closeOnKill: false, pid: 17914 });
    const outputIndex = args.indexOf("-CompileTo") + 1;
    setTimeout(async () => {
      await writeFile(args[outputIndex], "compiled-supervisor", { encoding: "utf8" });
      compiler.child.exitCode = 0;
      compiler.child.stdout.end();
      compiler.child.stderr.end();
      compiler.child.emit("exit", 0, null);
      compiler.child.emit("close", 0, null);
    }, 50);
    return compiler.child;
  };
  let longCaller;
  try {
    longCaller = prepareWindowsEditorProcessSupervisor(environment, {
      platform: "win32",
      buildTimeoutMs: 500,
      spawnProcess: spawnCompiler
    });
    void longCaller.catch(() => undefined);
    await assert.rejects(
      prepareWindowsEditorProcessSupervisor(environment, {
        platform: "win32",
        buildTimeoutMs: 10,
        spawnProcess: () => assert.fail("joined callers must share one compiler")
      }),
      (error) => {
        assert.equal(error.code, "EDITOR_ACCEPTANCE_STAGE_DEADLINE");
        assert.equal(error.details?.reason, "deadline");
        assert.equal(error.details?.limitMs, 10);
        assert.equal(error.details?.elapsedMs >= 10, true);
        assert.equal(error.details?.elapsedMs < 1_000, true);
        assert.equal(error.details?.buildStillOwned, true);
        assert.equal(error.details?.treeVerifiedStopped, null);
        assert.match(error.message, /caller exceeded 10 ms/u);
        return true;
      }
    );
    const receipt = await longCaller;
    assert.equal(receipt.buildRoot, directory);
    assert.equal(compilerLaunches, 1);
  } finally {
    if (longCaller) await Promise.allSettled([longCaller]);
    await rm(directory, { recursive: true, force: true });
  }
});

test(
  "the final joined caller transfers its own settlement bound to the shared compiler",
  { timeout: 5_000 },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "openwrangler-supervisor-joined-settlement-"));
    const environment = createEditorAcceptanceEnvironmentForPlatform(process.env, {}, "win32");
    configureEditorAcceptanceTempRoot(directory, environment);
    const compiler = fakeWindowsCompiler({ closeOnKill: true, pid: 17918 });
    let observedSettlementTimeoutMs;
    let creator;
    let finalJoiner;
    try {
      creator = prepareWindowsEditorProcessSupervisor(environment, {
        platform: "win32",
        buildTimeoutMs: 10,
        buildSettlementTimeoutMs: 90,
        spawnProcess: () => compiler.child,
        terminateBuildProcessTree(child, { timeoutMs }) {
          observedSettlementTimeoutMs = timeoutMs;
          child.kill("SIGKILL");
          return { treeVerifiedStopped: true };
        }
      });
      finalJoiner = prepareWindowsEditorProcessSupervisor(environment, {
        platform: "win32",
        buildTimeoutMs: 30,
        buildSettlementTimeoutMs: 25,
        spawnProcess: () => assert.fail("joined callers must share one compiler")
      });
      void creator.catch(() => undefined);
      void finalJoiner.catch(() => undefined);
      await assert.rejects(creator, (error) => {
        assert.equal(error.code, "EDITOR_ACCEPTANCE_STAGE_DEADLINE");
        assert.equal(error.details?.limitMs, 10);
        assert.equal(error.details?.elapsedMs >= 10, true);
        assert.equal(error.details?.treeVerifiedStopped, null);
        assert.equal(error.details?.buildStillOwned, true);
        return true;
      });
      await assert.rejects(finalJoiner, (error) => {
        assert.equal(error.code, "EDITOR_ACCEPTANCE_STAGE_DEADLINE");
        assert.equal(error.details?.limitMs, 30);
        assert.equal(error.details?.elapsedMs >= 30, true);
        assert.equal(error.details?.treeVerifiedStopped, true);
        assert.equal(error.details?.buildSettlementTimeoutMs, 25);
        return true;
      });
      assert.equal(observedSettlementTimeoutMs, 25);
      assert.deepEqual(compiler.state(), { killCount: 1, closeCount: 1, closeTimerActive: false });
    } finally {
      await Promise.allSettled([creator, finalJoiner].filter(Boolean));
      await rm(directory, { recursive: true, force: true });
    }
  }
);

test("an already-aborted joined caller cannot cancel another caller's compilation", { timeout: 5_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "openwrangler-supervisor-joined-abort-"));
  const environment = createEditorAcceptanceEnvironmentForPlatform(process.env, {}, "win32");
  configureEditorAcceptanceTempRoot(directory, environment);
  let compilerLaunches = 0;
  const spawnCompiler = (_executable, args) => {
    compilerLaunches += 1;
    const compiler = fakeWindowsCompiler({ closeOnKill: false, pid: 17915 });
    const outputIndex = args.indexOf("-CompileTo") + 1;
    setTimeout(async () => {
      await writeFile(args[outputIndex], "compiled-supervisor", { encoding: "utf8" });
      compiler.child.exitCode = 0;
      compiler.child.stdout.end();
      compiler.child.stderr.end();
      compiler.child.emit("exit", 0, null);
      compiler.child.emit("close", 0, null);
    }, 30);
    return compiler.child;
  };
  const controller = new AbortController();
  let activeCaller;
  try {
    activeCaller = prepareWindowsEditorProcessSupervisor(environment, {
      platform: "win32",
      buildTimeoutMs: 500,
      spawnProcess: spawnCompiler
    });
    void activeCaller.catch(() => undefined);
    controller.abort();
    await assert.rejects(
      prepareWindowsEditorProcessSupervisor(environment, {
        platform: "win32",
        buildTimeoutMs: 500,
        buildAbortSignal: controller.signal,
        spawnProcess: () => assert.fail("an aborted join must not launch or replace the compiler")
      }),
      (error) => {
        assert.equal(error.code, "EDITOR_ACCEPTANCE_STAGE_ABORTED");
        assert.equal(error.details?.reason, "cancelled");
        return true;
      }
    );
    await activeCaller;
    assert.equal(compilerLaunches, 1);
  } finally {
    if (activeCaller) await Promise.allSettled([activeCaller]);
    await rm(directory, { recursive: true, force: true });
  }
});

test("taskkill error without close survives the compiler settlement deadline", { timeout: 5_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "openwrangler-supervisor-taskkill-error-"));
  const environment = createEditorAcceptanceEnvironmentForPlatform(process.env, {}, "win32");
  configureEditorAcceptanceTempRoot(directory, environment);
  const compiler = fakeWindowsCompiler({ closeOnKill: false, pid: 17931 });
  const taskkill = new EventEmitter();
  taskkill.pid = 17932;
  taskkill.exitCode = null;
  taskkill.signalCode = null;
  const taskkillError = new Error("synthetic taskkill error without close");
  let taskkillKillCount = 0;
  let taskkillUnrefCount = 0;
  taskkill.kill = () => {
    taskkillKillCount += 1;
    return true;
  };
  taskkill.unref = () => {
    taskkillUnrefCount += 1;
  };
  try {
    await assert.rejects(
      prepareWindowsEditorProcessSupervisor(environment, {
        platform: "win32",
        buildTimeoutMs: 10,
        buildSettlementTimeoutMs: 20,
        spawnProcess: () => compiler.child,
        spawnTaskkillProcess: () => {
          queueMicrotask(() => taskkill.emit("error", taskkillError));
          return taskkill;
        }
      }),
      (error) => {
        assert.equal(error.code, "EDITOR_PROCESS_TREE_UNVERIFIED");
        assert.equal(error.details?.compilerClosed, false);
        assert.equal(error.details?.treeVerifiedStopped, false);
        assert.equal(error.cause instanceof AggregateError, true);
        assert.equal(error.cause.errors.length, 2);
        assert.equal(error.cause.errors[0]?.code, "EDITOR_ACCEPTANCE_DEADLINE");
        assert.equal(error.cause.errors[1], taskkillError);
        return true;
      }
    );
    assert.equal(taskkillKillCount, 1);
    assert.equal(taskkillUnrefCount, 1);
    assert.equal(compiler.state().killCount, 1);
    assert.equal(taskkill.listenerCount("error"), 1);
    assert.equal(taskkill.listenerCount("close"), 1);
    assert.equal(compiler.child.listenerCount("error"), 1);
    assert.equal(compiler.child.listenerCount("close"), 1);
    assert.doesNotThrow(() => taskkill.emit("error", new Error("synthetic late taskkill error")));
    taskkill.emit("close", null, "SIGKILL");
    compiler.child.emit("close", null, "SIGKILL");
    assert.equal(taskkill.listenerCount("error"), 0);
    assert.equal(taskkill.listenerCount("close"), 0);
    assert.equal(compiler.child.listenerCount("error"), 0);
    assert.equal(compiler.child.listenerCount("close"), 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a false taskkill cancellation result is retained as tree uncertainty", { timeout: 5_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "openwrangler-supervisor-taskkill-false-"));
  const environment = createEditorAcceptanceEnvironmentForPlatform(process.env, {}, "win32");
  configureEditorAcceptanceTempRoot(directory, environment);
  const compiler = fakeWindowsCompiler({ closeOnKill: true, pid: 17933 });
  const taskkill = new EventEmitter();
  taskkill.pid = 17934;
  taskkill.exitCode = null;
  taskkill.signalCode = null;
  taskkill.kill = () => false;
  taskkill.unref = () => undefined;
  try {
    await assert.rejects(
      prepareWindowsEditorProcessSupervisor(environment, {
        platform: "win32",
        buildTimeoutMs: 10,
        buildSettlementTimeoutMs: 20,
        spawnProcess: () => compiler.child,
        spawnTaskkillProcess: () => taskkill
      }),
      (error) => {
        assert.equal(error.code, "EDITOR_PROCESS_TREE_UNVERIFIED");
        assert.equal(error.details?.compilerClosed, true);
        assert.equal(error.details?.treeVerifiedStopped, false);
        assert.equal(error.cause instanceof AggregateError, true);
        assert.equal(error.cause.errors[0]?.code, "EDITOR_ACCEPTANCE_DEADLINE");
        assert.match(error.cause.errors[1]?.message, /taskkill process rejected forced termination/u);
        return true;
      }
    );
    assert.equal(taskkill.listenerCount("error"), 1);
    assert.equal(taskkill.listenerCount("close"), 1);
    taskkill.emit("close", null, "SIGKILL");
    assert.equal(taskkill.listenerCount("error"), 0);
    assert.equal(taskkill.listenerCount("close"), 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("taskkill, compiler, and unref failures retain deterministic settlement order", { timeout: 5_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "openwrangler-supervisor-error-order-"));
  const environment = createEditorAcceptanceEnvironmentForPlatform(process.env, {}, "win32");
  configureEditorAcceptanceTempRoot(directory, environment);
  const compiler = fakeWindowsCompiler({ closeOnKill: false, pid: 17935 });
  const taskkill = new EventEmitter();
  taskkill.pid = 17936;
  taskkill.exitCode = null;
  taskkill.signalCode = null;
  const taskkillError = new Error("synthetic taskkill cancellation error");
  const compilerError = new Error("synthetic simultaneous compiler error");
  const unrefError = new Error("synthetic compiler unref error");
  taskkill.kill = () => {
    taskkill.emit("error", taskkillError);
    return true;
  };
  taskkill.unref = () => undefined;
  compiler.child.unref = () => {
    throw unrefError;
  };
  try {
    await assert.rejects(
      prepareWindowsEditorProcessSupervisor(environment, {
        platform: "win32",
        buildTimeoutMs: 10,
        buildSettlementTimeoutMs: 20,
        spawnProcess: () => {
          queueMicrotask(() => compiler.child.emit("error", compilerError));
          return compiler.child;
        },
        spawnTaskkillProcess: () => taskkill
      }),
      (error) => {
        assert.equal(error.code, "EDITOR_PROCESS_TREE_UNVERIFIED");
        assert.equal(error.details?.compilerClosed, false);
        assert.equal(error.details?.treeVerifiedStopped, false);
        assert.equal(error.cause instanceof AggregateError, true);
        assert.equal(error.cause.errors.length, 4);
        assert.equal(error.cause.errors[0]?.code, "EDITOR_ACCEPTANCE_DEADLINE");
        assert.equal(error.cause.errors[1], taskkillError);
        assert.equal(error.cause.errors[2], compilerError);
        assert.equal(error.cause.errors[3], unrefError);
        return true;
      }
    );
    assert.equal(taskkill.listenerCount("error"), 1);
    assert.equal(taskkill.listenerCount("close"), 1);
    assert.equal(compiler.child.listenerCount("error"), 1);
    assert.equal(compiler.child.listenerCount("close"), 1);
    taskkill.emit("close", null, "SIGKILL");
    compiler.child.emit("close", null, "SIGKILL");
    assert.equal(taskkill.listenerCount("error"), 0);
    assert.equal(taskkill.listenerCount("close"), 0);
    assert.equal(compiler.child.listenerCount("error"), 0);
    assert.equal(compiler.child.listenerCount("close"), 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("never-settling taskkill and compiler handles return bounded uncertainty", { timeout: 5_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "openwrangler-supervisor-taskkill-settlement-"));
  const environment = createEditorAcceptanceEnvironmentForPlatform(process.env, {}, "win32");
  configureEditorAcceptanceTempRoot(directory, environment);
  const compiler = fakeWindowsCompiler({ closeOnKill: false, pid: 17919 });
  const taskkill = new EventEmitter();
  taskkill.pid = 17920;
  taskkill.exitCode = null;
  taskkill.signalCode = null;
  let taskkillKillCount = 0;
  let taskkillUnrefCount = 0;
  taskkill.kill = () => {
    taskkillKillCount += 1;
    return true;
  };
  taskkill.unref = () => {
    taskkillUnrefCount += 1;
  };
  try {
    const startedAt = performance.now();
    await assert.rejects(
      prepareWindowsEditorProcessSupervisor(environment, {
        platform: "win32",
        buildTimeoutMs: 10,
        buildSettlementTimeoutMs: 20,
        spawnProcess: () => compiler.child,
        spawnTaskkillProcess: () => taskkill
      }),
      (error) => {
        assert.equal(error.code, "EDITOR_PROCESS_TREE_UNVERIFIED");
        assert.equal(error.details?.stage, "windows-supervisor-compilation");
        assert.equal(error.details?.reason, "deadline");
        assert.equal(error.details?.compilerClosed, false);
        assert.equal(error.details?.treeVerifiedStopped, false);
        assert.equal(error.cause instanceof AggregateError, true);
        assert.equal(error.cause.errors[0]?.code, "EDITOR_ACCEPTANCE_DEADLINE");
        assert.match(error.cause.errors[1]?.message, /did not attest complete termination/u);
        return true;
      }
    );
    assert.equal(performance.now() - startedAt < 1_000, true);
    assert.equal(taskkillKillCount, 1);
    assert.equal(taskkillUnrefCount, 1);
    assert.equal(compiler.state().killCount, 1);
    assert.equal(taskkill.listenerCount("close"), 1);
    assert.equal(taskkill.listenerCount("error"), 1);
    assert.deepEqual(compiler.lifecycle(), {
      closeListeners: 1,
      errorListeners: 1,
      stderrDataListeners: 0,
      stdoutDataListeners: 0,
      unrefCount: 1
    });
    assert.doesNotThrow(() => compiler.child.emit("error", new Error("synthetic late taskkill error")));
    compiler.child.emit("close", null, "SIGKILL");
    assert.equal(compiler.child.listenerCount("error"), 0);
    assert.equal(compiler.child.listenerCount("close"), 0);
    assert.doesNotThrow(() => taskkill.emit("error", new Error("synthetic late taskkill-process error")));
    taskkill.emit("close", null, "SIGKILL");
    assert.equal(taskkill.listenerCount("error"), 0);
    assert.equal(taskkill.listenerCount("close"), 0);
    await assert.rejects(
      prepareWindowsEditorProcessSupervisor(environment, {
        platform: "win32",
        spawnProcess: () => assert.fail("a taskkill-uncertain compiler root must stay poisoned")
      }),
      /previously involved in an unverified process tree/u
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a never-settling custom terminator cannot pin compiler settlement", { timeout: 5_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "openwrangler-supervisor-native-handle-"));
  const environment = createEditorAcceptanceEnvironmentForPlatform(process.env, {}, "win32");
  configureEditorAcceptanceTempRoot(directory, environment);
  const compiler = fakeWindowsCompiler({ closeOnKill: false, pid: 17921 });
  try {
    const startedAt = performance.now();
    await assert.rejects(
      prepareWindowsEditorProcessSupervisor(environment, {
        platform: "win32",
        buildTimeoutMs: 10,
        buildSettlementTimeoutMs: 20,
        spawnProcess: () => compiler.child,
        terminateBuildProcessTree: () => new Promise(() => {})
      }),
      (error) => {
        assert.equal(editorProcessTreeMayBeLive(error), true);
        assert.equal(error.code, "EDITOR_PROCESS_TREE_UNVERIFIED");
        assert.equal(error.details?.stage, "windows-supervisor-compilation");
        assert.equal(error.details?.treeVerifiedStopped, false);
        assert.equal(error.details?.compilerClosed, false);
        assert.match(String(error.cause), /settlement exceeded 20 ms/u);
        return true;
      }
    );
    assert.equal(performance.now() - startedAt < 1_000, true);
    assert.equal(compiler.child.stdout.destroyed, true);
    assert.equal(compiler.child.stderr.destroyed, true);
    assert.deepEqual(compiler.lifecycle(), {
      closeListeners: 1,
      errorListeners: 1,
      stderrDataListeners: 0,
      stdoutDataListeners: 0,
      unrefCount: 1
    });
    assert.doesNotThrow(() => compiler.child.emit("error", new Error("synthetic late native-handle error")));
    compiler.child.emit("close", null, "SIGKILL");
    assert.equal(compiler.child.listenerCount("error"), 0);
    assert.equal(compiler.child.listenerCount("close"), 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("compiler stdio cleanup faults preserve the tree-unverified classification", { timeout: 5_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "openwrangler-supervisor-cleanup-fault-"));
  const environment = createEditorAcceptanceEnvironmentForPlatform(process.env, {}, "win32");
  configureEditorAcceptanceTempRoot(directory, environment);
  const compiler = fakeWindowsCompiler({ closeOnKill: false, pid: 17916 });
  compiler.child.stdout.destroy = () => {
    throw new Error("synthetic compiler stdout cleanup failure");
  };
  try {
    await assert.rejects(
      prepareWindowsEditorProcessSupervisor(environment, {
        platform: "win32",
        buildTimeoutMs: 10,
        buildSettlementTimeoutMs: 20,
        spawnProcess: () => compiler.child,
        terminateBuildProcessTree: () => new Promise(() => {})
      }),
      (error) => {
        assert.equal(error.code, "EDITOR_PROCESS_TREE_UNVERIFIED");
        assert.equal(error.details?.stage, "windows-supervisor-compilation");
        assert.equal(error.details?.treeVerifiedStopped, false);
        assert.equal(error.details?.compilerClosed, false);
        assert.equal(editorProcessTreeMayBeLive(error), true);
        assert.equal(error.cause instanceof AggregateError, true);
        assert.equal(error.cause.errors[0].code, "EDITOR_ACCEPTANCE_DEADLINE");
        assert.deepEqual(
          {
            stage: error.cause.errors[0].details?.stage,
            reason: error.cause.errors[0].details?.reason,
            limitMs: error.cause.errors[0].details?.limitMs,
            treeVerifiedStopped: error.cause.errors[0].details?.treeVerifiedStopped
          },
          {
            stage: "windows-supervisor-compilation-settlement",
            reason: "settlement-deadline",
            limitMs: 20,
            treeVerifiedStopped: false
          }
        );
        assert.equal(error.cause.errors[0].details?.elapsedMs >= 20, true);
        assert.equal(error.cause.errors[0].details?.elapsedMs < 1_000, true);
        assert.match(error.cause.errors[1].message, /cleanup failure/u);
        return true;
      }
    );
    assert.doesNotThrow(() => compiler.child.emit("error", new Error("synthetic late cleanup error")));
    compiler.child.emit("close", null, "SIGKILL");
    assert.equal(compiler.child.listenerCount("error"), 0);
    assert.equal(compiler.child.listenerCount("close"), 0);
    await assert.rejects(
      prepareWindowsEditorProcessSupervisor(environment, {
        platform: "win32",
        spawnProcess: () => assert.fail("a cleanup-uncertain compiler root must stay poisoned")
      }),
      /previously involved in an unverified process tree/u
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
