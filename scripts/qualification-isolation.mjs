import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, opendir, readFile, realpath, readlink, writeFile } from "node:fs/promises";
import {
  delimiter,
  dirname,
  extname,
  isAbsolute,
  join,
  parse,
  relative,
  resolve,
  win32 as windowsPath
} from "node:path";
import { pathToFileURL } from "node:url";
import { TextDecoder } from "node:util";
import { resolveAcceptancePython } from "./packaged-python-preflight.mjs";

const ASSIGNMENT_PROTOCOL = "openwrangler-qualification-assignment-v1";
const RECEIPT_PROTOCOL = "openwrangler-qualification-receipt-v1";
const MAX_ASSIGNMENT_BYTES = 32 * 1024;
const MAX_GIT_CONFIG_BYTES = 1024 * 1024;
const MAX_GIT_CONFIG_MANIFEST_BYTES = 4 * 1024 * 1024;
const MAX_GIT_INDEX_BYTES = 256 * 1024 * 1024;
const MAX_PYTHON_INVENTORY_BYTES = 4 * 1024 * 1024;
const MAX_PYTHON_PAYLOAD_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_PYTHON_PAYLOAD_FILES = 100_000;
const MAX_PYTHON_PAYLOAD_FILE_BYTES = 512 * 1024 * 1024;
const MAX_PYTHON_PAYLOAD_PATH_BYTES = 16 * 1024 * 1024;
const MAX_RECEIPT_BYTES = 256 * 1024;
const MAX_EXECUTABLE_BYTES = 256 * 1024 * 1024;
const MAX_PYTEST_TEMP_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_PYTEST_TEMP_ENTRIES = 100_000;
const MAX_PYTEST_TEMP_PATH_BYTES = 16 * 1024 * 1024;
const DEFAULT_COMMAND_TIMEOUT_MS = 30 * 60 * 1000;
const DEFAULT_TERMINATION_GRACE_MS = 10_000;
const WINDOWS_JOB_ATTESTATION_PREFIX = "OPEN_WRANGLER_WINDOWS_JOB_EMPTY:";
const WINDOWS_JOB_LOAD_CONTROL_PREFIX = "OPEN_WRANGLER_WINDOWS_JOB_LOAD:";
const WINDOWS_JOB_LOADED_PREFIX = "OPEN_WRANGLER_WINDOWS_JOB_LOADED:";
const WINDOWS_JOB_SUPERVISOR_PATH = join(import.meta.dirname, "windows-job-supervisor.ps1");
const SHA_PATTERN = /^[0-9a-f]{40}$/u;
const TOKEN_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const BRANCH_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/u;
const ASSIGNMENT_KEYS = [
  "base",
  "branch",
  "gitDirectory",
  "gitExecutable",
  "head",
  "issue",
  "protocol",
  "runId",
  "stateRoot",
  "taskId",
  "tree",
  "worktree"
];
const GIT_OVERRIDE_KEYS = new Set([
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_ATTR_NOSYSTEM",
  "GIT_AUTHOR_DATE",
  "GIT_AUTHOR_EMAIL",
  "GIT_AUTHOR_NAME",
  "GIT_CEILING_DIRECTORIES",
  "GIT_COMMON_DIR",
  "GIT_COMMITTER_DATE",
  "GIT_COMMITTER_EMAIL",
  "GIT_COMMITTER_NAME",
  "GIT_CONFIG",
  "GIT_CONFIG_COUNT",
  "GIT_CONFIG_GLOBAL",
  "GIT_CONFIG_NOSYSTEM",
  "GIT_CONFIG_PARAMETERS",
  "GIT_CONFIG_SYSTEM",
  "GIT_DIR",
  "GIT_DISCOVERY_ACROSS_FILESYSTEM",
  "GIT_EXEC_PATH",
  "GIT_INDEX_FILE",
  "GIT_NAMESPACE",
  "GIT_NO_REPLACE_OBJECTS",
  "GIT_OBJECT_DIRECTORY",
  "GIT_QUARANTINE_PATH",
  "GIT_REPLACE_REF_BASE",
  "GIT_SHALLOW_FILE",
  "GIT_WORK_TREE",
  "EMAIL"
]);
const GIT_OVERRIDE_PREFIXES = Object.freeze(["GIT_CONFIG_KEY_", "GIT_CONFIG_VALUE_"]);
const SAFE_PASSTHROUGH_ENVIRONMENT_KEYS = Object.freeze([
  "CI",
  "COLORTERM",
  "GITHUB_ACTIONS",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "NUMBER_OF_PROCESSORS",
  "OS",
  "PROCESSOR_ARCHITECTURE",
  "RUNNER_ARCH",
  "RUNNER_OS",
  "SHELL",
  "TERM",
  "TZ"
]);
const PRIVATE_DIRECTORY_ENVIRONMENT = Object.freeze({
  APPDATA: "xdgConfig",
  COREPACK_HOME: "corepackHome",
  HOME: "home",
  LOCALAPPDATA: "xdgData",
  NPM_CONFIG_CACHE: "npmCache",
  NPM_CONFIG_PREFIX: "npmPrefix",
  OPEN_WRANGLER_ARTIFACTS_DIR: "artifacts",
  OPEN_WRANGLER_BROWSER_PROFILE_ROOT: "browserProfile",
  PIP_CACHE_DIR: "pipCache",
  PLAYWRIGHT_BROWSERS_PATH: "playwrightBrowsers",
  PYTHONPYCACHEPREFIX: "pythonBytecode",
  PYTHONUSERBASE: "pythonUserBase",
  R_LIBS_USER: "rLibrary",
  R_USER: "rUser",
  R_USER_CACHE_DIR: "rCache",
  RUFF_CACHE_DIR: "ruffCache",
  RUNNER_TEMP: "temp",
  TEMP: "temp",
  TMP: "temp",
  TMPDIR: "temp",
  USERPROFILE: "home",
  UV_CACHE_DIR: "uvCache",
  VIRTUAL_ENV: "venv",
  XDG_CACHE_HOME: "xdgCache",
  XDG_CONFIG_HOME: "xdgConfig",
  XDG_DATA_HOME: "xdgData",
  XDG_RUNTIME_DIR: "xdgRuntime",
  XDG_STATE_HOME: "xdgState",
  npm_config_cache: "npmCache",
  npm_config_prefix: "npmPrefix"
});
const PRIVATE_FILE_ENVIRONMENT = Object.freeze({
  NPM_CONFIG_USERCONFIG: "npmUserConfig",
  OPEN_WRANGLER_QUALIFICATION_RECEIPT: "receipt",
  OPEN_WRANGLER_TEST_PROGRESS: "testProgress",
  OPEN_WRANGLER_TEST_RESULT: "testResult",
  PIP_CONFIG_FILE: "pipConfig",
  npm_config_userconfig: "npmUserConfig"
});
const PINNED_TOOL_FILE_ENVIRONMENT = Object.freeze({
  OPEN_WRANGLER_PYTHON: "pythonToolExecutable",
  OPEN_WRANGLER_TEST_PYTHON: "pythonToolExecutable"
});
const WORKTREE_PATH_ENVIRONMENT = Object.freeze({
  OPEN_WRANGLER_NODE_MODULES: "nodeModules",
  OPEN_WRANGLER_VITEST_CACHE_DIR: "vitestCache",
  VITE_CACHE_DIR: "vitestCache",
  VITEST_CACHE_DIR: "vitestCache"
});
const EXACT_ENVIRONMENT_VALUES = Object.freeze({
  PIP_DISABLE_PIP_VERSION_CHECK: "1",
  PIP_NO_INPUT: "1",
  PIP_REQUIRE_VIRTUALENV: "1",
  PYTHONNOUSERSITE: "1"
});
const FORBIDDEN_INHERITED_ENVIRONMENT_KEYS = Object.freeze([
  ...GIT_OVERRIDE_KEYS,
  "NODE_PATH",
  "PIP_PREFIX",
  "PIP_TARGET",
  "QUALIFICATION_SHARED_SENTINEL"
]);

const QUALIFICATION_ENVIRONMENT_CONTRACT = Object.freeze({
  exactValues: EXACT_ENVIRONMENT_VALUES,
  forbiddenInheritedKeys: FORBIDDEN_INHERITED_ENVIRONMENT_KEYS,
  forbiddenInheritedPrefixes: GIT_OVERRIDE_PREFIXES,
  passThroughKeys: SAFE_PASSTHROUGH_ENVIRONMENT_KEYS,
  privateDirectories: PRIVATE_DIRECTORY_ENVIRONMENT,
  privateFiles: PRIVATE_FILE_ENVIRONMENT,
  pinnedToolFiles: PINNED_TOOL_FILE_ENVIRONMENT,
  runnerOwnedKeys: Object.freeze(["COMSPEC", "PATH", "PWD", "SYSTEMDRIVE", "SYSTEMROOT", "WINDIR"]),
  worktreePaths: WORKTREE_PATH_ENVIRONMENT
});

const POSIX_SUBREAPER_SOURCE = String.raw`
import ctypes, json, os, signal, subprocess, sys, time

CONTROL_FD = 5
TARGET_FD = 4

def publish(value):
    try:
        os.write(CONTROL_FD, (json.dumps(value, separators=(",", ":")) + "\n").encode("utf-8"))
    except OSError:
        pass

class ParentTermination(Exception):
    pass

def request_parent_termination(_signal, _frame):
    raise ParentTermination()

def children():
    path = "/proc/self/task/%d/children" % os.getpid()
    try:
        text = open(path, "r", encoding="ascii").read().strip()
    except OSError:
        return []
    return [int(value) for value in text.split()] if text else []

def signal_children(sig):
    for pid in children():
        try:
            os.kill(pid, sig)
        except ProcessLookupError:
            pass

def reap_exited():
    while True:
        try:
            waited, _ = os.waitpid(-1, os.WNOHANG)
        except ChildProcessError:
            return
        if waited <= 0:
            return

def terminate_children(sig, deadline):
    while time.monotonic() < deadline:
        reap_exited()
        if not children():
            return True
        signal_children(sig)
        time.sleep(0.01)
    reap_exited()
    signal_children(sig)
    reap_exited()
    return not children()

def main():
    if sys.platform != "linux" or not os.path.isdir("/proc/self/task"):
        publish({"spawnError":"POSIX detached-process containment requires Linux procfs","treeEmpty":False})
        return
    libc = ctypes.CDLL(None, use_errno=True)
    if libc.prctl(36, 1, 0, 0, 0) != 0:
        publish({"spawnError":"POSIX detached-process containment could not enable its subreaper","treeEmpty":False})
        return
    arguments = json.loads(sys.argv[1])
    argv0 = sys.argv[2]
    timeout = int(sys.argv[3]) / 1000.0
    grace = int(sys.argv[4]) / 1000.0
    target_path = "/dev/fd/%d" % TARGET_FD
    target = None
    parent_terminated = False
    signal.signal(signal.SIGTERM, request_parent_termination)
    signal.signal(signal.SIGINT, request_parent_termination)
    try:
        target = subprocess.Popen(
            [argv0, *arguments],
            executable=target_path,
            close_fds=True,
            pass_fds=(TARGET_FD,),
            start_new_session=True,
        )
    except ParentTermination:
        parent_terminated = True
    except BaseException as error:
        publish({"spawnError":str(error),"treeEmpty":True})
        return
    timed_out = False
    status = None
    signal_name = None
    try:
        if not parent_terminated:
            status = target.wait(timeout=timeout)
    except ParentTermination:
        parent_terminated = True
    except subprocess.TimeoutExpired:
        timed_out = True
    if timed_out or parent_terminated:
        signal.signal(signal.SIGTERM, signal.SIG_IGN)
        signal.signal(signal.SIGINT, signal.SIG_IGN)
        if target is not None:
            try:
                os.killpg(target.pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
            try:
                status = target.wait(timeout=grace)
            except subprocess.TimeoutExpired:
                try:
                    os.killpg(target.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
                try:
                    status = target.wait(timeout=grace)
                except subprocess.TimeoutExpired:
                    status = None
    reap_exited()
    lingering = bool(children())
    tree_empty = terminate_children(signal.SIGTERM, time.monotonic() + grace) if lingering else True
    if not tree_empty:
        tree_empty = terminate_children(signal.SIGKILL, time.monotonic() + grace)
    if isinstance(status, int) and status < 0:
        try:
            signal_name = signal.Signals(-status).name
        except ValueError:
            signal_name = "SIG%d" % (-status)
        status = None
    publish({
        "lingeringDescendants": lingering,
        "signal": signal_name,
        "spawnError": "POSIX containment supervisor was terminated by its owner" if parent_terminated else None,
        "status": status,
        "timedOut": timed_out,
        "treeEmpty": tree_empty,
    })

try:
    main()
except BaseException as error:
    publish({"spawnError":"POSIX containment supervisor failed: %s" % error,"treeEmpty":False})
`;

function fail(message) {
  throw new Error(`Qualification isolation: ${message}`);
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function sortedKeys(value) {
  return Object.keys(value).sort();
}

function assertExactKeys(value, expected, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(`${label} must be an object`);
  }
  if (JSON.stringify(sortedKeys(value)) !== JSON.stringify([...expected].sort())) {
    fail(`${label} has an unexpected shape`);
  }
}

function assertCanonicalAbsolutePath(value, label) {
  if (typeof value !== "string" || value.length === 0 || !isAbsolute(value) || resolve(value) !== value) {
    fail(`${label} must be a canonical absolute path`);
  }
  return value;
}

function assertToken(value, label) {
  if (typeof value !== "string" || !TOKEN_PATTERN.test(value)) {
    fail(`${label} is malformed`);
  }
}

function assertBranch(value) {
  if (
    typeof value !== "string" ||
    !BRANCH_PATTERN.test(value) ||
    value.includes("..") ||
    value.includes("//") ||
    value.endsWith("/")
  ) {
    fail("branch is malformed");
  }
}

function isInside(path, parent) {
  const suffix = relative(parent, path);
  return suffix !== "" && !suffix.startsWith("..") && !isAbsolute(suffix);
}

function isGitOverrideEnvironmentKey(key) {
  const normalized = key.toUpperCase();
  return GIT_OVERRIDE_KEYS.has(normalized) || GIT_OVERRIDE_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}

function cleanGitEnvironment(environment = process.env) {
  const result = { ...environment };
  for (const key of Object.keys(result)) {
    if (isGitOverrideEnvironmentKey(key)) {
      delete result[key];
    }
  }
  return result;
}

function gitInspectionEnvironment(assignment, hostEnvironment = process.env) {
  const environment = cleanGitEnvironment(hostEnvironment);
  environment.GIT_OPTIONAL_LOCKS = "0";
  const directories = [dirname(assignment.gitExecutable), dirname(process.execPath)];
  if (process.platform === "win32") {
    const systemRoot = windowsSystemRootCandidate(process.execPath);
    environment.COMSPEC = join(systemRoot, "System32", "cmd.exe");
    environment.SYSTEMDRIVE = parse(systemRoot).root.replace(/[\\/]$/u, "");
    environment.SYSTEMROOT = systemRoot;
    environment.WINDIR = systemRoot;
    directories.push(join(systemRoot, "System32"));
  } else {
    directories.push("/usr/bin", "/bin");
  }
  environment.PATH = [...new Set(directories)].join(delimiter);
  return environment;
}

function safeGitConfigArguments() {
  const disabledPath = process.platform === "win32" ? "NUL" : "/dev/null";
  return [
    "-c",
    "core.fsmonitor=false",
    "-c",
    "core.untrackedCache=false",
    "-c",
    `core.hooksPath=${disabledPath}`,
    "-c",
    `core.attributesFile=${disabledPath}`,
    "-c",
    `core.excludesFile=${disabledPath}`,
    "-c",
    "core.pager=",
    "-c",
    "diff.external=",
    "-c",
    "diff.trustExitCode=false",
    "-c",
    "interactive.diffFilter=",
    "-c",
    "commit.gpgSign=false",
    "-c",
    "tag.gpgSign=false",
    "-c",
    "format.signOff=false",
    "-c",
    "format.signature="
  ];
}

function gitInspectionArguments(assignment, arguments_) {
  const command = arguments_[0];
  const hardened =
    command === "diff" ? [command, "--no-ext-diff", "--no-textconv", ...arguments_.slice(1)] : arguments_;
  return [
    ...safeGitConfigArguments(),
    "--no-optional-locks",
    "--git-dir",
    assignment.gitDirectory,
    "--work-tree",
    assignment.worktree,
    ...hardened
  ];
}

function gitWithEnvironment(assignment, arguments_, hostEnvironment) {
  const result = spawnSync(assignment.gitExecutable, gitInspectionArguments(assignment, arguments_), {
    cwd: assignment.worktree,
    encoding: "utf8",
    env: gitInspectionEnvironment(assignment, hostEnvironment),
    maxBuffer: 4 * 1024 * 1024,
    windowsHide: true
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    fail(`Git ${arguments_.join(" ")} failed: ${(result.stderr || result.stdout).trim()}`);
  }
  return result.stdout.trim();
}

function optionalGitConfig(assignment, key, hostEnvironment = process.env) {
  const result = spawnSync(assignment.gitExecutable, gitInspectionArguments(assignment, ["config", "--get", key]), {
    cwd: assignment.worktree,
    encoding: "utf8",
    env: gitInspectionEnvironment(assignment, hostEnvironment),
    maxBuffer: 1024 * 1024,
    windowsHide: true
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status === 1 && result.stdout === "") {
    return null;
  }
  if (result.status !== 0) {
    fail(`Git config ${key} failed: ${(result.stderr || result.stdout).trim()}`);
  }
  const value = result.stdout.trim();
  return value === "" ? null : value;
}

function gitConfigSelectionEnvironment(hostEnvironment) {
  const selection = {};
  for (const key of ["HOME", "HOMEDRIVE", "HOMEPATH", "PROGRAMDATA", "USERPROFILE", "XDG_CONFIG_HOME"]) {
    if (typeof hostEnvironment[key] === "string" && hostEnvironment[key].length > 0) {
      selection[key] = hostEnvironment[key];
    }
  }
  return selection;
}

function decodeStrictUtf8(bytes, label) {
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    fail(`${label} is not strict UTF-8`);
  }
  if (!Buffer.from(text, "utf8").equals(bytes)) {
    fail(`${label} does not round-trip as strict UTF-8`);
  }
  return text;
}

function parseGitConfigManifestBytes(bytes) {
  if (bytes.length === 0 || bytes.length > MAX_GIT_CONFIG_MANIFEST_BYTES || bytes.at(-1) !== 0) {
    fail("Git config manifest bytes are invalid");
  }
  const fields = decodeStrictUtf8(bytes, "Git config manifest").split("\0");
  fields.pop();
  if (fields.length % 3 !== 0) fail("Git config manifest shape is invalid");
  const sourceScopes = new Map();
  for (let index = 0; index < fields.length; index += 3) {
    const scope = fields[index];
    const origin = fields[index + 1];
    if (origin === "command line:") {
      if (scope !== "command") fail("Git command-line config has the wrong scope");
      continue;
    }
    if (!origin.startsWith("file:")) {
      fail(`Git config source ${origin} is not a receiptable file`);
    }
    const path = origin.slice("file:".length);
    assertCanonicalAbsolutePath(path, "Git config source");
    const scopes = sourceScopes.get(path) ?? new Set();
    scopes.add(scope);
    sourceScopes.set(path, scopes);
  }
  return {
    entryCount: fields.length / 3,
    sources: [...sourceScopes.entries()]
      .map(([path, scopes]) => ({ path, scopes: [...scopes].sort() }))
      .sort((left, right) => left.path.localeCompare(right.path))
  };
}

function captureGitConfigManifest(assignment, hostEnvironment) {
  const result = spawnSync(
    assignment.gitExecutable,
    gitInspectionArguments(assignment, ["config", "--show-origin", "--show-scope", "--null", "--list"]),
    {
      cwd: assignment.worktree,
      encoding: null,
      env: gitInspectionEnvironment(assignment, hostEnvironment),
      maxBuffer: MAX_GIT_CONFIG_MANIFEST_BYTES,
      windowsHide: true
    }
  );
  if (result.error) throw result.error;
  if (result.status !== 0) {
    fail("Git config manifest command failed");
  }
  const bytes = Buffer.from(result.stdout ?? Buffer.alloc(0));
  const parsed = parseGitConfigManifestBytes(bytes);
  return {
    bytes,
    entryCount: parsed.entryCount,
    selectionEnvironment: gitConfigSelectionEnvironment(hostEnvironment),
    sha256: sha256(bytes),
    sources: parsed.sources
  };
}

async function fileIdentity(path, expectedKind) {
  const value = await lstat(path, { bigint: true });
  if (value.isSymbolicLink()) {
    fail(`${path} must not be a symbolic link`);
  }
  if (expectedKind === "directory" && !value.isDirectory()) {
    fail(`${path} must be a directory`);
  }
  if (expectedKind === "file" && (!value.isFile() || value.nlink !== 1n)) {
    fail(`${path} must be a singly linked regular file`);
  }
  const canonical = await realpath(path);
  if (canonical !== path) {
    fail(`${path} must not use an aliased parent`);
  }
  return {
    device: value.dev.toString(),
    inode: value.ino.toString(),
    mode: Number(value.mode & 0o777n),
    links: value.nlink.toString(),
    path
  };
}

function sameIdentity(left, right) {
  return (
    left.path === right.path && left.device === right.device && left.inode === right.inode && left.mode === right.mode
  );
}

function sameImmutableSnapshot(left, right) {
  return ["dev", "ino", "mode", "nlink", "size", "mtimeNs", "ctimeNs", "birthtimeNs"].every(
    (key) => left[key] === right[key]
  );
}

function sameDirectorySnapshot(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.mode === right.mode;
}

async function openPinnedDirectory(path, label, { afterOpenForTest } = {}) {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0));
  } catch (error) {
    if (error?.code === "ELOOP" || error?.code === "ENOTDIR") {
      fail(`${label} must be one canonical non-symbolic-link directory`);
    }
    throw error;
  }
  try {
    const opened = await handle.stat({ bigint: true });
    await afterOpenForTest?.({ handle, path });
    const namedBefore = await lstat(path, { bigint: true });
    const canonical = await realpath(path);
    const namedAfter = await lstat(path, { bigint: true });
    if (
      !opened.isDirectory() ||
      namedBefore.isSymbolicLink() ||
      namedAfter.isSymbolicLink() ||
      !sameDirectorySnapshot(opened, namedBefore) ||
      !sameDirectorySnapshot(namedBefore, namedAfter) ||
      canonical !== path
    ) {
      fail(`${label} changed while it was opened`);
    }
    return { handle, path, snapshot: opened };
  } catch (error) {
    await finishWithOwnedCleanup(error, [{ label, run: () => handle.close() }]);
  }
}

async function verifyPinnedDirectory(value, label) {
  const opened = await value.handle.stat({ bigint: true });
  const named = await lstat(value.path, { bigint: true });
  if (
    !opened.isDirectory() ||
    named.isSymbolicLink() ||
    !sameDirectorySnapshot(value.snapshot, opened) ||
    !sameDirectorySnapshot(opened, named) ||
    (await realpath(value.path)) !== value.path
  ) {
    fail(`${label} identity changed`);
  }
}

async function readPinnedBytes(handle, maximumBytes, label) {
  const opened = await handle.stat({ bigint: true });
  if (!opened.isFile() || opened.nlink !== 1n || opened.size <= 0n || opened.size > BigInt(maximumBytes)) {
    fail(`${label} bytes are invalid`);
  }
  const bytes = Buffer.alloc(Number(opened.size));
  let offset = 0;
  while (offset < bytes.length) {
    const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
    if (bytesRead === 0) {
      fail(`${label} ended before its pinned size`);
    }
    offset += bytesRead;
  }
  const completed = await handle.stat({ bigint: true });
  if (!sameImmutableSnapshot(opened, completed)) {
    fail(`${label} changed while it was read`);
  }
  return { bytes, snapshot: opened };
}

async function openPinnedRegularFile(path, maximumBytes, label, { afterOpenForTest } = {}) {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  } catch (error) {
    if (error?.code === "ELOOP") {
      fail(`${label} must be a singly linked regular file`);
    }
    throw error;
  }
  try {
    const opened = await handle.stat({ bigint: true });
    await afterOpenForTest?.({ handle, path });
    const namedBefore = await lstat(path, { bigint: true });
    const canonical = await realpath(path);
    const namedAfter = await lstat(path, { bigint: true });
    if (
      !opened.isFile() ||
      opened.nlink !== 1n ||
      namedBefore.isSymbolicLink() ||
      namedAfter.isSymbolicLink() ||
      !sameImmutableSnapshot(opened, namedBefore) ||
      !sameImmutableSnapshot(namedBefore, namedAfter) ||
      canonical !== path
    ) {
      fail(`${label} changed while it was opened`);
    }
    const { bytes, snapshot } = await readPinnedBytes(handle, maximumBytes, label);
    const after = await lstat(path, { bigint: true });
    if (
      after.isSymbolicLink() ||
      !sameImmutableSnapshot(opened, snapshot) ||
      !sameImmutableSnapshot(snapshot, after) ||
      (await realpath(path)) !== path
    ) {
      fail(`${label} changed while it was opened`);
    }
    return { bytes, handle, path, snapshot };
  } catch (error) {
    await finishWithOwnedCleanup(error, [{ label, run: () => handle.close() }]);
  }
}

async function verifyPinnedRegularFile(value, maximumBytes, label) {
  const { bytes, snapshot } = await readPinnedBytes(value.handle, maximumBytes, label);
  const named = await lstat(value.path, { bigint: true });
  if (
    named.isSymbolicLink() ||
    !sameImmutableSnapshot(value.snapshot, snapshot) ||
    !sameImmutableSnapshot(snapshot, named) ||
    (await realpath(value.path)) !== value.path
  ) {
    fail(`${label} identity changed`);
  }
  return bytes;
}

async function readAssignment(path) {
  assertCanonicalAbsolutePath(path, "assignment path");
  const pinned = await openPinnedRegularFile(path, MAX_ASSIGNMENT_BYTES, "assignment");
  const { bytes } = pinned;
  if (bytes.includes(0)) {
    await pinned.handle.close();
    fail("assignment bytes are invalid");
  }
  let value;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch {
    await pinned.handle.close();
    fail("assignment is not valid JSON");
  }
  try {
    assertExactKeys(value, ASSIGNMENT_KEYS, "assignment");
    if (value.protocol !== ASSIGNMENT_PROTOCOL) {
      fail("assignment protocol is unsupported");
    }
    assertToken(value.taskId, "taskId");
    assertToken(value.runId, "runId");
    assertBranch(value.branch);
    if (!Number.isSafeInteger(value.issue) || value.issue <= 0) {
      fail("issue must be a positive safe integer");
    }
    for (const key of ["base", "head", "tree"]) {
      if (typeof value[key] !== "string" || !SHA_PATTERN.test(value[key])) {
        fail(`${key} must be a lowercase full Git object ID`);
      }
    }
    assertCanonicalAbsolutePath(value.worktree, "worktree");
    assertCanonicalAbsolutePath(value.stateRoot, "stateRoot");
    assertCanonicalAbsolutePath(value.gitDirectory, "gitDirectory");
    assertCanonicalAbsolutePath(value.gitExecutable, "gitExecutable");
  } catch (error) {
    await pinned.handle.close();
    throw error;
  }
  return { bytes, digest: sha256(bytes), path, pinned, value };
}

async function optionalDirectoryIdentity(path) {
  try {
    return await fileIdentity(path, "directory");
  } catch (error) {
    if (error?.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

async function captureGitIdentity(assignment, hostEnvironment = process.env) {
  const worktreeIdentity = await fileIdentity(assignment.worktree, "directory");
  const inspect = (arguments_) => gitWithEnvironment(assignment, arguments_, hostEnvironment);
  if (inspect(["rev-parse", "--is-inside-work-tree"]) !== "true") {
    fail("assignment worktree is not a Git worktree");
  }
  const gitDirectory = inspect(["rev-parse", "--path-format=absolute", "--git-dir"]);
  const commonDirectory = inspect(["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  const gitIndex = inspect(["rev-parse", "--path-format=absolute", "--git-path", "index"]);
  const objectDirectory = inspect(["rev-parse", "--path-format=absolute", "--git-path", "objects"]);
  const head = inspect(["rev-parse", "HEAD"]);
  const tree = inspect(["rev-parse", "HEAD^{tree}"]);
  const branch = inspect(["branch", "--show-current"]);
  const base = inspect(["rev-parse", `${assignment.base}^{commit}`]);
  const mergeBase = inspect(["merge-base", assignment.base, "HEAD"]);
  const status = inspect(["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
  const diffCheck = inspect(["diff", "--check"]);
  if (base !== assignment.base || mergeBase !== assignment.base) {
    fail("assignment base is not the exact ancestor of HEAD");
  }
  if (head !== assignment.head || tree !== assignment.tree || branch !== assignment.branch) {
    fail("worktree HEAD, tree, or branch does not match the assignment");
  }
  if (gitDirectory !== assignment.gitDirectory) {
    fail("worktree Git directory does not match the sealed assignment owner");
  }
  if (status !== "" || diffCheck !== "") {
    fail("worktree must be clean before qualification");
  }
  const nodeModules = join(assignment.worktree, "node_modules");
  const nodeModulesIdentity = await optionalDirectoryIdentity(nodeModules);
  return {
    base,
    branch,
    commonDirectory: await fileIdentity(commonDirectory, "directory"),
    gitDirectory: await fileIdentity(gitDirectory, "directory"),
    gitExecutable: await fileIdentity(assignment.gitExecutable, "file"),
    gitIndex: await fileIdentity(gitIndex, "file"),
    head,
    mergeBase,
    nodeModules: nodeModulesIdentity,
    objectDirectory: await fileIdentity(objectDirectory, "directory"),
    tree,
    worktree: worktreeIdentity
  };
}

async function openGitOwnerPins(assignment, gitIdentity, worktreePin, hostEnvironment) {
  const pins = { configSources: [], worktree: worktreePin };
  try {
    pins.commonDirectory = await openPinnedDirectory(gitIdentity.commonDirectory.path, "Git common-directory owner");
    pins.gitDirectory = await openPinnedDirectory(gitIdentity.gitDirectory.path, "Git-directory owner");
    pins.gitIndex = await openPinnedRegularFile(gitIdentity.gitIndex.path, MAX_GIT_INDEX_BYTES, "Git index owner");
    pins.objectDirectory = await openPinnedDirectory(gitIdentity.objectDirectory.path, "Git object-directory owner");
    const manifestBefore = captureGitConfigManifest(assignment, hostEnvironment);
    for (const source of manifestBefore.sources) {
      pins.configSources.push({
        ...source,
        pin: await openPinnedRegularFile(source.path, MAX_GIT_CONFIG_BYTES, `Git config source ${source.path}`)
      });
    }
    const manifestAfter = captureGitConfigManifest(assignment, hostEnvironment);
    if (
      manifestBefore.sha256 !== manifestAfter.sha256 ||
      manifestBefore.entryCount !== manifestAfter.entryCount ||
      JSON.stringify(manifestBefore.sources) !== JSON.stringify(manifestAfter.sources)
    ) {
      fail("effective Git config changed while its sources were pinned");
    }
    pins.configManifest = manifestBefore;
    pins.gitExecutable = await openPinnedExecutable(gitIdentity.gitExecutable.path);
    if (gitIdentity.nodeModules) {
      pins.nodeModules = await openPinnedDirectory(gitIdentity.nodeModules.path, "node_modules owner");
    }
    for (const [key, pin] of Object.entries(pins)) {
      if (key === "configManifest" || key === "configSources") continue;
      if (key === "gitExecutable") {
        const leaf = executableLeaf(pin);
        if (
          leaf.before.dev.toString() !== gitIdentity.gitExecutable.device ||
          leaf.before.ino.toString() !== gitIdentity.gitExecutable.inode
        ) {
          fail("Git executable changed before its owner could be pinned");
        }
        continue;
      }
      if (key === "gitIndex") {
        if (
          pin.snapshot.dev.toString() !== gitIdentity.gitIndex.device ||
          pin.snapshot.ino.toString() !== gitIdentity.gitIndex.inode
        ) {
          fail("Git index changed before its owner could be pinned");
        }
        continue;
      }
      const identity = key === "worktree" ? gitIdentity.worktree : gitIdentity[key];
      if (pin.snapshot.dev.toString() !== identity.device || pin.snapshot.ino.toString() !== identity.inode) {
        fail(`${key} changed before its owner could be pinned`);
      }
    }
    return pins;
  } catch (error) {
    await finishWithOwnedCleanup(error, [{ label: "partial Git owners", run: () => closeDirectoryPins(pins) }]);
  }
}

async function verifyGitOwnerPins(pins) {
  for (const [key, pin] of Object.entries(pins)) {
    if (key === "configManifest") {
      continue;
    } else if (key === "configSources") {
      for (const source of pin) {
        await verifyPinnedRegularFile(source.pin, MAX_GIT_CONFIG_BYTES, `Git config source ${source.path}`);
      }
    } else if (key === "gitExecutable") {
      await verifyPinnedExecutable(pin);
    } else if (key === "gitIndex") {
      await verifyPinnedRegularFile(pin, MAX_GIT_INDEX_BYTES, "Git index owner");
    } else {
      await verifyPinnedDirectory(pin, `${key} owner`);
    }
  }
}

async function closeDirectoryPins(pins) {
  const actions = [];
  for (const [key, value] of Object.entries(pins ?? {})) {
    if (key === "configManifest") continue;
    if (key === "configSources") {
      for (const [index, source] of value.entries()) {
        actions.push({ label: `Git config source ${String(index)}`, run: () => source.pin.handle.close() });
      }
    } else {
      actions.push({ label: `${key} owner`, run: () => value.handle.close() });
    }
  }
  await finishWithOwnedCleanup(null, actions);
}

async function captureGitConfigIdentity(assignment, pins, hostEnvironment) {
  const sources = [];
  for (const source of pins.configSources) {
    const bytes = await verifyPinnedRegularFile(source.pin, MAX_GIT_CONFIG_BYTES, `Git config source ${source.path}`);
    sources.push({
      device: source.pin.snapshot.dev.toString(),
      inode: source.pin.snapshot.ino.toString(),
      links: source.pin.snapshot.nlink.toString(),
      mode: Number(source.pin.snapshot.mode & 0o777n),
      path: source.path,
      scopes: source.scopes,
      sha256: sha256(bytes),
      size: bytes.length
    });
  }
  const manifest = captureGitConfigManifest(assignment, hostEnvironment);
  if (
    manifest.sha256 !== pins.configManifest.sha256 ||
    manifest.entryCount !== pins.configManifest.entryCount ||
    JSON.stringify(manifest.sources) !== JSON.stringify(pins.configManifest.sources)
  ) {
    fail("effective Git config manifest changed during qualification");
  }
  return {
    effectiveEmail: optionalGitConfig(assignment, "user.email", hostEnvironment),
    effectiveName: optionalGitConfig(assignment, "user.name", hostEnvironment),
    entryCount: manifest.entryCount,
    manifestSha256: manifest.sha256,
    sources
  };
}

async function captureGitMetadataIdentity(pins) {
  const indexBytes = await verifyPinnedRegularFile(pins.gitIndex, MAX_GIT_INDEX_BYTES, "Git index owner");
  const gitDirectory = await inspectPrivateTree(pins.gitDirectory, "Git-directory owner");
  const commonDirectory =
    pins.commonDirectory.path === pins.gitDirectory.path
      ? null
      : await inspectPrivateTree(pins.commonDirectory, "Git common-directory owner");
  return {
    commonDirectory,
    gitDirectory,
    index: {
      device: pins.gitIndex.snapshot.dev.toString(),
      inode: pins.gitIndex.snapshot.ino.toString(),
      mode: Number(pins.gitIndex.snapshot.mode & 0o777n),
      sha256: sha256(indexBytes),
      size: indexBytes.length
    },
    objects: await inspectPrivateTree(pins.objectDirectory, "Git object-directory owner")
  };
}

function assertSameGitIdentity(before, after) {
  for (const key of ["base", "branch", "head", "mergeBase", "tree"]) {
    if (before[key] !== after[key]) {
      fail(`worktree ${key} changed during qualification`);
    }
  }
  for (const key of ["commonDirectory", "gitDirectory", "gitExecutable", "gitIndex", "objectDirectory", "worktree"]) {
    if (!sameIdentity(before[key], after[key])) {
      fail(`worktree ${key} identity changed during qualification`);
    }
  }
  if (JSON.stringify(before.gitConfig) !== JSON.stringify(after.gitConfig)) {
    fail("worktree Git config or effective identity changed during qualification");
  }
  if (JSON.stringify(before.gitMetadata) !== JSON.stringify(after.gitMetadata)) {
    fail("worktree Git index or object inventory changed during qualification");
  }
  if (before.nodeModules === null && after.nodeModules !== null) {
    return;
  }
  if (
    (before.nodeModules === null) !== (after.nodeModules === null) ||
    (before.nodeModules !== null && !sameIdentity(before.nodeModules, after.nodeModules))
  ) {
    fail("worktree node_modules identity changed during qualification");
  }
}

async function makeDirectory(path) {
  await mkdir(path, { mode: 0o700, recursive: true });
  if (process.platform !== "win32") {
    await chmod(path, 0o700);
  }
  return fileIdentity(path, "directory");
}

async function createStateLayout(assignment, assignmentDigest) {
  if (
    assignment.stateRoot === assignment.worktree ||
    isInside(assignment.stateRoot, assignment.worktree) ||
    isInside(assignment.worktree, assignment.stateRoot)
  ) {
    fail("stateRoot and worktree must be disjoint");
  }
  const parent = dirname(assignment.stateRoot);
  const parentBefore = await fileIdentity(parent, "directory");
  try {
    await lstat(assignment.stateRoot);
    fail("stateRoot already exists");
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
  }
  await mkdir(assignment.stateRoot, { mode: 0o700 });
  if (process.platform !== "win32") {
    await chmod(assignment.stateRoot, 0o700);
  }
  const stateRootIdentity = await fileIdentity(assignment.stateRoot, "directory");
  const parentAfter = await fileIdentity(parent, "directory");
  if (!sameIdentity(parentBefore, parentAfter)) {
    fail("stateRoot parent changed during creation");
  }

  const pythonExecutable = join(
    assignment.stateRoot,
    "python",
    "venv",
    process.platform === "win32" ? "Scripts" : "bin",
    process.platform === "win32" ? "python.exe" : "python"
  );
  const layout = {
    artifacts: join(assignment.stateRoot, "artifacts"),
    browserProfile: join(assignment.stateRoot, "browser", "profile"),
    corepackHome: join(assignment.stateRoot, "node", "corepack"),
    executableSnapshots: join(assignment.stateRoot, "runs", assignment.runId, "executables"),
    gitMetadata: join(assignment.stateRoot, "git", "metadata"),
    gitWrapper: join(assignment.stateRoot, "node", "tool-shims", process.platform === "win32" ? "git.cmd" : "git"),
    gitWrapperProgram: join(assignment.stateRoot, "node", "tool-shims", "git-wrapper.mjs"),
    home: join(assignment.stateRoot, "home"),
    nodeModules: join(assignment.worktree, "node_modules"),
    npmCache: join(assignment.stateRoot, "node", "npm-cache"),
    npmPrefix: join(assignment.stateRoot, "node", "npm-prefix"),
    npmUserConfig: join(assignment.stateRoot, "node", "npm-userconfig"),
    pipCache: join(assignment.stateRoot, "python", "pip-cache"),
    pipConfig: join(assignment.stateRoot, "python", "pip.conf"),
    playwrightBrowsers: join(assignment.stateRoot, "browser", "playwright"),
    pytestCache: join(assignment.stateRoot, "python", "pytest-cache"),
    pytestTempParent: join(assignment.stateRoot, "python", "pytest-temp"),
    pythonBytecode: join(assignment.stateRoot, "python", "bytecode"),
    pythonExecutable,
    pythonToolExecutable: pythonExecutable,
    pythonUserBase: join(assignment.stateRoot, "python", "user-base"),
    rCache: join(assignment.stateRoot, "r", "cache"),
    rLibrary: join(assignment.stateRoot, "r", "library"),
    receipt: join(assignment.stateRoot, "artifacts", "qualification-receipt.json"),
    rUser: join(assignment.stateRoot, "r", "user"),
    run: join(assignment.stateRoot, "runs", assignment.runId),
    ruffCache: join(assignment.stateRoot, "python", "ruff-cache"),
    stateRoot: assignment.stateRoot,
    temp: join(assignment.stateRoot, "temp"),
    testProgress: join(assignment.stateRoot, "runs", assignment.runId, "test-progress.json"),
    testResult: join(assignment.stateRoot, "runs", assignment.runId, "test-result.json"),
    toolShim: join(assignment.stateRoot, "node", "tool-shims"),
    uvCache: join(assignment.stateRoot, "python", "uv-cache"),
    venv: join(assignment.stateRoot, "python", "venv"),
    vitestCache: join(assignment.worktree, "node_modules", ".vite"),
    xdgCache: join(assignment.stateRoot, "xdg", "cache"),
    xdgConfig: join(assignment.stateRoot, "xdg", "config"),
    xdgData: join(assignment.stateRoot, "xdg", "data"),
    xdgRuntime: join(assignment.stateRoot, "xdg", "runtime"),
    xdgState: join(assignment.stateRoot, "xdg", "state")
  };
  layout.pytestTemp = join(layout.pytestTempParent, `basetemp-${randomUUID()}`);
  const directoryKeys = Object.keys(layout).filter(
    (key) =>
      ![
        "nodeModules",
        "gitWrapper",
        "gitWrapperProgram",
        "npmUserConfig",
        "pipConfig",
        "pytestTemp",
        "pythonExecutable",
        "pythonToolExecutable",
        "receipt",
        "stateRoot",
        "testProgress",
        "testResult",
        "venv",
        "vitestCache"
      ].includes(key)
  );
  const identities = {};
  for (const key of directoryKeys) {
    identities[key] = await makeDirectory(layout[key]);
  }
  await writeFile(layout.npmUserConfig, "", { encoding: "utf8", flag: "wx", mode: 0o600 });
  identities.npmUserConfig = await fileIdentity(layout.npmUserConfig, "file");
  await writeFile(layout.pipConfig, "", { encoding: "utf8", flag: "wx", mode: 0o600 });
  identities.pipConfig = await fileIdentity(layout.pipConfig, "file");
  const marker = join(assignment.stateRoot, "assignment.json");
  await writeFile(
    marker,
    `${JSON.stringify({
      assignmentSha256: assignmentDigest,
      issue: assignment.issue,
      protocol: ASSIGNMENT_PROTOCOL,
      runId: assignment.runId,
      taskId: assignment.taskId
    })}\n`,
    { encoding: "utf8", flag: "wx", mode: 0o600 }
  );
  identities.marker = await fileIdentity(marker, "file");
  const receiptHandle = await open(
    layout.receipt,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0),
    0o600
  );
  let receiptSnapshot;
  try {
    receiptSnapshot = await receiptHandle.stat({ bigint: true });
    const named = await lstat(layout.receipt, { bigint: true });
    if (
      !receiptSnapshot.isFile() ||
      receiptSnapshot.nlink !== 1n ||
      receiptSnapshot.size !== 0n ||
      !sameImmutableSnapshot(receiptSnapshot, named) ||
      (await realpath(layout.receipt)) !== layout.receipt
    ) {
      fail("receipt reservation is invalid");
    }
  } catch (error) {
    await finishWithOwnedCleanup(error, [{ label: "receipt owner", run: () => receiptHandle.close() }]);
  }
  const ownerPins = {};
  try {
    ownerPins.stateRoot = await openPinnedDirectory(layout.stateRoot, "stateRoot owner");
    ownerPins.artifacts = await openPinnedDirectory(layout.artifacts, "artifact owner");
    ownerPins.executableSnapshots = await openPinnedDirectory(layout.executableSnapshots, "executable-snapshot owner");
    ownerPins.gitMetadata = await openPinnedDirectory(layout.gitMetadata, "private Git metadata owner");
    ownerPins.pytestTempParent = await openPinnedDirectory(layout.pytestTempParent, "pytest-temp parent owner");
    for (const [key, pin] of Object.entries(ownerPins)) {
      const identity = key === "stateRoot" ? stateRootIdentity : identities[key];
      if (pin.snapshot.dev.toString() !== identity.device || pin.snapshot.ino.toString() !== identity.inode) {
        fail(`${key} owner changed before it could be pinned`);
      }
    }
  } catch (error) {
    await finishWithOwnedCleanup(error, [
      ...Object.entries(ownerPins).map(([key, pin]) => ({ label: `${key} owner`, run: () => pin.handle.close() })),
      { label: "receipt owner", run: () => receiptHandle.close() }
    ]);
  }
  return {
    identities,
    layout,
    ownerPins,
    pytestTempTree: null,
    receiptHandle,
    receiptSnapshot,
    runnerFilePins: [],
    stateRootIdentity
  };
}

async function requireAbsentPath(path, label) {
  try {
    await lstat(path);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  fail(`${label} must be absent before qualification`);
}

function pytestTreeLimits(value) {
  const requested = value ?? {};
  const maximums = {
    bytes: MAX_PYTEST_TEMP_BYTES,
    entries: MAX_PYTEST_TEMP_ENTRIES,
    pathBytes: MAX_PYTEST_TEMP_PATH_BYTES
  };
  const result = {};
  for (const [key, maximum] of Object.entries(maximums)) {
    const candidate = requested[key] ?? maximum;
    if (!Number.isSafeInteger(candidate) || candidate <= 0 || candidate > maximum) {
      fail(`pytest temporary ${key} limit is invalid`);
    }
    result[key] = candidate;
  }
  return Object.freeze(result);
}

async function pinnedMountIdentity(handle, path, platform, mountIdentityForTest) {
  if (mountIdentityForTest) {
    const injected = await mountIdentityForTest({ handle, path, platform });
    if (typeof injected !== "string" || injected.length === 0 || injected.length > 256) {
      fail("pytest temporary mount identity is invalid");
    }
    return `injected:${injected}`;
  }
  const opened = await handle.stat({ bigint: true });
  if (platform === "linux") {
    const bytes = await readFile(`/proc/self/fdinfo/${handle.fd}`);
    if (bytes.length === 0 || bytes.length > 4096 || bytes.includes(0)) {
      fail("pytest temporary Linux mount identity is unavailable");
    }
    const matches = [...bytes.toString("utf8").matchAll(/^mnt_id:\s*([0-9]+)$/gmu)];
    if (matches.length !== 1) fail("pytest temporary Linux mount identity is ambiguous");
    return `linux:${matches[0][1]}`;
  }
  if (platform === "win32") {
    const root = windowsPath.parse(path).root.toLowerCase();
    if (!root) fail("pytest temporary Windows volume identity is unavailable");
    let cursor = root;
    for (const segment of path
      .slice(root.length)
      .split(/[\\/]+/u)
      .filter(Boolean)) {
      cursor = windowsPath.join(cursor, segment);
      const value = await lstat(cursor, { bigint: true });
      if (value.isSymbolicLink()) fail("pytest temporary tree contains a Windows reparse alias");
    }
    return `windows:${root}:${opened.dev.toString()}`;
  }
  fail(`pytest temporary mount identity is unsupported on ${platform}`);
}

function addTreeDigest(accumulator, values) {
  const hash = createHash("sha256");
  for (const value of Array.isArray(values) ? values : [values]) hash.update(value);
  const entry = hash.digest();
  for (let index = 0; index < entry.length; index += 1) accumulator.xor[index] ^= entry[index];
  accumulator.sum = (accumulator.sum + BigInt(`0x${entry.toString("hex")}`)) & ((1n << 256n) - 1n);
}

function finishTreeDigest(accumulator, entries) {
  const sum = Buffer.from(accumulator.sum.toString(16).padStart(64, "0"), "hex");
  return createHash("sha256").update(`${entries}\0`, "utf8").update(accumulator.xor).update(sum).digest("hex");
}

async function inspectPrivateTree(rootPin, label, options = {}) {
  const limits = pytestTreeLimits(options.limits);
  const platform = options.platformForTest ?? process.platform;
  await verifyPinnedDirectory(rootPin, label);
  const rootBefore = await rootPin.handle.stat({ bigint: true });
  const rootMount = await pinnedMountIdentity(rootPin.handle, rootPin.path, platform, options.mountIdentityForTest);
  const accumulator = { sum: 0n, xor: Buffer.alloc(32) };
  let directories = 1;
  let entries = 0;
  let files = 0;
  let pathBytes = 0;
  let symbolicLinks = 0;
  let totalBytes = 0n;

  const requireOwnedMount = async (handle, path) => {
    const identity = await pinnedMountIdentity(handle, path, platform, options.mountIdentityForTest);
    if (identity !== rootMount) fail(`${label} contains an aliased or mounted entry`);
    return identity;
  };
  const decodeRawName = (value) => {
    const bytes = Buffer.isBuffer(value) ? Buffer.from(value) : Buffer.from(value, "utf8");
    let name;
    try {
      name = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    } catch {
      fail(`${label} contains an undecodable path before inspection`);
    }
    if (name.length === 0 || !Buffer.from(name, "utf8").equals(bytes)) {
      fail(`${label} contains an undecodable path before inspection`);
    }
    return { bytes, name };
  };
  const visit = async (directoryPin, relativeDirectory, relativeDirectoryBytes) => {
    await verifyPinnedDirectory(directoryPin, label);
    await requireOwnedMount(directoryPin.handle, directoryPin.path);
    const stream = await opendir(directoryPin.path, { encoding: platform === "win32" ? "utf8" : "buffer" });
    try {
      for await (const directoryEntry of stream) {
        entries += 1;
        if (entries > limits.entries) fail(`${label} contains too many entries`);
        const entryName = decodeRawName(directoryEntry.name);
        if (relativeDirectory === "" && options.allowedTopLevelName !== undefined) {
          if (options.allowedTopLevelName === null || entryName.name !== options.allowedTopLevelName) {
            fail(`${label} contains an unreceipted sibling entry`);
          }
        }
        const path = join(directoryPin.path, entryName.name);
        const relativePath = relative(rootPin.path, path);
        const relativePathBytes =
          relativeDirectoryBytes.length === 0
            ? entryName.bytes
            : Buffer.concat([relativeDirectoryBytes, Buffer.from("/", "ascii"), entryName.bytes]);
        const currentPathBytes = relativePathBytes.length;
        pathBytes += currentPathBytes;
        if (
          relativePath === "" ||
          relativePath.startsWith("..") ||
          isAbsolute(relativePath) ||
          !Buffer.from(relativePath, "utf8").equals(relativePathBytes) ||
          currentPathBytes > 4096
        ) {
          fail(`${label} contains an invalid path`);
        }
        if (pathBytes > limits.pathBytes) fail(`${label} contains too many path bytes`);
        const namedBefore = await lstat(path, { bigint: true });
        let kind;
        let linkIdentity = Buffer.alloc(0);
        if (namedBefore.isSymbolicLink()) {
          const rawLinkText = await readlink(path, { encoding: platform === "win32" ? "utf8" : "buffer" });
          const linkText = decodeRawName(rawLinkText);
          const target = await realpath(path);
          if (!isInside(target, rootPin.path)) fail(`${label} contains an escaping symbolic link`);
          const targetValue = await lstat(target, { bigint: true });
          const targetHandle = await open(
            target,
            constants.O_RDONLY |
              (targetValue.isDirectory() ? (constants.O_DIRECTORY ?? 0) : 0) |
              (constants.O_NOFOLLOW ?? 0)
          );
          try {
            const openedTarget = await targetHandle.stat({ bigint: true });
            if (
              targetValue.isSymbolicLink() ||
              !sameImmutableSnapshot(targetValue, openedTarget) ||
              (await realpath(target)) !== target
            ) {
              fail(`${label} contains an unstable symbolic link target`);
            }
            await requireOwnedMount(targetHandle, target);
          } finally {
            await targetHandle.close();
          }
          kind = "symbolic-link";
          linkIdentity = Buffer.concat([
            linkText.bytes,
            Buffer.from("\0", "ascii"),
            Buffer.from(target, "utf8"),
            Buffer.from("\0", "ascii")
          ]);
          symbolicLinks += 1;
        } else if ((await realpath(path)) !== path) {
          fail(`${label} contains an aliased or mounted entry`);
        } else if (namedBefore.isDirectory()) {
          const childPin = await openPinnedDirectory(path, label);
          try {
            if (!sameDirectorySnapshot(namedBefore, childPin.snapshot)) fail(`${label} changed while it was opened`);
            await requireOwnedMount(childPin.handle, path);
            kind = "directory";
            directories += 1;
            await visit(childPin, relativePath, relativePathBytes);
          } finally {
            await childPin.handle.close();
          }
        } else if (namedBefore.isFile() && namedBefore.nlink === 1n) {
          const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
          try {
            const opened = await handle.stat({ bigint: true });
            if (!sameImmutableSnapshot(namedBefore, opened)) fail(`${label} changed while it was opened`);
            await requireOwnedMount(handle, path);
          } finally {
            await handle.close();
          }
          kind = "file";
          files += 1;
          totalBytes += namedBefore.size;
          if (totalBytes > BigInt(limits.bytes)) fail(`${label} contains too many bytes`);
        } else {
          fail(`${label} contains a linked or unsupported entry`);
        }
        const namedAfter = await lstat(path, { bigint: true });
        if (!sameImmutableSnapshot(namedBefore, namedAfter)) fail(`${label} changed while it was inspected`);
        addTreeDigest(accumulator, [
          Buffer.from(`${kind}\0`, "utf8"),
          relativePathBytes,
          Buffer.from("\0", "ascii"),
          linkIdentity,
          Buffer.from(
            `${rootMount}\0${namedBefore.dev.toString()}\0${namedBefore.ino.toString()}\0${namedBefore.mode.toString()}\0${namedBefore.nlink.toString()}\0${namedBefore.size.toString()}\0${namedBefore.mtimeNs.toString()}\0${namedBefore.ctimeNs.toString()}\0`,
            "utf8"
          )
        ]);
      }
    } finally {
      await stream.close().catch((error) => {
        if (error?.code !== "ERR_DIR_CLOSED") throw error;
      });
    }
    await verifyPinnedDirectory(directoryPin, label);
  };

  await visit(rootPin, "", Buffer.alloc(0));
  await verifyPinnedDirectory(rootPin, label);
  const rootAfter = await rootPin.handle.stat({ bigint: true });
  if (!sameImmutableSnapshot(rootBefore, rootAfter)) fail(`${label} changed while it was inspected`);
  return {
    bytes: Number(totalBytes),
    device: rootPin.snapshot.dev.toString(),
    directories,
    entries,
    files,
    mount: rootMount,
    pathBytes,
    root: {
      ...fileIdentityRecord(rootPin.path, rootBefore),
      birthtimeNanoseconds: rootBefore.birthtimeNs.toString(),
      changeNanoseconds: rootBefore.ctimeNs.toString(),
      modificationNanoseconds: rootBefore.mtimeNs.toString(),
      size: Number(rootBefore.size)
    },
    sha256: finishTreeDigest(accumulator, entries),
    symbolicLinks
  };
}

function fileIdentityRecord(path, value) {
  return {
    device: value.dev.toString(),
    inode: value.ino.toString(),
    links: value.nlink.toString(),
    mode: Number(value.mode & 0o777n),
    path
  };
}

async function bindPytestTempTree(layoutState, { afterOpenForTest, limits, mountIdentityForTest } = {}) {
  let pin;
  try {
    pin = await openPinnedDirectory(layoutState.layout.pytestTemp, "pytest basetemp", { afterOpenForTest });
  } catch (error) {
    if (error?.code === "ENOENT") {
      await requireAbsentPath(layoutState.layout.pytestTemp, "pytest basetemp");
      const accounting = await inspectPrivateTree(layoutState.ownerPins.pytestTempParent, "pytest temporary parent", {
        allowedTopLevelName: null,
        limits,
        mountIdentityForTest
      });
      layoutState.pytestTempTree = { ...accounting, basetemp: null };
      return layoutState.pytestTempTree;
    }
    throw error;
  }
  try {
    const accounting = await inspectPrivateTree(layoutState.ownerPins.pytestTempParent, "pytest temporary parent", {
      allowedTopLevelName: parse(layoutState.layout.pytestTemp).base,
      limits,
      mountIdentityForTest
    });
    await verifyPinnedDirectory(pin, "pytest basetemp");
    layoutState.ownerPins.pytestTemp = pin;
    layoutState.pytestTempTree = { ...accounting, basetemp: fileIdentityRecord(pin.path, pin.snapshot) };
    return layoutState.pytestTempTree;
  } catch (error) {
    await finishWithOwnedCleanup(error, [{ label: "pytest basetemp", run: () => pin.handle.close() }]);
  }
}

function quotePytestPath(path) {
  return `'${path.replaceAll("'", `'"'"'`)}'`;
}

function gitWrapperProgramSource(assignment, configSelectionEnvironment, gitExecutableLaunch, windowsPowerShell) {
  return `import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, readdirSync, readSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";

const binding = ${JSON.stringify({
    configSelectionEnvironment,
    gitDirectory: assignment.gitDirectory,
    gitExecutable: executableLeaf(gitExecutableLaunch.snapshot).path,
    gitExecutableSha256: gitExecutableLaunch.record.sha256,
    gitExecutableSize: gitExecutableLaunch.record.snapshot.size,
    platform: process.platform,
    privateHome: join(assignment.stateRoot, "home"),
    privateGitRoot: join(assignment.stateRoot, "git", "metadata"),
    privateXdgConfig: join(assignment.stateRoot, "xdg", "config"),
    safeConfigArguments: safeGitConfigArguments(),
    stateRoot: assignment.stateRoot,
    windowsPowerShell,
    worktree: assignment.worktree
  })};
function isInside(root, candidate) {
  const suffix = relative(root, candidate);
  return suffix === "" || (!suffix.startsWith("..") && !isAbsolute(suffix));
}
function privateGitDirectory(effectiveCwd) {
  const owner = realpathSync.native(binding.privateGitRoot);
  if (owner !== binding.privateGitRoot) {
    throw new Error("qualification private Git metadata root is aliased");
  }
  const key = createHash("sha256").update(Buffer.from(effectiveCwd, "utf8")).digest("hex");
  return resolve(owner, key + ".git");
}
function validatePrivateGitAdmin(root, pointerPath) {
  const rootValue = lstatSync(root, { bigint: true });
  if (!rootValue.isDirectory() || rootValue.isSymbolicLink() || realpathSync.native(root) !== root) {
    throw new Error("qualification private Git metadata owner is not one canonical directory");
  }
  let entries = 0;
  let pathBytes = 0;
  const pending = [root];
  while (pending.length > 0) {
    const current = pending.pop();
    const children = readdirSync(current, { encoding: "utf8", withFileTypes: true });
    for (const child of children) {
      const path = resolve(current, child.name);
      entries += 1;
      pathBytes += Buffer.byteLength(path, "utf8");
      if (entries > 100000 || pathBytes > 16 * 1024 * 1024) {
        throw new Error("qualification private Git metadata inventory exceeded its bound");
      }
      if (!isInside(root, path)) {
        throw new Error("qualification private Git metadata path escaped its owner");
      }
      const value = lstatSync(path, { bigint: true });
      if (value.isSymbolicLink() || realpathSync.native(path) !== path) {
        throw new Error("qualification private Git metadata contains a symbolic-link, junction, or alias");
      }
      if (value.isDirectory()) pending.push(path);
      else if (!value.isFile() || value.nlink !== 1n) {
        throw new Error("qualification private Git metadata contains an unsupported or multiply linked entry");
      }
    }
  }
  const pointer = lstatSync(pointerPath, { bigint: true });
  if (!pointer.isFile() || pointer.isSymbolicLink() || pointer.nlink !== 1n || realpathSync.native(pointerPath) !== pointerPath) {
    throw new Error("qualification private Git pointer is invalid");
  }
  const expected = "gitdir: " + root + "\\n";
  if (readFileSync(pointerPath, "utf8") !== expected) {
    throw new Error("qualification private Git pointer does not bind its runner-owned metadata");
  }
}
function rejectConfigurationInjection(argument) {
  return (
    argument === "-c" ||
    (argument.startsWith("-c") && argument.length > 2) ||
    argument === "--config-env" ||
    argument.startsWith("--config-env=")
  );
}
function validateGlobalOptions(arguments_) {
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === "--" || !argument.startsWith("-")) return;
    if (rejectConfigurationInjection(argument)) {
      throw new Error("qualification Git configuration cannot be overridden");
    }
    if (argument === "-C") {
      if (typeof arguments_[index + 1] !== "string" || arguments_[index + 1].length === 0) {
        throw new Error("qualification Git -C owner is malformed");
      }
      index += 1;
      continue;
    }
    if (argument.startsWith("-C") && argument.length > 2) continue;
    throw new Error("qualification Git global option is not allowed");
  }
}
function effectiveWorkingDirectory(initial, arguments_) {
  let directory = initial;
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === "--" || !argument.startsWith("-")) break;
    let requested;
    if (argument === "-C") {
      requested = arguments_[index + 1];
      index += 1;
    } else if (argument.startsWith("-C") && argument.length > 2) {
      requested = argument.slice(2);
    }
    if (requested === undefined) continue;
    if (requested.length === 0) continue;
    directory = realpathSync.native(resolve(directory, requested));
  }
  return directory;
}
function commandAfterGlobalOptions(arguments_) {
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === "-C") {
      index += 1;
      continue;
    }
    if (argument.startsWith("-C") && argument.length > 2) continue;
    if (argument === "--") return { command: arguments_[index + 1], rest: arguments_.slice(index + 2) };
    if (!argument.startsWith("-")) return { command: argument, rest: arguments_.slice(index + 1) };
  }
  return { command: undefined, rest: [] };
}
function rejectUnsafeReadOption(argument) {
  const name = argument.includes("=") ? argument.slice(0, argument.indexOf("=")) : argument;
  return (
    name === "-o" ||
    (name.startsWith("-o") && !name.startsWith("--")) ||
    name === "--output" ||
    name === "--config-env" ||
    name === "--ext-diff" ||
    name === "--textconv" ||
    name === "--filters" ||
    name === "--filter" ||
    name === "--exec-path" ||
    name === "--upload-pack" ||
    name === "--receive-pack" ||
    name === "--show-signature" ||
    name === "--no-index" ||
    name === "--index-info" ||
    name === "--alternate-refs" ||
    name.startsWith("--write") ||
    name.startsWith("--update") ||
    name.includes("helper")
  );
}
function validateReadOnlyArguments(command, rest) {
  let pathsOnly = false;
  for (const argument of rest) {
    if (pathsOnly) continue;
    if (argument === "--") {
      pathsOnly = true;
      continue;
    }
    if (rejectConfigurationInjection(argument)) {
      throw new Error("qualification Git configuration cannot be overridden");
    }
    if (argument.startsWith("-") && rejectUnsafeReadOption(argument)) {
      throw new Error("qualification Git " + command + " option is not read-only");
    }
  }
}
function requireReadOnlyAssignedCommand(arguments_) {
  const { command, rest } = commandAfterGlobalOptions(arguments_);
  const ordinary = new Set([
    "branch",
    "cat-file",
    "check-ignore",
    "describe",
    "diff",
    "diff-index",
    "diff-tree",
    "for-each-ref",
    "log",
    "ls-files",
    "ls-tree",
    "merge-base",
    "name-rev",
    "rev-list",
    "rev-parse",
    "show",
    "show-ref",
    "status"
  ]);
  if (command === "branch") {
    if (rest.length !== 1 || rest[0] !== "--show-current") {
      throw new Error("qualification Git branch access is read-only");
    }
    validateReadOnlyArguments(command, rest);
    return;
  }
  if (command === "config") {
    const readFlags = new Set(["--get", "--get-all", "--get-regexp", "--list", "-l", "--null", "--show-origin", "--show-scope"]);
    if (rest.length === 0 || rest.some((argument) => argument.startsWith("--file") || argument.startsWith("--blob"))) {
      throw new Error("qualification Git config access is read-only");
    }
    const mode = rest.find((argument) => ["--get", "--get-all", "--get-regexp", "--list", "-l"].includes(argument));
    if (!mode || rest.some((argument) => argument.startsWith("-") && !readFlags.has(argument))) {
      throw new Error("qualification Git config access is read-only");
    }
    const positional = rest.filter((argument) => !argument.startsWith("-"));
    if ((mode === "--list" || mode === "-l") ? positional.length !== 0 : positional.length < 1 || positional.length > 2) {
      throw new Error("qualification Git config access is read-only");
    }
    validateReadOnlyArguments(command, rest);
    return;
  }
  if (!ordinary.has(command)) {
    throw new Error("qualification Git command is not read-only for the authoritative worktree");
  }
  validateReadOnlyArguments(command, rest);
}
function requirePrivatePathOperand(effectiveCwd, value, label) {
  if (typeof value !== "string" || value.length === 0 || isAbsolute(value)) {
    throw new Error("qualification Git " + label + " must be relative to the private repository");
  }
  const resolved = resolve(effectiveCwd, value);
  if (!isInside(binding.stateRoot, resolved)) {
    throw new Error("qualification Git " + label + " escaped the private task root");
  }
  return resolved;
}
function requirePrivateTaskCommand(arguments_, effectiveCwd) {
  const { command, rest } = commandAfterGlobalOptions(arguments_);
  if (command === "init") {
    if (
      rest.some(
        (argument) =>
          argument !== "--quiet" &&
          argument !== "-q" &&
          argument !== "--initial-branch=main" &&
          argument !== "-bmain"
      )
    ) {
      throw new Error("qualification Git init is restricted to the current private repository");
    }
    return;
  }
  if (command === "config") {
    if (
      rest.length !== 3 ||
      rest[0] !== "--local" ||
      !["user.name", "user.email"].includes(rest[1]) ||
      rest[2].length === 0 ||
      rest[2].includes("\0")
    ) {
      throw new Error("qualification Git config is restricted to local private fixture identity");
    }
    return;
  }
  if (command === "add") {
    if (rest.length === 0 || rest.some((argument) => argument.startsWith("-"))) {
      throw new Error("qualification Git add is restricted to private relative paths");
    }
    for (const argument of rest) requirePrivatePathOperand(effectiveCwd, argument, "add operand");
    return;
  }
  if (command === "commit") {
    if (
      rest.length !== 3 ||
      !["--quiet", "-q"].includes(rest[0]) ||
      rest[1] !== "-m" ||
      rest[2].length === 0 ||
      rest[2].includes("\0")
    ) {
      throw new Error("qualification Git commit is restricted to one private fixture message");
    }
    return;
  }
  if (command === "rev-parse") {
    if (rest.length !== 1 || rest[0] !== "HEAD") {
      throw new Error("qualification Git rev-parse is restricted to the private HEAD");
    }
    return;
  }
  if (command === "status") {
    if (
      rest.length !== 2 ||
      rest[0] !== "--porcelain=v1" ||
      rest[1] !== "--untracked-files=all"
    ) {
      throw new Error("qualification Git status is restricted to the private fixture status");
    }
    return;
  }
  if (command === "show") {
    if (
      rest.length !== 3 ||
      rest[0] !== "-s" ||
      rest[1] !== "--format=%an%n%ae%n%cn%n%ce" ||
      rest[2] !== "HEAD"
    ) {
      throw new Error("qualification Git show is restricted to private fixture identity");
    }
    return;
  }
  if (command === "cat-file") {
    if (rest.length !== 2 || rest[0] !== "commit" || rest[1] !== "HEAD") {
      throw new Error("qualification Git cat-file is restricted to the private HEAD commit");
    }
    return;
  }
  if (command === "diff") {
    if (rest.length !== 3 || rest[0] !== "HEAD" || rest[1] !== "--" || rest[2] !== "fixture.txt") {
      throw new Error("qualification Git diff is restricted to the private fixture file");
    }
    return;
  }
  throw new Error("qualification Git command is not allowed inside the private task root");
}
function hardenedAssignedArguments(arguments_) {
  const { command } = commandAfterGlobalOptions(arguments_);
  const commandIndex = arguments_.findIndex((argument, index) => {
    if (index > 0 && arguments_[index - 1] === "-C") return false;
    return argument === command;
  });
  if (commandIndex < 0) throw new Error("qualification Git command is missing");
  const hardened = [...arguments_];
  if (["diff", "diff-index", "diff-tree", "log", "show"].includes(command)) {
    hardened.splice(commandIndex + 1, 0, "--no-ext-diff", "--no-textconv");
  }
  return [
    ...binding.safeConfigArguments,
    "--git-dir",
    binding.gitDirectory,
    "--work-tree",
    binding.worktree,
    ...hardened
  ];
}
let privateGitOwner = null;
let privateGitPointer = null;
function hardenedPrivateArguments(arguments_, effectiveCwd) {
  const { command, rest } = commandAfterGlobalOptions(arguments_);
  privateGitOwner = privateGitDirectory(effectiveCwd);
  privateGitPointer = resolve(effectiveCwd, ".git");
  if (command === "init") {
    try {
      lstatSync(privateGitPointer);
      throw new Error("qualification Git init cannot reuse an existing metadata owner");
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    try {
      lstatSync(privateGitOwner);
      throw new Error("qualification Git init cannot reuse runner-owned metadata");
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    return [
      ...binding.safeConfigArguments,
      command,
      "--separate-git-dir=" + privateGitOwner,
      ...rest
    ];
  }
  validatePrivateGitAdmin(privateGitOwner, privateGitPointer);
  const hardenedRest = command === "diff" ? ["--no-ext-diff", "--no-textconv", ...rest] : rest;
  return [
    ...binding.safeConfigArguments,
    "--git-dir",
    privateGitOwner,
    "--work-tree",
    effectiveCwd,
    command,
    ...hardenedRest
  ];
}
const environment = { ...process.env };
for (const key of Object.keys(environment)) {
  const upper = key.toUpperCase();
  if (upper === "EMAIL" || upper.startsWith("GIT_")) delete environment[key];
}
environment.GIT_OPTIONAL_LOCKS = "0";
environment.GIT_NO_REPLACE_OBJECTS = "1";
environment.GIT_PAGER = "";
environment.GIT_TERMINAL_PROMPT = "0";
environment.PAGER = "";
const cwd = realpathSync.native(process.cwd());
const arguments_ = process.argv.slice(2);
validateGlobalOptions(arguments_);
const effectiveCwd = effectiveWorkingDirectory(cwd, arguments_);
const usesAssignedWorktree = isInside(binding.worktree, effectiveCwd);
if (!usesAssignedWorktree && !isInside(binding.stateRoot, effectiveCwd)) {
  throw new Error("unbound qualification Git is permitted only inside the private task root");
}
if (usesAssignedWorktree) requireReadOnlyAssignedCommand(arguments_);
else requirePrivateTaskCommand(arguments_, effectiveCwd);
if (usesAssignedWorktree) {
  Object.assign(environment, binding.configSelectionEnvironment);
} else {
  const disabledConfig = binding.platform === "win32" ? "NUL" : "/dev/null";
  environment.GIT_ATTR_NOSYSTEM = "1";
  environment.GIT_CONFIG_GLOBAL = disabledConfig;
  environment.GIT_CONFIG_NOSYSTEM = "1";
  environment.GIT_CONFIG_SYSTEM = disabledConfig;
  environment.HOME = binding.privateHome;
  environment.USERPROFILE = binding.privateHome;
  environment.XDG_CONFIG_HOME = binding.privateXdgConfig;
}
const commandArguments = usesAssignedWorktree
  ? hardenedAssignedArguments(arguments_)
  : hardenedPrivateArguments(arguments_, effectiveCwd);
function verifyOpenedExecutable(handle) {
  const value = fstatSync(handle, { bigint: true });
  if (!value.isFile() || value.nlink !== 1n || value.size !== BigInt(binding.gitExecutableSize)) {
    throw new Error("qualification Git executable snapshot identity is invalid");
  }
  const digest = createHash("sha256");
  const buffer = Buffer.alloc(64 * 1024);
  let offset = 0;
  while (offset < binding.gitExecutableSize) {
    const bytesRead = readSync(handle, buffer, 0, Math.min(buffer.length, binding.gitExecutableSize - offset), offset);
    if (bytesRead <= 0) throw new Error("qualification Git executable snapshot ended during verification");
    digest.update(buffer.subarray(0, bytesRead));
    offset += bytesRead;
  }
  if (digest.digest("hex") !== binding.gitExecutableSha256) {
    throw new Error("qualification Git executable snapshot bytes changed");
  }
}
let result;
if (binding.platform === "win32") {
  const pathBase64 = Buffer.from(binding.gitExecutable, "utf8").toString("base64");
  const argumentsBase64 = Buffer.from(JSON.stringify(commandArguments), "utf8").toString("base64");
  const source = [
    '$ErrorActionPreference="Stop"',
    '$ProgressPreference="SilentlyContinue"',
    '$path=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String("' + pathBase64 + '"))',
    '$arguments=@(ConvertFrom-Json ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String("' + argumentsBase64 + '"))))',
    '$stream=[IO.File]::Open($path,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)',
    'try{',
    'if($stream.Length -ne ' + String(binding.gitExecutableSize) + '){throw "git-size"}',
    '$hasher=[Security.Cryptography.SHA256]::Create()',
    'try{$actual=[BitConverter]::ToString($hasher.ComputeHash($stream)).Replace("-","").ToLowerInvariant()}finally{$hasher.Dispose()}',
    'if(-not [String]::Equals($actual,"' + binding.gitExecutableSha256 + '",[StringComparison]::Ordinal)){throw "git-digest"}',
    '& $path @arguments',
    '$status=$LASTEXITCODE',
    '}finally{$stream.Dispose()}',
    'exit $status'
  ].join("\\n");
  const encoded = Buffer.from(source, "utf16le").toString("base64");
  result = spawnSync(binding.windowsPowerShell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded], {
    cwd: effectiveCwd,
    env: environment,
    stdio: "inherit",
    windowsHide: true
  });
} else {
  const handle = openSync(binding.gitExecutable, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    verifyOpenedExecutable(handle);
    result = spawnSync("/proc/self/fd/3", commandArguments, {
      argv0: binding.gitExecutable,
      cwd: effectiveCwd,
      env: environment,
      stdio: ["inherit", "inherit", "inherit", handle],
      windowsHide: true
    });
  } finally {
    closeSync(handle);
  }
}
if (result.error) throw result.error;
if (privateGitOwner !== null) validatePrivateGitAdmin(privateGitOwner, privateGitPointer);
process.exitCode = result.status ?? 1;
`;
}

async function prepareGitWrapper(layoutState, assignment, configSelectionEnvironment, options = {}) {
  const executable = await openPinnedExecutable(assignment.gitExecutable);
  try {
    layoutState.gitExecutableLaunch = await createExecutableSnapshot(
      executable,
      layoutState.layout.executableSnapshots,
      {
        afterWriteForTest: options.afterGitExecutableSnapshotWriteForTest
      }
    );
  } catch (error) {
    await finishWithOwnedCleanup(error, [
      { label: "private Git executable source", run: () => closePinnedExecutable(executable) }
    ]);
  }
  const windowsPowerShell =
    process.platform === "win32"
      ? await realpath(
          join(windowsSystemRootCandidate(process.execPath), "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
        )
      : null;
  const programBytes = gitWrapperProgramSource(
    assignment,
    configSelectionEnvironment,
    layoutState.gitExecutableLaunch,
    windowsPowerShell
  );
  await writeFile(layoutState.layout.gitWrapperProgram, programBytes, { flag: "wx", mode: 0o500 });
  if (process.platform === "win32") {
    await writeFile(
      layoutState.layout.gitWrapper,
      `@echo off\r\n"${process.execPath}" "${layoutState.layout.gitWrapperProgram}" %*\r\n`,
      { flag: "wx", mode: 0o500 }
    );
  } else {
    await writeFile(
      layoutState.layout.gitWrapper,
      `#!/bin/sh\nexec ${quotePytestPath(process.execPath)} ${quotePytestPath(layoutState.layout.gitWrapperProgram)} "$@"\n`,
      { flag: "wx", mode: 0o500 }
    );
    await chmod(layoutState.layout.gitWrapper, 0o500);
    await chmod(layoutState.layout.gitWrapperProgram, 0o500);
  }
  for (const [path, label] of [
    [layoutState.layout.gitWrapper, "private Git launcher"],
    [layoutState.layout.gitWrapperProgram, "private Git launcher program"]
  ]) {
    const pin = await openPinnedRegularFile(path, MAX_ASSIGNMENT_BYTES, label);
    layoutState.runnerFilePins.push({ label, pin });
    layoutState.identities[label === "private Git launcher" ? "gitWrapper" : "gitWrapperProgram"] = await fileIdentity(
      path,
      "file"
    );
  }
}

function windowsSystemRootCandidate(nodeExecutable) {
  const root = windowsPath.parse(nodeExecutable).root;
  if (!root) fail("the Node executable does not identify a Windows installation drive");
  return windowsPath.join(root, "Windows");
}

async function trustedToolDirectories(assignment) {
  const candidates = [dirname(assignment.gitExecutable), dirname(process.execPath)];
  let windowsCommandProcessor = null;
  let windowsSupervisorCommand = null;
  let windowsSystemRoot = null;
  if (process.platform === "win32") {
    windowsSystemRoot = await realpath(windowsSystemRootCandidate(process.execPath));
    const system32 = await realpath(join(windowsSystemRoot, "System32"));
    const powerShellDirectory = await realpath(join(system32, "WindowsPowerShell", "v1.0"));
    windowsCommandProcessor = await realpath(join(system32, "cmd.exe"));
    windowsSupervisorCommand = await realpath(join(powerShellDirectory, "powershell.exe"));
    candidates.push(system32, powerShellDirectory);
  } else {
    candidates.push("/usr/bin", "/bin");
  }
  const directories = [];
  const pins = [];
  try {
    for (const candidate of candidates) {
      const canonical = await realpath(candidate);
      if (directories.includes(canonical)) continue;
      pins.push(await openPinnedDirectory(canonical, `trusted tool directory ${String(pins.length)}`));
      directories.push(canonical);
    }
  } catch (error) {
    await finishWithOwnedCleanup(
      error,
      pins.map((pin, index) => ({ label: `trusted tool directory ${String(index)}`, run: () => pin.handle.close() }))
    );
  }
  return { directories, pins, windowsCommandProcessor, windowsSupervisorCommand, windowsSystemRoot };
}

function isolatedEnvironment(assignmentFile, assignment, layout, hostEnvironment) {
  const environment = {};
  for (const key of SAFE_PASSTHROUGH_ENVIRONMENT_KEYS) {
    const value = hostEnvironment[key];
    if (value !== undefined) {
      environment[key] = value;
    }
  }
  for (const [key, layoutKey] of Object.entries(PRIVATE_DIRECTORY_ENVIRONMENT)) {
    environment[key] = layout[layoutKey];
  }
  for (const [key, layoutKey] of Object.entries(PRIVATE_FILE_ENVIRONMENT)) {
    environment[key] = layout[layoutKey];
  }
  for (const [key, layoutKey] of Object.entries(PINNED_TOOL_FILE_ENVIRONMENT)) {
    environment[key] = layout[layoutKey];
  }
  for (const [key, layoutKey] of Object.entries(WORKTREE_PATH_ENVIRONMENT)) {
    environment[key] = layout[layoutKey];
  }
  Object.assign(environment, EXACT_ENVIRONMENT_VALUES, {
    OPEN_WRANGLER_QUALIFICATION_ASSIGNMENT: assignmentFile,
    OPEN_WRANGLER_QUALIFICATION_ROOT: assignment.stateRoot,
    OPEN_WRANGLER_QUALIFICATION_RUN_ID: assignment.runId,
    OPEN_WRANGLER_QUALIFICATION_TASK_ID: assignment.taskId,
    PATH: `${dirname(layout.pythonExecutable)}${delimiter}${layout.toolPath}`,
    PWD: assignment.worktree,
    PYTEST_ADDOPTS: `-o cache_dir=${quotePytestPath(layout.pytestCache)} --basetemp=${quotePytestPath(layout.pytestTemp)}`,
    npm_config_userconfig: layout.npmUserConfig
  });
  if (process.platform === "win32") {
    environment.COMSPEC = layout.windowsCommandProcessor;
    environment.SYSTEMDRIVE = parse(layout.windowsSystemRoot).root.replace(/[\\/]$/u, "");
    environment.SYSTEMROOT = layout.windowsSystemRoot;
    environment.WINDIR = layout.windowsSystemRoot;
    delete environment.npm_config_cache;
    delete environment.npm_config_prefix;
    delete environment.npm_config_userconfig;
  }
  return environment;
}

function delay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

const SETTLEMENT_UNCERTAIN = Symbol("settlement-uncertain");

async function boundedWait(promise, milliseconds) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((resolveTimeout) => {
        timer = setTimeout(() => resolveTimeout(SETTLEMENT_UNCERTAIN), milliseconds);
      })
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function appendCleanupErrors(target, error) {
  if (error instanceof AggregateError) {
    for (const nested of error.errors) appendCleanupErrors(target, nested);
    return;
  }
  target.push(error instanceof Error ? error : new Error(String(error)));
}

async function collectOwnedCleanup(actions, graceMilliseconds = DEFAULT_TERMINATION_GRACE_MS) {
  const errors = [];
  for (const action of actions) {
    if (!action?.run) continue;
    try {
      const outcome = await boundedWait(Promise.resolve().then(action.run), graceMilliseconds);
      if (outcome === SETTLEMENT_UNCERTAIN) {
        errors.push(new Error(`${action.label} cleanup did not settle within its bound`));
      }
    } catch (error) {
      appendCleanupErrors(errors, error);
    }
  }
  return errors;
}

async function finishWithOwnedCleanup(primaryError, actions, graceMilliseconds = DEFAULT_TERMINATION_GRACE_MS) {
  const cleanupErrors = await collectOwnedCleanup(actions, graceMilliseconds);
  if (primaryError && cleanupErrors.length > 0) {
    throw new AggregateError([primaryError, ...cleanupErrors], "qualification failed and owned cleanup also failed");
  }
  if (primaryError) throw primaryError;
  if (cleanupErrors.length > 0) {
    throw new AggregateError(cleanupErrors, "owned qualification cleanup failed");
  }
}

function validateBound(value, maximum, label) {
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
    fail(`${label} must be a positive safe integer no larger than ${maximum}`);
  }
}

async function openPinnedSymbolicExecutable(path, allowedSymbolicLinkTarget, options) {
  if (!allowedSymbolicLinkTarget) {
    fail("qualification command must not be a symbolic link");
  }
  const target = await openPinnedExecutable(allowedSymbolicLinkTarget, undefined, options);
  try {
    const before = await lstat(path, { bigint: true });
    const linkText = await readlink(path);
    const canonical = await realpath(path);
    const after = await lstat(path, { bigint: true });
    if (
      !before.isSymbolicLink() ||
      !after.isSymbolicLink() ||
      !sameImmutableSnapshot(before, after) ||
      canonical !== allowedSymbolicLinkTarget
    ) {
      fail("qualification command symbolic link changed while it was resolved");
    }
    return { before, linkText, path, symbolicLinkTarget: allowedSymbolicLinkTarget, target };
  } catch (error) {
    await finishWithOwnedCleanup(error, [
      { label: "qualification command symbolic target", run: () => closePinnedExecutable(target) }
    ]);
  }
}

async function openPinnedExecutable(
  path,
  allowedSymbolicLinkTarget,
  { afterOpenForTest, requireExecutable = true } = {}
) {
  assertCanonicalAbsolutePath(path, "qualification command");
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  } catch (error) {
    if (error?.code === "ELOOP") {
      return openPinnedSymbolicExecutable(path, allowedSymbolicLinkTarget, { afterOpenForTest, requireExecutable });
    }
    throw error;
  }
  try {
    const opened = await handle.stat({ bigint: true });
    await afterOpenForTest?.({ handle, path });
    const namedBefore = await lstat(path, { bigint: true });
    if (namedBefore.isSymbolicLink()) {
      await handle.close();
      handle = undefined;
      return openPinnedSymbolicExecutable(path, allowedSymbolicLinkTarget);
    }
    const canonical = await realpath(path);
    const namedAfter = await lstat(path, { bigint: true });
    if (
      !opened.isFile() ||
      opened.nlink !== 1n ||
      (requireExecutable && process.platform !== "win32" && (opened.mode & 0o111n) === 0n) ||
      namedAfter.isSymbolicLink() ||
      !sameImmutableSnapshot(opened, namedBefore) ||
      !sameImmutableSnapshot(namedBefore, namedAfter) ||
      canonical !== path
    ) {
      fail("qualification command changed while it was opened");
    }
    return { before: opened, handle, path };
  } catch (error) {
    await finishWithOwnedCleanup(error, [{ label: "qualification command", run: () => handle?.close() }]);
  }
}

async function verifyPinnedExecutable(value) {
  if (value.target) {
    const current = await lstat(value.path, { bigint: true });
    if (
      !current.isSymbolicLink() ||
      !sameImmutableSnapshot(value.before, current) ||
      (await readlink(value.path)) !== value.linkText ||
      (await realpath(value.path)) !== value.symbolicLinkTarget
    ) {
      fail("qualification command symbolic link changed");
    }
    await verifyPinnedExecutable(value.target);
    return;
  }
  const opened = await value.handle.stat({ bigint: true });
  const named = await lstat(value.path, { bigint: true });
  if (
    named.isSymbolicLink() ||
    !sameImmutableSnapshot(value.before, opened) ||
    !sameImmutableSnapshot(opened, named) ||
    (await realpath(value.path)) !== value.path
  ) {
    fail("qualification command identity changed");
  }
}

async function closePinnedExecutable(value) {
  if (value?.target) {
    await closePinnedExecutable(value.target);
  } else if (value?.handle) {
    await value.handle.close();
  }
}

function executableLeaf(value) {
  return value.target ? executableLeaf(value.target) : value;
}

function executableIdentity(value) {
  return {
    device: value.before.dev.toString(),
    inode: value.before.ino.toString(),
    links: value.before.nlink.toString(),
    mode: Number(value.before.mode & 0o777n),
    path: value.path,
    size: Number(value.before.size)
  };
}

async function hashPinnedExecutable(executable) {
  await verifyPinnedExecutable(executable);
  const leaf = executableLeaf(executable);
  const digest = createHash("sha256");
  const buffer = Buffer.alloc(64 * 1024);
  let offset = 0;
  while (offset < Number(leaf.before.size)) {
    const length = Math.min(buffer.length, Number(leaf.before.size) - offset);
    const { bytesRead } = await leaf.handle.read(buffer, 0, length, offset);
    if (bytesRead <= 0) fail("qualification command snapshot ended while it was rehashed");
    digest.update(buffer.subarray(0, bytesRead));
    offset += bytesRead;
  }
  await verifyPinnedExecutable(executable);
  return digest.digest("hex");
}

async function createExecutableSnapshot(
  executable,
  snapshotRoot,
  { afterWriteForTest, requireExecutable = true } = {}
) {
  await verifyPinnedExecutable(executable);
  const source = executableLeaf(executable);
  if (source.before.size <= 0n || source.before.size > BigInt(MAX_EXECUTABLE_BYTES)) {
    fail("qualification command executable size is invalid");
  }
  const extension = extname(source.path);
  const stateRoot = resolve(snapshotRoot, "../../..");
  const destinationRoot = isInside(executable.path, stateRoot) ? dirname(executable.path) : snapshotRoot;
  const snapshotPath = join(destinationRoot, `${randomUUID()}${extension}`);
  const writer = await open(
    snapshotPath,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0),
    Number(source.before.mode & 0o777n)
  );
  const digest = createHash("sha256");
  const buffer = Buffer.alloc(64 * 1024);
  let offset = 0;
  try {
    await writer.chmod(Number(source.before.mode & 0o777n));
    while (offset < Number(source.before.size)) {
      const length = Math.min(buffer.length, Number(source.before.size) - offset);
      const { bytesRead } = await source.handle.read(buffer, 0, length, offset);
      if (bytesRead <= 0) fail("qualification command ended while its immutable snapshot was created");
      digest.update(buffer.subarray(0, bytesRead));
      let written = 0;
      while (written < bytesRead) {
        const result = await writer.write(buffer, written, bytesRead - written, offset + written);
        if (result.bytesWritten <= 0) fail("qualification command snapshot write made no progress");
        written += result.bytesWritten;
      }
      offset += bytesRead;
    }
    await writer.sync();
    const completed = await writer.stat({ bigint: true });
    if (
      !completed.isFile() ||
      completed.nlink !== 1n ||
      completed.size !== source.before.size ||
      Number(completed.mode & 0o777n) !== Number(source.before.mode & 0o777n)
    ) {
      fail("qualification command snapshot identity is invalid");
    }
  } finally {
    await writer.close();
  }
  const sourceDigest = digest.digest("hex");
  await afterWriteForTest?.({ snapshotPath });
  await verifyPinnedExecutable(executable);
  const snapshot = await openPinnedExecutable(snapshotPath, undefined, { requireExecutable });
  const snapshotLeaf = executableLeaf(snapshot);
  if (snapshotLeaf.before.size !== source.before.size || (await hashPinnedExecutable(snapshot)) !== sourceDigest) {
    await closePinnedExecutable(snapshot);
    fail("qualification command snapshot bytes changed before launch");
  }
  return {
    record: {
      sha256: sourceDigest,
      snapshot: executableIdentity(snapshotLeaf),
      source: executableIdentity(source),
      sourcePath: executable.path
    },
    snapshot,
    source: executable
  };
}

async function verifyExecutableLaunch(value) {
  await verifyPinnedExecutable(value.source);
  await verifyPinnedExecutable(value.snapshot);
}

async function closeExecutableLaunch(value) {
  if (!value) return;
  await finishWithOwnedCleanup(null, [
    { label: "qualification command snapshot", run: () => closePinnedExecutable(value.snapshot) },
    { label: "qualification command source", run: () => closePinnedExecutable(value.source) }
  ]);
}

function waitForSpawnedProcess(child) {
  return new Promise((resolveResult) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolveResult(value);
    };
    child.once("error", (error) => finish({ error }));
    child.once("exit", (status, signal) => finish({ signal, status }));
  });
}

async function terminateAndAwaitProcess(child, completion, graceMilliseconds) {
  child.stdin?.destroy();
  child.kill("SIGTERM");
  const graceful = await boundedWait(completion, graceMilliseconds);
  if (graceful !== SETTLEMENT_UNCERTAIN) return graceful;
  child.kill("SIGKILL");
  const forced = await boundedWait(completion, graceMilliseconds);
  return forced === SETTLEMENT_UNCERTAIN ? null : forced;
}

function readPosixSupervisorControl(stream) {
  return new Promise((resolveControl) => {
    const chunks = [];
    let length = 0;
    let failed = false;
    stream.on("data", (chunk) => {
      length += chunk.length;
      if (length > 64 * 1024) {
        failed = true;
        stream.destroy();
        return;
      }
      chunks.push(Buffer.from(chunk));
    });
    stream.once("error", () => resolveControl(null));
    stream.once("end", () => {
      if (failed) {
        resolveControl(null);
        return;
      }
      try {
        const text = Buffer.concat(chunks).toString("utf8");
        if (!text.endsWith("\n") || text.indexOf("\n") !== text.length - 1) {
          resolveControl(null);
          return;
        }
        const value = JSON.parse(text);
        resolveControl(value && typeof value === "object" && !Array.isArray(value) ? value : null);
      } catch {
        resolveControl(null);
      }
    });
  });
}

async function runPosixOwnedCommand(command, arguments_, options) {
  if ((options.platformForTest ?? process.platform) !== "linux") {
    return {
      lingeringDescendants: false,
      signal: null,
      spawnError: "POSIX detached-process containment requires Linux subreaper support",
      status: null,
      timedOut: false,
      treeEmpty: true
    };
  }
  let child;
  await options.beforeSpawnForTest?.({
    executedPath: command,
    sourcePath: options.sourceCommand,
    strategy: options.executionStrategy
  });
  try {
    await options.verifyExecutableForSpawn();
    child = spawn(
      options.supervisorExecutedPath,
      [
        "-I",
        "-c",
        options.posixSupervisorSourceForTest ?? POSIX_SUBREAPER_SOURCE,
        JSON.stringify(arguments_),
        options.launchArgv0,
        String(options.timeoutMs),
        String(options.terminationGraceMs)
      ],
      {
        cwd: options.cwd,
        detached: true,
        env: options.environment,
        shell: false,
        stdio: ["inherit", "inherit", "inherit", options.supervisorExecutableFd, options.targetExecutableFd, "pipe"],
        windowsHide: true
      }
    );
  } catch (error) {
    let callbackError;
    try {
      await options.afterSpawnForTest?.({
        child: undefined,
        executedPath: command,
        sourcePath: options.sourceCommand,
        strategy: options.executionStrategy
      });
    } catch (afterError) {
      callbackError = afterError;
    }
    return {
      lingeringDescendants: false,
      signal: null,
      spawnError:
        callbackError instanceof Error
          ? callbackError.message
          : callbackError
            ? String(callbackError)
            : error instanceof Error
              ? error.message
              : String(error),
      status: null,
      timedOut: false,
      treeEmpty: true
    };
  }
  const completion = waitForSpawnedProcess(child);
  try {
    await options.afterSpawnForTest?.({
      child,
      executedPath: command,
      sourcePath: options.sourceCommand,
      strategy: options.executionStrategy
    });
  } catch (error) {
    const settlement = await terminateAndAwaitProcess(child, completion, 5 * options.terminationGraceMs);
    return {
      lingeringDescendants: false,
      signal: null,
      spawnError:
        settlement === null
          ? `${error instanceof Error ? error.message : String(error)}; POSIX supervisor did not settle after forced termination`
          : error instanceof Error
            ? error.message
            : String(error),
      status: null,
      timedOut: false,
      treeEmpty: false
    };
  }
  const controlStream = options.posixMissingControlPipeForTest ? null : child.stdio[5];
  if (!controlStream) {
    const settlement = await terminateAndAwaitProcess(child, completion, 5 * options.terminationGraceMs);
    return {
      lingeringDescendants: false,
      signal: null,
      spawnError:
        settlement === null
          ? "POSIX containment supervisor control pipe is unavailable and forced termination did not settle"
          : "POSIX containment supervisor control pipe is unavailable",
      status: null,
      timedOut: false,
      treeEmpty: false
    };
  }
  const control = readPosixSupervisorControl(controlStream);
  let timer;
  const outcome = await Promise.race([
    completion,
    new Promise((resolveTimeout) => {
      timer = setTimeout(
        () => resolveTimeout({ timedOut: true }),
        options.posixOuterSettlementMsForTest ?? options.timeoutMs + 5 * options.terminationGraceMs + 5_000
      );
    })
  ]);
  clearTimeout(timer);
  if (outcome.timedOut === true) {
    const settlement = await terminateAndAwaitProcess(child, completion, 5 * options.terminationGraceMs);
    const boundedControl = await boundedWait(control, 5 * options.terminationGraceMs);
    const reported = boundedControl === SETTLEMENT_UNCERTAIN ? null : boundedControl;
    return {
      lingeringDescendants: reported?.lingeringDescendants === true,
      signal: settlement?.signal ?? null,
      spawnError:
        settlement === null
          ? "POSIX containment supervisor exceeded its bounded settlement and did not settle after forced termination"
          : "POSIX containment supervisor exceeded its bounded settlement",
      status: null,
      timedOut: true,
      treeEmpty: settlement !== null && reported?.treeEmpty === true
    };
  }
  const boundedControl = await boundedWait(control, 5 * options.terminationGraceMs);
  const reported = boundedControl === SETTLEMENT_UNCERTAIN ? null : boundedControl;
  if (outcome.error || outcome.status !== 0 || outcome.signal !== null || !reported) {
    return {
      lingeringDescendants: false,
      signal: null,
      spawnError: outcome.error
        ? outcome.error instanceof Error
          ? outcome.error.message
          : String(outcome.error)
        : "POSIX containment supervisor did not publish one valid terminal result",
      status: null,
      timedOut: false,
      treeEmpty: false
    };
  }
  return {
    lingeringDescendants: reported.lingeringDescendants === true,
    signal: typeof reported.signal === "string" ? reported.signal : null,
    spawnError: typeof reported.spawnError === "string" ? reported.spawnError : null,
    status: Number.isInteger(reported.status) ? reported.status : null,
    timedOut: reported.timedOut === true,
    treeEmpty: reported.treeEmpty === true
  };
}

function windowsSupervisorSignals(stream, loadedToken, attestationToken) {
  const markers = [
    { bytes: Buffer.from(`${WINDOWS_JOB_LOADED_PREFIX}${loadedToken}\r\n`, "ascii"), count: 0, kind: "loaded" },
    {
      bytes: Buffer.from(`${WINDOWS_JOB_ATTESTATION_PREFIX}${attestationToken}\n`, "ascii"),
      count: 0,
      kind: "attested"
    }
  ];
  const maximumMarkerBytes = Math.max(...markers.map((marker) => marker.bytes.length));
  let pending = Buffer.alloc(0);
  let resolveLoaded;
  let loadedSettled = false;
  const loaded = new Promise((resolve) => {
    resolveLoaded = resolve;
  });
  const completed = new Promise((resolveSignals) => {
    stream.on("data", (chunk) => {
      let combined = pending.length === 0 ? Buffer.from(chunk) : Buffer.concat([pending, chunk]);
      while (true) {
        const matches = markers
          .map((marker) => ({ marker, offset: combined.indexOf(marker.bytes) }))
          .filter(({ offset }) => offset >= 0)
          .sort((left, right) => left.offset - right.offset);
        if (matches.length === 0) break;
        const { marker, offset } = matches[0];
        if (offset > 0) process.stderr.write(combined.subarray(0, offset));
        marker.count += 1;
        if (marker.kind === "loaded" && marker.count === 1 && !loadedSettled) {
          loadedSettled = true;
          resolveLoaded(true);
        }
        combined = combined.subarray(offset + marker.bytes.length);
      }
      const retained = Math.min(combined.length, maximumMarkerBytes - 1);
      const published = combined.length - retained;
      if (published > 0) process.stderr.write(combined.subarray(0, published));
      pending = Buffer.from(combined.subarray(published));
    });
    stream.once("error", () => {
      if (!loadedSettled) {
        loadedSettled = true;
        resolveLoaded(false);
      }
      resolveSignals({ attested: false, loaded: false });
    });
    stream.once("end", () => {
      if (pending.length > 0) process.stderr.write(pending);
      if (!loadedSettled) {
        loadedSettled = true;
        resolveLoaded(false);
      }
      resolveSignals({
        attested: markers.find((marker) => marker.kind === "attested").count === 1,
        loaded: markers.find((marker) => marker.kind === "loaded").count === 1
      });
    });
  });
  return { completed, loaded };
}

function windowsSupervisorLoader(scriptPath, scriptRecord, loadControlToken, loadedToken) {
  if (
    !isAbsolute(scriptPath) ||
    !scriptRecord ||
    !scriptRecord.snapshot ||
    !Number.isSafeInteger(scriptRecord.snapshot.size) ||
    scriptRecord.snapshot.size <= 0 ||
    typeof scriptRecord.sha256 !== "string" ||
    !/^[0-9a-f]{64}$/u.test(scriptRecord.sha256) ||
    !TOKEN_PATTERN.test(loadControlToken) ||
    !TOKEN_PATTERN.test(loadedToken)
  ) {
    fail("Windows Job Object loader identity is invalid");
  }
  const pathBase64 = Buffer.from(scriptPath, "utf8").toString("base64");
  const source = [
    '$ErrorActionPreference="Stop"',
    '$ProgressPreference="SilentlyContinue"',
    `$expectedControl="${WINDOWS_JOB_LOAD_CONTROL_PREFIX}${loadControlToken}"`,
    "$actualControl=[Console]::In.ReadLine()",
    'if(-not [String]::Equals($actualControl,$expectedControl,[StringComparison]::Ordinal)){throw "load-control"}',
    `$path=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String("${pathBase64}"))`,
    "$stream=[IO.File]::Open($path,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)",
    "try{",
    `if($stream.Length -ne ${scriptRecord.snapshot.size}){throw "script-size"}`,
    "$hasher=[Security.Cryptography.SHA256]::Create()",
    'try{$actual=[BitConverter]::ToString($hasher.ComputeHash($stream)).Replace("-","").ToLowerInvariant()}finally{$hasher.Dispose()}',
    `if(-not [String]::Equals($actual,"${scriptRecord.sha256}",[StringComparison]::Ordinal)){throw "script-digest"}`,
    "$stream.Position=0",
    "$encoding=[Text.UTF8Encoding]::new($false,$true)",
    "$reader=[IO.StreamReader]::new($stream,$encoding,$false,4096,$true)",
    "try{$script=$reader.ReadToEnd()}finally{$reader.Dispose()}",
    "$block=[ScriptBlock]::Create($script)",
    `[Console]::Error.WriteLine("${WINDOWS_JOB_LOADED_PREFIX}${loadedToken}")`,
    "& $block",
    "}finally{$stream.Dispose()}"
  ].join("\n");
  const encoded = Buffer.from(source, "utf16le").toString("base64");
  if (encoded.length === 0 || encoded.length > 24_000) fail("Windows Job Object loader is too large");
  return encoded;
}

async function runWindowsOwnedCommand(command, arguments_, options) {
  await options.beforeSpawnForTest?.({
    executedPath: command,
    sourcePath: options.sourceCommand,
    supervisorScriptExecutedPath: options.supervisorScriptExecutedPath,
    supervisorScriptSourcePath: options.supervisorScriptSourcePath,
    strategy: options.executionStrategy
  });
  try {
    await options.verifyExecutableForSpawn();
  } catch (error) {
    return {
      lingeringDescendants: false,
      signal: null,
      spawnError: error instanceof Error ? error.message : String(error),
      status: null,
      timedOut: false,
      treeEmpty: true
    };
  }
  if (!options.supervisorExecutedPath || !isAbsolute(options.supervisorExecutedPath)) {
    return {
      lingeringDescendants: false,
      signal: null,
      spawnError: "Windows process ownership requires a pinned supervisor executable",
      status: null,
      timedOut: false,
      treeEmpty: true
    };
  }
  if (!options.supervisorScriptExecutedPath || !isAbsolute(options.supervisorScriptExecutedPath)) {
    return {
      lingeringDescendants: false,
      signal: null,
      spawnError: "Windows process ownership requires a pinned Job Object script",
      status: null,
      timedOut: false,
      treeEmpty: true
    };
  }
  let supervisor;
  const attestationToken = randomUUID();
  const loadControlToken = randomUUID();
  const loadedToken = randomUUID();
  let encodedLoader;
  try {
    encodedLoader = windowsSupervisorLoader(
      options.supervisorScriptExecutedPath,
      options.supervisorScriptRecord,
      loadControlToken,
      loadedToken
    );
    supervisor = spawn(
      options.supervisorExecutedPath,
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encodedLoader],
      {
        cwd: options.cwd,
        detached: false,
        env: options.environment,
        shell: false,
        stdio: ["pipe", "inherit", "pipe"],
        windowsHide: true
      }
    );
  } catch (error) {
    return {
      lingeringDescendants: false,
      signal: null,
      spawnError: error instanceof Error ? error.message : String(error),
      status: null,
      timedOut: false,
      treeEmpty: true
    };
  }
  const completion = waitForSpawnedProcess(supervisor);
  try {
    await options.afterSpawnForTest?.({
      child: supervisor,
      executedPath: command,
      sourcePath: options.sourceCommand,
      supervisorScriptExecutedPath: options.supervisorScriptExecutedPath,
      supervisorScriptSourcePath: options.supervisorScriptSourcePath,
      strategy: options.executionStrategy
    });
  } catch (error) {
    const settlement = await terminateAndAwaitProcess(supervisor, completion, options.terminationGraceMs);
    return {
      lingeringDescendants: false,
      signal: null,
      spawnError:
        settlement === null
          ? `${error instanceof Error ? error.message : String(error)}; Windows supervisor did not settle after forced termination`
          : error instanceof Error
            ? error.message
            : String(error),
      status: null,
      timedOut: false,
      treeEmpty: false
    };
  }
  const controlPipesAvailable =
    !options.windowsMissingControlPipeForTest && supervisor.stdin !== null && supervisor.stderr !== null;
  if (!controlPipesAvailable) {
    const settlement = await terminateAndAwaitProcess(supervisor, completion, options.terminationGraceMs);
    return {
      lingeringDescendants: false,
      signal: null,
      spawnError:
        settlement === null
          ? "Windows Job Object supervisor pipes are unavailable and forced termination did not settle"
          : "Windows Job Object supervisor pipes are unavailable",
      status: null,
      timedOut: false,
      treeEmpty: false
    };
  }
  const signals = windowsSupervisorSignals(supervisor.stderr, loadedToken, attestationToken);
  let controlError;
  supervisor.stdin.on("error", (error) => {
    controlError ??= error;
  });
  try {
    await options.verifyExecutableForSpawn();
  } catch (error) {
    const settlement = await terminateAndAwaitProcess(supervisor, completion, options.terminationGraceMs);
    return {
      lingeringDescendants: false,
      signal: null,
      spawnError:
        settlement === null
          ? `${error instanceof Error ? error.message : String(error)}; Windows supervisor did not settle after forced termination`
          : error instanceof Error
            ? error.message
            : String(error),
      status: null,
      timedOut: false,
      treeEmpty: false
    };
  }
  try {
    await options.beforeWindowsLoaderReleaseForTest?.({
      executedPath: command,
      sourcePath: options.sourceCommand,
      supervisorScriptExecutedPath: options.supervisorScriptExecutedPath,
      supervisorScriptSourcePath: options.supervisorScriptSourcePath,
      strategy: options.executionStrategy
    });
  } catch (error) {
    const settlement = await terminateAndAwaitProcess(supervisor, completion, options.terminationGraceMs);
    return {
      lingeringDescendants: false,
      signal: null,
      spawnError:
        settlement === null
          ? `${error instanceof Error ? error.message : String(error)}; Windows supervisor did not settle after forced termination`
          : error instanceof Error
            ? error.message
            : String(error),
      status: null,
      timedOut: false,
      treeEmpty: false
    };
  }
  supervisor.stdin.write(`${WINDOWS_JOB_LOAD_CONTROL_PREFIX}${loadControlToken}\n`, "ascii", (error) => {
    controlError ??= error;
  });
  const loaded = await Promise.race([
    signals.loaded,
    completion.then(() => false),
    delay(Math.min(options.timeoutMs, 30_000)).then(() => false)
  ]);
  if (!loaded) {
    const settlement = await terminateAndAwaitProcess(supervisor, completion, options.terminationGraceMs);
    return {
      lingeringDescendants: false,
      signal: null,
      spawnError:
        settlement === null
          ? "Windows Job Object supervisor did not bind its pinned script before launch and did not settle after forced termination"
          : "Windows Job Object supervisor did not bind its pinned script before launch",
      status: null,
      timedOut: false,
      treeEmpty: false
    };
  }
  try {
    await options.verifyExecutableForSpawn();
  } catch (error) {
    const settlement = await terminateAndAwaitProcess(supervisor, completion, options.terminationGraceMs);
    return {
      lingeringDescendants: false,
      signal: null,
      spawnError:
        settlement === null
          ? `${error instanceof Error ? error.message : String(error)}; Windows supervisor did not settle after forced termination`
          : error instanceof Error
            ? error.message
            : String(error),
      status: null,
      timedOut: false,
      treeEmpty: false
    };
  }
  supervisor.stdin.write(
    `${JSON.stringify({
      args: arguments_,
      attestationToken,
      command: "launch",
      cwd: options.cwd,
      environment: options.environment,
      executable: command,
      protocol: 1
    })}\n`,
    "utf8",
    (error) => {
      controlError ??= error;
    }
  );
  let timer;
  const outcome = await Promise.race([
    completion,
    new Promise((resolveTimeout) => {
      timer = setTimeout(() => resolveTimeout({ timedOut: true }), options.timeoutMs);
    })
  ]);
  clearTimeout(timer);
  let finalOutcome = outcome;
  if (outcome.timedOut === true) {
    supervisor.stdin.write('{"protocol":1,"command":"terminate"}\n', "utf8", (error) => {
      controlError ??= error;
    });
    const graceful = await boundedWait(completion, options.terminationGraceMs);
    if (graceful === SETTLEMENT_UNCERTAIN) {
      finalOutcome = await terminateAndAwaitProcess(supervisor, completion, options.terminationGraceMs);
    } else {
      finalOutcome = graceful;
    }
  }
  supervisor.stdin.destroy();
  const boundedSignals = await boundedWait(signals.completed, options.terminationGraceMs);
  const signalResult = boundedSignals === SETTLEMENT_UNCERTAIN ? null : boundedSignals;
  const treeEmpty = finalOutcome !== null && signalResult?.loaded === true && signalResult.attested === true;
  return {
    lingeringDescendants: false,
    signal: finalOutcome?.signal ?? null,
    spawnError: controlError
      ? controlError instanceof Error
        ? controlError.message
        : String(controlError)
      : finalOutcome === null
        ? "Windows supervisor did not settle after forced termination"
        : signalResult === null
          ? "Windows supervisor control stream did not settle within its bound"
          : finalOutcome.error
            ? finalOutcome.error instanceof Error
              ? finalOutcome.error.message
              : String(finalOutcome.error)
            : null,
    status: finalOutcome?.status ?? null,
    timedOut: outcome.timedOut === true,
    treeEmpty
  };
}

async function runOwnedCommand(command, arguments_, options) {
  const platform = options.platformForTest ?? process.platform;
  let executable;
  let launch;
  let supervisorExecutable;
  let supervisorLaunch;
  let supervisorScriptExecutable;
  let supervisorScriptLaunch;
  try {
    executable = await openPinnedExecutable(
      command,
      options.allowedSymbolicLinkTarget,
      options.executableAfterOpenForTest ? { afterOpenForTest: options.executableAfterOpenForTest } : undefined
    );
    launch = await createExecutableSnapshot(executable, options.executableSnapshotRoot, {
      afterWriteForTest: options.executableSnapshotAfterWriteForTest
    });
    if (platform !== "win32") {
      supervisorExecutable = await openPinnedExecutable(options.posixSupervisorCommand);
      supervisorLaunch = await createExecutableSnapshot(supervisorExecutable, options.executableSnapshotRoot);
    } else if (options.windowsSupervisorCommand) {
      supervisorExecutable = await openPinnedExecutable(options.windowsSupervisorCommand);
      supervisorLaunch = await createExecutableSnapshot(supervisorExecutable, options.executableSnapshotRoot);
      supervisorScriptExecutable = await openPinnedExecutable(options.windowsJobSupervisorScript, undefined, {
        requireExecutable: false
      });
      supervisorScriptLaunch = await createExecutableSnapshot(
        supervisorScriptExecutable,
        options.executableSnapshotRoot,
        { requireExecutable: false }
      );
    }
  } catch (error) {
    const cleanupErrors = await collectOwnedCleanup([
      {
        label: "qualification command owner",
        run: () => (launch ? closeExecutableLaunch(launch) : closePinnedExecutable(executable))
      },
      {
        label: "qualification supervisor owner",
        run: () =>
          supervisorLaunch ? closeExecutableLaunch(supervisorLaunch) : closePinnedExecutable(supervisorExecutable)
      },
      {
        label: "qualification supervisor script owner",
        run: () =>
          supervisorScriptLaunch
            ? closeExecutableLaunch(supervisorScriptLaunch)
            : closePinnedExecutable(supervisorScriptExecutable)
      }
    ]);
    const messages = [error instanceof Error ? error.message : String(error), ...cleanupErrors.map(String)];
    return {
      executable: null,
      lingeringDescendants: false,
      signal: null,
      spawnError: messages.join("; "),
      status: null,
      timedOut: false,
      treeEmpty: true
    };
  }
  let primaryError;
  try {
    const executionStrategy = platform === "win32" ? "private-snapshot" : "inherited-descriptor";
    const executedPath = platform === "win32" ? executableLeaf(launch.snapshot).path : "/dev/fd/4";
    const runner = options.ownedRunnerForTest ?? (platform === "win32" ? runWindowsOwnedCommand : runPosixOwnedCommand);
    const result = await runner(executedPath, arguments_, {
      ...options,
      executionStrategy,
      launchArgv0: executableLeaf(launch.snapshot).path,
      platformForTest: platform,
      sourceCommand: command,
      supervisorSourceCommand:
        platform === "win32" && supervisorLaunch ? executableLeaf(supervisorLaunch.source).path : null,
      supervisorExecutedPath:
        platform === "win32" ? (supervisorLaunch ? executableLeaf(supervisorLaunch.snapshot).path : null) : "/dev/fd/3",
      supervisorScriptSourcePath:
        platform === "win32" && supervisorScriptLaunch ? executableLeaf(supervisorScriptLaunch.source).path : null,
      supervisorScriptExecutedPath:
        platform === "win32" && supervisorScriptLaunch ? executableLeaf(supervisorScriptLaunch.snapshot).path : null,
      supervisorScriptRecord: platform === "win32" ? (supervisorScriptLaunch?.record ?? null) : null,
      supervisorExecutableFd: platform === "win32" ? null : executableLeaf(supervisorLaunch.snapshot).handle.fd,
      targetExecutableFd: platform === "win32" ? null : executableLeaf(launch.snapshot).handle.fd,
      verifyExecutableForSpawn: async () => {
        await verifyExecutableLaunch(launch);
        if (supervisorLaunch) await verifyExecutableLaunch(supervisorLaunch);
        if (supervisorScriptLaunch) await verifyExecutableLaunch(supervisorScriptLaunch);
      }
    });
    await options.afterSettlementForTest?.({
      result,
      supervisorScriptExecutedPath:
        platform === "win32" && supervisorScriptLaunch ? executableLeaf(supervisorScriptLaunch.snapshot).path : null,
      supervisorScriptSourcePath:
        platform === "win32" && supervisorScriptLaunch ? executableLeaf(supervisorScriptLaunch.source).path : null
    });
    result.executable = {
      ...launch.record,
      strategy: executionStrategy,
      supervisor: supervisorLaunch
        ? { ...supervisorLaunch.record, jobScript: supervisorScriptLaunch?.record ?? null }
        : null
    };
    if (result.treeEmpty) {
      try {
        await verifyExecutableLaunch(launch);
        if (supervisorLaunch) await verifyExecutableLaunch(supervisorLaunch);
        if (supervisorScriptLaunch) await verifyExecutableLaunch(supervisorScriptLaunch);
      } catch (error) {
        result.spawnError ??= error instanceof Error ? error.message : String(error);
      }
    }
    return result;
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    await finishWithOwnedCleanup(primaryError, [
      { label: "qualification command launch", run: () => closeExecutableLaunch(launch) },
      { label: "qualification supervisor launch", run: () => closeExecutableLaunch(supervisorLaunch) },
      { label: "qualification supervisor script launch", run: () => closeExecutableLaunch(supervisorScriptLaunch) }
    ]);
  }
}

async function captureVenvPythonIdentity(path, bootstrapPython) {
  const value = await lstat(path, { bigint: true });
  if (value.isSymbolicLink()) {
    const target = await realpath(path);
    if (target !== bootstrapPython) {
      fail("task venv Python does not target the pinned bootstrap interpreter");
    }
    return {
      device: value.dev.toString(),
      inode: value.ino.toString(),
      links: value.nlink.toString(),
      mode: Number(value.mode & 0o777n),
      path,
      target,
      type: "symbolic-link"
    };
  }
  if (!value.isFile() || value.nlink !== 1n) {
    fail("task venv Python must be a private regular file or exact bootstrap link");
  }
  return {
    device: value.dev.toString(),
    inode: value.ino.toString(),
    links: value.nlink.toString(),
    mode: Number(value.mode & 0o777n),
    path,
    target: await realpath(path),
    type: "file"
  };
}

async function verifyVenvPythonIdentity(before) {
  const after = await captureVenvPythonIdentity(
    before.path,
    before.type === "symbolic-link" ? before.target : undefined
  );
  if (
    before.device !== after.device ||
    before.inode !== after.inode ||
    before.links !== after.links ||
    before.mode !== after.mode ||
    before.target !== after.target ||
    before.type !== after.type
  ) {
    fail("task venv Python identity changed during qualification");
  }
}

async function digestPinnedPayload(handle, expected, label) {
  const opened = await handle.stat({ bigint: true });
  if (
    !opened.isFile() ||
    opened.size < 0n ||
    opened.size > BigInt(MAX_PYTHON_PAYLOAD_FILE_BYTES) ||
    !sameImmutableSnapshot(expected, opened)
  ) {
    fail(`${label} identity or size is invalid`);
  }
  const hash = createHash("sha256");
  const buffer = Buffer.alloc(64 * 1024);
  let offset = 0;
  while (offset < Number(opened.size)) {
    const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, Number(opened.size) - offset), offset);
    if (bytesRead === 0) fail(`${label} ended before its pinned size`);
    hash.update(buffer.subarray(0, bytesRead));
    offset += bytesRead;
  }
  const completed = await handle.stat({ bigint: true });
  if (!sameImmutableSnapshot(opened, completed)) fail(`${label} changed while it was hashed`);
  return hash.digest("hex");
}

async function openPinnedPythonPayload(value) {
  let handle;
  try {
    handle = await open(value.target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const opened = await handle.stat({ bigint: true });
    const sourceBefore = await lstat(value.path, { bigint: true });
    const targetBefore = await lstat(value.target, { bigint: true });
    if (
      !opened.isFile() ||
      opened.nlink !== 1n ||
      targetBefore.isSymbolicLink() ||
      !sameImmutableSnapshot(opened, targetBefore) ||
      (await realpath(value.path)) !== value.target ||
      (await realpath(value.target)) !== value.target
    ) {
      fail(`Python payload ${value.path} is not one stable regular file`);
    }
    const digest = await digestPinnedPayload(handle, opened, `Python payload ${value.path}`);
    const sourceAfter = await lstat(value.path, { bigint: true });
    const targetAfter = await lstat(value.target, { bigint: true });
    if (
      !sameImmutableSnapshot(sourceBefore, sourceAfter) ||
      !sameImmutableSnapshot(opened, targetAfter) ||
      (await realpath(value.path)) !== value.target
    ) {
      fail(`Python payload ${value.path} changed while it was pinned`);
    }
    return {
      digest,
      handle,
      kind: value.kind,
      path: value.path,
      size: Number(opened.size),
      snapshot: opened,
      sourceSnapshot: sourceBefore,
      target: value.target
    };
  } catch (error) {
    await finishWithOwnedCleanup(error, [{ label: `Python payload ${value.path}`, run: () => handle?.close() }]);
  }
}

async function verifyPinnedPythonPayload(value) {
  const source = await lstat(value.path, { bigint: true });
  const target = await lstat(value.target, { bigint: true });
  if (
    !sameImmutableSnapshot(value.sourceSnapshot, source) ||
    !sameImmutableSnapshot(value.snapshot, target) ||
    (await realpath(value.path)) !== value.target ||
    (await realpath(value.target)) !== value.target ||
    (await digestPinnedPayload(value.handle, value.snapshot, `Python payload ${value.path}`)) !== value.digest
  ) {
    fail(`Python payload ${value.path} changed during qualification`);
  }
}

function validatePythonPayloadSelection(payloads, phase) {
  if (!Array.isArray(payloads) || payloads.length === 0 || payloads.length > MAX_PYTHON_PAYLOAD_FILES) {
    fail(`Python ${phase} payload selection is invalid`);
  }
  const result = [];
  let pathBytes = 0;
  let previousPath = null;
  const kinds = new Set([
    "entry-point",
    "import-archive",
    "native-extension",
    "path-configuration",
    "python-bytecode",
    "python-source",
    "record",
    "script",
    "venv-configuration"
  ]);
  for (const payload of payloads) {
    assertExactKeys(payload, ["kind", "path", "target"], `Python ${phase} payload`);
    if (
      typeof payload.kind !== "string" ||
      !kinds.has(payload.kind) ||
      typeof payload.path !== "string" ||
      !isAbsolute(payload.path) ||
      typeof payload.target !== "string" ||
      !isAbsolute(payload.target)
    ) {
      fail(`Python ${phase} payload selection is invalid`);
    }
    pathBytes += Buffer.byteLength(payload.path, "utf8") + Buffer.byteLength(payload.target, "utf8");
    if (
      pathBytes > MAX_PYTHON_PAYLOAD_PATH_BYTES ||
      (previousPath !== null &&
        Buffer.compare(Buffer.from(payload.path, "utf8"), Buffer.from(previousPath, "utf8")) <= 0)
    ) {
      fail(`Python ${phase} payload selection is ambiguous or oversized`);
    }
    previousPath = payload.path;
    result.push(payload);
  }
  return { pathBytes, values: result };
}

function pythonPayloadSummary(pins, pathBytes) {
  const kinds = {};
  let bytes = 0;
  const records = pins.map((pin) => {
    bytes += pin.size;
    kinds[pin.kind] = (kinds[pin.kind] ?? 0) + 1;
    return {
      kind: pin.kind,
      path: pin.path,
      sha256: pin.digest,
      size: pin.size,
      target: pin.target
    };
  });
  if (bytes > MAX_PYTHON_PAYLOAD_BYTES) fail("Python payload inventory exceeds its byte bound");
  const manifest = Buffer.from(JSON.stringify(records), "utf8");
  if (manifest.length > MAX_PYTHON_PAYLOAD_PATH_BYTES) fail("Python payload manifest exceeds its byte bound");
  return {
    bytes,
    files: pins.length,
    kinds: Object.fromEntries(Object.entries(kinds).sort(([left], [right]) => left.localeCompare(right))),
    pathBytes,
    sha256: sha256(manifest)
  };
}

async function bindPythonPayloads(layoutState, payloads, phase) {
  const selection = validatePythonPayloadSelection(payloads, phase);
  const serialized = JSON.stringify(selection.values);
  if (phase === "after") {
    if (serialized !== layoutState.pythonPayloadSelection) {
      const before = JSON.parse(layoutState.pythonPayloadSelection);
      const maximum = Math.max(before.length, selection.values.length);
      let changed = "count";
      for (let index = 0; index < maximum; index += 1) {
        if (JSON.stringify(before[index]) !== JSON.stringify(selection.values[index])) {
          changed = before[index]?.path ?? selection.values[index]?.path ?? "count";
          break;
        }
      }
      fail(`task Python payload selection changed during qualification at ${changed}`);
    }
    for (const pin of layoutState.pythonPayloadPins) await verifyPinnedPythonPayload(pin);
    return layoutState.pythonPayloadSummary;
  }
  const pins = [];
  try {
    let bytes = 0;
    for (const payload of selection.values) {
      const pin = await openPinnedPythonPayload(payload);
      pins.push(pin);
      bytes += pin.size;
      if (bytes > MAX_PYTHON_PAYLOAD_BYTES) fail("Python payload inventory exceeds its byte bound");
    }
  } catch (error) {
    await finishWithOwnedCleanup(
      error,
      pins.map((pin, index) => ({ label: `Python payload ${String(index)}`, run: () => pin.handle.close() }))
    );
  }
  layoutState.pythonPayloadPins = pins;
  layoutState.pythonPayloadSelection = serialized;
  layoutState.pythonPayloadSummary = pythonPayloadSummary(pins, selection.pathBytes);
  return layoutState.pythonPayloadSummary;
}

async function closePythonPayloadPins(layoutState) {
  await finishWithOwnedCleanup(
    null,
    (layoutState?.pythonPayloadPins ?? []).map((pin, index) => ({
      label: `Python payload ${String(index)}`,
      run: () => pin.handle.close()
    }))
  );
}

class OwnedProcessTreeError extends Error {}

function requireOwnedProcessTree(result, label) {
  if (!result.treeEmpty) {
    throw new OwnedProcessTreeError(`${label} process tree could not be attested empty`);
  }
}

const PYTHON_INVENTORY_SCRIPT = [
  "import importlib.machinery as machinery",
  "import importlib.metadata as metadata",
  "import hashlib",
  "import json",
  "import os",
  "import site",
  "import sys",
  "import sysconfig",
  `MAX_FILES = ${String(MAX_PYTHON_PAYLOAD_FILES)}`,
  `MAX_PATH_BYTES = ${String(MAX_PYTHON_PAYLOAD_PATH_BYTES)}`,
  "payloads = {}",
  "walked_entries = 0",
  "walked_path_bytes = 0",
  "extension_suffixes = tuple(sorted(set(machinery.EXTENSION_SUFFIXES), key=len, reverse=True))",
  "def payload_kind(name, scripts=False):",
  "    if scripts: return 'script'",
  "    if name == 'RECORD': return 'record'",
  "    if name == 'entry_points.txt': return 'entry-point'",
  "    if name.endswith('.pth'): return 'path-configuration'",
  "    if name.endswith(extension_suffixes): return 'native-extension'",
  "    if name.endswith(tuple(machinery.SOURCE_SUFFIXES)): return 'python-source'",
  "    if name.endswith(tuple(machinery.BYTECODE_SUFFIXES)): return 'python-bytecode'",
  "    return None",
  "def add_payload(path, kind):",
  "    global walked_path_bytes",
  "    absolute = os.path.abspath(path)",
  "    target = os.path.realpath(absolute)",
  "    if not os.path.isfile(target): raise RuntimeError('Python payload is not a regular file: ' + absolute)",
  "    walked_path_bytes += len(os.fsencode(absolute)) + len(os.fsencode(target))",
  "    if walked_path_bytes > MAX_PATH_BYTES: raise RuntimeError('Python payload path inventory exceeded its bound')",
  "    payloads[absolute] = {'kind': kind, 'path': absolute, 'target': target}",
  "    if len(payloads) > MAX_FILES: raise RuntimeError('Python payload inventory exceeded its file bound')",
  "def scan_root(root, scripts=False):",
  "    global walked_entries, walked_path_bytes",
  "    for current, directories, files in os.walk(root, topdown=True, followlinks=False):",
  "        directories.sort()",
  "        files.sort()",
  "        walked_entries += len(directories) + len(files)",
  "        walked_path_bytes += sum(len(os.fsencode(os.path.join(current, name))) for name in directories)",
  "        if walked_entries > MAX_FILES * 8 or walked_path_bytes > MAX_PATH_BYTES:",
  "            raise RuntimeError('Python payload discovery exceeded its bound')",
  "        for name in files:",
  "            kind = payload_kind(name, scripts)",
  "            if kind is not None: add_payload(os.path.join(current, name), kind)",
  "roots = []",
  "for value in sys.path:",
  "    if not value: continue",
  "    absolute = os.path.abspath(value)",
  "    if os.path.isdir(absolute): roots.append((absolute, False))",
  "    elif os.path.isfile(absolute): add_payload(absolute, 'import-archive')",
  "for root, scripts in sorted(set(roots)):",
  "    scan_root(root, scripts)",
  "venv_configuration = os.path.join(os.path.realpath(sys.prefix), 'pyvenv.cfg')",
  "if os.path.isfile(venv_configuration): add_payload(venv_configuration, 'venv-configuration')",
  "entry_point_names = set()",
  "packages = []",
  "for distribution in metadata.distributions():",
  "    name = distribution.metadata.get('Name')",
  "    version = distribution.version",
  "    metadata_path = os.path.realpath(str(distribution._path))",
  "    metadata_file = os.path.join(metadata_path, 'METADATA')",
  "    metadata_digest = None",
  "    if os.path.isfile(metadata_file):",
  "        with open(metadata_file, 'rb') as handle:",
  "            metadata_digest = hashlib.file_digest(handle, 'sha256').hexdigest()",
  "    entry_point_names.update(entry.name for entry in distribution.entry_points if entry.name and os.sep not in entry.name and (os.altsep is None or os.altsep not in entry.name))",
  "    packages.append({'location': os.path.realpath(str(distribution.locate_file(''))), 'metadataPath': metadata_path, 'metadataSha256': metadata_digest, 'name': name or '', 'version': version or ''})",
  "packages.sort(key=lambda value: (value['name'].casefold(), value['name'], value['version'], value['metadataPath']))",
  "scripts_root = os.path.abspath(sysconfig.get_path('scripts'))",
  "for name in sorted(entry_point_names):",
  "    for candidate in (name, name + '.exe', name + '-script.py'):",
  "        path = os.path.join(scripts_root, candidate)",
  "        if os.path.isfile(path): add_payload(path, 'script')",
  "payload = {",
  "    'basePrefix': os.path.realpath(sys.base_prefix),",
  "    'cacheTag': sys.implementation.cache_tag,",
  "    'executable': os.path.abspath(sys.executable),",
  "    'executableRealpath': os.path.realpath(sys.executable),",
  "    'isolated': bool(sys.flags.isolated),",
  "    'packages': packages,",
  "    'payloads': sorted(payloads.values(), key=lambda value: (value['path'], value['kind'], value['target'])),",
  "    'prefix': os.path.realpath(sys.prefix),",
  "    'pythonVersion': list(sys.version_info[:3]),",
  "    'sysPath': [os.path.realpath(value) for value in sys.path],",
  "    'userSiteEnabled': bool(site.ENABLE_USER_SITE),",
  "}",
  "with open(sys.argv[1], 'x', encoding='utf-8', newline='\\n') as handle:",
  "    json.dump(payload, handle, ensure_ascii=False, separators=(',', ':'), sort_keys=True)",
  "    handle.write('\\n')"
].join("\n");

async function capturePythonInventory(assignment, layoutState, hostEnvironment, bootstrapPython, phase, options) {
  const inventoryPath = join(layoutState.layout.run, `python-inventory-${phase}.json`);
  await requireAbsentPath(inventoryPath, `Python ${phase} inventory`);
  const environment = isolatedEnvironment(options.assignmentPath, assignment, layoutState.layout, hostEnvironment);
  const result = await runOwnedCommand(
    layoutState.layout.pythonExecutable,
    ["-I", "-c", PYTHON_INVENTORY_SCRIPT, inventoryPath],
    {
      allowedSymbolicLinkTarget:
        layoutState.pythonEntry.type === "symbolic-link" ? layoutState.pythonEntry.target : undefined,
      cwd: assignment.worktree,
      environment,
      executableSnapshotRoot: layoutState.layout.executableSnapshots,
      ownedRunnerForTest: options.ownedRunnerForTest,
      platformForTest: options.platformForTest,
      posixSupervisorCommand: bootstrapPython,
      windowsJobSupervisorScript: options.windowsJobSupervisorScript,
      windowsSupervisorCommand: options.windowsSupervisorCommand ?? layoutState.layout.windowsSupervisorCommand,
      terminationGraceMs: options.terminationGraceMs,
      timeoutMs: 30_000
    }
  );
  requireOwnedProcessTree(result, `task Python ${phase} inventory`);
  const failure = resultFailure(result, `task Python ${phase} inventory`);
  if (failure) fail(failure);
  const pin = await openPinnedRegularFile(inventoryPath, MAX_PYTHON_INVENTORY_BYTES, `Python ${phase} inventory`);
  let inventory;
  let payloadManifest;
  try {
    inventory = JSON.parse(decodeStrictUtf8(pin.bytes, `Python ${phase} inventory`));
    assertExactKeys(
      inventory,
      [
        "basePrefix",
        "cacheTag",
        "executable",
        "executableRealpath",
        "isolated",
        "packages",
        "payloads",
        "prefix",
        "pythonVersion",
        "sysPath",
        "userSiteEnabled"
      ],
      `Python ${phase} inventory`
    );
    if (
      inventory.executable !== result.executable.snapshot.path ||
      inventory.executableRealpath !== result.executable.snapshot.path ||
      inventory.prefix !== (await realpath(layoutState.layout.venv)) ||
      inventory.isolated !== true ||
      inventory.userSiteEnabled !== false ||
      !Array.isArray(inventory.pythonVersion) ||
      inventory.pythonVersion.length !== 3 ||
      !inventory.pythonVersion.every(Number.isSafeInteger) ||
      typeof inventory.cacheTag !== "string" ||
      inventory.cacheTag.length === 0 ||
      !Array.isArray(inventory.sysPath) ||
      !inventory.sysPath.every((value) => typeof value === "string" && isAbsolute(value)) ||
      !Array.isArray(inventory.packages) ||
      !Array.isArray(inventory.payloads)
    ) {
      fail(`Python ${phase} inventory does not bind the private interpreter`);
    }
    for (const package_ of inventory.packages) {
      assertExactKeys(
        package_,
        ["location", "metadataPath", "metadataSha256", "name", "version"],
        `Python ${phase} package`
      );
      if (
        typeof package_.name !== "string" ||
        typeof package_.version !== "string" ||
        typeof package_.location !== "string" ||
        !isAbsolute(package_.location) ||
        typeof package_.metadataPath !== "string" ||
        !isAbsolute(package_.metadataPath) ||
        (package_.metadataSha256 !== null &&
          (typeof package_.metadataSha256 !== "string" || !/^[0-9a-f]{64}$/u.test(package_.metadataSha256)))
      ) {
        fail(`Python ${phase} package inventory is invalid`);
      }
    }
    payloadManifest = await bindPythonPayloads(layoutState, inventory.payloads, phase);
  } catch (error) {
    await finishWithOwnedCleanup(error, [{ label: `Python ${phase} inventory`, run: () => pin.handle.close() }]);
  }
  layoutState.runnerFilePins.push({
    label: `Python ${phase} inventory`,
    maximumBytes: MAX_PYTHON_INVENTORY_BYTES,
    pin
  });
  const normalized = {
    ...inventory,
    executable: layoutState.layout.pythonExecutable,
    executableRealpath: layoutState.pythonEntry.target,
    executableSha256: result.executable.sha256,
    packageInventorySha256: sha256(Buffer.from(JSON.stringify(inventory.packages), "utf8")),
    payloadManifest
  };
  delete normalized.payloads;
  return {
    identity: normalized,
    result
  };
}

function resultFailure(result, label) {
  if (result.spawnError) return `${label} could not start: ${result.spawnError}`;
  if (result.timedOut) return `${label} exceeded its hard timeout`;
  if (!result.treeEmpty) return `${label} process tree could not be attested empty`;
  if (result.lingeringDescendants) return `${label} left descendants after its leader exited`;
  if (result.status !== 0 || result.signal !== null) {
    return result.signal === null
      ? `${label} exited with status ${String(result.status)}`
      : `${label} exited on signal ${result.signal}`;
  }
  return null;
}

async function bootstrapPythonEnvironment(assignmentPath, assignment, layoutState, hostEnvironment, options) {
  const selected = resolveAcceptancePython({
    environment: hostEnvironment,
    platform: process.platform,
    profile: "repository-command",
    repositoryRoot: assignment.worktree
  });
  const bootstrapPython = await realpath(selected);
  assertCanonicalAbsolutePath(bootstrapPython, "bootstrap Python");
  layoutState.layout.pythonToolExecutable = bootstrapPython;
  const trustedTools = await trustedToolDirectories(assignment);
  layoutState.layout.toolDirectories = trustedTools.directories;
  layoutState.layout.toolPath = [layoutState.layout.toolShim, ...trustedTools.directories].join(delimiter);
  layoutState.layout.windowsCommandProcessor = trustedTools.windowsCommandProcessor;
  layoutState.layout.windowsSupervisorCommand = trustedTools.windowsSupervisorCommand;
  layoutState.layout.windowsSystemRoot = trustedTools.windowsSystemRoot;
  for (const [index, pin] of trustedTools.pins.entries()) {
    layoutState.ownerPins[`toolDirectory${String(index)}`] = pin;
  }
  const environment = isolatedEnvironment(assignmentPath, assignment, layoutState.layout, hostEnvironment);
  environment.OPEN_WRANGLER_PYTHON = bootstrapPython;
  environment.OPEN_WRANGLER_TEST_PYTHON = bootstrapPython;
  const creation = await runOwnedCommand(
    bootstrapPython,
    ["-I", "-m", "venv", "--system-site-packages", layoutState.layout.venv],
    {
      cwd: assignment.worktree,
      environment,
      executableSnapshotRoot: layoutState.layout.executableSnapshots,
      ownedRunnerForTest: options.ownedRunnerForTest,
      platformForTest: options.platformForTest,
      posixSupervisorCommand: bootstrapPython,
      windowsJobSupervisorScript: options.windowsJobSupervisorScript,
      windowsSupervisorCommand: options.windowsSupervisorCommand ?? layoutState.layout.windowsSupervisorCommand,
      terminationGraceMs: options.terminationGraceMs,
      timeoutMs: 120_000
    }
  );
  const creationFailure = resultFailure(creation, "task Python venv bootstrap");
  if (creationFailure) return { bootstrapPython, failure: creationFailure, result: creation };
  layoutState.identities.venv = await fileIdentity(layoutState.layout.venv, "directory");
  layoutState.pythonEntry = await captureVenvPythonIdentity(
    layoutState.layout.pythonExecutable,
    creation.executable.snapshot.path
  );
  layoutState.pythonExecutablePin = await openPinnedExecutable(
    layoutState.layout.pythonExecutable,
    layoutState.pythonEntry.type === "symbolic-link" ? layoutState.pythonEntry.target : undefined
  );
  layoutState.layout.pythonToolExecutable = layoutState.layout.pythonExecutable;
  const verificationEnvironment = isolatedEnvironment(assignmentPath, assignment, layoutState.layout, hostEnvironment);
  const verification = await runOwnedCommand(
    layoutState.layout.pythonExecutable,
    [
      "-I",
      "-c",
      "import os,sys; expected=os.path.realpath(sys.argv[1]); raise SystemExit(0 if os.path.realpath(sys.prefix)==expected and os.path.realpath(sys.base_prefix)!=expected else 1)",
      layoutState.layout.venv
    ],
    {
      allowedSymbolicLinkTarget:
        layoutState.pythonEntry.type === "symbolic-link" ? layoutState.pythonEntry.target : undefined,
      cwd: assignment.worktree,
      environment: verificationEnvironment,
      executableSnapshotRoot: layoutState.layout.executableSnapshots,
      ownedRunnerForTest: options.ownedRunnerForTest,
      platformForTest: options.platformForTest,
      posixSupervisorCommand: bootstrapPython,
      windowsJobSupervisorScript: options.windowsJobSupervisorScript,
      windowsSupervisorCommand: options.windowsSupervisorCommand ?? layoutState.layout.windowsSupervisorCommand,
      terminationGraceMs: options.terminationGraceMs,
      timeoutMs: 30_000
    }
  );
  const verificationFailure = resultFailure(verification, "task Python venv verification");
  if (verificationFailure) {
    return { bootstrapPython, failure: verificationFailure, result: creation, verification };
  }
  const inventory = await capturePythonInventory(assignment, layoutState, hostEnvironment, bootstrapPython, "before", {
    ...options,
    assignmentPath
  });
  return {
    bootstrapPython,
    failure: null,
    inventory: inventory.identity,
    inventoryResult: inventory.result,
    result: creation,
    verification
  };
}

async function verifyLayout(layoutState) {
  if (!layoutState.gitExecutableLaunch) fail("private Git executable snapshot was not bound");
  await verifyExecutableLaunch(layoutState.gitExecutableLaunch);
  for (const [key, pin] of Object.entries(layoutState.ownerPins)) {
    await verifyPinnedDirectory(pin, `${key} owner`);
  }
  for (const [key, before] of Object.entries(layoutState.identities)) {
    const path = key === "marker" ? join(dirname(layoutState.layout.home), "assignment.json") : layoutState.layout[key];
    const expectedKind = ["gitWrapper", "gitWrapperProgram", "marker", "npmUserConfig", "pipConfig"].includes(key)
      ? "file"
      : "directory";
    const after = await fileIdentity(path, expectedKind);
    if (!sameIdentity(before, after)) {
      fail(`${key} identity changed during qualification`);
    }
  }
  const stateRootAfter = await fileIdentity(layoutState.layout.stateRoot, "directory");
  if (!sameIdentity(layoutState.stateRootIdentity, stateRootAfter)) {
    fail("stateRoot identity changed during qualification");
  }
  if (layoutState.pythonEntry) {
    await verifyVenvPythonIdentity(layoutState.pythonEntry);
  }
  if (layoutState.pythonExecutablePin) {
    await verifyPinnedExecutable(layoutState.pythonExecutablePin);
  }
  for (const pin of layoutState.pythonPayloadPins ?? []) {
    await verifyPinnedPythonPayload(pin);
  }
  if (layoutState.pytestTempTree) {
    const afterAccounting = await inspectPrivateTree(
      layoutState.ownerPins.pytestTempParent,
      "pytest temporary parent",
      {
        allowedTopLevelName: layoutState.ownerPins.pytestTemp ? parse(layoutState.layout.pytestTemp).base : null,
        ...layoutState.pytestTreeOptions
      }
    );
    if (layoutState.ownerPins.pytestTemp)
      await verifyPinnedDirectory(layoutState.ownerPins.pytestTemp, "pytest basetemp");
    const after = {
      ...afterAccounting,
      basetemp: layoutState.ownerPins.pytestTemp
        ? fileIdentityRecord(layoutState.ownerPins.pytestTemp.path, layoutState.ownerPins.pytestTemp.snapshot)
        : null
    };
    if (JSON.stringify(after) !== JSON.stringify(layoutState.pytestTempTree)) {
      fail("pytest temporary parent changed after it was bound");
    }
  } else {
    fail("pytest temporary parent was not bound");
  }
  for (const { label, maximumBytes = MAX_ASSIGNMENT_BYTES, pin } of layoutState.runnerFilePins) {
    await verifyPinnedRegularFile(pin, maximumBytes, label);
  }
}

async function writeReceiptToHandle(layoutState, receiptHandle, value) {
  const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
  if (bytes.length === 0 || bytes.length > MAX_RECEIPT_BYTES) {
    fail("receipt bytes are invalid");
  }
  const opened = await receiptHandle.stat({ bigint: true });
  const named = await lstat(layoutState.layout.receipt, { bigint: true });
  if (
    !sameImmutableSnapshot(layoutState.receiptSnapshot, opened) ||
    !sameImmutableSnapshot(opened, named) ||
    (await realpath(layoutState.layout.receipt)) !== layoutState.layout.receipt
  ) {
    fail("receipt reservation identity changed before publication");
  }
  let offset = 0;
  while (offset < bytes.length) {
    const { bytesWritten } = await receiptHandle.write(bytes, offset, bytes.length - offset, offset);
    if (bytesWritten === 0) fail("receipt publication made no progress");
    offset += bytesWritten;
  }
  await receiptHandle.sync();
  const completed = await receiptHandle.stat({ bigint: true });
  const finalNamed = await lstat(layoutState.layout.receipt, { bigint: true });
  if (
    completed.dev !== layoutState.receiptSnapshot.dev ||
    completed.ino !== layoutState.receiptSnapshot.ino ||
    completed.mode !== layoutState.receiptSnapshot.mode ||
    completed.nlink !== 1n ||
    completed.size !== BigInt(bytes.length) ||
    finalNamed.isSymbolicLink() ||
    completed.dev !== finalNamed.dev ||
    completed.ino !== finalNamed.ino ||
    completed.size !== finalNamed.size ||
    (await realpath(layoutState.layout.receipt)) !== layoutState.layout.receipt
  ) {
    fail("receipt identity changed during publication");
  }
}

async function writeReceipt(layoutState, value) {
  await writeReceiptToHandle(layoutState, layoutState.receiptHandle, value);
}

async function scrubReceiptReservation(layoutState) {
  const handle = await open(layoutState.layout.receipt, constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0));
  let error;
  try {
    const opened = await handle.stat({ bigint: true });
    const named = await lstat(layoutState.layout.receipt, { bigint: true });
    if (
      !opened.isFile() ||
      opened.nlink !== 1n ||
      named.isSymbolicLink() ||
      opened.dev !== layoutState.receiptSnapshot.dev ||
      opened.ino !== layoutState.receiptSnapshot.ino ||
      opened.dev !== named.dev ||
      opened.ino !== named.ino ||
      (await realpath(layoutState.layout.receipt)) !== layoutState.layout.receipt
    ) {
      fail("receipt reservation identity changed before scrub");
    }
    await handle.truncate(0);
    await handle.sync();
  } catch (value) {
    error = value;
  }
  await finishWithOwnedCleanup(error, [{ label: "receipt scrub owner", run: () => handle.close() }]);
}

async function publishEligibleReceipt(layoutState, value) {
  let handle;
  let publicationError;
  try {
    handle = await open(layoutState.layout.receipt, constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0));
    await writeReceiptToHandle(layoutState, handle, value);
    await handle.close();
    handle = undefined;
  } catch (error) {
    publicationError = error;
  }
  if (!publicationError) return;
  const cleanupErrors = [];
  if (handle) {
    try {
      await handle.close();
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  try {
    await scrubReceiptReservation(layoutState);
  } catch (error) {
    cleanupErrors.push(error);
  }
  if (cleanupErrors.length > 0) {
    throw new AggregateError([publicationError, ...cleanupErrors], "receipt publication and scrub failed");
  }
  throw publicationError;
}

async function runQualification({
  afterCommandSpawnForTest,
  afterCommandSettlementForTest,
  afterExecutableSnapshotWriteForTest,
  afterGitExecutableSnapshotWriteForTest,
  afterGitWrapperPreparedForTest,
  assignmentPath,
  beforeCommandSpawnForTest,
  beforeWindowsLoaderReleaseForTest,
  bootstrapCommandPlatformForTest,
  bootstrapCommandRunnerForTest,
  bootstrapWindowsJobSupervisorScriptForTest,
  bootstrapWindowsSupervisorCommandForTest,
  command,
  commandPlatformForTest,
  commandRunnerForTest,
  cleanupActionsForTest = [],
  environment = process.env,
  pytestTempAfterOpenForTest,
  pytestTempLimitsForTest,
  pytestTempMountIdentityForTest,
  pythonInventoryAfterRunnerForTest,
  posixMissingControlPipeForTest,
  posixOuterSettlementMsForTest,
  posixSupervisorSourceForTest,
  terminationGraceMs = DEFAULT_TERMINATION_GRACE_MS,
  timeoutMs = DEFAULT_COMMAND_TIMEOUT_MS,
  windowsJobSupervisorScriptForTest,
  windowsMissingControlPipeForTest,
  windowsSupervisorCommandForTest,
  writeOutput = true
}) {
  validateBound(timeoutMs, DEFAULT_COMMAND_TIMEOUT_MS, "qualification timeout");
  validateBound(terminationGraceMs, DEFAULT_TERMINATION_GRACE_MS, "qualification termination grace");
  const initialAssignment = await readAssignment(assignmentPath);
  let layoutState;
  let gitOwnerPins;
  let primaryError;
  let completedReceipt;
  try {
    const assignment = initialAssignment.value;
    const worktreePin = await openPinnedDirectory(assignment.worktree, "worktree owner");
    let initialGit;
    try {
      initialGit = await captureGitIdentity(assignment, environment);
    } catch (error) {
      await finishWithOwnedCleanup(error, [{ label: "worktree owner", run: () => worktreePin.handle.close() }]);
    }
    gitOwnerPins = await openGitOwnerPins(assignment, initialGit, worktreePin, environment);
    await verifyGitOwnerPins(gitOwnerPins);
    initialGit = {
      ...initialGit,
      gitConfig: await captureGitConfigIdentity(assignment, gitOwnerPins, environment),
      gitMetadata: await captureGitMetadataIdentity(gitOwnerPins)
    };
    layoutState = await createStateLayout(assignment, initialAssignment.digest);
    layoutState.pytestTreeOptions = {
      limits: pytestTreeLimits(pytestTempLimitsForTest),
      mountIdentityForTest: pytestTempMountIdentityForTest
    };
    await prepareGitWrapper(layoutState, assignment, gitOwnerPins.configManifest.selectionEnvironment, {
      afterGitExecutableSnapshotWriteForTest
    });
    await afterGitWrapperPreparedForTest?.({
      executableSnapshotPath: executableLeaf(layoutState.gitExecutableLaunch.snapshot).path,
      executableSourcePath: executableLeaf(layoutState.gitExecutableLaunch.source).path
    });
    const startedAt = new Date().toISOString();
    const failures = [];
    let bootstrap;
    try {
      bootstrap = await bootstrapPythonEnvironment(assignmentPath, assignment, layoutState, environment, {
        ownedRunnerForTest: bootstrapCommandRunnerForTest,
        platformForTest: bootstrapCommandPlatformForTest,
        terminationGraceMs,
        timeoutMs,
        windowsJobSupervisorScript: bootstrapWindowsJobSupervisorScriptForTest ?? WINDOWS_JOB_SUPERVISOR_PATH,
        windowsSupervisorCommand: bootstrapWindowsSupervisorCommandForTest
      });
      if (bootstrap.failure) failures.push(bootstrap.failure);
    } catch (error) {
      if (error instanceof OwnedProcessTreeError) throw error;
      failures.push(error instanceof Error ? error.message : String(error));
    }
    let result = {
      lingeringDescendants: false,
      notRun: true,
      signal: null,
      spawnError: null,
      status: null,
      timedOut: false,
      treeEmpty: true
    };
    if (failures.length === 0) {
      try {
        await verifyPinnedDirectory(layoutState.ownerPins.pytestTempParent, "pytest-temp parent owner");
        await requireAbsentPath(layoutState.layout.pytestTemp, "pytest basetemp");
        const emptyParent = await inspectPrivateTree(
          layoutState.ownerPins.pytestTempParent,
          "pytest temporary parent",
          { allowedTopLevelName: null, ...layoutState.pytestTreeOptions }
        );
        if (emptyParent.entries !== 0) fail("pytest temporary parent was not initially empty");
      } catch (error) {
        failures.push(error instanceof Error ? error.message : String(error));
      }
    }
    if (failures.length === 0) {
      result = await runOwnedCommand(command[0], command.slice(1), {
        cwd: assignment.worktree,
        environment: isolatedEnvironment(assignmentPath, assignment, layoutState.layout, environment),
        executableSnapshotRoot: layoutState.layout.executableSnapshots,
        afterSpawnForTest: afterCommandSpawnForTest,
        afterSettlementForTest: afterCommandSettlementForTest,
        beforeSpawnForTest: beforeCommandSpawnForTest,
        beforeWindowsLoaderReleaseForTest,
        executableSnapshotAfterWriteForTest: afterExecutableSnapshotWriteForTest,
        ownedRunnerForTest: commandRunnerForTest,
        platformForTest: commandPlatformForTest,
        posixMissingControlPipeForTest,
        posixOuterSettlementMsForTest,
        posixSupervisorSourceForTest,
        posixSupervisorCommand: bootstrap.bootstrapPython,
        windowsJobSupervisorScript: windowsJobSupervisorScriptForTest ?? WINDOWS_JOB_SUPERVISOR_PATH,
        windowsMissingControlPipeForTest,
        windowsSupervisorCommand: windowsSupervisorCommandForTest ?? layoutState.layout.windowsSupervisorCommand,
        terminationGraceMs,
        timeoutMs
      });
      const commandFailure = resultFailure(result, "qualification command");
      if (commandFailure) failures.push(commandFailure);
    }
    const processTreesEmpty =
      result.treeEmpty && (bootstrap?.result?.treeEmpty ?? true) && (bootstrap?.verification?.treeEmpty ?? true);
    if (!processTreesEmpty) {
      fail("a qualification process tree could not be attested empty; source and receipt paths were not reopened");
    }
    let finalPythonInventory = null;
    if (bootstrap?.inventory) {
      try {
        const captured = await capturePythonInventory(
          assignment,
          layoutState,
          environment,
          bootstrap.bootstrapPython,
          "after",
          {
            assignmentPath,
            ownedRunnerForTest: pythonInventoryAfterRunnerForTest ?? bootstrapCommandRunnerForTest,
            platformForTest: bootstrapCommandPlatformForTest,
            terminationGraceMs,
            windowsJobSupervisorScript: bootstrapWindowsJobSupervisorScriptForTest ?? WINDOWS_JOB_SUPERVISOR_PATH,
            windowsSupervisorCommand: bootstrapWindowsSupervisorCommandForTest
          }
        );
        finalPythonInventory = captured.identity;
        if (JSON.stringify(bootstrap.inventory) !== JSON.stringify(finalPythonInventory)) {
          fail("task Python interpreter or package inventory changed during qualification");
        }
      } catch (error) {
        if (error instanceof OwnedProcessTreeError) throw error;
        failures.push(error instanceof Error ? error.message : String(error));
      }
    }
    try {
      await bindPytestTempTree(layoutState, {
        afterOpenForTest: pytestTempAfterOpenForTest,
        ...layoutState.pytestTreeOptions
      });
    } catch (error) {
      failures.push(error instanceof Error ? error.message : String(error));
    }
    let finalAssignmentDigest = null;
    let finalGit = null;
    try {
      const finalAssignmentBytes = await verifyPinnedRegularFile(
        initialAssignment.pinned,
        MAX_ASSIGNMENT_BYTES,
        "assignment"
      );
      finalAssignmentDigest = sha256(finalAssignmentBytes);
      if (finalAssignmentDigest !== initialAssignment.digest) {
        fail("assignment identity or bytes changed during qualification");
      }
    } catch (error) {
      failures.push(error instanceof Error ? error.message : String(error));
    }
    try {
      await verifyGitOwnerPins(gitOwnerPins);
      finalGit = await captureGitIdentity(assignment, environment);
      finalGit = {
        ...finalGit,
        gitConfig: await captureGitConfigIdentity(assignment, gitOwnerPins, environment),
        gitMetadata: await captureGitMetadataIdentity(gitOwnerPins)
      };
      assertSameGitIdentity(initialGit, finalGit);
    } catch (error) {
      failures.push(error instanceof Error ? error.message : String(error));
    }
    try {
      await verifyLayout(layoutState);
    } catch (error) {
      failures.push(error instanceof Error ? error.message : String(error));
    }
    const eligible = failures.length === 0;
    const receipt = {
      assignment: {
        base: assignment.base,
        branch: assignment.branch,
        gitDirectory: assignment.gitDirectory,
        gitExecutable: assignment.gitExecutable,
        head: assignment.head,
        issue: assignment.issue,
        path: assignmentPath,
        runId: assignment.runId,
        sha256: initialAssignment.digest,
        taskId: assignment.taskId,
        tree: assignment.tree
      },
      bootstrap,
      command,
      eligible,
      environment: layoutState.layout,
      failures,
      finishedAt: new Date().toISOString(),
      gitExecutableSnapshot: layoutState.gitExecutableLaunch.record,
      identity: initialGit,
      postIdentity: finalGit,
      protocol: RECEIPT_PROTOCOL,
      pythonInventory: {
        after: finalPythonInventory,
        before: bootstrap?.inventory ?? null
      },
      pytestTemp: layoutState.pytestTempTree,
      result,
      startedAt
    };
    if (!eligible && !failures.some((failure) => /artifact|receipt reservation/u.test(failure))) {
      await writeReceipt(layoutState, receipt);
      if (writeOutput) process.stdout.write(`${layoutState.layout.receipt}\n`);
    }
    if (!eligible) {
      fail(failures.join("; "));
    }
    completedReceipt = receipt;
  } catch (error) {
    primaryError = error;
  }
  await finishWithOwnedCleanup(primaryError, [
    { label: "private Git executable launch", run: () => closeExecutableLaunch(layoutState?.gitExecutableLaunch) },
    { label: "private Python executable owner", run: () => closePinnedExecutable(layoutState?.pythonExecutablePin) },
    { label: "private Python payload owners", run: () => closePythonPayloadPins(layoutState) },
    ...(layoutState?.runnerFilePins ?? []).map(({ label, pin }) => ({
      label,
      run: () => pin.handle.close()
    })),
    { label: "layout owners", run: () => closeDirectoryPins(layoutState?.ownerPins) },
    { label: "Git owners", run: () => closeDirectoryPins(gitOwnerPins) },
    { label: "receipt owner", run: () => layoutState?.receiptHandle?.close() },
    { label: "assignment owner", run: () => initialAssignment.pinned.handle.close() },
    ...cleanupActionsForTest
  ]);
  if (!completedReceipt || !layoutState) fail("eligible qualification did not produce a receipt");
  await publishEligibleReceipt(layoutState, completedReceipt);
  if (writeOutput) process.stdout.write(`${layoutState.layout.receipt}\n`);
  return completedReceipt;
}

function parseCommandLine(arguments_) {
  if (arguments_[0] !== "run") {
    fail("usage: qualification-isolation.mjs run --assignment <path> -- <command> [args...]");
  }
  if (arguments_[1] !== "--assignment" || typeof arguments_[2] !== "string") {
    fail("--assignment <path> is required");
  }
  if (arguments_[3] !== "--" || arguments_.length < 5) {
    fail("a command after -- is required");
  }
  return { assignmentPath: arguments_[2], command: arguments_.slice(4) };
}

const QUALIFICATION_ISOLATION_TEST_BOUNDARY = Object.freeze({
  finishWithOwnedCleanup,
  parseGitConfigManifestBytes,
  openDirectory(path, afterOpenForTest) {
    return openPinnedDirectory(path, "test directory", { afterOpenForTest });
  },
  openExecutable(path, afterOpenForTest) {
    return openPinnedExecutable(path, undefined, { afterOpenForTest });
  },
  openRegularFile(path, afterOpenForTest) {
    return openPinnedRegularFile(path, MAX_ASSIGNMENT_BYTES, "test regular file", { afterOpenForTest });
  },
  terminateAndAwaitProcess,
  windowsSupervisorLoader,
  windowsSupervisorSignals,
  windowsSystemRootCandidate
});

export {
  ASSIGNMENT_PROTOCOL,
  QUALIFICATION_ENVIRONMENT_CONTRACT,
  QUALIFICATION_ISOLATION_TEST_BOUNDARY,
  RECEIPT_PROTOCOL,
  runQualification
};

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    await runQualification(parseCommandLine(process.argv.slice(2)));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
