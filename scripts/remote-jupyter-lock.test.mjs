import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

import {
  REMOTE_JUPYTER_INPUT_PATH,
  REMOTE_JUPYTER_LOCK_EXCLUDE_NEWER,
  REMOTE_JUPYTER_LOCK_PATH,
  REMOTE_JUPYTER_LOCK_PLATFORM,
  REMOTE_JUPYTER_LOCK_PYTHON_VERSION,
  REMOTE_JUPYTER_LOCK_TOOL_VERSION,
  REMOTE_R_JUPYTER_INPUT_PATH,
  REMOTE_R_JUPYTER_LOCK_PATH,
  checkRemoteJupyterLockFiles,
  checkRemoteRJupyterLockFiles,
  isRemoteJupyterLockToolVersionOutput,
  remoteJupyterCompileArguments,
  remoteRJupyterCompileArguments,
  validateRemoteJupyterLock,
  validateRemoteRJupyterLock
} from "./remote-jupyter-lock.mjs";

const REPOSITORY_ROOT = resolve(import.meta.dirname, "..");

test("the remote Jupyter lock is complete, canonical, and above its security floor", async () => {
  const { directEntries, lockedEntries } = await checkRemoteJupyterLockFiles();
  assert.equal(directEntries.find(({ name }) => name === "jupyter-server")?.version, "2.20.0");
  assert.ok(lockedEntries.length > 50);
});

test("the R fixture has a separate server-only lock without Python dataframe engines", async () => {
  const { directEntries, lockedEntries } = await checkRemoteRJupyterLockFiles();
  assert.deepEqual(directEntries, [{ name: "jupyter-server", version: "2.20.0" }]);
  assert.ok(lockedEntries.length > 40);
  const names = new Set(lockedEntries.map(({ name }) => name));
  for (const forbidden of ["duckdb", "ipykernel", "ipython", "pandas", "polars", "polars-runtime-32"]) {
    assert.equal(names.has(forbidden), false);
  }
});

test("the remote Jupyter lock rejects a vulnerable server regression", async () => {
  const [inputText, lockText] = await fixtureTexts();
  assert.throws(
    () =>
      validateRemoteJupyterLock(
        inputText.replace("jupyter-server==2.20.0", "jupyter-server==2.19.0"),
        lockText.replace("jupyter-server==2.20.0", "jupyter-server==2.19.0")
      ),
    /at or above 2\.20\.0/u
  );
});

test("the remote Jupyter lock rejects stale direct pins and incomplete hashes", async () => {
  const [inputText, lockText] = await fixtureTexts();
  assert.throws(
    () => validateRemoteJupyterLock(inputText, lockText.replace("jupyter-server==2.20.0", "jupyter-server==2.19.0")),
    /must match its hashed lock entry exactly/u
  );
  assert.throws(
    () =>
      validateRemoteJupyterLock(
        inputText,
        lockText.replace(
          "    --hash=sha256:b5778ba337d8015a3dc2b80803ecdd5ac18d3797fddf61a50ea5fb472b4ebe14 \\\n",
          "    --hash=sha256:b5778ba337d8015a3dc2b80803ecdd5ac18d3797fddf61a50ea5fb472b4ebe14\n"
        )
      ),
    /unique, sorted, canonical hash lines/u
  );
});

test("the lock compiler freezes its tool, target, index, and release horizon", () => {
  const output = "/tmp/openwrangler-lock-contract.txt";
  const argumentsList = remoteJupyterCompileArguments(output);
  assert.equal(REMOTE_JUPYTER_LOCK_TOOL_VERSION, "0.11.32");
  assert.equal(REMOTE_JUPYTER_LOCK_PYTHON_VERSION, "3.12");
  assert.equal(REMOTE_JUPYTER_LOCK_PLATFORM, "x86_64-manylinux_2_28");
  assert.equal(REMOTE_JUPYTER_LOCK_EXCLUDE_NEWER, "2026-07-27T00:00:00Z");
  assert.deepEqual(argumentsList.slice(0, 3), ["pip", "compile", REMOTE_JUPYTER_INPUT_PATH]);
  assert.ok(argumentsList.includes("--only-binary=:all:"));
  assert.ok(argumentsList.includes("--generate-hashes"));
  assert.ok(argumentsList.includes("--no-config"));
  assert.ok(argumentsList.includes("--upgrade"));
  assert.deepEqual(argumentsList.slice(-2), ["--output-file", output]);
  const rArguments = remoteRJupyterCompileArguments(output);
  assert.deepEqual(rArguments.slice(0, 3), ["pip", "compile", REMOTE_R_JUPYTER_INPUT_PATH]);
  assert.deepEqual(rArguments.slice(3), argumentsList.slice(3));
});

test("the lock compiler accepts only the exact resolver version output", () => {
  assert.equal(isRemoteJupyterLockToolVersionOutput("uv 0.11.32 (x86_64-unknown-linux-gnu)\n"), true);
  assert.equal(isRemoteJupyterLockToolVersionOutput("uv 0.11.32\n"), true);
  assert.equal(isRemoteJupyterLockToolVersionOutput("uv 0.11.31 (x86_64-unknown-linux-gnu)\n"), false);
  assert.equal(isRemoteJupyterLockToolVersionOutput("uv 0.11.32 (x86_64-unknown-linux-gnu)\nextra\n"), false);
});

test("ordinary and released audit workflows cannot omit the fixture lock", async () => {
  const [packageText, ci, release, releasedJupyter, vscodeIgnore] = await Promise.all([
    readFile(resolve(REPOSITORY_ROOT, "package.json"), "utf8"),
    readFile(resolve(REPOSITORY_ROOT, ".github", "workflows", "ci.yml"), "utf8"),
    readFile(resolve(REPOSITORY_ROOT, ".github", "workflows", "release.yml"), "utf8"),
    readFile(resolve(REPOSITORY_ROOT, ".github", "workflows", "released-jupyter.yml"), "utf8"),
    readFile(resolve(REPOSITORY_ROOT, ".vscodeignore"), "utf8")
  ]);
  const packageJson = JSON.parse(packageText);
  assert.match(packageJson.scripts["audit:python"], /audit:remote-jupyter/u);
  assert.match(packageJson.scripts["audit:remote-jupyter"], /scripts\/remote-jupyter\/requirements\.txt/u);
  assert.match(packageJson.scripts["audit:remote-jupyter"], /scripts\/remote-jupyter\/requirements\.r\.txt/u);
  assert.equal((packageJson.scripts["audit:remote-jupyter"].match(/--require-hashes/gu) ?? []).length, 2);
  assert.equal((packageJson.scripts["audit:remote-jupyter"].match(/--strict/gu) ?? []).length, 2);
  assert.doesNotMatch(packageJson.scripts["audit:remote-jupyter"], /--ignore-vuln/u);
  assert.match(packageJson.scripts.check, /check:remote-jupyter-lock/u);
  const uvBootstrap =
    /python -m pip install --no-deps "https:\/\/files\.pythonhosted\.org\/[^"]+\/uv-0\.11\.32-py3-none-manylinux_2_17_x86_64\.manylinux2014_x86_64\.whl#sha256=3da76cd4e2697de30928b8a8524bd39183ac1e08cb7e72833807c022b7cba6c4"/u;
  assert.match(ci, uvBootstrap);
  assert.match(ci, /run: npm run lock:remote-jupyter:check/u);
  assert.match(ci, /run: npm run audit:python/u);
  assert.match(release, uvBootstrap);
  assert.match(release, /run: npm run lock:remote-jupyter:check/u);
  assert.match(release, /run: npm run audit:python/u);
  assert.match(releasedJupyter, uvBootstrap);
  assert.match(releasedJupyter, /run: npm run lock:remote-jupyter:check/u);
  assert.match(releasedJupyter, /run: npm run audit:remote-jupyter/u);
  assert.match(vscodeIgnore, /^scripts\/\*\*$/mu);
});

async function fixtureTexts() {
  return Promise.all([readFile(REMOTE_JUPYTER_INPUT_PATH, "utf8"), readFile(REMOTE_JUPYTER_LOCK_PATH, "utf8")]);
}

test("the R fixture validator rejects Python engine packages", async () => {
  const [inputText, lockText] = await Promise.all([
    readFile(REMOTE_R_JUPYTER_INPUT_PATH, "utf8"),
    readFile(REMOTE_R_JUPYTER_LOCK_PATH, "utf8")
  ]);
  assert.throws(
    () => validateRemoteRJupyterLock(inputText, lockText.replace(/^pandocfilters==/mu, "pandas==")),
    /must not include pandas/u
  );
});
