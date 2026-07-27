import assert from "node:assert/strict";
import fs, {
  linkSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  truncateSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { MAX_VSIX_BYTES, readBoundedVsixFileSnapshot } from "./vsix-archive.mjs";

test("reads one bounded VSIX through a descriptor-bound immutable snapshot", (context) => {
  const root = mkdtempSync(join(tmpdir(), "ow-vsix-snapshot-"));
  context.after(() => rmSync(root, { force: true, recursive: true }));
  const candidate = join(root, "candidate.vsix");
  writeFileSync(candidate, "candidate bytes", { flag: "wx", mode: 0o600 });

  const snapshot = readBoundedVsixFileSnapshot(candidate, { requireOwner: true });
  assert.deepEqual(snapshot.bytes, Buffer.from("candidate bytes"));
  assert.equal(snapshot.identity.size, 15n);
  assert.equal(typeof snapshot.identity.dev, "bigint");
  assert.equal(typeof snapshot.identity.ino, "bigint");
  assert.ok(Object.isFrozen(snapshot));
  assert.ok(Object.isFrozen(snapshot.identity));
});

test("rejects symlinked and hard-linked VSIX paths without reading them", (context) => {
  const root = mkdtempSync(join(tmpdir(), "ow-vsix-links-"));
  context.after(() => rmSync(root, { force: true, recursive: true }));
  const candidate = join(root, "candidate.vsix");
  const hardLink = join(root, "candidate-hard.vsix");
  const symbolicLink = join(root, "candidate-symbolic.vsix");
  writeFileSync(candidate, "candidate bytes", { flag: "wx", mode: 0o600 });
  linkSync(candidate, hardLink);
  assert.throws(() => readBoundedVsixFileSnapshot(candidate), /regular, unlinked file/u);

  symlinkSync(candidate, symbolicLink);
  assert.throws(() => readBoundedVsixFileSnapshot(symbolicLink), /regular, unlinked file|cannot be inspected/u);
});

test("rejects empty and sparse oversized VSIX files before reading payload bytes", (context) => {
  const root = mkdtempSync(join(tmpdir(), "ow-vsix-size-"));
  context.after(() => rmSync(root, { force: true, recursive: true }));
  const empty = join(root, "empty.vsix");
  const oversized = join(root, "oversized.vsix");
  writeFileSync(empty, "", { flag: "wx", mode: 0o600 });
  writeFileSync(oversized, "x", { flag: "wx", mode: 0o600 });
  truncateSync(oversized, MAX_VSIX_BYTES + 1);

  assert.throws(() => readBoundedVsixFileSnapshot(empty), /between 1 and/u);
  assert.throws(() => readBoundedVsixFileSnapshot(oversized), /between 1 and/u);
});

test("rejects a named-path inode swap around the descriptor read", (context) => {
  const root = mkdtempSync(join(tmpdir(), "ow-vsix-swap-"));
  context.after(() => rmSync(root, { force: true, recursive: true }));
  const candidate = join(root, "candidate.vsix");
  const moved = join(root, "moved.vsix");
  writeFileSync(candidate, "original candidate bytes", { flag: "wx", mode: 0o600 });

  const originalReadFileSync = readFileSync;
  let swapped = false;
  context.mock.method(fs, "readFileSync", (...args) => {
    if (!swapped && typeof args[0] === "number") {
      swapped = true;
      renameSync(candidate, moved);
      writeFileSync(candidate, "replacement candidate bytes", { flag: "wx", mode: 0o600 });
    }
    return originalReadFileSync(...args);
  });

  assert.throws(() => readBoundedVsixFileSnapshot(candidate), /changed while its descriptor snapshot was read/u);
  assert.equal(swapped, true);
});
