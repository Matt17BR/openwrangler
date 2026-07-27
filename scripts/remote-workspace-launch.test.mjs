import assert from "node:assert/strict";
import {
  chmodSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  truncateSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { PINNED_REMOTE_VSCODE_COMMIT } from "./remote-workspace-acquisition.mjs";
import { REMOTE_WORKSPACE_PHASE_NODE_MAXIMUM_BYTES } from "./remote-workspace-contract.mjs";
import {
  assertRemoteWorkspaceImmutableInputRegistry,
  createRemoteWorkspaceImmutableInputRegistry,
  createRemoteWorkspaceImmutableMountTemplate,
  openRemoteWorkspaceImmutableInputLeases,
  REMOTE_WORKSPACE_IMMUTABLE_INPUT_IDS,
  validateRemoteWorkspaceImmutableMounts
} from "./remote-workspace-launch.mjs";

const linuxTest = process.platform === "linux" ? test : test.skip;

linuxTest("Remote launch registry requires every classified authority, state, and guard input exactly once", () => {
  const root = fixtureRoot("ow-remote-launch-registry-");
  try {
    const sources = createRegistrySources(root);
    const registry = createRemoteWorkspaceImmutableInputRegistry(sources, registryOptions());
    assert.equal(assertRemoteWorkspaceImmutableInputRegistry(registry), registry);
    assert.deepEqual(
      registry.entries.map((entry) => entry.id),
      REMOTE_WORKSPACE_IMMUTABLE_INPUT_IDS
    );
    for (const mutation of [
      Object.fromEntries(Object.entries(sources).slice(1)),
      { ...sources, extra: sources.descriptor }
    ]) {
      assert.throws(
        () => createRemoteWorkspaceImmutableInputRegistry(mutation, registryOptions()),
        /incomplete or malformed/u
      );
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

linuxTest("Remote launch registry rejects immutable add, remove, symlink, and hard-link drift", () => {
  const root = fixtureRoot("ow-remote-launch-drift-");
  try {
    const sources = createRegistrySources(root);
    const registry = createRemoteWorkspaceImmutableInputRegistry(sources, registryOptions());
    const added = join(sources.phaseRuntime, "added.mjs");
    writeFileSync(added, "export {};\n", { mode: 0o600 });
    assert.throws(() => assertRemoteWorkspaceImmutableInputRegistry(registry), /changed after it was pinned/u);
    unlinkSync(added);
    unlinkSync(join(sources.phaseRuntime, "entry"));
    assert.throws(() => assertRemoteWorkspaceImmutableInputRegistry(registry), /changed after it was pinned/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }

  for (const kind of ["symlink", "hardlink"]) {
    const linkedRoot = fixtureRoot(`ow-remote-launch-${kind}-`);
    try {
      const sources = createRegistrySources(linkedRoot);
      const entry = join(sources.phaseRuntime, "entry");
      if (kind === "symlink") {
        symlinkSync(entry, join(sources.phaseRuntime, "linked"));
      } else {
        linkSync(entry, join(sources.phaseRuntime, "linked"));
      }
      assert.throws(
        () => createRemoteWorkspaceImmutableInputRegistry(sources, registryOptions()),
        /symbolic link|single-link|bounded no-follow regular/u
      );
    } finally {
      rmSync(linkedRoot, { recursive: true, force: true });
    }
  }
});

linuxTest("Remote launch registry binds the staged phase Node bytes and mode", () => {
  const root = fixtureRoot("ow-remote-launch-phase-node-");
  try {
    const sources = createRegistrySources(root);
    chmodSync(sources.phaseNode, 0o700);
    const registry = createRemoteWorkspaceImmutableInputRegistry(sources, registryOptions());
    writeFileSync(sources.phaseNode, "changed phase node\n", { mode: 0o700 });
    assert.throws(() => assertRemoteWorkspaceImmutableInputRegistry(registry), /changed after it was pinned/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }

  const oversizedRoot = fixtureRoot("ow-remote-launch-phase-node-oversized-");
  try {
    const sources = createRegistrySources(oversizedRoot);
    truncateSync(sources.phaseNode, REMOTE_WORKSPACE_PHASE_NODE_MAXIMUM_BYTES + 1);
    assert.throws(
      () => createRemoteWorkspaceImmutableInputRegistry(sources, registryOptions()),
      /bounded no-follow regular receipt file/u
    );
  } finally {
    rmSync(oversizedRoot, { recursive: true, force: true });
  }
});

linuxTest("Remote launch leases reject named-path replacement and swap-and-restore races", () => {
  const root = fixtureRoot("ow-remote-launch-lease-");
  try {
    const sources = createRegistrySources(root);
    let registry = createRemoteWorkspaceImmutableInputRegistry(sources, registryOptions());
    const descriptor = sources.descriptor;
    const displaced = join(root, "displaced-descriptor");
    const replacement = join(root, "replacement-descriptor");
    writeFileSync(replacement, "replacement\n", { mode: 0o600 });
    assert.throws(
      () =>
        openRemoteWorkspaceImmutableInputLeases(registry, {
          onLeaseOpened(entry) {
            if (entry.id !== "descriptor") return;
            renameSync(descriptor, displaced);
            renameSync(replacement, descriptor);
          }
        }),
      /changed at the launch boundary/u
    );
    unlinkSync(descriptor);
    renameSync(displaced, descriptor);

    registry = createRemoteWorkspaceImmutableInputRegistry(sources, registryOptions());
    writeFileSync(replacement, "replacement\n", { mode: 0o600 });
    assert.throws(
      () =>
        openRemoteWorkspaceImmutableInputLeases(registry, {
          onLeaseOpened(entry) {
            if (entry.id !== "descriptor") return;
            renameSync(descriptor, displaced);
            renameSync(replacement, descriptor);
            unlinkSync(descriptor);
            renameSync(displaced, descriptor);
          }
        }),
      /changed at the launch boundary/u
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

linuxTest("Remote launch guards retain host identity without treating mutable state as authority", () => {
  const root = fixtureRoot("ow-remote-launch-guards-");
  try {
    const sources = createRegistrySources(root);
    const registry = createRemoteWorkspaceImmutableInputRegistry(sources, registryOptions());
    writeFileSync(join(sources.userData, "runtime-state"), "mutable\n", { mode: 0o600 });
    for (const id of ["localHome", "userData", "remoteHome", "output", "hostHome"]) {
      const runtimeDirectory = join(sources[id], "runtime-directory");
      mkdirSync(runtimeDirectory, { mode: 0o700 });
      assert.equal(assertRemoteWorkspaceImmutableInputRegistry(registry), registry);
      openRemoteWorkspaceImmutableInputLeases(registry).release();
      rmSync(runtimeDirectory, { recursive: true });
      assert.equal(assertRemoteWorkspaceImmutableInputRegistry(registry), registry);
      openRemoteWorkspaceImmutableInputLeases(registry).release();
    }
    assert.equal(assertRemoteWorkspaceImmutableInputRegistry(registry), registry);

    const hostHome = sources.hostHome;
    const displaced = join(root, "displaced-home");
    const replacement = join(root, "replacement-home");
    mkdirSync(replacement, { mode: 0o700 });
    assert.throws(
      () =>
        openRemoteWorkspaceImmutableInputLeases(registry, {
          onLeaseOpened(entry) {
            if (entry.id !== "hostHome") return;
            renameSync(hostHome, displaced);
            renameSync(replacement, hostHome);
          }
        }),
      /changed at the launch boundary/u
    );

    chmodSync(sources.userData, 0o711);
    assert.throws(
      () => assertRemoteWorkspaceImmutableInputRegistry(registry),
      /not private|changed after it was pinned/u
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

linuxTest("Remote launch relaxed directory topology retains mode and file-link authority", () => {
  const modeRoot = fixtureRoot("ow-remote-launch-directory-mode-");
  try {
    const sources = createRegistrySources(modeRoot);
    const registry = createRemoteWorkspaceImmutableInputRegistry(sources, registryOptions());
    for (const id of ["userData", "hostHome"]) {
      chmodSync(sources[id], 0o711);
      assert.throws(
        () => assertRemoteWorkspaceImmutableInputRegistry(registry),
        /not private|changed after it was pinned/u
      );
      chmodSync(sources[id], 0o700);
      assert.equal(assertRemoteWorkspaceImmutableInputRegistry(registry), registry);
    }
  } finally {
    rmSync(modeRoot, { recursive: true, force: true });
  }

  for (const id of ["descriptor", "hostSentinel"]) {
    const linkRoot = fixtureRoot(`ow-remote-launch-${id}-post-pin-link-`);
    try {
      const sources = createRegistrySources(linkRoot);
      const registry = createRemoteWorkspaceImmutableInputRegistry(sources, registryOptions());
      linkSync(sources[id], join(linkRoot, `${id}-linked`));
      assert.throws(
        () => assertRemoteWorkspaceImmutableInputRegistry(registry),
        /unsafe type or link count|changed after it was pinned/u
      );
    } finally {
      rmSync(linkRoot, { recursive: true, force: true });
    }
  }
});

linuxTest("Remote launch mount template is complete, ordered, and read-only after mutable overlays", () => {
  const mounts = createRemoteWorkspaceImmutableMountTemplate(PINNED_REMOTE_VSCODE_COMMIT);
  assert.equal(validateRemoteWorkspaceImmutableMounts(mounts, { commit: PINNED_REMOTE_VSCODE_COMMIT }), mounts);
  const lastMutable = mounts.findLastIndex((mount) => mount.access === "mutable");
  const firstImmutable = mounts.findIndex((mount) => mount.access === "immutable");
  assert.ok(lastMutable >= 0 && firstImmutable > lastMutable);
  assert.equal(new Set(mounts.map((mount) => mount.destination)).size, mounts.length);
  assert.deepEqual(
    mounts
      .filter((mount) => ["sshTomcrypt", "sshTommath"].includes(mount.id))
      .map(({ id, destination, access }) => ({ id, destination, access })),
    [
      { id: "sshTomcrypt", destination: "/usr/lib/x86_64-linux-gnu/libtomcrypt.so.1", access: "immutable" },
      { id: "sshTommath", destination: "/usr/lib/x86_64-linux-gnu/libtommath.so.1", access: "immutable" }
    ]
  );
  for (const mutation of [
    mounts.slice(1),
    [...mounts, mounts[0]],
    mounts.map((mount, index) => (index === 0 ? { ...mount, access: "immutable" } : mount)),
    mounts.map((mount, index) => (index === 0 ? { ...mount, descriptor: 99 } : mount)),
    mounts.map((mount) =>
      mount.id === "sshTomcrypt" ? { ...mount, destination: "/usr/lib/unpinned-library.so" } : mount
    )
  ]) {
    assert.throws(
      () => validateRemoteWorkspaceImmutableMounts(mutation, { commit: PINNED_REMOTE_VSCODE_COMMIT }),
      /incomplete|malformed/u
    );
  }
});

for (const id of ["client", "remoteServer", "python"]) {
  linuxTest(`Remote launch registry binds in-place ${id} child mutations`, () => {
    const root = fixtureRoot(`ow-remote-launch-${id}-mutation-`);
    try {
      const sources = createRegistrySources(root);
      const registry = createRemoteWorkspaceImmutableInputRegistry(sources, registryOptions());
      writeFileSync(join(sources[id], "entry"), `${id}-changed\n`, { mode: 0o600 });
      assert.throws(() => assertRemoteWorkspaceImmutableInputRegistry(registry), /changed after it was pinned/u);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}

for (const id of ["sshTomcrypt", "sshTommath"]) {
  linuxTest(`Remote launch registry binds the exact ${id} library bytes`, () => {
    const root = fixtureRoot(`ow-remote-launch-${id}-mutation-`);
    try {
      const sources = createRegistrySources(root);
      const registry = createRemoteWorkspaceImmutableInputRegistry(sources, registryOptions());
      writeFileSync(sources[id], `${id}-changed\n`, { mode: 0o600 });
      assert.throws(() => assertRemoteWorkspaceImmutableInputRegistry(registry), /changed after it was pinned/u);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}

linuxTest("Remote launch tree receipts allow pinned Python links and detect permission drift", () => {
  const root = fixtureRoot("ow-remote-launch-python-links-");
  try {
    const sources = createRegistrySources(root);
    const pythonEntry = join(sources.python, "entry");
    symlinkSync("entry", join(sources.python, "python"));
    const externalPythonTarget = realpathSync("/usr/bin/true");
    if (lstatSync(externalPythonTarget, { bigint: true }).uid === 0n) {
      symlinkSync("/usr/bin/true", join(sources.python, "python3"));
    }
    const registry = createRemoteWorkspaceImmutableInputRegistry(sources, registryOptions());
    assert.equal(assertRemoteWorkspaceImmutableInputRegistry(registry), registry);
    chmodSync(pythonEntry, 0o666);
    assert.throws(() => assertRemoteWorkspaceImmutableInputRegistry(registry), /changed after it was pinned/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function createRegistrySources(root) {
  const directories = new Set([
    "localHome",
    "userData",
    "remoteHome",
    "output",
    "phaseRuntime",
    "client",
    "localExtensions",
    "remoteServer",
    "remoteExtensions",
    "remoteTestModule",
    "python",
    "sshRuntime",
    "ssh",
    "workspace",
    "hostHome"
  ]);
  const sources = {};
  for (const id of REMOTE_WORKSPACE_IMMUTABLE_INPUT_IDS) {
    const path = join(root, id.replaceAll(":", "-"));
    sources[id] = path;
    if (directories.has(id)) {
      mkdirSync(path, { recursive: true, mode: 0o700 });
      chmodSync(path, 0o700);
      if (!["localHome", "userData", "remoteHome", "output", "hostHome"].includes(id)) {
        writeFileSync(join(path, "entry"), `${id}\n`, { mode: 0o600 });
      }
    } else {
      writeFileSync(path, `${id}\n`, { mode: id === "remoteCli" ? 0o700 : 0o600 });
    }
  }
  return sources;
}

function registryOptions() {
  return {
    commit: PINNED_REMOTE_VSCODE_COMMIT,
    uid: process.getuid?.() ?? 1001,
    gid: process.getgid?.() ?? 1001
  };
}

function fixtureRoot(prefix) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  chmodSync(root, 0o700);
  return root;
}
