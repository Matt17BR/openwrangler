import assert from "node:assert/strict";
import {
  chmodSync,
  closeSync,
  cpSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import test from "node:test";
import {
  assertRemoteWorkspaceHost,
  copyPrivatePythonEnvironment,
  createRemoteWorkspaceHostIsolationDigest,
  createRemoteWorkspaceCommandRunner,
  createRemoteWorkspaceBwrapArguments,
  createRemoteWorkspaceLayout,
  createRemoteWorkspaceNamespaceLayout,
  assertRemoteWorkspaceResultLease,
  closeRemoteWorkspaceResultLease,
  namespaceRemoteWorkspaceImmutablePath,
  openRemoteWorkspaceResultLeaseIfPresent,
  PINNED_REMOTE_SSH_BYTES,
  PINNED_REMOTE_SSH_SHA256,
  PINNED_REMOTE_SSH_VERSION,
  parseRemoteWorkspacePhaseDescriptor,
  readBoundedRemoteWorkspaceFile,
  REMOTE_WORKSPACE_AUTHORITY,
  REMOTE_WORKSPACE_INACTIVITY_TIMEOUT_MS,
  REMOTE_WORKSPACE_PHASE_CHILD_PATH,
  REMOTE_WORKSPACE_PHASE_DESCRIPTOR_PATH,
  REMOTE_WORKSPACE_PHASE_NODE_PATH,
  REMOTE_WORKSPACE_PHASE_TIMEOUT_MS,
  resolveRemoteWorkspaceSystemRuntimeDirectories,
  validateRootOwnedDropbearLibraryMountpoint,
  validateRootOwnedSystemRuntimeDirectory,
  validateRemoteWorkspaceBwrapHelp,
  validateRemoteWorkspaceBootstrapAttestation,
  validateRemoteWorkspaceCandidateExpectation,
  validateRemoteWorkspaceCandidatePath,
  validateRemoteWorkspaceNamespaceAttestation,
  validateRemoteWorkspacePhaseDescriptorPath,
  validateRemoteWorkspacePhaseDescriptor,
  validateRemoteWorkspaceNamespaceProbe,
  validateRemoteWorkspaceZeroCapabilities,
  validateRemoteWorkspaceSystemRuntimeDirectories,
  validateRemoteSshLogAttestation,
  validateRemoteWorkspaceResult
} from "./remote-workspace-acceptance.mjs";
import { PINNED_REMOTE_VSCODE_COMMIT } from "./remote-workspace-acquisition.mjs";
import {
  finalizeRemoteWorkspaceControllerFailure,
  publishRemoteWorkspaceControllerFailureResult,
  validateRemoteWorkspaceDropbearLoaderResolution
} from "./remote-workspace-contract.mjs";
import { createRemoteWorkspaceImmutableMountTemplate } from "./remote-workspace-launch.mjs";

const linuxTest = process.platform === "linux" ? test : test.skip;

linuxTest("Remote workspace layout is short, private, and independently scoped", () => {
  const parent = privateRoot("ow-remote-layout-");
  try {
    const layout = createRemoteWorkspaceLayout(parent);
    assert.equal(layout.root.startsWith(parent), true);
    assert.equal(layout.workspace.startsWith(layout.remoteHome), false);
    assert.equal(layout.remoteExtensions.startsWith(layout.remoteHome), false);
    assert.equal(layout.python.startsWith(layout.remoteHome), false);
    assert.equal(layout.sshRuntime.startsWith(layout.remoteHome), false);
    assert.equal(layout.remoteServerBase.startsWith(layout.remoteHome), false);
    assert.equal(layout.workspace.startsWith(layout.immutable), true);
    const remoteServerBase = lstatSync(layout.remoteServerBase);
    assert.equal(remoteServerBase.isDirectory(), true);
    assert.equal(remoteServerBase.isSymbolicLink(), false);
    assert.equal(remoteServerBase.mode & 0o777, 0o700);
    assert.deepEqual(readdirSync(layout.remoteServerBase), []);
    assert.deepEqual(readdirSync(layout.remoteHome).sort(), [
      ".vscode-server",
      "cache",
      "config",
      "data",
      "runtime",
      "state",
      "tmp"
    ]);
    const namespace = createRemoteWorkspaceNamespaceLayout(layout);
    assert.equal(namespace.remoteHome, "/ow/rh");
    assert.equal(namespace.workspace, "/ow/rh/workspace");
    assert.equal(namespace.remoteServerBase, "/ow/rh/.vscode-server");
    assert.equal(namespace.immutable, "/ow/immutable-unreachable");
    assert.equal(
      namespaceRemoteWorkspaceImmutablePath(layout, join(layout.python, "bin", "openwrangler-python")),
      "/ow/rh/python/bin/openwrangler-python"
    );
    assert.equal(
      namespaceRemoteWorkspaceImmutablePath(layout, join(layout.remoteServerBase, "code-test")),
      "/ow/rh/.vscode-server/code-test"
    );
    assert.throws(
      () => namespaceRemoteWorkspaceImmutablePath(layout, join(layout.remoteHome, "state", "untrusted")),
      /not part of one phase-visible immutable mount/u
    );
    assert.notEqual(layout.localHome, layout.remoteHome);
    assert.notEqual(layout.localExtensions, layout.remoteExtensions);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("Dropbear default-loader listings resolve only the independently pinned libraries", () => {
  const listing = [
    "\tlinux-vdso.so.1 (0x00007ffc00000000)",
    "\tlibtomcrypt.so.1 => /lib/x86_64-linux-gnu/libtomcrypt.so.1 (0x00007f0100000000)",
    "\tlibtommath.so.1 => /lib/x86_64-linux-gnu/libtommath.so.1 (0x00007f0200000000)",
    "\tlibc.so.6 => /usr/lib/x86_64-linux-gnu/libc.so.6 (0x00007f0300000000)",
    "\t/usr/lib64/ld-linux-x86-64.so.2 (0x00007f0400000000)",
    ""
  ].join("\n");
  assert.equal(validateRemoteWorkspaceDropbearLoaderResolution(listing), listing);
  const usrAliasListing = listing.replaceAll("/lib/x86_64-linux-gnu/", "/usr/lib/x86_64-linux-gnu/");
  assert.equal(validateRemoteWorkspaceDropbearLoaderResolution(usrAliasListing), usrAliasListing);
  for (const mutation of [
    listing.replace(
      "/lib/x86_64-linux-gnu/libtomcrypt.so.1",
      "/usr/lib/x86_64-linux-gnu/glibc-hwcaps/x86-64-v3/libtomcrypt.so.1"
    ),
    listing.replace("/lib/x86_64-linux-gnu/libtommath.so.1", "/usr/lib/libtommath.so.1"),
    listing.replace("\tlibtommath.so.1 => /lib/x86_64-linux-gnu/libtommath.so.1 (0x00007f0200000000)\n", ""),
    listing.replace(
      "\tlibtomcrypt.so.1 => /lib/x86_64-linux-gnu/libtomcrypt.so.1 (0x00007f0100000000)",
      [
        "\tlibtomcrypt.so.1 => /lib/x86_64-linux-gnu/libtomcrypt.so.1 (0x00007f0100000000)",
        "\tlibtomcrypt.so.1 => /lib/x86_64-linux-gnu/libtomcrypt.so.1 (0x00007f0100000001)"
      ].join("\n")
    ),
    `${listing}${"x".repeat(64 * 1024)}`
  ]) {
    assert.throws(() => validateRemoteWorkspaceDropbearLoaderResolution(mutation), /Dropbear loader/u);
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
    ["bash", "bwrap", "busybox", "dpkgDeb", "dynamicLoader", "getconf", "ip", "ldd", "ssh", "sshKeygen", "xkbcomp"].map(
      (name) => [name, process.execPath]
    )
  );
  await assert.rejects(
    assertRemoteWorkspaceHost(
      { platform: "linux", architecture: "x64", tools: fakeTools, uid: 1001, gid: 1001 },
      { runCommand: async () => Promise.reject(new Error("unprivileged user namespaces disabled")) }
    ),
    /no desktop-network fallback/u
  );
  const commands = [];
  const host = await assertRemoteWorkspaceHost(
    { platform: "linux", architecture: "x64", tools: fakeTools, uid: 1001, gid: 1001 },
    {
      async runCommand(command) {
        commands.push(command);
        return commands.length === 1
          ? {
              stdout: [
                "    --bind-fd FD DEST            Bind open directory or path fd on DEST",
                "    --ro-bind-fd FD DEST         Bind open directory or path fd read-only on DEST",
                "    --perms OCTAL                Set permissions of next argument (--bind-data, --file, etc.)"
              ].join("\n"),
              stderr: ""
            }
          : { stdout: namespaceProbeOutput(), stderr: "" };
      }
    }
  );
  assert.equal(host.uid, 1001);
  assert.equal(host.gid, 1001);
  assert.equal(commands.length, 2);
  assert.match(commands[1].args.at(-1), /echo CAPABILITIES/u);
  assert.match(commands[1].args.at(-1), /grep '\^Cap'/u);
});

test("Bubblewrap preflight requires descriptor-bound mutable and read-only mounts", () => {
  const help = [
    "Usage:",
    "    --bind-fd FD DEST            Bind open directory or path fd on DEST",
    "    --ro-bind-fd FD DEST         Bind open directory or path fd read-only on DEST",
    "    --perms OCTAL                Set permissions of next argument (--bind-data, --file, etc.)"
  ].join("\n");
  assert.deepEqual(validateRemoteWorkspaceBwrapHelp(help), {
    bindFd: true,
    readOnlyBindFd: true,
    permissions: true
  });
  for (const unsupported of [
    help.replace("--bind-fd FD DEST", "--bind SRC DEST"),
    help.replace("--ro-bind-fd FD DEST", "--ro-bind SRC DEST"),
    help.replace("--perms OCTAL", "--dir DIR"),
    ""
  ]) {
    assert.throws(() => validateRemoteWorkspaceBwrapHelp(unsupported), /descriptor-bound mount and permissions/u);
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
    const builderInput = {
      root: layout.root,
      descriptor,
      childScript: child,
      // This structural argument test never executes the phase. Use a
      // platform-present regular executable that stays distinct from the
      // staged phase-Node destination on system-Node layouts.
      systemPython: realpathSync("/usr/bin/true"),
      systemRuntimeDirectories: ["/usr/lib/x86_64-linux-gnu"],
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
        ssh: process.execPath,
        xkbcomp: process.execPath
      }
    };
    const args = createRemoteWorkspaceBwrapArguments(builderInput, {
      validateSystemRuntimeDirectory: (path) => path,
      validateDropbearLibraryMountpoint: (path) => path
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
    const namespaceRootIndex = args.indexOf("/ow");
    assert.notEqual(namespaceRootIndex, -1);
    assert.deepEqual(args.slice(namespaceRootIndex - 3, namespaceRootIndex + 1), ["--perms", "0700", "--dir", "/ow"]);
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
    const phaseNodeMount = createRemoteWorkspaceImmutableMountTemplate(PINNED_REMOTE_VSCODE_COMMIT).find(
      (mount) => mount.id === "phaseNode"
    );
    assert.ok(phaseNodeMount);
    assert.equal(
      args.some(
        (value, index) =>
          value === "--ro-bind-fd" &&
          args[index + 1] === String(phaseNodeMount.descriptor) &&
          args[index + 2] === REMOTE_WORKSPACE_PHASE_NODE_PATH
      ),
      true
    );
    assert.equal(
      args.some((value, index) => value === "--ro-bind" && args[index + 2] === "/usr/bin/node"),
      false
    );
    const phaseCommand = args.lastIndexOf("--");
    assert.notEqual(phaseCommand, -1);
    assert.equal(args[phaseCommand + 1], REMOTE_WORKSPACE_PHASE_NODE_PATH);
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
    assert.equal(args.includes("/usr/bin/ldconfig"), false);
    const usrLibDirectory = args.findIndex((value, index) => value === "--dir" && args[index + 1] === "/usr/lib");
    assert.notEqual(usrLibDirectory, -1);
    const systemRuntimeMount = args.findIndex(
      (value, index) =>
        value === "--ro-bind" &&
        args[index + 1] === "/usr/lib/x86_64-linux-gnu" &&
        args[index + 2] === "/usr/lib/x86_64-linux-gnu"
    );
    assert.notEqual(systemRuntimeMount, -1);
    for (const [id, destination] of [
      ["sshTomcrypt", "/usr/lib/x86_64-linux-gnu/libtomcrypt.so.1"],
      ["sshTommath", "/usr/lib/x86_64-linux-gnu/libtommath.so.1"]
    ]) {
      const mount = createRemoteWorkspaceImmutableMountTemplate(PINNED_REMOTE_VSCODE_COMMIT).find(
        (entry) => entry.id === id
      );
      assert.ok(mount);
      assert.equal(mount.destination, destination);
      const mountIndex = args.findIndex(
        (value, index) =>
          value === "--ro-bind-fd" && args[index + 1] === String(mount.descriptor) && args[index + 2] === destination
      );
      assert.ok(mountIndex > usrLibDirectory);
      assert.ok(mountIndex > systemRuntimeMount);
    }
    assert.notEqual(
      args.findIndex(
        (value, index) => value === "--symlink" && args[index + 1] === "usr/lib" && args[index + 2] === "/lib"
      ),
      -1
    );
    assert.equal(
      args.some((value) => value.includes("ld.so.cache") || value.includes("ld.so.conf")),
      false
    );
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
    assert.equal(args.includes("--bootstrap-preflight"), false);
    const bootstrapArgs = createRemoteWorkspaceBwrapArguments(
      { ...builderInput, bootstrapPreflight: true },
      {
        validateSystemRuntimeDirectory: (path) => path,
        validateDropbearLibraryMountpoint: (path) => path
      }
    );
    assert.deepEqual(bootstrapArgs.slice(-6), [
      REMOTE_WORKSPACE_PHASE_CHILD_PATH,
      REMOTE_WORKSPACE_PHASE_DESCRIPTOR_PATH,
      "/usr/bin/ip",
      "/usr/bin/ssh",
      "/usr/lib64/ld-linux-x86-64.so.2",
      "--bootstrap-preflight"
    ]);
    assert.throws(
      () =>
        createRemoteWorkspaceBwrapArguments(builderInput, {
          validateSystemRuntimeDirectory: (path) => path,
          validateDropbearLibraryMountpoint: null
        }),
      /library-mountpoint validator/u
    );
    assert.throws(
      () =>
        createRemoteWorkspaceBwrapArguments(builderInput, {
          validateSystemRuntimeDirectory: (path) => path,
          validateDropbearLibraryMountpoint: () => "/wrong"
        }),
      /altered its exact target/u
    );
    assert.throws(
      () =>
        createRemoteWorkspaceBwrapArguments(
          { ...builderInput, bootstrapPreflight: "yes" },
          {
            validateSystemRuntimeDirectory: (path) => path,
            validateDropbearLibraryMountpoint: (path) => path
          }
        ),
      /bootstrap-preflight policy/u
    );
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
    /root 1 of 1 is unavailable or unsafe/u
  );
  assert.throws(
    () => validateRemoteWorkspaceSystemRuntimeDirectories(["/usr/lib", "/usr/lib"]),
    /explicit unique system-runtime closure/u
  );
});

linuxTest("System runtime closure roots and ancestors must be canonical, root-owned, and non-writable", () => {
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
      realpath: (path) => path
    }),
    canonical
  );
  for (const [lstat, realpath] of [
    [(path) => (path === canonical ? directory({ uid: 1001 }) : directory()), (path) => path],
    [(path) => (path === canonical ? directory({ mode: 0o040775 }) : directory()), (path) => path],
    [(path) => (path === canonical ? directory({ isSymbolicLink: () => true }) : directory()), (path) => path],
    [() => directory(), (path) => (path === canonical ? `${canonical}-redirected` : path)],
    [(path) => (path === "/usr" ? directory({ mode: 0o040777 }) : directory()), (path) => path],
    [(path) => (path === "/usr" ? directory({ uid: 1001 }) : directory()), (path) => path],
    [() => directory(), (path) => (path === "/usr" ? "/redirected-usr" : path)]
  ]) {
    assert.throws(
      () =>
        validateRootOwnedSystemRuntimeDirectory(canonical, {
          lstat,
          realpath
        }),
      /every ancestor must be canonical, root-owned, and non-writable/u
    );
  }
});

test("Dropbear system-library mountpoints stay on root-controlled multiarch files", () => {
  const root = "/usr/lib/x86_64-linux-gnu";
  const file = (overrides = {}) => ({
    isFile: () => true,
    isSymbolicLink: () => false,
    uid: 0,
    mode: 0o100644,
    ...overrides
  });
  const symlink = (overrides = {}) => ({
    isFile: () => false,
    isSymbolicLink: () => true,
    uid: 0,
    mode: 0o120777,
    ...overrides
  });
  for (const [soname, versioned] of [
    ["libtomcrypt.so.1", "libtomcrypt.so.1.0.1"],
    ["libtommath.so.1", "libtommath.so.1.3.0"]
  ]) {
    const mountpoint = `${root}/${soname}`;
    const target = `${root}/${versioned}`;
    assert.equal(
      validateRootOwnedDropbearLibraryMountpoint(mountpoint, {
        lstat: (path) => (path === mountpoint ? symlink() : file()),
        readlink: () => versioned,
        realpath: () => target
      }),
      mountpoint
    );
    assert.equal(
      validateRootOwnedDropbearLibraryMountpoint(mountpoint, {
        lstat: () => file(),
        readlink: () => {
          throw new Error("A regular mountpoint must not be read as a link.");
        },
        realpath: () => mountpoint
      }),
      mountpoint
    );
  }

  const mountpoint = `${root}/libtomcrypt.so.1`;
  const target = `${root}/libtomcrypt.so.1.0.1`;
  const valid = {
    lstat: (path) => (path === mountpoint ? symlink() : file()),
    readlink: () => "libtomcrypt.so.1.0.1",
    realpath: () => target
  };
  for (const overrides of [
    { lstat: () => symlink({ uid: 1001 }) },
    { readlink: () => "/tmp/libtomcrypt.so.1.0.1" },
    { readlink: () => "../../../tmp/libtomcrypt.so.1.0.1" },
    {
      readlink: () => "mutable/libtomcrypt.so.1.0.1",
      realpath: () => `${root}/mutable/libtomcrypt.so.1.0.1`
    },
    {
      readlink: () => "libtomcrypt.so.1.indirect",
      realpath: () => target
    },
    {
      readlink: () => "libtomcrypt.so.1.0.1",
      realpath: () => `${root}/libtomcrypt.so.1.0.2`
    },
    { realpath: () => "/tmp/libtomcrypt.so.1.0.1" },
    { lstat: (path) => (path === mountpoint ? symlink() : file({ uid: 1001 })) },
    { lstat: (path) => (path === mountpoint ? symlink() : file({ mode: 0o100666 })) },
    {
      lstat: (path) =>
        path === mountpoint
          ? symlink()
          : symlink({
              isFile: () => true
            })
    },
    {
      lstat: (path) =>
        path === mountpoint
          ? symlink()
          : file({
              isFile: () => false
            })
    }
  ]) {
    assert.throws(() => validateRootOwnedDropbearLibraryMountpoint(mountpoint, { ...valid, ...overrides }));
  }
  assert.throws(() => validateRootOwnedDropbearLibraryMountpoint(`${root}/unapproved.so`, valid));
  assert.throws(() =>
    validateRootOwnedDropbearLibraryMountpoint(mountpoint, {
      ...valid,
      lstat: () => {
        throw new Error("missing");
      }
    })
  );
});

test("The system-runtime resolver constructs its complete closure before delegated validation", () => {
  const validated = [];
  const directories = resolveRemoteWorkspaceSystemRuntimeDirectories(["/usr/lib"], {
    validateDirectory(directory) {
      validated.push(directory);
      return directory;
    }
  });
  assert.equal(Object.isFrozen(directories), true);
  assert.deepEqual(validated, directories);
  assert.equal(directories.at(-1), "/usr/lib");
  assert.equal(directories.includes("/usr/lib/x86_64-linux-gnu"), true);
  assert.equal(directories.includes("/etc/ssl/certs"), true);
});

test("The system-runtime resolver identifies the failing root without exposing its path", () => {
  assert.throws(
    () =>
      validateRemoteWorkspaceSystemRuntimeDirectories(["/first", "/private/second"], {
        validateDirectory(directory) {
          if (directory === "/private/second") throw new Error("unsafe");
          return directory;
        }
      }),
    (error) => {
      assert.match(error.message, /root 2 of 2 is unavailable or unsafe/u);
      assert.equal(error.message.includes("/private/second"), false);
      assert.equal(error.cause?.message, "unsafe");
      return true;
    }
  );
});

test("The system-runtime resolver rejects a malformed injected directory validator", () => {
  assert.throws(
    () =>
      resolveRemoteWorkspaceSystemRuntimeDirectories(["/usr/lib"], {
        validateDirectory: null
      }),
    /validator is malformed/u
  );
});

test("Linux capability status requires all five exact capability sets to be uniquely zero", () => {
  const status = zeroCapabilityStatus();
  assert.deepEqual(validateRemoteWorkspaceZeroCapabilities(status), zeroCapabilities());
  for (const field of ["CapInh", "CapPrm", "CapEff", "CapBnd", "CapAmb"]) {
    assert.throws(
      () =>
        validateRemoteWorkspaceZeroCapabilities(
          status.replace(`${field}:\t${"0".repeat(16)}`, `${field}:\t${"0".repeat(15)}1`)
        ),
      /retained a Linux capability/u
    );
  }
  for (const mutation of [
    status
      .split("\n")
      .filter((line) => !line.startsWith("CapAmb:"))
      .join("\n"),
    `${status}\nCapEff:\t${"0".repeat(16)}`,
    `${status}\nCapFuture:\t${"0".repeat(16)}`,
    status.replace(`CapEff:\t${"0".repeat(16)}`, "CapEff:\tnot-hex"),
    status.replace(`CapEff:\t${"0".repeat(16)}`, `capeff:\t${"0".repeat(16)}`)
  ]) {
    assert.throws(
      () => validateRemoteWorkspaceZeroCapabilities(mutation),
      /capability status is (?:malformed|incomplete)/u
    );
  }
});

test("Namespace probe requires one ID row and all-zero Linux capabilities", () => {
  assert.deepEqual(validateRemoteWorkspaceNamespaceProbe(namespaceProbeOutput(), { uid: 1001, gid: 1001 }), {
    uidMap: [1001, 0, 1],
    gidMap: [1001, 0, 1],
    capabilities: zeroCapabilities()
  });
  assert.throws(
    () =>
      validateRemoteWorkspaceNamespaceProbe(namespaceProbeOutput().replace("1001 0 1", "1001 0 2"), {
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

test("Remote result validation accepts strict correlated success and failure outcomes", () => {
  const runId = "11111111-1111-4111-8111-111111111111";
  assert.deepEqual(
    validateRemoteWorkspaceResult(JSON.stringify({ protocol: 1, runId, phase: "remote-workspace", ok: true }), {
      runId
    }),
    { protocol: 1, runId, phase: "remote-workspace", ok: true, outcome: "success" }
  );
  assert.deepEqual(
    validateRemoteWorkspaceResult(
      JSON.stringify({ protocol: 1, runId, phase: "remote-workspace", ok: false, error: "assertion failed" }),
      { runId }
    ),
    {
      protocol: 1,
      runId,
      phase: "remote-workspace",
      ok: false,
      error: "assertion failed",
      outcome: "failure"
    }
  );
  for (const result of [
    { protocol: 1, runId: "22222222-2222-4222-8222-222222222222", phase: "remote-workspace", ok: true },
    { protocol: 1, runId, phase: "remote-workspace", ok: false, error: "" },
    { protocol: 1, runId, phase: "remote-workspace", ok: false, error: "x".repeat(16_001) },
    { protocol: 1, runId, phase: "verify", ok: true },
    { protocol: 1, runId, phase: "remote-workspace", ok: true, authority: REMOTE_WORKSPACE_AUTHORITY },
    { protocol: 1, runId, phase: "remote-workspace", ok: false, error: "failed", extra: true }
  ]) {
    assert.throws(
      () => validateRemoteWorkspaceResult(JSON.stringify(result), { runId }),
      /correlated terminal result/u
    );
  }
});

test("Remote bootstrap attestation accepts only one canonical correlated private-layout proof", () => {
  const runId = "11111111-1111-4111-8111-111111111111";
  const attestation = {
    protocol: 1,
    runId,
    phase: "remote-workspace",
    kind: "bootstrap-preflight",
    filesystem: "validated",
    namespaceEmpty: true,
    capabilities: zeroCapabilities()
  };
  const contents = `${JSON.stringify(attestation)}\n`;
  assert.deepEqual(validateRemoteWorkspaceBootstrapAttestation(contents, { runId }), attestation);
  for (const mutation of [
    contents.trimEnd(),
    `\n${contents}`,
    `${JSON.stringify({ ...attestation, runId: "22222222-2222-4222-8222-222222222222" })}\n`,
    `${JSON.stringify({ ...attestation, filesystem: "unchecked" })}\n`,
    `${JSON.stringify({ ...attestation, capabilities: { ...zeroCapabilities(), effective: 1 } })}\n`,
    `${JSON.stringify({
      ...attestation,
      capabilities: Object.fromEntries(Object.entries(zeroCapabilities()).reverse())
    })}\n`,
    `${JSON.stringify({ ...attestation, rawDiagnostic: "/host/private" })}\n`
  ]) {
    assert.throws(() => validateRemoteWorkspaceBootstrapAttestation(mutation, { runId }), /bootstrap attestation/u);
  }
  assert.throws(
    () => validateRemoteWorkspaceBootstrapAttestation(contents, { runId: "not-a-run-id" }),
    /bootstrap attestation/u
  );
});

test("Remote controller failure finalization proves cleanup and isolation before fixed publication", async () => {
  const capabilities = {
    inheritable: 0,
    permitted: 0,
    effective: 0,
    bounding: 0,
    ambient: 0
  };
  for (const code of ["phase-failed", "phase-result-wait-failed"]) {
    const calls = [];
    const result = await finalizeRemoteWorkspaceControllerFailure({
      async stopChildren() {
        calls.push("stop");
      },
      assertDisplayEmpty() {
        calls.push("display");
      },
      assertNamespace() {
        calls.push("namespace");
      },
      captureCapabilities() {
        calls.push("capabilities");
        return capabilities;
      },
      publishResult(publishedCode) {
        calls.push(`publish:${publishedCode}`);
        return { outcome: "failure", resultBytes: 123, resultSha256: "a".repeat(64) };
      },
      code
    });
    assert.deepEqual(calls, ["stop", "display", "namespace", "capabilities", `publish:${code}`]);
    assert.deepEqual(result, {
      outcome: "failure",
      resultBytes: 123,
      resultSha256: "a".repeat(64),
      capabilities
    });
  }
  await assert.rejects(
    finalizeRemoteWorkspaceControllerFailure({
      stopChildren() {
        assert.fail("An unknown failure code must be rejected before cleanup.");
      },
      assertDisplayEmpty() {},
      assertNamespace() {},
      captureCapabilities() {
        return capabilities;
      },
      publishResult() {},
      code: "raw secret-bearing diagnostic"
    }),
    /failure boundary is malformed/u
  );
});

test("Remote controller failure finalization attests a first-observed result without overwriting it", async () => {
  const capabilities = zeroCapabilities();
  for (const code of ["phase-cleanup-failed", "phase-result-validation-failed"]) {
    for (const resultOutcome of ["success", "failure"]) {
      const calls = [];
      const result = await finalizeRemoteWorkspaceControllerFailure({
        async stopChildren() {
          calls.push("stop");
        },
        assertDisplayEmpty() {
          calls.push("display");
        },
        assertNamespace() {
          calls.push("namespace");
        },
        captureCapabilities() {
          calls.push("capabilities");
          return capabilities;
        },
        observedResultReceipt: {
          outcome: resultOutcome,
          resultBytes: 123,
          resultSha256: "a".repeat(64)
        },
        publishResult() {
          assert.fail("An existing result must never be overwritten.");
        },
        code
      });
      assert.deepEqual(calls, ["stop", "display", "namespace", "capabilities"]);
      assert.deepEqual(result, {
        outcome: "failure",
        controllerCode: code,
        resultOutcome,
        resultBytes: 123,
        resultSha256: "a".repeat(64),
        capabilities
      });
    }
  }
  await assert.rejects(
    finalizeRemoteWorkspaceControllerFailure({
      async stopChildren() {},
      assertDisplayEmpty() {},
      assertNamespace() {},
      captureCapabilities() {
        return capabilities;
      },
      observedResultReceipt: {
        outcome: "success",
        resultBytes: 123,
        resultSha256: "a".repeat(64),
        rawDiagnostic: "/host/private"
      },
      publishResult() {
        assert.fail("A malformed existing result must never be replaced.");
      }
    }),
    /existing controller result receipt is malformed/u
  );
  await assert.rejects(
    finalizeRemoteWorkspaceControllerFailure({
      async stopChildren() {},
      assertDisplayEmpty() {},
      assertNamespace() {},
      captureCapabilities() {
        return capabilities;
      },
      observedResultReceipt: {
        outcome: "success",
        resultBytes: 123,
        resultSha256: "a".repeat(64)
      },
      publishResult() {
        assert.fail("A late result must never expand an earlier-stage failure contract.");
      },
      code: "phase-result-wait-failed"
    }),
    /existing controller result receipt is malformed/u
  );
});

test("Remote controller failure finalization never publishes across cleanup or isolation uncertainty", async () => {
  for (const failedOperation of ["stop", "display", "namespace", "capabilities"]) {
    const calls = [];
    await assert.rejects(
      finalizeRemoteWorkspaceControllerFailure({
        async stopChildren() {
          calls.push("stop");
          if (failedOperation === "stop") throw new Error("stop failed");
        },
        assertDisplayEmpty() {
          calls.push("display");
          if (failedOperation === "display") throw new Error("display failed");
        },
        assertNamespace() {
          calls.push("namespace");
          if (failedOperation === "namespace") throw new Error("namespace failed");
        },
        captureCapabilities() {
          calls.push("capabilities");
          return failedOperation === "capabilities"
            ? { inheritable: 0, permitted: 0, effective: 1, bounding: 0, ambient: 0 }
            : { inheritable: 0, permitted: 0, effective: 0, bounding: 0, ambient: 0 };
        },
        publishResult() {
          calls.push("publish");
          return { outcome: "failure", resultBytes: 123, resultSha256: "a".repeat(64) };
        }
      }),
      /failed|zero capabilities/u
    );
    assert.equal(calls.includes("publish"), false);
  }
});

linuxTest("Remote controller failures publish one exclusive correlated result after owned cleanup", () => {
  const root = privateRoot("ow-remote-controller-result-");
  const runId = "11111111-1111-4111-8111-111111111111";
  const path = join(root, "result.json");
  const rejectedPath = join(root, "rejected.json");
  const protectedPath = join(root, "protected.txt");
  const linkedPath = join(root, "linked.json");
  const hardLinkedPath = join(root, "hard-linked.json");
  try {
    assert.throws(
      () =>
        publishRemoteWorkspaceControllerFailureResult(rejectedPath, {
          runId,
          code: "phase-failed secret-token https://example.test/private /host/private"
        }),
      /malformed/u
    );
    assert.throws(
      () => lstatSync(rejectedPath),
      (error) => error?.code === "ENOENT"
    );
    const receipt = publishRemoteWorkspaceControllerFailureResult(path, {
      runId,
      code: "phase-failed"
    });
    assert.equal(receipt.outcome, "failure");
    assert.equal(receipt.resultBytes, statSync(path).size);
    assert.match(receipt.resultSha256, /^[0-9a-f]{64}$/u);
    assert.equal(statSync(path).mode & 0o777, 0o600);
    assert.deepEqual(validateRemoteWorkspaceResult(readFileSync(path, "utf8"), { runId }), {
      protocol: 1,
      runId,
      phase: "remote-workspace",
      ok: false,
      error: "controller:phase-failed: the isolated Remote SSH controller exited after verified cleanup.",
      outcome: "failure"
    });
    assert.throws(
      () =>
        publishRemoteWorkspaceControllerFailureResult(path, {
          runId,
          code: "phase-failed"
        }),
      (error) => error?.code === "EEXIST"
    );
    assert.match(readFileSync(path, "utf8"), /controller:phase-failed/u);
    assert.doesNotMatch(readFileSync(path, "utf8"), /secret-token|example\.test|host\/private/u);
    const stagedFailurePath = join(root, "stage-failure.json");
    publishRemoteWorkspaceControllerFailureResult(stagedFailurePath, {
      runId,
      code: "phase-result-wait-failed"
    });
    assert.equal(
      validateRemoteWorkspaceResult(readFileSync(stagedFailurePath, "utf8"), { runId }).error,
      "controller:phase-result-wait-failed: the isolated extension host failed before publishing a result."
    );
    writeFileSync(protectedPath, "protected\n", { mode: 0o600 });
    symlinkSync(protectedPath, linkedPath);
    linkSync(protectedPath, hardLinkedPath);
    for (const existingPath of [linkedPath, hardLinkedPath]) {
      assert.throws(
        () =>
          publishRemoteWorkspaceControllerFailureResult(existingPath, {
            runId,
            code: "phase-failed"
          }),
        (error) => error?.code === "EEXIST"
      );
    }
    assert.equal(readFileSync(protectedPath, "utf8"), "protected\n");
    assert.doesNotThrow(() => lstatSync(path));
    assert.deepEqual(
      readdirSync(root)
        .filter((name) => name.startsWith(".result.json."))
        .sort(),
      []
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

linuxTest("Remote controller failure publication never exposes write, flush, or close faults", () => {
  const root = privateRoot("ow-remote-controller-fault-");
  const runId = "11111111-1111-4111-8111-111111111111";
  try {
    for (const [stage, boundary] of [
      [
        "write",
        {
          write() {
            throw new Error("injected write fault");
          }
        }
      ],
      [
        "fsync",
        {
          fsync() {
            throw new Error("injected fsync fault");
          }
        }
      ],
      [
        "close",
        {
          close(descriptor) {
            closeSync(descriptor);
            throw new Error("injected close fault");
          }
        }
      ]
    ]) {
      const path = join(root, `${stage}.json`);
      assert.throws(
        () =>
          publishRemoteWorkspaceControllerFailureResult(
            path,
            {
              runId,
              code: "phase-failed"
            },
            boundary
          ),
        new RegExp(`injected ${stage} fault`, "u")
      );
      assert.throws(
        () => lstatSync(path),
        (error) => error?.code === "ENOENT"
      );
      assert.deepEqual(
        readdirSync(root).filter((name) => name.includes(`${stage}.json`)),
        []
      );
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

linuxTest("Remote controller failure atomic publication never overwrites a racing result", () => {
  const root = privateRoot("ow-remote-controller-race-");
  const runId = "11111111-1111-4111-8111-111111111111";
  const path = join(root, "result.json");
  try {
    assert.throws(
      () =>
        publishRemoteWorkspaceControllerFailureResult(
          path,
          {
            runId,
            code: "phase-failed"
          },
          {
            beforeLink(_temporary, resultPath) {
              writeFileSync(resultPath, "racing-owner\n", { mode: 0o600 });
            }
          }
        ),
      (error) => error?.code === "EEXIST"
    );
    assert.equal(readFileSync(path, "utf8"), "racing-owner\n");
    assert.deepEqual(
      readdirSync(root)
        .filter((name) => name.startsWith(".result.json."))
        .sort(),
      []
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

linuxTest("Remote controller failure publication fails closed when identified temporary cleanup fails", () => {
  const root = privateRoot("ow-remote-controller-cleanup-");
  const runId = "11111111-1111-4111-8111-111111111111";
  const path = join(root, "result.json");
  let unlinkCalls = 0;
  try {
    assert.throws(
      () =>
        publishRemoteWorkspaceControllerFailureResult(
          path,
          {
            runId,
            code: "phase-failed"
          },
          {
            unlink() {
              unlinkCalls += 1;
              throw new Error("injected identified cleanup fault");
            }
          }
        ),
      (error) =>
        error instanceof AggregateError &&
        error.errors.length === 2 &&
        error.errors.every((candidate) => /identified cleanup fault/u.test(candidate.message))
    );
    assert.equal(unlinkCalls, 2);
    assert.equal(lstatSync(path).nlink, 2);
    assert.throws(() => openRemoteWorkspaceResultLeaseIfPresent(path, { runId }), /private regular file/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Remote result leases retain the first strict terminal file through final validation", () => {
  const root = privateRoot("ow-remote-result-lease-");
  const runId = "11111111-1111-4111-8111-111111111111";
  const path = join(root, "result.json");
  try {
    assert.equal(openRemoteWorkspaceResultLeaseIfPresent(path, { runId }), undefined);
    const contents = JSON.stringify({
      protocol: 1,
      runId,
      phase: "remote-workspace",
      ok: false,
      error: "assertion failed"
    });
    writeFileSync(path, contents, { mode: 0o600 });
    const lease = openRemoteWorkspaceResultLeaseIfPresent(path, { runId });
    assert.equal(lease.outcome, "failure");
    assert.equal(lease.bytes, Buffer.byteLength(contents));
    assert.match(lease.sha256, /^[0-9a-f]{64}$/u);
    assert.equal(lease.result.error, "assertion failed");
    assert.equal(assertRemoteWorkspaceResultLease(lease), lease);
    closeRemoteWorkspaceResultLease(lease);
    assert.throws(() => assertRemoteWorkspaceResultLease(lease), /not active/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Remote result leases reject path replacement before, during, and after first observation", () => {
  const runId = "11111111-1111-4111-8111-111111111111";
  for (const timing of ["during-open", "after-read", "after-open"]) {
    const root = privateRoot(`ow-remote-result-${timing}-`);
    const path = join(root, "result.json");
    const displaced = join(root, "displaced.json");
    const replacement = join(root, "replacement.json");
    const success = JSON.stringify({ protocol: 1, runId, phase: "remote-workspace", ok: true });
    const failure = JSON.stringify({
      protocol: 1,
      runId,
      phase: "remote-workspace",
      ok: false,
      error: "replacement"
    });
    try {
      writeFileSync(path, success, { mode: 0o600 });
      writeFileSync(replacement, failure, { mode: 0o600 });
      if (timing !== "after-open") {
        assert.throws(
          () =>
            openRemoteWorkspaceResultLeaseIfPresent(path, {
              runId,
              [timing === "during-open" ? "onDescriptorOpened" : "afterRead"]() {
                renameSync(path, displaced);
                renameSync(replacement, path);
              }
            }),
          /changed/u
        );
      } else {
        const lease = openRemoteWorkspaceResultLeaseIfPresent(path, { runId });
        renameSync(path, displaced);
        renameSync(replacement, path);
        assert.throws(() => assertRemoteWorkspaceResultLease(lease), /changed after first observation/u);
        assert.throws(() => closeRemoteWorkspaceResultLease(lease), /changed after first observation/u);
        assert.throws(() => assertRemoteWorkspaceResultLease(lease), /not active/u);
      }
      assert.equal(readFileSync(displaced, "utf8"), success);
      assert.equal(readFileSync(path, "utf8"), failure);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("Remote result lease identity uncertainty stays latched after the original path is restored", () => {
  const root = privateRoot("ow-remote-result-restored-");
  const runId = "11111111-1111-4111-8111-111111111111";
  const path = join(root, "result.json");
  const displaced = join(root, "displaced.json");
  const contents = JSON.stringify({ protocol: 1, runId, phase: "remote-workspace", ok: true });
  try {
    writeFileSync(path, contents, { mode: 0o600 });
    const lease = openRemoteWorkspaceResultLeaseIfPresent(path, { runId });
    renameSync(path, displaced);
    writeFileSync(path, contents, { mode: 0o600 });
    assert.throws(() => assertRemoteWorkspaceResultLease(lease), /changed after first observation/u);
    rmSync(path);
    renameSync(displaced, path);
    assert.equal(readFileSync(path, "utf8"), contents);
    assert.throws(() => assertRemoteWorkspaceResultLease(lease), /changed after first observation/u);
    assert.throws(() => closeRemoteWorkspaceResultLease(lease), /changed after first observation/u);
    assert.throws(() => assertRemoteWorkspaceResultLease(lease), /not active/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
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
    hostIsolationSha256,
    outcome: "success",
    resultBytes: 123,
    resultSha256: "c".repeat(64),
    capabilities: zeroCapabilities()
  };
  assert.deepEqual(
    validateRemoteWorkspaceNamespaceAttestation(`${JSON.stringify(attestation)}\n`, {
      runId,
      ...candidate,
      hostIsolationSha256
    }),
    attestation
  );
  assert.equal(
    validateRemoteWorkspaceNamespaceAttestation(`${JSON.stringify({ ...attestation, outcome: "failure" })}\n`, {
      runId,
      ...candidate,
      hostIsolationSha256
    }).outcome,
    "failure"
  );
  const {
    resultBytes: controllerResultBytes,
    resultSha256: controllerResultSha256,
    capabilities: controllerCapabilities,
    ...controllerPrefix
  } = attestation;
  const controllerAttestation = {
    ...controllerPrefix,
    outcome: "failure",
    controllerCode: "phase-result-validation-failed",
    resultOutcome: "success",
    resultBytes: controllerResultBytes,
    resultSha256: controllerResultSha256,
    capabilities: controllerCapabilities
  };
  assert.deepEqual(
    validateRemoteWorkspaceNamespaceAttestation(`${JSON.stringify(controllerAttestation)}\n`, {
      runId,
      ...candidate,
      hostIsolationSha256
    }),
    controllerAttestation
  );
  for (const mutation of [
    { ...controllerAttestation, controllerCode: "raw diagnostic" },
    { ...controllerAttestation, controllerCode: "phase-result-wait-failed" },
    { ...controllerAttestation, resultOutcome: "unknown" },
    { ...controllerAttestation, outcome: "success" },
    Object.fromEntries(Object.entries(controllerAttestation).filter(([key]) => key !== "resultOutcome"))
  ]) {
    assert.throws(
      () =>
        validateRemoteWorkspaceNamespaceAttestation(`${JSON.stringify(mutation)}\n`, {
          runId,
          ...candidate,
          hostIsolationSha256
        }),
      /exact candidate, Remote SSH artifact/u
    );
  }
  const canonicalAttestation = JSON.stringify(attestation);
  for (const malformed of [
    canonicalAttestation,
    `${canonicalAttestation}\n\n`,
    `${canonicalAttestation}\r\n`,
    `${JSON.stringify(Object.fromEntries(Object.entries(attestation).reverse()))}\n`,
    `${JSON.stringify({
      ...attestation,
      capabilities: Object.fromEntries(Object.entries(attestation.capabilities).reverse())
    })}\n`,
    `${canonicalAttestation.replace('{"protocol":1,', '{"protocol":1,"protocol":1,')}\n`
  ]) {
    assert.throws(
      () =>
        validateRemoteWorkspaceNamespaceAttestation(malformed, {
          runId,
          ...candidate,
          hostIsolationSha256
        }),
      /canonical attestation|canonical JSON/u
    );
  }
  for (const mutation of [
    { ...attestation, candidateSha256: "b".repeat(64) },
    { ...attestation, candidateBytes: 124 },
    { ...attestation, remoteSshVersion: "0.125.0" },
    { ...attestation, remoteSshBytes: PINNED_REMOTE_SSH_BYTES + 1 },
    { ...attestation, remoteSshSha256: "b".repeat(64) },
    { ...attestation, hostIsolationSha256: "b".repeat(64) },
    { ...attestation, outcome: "unknown" },
    { ...attestation, resultBytes: 0 },
    { ...attestation, resultSha256: "C".repeat(64) },
    {
      ...attestation,
      capabilities: { ...attestation.capabilities, effective: 1 }
    },
    {
      ...attestation,
      capabilities: {
        inheritable: 0,
        permitted: 0,
        effective: 0,
        bounding: 0
      }
    },
    { ...attestation, extra: true }
  ]) {
    assert.throws(
      () =>
        validateRemoteWorkspaceNamespaceAttestation(`${JSON.stringify(mutation)}\n`, {
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

linuxTest("copied Python accepts an absent journal only after the product guard reports clean", async () => {
  const root = privateRoot("ow-remote-python-journal-absent-");
  try {
    const source = createTinyPythonEnvironment(root);
    const destination = join(root, "copied");
    let resolverInput;
    const copied = await copyPrivatePythonEnvironment(source.executable, destination, {
      resolveSystemRuntimeDirectories(pythonDirectories) {
        resolverInput = pythonDirectories;
        return resolveUnitSystemRuntimeDirectories(pythonDirectories);
      }
    });
    assert.equal(Object.isFrozen(resolverInput), true);
    assert.deepEqual(copied.systemRuntimeDirectories, resolveUnitSystemRuntimeDirectories(resolverInput));
    assert.equal(Object.isFrozen(copied.systemRuntimeDirectories), true);
    assert.equal(copied.executable, join(destination, "bin", "openwrangler-python"));
    assert.equal(lstatSync(join(source.prefix, "bin", "python")).isSymbolicLink(), true);
    assert.equal(lstatSync(join(destination, "bin", "python")).isSymbolicLink(), true);
    const copiedLauncher = lstatSync(copied.executable, { bigint: true });
    assert.equal(copiedLauncher.isFile(), true);
    assert.equal(copiedLauncher.isSymbolicLink(), false);
    assert.equal(copiedLauncher.nlink, 1n);
    assert.equal(Number(copiedLauncher.mode & 0o777n), 0o700);
    assert.equal(realpathSync(copied.executable), copied.executable);
    const copiedPrefix = spawnSync(
      copied.executable,
      ["-I", "-c", "import os,sys;print(os.path.realpath(sys.prefix))"],
      { encoding: "utf8", maxBuffer: 16 * 1024 }
    );
    assert.equal(copiedPrefix.status, 0, copiedPrefix.stderr);
    assert.equal(copiedPrefix.stdout.trim(), realpathSync(destination));
    assert.throws(() => lstatSync(join(source.prefix, ".openwrangler-dependency-journal-v1")), {
      code: "ENOENT"
    });
    assert.deepEqual(readdirSync(join(destination, ".openwrangler-dependency-journal-v1")), ["mutation.lock"]);
    assert.equal(lstatSync(join(destination, ".openwrangler-dependency-journal-v1")).mode & 0o777, 0o700);
    assert.equal(
      lstatSync(join(destination, ".openwrangler-dependency-journal-v1", "mutation.lock")).mode & 0o777,
      0o600
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

linuxTest("copied Python repairs only the copied clean journal under umask 0002", async () => {
  const root = privateRoot("ow-remote-python-journal-clean-");
  const priorUmask = process.umask(0o002);
  try {
    const source = createTinyPythonEnvironment(root);
    const sourceJournal = join(source.prefix, ".openwrangler-dependency-journal-v1");
    mkdirSync(sourceJournal, { mode: 0o700 });
    chmodSync(sourceJournal, 0o700);
    const sourceBefore = dependencyJournalTestReceipt(sourceJournal);
    const destination = join(root, "copied");
    let modeAfterRealCopy;
    await copyPrivatePythonEnvironment(source.executable, destination, {
      copy(sourcePath, destinationPath, options) {
        cpSync(sourcePath, destinationPath, options);
        modeAfterRealCopy = lstatSync(join(destinationPath, ".openwrangler-dependency-journal-v1")).mode & 0o777;
      },
      resolveSystemRuntimeDirectories: resolveUnitSystemRuntimeDirectories
    });
    assert.equal(modeAfterRealCopy, 0o775);
    assert.deepEqual(dependencyJournalTestReceipt(sourceJournal), sourceBefore);
    assert.equal(lstatSync(sourceJournal).mode & 0o777, 0o700);
    assert.equal(lstatSync(join(destination, ".openwrangler-dependency-journal-v1")).mode & 0o777, 0o700);
    assert.deepEqual(readdirSync(join(destination, ".openwrangler-dependency-journal-v1")), ["mutation.lock"]);
  } finally {
    process.umask(priorUmask);
    rmSync(root, { recursive: true, force: true });
  }
});

linuxTest("copied Python rejects a retained dirty dependency marker without changing its source", async () => {
  const root = privateRoot("ow-remote-python-journal-dirty-");
  try {
    const source = createTinyPythonEnvironment(root);
    const journal = join(source.prefix, ".openwrangler-dependency-journal-v1");
    mkdirSync(journal, { mode: 0o700 });
    chmodSync(journal, 0o700);
    writeFileSync(join(journal, "mutation.lock"), "", { mode: 0o600 });
    const token = "11111111-1111-4111-8111-111111111111";
    writeFileSync(
      join(journal, `mutation-${token}.json`),
      JSON.stringify({
        dependencies: [
          {
            importModule: "pandas",
            distribution: "pandas",
            installSpec: "pandas",
            minimumVersion: null,
            maximumVersionExclusive: null
          }
        ],
        environment: dependencyGuardTestEnvironment(source),
        protocol: "openwrangler-dependency-guard-v1",
        token
      }),
      { mode: 0o600 }
    );
    const before = dependencyJournalTestReceipt(journal);
    await assert.rejects(copyPrivatePythonEnvironment(source.executable, join(root, "copied")), /exited with code 16/u);
    assert.deepEqual(dependencyJournalTestReceipt(journal), before);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

linuxTest("copied Python rejects malformed journal state without filtering copied leaves", async () => {
  const root = privateRoot("ow-remote-python-journal-malformed-");
  try {
    const source = createTinyPythonEnvironment(root);
    const journal = join(source.prefix, ".openwrangler-dependency-journal-v1");
    mkdirSync(journal, { mode: 0o700 });
    chmodSync(journal, 0o700);
    writeFileSync(join(journal, "mutation.lock"), "", { mode: 0o600 });
    writeFileSync(join(journal, "unexpected.json"), "malformed\n", { mode: 0o600 });
    const before = dependencyJournalTestReceipt(journal);
    const destination = join(root, "copied");
    await assert.rejects(copyPrivatePythonEnvironment(source.executable, destination), /exited with code 12/u);
    assert.deepEqual(dependencyJournalTestReceipt(journal), before);
    assert.equal(
      readFileSync(join(destination, ".openwrangler-dependency-journal-v1", "unexpected.json"), "utf8"),
      "malformed\n"
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

linuxTest("copied Python never asks the product guard to recover a pending journal leaf", async () => {
  const root = privateRoot("ow-remote-python-journal-pending-");
  try {
    const source = createTinyPythonEnvironment(root);
    const journal = join(source.prefix, ".openwrangler-dependency-journal-v1");
    const token = "22222222-2222-4222-8222-222222222222";
    const pending = `.pending-${token}.tmp`;
    mkdirSync(journal, { mode: 0o700 });
    chmodSync(journal, 0o700);
    writeFileSync(join(journal, pending), "pending\n", { mode: 0o600 });
    const destination = join(root, "copied");
    await assert.rejects(
      copyPrivatePythonEnvironment(source.executable, destination),
      /contains recoverable or nested state/u
    );
    assert.equal(readFileSync(join(destination, ".openwrangler-dependency-journal-v1", pending), "utf8"), "pending\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

linuxTest("copied Python rejects source journal drift observed after the real copy", async () => {
  const root = privateRoot("ow-remote-python-journal-drift-");
  try {
    const source = createTinyPythonEnvironment(root);
    const journal = join(source.prefix, ".openwrangler-dependency-journal-v1");
    const lock = join(journal, "mutation.lock");
    mkdirSync(journal, { mode: 0o700 });
    chmodSync(journal, 0o700);
    writeFileSync(lock, "", { mode: 0o600 });
    await assert.rejects(
      copyPrivatePythonEnvironment(source.executable, join(root, "copied"), {
        copy(sourcePath, destinationPath, options) {
          cpSync(sourcePath, destinationPath, options);
          writeFileSync(lock, "changed\n", { mode: 0o600 });
        }
      }),
      /source Python dependency journal changed/u
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

linuxTest("copied Python rejects a malformed injected final system-runtime resolver before source access", async () => {
  await assert.rejects(
    copyPrivatePythonEnvironment("/not-used", "/not-used", {
      resolveSystemRuntimeDirectories: null
    }),
    /system-runtime resolver is malformed/u
  );
});

linuxTest("copied Python rejects a final resolver that alters the exact required closure", async () => {
  const root = privateRoot("ow-remote-python-runtime-closure-");
  try {
    const source = createTinyPythonEnvironment(root);
    await assert.rejects(
      copyPrivatePythonEnvironment(source.executable, join(root, "copied"), {
        resolveSystemRuntimeDirectories(pythonDirectories) {
          return resolveUnitSystemRuntimeDirectories(pythonDirectories).slice(1);
        }
      }),
      /altered its exact required closure/u
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Remote acceptance deadlines stay bounded and match native-editor ownership rules", () => {
  assert.equal(REMOTE_WORKSPACE_PHASE_TIMEOUT_MS, 300_000);
  assert.equal(REMOTE_WORKSPACE_INACTIVITY_TIMEOUT_MS, 180_000);
});

test("tiny Python fixtures resolve explicit, setup-python, and platform-local interpreters absolutely", () => {
  const root = privateRoot("ow-remote-python-bootstrap-");
  try {
    const explicit = join(root, "explicit-python");
    const hosted = join(root, "hosted");
    const hostedPosix = join(hosted, "bin", "python");
    const hostedWindows = join(hosted, "python.exe");
    const localPosix = join(root, ".venv", "bin", "python");
    for (const path of [explicit, hostedPosix, hostedWindows, localPosix]) {
      mkdirSync(resolve(path, ".."), { recursive: true, mode: 0o700 });
      writeFileSync(path, "", { mode: 0o700 });
    }
    assert.equal(
      resolveTinyPythonBootstrap(
        { OPEN_WRANGLER_PYTHON: explicit, pythonLocation: hosted },
        { workingDirectory: root }
      ),
      explicit
    );
    assert.equal(resolveTinyPythonBootstrap({ pythonLocation: hosted }, { platform: "linux" }), hostedPosix);
    assert.equal(resolveTinyPythonBootstrap({ pythonLocation: hosted }, { platform: "win32" }), hostedWindows);
    assert.equal(resolveTinyPythonBootstrap({}, { platform: "linux", workingDirectory: root }), localPosix);
    assert.throws(
      () => resolveTinyPythonBootstrap({ pythonLocation: join(root, "missing") }, { platform: "linux" }),
      /existing regular file/u
    );
    assert.throws(
      () => resolveTinyPythonBootstrap({ OPEN_WRANGLER_PYTHON: "relative-python" }),
      /bounded absolute path/u
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function privateRoot(prefix) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  chmodSync(root, 0o700);
  return root;
}

function zeroCapabilityStatus() {
  return [
    `CapInh:\t${"0".repeat(16)}`,
    `CapPrm:\t${"0".repeat(16)}`,
    `CapEff:\t${"0".repeat(16)}`,
    `CapBnd:\t${"0".repeat(16)}`,
    `CapAmb:\t${"0".repeat(16)}`
  ].join("\n");
}

function zeroCapabilities() {
  return {
    inheritable: 0,
    permitted: 0,
    effective: 0,
    bounding: 0,
    ambient: 0
  };
}

function namespaceProbeOutput() {
  return [
    "1: lo: <LOOPBACK> inet 127.0.0.1/8",
    "UID_MAP",
    "1001 0 1",
    "GID_MAP",
    "1001 0 1",
    "CAPABILITIES",
    zeroCapabilityStatus()
  ].join("\n");
}

function createTinyPythonEnvironment(root) {
  const prefix = join(root, "source");
  const bootstrap = resolveTinyPythonBootstrap();
  const created = spawnSync(bootstrap, ["-m", "venv", "--without-pip", "--symlinks", prefix], {
    encoding: "utf8",
    maxBuffer: 64 * 1024
  });
  const creationDiagnostic = [
    created.error?.message,
    created.signal ? `signal=${created.signal}` : undefined,
    created.stderr,
    created.stdout
  ]
    .filter((value) => typeof value === "string" && value.trim().length > 0)
    .join(" ");
  assert.equal(
    created.status,
    0,
    `Could not create the tiny private Python fixture: ${creationDiagnostic || "no subprocess diagnostic"}`
  );
  const executable = join(prefix, "bin", "python");
  const versionResult = spawnSync(
    executable,
    ["-I", "-c", "import sys;print('.'.join(str(part) for part in sys.version_info[:3]))"],
    { encoding: "utf8", maxBuffer: 16 * 1024 }
  );
  assert.equal(versionResult.status, 0, versionResult.stderr);
  const version = versionResult.stdout.trim();
  const majorMinor = version.split(".").slice(0, 2).join(".");
  const sitePackages = join(prefix, "lib", `python${majorMinor}`, "site-packages");
  mkdirSync(sitePackages, { recursive: true, mode: 0o700 });
  for (const name of ["pandas", "polars", "pyarrow"]) {
    writeFileSync(join(sitePackages, `${name}.py`), `__version__ = "1.0.0"\n`, {
      mode: 0o600
    });
  }
  return Object.freeze({ executable, prefix, version });
}

function resolveTinyPythonBootstrap(
  environment = process.env,
  { platform = process.platform, workingDirectory = process.cwd(), inspect = statSync } = {}
) {
  const configured =
    environment.OPEN_WRANGLER_PYTHON ??
    (environment.pythonLocation
      ? join(environment.pythonLocation, platform === "win32" ? "python.exe" : join("bin", "python"))
      : resolve(
          workingDirectory,
          ".venv",
          platform === "win32" ? join("Scripts", "python.exe") : join("bin", "python")
        ));
  if (
    typeof configured !== "string" ||
    !isAbsolute(configured) ||
    resolve(configured) !== configured ||
    configured.length <= 0 ||
    configured.length > 16_384 ||
    /[\0\r\n]/u.test(configured)
  ) {
    throw new Error("A tiny Python fixture bootstrap requires one bounded absolute path.");
  }
  let metadata;
  try {
    metadata = inspect(configured);
  } catch (error) {
    throw new Error("The tiny Python fixture bootstrap is not an existing regular file.", { cause: error });
  }
  if (!metadata.isFile()) {
    throw new Error("The tiny Python fixture bootstrap is not an existing regular file.");
  }
  return configured;
}

function resolveUnitSystemRuntimeDirectories(pythonDirectories) {
  return resolveRemoteWorkspaceSystemRuntimeDirectories(pythonDirectories, {
    validateDirectory: (directory) => directory
  });
}

function dependencyGuardTestEnvironment({ executable, prefix, version }) {
  const executableMetadata = statSync(executable, { bigint: true });
  const rootMetadata = statSync(prefix, { bigint: true });
  return {
    executable,
    executableIdentity: {
      device: String(executableMetadata.dev),
      inode: String(executableMetadata.ino),
      size: String(executableMetadata.size),
      mtimeNs: String(executableMetadata.mtimeNs),
      ctimeNs: String(executableMetadata.ctimeNs)
    },
    packageRoot: prefix,
    packageRootIdentity: {
      device: String(rootMetadata.dev),
      inode: String(rootMetadata.ino)
    },
    pythonVersion: version
  };
}

function dependencyJournalTestReceipt(path) {
  const metadata = lstatSync(path, { bigint: true });
  return {
    mode: metadata.mode,
    uid: metadata.uid,
    gid: metadata.gid,
    entries: readdirSync(path)
      .sort()
      .map((name) => ({
        name,
        contents: readFileSync(join(path, name)),
        mode: lstatSync(join(path, name), { bigint: true }).mode
      }))
  };
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
    python: "/ow/rh/python/bin/openwrangler-python",
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
    [join(root, "rh", "python", "bin", "openwrangler-python"), "#!/bin/sh\n", 0o700],
    [join(root, "rh", "ssh", "config"), "Host ow-loopback\n", 0o600],
    [join(root, "rh", "ssh-runtime", "runtime", "bin", "dropbear"), "#!/bin/sh\n", 0o700],
    [join(root, "rh", "ssh", "host"), "private-key\n", 0o600]
  ]) {
    writeFileSync(path, contents, { mode });
    chmodSync(path, mode);
  }
  return descriptor;
}
