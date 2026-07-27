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
import { createEditorAcceptanceEnvironment, runBoundedEditorCommand } from "./editor-acceptance.mjs";
import { PINNED_REMOTE_VSCODE_COMMIT, PINNED_REMOTE_VSCODE_VERSION } from "./remote-workspace-acquisition.mjs";

export const REMOTE_WORKSPACE_PHASE = "remote-workspace";
export const REMOTE_WORKSPACE_AUTHORITY = "ssh-remote+ow-loopback";
export const REMOTE_WORKSPACE_PROTOCOL = 1;
export const REMOTE_WORKSPACE_PHASE_TIMEOUT_MS = 300_000;
export const REMOTE_WORKSPACE_INACTIVITY_TIMEOUT_MS = 180_000;
export const REMOTE_WORKSPACE_PORT = 49_321;
const HOST_COMMAND_OUTPUT_LIMIT_BYTES = 32 * 1024;
const PYTHON_PROBE_OUTPUT_LIMIT_BYTES = 16 * 1024;
const PATH_LIMIT = 16_384;
const REQUIRED_HOST_TOOLS = Object.freeze({
  bwrap: "/usr/bin/bwrap",
  ip: "/usr/sbin/ip",
  ssh: "/usr/bin/ssh",
  sshd: "/usr/sbin/sshd",
  sshKeygen: "/usr/bin/ssh-keygen"
});

export async function assertRemoteWorkspaceHost(
  { platform = process.platform, architecture = process.arch, tools = REQUIRED_HOST_TOOLS } = {},
  { runCommand = runBoundedEditorCommand } = {}
) {
  if (platform !== "linux" || architecture !== "x64") {
    throw new Error("Real Remote SSH acceptance supports only Linux x64 with official VS Code.");
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
          "0",
          "--gid",
          "0",
          "--unshare-pid",
          "--unshare-net",
          "--die-with-parent",
          "--new-session",
          "--ro-bind",
          "/",
          "/",
          "--proc",
          "/proc",
          tools.ip,
          "address",
          "show",
          "lo"
        ],
        environment: createEditorAcceptanceEnvironment(),
        label: "Remote SSH bubblewrap and user-namespace preflight"
      },
      { timeoutMs: 15_000, maxOutputBytes: HOST_COMMAND_OUTPUT_LIMIT_BYTES }
    );
    if (!probe.stdout.includes("127.0.0.1")) {
      throw new Error("The private network namespace did not initialize loopback.");
    }
  } catch (error) {
    throw new Error(
      "Remote SSH acceptance requires working bubblewrap user, PID, and network namespaces; no desktop-network fallback is allowed.",
      { cause: error }
    );
  }
  return Object.freeze({ ...tools });
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
    ssh: join(root, "ssh"),
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
    paths.ssh,
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
  nodeExecutable = process.execPath,
  tools = REQUIRED_HOST_TOOLS
}) {
  for (const [label, value] of Object.entries({ root, descriptor, childScript, nodeExecutable })) {
    if (typeof value !== "string" || !isAbsolute(value) || value.length > PATH_LIMIT) {
      throw new Error(`Remote SSH acceptance requires one bounded absolute ${label} path.`);
    }
  }
  const canonicalRoot = realpathSync(root);
  for (const [label, value] of Object.entries({ descriptor, childScript })) {
    const canonical = realpathSync(value);
    if (label === "descriptor" && !isContained(canonicalRoot, canonical)) {
      throw new Error("The Remote SSH phase descriptor escaped its private root.");
    }
    assertAbsoluteRegularFile(canonical, label);
  }
  assertAbsoluteRegularFile(nodeExecutable, "Node executable");
  return Object.freeze([
    "--unshare-user",
    "--uid",
    "0",
    "--gid",
    "0",
    "--unshare-pid",
    "--unshare-net",
    "--unshare-ipc",
    "--unshare-uts",
    "--die-with-parent",
    "--new-session",
    "--hostname",
    "openwrangler-remote-acceptance",
    "--ro-bind",
    "/",
    "/",
    "--bind",
    canonicalRoot,
    canonicalRoot,
    "--tmpfs",
    "/run/sshd",
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
    join(canonicalRoot, "lh"),
    "--setenv",
    "USERPROFILE",
    join(canonicalRoot, "lh"),
    "--setenv",
    "TMPDIR",
    join(canonicalRoot, "lh", "tmp"),
    "--setenv",
    "TMP",
    join(canonicalRoot, "lh", "tmp"),
    "--setenv",
    "TEMP",
    join(canonicalRoot, "lh", "tmp"),
    "--setenv",
    "XDG_RUNTIME_DIR",
    join(canonicalRoot, "lh", "runtime"),
    "--setenv",
    "XDG_CONFIG_HOME",
    join(canonicalRoot, "lh", "config"),
    "--setenv",
    "XDG_CACHE_HOME",
    join(canonicalRoot, "lh", "cache"),
    "--setenv",
    "XDG_DATA_HOME",
    join(canonicalRoot, "lh", "data"),
    "--setenv",
    "XDG_STATE_HOME",
    join(canonicalRoot, "lh", "state"),
    "--",
    nodeExecutable,
    childScript,
    descriptor,
    tools.ip,
    tools.sshd
  ]);
}

export function writeRemoteWorkspacePhaseDescriptor(
  path,
  { runId = randomUUID(), layout, editor, testModule, python, user, sshConfig, sshdConfig }
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
    editor,
    testModule,
    python,
    user,
    sshConfig,
    sshdConfig,
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
  validateRemoteWorkspacePhaseDescriptor(descriptor, layout.root);
  writeFileSync(path, `${JSON.stringify(descriptor)}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600
  });
  return Object.freeze(descriptor);
}

export function validateRemoteWorkspacePhaseDescriptor(value, privateRoot) {
  if (
    !value ||
    typeof value !== "object" ||
    value.protocol !== REMOTE_WORKSPACE_PROTOCOL ||
    value.phase !== REMOTE_WORKSPACE_PHASE ||
    !/^[0-9a-f-]{36}$/u.test(value.runId) ||
    value.timeoutMs !== REMOTE_WORKSPACE_PHASE_TIMEOUT_MS ||
    value.inactivityTimeoutMs !== REMOTE_WORKSPACE_INACTIVITY_TIMEOUT_MS ||
    value.authority !== REMOTE_WORKSPACE_AUTHORITY ||
    value.version !== PINNED_REMOTE_VSCODE_VERSION ||
    value.commit !== PINNED_REMOTE_VSCODE_COMMIT ||
    !/^pid:\[[0-9]+\]$/u.test(value.hostPidNamespace) ||
    !/^net:\[[0-9]+\]$/u.test(value.hostNetworkNamespace) ||
    typeof value.user !== "string" ||
    !/^[A-Za-z_][A-Za-z0-9_-]{0,63}$/u.test(value.user)
  ) {
    throw new Error("The Remote SSH phase descriptor is malformed.");
  }
  const root = realpathSync(privateRoot);
  for (const candidate of [
    value.editor,
    value.python,
    value.sshConfig,
    value.sshdConfig,
    ...Object.values(value.paths ?? {})
  ]) {
    if (typeof candidate !== "string" || !isAbsolute(candidate) || candidate.length > PATH_LIMIT) {
      throw new Error("The Remote SSH phase descriptor contains an invalid path.");
    }
    if (!isContained(root, resolve(candidate)) && resolve(candidate) !== root) {
      throw new Error("The Remote SSH phase descriptor escaped its private root.");
    }
  }
  assertAbsoluteRegularFile(value.testModule, "remote test module");
  return value;
}

export function validateRemoteSshLogAttestation(text) {
  if (
    typeof text !== "string" ||
    Buffer.byteLength(text, "utf8") <= 0 ||
    Buffer.byteLength(text, "utf8") > 2 * 1024 * 1024 ||
    !text.includes(`Using commit id "${PINNED_REMOTE_VSCODE_COMMIT}" and quality "stable" for server`) ||
    !text.includes("Found existing installation") ||
    !text.includes("didLocalDownload==0==") ||
    text.includes("didLocalDownload==1==") ||
    /Downloading VS Code server|Got request to download on client|vscode-cli-[0-9a-f]{40}\.tar\.gz/u.test(text)
  ) {
    throw new Error("The Remote SSH log did not prove reuse of the exact pre-provisioned offline server chain.");
  }
  return Object.freeze({
    commit: PINNED_REMOTE_VSCODE_COMMIT,
    didLocalDownload: false,
    existingInstallation: true
  });
}

export function validateRemoteWorkspaceResult(contents, { runId }) {
  if (typeof contents !== "string" || Buffer.byteLength(contents, "utf8") > 64 * 1024) {
    throw new Error("The Remote SSH acceptance result is oversized.");
  }
  let result;
  try {
    result = JSON.parse(contents);
  } catch (error) {
    throw new Error("The Remote SSH acceptance result is malformed.", { cause: error });
  }
  if (
    !result ||
    result.protocol !== 1 ||
    result.runId !== runId ||
    result.phase !== REMOTE_WORKSPACE_PHASE ||
    result.ok !== true ||
    Object.keys(result).sort().join(",") !== "ok,phase,protocol,runId"
  ) {
    throw new Error("The Remote SSH acceptance phase did not publish one correlated success result.");
  }
  return result;
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

function isContained(parent, candidate) {
  const relation = relative(parent, candidate);
  return relation.length > 0 && relation !== ".." && !relation.startsWith(`..${sep}`) && !isAbsolute(relation);
}

export function readBoundedRemoteWorkspaceFile(path, maximumBytes) {
  const metadata = lstatSync(path, { bigint: true });
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.nlink !== 1n ||
    metadata.size <= 0n ||
    metadata.size > BigInt(maximumBytes)
  ) {
    throw new Error(`Remote SSH acceptance rejected ${basename(path)} as an unsafe bounded file.`);
  }
  return readFileSync(path, "utf8");
}
