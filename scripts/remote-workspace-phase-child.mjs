import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  opendirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync
} from "node:fs";
import { isAbsolute, join } from "node:path";
import {
  readBoundedRemoteWorkspaceFile,
  validateRemoteSshLogAttestation,
  validateRemoteWorkspacePhaseDescriptor,
  validateRemoteWorkspaceResult
} from "./remote-workspace-contract.mjs";

const POLL_MS = 250;
const STOP_GRACE_MS = 5_000;
const OUTPUT_LIMIT_BYTES = 64 * 1024;
const MAX_LOG_FILES = 1_000;
const MAX_REMOTE_SSH_LOG_BYTES = 2 * 1024 * 1024;
const PRIVATE_DISPLAY = ":99";
const PRIVATE_DISPLAY_DIRECTORY = "/tmp/.X11-unix";
const PRIVATE_DISPLAY_SOCKET = `${PRIVATE_DISPLAY_DIRECTORY}/X99`;
const PRIVATE_DISPLAY_LOCK = "/tmp/.X99-lock";
const [descriptorPath, ipExecutable, sshExecutable, dynamicLoader, ldconfigExecutable] = process.argv.slice(2);
let descriptor;

try {
  descriptor = readDescriptor(descriptorPath);
  if (
    readlinkSync("/proc/self/ns/pid") === descriptor.hostPidNamespace ||
    readlinkSync("/proc/self/ns/net") === descriptor.hostNetworkNamespace ||
    readlinkSync("/proc/self/ns/user") === descriptor.hostUserNamespace
  ) {
    throw new Error("The Remote SSH phase did not enter private user, PID, and network namespaces.");
  }
  await runPhase(descriptor, ipExecutable, sshExecutable, ldconfigExecutable);
  process.stdout.write(
    `${JSON.stringify({
      protocol: 1,
      runId: descriptor.runId,
      phase: descriptor.phase,
      namespaceEmpty: true,
      network: "unshared",
      display: "xvfb",
      displayEmpty: true,
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

async function runPhase(config, ip, ssh, ldconfig) {
  assertExecutable(ip, "private-network setup");
  assertExecutable(ssh, "private SSH client");
  assertExecutable(dynamicLoader, "private SSH dynamic loader");
  assertExecutable(ldconfig, "private dynamic-loader cache builder");
  assertExecutable(config.xvfb, "private Xvfb executable");
  const sshServer = remoteNamespacePath(config, config.sshServer);
  const sshLibraryPath = remoteNamespacePath(config, config.sshLibraryPath);
  const sshHostKey = remoteNamespacePath(config, config.sshHostKey);
  const sshAuthorizedKeys = remoteNamespacePath(config, config.sshAuthorizedKeys);
  assertExecutable(sshServer, "private SSH daemon");
  if (process.getuid?.() !== config.uid || process.getgid?.() !== config.gid) {
    throw new Error("The private user namespace did not map its sole non-root owner.");
  }
  assertPrivateNamespace(config);
  const loopback = runSync(ip, ["address", "show", "lo"], "private loopback setup");
  if (!loopback.stdout.includes("127.0.0.1")) {
    throw new Error("The private loopback network was not initialized.");
  }
  runSync(
    ldconfig,
    [
      "-C",
      join(config.paths.remoteHome, "accounts", "ld.so.cache"),
      "-f",
      join(config.paths.remoteHome, "accounts", "ld.so.conf"),
      "-i",
      "-X"
    ],
    "private dynamic-loader cache setup"
  );
  runSync(sshServer, ["-V"], "private Dropbear cache probe");

  const xvfbChild = await startPrivateXvfb(config);
  const sshdOutput = boundedOutput();
  const sshdChild = spawn(
    dynamicLoader,
    [
      "--library-path",
      sshLibraryPath,
      sshServer,
      "-F",
      "-E",
      "-e",
      "-s",
      "-g",
      "-m",
      "-z",
      "-p",
      "127.0.0.1:49321",
      "-P",
      join(config.paths.remoteHome, "dropbear.pid"),
      "-r",
      sshHostKey,
      "-D",
      sshAuthorizedKeys
    ],
    {
      detached: true,
      env: remoteServerEnvironment(config),
      stdio: ["ignore", "ignore", "pipe"]
    }
  );
  sshdChild.stderr.on("data", (chunk) => sshdOutput.append(chunk));
  const editorOutput = boundedOutput();
  let editor;
  let phaseError;
  try {
    await wait(350);
    if (sshdChild.exitCode !== null || sshdChild.signalCode !== null || sshdChild.pid === undefined) {
      throw new Error(
        `The private loopback SSH daemon exited before Remote SSH connected.${sshdOutput.text() ? ` ${sshdOutput.text()}` : ""}`
      );
    }
    runSync(
      ssh,
      [
        "-F",
        config.sshConfig,
        "ow-loopback",
        "/bin/sh",
        "-c",
        [
          "'test -z \"${LD_PRELOAD-}\"",
          "&& test -z \"${LD_LIBRARY_PATH-}\"",
          "&& test -z \"${LD_BIND_NOW-}\"",
          "&& test -z \"${LD_AUDIT-}\"",
          "&& test -n \"${OPEN_WRANGLER_TEST_MODULE-}\"",
          "&& test -n \"${OPEN_WRANGLER_TEST_RESULT-}\"",
          "&& printf %s \"$HOME\"'"
        ].join(" ")
      ],
      "private loopback SSH probe",
      config.paths.remoteHome
    );
    editor = spawn(
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
        "--ozone-platform=x11",
        "--force-disable-user-env",
        "--disable-crash-reporter",
        "--use-inmemory-secretstorage",
        "--password-store=basic",
        "--skip-add-to-recently-opened"
      ],
      {
        detached: true,
        env: editorEnvironment(config.paths.localHome, ":99"),
        stdio: ["ignore", "pipe", "pipe"]
      }
    );
    editor.stdout.on("data", (chunk) => editorOutput.append(chunk));
    editor.stderr.on("data", (chunk) => editorOutput.append(chunk));
    await observeAcceptance(config, editor);
  } catch (error) {
    const editorDiagnostic = sanitizeFailure(editorOutput.text(), config.paths.root);
    phaseError = editorDiagnostic
      ? new Error(
          `${error instanceof Error ? error.message : String(error)} Editor: ${editorDiagnostic}`,
          { cause: error }
        )
      : error;
  }
  let cleanupError;
  try {
    await stopNamespaceChildren([editor, sshdChild, xvfbChild].filter(Boolean));
    assertPrivateDisplayEmpty();
  } catch (error) {
    cleanupError = error;
  }
  if (phaseError && cleanupError) {
    throw new AggregateError([phaseError, cleanupError], "The Remote SSH phase and namespace cleanup both failed.");
  }
  if (cleanupError) throw cleanupError;
  if (phaseError) {
    const daemonDiagnostic = sshdOutput.text();
    if (daemonDiagnostic) {
      throw new Error(
        `${phaseError instanceof Error ? phaseError.message : String(phaseError)} SSH daemon: ${daemonDiagnostic}`,
        { cause: phaseError }
      );
    }
    throw phaseError;
  }

  const resultSnapshot = immutableSnapshot(config.paths.result);
  const resultContents = readBoundedRemoteWorkspaceFile(config.paths.result, 64 * 1024);
  assertSnapshotUnchanged(config.paths.result, resultSnapshot);
  try {
    validateRemoteWorkspaceResult(resultContents, config);
  } catch (error) {
    let harnessDiagnostic = "";
    try {
      const decoded = JSON.parse(resultContents);
      if (typeof decoded?.error === "string") harnessDiagnostic = sanitizeFailure(decoded.error, config.paths.root);
    } catch {
      // The validator retains the authoritative malformed-result error.
    }
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}${harnessDiagnostic ? ` Harness: ${harnessDiagnostic}` : ""}`,
      { cause: error }
    );
  }
  const remoteSshLog = findRemoteSshLog(config.paths.userData);
  validateRemoteSshLogAttestation(readBoundedRemoteWorkspaceFile(remoteSshLog, MAX_REMOTE_SSH_LOG_BYTES));
  assertSnapshotUnchanged(config.paths.result, resultSnapshot);
}

function assertPrivateNamespace(config) {
  const uidMap = readSingleIdMap("/proc/self/uid_map", config.uid);
  const gidMap = readSingleIdMap("/proc/self/gid_map", config.gid);
  if (uidMap.count !== 1 || gidMap.count !== 1) {
    throw new Error("The private user namespace exposed more than one user or group identity.");
  }
  const status = readFileSync("/proc/self/status", "utf8");
  const capability = status.match(/^CapEff:\s*([0-9a-fA-F]+)$/mu);
  if (!capability || !/^0+$/u.test(capability[1])) {
    throw new Error("The private Remote SSH phase retained an effective capability.");
  }
  const privateRoot = lstatSync(config.paths.root);
  const systemNode = lstatSync("/usr/bin/node");
  if (privateRoot.uid !== config.uid || systemNode.uid !== 65_534) {
    throw new Error("The private user map did not isolate the invoking user from host root.");
  }
  if (
    existsSync(config.hostHome) ||
    existsSync(config.hostSentinel) ||
    readdirSync("/home").length !== 0
  ) {
    throw new Error("The private runtime exposed a host home or host-private sentinel.");
  }
}

function readSingleIdMap(path, expectedNamespaceId) {
  const lines = readFileSync(path, "utf8")
    .trim()
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length !== 1) throw new Error("The private namespace ID map has an unexpected row count.");
  const parts = lines[0].split(/\s+/u);
  if (parts.length !== 3 || parts.some((part) => !/^[0-9]+$/u.test(part))) {
    throw new Error("The private namespace ID map is malformed.");
  }
  const [namespaceId, parentId, count] = parts.map(Number);
  if (namespaceId !== expectedNamespaceId || !Number.isSafeInteger(parentId) || count !== 1) {
    throw new Error("The private namespace ID map did not contain its one expected identity.");
  }
  return { namespaceId, parentId, count };
}

async function startPrivateXvfb(config) {
  mkdirSync(PRIVATE_DISPLAY_DIRECTORY, { mode: 0o1777 });
  chmodSync(PRIVATE_DISPLAY_DIRECTORY, 0o1777);
  const output = boundedOutput();
  const child = spawn(
    config.xvfb,
    [PRIVATE_DISPLAY, "-screen", "0", "1280x720x24", "-nolisten", "tcp", "-noreset"],
    {
      detached: true,
      env: privateDisplayEnvironment(config.paths.localHome),
      stdio: ["ignore", "ignore", "pipe"]
    }
  );
  child.stderr.on("data", (chunk) => output.append(chunk));
  try {
    const deadline = Date.now() + 10_000;
    do {
      if (child.exitCode !== null || child.signalCode !== null || child.pid === undefined) {
        throw new Error(
          `The private Xvfb exited before its display became ready.${output.text() ? ` ${output.text()}` : ""}`
        );
      }
      if (existsSync(PRIVATE_DISPLAY_SOCKET) && existsSync(PRIVATE_DISPLAY_LOCK)) {
        assertPrivateDisplayOwned(config, child.pid);
        return child;
      }
      await wait(50);
    } while (Date.now() < deadline);
    throw new Error(`The private Xvfb display did not become ready.${output.text() ? ` ${output.text()}` : ""}`);
  } catch (error) {
    let cleanupError;
    try {
      await stopNamespaceChildren([child]);
      assertPrivateDisplayEmpty();
    } catch (candidate) {
      cleanupError = candidate;
    }
    if (cleanupError) {
      throw new AggregateError([error, cleanupError], "Private Xvfb startup and cleanup both failed.");
    }
    throw error;
  }
}

function assertPrivateDisplayOwned(config, expectedPid) {
  const directory = lstatSync(PRIVATE_DISPLAY_DIRECTORY);
  const socket = lstatSync(PRIVATE_DISPLAY_SOCKET);
  const lock = lstatSync(PRIVATE_DISPLAY_LOCK);
  const entries = readdirSync(PRIVATE_DISPLAY_DIRECTORY).sort();
  const recordedPid = Number(readFileSync(PRIVATE_DISPLAY_LOCK, "utf8").trim());
  if (
    !directory.isDirectory() ||
    directory.isSymbolicLink() ||
    directory.uid !== config.uid ||
    entries.length !== 1 ||
    entries[0] !== "X99" ||
    !socket.isSocket() ||
    socket.isSymbolicLink() ||
    socket.uid !== config.uid ||
    !lock.isFile() ||
    lock.isSymbolicLink() ||
    lock.nlink !== 1 ||
    lock.uid !== config.uid ||
    recordedPid !== expectedPid
  ) {
    throw new Error("The private Xvfb display lost its isolated process, lock, or socket identity.");
  }
}

function assertPrivateDisplayEmpty() {
  if (existsSync(PRIVATE_DISPLAY_SOCKET) || existsSync(PRIVATE_DISPLAY_LOCK)) {
    throw new Error("The private Xvfb display socket or lock remained after shutdown.");
  }
  if (existsSync(PRIVATE_DISPLAY_DIRECTORY)) {
    const directory = lstatSync(PRIVATE_DISPLAY_DIRECTORY);
    if (directory.isSymbolicLink() || !directory.isDirectory() || readdirSync(PRIVATE_DISPLAY_DIRECTORY).length !== 0) {
      throw new Error("The private Xvfb socket directory was not empty after shutdown.");
    }
  }
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
    const detail = [result.error?.message, result.stdout, result.stderr]
      .filter((value) => typeof value === "string" && value.trim().length > 0)
      .join(" ")
      .replaceAll("\r", " ")
      .replaceAll("\n", " ")
      .slice(-8_192);
    throw new Error(
      `${label} failed inside the private namespace (status ${String(result.status)}, signal ${String(result.signal)}).${
        detail ? ` ${detail}` : ""
      }`
    );
  }
  if (expectedOutput !== undefined && result.stdout !== expectedOutput) {
    throw new Error(`${label} returned an unexpected private path.`);
  }
  return result;
}

function privateDisplayEnvironment(home) {
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
    XDG_SESSION_TYPE: "tty",
    TMPDIR: "/tmp",
    TMP: "/tmp",
    TEMP: "/tmp"
  };
}

function editorEnvironment(home, display) {
  return {
    PATH: "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
    LANG: "C.UTF-8",
    HOME: home,
    USERPROFILE: home,
    DISPLAY: display,
    GDK_BACKEND: "x11",
    XDG_RUNTIME_DIR: join(home, "runtime"),
    XDG_CONFIG_HOME: join(home, "config"),
    XDG_CACHE_HOME: join(home, "cache"),
    XDG_DATA_HOME: join(home, "data"),
    XDG_STATE_HOME: join(home, "state"),
    XDG_SESSION_TYPE: "x11",
    TMPDIR: join(home, "tmp"),
    TMP: join(home, "tmp"),
    TEMP: join(home, "tmp")
  };
}

function remoteServerEnvironment(config) {
  const home = config.paths.remoteHome;
  return {
    PATH: "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
    LANG: "C.UTF-8",
    HOME: home,
    USERPROFILE: home,
    USER: config.user,
    LOGNAME: config.user,
    XDG_RUNTIME_DIR: join(home, "runtime"),
    XDG_CONFIG_HOME: join(home, "config"),
    XDG_CACHE_HOME: join(home, "cache"),
    XDG_DATA_HOME: join(home, "data"),
    XDG_STATE_HOME: join(home, "state"),
    TMPDIR: join(home, "tmp"),
    TMP: join(home, "tmp"),
    TEMP: join(home, "tmp"),
    OPEN_WRANGLER_EXTENSION_TESTS: "1",
    OPEN_WRANGLER_TEST_PHASE: config.phase,
    OPEN_WRANGLER_TEST_EDITOR: "vscode-remote-ssh",
    OPEN_WRANGLER_TEST_PYTHON: config.python,
    OPEN_WRANGLER_TEST_MODULE: config.testModule,
    OPEN_WRANGLER_TEST_RESULT: config.paths.result,
    OPEN_WRANGLER_TEST_PROGRESS: config.paths.progress,
    OPEN_WRANGLER_TEST_RUN_ID: config.runId
  };
}

function remoteNamespacePath(config, hostPath) {
  const prefix = `${config.paths.remoteHome}/`;
  if (typeof hostPath !== "string" || !hostPath.startsWith(prefix) || hostPath.includes("\0")) {
    throw new Error("The private SSH runtime escaped its remote-home mapping.");
  }
  const suffix = hostPath.slice(prefix.length);
  if (!suffix || suffix.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new Error("The private SSH runtime has an invalid remote-home mapping.");
  }
  return hostPath;
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
  return text.slice(-8_192);
}

function wait(milliseconds) {
  return new Promise((resolveWait) => setTimeout(resolveWait, milliseconds));
}
