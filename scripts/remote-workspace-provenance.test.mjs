import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, lstatSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  acceptRemoteWorkspaceCandidate,
  assertRemoteWorkspaceCandidateReceipt,
  assertRemoteWorkspaceFileReceipt,
  captureRemoteWorkspaceFileReceipt,
  stageRemoteWorkspaceCandidate
} from "./remote-workspace-provenance.mjs";

test("candidate receipts bind caller bytes across staging and later source mutation", () => {
  const root = privateRoot("ow-remote-provenance-");
  try {
    const source = join(root, "candidate.vsix");
    const staged = join(root, "staged.vsix");
    const contents = Buffer.from("exact candidate bytes", "utf8");
    writeFileSync(source, contents, { mode: 0o600 });
    const expectation = {
      sha256: createHash("sha256").update(contents).digest("hex"),
      bytes: contents.length
    };
    const sourceReceipt = acceptRemoteWorkspaceCandidate(source, expectation);
    assert.throws(
      () => assertRemoteWorkspaceFileReceipt(source, { ...sourceReceipt, extra: true }),
      /changed after its identity was pinned/u
    );
    const stagedReceipt = stageRemoteWorkspaceCandidate(source, staged, sourceReceipt, expectation);
    if (process.platform !== "win32") assert.equal(lstatSync(staged).mode & 0o777, 0o600);
    assert.deepEqual(readFileSync(staged), contents);
    assert.deepEqual(assertRemoteWorkspaceCandidateReceipt(source, sourceReceipt, expectation), sourceReceipt);
    assert.deepEqual(assertRemoteWorkspaceCandidateReceipt(staged, stagedReceipt, expectation), stagedReceipt);

    writeFileSync(source, Buffer.from("mutated candidate bytes", "utf8"));
    assert.throws(
      () => assertRemoteWorkspaceCandidateReceipt(source, sourceReceipt, expectation),
      /changed after its identity was pinned/u
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("generic provenance receipts reject symlinks and same-path replacement", () => {
  const root = privateRoot("ow-remote-file-receipt-");
  try {
    const path = join(root, "source");
    const link = join(root, "link");
    writeFileSync(path, "first", { mode: 0o600 });
    const receipt = captureRemoteWorkspaceFileReceipt(path);
    writeFileSync(path, "second", { mode: 0o600 });
    assert.throws(() => assertRemoteWorkspaceFileReceipt(path, receipt), /changed after its identity was pinned/u);
    symlinkSync(path, link);
    assert.throws(
      () => captureRemoteWorkspaceFileReceipt(link),
      /bounded no-follow regular receipt file|path changed before it could be opened/u
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("candidate acceptance rejects a caller receipt mismatch", () => {
  const root = privateRoot("ow-remote-candidate-mismatch-");
  try {
    const path = join(root, "candidate.vsix");
    writeFileSync(path, "candidate", { mode: 0o600 });
    assert.throws(
      () => acceptRemoteWorkspaceCandidate(path, { sha256: "a".repeat(64), bytes: 9 }),
      /did not match its caller-supplied/u
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function privateRoot(prefix) {
  const root = mkdtempSync(join(tmpdir(), prefix));
  chmodSync(root, 0o700);
  return root;
}
