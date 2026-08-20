import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, readFile, realpath, writeFile } from "node:fs/promises";
import { delimiter, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const ASSIGNMENT_PROTOCOL = "openwrangler-qualification-assignment-v1";
const RECEIPT_PROTOCOL = "openwrangler-qualification-receipt-v1";
const MAX_ASSIGNMENT_BYTES = 32 * 1024;
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
const MUTABLE_ENVIRONMENT_KEYS = new Set(
  [
    "BROWSER",
    "CHROME_USER_DATA_DIR",
    "COREPACK_HOME",
    "HOME",
    "NPM_CONFIG_CACHE",
    "NPM_CONFIG_PREFIX",
    "NPM_CONFIG_USERCONFIG",
    "OPEN_WRANGLER_ARTIFACTS_DIR",
    "OPEN_WRANGLER_BROWSER_PROFILE_ROOT",
    "OPEN_WRANGLER_PYTHON",
    "OPEN_WRANGLER_QUALIFICATION_ASSIGNMENT",
    "OPEN_WRANGLER_QUALIFICATION_RECEIPT",
    "OPEN_WRANGLER_QUALIFICATION_ROOT",
    "OPEN_WRANGLER_QUALIFICATION_RUN_ID",
    "OPEN_WRANGLER_QUALIFICATION_TASK_ID",
    "OPEN_WRANGLER_TEST_PYTHON",
    "OPEN_WRANGLER_VITEST_CACHE_DIR",
    "PIP_CACHE_DIR",
    "PLAYWRIGHT_BROWSERS_PATH",
    "PYTEST_ADDOPTS",
    "PYTHONHOME",
    "PYTHONPATH",
    "PYTHONPYCACHEPREFIX",
    "R_LIBS_USER",
    "R_USER",
    "R_USER_CACHE_DIR",
    "RUFF_CACHE_DIR",
    "TEMP",
    "TMP",
    "TMPDIR",
    "USERPROFILE",
    "VIRTUAL_ENV",
    "VITE_CACHE_DIR",
    "VITEST_CACHE_DIR",
    "XDG_CACHE_HOME",
    "XDG_CONFIG_HOME",
    "XDG_DATA_HOME",
    "XDG_RUNTIME_DIR",
    "XDG_STATE_HOME",
    "npm_config_cache",
    "npm_config_prefix",
    "npm_config_userconfig"
  ].map((value) => value.toLowerCase())
);

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
    path
  };
}

function sameIdentity(left, right) {
  return left.path === right.path && left.device === right.device && left.inode === right.inode;
}

async function readAssignment(path) {
  assertCanonicalAbsolutePath(path, "assignment path");
  const identity = await fileIdentity(path, "file");
  const bytes = await readFile(path);
  if (bytes.length === 0 || bytes.length > MAX_ASSIGNMENT_BYTES || bytes.includes(0)) {
    fail("assignment bytes are invalid");
  }
  let value;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch {
    fail("assignment is not valid JSON");
  }
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
  return { bytes, digest: sha256(bytes), identity, path, value };
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
    playwrightBrowsers: join(assignment.stateRoot, "browser", "playwright"),
    pytestCache: join(assignment.stateRoot, "python", "pytest-cache"),
    pytestTemp: join(assignment.stateRoot, "python", "pytest-temp"),
    pythonBytecode: join(assignment.stateRoot, "python", "bytecode"),
    pythonExecutable,
    rCache: join(assignment.stateRoot, "r", "cache"),
    rLibrary: join(assignment.stateRoot, "r", "library"),
    receipt: join(assignment.stateRoot, "artifacts", "qualification-receipt.json"),
    rUser: join(assignment.stateRoot, "r", "user"),
    run: join(assignment.stateRoot, "runs", assignment.runId),
    ruffCache: join(assignment.stateRoot, "python", "ruff-cache"),
    temp: join(assignment.stateRoot, "temp"),
    venv: join(assignment.stateRoot, "python", "venv"),
    vitestCache: join(assignment.worktree, "node_modules", ".vite"),
    xdgCache: join(assignment.stateRoot, "xdg", "cache"),
    xdgConfig: join(assignment.stateRoot, "xdg", "config"),
    xdgData: join(assignment.stateRoot, "xdg", "data"),
    xdgRuntime: join(assignment.stateRoot, "xdg", "runtime"),
    xdgState: join(assignment.stateRoot, "xdg", "state")
  };
  const directoryKeys = Object.keys(layout).filter(
    (key) => !["nodeModules", "npmUserConfig", "pythonExecutable", "receipt", "vitestCache"].includes(key)
  );
  const identities = {};
  for (const key of directoryKeys) {
    identities[key] = await makeDirectory(layout[key]);
  }
  await writeFile(layout.npmUserConfig, "", { encoding: "utf8", flag: "wx", mode: 0o600 });
  identities.npmUserConfig = await fileIdentity(layout.npmUserConfig, "file");
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
  return { identities, layout, stateRootIdentity };
}

function quotePytestPath(path) {
  return `'${path.replaceAll("'", `'"'"'`)}'`;
}

function isolatedEnvironment(assignmentFile, assignment, gitIdentity, layout) {
  const environment = { ...process.env };
  for (const key of Object.keys(environment)) {
    if (MUTABLE_ENVIRONMENT_KEYS.has(key.toLowerCase()) || GIT_OVERRIDE_KEYS.has(key.toUpperCase())) {
      delete environment[key];
    }
  }
  const binaryDirectory = dirname(layout.pythonExecutable);
  Object.assign(environment, {
    COREPACK_HOME: layout.corepackHome,
    GIT_DIR: gitIdentity.gitDirectory.path,
    GIT_WORK_TREE: assignment.worktree,
    HOME: layout.home,
    NPM_CONFIG_CACHE: layout.npmCache,
    NPM_CONFIG_PREFIX: layout.npmPrefix,
    NPM_CONFIG_USERCONFIG: layout.npmUserConfig,
    OPEN_WRANGLER_ARTIFACTS_DIR: layout.artifacts,
    OPEN_WRANGLER_BROWSER_PROFILE_ROOT: layout.browserProfile,
    OPEN_WRANGLER_NODE_MODULES: layout.nodeModules,
    OPEN_WRANGLER_PYTHON: layout.pythonExecutable,
    OPEN_WRANGLER_QUALIFICATION_ASSIGNMENT: assignmentFile,
    OPEN_WRANGLER_QUALIFICATION_RECEIPT: layout.receipt,
    OPEN_WRANGLER_QUALIFICATION_ROOT: assignment.stateRoot,
    OPEN_WRANGLER_QUALIFICATION_RUN_ID: assignment.runId,
    OPEN_WRANGLER_QUALIFICATION_TASK_ID: assignment.taskId,
    OPEN_WRANGLER_TEST_PYTHON: layout.pythonExecutable,
    OPEN_WRANGLER_VITEST_CACHE_DIR: layout.vitestCache,
    PATH: `${binaryDirectory}${delimiter}${process.env.PATH ?? ""}`,
    PIP_CACHE_DIR: layout.pipCache,
    PLAYWRIGHT_BROWSERS_PATH: layout.playwrightBrowsers,
    PYTEST_ADDOPTS: `--cache-dir=${quotePytestPath(layout.pytestCache)} --basetemp=${quotePytestPath(layout.pytestTemp)}`,
    PYTHONNOUSERSITE: "1",
    PYTHONPYCACHEPREFIX: layout.pythonBytecode,
    R_LIBS_USER: layout.rLibrary,
    R_USER: layout.rUser,
    R_USER_CACHE_DIR: layout.rCache,
    RUFF_CACHE_DIR: layout.ruffCache,
    TEMP: layout.temp,
    TMP: layout.temp,
    TMPDIR: layout.temp,
    USERPROFILE: layout.home,
    VIRTUAL_ENV: layout.venv,
    VITE_CACHE_DIR: layout.vitestCache,
    VITEST_CACHE_DIR: layout.vitestCache,
    XDG_CACHE_HOME: layout.xdgCache,
    XDG_CONFIG_HOME: layout.xdgConfig,
    XDG_DATA_HOME: layout.xdgData,
    XDG_RUNTIME_DIR: layout.xdgRuntime,
    XDG_STATE_HOME: layout.xdgState,
    npm_config_cache: layout.npmCache,
    npm_config_prefix: layout.npmPrefix,
    npm_config_userconfig: layout.npmUserConfig
  });
  return environment;
}

function runCommand(command, arguments_, options) {
  return new Promise((resolveResult, reject) => {
    const child = spawn(command, arguments_, {
      cwd: options.cwd,
      env: options.environment,
      shell: false,
      stdio: "inherit",
      windowsHide: true
    });
    child.once("error", reject);
    child.once("exit", (status, signal) => resolveResult({ signal, status }));
  });
}

async function verifyLayout(layoutState) {
  for (const [key, before] of Object.entries(layoutState.identities)) {
    const path = key === "marker" ? join(dirname(layoutState.layout.home), "assignment.json") : layoutState.layout[key];
    const expectedKind = key === "marker" || key === "npmUserConfig" ? "file" : "directory";
    const after = await fileIdentity(path, expectedKind);
    if (!sameIdentity(before, after)) {
      fail(`${key} identity changed during qualification`);
    }
  }
  const stateRootAfter = await fileIdentity(dirname(layoutState.layout.home), "directory");
  if (!sameIdentity(layoutState.stateRootIdentity, stateRootAfter)) {
    fail("stateRoot identity changed during qualification");
  }
}

async function writeReceipt(path, value) {
  const handle = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function runQualification({ assignmentPath, command }) {
  const initialAssignment = await readAssignment(assignmentPath);
  const assignment = initialAssignment.value;
  const initialGit = await captureGitIdentity(assignment);
  const layoutState = await createStateLayout(assignment, initialAssignment.digest);
  const startedAt = new Date().toISOString();
  const result = await runCommand(command[0], command.slice(1), {
    cwd: assignment.worktree,
    environment: isolatedEnvironment(assignmentPath, assignment, initialGit, layoutState.layout)
  });
  const failures = [];
  let finalAssignment = null;
  let finalGit = null;
  try {
    finalAssignment = await readAssignment(assignmentPath);
    if (
      finalAssignment.digest !== initialAssignment.digest ||
      !sameIdentity(initialAssignment.identity, finalAssignment.identity)
    ) {
      fail("assignment identity or bytes changed during qualification");
    }
  } catch (error) {
    failures.push(error instanceof Error ? error.message : String(error));
  }
  try {
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
  if (result.status !== 0 || result.signal !== null) {
    failures.push(
      result.signal === null
        ? `qualification command exited with status ${String(result.status)}`
        : `qualification command exited on signal ${result.signal}`
    );
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
  await writeReceipt(layoutState.layout.receipt, receipt);
  process.stdout.write(`${layoutState.layout.receipt}\n`);
  if (!eligible) {
    fail(failures.join("; "));
  }
  return receipt;
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

export { ASSIGNMENT_PROTOCOL, RECEIPT_PROTOCOL, runQualification };

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    await runQualification(parseCommandLine(process.argv.slice(2)));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
