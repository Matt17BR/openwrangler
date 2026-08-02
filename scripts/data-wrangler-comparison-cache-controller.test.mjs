import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  constants,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
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
  const pythonExecutablePath = resolve(root, "python3");
  copyFileSync(
    realpathSync(process.env.OPEN_WRANGLER_TEST_PYTHON ?? "/usr/bin/python3"),
    pythonExecutablePath,
    constants.COPYFILE_EXCL
  );
  chmodSync(pythonExecutablePath, 0o700);
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
    pythonExecutablePath
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

linuxTest("an evicted acknowledgement binds the exact private copy receipt", () => {
  const current = fixture();
  try {
    const capturedToolchain = captureDataWranglerComparisonStudyV2Toolchain({
      pythonExecutablePath: current.pythonExecutablePath,
      controllerPath: current.controllerPath
    });
    const identity = current.sourceCopy.copyReceipt.filesystemIdentity;
    const pageSizeBytes = 4_096;
    const totalPages = Math.ceil(identity.sizeBytes / pageSizeBytes);
    const receipt = runDataWranglerComparisonStudyV2CacheController(
      {
        sourceCopy: current.sourceCopy,
        cacheState: "cold",
        pythonExecutablePath: current.pythonExecutablePath,
        controllerPath: current.controllerPath
      },
      {
        spawn() {
          return {
            status: 0,
            signal: null,
            stderr: "",
            stdout: JSON.stringify({
              protocol: "openwrangler-source-cache-proof-study-v2",
              requestedState: "evicted",
              fdatasyncApplied: true,
              adviceAccepted: true,
              verification: "linux-mincore",
              pageSizeBytes,
              totalPages,
              residentPagesBefore: totalPages,
              residentPagesAfter: 0,
              identityStable: true,
              verified: true,
              sourceFilesystemIdentityBefore: identity,
              sourceFilesystemIdentityAfter: identity,
              controller: capturedToolchain.controller,
              pythonExecutable: capturedToolchain.pythonExecutable
            })
          };
        }
      }
    );

    assert.equal(receipt.proof.requestedState, "evicted");
    assert.equal(receipt.proof.residentPagesAfter, 0);
    assert.deepEqual(receipt.proof.sourceFilesystemIdentityBefore, identity);
    assert.deepEqual(receipt.proof.sourceFilesystemIdentityAfter, identity);
    assert.deepEqual(receipt.toolchain, capturedToolchain);
  } finally {
    dispose(current);
  }
});

linuxTest("path rebinding cannot change the descriptor-executed interpreter, controller, or source", () => {
  const current = fixture();
  let observedProof;
  try {
    const expectedToolchain = captureDataWranglerComparisonStudyV2Toolchain({
      pythonExecutablePath: current.pythonExecutablePath,
      controllerPath: current.controllerPath
    });
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
            spawn(executable, arguments_, options) {
              assert.equal(executable, "/proc/self/fd/4");
              assert.equal(arguments_[0], "/proc/self/fd/3");
              assert.deepEqual(arguments_.slice(1, 3), ["--source-fd", "5"]);
              renameSync(current.controllerPath, `${current.controllerPath}.pinned`);
              writeFileSync(current.controllerPath, "raise SystemExit(97)\n", { flag: "wx", mode: 0o600 });
              renameSync(current.pythonExecutablePath, `${current.pythonExecutablePath}.pinned`);
              writeFileSync(current.pythonExecutablePath, "not the pinned interpreter\n", {
                flag: "wx",
                mode: 0o700
              });
              renameSync(current.sourceCopy.copyPath, `${current.sourceCopy.copyPath}.pinned`);
              writeFileSync(current.sourceCopy.copyPath, "decoy source bytes\n", { flag: "wx", mode: 0o600 });
              const result = spawnSync(executable, arguments_, options);
              observedProof = JSON.parse(result.stdout);
              return result;
            }
          }
        ),
      /retained lease changed|host-pinned toolchain/u
    );
    assert.deepEqual(observedProof.controller, expectedToolchain.controller);
    assert.deepEqual(observedProof.pythonExecutable, expectedToolchain.pythonExecutable);
    assert.deepEqual(observedProof.sourceFilesystemIdentityBefore, current.sourceCopy.copyReceipt.filesystemIdentity);
    assert.deepEqual(observedProof.sourceFilesystemIdentityAfter, current.sourceCopy.copyReceipt.filesystemIdentity);
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
