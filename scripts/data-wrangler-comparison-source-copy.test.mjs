import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  fstatSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  readSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { dataWranglerComparisonCleanupMayBeUnsettled } from "./data-wrangler-comparison-cleanup-safety.mjs";
import {
  DATA_WRANGLER_COMPARISON_SOURCE_COPY_PROTOCOL,
  assertDataWranglerComparisonSourceCopy,
  cleanupDataWranglerComparisonSourceCopy,
  createDataWranglerComparisonSourceCopy,
  withDataWranglerComparisonSourceCopyDescriptor
} from "./data-wrangler-comparison-source-copy.mjs";

const linuxTest = process.platform === "linux" ? test : test.skip;

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "ow-source-copy-test-"));
  chmodSync(root, 0o700);
  const source = resolve(root, "canonical.csv");
  const sourceBytes = Buffer.from("c00,c01\n0,1\n1,2\n", "utf8");
  writeFileSync(source, sourceBytes, { flag: "wx", mode: 0o600 });
  const privateRoot = resolve(root, "trial-private");
  mkdirSync(privateRoot, { mode: 0o700 });
  return { root, source, sourceBytes, privateRoot, copy: resolve(privateRoot, "source.csv") };
}

function removeFixture(root) {
  rmSync(root, { force: true, recursive: true });
}

linuxTest("creates one exclusive mode-0600 byte-identical copy with authentic distinct receipts", () => {
  const current = fixture();
  try {
    const sourceBefore = lstatSync(current.source, { bigint: true });
    const handle = createDataWranglerComparisonSourceCopy({
      canonicalPath: current.source,
      privateRoot: current.privateRoot,
      name: "source.csv",
      maximumBytes: 1_024
    });

    assert.equal(handle.protocol, DATA_WRANGLER_COMPARISON_SOURCE_COPY_PROTOCOL);
    assert.equal(handle.mode, "0600");
    assert.equal(handle.byteIdentical, true);
    assert.deepEqual(readFileSync(current.copy), current.sourceBytes);
    assert.deepEqual(readFileSync(current.source), current.sourceBytes);
    assert.equal(lstatSync(current.copy).mode & 0o777, 0o600);
    assert.equal(handle.canonicalReceipt.sha256, handle.copyReceipt.sha256);
    assert.equal(handle.canonicalReceipt.filesystemIdentity.sizeBytes, handle.copyReceipt.filesystemIdentity.sizeBytes);
    assert.notDeepEqual(
      {
        device: handle.canonicalReceipt.filesystemIdentity.device,
        inode: handle.canonicalReceipt.filesystemIdentity.inode
      },
      {
        device: handle.copyReceipt.filesystemIdentity.device,
        inode: handle.copyReceipt.filesystemIdentity.inode
      }
    );
    assertDataWranglerComparisonSourceCopy(handle);

    const cleanup = cleanupDataWranglerComparisonSourceCopy(handle);
    assert.equal(cleanup.removed, true);
    assert.equal(existsSync(current.copy), false);
    assert.deepEqual(readFileSync(current.source), current.sourceBytes);
    const sourceAfter = lstatSync(current.source, { bigint: true });
    assert.equal(sourceAfter.dev, sourceBefore.dev);
    assert.equal(sourceAfter.ino, sourceBefore.ino);
    assert.throws(() => cleanupDataWranglerComparisonSourceCopy(handle), /unknown or already settled/u);
  } finally {
    removeFixture(current.root);
  }
});

linuxTest("descriptor borrowing exposes only the pinned copy and blocks concurrent cleanup", () => {
  const current = fixture();
  try {
    const handle = createDataWranglerComparisonSourceCopy({
      canonicalPath: current.source,
      privateRoot: current.privateRoot,
      name: "source.csv"
    });
    const result = withDataWranglerComparisonSourceCopyDescriptor(handle, ({ descriptor, receipt }) => {
      const metadata = fstatSync(descriptor, { bigint: true });
      assert.equal(metadata.dev.toString(), receipt.filesystemIdentity.device);
      assert.equal(metadata.ino.toString(), receipt.filesystemIdentity.inode);
      const bytes = Buffer.alloc(current.sourceBytes.length);
      assert.equal(readSync(descriptor, bytes, 0, bytes.length, 0), bytes.length);
      assert.deepEqual(bytes, current.sourceBytes);
      assert.throws(() => cleanupDataWranglerComparisonSourceCopy(handle), /descriptor is still in use/u);
      assert.throws(
        () => withDataWranglerComparisonSourceCopyDescriptor(handle, () => undefined),
        /descriptor is already in use/u
      );
      return "completed";
    });
    assert.equal(result, "completed");
    assert.equal(cleanupDataWranglerComparisonSourceCopy(handle).removed, true);
  } finally {
    removeFixture(current.root);
  }
});

linuxTest("exclusive no-follow creation preserves existing files and symlink referents", () => {
  const current = fixture();
  try {
    writeFileSync(current.copy, "existing\n", { flag: "wx", mode: 0o600 });
    assert.throws(
      () =>
        createDataWranglerComparisonSourceCopy({
          canonicalPath: current.source,
          privateRoot: current.privateRoot,
          name: "source.csv"
        }),
      /Could not create/u
    );
    assert.equal(readFileSync(current.copy, "utf8"), "existing\n");

    unlinkSync(current.copy);
    const referent = resolve(current.root, "referent.txt");
    writeFileSync(referent, "referent\n", { flag: "wx", mode: 0o600 });
    symlinkSync(referent, current.copy);
    assert.throws(
      () =>
        createDataWranglerComparisonSourceCopy({
          canonicalPath: current.source,
          privateRoot: current.privateRoot,
          name: "source.csv"
        }),
      /Could not create/u
    );
    assert.equal(readFileSync(referent, "utf8"), "referent\n");
    assert.equal(lstatSync(current.copy).isSymbolicLink(), true);
  } finally {
    removeFixture(current.root);
  }
});

linuxTest("an unsettled creation rollback is marked and leaves a replacement untouched", () => {
  const current = fixture();
  try {
    const operationError = new Error("injected source-copy creation failure");
    const rollbackError = new Error("injected source-copy rollback boundary failure");
    const replacement = Buffer.from("foreign replacement\n", "utf8");
    assert.throws(
      () =>
        createDataWranglerComparisonSourceCopy(
          {
            canonicalPath: current.source,
            privateRoot: current.privateRoot,
            name: "source.csv"
          },
          {
            faultInjector(checkpoint) {
              if (checkpoint === "after-copy-created") throw operationError;
              assert.equal(checkpoint, "before-rollback-unlink");
              unlinkSync(current.copy);
              writeFileSync(current.copy, replacement, { flag: "wx", mode: 0o600 });
              throw rollbackError;
            }
          }
        ),
      (error) =>
        error instanceof AggregateError &&
        dataWranglerComparisonCleanupMayBeUnsettled(error) &&
        error.errors.includes(operationError) &&
        error.errors.includes(rollbackError)
    );
    assert.deepEqual(readFileSync(current.copy), replacement);
    assert.deepEqual(readFileSync(current.source), current.sourceBytes);
  } finally {
    removeFixture(current.root);
  }
});

linuxTest("creation rollback revalidates a replacement immediately before unlink", () => {
  const current = fixture();
  try {
    const operationError = new Error("injected source-copy creation failure");
    const replacement = Buffer.from("foreign replacement after validation\n", "utf8");
    assert.throws(
      () =>
        createDataWranglerComparisonSourceCopy(
          {
            canonicalPath: current.source,
            privateRoot: current.privateRoot,
            name: "source.csv"
          },
          {
            faultInjector(checkpoint) {
              if (checkpoint === "after-copy-created") throw operationError;
              assert.equal(checkpoint, "before-rollback-unlink");
              unlinkSync(current.copy);
              writeFileSync(current.copy, replacement, { flag: "wx", mode: 0o600 });
            }
          }
        ),
      (error) =>
        error instanceof AggregateError &&
        dataWranglerComparisonCleanupMayBeUnsettled(error) &&
        error.errors.includes(operationError) &&
        error.errors.some((nested) =>
          /could not be identified safely for cleanup/u.test(String(nested?.message ?? nested))
        )
    );
    assert.deepEqual(readFileSync(current.copy), replacement);
    assert.deepEqual(readFileSync(current.source), current.sourceBytes);
  } finally {
    removeFixture(current.root);
  }
});

linuxTest("rejects non-private roots, linked sources, and unsafe copy names", () => {
  const current = fixture();
  try {
    chmodSync(current.privateRoot, 0o755);
    assert.throws(
      () =>
        createDataWranglerComparisonSourceCopy({
          canonicalPath: current.source,
          privateRoot: current.privateRoot,
          name: "source.csv"
        }),
      /Could not create/u
    );
    chmodSync(current.privateRoot, 0o700);

    const linked = resolve(current.root, "canonical-linked.csv");
    linkSync(current.source, linked);
    assert.throws(
      () =>
        createDataWranglerComparisonSourceCopy({
          canonicalPath: current.source,
          privateRoot: current.privateRoot,
          name: "source.csv"
        }),
      /Could not create/u
    );
    unlinkSync(linked);
    const containedSource = resolve(current.privateRoot, "canonical-inside.csv");
    writeFileSync(containedSource, current.sourceBytes, { flag: "wx", mode: 0o600 });
    assert.throws(
      () =>
        createDataWranglerComparisonSourceCopy({
          canonicalPath: containedSource,
          privateRoot: current.privateRoot,
          name: "source.csv"
        }),
      /not isolated from its canonical input/u
    );
    assert.throws(
      () =>
        createDataWranglerComparisonSourceCopy({
          canonicalPath: current.source,
          privateRoot: current.privateRoot,
          name: "../source.csv"
        }),
      /path-free file name/u
    );
  } finally {
    removeFixture(current.root);
  }
});

linuxTest("cleanup leaves a raced replacement untouched and never unlinks the canonical input", () => {
  const current = fixture();
  try {
    const handle = createDataWranglerComparisonSourceCopy({
      canonicalPath: current.source,
      privateRoot: current.privateRoot,
      name: "source.csv"
    });
    const replacement = Buffer.from("foreign replacement\n", "utf8");
    assert.throws(
      () =>
        cleanupDataWranglerComparisonSourceCopy(handle, {
          faultInjector(checkpoint) {
            assert.equal(checkpoint, "before-unlink");
            unlinkSync(current.copy);
            writeFileSync(current.copy, replacement, { flag: "wx", mode: 0o600 });
          }
        }),
      /uncertain names were left untouched/u
    );
    assert.deepEqual(readFileSync(current.copy), replacement);
    assert.deepEqual(readFileSync(current.source), current.sourceBytes);
  } finally {
    removeFixture(current.root);
  }
});

linuxTest("cleanup refuses a hard-link substitution instead of unlinking either source name", () => {
  const current = fixture();
  try {
    const handle = createDataWranglerComparisonSourceCopy({
      canonicalPath: current.source,
      privateRoot: current.privateRoot,
      name: "source.csv"
    });
    assert.throws(
      () =>
        cleanupDataWranglerComparisonSourceCopy(handle, {
          faultInjector() {
            unlinkSync(current.copy);
            linkSync(current.source, current.copy);
          }
        }),
      /uncertain names were left untouched/u
    );
    assert.deepEqual(readFileSync(current.source), current.sourceBytes);
    assert.deepEqual(readFileSync(current.copy), current.sourceBytes);
    assert.equal(lstatSync(current.source).nlink, 2);
  } finally {
    removeFixture(current.root);
  }
});

linuxTest("cleanup fails closed when the private root name is rebound", () => {
  const current = fixture();
  const movedRoot = resolve(current.root, "moved-private");
  try {
    const handle = createDataWranglerComparisonSourceCopy({
      canonicalPath: current.source,
      privateRoot: current.privateRoot,
      name: "source.csv"
    });
    renameSync(current.privateRoot, movedRoot);
    mkdirSync(current.privateRoot, { mode: 0o700 });
    const decoy = resolve(current.privateRoot, "source.csv");
    writeFileSync(decoy, "decoy\n", { flag: "wx", mode: 0o600 });

    assert.throws(() => cleanupDataWranglerComparisonSourceCopy(handle), /uncertain names were left untouched/u);
    assert.deepEqual(readFileSync(resolve(movedRoot, "source.csv")), current.sourceBytes);
    assert.equal(readFileSync(decoy, "utf8"), "decoy\n");
    assert.deepEqual(readFileSync(current.source), current.sourceBytes);
  } finally {
    removeFixture(current.root);
  }
});
