import assert from "node:assert/strict";
import { existsSync, renameSync, writeFileSync } from "node:fs";
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
import { spawnArmedWindowsProcess } from "./windows-owned-process.mjs";

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
    let armedTreeMayBeLive = false;
    try {
      const supervisorReceipt = await prepareWindowsEditorProcessSupervisor(environment, { platform: "win32" });
      const armedSentinel = join(privateRoot, "armed-target-started");
      const armedStartedAt = Date.now();
      const armed = spawnArmedWindowsProcess(
        process.execPath,
        [
          "-e",
          [
            "const { spawn } = require('node:child_process');",
            "require('node:fs').writeFileSync(process.argv[1], 'started');",
            "process.stdout.write('armed stdout');",
            "process.stderr.write('armed stderr');",
            "spawn(process.execPath, ['-e', 'setTimeout(() => {}, 500)'], { detached: true, stdio: 'ignore' }).unref();"
          ].join(" "),
          armedSentinel
        ],
        { cwd: privateRoot, env: environment, stdio: ["ignore", "pipe", "pipe"] },
        { platform: "win32", supervisorReceipt }
      );
      armedTreeMayBeLive = true;
      const armedStdout = collectStream(armed.child.stdout);
      const armedStderr = collectStream(armed.stderr);
      await deadline(armed.ready, 10_000, "armed READY");
      assert.equal(existsSync(armedSentinel), false, "the suspended target must not run before GO");
      await armed.go();
      const armedExit = await deadline(childClose(armed.child), 15_000, "armed natural exit");
      const armedEmpty = await deadline(armed.verifyEmpty(), 5_000, "armed EMPTY");
      if (armedEmpty) armedTreeMayBeLive = false;
      assert.deepEqual(armedExit, { code: 0, signal: null });
      assert.equal(armedEmpty, true);
      assert.equal(await armedStdout, "armed stdout");
      assert.equal(await armedStderr, "armed stderr");
      assert.equal(existsSync(armedSentinel), true);
      assert.ok(
        Date.now() - armedStartedAt >= 350,
        "the armed Job Object must remain owned until the target descendant exits"
      );

      const terminatedSentinel = join(privateRoot, "terminated-target-started");
      const terminated = spawnArmedWindowsProcess(
        process.execPath,
        [
          "-e",
          "require('node:fs').writeFileSync(process.argv[1], 'started'); setInterval(() => {}, 1000);",
          terminatedSentinel
        ],
        { cwd: privateRoot, env: environment, stdio: ["ignore", "ignore", "pipe"] },
        { platform: "win32", supervisorReceipt }
      );
      armedTreeMayBeLive = true;
      const terminatedStderr = collectStream(terminated.stderr);
      await deadline(terminated.ready, 10_000, "pre-GO termination READY");
      assert.equal(existsSync(terminatedSentinel), false);
      const terminatedClose = childClose(terminated.child);
      await terminated.terminate();
      const terminatedExit = await deadline(terminatedClose, 15_000, "pre-GO termination");
      const terminatedEmpty = await deadline(terminated.verifyEmpty(), 5_000, "pre-GO termination EMPTY");
      if (terminatedEmpty) armedTreeMayBeLive = false;
      assert.deepEqual(terminatedExit, { code: 143, signal: null });
      assert.equal(terminatedEmpty, true);
      assert.equal(await terminatedStderr, "");
      assert.equal(existsSync(terminatedSentinel), false);

      const postGoSentinel = join(privateRoot, "post-go-target-started");
      const postGoTerminated = spawnArmedWindowsProcess(
        process.execPath,
        [
          "-e",
          "require('node:fs').writeFileSync(process.argv[1], 'started'); setInterval(() => {}, 1000);",
          postGoSentinel
        ],
        { cwd: privateRoot, env: environment, stdio: ["ignore", "ignore", "pipe"] },
        { platform: "win32", supervisorReceipt }
      );
      armedTreeMayBeLive = true;
      const postGoStderr = collectStream(postGoTerminated.stderr);
      await deadline(postGoTerminated.ready, 10_000, "post-GO termination READY");
      assert.equal(existsSync(postGoSentinel), false);
      await postGoTerminated.go();
      await waitForFile(postGoSentinel, 10_000);
      const postGoClose = childClose(postGoTerminated.child);
      await postGoTerminated.terminate();
      const postGoExit = await deadline(postGoClose, 15_000, "post-GO termination");
      const postGoEmpty = await deadline(postGoTerminated.verifyEmpty(), 5_000, "post-GO termination EMPTY");
      if (postGoEmpty) armedTreeMayBeLive = false;
      assert.deepEqual(postGoExit, { code: 143, signal: null });
      assert.equal(postGoEmpty, true);
      assert.equal(await postGoStderr, "");

      const leaseSentinel = join(privateRoot, "lease-target-started");
      const leaseClosed = spawnArmedWindowsProcess(
        process.execPath,
        [
          "-e",
          "require('node:fs').writeFileSync(process.argv[1], 'started'); setInterval(() => {}, 1000);",
          leaseSentinel
        ],
        { cwd: privateRoot, env: environment, stdio: ["ignore", "ignore", "pipe"] },
        { platform: "win32", supervisorReceipt }
      );
      armedTreeMayBeLive = true;
      const leaseStderr = collectStream(leaseClosed.stderr);
      await deadline(leaseClosed.ready, 10_000, "lease-close READY");
      assert.equal(existsSync(leaseSentinel), false);
      const leaseClose = childClose(leaseClosed.child);
      await leaseClosed.closeLease();
      const leaseExit = await deadline(leaseClose, 15_000, "lease-close exit");
      const leaseEmpty = await deadline(leaseClosed.verifyEmpty(), 5_000, "lease-close EMPTY");
      if (leaseEmpty) armedTreeMayBeLive = false;
      assert.deepEqual(leaseExit, { code: 125, signal: null });
      assert.equal(leaseEmpty, true);
      assert.equal(await leaseStderr, "");
      assert.equal(existsSync(leaseSentinel), false);

      for (const mode of ["malformed", "duplicate"]) {
        const probe = await runBoundedEditorCommand(
          {
            executable: process.execPath,
            args: ["-e", armedProtocolFailureProbe(), supervisorReceipt.executable, mode],
            environment,
            label: `real Windows supervisor ${mode} GO smoke`
          },
          { platform: "win32", timeoutMs: 30_000 }
        );
        assert.deepEqual(probe, { stdout: `${mode}-go-rejected`, stderr: "" });
      }

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
      if (armedTreeMayBeLive || editorProcessTreeMayBeLive(error)) removePrivateRoot = false;
      throw error;
    } finally {
      if (removePrivateRoot) await rm(privateRoot, { recursive: true, force: true });
    }
  }
);

function armedProtocolFailureProbe() {
  return [
    "const { spawn } = require('node:child_process');",
    "const supervisor = process.argv[1]; const mode = process.argv[2];",
    "const token = '65cebdc9-a4fe-4211-9dac-5d5ec3a14a37';",
    "const child = spawn(supervisor, [], { env: process.env, windowsHide: true, stdio: ['pipe', 'ignore', 'pipe'] });",
    "const launch = { protocol: 2, command: 'launch-armed', executable: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'], cwd: process.cwd(), environment: process.env, attestationToken: token };",
    "let stderr = ''; let sent = false; let finished = false;",
    "const ready = 'OPEN_WRANGLER_WINDOWS_JOB_READY:' + token + '\\n';",
    "const failure = 'OPEN_WRANGLER_WINDOWS_SUPERVISOR_ERROR:protocol\\n';",
    "const finish = (code, message) => { if (finished) return; finished = true; clearTimeout(timer); if (message) process.stderr.write(message); process.exitCode = code; };",
    "const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} finish(3, 'inner armed supervisor timeout'); }, 15000);",
    "child.stdin.on('error', () => {});",
    "child.stderr.setEncoding('utf8');",
    "child.stderr.on('data', chunk => { stderr += chunk; if (!sent && stderr.includes(ready)) { sent = true; const valid = JSON.stringify({ protocol: 2, command: 'go', attestationToken: token }) + '\\n'; const invalid = JSON.stringify({ protocol: 2, command: 'go', attestationToken: '00000000-0000-4000-8000-000000000000' }) + '\\n'; child.stdin.write(mode === 'duplicate' ? valid + valid : invalid); } if (Buffer.byteLength(stderr, 'utf8') > 4096) { try { child.kill('SIGKILL'); } catch {} finish(4, 'inner armed supervisor output limit'); } });",
    "child.once('error', () => finish(5, 'inner armed supervisor spawn failure'));",
    "child.once('close', (code, signal) => { const normalized = stderr.replace(/\\r\\n/gu, '\\n'); if (code === 125 && signal === null && normalized === ready + failure) { process.stdout.write(mode + '-go-rejected'); finish(0); } else finish(6, 'inner armed supervisor protocol mismatch'); });",
    "child.stdin.write(JSON.stringify(launch) + '\\n');"
  ].join(" ");
}

function childClose(child) {
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
}

function collectStream(stream) {
  const chunks = [];
  stream.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
  return new Promise((resolve, reject) => {
    stream.once("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    stream.once("error", reject);
  });
}

async function deadline(promise, milliseconds, label) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} exceeded ${milliseconds} ms.`)), milliseconds);
      })
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function waitForFile(path, milliseconds) {
  const deadlineAt = Date.now() + milliseconds;
  while (!existsSync(path)) {
    if (Date.now() >= deadlineAt) throw new Error(`File did not appear within ${milliseconds} ms.`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
