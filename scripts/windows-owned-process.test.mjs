import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import { PassThrough, Writable } from "node:stream";
import test from "node:test";
import {
  WINDOWS_OWNED_PROCESS_EMPTY_PREFIX,
  WINDOWS_OWNED_PROCESS_READY_PREFIX,
  spawnArmedWindowsProcess
} from "./windows-owned-process.mjs";

const TOKEN = "8f36fae0-13d4-4fb0-b2d4-4e49b46a4027";

test("the portable armed client spawns directly and writes exact GO and termination frames", async () => {
  const { child, frames, spawnCalls } = createSupervisorDouble();
  const owned = spawnArmedWindowsProcess(
    "C:\\tools\\worker.exe",
    ["--probe"],
    { cwd: "C:\\work", env: { SYSTEMROOT: "C:\\Windows" }, stdio: ["ignore", "pipe", "pipe"] },
    {
      platform: "win32",
      token: TOKEN,
      supervisorReceipt: Object.freeze({ receipt: true }),
      assertSupervisorReceipt(receipt) {
        assert.deepEqual(receipt, { receipt: true });
        return "C:\\private\\supervisor.exe";
      },
      spawnProcess() {
        spawnCalls.push([...arguments]);
        return child;
      }
    }
  );
  const stderr = collect(owned.stderr);
  assert.equal(spawnCalls.length, 1);
  assert.equal(spawnCalls[0][0], "C:\\private\\supervisor.exe");
  assert.deepEqual(spawnCalls[0][1], []);
  assert.deepEqual(spawnCalls[0][2], {
    cwd: "C:\\work",
    env: { SYSTEMROOT: "C:\\Windows" },
    detached: false,
    shell: false,
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"]
  });
  assert.deepEqual(JSON.parse(frames[0]), {
    protocol: 2,
    command: "launch-armed",
    executable: "C:\\tools\\worker.exe",
    args: ["--probe"],
    cwd: "C:\\work",
    environment: { SYSTEMROOT: "C:\\Windows" },
    attestationToken: TOKEN
  });

  let goSettled = false;
  const go = owned.go().then(() => {
    goSettled = true;
  });
  await assert.rejects(owned.go(), /exactly one GO/u);
  await assert.rejects(owned.terminate(), /at most one termination/u);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(goSettled, false);
  assert.equal(frames.length, 1);

  child.stderr.write(`${WINDOWS_OWNED_PROCESS_READY_PREFIX}${TOKEN}\n`, "ascii");
  await go;
  assert.deepEqual(JSON.parse(frames[1]), {
    protocol: 2,
    command: "go",
    attestationToken: TOKEN
  });
  await assert.rejects(owned.go(), /exactly one GO/u);
  await owned.terminate();
  assert.deepEqual(JSON.parse(frames[2]), {
    protocol: 2,
    command: "terminate",
    attestationToken: TOKEN
  });

  child.stderr.end(`target stderr\n${WINDOWS_OWNED_PROCESS_EMPTY_PREFIX}${TOKEN}\n`, "ascii");
  assert.equal(await owned.verifyEmpty(), true);
  assert.equal(await stderr, "target stderr\n");
});

test("the portable armed client rejects shell and unsupported spawn options before spawn", () => {
  let spawnCount = 0;
  const dependencies = {
    platform: "win32",
    token: TOKEN,
    supervisorReceipt: {},
    assertSupervisorReceipt: () => "C:\\private\\supervisor.exe",
    spawnProcess() {
      spawnCount++;
      return createSupervisorDouble().child;
    }
  };
  for (const options of [
    { cwd: "C:\\work", shell: true },
    { cwd: "C:\\work", shell: "cmd.exe" },
    { cwd: "C:\\work", argv0: "interposed.exe" },
    { cwd: "C:\\work", signal: new AbortController().signal }
  ]) {
    assert.throws(
      () => spawnArmedWindowsProcess("C:\\tools\\worker.exe", [], options, dependencies),
      /shell disabled|does not accept the spawn option/u
    );
  }
  assert.equal(spawnCount, 0);
});

test("abort and closeLease revoke immediately without waiting for a stalled READY", async () => {
  const { child } = createSupervisorDouble();
  const owned = spawnTestProcess(child);
  const pendingGo = owned.go();
  await new Promise((resolve) => setImmediate(resolve));
  const firstAbort = owned.closeLease();
  const secondAbort = owned.abort();
  assert.strictEqual(secondAbort, firstAbort);
  assert.strictEqual(owned.closeLease(), firstAbort);
  assert.equal(child.stdin.destroyed, true);
  await firstAbort;
  await assert.rejects(pendingGo, /control lease was revoked before GO/u);
  child.stderr.destroy();
  assert.equal(await owned.verifyEmpty(), false);
});

test("destroying transformed stderr loses verification, aborts the lease, and settles EMPTY", async () => {
  const { child } = createSupervisorDouble();
  const owned = spawnTestProcess(child);
  child.stderr.write(`${WINDOWS_OWNED_PROCESS_READY_PREFIX}${TOKEN}\n`, "ascii");
  await owned.ready;
  const outputClosed = new Promise((resolve) => owned.stderr.once("close", resolve));
  owned.stderr.destroy();
  await outputClosed;
  assert.equal(child.stdin.destroyed, true);
  assert.equal(await owned.verifyEmpty(), false);
});

test("the portable armed client rejects duplicate proofs and preserves ordinary stderr", async () => {
  const { child } = createSupervisorDouble();
  const owned = spawnTestProcess(child);
  const stderr = collect(owned.stderr);
  child.stderr.write(`before${WINDOWS_OWNED_PROCESS_READY_PREFIX}${TOKEN}\n`, "ascii");
  await owned.ready;
  child.stderr.end(
    `${WINDOWS_OWNED_PROCESS_READY_PREFIX}${TOKEN}\nafter${WINDOWS_OWNED_PROCESS_EMPTY_PREFIX}${TOKEN}\n`,
    "ascii"
  );
  assert.equal(await owned.verifyEmpty(), false);
  assert.equal(child.stdin.destroyed, true);
  assert.equal(await stderr, "beforeafter");
  await assert.rejects(owned.go(), /exactly one GO|lost its control lease/u);
});

test("a launch-frame write failure loses verification and uses the same repeatable abort", async () => {
  const { child } = createSupervisorDouble({ failWriteAt: 1 });
  const owned = spawnTestProcess(child);
  await assert.rejects(owned.ready, /control frame could not be written|exact READY proof/u);
  assert.equal(child.stdin.destroyed, true);
  assert.equal(await owned.verifyEmpty(), false);
  assert.strictEqual(owned.abort(), owned.abort());
  child.stderr.destroy();
});

test("a GO write failure loses verification and leaves abort available", async () => {
  const { child } = createSupervisorDouble({ failWriteAt: 2 });
  const owned = spawnTestProcess(child);
  child.stderr.write(`${WINDOWS_OWNED_PROCESS_READY_PREFIX}${TOKEN}\n`, "ascii");
  await owned.ready;
  await assert.rejects(owned.go(), /control frame could not be written/u);
  assert.equal(child.stdin.destroyed, true);
  assert.equal(await owned.verifyEmpty(), false);
  const firstAbort = owned.abort();
  assert.strictEqual(owned.closeLease(), firstAbort);
  await firstAbort;
  child.stderr.destroy();
});

test("the portable armed client settles both proofs when stderr closes before READY", async () => {
  const { child } = createSupervisorDouble();
  const owned = spawnTestProcess(child);
  const stderr = collect(owned.stderr);
  child.stderr.end("supervisor stopped", "utf8");
  await assert.rejects(owned.ready, /one exact READY proof/u);
  assert.equal(await owned.verifyEmpty(), false);
  assert.equal(await stderr, "supervisor stopped");
});

test("the checked-in supervisor keeps v1 and adds a separately armed v2 path", async () => {
  const source = await readFile(new URL("./windows-job-supervisor.ps1", import.meta.url), "utf8");
  assert.match(source, /"protocol", "command", "executable", "args", "cwd", "environment", "attestationToken"/u);
  assert.match(source, /ProtocolVersion == 1\) return RunLegacy\(reader, request\)/u);
  assert.match(source, /ProtocolVersion == 2\) return RunArmed\(reader, request\)/u);
  assert.match(source, /NativeJob job = NativeJob\.Prepare\(request\)/u);
  assert.match(source, /WriteJobReadyAttestation\(request\.AttestationToken\)/u);
  assert.match(source, /Protocol\.ParseGo\(control\.Frame, request\.AttestationToken\)/u);
  assert.match(source, /requireExactlyOneSuspend && previousSuspendCount != 1u/u);
  assert.match(source, /JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE/u);
  assert.match(source, /OPEN_WRANGLER_WINDOWS_JOB_EMPTY:/u);
  assert.doesNotMatch(source, /Process\.Start|Start-Process/u);
});

function spawnTestProcess(child) {
  return spawnArmedWindowsProcess(
    "C:\\tools\\worker.exe",
    [],
    { cwd: "C:\\work", env: { SYSTEMROOT: "C:\\Windows" } },
    {
      platform: "win32",
      token: TOKEN,
      supervisorReceipt: {},
      assertSupervisorReceipt: () => "C:\\private\\supervisor.exe",
      spawnProcess: () => child
    }
  );
}

function createSupervisorDouble({ failWriteAt } = {}) {
  const frames = [];
  let pending = "";
  let writes = 0;
  const stdin = new Writable({
    write(chunk, _encoding, callback) {
      writes++;
      if (writes === failWriteAt) {
        callback(new Error("injected control write failure"));
        return;
      }
      pending += chunk.toString("utf8");
      while (true) {
        const newline = pending.indexOf("\n");
        if (newline < 0) break;
        frames.push(pending.slice(0, newline));
        pending = pending.slice(newline + 1);
      }
      callback();
    }
  });
  const child = Object.assign(new EventEmitter(), {
    stdin,
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill() {}
  });
  return { child, frames, spawnCalls: [] };
}

function collect(stream) {
  const chunks = [];
  stream.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
  return new Promise((resolve, reject) => {
    stream.once("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    stream.once("error", reject);
  });
}
