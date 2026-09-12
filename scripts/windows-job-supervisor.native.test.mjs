import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import {
  configureEditorAcceptanceTempRoot,
  createEditorAcceptanceEnvironmentForPlatform,
  editorProcessTreeMayBeLive,
  prepareWindowsEditorProcessSupervisor,
  runBoundedEditorCommand
} from "./editor-acceptance.mjs";

const commandCleanup = Object.freeze({
  terminationGraceMs: 5_000,
  killGraceMs: 5_000,
  windowsTreeKillTimeoutMs: 5_000
});

for (const scenario of ["sole deadline", "departing shared caller", "unclosed tree"]) {
  test(`Windows compiler preparation retains ownership: ${scenario}`, { timeout: 10_000 }, async (t) => {
    const privateRoot = await mkdtemp(join(tmpdir(), "ow-supervisor-control-"));
    const environment = createEditorAcceptanceEnvironmentForPlatform(process.env, {}, "win32");
    configureEditorAcceptanceTempRoot(privateRoot, environment, "win32");
    const compiler = controlledCompilerChild(42_001, true);
    const taskkill = controlledCompilerChild(42_002);
    const firstController = new AbortController();
    const secondController = new AbortController();
    const pending = [];
    let launches = 0;
    let outputDirectory;
    const taskkillArguments = [];
    t.after(async () => {
      firstController.abort();
      secondController.abort();
      compiler.close();
      taskkill.close();
      await Promise.allSettled(pending);
      compiler.stdout.destroy();
      compiler.stderr.destroy();
      await rm(privateRoot, { recursive: true, force: true });
    });
    const options = {
      platform: "win32",
      buildTimeoutMs: scenario === "sole deadline" ? 1_000 : 5_000,
      buildSettlementTimeoutMs: scenario === "unclosed tree" ? 100 : 1_000,
      spawnProcess: (_executable, args) => {
        launches += 1;
        outputDirectory = dirname(args.at(-1));
        return compiler;
      },
      spawnTaskkillProcess: (_executable, args) => {
        taskkillArguments.push(args);
        if (scenario === "sole deadline") {
          queueMicrotask(() => {
            taskkill.close();
            compiler.close(null, "SIGKILL");
          });
        }
        return taskkill;
      }
    };
    const first = prepareWindowsEditorProcessSupervisor(environment, {
      ...options,
      buildAbortSignal: firstController.signal
    });
    pending.push(first);
    if (scenario === "departing shared caller") {
      const second = prepareWindowsEditorProcessSupervisor(environment, {
        ...options,
        buildAbortSignal: secondController.signal
      });
      pending.push(second);
      let secondSettled = false;
      const secondOutcome = second.then(
        (receipt) => {
          secondSettled = true;
          return { receipt };
        },
        (error) => {
          secondSettled = true;
          return { error };
        }
      );
      firstController.abort();
      await assert.rejects(first, (error) => {
        assert.equal(error.code, "EDITOR_ACCEPTANCE_STAGE_ABORTED");
        assert.equal(error.details.buildStillOwned, true);
        assert.equal(error.details.treeVerifiedStopped, null);
        return true;
      });
      assert.equal(secondSettled, false);
      assert.equal(launches, 1);
      assert.deepEqual(taskkillArguments, []);
      assert.equal(compiler.stdout.destroyed, false);
      compiler.close(7);
      const outcome = await secondOutcome;
      assert.equal(outcome.error?.details.reason, "nonzero-exit");
      assert.equal(outcome.error?.details.treeVerifiedStopped, true);
      assert.equal(compiler.stdout.destroyed, true);
      return;
    }
    if (scenario === "unclosed tree") firstController.abort();
    await assert.rejects(first, (error) => {
      if (scenario === "sole deadline") {
        assert.equal(error.code, "EDITOR_ACCEPTANCE_STAGE_DEADLINE");
        assert.equal(error.details.treeVerifiedStopped, true);
        assert.equal(error.details.compilerClosed, true);
        assert.equal(error.details.compilerTreeTerminated, true);
        assert.ok(error.details.elapsedMs >= 1_000);
      } else {
        assert.equal(error.code, "EDITOR_PROCESS_TREE_UNVERIFIED");
        assert.equal(error.details.compilerClosed, false);
        assert.equal(error.details.compilerTreeTerminated, false);
        const deadline = error.details.settlementDeadline;
        assert.equal(deadline.limitMs, 100);
        assert.ok(deadline.elapsedMs >= 100);
        assert.equal(deadline.abortSettlementLimitMs, 100);
        assert.ok(deadline.abortSettlementElapsedMs >= 100);
      }
      return true;
    });
    assert.deepEqual(taskkillArguments, [["/PID", String(compiler.pid), "/T", "/F"]]);
    assert.equal(launches, 1);
    assert.equal(compiler.stdout.destroyed, true);
    assert.equal(compiler.stderr.destroyed, true);
    assert.equal(compiler.unrefs, 1);
    assert.equal(taskkill.unrefs, 1);
    if (scenario === "unclosed tree") {
      assert.equal((await stat(outputDirectory)).isDirectory(), true);
      await assert.rejects(prepareWindowsEditorProcessSupervisor(environment, options), (error) => {
        assert.equal(error.code, "EDITOR_PROCESS_TREE_UNVERIFIED");
        assert.match(error.message, /cannot be reused/u);
        return true;
      });
      assert.equal(launches, 1);
      for (const child of [compiler, taskkill]) {
        assert.deepEqual(child.kills, ["SIGKILL"]);
        assert.doesNotThrow(() => child.emit("error", new Error("owned late close")));
        child.close();
        assert.equal(child.listenerCount("error"), 0);
        assert.equal(child.listenerCount("close"), 0);
      }
    }
  });
}

function controlledCompilerChild(pid, captureOutput = false) {
  return Object.assign(new EventEmitter(), {
    pid,
    exitCode: null,
    signalCode: null,
    kills: [],
    unrefs: 0,
    ...(captureOutput ? { stdout: new PassThrough(), stderr: new PassThrough() } : {}),
    kill(signal) {
      this.kills.push(signal);
      return true;
    },
    unref() {
      this.unrefs += 1;
    },
    close(code = 0, signal = null) {
      this.exitCode = code;
      this.signalCode = signal;
      this.emit("close", code, signal);
    }
  });
}

test(
  "the real Windows Job Object supervisor contains, terminates, and rejects malformed control",
  { skip: process.platform !== "win32", timeout: 420_000 },
  async () => {
    const privateParent = join(tmpdir(), "ow");
    await mkdir(privateParent, { recursive: true, mode: 0o700 });
    const privateRoot = await mkdtemp(join(privateParent, "x-"));
    const environment = createEditorAcceptanceEnvironmentForPlatform(process.env, {}, "win32");
    configureEditorAcceptanceTempRoot(privateRoot, environment);
    let cleanupIsSafe = true;

    try {
      const supervisor = await prepareWindowsEditorProcessSupervisor(environment, { platform: "win32" });

      const natural = await runBoundedEditorCommand(
        {
          executable: process.execPath,
          args: [
            "-e",
            [
              "const { spawn } = require('node:child_process');",
              "const startedAt = Date.now();",
              "const descendant = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 1200)'], { detached: true, stdio: 'ignore' });",
              "descendant.unref();",
              "process.stdout.write(JSON.stringify({ startedAt, descendantPid: descendant.pid }));"
            ].join(" ")
          ],
          environment,
          label: "Windows supervisor natural descendant containment"
        },
        { platform: "win32", timeoutMs: 30_000, ...commandCleanup }
      );
      const naturalResult = JSON.parse(natural.stdout);
      assert.equal(processIsRunning(naturalResult.descendantPid), false);
      assert.ok(Date.now() - naturalResult.startedAt >= 400);

      let forcedFailure;
      try {
        await runBoundedEditorCommand(
          {
            executable: process.execPath,
            args: [
              "-e",
              [
                "const { spawn } = require('node:child_process');",
                "const descendant = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });",
                "process.stdout.write(`descendant:${descendant.pid}\\n`);",
                "setInterval(() => {}, 1000);"
              ].join(" ")
            ],
            environment,
            label: "Windows supervisor forced descendant termination"
          },
          { platform: "win32", timeoutMs: 2_000, ...commandCleanup }
        );
      } catch (error) {
        forcedFailure = error;
      }
      assert.ok(forcedFailure instanceof Error);
      cleanupIsSafe = !editorProcessTreeMayBeLive(forcedFailure);
      assert.equal(cleanupIsSafe, true);
      assert.match(forcedFailure.message, /timed out after 2000 ms/u);
      const forcedPid = Number(/descendant:(\d+)/u.exec(forcedFailure.message)?.[1]);
      assert.equal(Number.isSafeInteger(forcedPid), true);
      assert.equal(processIsRunning(forcedPid), false);

      const malformed = await runBoundedEditorCommand(
        {
          executable: process.execPath,
          args: [
            "-e",
            [
              "const { spawn } = require('node:child_process');",
              "const child = spawn(process.argv[1], [], { env: process.env, windowsHide: true, stdio: ['pipe', 'ignore', 'pipe'] });",
              "let stderr = '';",
              "child.stderr.setEncoding('utf8');",
              "child.stderr.on('data', chunk => { stderr += chunk; });",
              "child.once('close', (code, signal) => { const normalized = stderr.replace(/\\r\\n/gu, '\\n'); if (code === 125 && signal === null && normalized === 'OPEN_WRANGLER_WINDOWS_SUPERVISOR_ERROR:protocol\\n') process.stdout.write('malformed-frame-rejected'); else process.exitCode = 2; });",
              "child.stdin.end('{}\\n', 'utf8');"
            ].join(" "),
            supervisor.executable
          ],
          environment,
          label: "Windows supervisor malformed-frame rejection"
        },
        { platform: "win32", timeoutMs: 30_000, ...commandCleanup }
      );
      assert.deepEqual(malformed, { stdout: "malformed-frame-rejected", stderr: "" });
    } catch (error) {
      if (editorProcessTreeMayBeLive(error)) cleanupIsSafe = false;
      throw error;
    } finally {
      if (cleanupIsSafe) await rm(privateRoot, { recursive: true, force: true });
    }
  }
);

function processIsRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    throw error;
  }
}
