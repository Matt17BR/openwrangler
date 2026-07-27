import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync } from "node:fs";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";

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
export const REMOTE_WORKSPACE_MAX_CANDIDATE_BYTES = 64 * 1024 * 1024;
const PATH_LIMIT = 16_384;
const PHASE_DESCRIPTOR_LIMIT_BYTES = 64 * 1024;
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
  python: `${REMOTE_WORKSPACE_NAMESPACE_ROOT}/rh/python/bin/python`,
  sshConfig: `${REMOTE_WORKSPACE_NAMESPACE_ROOT}/rh/ssh/config`,
  sshServer: `${REMOTE_WORKSPACE_NAMESPACE_ROOT}/rh/ssh-runtime/runtime/bin/dropbear`,
  sshLibraryPath: `${REMOTE_WORKSPACE_NAMESPACE_ROOT}/rh/ssh-runtime/runtime/lib`,
  sshHostKey: `${REMOTE_WORKSPACE_NAMESPACE_ROOT}/rh/ssh/host`,
  sshAuthorizedKeys: `${REMOTE_WORKSPACE_NAMESPACE_ROOT}/rh/ssh`
});

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

export function validateRemoteWorkspaceNamespaceAttestation(contents, expected) {
  if (typeof contents !== "string" || Buffer.byteLength(contents, "utf8") > 16 * 1024) {
    throw new Error("The Remote SSH PID-namespace attestation is oversized.");
  }
  if (!/^[0-9a-f-]{36}$/u.test(expected?.runId ?? "")) {
    throw new Error("The Remote SSH PID-namespace expectation is malformed.");
  }
  if (typeof expected?.hostIsolationSha256 !== "string" || !/^[0-9a-f]{64}$/u.test(expected.hostIsolationSha256)) {
    throw new Error("The Remote SSH PID-namespace host-isolation expectation is malformed.");
  }
  const candidate = validateRemoteWorkspaceCandidateExpectation(expected?.sha256, String(expected?.bytes ?? ""));
  const lines = contents.endsWith("\n") ? contents.slice(0, -1).split("\n") : contents.split("\n");
  if (lines.length !== 1) throw new Error("The Remote SSH PID namespace published a malformed attestation.");
  let value;
  try {
    value = JSON.parse(lines[0]);
  } catch (error) {
    throw new Error("The Remote SSH PID namespace published a malformed attestation.", { cause: error });
  }
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
    Object.keys(value).sort().join(",") !==
      "candidateBytes,candidateSha256,commit,display,displayEmpty,hostIsolationSha256,hostname,ipc,namespaceEmpty,network,phase,protocol,remoteAuthority,remoteSshBytes,remoteSshSha256,remoteSshVersion,runId,uts,version"
  ) {
    throw new Error(
      "The Remote SSH PID namespace did not attest its exact candidate, Remote SSH artifact, and empty owned state."
    );
  }
  return Object.freeze(value);
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

export function validateRemoteWorkspaceResult(contents, { runId }) {
  if (typeof contents !== "string" || Buffer.byteLength(contents, "utf8") > 64 * 1024) {
    throw new Error("The Remote SSH acceptance result is oversized.");
  }
  let result;
  try {
    result = JSON.parse(contents);
  } catch (error) {
    throw new Error("The Remote SSH acceptance result is malformed.", { cause: error });
  }
  if (
    !result ||
    result.protocol !== 1 ||
    result.runId !== runId ||
    result.phase !== REMOTE_WORKSPACE_PHASE ||
    result.ok !== true ||
    Object.keys(result).sort().join(",") !== "ok,phase,protocol,runId"
  ) {
    throw new Error("The Remote SSH acceptance phase did not publish one correlated success result.");
  }
  return result;
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
