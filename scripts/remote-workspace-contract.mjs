import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  openSync,
  opendirSync,
  readSync,
  realpathSync,
  unlinkSync,
  writeSync
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export const PINNED_REMOTE_VSCODE_VERSION = "1.130.0";
export const PINNED_REMOTE_VSCODE_COMMIT = "1b6a188127eeaf9194f945eb6eb89a657e93c54c";
export const PINNED_REMOTE_SSH_VERSION = "0.124.0";
export const PINNED_REMOTE_SSH_BYTES = 742_378;
export const PINNED_REMOTE_SSH_SHA256 = "1a891224e1291e89a405b90f5018555d6642ac66e2e68653970e4f155d766416";
export const REMOTE_WORKSPACE_PHASE = "remote-workspace";
export const REMOTE_WORKSPACE_AUTHORITY = "ssh-remote+ow-loopback";
export const REMOTE_WORKSPACE_PROTOCOL = 1;
export const REMOTE_WORKSPACE_PHASE_TIMEOUT_MS = 300_000;
export const REMOTE_WORKSPACE_INACTIVITY_TIMEOUT_MS = 180_000;
export const REMOTE_WORKSPACE_PORT = 49_321;
export const REMOTE_WORKSPACE_NAMESPACE_ROOT = "/ow";
export const REMOTE_WORKSPACE_PHASE_DESCRIPTOR_PATH = `${REMOTE_WORKSPACE_NAMESPACE_ROOT}/phase.json`;
export const REMOTE_WORKSPACE_PHASE_CHILD_PATH = `${REMOTE_WORKSPACE_NAMESPACE_ROOT}/phase-runtime/remote-workspace-phase-child.mjs`;
export const REMOTE_WORKSPACE_PHASE_NODE_PATH = `${REMOTE_WORKSPACE_NAMESPACE_ROOT}/phase-node`;
export const REMOTE_WORKSPACE_PHASE_NODE_MAXIMUM_BYTES = 256 * 1024 * 1024;
export const REMOTE_WORKSPACE_MAX_CANDIDATE_BYTES = 64 * 1024 * 1024;
const REMOTE_WORKSPACE_DROPBEAR_RUNTIME_ROOT = `${REMOTE_WORKSPACE_NAMESPACE_ROOT}/rh/ssh-runtime/runtime`;
const REMOTE_WORKSPACE_DROPBEAR_SERVER = `${REMOTE_WORKSPACE_DROPBEAR_RUNTIME_ROOT}/bin/dropbear`;
const REMOTE_WORKSPACE_DROPBEAR_LIBRARY_PATH = `${REMOTE_WORKSPACE_DROPBEAR_RUNTIME_ROOT}/lib`;
export const REMOTE_WORKSPACE_DROPBEAR_NO_REEXEC_ARGV0 = `${REMOTE_WORKSPACE_DROPBEAR_RUNTIME_ROOT}/bin/.openwrangler-no-reexec/dropbear`;
const PATH_LIMIT = 16_384;
const DROPBEAR_LOADER_LIST_LIMIT_BYTES = 64 * 1024;
const PHASE_DESCRIPTOR_LIMIT_BYTES = 64 * 1024;
const REMOTE_WORKSPACE_RESULT_LIMIT_BYTES = 64 * 1024;
const REMOTE_WORKSPACE_RESULT_ERROR_LIMIT_CHARACTERS = 16_000;
const REMOTE_WORKSPACE_LOG_TREE_ENTRY_LIMIT = 1_000;
const REMOTE_WORKSPACE_LOG_TREE_DEPTH_LIMIT = 8;
const REMOTE_WORKSPACE_LOG_TIMESTAMP = /^[0-9]{8}T[0-9]{6}$/u;
const REMOTE_WORKSPACE_OUTPUT_LOG_DIRECTORY = /^output_logging_[0-9]{8}T[0-9]{6}$/u;
const REMOTE_WORKSPACE_WINDOW_DIRECTORY = /^window[1-9][0-9]*$/u;
const REMOTE_WORKSPACE_EXTENSION_HOST_DIRECTORY = /^exthost[1-9][0-9]*$/u;
const REMOTE_WORKSPACE_CONTROLLER_FAILURES = new Map([
  ["phase-failed", "controller:phase-failed: the isolated Remote SSH controller exited after verified cleanup."],
  [
    "phase-setup-failed",
    "controller:phase-setup-failed: the isolated Remote SSH controller failed during private setup."
  ],
  [
    "phase-display-failed",
    "controller:phase-display-failed: the isolated Remote SSH display failed before editor launch."
  ],
  [
    "phase-ssh-daemon-failed",
    "controller:phase-ssh-daemon-failed: the isolated Remote SSH daemon failed before its client probe."
  ],
  [
    "phase-ssh-probe-failed",
    "controller:phase-ssh-probe-failed: the isolated Remote SSH client probe failed before editor launch."
  ],
  [
    "phase-editor-start-failed",
    "controller:phase-editor-start-failed: the isolated VS Code client failed during launch."
  ],
  [
    "phase-result-wait-failed",
    "controller:phase-result-wait-failed: the isolated extension host failed before publishing a result."
  ],
  [
    "phase-result-wait-client-not-ready",
    "controller:phase-result-wait-client-not-ready: last observed stage: no unique isolated VS Code client log."
  ],
  [
    "phase-result-wait-remote-ssh-not-ready",
    "controller:phase-result-wait-remote-ssh-not-ready: last observed stage: isolated VS Code client startup; no unique Remote SSH resolver log."
  ],
  [
    "phase-result-wait-remote-agent-not-ready",
    "controller:phase-result-wait-remote-agent-not-ready: last observed stage: Remote SSH resolver startup; no unique remote-agent log."
  ],
  [
    "phase-result-wait-remote-exthost-not-ready",
    "controller:phase-result-wait-remote-exthost-not-ready: last observed stage: remote-agent startup; no unique remote extension-host log."
  ],
  [
    "phase-result-wait-harness-not-ready",
    "controller:phase-result-wait-harness-not-ready: last observed stage: remote extension-host startup; no correlated acceptance checkpoint."
  ],
  [
    "phase-result-wait-harness-bootstrap-stalled",
    "controller:phase-result-wait-harness-bootstrap-stalled: last observed stage: correlated acceptance-harness bootstrap."
  ],
  [
    "phase-result-wait-harness-activation-stalled",
    "controller:phase-result-wait-harness-activation-stalled: last observed stage: correlated Open Wrangler activation."
  ],
  [
    "phase-result-wait-harness-preflight-stalled",
    "controller:phase-result-wait-harness-preflight-stalled: last observed stage: correlated packaged-extension preflight."
  ],
  [
    "phase-result-wait-harness-scenario-stalled",
    "controller:phase-result-wait-harness-scenario-stalled: last observed stage: correlated Remote SSH scenario setup."
  ],
  [
    "phase-result-wait-harness-open-stalled",
    "controller:phase-result-wait-harness-open-stalled: last observed stage: correlated remote file-open request."
  ],
  [
    "phase-result-wait-harness-filter-stalled",
    "controller:phase-result-wait-harness-filter-stalled: last observed stage: correlated remote filter request."
  ],
  [
    "phase-result-wait-harness-cleanup-stalled",
    "controller:phase-result-wait-harness-cleanup-stalled: last observed stage: correlated remote session cleanup."
  ],
  [
    "phase-result-wait-harness-completion-stalled",
    "controller:phase-result-wait-harness-completion-stalled: last observed stage: correlated acceptance completion without a terminal result."
  ],
  [
    "phase-cleanup-failed",
    "controller:phase-cleanup-failed: the isolated Remote SSH process or display cleanup failed."
  ],
  [
    "phase-result-validation-failed",
    "controller:phase-result-validation-failed: the isolated Remote SSH terminal evidence failed validation."
  ]
]);
const REMOTE_WORKSPACE_PROGRESS_FAILURES = new Map([
  ["remote-workspace:harness-start", "phase-result-wait-harness-bootstrap-stalled"],
  ["preflight:start", "phase-result-wait-harness-bootstrap-stalled"],
  ["activation:start", "phase-result-wait-harness-activation-stalled"],
  ["activation:complete", "phase-result-wait-harness-preflight-stalled"],
  ["preflight:package", "phase-result-wait-harness-preflight-stalled"],
  ["preflight:commands", "phase-result-wait-harness-preflight-stalled"],
  ["preflight:contributions", "phase-result-wait-harness-preflight-stalled"],
  ["preflight:complete", "phase-result-wait-harness-preflight-stalled"],
  ["remote-workspace:start", "phase-result-wait-harness-scenario-stalled"],
  ["remote-workspace:open", "phase-result-wait-harness-open-stalled"],
  ["remote-workspace:filter", "phase-result-wait-harness-filter-stalled"],
  ["remote-workspace:cleanup", "phase-result-wait-harness-cleanup-stalled"],
  ["remote-workspace:complete", "phase-result-wait-harness-completion-stalled"]
]);
const REMOTE_WORKSPACE_POST_RESULT_CONTROLLER_FAILURES = new Set([
  "phase-cleanup-failed",
  "phase-result-validation-failed"
]);
const DROPBEAR_PINNED_LOADER_RESOLUTIONS = Object.freeze([
  Object.freeze({
    soname: "libtomcrypt.so.1",
    reportedPaths: Object.freeze([
      "/lib/x86_64-linux-gnu/libtomcrypt.so.1",
      "/usr/lib/x86_64-linux-gnu/libtomcrypt.so.1"
    ])
  }),
  Object.freeze({
    soname: "libtommath.so.1",
    reportedPaths: Object.freeze(["/lib/x86_64-linux-gnu/libtommath.so.1", "/usr/lib/x86_64-linux-gnu/libtommath.so.1"])
  })
]);

export function getRemoteWorkspaceControllerFailureMessage(code) {
  const message = REMOTE_WORKSPACE_CONTROLLER_FAILURES.get(code);
  if (typeof code !== "string" || message === undefined) {
    throw new Error("The Remote SSH controller failure code is malformed.");
  }
  return message;
}

export function inspectRemoteWorkspaceLogTopology({ localLogs, remoteLogs, uid }, testBoundary = {}) {
  if (
    typeof localLogs !== "string" ||
    !isAbsolute(localLogs) ||
    localLogs.length <= 0 ||
    localLogs.length > PATH_LIMIT ||
    typeof remoteLogs !== "string" ||
    !isAbsolute(remoteLogs) ||
    remoteLogs.length <= 0 ||
    remoteLogs.length > PATH_LIMIT ||
    !Number.isSafeInteger(uid) ||
    uid < 0
  ) {
    throw new Error("The Remote SSH private log-topology request is malformed.");
  }
  const boundary = remoteWorkspaceLogTopologyBoundary(testBoundary);
  const local = scanRemoteWorkspaceLogTree(localLogs, uid, "local", boundary);
  const remote = scanRemoteWorkspaceLogTree(remoteLogs, uid, "remote", boundary);
  return Object.freeze({
    clientLogCount: local.clientLogCount,
    remoteSshLogCount: local.remoteSshLogCount,
    remoteAgentLogCount: remote.remoteAgentLogCount,
    remoteExtensionHostLogCount: remote.remoteExtensionHostLogCount
  });
}

export function classifyRemoteWorkspaceResultWaitObservation(value) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(",") !==
      "clientLogCount,lastProgressCheckpoint,remoteAgentLogCount,remoteExtensionHostLogCount,remoteSshLogCount" ||
    (value.lastProgressCheckpoint !== null && typeof value.lastProgressCheckpoint !== "string")
  ) {
    throw new Error("The Remote SSH result-wait observation is malformed.");
  }
  const counts = [
    value.clientLogCount,
    value.remoteSshLogCount,
    value.remoteAgentLogCount,
    value.remoteExtensionHostLogCount
  ];
  if (
    counts.some((count) => !Number.isSafeInteger(count) || count < 0 || count > REMOTE_WORKSPACE_LOG_TREE_ENTRY_LIMIT)
  ) {
    throw new Error("The Remote SSH result-wait observation is malformed.");
  }
  if (value.lastProgressCheckpoint !== null) {
    const code = REMOTE_WORKSPACE_PROGRESS_FAILURES.get(value.lastProgressCheckpoint);
    return counts.every((count) => count === 0) && code !== undefined ? code : "phase-result-wait-failed";
  }
  if (counts.some((count) => count > 1)) return "phase-result-wait-failed";
  if (value.clientLogCount === 0) {
    return counts.slice(1).every((count) => count === 0)
      ? "phase-result-wait-client-not-ready"
      : "phase-result-wait-failed";
  }
  if (value.remoteSshLogCount === 0) {
    return counts.slice(2).every((count) => count === 0)
      ? "phase-result-wait-remote-ssh-not-ready"
      : "phase-result-wait-failed";
  }
  if (value.remoteAgentLogCount === 0) {
    return value.remoteExtensionHostLogCount === 0
      ? "phase-result-wait-remote-agent-not-ready"
      : "phase-result-wait-failed";
  }
  if (value.remoteExtensionHostLogCount === 0) return "phase-result-wait-remote-exthost-not-ready";
  return "phase-result-wait-harness-not-ready";
}

export function validateRemoteWorkspaceDropbearLoaderResolution(output) {
  if (
    typeof output !== "string" ||
    output.length === 0 ||
    Buffer.byteLength(output, "utf8") > DROPBEAR_LOADER_LIST_LIMIT_BYTES ||
    output.includes("\0")
  ) {
    throw new Error("The private Dropbear loader listing is malformed or unbounded.");
  }
  const lines = output.split("\n");
  for (const expected of DROPBEAR_PINNED_LOADER_RESOLUTIONS) {
    const matching = lines.filter((line) => line.includes(expected.soname));
    const escapedSoname = expected.soname.replaceAll(".", String.raw`\.`);
    const exact = expected.reportedPaths.some((path) => {
      const escapedPath = path.replaceAll(".", String.raw`\.`);
      return new RegExp(String.raw`^\s*${escapedSoname}\s+=>\s+${escapedPath}\s+\(0x[0-9A-Fa-f]+\)\s*$`, "u").test(
        matching[0] ?? ""
      );
    });
    if (matching.length !== 1 || !exact) {
      throw new Error("The private Dropbear loader did not resolve one exact pinned dependency.");
    }
  }
  return output;
}

export function validateRemoteWorkspaceLibstdcxxResolution(output) {
  if (
    typeof output !== "string" ||
    Buffer.byteLength(output, "utf8") <= 0 ||
    Buffer.byteLength(output, "utf8") > 4_096 ||
    !/^\/usr\/lib\/x86_64-linux-gnu\/libstdc\+\+\.so\.6(?:\.[0-9]+)+\n$/u.test(output)
  ) {
    throw new Error("The private VS Code CLI compatibility library did not resolve inside its read-only runtime.");
  }
  return output;
}

const REMOTE_WORKSPACE_RESULT_LEASES = new WeakMap();
const LINUX_CAPABILITY_FIELDS = Object.freeze([
  ["CapInh", "inheritable"],
  ["CapPrm", "permitted"],
  ["CapEff", "effective"],
  ["CapBnd", "bounding"],
  ["CapAmb", "ambient"]
]);
const PHASE_DESCRIPTOR_KEYS = Object.freeze([
  "authority",
  "candidateBytes",
  "candidateSha256",
  "commit",
  "displayMode",
  "editor",
  "gid",
  "hostHome",
  "hostIsolationSha256",
  "hostIpcNamespace",
  "hostNetworkNamespace",
  "hostPidNamespace",
  "hostSentinel",
  "hostUserNamespace",
  "hostUtsNamespace",
  "inactivityTimeoutMs",
  "paths",
  "phase",
  "protocol",
  "python",
  "remoteSshBytes",
  "remoteSshSha256",
  "remoteSshVersion",
  "runId",
  "sshAuthorizedKeys",
  "sshConfig",
  "sshHostKey",
  "sshLibraryPath",
  "sshServer",
  "testModule",
  "timeoutMs",
  "uid",
  "user",
  "version",
  "xvfb"
]);
const FIXED_PHASE_PATHS = Object.freeze({
  root: REMOTE_WORKSPACE_NAMESPACE_ROOT,
  workspace: `${REMOTE_WORKSPACE_NAMESPACE_ROOT}/rh/workspace`,
  userData: `${REMOTE_WORKSPACE_NAMESPACE_ROOT}/ud`,
  localExtensions: `${REMOTE_WORKSPACE_NAMESPACE_ROOT}/le`,
  localHome: `${REMOTE_WORKSPACE_NAMESPACE_ROOT}/lh`,
  remoteHome: `${REMOTE_WORKSPACE_NAMESPACE_ROOT}/rh`,
  result: `${REMOTE_WORKSPACE_NAMESPACE_ROOT}/out/result.json`,
  progress: `${REMOTE_WORKSPACE_NAMESPACE_ROOT}/out/progress.json`
});
const FIXED_DESCRIPTOR_PATHS = Object.freeze({
  editor: `${REMOTE_WORKSPACE_NAMESPACE_ROOT}/client/code`,
  xvfb: `${REMOTE_WORKSPACE_NAMESPACE_ROOT}/phase-runtime/Xvfb`,
  testModule: `${REMOTE_WORKSPACE_NAMESPACE_ROOT}/rh/test-module/dist-test/test/extensionHost/index.js`,
  python: `${REMOTE_WORKSPACE_NAMESPACE_ROOT}/rh/python/bin/openwrangler-python`,
  sshConfig: `${REMOTE_WORKSPACE_NAMESPACE_ROOT}/rh/ssh/config`,
  sshServer: REMOTE_WORKSPACE_DROPBEAR_SERVER,
  sshLibraryPath: REMOTE_WORKSPACE_DROPBEAR_LIBRARY_PATH,
  sshHostKey: `${REMOTE_WORKSPACE_NAMESPACE_ROOT}/rh/ssh/host`,
  sshAuthorizedKeys: `${REMOTE_WORKSPACE_NAMESPACE_ROOT}/rh/ssh`
});

export function assertRemoteWorkspaceDropbearNoReexecPath(path, boundary) {
  if (path !== REMOTE_WORKSPACE_DROPBEAR_NO_REEXEC_ARGV0) {
    throw new Error("The Remote SSH Dropbear argv0 does not use its fixed immutable no-reexec path.");
  }
  const lstat = remoteWorkspaceDropbearAbsenceBoundary(boundary);
  try {
    lstat(path);
  } catch (error) {
    if (error?.code === "ENOENT") return path;
    throw new Error("The Remote SSH Dropbear no-reexec argv0 could not be proven absent.", { cause: error });
  }
  throw new Error("The Remote SSH Dropbear no-reexec argv0 must remain absent.");
}

export function createRemoteWorkspaceDropbearLoaderArguments(value, boundary) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(",") !== "dropbearArguments,sshLibraryPath,sshServer" ||
    value.sshServer !== REMOTE_WORKSPACE_DROPBEAR_SERVER ||
    value.sshLibraryPath !== REMOTE_WORKSPACE_DROPBEAR_LIBRARY_PATH ||
    !Array.isArray(value.dropbearArguments) ||
    value.dropbearArguments.length === 0 ||
    value.dropbearArguments.length > 64 ||
    value.dropbearArguments.some(
      (argument) =>
        typeof argument !== "string" ||
        argument.length === 0 ||
        argument.length > PATH_LIMIT ||
        /[\0\r\n]/u.test(argument)
    )
  ) {
    throw new Error("The Remote SSH Dropbear private-loader request is malformed.");
  }
  const argv0 = assertRemoteWorkspaceDropbearNoReexecPath(REMOTE_WORKSPACE_DROPBEAR_NO_REEXEC_ARGV0, boundary);
  return Object.freeze([
    "--argv0",
    argv0,
    "--library-path",
    value.sshLibraryPath,
    value.sshServer,
    ...value.dropbearArguments
  ]);
}

export function createRemoteWorkspaceHostIsolationDigest(hostHome, hostSentinel) {
  for (const value of [hostHome, hostSentinel]) {
    if (
      typeof value !== "string" ||
      !isAbsolute(value) ||
      value.length <= 0 ||
      value.length > PATH_LIMIT ||
      /[\0\r\n]/u.test(value)
    ) {
      throw new Error("The Remote SSH host-isolation path is malformed.");
    }
  }
  return createHash("sha256")
    .update("openwrangler-remote-host-isolation-v1\0", "utf8")
    .update(hostHome, "utf8")
    .update("\0", "utf8")
    .update(hostSentinel, "utf8")
    .digest("hex");
}

function remoteWorkspaceDropbearAbsenceBoundary(value) {
  if (value === undefined) return lstatSync;
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).join(",") !== "lstat" ||
    typeof value.lstat !== "function"
  ) {
    throw new Error("The Remote SSH Dropbear absence boundary is malformed.");
  }
  return value.lstat;
}

export function validateRemoteWorkspacePhaseDescriptorPath(path) {
  if (path !== REMOTE_WORKSPACE_PHASE_DESCRIPTOR_PATH) {
    throw new Error("The Remote SSH phase requires its exact read-only private descriptor path.");
  }
  return path;
}

export function parseRemoteWorkspacePhaseDescriptor(
  contents,
  { filesystem = true, inspectionRoot = REMOTE_WORKSPACE_NAMESPACE_ROOT } = {}
) {
  if (
    typeof contents !== "string" ||
    Buffer.byteLength(contents, "utf8") <= 0 ||
    Buffer.byteLength(contents, "utf8") > PHASE_DESCRIPTOR_LIMIT_BYTES ||
    !contents.endsWith("\n") ||
    contents.slice(0, -1).includes("\n") ||
    contents.includes("\r")
  ) {
    throw new Error("The Remote SSH phase descriptor is not one bounded canonical JSON line.");
  }
  let value;
  try {
    value = JSON.parse(contents.slice(0, -1));
  } catch (error) {
    throw new Error("The Remote SSH phase descriptor is malformed.", { cause: error });
  }
  const validated = validateRemoteWorkspacePhaseDescriptor(value, { filesystem, inspectionRoot });
  const normalized = canonicalPhaseDescriptor(validated);
  if (`${JSON.stringify(normalized)}\n` !== contents) {
    throw new Error("The Remote SSH phase descriptor is not canonical JSON.");
  }
  return Object.freeze({ ...normalized, paths: Object.freeze(normalized.paths) });
}

export function validateRemoteWorkspacePhaseDescriptor(
  value,
  { filesystem = true, inspectionRoot = REMOTE_WORKSPACE_NAMESPACE_ROOT } = {}
) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    !hasExactKeys(value, PHASE_DESCRIPTOR_KEYS) ||
    value.protocol !== REMOTE_WORKSPACE_PROTOCOL ||
    value.phase !== REMOTE_WORKSPACE_PHASE ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(value.runId) ||
    value.timeoutMs !== REMOTE_WORKSPACE_PHASE_TIMEOUT_MS ||
    value.inactivityTimeoutMs !== REMOTE_WORKSPACE_INACTIVITY_TIMEOUT_MS ||
    value.authority !== REMOTE_WORKSPACE_AUTHORITY ||
    value.version !== PINNED_REMOTE_VSCODE_VERSION ||
    value.commit !== PINNED_REMOTE_VSCODE_COMMIT ||
    !isCandidateReceipt(value.candidateSha256, value.candidateBytes) ||
    value.remoteSshVersion !== PINNED_REMOTE_SSH_VERSION ||
    value.remoteSshBytes !== PINNED_REMOTE_SSH_BYTES ||
    value.remoteSshSha256 !== PINNED_REMOTE_SSH_SHA256 ||
    value.hostIsolationSha256 !== createRemoteWorkspaceHostIsolationDigest(value.hostHome, value.hostSentinel) ||
    value.displayMode !== "xvfb" ||
    !/^pid:\[[0-9]+\]$/u.test(value.hostPidNamespace) ||
    !/^net:\[[0-9]+\]$/u.test(value.hostNetworkNamespace) ||
    !/^ipc:\[[0-9]+\]$/u.test(value.hostIpcNamespace) ||
    !/^uts:\[[0-9]+\]$/u.test(value.hostUtsNamespace) ||
    !/^user:\[[0-9]+\]$/u.test(value.hostUserNamespace) ||
    typeof value.user !== "string" ||
    !/^[A-Za-z_][A-Za-z0-9_-]{0,63}$/u.test(value.user) ||
    !Number.isSafeInteger(value.uid) ||
    !Number.isSafeInteger(value.gid) ||
    value.uid <= 0 ||
    value.gid <= 0 ||
    value.uid > 2_147_483_647 ||
    value.gid > 2_147_483_647
  ) {
    throw new Error("The Remote SSH phase descriptor is malformed.");
  }
  if (
    !value.paths ||
    typeof value.paths !== "object" ||
    Array.isArray(value.paths) ||
    !hasExactKeys(value.paths, Object.keys(FIXED_PHASE_PATHS)) ||
    Object.entries(FIXED_PHASE_PATHS).some(([name, expected]) => value.paths[name] !== expected) ||
    Object.entries(FIXED_DESCRIPTOR_PATHS).some(([name, expected]) => value[name] !== expected)
  ) {
    throw new Error("The Remote SSH phase descriptor does not use the fixed private namespace layout.");
  }
  const root = REMOTE_WORKSPACE_NAMESPACE_ROOT;
  for (const candidate of [
    value.editor,
    value.xvfb,
    value.testModule,
    value.python,
    value.sshConfig,
    value.sshServer,
    value.sshLibraryPath,
    value.sshHostKey,
    value.sshAuthorizedKeys,
    ...Object.values(value.paths ?? {})
  ]) {
    if (typeof candidate !== "string" || !isAbsolute(candidate) || candidate.length > PATH_LIMIT) {
      throw new Error("The Remote SSH phase descriptor contains an invalid path.");
    }
    const resolved = resolve(candidate);
    if (resolved !== root && !isContained(root, resolved)) {
      throw new Error("The Remote SSH phase descriptor escaped its private root.");
    }
  }
  for (const external of [value.hostHome, value.hostSentinel]) {
    if (
      typeof external !== "string" ||
      !isAbsolute(external) ||
      external.length > PATH_LIMIT ||
      /[\0\r\n]/u.test(external) ||
      resolve(external) === root ||
      isContained(root, resolve(external))
    ) {
      throw new Error("The Remote SSH isolation sentinel is malformed.");
    }
  }
  if (filesystem) {
    const physicalRoot = canonicalInspectionRoot(inspectionRoot);
    const physical = (candidate) => join(physicalRoot, relative(root, candidate));
    for (const [candidate, label] of [
      [root, "private namespace root"],
      [value.paths.workspace, "private workspace"],
      [value.paths.userData, "private user-data directory"],
      [value.paths.localExtensions, "private local extensions directory"],
      [value.paths.localHome, "private local home"],
      [value.paths.remoteHome, "private remote home"],
      [value.sshLibraryPath, "private SSH library directory"],
      [value.sshAuthorizedKeys, "private SSH authorized-keys directory"]
    ]) {
      assertTrustedDirectory(physical(candidate), label, physicalRoot, value.uid, value.gid);
    }
    for (const [candidate, label, mode, executable] of [
      [value.editor, "private editor executable", undefined, true],
      [value.xvfb, "private Xvfb executable", 0o700, true],
      [value.testModule, "remote test module", 0o644, false],
      [value.python, "private Python executable", undefined, true],
      [value.sshConfig, "private SSH configuration", 0o600, false],
      [value.sshServer, "private SSH server", 0o700, true],
      [value.sshHostKey, "private SSH host key", 0o600, false]
    ]) {
      assertTrustedRegularFile(physical(candidate), label, physicalRoot, value.uid, value.gid, {
        mode,
        executable
      });
    }
    assertPathAbsent(physical(value.paths.result), "result");
    assertPathAbsent(physical(value.paths.progress), "progress");
  }
  return value;
}

export function validateRemoteWorkspaceCandidateExpectation(sha256, rawBytes) {
  if (
    typeof sha256 !== "string" ||
    !/^[0-9a-f]{64}$/u.test(sha256) ||
    typeof rawBytes !== "string" ||
    !/^[1-9][0-9]*$/u.test(rawBytes)
  ) {
    throw new Error("Remote SSH acceptance requires a lowercase SHA-256 and canonical byte-size expectation.");
  }
  const bytes = Number(rawBytes);
  if (!isCandidateReceipt(sha256, bytes)) {
    throw new Error(
      `Remote SSH candidate size must be a safe positive integer no larger than ${REMOTE_WORKSPACE_MAX_CANDIDATE_BYTES} bytes.`
    );
  }
  return Object.freeze({ sha256, bytes });
}

export function validateRemoteWorkspaceCandidatePath(path) {
  if (
    typeof path !== "string" ||
    !isAbsolute(path) ||
    path.length <= 0 ||
    path.length > PATH_LIMIT ||
    /[\0\r\n]/u.test(path)
  ) {
    throw new Error("Remote SSH acceptance requires one bounded absolute caller candidate path.");
  }
  return path;
}

export function validateRemoteWorkspaceZeroCapabilities(contents) {
  if (
    typeof contents !== "string" ||
    Buffer.byteLength(contents, "utf8") <= 0 ||
    Buffer.byteLength(contents, "utf8") > PHASE_DESCRIPTOR_LIMIT_BYTES ||
    contents.includes("\r")
  ) {
    throw new Error("The Remote SSH Linux capability status is malformed.");
  }
  const expectedNames = new Set(LINUX_CAPABILITY_FIELDS.map(([name]) => name));
  const observed = new Map();
  for (const line of contents.split("\n").filter((candidate) => candidate.startsWith("Cap"))) {
    const match = /^(Cap[A-Za-z]+):[ \t]+([0-9a-fA-F]{16})$/u.exec(line);
    if (!match || !expectedNames.has(match[1]) || observed.has(match[1])) {
      throw new Error("The Remote SSH Linux capability status is malformed.");
    }
    if (!/^0{16}$/u.test(match[2])) {
      throw new Error("The Remote SSH private namespace retained a Linux capability.");
    }
    observed.set(match[1], match[2]);
  }
  if (
    observed.size !== LINUX_CAPABILITY_FIELDS.length ||
    LINUX_CAPABILITY_FIELDS.some(([name]) => !observed.has(name))
  ) {
    throw new Error("The Remote SSH Linux capability status is incomplete.");
  }
  return Object.freeze(Object.fromEntries(LINUX_CAPABILITY_FIELDS.map(([, property]) => [property, 0])));
}

export function validateRemoteWorkspaceNamespaceAttestation(contents, expected) {
  if (
    typeof contents !== "string" ||
    Buffer.byteLength(contents, "utf8") <= 0 ||
    Buffer.byteLength(contents, "utf8") > 16 * 1024 ||
    !contents.endsWith("\n") ||
    contents.slice(0, -1).includes("\n") ||
    contents.includes("\r")
  ) {
    throw new Error("The Remote SSH PID namespace did not publish one bounded canonical attestation.");
  }
  if (!/^[0-9a-f-]{36}$/u.test(expected?.runId ?? "")) {
    throw new Error("The Remote SSH PID-namespace expectation is malformed.");
  }
  if (typeof expected?.hostIsolationSha256 !== "string" || !/^[0-9a-f]{64}$/u.test(expected.hostIsolationSha256)) {
    throw new Error("The Remote SSH PID-namespace host-isolation expectation is malformed.");
  }
  const candidate = validateRemoteWorkspaceCandidateExpectation(expected?.sha256, String(expected?.bytes ?? ""));
  let value;
  try {
    value = JSON.parse(contents.slice(0, -1));
  } catch (error) {
    throw new Error("The Remote SSH PID namespace published a malformed attestation.", { cause: error });
  }
  const controllerFailure = value?.controllerCode !== undefined || value?.resultOutcome !== undefined;
  const exactKeys = controllerFailure
    ? "candidateBytes,candidateSha256,capabilities,commit,controllerCode,display,displayEmpty,hostIsolationSha256,hostname,ipc,namespaceEmpty,network,outcome,phase,protocol,remoteAuthority,remoteSshBytes,remoteSshSha256,remoteSshVersion,resultBytes,resultOutcome,resultSha256,runId,uts,version"
    : "candidateBytes,candidateSha256,capabilities,commit,display,displayEmpty,hostIsolationSha256,hostname,ipc,namespaceEmpty,network,outcome,phase,protocol,remoteAuthority,remoteSshBytes,remoteSshSha256,remoteSshVersion,resultBytes,resultSha256,runId,uts,version";
  if (
    value?.protocol !== REMOTE_WORKSPACE_PROTOCOL ||
    value.runId !== expected.runId ||
    value.phase !== REMOTE_WORKSPACE_PHASE ||
    value.namespaceEmpty !== true ||
    value.network !== "unshared" ||
    value.ipc !== "unshared" ||
    value.uts !== "unshared" ||
    value.hostname !== "openwrangler-remote-acceptance" ||
    value.display !== "xvfb" ||
    value.displayEmpty !== true ||
    value.remoteAuthority !== REMOTE_WORKSPACE_AUTHORITY ||
    value.version !== PINNED_REMOTE_VSCODE_VERSION ||
    value.commit !== PINNED_REMOTE_VSCODE_COMMIT ||
    value.candidateSha256 !== candidate.sha256 ||
    value.candidateBytes !== candidate.bytes ||
    value.remoteSshVersion !== PINNED_REMOTE_SSH_VERSION ||
    value.remoteSshBytes !== PINNED_REMOTE_SSH_BYTES ||
    value.remoteSshSha256 !== PINNED_REMOTE_SSH_SHA256 ||
    value.hostIsolationSha256 !== expected.hostIsolationSha256 ||
    !["success", "failure"].includes(value.outcome) ||
    (controllerFailure &&
      (value.outcome !== "failure" ||
        !REMOTE_WORKSPACE_CONTROLLER_FAILURES.has(value.controllerCode) ||
        !REMOTE_WORKSPACE_POST_RESULT_CONTROLLER_FAILURES.has(value.controllerCode) ||
        !["success", "failure"].includes(value.resultOutcome))) ||
    !Number.isSafeInteger(value.resultBytes) ||
    value.resultBytes <= 0 ||
    value.resultBytes > REMOTE_WORKSPACE_RESULT_LIMIT_BYTES ||
    typeof value.resultSha256 !== "string" ||
    !/^[0-9a-f]{64}$/u.test(value.resultSha256) ||
    !isZeroCapabilityAttestation(value.capabilities) ||
    Object.keys(value).sort().join(",") !== exactKeys
  ) {
    throw new Error(
      "The Remote SSH PID namespace did not attest its exact candidate, Remote SSH artifact, and empty owned state."
    );
  }
  const canonical = {
    protocol: REMOTE_WORKSPACE_PROTOCOL,
    runId: value.runId,
    phase: REMOTE_WORKSPACE_PHASE,
    namespaceEmpty: true,
    network: "unshared",
    ipc: "unshared",
    uts: "unshared",
    hostname: "openwrangler-remote-acceptance",
    display: "xvfb",
    displayEmpty: true,
    remoteAuthority: REMOTE_WORKSPACE_AUTHORITY,
    version: PINNED_REMOTE_VSCODE_VERSION,
    commit: PINNED_REMOTE_VSCODE_COMMIT,
    candidateSha256: candidate.sha256,
    candidateBytes: candidate.bytes,
    remoteSshVersion: PINNED_REMOTE_SSH_VERSION,
    remoteSshBytes: PINNED_REMOTE_SSH_BYTES,
    remoteSshSha256: PINNED_REMOTE_SSH_SHA256,
    hostIsolationSha256: expected.hostIsolationSha256,
    outcome: value.outcome,
    ...(controllerFailure
      ? {
          controllerCode: value.controllerCode,
          resultOutcome: value.resultOutcome
        }
      : {}),
    resultBytes: value.resultBytes,
    resultSha256: value.resultSha256,
    capabilities: Object.fromEntries(
      LINUX_CAPABILITY_FIELDS.map(([, property]) => [property, value.capabilities[property]])
    )
  };
  if (`${JSON.stringify(canonical)}\n` !== contents) {
    throw new Error("The Remote SSH PID namespace attestation is not canonical JSON.");
  }
  return Object.freeze({
    ...canonical,
    capabilities: Object.freeze({ ...canonical.capabilities })
  });
}

export function validateRemoteSshLogAttestation(text) {
  if (
    typeof text !== "string" ||
    Buffer.byteLength(text, "utf8") <= 0 ||
    Buffer.byteLength(text, "utf8") > 2 * 1024 * 1024 ||
    !text.includes(`Using commit id "${PINNED_REMOTE_VSCODE_COMMIT}" and quality "stable" for server`) ||
    !text.includes("Found existing installation") ||
    !text.includes("didLocalDownload==0==") ||
    text.includes("didLocalDownload==1==") ||
    /Downloading VS Code server|Got request to download on client|vscode-cli-[0-9a-f]{40}\.tar\.gz/u.test(text)
  ) {
    throw new Error("The Remote SSH log did not prove reuse of the exact pre-provisioned offline server chain.");
  }
  return Object.freeze({
    commit: PINNED_REMOTE_VSCODE_COMMIT,
    didLocalDownload: false,
    existingInstallation: true
  });
}

function scanRemoteWorkspaceLogTree(root, uid, kind, boundary) {
  const counts = {
    clientLogCount: 0,
    remoteSshLogCount: 0,
    remoteAgentLogCount: 0,
    remoteExtensionHostLogCount: 0
  };
  let rootMetadata;
  try {
    rootMetadata = lstatSync(root, { bigint: true });
  } catch (error) {
    if (error?.code === "ENOENT") return counts;
    throw error;
  }
  assertPrivateLogEntry(rootMetadata, uid, "directory");
  const state = { entries: 0 };
  scanRemoteWorkspaceLogDirectory({
    openPath: root,
    namedPath: root,
    parts: [],
    uid,
    kind,
    counts,
    state,
    boundary
  });
  return counts;
}

function scanRemoteWorkspaceLogDirectory({ openPath, namedPath, parts, uid, kind, counts, state, boundary }) {
  const namedBefore = lstatSync(namedPath, { bigint: true });
  const anchoredBefore = openPath === namedPath ? namedBefore : lstatSync(openPath, { bigint: true });
  assertPrivateLogEntry(namedBefore, uid, "directory");
  if (!samePrivateLogEntry(namedBefore, anchoredBefore)) {
    throw new Error("The Remote SSH private log tree changed identity before directory open.");
  }
  const descriptor = openSync(
    openPath,
    constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0) | (constants.O_CLOEXEC ?? 0),
    0o700
  );
  const observedChildren = [];
  let handle;
  try {
    const opened = fstatSync(descriptor, { bigint: true });
    if (!samePrivateLogEntry(namedBefore, opened)) {
      throw new Error("The Remote SSH private log tree changed identity during directory open.");
    }
    handle = opendirSync(`/proc/self/fd/${descriptor}`);
    while (true) {
      const entry = handle.readSync();
      if (!entry) break;
      state.entries += 1;
      if (state.entries > REMOTE_WORKSPACE_LOG_TREE_ENTRY_LIMIT) {
        throw new Error("The Remote SSH private log tree exceeded its entry bound.");
      }
      const childParts = [...parts, entry.name];
      if (childParts.length > REMOTE_WORKSPACE_LOG_TREE_DEPTH_LIMIT) {
        throw new Error("The Remote SSH private log tree exceeded its depth bound.");
      }
      const childNamedPath = join(namedPath, entry.name);
      const childOpenPath = `/proc/self/fd/${descriptor}/${entry.name}`;
      if (
        Buffer.byteLength(childNamedPath, "utf8") > PATH_LIMIT ||
        Buffer.byteLength(childOpenPath, "utf8") > PATH_LIMIT
      ) {
        throw new Error("The Remote SSH private log tree exceeded its path bound.");
      }
      const namedChild = lstatSync(childNamedPath, { bigint: true });
      const anchoredChild = lstatSync(childOpenPath, { bigint: true });
      if (!samePrivateLogEntry(namedChild, anchoredChild)) {
        throw new Error("The Remote SSH private log tree changed identity during enumeration.");
      }
      const childKind = namedChild.isDirectory() ? "directory" : "file";
      assertPrivateLogEntry(namedChild, uid, childKind);
      observedChildren.push({
        namedPath: childNamedPath,
        openPath: childOpenPath,
        snapshot: namedChild
      });
      boundary.onEntryObserved({
        kind,
        entryKind: childKind,
        namedPath: childNamedPath,
        parts: Object.freeze([...childParts])
      });
      if (childKind === "directory") {
        scanRemoteWorkspaceLogDirectory({
          openPath: childOpenPath,
          namedPath: childNamedPath,
          parts: childParts,
          uid,
          kind,
          counts,
          state,
          boundary
        });
      } else {
        classifyRemoteWorkspaceLogPath(kind, childParts, counts);
      }
    }
    const completedHandle = handle;
    handle = undefined;
    completedHandle.closeSync();
    for (const child of observedChildren) {
      const namedAfter = lstatSync(child.namedPath, { bigint: true });
      const anchoredAfter = lstatSync(child.openPath, { bigint: true });
      if (!samePrivateLogEntry(child.snapshot, namedAfter) || !samePrivateLogEntry(child.snapshot, anchoredAfter)) {
        throw new Error("The Remote SSH private log tree changed identity after enumeration.");
      }
    }
    const openedAfter = fstatSync(descriptor, { bigint: true });
    const namedAfter = lstatSync(namedPath, { bigint: true });
    if (!samePrivateLogEntry(opened, openedAfter) || !samePrivateLogEntry(opened, namedAfter)) {
      throw new Error("The Remote SSH private log directory changed identity after enumeration.");
    }
  } finally {
    try {
      handle?.closeSync();
    } finally {
      closeSync(descriptor);
    }
  }
}

function classifyRemoteWorkspaceLogPath(kind, parts, counts) {
  if (kind === "local") {
    if (parts.length === 2 && REMOTE_WORKSPACE_LOG_TIMESTAMP.test(parts[0]) && parts[1] === "main.log") {
      counts.clientLogCount += 1;
    } else if (
      parts.length === 5 &&
      REMOTE_WORKSPACE_LOG_TIMESTAMP.test(parts[0]) &&
      REMOTE_WORKSPACE_WINDOW_DIRECTORY.test(parts[1]) &&
      parts[2] === "exthost" &&
      REMOTE_WORKSPACE_OUTPUT_LOG_DIRECTORY.test(parts[3]) &&
      parts[4] === "1-Remote - SSH.log"
    ) {
      counts.remoteSshLogCount += 1;
    }
  } else if (parts.length === 2 && REMOTE_WORKSPACE_LOG_TIMESTAMP.test(parts[0]) && parts[1] === "remoteagent.log") {
    counts.remoteAgentLogCount += 1;
  } else if (
    parts.length === 3 &&
    REMOTE_WORKSPACE_LOG_TIMESTAMP.test(parts[0]) &&
    REMOTE_WORKSPACE_EXTENSION_HOST_DIRECTORY.test(parts[1]) &&
    parts[2] === "exthost.log"
  ) {
    counts.remoteExtensionHostLogCount += 1;
  }
}

function assertPrivateLogEntry(metadata, uid, kind) {
  const validType = kind === "directory" ? metadata.isDirectory() : metadata.isFile();
  if (
    !validType ||
    metadata.isSymbolicLink() ||
    metadata.uid !== BigInt(uid) ||
    Number(metadata.mode & 0o022n) !== 0 ||
    (kind === "file" && metadata.nlink !== 1n)
  ) {
    throw new Error("The Remote SSH private log tree contains an unsafe entry.");
  }
}

function samePrivateLogEntry(left, right) {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.uid === right.uid &&
    left.gid === right.gid &&
    left.nlink === right.nlink &&
    left.birthtimeNs === right.birthtimeNs
  );
}

function remoteWorkspaceLogTopologyBoundary(value) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => key !== "onEntryObserved") ||
    (value.onEntryObserved !== undefined && typeof value.onEntryObserved !== "function")
  ) {
    throw new Error("The Remote SSH private log-topology boundary is malformed.");
  }
  return Object.freeze({
    onEntryObserved: value.onEntryObserved ?? (() => undefined)
  });
}

export function validateRemoteWorkspaceResult(contents, { runId }) {
  if (
    typeof contents !== "string" ||
    Buffer.byteLength(contents, "utf8") <= 0 ||
    Buffer.byteLength(contents, "utf8") > REMOTE_WORKSPACE_RESULT_LIMIT_BYTES
  ) {
    throw new Error("The Remote SSH acceptance result is oversized.");
  }
  let result;
  try {
    result = JSON.parse(contents);
  } catch (error) {
    throw new Error("The Remote SSH acceptance result is malformed.", { cause: error });
  }
  const correlated =
    result &&
    result.protocol === REMOTE_WORKSPACE_PROTOCOL &&
    result.runId === runId &&
    result.phase === REMOTE_WORKSPACE_PHASE;
  if (correlated && result.ok === true && Object.keys(result).sort().join(",") === "ok,phase,protocol,runId") {
    return Object.freeze({ ...result, outcome: "success" });
  }
  if (
    correlated &&
    result.ok === false &&
    typeof result.error === "string" &&
    result.error.length > 0 &&
    result.error.length <= REMOTE_WORKSPACE_RESULT_ERROR_LIMIT_CHARACTERS &&
    Object.keys(result).sort().join(",") === "error,ok,phase,protocol,runId"
  ) {
    return Object.freeze({ ...result, outcome: "failure" });
  }
  throw new Error("The Remote SSH acceptance phase did not publish one correlated terminal result.");
}

export function validateRemoteWorkspaceBootstrapAttestation(contents, { runId }) {
  if (
    typeof runId !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(runId) ||
    typeof contents !== "string" ||
    Buffer.byteLength(contents, "utf8") <= 0 ||
    Buffer.byteLength(contents, "utf8") > PHASE_DESCRIPTOR_LIMIT_BYTES ||
    !contents.endsWith("\n") ||
    contents.slice(0, -1).includes("\n") ||
    contents.includes("\r")
  ) {
    throw new Error("The Remote SSH bootstrap attestation is not one bounded canonical JSON line.");
  }
  let attestation;
  try {
    attestation = JSON.parse(contents.slice(0, -1));
  } catch (error) {
    throw new Error("The Remote SSH bootstrap attestation is malformed.", { cause: error });
  }
  if (
    !attestation ||
    typeof attestation !== "object" ||
    Array.isArray(attestation) ||
    Object.keys(attestation).sort().join(",") !== "capabilities,filesystem,kind,namespaceEmpty,phase,protocol,runId" ||
    attestation.protocol !== REMOTE_WORKSPACE_PROTOCOL ||
    attestation.runId !== runId ||
    attestation.phase !== REMOTE_WORKSPACE_PHASE ||
    attestation.kind !== "bootstrap-preflight" ||
    attestation.filesystem !== "validated" ||
    attestation.namespaceEmpty !== true ||
    !isZeroCapabilityAttestation(attestation.capabilities)
  ) {
    throw new Error("The Remote SSH bootstrap attestation lost its exact private correlation.");
  }
  const canonical = {
    protocol: REMOTE_WORKSPACE_PROTOCOL,
    runId,
    phase: REMOTE_WORKSPACE_PHASE,
    kind: "bootstrap-preflight",
    filesystem: "validated",
    namespaceEmpty: true,
    capabilities: Object.fromEntries(
      LINUX_CAPABILITY_FIELDS.map(([, property]) => [property, attestation.capabilities[property]])
    )
  };
  if (`${JSON.stringify(canonical)}\n` !== contents) {
    throw new Error("The Remote SSH bootstrap attestation is not canonical JSON.");
  }
  return Object.freeze({
    ...canonical,
    capabilities: Object.freeze({ ...canonical.capabilities })
  });
}

export async function finalizeRemoteWorkspaceControllerFailure({
  stopChildren,
  assertDisplayEmpty,
  assertNamespace,
  captureCapabilities,
  observedResultReceipt,
  publishResult,
  code = "phase-failed"
}) {
  for (const operation of [stopChildren, assertDisplayEmpty, assertNamespace, captureCapabilities, publishResult]) {
    if (typeof operation !== "function") {
      throw new Error("The Remote SSH controller failure boundary is malformed.");
    }
  }
  if (!REMOTE_WORKSPACE_CONTROLLER_FAILURES.has(code)) {
    throw new Error("The Remote SSH controller failure boundary is malformed.");
  }
  await stopChildren();
  assertDisplayEmpty();
  assertNamespace();
  const capabilities = captureCapabilities();
  if (!isZeroCapabilityAttestation(capabilities)) {
    throw new Error("The Remote SSH controller failure boundary did not retain zero capabilities.");
  }
  const existingResult = observedResultReceipt;
  if (existingResult !== undefined) {
    if (
      !REMOTE_WORKSPACE_POST_RESULT_CONTROLLER_FAILURES.has(code) ||
      !existingResult ||
      typeof existingResult !== "object" ||
      Array.isArray(existingResult) ||
      !["success", "failure"].includes(existingResult.outcome) ||
      !Number.isSafeInteger(existingResult.resultBytes) ||
      existingResult.resultBytes <= 0 ||
      existingResult.resultBytes > REMOTE_WORKSPACE_RESULT_LIMIT_BYTES ||
      typeof existingResult.resultSha256 !== "string" ||
      !/^[0-9a-f]{64}$/u.test(existingResult.resultSha256) ||
      Object.keys(existingResult).sort().join(",") !== "outcome,resultBytes,resultSha256"
    ) {
      throw new Error("The Remote SSH existing controller result receipt is malformed.");
    }
    return Object.freeze({
      outcome: "failure",
      controllerCode: code,
      resultOutcome: existingResult.outcome,
      resultBytes: existingResult.resultBytes,
      resultSha256: existingResult.resultSha256,
      capabilities: Object.freeze({ ...capabilities })
    });
  }
  const result = publishResult(code);
  if (
    !result ||
    typeof result !== "object" ||
    Array.isArray(result) ||
    result.outcome !== "failure" ||
    !Number.isSafeInteger(result.resultBytes) ||
    result.resultBytes <= 0 ||
    result.resultBytes > REMOTE_WORKSPACE_RESULT_LIMIT_BYTES ||
    typeof result.resultSha256 !== "string" ||
    !/^[0-9a-f]{64}$/u.test(result.resultSha256) ||
    Object.keys(result).sort().join(",") !== "outcome,resultBytes,resultSha256"
  ) {
    throw new Error("The Remote SSH controller failure result receipt is malformed.");
  }
  return Object.freeze({
    ...result,
    capabilities: Object.freeze({ ...capabilities })
  });
}

export function publishRemoteWorkspaceControllerFailureResult(path, { runId, code }, testBoundary = {}) {
  if (process.platform !== "linux") {
    throw new Error("Remote SSH controller failure publication is supported only by the Linux acceptance runner.");
  }
  let error;
  try {
    error = getRemoteWorkspaceControllerFailureMessage(code);
  } catch {
    throw new Error("The Remote SSH controller failure result is malformed.");
  }
  if (
    typeof path !== "string" ||
    !isAbsolute(path) ||
    path.length <= 0 ||
    path.length > PATH_LIMIT ||
    typeof runId !== "string" ||
    !/^[0-9a-f-]{36}$/u.test(runId) ||
    typeof code !== "string" ||
    error === undefined
  ) {
    throw new Error("The Remote SSH controller failure result is malformed.");
  }
  const contents = JSON.stringify({
    protocol: REMOTE_WORKSPACE_PROTOCOL,
    runId,
    phase: REMOTE_WORKSPACE_PHASE,
    ok: false,
    error
  });
  const result = validateRemoteWorkspaceResult(contents, { runId });
  const bytes = Buffer.from(contents, "utf8");
  const publication = controllerFailurePublicationBoundary(testBoundary);
  const temporary = join(dirname(path), `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
  if (temporary.length > PATH_LIMIT) {
    throw new Error("The Remote SSH controller failure temporary path is malformed.");
  }
  let descriptor;
  let opened;
  let completed;
  let temporaryRemoved = false;
  let failure;
  try {
    descriptor = openSync(
      temporary,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        (constants.O_NOFOLLOW ?? 0) |
        (constants.O_CLOEXEC ?? 0),
      0o600
    );
    opened = fstatSync(descriptor, { bigint: true });
    if (
      !opened.isFile() ||
      opened.isSymbolicLink() ||
      opened.nlink !== 1n ||
      opened.size !== 0n ||
      Number(opened.mode & 0o777n) !== 0o600
    ) {
      throw new Error("The Remote SSH controller failure target is not one exclusive private regular file.");
    }
    let offset = 0;
    while (offset < bytes.length) {
      const written = publication.write(descriptor, bytes, offset, bytes.length - offset, offset);
      if (!Number.isSafeInteger(written) || written <= 0) {
        throw new Error("The Remote SSH controller failure result made no write progress.");
      }
      offset += written;
    }
    publication.fsync(descriptor);
    completed = fstatSync(descriptor, { bigint: true });
    if (
      !sameResultPublicationIdentity(opened, completed) ||
      completed.nlink !== 1n ||
      completed.size !== BigInt(bytes.length) ||
      Number(completed.mode & 0o777n) !== 0o600
    ) {
      throw new Error("The Remote SSH controller failure result changed while it was published.");
    }
    const closingDescriptor = descriptor;
    descriptor = undefined;
    publication.close(closingDescriptor);

    publication.beforeLink(temporary, path);
    const temporaryBeforeLink = lstatSync(temporary, { bigint: true });
    if (
      !sameResultPublicationIdentity(completed, temporaryBeforeLink) ||
      temporaryBeforeLink.nlink !== 1n ||
      temporaryBeforeLink.size !== BigInt(bytes.length)
    ) {
      throw new Error("The Remote SSH controller failure temporary changed before publication.");
    }
    publication.link(temporary, path);
    publication.beforeTemporaryRemoval(temporary, path);
    const linkedTemporary = lstatSync(temporary, { bigint: true });
    const linkedResult = lstatSync(path, { bigint: true });
    if (
      !sameResultPublicationIdentity(completed, linkedTemporary) ||
      !sameResultPublicationIdentity(completed, linkedResult) ||
      linkedTemporary.nlink !== 2n ||
      linkedResult.nlink !== 2n ||
      linkedTemporary.size !== BigInt(bytes.length) ||
      linkedResult.size !== BigInt(bytes.length) ||
      Number(linkedTemporary.mode & 0o777n) !== 0o600 ||
      Number(linkedResult.mode & 0o777n) !== 0o600
    ) {
      throw new Error("The Remote SSH controller failure result changed during atomic publication.");
    }
    publication.unlink(temporary);
    assertControllerFailureTemporaryAbsent(temporary);
    temporaryRemoved = true;
    const published = lstatSync(path, { bigint: true });
    if (
      !sameResultPublicationIdentity(completed, published) ||
      published.nlink !== 1n ||
      published.size !== BigInt(bytes.length) ||
      Number(published.mode & 0o777n) !== 0o600
    ) {
      throw new Error("The Remote SSH controller failure result changed after atomic publication.");
    }
  } catch (candidate) {
    failure = candidate;
  } finally {
    if (descriptor !== undefined) {
      const closingDescriptor = descriptor;
      descriptor = undefined;
      try {
        publication.close(closingDescriptor);
      } catch (candidate) {
        failure = combinePublicationErrors(
          failure,
          candidate,
          "The Remote SSH controller failure write and close both failed."
        );
      }
    }
    if (opened !== undefined && !temporaryRemoved) {
      try {
        removeIdentifiedControllerFailureTemporary(temporary, opened, publication.unlink);
      } catch (candidate) {
        failure = combinePublicationErrors(
          failure,
          candidate,
          "The Remote SSH controller failure publication and temporary cleanup both failed."
        );
      }
    }
  }
  if (failure) throw failure;

  const lease = openRemoteWorkspaceResultLeaseIfPresent(path, { runId });
  if (!lease) throw new Error("The Remote SSH controller failure result disappeared after publication.");
  let validationError;
  try {
    if (lease.outcome !== "failure" || lease.result.error !== result.error) {
      throw new Error("The Remote SSH controller failure result changed after publication.");
    }
    assertRemoteWorkspaceResultLease(lease);
  } catch (candidate) {
    validationError = candidate;
  }
  let closeError;
  try {
    closeRemoteWorkspaceResultLease(lease);
  } catch (candidate) {
    closeError = candidate;
  }
  if (validationError && closeError) {
    throw new AggregateError(
      [validationError, closeError],
      "The Remote SSH controller failure result failed validation and close."
    );
  }
  if (validationError) throw validationError;
  if (closeError) throw closeError;
  return Object.freeze({
    outcome: "failure",
    resultBytes: lease.bytes,
    resultSha256: lease.sha256
  });
}

export function openRemoteWorkspaceResultLeaseIfPresent(path, { runId, onDescriptorOpened, afterRead } = {}) {
  if (
    typeof path !== "string" ||
    !isAbsolute(path) ||
    path.length <= 0 ||
    path.length > PATH_LIMIT ||
    typeof runId !== "string" ||
    !/^[0-9a-f-]{36}$/u.test(runId) ||
    (onDescriptorOpened !== undefined && typeof onDescriptorOpened !== "function") ||
    (afterRead !== undefined && typeof afterRead !== "function")
  ) {
    throw new Error("The Remote SSH result lease policy is malformed.");
  }
  let descriptor;
  try {
    descriptor = openSync(
      path,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0) | (constants.O_CLOEXEC ?? 0)
    );
  } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    throw new Error("The Remote SSH result could not be opened as one private regular file.", {
      cause: error
    });
  }
  let leased = false;
  try {
    const snapshot = resultLeaseSnapshot(fstatSync(descriptor, { bigint: true }));
    onDescriptorOpened?.();
    assertResultLeaseNamedPath(path, snapshot);
    const bytes = readExactResultLeaseBytes(descriptor, snapshot);
    afterRead?.();
    assertResultLeaseDescriptorAndPath(descriptor, path, snapshot);
    const contents = decodeResultLeaseBytes(bytes);
    const result = validateRemoteWorkspaceResult(contents, { runId });
    const token = Object.freeze({
      outcome: result.outcome,
      bytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      result
    });
    REMOTE_WORKSPACE_RESULT_LEASES.set(token, { descriptor, path, snapshot, bytes, invalidated: false });
    leased = true;
    return token;
  } finally {
    if (!leased) closeSync(descriptor);
  }
}

export function assertRemoteWorkspaceResultLease(lease) {
  const state = REMOTE_WORKSPACE_RESULT_LEASES.get(lease);
  if (!state) throw new Error("The Remote SSH result lease is not active.");
  if (state.invalidated) {
    throw new Error("The Remote SSH result changed after first observation.");
  }
  try {
    assertResultLeaseDescriptorAndPath(state.descriptor, state.path, state.snapshot);
    const bytes = readExactResultLeaseBytes(state.descriptor, state.snapshot);
    assertResultLeaseDescriptorAndPath(state.descriptor, state.path, state.snapshot);
    if (!bytes.equals(state.bytes) || createHash("sha256").update(bytes).digest("hex") !== lease.sha256) {
      throw new Error("The Remote SSH result changed after first observation.");
    }
  } catch (error) {
    state.invalidated = true;
    throw error;
  }
  return lease;
}

export function closeRemoteWorkspaceResultLease(lease) {
  const state = REMOTE_WORKSPACE_RESULT_LEASES.get(lease);
  if (!state) throw new Error("The Remote SSH result lease is not active.");
  let validationError;
  try {
    assertRemoteWorkspaceResultLease(lease);
  } catch (error) {
    validationError = error;
  }
  REMOTE_WORKSPACE_RESULT_LEASES.delete(lease);
  let closeError;
  try {
    closeSync(state.descriptor);
  } catch (error) {
    closeError = error;
  }
  if (validationError && closeError) {
    throw new AggregateError(
      [validationError, closeError],
      "The Remote SSH result changed and its lease could not close."
    );
  }
  if (validationError) throw validationError;
  if (closeError) throw closeError;
}

function resultLeaseSnapshot(metadata) {
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.nlink !== 1n ||
    metadata.size <= 0n ||
    metadata.size > BigInt(REMOTE_WORKSPACE_RESULT_LIMIT_BYTES)
  ) {
    throw new Error("The Remote SSH result is not one bounded private regular file.");
  }
  return Object.freeze({
    dev: metadata.dev,
    ino: metadata.ino,
    mode: metadata.mode,
    nlink: metadata.nlink,
    uid: metadata.uid,
    gid: metadata.gid,
    size: metadata.size,
    mtimeNs: metadata.mtimeNs,
    ctimeNs: metadata.ctimeNs,
    birthtimeNs: metadata.birthtimeNs
  });
}

function assertResultLeaseNamedPath(path, snapshot) {
  const named = resultLeaseSnapshot(lstatSync(path, { bigint: true }));
  if (!sameResultLeaseSnapshot(named, snapshot)) {
    throw new Error("The Remote SSH result path changed after first observation.");
  }
}

function assertResultLeaseDescriptorAndPath(descriptor, path, snapshot) {
  const opened = resultLeaseSnapshot(fstatSync(descriptor, { bigint: true }));
  if (!sameResultLeaseSnapshot(opened, snapshot)) {
    throw new Error("The Remote SSH result descriptor changed after first observation.");
  }
  assertResultLeaseNamedPath(path, snapshot);
}

function readExactResultLeaseBytes(descriptor, snapshot) {
  const bytes = Buffer.alloc(Number(snapshot.size));
  let offset = 0;
  while (offset < bytes.length) {
    const count = readSync(descriptor, bytes, offset, bytes.length - offset, offset);
    if (!Number.isSafeInteger(count) || count <= 0) {
      throw new Error("The Remote SSH result ended before its pinned byte size.");
    }
    offset += count;
  }
  return bytes;
}

function decodeResultLeaseBytes(bytes) {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    throw new Error("The Remote SSH result is not strict UTF-8.", { cause: error });
  }
}

function sameResultLeaseSnapshot(left, right) {
  return Object.keys(left).every((key) => left[key] === right[key]);
}

function sameResultPublicationIdentity(opened, completed) {
  return (
    opened.isFile() &&
    !opened.isSymbolicLink() &&
    completed.isFile() &&
    !completed.isSymbolicLink() &&
    opened.dev === completed.dev &&
    opened.ino === completed.ino &&
    opened.mode === completed.mode &&
    opened.uid === completed.uid &&
    opened.gid === completed.gid &&
    opened.birthtimeNs === completed.birthtimeNs
  );
}

function controllerFailurePublicationBoundary(value) {
  const allowed = new Set(["beforeLink", "beforeTemporaryRemoval", "close", "fsync", "link", "unlink", "write"]);
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => !allowed.has(key))
  ) {
    throw new Error("The Remote SSH controller failure publication boundary is malformed.");
  }
  const boundary = {
    beforeLink: value.beforeLink ?? (() => undefined),
    beforeTemporaryRemoval: value.beforeTemporaryRemoval ?? (() => undefined),
    close: value.close ?? closeSync,
    fsync: value.fsync ?? fsyncSync,
    link: value.link ?? linkSync,
    unlink: value.unlink ?? unlinkSync,
    write: value.write ?? writeSync
  };
  if (Object.values(boundary).some((operation) => typeof operation !== "function")) {
    throw new Error("The Remote SSH controller failure publication boundary is malformed.");
  }
  return Object.freeze(boundary);
}

function removeIdentifiedControllerFailureTemporary(path, identity, unlink) {
  let current;
  try {
    current = lstatSync(path, { bigint: true });
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new Error("The Remote SSH controller failure temporary disappeared before identified cleanup.", {
        cause: error
      });
    }
    throw error;
  }
  if (
    !sameResultPublicationIdentity(identity, current) ||
    current.nlink < 1n ||
    current.nlink > 2n ||
    Number(current.mode & 0o777n) !== 0o600
  ) {
    throw new Error("The Remote SSH controller failure temporary changed before identified cleanup.");
  }
  unlink(path);
  assertControllerFailureTemporaryAbsent(path);
}

function assertControllerFailureTemporaryAbsent(path) {
  try {
    lstatSync(path);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  throw new Error("The Remote SSH controller failure temporary remained after cleanup.");
}

function combinePublicationErrors(left, right, message) {
  return left ? new AggregateError([left, right], message) : right;
}

export function readBoundedRemoteWorkspaceFile(path, maximumBytes, { onDescriptorOpened } = {}) {
  if (
    typeof path !== "string" ||
    !isAbsolute(path) ||
    path.length <= 0 ||
    path.length > PATH_LIMIT ||
    !Number.isSafeInteger(maximumBytes) ||
    maximumBytes <= 0 ||
    maximumBytes > REMOTE_WORKSPACE_MAX_CANDIDATE_BYTES ||
    (onDescriptorOpened !== undefined && typeof onDescriptorOpened !== "function")
  ) {
    throw new Error("Remote SSH acceptance requires one bounded no-follow file read.");
  }
  let descriptor;
  try {
    descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  } catch (error) {
    throw new Error(`Remote SSH acceptance rejected ${basename(path)} as an unsafe bounded file.`, {
      cause: error
    });
  }
  try {
    const opened = boundedFileSnapshot(fstatSync(descriptor, { bigint: true }), maximumBytes, path);
    onDescriptorOpened?.();
    const namedBefore = boundedFileSnapshot(lstatSync(path, { bigint: true }), maximumBytes, path);
    if (!sameFileSnapshot(opened, namedBefore)) {
      throw new Error(`Remote SSH acceptance rejected ${basename(path)} after its path identity changed.`);
    }
    const chunks = [];
    const buffer = Buffer.alloc(Math.min(64 * 1024, maximumBytes));
    let total = 0;
    while (true) {
      const read = readSync(descriptor, buffer, 0, buffer.length, null);
      if (!Number.isSafeInteger(read) || read < 0) {
        throw new Error("A Remote SSH bounded file read returned an invalid byte count.");
      }
      if (read === 0) break;
      total += read;
      if (total > Number(opened.size) || total > maximumBytes) {
        throw new Error("A Remote SSH bounded file exceeded its pinned read size.");
      }
      chunks.push(Buffer.from(buffer.subarray(0, read)));
    }
    if (total !== Number(opened.size)) {
      throw new Error("A Remote SSH bounded file ended before its pinned byte size.");
    }
    const completed = boundedFileSnapshot(fstatSync(descriptor, { bigint: true }), maximumBytes, path);
    const namedAfter = boundedFileSnapshot(lstatSync(path, { bigint: true }), maximumBytes, path);
    if (!sameFileSnapshot(opened, completed) || !sameFileSnapshot(opened, namedAfter)) {
      throw new Error(`Remote SSH acceptance rejected ${basename(path)} after it changed while being read.`);
    }
    return Buffer.concat(chunks, total).toString("utf8");
  } finally {
    closeSync(descriptor);
  }
}

function canonicalPhaseDescriptor(value) {
  return {
    protocol: value.protocol,
    phase: value.phase,
    runId: value.runId,
    timeoutMs: value.timeoutMs,
    inactivityTimeoutMs: value.inactivityTimeoutMs,
    authority: value.authority,
    version: value.version,
    commit: value.commit,
    candidateSha256: value.candidateSha256,
    candidateBytes: value.candidateBytes,
    remoteSshVersion: value.remoteSshVersion,
    remoteSshBytes: value.remoteSshBytes,
    remoteSshSha256: value.remoteSshSha256,
    hostPidNamespace: value.hostPidNamespace,
    hostNetworkNamespace: value.hostNetworkNamespace,
    hostIpcNamespace: value.hostIpcNamespace,
    hostUtsNamespace: value.hostUtsNamespace,
    hostUserNamespace: value.hostUserNamespace,
    editor: value.editor,
    xvfb: value.xvfb,
    displayMode: value.displayMode,
    testModule: value.testModule,
    python: value.python,
    user: value.user,
    sshConfig: value.sshConfig,
    sshServer: value.sshServer,
    sshLibraryPath: value.sshLibraryPath,
    sshHostKey: value.sshHostKey,
    sshAuthorizedKeys: value.sshAuthorizedKeys,
    hostHome: value.hostHome,
    hostSentinel: value.hostSentinel,
    hostIsolationSha256: value.hostIsolationSha256,
    uid: value.uid,
    gid: value.gid,
    paths: {
      root: value.paths.root,
      workspace: value.paths.workspace,
      userData: value.paths.userData,
      localExtensions: value.paths.localExtensions,
      localHome: value.paths.localHome,
      remoteHome: value.paths.remoteHome,
      result: value.paths.result,
      progress: value.paths.progress
    }
  };
}

function isZeroCapabilityAttestation(value) {
  const properties = LINUX_CAPABILITY_FIELDS.map(([, property]) => property).sort();
  return (
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).sort().join(",") === properties.join(",") &&
    properties.every((property) => value[property] === 0)
  );
}

function canonicalInspectionRoot(path) {
  if (typeof path !== "string" || !isAbsolute(path) || path.length > PATH_LIMIT) {
    throw new Error("Remote SSH acceptance requires one bounded inspection root.");
  }
  const canonical = realpathSync(path);
  const metadata = lstatSync(path, { bigint: true });
  if (canonical !== path || !metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error("The Remote SSH inspection root is not one canonical directory.");
  }
  return canonical;
}

function assertTrustedRegularFile(path, label, root, uid, gid, { mode, executable }) {
  const canonical = realpathSync(path);
  const metadata = lstatSync(path, { bigint: true });
  const permissions = Number(metadata.mode & 0o777n);
  if (
    canonical !== path ||
    !isContained(root, canonical) ||
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.nlink !== 1n ||
    metadata.uid !== BigInt(uid) ||
    metadata.gid !== BigInt(gid) ||
    (permissions & 0o022) !== 0 ||
    (mode !== undefined && permissions !== mode) ||
    (executable && (permissions & 0o100) === 0)
  ) {
    throw new Error(`Remote SSH acceptance requires one owner-private, single-link ${label}.`);
  }
}

function assertTrustedDirectory(path, label, root, uid, gid) {
  const canonical = realpathSync(path);
  const metadata = lstatSync(path, { bigint: true });
  if (
    canonical !== path ||
    (canonical !== root && !isContained(root, canonical)) ||
    !metadata.isDirectory() ||
    metadata.isSymbolicLink() ||
    metadata.nlink < 1n ||
    metadata.uid !== BigInt(uid) ||
    metadata.gid !== BigInt(gid) ||
    Number(metadata.mode & 0o777n) !== 0o700
  ) {
    throw new Error(`Remote SSH acceptance requires one owner-private ${label}.`);
  }
}

function assertPathAbsent(path, label) {
  try {
    lstatSync(path);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw new Error(`The Remote SSH ${label} path could not be proven absent.`, { cause: error });
  }
  throw new Error(`The Remote SSH ${label} path must be absent before phase launch.`);
}

function boundedFileSnapshot(metadata, maximumBytes, path) {
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.nlink !== 1n ||
    metadata.size <= 0n ||
    metadata.size > BigInt(maximumBytes)
  ) {
    throw new Error(`Remote SSH acceptance rejected ${basename(path)} as an unsafe bounded file.`);
  }
  return Object.freeze({
    dev: metadata.dev,
    ino: metadata.ino,
    mode: metadata.mode,
    nlink: metadata.nlink,
    uid: metadata.uid,
    gid: metadata.gid,
    size: metadata.size,
    mtimeNs: metadata.mtimeNs,
    ctimeNs: metadata.ctimeNs,
    birthtimeNs: metadata.birthtimeNs
  });
}

function sameFileSnapshot(left, right) {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.nlink === right.nlink &&
    left.uid === right.uid &&
    left.gid === right.gid &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs &&
    left.birthtimeNs === right.birthtimeNs
  );
}

function hasExactKeys(value, expected) {
  const actual = Object.keys(value).sort();
  const required = [...expected].sort();
  return actual.length === required.length && actual.every((key, index) => key === required[index]);
}

function isContained(parent, candidate) {
  const relation = relative(parent, candidate);
  return relation.length > 0 && relation !== ".." && !relation.startsWith(`..${sep}`) && !isAbsolute(relation);
}

function isCandidateReceipt(sha256, bytes) {
  return (
    typeof sha256 === "string" &&
    /^[0-9a-f]{64}$/u.test(sha256) &&
    Number.isSafeInteger(bytes) &&
    bytes > 0 &&
    bytes <= REMOTE_WORKSPACE_MAX_CANDIDATE_BYTES
  );
}
