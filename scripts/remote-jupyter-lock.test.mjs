import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { gzipSync } from "node:zlib";

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
  generateRemoteRPackageLock,
  readRemoteRPackageLockFile,
  remoteRPackageLockDigest,
  validateRemoteRPackageLock
} from "./remote-r-package-lock.mjs";

const REPOSITORY_ROOT = resolve(import.meta.dirname, "..");
const R_PACKAGE_INSTALLER = resolve(REPOSITORY_ROOT, "scripts", "remote-jupyter", "install-r-packages.py");

function runInstallerProbe(source, timeout = 10_000) {
  return spawnSync("python3", ["-I", "-c", source, R_PACKAGE_INSTALLER], {
    cwd: REPOSITORY_ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout
  });
}

async function expectBoundedDeadline(promise, pattern) {
  let timer;
  const result = await Promise.race([
    promise.then(
      () => ({ state: "resolved" }),
      (error) => ({ error, state: "rejected" })
    ),
    new Promise((resolvePromise) => {
      timer = setTimeout(() => resolvePromise({ state: "stalled" }), 1_000);
    })
  ]).finally(() => clearTimeout(timer));
  assert.equal(result.state, "rejected", `expected a bounded rejection, received ${result.state}`);
  assert.match(String(result.error), pattern);
}

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
  assert.equal(result.packageCount, 26);
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

test("the installer bounds owned logs without truncating package-created files", () => {
  const probe = runInstallerProbe(String.raw`
import importlib.util
import os
from pathlib import Path
import sys
import tempfile

spec = importlib.util.spec_from_file_location("ow_installer", sys.argv[1])
installer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(installer)
with tempfile.TemporaryDirectory(prefix="ow-r-installer-output-") as directory:
    root = Path(directory)
    package_output = root / "package-output.bin"
    size = installer.COMMAND_LOG_MAX_BYTES + 4096
    installer.bounded_command(
        [
            sys.executable,
            "-c",
            "from pathlib import Path; import sys; Path(sys.argv[1]).write_bytes(b'x' * int(sys.argv[2])); print('ok')",
            str(package_output),
            str(size),
        ],
        dict(os.environ),
        root / "command.log",
    )
    assert package_output.stat().st_size == size
`);
  assert.equal(probe.status, 0, probe.stderr);
  assert.equal(probe.signal, null);
});

test("the installer settles a timed-out owned process tree before descendants can mutate", () => {
  const probe = runInstallerProbe(String.raw`
import importlib.util
import os
from pathlib import Path
import sys
import tempfile
import time

spec = importlib.util.spec_from_file_location("ow_installer", sys.argv[1])
installer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(installer)
installer.COMMAND_TIMEOUT_SECONDS = 0.2
with tempfile.TemporaryDirectory(prefix="ow-r-installer-timeout-") as directory:
    root = Path(directory)
    marker = root / "descendant-survived"
    descendant = "from pathlib import Path; import sys,time; time.sleep(0.4); Path(sys.argv[1]).write_text('survived', encoding='utf8')"
    parent = "import subprocess,sys,time; subprocess.Popen([sys.executable, '-c', sys.argv[2], sys.argv[1]]); time.sleep(10)"
    try:
        installer.bounded_command(
            [sys.executable, "-c", parent, str(marker), descendant],
            dict(os.environ),
            root / "command.log",
        )
    except installer.ContractError:
        pass
    else:
        raise AssertionError("the timed-out command unexpectedly succeeded")
    time.sleep(0.7)
    assert not marker.exists(), "a timed-out descendant remained alive"
`);
  assert.equal(probe.status, 0, probe.stderr);
  assert.equal(probe.signal, null);
});

test("the installer settles an output-overflow owned process tree before descendants can mutate", () => {
  const probe = runInstallerProbe(String.raw`
import importlib.util
import os
from pathlib import Path
import sys
import tempfile
import time

spec = importlib.util.spec_from_file_location("ow_installer", sys.argv[1])
installer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(installer)
with tempfile.TemporaryDirectory(prefix="ow-r-installer-overflow-") as directory:
    root = Path(directory)
    marker = root / "descendant-survived"
    descendant = "from pathlib import Path; import sys,time; time.sleep(0.4); Path(sys.argv[1]).write_text('survived', encoding='utf8')"
    parent = "import os,subprocess,sys,time; subprocess.Popen([sys.executable, '-c', sys.argv[2], sys.argv[1]]); os.write(1, b'x' * (1048576 + 65536)); time.sleep(10)"
    try:
        installer.bounded_command(
            [sys.executable, "-c", parent, str(marker), descendant],
            dict(os.environ),
            root / "command.log",
        )
    except installer.ContractError:
        pass
    else:
        raise AssertionError("the overflowing command unexpectedly succeeded")
    time.sleep(0.7)
    assert not marker.exists(), "an overflowing descendant remained alive"
`);
  assert.equal(probe.status, 0, probe.stderr);
  assert.equal(probe.signal, null);
});

test("the installer settles escaped descendants after diagnostic inventory overflow", () => {
  const probe = runInstallerProbe(String.raw`
import importlib.util
import os
from pathlib import Path
import sys
import tempfile
import time

spec = importlib.util.spec_from_file_location("ow_installer", sys.argv[1])
installer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(installer)
installer.COMMAND_TIMEOUT_SECONDS = 0.2
installer.COMMAND_TERMINATION_GRACE_SECONDS = 0.5
installer.COMMAND_PROCESS_SCAN_MAX_ENTRIES = 1
try:
    installer.linux_process_snapshot()
except installer.ContractError as error:
    assert "inventory exceeded its fixed bound" in str(error)
else:
    raise AssertionError("the lowered diagnostic inventory bound did not overflow")
with tempfile.TemporaryDirectory(prefix="ow-r-installer-setsid-") as directory:
    root = Path(directory)
    descendant = "import os; from pathlib import Path; import sys,time; Path(sys.argv[2]).write_text(str(os.getpid()), encoding='ascii'); time.sleep(0.6); Path(sys.argv[1]).write_text('survived', encoding='utf8')"
    parent = "import os,subprocess,sys,time; from pathlib import Path; root=Path(sys.argv[1]); prefix=sys.argv[2]; source=sys.argv[3]; mode=sys.argv[4]; children=[]\nfor index in range(6):\n marker=root/f'{prefix}-marker-{index}'; ready=root/f'{prefix}-pid-{index}'; children.append(subprocess.Popen([sys.executable,'-c',source,str(marker),str(ready)],start_new_session=True,stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,close_fds=True))\ndeadline=time.monotonic()+0.5\nwhile time.monotonic()<deadline and not all((root/f'{prefix}-pid-{index}').exists() for index in range(6)): time.sleep(0.005)\nassert all((root/f'{prefix}-pid-{index}').exists() for index in range(6))\nif mode == 'overflow': os.write(1, b'x' * (1048576 + 65536))\nelif mode == 'timeout': time.sleep(10)"
    for mode in ("success", "timeout", "overflow"):
        try:
            installer.bounded_command(
                [sys.executable, "-c", parent, str(root), mode, descendant, mode],
                dict(os.environ),
                root / f"{mode}-command.log",
            )
        except installer.ContractError:
            pass
        else:
            raise AssertionError(f"{mode} command with a live escaped descendant unexpectedly succeeded")
        process_ids = [
            int((root / f"{mode}-pid-{index}").read_text(encoding="ascii"))
            for index in range(6)
        ]
        assert all(not Path(f"/proc/{process_id}").exists() for process_id in process_ids), (
            f"{mode} descendants were not reaped"
        )
        assert not list(root.glob(f"{mode}-marker-*")), f"{mode} descendants mutated before settlement"
        time.sleep(0.7)
        assert not list(root.glob(f"{mode}-marker-*")), f"{mode} descendants mutated after settlement"
`);
  assert.equal(probe.status, 0, probe.stderr);
  assert.equal(probe.signal, null);
});

test("the installer fails closed before dispatch rather than claiming an unrelated child", () => {
  const probe = runInstallerProbe(String.raw`
import importlib.util
import os
from pathlib import Path
import subprocess
import sys
import tempfile

spec = importlib.util.spec_from_file_location("ow_installer", sys.argv[1])
installer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(installer)
with tempfile.TemporaryDirectory(prefix="ow-r-installer-exclusive-") as directory:
    root = Path(directory)
    marker = root / "command-dispatched"
    unrelated = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(10)"], start_new_session=True)
    try:
        try:
            installer.bounded_command(
                [sys.executable, "-c", "from pathlib import Path; import sys; Path(sys.argv[1]).touch()", str(marker)],
                dict(os.environ),
                root / "command.log",
            )
        except installer.ContractError as error:
            assert "was not exclusive before dispatch" in str(error)
        else:
            raise AssertionError("command dispatched without an exclusive descendant owner")
        assert unrelated.poll() is None, "the unrelated child was affected"
        assert not marker.exists(), "the command ran before descendant ownership was established"
    finally:
        unrelated.terminate()
        unrelated.wait(timeout=2)
`);
  assert.equal(probe.status, 0, probe.stderr);
  assert.equal(probe.signal, null);
});

test("changed same-version archive bytes reject before install dispatch", () => {
  const probe = runInstallerProbe(String.raw`
import hashlib
import importlib.util
import os
from pathlib import Path
import sys
import tempfile

spec = importlib.util.spec_from_file_location("ow_installer", sys.argv[1])
installer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(installer)
expected = b"expected archive bytes"
changed = b"changed! archive bytes"
assert len(expected) == len(changed)
package = {
    "name": "fixture",
    "version": "1.0.0",
    "bytes": len(expected),
    "sha256": hashlib.sha256(expected).hexdigest(),
}
with tempfile.TemporaryDirectory(prefix="ow-r-installer-drift-") as directory:
    root = Path(directory)
    dispatched = []
    installer.bounded_command = lambda *arguments, **options: dispatched.append((arguments, options))
    for index, archive_bytes in enumerate((changed, changed + b"!")):
        archive = root / f"fixture_1.0.0-{index}.tar.gz"
        archive.write_bytes(archive_bytes)
        try:
            installer.install_verified_archive(
                package,
                archive,
                ["/usr/local/bin/R", "CMD", "INSTALL", str(archive)],
                dict(os.environ),
                root / f"command-{index}.log",
            )
        except installer.ContractError:
            pass
        else:
            raise AssertionError("changed same-version bytes were accepted")
    assert dispatched == [], "install dispatch occurred before archive identity rejection"
`);
  assert.equal(probe.status, 0, probe.stderr);
  assert.equal(probe.signal, null);
});

test("lock generation has request-header, body-progress, and aggregate deadlines", async () => {
  const headerSignals = [];
  await expectBoundedDeadline(
    generateRemoteRPackageLock({
      deadlines: { aggregateMs: 250, bodyProgressMs: 100, requestHeaderMs: 25 },
      fetchImpl: (_url, { signal }) => {
        headerSignals.push(signal);
        return new Promise(() => {});
      }
    }),
    /request-header deadline/u
  );
  assert.equal(headerSignals.length, 1);
  assert.equal(headerSignals[0].aborted, true);

  const stalledBody = {
    [Symbol.asyncIterator]() {
      return { next: () => new Promise(() => {}) };
    }
  };
  const bodySignals = [];
  await expectBoundedDeadline(
    generateRemoteRPackageLock({
      deadlines: { aggregateMs: 250, bodyProgressMs: 25, requestHeaderMs: 100 },
      fetchImpl: async (url, { signal }) => {
        bodySignals.push(signal);
        return { body: stalledBody, headers: { get: () => null }, status: 200, url };
      }
    }),
    /body-progress deadline/u
  );
  assert.equal(bodySignals.length, 1);
  assert.equal(bodySignals[0].aborted, true);

  const aggregateSignals = [];
  await expectBoundedDeadline(
    generateRemoteRPackageLock({
      deadlines: { aggregateMs: 25, bodyProgressMs: 100, requestHeaderMs: 100 },
      fetchImpl: async (url, { signal }) => {
        aggregateSignals.push(signal);
        await delay(100);
        return { body: [], headers: { get: () => null }, status: 200, url };
      }
    }),
    /aggregate deadline/u
  );
  assert.equal(aggregateSignals.length, 1);
  assert.equal(aggregateSignals[0].aborted, true);

  const zeroByteSignals = [];
  const zeroByteBody = {
    [Symbol.asyncIterator]() {
      return { next: () => Promise.resolve({ done: false, value: new Uint8Array(0) }) };
    }
  };
  await expectBoundedDeadline(
    generateRemoteRPackageLock({
      deadlines: { aggregateMs: 25, bodyProgressMs: 100, requestHeaderMs: 100 },
      fetchImpl: async (url, { signal }) => {
        zeroByteSignals.push(signal);
        return { body: zeroByteBody, headers: { get: () => null }, status: 200, url };
      }
    }),
    /zero-byte body chunk/u
  );
  assert.equal(zeroByteSignals.length, 1);
  assert.equal(zeroByteSignals[0].aborted, true);

  const microtaskSignals = [];
  const endlessPositiveBody = {
    [Symbol.asyncIterator]() {
      return { next: () => Promise.resolve({ done: false, value: Uint8Array.of(1) }) };
    }
  };
  await expectBoundedDeadline(
    generateRemoteRPackageLock({
      deadlines: { aggregateMs: 5, bodyProgressMs: 100, requestHeaderMs: 100 },
      fetchImpl: async (url, { signal }) => {
        microtaskSignals.push(signal);
        return { body: endlessPositiveBody, headers: { get: () => null }, status: 200, url };
      }
    }),
    /aggregate deadline/u
  );
  assert.equal(microtaskSignals.length, 1);
  assert.equal(microtaskSignals[0].aborted, true);

  const boundedMetadata = gzipSync("Package: bounded\nVersion: 1.0.0\n\n");
  let boundedBodyReads = 0;
  await assert.rejects(
    generateRemoteRPackageLock({
      deadlines: { aggregateMs: 250, bodyProgressMs: 100, requestHeaderMs: 100 },
      fetchImpl: async (url) => ({
        body: {
          [Symbol.asyncIterator]() {
            let emitted = false;
            return {
              next: () => {
                boundedBodyReads += 1;
                if (emitted) return Promise.resolve({ done: true });
                emitted = true;
                return Promise.resolve({ done: false, value: boundedMetadata });
              }
            };
          }
        },
        headers: { get: () => String(boundedMetadata.byteLength) },
        status: 200,
        url
      })
    }),
    /does not contain required package/u
  );
  assert.equal(boundedBodyReads, 4);
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
