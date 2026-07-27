import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  assertRemoteWorkspaceExactFileStage,
  assertRemoteWorkspaceTreeStage,
  stageRemoteWorkspaceExactFile,
  stageRemoteWorkspaceTree
} from "./remote-workspace-staging.mjs";

test("exact staged harness files retain source, destination, bytes, and mode receipts", () => {
  const root = privateRoot("ow-remote-stage-file-");
  try {
    const source = join(root, "source.mjs");
    const staged = join(root, "staged.mjs");
    writeFileSync(source, "export {};\n", { mode: 0o640 });
    const receipt = stageRemoteWorkspaceExactFile(source, staged, 0o700);
    assert.equal(receipt.sourcePath, source);
    assert.equal(receipt.stagedPath, staged);
    assert.equal(Number(receipt.stagedReceipt.mode & 0o777n), 0o700);
    assert.equal(assertRemoteWorkspaceExactFileStage(receipt), receipt);
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
    writeFileSync(join(source, "nested", "package.json"), '{"name":"fixture"}\n', { mode: 0o640 });
    const receipt = stageRemoteWorkspaceTree(source, staged, {
      label: "Remote SSH staging regression tree",
      maximumFiles: 8,
      maximumBytes: 1_024,
      maximumFileBytes: 512
    });
    assert.equal(receipt.sourceManifest.files.length, 2);
    assert.equal(receipt.stagedManifest.files.length, 2);
    assert.equal(assertRemoteWorkspaceTreeStage(receipt), receipt);
    writeFileSync(join(staged, "index.js"), "export const changed = true;\n");
    assert.throws(() => assertRemoteWorkspaceTreeStage(receipt), /changed after its provenance was pinned/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function privateRoot(prefix) {
  const root = mkdtempSync(join(tmpdir(), prefix));
  chmodSync(root, 0o700);
  return root;
}
