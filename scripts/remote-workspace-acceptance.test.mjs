import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  assertRemoteWorkspaceHost,
  createRemoteWorkspaceCommandRunner,
  createRemoteWorkspaceBwrapArguments,
  createRemoteWorkspaceLayout,
  PINNED_REMOTE_SSH_BYTES,
  PINNED_REMOTE_SSH_SHA256,
  PINNED_REMOTE_SSH_VERSION,
  REMOTE_WORKSPACE_AUTHORITY,
  REMOTE_WORKSPACE_INACTIVITY_TIMEOUT_MS,
  REMOTE_WORKSPACE_PHASE_TIMEOUT_MS,
  validateRootOwnedSystemRuntimeDirectory,
  validateRemoteWorkspaceCandidateExpectation,
  validateRemoteWorkspaceCandidatePath,
  validateRemoteWorkspaceNamespaceAttestation,
  validateRemoteWorkspacePhaseDescriptor,
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

test("Remote command ownership uncertainty latches permanently across later commands", async () => {
  const ownershipError = Object.assign(new Error("ownership uncertain"), {
    code: "EDITOR_PROCESS_TREE_UNVERIFIED"
  });
  let calls = 0;
  const runner = createRemoteWorkspaceCommandRunner(async () => {
    calls += 1;
    if (calls === 1) throw ownershipError;
    return { stdout: "", stderr: "" };
  });
  await assert.rejects(runner.run({}, {}), ownershipError);
  assert.equal(runner.ownershipUncertain(), true);
  await runner.run({}, {});
  assert.equal(runner.ownershipUncertain(), true);
});

test("Remote phase descriptors cannot execute a test module outside the private run root", () => {
  const parent = privateRoot("ow-remote-descriptor-");
  try {
    const layout = createRemoteWorkspaceLayout(parent);
    const internal = (name) => join(layout.root, name);
    const descriptor = {
      protocol: 1,
      phase: "remote-workspace",
      runId: "11111111-1111-4111-8111-111111111111",
      timeoutMs: REMOTE_WORKSPACE_PHASE_TIMEOUT_MS,
      inactivityTimeoutMs: REMOTE_WORKSPACE_INACTIVITY_TIMEOUT_MS,
      authority: REMOTE_WORKSPACE_AUTHORITY,
      version: "1.130.0",
      commit: PINNED_REMOTE_VSCODE_COMMIT,
      candidateSha256: "a".repeat(64),
      candidateBytes: 123,
      remoteSshVersion: PINNED_REMOTE_SSH_VERSION,
      remoteSshBytes: PINNED_REMOTE_SSH_BYTES,
      remoteSshSha256: PINNED_REMOTE_SSH_SHA256,
      displayMode: "xvfb",
      hostPidNamespace: "pid:[1]",
      hostNetworkNamespace: "net:[1]",
      hostIpcNamespace: "ipc:[1]",
      hostUtsNamespace: "uts:[1]",
      hostUserNamespace: "user:[1]",
      user: "openwrangler",
      uid: 1001,
      gid: 1001,
      editor: internal("editor"),
      xvfb: internal("Xvfb"),
      testModule: internal("test-module"),
      python: internal("python"),
      sshConfig: internal("ssh-config"),
      sshServer: internal("dropbear"),
      sshLibraryPath: internal("ssh-libraries"),
      sshHostKey: internal("host-key"),
      sshAuthorizedKeys: internal("authorized-keys"),
      paths: { root: layout.root },
      hostHome: join(parent, "host-home"),
      hostSentinel: join(parent, "host-sentinel")
    };
    assert.equal(validateRemoteWorkspacePhaseDescriptor(descriptor, layout.root, { filesystem: false }), descriptor);
    assert.throws(
      () =>
        validateRemoteWorkspacePhaseDescriptor(
          { ...descriptor, testModule: join(parent, "host-test-module.mjs") },
          layout.root,
          { filesystem: false }
        ),
      /escaped its private root/u
    );
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
    getconf: "/usr/bin/true",
    ip: "/usr/bin/true",
    ldd: "/usr/bin/true",
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
        getconf: "/usr/bin/getconf",
        ip: "/usr/bin/ip",
        ldd: "/usr/bin/ldd",
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
      "--unshare-ipc",
      "--unshare-uts",
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
    assert.equal(
      environmentNames.some((name) => name.startsWith("LD_")),
      false
    );
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
    assert.equal(args.includes("/usr/bin/getconf"), true);
    assert.equal(args.includes("/usr/bin/ldd"), true);
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
      validateRemoteWorkspaceNamespaceProbe("127.0.0.1\nUID_MAP\n1001 0 2\nGID_MAP\n1001 0 1\nCAP_EFF\nCapEff: 1\n", {
        uid: 1001,
        gid: 1001
      }),
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

test("Remote namespace attestation binds caller candidate and pinned Remote SSH receipts", () => {
  const runId = "11111111-1111-4111-8111-111111111111";
  const candidate = validateRemoteWorkspaceCandidateExpectation("a".repeat(64), "123");
  assert.deepEqual(candidate, { sha256: "a".repeat(64), bytes: 123 });
  for (const [sha256, bytes] of [
    ["A".repeat(64), "123"],
    ["a".repeat(63), "123"],
    ["a".repeat(64), "0123"],
    ["a".repeat(64), "0"],
    ["a".repeat(64), String(64 * 1024 * 1024 + 1)]
  ]) {
    assert.throws(() => validateRemoteWorkspaceCandidateExpectation(sha256, bytes), /SHA-256|candidate size/u);
  }
  const attestation = {
    protocol: 1,
    runId,
    phase: "remote-workspace",
    namespaceEmpty: true,
    network: "unshared",
    ipc: "unshared",
    uts: "unshared",
    hostname: "openwrangler-remote-acceptance",
    display: "xvfb",
    displayEmpty: true,
    remoteAuthority: REMOTE_WORKSPACE_AUTHORITY,
    version: "1.130.0",
    commit: PINNED_REMOTE_VSCODE_COMMIT,
    candidateSha256: candidate.sha256,
    candidateBytes: candidate.bytes,
    remoteSshVersion: PINNED_REMOTE_SSH_VERSION,
    remoteSshBytes: PINNED_REMOTE_SSH_BYTES,
    remoteSshSha256: PINNED_REMOTE_SSH_SHA256
  };
  assert.deepEqual(
    validateRemoteWorkspaceNamespaceAttestation(`${JSON.stringify(attestation)}\n`, { runId, ...candidate }),
    attestation
  );
  for (const mutation of [
    { ...attestation, candidateSha256: "b".repeat(64) },
    { ...attestation, candidateBytes: 124 },
    { ...attestation, remoteSshVersion: "0.125.0" },
    { ...attestation, remoteSshBytes: PINNED_REMOTE_SSH_BYTES + 1 },
    { ...attestation, remoteSshSha256: "b".repeat(64) },
    { ...attestation, extra: true }
  ]) {
    assert.throws(
      () => validateRemoteWorkspaceNamespaceAttestation(JSON.stringify(mutation), { runId, ...candidate }),
      /exact candidate, Remote SSH artifact/u
    );
  }
});

test("Remote candidate paths reject relative caller arguments before resolution", () => {
  assert.equal(validateRemoteWorkspaceCandidatePath("/tmp/openwrangler.vsix"), "/tmp/openwrangler.vsix");
  for (const path of ["openwrangler.vsix", "./openwrangler.vsix", "../openwrangler.vsix", "", "bad\0path"]) {
    assert.throws(() => validateRemoteWorkspaceCandidatePath(path), /absolute caller candidate path/u);
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
