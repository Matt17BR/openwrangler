import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { relative, resolve, sep } from "node:path";
import test from "node:test";
import { dataWranglerComparisonCleanupMayBeUnsettled } from "./data-wrangler-comparison-cleanup-safety.mjs";
import { captureDataWranglerPreparationFile } from "./data-wrangler-comparison-preparation.mjs";
import { materializeDataWranglerComparisonRunKernel } from "./data-wrangler-comparison-run-kernel.mjs";

function privateDirectory(path) {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  chmodSync(path, 0o700);
  return path;
}

function createKernel(root) {
  const name = "dataframe-comparison-study-test";
  const displayName = "Dataframe comparison study CPython 3.12.13 (private trial)";
  const directory = privateDirectory(resolve(root, "canonical", "data", "kernels", name));
  const path = resolve(directory, "kernel.json");
  writeFileSync(
    path,
    `${JSON.stringify(
      {
        argv: ["/private/python", "-I", "-m", "ipykernel_launcher", "-f", "{connection_file}"],
        display_name: displayName,
        language: "python",
        metadata: { debugger: false }
      },
      null,
      2
    )}\n`,
    { mode: 0o600, flag: "wx" }
  );
  const receipt = captureDataWranglerPreparationFile(path, "Test comparison kernelspec", {
    maximumBytes: 64 * 1024
  });
  return { path, name, displayName, sha256: receipt.sha256 };
}

function inside(root, path) {
  const value = relative(root, path);
  return value.length > 0 && value !== ".." && !value.startsWith(`..${sep}`);
}

test("materializes one byte-identical kernel in private run-owned Jupyter directories", () => {
  const root = mkdtempSync(resolve(tmpdir(), "ow-run-kernel-"));
  try {
    chmodSync(root, 0o700);
    const runRoot = privateDirectory(resolve(root, "run"));
    const kernel = createKernel(root);
    const result = materializeDataWranglerComparisonRunKernel({ runRoot, kernel });
    assert.equal(readFileSync(result.kernelspecPath, "utf8"), readFileSync(kernel.path, "utf8"));
    assert.equal(result.sha256, kernel.sha256);
    for (const path of Object.values(result.jupyterEnvironment)) {
      assert.equal(inside(runRoot, path), true);
      assert.equal(Number(lstatSync(path, { bigint: true }).mode & 0o777n), 0o700);
    }
    assert.equal(Number(lstatSync(result.kernelspecPath, { bigint: true }).mode & 0o777n), 0o600);
    assert.equal(lstatSync(result.kernelspecPath, { bigint: true }).nlink, 1n);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rejects linked or broadly accessible run roots", () => {
  const root = mkdtempSync(resolve(tmpdir(), "ow-run-kernel-root-"));
  try {
    chmodSync(root, 0o700);
    const kernel = createKernel(root);
    const broadRoot = privateDirectory(resolve(root, "broad"));
    chmodSync(broadRoot, 0o755);
    assert.throws(
      () => materializeDataWranglerComparisonRunKernel({ runRoot: broadRoot, kernel }),
      /mode-700 directory/u
    );
    const privateRoot = privateDirectory(resolve(root, "private"));
    const linkedRoot = resolve(root, "linked");
    symlinkSync(privateRoot, linkedRoot, "dir");
    assert.throws(
      () => materializeDataWranglerComparisonRunKernel({ runRoot: linkedRoot, kernel }),
      /without symbolic links/u
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("publishes exclusively and leaves a pre-existing Jupyter tree untouched", () => {
  const root = mkdtempSync(resolve(tmpdir(), "ow-run-kernel-existing-"));
  try {
    chmodSync(root, 0o700);
    const runRoot = privateDirectory(resolve(root, "run"));
    const kernel = createKernel(root);
    const jupyterRoot = privateDirectory(resolve(runRoot, "jupyter"));
    const sentinel = resolve(jupyterRoot, "keep.txt");
    writeFileSync(sentinel, "keep\n", { mode: 0o600, flag: "wx" });
    assert.throws(() => materializeDataWranglerComparisonRunKernel({ runRoot, kernel }), /EEXIST|already exists/iu);
    assert.equal(readFileSync(sentinel, "utf8"), "keep\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("does not replace a kernelspec planted at the publication boundary", () => {
  const root = mkdtempSync(resolve(tmpdir(), "ow-run-kernel-publication-"));
  try {
    chmodSync(root, 0o700);
    const runRoot = privateDirectory(resolve(root, "run"));
    const kernel = createKernel(root);
    assert.throws(
      () =>
        materializeDataWranglerComparisonRunKernel(
          { runRoot, kernel },
          {
            beforePublish({ publishedPath }) {
              writeFileSync(publishedPath, "planted\n", { mode: 0o600, flag: "wx" });
            }
          }
        ),
      /materialization or exact cleanup failed/iu
    );
    const planted = resolve(runRoot, "jupyter", "data", "kernels", kernel.name, "kernel.json");
    assert.equal(readFileSync(planted, "utf8"), "planted\n");
    assert.equal(existsSync(resolve(runRoot, "jupyter")), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("does not create anything outside the run root after a named-parent swap", () => {
  const root = mkdtempSync(resolve(tmpdir(), "ow-run-kernel-swap-"));
  try {
    chmodSync(root, 0o700);
    const runRoot = privateDirectory(resolve(root, "run"));
    const outside = privateDirectory(resolve(root, "outside"));
    const displaced = resolve(runRoot, "displaced-jupyter");
    const kernel = createKernel(root);
    assert.throws(
      () =>
        materializeDataWranglerComparisonRunKernel(
          { runRoot, kernel },
          {
            beforePublish({ jupyterRoot }) {
              renameSync(jupyterRoot, displaced);
              symlinkSync(outside, jupyterRoot, "dir");
            }
          }
        ),
      /materialization or exact cleanup failed/iu
    );
    assert.deepEqual(readdirSync(outside), []);
    assert.equal(existsSync(resolve(outside, "kernel.json")), false);
    assert.equal(lstatSync(resolve(runRoot, "jupyter")).isSymbolicLink(), true);
    assert.equal(existsSync(displaced), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("retains a failed tree when cleanup finds a foreign descendant", () => {
  const root = mkdtempSync(resolve(tmpdir(), "ow-run-kernel-foreign-"));
  try {
    chmodSync(root, 0o700);
    const runRoot = privateDirectory(resolve(root, "run"));
    const kernel = createKernel(root);
    const foreignText = "foreign descendant\n";
    const operationError = new Error("forced post-publication failure");
    assert.throws(
      () =>
        materializeDataWranglerComparisonRunKernel(
          { runRoot, kernel },
          {
            afterPublish({ jupyterRoot }) {
              writeFileSync(resolve(jupyterRoot, "runtime", "foreign.txt"), foreignText, {
                mode: 0o600,
                flag: "wx"
              });
              throw operationError;
            }
          }
        ),
      (error) =>
        error instanceof AggregateError &&
        dataWranglerComparisonCleanupMayBeUnsettled(error) &&
        error.errors.includes(operationError)
    );
    const foreignPath = resolve(runRoot, "jupyter", "runtime", "foreign.txt");
    assert.equal(readFileSync(foreignPath, "utf8"), foreignText);
    assert.equal(existsSync(resolve(runRoot, "jupyter", "data", "kernels", kernel.name, "kernel.json")), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rejects a successful-looking materialization that contains a foreign descendant", () => {
  const root = mkdtempSync(resolve(tmpdir(), "ow-run-kernel-contaminated-"));
  try {
    chmodSync(root, 0o700);
    const runRoot = privateDirectory(resolve(root, "run"));
    const kernel = createKernel(root);
    const foreignText = "unexpected configuration\n";
    assert.throws(
      () =>
        materializeDataWranglerComparisonRunKernel(
          { runRoot, kernel },
          {
            afterPublish({ jupyterRoot }) {
              writeFileSync(resolve(jupyterRoot, "config", "jupyter_config.py"), foreignText, {
                mode: 0o600,
                flag: "wx"
              });
            }
          }
        ),
      /materialization or exact cleanup failed/iu
    );
    const foreignPath = resolve(runRoot, "jupyter", "config", "jupyter_config.py");
    assert.equal(readFileSync(foreignPath, "utf8"), foreignText);
    assert.equal(existsSync(resolve(runRoot, "jupyter", "data", "kernels", kernel.name, "kernel.json")), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rejects a successful-looking materialization whose published bytes changed", () => {
  const root = mkdtempSync(resolve(tmpdir(), "ow-run-kernel-published-change-"));
  try {
    chmodSync(root, 0o700);
    const runRoot = privateDirectory(resolve(root, "run"));
    const kernel = createKernel(root);
    const original = readFileSync(kernel.path);
    const changed = Buffer.from(original);
    changed[0] = changed[0] === 0x7b ? 0x5b : 0x7b;
    assert.equal(changed.length, original.length);
    assert.throws(
      () =>
        materializeDataWranglerComparisonRunKernel(
          { runRoot, kernel },
          {
            afterPublish({ publishedPath }) {
              writeFileSync(publishedPath, changed, { mode: 0o600 });
            }
          }
        ),
      /materialization or exact cleanup failed/iu
    );
    const publishedPath = resolve(runRoot, "jupyter", "data", "kernels", kernel.name, "kernel.json");
    assert.deepEqual(readFileSync(publishedPath), changed);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("retains a failed tree when the published kernelspec gains a hard link", () => {
  const root = mkdtempSync(resolve(tmpdir(), "ow-run-kernel-hardlink-"));
  try {
    chmodSync(root, 0o700);
    const runRoot = privateDirectory(resolve(root, "run"));
    const kernel = createKernel(root);
    const outsideLink = resolve(root, "published-kernel-hardlink.json");
    assert.throws(
      () =>
        materializeDataWranglerComparisonRunKernel(
          { runRoot, kernel },
          {
            afterPublish({ publishedPath }) {
              linkSync(publishedPath, outsideLink);
              throw new Error("forced post-publication failure");
            }
          }
        ),
      /materialization or exact cleanup failed/iu
    );
    const publishedPath = resolve(runRoot, "jupyter", "data", "kernels", kernel.name, "kernel.json");
    assert.equal(readFileSync(outsideLink, "utf8"), readFileSync(kernel.path, "utf8"));
    assert.equal(lstatSync(outsideLink, { bigint: true }).ino, lstatSync(publishedPath, { bigint: true }).ino);
    assert.equal(lstatSync(publishedPath, { bigint: true }).nlink, 2n);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("detects a same-size in-place canonical kernelspec change after publication", () => {
  const root = mkdtempSync(resolve(tmpdir(), "ow-run-kernel-change-"));
  try {
    chmodSync(root, 0o700);
    const runRoot = privateDirectory(resolve(root, "run"));
    const kernel = createKernel(root);
    const original = readFileSync(kernel.path);
    const changed = Buffer.from(original);
    const marker = changed.indexOf(Buffer.from("private trial"));
    assert.notEqual(marker, -1);
    changed[marker] = changed[marker] === 0x70 ? 0x50 : 0x70;
    assert.equal(changed.length, original.length);
    assert.throws(
      () =>
        materializeDataWranglerComparisonRunKernel(
          { runRoot, kernel },
          {
            afterPublish() {
              writeFileSync(kernel.path, changed, { mode: 0o600 });
            }
          }
        ),
      /changed before its positional read|bytes changed during run-local materialization/u
    );
    assert.equal(existsSync(resolve(runRoot, "jupyter")), false);
    assert.deepEqual(readFileSync(kernel.path), changed);
    assert.equal(existsSync(runRoot), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rejects a linked canonical kernelspec before creating run-local state", () => {
  const root = mkdtempSync(resolve(tmpdir(), "ow-run-kernel-source-"));
  try {
    chmodSync(root, 0o700);
    const runRoot = privateDirectory(resolve(root, "run"));
    const kernel = createKernel(root);
    const linkedDirectory = privateDirectory(resolve(root, "linked-source", kernel.name));
    const linkedPath = resolve(linkedDirectory, "kernel.json");
    symlinkSync(kernel.path, linkedPath);
    assert.throws(
      () => materializeDataWranglerComparisonRunKernel({ runRoot, kernel: { ...kernel, path: linkedPath } }),
      /regular file/u
    );
    assert.equal(existsSync(resolve(runRoot, "jupyter")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
