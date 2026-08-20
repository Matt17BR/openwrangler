import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { access, appendFile, mkdir, writeFile } from "node:fs/promises";
import { basename, isAbsolute, join, relative } from "node:path";

const requiredEnvironment = [
  "HOME",
  "NPM_CONFIG_CACHE",
  "OPEN_WRANGLER_ARTIFACTS_DIR",
  "OPEN_WRANGLER_BROWSER_PROFILE_ROOT",
  "OPEN_WRANGLER_QUALIFICATION_ASSIGNMENT",
  "OPEN_WRANGLER_QUALIFICATION_ROOT",
  "OPEN_WRANGLER_QUALIFICATION_TASK_ID",
  "PIP_CACHE_DIR",
  "PLAYWRIGHT_BROWSERS_PATH",
  "PYTHONPYCACHEPREFIX",
  "TEMP",
  "VIRTUAL_ENV",
  "XDG_CACHE_HOME"
];

function argument(name) {
  const index = process.argv.indexOf(name);
  assert.notEqual(index, -1, `missing ${name}`);
  assert.ok(process.argv[index + 1], `missing ${name} value`);
  return process.argv[index + 1];
}

async function waitFor(path) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      await access(path);
      return;
    } catch {
      await new Promise((resolveWait) => setTimeout(resolveWait, 10));
    }
  }
  throw new Error(`timed out waiting for ${basename(path)}`);
}

async function recordEnvironment() {
  const stateRoot = process.env.OPEN_WRANGLER_QUALIFICATION_ROOT;
  const taskId = process.env.OPEN_WRANGLER_QUALIFICATION_TASK_ID;
  assert.ok(stateRoot && isAbsolute(stateRoot));
  assert.ok(taskId);
  for (const key of requiredEnvironment) {
    const value = process.env[key];
    assert.ok(value, `${key} must be set`);
    if (key === "OPEN_WRANGLER_QUALIFICATION_TASK_ID") {
      assert.equal(value, taskId);
      continue;
    }
    assert.ok(isAbsolute(value), `${key} must be absolute`);
    if (key !== "OPEN_WRANGLER_QUALIFICATION_ASSIGNMENT") {
      const suffix = relative(stateRoot, value);
      assert.ok(suffix === "" || (!suffix.startsWith("..") && !isAbsolute(suffix)), `${key} escaped the state root`);
    }
  }
  const writableRoots = [
    process.env.HOME,
    process.env.NPM_CONFIG_CACHE,
    process.env.OPEN_WRANGLER_ARTIFACTS_DIR,
    process.env.OPEN_WRANGLER_BROWSER_PROFILE_ROOT,
    process.env.PIP_CACHE_DIR,
    process.env.PLAYWRIGHT_BROWSERS_PATH,
    process.env.PYTHONPYCACHEPREFIX,
    process.env.TEMP,
    process.env.VIRTUAL_ENV,
    process.env.XDG_CACHE_HOME
  ];
  for (const root of writableRoots) {
    await mkdir(root, { mode: 0o700, recursive: true });
    await writeFile(join(root, `child-${taskId}.txt`), `${taskId}\n`, { flag: "wx", mode: 0o600 });
  }
}

const mode = process.argv[2];
await recordEnvironment();

if (mode === "hold") {
  const ready = argument("--ready");
  const release = argument("--release");
  await writeFile(ready, `${process.env.OPEN_WRANGLER_QUALIFICATION_TASK_ID}\n`, {
    flag: "wx",
    mode: 0o600
  });
  await waitFor(release);
} else if (mode === "mutate-worktree") {
  await appendFile(join(process.cwd(), "tracked.txt"), "mutated\n", "utf8");
} else if (mode === "advance-head") {
  await appendFile(join(process.cwd(), "tracked.txt"), "advanced\n", "utf8");
  execFileSync("git", ["add", "tracked.txt"], { cwd: process.cwd(), env: process.env, windowsHide: true });
  execFileSync("git", ["commit", "--quiet", "-m", "test mutation"], {
    cwd: process.cwd(),
    env: process.env,
    windowsHide: true
  });
} else if (mode === "mutate-assignment") {
  await appendFile(process.env.OPEN_WRANGLER_QUALIFICATION_ASSIGNMENT, "\n", "utf8");
} else if (mode !== "record") {
  throw new Error(`unknown fixture mode ${String(mode)}`);
}
