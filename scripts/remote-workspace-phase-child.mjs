import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  opendirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  statfsSync
} from "node:fs";
import { join } from "node:path";
import {
  assertRemoteWorkspaceResultLease,
  classifyRemoteWorkspaceResultWaitObservation,
  closeRemoteWorkspaceResultLease,
  createRemoteWorkspaceDropbearLoaderArguments,
  finalizeRemoteWorkspaceControllerFailure,
  inspectRemoteWorkspaceLogTopology,
  openRemoteWorkspaceResultLeaseIfPresent,
  parseRemoteWorkspacePhaseDescriptor,
  publishRemoteWorkspaceControllerFailureResult,
  readBoundedRemoteWorkspaceFile,
  validateRemoteWorkspacePhaseDescriptorPath,
  validateRemoteWorkspacePhaseDescriptor,
  validateRemoteWorkspaceBootstrapAttestation,
  validateRemoteWorkspaceDropbearLoaderResolution,
  validateRemoteWorkspaceLibstdcxxResolution,
  validateRemoteWorkspaceProcfsType,
  validateRemoteSshLogAttestation,
  validateRemoteWorkspaceZeroCapabilities
} from "./remote-workspace-contract.mjs";
import {
  assertRemoteWorkspaceDisplayReceipt,
  captureRemoteWorkspaceDisplayReceipt,
  spawnMonitoredRemoteWorkspaceChild
} from "./remote-workspace-processes.mjs";

const POLL_MS = 250;
const STOP_GRACE_MS = 5_000;
const OUTPUT_LIMIT_BYTES = 64 * 1024;
const MAX_LOG_FILES = 1_000;
const MAX_REMOTE_SSH_LOG_BYTES = 2 * 1024 * 1024;
const PRIVATE_DISPLAY = ":99";
const PRIVATE_DISPLAY_DIRECTORY = "/tmp/.X11-unix";
const PRIVATE_DISPLAY_SOCKET = `${PRIVATE_DISPLAY_DIRECTORY}/X99`;
const PRIVATE_DISPLAY_LOCK = "/tmp/.X99-lock";
const PRIVATE_VSCODE_LIBSTDCXX = "/usr/lib64/libstdc++.so.6";
const REMOTE_WORKSPACE_PROGRESS_CHECKPOINTS = new Set([
  "remote-workspace:harness-start",
  "preflight:start",
  "activation:start",
  "activation:complete",
  "preflight:package",
  "preflight:commands",
  "preflight:contributions",
  "preflight:complete",
  "remote-workspace:start",
  "remote-workspace:open",
  "remote-workspace:filter",
  "remote-workspace:cleanup",
  "remote-workspace:complete"
]);
const [descriptorPath, ipExecutable, sshExecutable, dynamicLoader, mode] = process.argv.slice(2);
let descriptor;

class RemoteWorkspaceResultWaitError extends Error {}

try {
  if (mode !== undefined && mode !== "--bootstrap-preflight") {
    throw new Error("The Remote SSH phase child received an unknown launch mode.");
  }
  descriptor = readDescriptor(descriptorPath, { filesystem: false });
  if (mode === "--bootstrap-preflight") {
    validateRemoteWorkspacePhaseDescriptor(descriptor);
    assertPrivateNamespace(descriptor);
    assertBootstrapExecutables(descriptor, ipExecutable, sshExecutable, dynamicLoader);
    assertPrivateDisplayEmpty();
    if (liveNamespaceChildren().length !== 0) {
      throw new Error("The Remote SSH bootstrap preflight retained a namespace child.");
    }
    const capabilities = validateRemoteWorkspaceZeroCapabilities(readFileSync("/proc/self/status", "utf8"));
    const attestation = `${JSON.stringify({
      protocol: 1,
      runId: descriptor.runId,
      phase: descriptor.phase,
      kind: "bootstrap-preflight",
      filesystem: "validated",
      namespaceEmpty: true,
      capabilities
    })}\n`;
    validateRemoteWorkspaceBootstrapAttestation(attestation, { runId: descriptor.runId });
    process.stdout.write(attestation);
  } else {
    // Filesystem state and namespace identity are launch authority. Any
    // mismatch remains non-publishable even if a later observation passes.
    validateRemoteWorkspacePhaseDescriptor(descriptor);
    assertPrivateNamespace(descriptor);
    let controllerFailureCode = "phase-setup-failed";
    let existingResultReceipt;
    let terminal;
    try {
      terminal = await runPhase(
        descriptor,
        ipExecutable,
        sshExecutable,
        (code) => {
          controllerFailureCode = code;
        },
        (receipt) => {
          existingResultReceipt = receipt;
        }
      );
    } catch {
      terminal = await recoverRemoteWorkspaceControllerFailure(
        descriptor,
        controllerFailureCode,
        existingResultReceipt
      );
    }
    process.stdout.write(
      `${JSON.stringify({
        protocol: 1,
        runId: descriptor.runId,
        phase: descriptor.phase,
        namespaceEmpty: true,
        network: "unshared",
        ipc: "unshared",
        uts: "unshared",
        hostname: "openwrangler-remote-acceptance",
        display: "xvfb",
        displayEmpty: true,
        remoteAuthority: descriptor.authority,
        version: descriptor.version,
        commit: descriptor.commit,
        candidateSha256: descriptor.candidateSha256,
        candidateBytes: descriptor.candidateBytes,
        remoteSshVersion: descriptor.remoteSshVersion,
        remoteSshBytes: descriptor.remoteSshBytes,
        remoteSshSha256: descriptor.remoteSshSha256,
        hostIsolationSha256: descriptor.hostIsolationSha256,
        outcome: terminal.outcome,
        ...(terminal.controllerCode
          ? {
              controllerCode: terminal.controllerCode,
              resultOutcome: terminal.resultOutcome
            }
          : {}),
        resultBytes: terminal.resultBytes,
        resultSha256: terminal.resultSha256,
        capabilities: terminal.capabilities
      })}\n`
    );
  }
} catch (error) {
  const root = descriptor?.paths?.root;
  const raw = error instanceof Error ? error.message : String(error);
  const sanitized = sanitizeFailure(raw, root);
  process.stderr.write(`Remote SSH acceptance failed: ${sanitized}\n`);
  process.exitCode = 1;
}

async function recoverRemoteWorkspaceControllerFailure(config, code, existingResultReceipt) {
  return finalizeRemoteWorkspaceControllerFailure({
    stopChildren: () => stopNamespaceChildren([]),
    assertDisplayEmpty: assertPrivateDisplayEmpty,
    assertNamespace: () => assertPrivateNamespace(config),
    captureCapabilities: () => validateRemoteWorkspaceZeroCapabilities(readFileSync("/proc/self/status", "utf8")),
    observedResultReceipt: existingResultReceipt,
    code,
    publishResult: (code) =>
      publishRemoteWorkspaceControllerFailureResult(config.paths.result, {
        runId: config.runId,
        code
      })
  });
}

function assertBootstrapExecutables(config, ip, ssh, loader) {
  assertExecutable(ip, "private-network setup");
  assertExecutable(ssh, "private SSH client");
  assertExecutable(loader, "private SSH dynamic loader");
  assertExecutable(config.xvfb, "private Xvfb executable");
  assertExecutable(config.editor, "private editor executable");
  assertExecutable(config.python, "private Python executable");
  assertExecutable(config.sshServer, "private SSH daemon");
  const loopback = runSync(ip, ["address", "show", "lo"], "private bootstrap loopback setup");
  if (!loopback.stdout.includes("127.0.0.1")) {
    throw new Error("The private bootstrap loopback network was not initialized.");
  }
  runSync(
    loader,
    createRemoteWorkspaceDropbearLoaderArguments({
      sshServer: config.sshServer,
      sshLibraryPath: config.sshLibraryPath,
      dropbearArguments: ["-V"]
    }),
    "private bootstrap Dropbear fork-only dynamic-loader probe"
  );
  validateRemoteWorkspaceDropbearLoaderResolution(
    runSync(loader, ["--list", config.sshServer], "private bootstrap Dropbear default-loader listing").stdout
  );
  validateRemoteWorkspaceLibstdcxxResolution(
    runSync(
      "/usr/bin/readlink",
      ["-f", PRIVATE_VSCODE_LIBSTDCXX],
      "private bootstrap VS Code CLI compatibility-library probe"
    ).stdout
  );
  runSync(config.sshServer, ["-V"], "private bootstrap Dropbear default-loader probe");
}

async function runPhase(config, ip, ssh, setControllerFailureCode, setExistingResultReceipt) {
  let currentFailureCode;
  const markFailureStage = (code) => {
    currentFailureCode = code;
    setControllerFailureCode(code);
  };
  markFailureStage("phase-setup-failed");
  assertExecutable(ip, "private-network setup");
  assertExecutable(ssh, "private SSH client");
  assertExecutable(dynamicLoader, "private SSH dynamic loader");
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
    dynamicLoader,
    createRemoteWorkspaceDropbearLoaderArguments({
      sshServer,
      sshLibraryPath,
      dropbearArguments: ["-V"]
    }),
    "private Dropbear fork-only dynamic-loader probe"
  );
  validateRemoteWorkspaceDropbearLoaderResolution(
    runSync(dynamicLoader, ["--list", sshServer], "private Dropbear default-loader listing").stdout
  );
  validateRemoteWorkspaceLibstdcxxResolution(
    runSync("/usr/bin/readlink", ["-f", PRIVATE_VSCODE_LIBSTDCXX], "private VS Code CLI compatibility-library probe")
      .stdout
  );
  runSync(sshServer, ["-V"], "private Dropbear default-loader probe");

  markFailureStage("phase-display-failed");
  const xvfb = await startPrivateXvfb(config);
  const sshdOutput = boundedOutput();
  const editorOutput = boundedOutput();
  let sshd;
  let editor;
  let resultLease;
  let phaseError;
  let phaseFailureCode;
  let resultWaitCanBeClassified = false;
  const resultWaitObservation = { lastProgressCheckpoint: null };
  try {
    markFailureStage("phase-ssh-daemon-failed");
    sshd = spawnMonitoredRemoteWorkspaceChild(
      "The private loopback SSH daemon",
      dynamicLoader,
      createRemoteWorkspaceDropbearLoaderArguments({
        sshServer,
        sshLibraryPath,
        dropbearArguments: [
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
        ]
      }),
      {
        detached: true,
        env: remoteServerEnvironment(config),
        stdio: ["ignore", "ignore", "pipe"]
      }
    );
    sshd.child.stderr.on("data", (chunk) => sshdOutput.append(chunk));
    await wait(350);
    try {
      sshd.assertRunning();
    } catch (error) {
      throw new Error(
        `The private loopback SSH daemon exited before Remote SSH connected.${sshdOutput.text() ? ` ${sshdOutput.text()}` : ""}`,
        { cause: error }
      );
    }
    markFailureStage("phase-ssh-probe-failed");
    runSync(
      ssh,
      [
        "-F",
        config.sshConfig,
        "ow-loopback",
        "/bin/sh",
        "-c",
        [
          '\'test -z "${LD_PRELOAD-}"',
          '&& test -z "${LD_LIBRARY_PATH-}"',
          '&& test -z "${LD_BIND_NOW-}"',
          '&& test -z "${LD_AUDIT-}"',
          '&& test -n "${OPEN_WRANGLER_TEST_MODULE-}"',
          '&& test -n "${OPEN_WRANGLER_TEST_RESULT-}"',
          '&& test "$(command -v getconf)" = /usr/bin/getconf',
          '&& test "$(command -v printenv)" = /usr/bin/printenv',
          '&& test "$(command -v ps)" = /usr/bin/ps',
          '&& test "$(/usr/bin/getconf LONG_BIT)" = 64',
          '&& test "$(/usr/bin/printenv HOME)" = "$HOME"',
          '&& /usr/bin/ps -p "$$" -o pid= >/dev/null',
          '&& printf %s "$HOME"\''
        ].join(" ")
      ],
      "private loopback SSH probe",
      config.paths.remoteHome
    );
    markFailureStage("phase-editor-start-failed");
    editor = spawnMonitoredRemoteWorkspaceChild(
      "Official VS Code",
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
    editor.child.stdout.on("data", (chunk) => editorOutput.append(chunk));
    editor.child.stderr.on("data", (chunk) => editorOutput.append(chunk));
    markFailureStage("phase-result-wait-failed");
    resultLease = await observeAcceptance(config, editor, resultWaitObservation);
  } catch (error) {
    phaseFailureCode = currentFailureCode;
    resultWaitCanBeClassified =
      phaseFailureCode === "phase-result-wait-failed" && error instanceof RemoteWorkspaceResultWaitError;
    const editorDiagnostic = sanitizeFailure(editorOutput.text(), config.paths.root);
    phaseError = editorDiagnostic
      ? new Error(`${error instanceof Error ? error.message : String(error)} Editor: ${editorDiagnostic}`, {
          cause: error
        })
      : error;
  }
  const cleanupErrors = [];
  try {
    assertRemoteWorkspaceDisplayReceipt(xvfb.displayReceipt);
  } catch (error) {
    markFailureStage("phase-cleanup-failed");
    cleanupErrors.push(error);
  }
  try {
    await stopNamespaceChildren([editor, sshd, xvfb.monitor].filter(Boolean));
  } catch (error) {
    markFailureStage("phase-cleanup-failed");
    cleanupErrors.push(error);
  }
  try {
    assertPrivateDisplayEmpty();
  } catch (error) {
    markFailureStage("phase-cleanup-failed");
    cleanupErrors.push(error);
  }
  let terminalError =
    cleanupErrors.length === 0
      ? undefined
      : cleanupErrors.length === 1
        ? cleanupErrors[0]
        : new AggregateError(cleanupErrors, "Private namespace cleanup had multiple failures.");
  if (phaseError) {
    const daemonDiagnostic = sshdOutput.text();
    if (daemonDiagnostic) {
      phaseError = new Error(
        `${phaseError instanceof Error ? phaseError.message : String(phaseError)} SSH daemon: ${daemonDiagnostic}`,
        { cause: phaseError }
      );
    }
    terminalError = terminalError
      ? new AggregateError([phaseError, terminalError], "The Remote SSH phase and namespace cleanup both failed.")
      : phaseError;
    if (cleanupErrors.length === 0 && phaseFailureCode) {
      markFailureStage(phaseFailureCode);
    }
  }
  if (phaseError && cleanupErrors.length === 0 && resultWaitCanBeClassified) {
    try {
      assertPrivateNamespace(config);
      validateRemoteWorkspaceZeroCapabilities(readFileSync("/proc/self/status", "utf8"));
      const topology = resultWaitObservation.lastProgressCheckpoint
        ? {
            clientLogCount: 0,
            remoteSshLogCount: 0,
            remoteAgentLogCount: 0,
            remoteExtensionHostLogCount: 0
          }
        : inspectRemoteWorkspaceLogTopology({
            localLogs: join(config.paths.userData, "logs"),
            remoteLogs: join(config.paths.remoteHome, ".vscode-server", "data", "logs"),
            uid: config.uid
          });
      markFailureStage(
        classifyRemoteWorkspaceResultWaitObservation({
          ...topology,
          lastProgressCheckpoint: resultWaitObservation.lastProgressCheckpoint
        })
      );
    } catch {
      markFailureStage("phase-result-wait-failed");
    }
  }

  let capabilities;
  if (!terminalError && resultLease) {
    try {
      const remoteSshLog = findRemoteSshLog(config.paths.userData);
      validateRemoteSshLogAttestation(readBoundedRemoteWorkspaceFile(remoteSshLog, MAX_REMOTE_SSH_LOG_BYTES));
      capabilities = validateRemoteWorkspaceZeroCapabilities(readFileSync("/proc/self/status", "utf8"));
      assertRemoteWorkspaceResultLease(resultLease);
    } catch (error) {
      markFailureStage("phase-result-validation-failed");
      terminalError = error;
    }
  }

  if (resultLease) {
    const receipt = Object.freeze({
      outcome: resultLease.outcome,
      resultBytes: resultLease.bytes,
      resultSha256: resultLease.sha256
    });
    try {
      closeRemoteWorkspaceResultLease(resultLease);
      setExistingResultReceipt(receipt);
    } catch (error) {
      if (cleanupErrors.length === 0) {
        markFailureStage("phase-result-validation-failed");
      }
      terminalError = terminalError
        ? new AggregateError([terminalError, error], "Remote SSH terminal validation and result close both failed.")
        : error;
    }
  }
  if (terminalError) throw terminalError;
  if (!resultLease || !capabilities) {
    markFailureStage("phase-result-wait-failed");
    throw new Error("The Remote SSH phase ended without one validated terminal result.");
  }
  return Object.freeze({
    outcome: resultLease.outcome,
    resultBytes: resultLease.bytes,
    resultSha256: resultLease.sha256,
    capabilities
  });
}

function assertPrivateNamespace(config) {
  if (
    readlinkSync("/proc/self/ns/pid") === config.hostPidNamespace ||
    readlinkSync("/proc/self/ns/net") === config.hostNetworkNamespace ||
    readlinkSync("/proc/self/ns/ipc") === config.hostIpcNamespace ||
    readlinkSync("/proc/self/ns/uts") === config.hostUtsNamespace ||
    readlinkSync("/proc/self/ns/user") === config.hostUserNamespace
  ) {
    throw new Error("The Remote SSH phase did not retain private user, PID, network, IPC, and UTS namespaces.");
  }
  validateRemoteWorkspaceProcfsType(statfsSync("/proc").type);
  const uidMap = readSingleIdMap("/proc/self/uid_map", config.uid);
  const gidMap = readSingleIdMap("/proc/self/gid_map", config.gid);
  if (uidMap.count !== 1 || gidMap.count !== 1) {
    throw new Error("The private user namespace exposed more than one user or group identity.");
  }
  const status = readFileSync("/proc/self/status", "utf8");
  validateRemoteWorkspaceZeroCapabilities(status);
  const privateRoot = lstatSync(config.paths.root);
  const hostRootExecutable = lstatSync("/usr/bin/bash");
  if (privateRoot.uid !== config.uid || hostRootExecutable.uid !== 65_534) {
    throw new Error("The private user map did not isolate the invoking user from host root.");
  }
  if (existsSync(config.hostHome) || existsSync(config.hostSentinel) || readdirSync("/home").length !== 0) {
    throw new Error("The private runtime exposed a host home or host-private sentinel.");
  }
  if (readFileSync("/proc/sys/kernel/hostname", "utf8").trim() !== "openwrangler-remote-acceptance") {
    throw new Error("The private UTS namespace did not retain its exact isolated hostname.");
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
  const monitor = spawnMonitoredRemoteWorkspaceChild(
    "The private Xvfb",
    config.xvfb,
    [PRIVATE_DISPLAY, "-screen", "0", "1280x720x24", "-nolisten", "tcp", "-noreset"],
    {
      detached: true,
      env: privateDisplayEnvironment(config.paths.localHome),
      stdio: ["ignore", "ignore", "pipe"]
    }
  );
  monitor.child.stderr.on("data", (chunk) => output.append(chunk));
  try {
    const deadline = Date.now() + 10_000;
    do {
      let pid;
      try {
        pid = monitor.assertRunning();
      } catch (error) {
        throw new Error(
          `The private Xvfb exited before its display became ready.${output.text() ? ` ${output.text()}` : ""}`,
          { cause: error }
        );
      }
      if (existsSync(PRIVATE_DISPLAY_SOCKET) && existsSync(PRIVATE_DISPLAY_LOCK)) {
        const displayReceipt = captureRemoteWorkspaceDisplayReceipt({
          directoryPath: PRIVATE_DISPLAY_DIRECTORY,
          socketPath: PRIVATE_DISPLAY_SOCKET,
          lockPath: PRIVATE_DISPLAY_LOCK,
          expectedEntry: "X99",
          uid: config.uid,
          pid
        });
        return Object.freeze({ monitor, displayReceipt });
      }
      await wait(50);
    } while (Date.now() < deadline);
    throw new Error(`The private Xvfb display did not become ready.${output.text() ? ` ${output.text()}` : ""}`);
  } catch (error) {
    let cleanupError;
    try {
      await stopNamespaceChildren([monitor]);
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

async function observeAcceptance(config, editor, observation) {
  const startedAt = Date.now();
  let lastCheckpointAt = startedAt;
  let lastCheckpoint;
  while (true) {
    const resultLease = acquireTimelyResult(config, startedAt);
    if (resultLease) return resultLease;
    if (existsSync(config.paths.progress)) {
      try {
        const progress = readBoundedRemoteWorkspaceFile(config.paths.progress, 1_024);
        if (progress !== lastCheckpoint) {
          const checkpoint = validateProgress(progress, config);
          lastCheckpoint = progress;
          lastCheckpointAt = Date.now();
          observation.lastProgressCheckpoint = checkpoint;
        }
      } catch (error) {
        let racedResult;
        try {
          racedResult = acquireTimelyResult(config, startedAt);
        } catch {
          throw error;
        }
        if (racedResult) return racedResult;
        throw error;
      }
    }
    try {
      editor.assertRunning();
    } catch (error) {
      const racedResult = acquireTimelyResult(config, startedAt);
      if (racedResult) return racedResult;
      throw new RemoteWorkspaceResultWaitError(
        "Official VS Code exited before the remote extension host published a result.",
        {
          cause: error
        }
      );
    }
    const now = Date.now();
    if (now - lastCheckpointAt >= config.inactivityTimeoutMs) {
      const racedResult = acquireTimelyResult(config, startedAt);
      if (racedResult) return racedResult;
      throw new RemoteWorkspaceResultWaitError("The Remote SSH phase made no checkpoint progress for 180 seconds.");
    }
    await wait(POLL_MS);
  }
}

function acquireTimelyResult(config, startedAt) {
  if (Date.now() - startedAt >= config.timeoutMs) {
    throw new RemoteWorkspaceResultWaitError("The Remote SSH phase exceeded its 300-second deadline.");
  }
  const resultLease = openRemoteWorkspaceResultLeaseIfPresent(config.paths.result, {
    runId: config.runId
  });
  if (!resultLease) return undefined;
  if (Date.now() - startedAt < config.timeoutMs) return resultLease;
  let closeError;
  try {
    closeRemoteWorkspaceResultLease(resultLease);
  } catch (error) {
    closeError = error;
  }
  const timeout = new RemoteWorkspaceResultWaitError("The Remote SSH phase exceeded its 300-second deadline.");
  if (closeError) {
    throw new AggregateError([timeout, closeError], "A late Remote SSH result could not close safely.");
  }
  throw timeout;
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
    progress.checkpoint.length > 256 ||
    !REMOTE_WORKSPACE_PROGRESS_CHECKPOINTS.has(progress.checkpoint) ||
    Object.keys(progress).sort().join(",") !== "checkpoint,phase,protocol,runId"
  ) {
    throw new Error("The Remote SSH progress checkpoint lost its phase correlation.");
  }
  return progress.checkpoint;
}

async function stopNamespaceChildren(monitors) {
  const errors = [];
  for (const monitor of monitors) {
    try {
      signalGroup(monitor.child, "SIGTERM");
    } catch (error) {
      errors.push(error);
    }
  }
  try {
    await waitUntilNoLiveNamespaceChildren(STOP_GRACE_MS);
  } catch (error) {
    errors.push(error);
  }
  for (const monitor of monitors) {
    try {
      signalGroup(monitor.child, "SIGKILL");
    } catch (error) {
      errors.push(error);
    }
  }
  try {
    for (const pid of liveNamespaceChildren()) {
      try {
        process.kill(pid, "SIGKILL");
      } catch (error) {
        if (error?.code !== "ESRCH") throw error;
      }
    }
  } catch (error) {
    errors.push(error);
  }
  try {
    await waitUntilNoLiveNamespaceChildren(STOP_GRACE_MS);
    const remaining = liveNamespaceChildren();
    if (remaining.length !== 0) {
      throw new Error("The private PID namespace could not prove all editor, SSH, and runtime processes stopped.");
    }
  } catch (error) {
    errors.push(error);
  }
  const settlements = await Promise.allSettled(monitors.map((monitor) => monitor.waitForClose(STOP_GRACE_MS)));
  for (const settlement of settlements) {
    if (settlement.status === "rejected") errors.push(settlement.reason);
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) {
    throw new AggregateError(errors, "Private namespace process shutdown had multiple failures.");
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

function readDescriptor(path, { filesystem = true } = {}) {
  validateRemoteWorkspacePhaseDescriptorPath(path);
  return parseRemoteWorkspacePhaseDescriptor(readBoundedRemoteWorkspaceFile(path, 64 * 1024), { filesystem });
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
