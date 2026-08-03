import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  accessSync,
  closeSync,
  constants,
  fdatasyncSync,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  writeSync
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

export const OWNED_CHECKOUT_MOVE_PROTOCOL = "openwrangler-owned-checkout-move-posix-v1";
export const OWNED_CHECKOUT_MOVE_OWNERSHIP_UNCERTAIN = "CHECKOUT_MOVE_OWNERSHIP_UNCERTAIN";
export const OWNED_CHECKOUT_HOST_NAMESPACE_PROTOCOL = "openwrangler-host-namespaces-v1";
export const OWNED_CHECKOUT_HOST_CGROUP_PROTOCOL = "openwrangler-host-cgroup-v2-v1";
export const OWNED_CHECKOUT_PIDFD_PROTOCOL = "openwrangler-owned-checkout-pidfd-v1";
export const OWNED_CHECKOUT_GIT_EXEC_PROTOCOL = "openwrangler-owned-checkout-git-exec-v1";
const TOKEN_PATTERN = /^[0-9a-f]{32}$/u;
const RESULT_CODE_PATTERN = /^[a-z][a-z0-9-]{0,63}$/u;
const MAXIMUM_REQUEST_BYTES = 32 * 1024;
const MAXIMUM_FRAME_BYTES = 1024;
const MAXIMUM_PIDFD_FRAME_BYTES = 64 * 1024;
const MAXIMUM_DIAGNOSTIC_BYTES = 16 * 1024;
const MAXIMUM_PROC_ENTRIES = 131_072;
const MAXIMUM_PROC_LINKS = 1_000_000;
const MAXIMUM_PROC_BYTES = 64 * 1024 * 1024;
const MAXIMUM_MOUNTINFO_BYTES = 8 * 1024 * 1024;
const MAXIMUM_GIT_OUTPUT_BYTES = 64 * 1024;
const MAXIMUM_HELPER_ARTIFACT_BYTES = 512 * 1024;
const MAXIMUM_PIDFD_SUPERVISOR_BYTES = 64 * 1024;
const MAXIMUM_CGROUP_DIRECTORIES = 4_096;
const MAXIMUM_CGROUP_PROCESSES = 512;
const MAXIMUM_CGROUP_FILE_BYTES = 4 * 1024 * 1024;
const MAXIMUM_CGROUP_DRAIN_PASSES = 8;
const PIDFD_TERM_GRACE_MS = 50;
const PIDFD_KILL_GRACE_MS = 1_000;
const PIDFD_PROTOCOL_TIMEOUT_MS = 3_000;
const DEFAULT_READY_TIMEOUT_MS = 10_000;
const DEFAULT_MOVE_TIMEOUT_MS = 30_000;
const DEFAULT_GROUP_GRACE_MS = 2_000;
const PROCESS_SCAN_RECONCILIATION_PASSES = 2;
const GROUP_SCAN_RECONCILIATION_PASSES = 4;
const HELPER_ARTIFACT_FD = 3;
const NODE_RUNTIME_FD = 4;
const GIT_EXECUTABLE_FD = 5;
const PYTHON_RUNTIME_FD = 6;
const PIDFD_SUPERVISOR_FD = 7;
const HELPER_PATH = import.meta.url.startsWith("file:") ? fileURLToPath(import.meta.url) : undefined;
const PIDFD_SUPERVISOR_PATH = import.meta.url.startsWith("file:")
  ? fileURLToPath(new URL("./owned-checkout-pidfd-supervisor.py", import.meta.url))
  : undefined;
const HELPER_BOOTSTRAP_GLOBAL = "__OPEN_WRANGLER_OWNED_MOVE_REQUEST__";
const HELPER_BOOTSTRAP = [
  'import { readFileSync } from "node:fs";',
  `globalThis.${HELPER_BOOTSTRAP_GLOBAL} = process.argv[1];`,
  `const source = readFileSync(${HELPER_ARTIFACT_FD});`,
  'await import(`data:text/javascript;base64,${source.toString("base64")}`);'
].join("\n");
const PRODUCTION_GIT_PATH = "/usr/bin/git";
const PRODUCTION_PYTHON_PATH = "/usr/bin/python3";

function signalPosixProcessGroup(pid, signal, signalProcess = process.kill) {
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    throw new TypeError("A POSIX process-group identity must be one positive safe integer.");
  }
  signalProcess(-pid, signal);
}

class ProcessScanRetry extends Error {}

export class OwnedCheckoutMoveError extends Error {
  constructor(code, message, options) {
    super(message, options);
    this.name = "OwnedCheckoutMoveError";
    this.code = code;
  }
}

function fail(code, message, options) {
  throw new OwnedCheckoutMoveError(code, message, options);
}

function exactKeys(value, keys, label) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).sort().join("\0") !== [...keys].sort().join("\0")
  ) {
    fail("invalid-protocol", `${label} has unknown or missing fields.`);
  }
}

export function parseStrictJson(text, maximumBytes = MAXIMUM_REQUEST_BYTES) {
  if (typeof text !== "string" || Buffer.byteLength(text, "utf8") > maximumBytes) {
    throw new SyntaxError("JSON input exceeded its fixed bound.");
  }
  let offset = 0;
  const skipWhitespace = () => {
    while (offset < text.length) {
      const code = text.charCodeAt(offset);
      if (code !== 0x09 && code !== 0x0a && code !== 0x0d && code !== 0x20) return;
      offset += 1;
    }
  };
  const scanString = () => {
    if (text[offset] !== '"') throw new SyntaxError("Expected a JSON string.");
    const start = offset;
    offset += 1;
    while (offset < text.length) {
      const character = text[offset];
      if (character === '"') {
        offset += 1;
        return JSON.parse(text.slice(start, offset));
      }
      if (character === "\\") {
        offset += 1;
        const escape = text[offset];
        if (escape === "u") {
          if (!/^[0-9a-fA-F]{4}$/u.test(text.slice(offset + 1, offset + 5))) {
            throw new SyntaxError("Malformed JSON Unicode escape.");
          }
          offset += 5;
          continue;
        }
        if (escape === undefined || !'"\\/bfnrt'.includes(escape)) {
          throw new SyntaxError("Malformed JSON escape.");
        }
        offset += 1;
        continue;
      }
      if (character.charCodeAt(0) < 0x20) throw new SyntaxError("Unescaped JSON control character.");
      offset += 1;
    }
    throw new SyntaxError("Unterminated JSON string.");
  };
  const scanValue = (depth) => {
    if (depth > 64) throw new SyntaxError("JSON nesting exceeded its fixed bound.");
    skipWhitespace();
    const character = text[offset];
    if (character === '"') {
      scanString();
      return;
    }
    if (character === "{") {
      offset += 1;
      skipWhitespace();
      const keys = new Set();
      if (text[offset] === "}") {
        offset += 1;
        return;
      }
      while (true) {
        const key = scanString();
        if (keys.has(key)) throw new SyntaxError("Duplicate JSON object key.");
        keys.add(key);
        skipWhitespace();
        if (text[offset] !== ":") throw new SyntaxError("Expected a JSON object colon.");
        offset += 1;
        scanValue(depth + 1);
        skipWhitespace();
        if (text[offset] === "}") {
          offset += 1;
          return;
        }
        if (text[offset] !== ",") throw new SyntaxError("Expected a JSON object separator.");
        offset += 1;
        skipWhitespace();
      }
    }
    if (character === "[") {
      offset += 1;
      skipWhitespace();
      if (text[offset] === "]") {
        offset += 1;
        return;
      }
      while (true) {
        scanValue(depth + 1);
        skipWhitespace();
        if (text[offset] === "]") {
          offset += 1;
          return;
        }
        if (text[offset] !== ",") throw new SyntaxError("Expected a JSON array separator.");
        offset += 1;
      }
    }
    const remainder = text.slice(offset);
    const literal = /^(?:true|false|null)/u.exec(remainder)?.[0];
    if (literal !== undefined) {
      offset += literal.length;
      return;
    }
    const number = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/u.exec(remainder)?.[0];
    if (number === undefined) throw new SyntaxError("Malformed JSON value.");
    offset += number.length;
  };
  scanValue(0);
  skipWhitespace();
  if (offset !== text.length) throw new SyntaxError("Trailing JSON input.");
  return JSON.parse(text);
}

function validateAbsolutePath(value, label) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 8192 ||
    !isAbsolute(value) ||
    resolve(value) !== value ||
    /[\0\r\n]/u.test(value)
  ) {
    fail("invalid-request", `${label} must be one normalized absolute path.`);
  }
  return value;
}

function validateIdentityReceipt(value, label, { includeSize = false } = {}) {
  exactKeys(value, includeSize ? ["device", "inode", "size"] : ["device", "inode"], label);
  for (const key of includeSize ? ["device", "inode", "size"] : ["device", "inode"]) {
    if (typeof value[key] !== "string" || !/^(0|[1-9][0-9]*)$/u.test(value[key])) {
      fail("invalid-request", `${label} contains an invalid ${key}.`);
    }
  }
  if (value.inode === "0") fail("invalid-request", `${label} must name a nonzero inode.`);
  return Object.freeze({ ...value });
}

function validateHostNamespaceAttestation(value) {
  exactKeys(value, ["protocol", "pid", "mount", "user"], "Host namespace attestation");
  if (value.protocol !== OWNED_CHECKOUT_HOST_NAMESPACE_PROTOCOL) {
    fail("invalid-request", "The host namespace attestation protocol is invalid.");
  }
  return Object.freeze({
    protocol: value.protocol,
    pid: validateIdentityReceipt(value.pid, "Host PID namespace"),
    mount: validateIdentityReceipt(value.mount, "Host mount namespace"),
    user: validateIdentityReceipt(value.user, "Host user namespace")
  });
}

function validateProcessReceipt(value, label) {
  exactKeys(value, ["pid", "starttime"], label);
  if (
    !Number.isSafeInteger(value.pid) ||
    value.pid <= 0 ||
    typeof value.starttime !== "string" ||
    !/^[1-9][0-9]*$/u.test(value.starttime)
  ) {
    fail("invalid-request", `${label} contains an invalid process identity.`);
  }
  return Object.freeze({ pid: value.pid, starttime: value.starttime });
}

function validateHostExecutionCgroup(value) {
  exactKeys(
    value,
    ["protocol", "mountPath", "relativePath", "path", "mountId", "mount", "directory", "namespace", "supervisors"],
    "Host execution cgroup receipt"
  );
  if (value.protocol !== OWNED_CHECKOUT_HOST_CGROUP_PROTOCOL) {
    fail("invalid-request", "The host execution cgroup protocol is invalid.");
  }
  validateAbsolutePath(value.mountPath, "Cgroup-v2 mount path");
  validateAbsolutePath(value.path, "Execution cgroup path");
  if (
    typeof value.relativePath !== "string" ||
    !value.relativePath.startsWith("/") ||
    resolve(value.relativePath) !== value.relativePath ||
    /[\0\r\n]/u.test(value.relativePath) ||
    resolve(value.mountPath, `.${value.relativePath}`) !== value.path ||
    typeof value.mountId !== "string" ||
    !/^[1-9][0-9]*$/u.test(value.mountId) ||
    !Array.isArray(value.supervisors) ||
    value.supervisors.length === 0 ||
    value.supervisors.length > 8
  ) {
    fail("invalid-request", "The host execution cgroup receipt is malformed.");
  }
  const supervisors = value.supervisors.map((item, index) =>
    validateProcessReceipt(item, `Cgroup supervisor ${index + 1}`)
  );
  if (new Set(supervisors.map((item) => item.pid)).size !== supervisors.length) {
    fail("invalid-request", "The host execution cgroup supervisors are not unique.");
  }
  return Object.freeze({
    ...value,
    mount: validateIdentityReceipt(value.mount, "Cgroup-v2 mount"),
    directory: validateIdentityReceipt(value.directory, "Execution cgroup directory"),
    namespace: validateIdentityReceipt(value.namespace, "Host cgroup namespace"),
    supervisors: Object.freeze(supervisors)
  });
}

function validateLaunchArtifacts(value) {
  exactKeys(
    value,
    ["helper", "node", "git", "python", "pidfdSupervisor", "gitTrust", "cgroupTrust"],
    "Launch artifact receipt"
  );
  if (!["production", "test"].includes(value.gitTrust)) {
    fail("invalid-request", "The Git launch-artifact trust mode is invalid.");
  }
  if (!["production", "test"].includes(value.cgroupTrust)) {
    fail("invalid-request", "The execution-cgroup trust mode is invalid.");
  }
  return Object.freeze({
    helper: validateIdentityReceipt(value.helper, "Helper launch artifact", { includeSize: true }),
    node: validateIdentityReceipt(value.node, "Node launch artifact"),
    git: validateIdentityReceipt(value.git, "Git launch artifact"),
    python: validateIdentityReceipt(value.python, "Python launch artifact"),
    pidfdSupervisor: validateIdentityReceipt(value.pidfdSupervisor, "pidfd supervisor launch artifact", {
      includeSize: true
    }),
    gitTrust: value.gitTrust,
    cgroupTrust: value.cgroupTrust
  });
}

function validatePublicMoveOptions(value) {
  exactKeys(
    value,
    [
      "sourcePath",
      "destinationPath",
      "managerRepositoryPath",
      "safeCwd",
      "hostNamespaceAttestation",
      "hostExecutionCgroup"
    ],
    "Move options"
  );
  for (const [key, label] of [
    ["sourcePath", "Source path"],
    ["destinationPath", "Destination path"],
    ["managerRepositoryPath", "Manager repository path"],
    ["safeCwd", "Safe working directory"]
  ]) {
    validateAbsolutePath(value[key], label);
  }
  return Object.freeze({
    ...value,
    hostNamespaceAttestation: validateHostNamespaceAttestation(value.hostNamespaceAttestation),
    hostExecutionCgroup: validateHostExecutionCgroup(value.hostExecutionCgroup)
  });
}

function validateRequest(value) {
  exactKeys(
    value,
    [
      "protocol",
      "token",
      "sourcePath",
      "destinationPath",
      "managerRepositoryPath",
      "safeCwd",
      "hostNamespaceAttestation",
      "hostExecutionCgroup",
      "launchArtifacts",
      "moveTimeoutMs"
    ],
    "Move request"
  );
  if (value.protocol !== OWNED_CHECKOUT_MOVE_PROTOCOL || !TOKEN_PATTERN.test(value.token)) {
    fail("invalid-request", "The move request protocol or correlation token is invalid.");
  }
  validateTimeout(value.moveTimeoutMs, "Helper move timeout");
  for (const [key, label] of [
    ["sourcePath", "Source path"],
    ["destinationPath", "Destination path"],
    ["managerRepositoryPath", "Manager repository path"],
    ["safeCwd", "Safe working directory"]
  ]) {
    validateAbsolutePath(value[key], label);
  }
  return Object.freeze({
    ...value,
    hostNamespaceAttestation: validateHostNamespaceAttestation(value.hostNamespaceAttestation),
    hostExecutionCgroup: validateHostExecutionCgroup(value.hostExecutionCgroup),
    launchArtifacts: validateLaunchArtifacts(value.launchArtifacts)
  });
}

function identityOf(metadata) {
  return Object.freeze({ device: metadata.dev.toString(), inode: metadata.ino.toString() });
}

function artifactReceipt(metadata, { includeSize = false } = {}) {
  return Object.freeze({
    ...identityOf(metadata),
    ...(includeSize ? { size: metadata.size.toString() } : {})
  });
}

function sameReceipt(left, right) {
  return (
    left.device === right.device &&
    left.inode === right.inode &&
    (left.size === undefined || right.size === undefined || left.size === right.size)
  );
}

function sameIdentity(left, right) {
  return left.device === right.device && left.inode === right.inode;
}

function currentUserOwns(metadata) {
  return typeof process.getuid !== "function" || metadata.uid === BigInt(process.getuid());
}

function openExecutableArtifact(path, label, { rejectCurrentUserWritable = false } = {}) {
  const canonicalPath = realpathSync(path);
  const named = inspectCanonicalPath(canonicalPath, label, "executable");
  let descriptor;
  try {
    descriptor = openSync(canonicalPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const metadata = fstatSync(descriptor, { bigint: true });
    if (!metadata.isFile() || !sameIdentity(named.identity, identityOf(metadata)) || (metadata.mode & 0o111n) === 0n) {
      fail("unsafe-executable", `${label} changed while its executable descriptor was opened.`);
    }
    if (rejectCurrentUserWritable) {
      let writable = true;
      try {
        accessSync(canonicalPath, constants.W_OK);
      } catch (error) {
        if (error && typeof error === "object" && ["EACCES", "EPERM", "EROFS"].includes(error.code)) writable = false;
        else throw error;
      }
      const namedAfter = lstatSync(canonicalPath, { bigint: true });
      if (!sameIdentity(identityOf(metadata), identityOf(namedAfter)) || writable) {
        fail("unsafe-executable", `${label} is writable by the current production user or changed during binding.`);
      }
    }
    return Object.freeze({ descriptor, receipt: artifactReceipt(metadata), path: canonicalPath });
  } catch (error) {
    if (descriptor !== undefined) closeSync(descriptor);
    if (error instanceof OwnedCheckoutMoveError) throw error;
    fail("unsafe-executable", `${label} could not be descriptor-bound.`, { cause: error });
  }
}

function createAnonymousSourceArtifact(sourcePath, safeCwd, maximumBytes, label) {
  const source = boundedRead(sourcePath, maximumBytes, label);
  const O_TMPFILE = 0o20000000 | constants.O_DIRECTORY;
  let descriptor;
  let readOnlyDescriptor;
  try {
    descriptor = openSync(safeCwd, constants.O_RDWR | O_TMPFILE, 0o400);
    let offset = 0;
    while (offset < source.bytes.length) {
      const count = writeSync(descriptor, source.bytes, offset, source.bytes.length - offset, offset);
      if (count === 0) fail("helper-artifact-failed", `The private ${label} artifact write made no progress.`);
      offset += count;
    }
    fdatasyncSync(descriptor);
    const metadata = fstatSync(descriptor, { bigint: true });
    if (
      !metadata.isFile() ||
      metadata.nlink !== 0n ||
      metadata.size !== BigInt(source.bytes.length) ||
      (metadata.mode & 0o777n) !== 0o400n
    ) {
      fail("helper-artifact-failed", `The private ${label} artifact did not retain its anonymous read-only shape.`);
    }
    const verified = Buffer.alloc(source.bytes.length);
    let readOffset = 0;
    while (readOffset < verified.length) {
      const count = readSync(descriptor, verified, readOffset, verified.length - readOffset, readOffset);
      if (count === 0) fail("helper-artifact-failed", `The private ${label} artifact ended before its recorded size.`);
      readOffset += count;
    }
    if (!verified.equals(source.bytes)) {
      fail("helper-artifact-failed", `The private ${label} artifact did not match its pinned source bytes.`);
    }
    readOnlyDescriptor = openSync(join("/proc/self/fd", String(descriptor)), constants.O_RDONLY);
    const readOnlyMetadata = fstatSync(readOnlyDescriptor, { bigint: true });
    if (!sameIdentity(identityOf(metadata), identityOf(readOnlyMetadata))) {
      fail("helper-artifact-failed", `The read-only ${label} descriptor did not retain the anonymous artifact.`);
    }
    closeSync(descriptor);
    descriptor = undefined;
    return Object.freeze({
      descriptor: readOnlyDescriptor,
      receipt: artifactReceipt(readOnlyMetadata, { includeSize: true })
    });
  } catch (error) {
    if (descriptor !== undefined) closeSync(descriptor);
    if (readOnlyDescriptor !== undefined) closeSync(readOnlyDescriptor);
    if (error instanceof OwnedCheckoutMoveError) throw error;
    fail("helper-artifact-failed", `The private ${label} artifact could not be created.`, { cause: error });
  }
}

function createAnonymousHelperArtifact(safeCwd) {
  return createAnonymousSourceArtifact(HELPER_PATH, safeCwd, MAXIMUM_HELPER_ARTIFACT_BYTES, "move helper source");
}

function createAnonymousPidfdSupervisorArtifact(safeCwd) {
  return createAnonymousSourceArtifact(
    PIDFD_SUPERVISOR_PATH,
    safeCwd,
    MAXIMUM_PIDFD_SUPERVISOR_BYTES,
    "pidfd supervisor source"
  );
}

function linuxDevice(value) {
  const major = ((value >> 8n) & 0xfffn) | ((value >> 32n) & 0xfffff000n);
  const minor = (value & 0xffn) | ((value >> 12n) & 0xffffff00n);
  return `${major}:${minor}`;
}

function inspectCanonicalPath(path, label, kind) {
  let before;
  let canonical;
  let metadata;
  try {
    before = lstatSync(path, { bigint: true });
    canonical = realpathSync(path);
    metadata = lstatSync(path, { bigint: true });
  } catch (error) {
    fail("unsafe-path", `${label} could not be inspected.`, { cause: error });
  }
  const expectedKind = kind === "directory" ? metadata.isDirectory() : metadata.isFile();
  const ownedOrTrustedExecutable =
    currentUserOwns(metadata) || (kind === "executable" && (metadata.mode & 0o022n) === 0n);
  if (
    !sameIdentity(identityOf(before), identityOf(metadata)) ||
    !expectedKind ||
    metadata.isSymbolicLink() ||
    !ownedOrTrustedExecutable ||
    canonical !== path
  ) {
    fail("unsafe-path", `${label} is not one canonical current-user-owned ${kind}.`);
  }
  if (kind === "executable" && (metadata.mode & 0o111n) === 0n) {
    fail("unsafe-path", `${label} is not executable.`);
  }
  return Object.freeze({
    path,
    identity: identityOf(metadata),
    device: metadata.dev.toString(),
    mountDevice: linuxDevice(metadata.dev)
  });
}

function inspectCurrentWorkingDirectory(expectedPath) {
  let metadata;
  let canonical;
  try {
    metadata = lstatSync(".", { bigint: true });
    canonical = realpathSync(".");
  } catch (error) {
    fail("unsafe-path", "The helper working-directory handle could not be inspected.", { cause: error });
  }
  if (
    !metadata.isDirectory() ||
    metadata.isSymbolicLink() ||
    !currentUserOwns(metadata) ||
    canonical !== expectedPath
  ) {
    fail("unsafe-path", "The helper did not retain the exact safe working directory.");
  }
  return identityOf(metadata);
}

function requireMissing(path, label) {
  try {
    lstatSync(path, { bigint: true });
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") return;
    fail("unsafe-path", `${label} could not be inspected.`, { cause: error });
  }
  fail("destination-exists", `${label} already exists.`);
}

function boundedRead(path, maximumBytes, label) {
  let descriptor;
  try {
    const namedBefore = lstatSync(path, { bigint: true });
    if (!namedBefore.isFile() || namedBefore.isSymbolicLink() || !currentUserOwns(namedBefore)) {
      fail("unsafe-path", `${label} is not one current-user-owned regular file.`);
    }
    descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const before = fstatSync(descriptor, { bigint: true });
    if (
      !sameIdentity(identityOf(namedBefore), identityOf(before)) ||
      !before.isFile() ||
      before.isSymbolicLink() ||
      before.size < 0n ||
      before.size > BigInt(maximumBytes)
    ) {
      fail("unsafe-path", `${label} is not one bounded regular file.`);
    }
    const buffer = Buffer.alloc(Number(before.size));
    let offset = 0;
    while (offset < buffer.length) {
      const count = readSync(descriptor, buffer, offset, buffer.length - offset, offset);
      if (count === 0) fail("unsafe-path", `${label} ended before its recorded size.`);
      offset += count;
    }
    const after = fstatSync(descriptor, { bigint: true });
    const namedAfter = lstatSync(path, { bigint: true });
    if (
      !sameIdentity(identityOf(before), identityOf(after)) ||
      !sameIdentity(identityOf(after), identityOf(namedAfter)) ||
      before.size !== after.size
    ) {
      fail("unsafe-path", `${label} changed while it was read.`);
    }
    return Object.freeze({ bytes: buffer, identity: identityOf(before), device: before.dev.toString() });
  } catch (error) {
    if (error instanceof OwnedCheckoutMoveError) throw error;
    fail("unsafe-path", `${label} could not be read safely.`, { cause: error });
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function oneLine(record, label) {
  const value = record.bytes.toString("utf8");
  const line = value.endsWith("\n") ? value.slice(0, -1) : value;
  if (line.length === 0 || /[\0\r\n]/u.test(line)) fail("unsafe-path", `${label} is malformed.`);
  return line;
}

function inside(path, root) {
  return path === root || (root === sep ? path.startsWith(sep) : path.startsWith(`${root}${sep}`));
}

function disjointPaths(request) {
  const protectedPaths = [request.sourcePath, request.destinationPath, request.managerRepositoryPath];
  for (let left = 0; left < protectedPaths.length; left += 1) {
    for (let right = left + 1; right < protectedPaths.length; right += 1) {
      if (inside(protectedPaths[left], protectedPaths[right]) || inside(protectedPaths[right], protectedPaths[left])) {
        fail("unsafe-layout", "The source, destination, and manager repository must not overlap.");
      }
    }
  }
  if (protectedPaths.some((path) => inside(request.safeCwd, path))) {
    fail("unsafe-layout", "The helper working directory must be outside every moved or managed path.");
  }
}

function decodeMountPath(value) {
  return value.replace(/\\(040|011|012|134)/gu, (_, code) => {
    if (code === "040") return " ";
    if (code === "011") return "\t";
    if (code === "012") return "\n";
    return "\\";
  });
}

export function parseLinuxMountInfo(value) {
  if (typeof value !== "string" || Buffer.byteLength(value, "utf8") > MAXIMUM_MOUNTINFO_BYTES) {
    fail("unsafe-mount", "Linux mount information exceeded its fixed bound.");
  }
  const entries = [];
  for (const line of value.split("\n")) {
    if (line === "") continue;
    const separator = line.indexOf(" - ");
    const fields = separator < 0 ? [] : line.slice(0, separator).split(" ");
    const filesystemFields = separator < 0 ? [] : line.slice(separator + 3).split(" ");
    if (
      fields.length < 6 ||
      filesystemFields.length < 3 ||
      !/^[1-9][0-9]*$/u.test(fields[0]) ||
      !/^[0-9]+:[0-9]+$/u.test(fields[2]) ||
      !/^[a-zA-Z0-9._-]+$/u.test(filesystemFields[0])
    ) {
      fail("unsafe-mount", "Linux mount information was malformed.");
    }
    const mountPoint = decodeMountPath(fields[4]);
    if (!isAbsolute(mountPoint) || resolve(mountPoint) !== mountPoint || /[\0\r\n]/u.test(mountPoint)) {
      fail("unsafe-mount", "Linux mount information contained an unsafe mount point.");
    }
    entries.push(
      Object.freeze({
        id: fields[0],
        device: fields[2],
        mountPoint,
        mountOptions: fields[5].split(","),
        filesystemType: filesystemFields[0]
      })
    );
    if (entries.length > MAXIMUM_PROC_ENTRIES) fail("unsafe-mount", "Linux mount information had too many entries.");
  }
  if (entries.length === 0) fail("unsafe-mount", "Linux mount information was empty.");
  return Object.freeze(entries);
}

function mountFor(entries, path) {
  const matches = entries.filter((entry) => inside(path, entry.mountPoint));
  if (matches.length === 0) fail("unsafe-mount", "A move path had no matching Linux mount.");
  const longest = Math.max(...matches.map((entry) => entry.mountPoint.length));
  const exact = matches.filter((entry) => entry.mountPoint.length === longest);
  if (exact.length !== 1) fail("unsafe-mount", "A move path had an ambiguous Linux mount.");
  return exact[0];
}

export function validateMoveMountTopology({ entries, paths, protectedRoots }) {
  if (!Array.isArray(entries) || !Array.isArray(paths) || !Array.isArray(protectedRoots) || paths.length === 0) {
    fail("unsafe-mount", "The move mount observation is malformed.");
  }
  const mounts = paths.map((item) => mountFor(entries, item.path));
  const mountIds = new Set(mounts.map((item) => item.id));
  const devices = new Set(paths.map((item) => item.device));
  if (
    mountIds.size !== 1 ||
    devices.size !== 1 ||
    paths.some((item, index) => item.mountDevice !== mounts[index].device)
  ) {
    fail("cross-mount", "The move paths do not share one filesystem mount and device.");
  }
  for (const root of protectedRoots) {
    if (entries.some((entry) => inside(entry.mountPoint, root) && entry.mountPoint !== mounts[0].mountPoint)) {
      fail("nested-mount", "A moved or managed path contains a nested mount.");
    }
  }
  return Object.freeze({ mountId: mounts[0].id, device: paths[0].device });
}

function readProcFile(path, maximumBytes, budget, label) {
  let descriptor;
  try {
    descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const before = fstatSync(descriptor, { bigint: true });
    if (!before.isFile()) fail("process-scan-uncertain", `${label} is not a regular process file.`);
    const chunks = [];
    let total = 0;
    while (true) {
      const chunk = Buffer.alloc(Math.min(64 * 1024, maximumBytes + 1 - total));
      const count = readSync(descriptor, chunk, 0, chunk.length, null);
      if (count === 0) break;
      total += count;
      if (total > maximumBytes) fail("process-scan-bound", `${label} exceeded its fixed bound.`);
      chunks.push(chunk.subarray(0, count));
    }
    const after = fstatSync(descriptor, { bigint: true });
    if (!sameIdentity(identityOf(before), identityOf(after))) {
      fail("process-scan-uncertain", `${label} changed identity while it was read.`);
    }
    budget.bytes += total;
    if (budget.bytes > MAXIMUM_PROC_BYTES) fail("process-scan-bound", "The process-use scan exceeded its byte bound.");
    return Buffer.concat(chunks, total).toString("utf8");
  } catch (error) {
    if (error instanceof OwnedCheckoutMoveError) throw error;
    fail("process-scan-uncertain", `${label} could not be read safely.`, { cause: error });
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function procEntryVanished(error) {
  return error && typeof error === "object" && ["ENOENT", "ESRCH"].includes(error.code);
}

function targetFromProcLink(path, label, { allowVanished = false } = {}) {
  try {
    return readlinkSync(path);
  } catch (error) {
    if (procEntryVanished(error) && allowVanished) return undefined;
    if (procEntryVanished(error)) throw new ProcessScanRetry();
    fail("process-scan-uncertain", `${label} could not be inspected.`, { cause: error });
  }
}

function pathUsesProtectedRoot(value, roots) {
  if (typeof value !== "string") return false;
  const normalized = value.endsWith(" (deleted)") ? value.slice(0, -10) : value;
  return isAbsolute(normalized) && roots.some((root) => inside(normalized, root));
}

function statusUids(value) {
  const match = /^Uid:\s+([0-9]+)\s+([0-9]+)\s+([0-9]+)\s+([0-9]+)$/mu.exec(value);
  if (match === null) fail("process-scan-uncertain", "A process status did not expose four user identities.");
  const values = match.slice(1).map(Number);
  if (values.some((item) => !Number.isSafeInteger(item))) {
    fail("process-scan-uncertain", "A process status contained an invalid user identity.");
  }
  return values;
}

function inspectProcDirectory(path, label) {
  try {
    const metadata = lstatSync(path, { bigint: true });
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      fail("process-scan-uncertain", `${label} is not one process directory.`);
    }
    return identityOf(metadata);
  } catch (error) {
    if (procEntryVanished(error)) throw new ProcessScanRetry();
    if (error instanceof OwnedCheckoutMoveError) throw error;
    fail("process-scan-uncertain", `${label} could not be inspected.`, { cause: error });
  }
}

function parseLinuxProcessIdentity(value, expectedPid) {
  const opening = value.indexOf("(");
  const closing = value.lastIndexOf(")");
  const pidText = opening < 0 ? "" : value.slice(0, opening).trim();
  const fields =
    closing < opening
      ? []
      : value
          .slice(closing + 2)
          .trim()
          .split(/\s+/u);
  if (
    !/^[1-9][0-9]*$/u.test(pidText) ||
    Number(pidText) !== expectedPid ||
    fields.length < 20 ||
    !/^[A-Za-z]$/u.test(fields[0]) ||
    !/^[0-9]+$/u.test(fields[2]) ||
    !/^[0-9]+$/u.test(fields[3]) ||
    !/^[1-9][0-9]*$/u.test(fields[19])
  ) {
    fail("process-scan-uncertain", "A Linux process identity was malformed.");
  }
  const identity = Object.freeze({
    pid: Number(pidText),
    state: fields[0],
    processGroup: Number(fields[2]),
    session: Number(fields[3]),
    starttime: fields[19]
  });
  if (
    !Number.isSafeInteger(identity.pid) ||
    !Number.isSafeInteger(identity.processGroup) ||
    !Number.isSafeInteger(identity.session)
  ) {
    fail("process-scan-uncertain", "A Linux process identity exceeded its numeric bounds.");
  }
  return identity;
}

function sameProcessIdentity(left, right) {
  return (
    left.pid === right.pid &&
    left.processGroup === right.processGroup &&
    left.session === right.session &&
    left.starttime === right.starttime
  );
}

function readProcessIdentity(procRoot, pid, budget) {
  try {
    return parseLinuxProcessIdentity(
      readProcFile(join(procRoot, String(pid), "stat"), 64 * 1024, budget, "Process identity"),
      pid
    );
  } catch (error) {
    if (procEntryVanished(error.cause ?? error)) throw new ProcessScanRetry();
    throw error;
  }
}

function stableDirectoryIdentity(path, before, label) {
  const after = inspectProcDirectory(path, label);
  if (!sameIdentity(before, after)) throw new ProcessScanRetry();
}

function scanOneProcess({ procRoot, pid, uid, protectedRoots, budget }) {
  const directory = join(procRoot, String(pid));
  const directoryBefore = inspectProcDirectory(directory, "Process directory");
  const identityBefore = readProcessIdentity(procRoot, pid, budget);
  let statusBefore;
  try {
    statusBefore = readProcFile(join(directory, "status"), 64 * 1024, budget, "Process status");
  } catch (error) {
    if (procEntryVanished(error.cause ?? error)) throw new ProcessScanRetry();
    throw error;
  }
  const uidsBefore = statusUids(statusBefore);
  const sameUid = uidsBefore.includes(uid);
  if (sameUid && !["X", "Z"].includes(identityBefore.state)) {
    for (const name of ["cwd", "root", "exe"]) {
      budget.links += 1;
      if (budget.links > MAXIMUM_PROC_LINKS)
        fail("process-scan-bound", "The process-use scan exceeded its link bound.");
      const target = targetFromProcLink(join(directory, name), `Process ${name}`);
      if (pathUsesProtectedRoot(target, protectedRoots)) {
        fail("checkout-in-use", "Another current-user process is using a protected checkout path.");
      }
    }
    const descriptorDirectory = join(directory, "fd");
    const descriptorDirectoryBefore = inspectProcDirectory(descriptorDirectory, "Process descriptor directory");
    let descriptors;
    try {
      descriptors = readdirSync(descriptorDirectory, { withFileTypes: true });
    } catch (error) {
      if (procEntryVanished(error)) throw new ProcessScanRetry();
      fail("process-scan-uncertain", "A current-user process descriptor table could not be inspected.", {
        cause: error
      });
    }
    budget.links += descriptors.length;
    if (budget.links > MAXIMUM_PROC_LINKS) fail("process-scan-bound", "The process-use scan exceeded its link bound.");
    for (const descriptor of descriptors) {
      const target = targetFromProcLink(join(descriptorDirectory, descriptor.name), "Process file descriptor", {
        allowVanished: true
      });
      if (pathUsesProtectedRoot(target, protectedRoots)) {
        fail("checkout-in-use", "Another current-user process has a protected checkout path open.");
      }
    }
    stableDirectoryIdentity(descriptorDirectory, descriptorDirectoryBefore, "Process descriptor directory");
    let maps;
    try {
      maps = readProcFile(join(directory, "maps"), 8 * 1024 * 1024, budget, "Process memory map");
    } catch (error) {
      if (procEntryVanished(error.cause ?? error)) throw new ProcessScanRetry();
      throw error;
    }
    for (const line of maps.split("\n")) {
      const start = line.indexOf("/");
      if (start >= 0 && pathUsesProtectedRoot(line.slice(start), protectedRoots)) {
        fail("checkout-in-use", "Another current-user process maps a protected checkout path.");
      }
    }
  }
  let statusAfter;
  try {
    statusAfter = readProcFile(join(directory, "status"), 64 * 1024, budget, "Process status");
  } catch (error) {
    if (procEntryVanished(error.cause ?? error)) throw new ProcessScanRetry();
    throw error;
  }
  const uidsAfter = statusUids(statusAfter);
  const identityAfter = readProcessIdentity(procRoot, pid, budget);
  stableDirectoryIdentity(directory, directoryBefore, "Process directory");
  if (!sameProcessIdentity(identityBefore, identityAfter) || uidsBefore.join(":") !== uidsAfter.join(":")) {
    throw new ProcessScanRetry();
  }
  return Object.freeze({
    fingerprint: `${pid}:${directoryBefore.device}:${directoryBefore.inode}:${identityBefore.starttime}:${identityBefore.processGroup}:${identityBefore.session}:${uidsBefore.join(":")}`,
    sameUid
  });
}

function processEntries(procRoot) {
  let entries;
  try {
    entries = readdirSync(procRoot, { withFileTypes: true });
  } catch (error) {
    fail("process-scan-uncertain", "The Linux process table could not be enumerated.", { cause: error });
  }
  if (entries.length > MAXIMUM_PROC_ENTRIES) fail("process-scan-bound", "The process table exceeded its entry bound.");
  return entries
    .filter((entry) => entry.isDirectory() && /^[1-9][0-9]*$/u.test(entry.name))
    .map((entry) => Number(entry.name))
    .filter((pid) => Number.isSafeInteger(pid))
    .sort((left, right) => left - right);
}

function scanProcessPass({ procRoot, protectedRoots, currentPid, uid, budget }) {
  const entries = processEntries(procRoot);
  const fingerprints = [];
  let sameUidProcesses = 0;
  let churnedProcesses = 0;
  for (const pid of entries) {
    if (pid === currentPid) continue;
    let observed;
    try {
      observed = scanOneProcess({ procRoot, pid, uid, protectedRoots, budget });
    } catch (error) {
      if (error instanceof ProcessScanRetry) {
        churnedProcesses += 1;
        continue;
      }
      throw error;
    }
    fingerprints.push(observed.fingerprint);
    if (observed.sameUid) sameUidProcesses += 1;
  }
  return Object.freeze({ fingerprint: fingerprints.join("\n"), sameUidProcesses, churnedProcesses });
}

export function scanSameUidProcessUse({
  procRoot = "/proc",
  protectedRoots,
  currentPid = process.pid,
  uid = typeof process.getuid === "function" ? process.getuid() : undefined
}) {
  if (
    !Array.isArray(protectedRoots) ||
    protectedRoots.length === 0 ||
    protectedRoots.some((path) => !isAbsolute(path) || resolve(path) !== path)
  ) {
    fail("process-scan-uncertain", "The process-use roots are malformed.");
  }
  if (!Number.isSafeInteger(uid) || uid < 0) {
    fail("process-scan-uncertain", "Linux process-use checks require one numeric current-user identity.");
  }
  const budget = { bytes: 0, links: 0 };
  let inspectedProcesses = 0;
  let sameUidProcesses = 0;
  let churnedProcesses = 0;
  // Each PID observation pins start time plus proc/status/fd directory
  // identity. A process that vanishes during that observation cannot retain a
  // checkout handle; a replacement is considered afresh by the second full
  // sweep. Requiring the unrelated global PID set itself to stop changing
  // would make a safe move impossible on an otherwise busy workstation.
  for (let attempt = 0; attempt < PROCESS_SCAN_RECONCILIATION_PASSES; attempt += 1) {
    const current = scanProcessPass({ procRoot, protectedRoots, currentPid, uid, budget });
    inspectedProcesses += current.fingerprint === "" ? 0 : current.fingerprint.split("\n").length;
    sameUidProcesses += current.sameUidProcesses;
    churnedProcesses += current.churnedProcesses;
  }
  return Object.freeze({
    inspectedProcesses,
    sameUidProcesses,
    churnedProcesses,
    inspectedLinks: budget.links,
    inspectedBytes: budget.bytes,
    reconciliationPasses: PROCESS_SCAN_RECONCILIATION_PASSES
  });
}

function readMountInfo(procRoot) {
  return parseLinuxMountInfo(
    readProcFile(join(procRoot, "self", "mountinfo"), MAXIMUM_MOUNTINFO_BYTES, { bytes: 0 }, "Mount information")
  );
}

function requireOwnedHelperGroup(procRoot) {
  let identity;
  try {
    identity = parseLinuxProcessIdentity(
      readProcFile(join(procRoot, "self", "stat"), 64 * 1024, { bytes: 0 }, "Helper process identity"),
      process.pid
    );
  } catch (error) {
    fail("process-group-uncertain", "The move helper identity could not be pinned.", { cause: error });
  }
  if (identity.processGroup !== process.pid || identity.session !== process.pid) {
    fail("process-group-uncertain", "The move helper is not the leader of its private POSIX session and group.");
  }
  return identity;
}

function worktreeBacklinks(request, checkoutPath = request.sourcePath) {
  const dotGitPath = join(checkoutPath, ".git");
  const dotGit = boundedRead(dotGitPath, 8192, "Checkout Git link");
  const match = /^gitdir: (.+)$/u.exec(oneLine(dotGit, "Checkout Git link"));
  if (match === null || !isAbsolute(match[1]) || resolve(match[1]) !== match[1]) {
    fail("unsafe-worktree", "The checkout Git link is malformed.");
  }
  const adminPath = realpathSync(match[1]);
  const worktreesRoot = join(request.managerRepositoryPath, "worktrees");
  const adminRelative = relative(worktreesRoot, adminPath);
  if (adminRelative === "" || adminRelative.startsWith(`..${sep}`) || adminRelative.includes(sep)) {
    fail("unsafe-worktree", "The checkout is not one direct worktree of the recorded manager.");
  }
  const admin = inspectCanonicalPath(adminPath, "Worktree administration directory", "directory");
  const commonDirectory = boundedRead(join(adminPath, "commondir"), 8192, "Worktree common-directory link");
  const commonValue = oneLine(commonDirectory, "Worktree common-directory link");
  if (realpathSync(resolve(adminPath, commonValue)) !== request.managerRepositoryPath) {
    fail("unsafe-worktree", "The worktree common-directory link does not name the recorded manager.");
  }
  const adminGitDirectory = boundedRead(join(adminPath, "gitdir"), 8192, "Worktree backlink");
  const backlinkValue = oneLine(adminGitDirectory, "Worktree backlink");
  if (!isAbsolute(backlinkValue) || resolve(backlinkValue) !== dotGitPath) {
    fail("unsafe-worktree", "The worktree backlink does not name the exact checkout Git file.");
  }
  return Object.freeze({
    dotGitPath,
    adminPath,
    dotGitIdentity: dotGit.identity,
    adminIdentity: admin.identity,
    commonIdentity: commonDirectory.identity,
    backlinkIdentity: adminGitDirectory.identity
  });
}

export function inspectOwnedCheckoutMove(requestValue, { procRoot = "/proc", requireCurrentCwd = false } = {}) {
  if (process.platform !== "linux")
    fail("unsupported-platform", "Owned checkout movement is Linux-only in this slice.");
  const request = validateRequest(requestValue);
  verifyHostNamespaceAttestation(request, procRoot);
  disjointPaths(request);
  const source = inspectCanonicalPath(request.sourcePath, "Checkout source", "directory");
  const destinationParent = inspectCanonicalPath(dirname(request.destinationPath), "Destination parent", "directory");
  const manager = inspectCanonicalPath(request.managerRepositoryPath, "Manager repository", "directory");
  const safeCwd = inspectCanonicalPath(request.safeCwd, "Helper working directory", "directory");
  const currentCwdIdentity = requireCurrentCwd ? inspectCurrentWorkingDirectory(request.safeCwd) : safeCwd.identity;
  if (!sameIdentity(currentCwdIdentity, safeCwd.identity)) {
    fail("unsafe-path", "The helper working-directory path no longer names its retained directory.");
  }
  requireMissing(request.destinationPath, "Checkout destination");
  const links = worktreeBacklinks(request);
  const mount = validateMoveMountTopology({
    entries: readMountInfo(procRoot),
    paths: [source, destinationParent, manager, safeCwd],
    protectedRoots: [request.sourcePath, request.destinationPath, request.managerRepositoryPath]
  });
  scanSameUidProcessUse({
    procRoot,
    protectedRoots: [request.sourcePath, request.destinationPath, request.managerRepositoryPath],
    currentPid: process.pid
  });
  return Object.freeze({
    request,
    sourceIdentity: source.identity,
    destinationParentIdentity: destinationParent.identity,
    managerIdentity: manager.identity,
    safeCwdIdentity: safeCwd.identity,
    currentCwdIdentity,
    links,
    mount
  });
}

function sameInspection(left, right) {
  return (
    sameIdentity(left.sourceIdentity, right.sourceIdentity) &&
    sameIdentity(left.destinationParentIdentity, right.destinationParentIdentity) &&
    sameIdentity(left.managerIdentity, right.managerIdentity) &&
    sameIdentity(left.safeCwdIdentity, right.safeCwdIdentity) &&
    sameIdentity(left.currentCwdIdentity, right.currentCwdIdentity) &&
    sameIdentity(left.links.dotGitIdentity, right.links.dotGitIdentity) &&
    sameIdentity(left.links.adminIdentity, right.links.adminIdentity) &&
    sameIdentity(left.links.commonIdentity, right.links.commonIdentity) &&
    sameIdentity(left.links.backlinkIdentity, right.links.backlinkIdentity) &&
    left.mount.mountId === right.mount.mountId &&
    left.mount.device === right.mount.device
  );
}

function requireAbsent(path, label) {
  try {
    lstatSync(path, { bigint: true });
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") return;
    fail("move-indeterminate", `${label} could not be proven absent after Git terminated.`, { cause: error });
  }
  fail("move-indeterminate", `${label} still exists after Git terminated.`);
}

function verifyMovedCheckoutState(initial, { procRoot = "/proc" } = {}) {
  const { request } = initial;
  verifyHostNamespaceAttestation(request, procRoot);
  requireAbsent(request.sourcePath, "Checkout source");
  const destination = inspectCanonicalPath(request.destinationPath, "Moved checkout destination", "directory");
  const destinationParent = inspectCanonicalPath(dirname(request.destinationPath), "Destination parent", "directory");
  const manager = inspectCanonicalPath(request.managerRepositoryPath, "Manager repository", "directory");
  const safeCwd = inspectCanonicalPath(request.safeCwd, "Helper working directory", "directory");
  const currentCwdIdentity = inspectCurrentWorkingDirectory(request.safeCwd);
  const links = worktreeBacklinks(request, request.destinationPath);
  const mount = validateMoveMountTopology({
    entries: readMountInfo(procRoot),
    paths: [destination, destinationParent, manager, safeCwd],
    protectedRoots: [request.destinationPath, request.managerRepositoryPath]
  });
  if (
    !sameIdentity(initial.sourceIdentity, destination.identity) ||
    destination.device !== initial.mount.device ||
    !sameIdentity(initial.destinationParentIdentity, destinationParent.identity) ||
    !sameIdentity(initial.managerIdentity, manager.identity) ||
    !sameIdentity(initial.safeCwdIdentity, safeCwd.identity) ||
    !sameIdentity(initial.currentCwdIdentity, currentCwdIdentity) ||
    !sameIdentity(initial.links.dotGitIdentity, links.dotGitIdentity) ||
    !sameIdentity(initial.links.adminIdentity, links.adminIdentity) ||
    !sameIdentity(initial.links.commonIdentity, links.commonIdentity) ||
    !sameIdentity(initial.links.backlinkIdentity, links.backlinkIdentity) ||
    mount.mountId !== initial.mount.mountId ||
    mount.device !== initial.mount.device
  ) {
    fail("move-indeterminate", "The exact moved-checkout identity did not reconcile after Git terminated.");
  }
}

async function verifyMovedCheckout(initial, options) {
  try {
    await verifyMovedCheckoutState(initial, options);
  } catch (error) {
    if (error instanceof OwnedCheckoutMoveError && error.code === "move-indeterminate") throw error;
    fail("move-indeterminate", "Post-move verification was indeterminate after Git terminated.", {
      cause: error
    });
  }
}

function verifyUnchangedCheckoutState(initial, { procRoot = "/proc" } = {}) {
  const { request } = initial;
  verifyHostNamespaceAttestation(request, procRoot);
  const current = inspectOwnedCheckoutMove(request, { procRoot, requireCurrentCwd: true });
  if (!sameInspection(initial, current)) {
    fail("move-indeterminate", "Git failed after changing the checkout or its worktree administration state.");
  }
}

async function verifyUnchangedCheckout(initial, options) {
  try {
    await verifyUnchangedCheckoutState(initial, options);
  } catch (error) {
    if (error instanceof OwnedCheckoutMoveError && error.code === "move-indeterminate") throw error;
    fail("move-indeterminate", "The original checkout state could not be reconciled after Git failed.", {
      cause: error
    });
  }
}

async function reconcileCheckoutAfterGit(initial, result, options) {
  const succeeded = result.code === 0 && result.signal === null;
  if (succeeded) await verifyMovedCheckout(initial, options);
  else await verifyUnchangedCheckout(initial, options);
  return succeeded;
}

function processIdentityOrMissing(procRoot, pid, label = "Process-group identity") {
  try {
    return parseLinuxProcessIdentity(
      readProcFile(join(procRoot, String(pid), "stat"), 64 * 1024, { bytes: 0 }, label),
      pid
    );
  } catch (error) {
    if (procEntryVanished(error.cause ?? error)) return undefined;
    fail("process-group-uncertain", "The POSIX process group could not be inspected.", { cause: error });
  }
}

function namespaceReceipt(procRoot, name, pid = "self") {
  let descriptor;
  try {
    descriptor = openSync(join(procRoot, String(pid), "ns", name), constants.O_RDONLY);
    const before = fstatSync(descriptor, { bigint: true });
    const after = fstatSync(descriptor, { bigint: true });
    if (!sameIdentity(identityOf(before), identityOf(after)) || before.ino === 0n) {
      fail("namespace-uncertain", `The ${name} namespace identity changed while it was pinned.`);
    }
    return artifactReceipt(before);
  } catch (error) {
    if (error instanceof OwnedCheckoutMoveError) throw error;
    fail("namespace-uncertain", `The ${name} namespace identity could not be pinned.`, { cause: error });
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function verifyHostNamespaceAttestation(request, procRoot) {
  const expected = request.hostNamespaceAttestation;
  for (const [key, procName] of [
    ["pid", "pid"],
    ["mount", "mnt"],
    ["user", "user"]
  ]) {
    const current = namespaceReceipt(procRoot, procName);
    if (!sameReceipt(expected[key], current)) {
      fail("namespace-mismatch", `The helper ${key} namespace does not match the trusted host attestation.`);
    }
  }
}

function inspectPinnedDirectory(path, expected, label, expectedDevice) {
  let before;
  let canonical;
  let after;
  try {
    before = lstatSync(path, { bigint: true });
    canonical = realpathSync(path);
    after = lstatSync(path, { bigint: true });
  } catch (error) {
    fail("cgroup-uncertain", `${label} could not be inspected.`, { cause: error });
  }
  if (
    !before.isDirectory() ||
    before.isSymbolicLink() ||
    !sameIdentity(identityOf(before), identityOf(after)) ||
    !sameReceipt(expected, artifactReceipt(after)) ||
    canonical !== path ||
    (expectedDevice !== undefined && after.dev.toString() !== expectedDevice)
  ) {
    fail("cgroup-uncertain", `${label} does not match its trusted host receipt.`);
  }
  return Object.freeze({ identity: identityOf(after), device: after.dev.toString() });
}

function parseProcessCgroup(value) {
  const lines = value.trimEnd().split("\n");
  if (lines.length !== 1) fail("cgroup-uncertain", "A process cgroup membership was not one cgroup-v2 record.");
  const match = /^0::(\/[\u0020-\u007e]*)$/u.exec(lines[0]);
  if (match === null || /[\\\0\r\n]/u.test(match[1]) || resolve(match[1]) !== match[1]) {
    fail("cgroup-uncertain", "A process cgroup-v2 membership was malformed.");
  }
  return match[1];
}

function processCgroupPath(procRoot, pid) {
  return parseProcessCgroup(
    readProcFile(join(procRoot, String(pid), "cgroup"), 64 * 1024, { bytes: 0 }, "Process cgroup membership")
  );
}

function verifyExecutionCgroupBase(request, procRoot) {
  const receipt = request.hostExecutionCgroup;
  const testMode = request.launchArtifacts.cgroupTrust === "test";
  const currentNamespace = namespaceReceipt(procRoot, "cgroup");
  if (!sameReceipt(receipt.namespace, currentNamespace)) {
    fail("cgroup-namespace-mismatch", "The helper cgroup namespace does not match the trusted host receipt.");
  }
  const mount = inspectPinnedDirectory(receipt.mountPath, receipt.mount, "Cgroup-v2 mount");
  inspectPinnedDirectory(receipt.path, receipt.directory, "Execution cgroup", mount.device);
  if (!inside(receipt.path, receipt.mountPath)) {
    fail("cgroup-uncertain", "The execution cgroup is outside its trusted cgroup-v2 mount.");
  }
  if (!testMode) {
    const matches = readMountInfo(procRoot).filter((entry) => entry.mountPoint === receipt.mountPath);
    if (
      matches.length !== 1 ||
      matches[0].id !== receipt.mountId ||
      matches[0].filesystemType !== "cgroup2" ||
      !matches[0].mountOptions.includes("ro") ||
      matches[0].device !== linuxDevice(BigInt(receipt.mount.device)) ||
      processCgroupPath(procRoot, "self") !== receipt.relativePath
    ) {
      fail("cgroup-uncertain", "The execution cgroup is not one exact read-only host cgroup-v2 mount and membership.");
    }
    const cgroupType = readProcFile(join(receipt.path, "cgroup.type"), 64, { bytes: 0 }, "Execution cgroup type");
    if (cgroupType !== "domain\n") {
      fail("cgroup-uncertain", "The execution cgroup is not one domain cgroup.");
    }
  }
  return Object.freeze({ testMode, device: mount.device });
}

function parseCgroupProcesses(value, { testMode }) {
  const processes = [];
  for (const line of value.split("\n")) {
    if (line === "") continue;
    if (testMode && line === "0") {
      processes.push(process.pid);
    } else if (/^[1-9][0-9]*$/u.test(line)) {
      const pid = Number(line);
      if (!Number.isSafeInteger(pid)) fail("cgroup-bound", "An execution-cgroup PID exceeded its numeric bound.");
      processes.push(pid);
    } else {
      fail("cgroup-uncertain", "An execution-cgroup process list was malformed.");
    }
  }
  return processes;
}

function scanExecutionCgroupTree(request, procRoot) {
  const { testMode, device } = verifyExecutionCgroupBase(request, procRoot);
  const root = request.hostExecutionCgroup.path;
  const pending = [root];
  const directories = [];
  const processes = new Set();
  const budget = { bytes: 0 };
  while (pending.length > 0) {
    const path = pending.shift();
    let before;
    let entries;
    try {
      before = lstatSync(path, { bigint: true });
      entries = readdirSync(path, { withFileTypes: true }).sort((left, right) =>
        left.name.localeCompare(right.name, "en")
      );
    } catch (error) {
      fail("cgroup-uncertain", "The execution cgroup tree could not be enumerated.", { cause: error });
    }
    if (
      !before.isDirectory() ||
      before.isSymbolicLink() ||
      before.dev.toString() !== device ||
      realpathSync(path) !== path
    ) {
      fail("cgroup-uncertain", "The execution cgroup tree changed or crossed a filesystem boundary.");
    }
    const relativePath = relative(root, path);
    directories.push(`${relativePath}\0${before.dev.toString()}\0${before.ino.toString()}`);
    if (directories.length > MAXIMUM_CGROUP_DIRECTORIES) {
      fail("cgroup-bound", "The execution cgroup tree exceeded its directory bound.");
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) fail("cgroup-uncertain", "The execution cgroup tree contained a symbolic link.");
      if (!entry.isDirectory()) continue;
      const child = join(path, entry.name);
      if (!inside(child, root)) fail("cgroup-uncertain", "The execution cgroup tree escaped its root.");
      pending.push(child);
    }
    const membership = readProcFile(
      join(path, "cgroup.procs"),
      MAXIMUM_CGROUP_FILE_BYTES,
      budget,
      "Execution cgroup process list"
    );
    for (const pid of parseCgroupProcesses(membership, { testMode })) {
      processes.add(pid);
      if (processes.size > MAXIMUM_CGROUP_PROCESSES) {
        fail("cgroup-bound", "The execution cgroup exceeded its process bound.");
      }
    }
    const after = lstatSync(path, { bigint: true });
    if (!sameIdentity(identityOf(before), identityOf(after))) {
      fail("cgroup-uncertain", "The execution cgroup tree changed while it was scanned.");
    }
  }
  return Object.freeze({
    testMode,
    tree: directories.sort().join("\n"),
    pids: Object.freeze([...processes].sort((left, right) => left - right))
  });
}

function sameCgroupSnapshot(left, right) {
  return left.tree === right.tree && left.pids.join("\n") === right.pids.join("\n");
}

function addAllowedProcess(map, identity, label) {
  const previous = map.get(identity.pid);
  if (previous !== undefined && previous !== identity.starttime) {
    fail("cgroup-uncertain", `${label} conflicts with another retained cgroup process identity.`);
  }
  map.set(identity.pid, identity.starttime);
}

/** @internal Exported for deterministic cgroup/PID race contract tests. */
export function observeExecutionCgroup(
  request,
  procRoot,
  helperIdentity,
  {
    requiredProcesses = [],
    trackedProcesses = [],
    scanCgroup = () => scanExecutionCgroupTree(request, procRoot),
    readCgroupProcessIdentity = (pid) => processIdentityOrMissing(procRoot, pid, "Execution cgroup process identity")
  } = {}
) {
  const first = scanCgroup();
  const bracketed = [];
  const missing = [];
  for (const pid of first.pids) {
    const identity = readCgroupProcessIdentity(pid);
    if (identity === undefined) missing.push(pid);
    else bracketed.push(identity);
  }
  const second = scanCgroup();
  if (!sameCgroupSnapshot(first, second)) {
    fail("cgroup-uncertain", "The execution cgroup changed across its reconciliation scans.");
  }
  if (!first.testMode && missing.length !== 0) {
    fail("cgroup-uncertain", "An execution-cgroup process disappeared inside its membership bracket.");
  }
  const observed = [];
  for (const identity of bracketed) {
    const current = readCgroupProcessIdentity(identity.pid);
    if (current === undefined) continue;
    if (!sameProcessIdentity(identity, current)) {
      fail("cgroup-uncertain", "An execution-cgroup PID was reused after its bracketed identity observation.");
    }
    observed.push(identity);
  }
  const required = new Map();
  for (const identity of request.hostExecutionCgroup.supervisors) {
    addAllowedProcess(required, identity, "A retained host supervisor");
  }
  if (helperIdentity !== undefined) addAllowedProcess(required, helperIdentity, "The retained helper");
  for (const identity of requiredProcesses) addAllowedProcess(required, identity, "A required helper process");
  const allowed = new Map(required);
  for (const identity of trackedProcesses) addAllowedProcess(allowed, identity, "A pidfd-tracked process");
  const observedByPid = new Map(observed.map((item) => [item.pid, item]));
  for (const [pid, starttime] of required) {
    if (observedByPid.get(pid)?.starttime !== starttime) {
      fail("cgroup-not-exclusive", "The exact supervisor/helper chain is not retained in its execution cgroup.");
    }
  }
  return Object.freeze({
    testMode: first.testMode,
    observed: Object.freeze(observed),
    unexpected: Object.freeze(observed.filter((item) => allowed.get(item.pid) !== item.starttime))
  });
}

function requireExclusiveExecutionCgroup(request, procRoot, helperIdentity, options) {
  const observation = observeExecutionCgroup(request, procRoot, helperIdentity, options);
  if (observation.unexpected.length !== 0) {
    fail("cgroup-not-exclusive", "An unexpected process remained in the exclusive execution cgroup.");
  }
  return observation;
}

async function drainUnexpectedExecutionCgroup(request, procRoot, helperIdentity, dependencies = {}) {
  let observedUnexpected = false;
  for (let pass = 0; pass < MAXIMUM_CGROUP_DRAIN_PASSES; pass += 1) {
    const observation = observeExecutionCgroup(request, procRoot, helperIdentity);
    if (observation.unexpected.length === 0) return observedUnexpected;
    observedUnexpected = true;
    await runPidfdSupervisorBatch(request, procRoot, helperIdentity, { drain: true, ...dependencies });
  }
  fail("cgroup-not-empty", "The exclusive execution cgroup could not be drained within its fixed bound.");
}

function executableReceiptOrMissing(procRoot, pid) {
  let descriptor;
  try {
    descriptor = openSync(join(procRoot, String(pid), "exe"), constants.O_RDONLY);
    const before = fstatSync(descriptor, { bigint: true });
    const after = fstatSync(descriptor, { bigint: true });
    if (!before.isFile() || !sameIdentity(identityOf(before), identityOf(after))) {
      fail("executable-uncertain", "A process executable changed while it was pinned.");
    }
    return artifactReceipt(before);
  } catch (error) {
    if (procEntryVanished(error.cause ?? error)) return undefined;
    if (error instanceof OwnedCheckoutMoveError) throw error;
    fail("executable-uncertain", "A process executable could not be pinned.", { cause: error });
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function verifyHelperLaunchArtifacts(request, procRoot, { includeHelper = true } = {}) {
  const expected = request.launchArtifacts;
  const descriptors = [
    ...(includeHelper ? [[HELPER_ARTIFACT_FD, expected.helper, "helper artifact", { includeSize: true }]] : []),
    ...(includeHelper ? [[NODE_RUNTIME_FD, expected.node, "Node runtime", {}]] : []),
    [GIT_EXECUTABLE_FD, expected.git, "Git executable", {}],
    [PYTHON_RUNTIME_FD, expected.python, "Python runtime", {}],
    [PIDFD_SUPERVISOR_FD, expected.pidfdSupervisor, "pidfd supervisor artifact", { includeSize: true }]
  ];
  for (const [descriptor, receipt, label, options] of descriptors) {
    let metadata;
    try {
      metadata = fstatSync(descriptor, { bigint: true });
    } catch (error) {
      fail("launch-artifact-mismatch", `The retained ${label} descriptor could not be inspected.`, { cause: error });
    }
    if (!metadata.isFile() || !sameReceipt(receipt, artifactReceipt(metadata, options))) {
      fail("launch-artifact-mismatch", `The retained ${label} descriptor no longer matches its receipt.`);
    }
  }
  const runningNode = executableReceiptOrMissing(procRoot, "self");
  if (!sameReceipt(expected.node, runningNode ?? {})) {
    fail("launch-artifact-mismatch", "The running helper executable is not the descriptor-bound Node runtime.");
  }
  if (expected.gitTrust === "production") {
    requireRetainedExecutableNotWritable(procRoot, GIT_EXECUTABLE_FD, "production Git executable");
  }
  requireRetainedExecutableNotWritable(procRoot, PYTHON_RUNTIME_FD, "pidfd Python runtime");
}

function requireRetainedExecutableNotWritable(procRoot, descriptor, label) {
  try {
    accessSync(join(procRoot, "self", "fd", String(descriptor)), constants.W_OK);
    fail("unsafe-executable", `The retained ${label} is writable by the current user.`);
  } catch (error) {
    if (error instanceof OwnedCheckoutMoveError) throw error;
    if (!(error && typeof error === "object" && ["EACCES", "EPERM", "EROFS"].includes(error.code))) {
      fail("unsafe-executable", `The retained ${label} write access could not be determined.`, { cause: error });
    }
  }
}

function samePidStarttime(left, right) {
  return left.pid === right.pid && left.starttime === right.starttime;
}

function pidfdControlFrame(type, token, extra = {}) {
  return `${JSON.stringify({ protocol: OWNED_CHECKOUT_PIDFD_PROTOCOL, type, token, ...extra })}\n`;
}

function parsePidfdIdentityArray(value, label) {
  if (!Array.isArray(value) || value.length > MAXIMUM_CGROUP_PROCESSES) {
    fail("pidfd-supervisor-output", `${label} exceeded its process bound.`);
  }
  const identities = value.map((item, index) => {
    try {
      return validateProcessReceipt(item, `${label} ${index + 1}`);
    } catch (error) {
      fail("pidfd-supervisor-output", `${label} contained a malformed identity.`, { cause: error });
    }
  });
  if (new Set(identities.map((item) => item.pid)).size !== identities.length) {
    fail("pidfd-supervisor-output", `${label} repeated a process identity.`);
  }
  return Object.freeze(identities);
}

function parsePidfdSupervisorFrame(line, token) {
  let value;
  try {
    value = parseStrictJson(line, MAXIMUM_PIDFD_FRAME_BYTES);
    if (value?.type === "ready") exactKeys(value, ["protocol", "type", "token"], "pidfd READY frame");
    else if (value?.type === "armed")
      exactKeys(value, ["protocol", "type", "token", "accepted", "live"], "pidfd ARMED frame");
    else if (value?.type === "result")
      exactKeys(value, ["protocol", "type", "token", "ok", "code"], "pidfd RESULT frame");
    else if (value?.type === "error") exactKeys(value, ["protocol", "type", "token", "code"], "pidfd ERROR frame");
    else fail("pidfd-supervisor-output", "The pidfd supervisor emitted an unknown frame.");
  } catch (error) {
    if (error instanceof OwnedCheckoutMoveError && error.code === "pidfd-supervisor-output") throw error;
    fail("pidfd-supervisor-output", "The pidfd supervisor emitted malformed output.", { cause: error });
  }
  if (
    value.protocol !== OWNED_CHECKOUT_PIDFD_PROTOCOL ||
    value.token !== token ||
    ((value.type === "result" || value.type === "error") && !RESULT_CODE_PATTERN.test(value.code)) ||
    (value.type === "result" &&
      (typeof value.ok !== "boolean" || (value.ok ? value.code !== "contained" : value.code === "contained")))
  ) {
    fail("pidfd-supervisor-output", "The pidfd supervisor output was not correlated.");
  }
  if (value.type === "armed") {
    value.accepted = parsePidfdIdentityArray(value.accepted, "The pidfd accepted set");
    value.live = parsePidfdIdentityArray(value.live, "The pidfd live set");
  }
  return Object.freeze(value);
}

function readPidfdSupervisorFrame(stream, token) {
  return new Promise((resolveFrame, rejectFrame) => {
    let buffer = Buffer.alloc(0);
    const timer = setTimeout(() => {
      cleanup();
      rejectFrame(new OwnedCheckoutMoveError("pidfd-supervisor-timeout", "The pidfd supervisor frame timed out."));
    }, PIDFD_PROTOCOL_TIMEOUT_MS);
    const cleanup = () => {
      clearTimeout(timer);
      stream.off("data", onData);
      stream.off("error", onError);
      stream.off("end", onEnd);
    };
    const onError = (error) => {
      cleanup();
      rejectFrame(
        new OwnedCheckoutMoveError("pidfd-supervisor-stream", "The pidfd supervisor output stream failed.", {
          cause: error
        })
      );
    };
    const onEnd = () => {
      cleanup();
      rejectFrame(new OwnedCheckoutMoveError("pidfd-supervisor-output", "The pidfd supervisor output ended early."));
    };
    const onData = (chunk) => {
      if (buffer.length + chunk.length > MAXIMUM_PIDFD_FRAME_BYTES) {
        cleanup();
        rejectFrame(
          new OwnedCheckoutMoveError("pidfd-supervisor-output", "The pidfd supervisor frame exceeded its bound.")
        );
        return;
      }
      buffer = Buffer.concat([buffer, chunk]);
      const newline = buffer.indexOf(0x0a);
      if (newline < 0) return;
      if (newline !== buffer.length - 1) {
        cleanup();
        rejectFrame(
          new OwnedCheckoutMoveError("pidfd-supervisor-output", "The pidfd supervisor emitted overlapping frames.")
        );
        return;
      }
      cleanup();
      try {
        resolveFrame(parsePidfdSupervisorFrame(buffer.subarray(0, newline).toString("utf8"), token));
      } catch (error) {
        rejectFrame(error);
      }
    };
    stream.on("data", onData);
    stream.on("error", onError);
    stream.on("end", onEnd);
  });
}

function appendTestCgroupProcess(request, pid) {
  if (request.launchArtifacts.cgroupTrust !== "test") return;
  let descriptor;
  try {
    descriptor = openSync(
      join(request.hostExecutionCgroup.path, "cgroup.procs"),
      constants.O_WRONLY | constants.O_APPEND | (constants.O_NOFOLLOW ?? 0)
    );
    const payload = Buffer.from(`${pid}\n`, "ascii");
    if (writeSync(descriptor, payload, 0, payload.length, null) !== payload.length) {
      fail("cgroup-uncertain", "The test cgroup membership write made no progress.");
    }
    fdatasyncSync(descriptor);
  } catch (error) {
    if (error instanceof OwnedCheckoutMoveError) throw error;
    fail("cgroup-uncertain", "The test cgroup could not record the pidfd supervisor.", { cause: error });
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

async function pinPidfdSupervisor(child, request, procRoot, closedState) {
  for (let attempt = 0; attempt < 40 && !closedState.closed; attempt += 1) {
    const identity = processIdentityOrMissing(procRoot, child.pid, "pidfd supervisor identity");
    const executable = executableReceiptOrMissing(procRoot, child.pid);
    if (
      identity !== undefined &&
      identity.processGroup === process.pid &&
      identity.session === process.pid &&
      sameReceipt(request.launchArtifacts.python, executable ?? {})
    ) {
      return identity;
    }
    await delay(5);
  }
  fail("pidfd-supervisor-uncertain", "The exact pidfd supervisor process could not be pinned.");
}

function samePidStarttimeSet(left, right) {
  return left.length === right.length && left.every((identity, index) => samePidStarttime(identity, right[index]));
}

async function awaitPidfdSupervisorClose(closed, closedState) {
  const outcome = await new Promise((resolveClose) => {
    const timer = setTimeout(() => resolveClose(undefined), PIDFD_PROTOCOL_TIMEOUT_MS);
    closed.then((value) => {
      clearTimeout(timer);
      resolveClose(value);
    });
  });
  if (outcome === undefined || !closedState.closed) {
    fail("process-group-not-empty", "The pidfd supervisor did not exit within its fixed protocol deadline.");
  }
  return outcome;
}

async function runPidfdSupervisorBatch(request, procRoot, helperIdentity, { drain = false } = {}) {
  verifyHelperLaunchArtifacts(request, procRoot, { includeHelper: false });
  const token = randomBytes(16).toString("hex");
  const encoded = Buffer.from(
    JSON.stringify({
      protocol: OWNED_CHECKOUT_PIDFD_PROTOCOL,
      token,
      cgroupTrust: request.launchArtifacts.cgroupTrust,
      cgroupRelativePath: request.hostExecutionCgroup.relativePath,
      cgroupPath: request.hostExecutionCgroup.path,
      termGraceMs: PIDFD_TERM_GRACE_MS,
      killGraceMs: PIDFD_KILL_GRACE_MS
    }),
    "utf8"
  ).toString("base64url");
  let child;
  try {
    child = spawn(
      `/proc/self/fd/${PYTHON_RUNTIME_FD}`,
      ["-I", "-S", "-E", "-B", `/proc/self/fd/${PIDFD_SUPERVISOR_FD}`, encoded],
      {
        detached: false,
        env: helperEnvironment(request.safeCwd),
        stdio: ["pipe", "pipe", "pipe", "ignore", "ignore", "ignore", PYTHON_RUNTIME_FD, PIDFD_SUPERVISOR_FD]
      }
    );
  } catch (error) {
    fail("pidfd-supervisor-spawn", "The descriptor-bound pidfd supervisor could not start.", { cause: error });
  }
  if (
    !Number.isSafeInteger(child?.pid) ||
    child.pid <= 0 ||
    !child?.stdin?.write ||
    !child?.stdin?.end ||
    !child?.stdout?.on ||
    !child?.stderr?.on ||
    typeof child?.once !== "function"
  ) {
    fail("process-group-not-empty", "The pidfd supervisor did not expose one owned protocol process.");
  }
  appendTestCgroupProcess(request, child.pid);
  const closedState = { closed: false, error: undefined };
  let closeResolve;
  const closed = new Promise((resolveClose) => {
    closeResolve = resolveClose;
  });
  child.once("error", (error) => {
    closedState.error ??= error;
  });
  child.once("close", (code, signal) => {
    closedState.closed = true;
    closeResolve(Object.freeze({ code, signal }));
  });
  let stderrBytes = 0;
  child.stderr.on("data", (chunk) => {
    stderrBytes += chunk.length;
  });
  child.stderr.on("error", (error) => {
    closedState.error ??= error;
  });
  child.stdin.on("error", (error) => {
    closedState.error ??= error;
  });
  child.stdout.on("error", (error) => {
    closedState.error ??= error;
  });
  let supervisorIdentity;
  let result;
  let ackSent = false;
  let targets = [];
  try {
    supervisorIdentity = await pinPidfdSupervisor(child, request, procRoot, closedState);
    const ready = await readPidfdSupervisorFrame(child.stdout, token);
    if (ready.type === "error") {
      await awaitPidfdSupervisorClose(closed, closedState);
      fail("pidfd-unavailable", "The host pidfd supervisor capability probe failed.");
    }
    if (ready.type !== "ready") {
      fail("pidfd-supervisor-output", "The pidfd supervisor did not publish READY first.");
    }
    const readyObservation = observeExecutionCgroup(request, procRoot, helperIdentity, {
      requiredProcesses: [supervisorIdentity]
    });
    targets = drain ? readyObservation.unexpected : [];
    if (!drain && readyObservation.unexpected.length !== 0) {
      fail("cgroup-not-exclusive", "An unexpected process appeared during the pidfd capability probe.");
    }
    const armedPromise = readPidfdSupervisorFrame(child.stdout, token);
    child.stdin.write(
      pidfdControlFrame("run", token, { targets: targets.map(({ pid, starttime }) => ({ pid, starttime })) })
    );
    const armed = await armedPromise;
    if (armed.type === "result") {
      result = armed;
    } else {
      if (armed.type !== "armed" || !samePidStarttimeSet(armed.accepted, targets)) {
        fail("pidfd-supervisor-output", "The pidfd supervisor did not retain the exact target batch.");
      }
      if (armed.live.some((identity) => !targets.some((target) => samePidStarttime(identity, target)))) {
        fail("pidfd-supervisor-output", "The pidfd supervisor reported an unknown live target.");
      }
      const observation = observeExecutionCgroup(request, procRoot, helperIdentity, {
        requiredProcesses: [supervisorIdentity],
        trackedProcesses: targets
      });
      const missingLive = armed.live.some(
        (identity) => !observation.observed.some((observed) => samePidStarttime(identity, observed))
      );
      const resultPromise = readPidfdSupervisorFrame(child.stdout, token);
      child.stdin.write(pidfdControlFrame("go", token));
      result = await resultPromise;
      if (missingLive && result.code === "contained") {
        fail("cgroup-ownership-uncertain", "A pidfd-live process left the attested execution cgroup before GO.");
      }
    }
    if (result.type !== "result") {
      fail("pidfd-supervisor-output", "The pidfd supervisor did not publish a terminal result.");
    }
    if (result.code === "pidfd-timeout") {
      fail(
        "cgroup-ownership-uncertain",
        "A pidfd-live process exceeded the kill deadline; its exact handle must remain retained."
      );
    }
    observeExecutionCgroup(request, procRoot, helperIdentity, {
      requiredProcesses: [supervisorIdentity],
      trackedProcesses: targets
    });
    child.stdin.end(pidfdControlFrame("ack", token));
    ackSent = true;
    const close = await awaitPidfdSupervisorClose(closed, closedState);
    if (
      closedState.error !== undefined ||
      stderrBytes !== 0 ||
      close.signal !== null ||
      close.code !== (result.ok ? 0 : 1)
    ) {
      fail("pidfd-supervisor-uncertain", "The pidfd supervisor did not close with its correlated result.");
    }
    if (!result.ok) {
      fail("cgroup-ownership-uncertain", "The pidfd supervisor could not prove exact target containment.");
    }
  } catch (error) {
    const mustForceContainment =
      !ackSent && (result?.code === "pidfd-timeout" || (result === undefined && !closedState.closed));
    if (!ackSent) {
      try {
        child.stdin.end(
          result === undefined || result.code === "pidfd-timeout" ? undefined : pidfdControlFrame("ack", token)
        );
      } catch {
        // The owned helper group remains the only fallback for its supervisor child.
      }
    }
    if (mustForceContainment) {
      fail(
        "cgroup-ownership-uncertain",
        "The pidfd supervisor retained an exact live handle past normal protocol completion.",
        { cause: error }
      );
    }
    if (!closedState.closed) {
      await awaitPidfdSupervisorClose(closed, closedState);
    }
    throw error;
  }
}

function groupDescendantSnapshot(procRoot, groupId, leaderPid) {
  let entries;
  try {
    entries = readdirSync(procRoot, { withFileTypes: true });
  } catch (error) {
    fail("process-group-uncertain", "The POSIX process table could not be inspected.", { cause: error });
  }
  if (entries.length > MAXIMUM_PROC_ENTRIES)
    fail("process-group-uncertain", "The POSIX process table exceeded its bound.");
  const members = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name, "en"))) {
    if (!entry.isDirectory() || !/^[1-9][0-9]*$/u.test(entry.name)) continue;
    const pid = Number(entry.name);
    if (!Number.isSafeInteger(pid) || pid === leaderPid) continue;
    const identity = processIdentityOrMissing(procRoot, pid);
    if (identity?.processGroup === groupId) members.push(`${pid}:${identity.starttime}`);
  }
  return members.join("\n");
}

async function requireNoGroupDescendantsStable(procRoot, groupId, leaderPid) {
  let previousEmpty = false;
  let observedMembers = false;
  for (let attempt = 0; attempt < GROUP_SCAN_RECONCILIATION_PASSES; attempt += 1) {
    const snapshot = groupDescendantSnapshot(procRoot, groupId, leaderPid);
    if (snapshot === "") {
      if (previousEmpty) return;
      previousEmpty = true;
    } else {
      observedMembers = true;
      previousEmpty = false;
    }
    await delay(10);
  }
  fail(
    observedMembers ? "process-group-not-empty" : "process-group-uncertain",
    observedMembers
      ? "The exact Git child left a process in the owned helper group."
      : "The owned helper group did not produce two stable empty observations."
  );
}

function frame(type, token, extra = {}) {
  return `${JSON.stringify({ protocol: OWNED_CHECKOUT_MOVE_PROTOCOL, type, token, ...extra })}\n`;
}

function helperEnvironment(safeCwd) {
  return Object.freeze({
    HOME: safeCwd,
    LANG: "C",
    LC_ALL: "C",
    PATH: "/usr/bin:/bin",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0"
  });
}

function appendBounded(chunks, chunk, currentBytes, maximumBytes) {
  const next = currentBytes + chunk.length;
  if (next > maximumBytes) fail("git-output-overflow", "Git output exceeded its fixed bound.");
  chunks.push(chunk);
  return next;
}

function readGitExecReady(stream, token) {
  return new Promise((resolveReady, rejectReady) => {
    let buffer = Buffer.alloc(0);
    const timer = setTimeout(() => {
      cleanup();
      rejectReady(new OwnedCheckoutMoveError("git-executable-uncertain", "The Git exec shim did not publish READY."));
    }, PIDFD_PROTOCOL_TIMEOUT_MS);
    const cleanup = () => {
      clearTimeout(timer);
      stream.off("data", onData);
      stream.off("error", onError);
      stream.off("end", onEnd);
    };
    const onError = (error) => {
      cleanup();
      rejectReady(
        new OwnedCheckoutMoveError("git-output-failed", "The Git exec-shim output stream failed.", { cause: error })
      );
    };
    const onEnd = () => {
      cleanup();
      rejectReady(new OwnedCheckoutMoveError("git-executable-uncertain", "The Git exec shim exited before READY."));
    };
    const onData = (chunk) => {
      if (buffer.length + chunk.length > MAXIMUM_FRAME_BYTES) {
        cleanup();
        rejectReady(new OwnedCheckoutMoveError("git-executable-uncertain", "The Git exec-shim frame was too large."));
        return;
      }
      buffer = Buffer.concat([buffer, chunk]);
      const newline = buffer.indexOf(0x0a);
      if (newline < 0) return;
      if (newline !== buffer.length - 1) {
        cleanup();
        rejectReady(
          new OwnedCheckoutMoveError("git-executable-uncertain", "The Git exec shim overlapped READY output.")
        );
        return;
      }
      cleanup();
      try {
        const value = parseStrictJson(buffer.subarray(0, newline).toString("utf8"), MAXIMUM_FRAME_BYTES);
        exactKeys(value, ["protocol", "type", "token"], "Git exec-shim frame");
        if (value.protocol !== OWNED_CHECKOUT_GIT_EXEC_PROTOCOL || value.type !== "ready" || value.token !== token) {
          fail("git-executable-uncertain", "The Git exec shim published an uncorrelated READY frame.");
        }
        resolveReady();
      } catch (error) {
        rejectReady(error);
      }
    };
    stream.on("data", onData);
    stream.on("error", onError);
    stream.on("end", onEnd);
  });
}

function observeGitExecShim(request, helperIdentity, childPid, retained, { readIdentity, readExecutable, readCgroup }) {
  const first = readIdentity(childPid);
  if (first === undefined) {
    if (retained === undefined) return undefined;
    fail("cgroup-ownership-uncertain", "The retained Git exec-shim identity disappeared before GO.");
  }
  const executable = readExecutable(childPid);
  const cgroup = readCgroup(childPid, first);
  const second = readIdentity(childPid);
  if (second === undefined || !sameProcessIdentity(first, second)) {
    fail("cgroup-ownership-uncertain", "The Git exec-shim PID/start-time identity changed while it was observed.");
  }
  const expectedCgroup = request.hostExecutionCgroup.relativePath;
  const matchesExpected =
    first.pid === childPid &&
    first.processGroup === helperIdentity.pid &&
    first.session === helperIdentity.pid &&
    first.state !== "Z" &&
    sameReceipt(request.launchArtifacts.python, executable ?? {}) &&
    cgroup === expectedCgroup;
  if (!matchesExpected) {
    if (retained === undefined) return undefined;
    fail(
      "cgroup-ownership-uncertain",
      "The retained Git exec shim changed its identity, executable, process group, session, or execution cgroup."
    );
  }
  const observation = Object.freeze({
    identity: first,
    executable: Object.freeze({ ...executable }),
    cgroup
  });
  if (
    retained !== undefined &&
    (!sameProcessIdentity(retained.identity, observation.identity) ||
      !sameReceipt(retained.executable, observation.executable) ||
      retained.cgroup !== observation.cgroup)
  ) {
    fail("cgroup-ownership-uncertain", "The exact retained Git exec-shim observation changed before GO.");
  }
  return observation;
}

/** @internal Exported only for the deterministic process-identity contract test. */
export async function runGitMove(
  request,
  helperIdentity,
  {
    spawnProcess = spawn,
    procRoot = "/proc",
    readGitChildIdentity = (pid) => processIdentityOrMissing(procRoot, pid, "Git exec-shim identity"),
    readGitChildExecutable = (pid) => executableReceiptOrMissing(procRoot, pid),
    readGitChildCgroup,
    scanGitExecutionCgroup,
    readGitExecutionCgroupProcessIdentity
  } = {}
) {
  const args = [
    "--git-dir",
    request.managerRepositoryPath,
    "-c",
    "worktree.useRelativePaths=false",
    "worktree",
    "move",
    request.sourcePath,
    request.destinationPath
  ];
  const production = request.launchArtifacts.gitTrust === "production";
  const execToken = randomBytes(16).toString("hex");
  let child;
  try {
    child = spawnProcess(
      production ? `/proc/self/fd/${PYTHON_RUNTIME_FD}` : `/proc/self/fd/${GIT_EXECUTABLE_FD}`,
      production
        ? ["-I", "-S", "-E", "-B", `/proc/self/fd/${PIDFD_SUPERVISOR_FD}`, "--exec-git", execToken, "git", ...args]
        : args,
      {
        detached: false,
        env: helperEnvironment(request.safeCwd),
        stdio: [
          production ? "pipe" : "ignore",
          "pipe",
          "pipe",
          "ignore",
          "ignore",
          GIT_EXECUTABLE_FD,
          ...(production ? [PYTHON_RUNTIME_FD, PIDFD_SUPERVISOR_FD] : [])
        ]
      }
    );
  } catch (error) {
    fail("git-spawn-failed", "The exact Git move child could not start.", { cause: error });
  }
  const chunks = [];
  let bytes = 0;
  let spawnError;
  let streamError;
  let childClosed = false;
  let exitSettled = false;
  let exitedResolve;
  let closedResolve;
  const exited = new Promise((resolveExit) => {
    exitedResolve = resolveExit;
  });
  const closed = new Promise((resolveClose) => {
    closedResolve = resolveClose;
  });
  if (typeof child?.once === "function") {
    child.once("error", (error) => {
      spawnError ??= error;
      if (!exitSettled) {
        exitSettled = true;
        exitedResolve(undefined);
      }
    });
    child.once("exit", (code, signal) => {
      exitSettled = true;
      exitedResolve({ code, signal });
    });
    child.once("close", (code, signal) => {
      childClosed = true;
      closedResolve({ code, signal });
    });
  }
  const failStream = (error) => {
    streamError ??= error;
  };
  child?.stdout?.on?.("error", failStream);
  child?.stderr?.on?.("error", failStream);
  child?.stdin?.on?.("error", failStream);
  if (
    !child?.stdout?.on ||
    !child?.stderr?.on ||
    (production && (!child?.stdin?.write || !child?.stdin?.end)) ||
    typeof child?.once !== "function" ||
    !Number.isSafeInteger(child?.pid) ||
    child.pid <= 0
  ) {
    try {
      signalPosixProcessGroup(process.pid, "SIGTERM");
    } catch {
      process.exit(125);
    }
    fail("git-spawn-failed", "The exact Git move child did not expose bounded output streams.");
  }
  appendTestCgroupProcess(request, child.pid);
  const captureStdout = (chunk) => {
    try {
      bytes = appendBounded(chunks, chunk, bytes, MAXIMUM_GIT_OUTPUT_BYTES);
    } catch (error) {
      failStream(error);
    }
  };
  child.stderr.on("data", (chunk) => {
    try {
      bytes = appendBounded(chunks, chunk, bytes, MAXIMUM_GIT_OUTPUT_BYTES);
    } catch (error) {
      failStream(error);
    }
  });
  if (production) {
    const ready = readGitExecReady(child.stdout, execToken);
    const cgroupReader =
      readGitChildCgroup ??
      ((pid, identity) => {
        if (request.launchArtifacts.cgroupTrust === "test") {
          observeExecutionCgroup(request, procRoot, helperIdentity, { requiredProcesses: [identity] });
          return request.hostExecutionCgroup.relativePath;
        }
        try {
          return processCgroupPath(procRoot, pid);
        } catch (error) {
          if (procEntryVanished(error.cause ?? error)) return undefined;
          throw error;
        }
      });
    const observationOptions = {
      readIdentity: readGitChildIdentity,
      readExecutable: readGitChildExecutable,
      readCgroup: cgroupReader
    };
    const requireRetainedExecutionCgroup = (identity) =>
      requireExclusiveExecutionCgroup(request, procRoot, helperIdentity, {
        requiredProcesses: [identity],
        ...(scanGitExecutionCgroup === undefined ? {} : { scanCgroup: scanGitExecutionCgroup }),
        ...(readGitExecutionCgroupProcessIdentity === undefined
          ? {}
          : { readCgroupProcessIdentity: readGitExecutionCgroupProcessIdentity })
      });
    let retained;
    try {
      for (let attempt = 0; attempt < 20 && !childClosed && !exitSettled; attempt += 1) {
        retained = observeGitExecShim(request, helperIdentity, child.pid, undefined, observationOptions);
        if (retained !== undefined) break;
        await delay(5);
      }
      if (retained === undefined) {
        fail(
          "cgroup-ownership-uncertain",
          "The exact Git exec shim could not be retained by PID/start time, executable, and execution cgroup."
        );
      }
      await ready;
      if (childClosed || exitSettled) {
        fail("cgroup-ownership-uncertain", "The retained Git exec shim exited after READY and before GO.");
      }
      observeGitExecShim(request, helperIdentity, child.pid, retained, observationOptions);
      requireRetainedExecutionCgroup(retained.identity);
      child.stdout.on("data", captureStdout);
      if (childClosed || exitSettled) {
        fail("cgroup-ownership-uncertain", "The retained Git exec shim exited immediately before GO.");
      }
      observeGitExecShim(request, helperIdentity, child.pid, retained, observationOptions);
      requireRetainedExecutionCgroup(retained.identity);
    } catch (error) {
      try {
        child.stdin.end();
      } catch {
        // The pipe is bound to the exact direct child; final helper-group
        // containment remains authoritative when it cannot be closed.
      }
      void ready.catch(() => {});
      if (error instanceof OwnedCheckoutMoveError && error.code === "cgroup-ownership-uncertain") throw error;
      fail("cgroup-ownership-uncertain", "The exact Git exec shim could not be revalidated before GO.", {
        cause: error
      });
    }
    child.stdin.end(
      `${JSON.stringify({ protocol: OWNED_CHECKOUT_GIT_EXEC_PROTOCOL, type: "go", token: execToken })}\n`
    );
  } else {
    child.stdout.on("data", captureStdout);
  }
  const exitResult = await exited;
  if (exitResult === undefined) fail("git-spawn-failed", "The exact Git move child did not publish its exit.");
  let escaped = false;
  let postExitError;
  try {
    escaped = await drainUnexpectedExecutionCgroup(request, procRoot, helperIdentity);
  } catch (error) {
    postExitError ??= error;
  }
  try {
    await requireNoGroupDescendantsStable(procRoot, process.pid, process.pid);
  } catch (error) {
    postExitError ??= error;
  }
  const closeResult = await new Promise((resolveClose) => {
    const timer = setTimeout(() => resolveClose(undefined), PIDFD_PROTOCOL_TIMEOUT_MS);
    closed.then((value) => {
      clearTimeout(timer);
      resolveClose(value);
    });
  });
  if (closeResult === undefined || !childClosed) {
    postExitError ??= new OwnedCheckoutMoveError(
      "git-output-uncertain",
      "The exact Git output streams did not close after descendant containment."
    );
  }
  if (spawnError !== undefined) {
    postExitError ??= new OwnedCheckoutMoveError("git-spawn-failed", "The exact Git move child failed after spawn.", {
      cause: spawnError
    });
  }
  if (streamError !== undefined) {
    postExitError ??= new OwnedCheckoutMoveError(
      "git-output-failed",
      "The exact Git move output could not be captured safely.",
      { cause: streamError }
    );
  }
  return Object.freeze({
    code: exitResult.code,
    signal: exitResult.signal,
    escaped,
    postExitError
  });
}

async function helperMain(encodedRequest, dependencies = {}) {
  const procRoot = dependencies.procRoot ?? "/proc";
  let request;
  let helperIdentity;
  let phase = "initial";
  let resultCode = 0;
  let deadline;
  let terminating = false;
  let terminationKillTimer;
  const clearDeadline = () => {
    clearTimeout(deadline);
    deadline = undefined;
  };
  const terminateAfterSignal = () => {
    if (terminating) return;
    terminating = true;
    clearDeadline();
    terminationKillTimer = setTimeout(() => {
      try {
        signalPosixProcessGroup(process.pid, "SIGKILL");
      } catch {
        process.exit(125);
      }
    }, DEFAULT_GROUP_GRACE_MS);
    void (async () => {
      try {
        if (request !== undefined && helperIdentity !== undefined) {
          await drainUnexpectedExecutionCgroup(request, procRoot, helperIdentity);
          requireExclusiveExecutionCgroup(request, procRoot, helperIdentity);
        }
        await requireNoGroupDescendantsStable(procRoot, process.pid, process.pid);
        clearTimeout(terminationKillTimer);
        process.exit(125);
      } catch {
        // Keep the session leader alive so the parent or the local fallback can
        // safely escalate to SIGKILL without risking process-group ID reuse.
      }
    })();
  };
  process.on("SIGTERM", terminateAfterSignal);
  const fatal = () => {
    if (terminating) return;
    try {
      signalPosixProcessGroup(process.pid, "SIGTERM");
    } catch {
      process.exit(125);
    }
  };
  process.stdin.on("error", fatal);
  process.stdout.on("error", fatal);
  const writeParentFrame = (value) =>
    new Promise((resolveWrite, rejectWrite) => {
      process.stdout.write(value, (error) => {
        if (error) rejectWrite(error);
        else resolveWrite();
      });
    });
  const parseControlFrame = (line, expectedType) => {
    let value;
    try {
      value = parseStrictJson(line, MAXIMUM_FRAME_BYTES);
      exactKeys(value, ["protocol", "type", "token"], "Move control frame");
    } catch (error) {
      fail("invalid-control", "The move control frame was malformed.", { cause: error });
    }
    if (
      value.protocol !== OWNED_CHECKOUT_MOVE_PROTOCOL ||
      value.type !== expectedType ||
      value.token !== request.token
    ) {
      fail("invalid-control", `The move helper expected one correlated ${expectedType.toUpperCase()} frame.`);
    }
  };
  const beginMove = (initial) => {
    phase = "running";
    clearDeadline();
    deadline = setTimeout(fatal, request.moveTimeoutMs);
    void (async () => {
      try {
        verifyHelperLaunchArtifacts(request, procRoot, { includeHelper: false });
        requireExclusiveExecutionCgroup(request, procRoot, helperIdentity);
        const confirmed = inspectOwnedCheckoutMove(request, { procRoot, requireCurrentCwd: true });
        if (!sameInspection(initial, confirmed)) fail("preflight-changed", "The move preflight changed before GO.");
        const result = await runGitMove(request, helperIdentity, dependencies);
        const ok = await reconcileCheckoutAfterGit(initial, result, { procRoot, helperIdentity });
        if (terminating) return;
        if (result.postExitError !== undefined) throw result.postExitError;
        if (result.escaped) fail("cgroup-escape", "The Git move spawned a process outside the owned POSIX group.");
        resultCode = ok ? 0 : 1;
        phase = "ack";
        await writeParentFrame(frame("result", request.token, { ok, code: ok ? "moved" : "git-failed" }));
      } catch (error) {
        if (terminating) return;
        if (error?.code === "process-group-uncertain" || error?.code === "process-group-not-empty") {
          fatal();
          return;
        }
        resultCode = 1;
        try {
          phase = "ack";
          await writeParentFrame(frame("result", request.token, { ok: false, code: error?.code ?? "move-failed" }));
        } catch {
          fatal();
        }
      }
    })();
  };
  const finishAfterAck = () => {
    phase = "finishing";
    void (async () => {
      try {
        requireExclusiveExecutionCgroup(request, procRoot, helperIdentity);
        await requireNoGroupDescendantsStable(procRoot, process.pid, process.pid);
        if (terminating) return;
        clearDeadline();
        phase = "done";
        process.exitCode = resultCode;
        process.stdin.destroy();
      } catch {
        fatal();
      }
    })();
  };
  try {
    helperIdentity = requireOwnedHelperGroup(procRoot);
    const bytes = Buffer.from(encodedRequest, "base64url");
    if (bytes.length === 0 || bytes.length > MAXIMUM_REQUEST_BYTES || bytes.toString("base64url") !== encodedRequest) {
      fail("invalid-request", "The encoded move request is malformed.");
    }
    try {
      request = validateRequest(parseStrictJson(bytes.toString("utf8"), MAXIMUM_REQUEST_BYTES));
    } catch (error) {
      if (error instanceof OwnedCheckoutMoveError) throw error;
      fail("invalid-request", "The encoded move request was malformed.", { cause: error });
    }
    verifyHelperLaunchArtifacts(request, procRoot);
    requireExclusiveExecutionCgroup(request, procRoot, helperIdentity);
    await runPidfdSupervisorBatch(request, procRoot, helperIdentity);
    requireExclusiveExecutionCgroup(request, procRoot, helperIdentity);
    const initial = inspectOwnedCheckoutMove(request, { procRoot, requireCurrentCwd: true });
    phase = "go";
    await writeParentFrame(frame("ready", request.token));
    closeSync(HELPER_ARTIFACT_FD);
    closeSync(NODE_RUNTIME_FD);
    deadline = setTimeout(fatal, request.moveTimeoutMs);
    let control = Buffer.alloc(0);
    process.stdin.on("data", (chunk) => {
      control = Buffer.concat([control, chunk]);
      if (control.length > MAXIMUM_FRAME_BYTES) {
        fatal();
        return;
      }
      while (true) {
        const newline = control.indexOf(0x0a);
        if (newline < 0) return;
        const line = control.subarray(0, newline).toString("utf8");
        control = control.subarray(newline + 1);
        try {
          if (phase === "go") {
            parseControlFrame(line, "go");
            beginMove(initial);
          } else if (phase === "ack") {
            parseControlFrame(line, "ack");
            finishAfterAck();
          } else {
            fail("invalid-control", "The move helper received a control frame in the wrong phase.");
          }
        } catch {
          fatal();
          return;
        }
      }
    });
    process.stdin.on("end", () => {
      if (phase !== "done" && phase !== "finishing") fatal();
    });
    process.stdin.resume();
  } catch (error) {
    clearDeadline();
    const token = request?.token ?? "0".repeat(32);
    try {
      await writeParentFrame(frame("error", token, { code: error?.code ?? "preflight-failed" }));
      process.exitCode = 1;
      phase = "done";
      process.stdin.destroy();
    } catch {
      fatal();
    }
  }
}

function encodeRequest(request) {
  const bytes = Buffer.from(JSON.stringify(validateRequest(request)), "utf8");
  if (bytes.length > MAXIMUM_REQUEST_BYTES) fail("invalid-request", "The move request exceeded its fixed bound.");
  return bytes.toString("base64url");
}

function parseFrame(line) {
  if (Buffer.byteLength(line, "utf8") > MAXIMUM_FRAME_BYTES)
    fail("invalid-helper-output", "The move helper frame was too large.");
  let value;
  try {
    value = parseStrictJson(line, MAXIMUM_FRAME_BYTES);
  } catch {
    fail("invalid-helper-output", "The move helper output was malformed.");
  }
  if (value?.type === "ready") exactKeys(value, ["protocol", "type", "token"], "Move helper frame");
  else if (value?.type === "error") exactKeys(value, ["protocol", "type", "token", "code"], "Move helper frame");
  else if (value?.type === "result") exactKeys(value, ["protocol", "type", "token", "ok", "code"], "Move helper frame");
  else fail("invalid-helper-output", "The move helper emitted an unknown frame type.");
  if (
    value.protocol !== OWNED_CHECKOUT_MOVE_PROTOCOL ||
    !TOKEN_PATTERN.test(value.token) ||
    (value.type !== "ready" && !RESULT_CODE_PATTERN.test(value.code)) ||
    (value.type === "result" &&
      (typeof value.ok !== "boolean" || (value.ok ? value.code !== "moved" : value.code === "moved")))
  ) {
    fail("invalid-helper-output", "The move helper output was not correlated.");
  }
  return value;
}

function validateTimeout(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0 || value > 300_000) {
    throw new TypeError(`${label} must be one positive safe integer no larger than 300000.`);
  }
}

function ownershipUncertain(message, cause) {
  return new OwnedCheckoutMoveError(OWNED_CHECKOUT_MOVE_OWNERSHIP_UNCERTAIN, message, { cause });
}

function helperIdentityMatches(pinned, current) {
  return (
    current !== undefined &&
    sameProcessIdentity(pinned, current) &&
    current.processGroup === pinned.pid &&
    current.session === pinned.pid
  );
}

/**
 * Starts a Linux move helper in a private process group.
 *
 * The returned `ready` promise does not authorize mutation. Its caller must
 * first persist an external intent, then call `authorize()` exactly once.
 */
export function startOwnedCheckoutMove(
  options,
  {
    spawnProcess = spawn,
    signalProcess = process.kill,
    tokenFactory = () => randomBytes(16).toString("hex"),
    readyTimeoutMs = DEFAULT_READY_TIMEOUT_MS,
    moveTimeoutMs = DEFAULT_MOVE_TIMEOUT_MS,
    groupGraceMs = DEFAULT_GROUP_GRACE_MS,
    procRoot = "/proc",
    readHelperIdentity,
    readHelperExecutable,
    testOnlyGitExecutable,
    testOnlyCgroupFilesystem = false
  } = {}
) {
  if (process.platform !== "linux")
    fail("unsupported-platform", "Owned checkout movement is Linux-only in this slice.");
  validateTimeout(readyTimeoutMs, "READY timeout");
  validateTimeout(moveTimeoutMs, "Move timeout");
  validateTimeout(groupGraceMs, "Process-group grace timeout");
  if (typeof testOnlyCgroupFilesystem !== "boolean") {
    throw new TypeError("The test-only cgroup filesystem seam must be boolean.");
  }
  const publicOptions = validatePublicMoveOptions(options);
  disjointPaths(publicOptions);
  inspectCanonicalPath(publicOptions.safeCwd, "Helper working directory", "directory");
  const token = tokenFactory();
  const launchArtifacts = [];
  let launchDescriptorsReleased = false;
  const releaseLaunchDescriptors = () => {
    if (launchDescriptorsReleased) return;
    launchDescriptorsReleased = true;
    let closeError;
    for (const artifact of launchArtifacts) {
      try {
        closeSync(artifact.descriptor);
      } catch (error) {
        closeError ??= error;
      }
    }
    if (closeError !== undefined) {
      throw ownershipUncertain("A descriptor-bound move launch artifact could not be released.", closeError);
    }
  };
  let request;
  try {
    const helperArtifact = createAnonymousHelperArtifact(publicOptions.safeCwd);
    launchArtifacts.push(helperArtifact);
    const nodeArtifact = openExecutableArtifact(realpathSync(process.execPath), "Node runtime");
    launchArtifacts.push(nodeArtifact);
    const gitArtifact = openExecutableArtifact(
      realpathSync(testOnlyGitExecutable ?? PRODUCTION_GIT_PATH),
      testOnlyGitExecutable === undefined ? "Production Git executable" : "Test-only Git executable",
      { rejectCurrentUserWritable: testOnlyGitExecutable === undefined }
    );
    launchArtifacts.push(gitArtifact);
    const pythonArtifact = openExecutableArtifact(realpathSync(PRODUCTION_PYTHON_PATH), "pidfd Python runtime", {
      rejectCurrentUserWritable: true
    });
    launchArtifacts.push(pythonArtifact);
    const pidfdSupervisorArtifact = createAnonymousPidfdSupervisorArtifact(publicOptions.safeCwd);
    launchArtifacts.push(pidfdSupervisorArtifact);
    request = validateRequest({
      ...publicOptions,
      protocol: OWNED_CHECKOUT_MOVE_PROTOCOL,
      token,
      moveTimeoutMs,
      launchArtifacts: {
        helper: helperArtifact.receipt,
        node: nodeArtifact.receipt,
        git: gitArtifact.receipt,
        python: pythonArtifact.receipt,
        pidfdSupervisor: pidfdSupervisorArtifact.receipt,
        gitTrust: testOnlyGitExecutable === undefined ? "production" : "test",
        cgroupTrust: testOnlyCgroupFilesystem ? "test" : "production"
      }
    });
    requireExclusiveExecutionCgroup(request, procRoot);
  } catch (error) {
    try {
      releaseLaunchDescriptors();
    } catch (closeError) {
      throw ownershipUncertain("Move launch setup failed and its descriptors could not be released.", closeError);
    }
    throw error;
  }
  let child;
  try {
    child = spawnProcess(
      `/proc/self/fd/${NODE_RUNTIME_FD}`,
      ["--input-type=module", "--eval", HELPER_BOOTSTRAP, encodeRequest(request)],
      {
        cwd: request.safeCwd,
        detached: true,
        env: helperEnvironment(request.safeCwd),
        stdio: [
          "pipe",
          "pipe",
          "pipe",
          launchArtifacts[0].descriptor,
          launchArtifacts[1].descriptor,
          launchArtifacts[2].descriptor,
          launchArtifacts[3].descriptor,
          launchArtifacts[4].descriptor
        ]
      }
    );
  } catch (error) {
    try {
      releaseLaunchDescriptors();
    } catch (closeError) {
      throw ownershipUncertain(
        "The move helper spawn failed and its launch descriptors could not be released.",
        closeError
      );
    }
    fail("helper-spawn-failed", "The move helper could not be spawned.", { cause: error });
  }
  let readyResolve;
  let readyReject;
  let completionResolve;
  let completionReject;
  const ready = new Promise((resolveReady, rejectReady) => {
    readyResolve = resolveReady;
    readyReject = rejectReady;
  });
  const completion = new Promise((resolveCompletion, rejectCompletion) => {
    completionResolve = resolveCompletion;
    completionReject = rejectCompletion;
  });
  let readySeen = false;
  let readySettled = false;
  let authorized = false;
  let result;
  let primaryError;
  let containmentError;
  let childError;
  let stdout = Buffer.alloc(0);
  let stderrBytes = 0;
  let settled = false;
  let closed = false;
  let terminating = false;
  let ackSent = false;
  let helperIdentity;
  let readyTimer;
  let actionTimer;
  let escalationTimer;
  let finalTimer;
  const identityReader =
    readHelperIdentity ?? ((pid) => processIdentityOrMissing(procRoot, pid, "Move helper process identity"));
  const executableReader = readHelperExecutable ?? ((pid) => executableReceiptOrMissing(procRoot, pid));
  const clearTimers = () => {
    clearTimeout(readyTimer);
    clearTimeout(actionTimer);
    clearTimeout(escalationTimer);
    clearTimeout(finalTimer);
  };
  const rejectReady = (error) => {
    if (readySettled) return;
    readySettled = true;
    readyReject(error);
  };
  const resolveReady = () => {
    if (readySettled) return;
    readySettled = true;
    readyResolve(Object.freeze({ protocol: OWNED_CHECKOUT_MOVE_PROTOCOL, token }));
  };
  const settleCompletion = (error) => {
    if (settled) return;
    settled = true;
    clearTimers();
    try {
      releaseLaunchDescriptors();
    } catch (closeError) {
      error ??= closeError;
    }
    if (error) completionReject(error);
    else completionResolve(Object.freeze({ protocol: OWNED_CHECKOUT_MOVE_PROTOCOL, status: "moved" }));
  };
  const inspectExactHelper = ({ allowExactZombie = false } = {}) => {
    if (helperIdentity === undefined) {
      throw ownershipUncertain("The move helper identity was never pinned.");
    }
    let current;
    try {
      current = identityReader(child.pid);
    } catch (error) {
      throw ownershipUncertain("The move helper identity could not be revalidated.", error);
    }
    if (!helperIdentityMatches(helperIdentity, current)) {
      throw ownershipUncertain("The move helper identity changed or disappeared before cleanup completed.");
    }
    // Linux removes /proc/<pid>/exe after the exact process becomes a zombie.
    // During cleanup, its pinned PID/start time/group/session still identifies
    // the dead group leader strongly enough to signal any surviving descendants.
    if (allowExactZombie && current.state === "Z") return current;
    let executable;
    try {
      executable = executableReader(child.pid, request.launchArtifacts.node);
    } catch (error) {
      throw ownershipUncertain("The move helper executable could not be revalidated.", error);
    }
    if (!sameReceipt(request.launchArtifacts.node, executable ?? {})) {
      throw ownershipUncertain("The move helper no longer runs the descriptor-bound Node executable.");
    }
    return current;
  };
  const signalExactHelper = (signal) => {
    try {
      inspectExactHelper({ allowExactZombie: true });
      signalPosixProcessGroup(child.pid, signal, signalProcess);
      return true;
    } catch (error) {
      containmentError ??=
        error instanceof OwnedCheckoutMoveError && error.code === OWNED_CHECKOUT_MOVE_OWNERSHIP_UNCERTAIN
          ? error
          : ownershipUncertain(`The move helper could not be sent ${signal}.`, error);
      return false;
    }
  };
  const closeControl = () => {
    try {
      child?.stdin?.destroy?.();
    } catch (error) {
      containmentError ??= ownershipUncertain("The move helper control pipe could not be closed.", error);
    }
  };
  const beginTermination = (error) => {
    primaryError ??= error;
    rejectReady(error);
    if (terminating || settled) return;
    terminating = true;
    clearTimeout(readyTimer);
    clearTimeout(actionTimer);
    signalExactHelper("SIGTERM");
    closeControl();
    try {
      releaseLaunchDescriptors();
    } catch (closeError) {
      containmentError ??= closeError;
    }
    escalationTimer = setTimeout(() => {
      if (closed || settled) return;
      signalExactHelper("SIGKILL");
      finalTimer = setTimeout(() => {
        if (closed || settled) return;
        settleCompletion(
          containmentError ??
            ownershipUncertain("The move helper did not report termination within the fixed cleanup deadline.")
        );
      }, groupGraceMs);
    }, groupGraceMs);
  };
  const consumeFrames = () => {
    while (true) {
      const newline = stdout.indexOf(0x0a);
      if (newline < 0) return;
      const line = stdout.subarray(0, newline).toString("utf8");
      stdout = stdout.subarray(newline + 1);
      let parsed;
      try {
        parsed = parseFrame(line);
      } catch (error) {
        beginTermination(error);
        return;
      }
      if (parsed.token !== token) {
        beginTermination(new OwnedCheckoutMoveError("invalid-helper-output", "The move helper correlation changed."));
        return;
      }
      if (!readySeen && parsed.type === "ready") {
        try {
          inspectExactHelper();
          releaseLaunchDescriptors();
        } catch (error) {
          beginTermination(error);
          return;
        }
        readySeen = true;
        clearTimeout(readyTimer);
        actionTimer = setTimeout(() => {
          beginTermination(
            new OwnedCheckoutMoveError("authorization-timeout", "The move helper did not receive GO in time.")
          );
        }, moveTimeoutMs);
        resolveReady();
      } else if (readySeen && authorized && parsed.type === "result" && result === undefined) {
        try {
          inspectExactHelper();
        } catch (error) {
          beginTermination(error);
          return;
        }
        result = parsed;
        if (parsed.ok !== true) {
          primaryError ??=
            parsed.code === "cgroup-ownership-uncertain"
              ? ownershipUncertain("The pidfd supervisor could not prove ownership of an escaped process.")
              : new OwnedCheckoutMoveError(parsed.code, "The exact Git worktree move failed.");
        }
        clearTimeout(actionTimer);
        ackSent = true;
        actionTimer = setTimeout(() => {
          beginTermination(new OwnedCheckoutMoveError("ack-timeout", "The move helper did not close after ACK."));
        }, groupGraceMs);
        try {
          child.stdin.end(frame("ack", token), (error) => {
            if (error && !closed) {
              beginTermination(
                new OwnedCheckoutMoveError("helper-control-failed", "The move helper ACK could not be sent.", {
                  cause: error
                })
              );
            }
          });
        } catch (error) {
          beginTermination(
            new OwnedCheckoutMoveError("helper-control-failed", "The move helper ACK could not be sent.", {
              cause: error
            })
          );
          return;
        }
      } else if (!readySeen && parsed.type === "error") {
        result = parsed;
      } else {
        beginTermination(
          new OwnedCheckoutMoveError("invalid-helper-output", "The move helper emitted an unexpected frame.")
        );
        return;
      }
    }
  };
  const onStdoutData = (chunk) => {
    if (terminating) return;
    if (stdout.length + chunk.length > MAXIMUM_DIAGNOSTIC_BYTES) {
      beginTermination(
        new OwnedCheckoutMoveError("invalid-helper-output", "The move helper output exceeded its bound.")
      );
      return;
    }
    stdout = Buffer.concat([stdout, chunk]);
    consumeFrames();
  };
  const onStderrData = (chunk) => {
    stderrBytes += chunk.length;
    if (stderrBytes > MAXIMUM_DIAGNOSTIC_BYTES) {
      beginTermination(
        new OwnedCheckoutMoveError("invalid-helper-output", "The move helper diagnostic exceeded its bound.")
      );
    }
  };
  const onStreamError = (streamName) => (error) => {
    beginTermination(
      new OwnedCheckoutMoveError("helper-stream-failed", `The move helper ${streamName} stream failed.`, {
        cause: error
      })
    );
  };
  const onClose = (code, signal) => {
    closed = true;
    clearTimers();
    try {
      releaseLaunchDescriptors();
    } catch (error) {
      containmentError ??= error;
    }
    if (settled) return;
    if (stdout.length !== 0)
      primaryError ??= new OwnedCheckoutMoveError("invalid-helper-output", "The move helper left a partial frame.");
    const error =
      containmentError ??
      primaryError ??
      (childError === undefined
        ? undefined
        : new OwnedCheckoutMoveError("helper-spawn-failed", "The move helper failed to launch.", {
            cause: childError
          })) ??
      (result?.type === "error"
        ? new OwnedCheckoutMoveError(result.code, "The move helper rejected its preflight.")
        : undefined) ??
      (!readySeen
        ? new OwnedCheckoutMoveError("helper-before-ready", "The move helper exited before READY.")
        : undefined) ??
      (!authorized ? new OwnedCheckoutMoveError("not-authorized", "The move helper exited without GO.") : undefined) ??
      (result === undefined
        ? new OwnedCheckoutMoveError("missing-result", "The move helper exited without a result.")
        : undefined) ??
      (!ackSent
        ? new OwnedCheckoutMoveError("missing-ack", "The move helper exited before its result was acknowledged.")
        : undefined) ??
      (result?.code === "cgroup-ownership-uncertain"
        ? ownershipUncertain("The pidfd supervisor could not prove ownership of an escaped process.")
        : undefined) ??
      (result?.ok !== true
        ? new OwnedCheckoutMoveError(result?.code ?? "move-failed", "The exact Git worktree move failed.")
        : undefined) ??
      (code !== 0 || signal !== null
        ? new OwnedCheckoutMoveError("helper-failed", "The move helper did not exit cleanly.")
        : undefined);
    rejectReady(error ?? new OwnedCheckoutMoveError("helper-before-ready", "The move helper exited before READY."));
    settleCompletion(error);
  };
  let setupError;
  try {
    child?.once?.("error", (error) => {
      childError ??= error;
      beginTermination(
        new OwnedCheckoutMoveError("helper-spawn-failed", "The move helper process failed.", { cause: error })
      );
    });
    child?.once?.("close", onClose);
    child?.stdin?.on?.("error", onStreamError("control"));
    child?.stdout?.on?.("error", onStreamError("stdout"));
    child?.stderr?.on?.("error", onStreamError("stderr"));
    child?.stdout?.on?.("data", onStdoutData);
    child?.stderr?.on?.("data", onStderrData);
  } catch (error) {
    setupError = new OwnedCheckoutMoveError("helper-spawn-failed", "The move helper listeners could not be attached.", {
      cause: error
    });
  }
  if (
    setupError === undefined &&
    (!child?.stdin?.on ||
      !child?.stdin?.write ||
      !child?.stdin?.end ||
      !child?.stdin?.destroy ||
      !child?.stdout?.on ||
      !child?.stderr?.on ||
      typeof child?.once !== "function" ||
      !Number.isSafeInteger(child?.pid) ||
      child.pid <= 0)
  ) {
    setupError = new OwnedCheckoutMoveError(
      "helper-spawn-failed",
      "The move helper did not expose one owned protocol process."
    );
  }
  if (Number.isSafeInteger(child?.pid) && child.pid > 0) {
    try {
      helperIdentity = identityReader(child.pid);
      if (!helperIdentityMatches(helperIdentity, helperIdentity)) {
        throw ownershipUncertain("The spawned move helper is not its private session and process-group leader.");
      }
      const executable = executableReader(child.pid, request.launchArtifacts.node);
      if (!sameReceipt(request.launchArtifacts.node, executable ?? {})) {
        throw ownershipUncertain("The spawned move helper is not running the descriptor-bound Node executable.");
      }
    } catch (error) {
      setupError ??=
        error instanceof OwnedCheckoutMoveError && error.code === OWNED_CHECKOUT_MOVE_OWNERSHIP_UNCERTAIN
          ? error
          : ownershipUncertain("The spawned move helper identity could not be pinned.", error);
    }
  }
  if (setupError === undefined) {
    readyTimer = setTimeout(() => {
      beginTermination(new OwnedCheckoutMoveError("ready-timeout", "The move helper did not reach READY in time."));
    }, readyTimeoutMs);
  } else {
    queueMicrotask(() => beginTermination(setupError));
  }
  return Object.freeze({
    ready,
    completion,
    authorize() {
      if (!readySeen) throw new OwnedCheckoutMoveError("not-ready", "GO cannot be sent before the exact READY frame.");
      if (authorized) throw new OwnedCheckoutMoveError("already-authorized", "GO may be sent exactly once.");
      if (settled || terminating || primaryError)
        throw new OwnedCheckoutMoveError("helper-closed", "The move helper is no longer usable.");
      authorized = true;
      clearTimeout(actionTimer);
      actionTimer = setTimeout(() => {
        beginTermination(
          new OwnedCheckoutMoveError("move-timeout", "The exact Git worktree move exceeded its deadline.")
        );
      }, moveTimeoutMs);
      try {
        child.stdin.write(frame("go", token), (error) => {
          if (error && !closed) {
            beginTermination(
              new OwnedCheckoutMoveError("helper-control-failed", "The move helper GO could not be sent.", {
                cause: error
              })
            );
          }
        });
      } catch (error) {
        beginTermination(
          new OwnedCheckoutMoveError("helper-control-failed", "The move helper GO could not be sent.", {
            cause: error
          })
        );
      }
    },
    abort() {
      if (settled) return;
      beginTermination(new OwnedCheckoutMoveError("aborted", "The move helper was aborted before completion."));
    }
  });
}

const descriptorBoundRequest = globalThis[HELPER_BOOTSTRAP_GLOBAL];
if (typeof descriptorBoundRequest === "string") {
  delete globalThis[HELPER_BOOTSTRAP_GLOBAL];
  if (process.argv.length !== 2 || process.argv[1] !== descriptorBoundRequest) process.exit(125);
  else await helperMain(descriptorBoundRequest);
} else if (
  process.argv[1] === HELPER_PATH ||
  process.argv[1] === `/proc/self/fd/${HELPER_ARTIFACT_FD}` ||
  /^\/proc\/[1-9][0-9]*\/fd\/3$/u.test(process.argv[1] ?? "")
) {
  if (process.argv.length !== 4 || process.argv[2] !== "--helper") process.exit(125);
  else await helperMain(process.argv[3]);
}
