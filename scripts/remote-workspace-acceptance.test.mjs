import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  assertRemoteWorkspaceHost,
  createRemoteWorkspaceBwrapArguments,
  createRemoteWorkspaceLayout,
  REMOTE_WORKSPACE_AUTHORITY,
  REMOTE_WORKSPACE_INACTIVITY_TIMEOUT_MS,
  REMOTE_WORKSPACE_PHASE_TIMEOUT_MS,
  validateRootOwnedSystemRuntimeDirectory,
  validateRemoteWorkspaceNamespaceProbe,
  validateRemoteSshLogAttestation,
  validateRemoteWorkspaceResult
} from "./remote-workspace-acceptance.mjs";
import { PINNED_REMOTE_VSCODE_COMMIT } from "./remote-workspace-acquisition.mjs";

test("Remote workspace layout is short, private, and independently scoped", () => {
  const parent = privateRoot("ow-remote-layout-");
  try {
    const layout = createRemoteWorkspaceLayout(parent);
    assert.equal(layout.root.startsWith(parent), true);
    assert.equal(layout.workspace.startsWith(layout.remoteHome), true);
    assert.equal(layout.remoteExtensions.startsWith(layout.remoteHome), true);
    assert.notEqual(layout.localHome, layout.remoteHome);
    assert.notEqual(layout.localExtensions, layout.remoteExtensions);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("Remote host preflight is Linux-only and fails closed without user namespaces", async () => {
  await assert.rejects(
    assertRemoteWorkspaceHost({ platform: "darwin", architecture: "arm64", tools: {} }),
    /only Linux x64/u
  );
  const fakeTools = {
    bash: "/usr/bin/true",
    bwrap: "/usr/bin/true",
    busybox: "/usr/bin/true",
    dpkgDeb: "/usr/bin/true",
    dynamicLoader: "/usr/bin/true",
    ip: "/usr/bin/true",
    ldconfig: "/usr/bin/true",
    node: "/usr/bin/true",
    ssh: "/usr/bin/true",
    sshKeygen: "/usr/bin/true",
    xkbcomp: "/usr/bin/true"
  };
  await assert.rejects(
    assertRemoteWorkspaceHost(
      { platform: "linux", architecture: "x64", tools: fakeTools },
      { runCommand: async () => Promise.reject(new Error("unprivileged user namespaces disabled")) }
    ),
    /no desktop-network fallback/u
  );
});

test("Bubblewrap arguments clear the environment and create zero-network PID isolation", () => {
  const parent = privateRoot("ow-remote-bwrap-");
  try {
    const layout = createRemoteWorkspaceLayout(parent);
    const hostSentinel = join(parent, "host-private-sentinel");
    writeFileSync(hostSentinel, "private\n", { mode: 0o600 });
    const child = join(layout.root, "child.mjs");
    writeFileSync(child, "export {};\n");
    const descriptor = layout.descriptor;
    writeFileSync(descriptor, "{}\n", { mode: 0o600 });
    const args = createRemoteWorkspaceBwrapArguments({
      root: layout.root,
      descriptor,
      childScript: child,
      systemPython: "/usr/bin/python3.14",
      uid: 1001,
      gid: 1001,
      tools: {
        bash: "/usr/bin/bash",
        bwrap: "/usr/bin/bwrap",
        busybox: "/usr/bin/busybox",
        dynamicLoader: "/usr/lib64/ld-linux-x86-64.so.2",
        ip: "/usr/bin/ip",
        ldconfig: "/usr/sbin/ldconfig",
        node: "/usr/bin/node",
        ssh: "/usr/bin/ssh",
        xkbcomp: "/usr/bin/xkbcomp"
      }
    });
    for (const required of [
      "--unshare-user",
      "--unshare-pid",
      "--unshare-net",
      "--die-with-parent",
      "--new-session",
      "--clearenv",
      "--tmpfs"
    ]) {
      assert.equal(args.includes(required), true, `Expected ${required}.`);
    }
    assert.equal(args.includes(process.env.HOME ?? "<missing>"), false);
    const environmentNames = args
      .map((value, index) => (value === "--setenv" ? args[index + 1] : undefined))
      .filter(Boolean);
    assert.equal(environmentNames.some((name) => name.startsWith("LD_")), false);
    assert.equal(
      args.some((value, index) => value === "--ro-bind" && args[index + 1] === "/" && args[index + 2] === "/"),
      false
    );
    const mountSources = args
      .map((value, index) => (value === "--bind" || value === "--ro-bind" ? args[index + 1] : undefined))
      .filter(Boolean);
    assert.equal(mountSources.includes("/"), false);
    assert.equal(args.includes(hostSentinel), false);
    const canonicalRoot = realpathSync(layout.root);
    assert.equal(
      mountSources
        .filter((source) => source.startsWith(`${process.env.HOME}/`))
        .every((source) => source === canonicalRoot || source.startsWith(`${canonicalRoot}/`)),
      true
    );
    assert.equal(args.includes("--cap-drop"), true);
    assert.equal(args.includes("/home"), true);
    const commandSeparator = args.lastIndexOf("--");
    assert.equal(args[commandSeparator + 3], "/ow/phase.json");
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("System runtime closure roots must be canonical, root-owned, and non-writable", () => {
  const canonical = "/usr/lib/openwrangler-runtime";
  const directory = (overrides = {}) => ({
    isDirectory: () => true,
    isSymbolicLink: () => false,
    uid: 0,
    mode: 0o040755,
    ...overrides
  });
  assert.equal(
    validateRootOwnedSystemRuntimeDirectory(canonical, {
      lstat: () => directory(),
      realpath: () => canonical
    }),
    canonical
  );
  for (const [metadata, resolved] of [
    [directory({ uid: 1001 }), canonical],
    [directory({ mode: 0o040775 }), canonical],
    [directory({ isSymbolicLink: () => true }), canonical],
    [directory(), `${canonical}-redirected`]
  ]) {
    assert.throws(
      () =>
        validateRootOwnedSystemRuntimeDirectory(canonical, {
          lstat: () => metadata,
          realpath: () => resolved
        }),
      /canonical, root-owned, and non-writable/u
    );
  }
});

test("Namespace probe requires one ID row and zero effective capabilities", () => {
  assert.deepEqual(
    validateRemoteWorkspaceNamespaceProbe(
      [
        "1: lo: <LOOPBACK> inet 127.0.0.1/8",
        "UID_MAP",
        "1001 0 1",
        "GID_MAP",
        "1001 0 1",
        "CAP_EFF",
        "CapEff:\t0000000000000000"
      ].join("\n"),
      { uid: 1001, gid: 1001 }
    ),
    {
      uidMap: [1001, 0, 1],
      gidMap: [1001, 0, 1],
      capabilityEffective: 0
    }
  );
  assert.throws(
    () =>
      validateRemoteWorkspaceNamespaceProbe(
        "127.0.0.1\nUID_MAP\n1001 0 2\nGID_MAP\n1001 0 1\nCAP_EFF\nCapEff: 1\n",
        { uid: 1001, gid: 1001 }
      ),
    /zero capabilities/u
  );
});

test("Remote SSH log attestation proves exact offline reuse and rejects downloads", () => {
  const valid = [
    `Using commit id "${PINNED_REMOTE_VSCODE_COMMIT}" and quality "stable" for server`,
    "Found existing installation at /private/.vscode-server...",
    "didLocalDownload==0=="
  ].join("\n");
  assert.deepEqual(validateRemoteSshLogAttestation(valid), {
    commit: PINNED_REMOTE_VSCODE_COMMIT,
    didLocalDownload: false,
    existingInstallation: true
  });
  for (const mutation of [
    valid.replace("didLocalDownload==0==", "didLocalDownload==1=="),
    `${valid}\nDownloading VS Code server locally...`,
    `${valid}\nvscode-cli-${PINNED_REMOTE_VSCODE_COMMIT}.tar.gz`,
    valid.replace(PINNED_REMOTE_VSCODE_COMMIT, "0".repeat(40)),
    valid.replace("Found existing installation", "Installing server")
  ]) {
    assert.throws(() => validateRemoteSshLogAttestation(mutation), /offline server chain/u);
  }
});

test("Remote result validation rejects authority-loss failures and mis-correlation", () => {
  const runId = "11111111-1111-4111-8111-111111111111";
  assert.deepEqual(
    validateRemoteWorkspaceResult(JSON.stringify({ protocol: 1, runId, phase: "remote-workspace", ok: true }), {
      runId
    }),
    { protocol: 1, runId, phase: "remote-workspace", ok: true }
  );
  for (const result of [
    { protocol: 1, runId: "22222222-2222-4222-8222-222222222222", phase: "remote-workspace", ok: true },
    { protocol: 1, runId, phase: "remote-workspace", ok: false, error: "remote authority lost" },
    { protocol: 1, runId, phase: "verify", ok: true },
    { protocol: 1, runId, phase: "remote-workspace", ok: true, authority: REMOTE_WORKSPACE_AUTHORITY }
  ]) {
    assert.throws(() => validateRemoteWorkspaceResult(JSON.stringify(result), { runId }), /correlated success result/u);
  }
});

test("Remote acceptance deadlines stay bounded and match native-editor ownership rules", () => {
  assert.equal(REMOTE_WORKSPACE_PHASE_TIMEOUT_MS, 300_000);
  assert.equal(REMOTE_WORKSPACE_INACTIVITY_TIMEOUT_MS, 180_000);
});

function privateRoot(prefix) {
  const root = mkdtempSync(join(tmpdir(), prefix));
  chmodSync(root, 0o700);
  return root;
}
