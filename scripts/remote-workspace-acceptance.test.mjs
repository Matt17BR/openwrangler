import assert from "node:assert/strict";
import {
  chmodSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  assertRemoteWorkspaceHost,
  createRemoteWorkspaceHostIsolationDigest,
  createRemoteWorkspaceCommandRunner,
  createRemoteWorkspaceBwrapArguments,
  createRemoteWorkspaceLayout,
  PINNED_REMOTE_SSH_BYTES,
  PINNED_REMOTE_SSH_SHA256,
  PINNED_REMOTE_SSH_VERSION,
  parseRemoteWorkspacePhaseDescriptor,
  readBoundedRemoteWorkspaceFile,
  REMOTE_WORKSPACE_AUTHORITY,
  REMOTE_WORKSPACE_INACTIVITY_TIMEOUT_MS,
  REMOTE_WORKSPACE_PHASE_CHILD_PATH,
  REMOTE_WORKSPACE_PHASE_DESCRIPTOR_PATH,
  REMOTE_WORKSPACE_PHASE_TIMEOUT_MS,
  validateRootOwnedSystemRuntimeDirectory,
  validateRemoteWorkspaceBwrapHelp,
  validateRemoteWorkspaceCandidateExpectation,
  validateRemoteWorkspaceCandidatePath,
  validateRemoteWorkspaceNamespaceAttestation,
  validateRemoteWorkspacePhaseDescriptorPath,
  validateRemoteWorkspacePhaseDescriptor,
  validateRemoteWorkspaceNamespaceProbe,
  validateRemoteWorkspaceSystemRuntimeDirectories,
  validateRemoteSshLogAttestation,
  validateRemoteWorkspaceResult
} from "./remote-workspace-acceptance.mjs";
import { PINNED_REMOTE_VSCODE_COMMIT } from "./remote-workspace-acquisition.mjs";
import { createRemoteWorkspaceImmutableMountTemplate } from "./remote-workspace-launch.mjs";

const linuxTest = process.platform === "linux" ? test : test.skip;

linuxTest("Remote workspace layout is short, private, and independently scoped", () => {
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

linuxTest("Remote phase descriptors cannot execute a test module outside the private run root", () => {
  const descriptor = remotePhaseDescriptor();
  assert.equal(validateRemoteWorkspacePhaseDescriptor(descriptor, { filesystem: false }), descriptor);
  assert.throws(
    () =>
      validateRemoteWorkspacePhaseDescriptor(
        { ...descriptor, testModule: "/host-test-module.mjs" },
        { filesystem: false }
      ),
    /fixed private namespace layout/u
  );
  assert.throws(
    () =>
      validateRemoteWorkspacePhaseDescriptor(
        { ...descriptor, paths: { ...descriptor.paths, root: "/attacker-root" } },
        { filesystem: false }
      ),
    /fixed private namespace layout/u
  );
  assert.throws(
    () =>
      validateRemoteWorkspacePhaseDescriptor(
        { ...descriptor, paths: { ...descriptor.paths, extra: "/ow/extra" } },
        { filesystem: false }
      ),
    /fixed private namespace layout/u
  );
  assert.throws(
    () => validateRemoteWorkspacePhaseDescriptor({ ...descriptor, extra: true }, { filesystem: false }),
    /malformed/u
  );
  const canonical = `${JSON.stringify(descriptor)}\n`;
  assert.deepEqual(parseRemoteWorkspacePhaseDescriptor(canonical, { filesystem: false }), descriptor);
  const reversed = Object.fromEntries(Object.entries(descriptor).reverse());
  assert.throws(
    () => parseRemoteWorkspacePhaseDescriptor(`${JSON.stringify(reversed)}\n`, { filesystem: false }),
    /canonical JSON/u
  );
  const reversedPaths = {
    ...descriptor,
    paths: Object.fromEntries(Object.entries(descriptor.paths).reverse())
  };
  assert.throws(
    () => parseRemoteWorkspacePhaseDescriptor(`${JSON.stringify(reversedPaths)}\n`, { filesystem: false }),
    /canonical JSON/u
  );
  assert.throws(
    () =>
      parseRemoteWorkspacePhaseDescriptor(canonical.replace('"protocol":1', '"protocol":99,"protocol":1'), {
        filesystem: false
      }),
    /canonical JSON/u
  );
});

linuxTest("Remote phase descriptor filesystem validation rejects linked leaves and precreated outputs", () => {
  const root = privateRoot("ow-remote-descriptor-filesystem-");
  try {
    const descriptor = createPhaseFilesystem(root);
    assert.equal(
      validateRemoteWorkspacePhaseDescriptor(descriptor, { filesystem: true, inspectionRoot: root }),
      descriptor
    );
    const testModule = join(root, "rh", "test-module", "dist-test", "test", "extensionHost", "index.js");
    linkSync(testModule, join(root, "linked-test-module.js"));
    assert.throws(
      () => validateRemoteWorkspacePhaseDescriptor(descriptor, { filesystem: true, inspectionRoot: root }),
      /single-link remote test module/u
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }

  for (const output of ["result.json", "progress.json"]) {
    const outputRoot = privateRoot(`ow-remote-descriptor-${output}-`);
    try {
      const descriptor = createPhaseFilesystem(outputRoot);
      writeFileSync(join(outputRoot, "out", output), "{}\n", { mode: 0o600 });
      assert.throws(
        () => validateRemoteWorkspacePhaseDescriptor(descriptor, { filesystem: true, inspectionRoot: outputRoot }),
        /must be absent/u
      );
    } finally {
      rmSync(outputRoot, { recursive: true, force: true });
    }
  }
});

linuxTest("Remote phase descriptor filesystem validation rejects a symlinked trusted leaf", () => {
  const root = privateRoot("ow-remote-descriptor-symlink-");
  try {
    const descriptor = createPhaseFilesystem(root);
    const editor = join(root, "client", "code");
    const replacement = join(root, "client", "replacement");
    renameSync(editor, replacement);
    symlinkSync(replacement, editor);
    assert.throws(
      () => validateRemoteWorkspacePhaseDescriptor(descriptor, { filesystem: true, inspectionRoot: root }),
      /single-link private editor executable/u
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Remote bounded reads stay on one no-follow descriptor across a named-path swap", () => {
  const root = privateRoot("ow-remote-bounded-read-");
  try {
    const path = join(root, "phase.json");
    const original = join(root, "original.json");
    const replacement = join(root, "replacement.json");
    writeFileSync(path, '{"value":"original"}\n', { mode: 0o600 });
    writeFileSync(replacement, '{"value":"replacement"}\n', { mode: 0o600 });
    assert.throws(
      () =>
        readBoundedRemoteWorkspaceFile(path, 1_024, {
          onDescriptorOpened: () => {
            renameSync(path, original);
            renameSync(replacement, path);
          }
        }),
      /path identity changed/u
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Remote phase accepts only its exact read-only descriptor argument", () => {
  assert.equal(
    validateRemoteWorkspacePhaseDescriptorPath(REMOTE_WORKSPACE_PHASE_DESCRIPTOR_PATH),
    REMOTE_WORKSPACE_PHASE_DESCRIPTOR_PATH
  );
  for (const path of ["/ow/other.json", "/tmp/phase.json", "phase.json", undefined]) {
    assert.throws(() => validateRemoteWorkspacePhaseDescriptorPath(path), /exact read-only private descriptor/u);
  }
});

test("Remote host preflight is Linux-only and fails closed without user namespaces", async () => {
  await assert.rejects(
    assertRemoteWorkspaceHost({ platform: "darwin", architecture: "arm64", tools: {} }),
    /only Linux x64/u
  );
  const fakeTools = Object.fromEntries(
    [
      "bash",
      "bwrap",
      "busybox",
      "dpkgDeb",
      "dynamicLoader",
      "getconf",
      "ip",
      "ldd",
      "ldconfig",
      "node",
      "ssh",
      "sshKeygen",
      "xkbcomp"
    ].map((name) => [name, process.execPath])
  );
  await assert.rejects(
    assertRemoteWorkspaceHost(
      { platform: "linux", architecture: "x64", tools: fakeTools, uid: 1001, gid: 1001 },
      { runCommand: async () => Promise.reject(new Error("unprivileged user namespaces disabled")) }
    ),
    /no desktop-network fallback/u
  );
});

test("Bubblewrap preflight requires descriptor-bound mutable and read-only mounts", () => {
  const help = [
    "Usage:",
    "    --bind-fd FD DEST            Bind open directory or path fd on DEST",
    "    --ro-bind-fd FD DEST         Bind open directory or path fd read-only on DEST"
  ].join("\n");
  assert.deepEqual(validateRemoteWorkspaceBwrapHelp(help), { bindFd: true, readOnlyBindFd: true });
  for (const unsupported of [
    help.replace("--bind-fd FD DEST", "--bind SRC DEST"),
    help.replace("--ro-bind-fd FD DEST", "--ro-bind SRC DEST"),
    ""
  ]) {
    assert.throws(() => validateRemoteWorkspaceBwrapHelp(unsupported), /descriptor-bound mount interface/u);
  }
});

linuxTest("Bubblewrap arguments clear the environment and create zero-network PID isolation", () => {
  const parent = privateRoot("ow-remote-bwrap-");
  try {
    const layout = createRemoteWorkspaceLayout(parent);
    const hostSentinel = join(parent, "host-private-sentinel");
    writeFileSync(hostSentinel, "private\n", { mode: 0o600 });
    const child = join(layout.phaseRuntime, "remote-workspace-phase-child.mjs");
    writeFileSync(child, "export {};\n");
    const descriptor = layout.descriptor;
    writeFileSync(descriptor, "{}\n", { mode: 0o600 });
    const args = createRemoteWorkspaceBwrapArguments(
      {
        root: layout.root,
        descriptor,
        childScript: child,
        // This structural argument test never executes the phase. Use a
        // platform-present regular executable instead of assuming one Python
        // minor exists on every CI image.
        systemPython: process.execPath,
        systemRuntimeDirectories: ["/usr"],
        immutableMounts: createRemoteWorkspaceImmutableMountTemplate(PINNED_REMOTE_VSCODE_COMMIT),
        uid: 1001,
        gid: 1001,
        tools: {
          bash: process.execPath,
          bwrap: process.execPath,
          busybox: process.execPath,
          dynamicLoader: process.execPath,
          getconf: process.execPath,
          ip: process.execPath,
          ldd: process.execPath,
          ldconfig: process.execPath,
          node: process.execPath,
          ssh: process.execPath,
          xkbcomp: process.execPath
        }
      },
      {
        validateSystemRuntimeDirectory: (path) => path
      }
    );
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
    const canonicalRoot = realpathSync(layout.root);
    assert.equal(mountSources.includes("/"), false);
    assert.equal(mountSources.includes(canonicalRoot), false);
    assert.equal(args.includes(hostSentinel), false);
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
    const descriptorBind = args.findIndex(
      (value, index) =>
        value === "--ro-bind-fd" &&
        args[index + 1] ===
          String(
            createRemoteWorkspaceImmutableMountTemplate(PINNED_REMOTE_VSCODE_COMMIT).find(
              (mount) => mount.id === "descriptor"
            ).descriptor
          ) &&
        args[index + 2] === REMOTE_WORKSPACE_PHASE_DESCRIPTOR_PATH
    );
    assert.notEqual(descriptorBind, -1);
    assert.equal(args.includes("--bind-fd"), true);
    assert.equal(args.includes("--ro-bind-fd"), true);
    assert.equal(args.includes(layout.root), false);
    const commandSeparator = args.lastIndexOf("--");
    assert.equal(args[commandSeparator + 2], REMOTE_WORKSPACE_PHASE_CHILD_PATH);
    assert.equal(args[commandSeparator + 3], REMOTE_WORKSPACE_PHASE_DESCRIPTOR_PATH);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("Bubblewrap requires an explicit available system-runtime closure", () => {
  assert.throws(
    () => validateRemoteWorkspaceSystemRuntimeDirectories(undefined),
    /explicit unique system-runtime closure/u
  );
  assert.throws(
    () => validateRemoteWorkspaceSystemRuntimeDirectories(["/definitely/missing/open-wrangler-runtime"]),
    /unavailable or unsafe/u
  );
  assert.throws(
    () => validateRemoteWorkspaceSystemRuntimeDirectories(["/usr/lib", "/usr/lib"]),
    /explicit unique system-runtime closure/u
  );
});

linuxTest("System runtime closure roots must be canonical, root-owned, and non-writable", () => {
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
  const hostIsolationSha256 = createRemoteWorkspaceHostIsolationDigest("/host-home", "/host-sentinel");
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
    remoteSshSha256: PINNED_REMOTE_SSH_SHA256,
    hostIsolationSha256
  };
  assert.deepEqual(
    validateRemoteWorkspaceNamespaceAttestation(`${JSON.stringify(attestation)}\n`, {
      runId,
      ...candidate,
      hostIsolationSha256
    }),
    attestation
  );
  for (const mutation of [
    { ...attestation, candidateSha256: "b".repeat(64) },
    { ...attestation, candidateBytes: 124 },
    { ...attestation, remoteSshVersion: "0.125.0" },
    { ...attestation, remoteSshBytes: PINNED_REMOTE_SSH_BYTES + 1 },
    { ...attestation, remoteSshSha256: "b".repeat(64) },
    { ...attestation, hostIsolationSha256: "b".repeat(64) },
    { ...attestation, extra: true }
  ]) {
    assert.throws(
      () =>
        validateRemoteWorkspaceNamespaceAttestation(JSON.stringify(mutation), {
          runId,
          ...candidate,
          hostIsolationSha256
        }),
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
  const root = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  chmodSync(root, 0o700);
  return root;
}

function remotePhaseDescriptor() {
  const hostHome = "/host-home";
  const hostSentinel = "/host-sentinel";
  return {
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
    hostPidNamespace: "pid:[1]",
    hostNetworkNamespace: "net:[1]",
    hostIpcNamespace: "ipc:[1]",
    hostUtsNamespace: "uts:[1]",
    hostUserNamespace: "user:[1]",
    editor: "/ow/client/code",
    xvfb: "/ow/phase-runtime/Xvfb",
    displayMode: "xvfb",
    testModule: "/ow/rh/test-module/dist-test/test/extensionHost/index.js",
    python: "/ow/rh/python/bin/python",
    user: "openwrangler",
    sshConfig: "/ow/rh/ssh/config",
    sshServer: "/ow/rh/ssh-runtime/runtime/bin/dropbear",
    sshLibraryPath: "/ow/rh/ssh-runtime/runtime/lib",
    sshHostKey: "/ow/rh/ssh/host",
    sshAuthorizedKeys: "/ow/rh/ssh",
    hostHome,
    hostSentinel,
    hostIsolationSha256: createRemoteWorkspaceHostIsolationDigest(hostHome, hostSentinel),
    uid: process.getuid?.() ?? 1001,
    gid: process.getgid?.() ?? 1001,
    paths: {
      root: "/ow",
      workspace: "/ow/rh/workspace",
      userData: "/ow/ud",
      localExtensions: "/ow/le",
      localHome: "/ow/lh",
      remoteHome: "/ow/rh",
      result: "/ow/out/result.json",
      progress: "/ow/out/progress.json"
    }
  };
}

function createPhaseFilesystem(root) {
  const descriptor = remotePhaseDescriptor();
  const directories = [
    "",
    "client",
    "phase-runtime",
    "rh",
    "rh/workspace",
    "rh/test-module/dist-test/test/extensionHost",
    "rh/python/bin",
    "rh/ssh",
    "rh/ssh-runtime/runtime/bin",
    "rh/ssh-runtime/runtime/lib",
    "ud",
    "le",
    "lh",
    "out"
  ];
  for (const directory of directories) {
    const path = directory.length === 0 ? root : join(root, directory);
    mkdirSync(path, { recursive: true, mode: 0o700 });
    chmodSync(path, 0o700);
  }
  for (const [path, contents, mode] of [
    [join(root, "client", "code"), "#!/bin/sh\n", 0o700],
    [join(root, "phase-runtime", "Xvfb"), "#!/bin/sh\n", 0o700],
    [join(root, "rh", "test-module", "dist-test", "test", "extensionHost", "index.js"), "export {};\n", 0o644],
    [join(root, "rh", "python", "bin", "python"), "#!/bin/sh\n", 0o700],
    [join(root, "rh", "ssh", "config"), "Host ow-loopback\n", 0o600],
    [join(root, "rh", "ssh-runtime", "runtime", "bin", "dropbear"), "#!/bin/sh\n", 0o700],
    [join(root, "rh", "ssh", "host"), "private-key\n", 0o600]
  ]) {
    writeFileSync(path, contents, { mode });
    chmodSync(path, mode);
  }
  return descriptor;
}
