import { spawn, spawnSync } from "node:child_process";
import { existsSync, lstatSync, opendirSync, readFileSync, readdirSync, readlinkSync, realpathSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import {
  readBoundedRemoteWorkspaceFile,
  validateRemoteSshLogAttestation,
  validateRemoteWorkspacePhaseDescriptor,
  validateRemoteWorkspaceResult
} from "./remote-workspace-acceptance.mjs";

const POLL_MS = 250;
const STOP_GRACE_MS = 5_000;
const OUTPUT_LIMIT_BYTES = 64 * 1024;
const MAX_LOG_FILES = 1_000;
const MAX_REMOTE_SSH_LOG_BYTES = 2 * 1024 * 1024;
const [descriptorPath, ipExecutable, sshdExecutable] = process.argv.slice(2);
let descriptor;

try {
  descriptor = readDescriptor(descriptorPath);
  if (
    readlinkSync("/proc/self/ns/pid") === descriptor.hostPidNamespace ||
    readlinkSync("/proc/self/ns/net") === descriptor.hostNetworkNamespace
  ) {
    throw new Error("The Remote SSH phase did not enter private PID and network namespaces.");
  }
  await runPhase(descriptor, ipExecutable, sshdExecutable);
  process.stdout.write(
    `${JSON.stringify({
      protocol: 1,
      runId: descriptor.runId,
      phase: descriptor.phase,
      namespaceEmpty: true,
      network: "unshared",
      remoteAuthority: descriptor.authority,
      version: descriptor.version,
      commit: descriptor.commit
    })}\n`
  );
} catch (error) {
  const root = descriptor?.paths?.root;
  const raw = error instanceof Error ? error.message : String(error);
  const sanitized = sanitizeFailure(raw, root);
  process.stderr.write(`Remote SSH acceptance failed: ${sanitized}\n`);
  process.exitCode = 1;
}

async function runPhase(config, ip, sshd) {
  assertExecutable(ip, "private-network setup");
  assertExecutable(sshd, "private SSH daemon");
  if (process.getuid?.() !== 0) {
    throw new Error("The private user namespace did not map its sole owner to namespace root.");
  }
  const loopback = runSync(ip, ["address", "show", "lo"], "private loopback setup");
  if (!loopback.stdout.includes("127.0.0.1")) {
    throw new Error("The private loopback network was not initialized.");
  }

  const sshdOutput = boundedOutput();
  const sshdChild = spawn(sshd, ["-D", "-e", "-f", config.sshdConfig], {
    detached: true,
    env: { PATH: "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin", LANG: "C.UTF-8" },
    stdio: ["ignore", "ignore", "pipe"]
  });
  sshdChild.stderr.on("data", (chunk) => sshdOutput.append(chunk));
  await wait(350);
  if (sshdChild.exitCode !== null || sshdChild.signalCode !== null || sshdChild.pid === undefined) {
    throw new Error(
      `The private loopback SSH daemon exited before Remote SSH connected.${sshdOutput.text() ? ` ${sshdOutput.text()}` : ""}`
    );
  }
  runSync(
    "/usr/bin/ssh",
    ["-F", config.sshConfig, "ow-loopback", "printf", "%s", "$HOME"],
    "private loopback SSH probe",
    config.paths.remoteHome
  );

  const editorOutput = boundedOutput();
  const editor = spawn(
    config.editor,
    [
      "--remote",
      config.authority,
      config.paths.workspace,
      "--user-data-dir",
      config.paths.userData,
      "--extensions-dir",
      config.paths.localExtensions,
      "--disable-workspace-trust",
      "--disable-updates",
      "--disable-telemetry",
      "--skip-welcome",
      "--skip-release-notes",
      "--locale=en",
      "--new-window",
      "--wait",
      "--no-sandbox",
      "--ozone-platform=headless",
      "--disable-gpu",
      "--disable-crash-reporter"
    ],
    {
      detached: true,
      env: editorEnvironment(config.paths.localHome),
      stdio: ["ignore", "pipe", "pipe"]
    }
  );
  editor.stdout.on("data", (chunk) => editorOutput.append(chunk));
  editor.stderr.on("data", (chunk) => editorOutput.append(chunk));

  let phaseError;
  try {
    await observeAcceptance(config, editor);
  } catch (error) {
    phaseError = error;
  }
  let cleanupError;
  try {
    await stopNamespaceChildren([editor, sshdChild]);
  } catch (error) {
    cleanupError = error;
  }
  if (phaseError && cleanupError) {
    throw new AggregateError([phaseError, cleanupError], "The Remote SSH phase and namespace cleanup both failed.");
  }
  if (cleanupError) throw cleanupError;
  if (phaseError) throw phaseError;

  const resultSnapshot = immutableSnapshot(config.paths.result);
  const resultContents = readBoundedRemoteWorkspaceFile(config.paths.result, 64 * 1024);
  assertSnapshotUnchanged(config.paths.result, resultSnapshot);
  validateRemoteWorkspaceResult(resultContents, config);
  const remoteSshLog = findRemoteSshLog(config.paths.userData);
  validateRemoteSshLogAttestation(readBoundedRemoteWorkspaceFile(remoteSshLog, MAX_REMOTE_SSH_LOG_BYTES));
  assertSnapshotUnchanged(config.paths.result, resultSnapshot);
}

async function observeAcceptance(config, editor) {
  const startedAt = Date.now();
  let lastCheckpointAt = startedAt;
  let lastCheckpoint;
  while (true) {
    if (existsSync(config.paths.progress)) {
      const progress = readBoundedRemoteWorkspaceFile(config.paths.progress, 16 * 1024);
      if (progress !== lastCheckpoint) {
        validateProgress(progress, config);
        lastCheckpoint = progress;
        lastCheckpointAt = Date.now();
      }
    }
    if (existsSync(config.paths.result)) return;
    if (editor.exitCode !== null || editor.signalCode !== null || editor.pid === undefined) {
      throw new Error("Official VS Code exited before the remote extension host published a result.");
    }
    const now = Date.now();
    if (now - startedAt >= config.timeoutMs) {
      throw new Error("The Remote SSH phase exceeded its 300-second deadline.");
    }
    if (now - lastCheckpointAt >= config.inactivityTimeoutMs) {
      throw new Error("The Remote SSH phase made no checkpoint progress for 180 seconds.");
    }
    await wait(POLL_MS);
  }
}

function validateProgress(contents, config) {
  let progress;
  try {
    progress = JSON.parse(contents);
  } catch (error) {
    throw new Error("The Remote SSH progress checkpoint is malformed.", { cause: error });
  }
  if (
    progress?.protocol !== 1 ||
    progress.runId !== config.runId ||
    progress.phase !== config.phase ||
    typeof progress.checkpoint !== "string" ||
    progress.checkpoint.length <= 0 ||
    progress.checkpoint.length > 256
  ) {
    throw new Error("The Remote SSH progress checkpoint lost its phase correlation.");
  }
}

async function stopNamespaceChildren(children) {
  for (const child of children) signalGroup(child, "SIGTERM");
  await waitUntilNoLiveNamespaceChildren(STOP_GRACE_MS);
  for (const child of children) signalGroup(child, "SIGKILL");
  for (const pid of liveNamespaceChildren()) {
    try {
      process.kill(pid, "SIGKILL");
    } catch (error) {
      if (error?.code !== "ESRCH") throw error;
    }
  }
  await waitUntilNoLiveNamespaceChildren(STOP_GRACE_MS);
  const remaining = liveNamespaceChildren();
  if (remaining.length !== 0) {
    throw new Error("The private PID namespace could not prove all editor, SSH, and runtime processes stopped.");
  }
}

async function waitUntilNoLiveNamespaceChildren(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  do {
    if (liveNamespaceChildren().length === 0) return;
    await wait(50);
  } while (Date.now() < deadline);
}

function liveNamespaceChildren() {
  const pids = [];
  for (const entry of readdirSync("/proc", { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^[1-9][0-9]*$/u.test(entry.name)) continue;
    const pid = Number(entry.name);
    if (pid === 1 || pid === process.pid) continue;
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      const closing = stat.lastIndexOf(")");
      const state = closing >= 0 ? stat.slice(closing + 2, closing + 3) : "";
      if (state && state !== "Z" && state !== "X") pids.push(pid);
    } catch (error) {
      if (error?.code !== "ENOENT" && error?.code !== "ESRCH") throw error;
    }
  }
  return pids;
}

function signalGroup(child, signal) {
  if (child?.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
  try {
    process.kill(-child.pid, signal);
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
  }
}

function findRemoteSshLog(userData) {
  const root = realpathSync(join(userData, "logs"));
  const queue = [root];
  const matches = [];
  let entries = 0;
  while (queue.length > 0) {
    const directory = queue.shift();
    const handle = opendirSync(directory);
    try {
      while (true) {
        const entry = handle.readSync();
        if (!entry) break;
        entries += 1;
        if (entries > MAX_LOG_FILES) throw new Error("The private VS Code log tree exceeded its scan bound.");
        const path = join(directory, entry.name);
        const metadata = lstatSync(path);
        if (metadata.isSymbolicLink()) throw new Error("The private VS Code log tree contains a symbolic link.");
        if (entry.isDirectory()) queue.push(path);
        else if (entry.isFile() && /^1-Remote - SSH\.log$/u.test(entry.name)) matches.push(path);
      }
    } finally {
      handle.closeSync();
    }
  }
  if (matches.length !== 1) {
    throw new Error("The private VS Code profile did not contain exactly one Remote SSH acceptance log.");
  }
  return matches[0];
}

function readDescriptor(path) {
  if (typeof path !== "string" || !isAbsolute(path)) {
    throw new Error("The Remote SSH phase requires one absolute private descriptor.");
  }
  const metadata = lstatSync(path, { bigint: true });
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.nlink !== 1n ||
    metadata.size <= 0n ||
    metadata.size > 64n * 1024n
  ) {
    throw new Error("The Remote SSH phase descriptor is not one bounded private file.");
  }
  const value = JSON.parse(readFileSync(path, "utf8"));
  return validateRemoteWorkspacePhaseDescriptor(value, value?.paths?.root);
}

function runSync(executable, args, label, expectedOutput) {
  const result = spawnSync(executable, args, {
    encoding: "utf8",
    env: { PATH: "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin", LANG: "C.UTF-8" },
    maxBuffer: OUTPUT_LIMIT_BYTES,
    timeout: 15_000
  });
  if (result.status !== 0 || result.signal || result.error) {
    throw new Error(`${label} failed inside the private namespace.`);
  }
  if (expectedOutput !== undefined && result.stdout !== expectedOutput) {
    throw new Error(`${label} returned an unexpected private path.`);
  }
  return result;
}

function editorEnvironment(home) {
  return {
    PATH: "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
    LANG: "C.UTF-8",
    HOME: home,
    USERPROFILE: home,
    XDG_RUNTIME_DIR: join(home, "runtime"),
    XDG_CONFIG_HOME: join(home, "config"),
    XDG_CACHE_HOME: join(home, "cache"),
    XDG_DATA_HOME: join(home, "data"),
    XDG_STATE_HOME: join(home, "state"),
    TMPDIR: join(home, "tmp"),
    TMP: join(home, "tmp"),
    TEMP: join(home, "tmp")
  };
}

function boundedOutput() {
  let bytes = 0;
  let exceeded = false;
  const chunks = [];
  return {
    append(chunk) {
      if (exceeded) return;
      const value = Buffer.from(chunk);
      bytes += value.length;
      if (bytes > OUTPUT_LIMIT_BYTES) {
        chunks.length = 0;
        exceeded = true;
      } else {
        chunks.push(value);
      }
    },
    text() {
      return exceeded ? "<bounded-output-omitted>" : Buffer.concat(chunks).toString("utf8").trim();
    }
  };
}

function immutableSnapshot(path) {
  const metadata = lstatSync(path, { bigint: true });
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1n) {
    throw new Error("The Remote SSH result is not one private regular file.");
  }
  return {
    dev: metadata.dev,
    ino: metadata.ino,
    mode: metadata.mode,
    nlink: metadata.nlink,
    size: metadata.size,
    mtimeNs: metadata.mtimeNs,
    ctimeNs: metadata.ctimeNs,
    birthtimeNs: metadata.birthtimeNs
  };
}

function assertSnapshotUnchanged(path, expected) {
  const current = immutableSnapshot(path);
  if (Object.keys(expected).some((key) => current[key] !== expected[key])) {
    throw new Error("The Remote SSH result changed after publication.");
  }
}

function assertExecutable(path, label) {
  const metadata = lstatSync(realpathSync(path));
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error(`The ${label} executable is unsafe.`);
  }
}

function sanitizeFailure(value, root) {
  let text = String(value).replaceAll("\0", "").replaceAll("\r", " ").replaceAll("\n", " ");
  if (root) text = text.replaceAll(root, "<private-root>");
  text = text.replace(/(?:https?|wss?):\/\/\S+/giu, "<redacted-url>");
  return text.slice(0, 8_192);
}

function wait(milliseconds) {
  return new Promise((resolveWait) => setTimeout(resolveWait, milliseconds));
}
