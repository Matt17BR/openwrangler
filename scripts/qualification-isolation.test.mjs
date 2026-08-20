import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { access, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import test from "node:test";
import { ASSIGNMENT_PROTOCOL, RECEIPT_PROTOCOL } from "./qualification-isolation.mjs";

const script = join(import.meta.dirname, "qualification-isolation.mjs");
const child = join(import.meta.dirname, "fixtures", "qualification-isolation-child.mjs");
const gitOverrideKeys = [
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_COMMON_DIR",
  "GIT_DIR",
  "GIT_INDEX_FILE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_WORK_TREE"
];

function cleanGitEnvironment() {
  const environment = { ...process.env };
  for (const key of gitOverrideKeys) {
    delete environment[key];
  }
  return environment;
}

function git(root, arguments_) {
  const result = spawnSync("git", arguments_, {
    cwd: root,
    encoding: "utf8",
    env: cleanGitEnvironment(),
    maxBuffer: 1024 * 1024,
    windowsHide: true
  });
  if (result.error) {
    throw result.error;
  }
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout.trim();
}

async function fixture(context, name = "fixture") {
  const root = realpathSync.native(await mkdtemp(join(tmpdir(), `ow-qualification-${name}-`)));
  context.after(() => rm(root, { force: true, recursive: true }));
  const repository = join(root, "repository");
  await mkdir(repository);
  git(repository, ["init", "--quiet", "--initial-branch=main"]);
  git(repository, ["config", "user.email", "qualification-test@openwrangler.invalid"]);
  git(repository, ["config", "user.name", "Open Wrangler Qualification Test"]);
  await writeFile(join(repository, "tracked.txt"), "source\n", "utf8");
  git(repository, ["add", "tracked.txt"]);
  git(repository, ["commit", "--quiet", "-m", "fixture"]);
  await mkdir(join(root, "assignments"));
  await mkdir(join(root, "states"));
  await mkdir(join(root, "worktrees"));
  return {
    base: git(repository, ["rev-parse", "HEAD"]),
    repository,
    root,
    tree: git(repository, ["rev-parse", "HEAD^{tree}"])
  };
}

async function addTask(value, taskId, overrides = {}) {
  const worktree = join(value.root, "worktrees", taskId);
  git(value.repository, ["worktree", "add", "--quiet", "--detach", worktree, value.base]);
  const branch = `qualification/${taskId}`;
  git(worktree, ["switch", "--quiet", "-c", branch]);
  const assignmentPath = join(value.root, "assignments", `${taskId}.json`);
  const assignment = {
    base: value.base,
    branch,
    head: value.base,
    issue: 728,
    protocol: ASSIGNMENT_PROTOCOL,
    runId: `run-${taskId}`,
    stateRoot: join(value.root, "states", taskId),
    taskId,
    tree: value.tree,
    worktree,
    ...overrides
  };
  await writeFile(assignmentPath, `${JSON.stringify(assignment)}\n`, { flag: "wx", mode: 0o600 });
  return { assignment, assignmentPath, branch, worktree };
}

function startRunner(task, mode, additionalArguments = [], environmentOverrides = {}) {
  const running = spawn(
    process.execPath,
    [script, "run", "--assignment", task.assignmentPath, "--", process.execPath, child, mode, ...additionalArguments],
    {
      env: { ...cleanGitEnvironment(), ...environmentOverrides },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true
    }
  );
  let stdout = "";
  let stderr = "";
  running.stdout.setEncoding("utf8");
  running.stderr.setEncoding("utf8");
  running.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  running.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  return new Promise((resolveResult, reject) => {
    running.once("error", reject);
    running.once("exit", (status, signal) => resolveResult({ signal, status, stderr, stdout }));
  });
}

async function waitFor(paths) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (paths.every((path) => existsSync(path))) {
      return;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 10));
  }
  throw new Error("timed out waiting for concurrent qualification children");
}

async function receipt(task) {
  return JSON.parse(await readFile(join(task.assignment.stateRoot, "artifacts", "qualification-receipt.json"), "utf8"));
}

test("isolates two concurrent worktree qualifications and seals their exact identities", async (context) => {
  const value = await fixture(context, "concurrent");
  const first = await addTask(value, "task-a");
  const second = await addTask(value, "task-b");
  const barrier = join(value.root, "barrier");
  const shared = join(value.root, "shared-state-that-must-stay-empty");
  await mkdir(barrier);
  await mkdir(shared);
  const release = join(barrier, "release");
  const firstReady = join(barrier, "first-ready");
  const secondReady = join(barrier, "second-ready");

  const hostileSharedEnvironment = {
    HOME: shared,
    NPM_CONFIG_CACHE: shared,
    OPEN_WRANGLER_ARTIFACTS_DIR: shared,
    OPEN_WRANGLER_BROWSER_PROFILE_ROOT: shared,
    PIP_CACHE_DIR: shared,
    PLAYWRIGHT_BROWSERS_PATH: shared,
    PYTEST_ADDOPTS: `--cache-dir=${shared}`,
    PYTHONPYCACHEPREFIX: shared,
    TEMP: shared,
    TMP: shared,
    TMPDIR: shared,
    VIRTUAL_ENV: shared,
    XDG_CACHE_HOME: shared,
    npm_config_cache: shared
  };
  const firstRun = startRunner(first, "hold", ["--ready", firstReady, "--release", release], hostileSharedEnvironment);
  const secondRun = startRunner(
    second,
    "hold",
    ["--ready", secondReady, "--release", release],
    hostileSharedEnvironment
  );
  await waitFor([firstReady, secondReady]);
  await writeFile(release, "release\n", { flag: "wx", mode: 0o600 });
  const [firstResult, secondResult] = await Promise.all([firstRun, secondRun]);
  assert.deepEqual(
    [firstResult.status, firstResult.signal, secondResult.status, secondResult.signal],
    [0, null, 0, null],
    `${firstResult.stderr}\n${secondResult.stderr}`
  );

  const firstReceipt = await receipt(first);
  const secondReceipt = await receipt(second);
  assert.equal(firstReceipt.protocol, RECEIPT_PROTOCOL);
  assert.equal(secondReceipt.protocol, RECEIPT_PROTOCOL);
  assert.equal(firstReceipt.eligible, true);
  assert.equal(secondReceipt.eligible, true);
  assert.equal(firstReceipt.identity.head, value.base);
  assert.equal(secondReceipt.identity.head, value.base);
  assert.equal(firstReceipt.identity.tree, value.tree);
  assert.equal(secondReceipt.identity.tree, value.tree);
  assert.notEqual(firstReceipt.identity.worktree.inode, secondReceipt.identity.worktree.inode);
  assert.notEqual(firstReceipt.identity.gitDirectory.path, secondReceipt.identity.gitDirectory.path);

  const mutableKeys = [
    "artifacts",
    "browserProfile",
    "corepackHome",
    "home",
    "npmCache",
    "npmPrefix",
    "pipCache",
    "playwrightBrowsers",
    "pytestCache",
    "pytestTemp",
    "pythonBytecode",
    "rCache",
    "rLibrary",
    "run",
    "ruffCache",
    "temp",
    "venv",
    "xdgCache",
    "xdgConfig",
    "xdgData",
    "xdgRuntime",
    "xdgState"
  ];
  for (const key of mutableKeys) {
    const firstSuffix = relative(first.assignment.stateRoot, firstReceipt.environment[key]);
    const secondSuffix = relative(second.assignment.stateRoot, secondReceipt.environment[key]);
    assert.ok(firstSuffix !== "" && !firstSuffix.startsWith("..") && !isAbsolute(firstSuffix));
    assert.ok(secondSuffix !== "" && !secondSuffix.startsWith("..") && !isAbsolute(secondSuffix));
    assert.notEqual(firstReceipt.environment[key], secondReceipt.environment[key]);
  }
  assert.equal(firstReceipt.environment.nodeModules, join(first.worktree, "node_modules"));
  assert.equal(secondReceipt.environment.nodeModules, join(second.worktree, "node_modules"));
  assert.equal(firstReceipt.environment.vitestCache, join(first.worktree, "node_modules", ".vite"));
  assert.equal(secondReceipt.environment.vitestCache, join(second.worktree, "node_modules", ".vite"));
  assert.notEqual(firstReceipt.environment.vitestCache, secondReceipt.environment.vitestCache);
  assert.equal(git(first.worktree, ["status", "--porcelain=v1", "--untracked-files=all"]), "");
  assert.equal(git(second.worktree, ["status", "--porcelain=v1", "--untracked-files=all"]), "");
  await access(join(firstReceipt.environment.npmCache, "child-task-a.txt"));
  await access(join(secondReceipt.environment.npmCache, "child-task-b.txt"));
  assert.equal(existsSync(join(firstReceipt.environment.npmCache, "child-task-b.txt")), false);
  assert.equal(existsSync(join(secondReceipt.environment.npmCache, "child-task-a.txt")), false);
  assert.deepEqual(await readdir(shared), []);
});

test("rejects aliased worktrees, symlinked roots, and reused state", async (context) => {
  const value = await fixture(context, "aliases");

  const aliased = await addTask(value, "aliased", { worktree: `${join(value.root, "worktrees", "aliased")}/.` });
  const aliasedResult = await startRunner(aliased, "record");
  assert.equal(aliasedResult.status, 1);
  assert.match(aliasedResult.stderr, /worktree must be a canonical absolute path/u);

  const linked = await addTask(value, "linked");
  const linkedWorktree = join(value.root, "linked-worktree");
  await symlink(linked.worktree, linkedWorktree, process.platform === "win32" ? "junction" : "dir");
  const linkedAssignmentPath = join(value.root, "assignments", "linked-alias.json");
  await writeFile(
    linkedAssignmentPath,
    `${JSON.stringify({ ...linked.assignment, runId: "run-linked-alias", stateRoot: join(value.root, "states", "linked-alias"), worktree: linkedWorktree })}\n`,
    { flag: "wx", mode: 0o600 }
  );
  const linkedResult = await startRunner(
    {
      assignment: { ...linked.assignment, stateRoot: join(value.root, "states", "linked-alias") },
      assignmentPath: linkedAssignmentPath
    },
    "record"
  );
  assert.equal(linkedResult.status, 1);
  assert.match(linkedResult.stderr, /aliased parent|symbolic link/u);

  const stateLinked = await addTask(value, "state-linked");
  const stateTarget = join(value.root, "state-target");
  await mkdir(stateTarget);
  await symlink(stateTarget, stateLinked.assignment.stateRoot, process.platform === "win32" ? "junction" : "dir");
  const stateLinkedResult = await startRunner(stateLinked, "record");
  assert.equal(stateLinkedResult.status, 1);
  assert.match(stateLinkedResult.stderr, /stateRoot already exists/u);

  const first = await addTask(value, "one-shot");
  const firstResult = await startRunner(first, "record");
  assert.equal(firstResult.status, 0, firstResult.stderr);
  const reusedAssignmentPath = join(value.root, "assignments", "one-shot-reused.json");
  await writeFile(reusedAssignmentPath, `${JSON.stringify({ ...first.assignment, runId: "run-one-shot-reused" })}\n`, {
    flag: "wx",
    mode: 0o600
  });
  const reusedResult = await startRunner(
    { assignment: first.assignment, assignmentPath: reusedAssignmentPath },
    "record"
  );
  assert.equal(reusedResult.status, 1);
  assert.match(reusedResult.stderr, /stateRoot already exists/u);

  if (process.platform !== "win32") {
    const assignmentLinked = await addTask(value, "assignment-linked");
    const assignmentAlias = join(value.root, "assignments", "assignment-symlink.json");
    await symlink(assignmentLinked.assignmentPath, assignmentAlias, "file");
    const assignmentLinkedResult = await startRunner(
      { assignment: assignmentLinked.assignment, assignmentPath: assignmentAlias },
      "record"
    );
    assert.equal(assignmentLinkedResult.status, 1);
    assert.match(assignmentLinkedResult.stderr, /symbolic link/u);
  }
});

test("marks receipts ineligible when source or assignment identity changes", async (context) => {
  const value = await fixture(context, "mutation");
  for (const [taskId, mode, expected] of [
    ["dirty-source", "mutate-worktree", /worktree must be clean/u],
    ["advanced-head", "advance-head", /HEAD, tree, or branch does not match/u],
    ["changed-assignment", "mutate-assignment", /assignment identity or bytes changed/u]
  ]) {
    const task = await addTask(value, taskId);
    const result = await startRunner(task, mode);
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, expected);
    const valueReceipt = await receipt(task);
    assert.equal(valueReceipt.eligible, false);
    assert.ok(valueReceipt.failures.some((failure) => expected.test(failure)));
  }
});

test("rejects assignments that do not bind the exact base, head, tree, and branch", async (context) => {
  const value = await fixture(context, "identity");
  for (const [taskId, override] of [
    ["wrong-base", { base: "a".repeat(40) }],
    ["wrong-head", { head: "b".repeat(40) }],
    ["wrong-tree", { tree: "c".repeat(40) }],
    ["wrong-branch", { branch: "qualification/other" }]
  ]) {
    const task = await addTask(value, taskId, override);
    const result = await startRunner(task, "record");
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Git rev-parse|HEAD, tree, or branch/u);
    assert.equal(existsSync(task.assignment.stateRoot), false);
  }
});
