import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { basename, isAbsolute, relative, resolve, sep } from "node:path";

export const PINNED_REMOTE_VSCODE_VERSION = "1.130.0";
export const PINNED_REMOTE_VSCODE_COMMIT = "1b6a188127eeaf9194f945eb6eb89a657e93c54c";
export const REMOTE_WORKSPACE_PHASE = "remote-workspace";
export const REMOTE_WORKSPACE_AUTHORITY = "ssh-remote+ow-loopback";
export const REMOTE_WORKSPACE_PROTOCOL = 1;
export const REMOTE_WORKSPACE_PHASE_TIMEOUT_MS = 300_000;
export const REMOTE_WORKSPACE_INACTIVITY_TIMEOUT_MS = 180_000;
export const REMOTE_WORKSPACE_PORT = 49_321;
export const REMOTE_WORKSPACE_NAMESPACE_ROOT = "/ow";
const PATH_LIMIT = 16_384;

export function validateRemoteWorkspacePhaseDescriptor(value, privateRoot, { filesystem = true } = {}) {
  if (
    !value ||
    typeof value !== "object" ||
    value.protocol !== REMOTE_WORKSPACE_PROTOCOL ||
    value.phase !== REMOTE_WORKSPACE_PHASE ||
    !/^[0-9a-f-]{36}$/u.test(value.runId) ||
    value.timeoutMs !== REMOTE_WORKSPACE_PHASE_TIMEOUT_MS ||
    value.inactivityTimeoutMs !== REMOTE_WORKSPACE_INACTIVITY_TIMEOUT_MS ||
    value.authority !== REMOTE_WORKSPACE_AUTHORITY ||
    value.version !== PINNED_REMOTE_VSCODE_VERSION ||
    value.commit !== PINNED_REMOTE_VSCODE_COMMIT ||
    value.displayMode !== "xvfb" ||
    !/^pid:\[[0-9]+\]$/u.test(value.hostPidNamespace) ||
    !/^net:\[[0-9]+\]$/u.test(value.hostNetworkNamespace) ||
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
  const root = filesystem ? realpathSync(privateRoot) : resolve(privateRoot);
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
      resolve(external) === root ||
      isContained(root, resolve(external))
    ) {
      throw new Error("The Remote SSH isolation sentinel is malformed.");
    }
  }
  if (filesystem) {
    assertAbsoluteRegularFile(value.testModule, "remote test module");
    assertAbsoluteRegularFile(value.xvfb, "private Xvfb executable");
  }
  return value;
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

export function readBoundedRemoteWorkspaceFile(path, maximumBytes) {
  const metadata = lstatSync(path, { bigint: true });
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.nlink !== 1n ||
    metadata.size <= 0n ||
    metadata.size > BigInt(maximumBytes)
  ) {
    throw new Error(`Remote SSH acceptance rejected ${basename(path)} as an unsafe bounded file.`);
  }
  return readFileSync(path, "utf8");
}

function assertAbsoluteRegularFile(path, label) {
  if (typeof path !== "string" || !isAbsolute(path) || path.length > PATH_LIMIT) {
    throw new Error(`Remote SSH acceptance requires one bounded absolute ${label} path.`);
  }
  const canonical = realpathSync(path);
  const metadata = lstatSync(canonical);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error(`Remote SSH acceptance requires one regular ${label}.`);
  }
}

function isContained(parent, candidate) {
  const relation = relative(parent, candidate);
  return relation.length > 0 && relation !== ".." && !relation.startsWith(`..${sep}`) && !isAbsolute(relation);
}
