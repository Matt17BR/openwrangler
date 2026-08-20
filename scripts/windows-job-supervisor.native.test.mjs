import assert from "node:assert/strict";
import { spawn as spawnChild } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { PassThrough } from "node:stream";
import test from "node:test";
import {
  configureEditorAcceptanceTempRoot,
  createEditorAcceptanceEnvironmentForPlatform,
  editorProcessTreeMayBeLive,
  prepareWindowsEditorProcessSupervisor,
  runBoundedEditorCommand,
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

async function runWindowsNativeStage(
  stage,
  { timeoutMs, settlementTimeoutMs = WINDOWS_NATIVE_STAGE_SETTLEMENT_TIMEOUT_MS },
  operation
) {
  const controller = new AbortController();
  const execution = Promise.resolve().then(() => operation(controller.signal));
  const observed = execution.then(
    (value) => ({ kind: "result", value }),
    (error) => ({ kind: "error", error })
  );
  let stageTimer;
  let observation;
  try {
    observation = await Promise.race([
      observed,
      new Promise((resolveDeadline) => {
        stageTimer = setTimeout(() => resolveDeadline({ kind: "deadline" }), timeoutMs);
      })
    ]);
  } finally {
    clearTimeout(stageTimer);
  }
  if (observation.kind === "result") return observation.value;
  if (observation.kind === "error") {
    throw new Error(`The native Windows supervisor ${stage} stage failed.`, { cause: observation.error });
  }

  controller.abort();
  let settlementTimer;
  let settlement;
  try {
    settlement = await Promise.race([
      observed,
      new Promise((resolveSettlementDeadline) => {
        settlementTimer = setTimeout(
          () => resolveSettlementDeadline({ kind: "settlement-deadline" }),
          settlementTimeoutMs
        );
      })
    ]);
  } finally {
    clearTimeout(settlementTimer);
  }
  if (settlement.kind === "settlement-deadline") {
    const failure = new Error(
      `The native Windows supervisor ${stage} stage exceeded ${timeoutMs} ms and did not settle within ${settlementTimeoutMs} ms after cancellation.`
    );
    failure.code = "EDITOR_PROCESS_TREE_UNVERIFIED";
    failure.details = { stage, treeVerifiedStopped: false };
    throw failure;
  }
  throw new Error(`The native Windows supervisor ${stage} stage exceeded its ${timeoutMs} ms correctness bound.`, {
    cause: settlement.kind === "error" ? settlement.error : undefined
  });
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

async function runWindowsNativeFilesystemStage(stage, stageOptions, script, args) {
  return runWindowsNativeStage(stage, stageOptions, (abortSignal) => {
    const child = spawnChild(process.execPath, ["-e", script, ...args], {
      detached: false,
      windowsHide: true,
      stdio: "ignore"
    });
    return new Promise((resolve, reject) => {
      let settled = false;
      const settle = (operation, value) => {
        if (settled) return;
        settled = true;
        abortSignal.removeEventListener("abort", onAbort);
        child.off("error", onError);
        child.off("close", onClose);
        operation(value);
      };
      const onAbort = () => {
        try {
          child.kill("SIGKILL");
        } catch (error) {
          const failure = new Error(`The native Windows supervisor ${stage} worker could not be cancelled.`, {
            cause: error
          });
          failure.code = "EDITOR_PROCESS_TREE_UNVERIFIED";
          failure.details = { stage, treeVerifiedStopped: false };
          settle(reject, failure);
        }
      };
      const onError = (error) => settle(reject, error);
      const onClose = (code, signal) => {
        if (code === 0 && signal === null) settle(resolve);
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
      child.once("error", onError);
      child.once("close", onClose);
      if (abortSignal.aborted) onAbort();
    });
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
    /exceeded its 10 ms correctness bound/u
  );
  assert.equal(cancellationObserved, true);
  assert.equal(operationSettled, true);
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
  return {
    child,
    state() {
      return { killCount, closeCount, closeTimerActive: closeTimer !== undefined };
    }
  };
}

test(
  "the real Windows supervisor owns every native lifecycle stage",
  { skip: process.platform !== "win32", timeout: WINDOWS_NATIVE_TEST_TIMEOUT_MS },
  async () => {
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
          settlementTimeoutMs: WINDOWS_NATIVE_BUILD_SETTLEMENT_TIMEOUT_MS
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
        { timeoutMs: 60_000 },
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
        { timeoutMs: 30_000 },
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
        { timeoutMs: 60_000 },
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
        { timeoutMs: WINDOWS_NATIVE_SYNC_STAGE_TIMEOUT_MS, settlementTimeoutMs: 5_000 },
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
          { timeoutMs: WINDOWS_NATIVE_SYNC_STAGE_TIMEOUT_MS, settlementTimeoutMs: 5_000 },
          "require('node:fs').rmSync(process.argv[1], { recursive: true, force: true });",
          [privateRoot]
        );
      }
    }
  }
);

test(
  "a delayed Windows supervisor compiler is killed, settled, and retained fail-closed",
  { timeout: 5_000 },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "openwrangler-supervisor-delayed-"));
    const environment = createEditorAcceptanceEnvironmentForPlatform(process.env, {}, "win32");
    configureEditorAcceptanceTempRoot(directory, environment);
    const compiler = fakeWindowsCompiler({ closeOnKill: true, closeDelayMs: 5, pid: 17911 });
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

test(
  "a stuck Windows supervisor compiler settles its callback at the cleanup deadline",
  { timeout: 5_000 },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "openwrangler-supervisor-stuck-"));
    const environment = createEditorAcceptanceEnvironmentForPlatform(process.env, {}, "win32");
    configureEditorAcceptanceTempRoot(directory, environment);
    const compiler = fakeWindowsCompiler({ closeOnKill: false, pid: 17912 });
    try {
      await assert.rejects(
        prepareWindowsEditorProcessSupervisor(environment, {
          platform: "win32",
          buildTimeoutMs: 10,
          buildSettlementTimeoutMs: 20,
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
          assert.equal(error.details?.compilerClosed, false);
          assert.match(error.message, /forced tree settlement exceeded 20 ms/u);
          return true;
        }
      );
      assert.deepEqual(compiler.state(), { killCount: 1, closeCount: 0, closeTimerActive: false });
      assert.equal(compiler.child.stdout.destroyed, true);
      assert.equal(compiler.child.stderr.destroyed, true);
      await assert.rejects(
        prepareWindowsEditorProcessSupervisor(environment, {
          platform: "win32",
          spawnProcess: () => assert.fail("an unsettled compiler root must never be reused")
        }),
        /previously involved in an unverified process tree/u
      );
    } finally {
      // The fake compiler owns no OS process or handle; production retains an
      // uncertain private root and rejects it permanently as asserted above.
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
  try {
    const longCaller = prepareWindowsEditorProcessSupervisor(environment, {
      platform: "win32",
      buildTimeoutMs: 500,
      spawnProcess: spawnCompiler
    });
    await assert.rejects(
      prepareWindowsEditorProcessSupervisor(environment, {
        platform: "win32",
        buildTimeoutMs: 10,
        spawnProcess: () => assert.fail("joined callers must share one compiler")
      }),
      (error) => {
        assert.equal(error.code, "EDITOR_ACCEPTANCE_STAGE_DEADLINE");
        assert.equal(error.details?.reason, "deadline");
        assert.equal(error.details?.buildStillOwned, true);
        assert.match(error.message, /caller exceeded 10 ms/u);
        return true;
      }
    );
    const receipt = await longCaller;
    assert.equal(receipt.buildRoot, directory);
    assert.equal(compilerLaunches, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

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
  try {
    const activeCaller = prepareWindowsEditorProcessSupervisor(environment, {
      platform: "win32",
      buildTimeoutMs: 500,
      spawnProcess: spawnCompiler
    });
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
    await rm(directory, { recursive: true, force: true });
  }
});

test(
  "compiler tree uncertainty and native output handles settle without pinning the caller",
  { timeout: 5_000 },
  async (context) => {
    const directory = await mkdtemp(join(tmpdir(), "openwrangler-supervisor-native-handle-"));
    const environment = createEditorAcceptanceEnvironmentForPlatform(process.env, {}, "win32");
    configureEditorAcceptanceTempRoot(directory, environment);
    let compiler;
    let descendantPid;
    context.after(async () => {
      try {
        compiler?.kill("SIGKILL");
      } catch (error) {
        if (error?.code !== "ESRCH") throw error;
      }
      if (Number.isSafeInteger(descendantPid)) {
        try {
          process.kill(descendantPid, "SIGKILL");
        } catch (error) {
          if (error?.code !== "ESRCH") throw error;
        }
      }
      await rm(directory, { recursive: true, force: true });
    });
    const startedAt = performance.now();
    await assert.rejects(
      prepareWindowsEditorProcessSupervisor(environment, {
        platform: "win32",
        buildTimeoutMs: 100,
        buildSettlementTimeoutMs: 25,
        spawnProcess() {
          compiler = spawnChild(
            process.execPath,
            [
              "-e",
              [
                "const { spawn } = require('node:child_process');",
                "const descendant = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 1000)'], { detached: true, stdio: ['ignore', process.stdout, process.stderr] });",
                "process.stderr.write(`descendant:${descendant.pid}\\n`);",
                "descendant.unref();",
                "setInterval(() => {}, 1000);"
              ].join(" ")
            ],
            { stdio: ["ignore", "pipe", "pipe"] }
          );
          compiler.stderr.on("data", (chunk) => {
            const match = /descendant:(\d+)/u.exec(chunk.toString("utf8"));
            if (match) descendantPid = Number(match[1]);
          });
          return compiler;
        },
        terminateBuildProcessTree(child) {
          child.kill("SIGKILL");
          return { treeVerifiedStopped: false };
        }
      }),
      (error) => {
        assert.equal(editorProcessTreeMayBeLive(error), true);
        assert.equal(error.code, "EDITOR_PROCESS_TREE_UNVERIFIED");
        assert.equal(error.details?.stage, "windows-supervisor-compilation");
        assert.equal(error.details?.treeVerifiedStopped, false);
        assert.equal(error.details?.compilerClosed, false);
        return true;
      }
    );
    assert.ok(
      performance.now() - startedAt < 1_000,
      "the load-tolerant correctness bound must release the compiler's native handles before its descendant exits"
    );
    assert.equal(compiler.stdout.destroyed, true);
    assert.equal(compiler.stderr.destroyed, true);
  }
);

test("compiler stdio cleanup faults preserve the tree-unverified classification", { timeout: 5_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "openwrangler-supervisor-cleanup-fault-"));
  const environment = createEditorAcceptanceEnvironmentForPlatform(process.env, {}, "win32");
  configureEditorAcceptanceTempRoot(directory, environment);
  const compiler = fakeWindowsCompiler({ closeOnKill: true, pid: 17916 });
  compiler.child.stdout.destroy = () => {
    throw new Error("synthetic compiler stdout cleanup failure");
  };
  try {
    await assert.rejects(
      prepareWindowsEditorProcessSupervisor(environment, {
        platform: "win32",
        buildTimeoutMs: 10,
        buildSettlementTimeoutMs: 100,
        spawnProcess: () => compiler.child,
        terminateBuildProcessTree(child) {
          child.kill("SIGKILL");
          return { treeVerifiedStopped: true };
        }
      }),
      (error) => {
        assert.equal(error.code, "EDITOR_PROCESS_TREE_UNVERIFIED");
        assert.equal(error.details?.stage, "windows-supervisor-compilation");
        assert.equal(error.details?.treeVerifiedStopped, false);
        assert.equal(error.details?.compilerClosed, true);
        assert.equal(editorProcessTreeMayBeLive(error), true);
        assert.match(String(error.cause), /cleanup failure/u);
        return true;
      }
    );
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
