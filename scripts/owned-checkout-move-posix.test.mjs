import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PassThrough } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  OWNED_CHECKOUT_MOVE_OWNERSHIP_UNCERTAIN,
  OWNED_CHECKOUT_MOVE_PROTOCOL,
  OWNED_CHECKOUT_PIDFD_PROTOCOL,
  OWNED_CHECKOUT_GIT_EXEC_PROTOCOL,
  OWNED_CHECKOUT_HOST_CGROUP_PROTOCOL,
  OWNED_CHECKOUT_HOST_NAMESPACE_PROTOCOL,
  OwnedCheckoutMoveError,
  observeExecutionCgroup,
  parseLinuxMountInfo,
  parseStrictJson,
  runGitMove,
  scanSameUidProcessUse,
  startOwnedCheckoutMove as startOwnedCheckoutMoveImplementation,
  validateMoveMountTopology
} from "./owned-checkout-move-posix.mjs";

const SCRIPT = fileURLToPath(new URL("./owned-checkout-move-posix.mjs", import.meta.url));
const PIDFD_SUPERVISOR_SCRIPT = fileURLToPath(new URL("./owned-checkout-pidfd-supervisor.py", import.meta.url));
const GIT = realpathSync("/usr/bin/git");
const PYTHON = realpathSync("/usr/bin/python3");

function identityReceipt(metadata, { includeSize = false } = {}) {
  return Object.freeze({
    device: metadata.dev.toString(),
    inode: metadata.ino.toString(),
    ...(includeSize ? { size: metadata.size.toString() } : {})
  });
}

function hostNamespaceAttestation() {
  const namespace = (name) => identityReceipt(statSync(join("/proc/self/ns", name), { bigint: true }));
  return Object.freeze({
    protocol: OWNED_CHECKOUT_HOST_NAMESPACE_PROTOCOL,
    pid: namespace("pid"),
    mount: namespace("mnt"),
    user: namespace("user")
  });
}

function liveProcessReceipt(pid = process.pid) {
  const value = readFileSync(join("/proc", String(pid), "stat"), "utf8");
  const closing = value.lastIndexOf(")");
  const fields =
    closing < 0
      ? []
      : value
          .slice(closing + 2)
          .trim()
          .split(/\s+/u);
  assert.equal(fields.length >= 20, true);
  assert.match(fields[19], /^[1-9][0-9]*$/u);
  return Object.freeze({ pid, starttime: fields[19] });
}

function startOwnedCheckoutMove(options, dependencies = {}) {
  return startOwnedCheckoutMoveImplementation(options, {
    testOnlyCgroupFilesystem: true,
    ...dependencies
  });
}

function git(cwd, ...args) {
  const result = spawnSync(GIT, args, {
    cwd,
    encoding: "utf8",
    env: { HOME: cwd, LANG: "C", LC_ALL: "C", PATH: "/usr/bin:/bin", GIT_CONFIG_NOSYSTEM: "1" }
  });
  assert.equal(result.status, 0, `git ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout.trim();
}

async function withMoveFixture(callback) {
  const root = mkdtempSync(join(tmpdir(), "ow-owned-move-"));
  chmodSync(root, 0o700);
  const seed = join(root, "seed");
  const managerRepositoryPath = join(root, "manager.git");
  const sourcePath = join(root, "source");
  const quarantine = join(root, "quarantine");
  const destinationPath = join(quarantine, "source");
  const safeCwd = join(root, "safe");
  const cgroupMountPath = join(root, "cgroup-v2");
  const cgroupPath = join(cgroupMountPath, "execution");
  mkdirSync(seed, { mode: 0o700 });
  mkdirSync(quarantine, { mode: 0o700 });
  mkdirSync(safeCwd, { mode: 0o700 });
  mkdirSync(cgroupPath, { recursive: true, mode: 0o700 });
  writeFileSync(join(cgroupPath, "cgroup.procs"), `${process.pid}\n0\n`);
  git(seed, "init", "-q", "-b", "main");
  git(seed, "config", "user.name", "Move Test");
  git(seed, "config", "user.email", "move@example.invalid");
  writeFileSync(join(seed, "README.md"), "move fixture\n");
  git(seed, "add", "README.md");
  git(seed, "commit", "-q", "-m", "Create move fixture");
  git(root, "clone", "-q", "--bare", seed, managerRepositoryPath);
  git(root, "--git-dir", managerRepositoryPath, "worktree", "add", "-q", "-b", "agent/source", sourcePath, "main");
  const options = Object.freeze({
    sourcePath,
    destinationPath,
    managerRepositoryPath,
    safeCwd,
    hostNamespaceAttestation: hostNamespaceAttestation(),
    hostExecutionCgroup: {
      protocol: OWNED_CHECKOUT_HOST_CGROUP_PROTOCOL,
      mountPath: cgroupMountPath,
      relativePath: "/execution",
      path: cgroupPath,
      mountId: "1",
      mount: identityReceipt(statSync(cgroupMountPath, { bigint: true })),
      directory: identityReceipt(statSync(cgroupPath, { bigint: true })),
      namespace: identityReceipt(statSync("/proc/self/ns/cgroup", { bigint: true })),
      supervisors: [liveProcessReceipt()]
    }
  });
  try {
    return await callback({ root, seed, quarantine, cgroupPath, options });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function moveFrame(type, token) {
  return `${JSON.stringify({ protocol: OWNED_CHECKOUT_MOVE_PROTOCOL, type, token })}\n`;
}

function spawnRawHelper(
  options,
  token,
  { moveTimeoutMs = 30_000, gitExecutable = GIT, detached = true, requestTransform = (value) => value } = {}
) {
  const descriptors = [
    openSync(SCRIPT, constants.O_RDONLY),
    openSync(realpathSync(process.execPath), constants.O_RDONLY),
    openSync(realpathSync(gitExecutable), constants.O_RDONLY),
    openSync(PYTHON, constants.O_RDONLY),
    openSync(PIDFD_SUPERVISOR_SCRIPT, constants.O_RDONLY)
  ];
  const launchArtifacts = {
    helper: identityReceipt(fstatSync(descriptors[0], { bigint: true }), { includeSize: true }),
    node: identityReceipt(fstatSync(descriptors[1], { bigint: true })),
    git: identityReceipt(fstatSync(descriptors[2], { bigint: true })),
    python: identityReceipt(fstatSync(descriptors[3], { bigint: true })),
    pidfdSupervisor: identityReceipt(fstatSync(descriptors[4], { bigint: true }), { includeSize: true }),
    gitTrust: "test",
    cgroupTrust: "test"
  };
  const requestText = JSON.stringify({
    ...options,
    protocol: OWNED_CHECKOUT_MOVE_PROTOCOL,
    token,
    moveTimeoutMs,
    launchArtifacts
  });
  const encoded = Buffer.from(requestTransform(requestText), "utf8").toString("base64url");
  try {
    return spawn(`/proc/self/fd/4`, [`/proc/self/fd/3`, "--helper", encoded], {
      cwd: options.safeCwd,
      detached,
      env: { HOME: options.safeCwd, LANG: "C", LC_ALL: "C", PATH: "/usr/bin:/bin" },
      stdio: ["pipe", "pipe", "pipe", ...descriptors]
    });
  } finally {
    for (const descriptor of descriptors) closeSync(descriptor);
  }
}

function readLine(stream) {
  return new Promise((resolveLine, rejectLine) => {
    let bytes = Buffer.alloc(0);
    const onData = (chunk) => {
      bytes = Buffer.concat([bytes, chunk]);
      const newline = bytes.indexOf(0x0a);
      if (newline < 0) return;
      cleanup();
      resolveLine(bytes.subarray(0, newline).toString("utf8"));
    };
    const onError = (error) => {
      cleanup();
      rejectLine(error);
    };
    const cleanup = () => {
      stream.off("data", onData);
      stream.off("error", onError);
    };
    stream.on("data", onData);
    stream.on("error", onError);
  });
}

function waitForClose(child) {
  return new Promise((resolveClose, rejectClose) => {
    child.once("error", rejectClose);
    child.once("close", (code, signal) => resolveClose({ code, signal }));
  });
}

function pidfdRequest(cgroupPath, token, { termGraceMs = 50, killGraceMs = 1_000 } = {}) {
  return Buffer.from(
    JSON.stringify({
      protocol: OWNED_CHECKOUT_PIDFD_PROTOCOL,
      token,
      cgroupTrust: "test",
      cgroupRelativePath: "/execution",
      cgroupPath,
      termGraceMs,
      killGraceMs
    }),
    "utf8"
  ).toString("base64url");
}

function pidfdFrame(type, token, extra = {}) {
  return `${JSON.stringify({ protocol: OWNED_CHECKOUT_PIDFD_PROTOCOL, type, token, ...extra })}\n`;
}

function spawnPidfdSupervisor(cgroupPath, token, encoded = pidfdRequest(cgroupPath, token)) {
  return spawn(PYTHON, ["-I", "-S", "-E", "-B", PIDFD_SUPERVISOR_SCRIPT, encoded], {
    env: { HOME: cgroupPath, LANG: "C", LC_ALL: "C", PATH: "/usr/bin:/bin" },
    stdio: ["pipe", "pipe", "pipe"]
  });
}

async function readJsonLine(stream) {
  return JSON.parse(await readLine(stream));
}

async function waitUntilNotRunning(pid, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  do {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if (error?.code === "ESRCH") return;
      throw error;
    }
    await delay(25);
  } while (Date.now() < deadline);
  assert.fail(`process ${pid} remained live`);
}

async function forceStopTestProcess(pid) {
  try {
    process.kill(pid, "SIGKILL");
  } catch (error) {
    assert.equal(error?.code, "ESRCH");
  }
  await waitUntilNotRunning(pid);
}

async function waitForPositivePid(path, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  do {
    if (existsSync(path)) {
      const value = readFileSync(path, "utf8").trim();
      if (/^[1-9][0-9]*$/u.test(value)) {
        const pid = Number(value);
        if (Number.isSafeInteger(pid)) return pid;
      }
    }
    await delay(10);
  } while (Date.now() < deadline);
  assert.fail("the fake Git descendant did not publish one positive PID before its deadline");
}

function writeExecutable(path, source) {
  writeFileSync(path, source, { mode: 0o700 });
  chmodSync(path, 0o700);
  return realpathSync(path);
}

function processStat(pid, { processGroup = pid, session = pid, starttime = "12345", state = "S" } = {}) {
  const fields = [state, "1", String(processGroup), String(session), ...Array(15).fill("0"), starttime];
  return `${pid} (fixture process) ${fields.join(" ")}\n`;
}

function fakeHelperIdentity(pid, starttime = "12345") {
  return Object.freeze({ pid, state: "S", processGroup: pid, session: pid, starttime });
}

function seamChild(pid = 43210) {
  const child = new EventEmitter();
  child.pid = pid;
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  return child;
}

function seamExecutable(_pid, expected) {
  return expected;
}

function observedProcessIdentity(pid, processGroup, starttime) {
  return Object.freeze({ pid, state: "S", processGroup, session: processGroup, starttime });
}

test("the Linux helper reaches READY without moving and one later GO performs the exact registered move", async (t) => {
  if (process.platform !== "linux") return t.skip("The owned move helper is Linux-only.");
  await withMoveFixture(async ({ root, options }) => {
    let helperPid;
    const operation = startOwnedCheckoutMove(options, {
      spawnProcess(command, args, spawnOptions) {
        const child = spawn(command, args, spawnOptions);
        helperPid = child.pid;
        return child;
      }
    });
    const ready = await operation.ready;
    assert.equal(ready.protocol, OWNED_CHECKOUT_MOVE_PROTOCOL);
    assert.equal(existsSync(options.sourcePath), true);
    assert.equal(existsSync(options.destinationPath), false);
    assert.equal(
      git(root, "--git-dir", options.managerRepositoryPath, "worktree", "list", "--porcelain").includes(
        options.sourcePath
      ),
      true
    );

    operation.authorize();
    assert.deepEqual(await operation.completion, { protocol: OWNED_CHECKOUT_MOVE_PROTOCOL, status: "moved" });
    assert.equal(existsSync(options.sourcePath), false);
    assert.equal(existsSync(options.destinationPath), true);
    const registered = git(root, "--git-dir", options.managerRepositoryPath, "worktree", "list", "--porcelain");
    assert.equal(registered.includes(options.sourcePath), false);
    assert.equal(registered.includes(options.destinationPath), true);
    assert.throws(
      () => process.kill(-helperPid, 0),
      (error) => error?.code === "ESRCH",
      "completion must not expose success while the helper group still exists"
    );
  });
});

test("source, destination-parent, and manager aliases fail before READY without moving", async (t) => {
  if (process.platform !== "linux") return t.skip("The owned move helper is Linux-only.");
  for (const pathKind of ["source", "destination-parent", "manager"]) {
    await withMoveFixture(async ({ root, options }) => {
      const alias = join(root, `${pathKind}-alias`);
      const changed = { ...options };
      if (pathKind === "source") {
        symlinkSync(options.sourcePath, alias);
        changed.sourcePath = alias;
      } else if (pathKind === "destination-parent") {
        symlinkSync(dirname(options.destinationPath), alias);
        changed.destinationPath = join(alias, "source");
      } else {
        symlinkSync(options.managerRepositoryPath, alias);
        changed.managerRepositoryPath = alias;
      }
      const operation = startOwnedCheckoutMove(changed);
      const outcomes = await Promise.allSettled([operation.ready, operation.completion]);
      assert.equal(
        outcomes.every((outcome) => outcome.status === "rejected"),
        true
      );
      assert.equal(
        outcomes.every((outcome) => outcome.reason?.code === "unsafe-path"),
        true
      );
      assert.equal(existsSync(options.sourcePath), true);
      assert.equal(existsSync(options.destinationPath), false);
    });
  }
});

test("the launcher requires an explicit trusted host namespace receipt and rejects a mismatch before READY", async (t) => {
  if (process.platform !== "linux") return t.skip("The owned move helper is Linux-only.");
  await withMoveFixture(async ({ options }) => {
    const { hostNamespaceAttestation: _omitted, ...withoutAttestation } = options;
    assert.throws(
      () => startOwnedCheckoutMove(withoutAttestation),
      (error) => error instanceof OwnedCheckoutMoveError && error.code === "invalid-protocol"
    );

    const mismatched = {
      ...options,
      hostNamespaceAttestation: {
        ...options.hostNamespaceAttestation,
        pid: {
          ...options.hostNamespaceAttestation.pid,
          inode: (BigInt(options.hostNamespaceAttestation.pid.inode) + 1n).toString()
        }
      }
    };
    const operation = startOwnedCheckoutMove(mismatched);
    const outcomes = await Promise.allSettled([operation.ready, operation.completion]);
    assert.equal(
      outcomes.every((outcome) => outcome.status === "rejected" && outcome.reason?.code === "namespace-mismatch"),
      true
    );
    assert.equal(existsSync(options.sourcePath), true);
    assert.equal(existsSync(options.destinationPath), false);
  });
});

test("the launcher requires an exclusive host execution cgroup before READY", async (t) => {
  if (process.platform !== "linux") return t.skip("The owned move helper is Linux-only.");
  await withMoveFixture(async ({ cgroupPath, options }) => {
    const { hostExecutionCgroup: _omitted, ...withoutCgroup } = options;
    assert.throws(
      () => startOwnedCheckoutMove(withoutCgroup),
      (error) => error instanceof OwnedCheckoutMoveError && error.code === "invalid-protocol"
    );

    const holder = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000);"], { stdio: "ignore" });
    try {
      writeFileSync(join(cgroupPath, "cgroup.procs"), `${process.pid}\n0\n${holder.pid}\n`);
      assert.throws(
        () => startOwnedCheckoutMove(options),
        (error) => error instanceof OwnedCheckoutMoveError && error.code === "cgroup-not-exclusive"
      );
      assert.equal(existsSync(options.sourcePath), true);
      assert.equal(existsSync(options.destinationPath), false);
    } finally {
      holder.kill("SIGKILL");
      await waitForClose(holder);
    }

    rmSync(cgroupPath, { recursive: true });
    mkdirSync(cgroupPath, { mode: 0o700 });
    writeFileSync(join(cgroupPath, "cgroup.procs"), `${process.pid}\n0\n`);
    assert.throws(
      () => startOwnedCheckoutMove(options),
      (error) => error instanceof OwnedCheckoutMoveError && error.code === "cgroup-uncertain"
    );
  });
});

test("a PID reused outside the cgroup between membership scans never becomes a pidfd target", () => {
  const targetPid = 424242;
  let identityObserved = false;
  let scans = 0;
  let identityReads = 0;
  const request = Object.freeze({
    hostExecutionCgroup: Object.freeze({ supervisors: [] })
  });
  assert.throws(
    () =>
      observeExecutionCgroup(request, "/unused-proc", undefined, {
        scanCgroup() {
          scans += 1;
          return Object.freeze({
            testMode: false,
            tree: "owned-cgroup",
            pids: Object.freeze(identityObserved ? [] : [targetPid])
          });
        },
        readCgroupProcessIdentity(pid) {
          identityReads += 1;
          identityObserved = true;
          return observedProcessIdentity(pid, 999999, "3000");
        }
      }),
    (error) => error instanceof OwnedCheckoutMoveError && error.code === "cgroup-uncertain"
  );
  assert.equal(scans, 2);
  assert.equal(identityReads, 1);
});

test("request options cannot replace the descriptor-bound production Git executable", async (t) => {
  if (process.platform !== "linux") return t.skip("The owned move helper is Linux-only.");
  await withMoveFixture(async ({ options }) => {
    assert.throws(
      () => startOwnedCheckoutMove({ ...options, gitExecutable: GIT }),
      (error) => error instanceof OwnedCheckoutMoveError && error.code === "invalid-protocol"
    );
  });
});

test("every Node protocol boundary shares duplicate-key rejecting JSON parsing", () => {
  for (const text of [
    '{"token":"a","token":"b"}',
    '{"type":"ready","\\u0074ype":"result"}',
    '{"outer":{"code":"one","code":"two"}}'
  ]) {
    assert.throws(() => parseStrictJson(text, 1_024), /Duplicate JSON object key/u);
  }
  assert.deepEqual(parseStrictJson('{"nested":[true,false,null,-1.25e2],"text":"ok"}', 1_024), {
    nested: [true, false, null, -125],
    text: "ok"
  });
});

test("the Git exec shim never receives GO after its retained PID/start time changes during READY", async (t) => {
  if (process.platform !== "linux") return t.skip("The descriptor exec shim is Linux-only.");
  const child = seamChild();
  const pythonReceipt = Object.freeze({ device: "11", inode: "22" });
  const helperIdentity = observedProcessIdentity(process.pid, process.pid, "1000");
  const request = Object.freeze({
    managerRepositoryPath: "/manager.git",
    sourcePath: "/source",
    destinationPath: "/destination",
    safeCwd: "/tmp",
    hostExecutionCgroup: Object.freeze({ relativePath: "/owned-move" }),
    launchArtifacts: Object.freeze({
      gitTrust: "production",
      cgroupTrust: "production",
      python: pythonReceipt
    })
  });
  let identityReads = 0;
  let control = "";
  let execToken;
  child.stdin.on("data", (chunk) => {
    control += chunk.toString("utf8");
  });

  const move = runGitMove(request, helperIdentity, {
    spawnProcess(_command, args) {
      execToken = args[6];
      return child;
    },
    readGitChildIdentity(pid) {
      identityReads += 1;
      if (identityReads === 2) {
        queueMicrotask(() => {
          child.stdout.write(
            `${JSON.stringify({
              protocol: OWNED_CHECKOUT_GIT_EXEC_PROTOCOL,
              type: "ready",
              token: execToken
            })}\n`
          );
        });
      }
      return observedProcessIdentity(pid, helperIdentity.pid, identityReads <= 2 ? "2000" : "3000");
    },
    readGitChildExecutable: () => pythonReceipt,
    readGitChildCgroup: () => request.hostExecutionCgroup.relativePath
  });

  await assert.rejects(
    move,
    (error) => error instanceof OwnedCheckoutMoveError && error.code === "cgroup-ownership-uncertain"
  );
  assert.equal(identityReads, 4, "the changed identity must be observed immediately after READY");
  assert.equal(control, "", "a substituted process must never receive the correlated GO frame");
});

test("the production Git exec shim never receives GO when a foreign cgroup member appears after READY", async (t) => {
  if (process.platform !== "linux") return t.skip("The descriptor exec shim is Linux-only.");
  const child = seamChild();
  const pythonReceipt = Object.freeze({ device: "11", inode: "22" });
  const helperIdentity = observedProcessIdentity(process.pid, process.pid, "1000");
  const childIdentity = observedProcessIdentity(child.pid, helperIdentity.pid, "2000");
  const foreignIdentity = observedProcessIdentity(45454, helperIdentity.pid, "3000");
  const request = Object.freeze({
    managerRepositoryPath: "/manager.git",
    sourcePath: "/source",
    destinationPath: "/destination",
    safeCwd: "/tmp",
    hostExecutionCgroup: Object.freeze({ relativePath: "/owned-move", supervisors: Object.freeze([]) }),
    launchArtifacts: Object.freeze({
      gitTrust: "production",
      cgroupTrust: "production",
      python: pythonReceipt
    })
  });
  let control = "";
  let execToken;
  let membershipScans = 0;
  child.stdin.on("data", (chunk) => {
    control += chunk.toString("utf8");
  });

  const move = runGitMove(request, helperIdentity, {
    spawnProcess(_command, args) {
      execToken = args[6];
      queueMicrotask(() => {
        child.stdout.write(
          `${JSON.stringify({
            protocol: OWNED_CHECKOUT_GIT_EXEC_PROTOCOL,
            type: "ready",
            token: execToken
          })}\n`
        );
      });
      return child;
    },
    readGitChildIdentity: () => childIdentity,
    readGitChildExecutable: () => pythonReceipt,
    readGitChildCgroup: () => request.hostExecutionCgroup.relativePath,
    scanGitExecutionCgroup() {
      membershipScans += 1;
      return Object.freeze({
        testMode: false,
        tree: "owned-cgroup",
        pids: Object.freeze(
          membershipScans <= 2
            ? [helperIdentity.pid, childIdentity.pid]
            : [helperIdentity.pid, childIdentity.pid, foreignIdentity.pid]
        )
      });
    },
    readGitExecutionCgroupProcessIdentity(pid) {
      return new Map([
        [helperIdentity.pid, helperIdentity],
        [childIdentity.pid, childIdentity],
        [foreignIdentity.pid, foreignIdentity]
      ]).get(pid);
    }
  });

  await assert.rejects(
    move,
    (error) => error instanceof OwnedCheckoutMoveError && error.code === "cgroup-ownership-uncertain"
  );
  assert.equal(membershipScans, 4, "the cgroup must be scanned after READY and again immediately before GO");
  assert.equal(control, "", "a foreign cgroup member must prevent the correlated GO frame");
});

test("the descriptor-bound helper rejects duplicate encoded-request keys before READY", async (t) => {
  if (process.platform !== "linux") return t.skip("The owned move helper is Linux-only.");
  await withMoveFixture(async ({ options }) => {
    const token = "8".repeat(32);
    const child = spawnRawHelper(options, token, {
      requestTransform: (value) => value.replace(`"token":"${token}"`, `"token":"${token}","token":"${token}"`)
    });
    const response = JSON.parse(await readLine(child.stdout));
    assert.equal(response.type, "error");
    assert.equal(response.code, "invalid-request");
    assert.notEqual((await waitForClose(child)).code, 0);
    assert.equal(existsSync(options.sourcePath), true);
    assert.equal(existsSync(options.destinationPath), false);
  });
});

test("the authorization API rejects GO before READY and a second GO", async (t) => {
  if (process.platform !== "linux") return t.skip("The owned move helper is Linux-only.");
  await withMoveFixture(async ({ options }) => {
    const operation = startOwnedCheckoutMove(options);
    assert.throws(
      () => operation.authorize(),
      (error) => error instanceof OwnedCheckoutMoveError && error.code === "not-ready"
    );
    await operation.ready;
    operation.authorize();
    assert.throws(
      () => operation.authorize(),
      (error) => error instanceof OwnedCheckoutMoveError && error.code === "already-authorized"
    );
    await operation.completion;
  });
});

test("RESULT leaves the same session-leading helper alive until the matching ACK", async (t) => {
  if (process.platform !== "linux") return t.skip("The owned move helper is Linux-only.");
  await withMoveFixture(async ({ options }) => {
    const token = "5".repeat(32);
    const child = spawnRawHelper(options, token);
    assert.equal(JSON.parse(await readLine(child.stdout)).type, "ready");
    const resultLine = readLine(child.stdout);
    child.stdin.write(moveFrame("go", token));
    const result = JSON.parse(await resultLine);
    assert.deepEqual(result, {
      protocol: OWNED_CHECKOUT_MOVE_PROTOCOL,
      type: "result",
      token,
      ok: true,
      code: "moved"
    });
    assert.equal(process.kill(child.pid, 0), true);
    await delay(25);
    assert.equal(process.kill(child.pid, 0), true);
    child.stdin.end(moveFrame("ack", token));
    assert.deepEqual(await waitForClose(child), { code: 0, signal: null });
  });
});

test("a duplicate-key ACK cannot complete a helper protocol", async (t) => {
  if (process.platform !== "linux") return t.skip("The owned move helper is Linux-only.");
  await withMoveFixture(async ({ options }) => {
    const token = "9".repeat(32);
    const child = spawnRawHelper(options, token);
    const closed = waitForClose(child);
    assert.equal((await readJsonLine(child.stdout)).type, "ready");
    child.stdin.write(moveFrame("go", token));
    assert.equal((await readJsonLine(child.stdout)).type, "result");
    child.stdin.end(`{"protocol":"${OWNED_CHECKOUT_MOVE_PROTOCOL}","type":"ack","type":"ack","token":"${token}"}\n`);
    assert.notEqual((await closed).code, 0);
    assert.equal(existsSync(options.sourcePath), false);
    assert.equal(existsSync(options.destinationPath), true);
  });
});

test("the helper rejects malformed, repeated, and duplicate-key GO bytes before Git can mutate", async (t) => {
  if (process.platform !== "linux") return t.skip("The owned move helper is Linux-only.");
  for (const control of [
    "{}\n",
    undefined,
    `{"protocol":"${OWNED_CHECKOUT_MOVE_PROTOCOL}","type":"go","type":"go","token":"${"1".repeat(32)}"}\n`
  ]) {
    await withMoveFixture(async ({ options }) => {
      const token = "1".repeat(32);
      const child = spawnRawHelper(options, token);
      const ready = JSON.parse(await readLine(child.stdout));
      assert.deepEqual(ready, { protocol: OWNED_CHECKOUT_MOVE_PROTOCOL, type: "ready", token });
      child.stdin.end(control ?? `${moveFrame("go", token)}${moveFrame("go", token)}`);
      const closed = await waitForClose(child);
      assert.notEqual(closed.code, 0);
      await waitUntilNotRunning(child.pid);
      assert.equal(existsSync(options.sourcePath), true);
      assert.equal(existsSync(options.destinationPath), false);
    });
  }
});

test("the helper rejects launch outside a private session as well as a private process group", async (t) => {
  if (process.platform !== "linux") return t.skip("The owned move helper is Linux-only.");
  await withMoveFixture(async ({ options }) => {
    const token = "3".repeat(32);
    const child = spawnRawHelper(options, token, { detached: false });
    const response = JSON.parse(await readLine(child.stdout));
    assert.equal(response.type, "error");
    assert.equal(response.code, "process-group-uncertain");
    const closed = await waitForClose(child);
    assert.notEqual(closed.code, 0);
    assert.equal(existsSync(options.sourcePath), true);
    assert.equal(existsSync(options.destinationPath), false);
  });
});

test("a timed-out exact Git child and its descendant leave the owned process group", async (t) => {
  if (process.platform !== "linux") return t.skip("The owned move helper is Linux-only.");
  await withMoveFixture(async ({ root, options }) => {
    const descendantPath = join(root, "descendant.pid");
    const fakeGit = writeExecutable(
      join(root, "hanging-git"),
      `#!/bin/sh\nsleep 60 &\necho $! > '${descendantPath}'\nwait\n`
    );
    const operation = startOwnedCheckoutMove(options, {
      testOnlyGitExecutable: fakeGit,
      moveTimeoutMs: 250,
      groupGraceMs: 2_000
    });
    await operation.ready;
    operation.authorize();
    await assert.rejects(
      operation.completion,
      (error) => error instanceof OwnedCheckoutMoveError && error.code === "move-timeout"
    );
    const descendant = Number(readFileSync(descendantPath, "utf8").trim());
    assert.equal(Number.isSafeInteger(descendant) && descendant > 0, true);
    await waitUntilNotRunning(descendant);
    assert.equal(existsSync(options.sourcePath), true);
    assert.equal(existsSync(options.destinationPath), false);
  });
});

test("the helper's own deadline contains descendants even if its parent sends no cleanup signal", async (t) => {
  if (process.platform !== "linux") return t.skip("The owned move helper is Linux-only.");
  await withMoveFixture(async ({ root, options }) => {
    const descendantPath = join(root, "helper-descendant.pid");
    const fakeGit = writeExecutable(
      join(root, "helper-hanging-git"),
      `#!/bin/sh\nsleep 60 &\necho $! > '${descendantPath}'\nwait\n`
    );
    const token = "2".repeat(32);
    const child = spawnRawHelper(options, token, { moveTimeoutMs: 1_000, gitExecutable: fakeGit });
    assert.deepEqual(JSON.parse(await readLine(child.stdout)), {
      protocol: OWNED_CHECKOUT_MOVE_PROTOCOL,
      type: "ready",
      token
    });
    child.stdin.write(moveFrame("go", token));
    const descendant = await waitForPositivePid(descendantPath);
    const closed = await waitForClose(child);
    assert.notEqual(closed.code, 0);
    await waitUntilNotRunning(child.pid);
    await waitUntilNotRunning(descendant);
    assert.equal(existsSync(options.sourcePath), true);
    assert.equal(existsSync(options.destinationPath), false);
  });
});

test("Git failure is path-free and the helper invokes only the exact unforced worktree-move arguments", async (t) => {
  if (process.platform !== "linux") return t.skip("The owned move helper is Linux-only.");
  await withMoveFixture(async ({ root, options }) => {
    const argumentsPath = join(root, "arguments.txt");
    const fakeGit = writeExecutable(
      join(root, "failing-git"),
      `#!/bin/sh\nprintf '%s\\n' "$@" > '${argumentsPath}'\nexit 23\n`
    );
    const operation = startOwnedCheckoutMove(options, { testOnlyGitExecutable: fakeGit });
    await operation.ready;
    operation.authorize();
    await assert.rejects(
      operation.completion,
      (error) => error instanceof OwnedCheckoutMoveError && error.code === "git-failed"
    );
    assert.deepEqual(readFileSync(argumentsPath, "utf8").trim().split("\n"), [
      "--git-dir",
      options.managerRepositoryPath,
      "-c",
      "worktree.useRelativePaths=false",
      "worktree",
      "move",
      options.sourcePath,
      options.destinationPath
    ]);
    assert.equal(existsSync(options.sourcePath), true);
    assert.equal(existsSync(options.destinationPath), false);
  });
});

test("a nonzero Git exit after moving only the checkout directory is move-indeterminate", async (t) => {
  if (process.platform !== "linux") return t.skip("The owned move helper is Linux-only.");
  await withMoveFixture(async ({ root, options }) => {
    const fakeGit = writeExecutable(join(root, "failed-directory-only-git"), '#!/bin/sh\nmv -- "$7" "$8"\nexit 23\n');
    const operation = startOwnedCheckoutMove(options, { testOnlyGitExecutable: fakeGit });
    await operation.ready;
    operation.authorize();
    await assert.rejects(
      operation.completion,
      (error) => error instanceof OwnedCheckoutMoveError && error.code === "move-indeterminate"
    );
    assert.equal(existsSync(options.sourcePath), false);
    assert.equal(existsSync(options.destinationPath), true);
  });
});

test("a nonzero partial move stays move-indeterminate when late cgroup drain also fails", async (t) => {
  if (process.platform !== "linux") return t.skip("The owned move helper is Linux-only.");
  await withMoveFixture(async ({ cgroupPath, root, options }) => {
    const membershipPath = join(cgroupPath, "cgroup.procs");
    const hiddenMembershipPath = join(cgroupPath, "cgroup.procs.hidden");
    const fakeGit = writeExecutable(
      join(root, "failed-partial-and-drain-git"),
      [
        "#!/bin/sh",
        'mv -- "$7" "$8"',
        `mv -- '${membershipPath}' '${hiddenMembershipPath}'`,
        `(/usr/bin/sleep 0.5; mv -- '${hiddenMembershipPath}' '${membershipPath}') &`,
        "exit 23",
        ""
      ].join("\n")
    );
    const operation = startOwnedCheckoutMove(options, { testOnlyGitExecutable: fakeGit });
    await operation.ready;
    operation.authorize();
    await assert.rejects(
      operation.completion,
      (error) => error instanceof OwnedCheckoutMoveError && error.code === "move-indeterminate"
    );
    assert.equal(existsSync(options.sourcePath), false);
    assert.equal(existsSync(options.destinationPath), true);
  });
});

test("a nonzero Git exit after changing only worktree metadata is move-indeterminate", async (t) => {
  if (process.platform !== "linux") return t.skip("The owned move helper is Linux-only.");
  await withMoveFixture(async ({ root, options }) => {
    const dotGit = readFileSync(join(options.sourcePath, ".git"), "utf8").trim();
    const match = /^gitdir: (.+)$/u.exec(dotGit);
    assert.notEqual(match, null);
    const backlinkPath = join(realpathSync(match[1]), "gitdir");
    const fakeGit = writeExecutable(
      join(root, "failed-metadata-only-git"),
      `#!/bin/sh\nprintf '%s\\n' "$8/.git" > '${backlinkPath}'\nexit 23\n`
    );
    const operation = startOwnedCheckoutMove(options, { testOnlyGitExecutable: fakeGit });
    await operation.ready;
    operation.authorize();
    await assert.rejects(
      operation.completion,
      (error) => error instanceof OwnedCheckoutMoveError && error.code === "move-indeterminate"
    );
    assert.equal(existsSync(options.sourcePath), true);
    assert.equal(existsSync(options.destinationPath), false);
    assert.equal(readFileSync(backlinkPath, "utf8").trim(), `${options.destinationPath}/.git`);
  });
});

test("a no-op executable returning success is reported as move-indeterminate without rollback", async (t) => {
  if (process.platform !== "linux") return t.skip("The owned move helper is Linux-only.");
  await withMoveFixture(async ({ root, options }) => {
    const fakeGit = writeExecutable(join(root, "no-op-git"), "#!/bin/sh\nexit 0\n");
    const operation = startOwnedCheckoutMove(options, { testOnlyGitExecutable: fakeGit });
    await operation.ready;
    operation.authorize();
    await assert.rejects(
      operation.completion,
      (error) => error instanceof OwnedCheckoutMoveError && error.code === "move-indeterminate"
    );
    assert.equal(existsSync(options.sourcePath), true);
    assert.equal(existsSync(options.destinationPath), false);
  });
});

test("a partial filesystem move returning success is reported as move-indeterminate and is not rolled back", async (t) => {
  if (process.platform !== "linux") return t.skip("The owned move helper is Linux-only.");
  await withMoveFixture(async ({ root, options }) => {
    const fakeGit = writeExecutable(join(root, "partial-git"), '#!/bin/sh\nmv -- "$7" "$8"\nexit 0\n');
    const operation = startOwnedCheckoutMove(options, { testOnlyGitExecutable: fakeGit });
    await operation.ready;
    operation.authorize();
    await assert.rejects(
      operation.completion,
      (error) => error instanceof OwnedCheckoutMoveError && error.code === "move-indeterminate"
    );
    assert.equal(existsSync(options.sourcePath), false);
    assert.equal(existsSync(options.destinationPath), true);
  });
});

test("a successful real Git move cannot hide an escaped setsid process using the moved checkout", async (t) => {
  if (process.platform !== "linux") return t.skip("The owned move helper is Linux-only.");
  await withMoveFixture(async ({ cgroupPath, root, options }) => {
    const escapedCwdPath = join(root, "escaped.cwd");
    const escapedPidPath = join(root, "escaped.pid");
    const escapedDescriptorsPath = join(root, "escaped.fds");
    let escapedPid;
    let escapedStopped = false;
    const fakeGit = writeExecutable(
      join(root, "escaping-git"),
      [
        "#!/bin/sh",
        `${GIT} "$@" || exit $?`,
        "exec 5<&- 6<&- 7<&-",
        `/usr/bin/setsid /bin/sh -c ': > "$2"; for fd in 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20 21 22 23 24 25 26 27 28 29 30 31 32; do [ -e "/proc/$$/fd/$fd" ] && printf "%s\\n" "$fd" >> "$2"; done; cd "$1" || exit 91; exec /usr/bin/sleep 60' sh "$8" '${escapedDescriptorsPath}' </dev/null >/dev/null 2>&1 &`,
        "escaped=$!",
        `printf '%s\\n' "$escaped" > '${escapedPidPath}'`,
        "attempt=0",
        "cwd=",
        'while [ "$attempt" -lt 100 ]; do',
        '  cwd=$(/usr/bin/readlink "/proc/$escaped/cwd") || exit 92',
        '  [ "$cwd" = "$8" ] && break',
        "  attempt=$((attempt + 1))",
        "  /usr/bin/sleep 0.01",
        "done",
        '[ "$cwd" = "$8" ] || exit 93',
        `printf '%s\\n' "$cwd" > '${escapedCwdPath}'`,
        `printf '%s\\n' "$escaped" >> '${join(cgroupPath, "cgroup.procs")}'`,
        "exit 0",
        ""
      ].join("\n")
    );
    try {
      const operation = startOwnedCheckoutMove(options, { testOnlyGitExecutable: fakeGit });
      await operation.ready;
      operation.authorize();
      await assert.rejects(
        operation.completion,
        (error) => error instanceof OwnedCheckoutMoveError && error.code === "cgroup-escape"
      );
      escapedPid = Number(readFileSync(escapedPidPath, "utf8").trim());
      assert.equal(Number.isSafeInteger(escapedPid) && escapedPid > 0, true);
      assert.equal(readFileSync(escapedCwdPath, "utf8").trim(), options.destinationPath);
      const inheritedDescriptors = readFileSync(escapedDescriptorsPath, "utf8").trim().split("\n").filter(Boolean);
      assert.deepEqual(
        inheritedDescriptors.filter((entry) => !["3", "4"].includes(entry)),
        []
      );
      await waitUntilNotRunning(escapedPid);
      escapedStopped = true;
      assert.equal(existsSync(options.sourcePath), false);
      assert.equal(existsSync(options.destinationPath), true);
    } finally {
      if (escapedPid === undefined && existsSync(escapedPidPath)) {
        escapedPid = Number(readFileSync(escapedPidPath, "utf8").trim());
      }
      if (!escapedStopped && Number.isSafeInteger(escapedPid) && escapedPid > 0) {
        await forceStopTestProcess(escapedPid);
        escapedStopped = true;
      }
    }
  });
});

test("the pidfd supervisor never signals a stale process identity", async (t) => {
  if (process.platform !== "linux") return t.skip("pidfds are Linux-only.");
  const root = mkdtempSync(join(tmpdir(), "ow-pidfd-stale-"));
  chmodSync(root, 0o700);
  const cgroupPath = join(root, "execution");
  mkdirSync(cgroupPath, { mode: 0o700 });
  const target = spawn("/usr/bin/sleep", ["60"], { stdio: "ignore" });
  const targetClosed = waitForClose(target);
  let targetStopped = false;
  try {
    writeFileSync(join(cgroupPath, "cgroup.procs"), `${target.pid}\n`);
    const token = "a".repeat(32);
    const supervisor = spawnPidfdSupervisor(cgroupPath, token);
    const supervisorClosed = waitForClose(supervisor);
    assert.deepEqual(await readJsonLine(supervisor.stdout), {
      protocol: OWNED_CHECKOUT_PIDFD_PROTOCOL,
      type: "ready",
      token
    });
    const actual = liveProcessReceipt(target.pid);
    supervisor.stdin.write(
      pidfdFrame("run", token, {
        targets: [{ pid: target.pid, starttime: (BigInt(actual.starttime) + 1n).toString() }]
      })
    );
    const result = await readJsonLine(supervisor.stdout);
    assert.equal(result.ok, false);
    assert.equal(result.code, "identity-mismatch");
    supervisor.stdin.end(pidfdFrame("ack", token));
    assert.deepEqual(await supervisorClosed, { code: 1, signal: null });
    assert.equal(target.kill(0), true);
  } finally {
    if (!targetStopped) {
      target.kill("SIGKILL");
      await targetClosed;
      targetStopped = true;
    }
    rmSync(root, { recursive: true, force: true });
  }
});

test("a live target leaving its attested cgroup is killed but reported as ownership-uncertain", async (t) => {
  if (process.platform !== "linux") return t.skip("pidfds are Linux-only.");
  const root = mkdtempSync(join(tmpdir(), "ow-pidfd-departure-"));
  chmodSync(root, 0o700);
  const cgroupPath = join(root, "execution");
  mkdirSync(cgroupPath, { mode: 0o700 });
  const target = spawn("/usr/bin/sleep", ["60"], { stdio: "ignore" });
  const targetClosed = waitForClose(target);
  try {
    writeFileSync(join(cgroupPath, "cgroup.procs"), `${target.pid}\n`);
    const token = "b".repeat(32);
    const supervisor = spawnPidfdSupervisor(cgroupPath, token);
    const supervisorClosed = waitForClose(supervisor);
    await readJsonLine(supervisor.stdout);
    const identity = liveProcessReceipt(target.pid);
    supervisor.stdin.write(pidfdFrame("run", token, { targets: [identity] }));
    const armed = await readJsonLine(supervisor.stdout);
    assert.deepEqual(armed.live, [identity]);
    writeFileSync(join(cgroupPath, "cgroup.procs"), "");
    supervisor.stdin.write(pidfdFrame("go", token));
    const result = await readJsonLine(supervisor.stdout);
    assert.equal(result.ok, false);
    assert.equal(result.code, "cgroup-departed");
    supervisor.stdin.end(pidfdFrame("ack", token));
    assert.deepEqual(await supervisorClosed, { code: 1, signal: null });
    assert.deepEqual(await targetClosed, { code: null, signal: "SIGKILL" });
  } finally {
    if (target.exitCode === null && target.signalCode === null) {
      target.kill("SIGKILL");
      await targetClosed;
    }
    rmSync(root, { recursive: true, force: true });
  }
});

test("a SIGKILL-resistant pidfd target cannot reach RESULT or ACK completion", async (t) => {
  if (process.platform !== "linux") return t.skip("pidfds are Linux-only.");
  const root = mkdtempSync(join(tmpdir(), "ow-pidfd-timeout-"));
  chmodSync(root, 0o700);
  const cgroupPath = join(root, "execution");
  mkdirSync(cgroupPath, { mode: 0o700 });
  writeFileSync(join(cgroupPath, "cgroup.procs"), "424242\n");
  const token = "7".repeat(32);
  const encoded = pidfdRequest(cgroupPath, token, { termGraceMs: 20, killGraceMs: 20 });
  const seam = [
    "import importlib.util, os, sys",
    "source, encoded = sys.argv[1], sys.argv[2]",
    'spec = importlib.util.spec_from_file_location("ow_pidfd_timeout_seam", source)',
    "module = importlib.util.module_from_spec(spec)",
    "spec.loader.exec_module(module)",
    "writers = []",
    "def fake_pidfd_open(_pid, _flags):",
    "    reader, writer = os.pipe()",
    "    writers.append(writer)",
    "    return reader",
    "module.os.pidfd_open = fake_pidfd_open",
    "module.signal.pidfd_send_signal = lambda *_args: None",
    'module.process_starttime = lambda _pid, _pidfd: "12345"',
    "module.test_cgroup_member = lambda _path, _pid, _pidfd: True",
    "module.remove_test_cgroup_members = lambda _path, _removed: None",
    "sys.argv = [source, encoded]",
    "module.main()"
  ].join("\n");
  const supervisor = spawn(PYTHON, ["-I", "-S", "-E", "-B", "-c", seam, PIDFD_SUPERVISOR_SCRIPT, encoded], {
    env: { HOME: root, LANG: "C", LC_ALL: "C", PATH: "/usr/bin:/bin" },
    stdio: ["pipe", "pipe", "pipe"]
  });
  const supervisorClosed = waitForClose(supervisor);
  try {
    assert.deepEqual(await readJsonLine(supervisor.stdout), {
      protocol: OWNED_CHECKOUT_PIDFD_PROTOCOL,
      type: "ready",
      token
    });
    const identity = { pid: 424242, starttime: "12345" };
    supervisor.stdin.write(pidfdFrame("run", token, { targets: [identity] }));
    const armed = await readJsonLine(supervisor.stdout);
    assert.deepEqual(armed.live, [identity]);

    let outputAfterGo = "";
    supervisor.stdout.on("data", (chunk) => {
      outputAfterGo += chunk.toString("utf8");
    });
    supervisor.stdin.write(pidfdFrame("go", token));
    await delay(250);
    assert.equal(outputAfterGo, "", "the kill deadline must not publish a normal RESULT frame");
    supervisor.stdin.write(pidfdFrame("ack", token));
    await delay(50);
    assert.equal(supervisor.kill(0), true, "an unsolicited ACK must not release retained live pidfds");
    assert.equal(outputAfterGo, "");
  } finally {
    if (supervisor.exitCode === null && supervisor.signalCode === null) supervisor.kill("SIGKILL");
    assert.deepEqual(await supervisorClosed, { code: null, signal: "SIGKILL" });
    rmSync(root, { recursive: true, force: true });
  }
});

test("the pidfd supervisor rejects duplicate request and control keys", async (t) => {
  if (process.platform !== "linux") return t.skip("pidfds are Linux-only.");
  const root = mkdtempSync(join(tmpdir(), "ow-pidfd-json-"));
  chmodSync(root, 0o700);
  const cgroupPath = join(root, "execution");
  mkdirSync(cgroupPath, { mode: 0o700 });
  writeFileSync(join(cgroupPath, "cgroup.procs"), "");
  try {
    const duplicateRequest = Buffer.from(
      `{"protocol":"${OWNED_CHECKOUT_PIDFD_PROTOCOL}","token":"${"c".repeat(32)}","token":"${"d".repeat(32)}","cgroupTrust":"test","cgroupRelativePath":"/execution","cgroupPath":${JSON.stringify(cgroupPath)},"termGraceMs":50,"killGraceMs":1000}`,
      "utf8"
    ).toString("base64url");
    const malformed = spawnPidfdSupervisor(cgroupPath, "c".repeat(32), duplicateRequest);
    const malformedClosed = waitForClose(malformed);
    const rejectedRequest = await readJsonLine(malformed.stdout);
    assert.equal(rejectedRequest.type, "error");
    assert.equal(rejectedRequest.code, "invalid-request");
    assert.deepEqual(await malformedClosed, { code: 1, signal: null });

    const token = "e".repeat(32);
    const supervisor = spawnPidfdSupervisor(cgroupPath, token);
    const supervisorClosed = waitForClose(supervisor);
    await readJsonLine(supervisor.stdout);
    supervisor.stdin.write(
      `{"protocol":"${OWNED_CHECKOUT_PIDFD_PROTOCOL}","type":"run","type":"run","token":"${token}","targets":[]}\n`
    );
    const rejectedControl = await readJsonLine(supervisor.stdout);
    assert.equal(rejectedControl.ok, false);
    assert.equal(rejectedControl.code, "invalid-control");
    supervisor.stdin.end(pidfdFrame("ack", token));
    assert.deepEqual(await supervisorClosed, { code: 1, signal: null });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the descriptor-bound Git exec shim closes every launch artifact before exec", async (t) => {
  if (process.platform !== "linux") return t.skip("The descriptor exec shim is Linux-only.");
  const sleepExecutable = realpathSync("/usr/bin/sleep");
  const descriptors = [
    openSync(sleepExecutable, constants.O_RDONLY),
    openSync(PYTHON, constants.O_RDONLY),
    openSync(PIDFD_SUPERVISOR_SCRIPT, constants.O_RDONLY)
  ];
  const token = "f".repeat(32);
  let child;
  try {
    child = spawn("/proc/self/fd/6", ["-I", "-S", "-E", "-B", "/proc/self/fd/7", "--exec-git", token, "sleep", "60"], {
      env: { HOME: tmpdir(), LANG: "C", LC_ALL: "C", PATH: "/usr/bin:/bin" },
      stdio: ["pipe", "pipe", "pipe", "ignore", "ignore", ...descriptors]
    });
  } finally {
    for (const descriptor of descriptors) closeSync(descriptor);
  }
  const closed = waitForClose(child);
  try {
    assert.deepEqual(await readJsonLine(child.stdout), {
      protocol: OWNED_CHECKOUT_GIT_EXEC_PROTOCOL,
      type: "ready",
      token
    });
    assert.equal(realpathSync(`/proc/${child.pid}/exe`), PYTHON);
    child.stdin.end(`${JSON.stringify({ protocol: OWNED_CHECKOUT_GIT_EXEC_PROTOCOL, type: "go", token })}\n`);
    const deadline = Date.now() + 2_000;
    while (realpathSync(`/proc/${child.pid}/exe`) !== sleepExecutable && Date.now() < deadline) await delay(5);
    assert.equal(realpathSync(`/proc/${child.pid}/exe`), sleepExecutable);
    const descriptorsAfterExec = new Set(readdirSync(`/proc/${child.pid}/fd`));
    assert.equal(descriptorsAfterExec.has("5"), false);
    assert.equal(descriptorsAfterExec.has("6"), false);
    assert.equal(descriptorsAfterExec.has("7"), false);
    assert.equal(readlinkSync(`/proc/${child.pid}/fd/0`), "/dev/null");
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await closed;
  }
});

test("a successful move rejects replacement of the pinned worktree backlink inode", async (t) => {
  if (process.platform !== "linux") return t.skip("The owned move helper is Linux-only.");
  await withMoveFixture(async ({ root, options }) => {
    const dotGit = readFileSync(join(options.sourcePath, ".git"), "utf8").trim();
    const match = /^gitdir: (.+)$/u.exec(dotGit);
    assert.notEqual(match, null);
    const adminPath = realpathSync(match[1]);
    const backlinkPath = join(adminPath, "gitdir");
    const replacementPath = join(adminPath, "gitdir.replacement");
    const fakeGit = writeExecutable(
      join(root, "replacing-backlink-git"),
      [
        "#!/bin/sh",
        `${GIT} "$@" || exit $?`,
        `cat '${backlinkPath}' > '${replacementPath}' || exit $?`,
        `mv -f -- '${replacementPath}' '${backlinkPath}' || exit $?`,
        "exit 0",
        ""
      ].join("\n")
    );
    const operation = startOwnedCheckoutMove(options, { testOnlyGitExecutable: fakeGit });
    await operation.ready;
    operation.authorize();
    await assert.rejects(
      operation.completion,
      (error) => error instanceof OwnedCheckoutMoveError && error.code === "move-indeterminate"
    );
    assert.equal(existsSync(options.sourcePath), false);
    assert.equal(existsSync(options.destinationPath), true);
  });
});

test("the parent never acknowledges success after the pinned helper identity changes", async (t) => {
  if (process.platform !== "linux") return t.skip("The owned move helper is Linux-only.");
  await withMoveFixture(async ({ options }) => {
    let calls = 0;
    const readHelperIdentity = (pid) => {
      calls += 1;
      return fakeHelperIdentity(pid, calls <= 2 ? "12345" : "54321");
    };
    const operation = startOwnedCheckoutMove(options, { readHelperIdentity, groupGraceMs: 100 });
    await operation.ready;
    operation.authorize();
    await assert.rejects(
      operation.completion,
      (error) => error instanceof OwnedCheckoutMoveError && error.code === OWNED_CHECKOUT_MOVE_OWNERSHIP_UNCERTAIN
    );
  });
});

test("mount topology requires one mount and rejects nested mounts", () => {
  const entries = parseLinuxMountInfo(
    ["1 0 8:1 / / rw - ext4 /dev/root rw", "2 1 8:2 / /managed/source/nested rw - ext4 /dev/other rw"].join("\n")
  );
  assert.throws(
    () =>
      validateMoveMountTopology({
        entries,
        paths: [
          { path: "/managed/source", device: "1", mountDevice: "8:1" },
          { path: "/managed/quarantine", device: "1", mountDevice: "8:1" }
        ],
        protectedRoots: ["/managed/source", "/managed/quarantine"]
      }),
    (error) => error instanceof OwnedCheckoutMoveError && error.code === "nested-mount"
  );
  assert.throws(
    () =>
      validateMoveMountTopology({
        entries: parseLinuxMountInfo(
          ["1 0 8:1 / /left rw - ext4 /dev/left rw", "2 0 8:2 / /right rw - ext4 /dev/right rw"].join("\n")
        ),
        paths: [
          { path: "/left/source", device: "1", mountDevice: "8:1" },
          { path: "/right/quarantine", device: "2", mountDevice: "8:2" }
        ],
        protectedRoots: ["/left/source", "/right/quarantine"]
      }),
    (error) => error instanceof OwnedCheckoutMoveError && error.code === "cross-mount"
  );
});

test("the bounded same-UID process scan rejects a checkout used as another process cwd", () => {
  const root = mkdtempSync(join(tmpdir(), "ow-process-use-"));
  chmodSync(root, 0o700);
  const checkout = join(root, "checkout");
  const procRoot = join(root, "proc");
  const processRoot = join(procRoot, "123");
  mkdirSync(checkout, { mode: 0o700 });
  mkdirSync(join(processRoot, "fd"), { recursive: true, mode: 0o700 });
  writeFileSync(
    join(processRoot, "status"),
    `Name:\tfixture\nUid:\t${process.getuid()}\t${process.getuid()}\t${process.getuid()}\t${process.getuid()}\n`
  );
  writeFileSync(join(processRoot, "stat"), processStat(123));
  writeFileSync(join(processRoot, "maps"), "");
  symlinkSync(checkout, join(processRoot, "cwd"));
  symlinkSync("/", join(processRoot, "root"));
  symlinkSync("/bin/sh", join(processRoot, "exe"));
  try {
    assert.throws(
      () => scanSameUidProcessUse({ procRoot, protectedRoots: [checkout], currentPid: 999_999, uid: process.getuid() }),
      (error) => error instanceof OwnedCheckoutMoveError && error.code === "checkout-in-use"
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a current-user process in the manager repository blocks the move before READY", async (t) => {
  if (process.platform !== "linux") return t.skip("The owned move helper is Linux-only.");
  await withMoveFixture(async ({ options }) => {
    const holder = spawn(process.execPath, ["-e", 'process.stdout.write("ready\\n"); setInterval(() => {}, 1000);'], {
      cwd: options.managerRepositoryPath,
      stdio: ["ignore", "pipe", "ignore"]
    });
    try {
      assert.equal(await readLine(holder.stdout), "ready");
      const operation = startOwnedCheckoutMove(options);
      const outcomes = await Promise.allSettled([operation.ready, operation.completion]);
      assert.equal(
        outcomes.every((outcome) => outcome.status === "rejected" && outcome.reason?.code === "checkout-in-use"),
        true
      );
      assert.equal(existsSync(options.sourcePath), true);
      assert.equal(existsSync(options.destinationPath), false);
    } finally {
      holder.kill("SIGTERM");
      await waitForClose(holder);
    }
  });
});

test("READY timeout escalates TERM to KILL and settles even when a seam child never closes", async (t) => {
  if (process.platform !== "linux") return t.skip("The owned move helper is Linux-only.");
  await withMoveFixture(async ({ options }) => {
    const child = seamChild();
    const signals = [];
    const operation = startOwnedCheckoutMove(options, {
      spawnProcess: () => child,
      readHelperIdentity: (pid) => fakeHelperIdentity(pid),
      readHelperExecutable: seamExecutable,
      signalProcess: (pid, signal) => signals.push({ pid, signal }),
      readyTimeoutMs: 20,
      groupGraceMs: 20
    });
    const outcomes = await Promise.allSettled([operation.ready, operation.completion]);
    assert.equal(outcomes[0].status, "rejected");
    assert.equal(outcomes[0].reason.code, "ready-timeout");
    assert.equal(outcomes[1].status, "rejected");
    assert.equal(outcomes[1].reason.code, OWNED_CHECKOUT_MOVE_OWNERSHIP_UNCERTAIN);
    assert.deepEqual(signals, [
      { pid: -child.pid, signal: "SIGTERM" },
      { pid: -child.pid, signal: "SIGKILL" }
    ]);
  });
});

for (const phase of ["authorization", "move", "abort"]) {
  test(`${phase} cleanup has a bounded TERM-to-KILL path independent of child close`, async (t) => {
    if (process.platform !== "linux") return t.skip("The owned move helper is Linux-only.");
    await withMoveFixture(async ({ options }) => {
      const child = seamChild();
      const signals = [];
      const token = "4".repeat(32);
      const operation = startOwnedCheckoutMove(options, {
        spawnProcess: () => child,
        readHelperIdentity: (pid) => fakeHelperIdentity(pid),
        readHelperExecutable: seamExecutable,
        signalProcess: (pid, signal) => signals.push({ pid, signal }),
        tokenFactory: () => token,
        moveTimeoutMs: 20,
        groupGraceMs: 20
      });
      if (phase === "abort") {
        operation.abort();
      } else {
        child.stdout.write(moveFrame("ready", token));
        await operation.ready;
        if (phase === "move") operation.authorize();
      }
      const outcomes = await Promise.allSettled([operation.ready, operation.completion]);
      assert.equal(outcomes[1].status, "rejected");
      assert.equal(outcomes[1].reason.code, OWNED_CHECKOUT_MOVE_OWNERSHIP_UNCERTAIN);
      assert.deepEqual(
        signals.map(({ signal }) => signal),
        ["SIGTERM", "SIGKILL"]
      );
    });
  });
}

test("a malformed spawned seam child is abandoned through bounded identity-owned cleanup", async (t) => {
  if (process.platform !== "linux") return t.skip("The owned move helper is Linux-only.");
  await withMoveFixture(async ({ options }) => {
    const child = seamChild();
    child.stdout = undefined;
    const signals = [];
    const operation = startOwnedCheckoutMove(options, {
      spawnProcess: () => child,
      readHelperIdentity: (pid) => fakeHelperIdentity(pid),
      readHelperExecutable: seamExecutable,
      signalProcess: (pid, signal) => signals.push({ pid, signal }),
      groupGraceMs: 20
    });
    const outcomes = await Promise.allSettled([operation.ready, operation.completion]);
    assert.equal(
      outcomes.every((outcome) => outcome.status === "rejected"),
      true
    );
    assert.equal(outcomes[0].reason.code, "helper-spawn-failed");
    assert.equal(outcomes[1].reason.code, OWNED_CHECKOUT_MOVE_OWNERSHIP_UNCERTAIN);
    assert.deepEqual(
      signals.map(({ signal }) => signal),
      ["SIGTERM", "SIGKILL"]
    );
  });
});

for (const streamName of ["stdin", "stdout", "stderr"]) {
  test(`${streamName} errors trigger bounded helper cleanup without waiting forever for close`, async (t) => {
    if (process.platform !== "linux") return t.skip("The owned move helper is Linux-only.");
    await withMoveFixture(async ({ options }) => {
      const child = seamChild();
      const signals = [];
      const operation = startOwnedCheckoutMove(options, {
        spawnProcess: () => child,
        readHelperIdentity: (pid) => fakeHelperIdentity(pid),
        readHelperExecutable: seamExecutable,
        signalProcess: (pid, signal) => signals.push({ pid, signal }),
        groupGraceMs: 20
      });
      queueMicrotask(() => child[streamName].emit("error", new Error(`${streamName} failed`)));
      const outcomes = await Promise.allSettled([operation.ready, operation.completion]);
      assert.equal(
        outcomes.every((outcome) => outcome.status === "rejected"),
        true
      );
      assert.equal(outcomes[0].reason.code, "helper-stream-failed");
      assert.equal(outcomes[1].reason.code, OWNED_CHECKOUT_MOVE_OWNERSHIP_UNCERTAIN);
      assert.deepEqual(
        signals.map(({ signal }) => signal),
        ["SIGTERM", "SIGKILL"]
      );
    });
  });
}

test("a helper process error is observed before cleanup and settles without close", async (t) => {
  if (process.platform !== "linux") return t.skip("The owned move helper is Linux-only.");
  await withMoveFixture(async ({ options }) => {
    const child = seamChild();
    const operation = startOwnedCheckoutMove(options, {
      spawnProcess: () => child,
      readHelperIdentity: (pid) => fakeHelperIdentity(pid),
      readHelperExecutable: seamExecutable,
      signalProcess: () => {},
      groupGraceMs: 20
    });
    queueMicrotask(() => child.emit("error", new Error("spawn failed")));
    const outcomes = await Promise.allSettled([operation.ready, operation.completion]);
    assert.equal(
      outcomes.every((outcome) => outcome.status === "rejected"),
      true
    );
    assert.equal(outcomes[0].reason.code, "helper-spawn-failed");
    assert.equal(outcomes[1].reason.code, OWNED_CHECKOUT_MOVE_OWNERSHIP_UNCERTAIN);
  });
});

test("an exact child close never probes or signals a possibly reused process-group ID", async (t) => {
  if (process.platform !== "linux") return t.skip("The owned move helper is Linux-only.");
  await withMoveFixture(async ({ options }) => {
    const child = seamChild();
    let identityReads = 0;
    const signals = [];
    const operation = startOwnedCheckoutMove(options, {
      spawnProcess: () => child,
      readHelperIdentity(pid) {
        identityReads += 1;
        if (identityReads > 1) throw new Error("PID was reused");
        return fakeHelperIdentity(pid);
      },
      readHelperExecutable: seamExecutable,
      signalProcess: (pid, signal) => signals.push({ pid, signal }),
      groupGraceMs: 20
    });
    queueMicrotask(() => child.emit("close", 1, null));
    const outcomes = await Promise.allSettled([operation.ready, operation.completion]);
    assert.equal(
      outcomes.every((outcome) => outcome.status === "rejected"),
      true
    );
    assert.equal(identityReads, 1);
    assert.deepEqual(signals, []);
  });
});

test("RESULT success requires a strict boolean and the canonical moved code", async (t) => {
  if (process.platform !== "linux") return t.skip("The owned move helper is Linux-only.");
  await withMoveFixture(async ({ options }) => {
    const child = seamChild();
    const token = "6".repeat(32);
    let closeQueued = false;
    const operation = startOwnedCheckoutMove(options, {
      spawnProcess: () => child,
      readHelperIdentity: (pid) => fakeHelperIdentity(pid),
      readHelperExecutable: seamExecutable,
      tokenFactory: () => token,
      signalProcess: (_pid, signal) => {
        if (signal === "SIGTERM" && !closeQueued) {
          closeQueued = true;
          queueMicrotask(() => child.emit("close", 1, "SIGTERM"));
        }
      },
      groupGraceMs: 20
    });
    child.stdout.write(moveFrame("ready", token));
    await operation.ready;
    operation.authorize();
    child.stdout.write(
      `${JSON.stringify({
        protocol: OWNED_CHECKOUT_MOVE_PROTOCOL,
        type: "result",
        token,
        ok: "yes",
        code: "moved"
      })}\n`
    );
    await assert.rejects(
      operation.completion,
      (error) => error instanceof OwnedCheckoutMoveError && error.code === "invalid-helper-output"
    );
  });
});

for (const frameType of ["ready", "result"]) {
  test(`a duplicate-key ${frameType.toUpperCase()} frame is rejected at the outer helper boundary`, async (t) => {
    if (process.platform !== "linux") return t.skip("The owned move helper is Linux-only.");
    await withMoveFixture(async ({ options }) => {
      const child = seamChild();
      const token = frameType === "ready" ? "a".repeat(32) : "b".repeat(32);
      let closeQueued = false;
      const operation = startOwnedCheckoutMove(options, {
        spawnProcess: () => child,
        readHelperIdentity: (pid) => fakeHelperIdentity(pid),
        readHelperExecutable: seamExecutable,
        tokenFactory: () => token,
        signalProcess: (_pid, signal) => {
          if (signal === "SIGTERM" && !closeQueued) {
            closeQueued = true;
            queueMicrotask(() => child.emit("close", 1, "SIGTERM"));
          }
        },
        groupGraceMs: 20
      });
      if (frameType === "ready") {
        child.stdout.write(
          `{"protocol":"${OWNED_CHECKOUT_MOVE_PROTOCOL}","type":"ready","type":"ready","token":"${token}"}\n`
        );
      } else {
        child.stdout.write(moveFrame("ready", token));
        await operation.ready;
        operation.authorize();
        child.stdout.write(
          `{"protocol":"${OWNED_CHECKOUT_MOVE_PROTOCOL}","type":"result","type":"result","token":"${token}","ok":true,"code":"moved"}\n`
        );
      }
      const outcomes = await Promise.allSettled([operation.ready, operation.completion]);
      assert.equal(outcomes[1].status, "rejected");
      assert.equal(outcomes[1].reason.code, "invalid-helper-output");
    });
  });
}
