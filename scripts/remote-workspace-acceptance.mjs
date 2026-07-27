import { randomUUID } from "node:crypto";
import {
  closeSync,
  chmodSync,
  constants,
  cpSync,
  existsSync,
  fchmodSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readlinkSync,
  realpathSync,
  statSync,
  writeFileSync
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import {
  createEditorAcceptanceEnvironment,
  editorProcessTreeMayBeLive,
  runBoundedEditorCommand
} from "./editor-acceptance.mjs";
import {
  createRemoteWorkspaceHostIsolationDigest,
  PINNED_REMOTE_SSH_BYTES,
  PINNED_REMOTE_SSH_SHA256,
  PINNED_REMOTE_SSH_VERSION,
  PINNED_REMOTE_VSCODE_COMMIT,
  PINNED_REMOTE_VSCODE_VERSION,
  assertRemoteWorkspaceResultLease,
  closeRemoteWorkspaceResultLease,
  openRemoteWorkspaceResultLeaseIfPresent,
  parseRemoteWorkspacePhaseDescriptor,
  readBoundedRemoteWorkspaceFile,
  REMOTE_WORKSPACE_AUTHORITY,
  REMOTE_WORKSPACE_INACTIVITY_TIMEOUT_MS,
  REMOTE_WORKSPACE_MAX_CANDIDATE_BYTES,
  REMOTE_WORKSPACE_NAMESPACE_ROOT,
  REMOTE_WORKSPACE_PHASE,
  REMOTE_WORKSPACE_PHASE_CHILD_PATH,
  REMOTE_WORKSPACE_PHASE_DESCRIPTOR_PATH,
  REMOTE_WORKSPACE_PHASE_NODE_MAXIMUM_BYTES,
  REMOTE_WORKSPACE_PHASE_NODE_PATH,
  REMOTE_WORKSPACE_PHASE_TIMEOUT_MS,
  REMOTE_WORKSPACE_PORT,
  REMOTE_WORKSPACE_PROTOCOL,
  validateRemoteWorkspaceCandidateExpectation,
  validateRemoteWorkspaceCandidatePath,
  validateRemoteWorkspaceBootstrapAttestation,
  validateRemoteWorkspaceNamespaceAttestation,
  validateRemoteWorkspaceZeroCapabilities,
  validateRemoteWorkspacePhaseDescriptorPath,
  validateRemoteSshLogAttestation,
  validateRemoteWorkspacePhaseDescriptor,
  validateRemoteWorkspaceResult
} from "./remote-workspace-contract.mjs";
import { validateRemoteWorkspaceImmutableMounts } from "./remote-workspace-launch.mjs";
import {
  assertRemoteWorkspaceExactFileStage,
  captureRemoteWorkspaceTreeManifest,
  stageRemoteWorkspaceExactFile
} from "./remote-workspace-staging.mjs";

export {
  createRemoteWorkspaceHostIsolationDigest,
  PINNED_REMOTE_SSH_BYTES,
  PINNED_REMOTE_SSH_SHA256,
  PINNED_REMOTE_SSH_VERSION,
  assertRemoteWorkspaceResultLease,
  closeRemoteWorkspaceResultLease,
  openRemoteWorkspaceResultLeaseIfPresent,
  parseRemoteWorkspacePhaseDescriptor,
  readBoundedRemoteWorkspaceFile,
  REMOTE_WORKSPACE_AUTHORITY,
  REMOTE_WORKSPACE_INACTIVITY_TIMEOUT_MS,
  REMOTE_WORKSPACE_MAX_CANDIDATE_BYTES,
  REMOTE_WORKSPACE_NAMESPACE_ROOT,
  REMOTE_WORKSPACE_PHASE,
  REMOTE_WORKSPACE_PHASE_CHILD_PATH,
  REMOTE_WORKSPACE_PHASE_DESCRIPTOR_PATH,
  REMOTE_WORKSPACE_PHASE_NODE_MAXIMUM_BYTES,
  REMOTE_WORKSPACE_PHASE_NODE_PATH,
  REMOTE_WORKSPACE_PHASE_TIMEOUT_MS,
  REMOTE_WORKSPACE_PORT,
  REMOTE_WORKSPACE_PROTOCOL,
  validateRemoteWorkspaceCandidateExpectation,
  validateRemoteWorkspaceCandidatePath,
  validateRemoteWorkspaceBootstrapAttestation,
  validateRemoteWorkspaceNamespaceAttestation,
  validateRemoteWorkspaceZeroCapabilities,
  validateRemoteWorkspacePhaseDescriptorPath,
  validateRemoteSshLogAttestation,
  validateRemoteWorkspacePhaseDescriptor,
  validateRemoteWorkspaceResult
};
const HOST_COMMAND_OUTPUT_LIMIT_BYTES = 32 * 1024;
const PYTHON_PROBE_OUTPUT_LIMIT_BYTES = 16 * 1024;
const DEPENDENCY_GUARD_OUTPUT_LIMIT_BYTES = 4 * 1024;
const PATH_LIMIT = 16_384;
const DEPENDENCY_GUARD_PROTOCOL = "openwrangler-dependency-guard-v1";
const DEPENDENCY_JOURNAL_NAME = ".openwrangler-dependency-journal-v1";
const DEPENDENCY_JOURNAL_LOCK_NAME = "mutation.lock";
const DEPENDENCY_JOURNAL_TEMP_PATTERN =
  /^\.pending-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.tmp$/u;
const DEPENDENCY_JOURNAL_BOUNDS = Object.freeze({
  label: "Remote SSH copied dependency journal",
  maximumFiles: 72,
  maximumBytes: 256 * 1024,
  maximumFileBytes: 65_536
});
const DEFAULT_DEPENDENCY_GUARD_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "python",
  "openwrangler_runtime",
  "dependency_guard.py"
);
const REQUIRED_HOST_TOOLS = Object.freeze({
  bash: "/usr/bin/bash",
  bwrap: "/usr/bin/bwrap",
  busybox: "/usr/bin/busybox",
  dpkgDeb: "/usr/bin/dpkg-deb",
  dynamicLoader: "/usr/lib64/ld-linux-x86-64.so.2",
  getconf: "/usr/bin/getconf",
  ip: "/usr/bin/ip",
  ldd: "/usr/bin/ldd",
  ssh: "/usr/bin/ssh",
  sshKeygen: "/usr/bin/ssh-keygen",
  xkbcomp: "/usr/bin/xkbcomp"
});
// The first entry is a deliberate read-only, root-owned system-library
// closure. Synthesizing thousands of transitive ELF mounts is more brittle
// without providing additional isolation from user data.
const REQUIRED_SYSTEM_RUNTIME_DIRECTORIES = Object.freeze([
  "/usr/lib/x86_64-linux-gnu",
  "/usr/lib/locale",
  "/usr/share/fontconfig",
  "/usr/share/fonts",
  "/usr/share/glib-2.0",
  "/usr/share/icons",
  "/usr/share/mime",
  "/usr/share/X11",
  "/usr/share/zoneinfo",
  "/etc/fonts",
  "/etc/ssl/certs"
]);
const DROPBEAR_SYSTEM_LIBRARY_MOUNTPOINTS = Object.freeze([
  "/usr/lib/x86_64-linux-gnu/libtomcrypt.so.1",
  "/usr/lib/x86_64-linux-gnu/libtommath.so.1"
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
    const help = await runCommand(
      {
        executable: tools.bwrap,
        args: ["--help"],
        environment: createEditorAcceptanceEnvironment(),
        label: "Remote SSH bubblewrap capability preflight"
      },
      { timeoutMs: 15_000, maxOutputBytes: HOST_COMMAND_OUTPUT_LIMIT_BYTES }
    );
    validateRemoteWorkspaceBwrapHelp(help.stdout);
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
            "/usr/bin/busybox echo CAPABILITIES",
            "/usr/bin/busybox grep '^Cap' /proc/self/status"
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

export function validateRemoteWorkspaceBwrapHelp(output) {
  if (
    typeof output !== "string" ||
    Buffer.byteLength(output, "utf8") > HOST_COMMAND_OUTPUT_LIMIT_BYTES ||
    !/^[ \t]+--bind-fd FD DEST[ \t]+Bind open directory or path fd on DEST[ \t]*$/mu.test(output) ||
    !/^[ \t]+--ro-bind-fd FD DEST[ \t]+Bind open directory or path fd read-only on DEST[ \t]*$/mu.test(output) ||
    !/^[ \t]+--perms OCTAL[ \t]+Set permissions of next argument \(--bind-data, --file, etc\.\)[ \t]*$/mu.test(output)
  ) {
    throw new Error(
      "The installed bubblewrap does not expose the required descriptor-bound mount and permissions interface."
    );
  }
  return Object.freeze({ bindFd: true, readOnlyBindFd: true, permissions: true });
}

export function validateRemoteWorkspaceNamespaceProbe(output, { uid, gid }) {
  if (typeof output !== "string" || Buffer.byteLength(output, "utf8") > HOST_COMMAND_OUTPUT_LIMIT_BYTES) {
    throw new Error("The private namespace preflight returned malformed output.");
  }
  const uidMatch = output.match(/UID_MAP\s+([0-9]+)\s+([0-9]+)\s+([0-9]+)\s+GID_MAP/u);
  const gidMatch = output.match(/GID_MAP\s+([0-9]+)\s+([0-9]+)\s+([0-9]+)\s+CAPABILITIES/u);
  let capabilities;
  try {
    capabilities = validateRemoteWorkspaceZeroCapabilities(output);
  } catch (error) {
    throw new Error("The private namespace preflight did not prove all-zero Linux capabilities.", {
      cause: error
    });
  }
  if (
    !output.includes("127.0.0.1") ||
    !uidMatch ||
    !gidMatch ||
    Number(uidMatch[1]) !== uid ||
    Number(gidMatch[1]) !== gid ||
    uidMatch[3] !== "1" ||
    gidMatch[3] !== "1"
  ) {
    throw new Error("The private namespace preflight did not prove loopback, one-ID maps, and zero capabilities.");
  }
  return Object.freeze({
    uidMap: uidMatch.slice(1).map(Number),
    gidMap: gidMatch.slice(1).map(Number),
    capabilities
  });
}

export function createRemoteWorkspaceLayout(parent) {
  const root = mkdtempSync(join(assertPrivateParent(parent), "r-"));
  chmodSync(root, 0o700);
  const paths = {
    root,
    immutable: join(root, "immutable"),
    client: join(root, "immutable", "client"),
    localHome: join(root, "lh"),
    userData: join(root, "ud"),
    localExtensions: join(root, "le"),
    remoteHome: join(root, "rh"),
    remoteServerBase: join(root, "immutable", "vscode-server"),
    remoteExtensions: join(root, "immutable", "remote-extensions"),
    workspace: join(root, "immutable", "workspace"),
    accounts: join(root, "immutable", "accounts"),
    ssh: join(root, "immutable", "ssh"),
    sshRuntime: join(root, "immutable", "ssh-runtime"),
    phaseRuntime: join(root, "phase-runtime"),
    remoteTestModule: join(root, "immutable", "test-module"),
    logs: join(root, "logs"),
    acceptanceHarness: join(root, "harness"),
    python: join(root, "immutable", "python"),
    candidate: join(root, "candidate.vsix"),
    output: join(root, "out"),
    result: join(root, "out", "result.json"),
    progress: join(root, "out", "progress.json"),
    descriptor: join(root, "phase.json")
  };
  for (const path of [
    paths.immutable,
    paths.client,
    paths.localHome,
    paths.userData,
    paths.localExtensions,
    paths.remoteHome,
    paths.remoteServerBase,
    paths.remoteExtensions,
    paths.workspace,
    paths.accounts,
    paths.ssh,
    paths.sshRuntime,
    paths.phaseRuntime,
    paths.logs,
    paths.acceptanceHarness,
    paths.output
  ]) {
    mkdirSync(path, { recursive: true, mode: 0o700 });
  }
  for (const home of [paths.localHome, paths.remoteHome]) {
    for (const child of ["runtime", "config", "cache", "data", "state", "tmp"]) {
      mkdirSync(join(home, child), { recursive: true, mode: 0o700 });
    }
  }
  for (const path of [
    join(paths.remoteHome, ".vscode-server"),
    join(paths.remoteHome, ".vscode-server", "cli", "servers", `Stable-${PINNED_REMOTE_VSCODE_COMMIT}`)
  ]) {
    mkdirSync(path, { recursive: true, mode: 0o700 });
  }
  return Object.freeze(paths);
}

export function createRemoteWorkspaceNamespaceLayout(paths) {
  assertRemoteWorkspacePhysicalLayout(paths);
  return Object.freeze({
    ...paths,
    root: REMOTE_WORKSPACE_NAMESPACE_ROOT,
    immutable: `${REMOTE_WORKSPACE_NAMESPACE_ROOT}/immutable-unreachable`,
    client: `${REMOTE_WORKSPACE_NAMESPACE_ROOT}/client`,
    localHome: `${REMOTE_WORKSPACE_NAMESPACE_ROOT}/lh`,
    userData: `${REMOTE_WORKSPACE_NAMESPACE_ROOT}/ud`,
    localExtensions: `${REMOTE_WORKSPACE_NAMESPACE_ROOT}/le`,
    remoteHome: `${REMOTE_WORKSPACE_NAMESPACE_ROOT}/rh`,
    remoteServerBase: `${REMOTE_WORKSPACE_NAMESPACE_ROOT}/rh/.vscode-server`,
    remoteExtensions: `${REMOTE_WORKSPACE_NAMESPACE_ROOT}/rh/.vscode-server/extensions`,
    workspace: `${REMOTE_WORKSPACE_NAMESPACE_ROOT}/rh/workspace`,
    accounts: `${REMOTE_WORKSPACE_NAMESPACE_ROOT}/rh/accounts`,
    ssh: `${REMOTE_WORKSPACE_NAMESPACE_ROOT}/rh/ssh`,
    sshRuntime: `${REMOTE_WORKSPACE_NAMESPACE_ROOT}/rh/ssh-runtime`,
    phaseRuntime: `${REMOTE_WORKSPACE_NAMESPACE_ROOT}/phase-runtime`,
    remoteTestModule: `${REMOTE_WORKSPACE_NAMESPACE_ROOT}/rh/test-module`,
    logs: `${REMOTE_WORKSPACE_NAMESPACE_ROOT}/logs-unreachable`,
    acceptanceHarness: `${REMOTE_WORKSPACE_NAMESPACE_ROOT}/harness-unreachable`,
    python: `${REMOTE_WORKSPACE_NAMESPACE_ROOT}/rh/python`,
    candidate: `${REMOTE_WORKSPACE_NAMESPACE_ROOT}/candidate-unreachable.vsix`,
    output: `${REMOTE_WORKSPACE_NAMESPACE_ROOT}/out`,
    result: `${REMOTE_WORKSPACE_NAMESPACE_ROOT}/out/result.json`,
    progress: `${REMOTE_WORKSPACE_NAMESPACE_ROOT}/out/progress.json`,
    descriptor: REMOTE_WORKSPACE_PHASE_DESCRIPTOR_PATH
  });
}

export function namespaceRemoteWorkspaceImmutablePath(paths, value) {
  const namespacePaths = createRemoteWorkspaceNamespaceLayout(paths);
  const mappings = [
    "remoteExtensions",
    "remoteTestModule",
    "remoteServerBase",
    "phaseRuntime",
    "sshRuntime",
    "workspace",
    "python",
    "client",
    "ssh",
    "accounts"
  ]
    .map((name) => ({ source: resolve(paths[name]), destination: namespacePaths[name] }))
    .sort((left, right) => right.source.length - left.source.length);
  const candidate = resolve(value);
  for (const mapping of mappings) {
    const relation = relative(mapping.source, candidate);
    if (!relation) return mapping.destination;
    if (relation !== ".." && !relation.startsWith(`..${sep}`) && !isAbsolute(relation)) {
      return join(mapping.destination, relation);
    }
  }
  throw new Error("A Remote SSH runtime path is not part of one phase-visible immutable mount.");
}

export async function copyPrivatePythonEnvironment(
  sourcePython,
  destination,
  {
    copy = cpSync,
    dependencyGuardPath = DEFAULT_DEPENDENCY_GUARD_PATH,
    resolveSystemRuntimeDirectories = resolveRemoteWorkspaceSystemRuntimeDirectories,
    runCommand = runBoundedEditorCommand
  } = {}
) {
  if (process.platform !== "linux") {
    throw new Error("Remote SSH private Python copying is supported only by the Linux acceptance runner.");
  }
  if (typeof resolveSystemRuntimeDirectories !== "function") {
    throw new Error("The Remote SSH copied-Python system-runtime resolver is malformed.");
  }
  const executable = assertAbsoluteRegularFile(sourcePython, "source Python");
  const sourceProbe = await probePython(executable, runCommand);
  const sourcePrefix = assertPrivatePythonPrefix(sourceProbe.prefix, executable);
  const sourceJournal = captureDependencyJournalSnapshot(sourcePrefix);
  const guard = assertAbsoluteRegularFile(dependencyGuardPath, "dependency guard");
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
  assertDependencyJournalSnapshot(sourcePrefix, sourceJournal);
  const copiedJournal = captureDependencyJournalSnapshot(destination, {
    requirePrivateMode: false
  });
  assertCopiedDependencyJournal(sourceJournal, copiedJournal);
  if (copiedJournal.kind === "present") {
    repairCopiedDependencyJournalMode(copiedJournal.path, destination);
    const repairedJournal = captureDependencyJournalSnapshot(destination);
    if (!isDeepStrictEqual(dependencyJournalContents(repairedJournal), dependencyJournalContents(sourceJournal))) {
      throw new Error("The copied dependency journal changed while its private mode was repaired.");
    }
  }
  const destinationPython = join(destination, "bin", "openwrangler-python");
  const launcherStage = stageRemoteWorkspaceExactFile(
    realpathSync(join(destination, "bin", "python")),
    destinationPython,
    0o700
  );
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
  const guardStage = stageRemoteWorkspaceExactFile(
    guard,
    join(destination, ".openwrangler-acceptance-dependency-guard.py"),
    0o600
  );
  const beforeGuard = captureDependencyJournalSnapshot(destination);
  assertDependencyJournalSafeForStatus(beforeGuard);
  let guardResult;
  let guardFailure;
  try {
    guardResult = await runCopiedDependencyGuardStatus({
      dependencyGuardPath: guardStage.stagedPath,
      executable: destinationPython,
      packageRoot: copiedProbe.prefix,
      pythonVersion: copiedProbe.version,
      runCommand
    });
  } catch (error) {
    guardFailure = error;
  }
  let integrityFailure;
  try {
    assertRemoteWorkspaceExactFileStage(launcherStage);
    assertRemoteWorkspaceExactFileStage(guardStage);
    assertDependencyJournalSnapshot(sourcePrefix, sourceJournal);
    const afterGuard = captureDependencyJournalSnapshot(destination);
    assertDependencyGuardPreservedJournal(beforeGuard, afterGuard);
  } catch (error) {
    integrityFailure = error;
  }
  if (guardFailure || integrityFailure) {
    if (guardFailure && integrityFailure) {
      throw new AggregateError(
        [guardFailure, integrityFailure],
        "The copied Python dependency guard failed without preserving every pinned input."
      );
    }
    throw guardFailure ?? integrityFailure;
  }
  if (
    guardResult.stderr !== "" ||
    guardResult.stdout !== `{"kind":"status","protocol":"${DEPENDENCY_GUARD_PROTOCOL}","state":"clean","token":null}\n`
  ) {
    throw new Error("The copied Python dependency guard did not report one exact clean status.");
  }
  const pythonSystemRuntimeDirectories = Object.freeze(
    sourceProbe.systemRuntimeDirectories.filter(
      (directory) => directory !== sourcePrefix && !isContained(sourcePrefix, directory)
    )
  );
  const expectedSystemRuntimeDirectories = [...REQUIRED_SYSTEM_RUNTIME_DIRECTORIES, ...pythonSystemRuntimeDirectories];
  const resolvedSystemRuntimeDirectories = resolveSystemRuntimeDirectories(pythonSystemRuntimeDirectories);
  if (!isDeepStrictEqual(resolvedSystemRuntimeDirectories, expectedSystemRuntimeDirectories)) {
    throw new Error("The Remote SSH copied-Python system-runtime resolver altered its exact required closure.");
  }
  assertRemoteWorkspaceExactFileStage(launcherStage);
  const systemRuntimeDirectories = Object.freeze([...resolvedSystemRuntimeDirectories]);
  return Object.freeze({
    executable: destinationPython,
    version: copiedProbe.version,
    packages: copiedProbe.packages,
    systemRuntimeDirectories
  });
}

export async function runCopiedDependencyGuardStatus({
  dependencyGuardPath = DEFAULT_DEPENDENCY_GUARD_PATH,
  executable,
  packageRoot,
  pythonVersion,
  runCommand = runBoundedEditorCommand
}) {
  const guard = assertAbsoluteRegularFile(dependencyGuardPath, "dependency guard");
  const python = assertAbsoluteRegularFile(executable, "copied Python");
  const root = realpathSync(packageRoot);
  const rootMetadata = statSync(root, { bigint: true });
  const executableMetadata = statSync(python, { bigint: true });
  if (
    !rootMetadata.isDirectory() ||
    !executableMetadata.isFile() ||
    typeof pythonVersion !== "string" ||
    !/^3\.(?:1[0-4])\.[0-9]+$/u.test(pythonVersion)
  ) {
    throw new Error("The copied Python dependency-guard environment is malformed.");
  }
  const frame = Buffer.from(
    `${JSON.stringify({
      protocol: DEPENDENCY_GUARD_PROTOCOL,
      kind: "status",
      environment: {
        executable: python,
        executableIdentity: dependencyGuardExecutableIdentity(executableMetadata),
        packageRoot: root,
        packageRootIdentity: dependencyGuardRootIdentity(rootMetadata),
        pythonVersion
      }
    })}\n`,
    "utf8"
  );
  if (frame.length > 65_536) {
    throw new Error("The copied Python dependency-guard request exceeded its fixed frame bound.");
  }
  return runCommand(
    {
      executable: python,
      args: ["-I", guard, "status"],
      environment: createEditorAcceptanceEnvironment(),
      input: frame,
      label: "Remote SSH copied Python dependency status"
    },
    {
      timeoutMs: 60_000,
      maxOutputBytes: DEPENDENCY_GUARD_OUTPUT_LIMIT_BYTES
    }
  );
}

function captureDependencyJournalSnapshot(prefix, { requirePrivateMode = true } = {}) {
  const canonicalPrefix = realpathSync(prefix);
  const prefixBefore = dependencyJournalDirectoryReceipt(canonicalPrefix);
  const path = join(canonicalPrefix, DEPENDENCY_JOURNAL_NAME);
  let metadata;
  try {
    metadata = lstatSync(path, { bigint: true });
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    const prefixAfter = dependencyJournalDirectoryReceipt(canonicalPrefix);
    if (!isDeepStrictEqual(prefixBefore, prefixAfter)) {
      throw new Error("The Python environment changed while its dependency journal absence was captured.");
    }
    try {
      lstatSync(path);
    } catch (secondError) {
      if (secondError?.code === "ENOENT") {
        return Object.freeze({
          kind: "absent",
          path,
          prefixReceipt: prefixAfter
        });
      }
      throw secondError;
    }
    throw new Error("The Python dependency journal appeared while its absence was captured.");
  }
  if (
    realpathSync(path) !== path ||
    !metadata.isDirectory() ||
    metadata.isSymbolicLink() ||
    metadata.uid !== prefixBefore.uid ||
    metadata.gid !== prefixBefore.gid ||
    (requirePrivateMode && Number(metadata.mode & 0o777n) !== 0o700)
  ) {
    throw new Error("The Python dependency journal must be canonical, owner-matched, and mode 0700.");
  }
  const manifest = captureRemoteWorkspaceTreeManifest(path, DEPENDENCY_JOURNAL_BOUNDS);
  const prefixAfter = dependencyJournalDirectoryReceipt(canonicalPrefix);
  if (!isDeepStrictEqual(prefixBefore, prefixAfter)) {
    throw new Error("The Python environment changed while its dependency journal was captured.");
  }
  return Object.freeze({
    kind: "present",
    path,
    prefixReceipt: prefixAfter,
    manifest
  });
}

function assertDependencyJournalSnapshot(prefix, expected) {
  const observed = captureDependencyJournalSnapshot(prefix);
  if (!isDeepStrictEqual(observed, expected)) {
    throw new Error("The source Python dependency journal changed while its environment was copied.");
  }
  return observed;
}

function assertCopiedDependencyJournal(source, copied) {
  if (
    source.kind !== copied.kind ||
    !isDeepStrictEqual(dependencyJournalContents(source), dependencyJournalContents(copied))
  ) {
    throw new Error("The copied Python environment did not preserve every dependency-journal leaf.");
  }
}

function dependencyJournalContents(snapshot) {
  if (snapshot.kind === "absent") return Object.freeze({ kind: "absent" });
  return Object.freeze({
    kind: "present",
    directories: Object.freeze(snapshot.manifest.directories.map((entry) => entry.path)),
    files: Object.freeze(
      snapshot.manifest.files.map((entry) =>
        Object.freeze({
          path: entry.path,
          mode: Number(entry.receipt.mode & 0o777n),
          size: entry.receipt.size,
          sha256: entry.receipt.sha256
        })
      )
    ),
    links: Object.freeze(
      snapshot.manifest.links.map((entry) =>
        Object.freeze({
          path: entry.path,
          target: entry.target,
          resolvedTarget: entry.resolvedTarget
        })
      )
    )
  });
}

function repairCopiedDependencyJournalMode(path, prefix) {
  const prefixReceipt = dependencyJournalDirectoryReceipt(realpathSync(prefix));
  let descriptor;
  try {
    descriptor = openSync(
      path,
      constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0) | (constants.O_CLOEXEC ?? 0)
    );
    const opened = fstatSync(descriptor, { bigint: true });
    const namedBefore = lstatSync(path, { bigint: true });
    if (
      !opened.isDirectory() ||
      opened.isSymbolicLink() ||
      !sameDependencyJournalDirectory(opened, namedBefore) ||
      opened.uid !== prefixReceipt.uid ||
      opened.gid !== prefixReceipt.gid ||
      realpathSync(path) !== path
    ) {
      throw new Error("The copied dependency-journal directory changed before its mode repair.");
    }
    fchmodSync(descriptor, 0o700);
    const repaired = fstatSync(descriptor, { bigint: true });
    const namedAfter = lstatSync(path, { bigint: true });
    if (
      !sameDependencyJournalDirectory(opened, repaired, { ignoreModeAndCtime: true }) ||
      !sameDependencyJournalDirectory(repaired, namedAfter) ||
      Number(repaired.mode & 0o777n) !== 0o700 ||
      realpathSync(path) !== path
    ) {
      throw new Error("The copied dependency-journal directory changed during its mode repair.");
    }
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function assertDependencyJournalSafeForStatus(snapshot) {
  if (snapshot.kind === "absent") return;
  if (
    snapshot.manifest.links.length !== 0 ||
    snapshot.manifest.directories.length !== 1 ||
    snapshot.manifest.directories[0]?.path !== "." ||
    snapshot.manifest.files.some((entry) => DEPENDENCY_JOURNAL_TEMP_PATTERN.test(entry.path))
  ) {
    throw new Error("The copied dependency journal contains recoverable or nested state; it will not be modified.");
  }
}

function assertDependencyGuardPreservedJournal(before, after) {
  if (before.kind === "absent") {
    assertDependencyGuardCreatedOnlyLock(after);
    return;
  }
  if (after.kind !== "present") {
    throw new Error("The copied dependency guard removed its journal.");
  }
  const afterFiles = new Map(after.manifest.files.map((entry) => [entry.path, entry]));
  for (const entry of before.manifest.files) {
    const current = afterFiles.get(entry.path);
    if (!current || !isDeepStrictEqual(current.receipt, entry.receipt)) {
      throw new Error("The copied dependency guard changed a retained journal leaf.");
    }
    afterFiles.delete(entry.path);
  }
  if (afterFiles.size === 0) {
    if (!isDeepStrictEqual(before.manifest, after.manifest)) {
      throw new Error("The copied dependency guard changed journal metadata.");
    }
    return;
  }
  if (
    afterFiles.size !== 1 ||
    before.manifest.files.some((entry) => entry.path === DEPENDENCY_JOURNAL_LOCK_NAME) ||
    !afterFiles.has(DEPENDENCY_JOURNAL_LOCK_NAME)
  ) {
    throw new Error("The copied dependency guard added an unexpected journal leaf.");
  }
  assertDependencyGuardLock(afterFiles.get(DEPENDENCY_JOURNAL_LOCK_NAME), after);
}

function assertDependencyGuardCreatedOnlyLock(snapshot) {
  if (
    snapshot.kind !== "present" ||
    snapshot.manifest.directories.length !== 1 ||
    snapshot.manifest.directories[0]?.path !== "." ||
    snapshot.manifest.links.length !== 0 ||
    snapshot.manifest.files.length !== 1 ||
    snapshot.manifest.files[0]?.path !== DEPENDENCY_JOURNAL_LOCK_NAME
  ) {
    throw new Error("The copied dependency guard created more than its private journal lock.");
  }
  assertDependencyGuardLock(snapshot.manifest.files[0], snapshot);
}

function assertDependencyGuardLock(entry, snapshot) {
  const rootReceipt = snapshot.manifest.directories[0]?.receipt;
  if (
    entry.receipt.size !== 0n ||
    Number(entry.receipt.mode & 0o777n) !== 0o600 ||
    entry.receipt.nlink !== 1n ||
    entry.receipt.uid !== rootReceipt?.uid ||
    entry.receipt.gid !== rootReceipt?.gid ||
    Number(rootReceipt.mode & 0o777n) !== 0o700
  ) {
    throw new Error("The copied dependency guard did not create one exact private lock.");
  }
}

function dependencyJournalDirectoryReceipt(path) {
  const metadata = lstatSync(path, { bigint: true });
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || realpathSync(path) !== path) {
    throw new Error("A Python dependency-journal parent is not one canonical directory.");
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

function sameDependencyJournalDirectory(left, right, { ignoreModeAndCtime = false } = {}) {
  return (
    left.isDirectory() &&
    right.isDirectory() &&
    !left.isSymbolicLink() &&
    !right.isSymbolicLink() &&
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.nlink === right.nlink &&
    left.uid === right.uid &&
    left.gid === right.gid &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.birthtimeNs === right.birthtimeNs &&
    (ignoreModeAndCtime || (left.mode === right.mode && left.ctimeNs === right.ctimeNs))
  );
}

function dependencyGuardExecutableIdentity(metadata) {
  return Object.freeze({
    device: String(metadata.dev),
    inode: String(metadata.ino),
    size: String(metadata.size),
    mtimeNs: String(metadata.mtimeNs),
    ctimeNs: String(metadata.ctimeNs)
  });
}

function dependencyGuardRootIdentity(metadata) {
  return Object.freeze({
    device: String(metadata.dev),
    inode: String(metadata.ino)
  });
}

function assertRemoteWorkspacePhysicalLayout(paths) {
  const root = typeof paths?.root === "string" ? realpathSync(paths.root) : undefined;
  const immutable = typeof paths?.immutable === "string" ? realpathSync(paths.immutable) : undefined;
  if (
    !paths ||
    typeof paths !== "object" ||
    root === undefined ||
    immutable === undefined ||
    !isContained(root, immutable)
  ) {
    throw new Error("The Remote SSH physical layout is malformed.");
  }
  for (const name of [
    "client",
    "remoteServerBase",
    "remoteExtensions",
    "workspace",
    "accounts",
    "ssh",
    "sshRuntime",
    "remoteTestModule",
    "python"
  ]) {
    if (typeof paths[name] !== "string" || !isContained(immutable, resolve(paths[name]))) {
      throw new Error("A Remote SSH immutable physical input escaped its setup-only root.");
    }
  }
  if (typeof paths.remoteHome !== "string" || isContained(realpathSync(paths.remoteHome), immutable)) {
    throw new Error("The Remote SSH mutable home contains its physical immutable-input root.");
  }
}

export function createRemoteWorkspaceBwrapArguments(
  {
    root,
    descriptor,
    childScript,
    systemPython,
    systemRuntimeDirectories,
    immutableMounts,
    uid,
    gid,
    bootstrapPreflight = false,
    tools = REQUIRED_HOST_TOOLS
  },
  {
    validateSystemRuntimeDirectory = validateRootOwnedSystemRuntimeDirectory,
    validateDropbearLibraryMountpoint = validateRootOwnedDropbearLibraryMountpoint
  } = {}
) {
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
  if (typeof bootstrapPreflight !== "boolean") {
    throw new Error("Remote SSH acceptance requires one explicit bootstrap-preflight policy.");
  }
  const canonicalRoot = realpathSync(root);
  for (const [label, value] of Object.entries({ descriptor, childScript })) {
    const canonical = realpathSync(value);
    if (!isContained(canonicalRoot, canonical)) throw new Error(`The Remote SSH ${label} escaped its private root.`);
    assertAbsoluteRegularFile(canonical, label);
  }
  if (namespacePrivatePath(canonicalRoot, childScript) !== REMOTE_WORKSPACE_PHASE_CHILD_PATH) {
    throw new Error("The Remote SSH phase child does not use its exact fixed private path.");
  }
  const canonicalPython = realpathSync(assertAbsoluteRegularFile(systemPython, "system Python executable"));
  // Production resolves and probes the exact system Python before entering
  // this pure argument builder. Keeping this function path-agnostic lets its
  // structural contract run on CI images with different installed minors.
  const runtimeDirectories = validateRemoteWorkspaceSystemRuntimeDirectories(systemRuntimeDirectories, {
    validateDirectory: validateSystemRuntimeDirectory
  });
  if (typeof validateDropbearLibraryMountpoint !== "function") {
    throw new Error("The Remote SSH Dropbear library-mountpoint validator is malformed.");
  }
  for (const mountpoint of DROPBEAR_SYSTEM_LIBRARY_MOUNTPOINTS) {
    if (validateDropbearLibraryMountpoint(mountpoint) !== mountpoint) {
      throw new Error("The Remote SSH Dropbear library-mountpoint validator altered its exact target.");
    }
  }
  const mounts = validateRemoteWorkspaceImmutableMounts(immutableMounts, {
    commit: PINNED_REMOTE_VSCODE_COMMIT
  });
  const privateMounts = mounts.filter((mount) => mount.destination.startsWith(`${REMOTE_WORKSPACE_NAMESPACE_ROOT}/`));
  const dropbearLibraryMounts = mounts.filter((mount) =>
    ["/usr/lib/x86_64-linux-gnu/libtomcrypt.so.1", "/usr/lib/x86_64-linux-gnu/libtommath.so.1"].includes(
      mount.destination
    )
  );
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
    "--perms",
    "0700",
    "--dir",
    REMOTE_WORKSPACE_NAMESPACE_ROOT
  ];
  for (const mount of privateMounts) {
    args.push(mount.access === "mutable" ? "--bind-fd" : "--ro-bind-fd", String(mount.descriptor), mount.destination);
  }
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
  for (const directory of runtimeDirectories) {
    args.push("--dir", directory, "--ro-bind", directory, directory);
  }
  for (const mount of dropbearLibraryMounts) {
    args.push("--ro-bind-fd", String(mount.descriptor), mount.destination);
  }
  for (const [source, destination] of [
    [tools.bash, "/usr/bin/bash"],
    [tools.bwrap, "/usr/bin/bwrap"],
    [tools.busybox, "/usr/bin/busybox"],
    [tools.dynamicLoader, "/usr/lib64/ld-linux-x86-64.so.2"],
    [tools.getconf, "/usr/bin/getconf"],
    [tools.ip, "/usr/bin/ip"],
    [tools.ldd, "/usr/bin/ldd"],
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
    args.push("--symlink", `${REMOTE_WORKSPACE_NAMESPACE_ROOT}/rh/accounts/${name}`, `/etc/${name}`);
  }
  args.push("--symlink", `${REMOTE_WORKSPACE_NAMESPACE_ROOT}/rh/accounts/machine-id`, "/var/lib/dbus/machine-id");
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
    REMOTE_WORKSPACE_PHASE_NODE_PATH,
    REMOTE_WORKSPACE_PHASE_CHILD_PATH,
    REMOTE_WORKSPACE_PHASE_DESCRIPTOR_PATH,
    "/usr/bin/ip",
    "/usr/bin/ssh",
    "/usr/lib64/ld-linux-x86-64.so.2",
    ...(bootstrapPreflight ? ["--bootstrap-preflight"] : [])
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
    gid,
    candidateReceipt,
    remoteSshReceipt
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
    candidateSha256: candidateReceipt?.sha256,
    candidateBytes: candidateReceipt?.bytes,
    remoteSshVersion: remoteSshReceipt?.version,
    remoteSshBytes: remoteSshReceipt?.bytes,
    remoteSshSha256: remoteSshReceipt?.sha256,
    hostPidNamespace: readlinkSync("/proc/self/ns/pid"),
    hostNetworkNamespace: readlinkSync("/proc/self/ns/net"),
    hostIpcNamespace: readlinkSync("/proc/self/ns/ipc"),
    hostUtsNamespace: readlinkSync("/proc/self/ns/uts"),
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
    hostIsolationSha256: createRemoteWorkspaceHostIsolationDigest(hostHome, hostSentinel),
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
  validateRemoteWorkspacePhaseDescriptor(descriptor, { filesystem: false });
  writeFileSync(path, `${JSON.stringify(descriptor)}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600
  });
  return Object.freeze(descriptor);
}

async function probePython(executable, runCommand) {
  const script = [
    "import importlib,json,os,sys,sysconfig",
    "names=('pandas','polars','pyarrow')",
    "packages={}",
    "for name in names:",
    " m=importlib.import_module(name)",
    " packages[name]={'name':name,'version':str(m.__version__),'path':os.path.realpath(m.__file__)}",
    "packages['python']={'name':'python','version':sys.version.split()[0],'path':os.path.realpath(sys.executable)}",
    "runtime=sorted({os.path.realpath(p) for p in (sysconfig.get_path('stdlib'),sysconfig.get_path('platstdlib')) if p})",
    "print(json.dumps({'prefix':os.path.realpath(sys.prefix),'version':sys.version.split()[0],'packages':packages,'systemRuntimeDirectories':runtime},sort_keys=True,separators=(',',':')))"
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
    !Array.isArray(probe.systemRuntimeDirectories) ||
    probe.systemRuntimeDirectories.length <= 0 ||
    !probe.systemRuntimeDirectories.every((path) => typeof path === "string" && isAbsolute(path)) ||
    Object.keys(probe.packages ?? {})
      .sort()
      .join(",") !== "pandas,polars,pyarrow,python"
  ) {
    throw new Error("The Remote SSH private Python dependency probe returned malformed metadata.");
  }
  return probe;
}

export function resolveRemoteWorkspaceSystemRuntimeDirectories(
  pythonDirectories,
  { validateDirectory = validateRootOwnedSystemRuntimeDirectory } = {}
) {
  if (
    !Array.isArray(pythonDirectories) ||
    pythonDirectories.length <= 0 ||
    pythonDirectories.length > 8 ||
    !pythonDirectories.every((path) => typeof path === "string" && isAbsolute(path))
  ) {
    throw new Error("The Remote SSH Python probe did not provide one explicit system-runtime closure.");
  }
  return validateRemoteWorkspaceSystemRuntimeDirectories(
    [...REQUIRED_SYSTEM_RUNTIME_DIRECTORIES, ...pythonDirectories],
    { validateDirectory }
  );
}

export function validateRemoteWorkspaceSystemRuntimeDirectories(
  directories,
  { validateDirectory = validateRootOwnedSystemRuntimeDirectory } = {}
) {
  if (
    !Array.isArray(directories) ||
    directories.length <= 0 ||
    directories.length > 64 ||
    new Set(directories).size !== directories.length
  ) {
    throw new Error("Remote SSH acceptance requires one explicit unique system-runtime closure.");
  }
  if (typeof validateDirectory !== "function") {
    throw new Error("The Remote SSH system-runtime closure validator is malformed.");
  }
  const validated = directories.map((directory, index) => {
    try {
      return validateDirectory(directory);
    } catch (error) {
      throw new Error(
        `Remote SSH system-runtime closure root ${index + 1} of ${directories.length} is unavailable or unsafe.`,
        { cause: error }
      );
    }
  });
  return Object.freeze(validated);
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
  for (let current = path; ; current = dirname(current)) {
    const metadata = lstat(current);
    const canonical = realpath(current);
    if (
      canonical !== current ||
      !metadata.isDirectory() ||
      metadata.isSymbolicLink() ||
      metadata.uid !== 0 ||
      (metadata.mode & 0o022) !== 0
    ) {
      throw new Error(
        "A system runtime closure root and every ancestor must be canonical, root-owned, and non-writable."
      );
    }
    if (dirname(current) === current) break;
  }
  return path;
}

export function validateRootOwnedDropbearLibraryMountpoint(
  path,
  { lstat = lstatSync, readlink = readlinkSync, realpath = realpathSync } = {}
) {
  const root = "/usr/lib/x86_64-linux-gnu";
  if (
    !DROPBEAR_SYSTEM_LIBRARY_MOUNTPOINTS.includes(path) ||
    typeof lstat !== "function" ||
    typeof readlink !== "function" ||
    typeof realpath !== "function"
  ) {
    throw new Error("A Dropbear system-library mountpoint is malformed.");
  }
  const leaf = lstat(path);
  if ((!leaf.isFile() && !leaf.isSymbolicLink()) || leaf.uid !== 0) {
    throw new Error("A Dropbear system-library mountpoint is not root-controlled.");
  }
  let expectedCanonical = path;
  if (leaf.isSymbolicLink()) {
    const target = readlink(path);
    const resolvedTarget = typeof target === "string" ? resolve(dirname(path), target) : "";
    if (
      typeof target !== "string" ||
      target.length === 0 ||
      target.length > PATH_LIMIT ||
      isAbsolute(target) ||
      target === "." ||
      target === ".." ||
      target !== basename(target) ||
      dirname(resolvedTarget) !== root
    ) {
      throw new Error("A Dropbear system-library mountpoint symlink is not one direct multiarch child.");
    }
    expectedCanonical = resolvedTarget;
  }
  const canonical = realpath(path);
  const target = lstat(canonical);
  if (
    canonical !== expectedCanonical ||
    !isContained(root, canonical) ||
    !target.isFile() ||
    target.isSymbolicLink() ||
    target.uid !== 0 ||
    (target.mode & 0o022) !== 0
  ) {
    throw new Error("A Dropbear system-library mountpoint target is unsafe.");
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
