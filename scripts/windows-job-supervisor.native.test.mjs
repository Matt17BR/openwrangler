import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
