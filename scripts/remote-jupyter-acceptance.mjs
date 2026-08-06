import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstatSync, realpathSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

export const REAL_REMOTE_JUPYTER_ENV = "OPEN_WRANGLER_REAL_REMOTE_JUPYTER";
export const REMOTE_JUPYTER_OWNERSHIP_UNCERTAIN_CODE = "REMOTE_JUPYTER_OWNERSHIP_UNCERTAIN";
export const REMOTE_JUPYTER_SETUP_TIMEOUT_MS = 300_000;
export const REMOTE_JUPYTER_SETUP_INACTIVITY_TIMEOUT_MS = 180_000;
export const REMOTE_JUPYTER_SETUP_HEARTBEAT_MS = 60_000;
export const REMOTE_JUPYTER_BASE_IMAGE =
  "python:3.12.10-slim-bookworm@sha256:fd95fa221297a88e1cf49c55ec1828edd7c5a428187e67b5d1805692d11588db";
export const REMOTE_R_JUPYTER_BASE_IMAGE =
  "rocker/r-ver:4.5.2@sha256:fd4ccdd3a4a6f7ef805e2daeee2a0fe3bf126bc231f36351223baecf5a595a4c";

const MODULE_DIRECTORY = fileURLToPath(new URL(".", import.meta.url));
const DEFAULT_BUILD_CONTEXT = resolve(MODULE_DIRECTORY, "remote-jupyter");
const OWNER_LABEL = "io.openwrangler.remote-jupyter.owner";
const CONTAINER_PORT = 8888;
const REMOTE_FIXTURE_DEFINITIONS = Object.freeze({
  python: Object.freeze({
    dockerfile: "Dockerfile",
    imageName: "openwrangler-remote-jupyter",
    kernelName: "openwrangler-remote-acceptance",
    kernelLabel: "Open Wrangler Remote Acceptance",
    language: "python"
  }),
  r: Object.freeze({
    dockerfile: "Dockerfile.r",
    imageName: "openwrangler-remote-r-jupyter",
    kernelName: "openwrangler-r-remote-acceptance",
    kernelLabel: "R (Open Wrangler Remote)",
    language: "R"
  })
});
const DOCKER_OUTPUT_MAX_BYTES = 64 * 1024;
const DOCKER_COMPLETION_UNKNOWN_CODE = "REMOTE_JUPYTER_DOCKER_COMPLETION_UNKNOWN";
const STATUS_MAX_BYTES = 16 * 1024;
const DEFAULT_DOCKER_TIMEOUT_MS = 120_000;
const DEFAULT_BUILD_TIMEOUT_MS = 300_000;
const DEFAULT_READY_TIMEOUT_MS = 60_000;
const DEFAULT_CLEANUP_TIMEOUT_MS = 15_000;
const DEFAULT_DOCKER_FORCE_CLOSE_TIMEOUT_MS = 2_000;
const POLL_INTERVAL_MS = 100;
const TOKEN = /^owr_[A-Za-z0-9_-]{39}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const IMAGE_ID = /^sha256:[0-9a-f]{64}$/u;
const CONTAINER_ID = /^[0-9a-f]{64}$/u;
const ENGINE_ID = /^[A-Za-z0-9][A-Za-z0-9:._-]{7,127}$/u;
const BOUNDED_DOCKER_VERSION = /^[\x21-\x7e]{1,128}$/u;
const NO_NEW_PRIVILEGES_OPTIONS = new Set(["no-new-privileges", "no-new-privileges=true", "no-new-privileges:true"]);
const CONTAINER_INSPECT_FORMAT = [
  "{{.Id}}",
  "{{.Name}}",
  "{{.Image}}",
  `{{index .Config.Labels "${OWNER_LABEL}"}}`,
  "{{.Config.User}}",
  "{{.Config.Hostname}}",
  "{{json .Config.Env}}",
  "{{.State.Running}}",
  "{{.HostConfig.ReadonlyRootfs}}",
  "{{.HostConfig.RestartPolicy.Name}}",
  "{{.HostConfig.PidsLimit}}",
  "{{.HostConfig.Memory}}",
  "{{.HostConfig.MemorySwap}}",
  "{{.HostConfig.NanoCpus}}",
  "{{json .HostConfig.CapDrop}}",
  "{{json .HostConfig.SecurityOpt}}",
  "{{json .HostConfig.Binds}}",
  "{{json .HostConfig.Tmpfs}}",
  "{{.HostConfig.NetworkMode}}"
].join("\t");

export function remoteJupyterAcceptanceEnabled(environment = process.env) {
  const value = environment?.[REAL_REMOTE_JUPYTER_ENV];
  if (value === undefined || value === "" || value === "0") return false;
  if (value !== "1") {
    throw new Error(`Real remote-Jupyter acceptance requires ${REAL_REMOTE_JUPYTER_ENV}=1.`);
  }
  return true;
}

export function remoteJupyterHostnameForRun(runId) {
  if (!UUID.test(runId ?? "")) {
    throw new Error("Remote Jupyter acceptance requires one canonical public run identifier.");
  }
  return `owr-${runId.replaceAll("-", "").slice(0, 12).toLowerCase()}`;
}

export function remoteJupyterOwnershipMayBeLive(error) {
  return error?.code === REMOTE_JUPYTER_OWNERSHIP_UNCERTAIN_CODE;
}

export function remoteJupyterFixtureDefinition(fixtureKind) {
  if (fixtureKind !== "python" && fixtureKind !== "r") {
    throw new Error('Remote Jupyter fixture kind must be exactly "python" or "r".');
  }
  return REMOTE_FIXTURE_DEFINITIONS[fixtureKind];
}

function notifyRemoteJupyterOwnershipUncertain(callback, error) {
  try {
    callback(error);
  } catch {
    throw ownershipUncertainError("Remote Jupyter ownership uncertainty could not be latched by its caller.");
  }
}

/**
 * Runs one editor phase against an already-started remote fixture.
 *
 * An editor ownership failure is fail-closed: the Docker client state lives
 * below the editor's private profile, so even attempting fixture cleanup would
 * access a path that invariant 40 requires the caller to leave untouched.
 */
export async function runRemoteJupyterAcceptanceLifecycle(
  fixture,
  runPhase,
  { phaseProcessTreeMayBeLive, onOwnershipUncertain, onCleanupCheckpoint = () => {} }
) {
  if (
    !fixture ||
    typeof fixture.cleanup !== "function" ||
    typeof runPhase !== "function" ||
    typeof phaseProcessTreeMayBeLive !== "function" ||
    typeof onOwnershipUncertain !== "function" ||
    typeof onCleanupCheckpoint !== "function"
  ) {
    throw new TypeError(
      "Remote Jupyter lifecycle requires a fixture, phase, ownership predicate, uncertainty callback, and cleanup checkpoint."
    );
  }

  let phaseResult;
  let phaseError;
  try {
    phaseResult = await runPhase();
  } catch (error) {
    if (phaseProcessTreeMayBeLive(error)) {
      notifyRemoteJupyterOwnershipUncertain(onOwnershipUncertain, error);
      throw error;
    }
    phaseError = error;
  }

  let cleanupError;
  try {
    onCleanupCheckpoint("start", { phaseFailed: phaseError !== undefined });
  } catch {
    const uncertainty = ownershipUncertainError(
      "Remote Jupyter cleanup checkpoint publication could not preserve private-root ownership."
    );
    notifyRemoteJupyterOwnershipUncertain(onOwnershipUncertain, uncertainty);
    throw uncertainty;
  }
  try {
    await fixture.cleanup();
  } catch (error) {
    if (remoteJupyterOwnershipMayBeLive(error)) {
      notifyRemoteJupyterOwnershipUncertain(onOwnershipUncertain, error);
      cleanupError = error;
    } else {
      cleanupError = error;
    }
  }
  if (!cleanupError) {
    try {
      onCleanupCheckpoint("complete", { phaseFailed: phaseError !== undefined });
    } catch {
      const uncertainty = ownershipUncertainError(
        "Remote Jupyter cleanup completion checkpoint could not preserve private-root ownership."
      );
      notifyRemoteJupyterOwnershipUncertain(onOwnershipUncertain, uncertainty);
      throw uncertainty;
    }
  }

  if (phaseError && cleanupError) {
    throw new AggregateError([phaseError, cleanupError], "Remote Jupyter acceptance and fixture cleanup both failed.");
  }
  if (phaseError) throw phaseError;
  if (cleanupError) throw cleanupError;
  return phaseResult;
}

export function assertRemoteJupyterPrivateDirectory(directory) {
  validateAbsoluteSingleLine(directory, "Remote Jupyter private Docker directory");
  let metadata;
  try {
    metadata = lstatSync(directory, { bigint: true });
  } catch {
    throw new Error("Remote Jupyter private Docker directory does not exist.");
  }
  const currentUser = typeof process.getuid === "function" ? BigInt(process.getuid()) : undefined;
  let canonicalDirectory;
  try {
    canonicalDirectory = realpathSync(directory);
  } catch {
    throw new Error("Remote Jupyter private Docker directory identity could not be read.");
  }
  if (
    !metadata.isDirectory() ||
    metadata.isSymbolicLink() ||
    (metadata.mode & 0o777n) !== 0o700n ||
    (currentUser !== undefined && metadata.uid !== currentUser) ||
    canonicalDirectory !== resolve(directory)
  ) {
    throw new Error("Remote Jupyter private Docker directory must be an owned mode-0700 real directory.");
  }
}

export function createRemoteJupyterDockerEnvironment(
  sourceEnvironment,
  privateDirectory,
  { platform = process.platform } = {}
) {
  if (platform !== "linux") {
    throw new Error("Remote Jupyter container acceptance is supported only on a Linux host.");
  }
  validateAbsoluteSingleLine(privateDirectory, "Remote Jupyter private Docker directory");
  const path = sourceEnvironment?.PATH;
  if (typeof path !== "string" || path.length === 0 || /[\0\r\n]/u.test(path)) {
    throw new Error("Remote Jupyter Docker execution requires one bounded PATH.");
  }
  const result = {
    PATH: path,
    HOME: privateDirectory,
    DOCKER_CONFIG: privateDirectory,
    TMPDIR: privateDirectory
  };
  const dockerHost = sourceEnvironment?.DOCKER_HOST;
  if (dockerHost !== undefined && dockerHost !== "") {
    const match = /^unix:\/\/(.+)$/u.exec(dockerHost);
    if (!match || !isAbsolute(match[1]) || /[\0\r\n]/u.test(match[1]) || match[1].split("/").includes("..")) {
      throw new Error("Remote Jupyter Docker routing must use one absolute local Unix socket.");
    }
    result.DOCKER_HOST = dockerHost;
  }
  return Object.freeze(result);
}

/**
 * Starts an isolated Jupyter Server fixture.
 *
 * The caller owns `token` and must keep it outside public acceptance envelopes.
 * It is sent only as bounded stdin to a fixed helper in the already-running
 * container. `runId` is public and only derives the fixed remote hostname. The
 * returned URL is deliberately tokenless.
 */
export async function startRemoteJupyterAcceptanceFixture(
  credentials,
  {
    environment = process.env,
    dockerPrivateDirectory,
    dockerExecutable = "docker",
    buildContext = DEFAULT_BUILD_CONTEXT,
    fixtureKind = "python",
    runCommand = runBoundedDockerCommand,
    fetchImpl = globalThis.fetch,
    randomUUIDImpl = randomUUID,
    now = () => performance.now(),
    sleep = (milliseconds) => delay(milliseconds),
    dockerTimeoutMs = DEFAULT_DOCKER_TIMEOUT_MS,
    buildTimeoutMs = DEFAULT_BUILD_TIMEOUT_MS,
    readyTimeoutMs = DEFAULT_READY_TIMEOUT_MS,
    cleanupTimeoutMs = DEFAULT_CLEANUP_TIMEOUT_MS,
    setupTimeoutMs = REMOTE_JUPYTER_SETUP_TIMEOUT_MS,
    setupInactivityTimeoutMs = REMOTE_JUPYTER_SETUP_INACTIVITY_TIMEOUT_MS,
    setupHeartbeatMs = REMOTE_JUPYTER_SETUP_HEARTBEAT_MS,
    onSetupCheckpoint = () => {},
    onCleanupCheckpoint = () => {}
  } = {}
) {
  if (!remoteJupyterAcceptanceEnabled(environment)) return undefined;
  const fixtureDefinition = remoteJupyterFixtureDefinition(fixtureKind);
  if (!isPlainObject(credentials) || !TOKEN.test(credentials.token ?? "")) {
    throw new Error("Remote Jupyter acceptance requires one separately generated opaque authentication token.");
  }
  if (!UUID.test(credentials.runId ?? "")) {
    throw new Error("Remote Jupyter acceptance requires one canonical public run identifier.");
  }
  if (
    typeof runCommand !== "function" ||
    typeof fetchImpl !== "function" ||
    typeof randomUUIDImpl !== "function" ||
    typeof now !== "function" ||
    typeof sleep !== "function" ||
    typeof onSetupCheckpoint !== "function" ||
    typeof onCleanupCheckpoint !== "function"
  ) {
    throw new TypeError(
      "Remote Jupyter acceptance requires injectable command, network, time, random, and checkpoint sources."
    );
  }
  const monotonicNow = createCheckedMonotonicClock(now);
  validateExecutable(dockerExecutable);
  validateAbsoluteSingleLine(buildContext, "Remote Jupyter build context");
  assertRemoteJupyterPrivateDirectory(dockerPrivateDirectory);
  for (const [label, value] of [
    ["Docker command timeout", dockerTimeoutMs],
    ["Docker build timeout", buildTimeoutMs],
    ["remote Jupyter readiness timeout", readyTimeoutMs],
    ["remote Jupyter cleanup timeout", cleanupTimeoutMs],
    ["remote Jupyter setup timeout", setupTimeoutMs],
    ["remote Jupyter setup inactivity timeout", setupInactivityTimeoutMs],
    ["remote Jupyter setup heartbeat", setupHeartbeatMs]
  ]) {
    validateTimeout(label, value);
  }
  if (
    cleanupTimeoutMs > DEFAULT_CLEANUP_TIMEOUT_MS ||
    setupTimeoutMs > REMOTE_JUPYTER_SETUP_TIMEOUT_MS ||
    setupInactivityTimeoutMs > REMOTE_JUPYTER_SETUP_INACTIVITY_TIMEOUT_MS ||
    setupHeartbeatMs > REMOTE_JUPYTER_SETUP_HEARTBEAT_MS ||
    setupHeartbeatMs >= setupInactivityTimeoutMs
  ) {
    throw new Error("Remote Jupyter phase deadlines exceed their fixed acceptance bounds.");
  }
  const setupBudget = createRemoteJupyterSetupBudget({
    now: monotonicNow,
    timeoutMs: setupTimeoutMs,
    inactivityTimeoutMs: setupInactivityTimeoutMs,
    heartbeatMs: setupHeartbeatMs,
    onCheckpoint: onSetupCheckpoint
  });
  setupBudget.checkpoint("setup:start");

  const ownerId = randomUUIDImpl();
  if (!UUID.test(ownerId)) {
    throw new Error("Remote Jupyter acceptance did not receive a safe random ownership identifier.");
  }
  const compactOwner = ownerId.replaceAll("-", "").toLowerCase();
  const hostname = remoteJupyterHostnameForRun(credentials.runId);
  const containerName = `ow-rj-${compactOwner.slice(0, 24)}`;
  const imageTag = `${fixtureDefinition.imageName}:${compactOwner}`;
  const token = credentials.token;
  const docker = createDockerClient({
    dockerExecutable,
    environment: createRemoteJupyterDockerEnvironment(environment, dockerPrivateDirectory),
    runCommand,
    dockerTimeoutMs,
    token
  });
  const setupDocker = createRemoteJupyterSetupDockerClient(docker, setupBudget, dockerTimeoutMs);
  const resources = {
    ownerId,
    containerName,
    containerId: undefined,
    imageTag,
    imageId: undefined,
    mutationStarted: false,
    buildOwnershipUncertain: false,
    launchOwnershipUncertain: false,
    hostname,
    runId: credentials.runId
  };
  let initialEngine;
  let cleanupHandle;

  try {
    initialEngine = await probeDockerEngine(setupDocker);
    await assertContainerNameAvailable(setupDocker, containerName);
    await assertOwnerLabelAvailable(setupDocker, ownerId);

    resources.mutationStarted = true;
    resources.buildOwnershipUncertain = true;
    let build;
    try {
      build = await setupDocker.required(
        [
          "build",
          "--quiet",
          "--no-cache",
          "--pull=false",
          "--file",
          resolve(buildContext, fixtureDefinition.dockerfile),
          "--label",
          `${OWNER_LABEL}=${ownerId}`,
          "--tag",
          imageTag,
          buildContext
        ],
        "Remote Jupyter image build",
        buildTimeoutMs
      );
    } catch (error) {
      if (!dockerCommandCompletionUnknown(error)) resources.buildOwnershipUncertain = false;
      throw error;
    }
    resources.imageId = parseExactImageId(build.stdout, "Remote Jupyter image build");
    await assertOwnedImage(setupDocker, resources);
    resources.buildOwnershipUncertain = false;

    resources.launchOwnershipUncertain = true;
    let launched;
    try {
      launched = await setupDocker.required(
        [
          "run",
          "--detach",
          "--name",
          containerName,
          `--hostname=${hostname}`,
          `--env=OPEN_WRANGLER_REMOTE_RUN_ID=${credentials.runId}`,
          "--label",
          `${OWNER_LABEL}=${ownerId}`,
          "--restart=no",
          "--read-only",
          "--tmpfs",
          "/tmp:rw,noexec,nosuid,nodev,size=536870912,mode=1777",
          "--tmpfs",
          "/run/openwrangler:rw,noexec,nosuid,nodev,size=65536,mode=0700,uid=65532,gid=65532",
          "--cap-drop=ALL",
          "--security-opt=no-new-privileges=true",
          "--pids-limit=256",
          "--memory=1073741824",
          "--memory-swap=1073741824",
          "--cpus=2",
          "--ulimit=nofile=1024:1024",
          "--user=65532:65532",
          "--network=bridge",
          "--publish=127.0.0.1::8888/tcp",
          resources.imageId
        ],
        "Remote Jupyter container launch"
      );
    } catch (error) {
      if (!dockerCommandCompletionUnknown(error)) resources.launchOwnershipUncertain = false;
      throw error;
    }
    resources.containerId = parseExactContainerId(launched.stdout, "Remote Jupyter container launch");
    await assertOwnedContainer(setupDocker, resources, {
      requireRunning: true,
      requireIsolation: false
    });
    resources.launchOwnershipUncertain = false;
    await assertOwnedContainer(setupDocker, resources, { requireRunning: true });

    await injectAuthenticationToken(setupDocker, resources.containerId, token);
    const baseUrl = await resolveLoopbackBaseUrl(setupDocker, resources.containerId);
    setupBudget.checkpoint("setup:readiness-start");
    await waitForJupyterStatus(baseUrl, token, fixtureDefinition, {
      fetchImpl,
      now: monotonicNow,
      sleep,
      timeoutMs: setupBudget.remainingTimeout(readyTimeoutMs),
      progressIntervalMs: setupHeartbeatMs,
      onProgress: () => setupBudget.checkpoint("setup:readiness-active")
    });
    setupBudget.checkpoint("setup:readiness-complete");

    assertSameDockerEngine(initialEngine, await probeDockerEngine(setupDocker));
    await assertOwnedContainer(setupDocker, resources, { requireRunning: true });
    cleanupHandle = createCleanupHandle({
      docker,
      initialEngine,
      resources,
      now: monotonicNow,
      sleep,
      cleanupTimeoutMs
    });
    setupBudget.checkpoint("setup:complete");
    return Object.freeze({ baseUrl, cleanup: cleanupHandle });
  } catch (error) {
    if (remoteJupyterOwnershipMayBeLive(error)) {
      throw error;
    }
    cleanupHandle ??= createCleanupHandle({
      docker,
      initialEngine,
      resources,
      now: monotonicNow,
      sleep,
      cleanupTimeoutMs
    });
    try {
      onCleanupCheckpoint("start", { originatingPhase: "setup" });
    } catch {
      throw ownershipUncertainError(
        "Remote Jupyter setup cleanup checkpoint could not preserve private-root ownership."
      );
    }
    try {
      await cleanupHandle();
    } catch {
      throw ownershipUncertainError(
        "Remote Jupyter acceptance failed and owned Docker resource disappearance could not be proven."
      );
    }
    try {
      onCleanupCheckpoint("complete", { originatingPhase: "setup" });
    } catch {
      throw ownershipUncertainError(
        "Remote Jupyter setup cleanup completion checkpoint could not preserve private-root ownership."
      );
    }
    throw safeFailure(error, token);
  }
}

export async function runBoundedDockerCommand(
  { executable, args, environment, stdin, label },
  {
    timeoutMs = DEFAULT_DOCKER_TIMEOUT_MS,
    maxOutputBytes = DOCKER_OUTPUT_MAX_BYTES,
    forceCloseTimeoutMs = DEFAULT_DOCKER_FORCE_CLOSE_TIMEOUT_MS,
    spawnProcess = spawn,
    killProcessGroup = killDockerProcessGroup,
    platform = process.platform,
    progressIntervalMs,
    onProgress
  } = {}
) {
  validateExecutable(executable);
  if (
    !Array.isArray(args) ||
    args.some((value) => typeof value !== "string" || /[\0\r\n]/u.test(value)) ||
    !isEnvironment(environment) ||
    (stdin !== undefined && !Buffer.isBuffer(stdin)) ||
    typeof label !== "string" ||
    label.length === 0 ||
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs <= 0 ||
    !Number.isSafeInteger(maxOutputBytes) ||
    maxOutputBytes <= 0 ||
    !Number.isSafeInteger(forceCloseTimeoutMs) ||
    forceCloseTimeoutMs <= 0 ||
    typeof spawnProcess !== "function" ||
    typeof killProcessGroup !== "function" ||
    typeof platform !== "string" ||
    platform.length === 0 ||
    (progressIntervalMs === undefined) !== (onProgress === undefined) ||
    (progressIntervalMs !== undefined &&
      (!Number.isSafeInteger(progressIntervalMs) || progressIntervalMs <= 0 || progressIntervalMs > 60_000)) ||
    (onProgress !== undefined && typeof onProgress !== "function")
  ) {
    throw new TypeError("Bounded Docker execution received an invalid command contract.");
  }

  return await new Promise((resolvePromise, rejectPromise) => {
    let settled = false;
    let completionTimer;
    let forceCloseTimer;
    let progressTimer;
    let forcedFailure;
    let killUncertain = false;
    let childError;
    let stdoutBytes = 0;
    let stderrBytes = 0;
    const stdout = [];
    const stderr = [];
    const startedAt = performance.now();
    const deadline = startedAt + timeoutMs;
    const closeGraceMs = Math.min(forceCloseTimeoutMs, Math.max(1, Math.floor(timeoutMs / 2)));
    let child;
    try {
      child = spawnProcess(executable, args, {
        detached: platform !== "win32",
        env: environment,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true
      });
    } catch {
      rejectPromise(dockerCommandCompletionUnknownError(`${label} could not start.`));
      return;
    }
    const finish = (callback) => {
      if (settled) return;
      settled = true;
      clearTimeout(completionTimer);
      clearTimeout(forceCloseTimer);
      clearInterval(progressTimer);
      callback();
    };
    const requestForcedStop = (message, failure = dockerCommandCompletionUnknownError(message)) => {
      if (settled || forcedFailure) return;
      forcedFailure = failure;
      clearTimeout(completionTimer);
      clearInterval(progressTimer);
      if (Number.isSafeInteger(child.pid) && child.pid > 0) {
        try {
          killProcessGroup(child, "SIGKILL", platform);
        } catch (error) {
          if (error?.code !== "ESRCH") killUncertain = true;
        }
      }
      const remainingMs = Math.max(1, Math.ceil(deadline - performance.now()));
      forceCloseTimer = setTimeout(
        () => {
          finish(() =>
            rejectPromise(
              ownershipUncertainError(`${label} process-tree shutdown could not be proven within its fixed deadline.`)
            )
          );
        },
        Math.min(closeGraceMs, remainingMs)
      );
    };
    const collect = (chunks, kind, chunk) => {
      if (settled || forcedFailure) return;
      if (!Buffer.isBuffer(chunk)) chunk = Buffer.from(chunk);
      if (kind === "stdout") stdoutBytes += chunk.length;
      else stderrBytes += chunk.length;
      if (stdoutBytes + stderrBytes > maxOutputBytes) {
        requestForcedStop(`${label} exceeded its fixed output bound.`);
        return;
      }
      chunks.push(chunk);
    };
    child.stdout.on("data", (chunk) => collect(stdout, "stdout", chunk));
    child.stderr.on("data", (chunk) => collect(stderr, "stderr", chunk));
    child.once("error", (error) => {
      childError = error;
      requestForcedStop(`${label} could not start or remain attached.`);
    });
    child.once("close", (exitCode, signal) => {
      finish(() => {
        if (killUncertain) {
          rejectPromise(ownershipUncertainError(`${label} process-group termination could not be proven.`));
          return;
        }
        if (forcedFailure) {
          rejectPromise(forcedFailure);
          return;
        }
        if (childError) {
          rejectPromise(dockerCommandCompletionUnknownError(`${label} could not start or remain attached.`));
          return;
        }
        resolvePromise({
          exitCode: Number.isInteger(exitCode) ? exitCode : -1,
          signal: typeof signal === "string" ? signal : undefined,
          stdout: Buffer.concat(stdout).toString("utf8"),
          stderr: Buffer.concat(stderr).toString("utf8")
        });
      });
    });
    completionTimer = setTimeout(
      () => requestForcedStop(`${label} exceeded its fixed deadline.`),
      Math.max(1, timeoutMs - closeGraceMs)
    );
    if (onProgress) {
      progressTimer = setInterval(() => {
        if (settled || forcedFailure) return;
        try {
          onProgress();
        } catch {
          const message = `${label} progress publication could not preserve private-root ownership.`;
          requestForcedStop(message, ownershipUncertainError(message));
        }
      }, progressIntervalMs);
    }
    child.stdin.once("error", () => {
      requestForcedStop(`${label} could not receive its bounded input.`);
    });
    try {
      if (stdin === undefined) child.stdin.end();
      else child.stdin.end(stdin);
    } catch {
      requestForcedStop(`${label} could not receive its bounded input.`);
    }
  });
}

function createRemoteJupyterSetupBudget({ now, timeoutMs, inactivityTimeoutMs, heartbeatMs, onCheckpoint }) {
  const startedAt = now();
  const deadline = startedAt + timeoutMs;
  let lastCheckpointAt = startedAt;
  let checkpointSequence = 0;

  const currentTime = () => {
    const current = now();
    if (current >= deadline) {
      throw new Error("Remote Jupyter setup exceeded its fixed aggregate deadline.");
    }
    if (current - lastCheckpointAt >= inactivityTimeoutMs) {
      throw new Error("Remote Jupyter setup exceeded its fixed checkpoint inactivity deadline.");
    }
    return current;
  };

  return Object.freeze({
    heartbeatMs,
    checkpoint(label) {
      if (typeof label !== "string" || label.length === 0 || label.length > 128 || /[\0\r\n]/u.test(label)) {
        throw new Error("Remote Jupyter setup checkpoint is malformed.");
      }
      currentTime();
      checkpointSequence += 1;
      try {
        onCheckpoint(`${label}:${checkpointSequence}`);
      } catch {
        throw ownershipUncertainError(
          "Remote Jupyter setup checkpoint publication could not preserve private-root ownership."
        );
      }
      const completedAt = currentTime();
      lastCheckpointAt = completedAt;
    },
    remainingTimeout(requestedTimeoutMs) {
      if (!Number.isSafeInteger(requestedTimeoutMs) || requestedTimeoutMs <= 0) {
        throw new Error("Remote Jupyter setup operation timeout is invalid.");
      }
      const remaining = Math.floor(deadline - currentTime());
      if (remaining <= 0) {
        throw new Error("Remote Jupyter setup exceeded its fixed aggregate deadline.");
      }
      return Math.min(requestedTimeoutMs, remaining);
    }
  });
}

function createRemoteJupyterSetupDockerClient(docker, budget, defaultTimeoutMs) {
  let commandSequence = 0;
  return Object.freeze({
    async required(args, label, timeoutMs = defaultTimeoutMs, stdin) {
      commandSequence += 1;
      const command = `setup:docker-${commandSequence}`;
      budget.checkpoint(`${command}:start`);
      const result = await docker.required(args, label, budget.remainingTimeout(timeoutMs), stdin, {
        intervalMs: budget.heartbeatMs,
        onProgress: () => budget.checkpoint(`${command}:active`)
      });
      budget.checkpoint(`${command}:complete`);
      return result;
    }
  });
}

function createDockerClient({ dockerExecutable, environment, runCommand, dockerTimeoutMs, token }) {
  return Object.freeze({
    async required(args, label, timeoutMs = dockerTimeoutMs, stdin, progress) {
      let result;
      try {
        result = await runCommand(
          {
            executable: dockerExecutable,
            args,
            environment,
            stdin,
            label
          },
          {
            timeoutMs,
            maxOutputBytes: DOCKER_OUTPUT_MAX_BYTES,
            ...(progress
              ? {
                  progressIntervalMs: progress.intervalMs,
                  onProgress: progress.onProgress
                }
              : {})
          }
        );
      } catch (error) {
        if (dockerCommandCompletionUnknown(error) || remoteJupyterOwnershipMayBeLive(error)) throw error;
        throw new Error(`${label} failed.`);
      }
      if (
        !isPlainObject(result) ||
        !Number.isInteger(result.exitCode) ||
        typeof result.stdout !== "string" ||
        typeof result.stderr !== "string" ||
        Buffer.byteLength(result.stdout, "utf8") + Buffer.byteLength(result.stderr, "utf8") > DOCKER_OUTPUT_MAX_BYTES ||
        result.exitCode !== 0
      ) {
        throw new Error(`${label} failed.`);
      }
      if (result.stdout.includes(token) || result.stderr.includes(token)) {
        throw new Error(`${label} returned forbidden authentication material.`);
      }
      return result;
    }
  });
}

async function probeDockerEngine(docker) {
  const version = oneLine(
    (await docker.required(["version", "--format", "{{.Server.Version}}"], "Remote Jupyter Docker version probe"))
      .stdout,
    "Docker version report"
  );
  if (!BOUNDED_DOCKER_VERSION.test(version)) {
    throw new Error("Remote Jupyter acceptance requires a bounded Linux Docker Engine.");
  }

  const context = await docker.required(["context", "show"], "Remote Jupyter Docker context probe");
  const contextName = oneLine(context.stdout, "Docker context report");
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/u.test(contextName)) {
    throw new Error("Remote Jupyter Docker context identity is malformed.");
  }

  const info = await docker.required(
    ["info", "--format", "{{.ID}}\t{{.OSType}}\t{{.Architecture}}\t{{.ServerVersion}}"],
    "Remote Jupyter Docker engine identity probe"
  );
  const infoFields = oneLine(info.stdout, "Docker engine identity report").split("\t");
  if (
    infoFields.length !== 4 ||
    !ENGINE_ID.test(infoFields[0]) ||
    infoFields[1] !== "linux" ||
    !["amd64", "x86_64"].includes(infoFields[2]) ||
    infoFields[3] !== version
  ) {
    throw new Error("Remote Jupyter Docker engine identity is malformed or inconsistent.");
  }
  return Object.freeze({
    engineId: infoFields[0],
    contextName,
    version,
    operatingSystem: infoFields[1],
    architecture: infoFields[2]
  });
}

function assertSameDockerEngine(expected, actual) {
  if (
    !expected ||
    !actual ||
    expected.engineId !== actual.engineId ||
    expected.contextName !== actual.contextName ||
    expected.version !== actual.version ||
    expected.operatingSystem !== actual.operatingSystem ||
    expected.architecture !== actual.architecture
  ) {
    throw new Error("Remote Jupyter Docker engine identity changed during the acceptance run.");
  }
}

async function assertContainerNameAvailable(docker, name) {
  const ids = await listContainerIds(docker, `name=^/${name}$`, "Remote Jupyter container-name probe");
  if (ids.length !== 0) {
    throw new Error("Remote Jupyter random container name was already in use.");
  }
}

async function assertOwnerLabelAvailable(docker, ownerId) {
  const containers = await listContainerIds(
    docker,
    `label=${OWNER_LABEL}=${ownerId}`,
    "Remote Jupyter container ownership-label probe"
  );
  const images = await listImageIds(
    docker,
    `label=${OWNER_LABEL}=${ownerId}`,
    "Remote Jupyter image ownership-label probe"
  );
  if (containers.length !== 0 || images.length !== 0) {
    throw new Error("Remote Jupyter random ownership label was already in use.");
  }
}

async function assertOwnedImage(docker, resources) {
  if (!IMAGE_ID.test(resources.imageId ?? "")) {
    throw new Error("Remote Jupyter image identity is unavailable.");
  }
  const inspected = await docker.required(
    ["image", "inspect", "--format", `{{.Id}}\t{{index .Config.Labels "${OWNER_LABEL}"}}`, resources.imageId],
    "Remote Jupyter owned-image inspection"
  );
  const fields = oneLine(inspected.stdout, "Remote Jupyter image inspection").split("\t");
  if (fields.length !== 2 || fields[0] !== resources.imageId || fields[1] !== resources.ownerId) {
    throw new Error("Remote Jupyter image ownership could not be proven.");
  }
}

async function assertOwnedContainer(docker, resources, { requireRunning, requireIsolation = true }) {
  if (!CONTAINER_ID.test(resources.containerId ?? "")) {
    throw new Error("Remote Jupyter container identity is unavailable.");
  }
  const inspected = await docker.required(
    ["container", "inspect", "--format", CONTAINER_INSPECT_FORMAT, resources.containerId],
    "Remote Jupyter owned-container inspection"
  );
  const fields = oneLine(inspected.stdout, "Remote Jupyter container inspection").split("\t");
  if (fields.length !== 19) {
    throw new Error("Remote Jupyter container inspection was malformed.");
  }
  const [
    id,
    name,
    image,
    owner,
    user,
    hostname,
    environmentJson,
    running,
    readOnly,
    restart,
    pids,
    memory,
    memorySwap,
    nanoCpus,
    capDropJson,
    securityOptionsJson,
    bindsJson,
    tmpfsJson,
    networkMode
  ] = fields;
  const capDrop = parseJson(capDropJson, "Remote Jupyter capability inspection");
  const containerEnvironment = parseJson(environmentJson, "Remote Jupyter environment inspection");
  const securityOptions = parseJson(securityOptionsJson, "Remote Jupyter security-option inspection");
  const binds = parseJson(bindsJson, "Remote Jupyter bind-mount inspection");
  const tmpfs = parseJson(tmpfsJson, "Remote Jupyter tmpfs inspection");
  const remoteRunEnvironment = Array.isArray(containerEnvironment)
    ? containerEnvironment.filter(
        (value) => typeof value === "string" && value.startsWith("OPEN_WRANGLER_REMOTE_RUN_ID=")
      )
    : [];
  if (
    id !== resources.containerId ||
    name !== `/${resources.containerName}` ||
    image !== resources.imageId ||
    owner !== resources.ownerId ||
    hostname !== resources.hostname ||
    !Array.isArray(containerEnvironment) ||
    containerEnvironment.some((value) => typeof value !== "string") ||
    remoteRunEnvironment.length !== 1 ||
    remoteRunEnvironment[0] !== `OPEN_WRANGLER_REMOTE_RUN_ID=${resources.runId}` ||
    containerEnvironment.some((value) => /OPEN_WRANGLER_REMOTE_TOKEN|JUPYTER_TOKEN/u.test(String(value)))
  ) {
    throw new Error("Remote Jupyter container ownership could not be proven.");
  }
  if (requireIsolation) {
    const isolationFailures = [];
    if (user !== "65532:65532") isolationFailures.push("user");
    if (!["true", "false"].includes(running) || (requireRunning && running !== "true")) {
      isolationFailures.push("running-state");
    }
    if (readOnly !== "true") isolationFailures.push("read-only-rootfs");
    if (restart !== "no") isolationFailures.push("restart-policy");
    if (pids !== "256") isolationFailures.push("pids-limit");
    if (memory !== "1073741824") isolationFailures.push("memory-limit");
    if (memorySwap !== "1073741824") isolationFailures.push("memory-swap-limit");
    if (nanoCpus !== "2000000000") isolationFailures.push("cpu-limit");
    if (!Array.isArray(capDrop) || capDrop.length !== 1 || capDrop[0] !== "ALL") {
      isolationFailures.push("capabilities");
    }
    if (
      !Array.isArray(securityOptions) ||
      securityOptions.length !== 1 ||
      !NO_NEW_PRIVILEGES_OPTIONS.has(securityOptions[0])
    ) {
      isolationFailures.push("no-new-privileges");
    }
    if (!(binds === null || (Array.isArray(binds) && binds.length === 0))) {
      isolationFailures.push("host-binds");
    }
    const tmpfsIsPlainObject = isPlainObject(tmpfs);
    if (!tmpfsIsPlainObject || Object.keys(tmpfs).length !== 2) {
      isolationFailures.push("tmpfs-shape");
    }
    if (
      tmpfsIsPlainObject &&
      !hasTmpfsProtections(tmpfs["/tmp"], ["noexec", "nosuid", "nodev", "size=536870912", "mode=1777"])
    ) {
      isolationFailures.push("tmpfs-temporary");
    }
    if (
      tmpfsIsPlainObject &&
      !hasTmpfsProtections(tmpfs["/run/openwrangler"], [
        "noexec",
        "nosuid",
        "nodev",
        "size=65536",
        "mode=0700",
        "uid=65532",
        "gid=65532"
      ])
    ) {
      isolationFailures.push("tmpfs-runtime");
    }
    if (networkMode !== "bridge") isolationFailures.push("network-mode");
    if (isolationFailures.length !== 0) {
      throw new Error(`Remote Jupyter container isolation could not be proven [${isolationFailures.join(",")}].`);
    }
  }
}

async function injectAuthenticationToken(docker, containerId, token) {
  const input = Buffer.from(token, "ascii");
  try {
    await docker.required(
      ["exec", "--interactive", "--user=65532:65532", containerId, "python", "-I", "/opt/openwrangler/inject-token.py"],
      "Remote Jupyter authentication injection",
      DEFAULT_DOCKER_TIMEOUT_MS,
      input
    );
  } finally {
    input.fill(0);
  }
}

async function resolveLoopbackBaseUrl(docker, containerId) {
  const port = await docker.required(
    ["port", containerId, `${CONTAINER_PORT}/tcp`],
    "Remote Jupyter loopback-port inspection"
  );
  const match = /^127\.0\.0\.1:([0-9]{1,5})$/u.exec(oneLine(port.stdout, "Remote Jupyter port report"));
  const value = Number(match?.[1]);
  if (!match || !Number.isSafeInteger(value) || value < 1 || value > 65535) {
    throw new Error("Remote Jupyter container was not published on one safe loopback port.");
  }
  return `http://127.0.0.1:${value}`;
}

async function waitForJupyterStatus(
  baseUrl,
  token,
  fixtureDefinition,
  { fetchImpl, now, sleep, timeoutMs, progressIntervalMs, onProgress }
) {
  const deadline = now() + timeoutMs;
  let nextProgressAt = now() + progressIntervalMs;
  while (now() <= deadline) {
    const iterationStartedAt = now();
    if (iterationStartedAt >= nextProgressAt) {
      onProgress();
      nextProgressAt = iterationStartedAt + progressIntervalMs;
    }
    const remaining = Math.max(1, deadline - now());
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.min(3_000, remaining));
    try {
      const response = await fetchImpl(`${baseUrl}/api/status`, {
        method: "GET",
        redirect: "error",
        headers: {
          accept: "application/json",
          authorization: `token ${token}`
        },
        signal: controller.signal
      });
      if (
        response?.status === 200 &&
        /^application\/json(?:\s*;|$)/iu.test(response.headers?.get?.("content-type") ?? "")
      ) {
        const report = await readBoundedJsonResponse(response);
        if (
          isPlainObject(report) &&
          Number.isSafeInteger(report.connections) &&
          report.connections >= 0 &&
          Number.isSafeInteger(report.kernels) &&
          report.kernels >= 0
        ) {
          const kernelspecResponse = await fetchImpl(`${baseUrl}/api/kernelspecs`, {
            method: "GET",
            redirect: "error",
            headers: {
              accept: "application/json",
              authorization: `token ${token}`
            },
            signal: controller.signal
          });
          if (
            kernelspecResponse?.status === 200 &&
            /^application\/json(?:\s*;|$)/iu.test(kernelspecResponse.headers?.get?.("content-type") ?? "") &&
            isExpectedRemoteKernelspec(await readBoundedJsonResponse(kernelspecResponse), fixtureDefinition)
          ) {
            return;
          }
        }
      }
    } catch {
      // Startup races and rejected requests are retried only within the fixed deadline.
    } finally {
      clearTimeout(timer);
    }
    if (now() >= deadline) break;
    await sleep(Math.min(POLL_INTERVAL_MS, Math.max(1, deadline - now())));
  }
  throw new Error("Remote Jupyter Server did not become ready within its fixed deadline.");
}

function isExpectedRemoteKernelspec(report, fixtureDefinition) {
  if (!isPlainObject(report) || !isPlainObject(report.kernelspecs)) return false;
  const candidate = report.kernelspecs[fixtureDefinition.kernelName];
  if (!isPlainObject(candidate) || candidate.name !== fixtureDefinition.kernelName || !isPlainObject(candidate.spec)) {
    return false;
  }
  const { argv, display_name: displayName, language } = candidate.spec;
  if (
    !Array.isArray(argv) ||
    argv.length !== 6 ||
    typeof argv[0] !== "string" ||
    !argv[0].startsWith("/") ||
    argv.slice(1).some((value) => typeof value !== "string") ||
    displayName !== fixtureDefinition.kernelLabel ||
    language !== fixtureDefinition.language
  ) {
    return false;
  }
  return fixtureDefinition.language === "python"
    ? argv[1] === "-Xfrozen_modules=off" &&
        argv[2] === "-m" &&
        argv[3] === "ipykernel_launcher" &&
        argv[4] === "-f" &&
        argv[5] === "{connection_file}"
    : argv[1] === "--slave" &&
        argv[2] === "-e" &&
        argv[3] === "IRkernel::main()" &&
        argv[4] === "--args" &&
        argv[5] === "{connection_file}";
}

async function readBoundedJsonResponse(response) {
  const contentLength = response.headers?.get?.("content-length");
  if (
    contentLength !== null &&
    contentLength !== undefined &&
    (!/^[0-9]{1,8}$/u.test(contentLength) || Number(contentLength) > STATUS_MAX_BYTES)
  ) {
    throw new Error("Remote Jupyter status exceeded its fixed response bound.");
  }
  if (!response.body || typeof response.body.getReader !== "function") {
    throw new Error("Remote Jupyter status did not provide a bounded response stream.");
  }
  const reader = response.body.getReader();
  const chunks = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!(value instanceof Uint8Array)) {
        throw new Error("Remote Jupyter status returned an invalid response chunk.");
      }
      length += value.byteLength;
      if (length > STATUS_MAX_BYTES) {
        await reader.cancel();
        throw new Error("Remote Jupyter status exceeded its fixed response bound.");
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return parseJson(Buffer.concat(chunks).toString("utf8"), "Remote Jupyter status");
}

function createCleanupHandle({ docker, initialEngine, resources, now, sleep, cleanupTimeoutMs }) {
  let cleanupPromise;
  let cleaned = false;
  let uncertain = false;
  return async function cleanup() {
    if (cleaned) return;
    if (uncertain) {
      throw ownershipUncertainError("Remote Jupyter Docker cleanup remains ownership-uncertain.");
    }
    if (cleanupPromise) return await cleanupPromise;
    cleanupPromise = (async () => {
      const deadline = now() + cleanupTimeoutMs;
      const cleanupDocker = createDeadlineDockerClient(docker, now, deadline);
      try {
        if (!initialEngine) {
          if (!resources.mutationStarted) {
            cleaned = true;
            return;
          }
          const possibleContainers = await listContainerIds(
            cleanupDocker,
            `name=^/${resources.containerName}$`,
            "Remote Jupyter failed-start container discovery"
          );
          const possibleImages = await listImageIds(
            cleanupDocker,
            `label=${OWNER_LABEL}=${resources.ownerId}`,
            "Remote Jupyter failed-start image discovery"
          );
          if (possibleContainers.length !== 0 || possibleImages.length !== 0) {
            throw new Error("Remote Jupyter Docker ownership was not established before cleanup.");
          }
          cleaned = true;
          return;
        }

        assertSameDockerEngine(initialEngine, await probeDockerEngine(cleanupDocker));
        await removeOwnedContainer(cleanupDocker, resources, {
          now,
          sleep,
          deadline
        });
        await removeOwnedImage(cleanupDocker, resources, {
          now,
          sleep,
          deadline
        });
        assertSameDockerEngine(initialEngine, await probeDockerEngine(cleanupDocker));
        await assertResourcesAbsent(cleanupDocker, resources);
        if (resources.buildOwnershipUncertain || resources.launchOwnershipUncertain) {
          throw ownershipUncertainError("Remote Jupyter Docker command completion remained ownership-uncertain.");
        }
        cleaned = true;
      } catch {
        uncertain = true;
        throw ownershipUncertainError("Remote Jupyter Docker resource disappearance could not be proven.");
      }
    })();
    try {
      await cleanupPromise;
    } finally {
      cleanupPromise = undefined;
    }
  };
}

function createDeadlineDockerClient(docker, now, deadline) {
  return Object.freeze({
    async required(args, label, _timeoutMs, stdin) {
      const remaining = Math.floor(deadline - now());
      if (remaining <= 0) {
        throw new Error("Remote Jupyter Docker cleanup exceeded its fixed deadline.");
      }
      return await docker.required(args, label, remaining, stdin);
    }
  });
}

async function removeOwnedContainer(docker, resources, { now, sleep, deadline }) {
  let containerId = resources.containerId;
  if (!containerId) {
    const named = await listContainerIds(
      docker,
      `name=^/${resources.containerName}$`,
      "Remote Jupyter cleanup container discovery"
    );
    if (named.length === 0) return;
    if (named.length !== 1) {
      throw new Error("Remote Jupyter cleanup found ambiguous container ownership.");
    }
    containerId = named[0];
    resources.containerId = containerId;
  }

  const present = await listContainerIds(
    docker,
    `id=${containerId}`,
    "Remote Jupyter cleanup container identity probe"
  );
  if (present.length === 0) {
    const sameName = await listContainerIds(
      docker,
      `name=^/${resources.containerName}$`,
      "Remote Jupyter cleanup container-name disappearance probe"
    );
    if (sameName.length !== 0) {
      throw new Error("Remote Jupyter container name was reused before cleanup completed.");
    }
    return;
  }
  if (present.length !== 1 || present[0] !== containerId) {
    throw new Error("Remote Jupyter cleanup found ambiguous container identity.");
  }
  await assertOwnedContainer(docker, resources, {
    requireRunning: false,
    requireIsolation: false
  });
  await docker.required(["container", "rm", "--force", containerId], "Remote Jupyter owned-container removal");
  await waitForAbsence(
    async () =>
      (await listContainerIds(docker, `id=${containerId}`, "Remote Jupyter container disappearance probe")).length ===
      0,
    { now, sleep, deadline, label: "Remote Jupyter container" }
  );
  const sameName = await listContainerIds(
    docker,
    `name=^/${resources.containerName}$`,
    "Remote Jupyter container-name final probe"
  );
  if (sameName.length !== 0) {
    throw new Error("Remote Jupyter container name remained occupied after cleanup.");
  }
}

async function removeOwnedImage(docker, resources, { now, sleep, deadline }) {
  const owned = await listImageIds(
    docker,
    `label=${OWNER_LABEL}=${resources.ownerId}`,
    "Remote Jupyter cleanup image discovery"
  );
  if (owned.length === 0) return;
  if (owned.length !== 1) {
    throw new Error("Remote Jupyter cleanup found ambiguous image ownership.");
  }
  if (resources.imageId && owned[0] !== resources.imageId) {
    throw new Error("Remote Jupyter cleanup image identity changed.");
  }
  resources.imageId = owned[0];
  await assertOwnedImage(docker, resources);
  await docker.required(["image", "rm", resources.imageId], "Remote Jupyter owned-image removal");
  await waitForAbsence(
    async () =>
      (
        await listImageIds(
          docker,
          `label=${OWNER_LABEL}=${resources.ownerId}`,
          "Remote Jupyter image disappearance probe"
        )
      ).length === 0,
    { now, sleep, deadline, label: "Remote Jupyter image" }
  );
}

async function assertResourcesAbsent(docker, resources) {
  const byName = await listContainerIds(
    docker,
    `name=^/${resources.containerName}$`,
    "Remote Jupyter final container-name probe"
  );
  const byOwner = await listContainerIds(
    docker,
    `label=${OWNER_LABEL}=${resources.ownerId}`,
    "Remote Jupyter final container-label probe"
  );
  const images = await listImageIds(
    docker,
    `label=${OWNER_LABEL}=${resources.ownerId}`,
    "Remote Jupyter final image-label probe"
  );
  if (byName.length !== 0 || byOwner.length !== 0 || images.length !== 0) {
    throw new Error("Remote Jupyter Docker resources remained after cleanup.");
  }
}

async function waitForAbsence(check, { now, sleep, deadline, label }) {
  while (now() <= deadline) {
    if (await check()) return;
    if (now() >= deadline) break;
    await sleep(Math.min(POLL_INTERVAL_MS, Math.max(1, deadline - now())));
  }
  throw new Error(`${label} did not disappear within its fixed cleanup deadline.`);
}

async function listContainerIds(docker, filter, label) {
  const result = await docker.required(
    ["container", "ls", "--all", "--quiet", "--no-trunc", "--filter", filter],
    label
  );
  return parseIdLines(result.stdout, CONTAINER_ID, "container");
}

async function listImageIds(docker, filter, label) {
  const result = await docker.required(["image", "ls", "--all", "--quiet", "--no-trunc", "--filter", filter], label);
  return parseIdLines(result.stdout, IMAGE_ID, "image");
}

function parseIdLines(stdout, pattern, kind) {
  const trimmed = stdout.trim();
  if (trimmed === "") return [];
  const ids = trimmed.split(/\r?\n/u);
  if (ids.length > 8 || ids.some((id) => !pattern.test(id)) || new Set(ids).size !== ids.length) {
    throw new Error(`Remote Jupyter Docker ${kind} listing was malformed or ambiguous.`);
  }
  return ids;
}

function parseExactImageId(stdout, label) {
  const value = oneLine(stdout, label);
  if (!IMAGE_ID.test(value)) throw new Error(`${label} did not return one exact image identity.`);
  return value;
}

function parseExactContainerId(stdout, label) {
  const value = oneLine(stdout, label);
  if (!CONTAINER_ID.test(value)) {
    throw new Error(`${label} did not return one exact container identity.`);
  }
  return value;
}

function oneLine(stdout, label) {
  if (typeof stdout !== "string") throw new Error(`${label} was malformed.`);
  const value = stdout.endsWith("\n") ? stdout.slice(0, -1) : stdout;
  if (value.length === 0 || value.length > 8_192 || /[\0\r\n]/u.test(value)) {
    throw new Error(`${label} was malformed.`);
  }
  return value;
}

function hasTmpfsProtections(value, expected) {
  if (typeof value !== "string" || /[\0\r\n]/u.test(value)) return false;
  const options = new Set(value.split(","));
  return expected.every((option) => options.has(option));
}

function parseJson(value, label) {
  try {
    return JSON.parse(value);
  } catch {
    throw new Error(`${label} was malformed.`);
  }
}

function safeFailure(error, token) {
  const fallback = "Remote Jupyter acceptance failed.";
  if (!(error instanceof Error) || typeof error.message !== "string") return new Error(fallback);
  const redacted = error.message.split(token).join("<redacted>");
  if (redacted.length === 0 || redacted.length > 512 || /[\0\r\n]/u.test(redacted) || redacted.includes(token)) {
    return new Error(fallback);
  }
  return new Error(redacted);
}

function ownershipUncertainError(message) {
  const error = new Error(message);
  error.code = REMOTE_JUPYTER_OWNERSHIP_UNCERTAIN_CODE;
  return error;
}

function dockerCommandCompletionUnknownError(message) {
  const error = new Error(message);
  error.code = DOCKER_COMPLETION_UNKNOWN_CODE;
  return error;
}

function dockerCommandCompletionUnknown(error) {
  return error?.code === DOCKER_COMPLETION_UNKNOWN_CODE;
}

function killDockerProcessGroup(child, signal, platform) {
  if (!Number.isSafeInteger(child?.pid) || child.pid <= 0) {
    throw new Error("Remote Jupyter Docker process identity was unavailable.");
  }
  if (platform === "win32") {
    if (!child.kill(signal)) {
      throw new Error("Remote Jupyter Docker process termination could not be requested.");
    }
    return;
  }
  process.kill(-child.pid, signal);
}

function createCheckedMonotonicClock(now) {
  let previous = Number.NEGATIVE_INFINITY;
  return () => {
    const current = now();
    if (!Number.isFinite(current) || current < previous) {
      throw new Error("Remote Jupyter acceptance monotonic time source regressed or became invalid.");
    }
    previous = current;
    return current;
  };
}

function validateExecutable(value) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    /[\0\r\n]/u.test(value) ||
    (value !== "docker" && !isAbsolute(value))
  ) {
    throw new Error("Remote Jupyter acceptance requires docker or one absolute Docker executable path.");
  }
}

function validateAbsoluteSingleLine(value, label) {
  if (typeof value !== "string" || !isAbsolute(value) || /[\0\r\n]/u.test(value)) {
    throw new Error(`${label} must be one absolute single-line path.`);
  }
}

function validateTimeout(label, value) {
  if (!Number.isSafeInteger(value) || value < 100 || value > 600_000) {
    throw new Error(`${label} is outside its fixed safety bounds.`);
  }
}

function isPlainObject(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
  );
}

function isEnvironment(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.entries(value).every(
      ([key, entry]) => /^[A-Za-z_][A-Za-z0-9_]*$/u.test(key) && typeof entry === "string" && !/[\0]/u.test(entry)
    )
  );
}
