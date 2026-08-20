import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, realpath, readlink, writeFile } from "node:fs/promises";
import { delimiter, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { resolveAcceptancePython } from "./packaged-python-preflight.mjs";

const ASSIGNMENT_PROTOCOL = "openwrangler-qualification-assignment-v1";
const RECEIPT_PROTOCOL = "openwrangler-qualification-receipt-v1";
const MAX_ASSIGNMENT_BYTES = 32 * 1024;
const MAX_RECEIPT_BYTES = 256 * 1024;
const DEFAULT_COMMAND_TIMEOUT_MS = 30 * 60 * 1000;
const DEFAULT_TERMINATION_GRACE_MS = 10_000;
const PROCESS_POLL_MS = 25;
const WINDOWS_JOB_ATTESTATION_PREFIX = "OPEN_WRANGLER_WINDOWS_JOB_EMPTY:";
const WINDOWS_JOB_SUPERVISOR_PATH = join(import.meta.dirname, "windows-job-supervisor.ps1");
const SHA_PATTERN = /^[0-9a-f]{40}$/u;
const TOKEN_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const BRANCH_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/u;
const ASSIGNMENT_KEYS = [
  "base",
  "branch",
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
  "GIT_COMMON_DIR",
  "GIT_DIR",
  "GIT_INDEX_FILE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_WORK_TREE"
]);
const SAFE_PASSTHROUGH_ENVIRONMENT_KEYS = Object.freeze([
  "CI",
  "COLORTERM",
  "COMSPEC",
  "GITHUB_ACTIONS",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "NUMBER_OF_PROCESSORS",
  "OS",
  "PATH",
  "PATHEXT",
  "PROCESSOR_ARCHITECTURE",
  "RUNNER_ARCH",
  "RUNNER_OS",
  "SHELL",
  "SYSTEMDRIVE",
  "SYSTEMROOT",
  "TERM",
  "TZ",
  "WINDIR"
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
  GIT_WORK_TREE: "worktree",
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
  "NODE_PATH",
  "PIP_PREFIX",
  "PIP_TARGET",
  "QUALIFICATION_SHARED_SENTINEL"
]);

const QUALIFICATION_ENVIRONMENT_CONTRACT = Object.freeze({
  exactValues: EXACT_ENVIRONMENT_VALUES,
  forbiddenInheritedKeys: FORBIDDEN_INHERITED_ENVIRONMENT_KEYS,
  passThroughKeys: SAFE_PASSTHROUGH_ENVIRONMENT_KEYS,
  privateDirectories: PRIVATE_DIRECTORY_ENVIRONMENT,
  privateFiles: PRIVATE_FILE_ENVIRONMENT,
  worktreePaths: WORKTREE_PATH_ENVIRONMENT
});

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

function cleanGitEnvironment(environment = process.env) {
  const result = { ...environment };
  for (const key of GIT_OVERRIDE_KEYS) {
    delete result[key];
  }
  return result;
}

function git(worktree, arguments_) {
  const result = spawnSync("git", ["-C", worktree, ...arguments_], {
    encoding: "utf8",
    env: cleanGitEnvironment(),
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

async function openPinnedDirectory(path, label) {
  const before = await lstat(path, { bigint: true });
  if (before.isSymbolicLink() || !before.isDirectory() || (await realpath(path)) !== path) {
    fail(`${label} must be one canonical non-symbolic-link directory`);
  }
  const handle = await open(path, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat({ bigint: true });
    const after = await lstat(path, { bigint: true });
    if (
      !opened.isDirectory() ||
      !sameDirectorySnapshot(before, opened) ||
      !sameDirectorySnapshot(opened, after) ||
      (await realpath(path)) !== path
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

async function openPinnedRegularFile(path, maximumBytes, label) {
  const before = await lstat(path, { bigint: true });
  if (before.isSymbolicLink() || !before.isFile() || before.nlink !== 1n) {
    fail(`${label} must be a singly linked regular file`);
  }
  if ((await realpath(path)) !== path) {
    fail(`${label} must not use an aliased parent`);
  }
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const { bytes, snapshot } = await readPinnedBytes(handle, maximumBytes, label);
    const after = await lstat(path, { bigint: true });
    if (
      after.isSymbolicLink() ||
      !sameImmutableSnapshot(before, snapshot) ||
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

async function captureGitIdentity(assignment) {
  const worktreeIdentity = await fileIdentity(assignment.worktree, "directory");
  const dotGit = await lstat(join(assignment.worktree, ".git"));
  if (dotGit.isSymbolicLink() || (!dotGit.isFile() && !dotGit.isDirectory())) {
    fail("worktree .git entry is invalid");
  }
  if (git(assignment.worktree, ["rev-parse", "--is-inside-work-tree"]) !== "true") {
    fail("assignment worktree is not a Git worktree");
  }
  const gitDirectory = git(assignment.worktree, ["rev-parse", "--path-format=absolute", "--git-dir"]);
  const commonDirectory = git(assignment.worktree, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  const head = git(assignment.worktree, ["rev-parse", "HEAD"]);
  const tree = git(assignment.worktree, ["rev-parse", "HEAD^{tree}"]);
  const branch = git(assignment.worktree, ["branch", "--show-current"]);
  const base = git(assignment.worktree, ["rev-parse", `${assignment.base}^{commit}`]);
  const mergeBase = git(assignment.worktree, ["merge-base", assignment.base, "HEAD"]);
  const status = git(assignment.worktree, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
  const diffCheck = git(assignment.worktree, ["diff", "--check"]);
  if (base !== assignment.base || mergeBase !== assignment.base) {
    fail("assignment base is not the exact ancestor of HEAD");
  }
  if (head !== assignment.head || tree !== assignment.tree || branch !== assignment.branch) {
    fail("worktree HEAD, tree, or branch does not match the assignment");
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
    head,
    mergeBase,
    nodeModules: nodeModulesIdentity,
    tree,
    worktree: worktreeIdentity
  };
}

async function openGitOwnerPins(gitIdentity, worktreePin) {
  const pins = { worktree: worktreePin };
  try {
    pins.commonDirectory = await openPinnedDirectory(gitIdentity.commonDirectory.path, "Git common-directory owner");
    pins.gitDirectory = await openPinnedDirectory(gitIdentity.gitDirectory.path, "Git-directory owner");
    if (gitIdentity.nodeModules) {
      pins.nodeModules = await openPinnedDirectory(gitIdentity.nodeModules.path, "node_modules owner");
    }
    for (const [key, pin] of Object.entries(pins)) {
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
    await verifyPinnedDirectory(pin, `${key} owner`);
  }
}

async function closeDirectoryPins(pins) {
  await Promise.all(Object.values(pins ?? {}).map((pin) => pin.handle.close()));
}

function assertSameGitIdentity(before, after) {
  for (const key of ["base", "branch", "head", "mergeBase", "tree"]) {
    if (before[key] !== after[key]) {
      fail(`worktree ${key} changed during qualification`);
    }
  }
  for (const key of ["commonDirectory", "gitDirectory", "worktree"]) {
    if (!sameIdentity(before[key], after[key])) {
      fail(`worktree ${key} identity changed during qualification`);
    }
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
    for (const [key, pin] of Object.entries(ownerPins)) {
      const identity = key === "stateRoot" ? stateRootIdentity : identities.artifacts;
      if (pin.snapshot.dev.toString() !== identity.device || pin.snapshot.ino.toString() !== identity.inode) {
        fail(`${key} owner changed before it could be pinned`);
      }
    }
  } catch (error) {
    await Promise.all(Object.values(ownerPins).map((pin) => pin.handle.close()));
    await receiptHandle.close();
    throw error;
  }
  return { identities, layout, ownerPins, receiptHandle, receiptSnapshot, stateRootIdentity };
}

function quotePytestPath(path) {
  return `'${path.replaceAll("'", `'"'"'`)}'`;
}

function isolatedEnvironment(assignmentFile, assignment, gitIdentity, layout, hostEnvironment) {
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
    environment[key] = layoutKey === "worktree" ? assignment.worktree : layout[layoutKey];
  }
  Object.assign(environment, EXACT_ENVIRONMENT_VALUES, {
    GIT_DIR: gitIdentity.gitDirectory.path,
    OPEN_WRANGLER_QUALIFICATION_ASSIGNMENT: assignmentFile,
    OPEN_WRANGLER_QUALIFICATION_ROOT: assignment.stateRoot,
    OPEN_WRANGLER_QUALIFICATION_RUN_ID: assignment.runId,
    OPEN_WRANGLER_QUALIFICATION_TASK_ID: assignment.taskId,
    PATH: `${dirname(layout.pythonExecutable)}${delimiter}${hostEnvironment.PATH ?? ""}`,
    PYTEST_ADDOPTS: `--cache-dir=${quotePytestPath(layout.pytestCache)} --basetemp=${quotePytestPath(layout.pytestTemp)}`,
    npm_config_userconfig: layout.npmUserConfig
  });
  if (process.platform === "win32") {
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

async function openPinnedExecutable(path, allowedSymbolicLinkTarget) {
  assertCanonicalAbsolutePath(path, "qualification command");
  const before = await lstat(path, { bigint: true });
  if (before.isSymbolicLink()) {
    if (!allowedSymbolicLinkTarget || (await realpath(path)) !== allowedSymbolicLinkTarget) {
      fail("qualification command must not be a symbolic link");
    }
    const linkText = await readlink(path);
    const target = await openPinnedExecutable(allowedSymbolicLinkTarget);
    return { before, linkText, path, symbolicLinkTarget: allowedSymbolicLinkTarget, target };
  }
  if (!before.isFile() || before.nlink !== 1n || (process.platform !== "win32" && (before.mode & 0o111n) === 0n)) {
    fail("qualification command must be one executable singly linked regular file");
  }
  if ((await realpath(path)) !== path) {
    fail("qualification command must not use an aliased parent");
  }
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat({ bigint: true });
    const after = await lstat(path, { bigint: true });
    if (!sameImmutableSnapshot(before, opened) || !sameImmutableSnapshot(opened, after)) {
      fail("qualification command changed while it was opened");
    }
    return { before: opened, handle, path };
  } catch (error) {
    await handle.close();
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

function posixProcessGroupRunning(processGroup) {
  try {
    process.kill(-processGroup, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    if (error?.code === "EPERM") return true;
    throw error;
  }
}

async function waitForPosixProcessGroupEmpty(processGroup, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  do {
    if (!posixProcessGroupRunning(processGroup)) return true;
    await delay(PROCESS_POLL_MS);
  } while (Date.now() < deadline);
  return !posixProcessGroupRunning(processGroup);
}

function signalPosixProcessGroup(processGroup, signal) {
  try {
    process.kill(-processGroup, signal);
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
  }
}

async function terminatePosixProcessGroup(processGroup, graceMs) {
  signalPosixProcessGroup(processGroup, "SIGTERM");
  if (await waitForPosixProcessGroupEmpty(processGroup, graceMs)) return true;
  signalPosixProcessGroup(processGroup, "SIGKILL");
  return waitForPosixProcessGroupEmpty(processGroup, graceMs);
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

async function runPosixOwnedCommand(command, arguments_, options) {
  let child;
  try {
    child = spawn(command, arguments_, {
      cwd: options.cwd,
      detached: true,
      env: options.environment,
      shell: false,
      stdio: "inherit",
      windowsHide: true
    });
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
  const completion = waitForSpawnedProcess(child);
  let timer;
  const outcome = await Promise.race([
    completion,
    new Promise((resolveTimeout) => {
      timer = setTimeout(() => resolveTimeout({ timedOut: true }), options.timeoutMs);
    })
  ]);
  clearTimeout(timer);
  if (outcome.error) {
    return {
      lingeringDescendants: false,
      signal: null,
      spawnError: outcome.error instanceof Error ? outcome.error.message : String(outcome.error),
      status: null,
      timedOut: false,
      treeEmpty: child.pid === undefined
    };
  }
  const processGroup = child.pid;
  if (processGroup === undefined) {
    return {
      lingeringDescendants: false,
      signal: outcome.signal ?? null,
      spawnError: "qualification command has no owned process-group identity",
      status: outcome.status ?? null,
      timedOut: outcome.timedOut === true,
      treeEmpty: false
    };
  }
  const lingeringDescendants = outcome.timedOut !== true && posixProcessGroupRunning(processGroup);
  let treeEmpty = !posixProcessGroupRunning(processGroup);
  if (!treeEmpty) {
    treeEmpty = await terminatePosixProcessGroup(processGroup, options.terminationGraceMs);
  }
  const completedAfterTermination =
    outcome.timedOut === true
      ? await Promise.race([completion, delay(options.terminationGraceMs).then(() => null)])
      : outcome;
  const finalOutcome = completedAfterTermination ?? { signal: null, status: null };
  return {
    lingeringDescendants,
    signal: finalOutcome.signal ?? null,
    spawnError: finalOutcome.error
      ? finalOutcome.error instanceof Error
        ? finalOutcome.error.message
        : String(finalOutcome.error)
      : null,
    status: finalOutcome.status ?? null,
    timedOut: outcome.timedOut === true,
    treeEmpty: treeEmpty && completedAfterTermination !== null
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
  const systemRoot = options.environment.SYSTEMROOT ?? options.environment.WINDIR;
  if (!systemRoot || !isAbsolute(systemRoot)) {
    return {
      lingeringDescendants: false,
      signal: null,
      spawnError: "Windows process ownership requires an exact system root",
      status: null,
      timedOut: false,
      treeEmpty: true
    };
  }
  const powerShell = join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  let supervisor;
  try {
    supervisor = spawn(
      powerShell,
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
  let executable;
  try {
    executable = await openPinnedExecutable(command, options.allowedSymbolicLinkTarget);
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
  try {
    const result =
      process.platform === "win32"
        ? await runWindowsOwnedCommand(command, arguments_, options)
        : await runPosixOwnedCommand(command, arguments_, options);
    if (result.treeEmpty) {
      try {
        await verifyPinnedExecutable(executable);
      } catch (error) {
        result.spawnError ??= error instanceof Error ? error.message : String(error);
      }
    }
    return result;
  } finally {
    await closePinnedExecutable(executable);
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

async function bootstrapPythonEnvironment(
  assignmentPath,
  assignment,
  gitIdentity,
  layoutState,
  hostEnvironment,
  options
) {
  const selected = resolveAcceptancePython({
    environment: hostEnvironment,
    platform: process.platform,
    profile: "repository-command",
    repositoryRoot: assignment.worktree
  });
  const bootstrapPython = await realpath(selected);
  assertCanonicalAbsolutePath(bootstrapPython, "bootstrap Python");
  const environment = isolatedEnvironment(assignmentPath, assignment, gitIdentity, layoutState.layout, hostEnvironment);
  environment.OPEN_WRANGLER_PYTHON = bootstrapPython;
  environment.OPEN_WRANGLER_TEST_PYTHON = bootstrapPython;
  environment.PATH = `${dirname(bootstrapPython)}${delimiter}${hostEnvironment.PATH ?? ""}`;
  const creation = await runOwnedCommand(bootstrapPython, ["-I", "-m", "venv", layoutState.layout.venv], {
    cwd: assignment.worktree,
    environment,
    terminationGraceMs: options.terminationGraceMs,
    timeoutMs: 120_000
  });
  const creationFailure = resultFailure(creation, "task Python venv bootstrap");
  if (creationFailure) return { bootstrapPython, failure: creationFailure, result: creation };
  layoutState.identities.venv = await fileIdentity(layoutState.layout.venv, "directory");
  layoutState.pythonEntry = await captureVenvPythonIdentity(layoutState.layout.pythonExecutable, bootstrapPython);
  const verificationEnvironment = isolatedEnvironment(
    assignmentPath,
    assignment,
    gitIdentity,
    layoutState.layout,
    hostEnvironment
  );
  const verification = await runOwnedCommand(
    layoutState.layout.pythonExecutable,
    [
      "-I",
      "-c",
      "import os,sys; expected=os.path.realpath(sys.argv[1]); raise SystemExit(0 if os.path.realpath(sys.prefix)==expected and os.path.realpath(sys.base_prefix)!=expected else 1)",
      layoutState.layout.venv
    ],
    {
      allowedSymbolicLinkTarget: layoutState.pythonEntry.type === "symbolic-link" ? bootstrapPython : undefined,
      cwd: assignment.worktree,
      environment: verificationEnvironment,
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
  await verifyPinnedDirectory(layoutState.ownerPins.stateRoot, "stateRoot owner");
  await verifyPinnedDirectory(layoutState.ownerPins.artifacts, "artifact owner");
  for (const [key, before] of Object.entries(layoutState.identities)) {
    const path = key === "marker" ? join(dirname(layoutState.layout.home), "assignment.json") : layoutState.layout[key];
    const expectedKind = key === "marker" || key === "npmUserConfig" || key === "pipConfig" ? "file" : "directory";
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
  assignmentPath,
  command,
  environment = process.env,
  terminationGraceMs = DEFAULT_TERMINATION_GRACE_MS,
  timeoutMs = DEFAULT_COMMAND_TIMEOUT_MS,
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
      initialGit = await captureGitIdentity(assignment);
    } catch (error) {
      await worktreePin.handle.close();
      throw error;
    }
    gitOwnerPins = await openGitOwnerPins(initialGit, worktreePin);
    await verifyGitOwnerPins(gitOwnerPins);
    layoutState = await createStateLayout(assignment, initialAssignment.digest);
    const startedAt = new Date().toISOString();
    const failures = [];
    let bootstrap;
    try {
      bootstrap = await bootstrapPythonEnvironment(assignmentPath, assignment, initialGit, layoutState, environment, {
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
        environment: isolatedEnvironment(assignmentPath, assignment, initialGit, layoutState.layout, environment),
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
      finalGit = await captureGitIdentity(assignment);
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

export { ASSIGNMENT_PROTOCOL, QUALIFICATION_ENVIRONMENT_CONTRACT, RECEIPT_PROTOCOL, runQualification };

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    await runQualification(parseCommandLine(process.argv.slice(2)));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
