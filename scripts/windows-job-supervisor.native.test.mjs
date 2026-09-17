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
  async (t) => {
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

      const binary = await runBoundedEditorCommand(
        {
          executable: process.execPath,
          args: [
            "-e",
            `(${windowsRBinaryControls.toString()})().catch(error => { console.error(error); process.exitCode = 1; });`,
            supervisor.executable,
            join(import.meta.dirname, "../r/openwrangler_runtime/windows-job-supervisor.ps1")
          ],
          environment,
          label: "Windows native R binary input and source supervisor ownership"
        },
        { platform: "win32", timeoutMs: 60_000, ...commandCleanup }
      );
      const binaryResult = JSON.parse(binary.stdout);
      assert.equal(binaryResult.passed, 8);
      assert.ok(binaryResult.sourceStartupMs > 0);
      t.diagnostic(JSON.stringify(binaryResult));
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

// Runs inside the existing outer Job so a failed ownership assertion cannot leak
// fixture children. Each inner supervisor still has its own private lease/job.
async function windowsRBinaryControls() {
  const { default: assert } = await import("node:assert/strict");
  const { spawn } = await import("node:child_process");
  const { randomUUID } = await import("node:crypto");
  const { join } = await import("node:path");
  const { setTimeout: delay } = await import("node:timers/promises");
  const ownedChildren = new Set();
  const executable = process.argv[1];
  const source = process.argv[2];
  const powerShell = join(
    process.env.SYSTEMROOT ?? process.env.SystemRoot,
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe"
  );
  const sourceArguments = ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", source];
  const alive = (pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      if (error.code === "ESRCH") return false;
      throw error;
    }
  };
  const frame = (payload) => {
    const body = Buffer.concat([Buffer.from(`${randomUUID()}\n`), payload]);
    const header = Buffer.alloc(4);
    header.writeUInt32BE(body.length);
    return Buffer.concat([header, body]);
  };
  function launch(code, useSource = false, firstFrame) {
    const token = randomUUID();
    const child = spawn(useSource ? powerShell : executable, useSource ? sourceArguments : [], {
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true
    });
    ownedChildren.add(child);
    child.once("close", () => ownedChildren.delete(child));
    child.stdin.on("error", () => undefined);
    let stdout = "",
      stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    let result;
    const closed = new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => {
        result = { code, signal, stdout, stderr };
        resolve(result);
      });
    });
    void closed.catch(() => undefined);
    const launchLine = Buffer.from(
      JSON.stringify({
        protocol: 1,
        command: "launch",
        executable: process.execPath,
        args: ["-e", code],
        cwd: process.cwd(),
        environment: process.env,
        attestationToken: token,
        inputMode: "r-binary"
      }) + "\n"
    );
    child.stdin.write(firstFrame ? Buffer.concat([launchLine, firstFrame]) : launchLine);
    return { child, closed, token, output: () => stdout, result: () => result, diagnostic: () => stderr };
  }
  async function ready(owned) {
    const deadline = Date.now() + 10_000;
    while (!owned.output().includes("\n")) {
      const result = owned.result?.();
      assert.equal(result, undefined, `Fixture exited before readiness: ${JSON.stringify(result)}`);
      assert.ok(Date.now() < deadline, `Fixture target did not start: ${(owned.diagnostic?.() ?? "").slice(-2048)}`);
      await delay(10);
    }
    return JSON.parse(owned.output().split("\n")[0]);
  }
  async function settled(owned, attested = true) {
    const result = await owned.closed;
    assert.equal(result.stderr.includes(`OPEN_WRANGLER_WINDOWS_JOB_EMPTY:${owned.token}\n`), attested);
    return result;
  }
  try {
    const binary = frame(Buffer.from([0, 1, 10, 13, 255]));
    const echo = `let bytes = Buffer.alloc(0); process.stdin.on('data', chunk => { bytes = Buffer.concat([bytes, chunk]); if (bytes.length >= ${binary.length}) { process.stdout.write(bytes.toString('base64')); process.exit(0); } });`;
    const coalesced = launch(echo, false, binary);
    const echoed = await settled(coalesced);
    assert.equal(echoed.code, 0);
    assert.equal(echoed.stdout, binary.toString("base64"));

    // Writer failure caused by owned termination must not suppress Job-empty evidence.
    const tree =
      "const {spawn} = require('node:child_process'); const nested=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore',detached:true}); nested.unref(); console.log(JSON.stringify({pid:process.pid, descendant:nested.pid})); setInterval(()=>{},1000);";
    const large = frame(Buffer.alloc(16 * 1024 * 1024));
    const blocked = launch(tree);
    const blockedPids = await ready(blocked);
    blocked.child.stdin.end(large);
    await settled(blocked);
    assert.equal(alive(blockedPids.pid), false);
    assert.equal(alive(blockedPids.descendant), false);

    const exiting = launch(tree.replace("setInterval(()=>{},1000);", "setTimeout(()=>process.exit(0),500);"));
    const exitingPids = await ready(exiting);
    exiting.child.stdin.write(large);
    await settled(exiting);
    assert.equal(alive(exitingPids.pid), false);
    assert.equal(alive(exitingPids.descendant), false);

    for (const invalid of [Buffer.from([0, 0]), Buffer.from([1, 0, 0, 38])]) {
      const refused = launch(tree);
      const pids = await ready(refused);
      refused.child.stdin.end(invalid);
      const result = await settled(refused, false);
      assert.equal(result.code, 125);
      assert.match(result.stderr, /SUPERVISOR_ERROR:protocol/);
      assert.equal(alive(pids.pid), false);
      assert.equal(alive(pids.descendant), false);
    }

    const sentinel = launch(tree);
    const sentinelPids = await ready(sentinel);
    const killed = launch(tree);
    const killedPids = await ready(killed);
    killed.child.kill("SIGKILL");
    await settled(killed, false);
    const deadline = Date.now() + 5_000;
    while (alive(killedPids.pid) || alive(killedPids.descendant)) {
      assert.ok(Date.now() < deadline, "killed supervisor left a fixture descendant");
      await delay(10);
    }
    assert.equal(alive(sentinelPids.pid), true);
    assert.equal(alive(sentinelPids.descendant), true);
    const started = performance.now();
    const sourceOwned = launch(tree, true);
    const sourcePids = await ready(sourceOwned);
    const sourceStartupMs = performance.now() - started;
    sourceOwned.child.stdin.end(large);
    await settled(sourceOwned);
    assert.equal(alive(sourcePids.pid), false);
    assert.equal(alive(sourcePids.descendant), false);
    // Closing the lease during compilation must not start an unowned lasting target.
    const duringCompilation = launch(tree, true);
    duringCompilation.child.stdin.end();
    await settled(duringCompilation);

    // The source owner must contain the same native tree once its job is ready.
    const killedSource = launch(tree, true);
    const killedSourcePids = await ready(killedSource);
    killedSource.child.kill("SIGKILL");
    await settled(killedSource, false);
    const sourceExitDeadline = Date.now() + 5_000;
    while (alive(killedSourcePids.pid) || alive(killedSourcePids.descendant)) {
      assert.ok(Date.now() < sourceExitDeadline, "killed source supervisor left a fixture descendant");
      await delay(10);
    }
    assert.equal(alive(sentinelPids.pid), true);
    assert.equal(alive(sentinelPids.descendant), true);
    sentinel.child.stdin.end();
    await settled(sentinel);
    process.stdout.write(JSON.stringify({ passed: 8, sourceStartupMs }));
  } finally {
    await Promise.allSettled(
      [...ownedChildren].map(
        (child) =>
          new Promise((resolve) => {
            child.once("close", resolve);
            child.stdin.destroy();
            child.kill("SIGKILL");
          })
      )
    );
  }
}
