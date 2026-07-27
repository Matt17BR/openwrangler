import { closeSync, constants, fstatSync, lstatSync, openSync, realpathSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  REMOTE_WORKSPACE_NAMESPACE_ROOT,
  REMOTE_WORKSPACE_PHASE_DESCRIPTOR_PATH,
  REMOTE_WORKSPACE_PHASE_NODE_MAXIMUM_BYTES,
  REMOTE_WORKSPACE_PHASE_NODE_PATH
} from "./remote-workspace-contract.mjs";
import { captureRemoteWorkspaceFileReceipt } from "./remote-workspace-provenance.mjs";
import { captureRemoteWorkspaceTreeManifest } from "./remote-workspace-staging.mjs";

const LINUX_O_PATH = 0o10000000;
const PATH_LIMIT = 16_384;
const MAXIMUM_MOUNTS = 32;
const DROPBEAR_LIBRARY_MOUNTS = Object.freeze([
  Object.freeze({
    id: "sshTomcrypt",
    destination: "/usr/lib/libtomcrypt.so.1"
  }),
  Object.freeze({
    id: "sshTommath",
    destination: "/usr/lib/libtommath.so.1"
  })
]);
const DROPBEAR_LIBRARY_DESTINATIONS = new Set(DROPBEAR_LIBRARY_MOUNTS.map((entry) => entry.destination));
const ACCOUNT_FILES = Object.freeze([
  "group",
  "hosts",
  "machine-id",
  "nsswitch.conf",
  "os-release",
  "passwd",
  "resolv.conf",
  "shadow"
]);

const TREE_BOUNDS = Object.freeze({
  phaseRuntime: Object.freeze({
    label: "Remote SSH immutable phase runtime",
    maximumFiles: 16,
    maximumBytes: 16 * 1024 * 1024,
    maximumFileBytes: 8 * 1024 * 1024
  }),
  client: Object.freeze({
    label: "Remote SSH immutable VS Code client",
    maximumFiles: 100_000,
    maximumBytes: 4 * 1024 * 1024 * 1024,
    maximumFileBytes: 512 * 1024 * 1024
  }),
  localExtensions: Object.freeze({
    label: "Remote SSH immutable local extensions",
    maximumFiles: 50_000,
    maximumBytes: 1024 * 1024 * 1024,
    maximumFileBytes: 64 * 1024 * 1024
  }),
  remoteExtensions: Object.freeze({
    label: "Remote SSH immutable remote extensions",
    maximumFiles: 50_000,
    maximumBytes: 1024 * 1024 * 1024,
    maximumFileBytes: 64 * 1024 * 1024
  }),
  remoteServer: Object.freeze({
    label: "Remote SSH immutable VS Code server",
    maximumFiles: 100_000,
    maximumBytes: 4 * 1024 * 1024 * 1024,
    maximumFileBytes: 512 * 1024 * 1024
  }),
  remoteTestModule: Object.freeze({
    label: "Remote SSH immutable test module",
    maximumFiles: 2_000,
    maximumBytes: 64 * 1024 * 1024,
    maximumFileBytes: 16 * 1024 * 1024
  }),
  python: Object.freeze({
    label: "Remote SSH immutable Python environment",
    maximumFiles: 100_000,
    maximumBytes: 4 * 1024 * 1024 * 1024,
    maximumFileBytes: 512 * 1024 * 1024,
    allowInternalSymlinks: true,
    allowedAbsoluteSymlinkRoots: Object.freeze(["/usr"])
  }),
  ssh: Object.freeze({
    label: "Remote SSH immutable key and client configuration",
    maximumFiles: 32,
    maximumBytes: 1024 * 1024,
    maximumFileBytes: 256 * 1024
  }),
  sshRuntime: Object.freeze({
    label: "Remote SSH immutable Dropbear runtime",
    maximumFiles: 256,
    maximumBytes: 64 * 1024 * 1024,
    maximumFileBytes: 32 * 1024 * 1024
  }),
  workspace: Object.freeze({
    label: "Remote SSH immutable workspace fixture",
    maximumFiles: 32,
    maximumBytes: 16 * 1024 * 1024,
    maximumFileBytes: 15 * 1024 * 1024
  })
});

const REQUIRED_MOUNTS = Object.freeze([
  Object.freeze({
    id: "localHome",
    kind: "directory",
    access: "mutable",
    destination: `${REMOTE_WORKSPACE_NAMESPACE_ROOT}/lh`
  }),
  Object.freeze({
    id: "userData",
    kind: "directory",
    access: "mutable",
    destination: `${REMOTE_WORKSPACE_NAMESPACE_ROOT}/ud`
  }),
  Object.freeze({
    id: "remoteHome",
    kind: "directory",
    access: "mutable",
    destination: `${REMOTE_WORKSPACE_NAMESPACE_ROOT}/rh`
  }),
  Object.freeze({
    id: "output",
    kind: "directory",
    access: "mutable",
    destination: `${REMOTE_WORKSPACE_NAMESPACE_ROOT}/out`
  }),
  Object.freeze({
    id: "descriptor",
    kind: "file",
    access: "immutable",
    destination: REMOTE_WORKSPACE_PHASE_DESCRIPTOR_PATH
  }),
  Object.freeze({
    id: "phaseNode",
    kind: "file",
    access: "immutable",
    destination: REMOTE_WORKSPACE_PHASE_NODE_PATH
  }),
  Object.freeze({
    id: "phaseRuntime",
    kind: "tree",
    access: "immutable",
    destination: `${REMOTE_WORKSPACE_NAMESPACE_ROOT}/phase-runtime`,
    bounds: TREE_BOUNDS.phaseRuntime
  }),
  Object.freeze({
    id: "client",
    kind: "tree",
    access: "immutable",
    destination: `${REMOTE_WORKSPACE_NAMESPACE_ROOT}/client`,
    bounds: TREE_BOUNDS.client
  }),
  Object.freeze({
    id: "localExtensions",
    kind: "tree",
    access: "immutable",
    destination: `${REMOTE_WORKSPACE_NAMESPACE_ROOT}/le`,
    bounds: TREE_BOUNDS.localExtensions
  }),
  Object.freeze({
    id: "localSettings",
    kind: "file",
    access: "immutable",
    destination: `${REMOTE_WORKSPACE_NAMESPACE_ROOT}/ud/User/settings.json`
  }),
  Object.freeze({
    id: "remoteCli",
    kind: "file",
    access: "immutable",
    destination: `${REMOTE_WORKSPACE_NAMESPACE_ROOT}/rh/.vscode-server/code-__COMMIT__`
  }),
  Object.freeze({
    id: "remoteServer",
    kind: "tree",
    access: "immutable",
    destination: `${REMOTE_WORKSPACE_NAMESPACE_ROOT}/rh/.vscode-server/cli/servers/Stable-__COMMIT__/server`,
    bounds: TREE_BOUNDS.remoteServer
  }),
  Object.freeze({
    id: "remoteExtensions",
    kind: "tree",
    access: "immutable",
    destination: `${REMOTE_WORKSPACE_NAMESPACE_ROOT}/rh/.vscode-server/extensions`,
    bounds: TREE_BOUNDS.remoteExtensions
  }),
  Object.freeze({
    id: "remoteTestModule",
    kind: "tree",
    access: "immutable",
    destination: `${REMOTE_WORKSPACE_NAMESPACE_ROOT}/rh/test-module`,
    bounds: TREE_BOUNDS.remoteTestModule
  }),
  Object.freeze({
    id: "python",
    kind: "tree",
    access: "immutable",
    destination: `${REMOTE_WORKSPACE_NAMESPACE_ROOT}/rh/python`,
    bounds: TREE_BOUNDS.python
  }),
  Object.freeze({
    id: "sshRuntime",
    kind: "tree",
    access: "immutable",
    destination: `${REMOTE_WORKSPACE_NAMESPACE_ROOT}/rh/ssh-runtime/runtime`,
    bounds: TREE_BOUNDS.sshRuntime
  }),
  ...DROPBEAR_LIBRARY_MOUNTS.map((entry) =>
    Object.freeze({
      ...entry,
      kind: "file",
      access: "immutable"
    })
  ),
  Object.freeze({
    id: "ssh",
    kind: "tree",
    access: "immutable",
    destination: `${REMOTE_WORKSPACE_NAMESPACE_ROOT}/rh/ssh`,
    bounds: TREE_BOUNDS.ssh
  }),
  Object.freeze({
    id: "workspace",
    kind: "tree",
    access: "immutable",
    destination: `${REMOTE_WORKSPACE_NAMESPACE_ROOT}/rh/workspace`,
    bounds: TREE_BOUNDS.workspace
  }),
  ...ACCOUNT_FILES.map((name) =>
    Object.freeze({
      id: `account:${name}`,
      kind: "file",
      access: "immutable",
      destination: `${REMOTE_WORKSPACE_NAMESPACE_ROOT}/rh/accounts/${name}`
    })
  )
]);

const REQUIRED_GUARDS = Object.freeze([
  Object.freeze({ id: "hostHome", kind: "directory", access: "guard" }),
  Object.freeze({ id: "hostSentinel", kind: "file", access: "guard" })
]);

export const REMOTE_WORKSPACE_IMMUTABLE_INPUT_IDS = Object.freeze(
  [...REQUIRED_MOUNTS, ...REQUIRED_GUARDS].map((entry) => entry.id)
);

export function createRemoteWorkspaceImmutableInputRegistry(
  sources,
  { commit, uid = process.getuid?.(), gid = process.getgid?.() } = {}
) {
  if (
    !sources ||
    typeof sources !== "object" ||
    Array.isArray(sources) ||
    Object.keys(sources).sort().join(",") !== [...REMOTE_WORKSPACE_IMMUTABLE_INPUT_IDS].sort().join(",") ||
    typeof commit !== "string" ||
    !/^[0-9a-f]{40}$/u.test(commit) ||
    !Number.isSafeInteger(uid) ||
    !Number.isSafeInteger(gid) ||
    uid <= 0 ||
    gid <= 0
  ) {
    throw new Error("The Remote SSH immutable-input registry is incomplete or malformed.");
  }
  const definitions = [...REQUIRED_MOUNTS, ...REQUIRED_GUARDS].map((definition) =>
    definition.destination
      ? {
          ...definition,
          destination: definition.destination.replaceAll("__COMMIT__", commit)
        }
      : definition
  );
  const entries = definitions.map((definition) =>
    captureImmutableEntry(definition, sources[definition.id], BigInt(uid), BigInt(gid))
  );
  return Object.freeze({
    commit,
    uid,
    gid,
    entries: Object.freeze(entries)
  });
}

export function assertRemoteWorkspaceImmutableInputRegistry(registry) {
  if (
    !registry ||
    typeof registry !== "object" ||
    !Array.isArray(registry.entries) ||
    registry.entries.length !== REMOTE_WORKSPACE_IMMUTABLE_INPUT_IDS.length ||
    registry.entries.map((entry) => entry.id).join(",") !== REMOTE_WORKSPACE_IMMUTABLE_INPUT_IDS.join(",")
  ) {
    throw new Error("The Remote SSH immutable-input registry receipt is malformed.");
  }
  for (const entry of registry.entries) assertImmutableEntry(entry, BigInt(registry.uid), BigInt(registry.gid));
  return registry;
}

export function openRemoteWorkspaceImmutableInputLeases(registry, { onLeaseOpened } = {}) {
  if (onLeaseOpened !== undefined && typeof onLeaseOpened !== "function") {
    throw new Error("The Remote SSH immutable-input lease hook is malformed.");
  }
  assertRemoteWorkspaceImmutableInputRegistry(registry);
  const opened = [];
  let released = false;
  try {
    for (const [index, entry] of registry.entries.entries()) {
      const descriptor = openSync(
        entry.source,
        LINUX_O_PATH | (constants.O_NOFOLLOW ?? 0) | (entry.kind === "file" ? 0 : (constants.O_DIRECTORY ?? 0))
      );
      opened.push({ descriptor, entry });
      onLeaseOpened?.(entry, index);
      const descriptorSnapshot = pathSnapshot(fstatSync(descriptor, { bigint: true }), entry.kind, entry.source);
      const namedSnapshot = pathSnapshot(lstatSync(entry.source, { bigint: true }), entry.kind, entry.source);
      if (
        !sameEntrySnapshot(descriptorSnapshot, entry.snapshot, entry.access, entry.kind) ||
        !sameEntrySnapshot(namedSnapshot, entry.snapshot, entry.access, entry.kind)
      ) {
        throw new Error(`The Remote SSH immutable ${entry.id} input changed at the launch boundary.`);
      }
    }
    assertRemoteWorkspaceImmutableInputRegistry(registry);
    const mounted = opened.filter(({ entry }) => entry.destination !== undefined);
    if (mounted.length <= 0 || mounted.length > MAXIMUM_MOUNTS) {
      throw new Error("The Remote SSH immutable-input mount count is outside its fixed bound.");
    }
    const inheritedFileDescriptors = mounted.map(({ descriptor }) => descriptor);
    const mounts = mounted.map(({ entry }, index) =>
      Object.freeze({
        id: entry.id,
        descriptor: 3 + index,
        destination: entry.destination,
        access: entry.access
      })
    );
    return Object.freeze({
      inheritedFileDescriptors: Object.freeze(inheritedFileDescriptors),
      mounts: Object.freeze(mounts),
      release() {
        if (released) return;
        released = true;
        const failures = [];
        for (const { descriptor } of opened.reverse()) {
          try {
            closeSync(descriptor);
          } catch (error) {
            failures.push(error);
          }
        }
        if (failures.length === 1) throw failures[0];
        if (failures.length > 1) {
          throw new AggregateError(failures, "Remote SSH immutable-input leases could not be released.");
        }
      }
    });
  } catch (error) {
    for (const { descriptor } of opened.reverse()) {
      try {
        closeSync(descriptor);
      } catch {
        // The authoritative launch-boundary failure is retained.
      }
    }
    throw error;
  }
}

export function validateRemoteWorkspaceImmutableMounts(mounts, { commit } = {}) {
  const expected = REQUIRED_MOUNTS;
  if (
    typeof commit !== "string" ||
    !/^[0-9a-f]{40}$/u.test(commit) ||
    !Array.isArray(mounts) ||
    mounts.length !== expected.length ||
    mounts.map((entry) => entry?.id).join(",") !== expected.map((entry) => entry.id).join(",")
  ) {
    throw new Error("The Remote SSH immutable-input mount list is incomplete or out of order.");
  }
  for (const [index, mount] of mounts.entries()) {
    if (
      !mount ||
      typeof mount !== "object" ||
      Object.keys(mount).sort().join(",") !== "access,descriptor,destination,id" ||
      mount.descriptor !== 3 + index ||
      mount.access !== expected[index].access ||
      typeof mount.destination !== "string" ||
      mount.destination !== expected[index].destination.replaceAll("__COMMIT__", commit) ||
      (!mount.destination.startsWith(`${REMOTE_WORKSPACE_NAMESPACE_ROOT}/`) &&
        !DROPBEAR_LIBRARY_DESTINATIONS.has(mount.destination)) ||
      resolve(mount.destination) !== mount.destination
    ) {
      throw new Error("The Remote SSH immutable-input mount list is malformed.");
    }
  }
  return mounts;
}

export function createRemoteWorkspaceImmutableMountTemplate(commit) {
  if (typeof commit !== "string" || !/^[0-9a-f]{40}$/u.test(commit)) {
    throw new Error("The Remote SSH immutable-input mount commit is malformed.");
  }
  return Object.freeze(
    REQUIRED_MOUNTS.map((entry, index) =>
      Object.freeze({
        id: entry.id,
        descriptor: 3 + index,
        destination: entry.destination.replaceAll("__COMMIT__", commit),
        access: entry.access
      })
    )
  );
}

function captureImmutableEntry(definition, source, uid, gid) {
  const canonical = canonicalInputPath(source);
  const snapshot = pathSnapshot(lstatSync(canonical, { bigint: true }), definition.kind, canonical);
  assertPrivateOwner(snapshot, uid, gid, definition.id);
  const receipt =
    definition.kind === "file"
      ? captureRemoteWorkspaceFileReceipt(canonical, fileReceiptPolicy(definition))
      : definition.kind === "tree"
        ? captureRemoteWorkspaceTreeManifest(canonical, definition.bounds)
        : undefined;
  if (definition.kind === "tree") assertPrivateTreeManifest(receipt, uid, gid, definition.id);
  return Object.freeze({
    id: definition.id,
    kind: definition.kind,
    source: canonical,
    destination: definition.destination,
    access: definition.access,
    allowEmpty: definition.allowEmpty === true,
    bounds: definition.bounds,
    snapshot,
    receipt
  });
}

function assertImmutableEntry(entry, uid, gid) {
  if (
    !entry ||
    typeof entry !== "object" ||
    !REMOTE_WORKSPACE_IMMUTABLE_INPUT_IDS.includes(entry.id) ||
    !["file", "tree", "directory"].includes(entry.kind) ||
    !["immutable", "mutable", "guard"].includes(entry.access)
  ) {
    throw new Error("A Remote SSH immutable-input receipt is malformed.");
  }
  const canonical = canonicalInputPath(entry.source);
  const snapshot = pathSnapshot(lstatSync(canonical, { bigint: true }), entry.kind, canonical);
  assertPrivateOwner(snapshot, uid, gid, entry.id);
  if (!sameEntrySnapshot(snapshot, entry.snapshot, entry.access, entry.kind)) {
    throw new Error(`The Remote SSH immutable ${entry.id} input changed after it was pinned.`);
  }
  const current =
    entry.kind === "file"
      ? captureRemoteWorkspaceFileReceipt(canonical, fileReceiptPolicy(entry))
      : entry.kind === "tree"
        ? captureRemoteWorkspaceTreeManifest(canonical, entry.bounds)
        : undefined;
  if (entry.kind === "tree") assertPrivateTreeManifest(current, uid, gid, entry.id);
  if (
    (entry.access === "immutable" || (entry.access === "guard" && entry.kind === "file")) &&
    !isDeepStrictEqual(current, entry.receipt)
  ) {
    throw new Error(`The Remote SSH immutable ${entry.id} input changed after it was pinned.`);
  }
}

function fileReceiptPolicy(entry) {
  return entry.id === "phaseNode"
    ? Object.freeze({
        allowEmpty: false,
        maximumBytes: REMOTE_WORKSPACE_PHASE_NODE_MAXIMUM_BYTES
      })
    : Object.freeze({ allowEmpty: entry.allowEmpty === true });
}

function assertPrivateTreeManifest(manifest, uid, gid, id) {
  for (const receipt of [
    ...manifest.directories.map((entry) => entry.receipt),
    ...manifest.files.map((entry) => entry.receipt)
  ]) {
    if (receipt.uid !== uid || receipt.gid !== gid) {
      throw new Error(`The Remote SSH immutable ${id} input contains an entry outside its private owner boundary.`);
    }
  }
  for (const { receipt } of manifest.links) {
    if (receipt.uid !== uid || receipt.gid !== gid || receipt.nlink !== 1n) {
      throw new Error(`The Remote SSH immutable ${id} input contains an uncontrolled symbolic link.`);
    }
  }
}

function canonicalInputPath(path) {
  if (
    typeof path !== "string" ||
    !isAbsolute(path) ||
    path.length <= 0 ||
    path.length > PATH_LIMIT ||
    /[\0\r\n]/u.test(path)
  ) {
    throw new Error("A Remote SSH immutable-input source path is malformed.");
  }
  const canonical = realpathSync(path);
  if (canonical !== path) {
    throw new Error("A Remote SSH immutable-input source must be one canonical no-link path.");
  }
  return canonical;
}

function pathSnapshot(metadata, kind, path) {
  const expectsFile = kind === "file";
  if (
    (expectsFile && (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1n)) ||
    (!expectsFile && (!metadata.isDirectory() || metadata.isSymbolicLink() || metadata.nlink < 1n))
  ) {
    throw new Error(`The Remote SSH immutable input ${path} has an unsafe type or link count.`);
  }
  return Object.freeze({
    dev: metadata.dev,
    ino: metadata.ino,
    mode: metadata.mode,
    nlink: metadata.nlink,
    uid: metadata.uid,
    gid: metadata.gid,
    size: metadata.size,
    mtimeNs: metadata.mtimeNs,
    ctimeNs: metadata.ctimeNs,
    birthtimeNs: metadata.birthtimeNs
  });
}

function assertPrivateOwner(snapshot, uid, gid, id) {
  if (snapshot.uid !== uid || snapshot.gid !== gid || Number(snapshot.mode & 0o022n) !== 0) {
    throw new Error(`The Remote SSH immutable ${id} input is not private and owner-controlled.`);
  }
}

function sameEntrySnapshot(left, right, access, kind) {
  if (access === "immutable" || (access === "guard" && kind === "file")) {
    return isDeepStrictEqual(left, right);
  }
  if (kind !== "directory" || !["mutable", "guard"].includes(access)) {
    throw new Error("A Remote SSH immutable-input receipt has an unsupported identity policy.");
  }
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.uid === right.uid &&
    left.gid === right.gid &&
    left.birthtimeNs === right.birthtimeNs
  );
}
