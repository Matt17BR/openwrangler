import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import {
  REMOTE_JUPYTER_INPUT_PATH,
  REMOTE_JUPYTER_FSSPEC_EXCLUDE_NEWER,
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
import {
  REMOTE_R_PACKAGE_AGGREGATE_MAX_BYTES,
  REMOTE_R_PACKAGE_ARCHIVE_MAX_BYTES,
  REMOTE_R_PACKAGE_LOCK_PATH,
  REMOTE_R_PACKAGE_LOCK_PROTOCOL,
  readRemoteRPackageLockFile,
  remoteRPackageLockDigest,
  validateRemoteRPackageLock
} from "./remote-r-package-lock.mjs";

const REPOSITORY_ROOT = resolve(import.meta.dirname, "..");

test("the remote Jupyter lock is complete, canonical, and above its security floor", async () => {
  const { directEntries, lockedEntries } = await checkRemoteJupyterLockFiles();
  assert.equal(directEntries.find(({ name }) => name === "jupyter-server")?.version, "2.20.0");
  assert.equal(directEntries.find(({ name }) => name === "fsspec")?.version, "2026.7.0");
  assert.deepEqual(lockedEntries.find(({ name }) => name === "fsspec")?.hashes, [
    "b57ddbafedfaef7018c1ecab32aa200a9d7ca26b77965f64e48b70061249d279",
    "c803c40f4cf860b49dea58ee3e1c33cb9c790520e233537e1340049f89b82a88"
  ]);
  assert.ok(lockedEntries.length > 50);
});

test("the R fixture has a separate server-only lock without Python dataframe engines", async () => {
  const { directEntries, lockedEntries } = await checkRemoteRJupyterLockFiles();
  assert.deepEqual(directEntries, [{ name: "jupyter-server", version: "2.20.0" }]);
  assert.ok(lockedEntries.length > 40);
  const names = new Set(lockedEntries.map(({ name }) => name));
  for (const forbidden of ["duckdb", "fsspec", "ipykernel", "ipython", "pandas", "polars", "polars-runtime-32"]) {
    assert.equal(names.has(forbidden), false);
  }
});

test("the remote R archive lock is complete, canonical, bounded, and category-exact", async () => {
  const result = await readRemoteRPackageLockFile();
  assert.equal(result.lock.protocol, REMOTE_R_PACKAGE_LOCK_PROTOCOL);
  assert.equal(result.lock.target.rVersion, "4.5.2");
  assert.equal(result.lock.target.codename, "noble");
  assert.equal(result.lock.target.architecture, "x86_64");
  assert.equal(result.digest, remoteRPackageLockDigest(await readFile(REMOTE_R_PACKAGE_LOCK_PATH, "utf8")));
  assert.ok(result.packageCount >= 20 && result.packageCount <= 128);
  assert.ok(result.aggregateBytes > 0 && result.aggregateBytes <= REMOTE_R_PACKAGE_AGGREGATE_MAX_BYTES);
  assert.deepEqual(
    result.lock.roots.runtime.map(({ name }) => name),
    ["IRkernel", "jsonlite", "rlang", "tibble", "data.table", "nanoparquet"]
  );
  assert.deepEqual(result.lock.roots.fixtures, [{ name: "collapse", repository: "supplemental" }]);
  const packages = new Map(result.lock.packages.map((entry) => [entry.name, entry]));
  assert.equal(packages.get("collapse").direct, false);
  assert.equal(packages.get("collapse").category, "fixture");
  assert.equal(packages.get("Rcpp").category, "fixture");
  for (const name of ["IRkernel", "jsonlite", "rlang", "tibble", "data.table", "nanoparquet"]) {
    assert.equal(packages.get(name)?.direct, true);
    assert.equal(packages.get(name)?.category, "runtime");
  }
  for (const entry of result.lock.packages) {
    assert.ok(entry.bytes <= REMOTE_R_PACKAGE_ARCHIVE_MAX_BYTES);
    for (const dependency of entry.dependencies) {
      assert.ok(packages.get(dependency).installOrder < entry.installOrder);
    }
  }
});

test("the remote R archive lock rejects closure, category, URL, bound, duplicate, and canonical drift", async () => {
  const text = await readFile(REMOTE_R_PACKAGE_LOCK_PATH, "utf8");
  const lock = JSON.parse(text);
  const mutate = (callback) => {
    const candidate = structuredClone(lock);
    callback(candidate);
    return `${JSON.stringify(candidate, null, 2)}\n`;
  };
  assert.throws(
    () =>
      validateRemoteRPackageLock(
        mutate((candidate) => (candidate.packages.find(({ name }) => name === "collapse").direct = true))
      ),
    /runtime-direct classification/u
  );
  assert.throws(
    () =>
      validateRemoteRPackageLock(
        mutate((candidate) => (candidate.packages.find(({ name }) => name === "Rcpp").category = "runtime"))
      ),
    /category reachability/u
  );
  assert.throws(
    () => validateRemoteRPackageLock(mutate((candidate) => candidate.packages.pop())),
    /missing dependency|root or dependency/u
  );
  assert.throws(
    () =>
      validateRemoteRPackageLock(
        mutate((candidate) => {
          const packageEntry = candidate.packages.find(({ name }) => name === "IRkernel");
          packageEntry.sourceUrl = packageEntry.sourceUrl.replace("IRkernel_", "IRdisplay_");
        })
      ),
    /source URL/u
  );
  assert.throws(
    () =>
      validateRemoteRPackageLock(
        mutate((candidate) => {
          candidate.packages[0].url = candidate.packages[0].url.replace("https://", "http://");
        })
      ),
    /archive URL/u
  );
  assert.throws(
    () =>
      validateRemoteRPackageLock(
        mutate((candidate) => {
          const packageEntry = candidate.packages.find(({ name }) => name === "Rcpp");
          packageEntry.repository = "primary";
          packageEntry.sourceUrl = candidate.repositories[0].url + `/Rcpp_${packageEntry.version}.tar.gz`;
        })
      ),
    /crossed its canonical repository/u
  );
  assert.throws(
    () =>
      validateRemoteRPackageLock(
        mutate((candidate) => (candidate.packages[0].bytes = REMOTE_R_PACKAGE_ARCHIVE_MAX_BYTES + 1))
      ),
    /archive bounds/u
  );
  assert.throws(
    () => validateRemoteRPackageLock(text.replace('  "protocol":', '  "protocol": "duplicate",\n  "protocol":')),
    /strict JSON/u
  );
  assert.throws(() => validateRemoteRPackageLock(text.replace('  "target"', ' "target"')), /not canonical/u);
});

test("the dependency-free Python installer independently validates the exact complete lock", async (t) => {
  const lockText = await readFile(REMOTE_R_PACKAGE_LOCK_PATH, "utf8");
  const digest = remoteRPackageLockDigest(lockText);
  const installer = resolve(REPOSITORY_ROOT, "scripts", "remote-jupyter", "install-r-packages.py");
  const exact = spawnSync(
    "python3",
    ["-I", installer, "--manifest", REMOTE_R_PACKAGE_LOCK_PATH, "--expected-lock-sha256", digest, "--validate-only"],
    { cwd: REPOSITORY_ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }
  );
  assert.equal(exact.status, 0, exact.stderr);
  assert.equal(exact.signal, null);
  assert.match(exact.stdout, new RegExp(`validated remote R package lock ${digest}`, "u"));

  const directory = await mkdtemp(join(tmpdir(), "ow-r-lock-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const mutated = join(directory, "lock.json");
  await writeFile(mutated, lockText.replace('"bytes": 9472', '"bytes": 9473'), "utf8");
  const rejected = spawnSync(
    "python3",
    ["-I", installer, "--manifest", mutated, "--expected-lock-sha256", digest, "--validate-only"],
    { cwd: REPOSITORY_ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }
  );
  assert.notEqual(rejected.status, 0);
  assert.match(rejected.stderr, /digest does not match/u);
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
  assert.equal(REMOTE_JUPYTER_FSSPEC_EXCLUDE_NEWER, "fsspec=2026-07-29T00:00:00Z");
  assert.deepEqual(argumentsList.slice(0, 3), ["pip", "compile", REMOTE_JUPYTER_INPUT_PATH]);
  assert.ok(argumentsList.includes("--only-binary=:all:"));
  assert.ok(argumentsList.includes("--generate-hashes"));
  assert.ok(argumentsList.includes("--exclude-newer-package"));
  assert.ok(argumentsList.includes(REMOTE_JUPYTER_FSSPEC_EXCLUDE_NEWER));
  assert.ok(argumentsList.includes("--no-config"));
  assert.ok(argumentsList.includes("--upgrade"));
  assert.deepEqual(argumentsList.slice(-2), ["--output-file", output]);
  const rArguments = remoteRJupyterCompileArguments(output);
  assert.deepEqual(rArguments.slice(0, 3), ["pip", "compile", REMOTE_R_JUPYTER_INPUT_PATH]);
  assert.equal(rArguments.includes("--exclude-newer-package"), false);
  const packageOverride = argumentsList.indexOf("--exclude-newer-package");
  assert.deepEqual(rArguments.slice(3), argumentsList.toSpliced(packageOverride, 2).slice(3));
});

test("the lock compiler accepts only the exact resolver version output", () => {
  assert.equal(isRemoteJupyterLockToolVersionOutput("uv 0.11.32 (x86_64-unknown-linux-gnu)\n"), true);
  assert.equal(isRemoteJupyterLockToolVersionOutput("uv 0.11.32\n"), true);
  assert.equal(isRemoteJupyterLockToolVersionOutput("uv 0.11.31 (x86_64-unknown-linux-gnu)\n"), false);
  assert.equal(isRemoteJupyterLockToolVersionOutput("uv 0.11.32 (x86_64-unknown-linux-gnu)\nextra\n"), false);
});

test("source and release producers own the fixture lock without candidate duplication", async () => {
  const [packageText, ci, candidateAcceptance, releaseCandidate, releasedJupyter, vscodeIgnore] = await Promise.all([
    readFile(resolve(REPOSITORY_ROOT, "package.json"), "utf8"),
    readFile(resolve(REPOSITORY_ROOT, ".github", "workflows", "ci.yml"), "utf8"),
    readFile(resolve(REPOSITORY_ROOT, ".github", "workflows", "candidate-acceptance.yml"), "utf8"),
    readFile(resolve(REPOSITORY_ROOT, ".github", "workflows", "release-candidate.yml"), "utf8"),
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
  for (const owner of [ci, releasedJupyter]) {
    assert.match(owner, uvBootstrap);
    assert.match(owner, /run: npm run lock:remote-jupyter:check/u);
  }
  assert.match(releaseCandidate, /run: npm run check:pr/u);
  assert.doesNotMatch(candidateAcceptance, uvBootstrap);
  assert.match(ci, /run: npm run audit:python/u);
  assert.match(releasedJupyter, /run: npm run audit:remote-jupyter/u);
  assert.equal((candidateAcceptance.match(/run: npm run audit:python/gu) ?? []).length, 1);
  assert.doesNotMatch(candidateAcceptance, uvBootstrap);
  assert.doesNotMatch(candidateAcceptance, /run: npm run lock:remote-jupyter:check/u);
  assert.doesNotMatch(candidateAcceptance, /run: npm run audit:remote-jupyter/u);
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
