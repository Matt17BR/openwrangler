import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { EventEmitter } from "node:events";
import {
  access,
  appendFile,
  chmod,
  copyFile,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, extname, isAbsolute, join, relative } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { Worker } from "node:worker_threads";
import {
  ASSIGNMENT_PROTOCOL,
  QUALIFICATION_ENVIRONMENT_CONTRACT,
  QUALIFICATION_ISOLATION_TEST_BOUNDARY,
  RECEIPT_PROTOCOL,
  runQualification
} from "./qualification-isolation.mjs";

const script = join(import.meta.dirname, "qualification-isolation.mjs");
const child = join(import.meta.dirname, "fixtures", "qualification-isolation-child.mjs");
const gitOverrideKeys = QUALIFICATION_ENVIRONMENT_CONTRACT.forbiddenInheritedKeys.filter(
  (key) => key === "EMAIL" || key.startsWith("GIT_")
);
const gitOverridePrefixes = QUALIFICATION_ENVIRONMENT_CONTRACT.forbiddenInheritedPrefixes;
let resolvedBootstrapPython;
let resolvedGitExecutable;

function bootstrapPython() {
  if (resolvedBootstrapPython) return resolvedBootstrapPython;
  for (const value of [process.env.OPEN_WRANGLER_PYTHON, process.env.OPEN_WRANGLER_TEST_PYTHON]) {
    if (value && isAbsolute(value) && existsSync(value)) {
      resolvedBootstrapPython = realpathSync.native(value);
      return resolvedBootstrapPython;
    }
  }
  const result = spawnSync(
    process.platform === "win32" ? "python.exe" : "python3",
    ["-c", "import sys; print(sys.executable)"],
    {
      encoding: "utf8",
      env: cleanGitEnvironment(),
      windowsHide: true
    }
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);
  resolvedBootstrapPython = realpathSync.native(result.stdout.trim());
  return resolvedBootstrapPython;
}

function gitExecutable() {
  if (resolvedGitExecutable) return resolvedGitExecutable;
  const result =
    process.platform === "win32"
      ? spawnSync("where.exe", ["git.exe"], { encoding: "utf8", env: cleanGitEnvironment(), windowsHide: true })
      : spawnSync("/bin/sh", ["-c", "command -v git"], {
          encoding: "utf8",
          env: cleanGitEnvironment(),
          windowsHide: true
        });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  resolvedGitExecutable = realpathSync.native(result.stdout.trim().split(/\r?\n/u)[0]);
  return resolvedGitExecutable;
}

function cleanGitEnvironment(source = process.env) {
  const environment = { ...source };
  for (const key of Object.keys(environment)) {
    const normalized = key.toUpperCase();
    if (gitOverrideKeys.includes(normalized) || gitOverridePrefixes.some((prefix) => normalized.startsWith(prefix))) {
      delete environment[key];
    }
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

function assignedGit(task, arguments_, environment = process.env) {
  const result = spawnSync(
    task.assignment.gitExecutable,
    ["--git-dir", task.assignment.gitDirectory, "--work-tree", task.worktree, ...arguments_],
    {
      cwd: task.worktree,
      encoding: "utf8",
      env: cleanGitEnvironment(environment),
      maxBuffer: 1024 * 1024,
      windowsHide: true
    }
  );
  if (result.error) throw result.error;
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout.trim();
}

function effectiveGitConfigSourcePaths(task, environment) {
  const result = spawnSync(
    task.assignment.gitExecutable,
    [
      "--git-dir",
      task.assignment.gitDirectory,
      "--work-tree",
      task.worktree,
      "config",
      "--show-origin",
      "--show-scope",
      "--null",
      "--list"
    ],
    {
      cwd: task.worktree,
      encoding: "utf8",
      env: cleanGitEnvironment(environment),
      maxBuffer: 4 * 1024 * 1024,
      windowsHide: true
    }
  );
  if (result.error) throw result.error;
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const fields = result.stdout.split("\0");
  assert.equal(fields.pop(), "");
  assert.equal(fields.length % 3, 0);
  const sources = new Set();
  for (let index = 0; index < fields.length; index += 3) {
    assert.match(fields[index + 1], /^file:/u);
    sources.add(fields[index + 1].slice("file:".length));
  }
  return [...sources].sort((left, right) => left.localeCompare(right));
}

async function fixture(context, name = "fixture") {
  const root = realpathSync.native(await mkdtemp(join(tmpdir(), `ow-qualification-${name}-`)));
  context.after(() => rm(root, { force: true, recursive: true }));
  const repository = join(root, "repository");
  await mkdir(repository);
  git(repository, ["init", "--quiet", "--initial-branch=main"]);
  git(repository, ["config", "user.email", "qualification-test@openwrangler.invalid"]);
  git(repository, ["config", "user.name", "Open Wrangler Qualification Test"]);
  await mkdir(join(repository, "nested"));
  await writeFile(join(repository, "nested", "fixture.txt"), "nested source\n", "utf8");
  await writeFile(join(repository, "tracked.txt"), "source\n", "utf8");
  git(repository, ["add", "nested/fixture.txt", "tracked.txt"]);
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
    gitDirectory: realpathSync.native(git(worktree, ["rev-parse", "--path-format=absolute", "--git-dir"])),
    gitExecutable: gitExecutable(),
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

async function replaceTaskAssignment(task, overrides) {
  task.assignment = { ...task.assignment, ...overrides };
  await rm(task.assignmentPath);
  await writeFile(task.assignmentPath, `${JSON.stringify(task.assignment)}\n`, { flag: "wx", mode: 0o600 });
  return task;
}

function startRunner(task, mode, additionalArguments = [], environmentOverrides = {}) {
  const running = spawn(
    process.execPath,
    [script, "run", "--assignment", task.assignmentPath, "--", process.execPath, child, mode, ...additionalArguments],
    {
      env: {
        ...cleanGitEnvironment(),
        ...environmentOverrides,
        OPEN_WRANGLER_PYTHON: bootstrapPython()
      },
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

function runnerEnvironment(overrides = {}) {
  return {
    ...cleanGitEnvironment(),
    ...overrides,
    OPEN_WRANGLER_PYTHON: bootstrapPython()
  };
}

async function receipt(task) {
  return JSON.parse(await readFile(join(task.assignment.stateRoot, "artifacts", "qualification-receipt.json"), "utf8"));
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function copiedExecutable(path) {
  await copyFile(process.execPath, path);
  await chmod(path, 0o700);
  return path;
}

async function simulatedWindowsSnapshotRunner(command, arguments_, options) {
  let childProcess;
  let launchError;
  await options.beforeSpawnForTest?.({
    executedPath: command,
    sourcePath: options.sourceCommand,
    supervisorScriptExecutedPath: options.supervisorScriptExecutedPath,
    supervisorScriptSourcePath: options.supervisorScriptSourcePath,
    strategy: options.executionStrategy
  });
  try {
    await options.verifyExecutableForSpawn();
    childProcess = spawn(command, arguments_, {
      argv0: options.launchArgv0,
      cwd: options.cwd,
      env: options.environment,
      shell: false,
      stdio: ["ignore", "ignore", "ignore"],
      windowsHide: true
    });
  } catch (error) {
    launchError = error;
  } finally {
    await options.afterSpawnForTest?.({
      child: childProcess,
      executedPath: command,
      sourcePath: options.sourceCommand,
      supervisorScriptExecutedPath: options.supervisorScriptExecutedPath,
      supervisorScriptSourcePath: options.supervisorScriptSourcePath,
      strategy: options.executionStrategy
    });
  }
  if (!childProcess) {
    return {
      lingeringDescendants: false,
      signal: null,
      spawnError: launchError instanceof Error ? launchError.message : "verified Windows snapshot was not launched",
      status: null,
      timedOut: false,
      treeEmpty: true
    };
  }
  const outcome = await new Promise((resolveOutcome) => {
    childProcess.once("error", (error) => resolveOutcome({ error }));
    childProcess.once("exit", (status, signal) => resolveOutcome({ signal, status }));
  });
  return {
    lingeringDescendants: false,
    signal: outcome.signal ?? null,
    spawnError: outcome.error?.message ?? null,
    status: outcome.status ?? null,
    timedOut: false,
    treeEmpty: true
  };
}

test("isolates two concurrent worktree qualifications and seals their exact identities", async (context) => {
  const value = await fixture(context, "concurrent");
  const first = await addTask(value, "task-a");
  const second = await addTask(value, "task-b");
  const barrier = join(value.root, "barrier");
  const shared = join(value.root, "shared-state-that-must-stay-empty");
  await mkdir(barrier);
  await mkdir(shared);
  const firstReady = join(barrier, "first-ready");
  const secondReady = join(barrier, "second-ready");

  const hostileSharedEnvironment = {
    HOME: shared,
    NPM_CONFIG_CACHE: shared,
    NODE_PATH: shared,
    OPEN_WRANGLER_ARTIFACTS_DIR: shared,
    OPEN_WRANGLER_BROWSER_PROFILE_ROOT: shared,
    OPEN_WRANGLER_TEST_PROGRESS: join(shared, "test-progress.json"),
    OPEN_WRANGLER_TEST_RESULT: join(shared, "test-result.json"),
    PIP_CACHE_DIR: shared,
    PIP_CONFIG_FILE: join(shared, "pip.conf"),
    PIP_PREFIX: shared,
    PIP_TARGET: shared,
    PLAYWRIGHT_BROWSERS_PATH: shared,
    PYTEST_ADDOPTS: `--cache-dir=${shared}`,
    PYTHONPYCACHEPREFIX: shared,
    PYTHONUSERBASE: shared,
    QUALIFICATION_SHARED_SENTINEL: shared,
    RUNNER_TEMP: shared,
    TEMP: shared,
    TMP: shared,
    TMPDIR: shared,
    VIRTUAL_ENV: shared,
    UV_CACHE_DIR: shared,
    XDG_CACHE_HOME: shared,
    npm_config_cache: shared
  };
  const commonRunOptions = {
    environment: runnerEnvironment(hostileSharedEnvironment),
    terminationGraceMs: 5_000,
    timeoutMs: 120_000,
    writeOutput: false
  };
  const [firstReceipt, secondReceipt] = await Promise.all([
    runQualification({
      ...commonRunOptions,
      assignmentPath: first.assignmentPath,
      command: [process.execPath, child, "hold", "--ready", firstReady, "--peer", secondReady]
    }),
    runQualification({
      ...commonRunOptions,
      assignmentPath: second.assignmentPath,
      command: [process.execPath, child, "hold", "--ready", secondReady, "--peer", firstReady]
    })
  ]);
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
    ...new Set([
      ...Object.values(QUALIFICATION_ENVIRONMENT_CONTRACT.privateDirectories),
      ...Object.values(QUALIFICATION_ENVIRONMENT_CONTRACT.privateFiles),
      "pytestCache",
      "pytestTemp",
      "run"
    ])
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
  await access(firstReceipt.environment.testProgress);
  await access(firstReceipt.environment.testResult);
  await access(secondReceipt.environment.testProgress);
  await access(secondReceipt.environment.testResult);
  assert.equal(existsSync(join(firstReceipt.environment.npmCache, "child-task-b.txt")), false);
  assert.equal(existsSync(join(secondReceipt.environment.npmCache, "child-task-a.txt")), false);
  assert.deepEqual(await readdir(shared), []);
});

test("strips authoritative Git controls from nested fixture commits and seals Git config identity", async (context) => {
  const value = await fixture(context, "nested-git");
  const task = await addTask(value, "nested-git");
  git(task.worktree, ["commit", "--quiet", "--allow-empty", "-m", "stale linked owner"]);
  const staleLinkedHead = git(task.worktree, ["rev-parse", "HEAD"]);
  const staleLinkedGitDirectory = realpathSync.native(
    git(task.worktree, ["rev-parse", "--path-format=absolute", "--git-dir"])
  );
  assert.notEqual(staleLinkedHead, task.assignment.head);
  const overlay = join(value.root, "authoritative-overlay.git");
  git(value.root, ["init", "--quiet", "--bare", overlay]);
  git(value.root, [
    `--git-dir=${overlay}`,
    "fetch",
    "--quiet",
    value.repository,
    `${value.base}:refs/heads/${task.branch}`
  ]);
  git(value.root, [`--git-dir=${overlay}`, "symbolic-ref", "HEAD", `refs/heads/${task.branch}`]);
  git(task.worktree, [`--git-dir=${overlay}`, `--work-tree=${task.worktree}`, "read-tree", value.base]);
  await replaceTaskAssignment(task, { gitDirectory: realpathSync.native(overlay) });
  const configPath = realpathSync.native(join(overlay, "config"));
  const fsmonitorMarker = join(value.root, "malicious-fsmonitor-ran.txt");
  const fsmonitorHelper = join(
    value.root,
    process.platform === "win32" ? "malicious-fsmonitor.cmd" : "malicious-fsmonitor"
  );
  await writeFile(
    fsmonitorHelper,
    process.platform === "win32"
      ? `@echo off\r\n>"${fsmonitorMarker}" echo invoked\r\nexit /b 1\r\n`
      : `#!/bin/sh\nprintf invoked > ${JSON.stringify(fsmonitorMarker)}\nexit 1\n`,
    { flag: "wx", mode: 0o700 }
  );
  if (process.platform !== "win32") await chmod(fsmonitorHelper, 0o700);
  assignedGit(task, ["config", "core.fsmonitor", fsmonitorHelper]);
  const configHome = join(value.root, "config-home");
  const includedConfigPath = join(configHome, "identity.inc");
  const globalConfigPath = join(configHome, ".gitconfig");
  await mkdir(configHome);
  await writeFile(
    includedConfigPath,
    "[user]\n\tname = Authoritative Included Owner\n\temail = included-owner@example.test\n",
    { flag: "wx", mode: 0o600 }
  );
  await writeFile(globalConfigPath, `[include]\n\tpath = ${includedConfigPath.replaceAll("\\", "/")}\n`, {
    flag: "wx",
    mode: 0o600
  });
  const configEnvironment = { ...process.env, HOME: configHome, XDG_CONFIG_HOME: join(configHome, "xdg") };
  const configBefore = await readFile(configPath);
  const globalConfigBefore = await readFile(globalConfigPath);
  const includedConfigBefore = await readFile(includedConfigPath);
  const effectiveBefore = {
    email: assignedGit(task, ["config", "--get", "user.email"], configEnvironment),
    name: assignedGit(task, ["config", "--get", "user.name"], configEnvironment)
  };
  const expectedConfigSources = effectiveGitConfigSourcePaths(task, configEnvironment);
  const nestedResultPath = join(task.assignment.stateRoot, "temp", "nested-git-result.json");
  const hostileToolDirectory = join(value.root, "hostile-tools");
  const hostileToolMarker = join(value.root, "hostile-git-invoked.txt");
  await mkdir(hostileToolDirectory);
  if (process.platform !== "win32") {
    await writeFile(
      join(hostileToolDirectory, "git"),
      `#!/bin/sh\nprintf invoked > '${hostileToolMarker}'\nexec '${gitExecutable()}' "$@"\n`,
      { flag: "wx", mode: 0o700 }
    );
  }
  const poisonedGitEnvironment = {
    ...Object.fromEntries(gitOverrideKeys.map((key) => [key, `inherited-${key.toLowerCase()}`])),
    EMAIL: "inherited-email@openwrangler.invalid",
    GIT_ALTERNATE_OBJECT_DIRECTORIES: join(value.root, "alternate-objects"),
    GIT_AUTHOR_EMAIL: "inherited-author@openwrangler.invalid",
    GIT_AUTHOR_NAME: "Inherited Author",
    GIT_COMMITTER_EMAIL: "inherited-committer@openwrangler.invalid",
    GIT_COMMITTER_NAME: "Inherited Committer",
    GIT_CONFIG_COUNT: "2",
    GIT_CONFIG_KEY_0: "user.name",
    GIT_CONFIG_KEY_1: "user.email",
    GIT_CONFIG_VALUE_0: "Injected Config Author",
    GIT_CONFIG_VALUE_1: "injected-config@openwrangler.invalid",
    GIT_DIR: staleLinkedGitDirectory,
    GIT_INDEX_FILE: join(staleLinkedGitDirectory, "index"),
    GIT_OBJECT_DIRECTORY: join(staleLinkedGitDirectory, "objects"),
    GIT_WORK_TREE: value.repository,
    git_config_key_2: "user.name",
    git_config_value_2: "Lowercase Injected Config Author",
    git_dir: staleLinkedGitDirectory,
    HOME: configHome,
    PATH: `${hostileToolDirectory}${delimiter}${process.env.PATH ?? ""}`
  };
  const valueReceipt = await runQualification({
    assignmentPath: task.assignmentPath,
    command: [process.execPath, child, "nested-git", "--path", nestedResultPath],
    environment: runnerEnvironment(poisonedGitEnvironment),
    terminationGraceMs: 5_000,
    timeoutMs: 120_000,
    writeOutput: false
  });

  assert.equal(valueReceipt.eligible, true);
  assert.deepEqual(await readFile(configPath), configBefore);
  assert.deepEqual(await readFile(globalConfigPath), globalConfigBefore);
  assert.deepEqual(await readFile(includedConfigPath), includedConfigBefore);
  assert.deepEqual(
    {
      email: assignedGit(task, ["config", "--get", "user.email"], configEnvironment),
      name: assignedGit(task, ["config", "--get", "user.name"], configEnvironment)
    },
    effectiveBefore
  );
  assert.deepEqual(valueReceipt.identity.gitConfig, valueReceipt.postIdentity.gitConfig);
  assert.equal(valueReceipt.identity.gitConfig.effectiveName, effectiveBefore.name);
  assert.equal(valueReceipt.identity.gitConfig.effectiveEmail, effectiveBefore.email);
  assert.deepEqual(
    valueReceipt.identity.gitConfig.sources.map((source) => source.path),
    expectedConfigSources
  );
  for (const [path, bytes] of [
    [configPath, configBefore],
    [globalConfigPath, globalConfigBefore],
    [includedConfigPath, includedConfigBefore]
  ]) {
    assert.equal(valueReceipt.identity.gitConfig.sources.find((source) => source.path === path)?.sha256, sha256(bytes));
  }
  assert.equal(existsSync(hostileToolMarker), false);
  assert.equal(existsSync(fsmonitorMarker), false);
  assert.equal(valueReceipt.environment.toolPath.includes(hostileToolDirectory), false);

  const nestedResult = JSON.parse(await readFile(nestedResultPath, "utf8"));
  assert.equal(nestedResult.authorName, "Open Wrangler nested fixture");
  assert.equal(nestedResult.authorEmail, "nested-fixture@openwrangler.invalid");
  assert.equal(nestedResult.committerName, nestedResult.authorName);
  assert.equal(nestedResult.committerEmail, nestedResult.authorEmail);
  assert.match(nestedResult.gitHome, new RegExp(`^${task.assignment.stateRoot}`, "u"));
  assert.match(nestedResult.gitXdgConfig, new RegExp(`^${task.assignment.stateRoot}`, "u"));
  assert.equal(nestedResult.nestedHeadFromWorktree, nestedResult.nestedHead);
  assert.match(nestedResult.privatePointer, /^gitdir: /u);
  assert.match(
    nestedResult.privatePointer,
    new RegExp(task.assignment.stateRoot.replaceAll(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u")
  );
  assert.equal(nestedResult.topLevelHead, task.assignment.head);
  assert.equal(nestedResult.topLevelHeadFromPrivateRoot, task.assignment.head);
  assert.equal(nestedResult.topLevelHeadFromRelativeChild, task.assignment.head);
  assert.equal(nestedResult.topLevelStatus, "");
  const nestedSuffix = relative(task.assignment.stateRoot, nestedResult.repository);
  assert.ok(nestedSuffix !== "" && !nestedSuffix.startsWith("..") && !isAbsolute(nestedSuffix));
  assert.equal(git(nestedResult.repository, ["config", "--local", "user.name"]), nestedResult.authorName);
  assert.equal(git(nestedResult.repository, ["config", "--local", "user.email"]), nestedResult.authorEmail);
  assert.equal(assignedGit(task, ["status", "--porcelain=v1", "--untracked-files=all"]), "");
});

test(
  "runs nested Git through the verified private snapshot and detects an original executable swap",
  { skip: process.platform === "win32" },
  async (context) => {
    const value = await fixture(context, "git-executable-snapshot");
    const task = await addTask(value, "git-executable-snapshot");
    const delegatedGit = join(value.root, "delegated-git");
    await writeFile(delegatedGit, `#!/bin/sh\nexec ${JSON.stringify(gitExecutable())} "$@"\n`, {
      flag: "wx",
      mode: 0o700
    });
    await replaceTaskAssignment(task, { gitExecutable: delegatedGit });
    const attackerMarker = join(value.root, "attacker-git-ran.txt");
    const nestedResultPath = join(task.assignment.stateRoot, "temp", "nested-git-result.json");
    await assert.rejects(
      runQualification({
        afterGitWrapperPreparedForTest: async ({ executableSnapshotPath, executableSourcePath }) => {
          assert.notEqual(executableSnapshotPath, executableSourcePath);
          await rename(executableSourcePath, `${executableSourcePath}.retained`);
          await writeFile(
            executableSourcePath,
            `#!/bin/sh\nprintf invoked > ${JSON.stringify(attackerMarker)}\nexit 77\n`,
            { flag: "wx", mode: 0o700 }
          );
        },
        assignmentPath: task.assignmentPath,
        command: [process.execPath, child, "nested-git", "--path", nestedResultPath],
        environment: runnerEnvironment(),
        terminationGraceMs: 5_000,
        timeoutMs: 120_000,
        writeOutput: false
      }),
      /qualification command identity changed/u
    );
    assert.equal(existsSync(attackerMarker), false);
    const nestedResult = JSON.parse(await readFile(nestedResultPath, "utf8"));
    assert.equal(nestedResult.topLevelHead, task.assignment.head);
    assert.equal(nestedResult.topLevelHeadFromPrivateRoot, task.assignment.head);
    assert.equal((await receipt(task)).eligible, false);
  }
);

test(
  "rejects a same-size Git snapshot replacement before descriptor-bound execution",
  { skip: process.platform === "win32" },
  async (context) => {
    const value = await fixture(context, "git-snapshot-replacement");
    const task = await addTask(value, "git-snapshot-replacement");
    const attackerMarker = join(value.root, "snapshot-attacker-ran.txt");
    const resultPath = join(task.assignment.stateRoot, "temp", "git-probe.txt");
    await assert.rejects(
      runQualification({
        afterGitWrapperPreparedForTest: async ({ executableSnapshotPath }) => {
          const original = await readFile(executableSnapshotPath);
          const attack = Buffer.from(
            `#!/bin/sh\nprintf invoked > ${JSON.stringify(attackerMarker)}\nexit 77\n`,
            "utf8"
          );
          assert.ok(attack.length < original.length);
          await rename(executableSnapshotPath, `${executableSnapshotPath}.retained`);
          await writeFile(
            executableSnapshotPath,
            Buffer.concat([attack, Buffer.alloc(original.length - attack.length, 0x20)]),
            {
              flag: "wx",
              mode: 0o700
            }
          );
        },
        assignmentPath: task.assignmentPath,
        command: [process.execPath, child, "git-probe", "--result", resultPath],
        environment: runnerEnvironment(),
        terminationGraceMs: 5_000,
        timeoutMs: 120_000,
        writeOutput: false
      }),
      /qualification command exited with status|qualification command identity changed/u
    );
    assert.equal(existsSync(attackerMarker), false);
    assert.equal(existsSync(resultPath), false);
    assert.equal((await receipt(task)).eligible, false);
  }
);

test("rejects Git owner overrides and unbound repositories outside the private task root", async (context) => {
  const value = await fixture(context, "git-owner-escape");
  const unrelated = join(value.root, "unrelated.git");
  git(value.root, ["init", "--quiet", "--bare", unrelated]);
  for (const [taskId, mode, path] of [
    ["git-owner-override", "git-owner-override", unrelated],
    ["git-outside-owner", "git-outside-owner", value.repository]
  ]) {
    const task = await addTask(value, taskId);
    const resultPath = join(task.assignment.stateRoot, "temp", `${taskId}.txt`);
    await assert.rejects(
      runQualification({
        assignmentPath: task.assignmentPath,
        command: [process.execPath, child, mode, "--path", path, "--result", resultPath],
        environment: runnerEnvironment(),
        terminationGraceMs: 5_000,
        timeoutMs: 120_000,
        writeOutput: false
      }),
      /qualification command exited with status/u
    );
    const valueReceipt = await receipt(task);
    assert.equal(valueReceipt.eligible, false);
    assert.equal(valueReceipt.result.treeEmpty, true);
    assert.equal(valueReceipt.result.status, 1);
    assert.match(valueReceipt.failures.join("\n"), /qualification command exited with status/u);
    assert.equal(assignedGit(task, ["status", "--porcelain=v1", "--untracked-files=all"]), "");
    assert.equal(valueReceipt.result.signal, null);
    assert.equal(existsSync(resultPath), false);
  }
});

test("rejects private-root Git commands whose operands or destinations escape the task root", async (context) => {
  const value = await fixture(context, "git-private-operands");
  const task = await addTask(value, "git-private-operands");
  const outside = join(value.root, "outside.txt");
  const outsideGit = realpathSync.native(join(value.repository, ".git"));
  const outsideConfig = join(outsideGit, "config");
  const outsideConfigBefore = await readFile(outsideConfig);
  const resultPath = join(task.assignment.stateRoot, "temp", "private-operands.txt");
  await writeFile(outside, "outside\n", { flag: "wx", mode: 0o600 });
  const valueReceipt = await runQualification({
    assignmentPath: task.assignmentPath,
    command: [
      process.execPath,
      child,
      "git-private-operand-attacks",
      "--outside",
      outside,
      "--outside-git",
      outsideGit,
      "--result",
      resultPath
    ],
    environment: runnerEnvironment(),
    terminationGraceMs: 5_000,
    timeoutMs: 120_000,
    writeOutput: false
  });
  assert.equal(valueReceipt.eligible, true);
  assert.equal(await readFile(resultPath, "utf8"), "5\n");
  assert.equal(await readFile(outside, "utf8"), "outside\n");
  assert.deepEqual(await readFile(outsideConfig), outsideConfigBefore);
});

test("rejects nested Git-admin aliases before they can redirect object writes", async (context) => {
  const value = await fixture(context, "git-private-admin-alias");
  const task = await addTask(value, "git-private-admin-alias");
  const outsideObjects = join(value.root, "outside-objects");
  const resultPath = join(task.assignment.stateRoot, "temp", "private-admin.txt");
  const valueReceipt = await runQualification({
    assignmentPath: task.assignmentPath,
    command: [
      process.execPath,
      child,
      "nested-git-admin-escape",
      "--outside-objects",
      outsideObjects,
      "--result",
      resultPath
    ],
    environment: runnerEnvironment(),
    terminationGraceMs: 5_000,
    timeoutMs: 120_000,
    writeOutput: false
  });
  assert.equal(valueReceipt.eligible, true);
  assert.deepEqual(await readdir(outsideObjects), []);
  const metadata = (await readFile(resultPath, "utf8")).trim();
  assert.match(metadata, new RegExp(`^${task.assignment.stateRoot.replaceAll(/[.*+?^${}()|[\]\\]/gu, "\\$&")}`, "u"));
  assert.match(metadata, /[/\\]git[/\\]metadata[/\\][0-9a-f]{64}\.git$/u);
});

test("suppresses inherited signing, format, external-diff, and textconv helpers", async (context) => {
  const value = await fixture(context, "git-private-helpers");
  const task = await addTask(value, "git-private-helpers");
  const configHome = join(value.root, "hostile-config-home");
  const marker = join(value.root, "hostile-helper-ran.txt");
  const helper = join(configHome, process.platform === "win32" ? "hostile-helper.cmd" : "hostile-helper");
  await mkdir(configHome, { mode: 0o700 });
  await writeFile(
    helper,
    process.platform === "win32"
      ? `@echo off\r\n>"${marker}" echo invoked\r\nexit /b 91\r\n`
      : `#!/bin/sh\nprintf invoked > ${JSON.stringify(marker)}\nexit 91\n`,
    { flag: "wx", mode: 0o700 }
  );
  if (process.platform !== "win32") await chmod(helper, 0o700);
  const configPath = join(configHome, ".gitconfig");
  const helperConfigPath = helper.replaceAll("\\", "/");
  await writeFile(
    configPath,
    [
      "[commit]",
      "\tgpgSign = true",
      "[tag]",
      "\tgpgSign = true",
      "[gpg]",
      `\tprogram = ${helperConfigPath}`,
      "[format]",
      "\tsignOff = true",
      "\tsignature = hostile-format-signature",
      "[diff]",
      `\texternal = ${helperConfigPath}`,
      "\ttrustExitCode = true",
      '[diff "qualification-attack"]',
      `\ttextconv = ${helperConfigPath}`,
      '[filter "qualification-attack"]',
      `\tclean = ${helperConfigPath}`,
      `\tprocess = ${helperConfigPath}`,
      "\trequired = true",
      `\tsmudge = ${helperConfigPath}`,
      "[interactive]",
      `\tdiffFilter = ${helperConfigPath}`,
      ""
    ].join("\n"),
    { flag: "wx", mode: 0o600 }
  );
  const resultPath = join(task.assignment.stateRoot, "temp", "private-helper-result.json");
  const valueReceipt = await runQualification({
    assignmentPath: task.assignmentPath,
    command: [process.execPath, child, "nested-git-hostile-helpers", "--result", resultPath],
    environment: runnerEnvironment({ HOME: configHome, XDG_CONFIG_HOME: join(configHome, "xdg") }),
    terminationGraceMs: 5_000,
    timeoutMs: 120_000,
    writeOutput: false
  });
  assert.equal(valueReceipt.eligible, true);
  assert.equal(existsSync(marker), false);
  const result = JSON.parse(await readFile(resultPath, "utf8"));
  assert.doesNotMatch(result.commit, /^gpgsig /mu);
  assert.doesNotMatch(result.commit, /^Signed-off-by:/mu);
  assert.match(result.diff, /^diff --git /mu);
});

test("pins repository Python and its package inventory independently for each task", async (context) => {
  const value = await fixture(context, "repository-python-tool");
  const tasks = await Promise.all([
    addTask(value, "repository-python-tool-a"),
    addTask(value, "repository-python-tool-b")
  ]);
  const completed = await Promise.all(
    tasks.map(async (task) => {
      const resultPath = join(task.assignment.stateRoot, "temp", "python-tool.json");
      const valueReceipt = await runQualification({
        assignmentPath: task.assignmentPath,
        command: [process.execPath, child, "repository-python-tool", "--result", resultPath],
        environment: runnerEnvironment(),
        terminationGraceMs: 5_000,
        timeoutMs: 120_000,
        writeOutput: false
      });
      return { result: JSON.parse(await readFile(resultPath, "utf8")), task, valueReceipt };
    })
  );
  for (const { result, task, valueReceipt } of completed) {
    assert.equal(valueReceipt.eligible, true);
    assert.equal(valueReceipt.environment.pythonToolExecutable, valueReceipt.environment.pythonExecutable);
    assert.notEqual(valueReceipt.environment.pythonToolExecutable, valueReceipt.bootstrap.bootstrapPython);
    assert.equal(result.executable, valueReceipt.environment.pythonExecutable);
    assert.equal(result.prefix, valueReceipt.environment.venv);
    assert.match(result.pytest, /^\d+\.\d+/u);
    assert.deepEqual(valueReceipt.pythonInventory.before, valueReceipt.pythonInventory.after);
    assert.equal(valueReceipt.pythonInventory.before.executable, valueReceipt.environment.pythonExecutable);
    assert.equal(valueReceipt.pythonInventory.before.prefix, valueReceipt.environment.venv);
    assert.match(valueReceipt.pythonInventory.before.payloadManifest.sha256, /^[0-9a-f]{64}$/u);
    assert.ok(valueReceipt.pythonInventory.before.payloadManifest.files > 0);
    assert.ok(valueReceipt.pythonInventory.before.payloadManifest.bytes > 0);
    assert.ok(valueReceipt.pythonInventory.before.payloadManifest.kinds["python-source"] > 0);
    assert.ok(valueReceipt.pythonInventory.before.payloadManifest.kinds["native-extension"] > 0);
    assert.ok(valueReceipt.pythonInventory.before.packages.some((package_) => package_.name === "pytest"));
    const executableSuffix = relative(valueReceipt.environment.venv, valueReceipt.environment.pythonExecutable);
    assert.ok(executableSuffix !== "" && !executableSuffix.startsWith("..") && !isAbsolute(executableSuffix));
    assert.match(valueReceipt.environment.pythonExecutable, new RegExp(`^${task.assignment.stateRoot}`, "u"));
  }
  assert.notEqual(completed[0].result.executable, completed[1].result.executable);
  assert.notEqual(
    completed[0].valueReceipt.pythonInventory.before.prefix,
    completed[1].valueReceipt.pythonInventory.before.prefix
  );
  assert.equal(
    completed[0].valueReceipt.pythonInventory.before.packageInventorySha256,
    completed[1].valueReceipt.pythonInventory.before.packageInventorySha256
  );
  assert.notEqual(
    completed[0].valueReceipt.pythonInventory.before.payloadManifest.sha256,
    completed[1].valueReceipt.pythonInventory.before.payloadManifest.sha256
  );
  assert.deepEqual(
    completed[0].valueReceipt.pythonInventory.before.packages.map(({ metadataSha256, name, version }) => ({
      metadataSha256,
      name,
      version
    })),
    completed[1].valueReceipt.pythonInventory.before.packages.map(({ metadataSha256, name, version }) => ({
      metadataSha256,
      name,
      version
    }))
  );
  for (const [index, { task, valueReceipt }] of completed.entries()) {
    const peerRoot = completed[index === 0 ? 1 : 0].task.assignment.stateRoot;
    assert.ok(valueReceipt.bootstrap.importBoundary.privateSite.startsWith(valueReceipt.environment.venv));
    assert.ok(valueReceipt.bootstrap.importBoundary.externalRoots.length > 0);
    assert.ok(
      valueReceipt.bootstrap.importBoundary.snapshotRoots.every((root) =>
        root.startsWith(valueReceipt.environment.pythonPackageSnapshot)
      )
    );
    assert.match(valueReceipt.bootstrap.importBoundary.preloadManifest.sha256, /^[0-9a-f]{64}$/u);
    assert.match(valueReceipt.bootstrap.importBoundary.sourceManifest.sha256, /^[0-9a-f]{64}$/u);
    assert.equal(
      valueReceipt.bootstrap.importBoundary.digestMapping.files,
      valueReceipt.bootstrap.importBoundary.sourceManifest.files
    );
    assert.match(valueReceipt.bootstrap.importBoundary.digestMapping.sha256, /^[0-9a-f]{64}$/u);
    assert.match(valueReceipt.bootstrap.importBoundary.venvConfiguration.version, /^3\.(?:10|11|12|13|14)\./u);
    const { minor } = valueReceipt.bootstrap.importBoundary.venvConfiguration;
    assert.equal(
      valueReceipt.bootstrap.importBoundary.runtime.version,
      valueReceipt.bootstrap.importBoundary.venvConfiguration.version
    );
    assert.equal(valueReceipt.bootstrap.importBoundary.runtime.preSitePrefixMode, minor >= 14 ? "venv" : "base");
    assert.equal(
      valueReceipt.bootstrap.importBoundary.runtime.preSitePrefix,
      minor >= 14 ? valueReceipt.environment.venv : valueReceipt.bootstrap.importBoundary.runtime.basePrefix
    );
    assert.equal(
      valueReceipt.pythonInventory.before.packages.some((package_) => package_.metadataPath.startsWith(peerRoot)),
      false
    );
    assert.match(valueReceipt.pythonInventory.before.executable, new RegExp(`^${task.assignment.stateRoot}`, "u"));
  }
});

test("admits only the supported CPython 3.10 through 3.14 pre-site contract", () => {
  for (const minor of [10, 11, 12, 13, 14]) {
    assert.equal(QUALIFICATION_ISOLATION_TEST_BOUNDARY.isSupportedCpythonVersion(3, minor), true);
    assert.equal(
      QUALIFICATION_ISOLATION_TEST_BOUNDARY.cpythonPreSitePrefixMode(3, minor),
      minor >= 14 ? "venv" : "base"
    );
  }
  for (const [major, minor] of [
    [2, 14],
    [3, 9],
    [3, 15],
    [4, 0]
  ]) {
    assert.equal(QUALIFICATION_ISOLATION_TEST_BOUNDARY.isSupportedCpythonVersion(major, minor), false);
  }
});

test("binds snapshot mode and destination identity before descriptor close", async (context) => {
  const value = await fixture(context, "python-snapshot-descriptor-binding");
  const task = await addTask(value, "python-snapshot-descriptor-binding");
  const shared = join(value.root, "descriptor-python-packages");
  const external = join(value.root, "external-mode-target.py");
  await mkdir(shared, { mode: 0o700 });
  await writeFile(join(shared, "qualification_descriptor_probe.py"), "VALUE = 1\n", { flag: "wx", mode: 0o600 });
  await writeFile(external, "VALUE = 2\n", { flag: "wx", mode: 0o600 });
  const modeBefore = Number((await lstat(external, { bigint: true })).mode & 0o777n);
  await assert.rejects(
    runQualification({
      additionalPythonPackageRootsForTest: [shared],
      afterPythonSnapshotDescriptorWriteForTest: async ({ destination }) => {
        if (!destination.endsWith("qualification_descriptor_probe.py")) return;
        await rename(destination, `${destination}.retained`);
        await symlink(external, destination, "file");
      },
      assignmentPath: task.assignmentPath,
      command: [process.execPath, child, "record"],
      environment: runnerEnvironment(),
      onlyAdditionalPythonPackageRootsForTest: true,
      terminationGraceMs: 5_000,
      timeoutMs: 120_000,
      writeOutput: false
    }),
    /Python package snapshot .* is not one private regular file/u
  );
  assert.equal(Number((await lstat(external, { bigint: true })).mode & 0o777n), modeBefore);
  assert.equal((await receipt(task)).eligible, false);
});

test("rejects a pre-seal hardlink without changing the external target mode", async (context) => {
  const value = await fixture(context, "python-snapshot-hardlink-binding");
  const task = await addTask(value, "python-snapshot-hardlink-binding");
  const shared = join(value.root, "hardlink-python-packages");
  const external = join(value.root, "external-hardlink-target.py");
  await mkdir(shared, { mode: 0o700 });
  await writeFile(join(shared, "qualification_hardlink_probe.py"), "VALUE = 1\n", { flag: "wx", mode: 0o600 });
  await writeFile(external, "VALUE = 1\n", { flag: "wx", mode: 0o600 });
  const modeBefore = Number((await lstat(external, { bigint: true })).mode & 0o777n);
  await assert.rejects(
    runQualification({
      additionalPythonPackageRootsForTest: [shared],
      afterPythonSnapshotCopyForTest: async ({ destination }) => {
        if (!destination.endsWith("qualification_hardlink_probe.py")) return;
        await rename(destination, `${destination}.retained`);
        await link(external, destination);
      },
      assignmentPath: task.assignmentPath,
      command: [process.execPath, child, "record"],
      environment: runnerEnvironment(),
      onlyAdditionalPythonPackageRootsForTest: true,
      terminationGraceMs: 5_000,
      timeoutMs: 120_000,
      writeOutput: false
    }),
    /Python package snapshot .* was not descriptor-bound before sealing/u
  );
  assert.equal(Number((await lstat(external, { bigint: true })).mode & 0o777n), modeBefore);
  assert.equal((await receipt(task)).eligible, false);
});

test("rejects a post-verification execution-namespace A-to-B-to-A restoration", async (context) => {
  const value = await fixture(context, "python-namespace-restoration");
  const task = await addTask(value, "python-namespace-restoration");
  const shared = join(value.root, "namespace-python-packages");
  const marker = join(value.root, "restored-namespace-executed.txt");
  await mkdir(shared, { mode: 0o700 });
  await writeFile(join(shared, "qualification_namespace_probe.py"), "VALUE = 1\n", { flag: "wx", mode: 0o600 });
  await assert.rejects(
    runQualification({
      additionalPythonPackageRootsForTest: [shared],
      afterPythonNamespaceVerificationForTest: async ({ snapshotRoots }) => {
        const root = snapshotRoots[0];
        const retained = `${root}.retained`;
        const attacker = `${root}.attacker`;
        await chmod(join(root, ".."), 0o700);
        await mkdir(attacker, { mode: 0o700 });
        await writeFile(
          join(attacker, "sitecustomize.py"),
          `from pathlib import Path\nPath(${JSON.stringify(marker)}).write_text('executed\\n', encoding='utf-8')\n`,
          { flag: "wx", mode: 0o400 }
        );
        await rename(root, retained);
        await rename(attacker, root);
        await rename(root, attacker);
        await rename(retained, root);
      },
      assignmentPath: task.assignmentPath,
      command: [process.execPath, child, "record"],
      environment: runnerEnvironment(),
      onlyAdditionalPythonPackageRootsForTest: true,
      terminationGraceMs: 5_000,
      timeoutMs: 120_000,
      writeOutput: false
    }),
    /Python (?:startup directory|execution namespace directory).* changed|identity changed/u
  );
  assert.equal(existsSync(marker), false);
  assert.equal((await receipt(task)).eligible, false);
});

test("snapshots package data, linked package directories, and versioned native libraries", async (context) => {
  const value = await fixture(context, "python-complete-package-payload");
  const task = await addTask(value, "python-complete-package-payload");
  const shared = join(value.root, "complete-python-packages");
  const linkedTarget = join(value.root, "linked-package-target");
  await mkdir(join(linkedTarget, "data"), { mode: 0o700, recursive: true });
  await writeFile(join(linkedTarget, "__init__.py"), "VALUE = 'linked-package'\n", { flag: "wx", mode: 0o600 });
  await writeFile(join(linkedTarget, "data", "payload.json"), '{"value":42}\n', { flag: "wx", mode: 0o600 });
  await mkdir(shared, { mode: 0o700 });
  await symlink(
    linkedTarget,
    join(shared, "qualification_linked_package"),
    process.platform === "win32" ? "junction" : "dir"
  );
  await writeFile(join(shared, "libqualification_payload.so.1.2"), "versioned-native-payload\n", {
    flag: "wx",
    mode: 0o600
  });
  await writeFile(join(shared, "qualification-package.data"), "unclassified-package-data\n", {
    flag: "wx",
    mode: 0o600
  });
  const resultPath = join(task.assignment.stateRoot, "temp", "complete-python-payload.json");
  const valueReceipt = await runQualification({
    additionalPythonPackageRootsForTest: [shared],
    assignmentPath: task.assignmentPath,
    command: [process.execPath, child, "complete-python-payload", "--result", resultPath],
    environment: runnerEnvironment(),
    onlyAdditionalPythonPackageRootsForTest: true,
    terminationGraceMs: 5_000,
    timeoutMs: 120_000,
    writeOutput: false
  });
  assert.equal(valueReceipt.eligible, true);
  assert.deepEqual(JSON.parse(await readFile(resultPath, "utf8")), {
    data: { value: 42 },
    native: "versioned-native-payload",
    value: "linked-package"
  });
  assert.ok(valueReceipt.bootstrap.importBoundary.sourceManifest.kinds["package-data"] > 0);
  assert.ok(valueReceipt.bootstrap.importBoundary.sourceManifest.kinds["native-extension"] > 0);
});

test("rejects a FIFO anywhere in a complete Python package root", async (context) => {
  if (process.platform === "win32") return context.skip("FIFO fixture requires POSIX mkfifo");
  const value = await fixture(context, "python-package-fifo");
  const task = await addTask(value, "python-package-fifo");
  const shared = join(value.root, "fifo-python-packages");
  await mkdir(shared, { mode: 0o700 });
  await writeFile(join(shared, "ordinary.py"), "VALUE = 1\n", { flag: "wx", mode: 0o600 });
  const fifo = join(shared, "unsupported.fifo");
  const created = spawnSync("mkfifo", [fifo], { env: cleanGitEnvironment(), windowsHide: true });
  assert.equal(created.status, 0, created.stderr?.toString() || created.stdout?.toString());
  await assert.rejects(
    runQualification({
      additionalPythonPackageRootsForTest: [shared],
      assignmentPath: task.assignmentPath,
      command: [process.execPath, child, "record"],
      environment: runnerEnvironment(),
      onlyAdditionalPythonPackageRootsForTest: true,
      terminationGraceMs: 5_000,
      timeoutMs: 120_000,
      writeOutput: false
    }),
    /unsupported Python package-root entry/u
  );
  assert.equal((await receipt(task)).eligible, false);
});

test("never creates a snapshot child through a replaced ancestor", async (context) => {
  if (process.platform !== "linux") return context.skip("descriptor-relative adversary is Linux-specific");
  const value = await fixture(context, "python-snapshot-parent-swap");
  const task = await addTask(value, "python-snapshot-parent-swap");
  const shared = join(value.root, "parent-swap-python-packages");
  const escaped = join(value.root, "snapshot-escape");
  await mkdir(shared, { mode: 0o700 });
  await mkdir(escaped, { mode: 0o700 });
  await writeFile(join(shared, "ordinary.py"), "VALUE = 1\n", { flag: "wx", mode: 0o600 });
  let swapped = false;
  await assert.rejects(
    runQualification({
      additionalPythonPackageRootsForTest: [shared],
      assignmentPath: task.assignmentPath,
      beforePythonSnapshotChildCreateForTest: async ({ destination }) => {
        if (swapped || !destination.endsWith("ordinary.py")) return;
        swapped = true;
        const parent = dirname(destination);
        await rename(parent, `${parent}.retained`);
        await symlink(escaped, parent, "dir");
      },
      command: [process.execPath, child, "record"],
      environment: runnerEnvironment(),
      onlyAdditionalPythonPackageRootsForTest: true,
      terminationGraceMs: 5_000,
      timeoutMs: 120_000,
      writeOutput: false
    })
  );
  assert.equal(swapped, true);
  assert.equal(existsSync(join(escaped, "ordinary.py")), false);
  assert.equal((await receipt(task)).eligible, false);
});

test("keeps a Windows snapshot child on its pinned parent after a junction-style replacement", async (context) => {
  const value = await fixture(context, "python-windows-snapshot-parent-swap");
  const task = await addTask(value, "python-windows-snapshot-parent-swap");
  const shared = join(value.root, "windows-parent-swap-python-packages");
  const escaped = join(value.root, "windows-snapshot-escape");
  await mkdir(shared, { mode: 0o700 });
  await mkdir(escaped, { mode: 0o700 });
  await writeFile(join(shared, "ordinary.py"), "VALUE = 1\n", { flag: "wx", mode: 0o600 });
  let swapped = false;
  await assert.rejects(
    runQualification({
      additionalPythonPackageRootsForTest: [shared],
      afterPythonSnapshotChildOpenForTest: async ({ destination, kind }) => {
        if (swapped || kind !== "file" || !destination.endsWith("ordinary.py")) return;
        swapped = true;
        const parent = dirname(destination);
        await rename(parent, `${parent}.retained`);
        await symlink(escaped, parent, process.platform === "win32" ? "junction" : "dir");
      },
      assignmentPath: task.assignmentPath,
      command: [process.execPath, child, "record"],
      environment: runnerEnvironment(),
      onlyAdditionalPythonPackageRootsForTest: true,
      pythonSnapshotPlatformForTest: "win32",
      terminationGraceMs: 5_000,
      timeoutMs: 120_000,
      writeOutput: false
    }),
    /Python package snapshot parent .* identity changed/u
  );
  assert.equal(swapped, true);
  assert.equal(existsSync(join(escaped, "ordinary.py")), false);
  assert.equal((await receipt(task)).eligible, false);
});

test("closes an executable snapshot reader when its first stat fails", async (context) => {
  const value = await fixture(context, "snapshot-reader-stat-failure");
  const executable = await QUALIFICATION_ISOLATION_TEST_BOUNDARY.openExecutable(gitExecutable());
  let readerClosed = false;
  try {
    await assert.rejects(
      QUALIFICATION_ISOLATION_TEST_BOUNDARY.createExecutableSnapshot(executable, value.root, {
        readerCloseForTest: async (reader) => {
          await reader.close();
          readerClosed = true;
        },
        readerStatForTest() {
          throw new Error("injected snapshot reader stat failure");
        },
        snapshotBesideOwnedExecutable: false
      }),
      /injected snapshot reader stat failure/u
    );
  } finally {
    await QUALIFICATION_ISOLATION_TEST_BOUNDARY.closePinnedExecutable(executable);
  }
  assert.equal(readerClosed, true);
});

test("preserves snapshot identity failure before its reader close failure", async (context) => {
  const value = await fixture(context, "snapshot-reader-identity-close-failure");
  const executable = await QUALIFICATION_ISOLATION_TEST_BOUNDARY.openExecutable(gitExecutable());
  try {
    await assert.rejects(
      QUALIFICATION_ISOLATION_TEST_BOUNDARY.createExecutableSnapshot(executable, value.root, {
        readerCloseForTest: async (reader) => {
          await reader.close();
          throw new Error("injected snapshot reader close failure");
        },
        async readerStatForTest(reader) {
          const value = await reader.stat({ bigint: true });
          return { ...value, ino: value.ino + 1n };
        },
        snapshotBesideOwnedExecutable: false
      }),
      (error) => {
        assert.ok(error instanceof AggregateError);
        assert.match(error.errors[0].message, /snapshot identity changed/u);
        assert.match(error.errors[1].message, /snapshot reader close failure/u);
        return true;
      }
    );
  } finally {
    await QUALIFICATION_ISOLATION_TEST_BOUNDARY.closePinnedExecutable(executable);
  }
});

test("charges Python payload path bytes before retaining a near-limit listing for sorting", async (context) => {
  const value = await fixture(context, "python-payload-preallocation-budget");
  const task = await addTask(value, "python-payload-preallocation-budget");
  const shared = join(value.root, "bounded-python-packages");
  const names = Array.from({ length: 8 }, (_, index) => `entry-${String(index).padStart(2, "0")}-${"b".repeat(96)}.py`);
  await mkdir(shared, { mode: 0o700 });
  for (const name of names) await writeFile(join(shared, name), "VALUE = 1\n", { flag: "wx", mode: 0o600 });
  let retained = 0;
  const oneEntryBytes = Buffer.byteLength(names[0]) + Buffer.byteLength(join(shared, names[0]));
  await assert.rejects(
    runQualification({
      additionalPythonPackageRootsForTest: [shared],
      afterPythonPayloadEntryRetainedForTest: async () => {
        retained += 1;
      },
      assignmentPath: task.assignmentPath,
      command: [process.execPath, child, "record"],
      environment: runnerEnvironment(),
      onlyAdditionalPythonPackageRootsForTest: true,
      pythonPayloadEntryLimitForTest: names.length,
      pythonPayloadPathByteLimitForTest: oneEntryBytes * (names.length - 1),
      terminationGraceMs: 5_000,
      timeoutMs: 120_000,
      writeOutput: false
    }),
    /retained path-byte bound/u
  );
  assert.equal(retained, names.length - 1);
  assert.equal((await receipt(task)).eligible, false);
});

test("restores and closes a sealed Python directory when chmod fails", async (context) => {
  if (process.platform === "win32") return context.skip("descriptor chmod is POSIX-only");
  const calls = [];
  let error;
  try {
    await QUALIFICATION_ISOLATION_TEST_BOUNDARY.restoreAndClosePythonDirectory(
      {
        handle: {
          async chmod() {
            calls.push("chmod");
            throw new Error("chmod-fault");
          },
          async close() {
            calls.push("close");
          }
        },
        restoreMode: 0o700
      },
      "test Python directory"
    );
  } catch (value) {
    error = value;
  }
  assert.ok(error instanceof AggregateError);
  assert.deepEqual(calls, ["chmod", "close"]);
  assert.deepEqual(
    error.errors.map((value) => value.message),
    ["chmod-fault"]
  );
});

test("reports a sealed Python directory close failure after mode restoration", async (context) => {
  if (process.platform === "win32") return context.skip("descriptor chmod is POSIX-only");
  const calls = [];
  let error;
  try {
    await QUALIFICATION_ISOLATION_TEST_BOUNDARY.restoreAndClosePythonDirectory(
      {
        handle: {
          async chmod(mode) {
            calls.push(`chmod:${mode.toString(8)}`);
          },
          async close() {
            calls.push("close");
            throw new Error("close-fault");
          }
        },
        restoreMode: 0o750
      },
      "test Python directory"
    );
  } catch (value) {
    error = value;
  }
  assert.ok(error instanceof AggregateError);
  assert.deepEqual(calls, ["chmod:750", "close"]);
  assert.deepEqual(
    error.errors.map((value) => value.message),
    ["close-fault"]
  );
});

test("aggregates Python directory restore and close failures in operation order", async (context) => {
  if (process.platform === "win32") return context.skip("descriptor chmod is POSIX-only");
  const calls = [];
  let error;
  try {
    await QUALIFICATION_ISOLATION_TEST_BOUNDARY.restoreAndClosePythonDirectory(
      {
        handle: {
          async chmod() {
            calls.push("chmod");
            throw new Error("chmod-fault");
          },
          async close() {
            calls.push("close");
            throw new Error("close-fault");
          }
        },
        restoreMode: 0o700
      },
      "test Python directory"
    );
  } catch (value) {
    error = value;
  }
  assert.ok(error instanceof AggregateError);
  assert.deepEqual(calls, ["chmod", "close"]);
  assert.deepEqual(
    error.errors.map((value) => value.message),
    ["chmod-fault", "close-fault"]
  );
});

test("rejects a package-root A-to-B-to-A restoration before site startup", async (context) => {
  const value = await fixture(context, "python-package-root-restoration");
  const task = await addTask(value, "python-package-root-restoration");
  const shared = join(value.root, "restored-python-packages");
  const retained = join(value.root, "restored-python-packages-retained");
  await mkdir(shared, { mode: 0o700 });
  await writeFile(join(shared, "restored_package.py"), "VALUE = 1\n", { flag: "wx", mode: 0o600 });
  await assert.rejects(
    runQualification({
      additionalPythonPackageRootsForTest: [shared],
      afterPythonSourceDiscoveryForTest: async ({ roots }) => {
        assert.ok(roots.includes(shared));
        await rename(shared, retained);
        await rename(retained, shared);
      },
      assignmentPath: task.assignmentPath,
      command: [process.execPath, child, "record"],
      environment: runnerEnvironment(),
      onlyAdditionalPythonPackageRootsForTest: true,
      terminationGraceMs: 5_000,
      timeoutMs: 120_000,
      writeOutput: false
    }),
    /Python package source root .* identity changed/u
  );
  assert.equal((await receipt(task)).eligible, false);
});

test("rejects a verified snapshot replacement before Python can import it", async (context) => {
  const value = await fixture(context, "python-snapshot-preimport-replacement");
  const task = await addTask(value, "python-snapshot-preimport-replacement");
  const shared = join(value.root, "snapshot-python-packages");
  const marker = join(value.root, "snapshot-replacement-executed.txt");
  await mkdir(shared, { mode: 0o700 });
  await writeFile(join(shared, "qualification_snapshot_probe.py"), "VALUE = 1\n", {
    flag: "wx",
    mode: 0o600
  });
  await assert.rejects(
    runQualification({
      additionalPythonPackageRootsForTest: [shared],
      afterPythonNamespaceVerificationForTest: async ({ payloads }) => {
        const target = payloads.find(({ path }) => path.endsWith("qualification_snapshot_probe.py"))?.path;
        assert.ok(target);
        const retained = `${target}.retained`;
        await chmod(join(target, ".."), 0o700);
        await rename(target, retained);
        await writeFile(
          target,
          `from pathlib import Path\nPath(${JSON.stringify(marker)}).write_text('executed\\n', encoding='utf-8')\n`,
          { flag: "wx", mode: 0o400 }
        );
      },
      assignmentPath: task.assignmentPath,
      command: [process.execPath, child, "record"],
      environment: runnerEnvironment(),
      onlyAdditionalPythonPackageRootsForTest: true,
      terminationGraceMs: 5_000,
      timeoutMs: 120_000,
      writeOutput: false
    }),
    /Python (?:startup directory|payload) .* changed during qualification/u
  );
  assert.equal(existsSync(marker), false);
  assert.equal((await receipt(task)).eligible, false);
});

test("shadows a symlinked ambient sitecustomize with the pinned task boundary", async (context) => {
  const value = await fixture(context, "python-symlinked-sitecustomize");
  const task = await addTask(value, "python-symlinked-sitecustomize");
  const shared = join(value.root, "sitecustomize-python-packages");
  const marker = join(value.root, "symlinked-sitecustomize-executed.txt");
  const target = join(shared, "hostile-sitecustomize.py");
  await mkdir(shared, { mode: 0o700 });
  await writeFile(
    target,
    `from pathlib import Path\nPath(${JSON.stringify(marker)}).write_text('executed\\n', encoding='utf-8')\n`,
    { flag: "wx", mode: 0o600 }
  );
  await symlink(target, join(shared, "sitecustomize.py"), "file");
  const valueReceipt = await runQualification({
    additionalPythonPackageRootsForTest: [shared],
    assignmentPath: task.assignmentPath,
    command: [process.execPath, child, "record"],
    environment: runnerEnvironment(),
    onlyAdditionalPythonPackageRootsForTest: true,
    terminationGraceMs: 5_000,
    timeoutMs: 120_000,
    writeOutput: false
  });
  assert.equal(valueReceipt.eligible, true);
  assert.equal(existsSync(marker), false);
  assert.ok(valueReceipt.bootstrap.importBoundary.snapshotRoots.length > 0);
});

test("rejects a symlinked or reparse-point package root", async (context) => {
  const value = await fixture(context, "python-linked-package-root");
  const task = await addTask(value, "python-linked-package-root");
  const target = join(value.root, "python-package-root-target");
  const linked = join(value.root, "python-package-root-linked");
  await mkdir(target, { mode: 0o700 });
  await writeFile(join(target, "linked_package.py"), "VALUE = 1\n", { flag: "wx", mode: 0o600 });
  await symlink(target, linked, process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(
    runQualification({
      additionalPythonPackageRootsForTest: [linked],
      assignmentPath: task.assignmentPath,
      command: [process.execPath, child, "record"],
      environment: runnerEnvironment(),
      terminationGraceMs: 5_000,
      timeoutMs: 120_000,
      writeOutput: false
    }),
    /Python package root .* is not one directory/u
  );
  assert.equal((await receipt(task)).eligible, false);
});

test("rejects every newly exposed Python package payload class", async (context) => {
  const value = await fixture(context, "python-inventory-mutation");
  const shared = join(value.root, "minimal-python-packages");
  await mkdir(shared, { mode: 0o700 });
  await writeFile(join(shared, "minimal_package.py"), "VALUE = 1\n", { flag: "wx", mode: 0o600 });
  for (const kind of [
    "source",
    "case-source",
    "native",
    "platform-native",
    "symlink",
    "path",
    "entry-point",
    "record"
  ]) {
    const task = await addTask(value, `python-inventory-${kind}`);
    await assert.rejects(
      runQualification({
        additionalPythonPackageRootsForTest: [shared],
        assignmentPath: task.assignmentPath,
        command: [process.execPath, child, "mutate-python-inventory", "--kind", kind],
        environment: runnerEnvironment(),
        onlyAdditionalPythonPackageRootsForTest: true,
        terminationGraceMs: 5_000,
        timeoutMs: 120_000,
        writeOutput: false
      }),
      /(?:task Python payload selection changed during qualification|Python after prelaunch directory .* changed during qualification)/u
    );
    const valueReceipt = await receipt(task);
    assert.equal(valueReceipt.eligible, false);
    assert.equal(valueReceipt.pythonInventory.after, null);
    assert.match(valueReceipt.pythonInventory.before.payloadManifest.sha256, /^[0-9a-f]{64}$/u);
  }
});

test("rejects a restored mutation of an already pinned Python payload", async (context) => {
  const value = await fixture(context, "python-payload-restored-mutation");
  const task = await addTask(value, "python-payload-restored-mutation");
  const shared = join(value.root, "minimal-python-packages");
  await mkdir(shared, { mode: 0o700 });
  await writeFile(join(shared, "minimal_package.py"), "VALUE = 1\n", { flag: "wx", mode: 0o600 });
  await assert.rejects(
    runQualification({
      additionalPythonPackageRootsForTest: [shared],
      assignmentPath: task.assignmentPath,
      command: [process.execPath, child, "replace-python-payload"],
      environment: runnerEnvironment(),
      onlyAdditionalPythonPackageRootsForTest: true,
      terminationGraceMs: 5_000,
      timeoutMs: 120_000,
      writeOutput: false
    }),
    /Python (?:after prelaunch directory|payload) .* changed during qualification/u
  );
  const valueReceipt = await receipt(task);
  assert.equal(valueReceipt.eligible, false);
  assert.equal(valueReceipt.pythonInventory.after, null);
});

test("rejects an atomic Python payload swap even when the original pathname is restored", async (context) => {
  const value = await fixture(context, "python-payload-atomic-swap");
  const task = await addTask(value, "python-payload-atomic-swap");
  const shared = join(value.root, "minimal-python-packages");
  await mkdir(shared, { mode: 0o700 });
  await writeFile(join(shared, "minimal_package.py"), "VALUE = 1\n", { flag: "wx", mode: 0o600 });
  await assert.rejects(
    runQualification({
      additionalPythonPackageRootsForTest: [shared],
      assignmentPath: task.assignmentPath,
      command: [process.execPath, child, "swap-python-payload"],
      environment: runnerEnvironment(),
      onlyAdditionalPythonPackageRootsForTest: true,
      terminationGraceMs: 5_000,
      timeoutMs: 120_000,
      writeOutput: false
    }),
    /Python (?:after prelaunch directory|payload) .* changed during qualification/u
  );
  assert.equal((await receipt(task)).eligible, false);
});

test("pins shared path configuration before startup without executing shared pth code", async (context) => {
  const value = await fixture(context, "python-preinventory-pth");
  const task = await addTask(value, "python-preinventory-pth");
  const shared = join(value.root, "shared-python-packages");
  const marker = join(value.root, "shared-pth-executed.txt");
  const linkedTarget = join(shared, "linked-target.py");
  const caseVariantSource = join(shared, "case-variant.PY");
  const platformNative = join(shared, process.platform === "win32" ? "platform-native.DLL" : "platform-native.DYLIB");
  await mkdir(shared, { mode: 0o700 });
  await writeFile(
    join(shared, "hostile.pth"),
    `import pathlib; pathlib.Path(${JSON.stringify(marker)}).write_text('executed\\n', encoding='utf-8')\n`,
    { flag: "wx", mode: 0o600 }
  );
  await writeFile(linkedTarget, "VALUE = 1\n", { flag: "wx", mode: 0o600 });
  const linkedModule = join(shared, "linked-module.py");
  await symlink(linkedTarget, linkedModule, "file");
  await writeFile(caseVariantSource, "VALUE = 2\n", { flag: "wx", mode: 0o600 });
  await writeFile(platformNative, "native-placeholder\n", { flag: "wx", mode: 0o600 });
  let preloadedPayloads;
  const valueReceipt = await runQualification({
    additionalPythonPackageRootsForTest: [shared],
    afterPythonSourceDiscoveryForTest: async ({ payloads }) => {
      preloadedPayloads = payloads;
    },
    assignmentPath: task.assignmentPath,
    command: [process.execPath, child, "record"],
    environment: runnerEnvironment(),
    onlyAdditionalPythonPackageRootsForTest: true,
    terminationGraceMs: 5_000,
    timeoutMs: 120_000,
    writeOutput: false
  });
  assert.equal(valueReceipt.eligible, true);
  assert.equal(existsSync(marker), false);
  assert.equal(valueReceipt.pythonInventory.before.sysPath.includes(shared), false);
  assert.ok(
    valueReceipt.bootstrap.importBoundary.snapshotRoots.every((root) =>
      valueReceipt.pythonInventory.before.sysPath.includes(root)
    )
  );
  assert.ok(valueReceipt.pythonInventory.before.payloadManifest.kinds["path-configuration"] > 0);
  assert.deepEqual(
    preloadedPayloads
      .filter(({ path }) => path.startsWith(`${shared}${process.platform === "win32" ? "\\" : "/"}`))
      .map(({ kind, path, target }) => ({ kind, path, target })),
    [
      { kind: "python-source", path: caseVariantSource, target: caseVariantSource },
      { kind: "path-configuration", path: join(shared, "hostile.pth"), target: join(shared, "hostile.pth") },
      { kind: "python-source", path: linkedModule, target: linkedTarget },
      { kind: "python-source", path: linkedTarget, target: linkedTarget },
      { kind: "native-extension", path: platformNative, target: platformNative }
    ].sort((left, right) => Buffer.compare(Buffer.from(left.path), Buffer.from(right.path)))
  );
});

test("rejects a pth insertion after preinventory before any startup code can run", async (context) => {
  const value = await fixture(context, "python-preinventory-pth-swap");
  const task = await addTask(value, "python-preinventory-pth-swap");
  const marker = join(value.root, "late-pth-executed.txt");
  const shared = join(value.root, "minimal-python-packages");
  await mkdir(shared, { mode: 0o700 });
  await writeFile(join(shared, "minimal_package.py"), "VALUE = 1\n", { flag: "wx", mode: 0o600 });
  await assert.rejects(
    runQualification({
      additionalPythonPackageRootsForTest: [shared],
      afterPythonPreinventoryForTest: async ({ privateSite }) => {
        await chmod(privateSite, 0o700);
        await writeFile(
          join(privateSite, "late-hostile.pth"),
          `import pathlib; pathlib.Path(${JSON.stringify(marker)}).write_text('executed\\n', encoding='utf-8')\n`,
          { flag: "wx", mode: 0o600 }
        );
      },
      assignmentPath: task.assignmentPath,
      command: [process.execPath, child, "record"],
      environment: runnerEnvironment(),
      onlyAdditionalPythonPackageRootsForTest: true,
      terminationGraceMs: 5_000,
      timeoutMs: 120_000,
      writeOutput: false
    }),
    /Python prelaunch directory .* changed during qualification/u
  );
  assert.equal(existsSync(marker), false);
  assert.equal((await receipt(task)).eligible, false);
});

test("fails hard before protected paths reopen when Python inventory loses tree ownership", async (context) => {
  const value = await fixture(context, "python-inventory-tree-ownership");
  const task = await addTask(value, "python-inventory-tree-ownership");
  const shared = join(value.root, "minimal-python-packages");
  await mkdir(shared, { mode: 0o700 });
  await writeFile(join(shared, "minimal_package.py"), "VALUE = 1\n", { flag: "wx", mode: 0o600 });
  await assert.rejects(
    runQualification({
      additionalPythonPackageRootsForTest: [shared],
      assignmentPath: task.assignmentPath,
      command: [process.execPath, child, "record"],
      environment: runnerEnvironment(),
      onlyAdditionalPythonPackageRootsForTest: true,
      pythonInventoryAfterRunnerForTest: async () => {
        await appendFile(task.assignmentPath, "\n", "utf8");
        return {
          lingeringDescendants: true,
          signal: null,
          spawnError: null,
          status: null,
          timedOut: false,
          treeEmpty: false
        };
      },
      terminationGraceMs: 5_000,
      timeoutMs: 120_000,
      writeOutput: false
    }),
    /task Python after inventory process tree could not be attested empty/u
  );
  assert.equal((await readFile(join(task.assignment.stateRoot, "artifacts", "qualification-receipt.json"))).length, 0);
});

test("routes pytest cache and temporary state through the private task root", async (context) => {
  const value = await fixture(context, "pytest-cache");
  const task = await addTask(value, "pytest-cache");
  const testFile = join(value.root, "test_private_cache.py");
  await writeFile(
    testFile,
    [
      "import os",
      "import shlex",
      "from pathlib import Path",
      "",
      "def test_private_cache(pytestconfig, tmp_path):",
      '    pytestconfig.cache.set("issue-728/proof", "private")',
      '    basetemp = next(value.split("=", 1)[1] for value in shlex.split(os.environ["PYTEST_ADDOPTS"]) if value.startswith("--basetemp="))',
      "    tmp_path.relative_to(Path(basetemp))",
      '    (tmp_path / "proof.txt").write_text("private tmp_path\\n", encoding="utf-8")',
      ""
    ].join("\n"),
    { flag: "wx", mode: 0o600 }
  );
  const valueReceipt = await runQualification({
    assignmentPath: task.assignmentPath,
    command: [bootstrapPython(), "-m", "pytest", "-q", testFile],
    environment: runnerEnvironment(),
    terminationGraceMs: 5_000,
    timeoutMs: 120_000,
    writeOutput: false
  });
  assert.equal(valueReceipt.eligible, true);
  assert.equal(valueReceipt.pytestTemp.root.path, valueReceipt.environment.pytestTempParent);
  assert.equal(valueReceipt.pytestTemp.basetemp.path, valueReceipt.environment.pytestTemp);
  assert.ok(valueReceipt.pytestTemp.directories >= 2);
  assert.ok(valueReceipt.pytestTemp.files >= 1);
  assert.ok(valueReceipt.pytestTemp.entries >= 2);
  assert.match(valueReceipt.environment.pytestCache, new RegExp(`^${task.assignment.stateRoot}`, "u"));
  assert.equal(
    relative(valueReceipt.environment.pytestTempParent, valueReceipt.environment.pytestTemp).startsWith(".."),
    false
  );
  assert.equal(
    await readFile(join(valueReceipt.environment.pytestCache, "v", "issue-728", "proof"), "utf8"),
    '"private"'
  );
  assert.equal(existsSync(join(value.root, ".pytest_cache")), false);
  assert.equal(existsSync(join(task.worktree, ".pytest_cache")), false);
});

test("receipts an absent pytest basetemp and rejects every sibling in its private parent", async (context) => {
  const value = await fixture(context, "pytest-parent-ownership");
  const absent = await addTask(value, "pytest-basetemp-absent");
  const absentReceipt = await runQualification({
    assignmentPath: absent.assignmentPath,
    command: [process.execPath, child, "record"],
    environment: runnerEnvironment(),
    terminationGraceMs: 5_000,
    timeoutMs: 120_000,
    writeOutput: false
  });
  assert.equal(absentReceipt.eligible, true);
  assert.equal(absentReceipt.pytestTemp.basetemp, null);
  assert.equal(absentReceipt.pytestTemp.entries, 0);
  assert.equal(absentReceipt.pytestTemp.pathBytes, 0);

  const sibling = await addTask(value, "pytest-parent-sibling");
  await assert.rejects(
    runQualification({
      afterCommandSettlementForTest: async () => {
        await writeFile(join(sibling.assignment.stateRoot, "python", "pytest-temp", "unreceipted"), "leftover\n", {
          flag: "wx",
          mode: 0o600
        });
      },
      assignmentPath: sibling.assignmentPath,
      command: [process.execPath, child, "record"],
      environment: runnerEnvironment(),
      terminationGraceMs: 5_000,
      timeoutMs: 120_000,
      writeOutput: false
    }),
    /pytest temporary parent contains an unreceipted sibling entry/u
  );
  assert.equal((await receipt(sibling)).eligible, false);
});

test("streams pytest entry and path limits before retaining oversized listings", async (context) => {
  const value = await fixture(context, "pytest-tree-limits");
  const makeTree = (fileNames) => [
    process.execPath,
    "-e",
    [
      'const { mkdirSync, writeFileSync } = require("node:fs");',
      "const match = process.env.PYTEST_ADDOPTS.match(/--basetemp='([^']+)'/u);",
      "if (!match) process.exit(2);",
      "mkdirSync(match[1], { recursive: false, mode: 0o700 });",
      `for (const name of ${JSON.stringify(fileNames)}) writeFileSync(require("node:path").join(match[1], name), "x");`
    ].join("")
  ];

  const exactEntries = await addTask(value, "pytest-entry-limit-exact");
  const exactEntriesReceipt = await runQualification({
    assignmentPath: exactEntries.assignmentPath,
    command: makeTree(["a", "b"]),
    environment: runnerEnvironment(),
    pytestTempLimitsForTest: { entries: 3 },
    terminationGraceMs: 5_000,
    timeoutMs: 120_000,
    writeOutput: false
  });
  assert.equal(exactEntriesReceipt.pytestTemp.entries, 3);

  const tooManyEntries = await addTask(value, "pytest-entry-limit-plus-one");
  await assert.rejects(
    runQualification({
      assignmentPath: tooManyEntries.assignmentPath,
      command: makeTree(["a", "b", "c"]),
      environment: runnerEnvironment(),
      pytestTempLimitsForTest: { entries: 3 },
      terminationGraceMs: 5_000,
      timeoutMs: 120_000,
      writeOutput: false
    }),
    /pytest temporary parent contains too many entries/u
  );
  assert.equal((await receipt(tooManyEntries)).eligible, false);

  const exactPathBytes = await addTask(value, "pytest-path-limit-exact");
  const exactPathReceipt = await runQualification({
    assignmentPath: exactPathBytes.assignmentPath,
    command: makeTree(["a"]),
    environment: runnerEnvironment(),
    pytestTempLimitsForTest: { pathBytes: 92 },
    terminationGraceMs: 5_000,
    timeoutMs: 120_000,
    writeOutput: false
  });
  assert.equal(exactPathReceipt.pytestTemp.pathBytes, 92);

  const tooManyPathBytes = await addTask(value, "pytest-path-limit-plus-one");
  await assert.rejects(
    runQualification({
      assignmentPath: tooManyPathBytes.assignmentPath,
      command: makeTree(["ab"]),
      environment: runnerEnvironment(),
      pytestTempLimitsForTest: { pathBytes: 92 },
      terminationGraceMs: 5_000,
      timeoutMs: 120_000,
      writeOutput: false
    }),
    /pytest temporary parent contains too many path bytes/u
  );
  assert.equal((await receipt(tooManyPathBytes)).eligible, false);
});

test("rejects a same-device pytest mount alias from the pinned mount inventory", async (context) => {
  const value = await fixture(context, "pytest-mount-inventory");
  const task = await addTask(value, "pytest-mount-alias");
  const devices = new Map();
  await assert.rejects(
    runQualification({
      assignmentPath: task.assignmentPath,
      command: [
        process.execPath,
        "-e",
        'const fs=require("node:fs"),p=require("node:path");const b=process.env.PYTEST_ADDOPTS.match(/--basetemp=\'([^\']+)\'/u)[1];fs.mkdirSync(p.join(b,"mounted"),{recursive:true});'
      ],
      environment: runnerEnvironment(),
      pytestTempMountIdentityForTest: async ({ handle, path }) => {
        const kind = path.endsWith("/mounted") || path.endsWith("\\mounted") ? "foreign" : "owner";
        devices.set(kind, (await handle.stat({ bigint: true })).dev);
        return kind;
      },
      terminationGraceMs: 5_000,
      timeoutMs: 120_000,
      writeOutput: false
    }),
    /pytest temporary parent contains an aliased or mounted entry/u
  );
  assert.equal(devices.get("foreign"), devices.get("owner"));
  assert.equal((await receipt(task)).eligible, false);
});

test("rejects replacement, escape, and linked leftovers in a created pytest basetemp", async (context) => {
  const value = await fixture(context, "pytest-basetemp-adversaries");
  const pytestFile = join(value.root, "test_tmp_path.py");
  await writeFile(pytestFile, 'def test_tmp_path(tmp_path):\n    (tmp_path / "owned.txt").write_text("owned\\n")\n', {
    flag: "wx",
    mode: 0o600
  });

  const replaced = await addTask(value, "pytest-basetemp-replaced");
  await assert.rejects(
    runQualification({
      assignmentPath: replaced.assignmentPath,
      command: [bootstrapPython(), "-m", "pytest", "-q", pytestFile],
      environment: runnerEnvironment(),
      pytestTempAfterOpenForTest: async ({ path }) => {
        await rename(path, `${path}.retained`);
        await mkdir(path, { mode: 0o700 });
      },
      terminationGraceMs: 5_000,
      timeoutMs: 120_000,
      writeOutput: false
    }),
    /pytest basetemp changed while it was opened/u
  );
  assert.equal((await receipt(replaced)).eligible, false);

  const escaped = await addTask(value, "pytest-basetemp-escaped");
  const escapeTarget = join(value.root, "pytest-escape-target");
  await mkdir(escapeTarget);
  await assert.rejects(
    runQualification({
      assignmentPath: escaped.assignmentPath,
      command: [
        bootstrapPython(),
        "-c",
        'import os, pathlib, shlex, sys; target = pathlib.Path(next(value.split("=", 1)[1] for value in shlex.split(os.environ["PYTEST_ADDOPTS"]) if value.startswith("--basetemp="))); target.symlink_to(sys.argv[1], target_is_directory=True)',
        escapeTarget
      ],
      environment: runnerEnvironment(),
      terminationGraceMs: 5_000,
      timeoutMs: 120_000,
      writeOutput: false
    }),
    /pytest basetemp must be one canonical non-symbolic-link directory/u
  );
  assert.equal((await receipt(escaped)).eligible, false);

  const linked = await addTask(value, "pytest-basetemp-linked");
  const linkedSource = join(value.root, "pytest-linked-source.txt");
  await writeFile(linkedSource, "outside\n", { flag: "wx", mode: 0o600 });
  await assert.rejects(
    runQualification({
      assignmentPath: linked.assignmentPath,
      command: [
        bootstrapPython(),
        "-c",
        'import os, pathlib, shlex, sys; target = pathlib.Path(next(value.split("=", 1)[1] for value in shlex.split(os.environ["PYTEST_ADDOPTS"]) if value.startswith("--basetemp="))); target.mkdir(); os.link(sys.argv[1], target / "linked.txt")',
        linkedSource
      ],
      environment: runnerEnvironment(),
      terminationGraceMs: 5_000,
      timeoutMs: 120_000,
      writeOutput: false
    }),
    /pytest temporary parent contains a linked or unsupported entry/u
  );
  assert.equal((await receipt(linked)).eligible, false);
});

test(
  "rejects an undecodable raw POSIX name before it can alias a U+FFFD entry during hardlink inspection",
  { skip: process.platform === "win32" },
  async (context) => {
    const value = await fixture(context, "pytest-raw-name");
    const task = await addTask(value, "pytest-raw-name");
    const linkedSource = join(value.root, "raw-name-external-hardlink.txt");
    await writeFile(linkedSource, "outside\n", { flag: "wx", mode: 0o600 });
    const original = await readFile(linkedSource);
    await assert.rejects(
      runQualification({
        afterCommandSettlementForTest: async () => {
          const parent = join(task.assignment.stateRoot, "python", "pytest-temp");
          const [basetemp] = await readdir(parent);
          const root = join(parent, basetemp);
          await writeFile(join(root, "\uFFFD"), "private\n", { flag: "wx", mode: 0o600 });
          await link(linkedSource, Buffer.concat([Buffer.from(`${root}/`, "utf8"), Buffer.from([0xff])]));
        },
        assignmentPath: task.assignmentPath,
        command: [
          process.execPath,
          "-e",
          "const fs=require(\"node:fs\");const b=process.env.PYTEST_ADDOPTS.match(/--basetemp='([^']+)'/u)[1];fs.mkdirSync(b,{mode:0o700});"
        ],
        environment: runnerEnvironment(),
        terminationGraceMs: 5_000,
        timeoutMs: 120_000,
        writeOutput: false
      }),
      /pytest temporary parent contains an undecodable path before inspection/u
    );
    assert.deepEqual(await readFile(linkedSource), original);
    assert.equal((await receipt(task)).eligible, false);
  }
);

test("rejects every config, output, helper, index, object, and ref escape against authoritative Git", async (context) => {
  const value = await fixture(context, "git-authoritative-mutations");
  for (const kind of [
    "config",
    "configEnv",
    "configEnvAbbreviated",
    "configParameter",
    "diffOutput",
    "diffOutputAbbreviated",
    "externalDiff",
    "externalDiffAbbreviated",
    "index",
    "object",
    "ref",
    "showOutput",
    "showShortOutput",
    "textconv",
    "textconvAbbreviated"
  ]) {
    const task = await addTask(value, `git-authoritative-${kind}`);
    const resultPath = join(task.assignment.stateRoot, "temp", `${kind}.txt`);
    await assert.rejects(
      runQualification({
        assignmentPath: task.assignmentPath,
        command: [process.execPath, child, "mutate-authoritative-git", "--kind", kind, "--result", resultPath],
        environment: runnerEnvironment(),
        terminationGraceMs: 5_000,
        timeoutMs: 120_000,
        writeOutput: false
      }),
      /qualification command exited with status/u
    );
    const valueReceipt = await receipt(task);
    assert.equal(valueReceipt.eligible, false);
    assert.equal(valueReceipt.result.treeEmpty, true);
    assert.equal(existsSync(resultPath), false);
    assert.deepEqual(valueReceipt.identity.gitConfig, valueReceipt.postIdentity.gitConfig);
    assert.deepEqual(valueReceipt.identity.gitMetadata, valueReceipt.postIdentity.gitMetadata);
    assert.ok(valueReceipt.identity.gitMetadata.gitDirectory.entries >= 1);
    assert.equal(
      valueReceipt.identity.gitMetadata.commonDirectory === null,
      valueReceipt.identity.gitDirectory.path === valueReceipt.identity.commonDirectory.path
    );
    assert.equal(assignedGit(task, ["status", "--porcelain=v1", "--untracked-files=all"]), "");
  }
});

test("receipts direct authoritative Git index, object, and ref writes as terminal mutations", async (context) => {
  const value = await fixture(context, "git-authoritative-direct-mutations");
  for (const kind of ["index", "object", "ref"]) {
    const task = await addTask(value, `git-authoritative-direct-${kind}`);
    await assert.rejects(
      runQualification({
        assignmentPath: task.assignmentPath,
        command: [process.execPath, child, "mutate-authoritative-git-direct", "--kind", kind],
        environment: runnerEnvironment(),
        terminationGraceMs: 5_000,
        timeoutMs: 120_000,
        writeOutput: false
      }),
      /Git (?:index owner bytes are invalid|object-directory owner changed|Git-directory owner changed|index or object inventory changed)/u
    );
    const valueReceipt = await receipt(task);
    assert.equal(valueReceipt.eligible, false);
    assert.ok(
      valueReceipt.failures.some((failure) =>
        /Git (?:index owner bytes are invalid|object-directory owner changed|Git-directory owner changed|index or object inventory changed)/u.test(
          failure
        )
      )
    );
  }
});

test("receipts and rejects mutation of an included effective Git config source", async (context) => {
  const value = await fixture(context, "git-config-include-mutation");
  const task = await addTask(value, "git-config-include-mutation");
  const configHome = join(value.root, "config-home");
  const includedConfig = join(configHome, "identity.inc");
  await mkdir(configHome);
  await writeFile(includedConfig, "[user]\n\tname = Included Owner\n\temail = included@example.test\n", {
    flag: "wx",
    mode: 0o600
  });
  await writeFile(join(configHome, ".gitconfig"), `[include]\n\tpath = ${includedConfig.replaceAll("\\", "/")}\n`, {
    flag: "wx",
    mode: 0o600
  });
  await assert.rejects(
    runQualification({
      assignmentPath: task.assignmentPath,
      command: [process.execPath, child, "mutate-git-config-source", "--path", includedConfig],
      environment: runnerEnvironment({ HOME: configHome, XDG_CONFIG_HOME: join(configHome, "xdg") }),
      terminationGraceMs: 5_000,
      timeoutMs: 120_000,
      writeOutput: false
    }),
    /Git config source .* (?:bytes are invalid|identity changed)/u
  );
  const valueReceipt = await receipt(task);
  assert.equal(valueReceipt.eligible, false);
  assert.equal(valueReceipt.postIdentity, null);
  assert.ok(valueReceipt.identity.gitConfig.sources.some((source) => source.path === includedConfig));
});

test("rejects invalid UTF-8 Git config origin bytes without lossy pathname substitution", () => {
  const bytes = Buffer.concat([
    Buffer.from("global\0file:/tmp/origin-", "utf8"),
    Buffer.from([0xff]),
    Buffer.from("\0user.name\nOwner\0", "utf8")
  ]);
  assert.throws(
    () => QUALIFICATION_ISOLATION_TEST_BOUNDARY.parseGitConfigManifestBytes(bytes),
    /Git config manifest is not strict UTF-8/u
  );
});

test("opens directory, regular-file, and executable owners before trusting their pathnames", async (context) => {
  const root = realpathSync.native(await mkdtemp(join(tmpdir(), "ow-qualification-open-first-")));
  context.after(() => rm(root, { force: true, recursive: true }));

  const directory = join(root, "directory");
  const retainedDirectory = join(root, "directory-retained");
  await mkdir(directory);
  await writeFile(join(directory, "owned.txt"), "owned\n", "utf8");
  await assert.rejects(
    QUALIFICATION_ISOLATION_TEST_BOUNDARY.openDirectory(directory, async () => {
      await rename(directory, retainedDirectory);
      await mkdir(directory);
    }),
    /changed while it was opened/u
  );
  assert.equal(await readFile(join(retainedDirectory, "owned.txt"), "utf8"), "owned\n");

  const regular = join(root, "assignment.json");
  const retainedRegular = join(root, "assignment-retained.json");
  await writeFile(regular, "owned\n", { flag: "wx", mode: 0o600 });
  await assert.rejects(
    QUALIFICATION_ISOLATION_TEST_BOUNDARY.openRegularFile(regular, async () => {
      await rename(regular, retainedRegular);
      await writeFile(regular, "replacement\n", { flag: "wx", mode: 0o600 });
    }),
    /changed while it was opened/u
  );
  assert.equal(await readFile(retainedRegular, "utf8"), "owned\n");

  const executable = join(root, `command${extname(process.execPath)}`);
  const retainedExecutable = join(root, `command-retained${extname(process.execPath)}`);
  await copiedExecutable(executable);
  await assert.rejects(
    QUALIFICATION_ISOLATION_TEST_BOUNDARY.openExecutable(executable, async () => {
      await rename(executable, retainedExecutable);
      await writeFile(executable, "replacement\n", { flag: "wx", mode: 0o700 });
    }),
    /changed while it was opened/u
  );
  assert.equal(sha256(await readFile(retainedExecutable)), sha256(await readFile(process.execPath)));
});

test("rejects source replacement before POSIX or Windows snapshot launch", async (context) => {
  const value = await fixture(context, "executable-snapshot");
  const expectedDigest = sha256(await readFile(process.execPath));
  for (const platform of ["linux", "win32"]) {
    const task = await addTask(value, `snapshot-${platform}`);
    const executable = await copiedExecutable(join(value.root, `command-${platform}${extname(process.execPath)}`));
    const retained = `${executable}.retained`;
    let launchedSnapshot;
    await assert.rejects(
      runQualification({
        afterCommandSpawnForTest: async ({ executedPath, sourcePath, strategy }) => {
          launchedSnapshot = { executedPath, sourcePath, strategy };
          await rm(executable, { force: true });
          await rename(retained, executable);
        },
        assignmentPath: task.assignmentPath,
        beforeCommandSpawnForTest: async ({ executedPath, sourcePath, strategy }) => {
          assert.equal(sourcePath, executable);
          assert.equal(strategy, platform === "win32" ? "private-snapshot" : "inherited-descriptor");
          assert.notEqual(executedPath, executable);
          await rename(executable, retained);
          await writeFile(executable, "replacement\n", { flag: "wx", mode: 0o700 });
        },
        command: [executable, child, "record"],
        commandPlatformForTest: platform,
        commandRunnerForTest: platform === "win32" ? simulatedWindowsSnapshotRunner : undefined,
        environment: runnerEnvironment(),
        terminationGraceMs: 5_000,
        timeoutMs: 120_000,
        writeOutput: false
      }),
      /qualification command identity changed/u
    );
    const valueReceipt = await receipt(task);
    assert.equal(valueReceipt.eligible, false);
    assert.equal(valueReceipt.result.status, null);
    assert.equal(valueReceipt.result.treeEmpty, true);
    assert.equal(existsSync(valueReceipt.environment.testResult), false);
    assert.equal(valueReceipt.result.executable.sha256, expectedDigest);
    assert.equal(valueReceipt.result.executable.sourcePath, executable);
    assert.equal(
      valueReceipt.result.executable.strategy,
      platform === "win32" ? "private-snapshot" : "inherited-descriptor"
    );
    assert.equal(launchedSnapshot.sourcePath, executable);
    assert.equal(launchedSnapshot.strategy, valueReceipt.result.executable.strategy);
    if (platform === "linux") assert.equal(launchedSnapshot.executedPath, "/proc/self/fd/4");
    assert.ok(
      relative(task.assignment.stateRoot, valueReceipt.result.executable.snapshot.path) !== "" &&
        !relative(task.assignment.stateRoot, valueReceipt.result.executable.snapshot.path).startsWith("..")
    );
    assert.equal(sha256(await readFile(executable)), expectedDigest);
  }
});

test("rejects a same-size executable snapshot replacement before launch", async (context) => {
  const value = await fixture(context, "snapshot-digest");
  const task = await addTask(value, "snapshot-digest");
  const executable = await copiedExecutable(join(value.root, `snapshot-source${extname(process.execPath)}`));
  let snapshotPath;
  await assert.rejects(
    runQualification({
      afterExecutableSnapshotWriteForTest: async (value) => {
        snapshotPath = value.snapshotPath;
        const original = await readFile(snapshotPath);
        const replacement = Buffer.alloc(original.length, 0x5a);
        const retained = `${snapshotPath}.retained`;
        await rename(snapshotPath, retained);
        await writeFile(snapshotPath, replacement, { flag: "wx", mode: 0o700 });
      },
      assignmentPath: task.assignmentPath,
      command: [executable, child, "record"],
      environment: runnerEnvironment(),
      terminationGraceMs: 5_000,
      timeoutMs: 120_000,
      writeOutput: false
    }),
    /snapshot bytes changed before launch/u
  );
  assert.ok(snapshotPath);
  const valueReceipt = await receipt(task);
  assert.equal(valueReceipt.eligible, false);
  assert.equal(valueReceipt.result.status, null);
  assert.equal(valueReceipt.result.treeEmpty, true);
  assert.equal(existsSync(valueReceipt.environment.testResult), false);
});

test(
  "executes a verified shebang snapshot through an inherited descriptor",
  { skip: process.platform !== "linux" },
  async (context) => {
    const value = await fixture(context, "shebang-snapshot");
    const task = await addTask(value, "shebang-snapshot");
    const executable = join(value.root, "qualification-command.sh");
    await writeFile(executable, `#!/bin/sh\nexec '${process.execPath}' "$@"\n`, { flag: "wx", mode: 0o700 });
    const valueReceipt = await runQualification({
      assignmentPath: task.assignmentPath,
      command: [executable, child, "record"],
      environment: runnerEnvironment(),
      terminationGraceMs: 5_000,
      timeoutMs: 120_000,
      writeOutput: false
    });
    assert.equal(valueReceipt.eligible, true);
    assert.equal(valueReceipt.result.status, 0);
    assert.equal(valueReceipt.result.treeEmpty, true);
    assert.equal(valueReceipt.result.executable.strategy, "inherited-descriptor");
    assert.equal(valueReceipt.result.executable.sha256, sha256(await readFile(executable)));
    await access(valueReceipt.environment.testResult);
  }
);

test("fails closed before launch on a non-Linux POSIX host", async (context) => {
  const value = await fixture(context, "unsupported-posix");
  const task = await addTask(value, "unsupported-posix");
  let beforeSpawnCalled = false;
  await assert.rejects(
    runQualification({
      assignmentPath: task.assignmentPath,
      beforeCommandSpawnForTest: async () => {
        beforeSpawnCalled = true;
      },
      command: [process.execPath, child, "record"],
      commandPlatformForTest: "darwin",
      environment: runnerEnvironment(),
      terminationGraceMs: 5_000,
      timeoutMs: 120_000,
      writeOutput: false
    }),
    /POSIX detached-process containment requires Linux subreaper support/u
  );
  const valueReceipt = await receipt(task);
  assert.equal(valueReceipt.eligible, false);
  assert.equal(valueReceipt.result.treeEmpty, true);
  assert.equal(beforeSpawnCalled, false);
  assert.equal(existsSync(valueReceipt.environment.testResult), false);
});

test("rejects a Windows private snapshot replacement before supervisor launch", async (context) => {
  const value = await fixture(context, "windows-snapshot-swap");
  const task = await addTask(value, "windows-snapshot-swap");
  const executable = await copiedExecutable(join(value.root, `windows-command${extname(process.execPath)}`));
  let retainedSnapshot;
  await assert.rejects(
    runQualification({
      afterCommandSpawnForTest: async ({ executedPath }) => {
        await rm(executedPath, { force: true });
        await rename(retainedSnapshot, executedPath);
      },
      assignmentPath: task.assignmentPath,
      beforeCommandSpawnForTest: async ({ executedPath, strategy }) => {
        assert.equal(strategy, "private-snapshot");
        retainedSnapshot = `${executedPath}.retained`;
        await rename(executedPath, retainedSnapshot);
        await writeFile(executedPath, "replacement\n", { flag: "wx", mode: 0o700 });
      },
      command: [executable, child, "record"],
      commandPlatformForTest: "win32",
      commandRunnerForTest: process.platform === "win32" ? undefined : simulatedWindowsSnapshotRunner,
      environment: runnerEnvironment(),
      terminationGraceMs: 5_000,
      timeoutMs: 120_000,
      writeOutput: false
    }),
    /qualification command identity changed/u
  );
  const valueReceipt = await receipt(task);
  assert.equal(valueReceipt.eligible, false);
  assert.equal(valueReceipt.result.status, null);
  assert.equal(valueReceipt.result.treeEmpty, true);
  assert.equal(existsSync(valueReceipt.environment.testResult), false);
});

test("executes the verified Windows supervisor snapshot and rejects an original-path swap", async (context) => {
  const value = await fixture(context, "windows-supervisor-snapshot");
  const task = await addTask(value, "windows-supervisor-snapshot");
  const supervisor = await copiedExecutable(join(value.root, `windows-supervisor${extname(process.execPath)}`));
  const expectedDigest = sha256(await readFile(supervisor));
  let executedSupervisorPath;
  await assert.rejects(
    runQualification({
      assignmentPath: task.assignmentPath,
      command: [process.execPath, child, "record"],
      commandPlatformForTest: "win32",
      commandRunnerForTest: async (command, arguments_, options) => {
        assert.equal(options.supervisorSourceCommand, supervisor);
        assert.notEqual(options.supervisorExecutedPath, supervisor);
        await options.verifyExecutableForSpawn();
        const original = await readFile(supervisor);
        const retained = `${supervisor}.retained`;
        await rename(supervisor, retained);
        await writeFile(supervisor, Buffer.alloc(original.length, 0x5a), { flag: "wx", mode: 0o700 });
        try {
          const launched = spawnSync(
            options.supervisorExecutedPath,
            ["-e", 'process.stdout.write("verified-supervisor\\n")'],
            {
              cwd: task.worktree,
              encoding: "utf8",
              env: options.environment,
              windowsHide: true
            }
          );
          assert.equal(launched.status, 0, launched.stderr || launched.stdout);
          assert.equal(launched.stdout, "verified-supervisor\n");
          assert.equal(sha256(await readFile(options.supervisorExecutedPath)), expectedDigest);
          executedSupervisorPath = options.supervisorExecutedPath;
        } finally {
          await rm(supervisor, { force: true });
          await rename(retained, supervisor);
        }
        return simulatedWindowsSnapshotRunner(command, arguments_, options);
      },
      environment: runnerEnvironment(),
      terminationGraceMs: 5_000,
      timeoutMs: 120_000,
      windowsSupervisorCommandForTest: supervisor,
      writeOutput: false
    }),
    /qualification command identity changed/u
  );
  const valueReceipt = await receipt(task);
  assert.equal(valueReceipt.eligible, false);
  assert.equal(valueReceipt.result.status, null);
  assert.equal(valueReceipt.result.treeEmpty, true);
  assert.ok(executedSupervisorPath);
  assert.equal(valueReceipt.result.executable.supervisor.snapshot.path, executedSupervisorPath);
  assert.equal(valueReceipt.result.executable.supervisor.sourcePath, supervisor);
  assert.equal(valueReceipt.result.executable.supervisor.sha256, expectedDigest);
  assert.equal(sha256(await readFile(supervisor)), expectedDigest);
});

test("binds the pinned Windows Job Object supervisor through venv creation and verification", async (context) => {
  const value = await fixture(context, "windows-bootstrap-supervisor");
  const task = await addTask(value, "windows-bootstrap-supervisor");
  const supervisor = await copiedExecutable(
    join(value.root, `windows-bootstrap-supervisor${extname(process.execPath)}`)
  );
  const jobScript = join(value.root, "windows-bootstrap-supervisor.ps1");
  await copyFile(join(import.meta.dirname, "windows-job-supervisor.ps1"), jobScript);
  const expectedScriptDigest = sha256(await readFile(jobScript));
  const bootstrapRecords = [];
  const valueReceipt = await runQualification({
    assignmentPath: task.assignmentPath,
    bootstrapCommandPlatformForTest: "win32",
    bootstrapCommandRunnerForTest: async (command, arguments_, options) => {
      assert.equal(options.supervisorScriptSourcePath, jobScript);
      assert.notEqual(options.supervisorScriptExecutedPath, jobScript);
      assert.equal(options.supervisorScriptRecord.sha256, expectedScriptDigest);
      bootstrapRecords.push({
        arguments_,
        jobScript: options.supervisorScriptRecord,
        supervisorScriptExecutedPath: options.supervisorScriptExecutedPath
      });
      return simulatedWindowsSnapshotRunner(command, arguments_, options);
    },
    bootstrapWindowsJobSupervisorScriptForTest: jobScript,
    bootstrapWindowsSupervisorCommandForTest: supervisor,
    command: [process.execPath, child, "record"],
    environment: runnerEnvironment(),
    terminationGraceMs: 5_000,
    timeoutMs: 120_000,
    writeOutput: false
  });
  assert.equal(valueReceipt.eligible, true);
  assert.equal(bootstrapRecords.length, 5);
  assert.ok(bootstrapRecords[0].arguments_.includes("venv"));
  assert.ok(bootstrapRecords[1].arguments_.some((argument) => argument.includes("sys.platlibdir")));
  assert.ok(bootstrapRecords[1].arguments_.includes("-S"));
  assert.ok(
    bootstrapRecords[2].arguments_.includes(
      "import os,sys; expected=os.path.realpath(sys.argv[1]); raise SystemExit(0 if os.path.realpath(sys.prefix)==expected and os.path.realpath(sys.base_prefix)!=expected else 1)"
    )
  );
  for (const record of bootstrapRecords.slice(3)) {
    assert.ok(record.arguments_.some((argument) => argument.includes("import importlib.metadata as metadata")));
    assert.equal(record.arguments_.includes("-S"), false);
  }
  for (const record of bootstrapRecords) {
    assert.equal(record.jobScript.sha256, expectedScriptDigest);
    assert.ok(record.supervisorScriptExecutedPath.startsWith(valueReceipt.environment.pythonExecutableSnapshots));
  }
  assert.equal(valueReceipt.bootstrap.result.executable.supervisor.jobScript.sha256, expectedScriptDigest);
  assert.equal(valueReceipt.bootstrap.verification.executable.supervisor.jobScript.sha256, expectedScriptDigest);
});

test("rejects supervisor identity replacement after dispatch and before final eligibility", async (context) => {
  const value = await fixture(context, "windows-supervisor-final-identity");
  for (const identity of ["source", "snapshot"]) {
    const task = await addTask(value, `windows-supervisor-final-${identity}`);
    const supervisor = await copiedExecutable(
      join(value.root, `windows-supervisor-final-${identity}${extname(process.execPath)}`)
    );
    const expectedDigest = sha256(await readFile(supervisor));
    let replacedPath;
    await assert.rejects(
      runQualification({
        assignmentPath: task.assignmentPath,
        command: [process.execPath, child, "record"],
        commandPlatformForTest: "win32",
        commandRunnerForTest: async (command, arguments_, options) => {
          const outcome = await simulatedWindowsSnapshotRunner(command, arguments_, options);
          replacedPath = identity === "source" ? options.supervisorSourceCommand : options.supervisorExecutedPath;
          const original = await readFile(replacedPath);
          await rename(replacedPath, `${replacedPath}.retained`);
          await writeFile(replacedPath, Buffer.alloc(original.length, 0x5a), { flag: "wx", mode: 0o700 });
          return outcome;
        },
        environment: runnerEnvironment(),
        terminationGraceMs: 5_000,
        timeoutMs: 120_000,
        windowsSupervisorCommandForTest: supervisor,
        writeOutput: false
      }),
      /qualification command identity changed/u
    );
    const valueReceipt = await receipt(task);
    assert.equal(valueReceipt.eligible, false);
    assert.equal(valueReceipt.result.status, 0);
    assert.equal(valueReceipt.result.treeEmpty, true);
    assert.ok(replacedPath);
    assert.equal(valueReceipt.result.executable.supervisor.sha256, expectedDigest);
    assert.match(valueReceipt.failures.join("\n"), /qualification command identity changed/u);
    await access(valueReceipt.environment.testResult);
  }
});

test("rejects a Job Object script replacement before launch without dispatching the target", async (context) => {
  const value = await fixture(context, "windows-job-script-prelaunch");
  for (const identity of ["source", "snapshot"]) {
    const task = await addTask(value, `windows-job-script-prelaunch-${identity}`);
    const supervisor = await copiedExecutable(
      join(value.root, `windows-job-script-prelaunch-supervisor-${identity}${extname(process.execPath)}`)
    );
    const jobScript = join(value.root, `windows-job-script-prelaunch-${identity}.ps1`);
    await copyFile(join(import.meta.dirname, "windows-job-supervisor.ps1"), jobScript);
    const expectedDigest = sha256(await readFile(jobScript));
    await assert.rejects(
      runQualification({
        assignmentPath: task.assignmentPath,
        beforeCommandSpawnForTest: async ({ supervisorScriptExecutedPath, supervisorScriptSourcePath }) => {
          const path = identity === "source" ? supervisorScriptSourcePath : supervisorScriptExecutedPath;
          const original = await readFile(path);
          await rename(path, `${path}.retained`);
          await writeFile(path, Buffer.alloc(original.length, 0x5a), { flag: "wx", mode: 0o600 });
        },
        command: [process.execPath, child, "record"],
        commandPlatformForTest: "win32",
        commandRunnerForTest: process.platform === "win32" ? undefined : simulatedWindowsSnapshotRunner,
        environment: runnerEnvironment(),
        terminationGraceMs: 5_000,
        timeoutMs: 120_000,
        windowsJobSupervisorScriptForTest: jobScript,
        windowsSupervisorCommandForTest: process.platform === "win32" ? undefined : supervisor,
        writeOutput: false
      }),
      /qualification command identity changed/u
    );
    const valueReceipt = await receipt(task);
    assert.equal(valueReceipt.eligible, false);
    assert.equal(valueReceipt.result.status, null);
    assert.equal(valueReceipt.result.treeEmpty, true);
    assert.equal(valueReceipt.result.executable.supervisor.jobScript.sha256, expectedDigest);
    assert.equal(existsSync(valueReceipt.environment.testResult), false);
  }
});

test("rejects a Job Object script replacement after dispatch and before final eligibility", async (context) => {
  const value = await fixture(context, "windows-job-script-final");
  for (const identity of ["source", "snapshot"]) {
    const task = await addTask(value, `windows-job-script-final-${identity}`);
    const supervisor = await copiedExecutable(
      join(value.root, `windows-job-script-final-supervisor-${identity}${extname(process.execPath)}`)
    );
    const jobScript = join(value.root, `windows-job-script-final-${identity}.ps1`);
    await copyFile(join(import.meta.dirname, "windows-job-supervisor.ps1"), jobScript);
    const expectedDigest = sha256(await readFile(jobScript));
    await assert.rejects(
      runQualification({
        afterCommandSettlementForTest: async ({ supervisorScriptExecutedPath, supervisorScriptSourcePath }) => {
          const path = identity === "source" ? supervisorScriptSourcePath : supervisorScriptExecutedPath;
          const original = await readFile(path);
          await rename(path, `${path}.retained`);
          await writeFile(path, Buffer.alloc(original.length, 0x5a), { flag: "wx", mode: 0o600 });
        },
        assignmentPath: task.assignmentPath,
        command: [process.execPath, child, "record"],
        commandPlatformForTest: "win32",
        commandRunnerForTest: process.platform === "win32" ? undefined : simulatedWindowsSnapshotRunner,
        environment: runnerEnvironment(),
        terminationGraceMs: 5_000,
        timeoutMs: 120_000,
        windowsJobSupervisorScriptForTest: jobScript,
        windowsSupervisorCommandForTest: process.platform === "win32" ? undefined : supervisor,
        writeOutput: false
      }),
      /qualification command identity changed/u
    );
    const valueReceipt = await receipt(task);
    assert.equal(valueReceipt.eligible, false);
    assert.equal(valueReceipt.result.status, 0);
    assert.equal(valueReceipt.result.treeEmpty, true);
    assert.equal(valueReceipt.result.executable.supervisor.jobScript.sha256, expectedDigest);
    assert.match(valueReceipt.failures.join("\n"), /qualification command identity changed/u);
    await access(valueReceipt.environment.testResult);
  }
});

test("builds a bounded Windows loader that pins the exact Job Object script bytes before execution", () => {
  const encoded = QUALIFICATION_ISOLATION_TEST_BOUNDARY.windowsSupervisorLoader(
    join(process.platform === "win32" ? "C:\\" : "/", "private", "job.ps1"),
    { sha256: "a".repeat(64), snapshot: { size: 1234 } },
    "load-control-token",
    "loaded-token"
  );
  const loader = Buffer.from(encoded, "base64").toString("utf16le");
  assert.match(loader, /FileShare\]::Read/u);
  assert.match(loader, /ComputeHash\(\$stream\)/u);
  assert.match(loader, /script-digest/u);
  assert.match(loader, /OPEN_WRANGLER_WINDOWS_JOB_LOAD:load-control-token/u);
  assert.match(loader, /OPEN_WRANGLER_WINDOWS_JOB_LOADED:loaded-token/u);
  assert.doesNotMatch(loader, /FileShare\]::ReadWrite/u);
});

test("parses the exact CRLF Windows loader marker and LF Job Object attestation once", async () => {
  const loadedToken = "loaded-token";
  const attestationToken = "attestation-token";
  const stream = new PassThrough();
  const signals = QUALIFICATION_ISOLATION_TEST_BOUNDARY.windowsSupervisorSignals(stream, loadedToken, attestationToken);
  stream.write(Buffer.from(`OPEN_WRANGLER_WINDOWS_JOB_LOADED:${loadedToken}\r`, "ascii"));
  stream.write(Buffer.from(`\nOPEN_WRANGLER_WINDOWS_JOB_EMPTY:${attestationToken}\n`, "ascii"));
  stream.end();
  assert.equal(await signals.loaded, true);
  assert.deepEqual(await signals.completed, { attested: true, loaded: true });

  const duplicate = new PassThrough();
  const duplicateSignals = QUALIFICATION_ISOLATION_TEST_BOUNDARY.windowsSupervisorSignals(
    duplicate,
    loadedToken,
    attestationToken
  );
  duplicate.end(
    Buffer.from(
      `OPEN_WRANGLER_WINDOWS_JOB_LOADED:${loadedToken}\r\nOPEN_WRANGLER_WINDOWS_JOB_LOADED:${loadedToken}\r\nOPEN_WRANGLER_WINDOWS_JOB_EMPTY:${attestationToken}\n`,
      "ascii"
    )
  );
  assert.deepEqual(await duplicateSignals.completed, { attested: true, loaded: false });
});

test(
  "loads the pinned Windows Job Object script before launching the qualification target",
  { skip: process.platform !== "win32" },
  async (context) => {
    const value = await fixture(context, "windows-loader-launch");
    const task = await addTask(value, "windows-loader-launch");
    const valueReceipt = await runQualification({
      assignmentPath: task.assignmentPath,
      command: [process.execPath, child, "record"],
      environment: runnerEnvironment(),
      terminationGraceMs: 5_000,
      timeoutMs: 120_000,
      writeOutput: false
    });
    assert.equal(valueReceipt.eligible, true);
    assert.equal(valueReceipt.result.status, 0);
    assert.equal(valueReceipt.result.treeEmpty, true);
    assert.ok(valueReceipt.result.executable.supervisor.jobScript);
    await access(valueReceipt.environment.testResult);
  }
);

test(
  "rejects a Windows Job Object script replacement after spawn and before the pinned loader opens it",
  { skip: process.platform !== "win32" },
  async (context) => {
    const value = await fixture(context, "windows-job-script-before-load");
    for (const identity of ["source", "snapshot"]) {
      const task = await addTask(value, `windows-job-script-before-load-${identity}`);
      const jobScript = join(value.root, `windows-job-script-before-load-${identity}.ps1`);
      const attackerMarker = join(value.root, `windows-job-script-attacker-${identity}.txt`);
      await copyFile(join(import.meta.dirname, "windows-job-supervisor.ps1"), jobScript);
      await assert.rejects(
        runQualification({
          beforeWindowsLoaderReleaseForTest: async ({ supervisorScriptExecutedPath, supervisorScriptSourcePath }) => {
            const path = identity === "source" ? supervisorScriptSourcePath : supervisorScriptExecutedPath;
            const original = await readFile(path);
            const attack = Buffer.from(
              `[IO.File]::WriteAllText('${attackerMarker.replaceAll("'", "''")}','attacker')\n`,
              "utf8"
            );
            assert.ok(attack.length < original.length);
            await rename(path, `${path}.retained`);
            await writeFile(path, Buffer.concat([attack, Buffer.alloc(original.length - attack.length, 0x20)]), {
              flag: "wx",
              mode: 0o600
            });
          },
          assignmentPath: task.assignmentPath,
          command: [process.execPath, child, "record"],
          environment: runnerEnvironment(),
          terminationGraceMs: 5_000,
          timeoutMs: 120_000,
          windowsJobSupervisorScriptForTest: jobScript,
          writeOutput: false
        }),
        /process tree could not be attested empty/u
      );
      assert.equal(existsSync(attackerMarker), false);
      assert.equal(
        existsSync(join(task.assignment.stateRoot, "runs", task.assignment.runId, "test-result.json")),
        false
      );
      assert.equal(
        (await readFile(join(task.assignment.stateRoot, "artifacts", "qualification-receipt.json"))).length,
        0
      );
    }
  }
);

test(
  "does not claim a Windows process tree empty when the Job Object script omits attestation",
  { skip: process.platform !== "win32" },
  async (context) => {
    const value = await fixture(context, "windows-job-missing-attestation");
    const task = await addTask(value, "windows-job-missing-attestation");
    const jobScript = join(value.root, "windows-job-missing-attestation.ps1");
    await writeFile(jobScript, "$null=[Console]::In.ReadLine();[Environment]::Exit(0)\n", { flag: "wx", mode: 0o600 });
    await assert.rejects(
      runQualification({
        assignmentPath: task.assignmentPath,
        command: [process.execPath, child, "record"],
        environment: runnerEnvironment(),
        terminationGraceMs: 5_000,
        timeoutMs: 120_000,
        windowsJobSupervisorScriptForTest: jobScript,
        writeOutput: false
      }),
      /process tree could not be attested empty/u
    );
    assert.equal(existsSync(join(task.assignment.stateRoot, "runs", task.assignment.runId, "test-result.json")), false);
    assert.equal(
      (await readFile(join(task.assignment.stateRoot, "artifacts", "qualification-receipt.json"))).length,
      0
    );
  }
);

test("derives the Windows supervisor root independently of inherited Windows paths", () => {
  assert.equal(
    QUALIFICATION_ISOLATION_TEST_BOUNDARY.windowsSystemRootCandidate("C:\\hostedtoolcache\\node\\node.exe"),
    "C:\\Windows"
  );
  assert.equal(QUALIFICATION_ISOLATION_TEST_BOUNDARY.windowsSystemRootCandidate("D:\\tools\\node.exe"), "D:\\Windows");
});

test(
  "ignores hostile inherited Windows roots when launching the pinned supervisor",
  { skip: process.platform !== "win32" },
  async (context) => {
    const value = await fixture(context, "windows-supervisor-root");
    const task = await addTask(value, "windows-supervisor-root");
    const hostileRoot = join(value.root, "hostile-windows-root");
    const valueReceipt = await runQualification({
      assignmentPath: task.assignmentPath,
      command: [process.execPath, child, "record"],
      environment: runnerEnvironment({ SYSTEMROOT: hostileRoot, WINDIR: hostileRoot }),
      terminationGraceMs: 5_000,
      timeoutMs: 120_000,
      writeOutput: false
    });
    assert.equal(valueReceipt.eligible, true);
    assert.notEqual(valueReceipt.environment.windowsSystemRoot, hostileRoot);
    assert.ok(valueReceipt.result.executable.supervisor);
  }
);

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
  assert.match(linkedResult.stderr, /aliased parent|symbolic[- ]link/u);

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
    assert.match(assignmentLinkedResult.stderr, /symbolic link|singly linked regular file/u);
  }
});

test("marks receipts ineligible when source or assignment identity changes", async (context) => {
  const value = await fixture(context, "mutation");
  for (const [taskId, mode, expected] of [
    ["dirty-source", "mutate-worktree", /worktree must be clean/u],
    ["advanced-head", "advance-head", /Git index owner bytes are invalid|HEAD, tree, or branch does not match/u],
    ["changed-assignment", "mutate-assignment", /assignment identity(?: or bytes)? changed/u]
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

test("publishes an ineligible pinned receipt when the qualification command cannot spawn", async (context) => {
  const value = await fixture(context, "spawn-failure");
  const task = await addTask(value, "missing-command");
  const missing = join(value.root, "does-not-exist");
  const result = await spawnRunnerCommand(task, [missing]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /could not start/u);
  const valueReceipt = await receipt(task);
  assert.equal(valueReceipt.eligible, false);
  assert.equal(valueReceipt.result.treeEmpty, true);
  assert.ok(valueReceipt.result.spawnError);
  assert.equal(valueReceipt.postIdentity.head, value.base);
  assert.equal(valueReceipt.postIdentity.tree, value.tree);
});

test("terminates an escaping descendant, blocks post-exit mutation, and bounds hung commands", async (context) => {
  const value = await fixture(context, "process-tree");
  const descendantTask = await addTask(value, "descendant");
  const tracked = join(descendantTask.worktree, "tracked.txt");
  await assert.rejects(
    runQualification({
      assignmentPath: descendantTask.assignmentPath,
      command: [process.execPath, child, "escape-parent", "--path", tracked],
      environment: runnerEnvironment(),
      terminationGraceMs: 250,
      timeoutMs: 500,
      writeOutput: false
    }),
    /descendants|hard timeout/u
  );
  const descendantReceipt = await receipt(descendantTask);
  assert.equal(descendantReceipt.eligible, false);
  assert.equal(descendantReceipt.result.treeEmpty, true);
  assert.ok(descendantReceipt.result.lingeringDescendants || descendantReceipt.result.timedOut);
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 2200));
  assert.equal(await readFile(tracked, "utf8"), "source\n");

  const nestedTask = await addTask(value, "nested-descendant");
  const nestedTracked = join(nestedTask.worktree, "tracked.txt");
  await assert.rejects(
    runQualification({
      assignmentPath: nestedTask.assignmentPath,
      command: [process.execPath, child, "escape-nested-parent", "--path", nestedTracked],
      environment: runnerEnvironment(),
      terminationGraceMs: 250,
      timeoutMs: 500,
      writeOutput: false
    }),
    /descendants|hard timeout/u
  );
  const nestedReceipt = await receipt(nestedTask);
  assert.equal(nestedReceipt.eligible, false);
  assert.equal(nestedReceipt.result.lingeringDescendants, true);
  assert.equal(nestedReceipt.result.treeEmpty, true);
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 2200));
  assert.equal(await readFile(nestedTracked, "utf8"), "source\n");

  const hungTask = await addTask(value, "hung");
  await assert.rejects(
    runQualification({
      assignmentPath: hungTask.assignmentPath,
      command: [process.execPath, child, "hang"],
      environment: runnerEnvironment(),
      terminationGraceMs: 250,
      timeoutMs: 250,
      writeOutput: false
    }),
    /hard timeout/u
  );
  const hungReceipt = await receipt(hungTask);
  assert.equal(hungReceipt.eligible, false);
  assert.equal(hungReceipt.result.timedOut, true);
  assert.equal(hungReceipt.result.treeEmpty, true);
});

test("bounds a never-settling forced close after both termination signals", async () => {
  const signals = [];
  let stdinDestroyed = false;
  const started = Date.now();
  const result = await QUALIFICATION_ISOLATION_TEST_BOUNDARY.terminateAndAwaitProcess(
    {
      kill(signal) {
        signals.push(signal);
        return true;
      },
      stdin: {
        destroy() {
          stdinDestroyed = true;
        }
      }
    },
    new Promise(() => {}),
    20
  );
  assert.equal(result, null);
  assert.equal(stdinDestroyed, true);
  assert.deepEqual(signals, ["SIGTERM", "SIGKILL"]);
  assert.ok(Date.now() - started < 1_000, "forced close exceeded its bounded wait");
});

test("delegates package-root discovery to the owned worker", async () => {
  const candidate = join(tmpdir(), "not-inspected-on-the-main-thread");
  let workerOptions;
  class ResultWorker extends EventEmitter {
    terminate() {
      return Promise.resolve(0);
    }
  }
  const value = await QUALIFICATION_ISOLATION_TEST_BOUNDARY.discoverPythonPayloads([candidate], "/unused", {
    includeVenv: false,
    requireDirectoryRoots: true,
    timeoutMilliseconds: 100,
    workerFactoryForTest(_url, options) {
      workerOptions = options;
      const worker = new ResultWorker();
      setImmediate(() =>
        worker.emit("message", {
          protocol: "openwrangler-python-payload-scan-v1",
          type: "result",
          value: { directories: [], linkedDirectories: [], payloads: [], roots: [candidate], snapshots: [] }
        })
      );
      return worker;
    }
  });
  assert.deepEqual(workerOptions.workerData.searchPaths, [candidate]);
  assert.deepEqual(value.roots, [candidate]);
});

test("starts the absolute Python payload deadline before pre-worker discovery", async () => {
  let constructed = false;
  class DeadlineWorker extends EventEmitter {
    terminate() {
      return Promise.resolve(0);
    }
  }
  await assert.rejects(
    QUALIFICATION_ISOLATION_TEST_BOUNDARY.discoverPythonPayloads([], "/unused", {
      async beforeWorkerConstructionForTest({ deadlineNanoseconds }) {
        assert.equal(typeof deadlineNanoseconds, "bigint");
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 15));
      },
      includeVenv: false,
      timeoutMilliseconds: 5,
      workerFactoryForTest() {
        constructed = true;
        return new DeadlineWorker();
      }
    }),
    /Python payload discovery exceeded its absolute deadline/u
  );
  assert.equal(constructed, true);
});

test("owns the package-root discovery deadline before qualification inspects a root", async (context) => {
  const value = await fixture(context, "python-root-pre-discovery-deadline");
  const task = await addTask(value, "python-root-pre-discovery-deadline");
  const packageRoot = join(value.root, "deadline-package-root");
  await mkdir(packageRoot, { mode: 0o700 });
  await writeFile(join(packageRoot, "ordinary.py"), "VALUE = 1\n", { flag: "wx", mode: 0o600 });
  let deadlineObserved = false;
  await assert.rejects(
    runQualification({
      additionalPythonPackageRootsForTest: [packageRoot],
      assignmentPath: task.assignmentPath,
      async beforePythonPayloadWorkerConstructionForTest({ deadlineNanoseconds }) {
        deadlineObserved = true;
        assert.equal(typeof deadlineNanoseconds, "bigint");
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 15));
      },
      command: [process.execPath, child, "record"],
      environment: runnerEnvironment(),
      onlyAdditionalPythonPackageRootsForTest: true,
      pythonPayloadScanTimeoutMsForTest: 5,
      terminationGraceMs: 5_000,
      timeoutMs: 120_000,
      writeOutput: false
    }),
    /Python payload discovery exceeded its absolute deadline/u
  );
  assert.equal(deadlineObserved, true);
  assert.equal((await receipt(task)).eligible, false);
});

test("charges synchronous worker construction to the existing absolute deadline", async () => {
  class DeadlineWorker extends EventEmitter {
    terminate() {
      return Promise.resolve(0);
    }
  }
  await assert.rejects(
    QUALIFICATION_ISOLATION_TEST_BOUNDARY.discoverPythonPayloads([], "/unused", {
      includeVenv: false,
      timeoutMilliseconds: 5,
      workerFactoryForTest() {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 15);
        return new DeadlineWorker();
      }
    }),
    /Python payload discovery exceeded its absolute deadline/u
  );
});

test("terminates a never-settling Python payload scan at one absolute deadline", async () => {
  const worker = new Worker("setInterval(() => {}, 1_000)", { eval: true });
  let exited = false;
  worker.once("exit", () => {
    exited = true;
  });
  await assert.rejects(
    QUALIFICATION_ISOLATION_TEST_BOUNDARY.runOwnedPythonDiscoveryWorker(worker, {
      deadlineNanoseconds: process.hrtime.bigint() + 25_000_000n
    }),
    /Python payload discovery exceeded its absolute deadline/u
  );
  assert.equal(exited, true);
});

test("bounds uncertain Python payload worker termination and ignores late progress", async () => {
  let progress = 0;
  class StalledWorker extends EventEmitter {
    terminate() {
      setImmediate(() =>
        this.emit("message", {
          protocol: "openwrangler-python-payload-scan-v1",
          type: "progress",
          value: { entries: 1 }
        })
      );
      return new Promise(() => {});
    }
  }
  const worker = new StalledWorker();
  const started = Date.now();
  await assert.rejects(
    QUALIFICATION_ISOLATION_TEST_BOUNDARY.runOwnedPythonDiscoveryWorker(worker, {
      deadlineNanoseconds: process.hrtime.bigint() + 5_000_000n,
      onProgress() {
        progress += 1;
      },
      settlementTimeoutMilliseconds: 20
    }),
    /worker ownership is uncertain after its settlement deadline/u
  );
  await new Promise((resolveDelay) => setImmediate(resolveDelay));
  assert.equal(progress, 0);
  assert.ok(Date.now() - started < 1_000, "worker settlement exceeded its fixed bound");
});

test("bounds raw Python payload worker diagnostics", async () => {
  class FailingWorker extends EventEmitter {
    terminate() {
      return Promise.resolve(0);
    }
  }
  const worker = new FailingWorker();
  const result = QUALIFICATION_ISOLATION_TEST_BOUNDARY.runOwnedPythonDiscoveryWorker(worker, {
    deadlineNanoseconds: process.hrtime.bigint() + 1_000_000_000n
  });
  worker.emit("error", new Error("x".repeat(20_000)));
  await assert.rejects(result, (error) => {
    assert.ok(Buffer.byteLength(error.message, "utf8") <= 4_096);
    return true;
  });
});

test("bounds termination diagnostics after the Python payload deadline", async () => {
  class FailingWorker extends EventEmitter {
    terminate() {
      throw new Error(`worker termination failed ${"x".repeat(20_000)}`);
    }
  }
  const worker = new FailingWorker();
  await assert.rejects(
    QUALIFICATION_ISOLATION_TEST_BOUNDARY.runOwnedPythonDiscoveryWorker(worker, {
      deadlineNanoseconds: process.hrtime.bigint() + 5_000_000n,
      settlementTimeoutMilliseconds: 20
    }),
    (error) => {
      assert.match(error.message, /worker ownership is uncertain/u);
      assert.ok(Buffer.byteLength(error.message, "utf8") <= 4_096);
      assert.match(error.errors[0].message, /absolute deadline/u);
      assert.match(error.errors[1].message, /worker termination failed/u);
      assert.ok(error.errors.every((value) => Buffer.byteLength(value.message, "utf8") <= 4_096));
      return true;
    }
  );
});

test("attempts every owned cleanup and preserves primary plus ordered cleanup faults", async () => {
  const order = [];
  const primary = new Error("primary failure");
  await assert.rejects(
    QUALIFICATION_ISOLATION_TEST_BOUNDARY.finishWithOwnedCleanup(
      primary,
      [
        {
          label: "first owner",
          run() {
            order.push("first");
            throw new Error("first cleanup failure");
          }
        },
        {
          label: "stalled owner",
          run() {
            order.push("stalled");
            return new Promise(() => {});
          }
        },
        {
          label: "last owner",
          run() {
            order.push("last");
            throw new Error("last cleanup failure");
          }
        }
      ],
      20
    ),
    (error) => {
      assert.ok(error instanceof AggregateError);
      assert.deepEqual(
        error.errors.map((value) => value.message),
        [
          "primary failure",
          "first cleanup failure",
          "stalled owner cleanup did not settle within its bound",
          "last cleanup failure"
        ]
      );
      return true;
    }
  );
  assert.deepEqual(order, ["first", "stalled", "last"]);
});

test("does not publish an eligible receipt when any owned cleanup fails", async (context) => {
  const value = await fixture(context, "eligible-cleanup-failure");
  const task = await addTask(value, "eligible-cleanup-failure");
  await assert.rejects(
    runQualification({
      assignmentPath: task.assignmentPath,
      cleanupActionsForTest: [
        {
          label: "injected final owner",
          run() {
            throw new Error("injected owned cleanup failure");
          }
        }
      ],
      command: [process.execPath, child, "record"],
      environment: runnerEnvironment(),
      terminationGraceMs: 5_000,
      timeoutMs: 120_000,
      writeOutput: false
    }),
    (error) => {
      assert.ok(error instanceof AggregateError);
      assert.ok(error.errors.some((value) => /injected owned cleanup failure/u.test(value.message)));
      return true;
    }
  );
  const receiptBytes = await readFile(join(task.assignment.stateRoot, "artifacts", "qualification-receipt.json"));
  assert.equal(receiptBytes.length, 0);
});

test("defines portable POSIX control and outer settlement bounds explicitly", () => {
  assert.deepEqual(QUALIFICATION_ISOLATION_TEST_BOUNDARY.posixSettlementBounds(1_000, 100), {
    control: 500,
    outer: 6_500
  });
  assert.throws(
    () => QUALIFICATION_ISOLATION_TEST_BOUNDARY.posixSettlementBounds(1_000, 0),
    /process termination grace must be one positive safe integer/u
  );
});

test(
  "kills and awaits a POSIX supervisor when its control pipe is missing or its outer settlement stalls",
  { skip: process.platform !== "linux" },
  async (context) => {
    const value = await fixture(context, "posix-supervisor-settlement");
    const missingTask = await addTask(value, "posix-missing-control");
    const tracked = join(missingTask.worktree, "tracked.txt");
    let missingPid;
    await assert.rejects(
      runQualification({
        afterCommandSpawnForTest: async ({ child: spawned }) => {
          missingPid = spawned.pid;
        },
        assignmentPath: missingTask.assignmentPath,
        command: [process.execPath, child, "delayed-write", "--delay", "500", "--path", tracked],
        environment: runnerEnvironment(),
        posixMissingControlPipeForTest: true,
        terminationGraceMs: 250,
        timeoutMs: 1_000,
        writeOutput: false
      }),
      /process tree could not be attested empty/u
    );
    assert.throws(() => process.kill(missingPid, 0), /ESRCH/u);
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 750));
    assert.equal(await readFile(tracked, "utf8"), "source\n");

    const stalledTask = await addTask(value, "posix-stalled-supervisor");
    let stalledPid;
    await assert.rejects(
      runQualification({
        afterCommandSpawnForTest: async ({ child: spawned }) => {
          stalledPid = spawned.pid;
        },
        assignmentPath: stalledTask.assignmentPath,
        command: [process.execPath, child, "record"],
        environment: runnerEnvironment(),
        posixOuterSettlementMsForTest: 50,
        posixSupervisorSourceForTest:
          "import signal,time\nsignal.signal(signal.SIGTERM, signal.SIG_IGN)\nwhile True: time.sleep(1)\n",
        terminationGraceMs: 100,
        timeoutMs: 1_000,
        writeOutput: false
      }),
      /process tree could not be attested empty/u
    );
    assert.throws(() => process.kill(stalledPid, 0), /ESRCH/u);
  }
);

test(
  "kills and awaits Windows supervisors on missing control and loader timeout paths",
  { skip: process.platform !== "win32" },
  async (context) => {
    const value = await fixture(context, "windows-supervisor-settlement");
    for (const kind of ["missing-control", "stalled-loader"]) {
      const task = await addTask(value, `windows-${kind}`);
      let supervisorPid;
      const jobScript = join(value.root, `windows-${kind}.ps1`);
      if (kind === "stalled-loader") {
        await writeFile(jobScript, "while($true){Start-Sleep -Milliseconds 100}\n", { flag: "wx", mode: 0o600 });
      }
      await assert.rejects(
        runQualification({
          afterCommandSpawnForTest: async ({ child: spawned }) => {
            supervisorPid = spawned.pid;
          },
          assignmentPath: task.assignmentPath,
          command: [process.execPath, child, "record"],
          environment: runnerEnvironment(),
          terminationGraceMs: 250,
          timeoutMs: 250,
          windowsJobSupervisorScriptForTest: kind === "stalled-loader" ? jobScript : undefined,
          windowsMissingControlPipeForTest: kind === "missing-control",
          writeOutput: false
        }),
        /process tree could not be attested empty/u
      );
      assert.throws(() => process.kill(supervisorPid, 0), /ESRCH/u);
    }
  }
);

test("a swapped artifact pathname cannot redirect the pinned receipt", async (context) => {
  const value = await fixture(context, "artifact-swap");
  const task = await addTask(value, "artifact-swap");
  const external = join(value.root, "external-artifacts");
  await mkdir(external);
  const result = await startRunner(task, "swap-artifacts", ["--target", external]);
  assert.equal(result.status, 1);
  assert.equal(existsSync(join(external, "qualification-receipt.json")), false);
});

function spawnRunnerCommand(task, command) {
  const running = spawn(process.execPath, [script, "run", "--assignment", task.assignmentPath, "--", ...command], {
    env: runnerEnvironment(),
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true
  });
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
