import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  assertRemoteWorkspaceExactFileStage,
  assertRemoteWorkspaceTreeStage,
  stageRemoteWorkspaceExactFile,
  stageRemoteWorkspaceTree
} from "./remote-workspace-staging.mjs";

const posixTest = process.platform === "win32" ? test.skip : test;

posixTest("exact staged harness files retain source, destination, bytes, and mode receipts", () => {
  const root = privateRoot("ow-remote-stage-file-");
  try {
    const source = join(root, "source.mjs");
    const staged = join(root, "staged.mjs");
    writeFileSync(source, "export {};\n", { mode: 0o640 });
    const receipt = stageRemoteWorkspaceExactFile(source, staged, 0o700, { maximumBytes: 1_024 });
    assert.equal(receipt.sourcePath, source);
    assert.equal(receipt.stagedPath, staged);
    assert.equal(Number(receipt.stagedReceipt.mode & 0o777n), 0o700);
    assert.equal(receipt.receiptPolicy.maximumBytes, 1_024);
    assert.equal(assertRemoteWorkspaceExactFileStage(receipt), receipt);
    for (const receiptPolicy of [null, [], { maximumBytes: 0 }, { maximumBytes: 1_024, extra: true }]) {
      assert.throws(
        () =>
          stageRemoteWorkspaceExactFile(source, join(root, `rejected-${String(receiptPolicy)}`), 0o700, receiptPolicy),
        /bounded receipt policy/u
      );
    }
    const oversized = join(root, "oversized-node");
    writeFileSync(oversized, "x", { mode: 0o700 });
    truncateSync(oversized, 1_025);
    assert.throws(
      () => stageRemoteWorkspaceExactFile(oversized, join(root, "rejected-oversized"), 0o700, { maximumBytes: 1_024 }),
      /bounded no-follow regular receipt file/u
    );
    writeFileSync(source, "export const changed = true;\n");
    assert.throws(() => assertRemoteWorkspaceExactFileStage(receipt), /changed after its identity was pinned/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("bounded staged trees retain independent source and destination manifests", () => {
  const root = privateRoot("ow-remote-stage-tree-");
  try {
    const source = join(root, "source");
    const staged = join(root, "staged");
    mkdirSync(join(source, "nested"), { recursive: true, mode: 0o700 });
    writeFileSync(join(source, "index.js"), "export {};\n", { mode: 0o600 });
    writeFileSync(join(source, "empty"), "", { mode: 0o600 });
    writeFileSync(join(source, "nested", "package.json"), '{"name":"fixture"}\n', { mode: 0o640 });
    const receipt = stageRemoteWorkspaceTree(source, staged, {
      label: "Remote SSH staging regression tree",
      maximumFiles: 8,
      maximumBytes: 1_024,
      maximumFileBytes: 512
    });
    assert.equal(receipt.sourceManifest.files.length, 3);
    assert.equal(receipt.stagedManifest.files.length, 3);
    assert.equal(assertRemoteWorkspaceTreeStage(receipt), receipt);
    writeFileSync(join(staged, "index.js"), "export const changed = true;\n");
    assert.throws(() => assertRemoteWorkspaceTreeStage(receipt), /changed after its provenance was pinned/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function privateRoot(prefix) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  chmodSync(root, 0o700);
  return root;
}
