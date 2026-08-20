import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, realpath, readlink, writeFile } from "node:fs/promises";
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
import { resolveAcceptancePython } from "./packaged-python-preflight.mjs";

const ASSIGNMENT_PROTOCOL = "openwrangler-qualification-assignment-v1";
const RECEIPT_PROTOCOL = "openwrangler-qualification-receipt-v1";
const MAX_ASSIGNMENT_BYTES = 32 * 1024;
const MAX_GIT_CONFIG_BYTES = 1024 * 1024;
const MAX_GIT_CONFIG_MANIFEST_BYTES = 4 * 1024 * 1024;
const MAX_RECEIPT_BYTES = 256 * 1024;
const MAX_EXECUTABLE_BYTES = 256 * 1024 * 1024;
const DEFAULT_COMMAND_TIMEOUT_MS = 30 * 60 * 1000;
const DEFAULT_TERMINATION_GRACE_MS = 10_000;
const WINDOWS_JOB_ATTESTATION_PREFIX = "OPEN_WRANGLER_WINDOWS_JOB_EMPTY:";
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
  OPEN_WRANGLER_PYTHON: "pythonExecutable",
  OPEN_WRANGLER_QUALIFICATION_RECEIPT: "receipt",
  OPEN_WRANGLER_TEST_PROGRESS: "testProgress",
  OPEN_WRANGLER_TEST_PYTHON: "pythonExecutable",
  OPEN_WRANGLER_TEST_RESULT: "testResult",
  PIP_CONFIG_FILE: "pipConfig",
  npm_config_userconfig: "npmUserConfig"
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
  runnerOwnedKeys: Object.freeze(["COMSPEC", "PATH", "PWD", "SYSTEMDRIVE", "SYSTEMROOT", "WINDIR"]),
  worktreePaths: WORKTREE_PATH_ENVIRONMENT
});

const POSIX_SUBREAPER_SOURCE = String.raw`
import ctypes, json, os, signal, subprocess, sys, time

CONTROL_FD = 5
TARGET_FD = 4

def publish(value):
    os.write(CONTROL_FD, (json.dumps(value, separators=(",", ":")) + "\n").encode("utf-8"))

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
    try:
        target = subprocess.Popen(
            [argv0, *arguments],
            executable=target_path,
            close_fds=True,
            pass_fds=(TARGET_FD,),
            start_new_session=True,
        )
    except BaseException as error:
        publish({"spawnError":str(error),"treeEmpty":True})
        return
    timed_out = False
    status = None
    signal_name = None
    try:
        status = target.wait(timeout=timeout)
    except subprocess.TimeoutExpired:
        timed_out = True
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
        "spawnError": None,
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

function gitWithEnvironment(assignment, arguments_, hostEnvironment) {
  const result = spawnSync(
    assignment.gitExecutable,
    ["--git-dir", assignment.gitDirectory, "--work-tree", assignment.worktree, ...arguments_],
    {
      cwd: assignment.worktree,
      encoding: "utf8",
      env: gitInspectionEnvironment(assignment, hostEnvironment),
      maxBuffer: 4 * 1024 * 1024,
      windowsHide: true
    }
  );
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    fail(`Git ${arguments_.join(" ")} failed: ${(result.stderr || result.stdout).trim()}`);
  }
  return result.stdout.trim();
}

function optionalGitConfig(assignment, key, hostEnvironment = process.env) {
  const result = spawnSync(
    assignment.gitExecutable,
    ["--git-dir", assignment.gitDirectory, "--work-tree", assignment.worktree, "config", "--get", key],
    {
      cwd: assignment.worktree,
      encoding: "utf8",
      env: gitInspectionEnvironment(assignment, hostEnvironment),
      maxBuffer: 1024 * 1024,
      windowsHide: true
    }
  );
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

function captureGitConfigManifest(assignment, hostEnvironment) {
  const result = spawnSync(
    assignment.gitExecutable,
    [
      "--git-dir",
      assignment.gitDirectory,
      "--work-tree",
      assignment.worktree,
      "config",
      "--show-origin",
      "--show-scope",
      "--null",
      "--list"
    ],
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
    fail(
      `Git config manifest failed: ${Buffer.concat([result.stderr ?? Buffer.alloc(0), result.stdout ?? Buffer.alloc(0)])
        .toString("utf8")
        .trim()}`
    );
  }
  const bytes = Buffer.from(result.stdout ?? Buffer.alloc(0));
  if (bytes.length === 0 || bytes.length > MAX_GIT_CONFIG_MANIFEST_BYTES || bytes.at(-1) !== 0) {
    fail("Git config manifest bytes are invalid");
  }
  const fields = bytes.toString("utf8").split("\0");
  fields.pop();
  if (fields.length % 3 !== 0) fail("Git config manifest shape is invalid");
  const sourceScopes = new Map();
  for (let index = 0; index < fields.length; index += 3) {
    const scope = fields[index];
    const origin = fields[index + 1];
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
    bytes,
    entryCount: fields.length / 3,
    selectionEnvironment: gitConfigSelectionEnvironment(hostEnvironment),
    sha256: sha256(bytes),
    sources: [...sourceScopes.entries()]
      .map(([path, scopes]) => ({ path, scopes: [...scopes].sort() }))
      .sort((left, right) => left.path.localeCompare(right.path))
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
    await handle.close();
    throw error;
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
    await handle.close();
    throw error;
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
    head,
    mergeBase,
    nodeModules: nodeModulesIdentity,
    tree,
    worktree: worktreeIdentity
  };
}

async function openGitOwnerPins(assignment, gitIdentity, worktreePin, hostEnvironment) {
  const pins = { configSources: [], worktree: worktreePin };
  try {
    pins.commonDirectory = await openPinnedDirectory(gitIdentity.commonDirectory.path, "Git common-directory owner");
    pins.gitDirectory = await openPinnedDirectory(gitIdentity.gitDirectory.path, "Git-directory owner");
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
      const identity = key === "worktree" ? gitIdentity.worktree : gitIdentity[key];
      if (pin.snapshot.dev.toString() !== identity.device || pin.snapshot.ino.toString() !== identity.inode) {
        fail(`${key} changed before its owner could be pinned`);
      }
    }
    return pins;
  } catch (error) {
    await closeDirectoryPins(pins);
    throw error;
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
    } else {
      await verifyPinnedDirectory(pin, `${key} owner`);
    }
  }
}

async function closeDirectoryPins(pins) {
  const handles = [];
  for (const [key, value] of Object.entries(pins ?? {})) {
    if (key === "configManifest") continue;
    if (key === "configSources") {
      handles.push(...value.map((source) => source.pin.handle));
    } else {
      handles.push(value.handle);
    }
  }
  await Promise.all(handles.map((handle) => handle.close()));
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

function assertSameGitIdentity(before, after) {
  for (const key of ["base", "branch", "head", "mergeBase", "tree"]) {
    if (before[key] !== after[key]) {
      fail(`worktree ${key} changed during qualification`);
    }
  }
  for (const key of ["commonDirectory", "gitDirectory", "gitExecutable", "worktree"]) {
    if (!sameIdentity(before[key], after[key])) {
      fail(`worktree ${key} identity changed during qualification`);
    }
  }
  if (JSON.stringify(before.gitConfig) !== JSON.stringify(after.gitConfig)) {
    fail("worktree Git config or effective identity changed during qualification");
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
    pytestTemp: join(assignment.stateRoot, "python", "pytest-temp"),
    pythonBytecode: join(assignment.stateRoot, "python", "bytecode"),
    pythonExecutable,
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
  const directoryKeys = Object.keys(layout).filter(
    (key) =>
      ![
        "nodeModules",
        "gitWrapper",
        "gitWrapperProgram",
        "npmUserConfig",
        "pipConfig",
        "pythonExecutable",
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
    await receiptHandle.close();
    throw error;
  }
  const ownerPins = {};
  try {
    ownerPins.stateRoot = await openPinnedDirectory(layout.stateRoot, "stateRoot owner");
    ownerPins.artifacts = await openPinnedDirectory(layout.artifacts, "artifact owner");
    ownerPins.executableSnapshots = await openPinnedDirectory(layout.executableSnapshots, "executable-snapshot owner");
    for (const [key, pin] of Object.entries(ownerPins)) {
      const identity = key === "stateRoot" ? stateRootIdentity : identities[key];
      if (pin.snapshot.dev.toString() !== identity.device || pin.snapshot.ino.toString() !== identity.inode) {
        fail(`${key} owner changed before it could be pinned`);
      }
    }
  } catch (error) {
    await Promise.all(Object.values(ownerPins).map((pin) => pin.handle.close()));
    await receiptHandle.close();
    throw error;
  }
  return { identities, layout, ownerPins, receiptHandle, receiptSnapshot, runnerFilePins: [], stateRootIdentity };
}

function quotePytestPath(path) {
  return `'${path.replaceAll("'", `'"'"'`)}'`;
}

function gitWrapperProgramSource(assignment, configSelectionEnvironment) {
  return `import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";

const binding = ${JSON.stringify({
    configSelectionEnvironment,
    gitDirectory: assignment.gitDirectory,
    gitExecutable: assignment.gitExecutable,
    stateRoot: assignment.stateRoot,
    worktree: assignment.worktree
  })};
function isInside(root, candidate) {
  const suffix = relative(root, candidate);
  return suffix === "" || (!suffix.startsWith("..") && !isAbsolute(suffix));
}
function rejectOwnerOverrides(arguments_) {
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === "--") break;
    if (!argument.startsWith("-")) break;
    if (
      argument === "--bare" ||
      argument === "--git-dir" ||
      argument.startsWith("--git-dir=") ||
      argument === "--namespace" ||
      argument.startsWith("--namespace=") ||
      argument === "--work-tree" ||
      argument.startsWith("--work-tree=")
    ) {
      throw new Error("qualification Git metadata ownership cannot be overridden");
    }
    if (argument === "-C" || argument === "-c" || argument === "--config-env") index += 1;
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
    } else if (argument === "-c" || argument === "--config-env") {
      index += 1;
    }
    if (requested === undefined) continue;
    if (requested.length === 0) continue;
    directory = realpathSync.native(resolve(directory, requested));
  }
  return directory;
}
const environment = { ...process.env };
for (const key of Object.keys(environment)) {
  const upper = key.toUpperCase();
  if (upper === "EMAIL" || upper.startsWith("GIT_")) delete environment[key];
}
Object.assign(environment, binding.configSelectionEnvironment);
const cwd = realpathSync.native(process.cwd());
const arguments_ = process.argv.slice(2);
rejectOwnerOverrides(arguments_);
const effectiveCwd = effectiveWorkingDirectory(cwd, arguments_);
const usesAssignedWorktree = isInside(binding.worktree, effectiveCwd);
if (!usesAssignedWorktree && !isInside(binding.stateRoot, effectiveCwd)) {
  throw new Error("unbound qualification Git is permitted only inside the private task root");
}
const commandArguments = usesAssignedWorktree
  ? ["--git-dir", binding.gitDirectory, "--work-tree", binding.worktree, ...arguments_]
  : arguments_;
const result = spawnSync(binding.gitExecutable, commandArguments, {
  cwd,
  env: environment,
  stdio: "inherit",
  windowsHide: true
});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
`;
}

async function prepareGitWrapper(layoutState, assignment, configSelectionEnvironment) {
  const programBytes = gitWrapperProgramSource(assignment, configSelectionEnvironment);
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
    await Promise.all(pins.map((pin) => pin.handle.close()));
    throw error;
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

function validateBound(value, maximum, label) {
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
    fail(`${label} must be a positive safe integer no larger than ${maximum}`);
  }
}

async function openPinnedSymbolicExecutable(path, allowedSymbolicLinkTarget) {
  if (!allowedSymbolicLinkTarget) {
    fail("qualification command must not be a symbolic link");
  }
  const target = await openPinnedExecutable(allowedSymbolicLinkTarget);
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
    await closePinnedExecutable(target);
    throw error;
  }
}

async function openPinnedExecutable(path, allowedSymbolicLinkTarget, { afterOpenForTest } = {}) {
  assertCanonicalAbsolutePath(path, "qualification command");
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  } catch (error) {
    if (error?.code === "ELOOP") {
      return openPinnedSymbolicExecutable(path, allowedSymbolicLinkTarget);
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
      (process.platform !== "win32" && (opened.mode & 0o111n) === 0n) ||
      namedAfter.isSymbolicLink() ||
      !sameImmutableSnapshot(opened, namedBefore) ||
      !sameImmutableSnapshot(namedBefore, namedAfter) ||
      canonical !== path
    ) {
      fail("qualification command changed while it was opened");
    }
    return { before: opened, handle, path };
  } catch (error) {
    await handle?.close();
    throw error;
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

async function createExecutableSnapshot(executable, snapshotRoot, { afterWriteForTest } = {}) {
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
  const snapshot = await openPinnedExecutable(snapshotPath);
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
  await closePinnedExecutable(value.snapshot);
  await closePinnedExecutable(value.source);
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
        POSIX_SUBREAPER_SOURCE,
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
    return {
      lingeringDescendants: false,
      signal: null,
      spawnError: error instanceof Error ? error.message : String(error),
      status: null,
      timedOut: false,
      treeEmpty: true
    };
  } finally {
    await options.afterSpawnForTest?.({
      child,
      executedPath: command,
      sourcePath: options.sourceCommand,
      strategy: options.executionStrategy
    });
  }
  const controlStream = child.stdio[5];
  if (!controlStream) {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      // The supervisor may already have exited while its missing control pipe was classified.
    }
    return {
      lingeringDescendants: false,
      signal: null,
      spawnError: "POSIX containment supervisor control pipe is unavailable",
      status: null,
      timedOut: false,
      treeEmpty: false
    };
  }
  const control = readPosixSupervisorControl(controlStream);
  const completion = waitForSpawnedProcess(child);
  let timer;
  const outcome = await Promise.race([
    completion,
    new Promise((resolveTimeout) => {
      timer = setTimeout(
        () => resolveTimeout({ timedOut: true }),
        options.timeoutMs + 2 * options.terminationGraceMs + 5_000
      );
    })
  ]);
  clearTimeout(timer);
  if (outcome.timedOut === true) {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      // The supervisor may have exited at the same instant as its outer settlement deadline.
    }
    return {
      lingeringDescendants: false,
      signal: null,
      spawnError: "POSIX containment supervisor exceeded its bounded settlement",
      status: null,
      timedOut: true,
      treeEmpty: false
    };
  }
  const reported = await control;
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

function windowsAttestation(stream, token) {
  const marker = Buffer.from(`${WINDOWS_JOB_ATTESTATION_PREFIX}${token}\n`, "ascii");
  let markerCount = 0;
  let pending = Buffer.alloc(0);
  return new Promise((resolveAttestation) => {
    stream.on("data", (chunk) => {
      let combined = pending.length === 0 ? Buffer.from(chunk) : Buffer.concat([pending, chunk]);
      let match;
      while ((match = combined.indexOf(marker)) >= 0) {
        if (match > 0) process.stderr.write(combined.subarray(0, match));
        markerCount += 1;
        combined = combined.subarray(match + marker.length);
      }
      const retained = Math.min(combined.length, marker.length - 1);
      const published = combined.length - retained;
      if (published > 0) process.stderr.write(combined.subarray(0, published));
      pending = Buffer.from(combined.subarray(published));
    });
    stream.once("error", () => resolveAttestation(false));
    stream.once("end", () => {
      if (pending.length > 0) process.stderr.write(pending);
      resolveAttestation(markerCount === 1);
    });
  });
}

async function runWindowsOwnedCommand(command, arguments_, options) {
  await options.beforeSpawnForTest?.({
    executedPath: command,
    sourcePath: options.sourceCommand,
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
  let supervisor;
  try {
    supervisor = spawn(
      options.supervisorExecutedPath,
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", WINDOWS_JOB_SUPERVISOR_PATH],
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
  if (!supervisor.stdin || !supervisor.stderr) {
    supervisor.kill("SIGKILL");
    return {
      lingeringDescendants: false,
      signal: null,
      spawnError: "Windows Job Object supervisor pipes are unavailable",
      status: null,
      timedOut: false,
      treeEmpty: false
    };
  }
  const token = randomUUID();
  const attested = windowsAttestation(supervisor.stderr, token);
  const completion = waitForSpawnedProcess(supervisor);
  let controlError;
  supervisor.stdin.on("error", (error) => {
    controlError ??= error;
  });
  await options.afterSpawnForTest?.({
    executedPath: command,
    sourcePath: options.sourceCommand,
    strategy: options.executionStrategy
  });
  try {
    await options.verifyExecutableForSpawn();
  } catch (error) {
    supervisor.stdin.destroy();
    supervisor.kill("SIGKILL");
    await completion;
    return {
      lingeringDescendants: false,
      signal: null,
      spawnError: error instanceof Error ? error.message : String(error),
      status: null,
      timedOut: false,
      treeEmpty: true
    };
  }
  supervisor.stdin.write(
    `${JSON.stringify({
      args: arguments_,
      attestationToken: token,
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
  if (outcome.timedOut === true) {
    supervisor.stdin.write('{"protocol":1,"command":"terminate"}\n', "utf8", (error) => {
      controlError ??= error;
    });
    let graceOutcome = await Promise.race([completion, delay(options.terminationGraceMs).then(() => null)]);
    if (graceOutcome === null) {
      supervisor.kill("SIGKILL");
      graceOutcome = await Promise.race([completion, delay(options.terminationGraceMs).then(() => null)]);
    }
    if (graceOutcome === null) {
      supervisor.stdin.destroy();
      return {
        lingeringDescendants: false,
        signal: null,
        spawnError: "Windows Job Object supervisor did not terminate within its bounded grace",
        status: null,
        timedOut: true,
        treeEmpty: false
      };
    }
  }
  const finalOutcome = outcome.timedOut === true ? await completion : outcome;
  supervisor.stdin.destroy();
  const treeEmpty = await attested;
  return {
    lingeringDescendants: false,
    signal: finalOutcome.signal ?? null,
    spawnError: controlError
      ? controlError instanceof Error
        ? controlError.message
        : String(controlError)
      : finalOutcome.error
        ? finalOutcome.error instanceof Error
          ? finalOutcome.error.message
          : String(finalOutcome.error)
        : null,
    status: finalOutcome.status ?? null,
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
    }
  } catch (error) {
    if (launch) await closeExecutableLaunch(launch);
    else await closePinnedExecutable(executable);
    if (supervisorLaunch) await closeExecutableLaunch(supervisorLaunch);
    else await closePinnedExecutable(supervisorExecutable);
    return {
      executable: null,
      lingeringDescendants: false,
      signal: null,
      spawnError: error instanceof Error ? error.message : String(error),
      status: null,
      timedOut: false,
      treeEmpty: true
    };
  }
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
      supervisorExecutableFd: platform === "win32" ? null : executableLeaf(supervisorLaunch.snapshot).handle.fd,
      targetExecutableFd: platform === "win32" ? null : executableLeaf(launch.snapshot).handle.fd,
      verifyExecutableForSpawn: async () => {
        await verifyExecutableLaunch(launch);
        if (supervisorLaunch) await verifyExecutableLaunch(supervisorLaunch);
      }
    });
    result.executable = {
      ...launch.record,
      strategy: executionStrategy,
      supervisor: supervisorLaunch?.record ?? null
    };
    if (result.treeEmpty) {
      try {
        await verifyExecutableLaunch(launch);
        if (supervisorLaunch) await verifyExecutableLaunch(supervisorLaunch);
      } catch (error) {
        result.spawnError ??= error instanceof Error ? error.message : String(error);
      }
    }
    return result;
  } finally {
    await closeExecutableLaunch(launch);
    await closeExecutableLaunch(supervisorLaunch);
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
  const creation = await runOwnedCommand(bootstrapPython, ["-I", "-m", "venv", layoutState.layout.venv], {
    cwd: assignment.worktree,
    environment,
    executableSnapshotRoot: layoutState.layout.executableSnapshots,
    posixSupervisorCommand: bootstrapPython,
    windowsSupervisorCommand: layoutState.layout.windowsSupervisorCommand,
    terminationGraceMs: options.terminationGraceMs,
    timeoutMs: 120_000
  });
  const creationFailure = resultFailure(creation, "task Python venv bootstrap");
  if (creationFailure) return { bootstrapPython, failure: creationFailure, result: creation };
  layoutState.identities.venv = await fileIdentity(layoutState.layout.venv, "directory");
  layoutState.pythonEntry = await captureVenvPythonIdentity(
    layoutState.layout.pythonExecutable,
    creation.executable.snapshot.path
  );
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
      posixSupervisorCommand: bootstrapPython,
      windowsSupervisorCommand: layoutState.layout.windowsSupervisorCommand,
      terminationGraceMs: options.terminationGraceMs,
      timeoutMs: 30_000
    }
  );
  const verificationFailure = resultFailure(verification, "task Python venv verification");
  return {
    bootstrapPython,
    failure: verificationFailure,
    result: creation,
    verification
  };
}

async function verifyLayout(layoutState) {
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
  for (const { label, pin } of layoutState.runnerFilePins) {
    await verifyPinnedRegularFile(pin, MAX_ASSIGNMENT_BYTES, label);
  }
}

async function writeReceipt(layoutState, value) {
  const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
  if (bytes.length === 0 || bytes.length > MAX_RECEIPT_BYTES) {
    fail("receipt bytes are invalid");
  }
  const opened = await layoutState.receiptHandle.stat({ bigint: true });
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
    const { bytesWritten } = await layoutState.receiptHandle.write(bytes, offset, bytes.length - offset, offset);
    if (bytesWritten === 0) fail("receipt publication made no progress");
    offset += bytesWritten;
  }
  await layoutState.receiptHandle.sync();
  const completed = await layoutState.receiptHandle.stat({ bigint: true });
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

async function runQualification({
  afterCommandSpawnForTest,
  afterExecutableSnapshotWriteForTest,
  assignmentPath,
  beforeCommandSpawnForTest,
  command,
  commandPlatformForTest,
  commandRunnerForTest,
  environment = process.env,
  terminationGraceMs = DEFAULT_TERMINATION_GRACE_MS,
  timeoutMs = DEFAULT_COMMAND_TIMEOUT_MS,
  windowsSupervisorCommandForTest,
  writeOutput = true
}) {
  validateBound(timeoutMs, DEFAULT_COMMAND_TIMEOUT_MS, "qualification timeout");
  validateBound(terminationGraceMs, DEFAULT_TERMINATION_GRACE_MS, "qualification termination grace");
  const initialAssignment = await readAssignment(assignmentPath);
  let layoutState;
  let gitOwnerPins;
  try {
    const assignment = initialAssignment.value;
    const worktreePin = await openPinnedDirectory(assignment.worktree, "worktree owner");
    let initialGit;
    try {
      initialGit = await captureGitIdentity(assignment, environment);
    } catch (error) {
      await worktreePin.handle.close();
      throw error;
    }
    gitOwnerPins = await openGitOwnerPins(assignment, initialGit, worktreePin, environment);
    await verifyGitOwnerPins(gitOwnerPins);
    initialGit = {
      ...initialGit,
      gitConfig: await captureGitConfigIdentity(assignment, gitOwnerPins, environment)
    };
    layoutState = await createStateLayout(assignment, initialAssignment.digest);
    await prepareGitWrapper(layoutState, assignment, gitOwnerPins.configManifest.selectionEnvironment);
    const startedAt = new Date().toISOString();
    const failures = [];
    let bootstrap;
    try {
      bootstrap = await bootstrapPythonEnvironment(assignmentPath, assignment, layoutState, environment, {
        terminationGraceMs,
        timeoutMs
      });
      if (bootstrap.failure) failures.push(bootstrap.failure);
    } catch (error) {
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
      result = await runOwnedCommand(command[0], command.slice(1), {
        cwd: assignment.worktree,
        environment: isolatedEnvironment(assignmentPath, assignment, layoutState.layout, environment),
        executableSnapshotRoot: layoutState.layout.executableSnapshots,
        afterSpawnForTest: afterCommandSpawnForTest,
        beforeSpawnForTest: beforeCommandSpawnForTest,
        executableSnapshotAfterWriteForTest: afterExecutableSnapshotWriteForTest,
        ownedRunnerForTest: commandRunnerForTest,
        platformForTest: commandPlatformForTest,
        posixSupervisorCommand: bootstrap.bootstrapPython,
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
        gitConfig: await captureGitConfigIdentity(assignment, gitOwnerPins, environment)
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
      identity: initialGit,
      postIdentity: finalGit,
      protocol: RECEIPT_PROTOCOL,
      result,
      startedAt
    };
    if (!failures.some((failure) => /artifact|receipt reservation/u.test(failure))) {
      await writeReceipt(layoutState, receipt);
      if (writeOutput) process.stdout.write(`${layoutState.layout.receipt}\n`);
    }
    if (!eligible) {
      fail(failures.join("; "));
    }
    return receipt;
  } finally {
    await Promise.all((layoutState?.runnerFilePins ?? []).map(({ pin }) => pin.handle.close()));
    await closeDirectoryPins(layoutState?.ownerPins);
    await closeDirectoryPins(gitOwnerPins);
    await layoutState?.receiptHandle?.close();
    await initialAssignment.pinned.handle.close();
  }
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
  openDirectory(path, afterOpenForTest) {
    return openPinnedDirectory(path, "test directory", { afterOpenForTest });
  },
  openExecutable(path, afterOpenForTest) {
    return openPinnedExecutable(path, undefined, { afterOpenForTest });
  },
  openRegularFile(path, afterOpenForTest) {
    return openPinnedRegularFile(path, MAX_ASSIGNMENT_BYTES, "test regular file", { afterOpenForTest });
  },
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
