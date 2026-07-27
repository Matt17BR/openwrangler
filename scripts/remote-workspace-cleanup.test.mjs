import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  createEditorAcceptancePrivateRootReceipt,
  removeEditorAcceptancePrivateRoot
} from "./packaged-editor-orchestration.mjs";
import {
  createRemoteWorkspaceOwnedFileCleanupReceipt,
  removeRemoteWorkspaceOwnedFile
} from "./remote-workspace-cleanup.mjs";

const CLEANUP_ID = "11111111-1111-4111-8111-111111111111";

test("Remote SSH private-root cleanup preserves both trees after its parent is replaced", async () => {
  const fixture = await mkdtemp(join(tmpdir(), "ow-remote-root-parent-swap-"));
  const parent = join(fixture, "parent");
  const parkedParent = join(fixture, "parked-parent");
  const root = join(parent, "root");
  try {
    await mkdir(root, { recursive: true });
    await writeFile(join(root, "owned.txt"), "owned\n");
    const receipt = createEditorAcceptancePrivateRootReceipt(root, { containedBy: parent });
    await rename(parent, parkedParent);
    await mkdir(root, { recursive: true });
    await writeFile(join(root, "replacement.txt"), "replacement\n");

    assert.throws(
      () => removeEditorAcceptancePrivateRoot(receipt),
      (error) => error?.code === "EDITOR_PRIVATE_ROOT_IDENTITY_LOST"
    );
    assert.equal(await readFile(join(parkedParent, "root", "owned.txt"), "utf8"), "owned\n");
    assert.equal(await readFile(join(root, "replacement.txt"), "utf8"), "replacement\n");
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test("Remote SSH private-root cleanup preserves both quarantines after a parent swap", async () => {
  const fixture = await mkdtemp(join(tmpdir(), "ow-remote-root-quarantine-parent-swap-"));
  const parent = join(fixture, "parent");
  const parkedParent = join(fixture, "parked-parent");
  const root = join(parent, "root");
  const quarantineName = `.openwrangler-remove-${CLEANUP_ID}`;
  try {
    await mkdir(root, { recursive: true });
    await writeFile(join(root, "owned.txt"), "owned\n");
    const receipt = createEditorAcceptancePrivateRootReceipt(root, { containedBy: parent });

    assert.throws(
      () =>
        removeEditorAcceptancePrivateRoot(receipt, {
          cleanupId: () => CLEANUP_ID,
          moveToQuarantine(source, target) {
            renameSync(source, target);
            renameSync(parent, parkedParent);
            mkdirSync(parent);
            mkdirSync(target);
            writeFileSync(join(target, "replacement.txt"), "replacement\n");
          }
        }),
      (error) => error?.code === "EDITOR_PRIVATE_ROOT_IDENTITY_LOST"
    );
    assert.equal(await readFile(join(parkedParent, quarantineName, "owned.txt"), "utf8"), "owned\n");
    assert.equal(await readFile(join(parent, quarantineName, "replacement.txt"), "utf8"), "replacement\n");
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test("Remote SSH owned-file cleanup removes only its quarantined sentinel", async () => {
  const fixture = await mkdtemp(join(tmpdir(), "ow-remote-file-cleanup-"));
  const parent = join(fixture, "parent");
  const sentinel = join(parent, "sentinel");
  const sibling = join(parent, "sibling");
  try {
    await mkdir(parent);
    await writeFile(sentinel, "sentinel\n");
    await writeFile(sibling, "preserve\n");
    const receipt = createRemoteWorkspaceOwnedFileCleanupReceipt(sentinel, {
      parentContainedBy: fixture
    });
    removeRemoteWorkspaceOwnedFile(receipt, { cleanupId: () => CLEANUP_ID });
    await assert.rejects(access(sentinel), { code: "ENOENT" });
    assert.equal(await readFile(sibling, "utf8"), "preserve\n");
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test("Remote SSH owned-file cleanup preserves a same-path replacement", async () => {
  const fixture = await mkdtemp(join(tmpdir(), "ow-remote-file-path-swap-"));
  const parent = join(fixture, "parent");
  const sentinel = join(parent, "sentinel");
  const displaced = join(parent, "displaced");
  try {
    await mkdir(parent);
    await writeFile(sentinel, "owned\n");
    const receipt = createRemoteWorkspaceOwnedFileCleanupReceipt(sentinel, {
      parentContainedBy: fixture
    });
    await rename(sentinel, displaced);
    await writeFile(sentinel, "replacement\n");
    assert.throws(
      () => removeRemoteWorkspaceOwnedFile(receipt),
      (error) => error?.code === "REMOTE_WORKSPACE_OWNED_FILE_IDENTITY_LOST"
    );
    assert.equal(await readFile(displaced, "utf8"), "owned\n");
    assert.equal(await readFile(sentinel, "utf8"), "replacement\n");
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test("Remote SSH owned-file cleanup preserves a replacement at its quarantine", async () => {
  const fixture = await mkdtemp(join(tmpdir(), "ow-remote-file-final-swap-"));
  const parent = join(fixture, "parent");
  const sentinel = join(parent, "sentinel");
  const displaced = join(parent, "displaced");
  const quarantine = join(parent, `.openwrangler-remove-${CLEANUP_ID}`);
  try {
    await mkdir(parent);
    await writeFile(sentinel, "owned\n");
    const receipt = createRemoteWorkspaceOwnedFileCleanupReceipt(sentinel, {
      parentContainedBy: fixture
    });
    assert.throws(
      () =>
        removeRemoteWorkspaceOwnedFile(receipt, {
          cleanupId: () => CLEANUP_ID,
          beforeRemove(target) {
            renameSync(target, displaced);
            writeFileSync(target, "replacement\n");
          }
        }),
      (error) => error?.code === "REMOTE_WORKSPACE_OWNED_FILE_IDENTITY_LOST"
    );
    assert.equal(await readFile(displaced, "utf8"), "owned\n");
    assert.equal(await readFile(quarantine, "utf8"), "replacement\n");
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test("Remote SSH owned-file cleanup preserves both parent trees after quarantine", async () => {
  const fixture = await mkdtemp(join(tmpdir(), "ow-remote-file-parent-swap-"));
  const parent = join(fixture, "parent");
  const parkedParent = join(fixture, "parked-parent");
  const sentinel = join(parent, "sentinel");
  const quarantineName = `.openwrangler-remove-${CLEANUP_ID}`;
  try {
    await mkdir(parent);
    await writeFile(sentinel, "owned\n");
    const receipt = createRemoteWorkspaceOwnedFileCleanupReceipt(sentinel, {
      parentContainedBy: fixture
    });
    assert.throws(
      () =>
        removeRemoteWorkspaceOwnedFile(receipt, {
          cleanupId: () => CLEANUP_ID,
          moveToQuarantine(source, target) {
            renameSync(source, target);
            renameSync(parent, parkedParent);
            mkdirSync(parent);
            writeFileSync(target, "replacement\n");
          }
        }),
      (error) => error?.code === "REMOTE_WORKSPACE_OWNED_FILE_IDENTITY_LOST"
    );
    assert.equal(await readFile(join(parkedParent, quarantineName), "utf8"), "owned\n");
    assert.equal(await readFile(join(parent, quarantineName), "utf8"), "replacement\n");
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test("Remote SSH owned-file cleanup rejects a planted quarantine without touching either file", async () => {
  const fixture = await mkdtemp(join(tmpdir(), "ow-remote-file-collision-"));
  const parent = join(fixture, "parent");
  const sentinel = join(parent, "sentinel");
  const quarantine = join(parent, `.openwrangler-remove-${CLEANUP_ID}`);
  try {
    await mkdir(parent);
    await writeFile(sentinel, "owned\n");
    await writeFile(quarantine, "planted\n");
    const receipt = createRemoteWorkspaceOwnedFileCleanupReceipt(sentinel, {
      parentContainedBy: fixture
    });
    assert.throws(
      () => removeRemoteWorkspaceOwnedFile(receipt, { cleanupId: () => CLEANUP_ID }),
      (error) => error?.code === "REMOTE_WORKSPACE_OWNED_FILE_IDENTITY_LOST"
    );
    assert.equal(await readFile(sentinel, "utf8"), "owned\n");
    assert.equal(await readFile(quarantine, "utf8"), "planted\n");
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});
