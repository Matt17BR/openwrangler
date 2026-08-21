import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import {
  access,
  appendFile,
  chmod,
  lstat,
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  writeFile
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { QUALIFICATION_ENVIRONMENT_CONTRACT } from "../qualification-isolation.mjs";

function argument(name) {
  const index = process.argv.indexOf(name);
  assert.notEqual(index, -1, `missing ${name}`);
  assert.ok(process.argv[index + 1], `missing ${name} value`);
  return process.argv[index + 1];
}

async function waitFor(path) {
  while (true) {
    try {
      await access(path);
      return;
    } catch {
      await new Promise((resolveWait) => setTimeout(resolveWait, 10));
    }
  }
}

async function recordEnvironment() {
  const stateRoot = process.env.OPEN_WRANGLER_QUALIFICATION_ROOT;
  const taskId = process.env.OPEN_WRANGLER_QUALIFICATION_TASK_ID;
  const runId = process.env.OPEN_WRANGLER_QUALIFICATION_RUN_ID;
  assert.ok(stateRoot && isAbsolute(stateRoot));
  assert.ok(taskId);
  assert.ok(runId);
  const privatePaths = new Map();
  for (const mapping of [
    QUALIFICATION_ENVIRONMENT_CONTRACT.privateDirectories,
    QUALIFICATION_ENVIRONMENT_CONTRACT.privateFiles
  ]) {
    for (const [key, layoutKey] of Object.entries(mapping)) {
      const value = process.env[key];
      assert.ok(value && isAbsolute(value), `${key} must be an absolute private path`);
      const suffix = relative(stateRoot, value);
      assert.ok(suffix === "" || (!suffix.startsWith("..") && !isAbsolute(suffix)), `${key} escaped the state root`);
      const prior = privatePaths.get(layoutKey);
      if (prior) assert.equal(value, prior, `${key} disagrees with the ${layoutKey} mapping`);
      else privatePaths.set(layoutKey, value);
    }
  }
  for (const key of Object.keys(QUALIFICATION_ENVIRONMENT_CONTRACT.pinnedToolFiles)) {
    const value = process.env[key];
    assert.ok(value && isAbsolute(value), `${key} must be one absolute pinned tool path`);
  }
  const expectedWorktreePaths = {
    nodeModules: join(process.cwd(), "node_modules"),
    vitestCache: join(process.cwd(), "node_modules", ".vite")
  };
  for (const [key, layoutKey] of Object.entries(QUALIFICATION_ENVIRONMENT_CONTRACT.worktreePaths)) {
    assert.equal(process.env[key], expectedWorktreePaths[layoutKey], `${key} has the wrong worktree mapping`);
  }
  for (const [key, expected] of Object.entries(QUALIFICATION_ENVIRONMENT_CONTRACT.exactValues)) {
    assert.equal(process.env[key], expected, `${key} has the wrong runner-owned value`);
  }
  for (const key of QUALIFICATION_ENVIRONMENT_CONTRACT.forbiddenInheritedKeys) {
    assert.equal(process.env[key], undefined, `${key} must not reach the qualification command`);
  }
  for (const prefix of QUALIFICATION_ENVIRONMENT_CONTRACT.forbiddenInheritedPrefixes) {
    for (const key of Object.keys(process.env)) {
      assert.equal(key.toUpperCase().startsWith(prefix), false, `${key} must not reach the qualification command`);
    }
  }
  assert.ok(process.env.OPEN_WRANGLER_QUALIFICATION_ASSIGNMENT?.endsWith(".json"));
  assert.equal(process.env.OPEN_WRANGLER_QUALIFICATION_TASK_ID, taskId);
  assert.equal(process.env.OPEN_WRANGLER_QUALIFICATION_RUN_ID, runId);
  assert.equal(process.env.PWD, process.cwd());
  assert.match(process.env.PYTEST_ADDOPTS ?? "", /(?:^|\s)-o\s+cache_dir=/u);
  assert.doesNotMatch(process.env.PYTEST_ADDOPTS ?? "", /--cache-dir/u);
  assert.equal(
    process.env.PATH?.split(process.platform === "win32" ? ";" : ":")[0],
    join(process.env.VIRTUAL_ENV, process.platform === "win32" ? "Scripts" : "bin")
  );
  assert.match(process.env.PYTEST_ADDOPTS ?? "", new RegExp(stateRoot.replaceAll(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"));
  const allowedKeys = new Set([
    ...QUALIFICATION_ENVIRONMENT_CONTRACT.passThroughKeys,
    ...QUALIFICATION_ENVIRONMENT_CONTRACT.runnerOwnedKeys,
    ...Object.keys(QUALIFICATION_ENVIRONMENT_CONTRACT.privateDirectories),
    ...Object.keys(QUALIFICATION_ENVIRONMENT_CONTRACT.privateFiles),
    ...Object.keys(QUALIFICATION_ENVIRONMENT_CONTRACT.pinnedToolFiles),
    ...Object.keys(QUALIFICATION_ENVIRONMENT_CONTRACT.worktreePaths),
    ...Object.keys(QUALIFICATION_ENVIRONMENT_CONTRACT.exactValues),
    "OPEN_WRANGLER_QUALIFICATION_ASSIGNMENT",
    "OPEN_WRANGLER_QUALIFICATION_ROOT",
    "OPEN_WRANGLER_QUALIFICATION_RUN_ID",
    "OPEN_WRANGLER_QUALIFICATION_TASK_ID",
    "PYTEST_ADDOPTS",
    "npm_config_userconfig"
  ]);
  for (const key of Object.keys(process.env)) {
    assert.ok(allowedKeys.has(key), `${key} is outside the exported qualification environment contract`);
  }

  const prefixProbe = [
    "import json, os, pathlib, sys",
    "target = pathlib.Path(os.environ['PYTHONUSERBASE']) / ('python-' + os.environ['OPEN_WRANGLER_QUALIFICATION_TASK_ID'] + '.txt')",
    "target.parent.mkdir(parents=True, exist_ok=True)",
    "target.write_text(sys.prefix + '\\n', encoding='utf-8')",
    "print(json.dumps({'executable': os.path.realpath(sys.executable), 'prefix': os.path.realpath(sys.prefix)}))"
  ].join("; ");
  const explicitPython = JSON.parse(
    execFileSync(process.env.OPEN_WRANGLER_TEST_PYTHON, ["-I", "-c", prefixProbe], {
      encoding: "utf8",
      env: process.env,
      windowsHide: true
    })
  );
  const pathPython = JSON.parse(
    execFileSync(process.platform === "win32" ? "python.exe" : "python", ["-I", "-c", prefixProbe], {
      encoding: "utf8",
      env: process.env,
      windowsHide: true
    })
  );
  assert.equal(explicitPython.executable, await realpath(process.env.OPEN_WRANGLER_TEST_PYTHON));
  assert.equal(explicitPython.prefix, resolve(process.env.VIRTUAL_ENV));
  assert.equal(pathPython.prefix, resolve(process.env.VIRTUAL_ENV));
  const writableRoots = [
    process.env.HOME,
    process.env.NPM_CONFIG_CACHE,
    process.env.OPEN_WRANGLER_ARTIFACTS_DIR,
    process.env.OPEN_WRANGLER_BROWSER_PROFILE_ROOT,
    process.env.PIP_CACHE_DIR,
    process.env.PLAYWRIGHT_BROWSERS_PATH,
    process.env.PYTHONPYCACHEPREFIX,
    process.env.PYTHONUSERBASE,
    process.env.RUNNER_TEMP,
    process.env.TEMP,
    process.env.UV_CACHE_DIR,
    process.env.VIRTUAL_ENV,
    process.env.XDG_CACHE_HOME
  ];
  for (const root of new Set(writableRoots)) {
    await mkdir(root, { mode: 0o700, recursive: true });
    await writeFile(join(root, `child-${taskId}.txt`), `${taskId}\n`, { flag: "wx", mode: 0o600 });
  }
  await writeFile(process.env.OPEN_WRANGLER_TEST_PROGRESS, `${taskId}:progress\n`, { flag: "wx", mode: 0o600 });
  await writeFile(process.env.OPEN_WRANGLER_TEST_RESULT, `${taskId}:result\n`, { flag: "wx", mode: 0o600 });
}

const mode = process.argv[2];
if (mode === "delayed-write") {
  await new Promise((resolveDelay) => setTimeout(resolveDelay, Number(argument("--delay"))));
  await appendFile(argument("--path"), "late mutation\n", "utf8");
  process.exit(0);
}
if (mode === "nested-escape-parent") {
  process.on("SIGTERM", () => {});
  const descendant = spawn(
    process.execPath,
    [import.meta.filename, "delayed-write", "--delay", "2000", "--path", argument("--path")],
    { detached: true, env: process.env, stdio: "ignore", windowsHide: true }
  );
  descendant.unref();
  setInterval(() => {}, 1000);
  await new Promise(() => {});
}
await recordEnvironment();

if (mode === "hold") {
  const ready = argument("--ready");
  const peer = argument("--peer");
  assert.notEqual(ready, peer, "barrier participants must own distinct ready markers");
  await writeFile(ready, `${process.env.OPEN_WRANGLER_QUALIFICATION_TASK_ID}\n`, {
    flag: "wx",
    mode: 0o600
  });
  await waitFor(peer);
} else if (mode === "mutate-worktree") {
  await appendFile(join(process.cwd(), "tracked.txt"), "mutated\n", "utf8");
} else if (mode === "advance-head") {
  await appendFile(join(process.cwd(), "tracked.txt"), "advanced\n", "utf8");
  const assignment = JSON.parse(await readFile(process.env.OPEN_WRANGLER_QUALIFICATION_ASSIGNMENT, "utf8"));
  const runAuthoritativeGit = (arguments_) =>
    execFileSync(
      assignment.gitExecutable,
      ["--git-dir", assignment.gitDirectory, "--work-tree", assignment.worktree, ...arguments_],
      { cwd: process.cwd(), env: process.env, windowsHide: true }
    );
  runAuthoritativeGit(["add", "tracked.txt"]);
  runAuthoritativeGit(["commit", "--quiet", "-m", "test mutation"]);
} else if (mode === "nested-git") {
  const runTopLevelGit = (arguments_) =>
    execFileSync("git", arguments_, {
      cwd: process.cwd(),
      encoding: "utf8",
      env: process.env,
      windowsHide: true
    }).trim();
  const topLevelHead = runTopLevelGit(["rev-parse", "HEAD"]);
  const topLevelStatus = runTopLevelGit(["status", "--porcelain=v1", "--untracked-files=all"]);
  const repository = join(process.env.RUNNER_TEMP, "nested-git");
  await mkdir(repository, { mode: 0o700 });
  const runGit = (arguments_) =>
    execFileSync("git", arguments_, {
      cwd: repository,
      encoding: "utf8",
      env: process.env,
      windowsHide: true
    }).trim();
  execFileSync("git", ["-C", repository, "init", "--quiet", "--initial-branch=main"], {
    cwd: process.cwd(),
    env: process.env,
    windowsHide: true
  });
  runGit(["config", "--local", "user.name", "Open Wrangler nested fixture"]);
  runGit(["config", "--local", "user.email", "nested-fixture@openwrangler.invalid"]);
  await writeFile(join(repository, "fixture.txt"), "fixture\n", { flag: "wx", mode: 0o600 });
  runGit(["add", "fixture.txt"]);
  runGit(["commit", "--quiet", "-m", "nested fixture"]);
  const nestedHead = runGit(["rev-parse", "HEAD"]);
  const privatePointer = (await readFile(join(repository, ".git"), "utf8")).trim();
  const topLevelHeadFromPrivateRoot = execFileSync("git", ["-C", process.cwd(), "rev-parse", "HEAD"], {
    cwd: repository,
    encoding: "utf8",
    env: process.env,
    windowsHide: true
  }).trim();
  const topLevelHeadFromRelativeChild = execFileSync("git", ["-C", "nested", "rev-parse", "HEAD"], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: process.env,
    windowsHide: true
  }).trim();
  const nestedHeadFromWorktree = execFileSync("git", ["-C", repository, "rev-parse", "HEAD"], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: process.env,
    windowsHide: true
  }).trim();
  const [authorName, authorEmail, committerName, committerEmail] = runGit([
    "show",
    "-s",
    "--format=%an%n%ae%n%cn%n%ce",
    "HEAD"
  ]).split("\n");
  await writeFile(
    argument("--path"),
    `${JSON.stringify({
      authorEmail,
      authorName,
      committerEmail,
      committerName,
      gitHome: process.env.HOME,
      gitXdgConfig: process.env.XDG_CONFIG_HOME,
      nestedHead,
      nestedHeadFromWorktree,
      privatePointer,
      repository,
      topLevelHead,
      topLevelHeadFromPrivateRoot,
      topLevelHeadFromRelativeChild,
      topLevelStatus
    })}\n`,
    { flag: "wx", mode: 0o600 }
  );
} else if (mode === "nested-git-admin-escape") {
  const repository = join(process.env.RUNNER_TEMP, "nested-git-admin-escape");
  const outsideObjects = argument("--outside-objects");
  await mkdir(repository, { mode: 0o700 });
  await mkdir(outsideObjects, { mode: 0o700 });
  const runGit = (arguments_) =>
    execFileSync("git", arguments_, {
      cwd: repository,
      encoding: "utf8",
      env: process.env,
      stdio: "pipe",
      windowsHide: true
    }).trim();
  runGit(["init", "--quiet", "--initial-branch=main"]);
  runGit(["config", "--local", "user.name", "Open Wrangler nested fixture"]);
  runGit(["config", "--local", "user.email", "nested-fixture@openwrangler.invalid"]);
  await writeFile(join(repository, "fixture.txt"), "fixture\n", { flag: "wx", mode: 0o600 });
  const pointer = (await readFile(join(repository, ".git"), "utf8")).trim();
  assert.match(pointer, /^gitdir: /u);
  const metadata = pointer.slice("gitdir: ".length);
  const objects = join(metadata, "objects");
  const retained = `${objects}-retained`;
  await rename(objects, retained);
  await symlink(outsideObjects, objects, process.platform === "win32" ? "junction" : "dir");
  try {
    assert.throws(() => runGit(["add", "fixture.txt"]));
  } finally {
    await rm(objects);
    await rename(retained, objects);
  }
  await writeFile(argument("--result"), `${metadata}\n`, { flag: "wx", mode: 0o600 });
} else if (mode === "nested-git-hostile-helpers") {
  const repository = join(process.env.RUNNER_TEMP, "nested-git-hostile-helpers");
  await mkdir(repository, { mode: 0o700 });
  const runGit = (arguments_) =>
    execFileSync("git", arguments_, {
      cwd: repository,
      encoding: "utf8",
      env: process.env,
      windowsHide: true
    }).trim();
  runGit(["init", "--quiet", "--initial-branch=main"]);
  runGit(["config", "--local", "user.name", "Open Wrangler nested fixture"]);
  runGit(["config", "--local", "user.email", "nested-fixture@openwrangler.invalid"]);
  await writeFile(
    join(repository, ".gitattributes"),
    "fixture.txt diff=qualification-attack filter=qualification-attack\n",
    {
      flag: "wx",
      mode: 0o600
    }
  );
  await writeFile(join(repository, "fixture.txt"), "fixture\n", { flag: "wx", mode: 0o600 });
  runGit(["add", ".gitattributes", "fixture.txt"]);
  runGit(["commit", "--quiet", "-m", "nested fixture"]);
  const commit = runGit(["cat-file", "commit", "HEAD"]);
  await writeFile(join(repository, "fixture.txt"), "fixture\nchanged\n", { mode: 0o600 });
  const diff = runGit(["diff", "HEAD", "--", "fixture.txt"]);
  await writeFile(argument("--result"), `${JSON.stringify({ commit, diff })}\n`, {
    flag: "wx",
    mode: 0o600
  });
} else if (mode === "git-owner-override") {
  try {
    execFileSync("git", ["--git-dir", argument("--path"), "rev-parse", "HEAD"], {
      cwd: process.cwd(),
      env: process.env,
      stdio: "ignore",
      windowsHide: true
    });
  } catch {
    process.exit(1);
  }
  await writeFile(argument("--result"), "escaped\n", { flag: "wx", mode: 0o600 });
} else if (mode === "git-outside-owner") {
  try {
    execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: argument("--path"),
      env: process.env,
      stdio: "ignore",
      windowsHide: true
    });
  } catch {
    process.exit(1);
  }
  await writeFile(argument("--result"), "escaped\n", { flag: "wx", mode: 0o600 });
} else if (mode === "git-probe") {
  try {
    execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: process.cwd(),
      env: process.env,
      stdio: "ignore",
      windowsHide: true
    });
  } catch {
    process.exit(1);
  }
  await writeFile(argument("--result"), "executed\n", { flag: "wx", mode: 0o600 });
} else if (mode === "git-private-operand-attacks") {
  const outside = argument("--outside");
  const outsideGit = argument("--outside-git");
  const privateRepository = join(process.env.RUNNER_TEMP, "private-operand-repository");
  await mkdir(privateRepository, { mode: 0o700 });
  execFileSync("git", ["init", "--quiet", "--initial-branch=main"], {
    cwd: privateRepository,
    env: process.env,
    windowsHide: true
  });
  const attempts = [
    ["config", "--file", outside, "user.name", "escaped"],
    ["init", outside],
    ["hash-object", "-w", outside],
    ["diff", "--no-index", ".", outside]
  ];
  for (const command of attempts) {
    assert.throws(() =>
      execFileSync("git", command, {
        cwd: privateRepository,
        env: process.env,
        stdio: "ignore",
        windowsHide: true
      })
    );
  }
  const aliasedRepository = join(process.env.RUNNER_TEMP, "aliased-private-repository");
  await mkdir(aliasedRepository, { mode: 0o700 });
  await symlink(outsideGit, join(aliasedRepository, ".git"), process.platform === "win32" ? "junction" : "dir");
  assert.throws(() =>
    execFileSync("git", ["config", "--local", "user.name", "escaped"], {
      cwd: aliasedRepository,
      env: process.env,
      stdio: "ignore",
      windowsHide: true
    })
  );
  await writeFile(argument("--result"), `${String(attempts.length + 1)}\n`, { flag: "wx", mode: 0o600 });
} else if (mode === "repository-python-tool") {
  const runPython = join(import.meta.dirname, "..", "run-python.mjs");
  execFileSync(process.execPath, [runPython, "-m", "pytest", "--version"], {
    cwd: process.cwd(),
    env: process.env,
    stdio: "ignore",
    windowsHide: true
  });
  await writeFile(
    argument("--result"),
    `${JSON.stringify({
      executable: process.env.OPEN_WRANGLER_PYTHON,
      prefix: process.env.VIRTUAL_ENV,
      pytest: execFileSync(process.env.OPEN_WRANGLER_PYTHON, ["-I", "-c", "import pytest; print(pytest.__version__)"], {
        encoding: "utf8",
        env: process.env,
        windowsHide: true
      }).trim()
    })}\n`,
    {
      flag: "wx",
      mode: 0o600
    }
  );
} else if (mode === "complete-python-payload") {
  const probe = [
    "import importlib.resources as resources",
    "import json",
    "import os",
    "import pathlib",
    "import qualification_linked_package as package",
    "root = pathlib.Path(os.environ['OPEN_WRANGLER_PYTHON_PACKAGE_SNAPSHOT'])",
    "matches = list(root.rglob('libqualification_payload.so.1.2'))",
    "if len(matches) != 1: raise RuntimeError('versioned native payload was not uniquely snapshotted')",
    "payload = {'data': json.loads(resources.files(package).joinpath('data/payload.json').read_text(encoding='utf-8')), 'native': matches[0].read_text(encoding='utf-8').strip(), 'value': package.VALUE}",
    "pathlib.Path(__import__('sys').argv[1]).write_text(json.dumps(payload, sort_keys=True) + '\\n', encoding='utf-8')"
  ].join("\n");
  execFileSync(process.env.OPEN_WRANGLER_PYTHON, ["-I", "-c", probe, argument("--result")], {
    cwd: process.cwd(),
    env: process.env,
    stdio: "ignore",
    windowsHide: true
  });
} else if (mode === "mutate-python-inventory") {
  const kind = argument("--kind");
  const purelib = execFileSync(
    process.env.OPEN_WRANGLER_PYTHON,
    ["-I", "-c", "import sysconfig; print(sysconfig.get_path('purelib'))"],
    { encoding: "utf8", env: process.env, windowsHide: true }
  ).trim();
  await chmod(purelib, 0o700);
  const mutations = {
    "entry-point": [
      join(purelib, "qualification_escape-1.0.dist-info", "entry_points.txt"),
      "[console_scripts]\nqualification-escape = qualification_escape:main\n"
    ],
    native: [
      join(purelib, process.platform === "win32" ? "qualification_escape.pyd" : "qualification_escape.so"),
      "native-placeholder\n"
    ],
    "case-source": [join(purelib, "qualification_escape.PY"), "def main():\n    return None\n"],
    "platform-native": [
      join(purelib, process.platform === "win32" ? "qualification_escape.DLL" : "qualification_escape.DYLIB"),
      "native-placeholder\n"
    ],
    path: [join(purelib, "qualification_escape.pth"), "qualification_escape\n"],
    record: [join(purelib, "qualification_escape-1.0.dist-info", "RECORD"), "qualification_escape.py,,\n"],
    source: [join(purelib, "qualification_escape.py"), "def main():\n    return None\n"],
    symlink: [join(purelib, "qualification_escape_link.py"), null]
  };
  assert.ok(Object.hasOwn(mutations, kind), `unknown Python payload mutation ${kind}`);
  const [path, bytes] = mutations[kind];
  await mkdir(dirname(path), { mode: 0o700, recursive: true });
  if (kind === "symlink") {
    const target = join(process.env.RUNNER_TEMP, "qualification_escape_target.py");
    await writeFile(target, "def main():\n    return None\n", { flag: "wx", mode: 0o600 });
    await symlink(target, path, "file");
  } else {
    await writeFile(path, bytes, { flag: "wx", mode: 0o600 });
  }
} else if (mode === "replace-python-payload") {
  const target = execFileSync(
    process.env.OPEN_WRANGLER_PYTHON,
    [
      "-I",
      "-c",
      "import pathlib,sysconfig; print((pathlib.Path(sysconfig.get_path('purelib')) / 'openwrangler-pinned-packages.pth').resolve())"
    ],
    { encoding: "utf8", env: process.env, windowsHide: true }
  ).trim();
  const original = await readFile(target);
  const originalMode = Number((await lstat(target, { bigint: true })).mode & 0o777n);
  await chmod(dirname(target), 0o700);
  await chmod(target, 0o600);
  await writeFile(target, Buffer.concat([original, Buffer.from("# temporary mutation\n", "utf8")]));
  await writeFile(target, original);
  await chmod(target, originalMode);
} else if (mode === "swap-python-payload") {
  const target = execFileSync(
    process.env.OPEN_WRANGLER_PYTHON,
    [
      "-I",
      "-c",
      "import pathlib,sysconfig; print((pathlib.Path(sysconfig.get_path('purelib')) / 'openwrangler-pinned-packages.pth').resolve())"
    ],
    { encoding: "utf8", env: process.env, windowsHide: true }
  ).trim();
  const retained = `${target}.qualification-retained`;
  const original = await readFile(target);
  await chmod(dirname(target), 0o700);
  await rename(target, retained);
  await writeFile(target, Buffer.concat([original, Buffer.from("# transient replacement\n", "utf8")]), {
    flag: "wx",
    mode: 0o600
  });
  await rm(target);
  await rename(retained, target);
} else if (mode === "mutate-git-config") {
  execFileSync("git", ["config", "user.name", "Mutated qualification fixture"], {
    cwd: process.cwd(),
    env: process.env,
    windowsHide: true
  });
} else if (mode === "mutate-authoritative-git") {
  const kind = argument("--kind");
  const result = argument("--result");
  const commands = {
    config: ["config", "user.name", "Mutated qualification fixture"],
    configEnv: ["--config-env=user.name=QUALIFICATION_ATTACK_VALUE", "rev-parse", "HEAD"],
    configEnvAbbreviated: ["--config-en=user.name=QUALIFICATION_ATTACK_VALUE", "rev-parse", "HEAD"],
    configParameter: ["-c", "user.name=Mutated qualification fixture", "rev-parse", "HEAD"],
    diffOutput: ["diff", "--output", result, "HEAD", "HEAD"],
    diffOutputAbbreviated: ["diff", "--out", result, "HEAD", "HEAD"],
    externalDiff: ["diff", "--ext-diff", "HEAD", "HEAD"],
    externalDiffAbbreviated: ["diff", "--ext-di", "HEAD", "HEAD"],
    index: ["update-index", "--chmod=+x", "tracked.txt"],
    object: ["hash-object", "-w", "tracked.txt"],
    ref: ["update-ref", "refs/heads/qualification-attack", "HEAD"],
    showOutput: ["show", `--output=${result}`, "--format=%H", "HEAD"],
    showShortOutput: ["show", `-o${result}`, "--format=%H", "HEAD"],
    textconv: ["show", "--textconv", "HEAD:tracked.txt"],
    textconvAbbreviated: ["show", "--textc", "HEAD:tracked.txt"]
  };
  assert.ok(Object.hasOwn(commands, kind), `unknown authoritative Git mutation ${kind}`);
  try {
    execFileSync("git", commands[kind], {
      cwd: process.cwd(),
      env: { ...process.env, QUALIFICATION_ATTACK_VALUE: "Mutated qualification fixture" },
      stdio: "ignore",
      windowsHide: true
    });
  } catch {
    process.exit(1);
  }
  await writeFile(result, "escaped\n", { flag: "wx", mode: 0o600 });
} else if (mode === "mutate-authoritative-git-direct") {
  const kind = argument("--kind");
  const assignment = JSON.parse(await readFile(process.env.OPEN_WRANGLER_QUALIFICATION_ASSIGNMENT, "utf8"));
  const prefix = ["--git-dir", assignment.gitDirectory, "--work-tree", assignment.worktree];
  let command;
  if (kind === "index") {
    command = ["update-index", "--chmod=+x", "tracked.txt"];
  } else if (kind === "object") {
    const source = join(process.env.RUNNER_TEMP, "unreceipted-object.txt");
    await writeFile(source, `unreceipted-${process.env.OPEN_WRANGLER_QUALIFICATION_RUN_ID}\n`, {
      flag: "wx",
      mode: 0o600
    });
    command = ["hash-object", "-w", source];
  } else if (kind === "ref") {
    command = ["update-ref", "refs/heads/qualification-direct-attack", "HEAD"];
  } else {
    throw new Error(`unknown direct authoritative Git mutation ${kind}`);
  }
  execFileSync(assignment.gitExecutable, [...prefix, ...command], {
    cwd: process.cwd(),
    env: process.env,
    windowsHide: true
  });
} else if (mode === "mutate-git-config-source") {
  await appendFile(argument("--path"), "\n[user]\n\tname = Mutated included config\n", "utf8");
} else if (mode === "mutate-assignment") {
  await appendFile(process.env.OPEN_WRANGLER_QUALIFICATION_ASSIGNMENT, "\n", "utf8");
} else if (mode === "escape-parent") {
  const descendant = spawn(
    process.execPath,
    [import.meta.filename, "delayed-write", "--delay", "2000", "--path", argument("--path")],
    { detached: true, env: process.env, stdio: "ignore", windowsHide: true }
  );
  descendant.unref();
} else if (mode === "escape-nested-parent") {
  const descendant = spawn(
    process.execPath,
    [import.meta.filename, "nested-escape-parent", "--path", argument("--path")],
    { detached: true, env: process.env, stdio: "ignore", windowsHide: true }
  );
  descendant.unref();
} else if (mode === "hang") {
  process.on("SIGTERM", () => {});
  setInterval(() => {}, 1000);
  await new Promise(() => {});
} else if (mode === "swap-artifacts") {
  const artifacts = process.env.OPEN_WRANGLER_ARTIFACTS_DIR;
  const retained = `${artifacts}-retained`;
  await rename(artifacts, retained);
  await symlink(argument("--target"), artifacts, process.platform === "win32" ? "junction" : "dir");
} else if (mode !== "record") {
  throw new Error(`unknown fixture mode ${String(mode)}`);
}
