import assert from "node:assert/strict";
import {
  chmodSync,
  constants,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import {
  DATA_WRANGLER_COMPARISON_CACHE_CONTROLLER_PROTOCOL,
  DATA_WRANGLER_COMPARISON_CACHE_TOOLCHAIN_PROTOCOL,
  captureDataWranglerComparisonStudyV2Toolchain,
  runDataWranglerComparisonStudyV2CacheController
} from "./data-wrangler-comparison-cache-controller.mjs";
import {
  cleanupDataWranglerComparisonSourceCopy,
  createDataWranglerComparisonSourceCopy
} from "./data-wrangler-comparison-source-copy.mjs";

const linuxTest = process.platform === "linux" ? test : test.skip;

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "ow-cache-controller-test-"));
  chmodSync(root, 0o700);
  const canonicalPath = resolve(root, "canonical.csv");
  writeFileSync(canonicalPath, Buffer.from("c00,c01\n0,1\n1,2\n", "utf8"), { flag: "wx", mode: 0o600 });
  const privateRoot = resolve(root, "private");
  mkdirSync(privateRoot, { mode: 0o700 });
  const controllerPath = resolve(root, "source_cache_control.py");
  copyFileSync(resolve("python/benchmarks/source_cache_control.py"), controllerPath, constants.COPYFILE_EXCL);
  chmodSync(controllerPath, 0o600);
  const sourceCopy = createDataWranglerComparisonSourceCopy({
    canonicalPath,
    privateRoot,
    name: "source.csv"
  });
  return {
    root,
    canonicalPath,
    canonicalBytes: readFileSync(canonicalPath),
    controllerPath,
    sourceCopy,
    pythonExecutablePath: realpathSync(process.env.OPEN_WRANGLER_TEST_PYTHON ?? "/usr/bin/python3")
  };
}

function dispose(current) {
  try {
    cleanupDataWranglerComparisonSourceCopy(current.sourceCopy);
  } catch {
    // A failed-close test may have deliberately settled the opaque lease.
  }
  rmSync(current.root, { force: true, recursive: true });
}

linuxTest("runs study-v2 through inherited fd 3 and binds the proof to host receipts", () => {
  const current = fixture();
  try {
    const capturedToolchain = captureDataWranglerComparisonStudyV2Toolchain({
      pythonExecutablePath: current.pythonExecutablePath,
      controllerPath: current.controllerPath
    });
    const receipt = runDataWranglerComparisonStudyV2CacheController({
      sourceCopy: current.sourceCopy,
      cacheState: "warm",
      pythonExecutablePath: current.pythonExecutablePath,
      controllerPath: current.controllerPath
    });

    assert.equal(receipt.protocol, DATA_WRANGLER_COMPARISON_CACHE_CONTROLLER_PROTOCOL);
    assert.equal(capturedToolchain.protocol, DATA_WRANGLER_COMPARISON_CACHE_TOOLCHAIN_PROTOCOL);
    assert.deepEqual(receipt.toolchain, capturedToolchain);
    assert.equal(receipt.proof.protocol, "openwrangler-source-cache-proof-study-v2");
    assert.equal(receipt.proof.requestedState, "resident");
    assert.deepEqual(receipt.proof.sourceFilesystemIdentityBefore, current.sourceCopy.copyReceipt.filesystemIdentity);
    assert.deepEqual(receipt.proof.sourceFilesystemIdentityAfter, current.sourceCopy.copyReceipt.filesystemIdentity);
    assert.equal(receipt.proof.controller.sha256.length, 64);
    assert.equal(receipt.proof.pythonExecutable.sha256.length, 64);
    assert.equal(receipt.proof.residentPagesAfter, receipt.proof.totalPages);
    assert.deepEqual(readFileSync(current.canonicalPath), current.canonicalBytes);
  } finally {
    dispose(current);
  }
});

linuxTest("revalidates the named controller immediately before spawn and launches no child after replacement", () => {
  const current = fixture();
  let spawnCount = 0;
  const replacement = Buffer.from("raise SystemExit(9)\n", "utf8");
  try {
    assert.throws(
      () =>
        runDataWranglerComparisonStudyV2CacheController(
          {
            sourceCopy: current.sourceCopy,
            cacheState: "warm",
            pythonExecutablePath: current.pythonExecutablePath,
            controllerPath: current.controllerPath
          },
          {
            faultInjector(checkpoint) {
              assert.equal(checkpoint, "before-spawn");
              unlinkSync(current.controllerPath);
              writeFileSync(current.controllerPath, replacement, { flag: "wx", mode: 0o600 });
            },
            spawn() {
              spawnCount += 1;
              throw new Error("spawn must not run");
            }
          }
        ),
      /host-pinned toolchain/u
    );
    assert.equal(spawnCount, 0);
    assert.deepEqual(readFileSync(current.controllerPath), replacement);
    assert.deepEqual(readFileSync(current.canonicalPath), current.canonicalBytes);
  } finally {
    dispose(current);
  }
});
