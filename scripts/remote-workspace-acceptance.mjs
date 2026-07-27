import { randomUUID } from "node:crypto";
import {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  writeFileSync
} from "node:fs";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  createEditorAcceptanceEnvironment,
  editorProcessTreeMayBeLive,
  runBoundedEditorCommand
} from "./editor-acceptance.mjs";
import {
  PINNED_REMOTE_VSCODE_COMMIT,
  PINNED_REMOTE_VSCODE_VERSION,
  readBoundedRemoteWorkspaceFile,
  REMOTE_WORKSPACE_AUTHORITY,
  REMOTE_WORKSPACE_INACTIVITY_TIMEOUT_MS,
  REMOTE_WORKSPACE_NAMESPACE_ROOT,
  REMOTE_WORKSPACE_PHASE,
  REMOTE_WORKSPACE_PHASE_TIMEOUT_MS,
  REMOTE_WORKSPACE_PORT,
  REMOTE_WORKSPACE_PROTOCOL,
  validateRemoteSshLogAttestation,
  validateRemoteWorkspacePhaseDescriptor,
  validateRemoteWorkspaceResult
} from "./remote-workspace-contract.mjs";

export {
  readBoundedRemoteWorkspaceFile,
  REMOTE_WORKSPACE_AUTHORITY,
  REMOTE_WORKSPACE_INACTIVITY_TIMEOUT_MS,
  REMOTE_WORKSPACE_NAMESPACE_ROOT,
  REMOTE_WORKSPACE_PHASE,
  REMOTE_WORKSPACE_PHASE_TIMEOUT_MS,
  REMOTE_WORKSPACE_PORT,
  REMOTE_WORKSPACE_PROTOCOL,
  validateRemoteSshLogAttestation,
  validateRemoteWorkspacePhaseDescriptor,
  validateRemoteWorkspaceResult
};
const HOST_COMMAND_OUTPUT_LIMIT_BYTES = 32 * 1024;
const PYTHON_PROBE_OUTPUT_LIMIT_BYTES = 16 * 1024;
const PATH_LIMIT = 16_384;
const REQUIRED_HOST_TOOLS = Object.freeze({
  bash: "/usr/bin/bash",
  bwrap: "/usr/bin/bwrap",
  busybox: "/usr/bin/busybox",
  dpkgDeb: "/usr/bin/dpkg-deb",
  dynamicLoader: "/usr/lib64/ld-linux-x86-64.so.2",
  getconf: "/usr/bin/getconf",
  ip: "/usr/bin/ip",
  ldd: "/usr/bin/ldd",
  ldconfig: "/usr/sbin/ldconfig",
  node: "/usr/bin/node",
  ssh: "/usr/bin/ssh",
  sshKeygen: "/usr/bin/ssh-keygen",
  xkbcomp: "/usr/bin/xkbcomp"
});
// The first entry is a deliberate read-only, root-owned system-library
// closure. Synthesizing thousands of transitive ELF mounts is more brittle
// without providing additional isolation from user data.
const SYSTEM_LIBRARY_CLOSURE_DIRECTORIES = Object.freeze([
  "/usr/lib/x86_64-linux-gnu",
  "/usr/lib/locale",
  "/usr/lib/python3.14",
  "/usr/libexec/glycin-loaders",
  "/usr/share/fontconfig",
  "/usr/share/fonts",
  "/usr/share/glib-2.0",
  "/usr/share/glycin-loaders",
  "/usr/share/icons",
  "/usr/share/mime",
  "/usr/share/nodejs/acorn",
  "/usr/share/nodejs/acorn-walk",
  "/usr/share/nodejs/cjs-module-lexer",
  "/usr/share/nodejs/minimatch",
  "/usr/share/nodejs/undici",
  "/usr/share/X11",
  "/usr/share/xkeyboard-config-2",
  "/usr/share/zoneinfo",
  "/etc/fonts",
  "/etc/ssl/certs"
]);
const BUSYBOX_APPLETS = Object.freeze([
  "awk",
  "basename",
  "cat",
  "chmod",
  "cp",
  "cut",
  "date",
  "dirname",
  "echo",
  "env",
  "find",
  "grep",
  "head",
  "id",
  "kill",
  "ln",
  "ls",
  "mkdir",
  "mktemp",
  "mv",
  "od",
  "printf",
  "ps",
  "pwd",
  "readlink",
  "rm",
  "sed",
  "sh",
  "sleep",
  "sort",
  "tail",
  "tar",
  "tee",
  "test",
  "touch",
  "tr",
  "true",
  "uname",
  "wc",
  "which",
  "xargs"
]);

export function createRemoteWorkspaceCommandRunner(runCommand = runBoundedEditorCommand) {
  let ownershipUncertain = false;
  return Object.freeze({
    async run(command, options) {
      try {
        return await runCommand(command, options);
      } catch (error) {
        if (editorProcessTreeMayBeLive(error)) ownershipUncertain = true;
        throw error;
      }
    },
    ownershipUncertain: () => ownershipUncertain
  });
}

export async function assertRemoteWorkspaceHost(
  {
    platform = process.platform,
    architecture = process.arch,
    tools = REQUIRED_HOST_TOOLS,
    uid = process.getuid?.(),
    gid = process.getgid?.()
  } = {},
  { runCommand = runBoundedEditorCommand } = {}
) {
  if (platform !== "linux" || architecture !== "x64") {
    throw new Error("Real Remote SSH acceptance supports only Linux x64 with official VS Code.");
  }
  if (
    !Number.isSafeInteger(uid) ||
    !Number.isSafeInteger(gid) ||
    uid <= 0 ||
    gid <= 0 ||
    uid > 2_147_483_647 ||
    gid > 2_147_483_647
  ) {
    throw new Error("Remote SSH acceptance requires one non-root invoking user and group.");
  }
  for (const [name, path] of Object.entries(tools)) {
    if (typeof path !== "string" || !isAbsolute(path)) {
      throw new Error(`Remote SSH acceptance requires an absolute ${name} path.`);
    }
    const metadata = lstatSync(path);
    const canonical = realpathSync(path);
    const canonicalMetadata = lstatSync(canonical);
    if (
      (!metadata.isFile() && !metadata.isSymbolicLink()) ||
      !canonicalMetadata.isFile() ||
      canonicalMetadata.isSymbolicLink()
    ) {
      throw new Error(`Remote SSH acceptance requires one regular ${name} executable.`);
    }
  }
  try {
    const probe = await runCommand(
      {
        executable: tools.bwrap,
        args: [
          "--unshare-user",
          "--uid",
          String(uid),
          "--gid",
          String(gid),
          "--unshare-pid",
          "--unshare-net",
          "--die-with-parent",
          "--new-session",
          "--cap-drop",
          "ALL",
          "--tmpfs",
          "/",
          "--dir",
          "/usr",
          "--dir",
          "/usr/bin",
          "--ro-bind",
          tools.busybox,
          "/usr/bin/busybox",
          "--proc",
          "/proc",
          "--dev",
          "/dev",
          "/usr/bin/busybox",
          "sh",
          "-c",
          [
            "/usr/bin/busybox ip address show lo",
            "/usr/bin/busybox echo UID_MAP",
            "/usr/bin/busybox cat /proc/self/uid_map",
            "/usr/bin/busybox echo GID_MAP",
            "/usr/bin/busybox cat /proc/self/gid_map",
            "/usr/bin/busybox echo CAP_EFF",
            "/usr/bin/busybox grep '^CapEff:' /proc/self/status"
          ].join("; ")
        ],
        environment: createEditorAcceptanceEnvironment(),
        label: "Remote SSH bubblewrap and user-namespace preflight"
      },
      { timeoutMs: 15_000, maxOutputBytes: HOST_COMMAND_OUTPUT_LIMIT_BYTES }
    );
    validateRemoteWorkspaceNamespaceProbe(probe.stdout, { uid, gid });
  } catch (error) {
    throw new Error(
      "Remote SSH acceptance requires working bubblewrap user, PID, and network namespaces; no desktop-network fallback is allowed.",
      { cause: error }
    );
  }
  return Object.freeze({ ...tools, uid, gid });
}

export function validateRemoteWorkspaceNamespaceProbe(output, { uid, gid }) {
  if (typeof output !== "string" || Buffer.byteLength(output, "utf8") > HOST_COMMAND_OUTPUT_LIMIT_BYTES) {
    throw new Error("The private namespace preflight returned malformed output.");
  }
  const uidMatch = output.match(/UID_MAP\s+([0-9]+)\s+([0-9]+)\s+([0-9]+)\s+GID_MAP/u);
  const gidMatch = output.match(/GID_MAP\s+([0-9]+)\s+([0-9]+)\s+([0-9]+)\s+CAP_EFF/u);
  const capabilityMatch = output.match(/CAP_EFF\s+CapEff:\s*([0-9a-fA-F]+)/u);
  if (
    !output.includes("127.0.0.1") ||
    !uidMatch ||
    !gidMatch ||
    !capabilityMatch ||
    Number(uidMatch[1]) !== uid ||
    Number(gidMatch[1]) !== gid ||
    uidMatch[3] !== "1" ||
    gidMatch[3] !== "1" ||
    !/^0+$/u.test(capabilityMatch[1])
  ) {
    throw new Error("The private namespace preflight did not prove loopback, one-ID maps, and zero capabilities.");
  }
  return Object.freeze({
    uidMap: uidMatch.slice(1).map(Number),
    gidMap: gidMatch.slice(1).map(Number),
    capabilityEffective: 0
  });
}

export function createRemoteWorkspaceLayout(parent) {
  const root = mkdtempSync(join(assertPrivateParent(parent), "r-"));
  chmodSync(root, 0o700);
  const paths = {
    root,
    client: join(root, "client"),
    localHome: join(root, "lh"),
    userData: join(root, "ud"),
    localExtensions: join(root, "le"),
    remoteHome: join(root, "rh"),
    remoteExtensions: join(root, "rh", ".vscode-server", "extensions"),
    workspace: join(root, "rh", "workspace"),
    accounts: join(root, "rh", "accounts"),
    ssh: join(root, "rh", "ssh"),
    sshRuntime: join(root, "rh", "ssh-runtime"),
    phaseRuntime: join(root, "phase-runtime"),
    remoteTestModule: join(root, "rh", "test-module"),
    logs: join(root, "logs"),
    acceptanceHarness: join(root, "harness"),
    python: join(root, "rh", "python"),
    candidate: join(root, "candidate.vsix"),
    result: join(root, "result.json"),
    progress: join(root, "progress.json"),
    descriptor: join(root, "phase.json")
  };
  for (const path of [
    paths.client,
    paths.localHome,
    paths.userData,
    paths.localExtensions,
    paths.remoteHome,
    paths.remoteExtensions,
    paths.workspace,
    paths.accounts,
    paths.ssh,
    paths.sshRuntime,
    paths.phaseRuntime,
    paths.logs,
    paths.acceptanceHarness
  ]) {
    mkdirSync(path, { recursive: true, mode: 0o700 });
  }
  for (const home of [paths.localHome, paths.remoteHome]) {
    for (const child of ["runtime", "config", "cache", "data", "state", "tmp"]) {
      mkdirSync(join(home, child), { recursive: true, mode: 0o700 });
    }
  }
  return Object.freeze(paths);
}

export async function copyPrivatePythonEnvironment(
  sourcePython,
  destination,
  { copy = cpSync, runCommand = runBoundedEditorCommand } = {}
) {
  const executable = assertAbsoluteRegularFile(sourcePython, "source Python");
  const sourceProbe = await probePython(executable, runCommand);
  const sourcePrefix = assertPrivatePythonPrefix(sourceProbe.prefix, executable);
  if (existsSync(destination)) {
    throw new Error("Remote SSH acceptance refuses to replace a Python environment.");
  }
  copy(sourcePrefix, destination, {
    recursive: true,
    errorOnExist: true,
    force: false,
    preserveTimestamps: true,
    verbatimSymlinks: true
  });
  chmodSync(destination, 0o700);
  const destinationPython = join(destination, "bin", "python");
  const copiedProbe = await probePython(destinationPython, runCommand);
  const sourceVersions = Object.fromEntries(
    Object.entries(sourceProbe.packages).map(([name, entry]) => [name, entry.version])
  );
  const copiedVersions = Object.fromEntries(
    Object.entries(copiedProbe.packages).map(([name, entry]) => [name, entry.version])
  );
  if (
    copiedProbe.prefix !== realpathSync(destination) ||
    copiedProbe.version !== sourceProbe.version ||
    JSON.stringify(copiedVersions) !== JSON.stringify(sourceVersions) ||
    !Object.values(copiedProbe.packages).every(
      (entry) => isContained(realpathSync(destination), realpathSync(entry.path)) || entry.name === "python"
    )
  ) {
    throw new Error("The copied private Python environment did not preserve its exact dependency receipt.");
  }
  return Object.freeze({
    executable: destinationPython,
    version: copiedProbe.version,
    packages: copiedProbe.packages
  });
}

export function createRemoteWorkspaceBwrapArguments({
  root,
  descriptor,
  childScript,
  systemPython,
  uid,
  gid,
  tools = REQUIRED_HOST_TOOLS
}) {
  for (const [label, value] of Object.entries({ root, descriptor, childScript, systemPython })) {
    if (typeof value !== "string" || !isAbsolute(value) || value.length > PATH_LIMIT) {
      throw new Error(`Remote SSH acceptance requires one bounded absolute ${label} path.`);
    }
  }
  if (
    !Number.isSafeInteger(uid) ||
    !Number.isSafeInteger(gid) ||
    uid <= 0 ||
    gid <= 0 ||
    uid > 2_147_483_647 ||
    gid > 2_147_483_647
  ) {
    throw new Error("Remote SSH acceptance requires one bounded non-root namespace identity.");
  }
  const canonicalRoot = realpathSync(root);
  for (const [label, value] of Object.entries({ descriptor, childScript })) {
    const canonical = realpathSync(value);
    if (!isContained(canonicalRoot, canonical)) throw new Error(`The Remote SSH ${label} escaped its private root.`);
    assertAbsoluteRegularFile(canonical, label);
  }
  const canonicalPython = realpathSync(assertAbsoluteRegularFile(systemPython, "system Python executable"));
  if (!canonicalPython.startsWith("/usr/bin/python3.")) {
    throw new Error("Remote SSH acceptance requires one exact system Python 3 executable.");
  }
  for (const directory of SYSTEM_LIBRARY_CLOSURE_DIRECTORIES) {
    validateRootOwnedSystemRuntimeDirectory(directory);
  }
  const args = [
    "--unshare-user",
    "--uid",
    String(uid),
    "--gid",
    String(gid),
    "--unshare-pid",
    "--unshare-net",
    "--unshare-ipc",
    "--unshare-uts",
    "--cap-drop",
    "ALL",
    "--die-with-parent",
    "--new-session",
    "--hostname",
    "openwrangler-remote-acceptance",
    "--tmpfs",
    "/",
    "--dir",
    REMOTE_WORKSPACE_NAMESPACE_ROOT,
    "--bind",
    canonicalRoot,
    REMOTE_WORKSPACE_NAMESPACE_ROOT
  ];
  for (const directory of [
    "/usr",
    "/usr/bin",
    "/usr/lib",
    "/usr/lib64",
    "/usr/libexec",
    "/usr/share",
    "/etc",
    "/etc/ssl",
    "/home",
    "/var",
    "/var/lib",
    "/var/lib/dbus"
  ]) {
    args.push("--dir", directory);
  }
  for (const directory of SYSTEM_LIBRARY_CLOSURE_DIRECTORIES) {
    args.push("--dir", directory, "--ro-bind", directory, directory);
  }
  for (const [source, destination] of [
    [tools.bash, "/usr/bin/bash"],
    [tools.bwrap, "/usr/bin/bwrap"],
    [tools.busybox, "/usr/bin/busybox"],
    [tools.dynamicLoader, "/usr/lib64/ld-linux-x86-64.so.2"],
    [tools.getconf, "/usr/bin/getconf"],
    [tools.ip, "/usr/bin/ip"],
    [tools.ldd, "/usr/bin/ldd"],
    [tools.ldconfig, "/usr/bin/ldconfig"],
    [tools.node, "/usr/bin/node"],
    [tools.ssh, "/usr/bin/ssh"],
    [tools.xkbcomp, "/usr/bin/xkbcomp"],
    [canonicalPython, canonicalPython]
  ]) {
    args.push("--ro-bind", realpathSync(source), destination);
  }
  for (const applet of BUSYBOX_APPLETS) args.push("--symlink", "busybox", `/usr/bin/${applet}`);
  args.push(
    "--symlink",
    "usr/bin",
    "/bin",
    "--symlink",
    "usr/lib",
    "/lib",
    "--symlink",
    "usr/lib64",
    "/lib64",
    "--symlink",
    "usr/bin",
    "/sbin",
    "--symlink",
    basename(canonicalPython),
    "/usr/bin/python3"
  );
  for (const name of [
    "passwd",
    "group",
    "shadow",
    "nsswitch.conf",
    "hosts",
    "resolv.conf",
    "os-release",
    "machine-id"
  ]) {
    args.push("--ro-bind", join(canonicalRoot, "rh", "accounts", name), `/etc/${name}`);
  }
  args.push("--ro-bind", join(canonicalRoot, "rh", "accounts", "machine-id"), "/var/lib/dbus/machine-id");
  args.push("--symlink", `${REMOTE_WORKSPACE_NAMESPACE_ROOT}/rh/accounts/ld.so.cache`, "/etc/ld.so.cache");
  args.push(
    "--tmpfs",
    "/run",
    "--proc",
    "/proc",
    "--dev",
    "/dev",
    "--tmpfs",
    "/tmp",
    "--clearenv",
    "--setenv",
    "PATH",
    "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
    "--setenv",
    "LANG",
    "C.UTF-8",
    "--setenv",
    "HOME",
    `${REMOTE_WORKSPACE_NAMESPACE_ROOT}/lh`,
    "--setenv",
    "USERPROFILE",
    `${REMOTE_WORKSPACE_NAMESPACE_ROOT}/lh`,
    "--setenv",
    "TMPDIR",
    `${REMOTE_WORKSPACE_NAMESPACE_ROOT}/lh/tmp`,
    "--setenv",
    "TMP",
    `${REMOTE_WORKSPACE_NAMESPACE_ROOT}/lh/tmp`,
    "--setenv",
    "TEMP",
    `${REMOTE_WORKSPACE_NAMESPACE_ROOT}/lh/tmp`,
    "--setenv",
    "XDG_RUNTIME_DIR",
    `${REMOTE_WORKSPACE_NAMESPACE_ROOT}/lh/runtime`,
    "--setenv",
    "XDG_CONFIG_HOME",
    `${REMOTE_WORKSPACE_NAMESPACE_ROOT}/lh/config`,
    "--setenv",
    "XDG_CACHE_HOME",
    `${REMOTE_WORKSPACE_NAMESPACE_ROOT}/lh/cache`,
    "--setenv",
    "XDG_DATA_HOME",
    `${REMOTE_WORKSPACE_NAMESPACE_ROOT}/lh/data`,
    "--setenv",
    "XDG_STATE_HOME",
    `${REMOTE_WORKSPACE_NAMESPACE_ROOT}/lh/state`,
    "--",
    "/usr/bin/node",
    namespacePrivatePath(canonicalRoot, childScript),
    namespacePrivatePath(canonicalRoot, descriptor),
    "/usr/bin/ip",
    "/usr/bin/ssh",
    "/usr/lib64/ld-linux-x86-64.so.2",
    "/usr/bin/ldconfig"
  );
  return Object.freeze(args);
}

export function writeRemoteWorkspacePhaseDescriptor(
  path,
  {
    runId = randomUUID(),
    layout,
    editor,
    xvfb,
    testModule,
    python,
    user,
    sshConfig,
    sshServer,
    sshLibraryPath,
    sshHostKey,
    sshAuthorizedKeys,
    hostHome,
    hostSentinel,
    uid,
    gid
  }
) {
  const descriptor = {
    protocol: REMOTE_WORKSPACE_PROTOCOL,
    phase: REMOTE_WORKSPACE_PHASE,
    runId,
    timeoutMs: REMOTE_WORKSPACE_PHASE_TIMEOUT_MS,
    inactivityTimeoutMs: REMOTE_WORKSPACE_INACTIVITY_TIMEOUT_MS,
    authority: REMOTE_WORKSPACE_AUTHORITY,
    version: PINNED_REMOTE_VSCODE_VERSION,
    commit: PINNED_REMOTE_VSCODE_COMMIT,
    hostPidNamespace: readlinkSync("/proc/self/ns/pid"),
    hostNetworkNamespace: readlinkSync("/proc/self/ns/net"),
    hostUserNamespace: readlinkSync("/proc/self/ns/user"),
    editor,
    xvfb,
    displayMode: "xvfb",
    testModule,
    python,
    user,
    sshConfig,
    sshServer,
    sshLibraryPath,
    sshHostKey,
    sshAuthorizedKeys,
    hostHome,
    hostSentinel,
    uid,
    gid,
    paths: {
      root: layout.root,
      workspace: layout.workspace,
      userData: layout.userData,
      localExtensions: layout.localExtensions,
      localHome: layout.localHome,
      remoteHome: layout.remoteHome,
      result: layout.result,
      progress: layout.progress
    }
  };
  validateRemoteWorkspacePhaseDescriptor(descriptor, layout.root, { filesystem: false });
  writeFileSync(path, `${JSON.stringify(descriptor)}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600
  });
  return Object.freeze(descriptor);
}

async function probePython(executable, runCommand) {
  const script = [
    "import importlib,json,os,sys",
    "names=('pandas','polars','pyarrow')",
    "packages={}",
    "for name in names:",
    " m=importlib.import_module(name)",
    " packages[name]={'name':name,'version':str(m.__version__),'path':os.path.realpath(m.__file__)}",
    "packages['python']={'name':'python','version':sys.version.split()[0],'path':os.path.realpath(sys.executable)}",
    "print(json.dumps({'prefix':os.path.realpath(sys.prefix),'version':sys.version.split()[0],'packages':packages},sort_keys=True,separators=(',',':')))"
  ].join("\n");
  const result = await runCommand(
    {
      executable,
      args: ["-I", "-c", script],
      environment: createEditorAcceptanceEnvironment(),
      label: "Remote SSH private Python dependency probe"
    },
    { timeoutMs: 60_000, maxOutputBytes: PYTHON_PROBE_OUTPUT_LIMIT_BYTES }
  );
  const probe = JSON.parse(result.stdout);
  if (
    typeof probe.prefix !== "string" ||
    typeof probe.version !== "string" ||
    !/^3\.(?:1[0-4])\.[0-9]+$/u.test(probe.version) ||
    Object.keys(probe.packages ?? {})
      .sort()
      .join(",") !== "pandas,polars,pyarrow,python"
  ) {
    throw new Error("The Remote SSH private Python dependency probe returned malformed metadata.");
  }
  return probe;
}

function assertPrivatePythonPrefix(prefix, executable) {
  if (typeof prefix !== "string" || !isAbsolute(prefix)) {
    throw new Error("The Remote SSH Python interpreter did not report an absolute environment prefix.");
  }
  const canonicalPrefix = realpathSync(prefix);
  if (!isContained(canonicalPrefix, resolve(executable))) {
    throw new Error("The Remote SSH Python interpreter is not owned by its reported environment.");
  }
  const metadata = lstatSync(canonicalPrefix);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error("The Remote SSH Python environment prefix is not a regular directory.");
  }
  return canonicalPrefix;
}

function assertPrivateParent(path) {
  const resolved = resolve(path);
  const metadata = lstatSync(resolved);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error("Remote SSH acceptance requires one real private parent directory.");
  }
  if ((metadata.mode & 0o777) !== 0o700) {
    throw new Error("Remote SSH acceptance requires a mode-0700 private parent directory.");
  }
  return resolved.endsWith(sep) ? resolved : `${resolved}${sep}`;
}

function assertAbsoluteRegularFile(path, label) {
  if (typeof path !== "string" || !isAbsolute(path) || path.length > PATH_LIMIT) {
    throw new Error(`Remote SSH acceptance requires one bounded absolute ${label} path.`);
  }
  const canonical = realpathSync(path);
  const metadata = lstatSync(canonical);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error(`Remote SSH acceptance requires one regular ${label}.`);
  }
  return resolve(path);
}

export function validateRootOwnedSystemRuntimeDirectory(path, { lstat = lstatSync, realpath = realpathSync } = {}) {
  if (typeof path !== "string" || !isAbsolute(path) || resolve(path) !== path || path.length > PATH_LIMIT) {
    throw new Error("A system runtime closure root is malformed.");
  }
  const metadata = lstat(path);
  const canonical = realpath(path);
  if (
    canonical !== path ||
    !metadata.isDirectory() ||
    metadata.isSymbolicLink() ||
    metadata.uid !== 0 ||
    (metadata.mode & 0o022) !== 0
  ) {
    throw new Error("A system runtime closure root must be canonical, root-owned, and non-writable.");
  }
  return path;
}

function isContained(parent, candidate) {
  const relation = relative(parent, candidate);
  return relation.length > 0 && relation !== ".." && !relation.startsWith(`..${sep}`) && !isAbsolute(relation);
}

function namespacePrivatePath(root, candidate) {
  const canonical = realpathSync(candidate);
  if (!isContained(root, canonical)) {
    throw new Error("A Remote SSH phase path escaped its private namespace root.");
  }
  return join(REMOTE_WORKSPACE_NAMESPACE_ROOT, relative(root, canonical));
}
