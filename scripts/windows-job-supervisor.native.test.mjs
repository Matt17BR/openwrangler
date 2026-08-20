import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { renameSync, rmSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp } from "node:fs/promises";
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
const WINDOWS_NATIVE_COMMAND_CLEANUP = Object.freeze({
  terminationGraceMs: 5_000,
  killGraceMs: 5_000,
  windowsTreeKillTimeoutMs: 5_000
});
const WINDOWS_NATIVE_TEST_TIMEOUT_MS = 480_000;
const WINDOWS_NATIVE_SYNC_STAGE_TIMEOUT_MS = 15_000;

async function runWindowsNativeStage(stage, operation) {
  try {
    return await operation();
  } catch (error) {
    throw new Error(`The native Windows supervisor ${stage} stage failed.`, { cause: error });
  }
}

function runWindowsNativeSynchronousStage(stage, operation) {
  const startedAt = performance.now();
  let result;
  try {
    result = operation();
  } catch (error) {
    throw new Error(`The native Windows supervisor ${stage} stage failed.`, { cause: error });
  }
  const elapsedMs = Math.max(0, performance.now() - startedAt);
  if (elapsedMs > WINDOWS_NATIVE_SYNC_STAGE_TIMEOUT_MS) {
    throw new Error(
      `The native Windows supervisor ${stage} stage exceeded its ${WINDOWS_NATIVE_SYNC_STAGE_TIMEOUT_MS} ms correctness bound after settling.`
    );
  }
  return result;
}

function fakeWindowsCompiler({ closeOnKill, closeDelayMs = 0, pid }) {
  const child = new EventEmitter();
  child.pid = pid;
  child.exitCode = null;
  child.signalCode = null;
  child.stdin = undefined;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
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
      const supervisorReceipt = await runWindowsNativeStage("compilation", () =>
        prepareWindowsEditorProcessSupervisor(environment, {
          platform: "win32",
          buildTimeoutMs: WINDOWS_NATIVE_BUILD_TIMEOUT_MS,
          buildSettlementTimeoutMs: WINDOWS_NATIVE_BUILD_SETTLEMENT_TIMEOUT_MS
        })
      );
      const natural = await runWindowsNativeStage("natural containment", () =>
        runBoundedEditorCommand(
          {
            executable: process.execPath,
            args: [
              "-e",
              [
                "const { spawn } = require('node:child_process');",
                "const targetStartedAt = Date.now();",
                "process.stdout.write(JSON.stringify({ targetStartedAt }));",
                "process.stderr.write('native stderr');",
                "spawn(process.execPath, ['-e', 'setTimeout(() => {}, 500)'], { detached: true, stdio: 'ignore' }).unref();"
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
        )
      );
      assert.equal(natural.stderr, "native stderr");
      const naturalEnvelope = JSON.parse(natural.stdout);
      assert.equal(Number.isSafeInteger(naturalEnvelope.targetStartedAt), true);
      assert.ok(
        Date.now() - naturalEnvelope.targetStartedAt >= 350,
        "the Job Object must remain owned until the descendant that started with the target exits"
      );

      const timeoutRejection = await runWindowsNativeStage("forced termination and attestation", async () => {
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
              ...WINDOWS_NATIVE_COMMAND_CLEANUP
            }
          );
        } catch (error) {
          rejection = error;
        }
        if (editorProcessTreeMayBeLive(rejection)) removePrivateRoot = false;
        assert.ok(rejection && typeof rejection === "object");
        assert.equal("code" in rejection && rejection.code === "EDITOR_COMMAND_RESOURCE_RELEASE_FAILED", false);
        assert.equal("message" in rejection && typeof rejection.message === "string", true);
        assert.match(rejection.message, /timed out after 2000 ms/u);
        return rejection;
      });
      assert.equal(editorProcessTreeMayBeLive(timeoutRejection), false);

      const malformedProbe = await runWindowsNativeStage("malformed-frame rejection", () =>
        runBoundedEditorCommand(
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
        )
      );
      assert.deepEqual(malformedProbe, { stdout: "malformed-frame-rejected", stderr: "" });

      runWindowsNativeSynchronousStage("executable replacement rejection", () => {
        renameSync(supervisorReceipt.executable, `${supervisorReceipt.executable}.original`);
        writeFileSync(supervisorReceipt.executable, "replacement", { encoding: "utf8" });
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
      });
    } catch (error) {
      if (editorProcessTreeMayBeLive(error)) removePrivateRoot = false;
      throw error;
    } finally {
      if (removePrivateRoot) {
        runWindowsNativeSynchronousStage("private-root cleanup", () =>
          rmSync(privateRoot, { recursive: true, force: true })
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
          spawnProcess: () => compiler.child
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
      rmSync(directory, { recursive: true, force: true });
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
          spawnProcess: () => compiler.child
        }),
        (error) => {
          assert.equal(editorProcessTreeMayBeLive(error), true);
          assert.equal(error.details?.stage, "windows-supervisor-compilation");
          assert.equal(error.details?.reason, "deadline");
          assert.equal(error.details?.compilerClosed, false);
          assert.match(error.message, /forced settlement exceeded 20 ms/u);
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
      rmSync(directory, { recursive: true, force: true });
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
    rmSync(directory, { recursive: true, force: true });
  }
});
