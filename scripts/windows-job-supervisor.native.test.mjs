import assert from "node:assert/strict";
import { renameSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  configureEditorAcceptanceTempRoot,
  createEditorAcceptanceEnvironmentForPlatform,
  editorProcessTreeMayBeLive,
  prepareWindowsEditorProcessSupervisor,
  runBoundedEditorCommand,
  spawnOwnedEditorProcess
} from "./editor-acceptance.mjs";

test(
  "the real Windows supervisor compiles once, contains descendants, terminates, and rejects malformed frames",
  { skip: process.platform !== "win32", timeout: 90_000 },
  async () => {
    const privateParent = join(tmpdir(), "ow");
    await mkdir(privateParent, { recursive: true, mode: 0o700 });
    const privateRoot = await mkdtemp(join(privateParent, "x-"));
    const environment = createEditorAcceptanceEnvironmentForPlatform(process.env, {}, "win32");
    configureEditorAcceptanceTempRoot(privateRoot, environment);
    let removePrivateRoot = true;
    try {
      const supervisorReceipt = await prepareWindowsEditorProcessSupervisor(environment, { platform: "win32" });
      const natural = await runBoundedEditorCommand(
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
          label: "real Windows supervisor natural-exit smoke"
        },
        { platform: "win32", timeoutMs: 30_000 }
      );
      assert.equal(natural.stderr, "native stderr");
      const naturalEnvelope = JSON.parse(natural.stdout);
      assert.equal(Number.isSafeInteger(naturalEnvelope.targetStartedAt), true);
      assert.ok(
        Date.now() - naturalEnvelope.targetStartedAt >= 350,
        "the Job Object must remain owned until the descendant that started with the target exits"
      );

      let timeoutRejection;
      try {
        await runBoundedEditorCommand(
          {
            executable: process.execPath,
            args: [
              "-e",
              "const { spawn } = require('node:child_process'); spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' }).unref(); setInterval(() => {}, 1000);"
            ],
            environment,
            label: "real Windows supervisor termination smoke"
          },
          {
            platform: "win32",
            timeoutMs: 2_000,
            terminationGraceMs: 5_000,
            killGraceMs: 5_000
          }
        );
      } catch (error) {
        timeoutRejection = error;
      }
      if (editorProcessTreeMayBeLive(timeoutRejection)) removePrivateRoot = false;
      assert.ok(timeoutRejection && typeof timeoutRejection === "object");
      assert.equal(
        "code" in timeoutRejection && timeoutRejection.code === "EDITOR_COMMAND_RESOURCE_RELEASE_FAILED",
        false
      );
      assert.equal("message" in timeoutRejection && typeof timeoutRejection.message === "string", true);
      assert.match(timeoutRejection.message, /timed out after 2000 ms/u);

      const malformedProbe = await runBoundedEditorCommand(
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
          label: "real Windows supervisor malformed-frame smoke"
        },
        { platform: "win32", timeoutMs: 30_000 }
      );
      assert.deepEqual(malformedProbe, { stdout: "malformed-frame-rejected", stderr: "" });

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
    } catch (error) {
      if (editorProcessTreeMayBeLive(error)) removePrivateRoot = false;
      throw error;
    } finally {
      if (removePrivateRoot) await rm(privateRoot, { recursive: true, force: true });
    }
  }
);
