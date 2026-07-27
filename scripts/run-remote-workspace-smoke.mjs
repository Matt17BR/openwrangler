import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  constants,
  copyFileSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createVSIX } from "@vscode/vsce";
import {
  createEditorAcceptanceEnvironment,
  editorProcessTreeMayBeLive,
  runBoundedEditorCommand,
  writeEditorAcceptanceHarness,
  writeEditorSettings
} from "./editor-acceptance.mjs";
import {
  acquirePinnedRemoteWorkspaceArtifacts,
  extractPinnedRemoteTar,
  PINNED_REMOTE_SSH_EXTENSION_ID,
  PINNED_REMOTE_SSH_VERSION,
  PINNED_REMOTE_VSCODE_COMMIT,
  validatePinnedRemoteInstallations
} from "./remote-workspace-acquisition.mjs";
import {
  assertRemoteWorkspaceHost,
  copyPrivatePythonEnvironment,
  createRemoteWorkspaceBwrapArguments,
  createRemoteWorkspaceLayout,
  REMOTE_WORKSPACE_AUTHORITY,
  REMOTE_WORKSPACE_PHASE,
  REMOTE_WORKSPACE_PHASE_TIMEOUT_MS,
  writeRemoteWorkspacePhaseDescriptor
} from "./remote-workspace-acceptance.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const candidatePath = resolve(repositoryRoot, process.argv[2] ?? "openwrangler.vsix");
const childScript = resolve(repositoryRoot, "scripts", "remote-workspace-phase-child.mjs");
const testModule = resolve(repositoryRoot, "dist-test", "test", "extensionHost", "index.js");
const packageJson = JSON.parse(readFileSync(resolve(repositoryRoot, "package.json"), "utf8"));
const expectedCandidate = `${packageJson.publisher}.${packageJson.name}@${packageJson.version}`.toLowerCase();
const expectedHarness = "openwrangler-tests.openwrangler-packaged-test-harness@0.0.0";
const namespaceSshUser = "root";
const setupOutputLimit = 64 * 1024;
let layout;
let rootReceipt;
let namespaceMayBeLive = false;

try {
  assertRegularCandidate(candidatePath);
  const tools = await assertRemoteWorkspaceHost();
  await verifyCandidate(candidatePath);
  const privateParent = preparePrivateParent(resolve(repositoryRoot, "tmp", "remote-workspace"));
  layout = createRemoteWorkspaceLayout(privateParent);
  rootReceipt = captureDirectoryReceipt(layout.root);
  const acquisition = await acquirePinnedRemoteWorkspaceArtifacts(layout.root, {
    artifactPaths: artifactOverrides(process.env)
  });
  const clientRoot = layout.client;
  await extractPinnedRemoteTar(acquisition.artifacts.vscode, clientRoot);

  const remoteServerBase = join(layout.remoteHome, ".vscode-server");
  await extractPinnedRemoteTar(acquisition.artifacts.cli, remoteServerBase);
  const unpackedCli = join(remoteServerBase, "code");
  const committedCli = join(remoteServerBase, `code-${PINNED_REMOTE_VSCODE_COMMIT}`);
  renameSync(unpackedCli, committedCli);
  chmodSync(committedCli, 0o755);

  const serverRoot = join(remoteServerBase, "cli", "servers", `Stable-${PINNED_REMOTE_VSCODE_COMMIT}`, "server");
  mkdirSync(serverRoot, { recursive: true, mode: 0o700 });
  await extractPinnedRemoteTar(acquisition.artifacts.server, serverRoot);
  const installation = await validatePinnedRemoteInstallations({
    clientRoot,
    cliPath: committedCli,
    serverRoot
  });

  stageCandidate(candidatePath, layout.candidate);
  await verifyCandidate(layout.candidate);
  const sourcePython = resolveSourcePython(process.env);
  const python = await copyPrivatePythonEnvironment(sourcePython, layout.python);
  await writeRemoteFixture(layout, python.executable);
  writeWorkspaceSettings(layout, python.executable);

  const harnessVsix = join(layout.root, "harness.vsix");
  writeEditorAcceptanceHarness(layout.acceptanceHarness);
  await createVSIX({
    cwd: layout.acceptanceHarness,
    packagePath: harnessVsix,
    dependencies: false,
    skipLicense: true,
    allowStarActivation: true,
    allowMissingRepository: true
  });
  const runId = randomUUID();
  const ssh = await writeSshConfiguration(layout, runId, python.executable);
  writeLocalEditorSettings(layout, ssh.clientConfig);

  const setupEnvironment = isolatedEnvironment(layout.localHome);
  await runSetupCommand(
    installation.clientCli,
    [
      "--user-data-dir",
      layout.userData,
      "--extensions-dir",
      layout.localExtensions,
      "--install-extension",
      acquisition.artifacts.remoteSsh.path,
      "--force",
      "--do-not-include-pack-dependencies",
      "--no-sandbox",
      "--ozone-platform=headless",
      "--disable-gpu",
      "--disable-updates",
      "--disable-telemetry"
    ],
    setupEnvironment,
    "Pinned Remote SSH local installation"
  );
  const localExtensions = await listExtensions(
    installation.clientCli,
    layout.localExtensions,
    layout.userData,
    setupEnvironment
  );
  if (
    localExtensions.length !== 1 ||
    localExtensions[0] !== `${PINNED_REMOTE_SSH_EXTENSION_ID}@${PINNED_REMOTE_SSH_VERSION}`
  ) {
    throw new Error("The local VS Code profile contains an unexpected extension or optional pack dependency.");
  }

  const remoteEnvironment = isolatedEnvironment(layout.remoteHome);
  for (const vsix of [layout.candidate, harnessVsix]) {
    await runSetupCommand(
      installation.serverExecutable,
      ["--extensions-dir", layout.remoteExtensions, "--install-extension", vsix, "--force"],
      remoteEnvironment,
      "Pinned remote extension installation"
    );
  }
  const remoteExtensions = await listServerExtensions(
    installation.serverExecutable,
    layout.remoteExtensions,
    remoteEnvironment
  );
  if (
    remoteExtensions.length !== 2 ||
    !remoteExtensions.includes(expectedCandidate) ||
    !remoteExtensions.includes(expectedHarness)
  ) {
    throw new Error("The remote extension host profile does not contain exactly the candidate and test harness.");
  }

  await runSetupCommand(
    tools.sshd,
    ["-t", "-f", ssh.serverConfig],
    { PATH: "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin", LANG: "C.UTF-8" },
    "Private SSH daemon configuration validation"
  );
  writeRemoteWorkspacePhaseDescriptor(layout.descriptor, {
    runId,
    layout,
    editor: installation.clientExecutable,
    testModule,
    python: python.executable,
    user: namespaceSshUser,
    sshConfig: ssh.clientConfig,
    sshdConfig: ssh.serverConfig
  });

  const bwrapArguments = createRemoteWorkspaceBwrapArguments({
    root: layout.root,
    descriptor: layout.descriptor,
    childScript,
    tools
  });
  namespaceMayBeLive = true;
  const attestation = await runBoundedEditorCommand(
    {
      executable: tools.bwrap,
      args: bwrapArguments,
      environment: createEditorAcceptanceEnvironment(),
      label: "Official VS Code Remote SSH packaged acceptance"
    },
    {
      timeoutMs: REMOTE_WORKSPACE_PHASE_TIMEOUT_MS,
      maxOutputBytes: setupOutputLimit,
      terminationGraceMs: 5_000,
      killGraceMs: 5_000
    }
  );
  namespaceMayBeLive = false;
  validateNamespaceAttestation(attestation.stdout, runId);
  removePrivateRoot(layout.root, rootReceipt);
  console.log(
    `Open Wrangler Remote SSH acceptance passed with official VS Code ${installation.version} (${installation.commit}).`
  );
} catch (error) {
  if (namespaceMayBeLive && editorProcessTreeMayBeLive(error)) {
    throw new Error(
      "Remote SSH acceptance lost PID-namespace ownership; no private result, logs, profile, or artifact path was inspected or removed."
    );
  }
  namespaceMayBeLive = false;
  if (layout && rootReceipt) {
    try {
      removePrivateRoot(layout.root, rootReceipt);
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        "Remote SSH acceptance and verified private-root cleanup failed."
      );
    }
  }
  throw error;
}

function artifactOverrides(environment) {
  const values = {
    vscode: environment.OPEN_WRANGLER_REMOTE_VSCODE_ARCHIVE,
    cli: environment.OPEN_WRANGLER_REMOTE_CLI_ARCHIVE,
    server: environment.OPEN_WRANGLER_REMOTE_SERVER_ARCHIVE,
    remoteSsh: environment.OPEN_WRANGLER_REMOTE_SSH_VSIX
  };
  return Object.fromEntries(
    Object.entries(values)
      .filter(([, value]) => value !== undefined)
      .map(([key, value]) => [key, resolve(String(value))])
  );
}

function resolveSourcePython(environment) {
  const candidate =
    environment.OPEN_WRANGLER_REMOTE_PYTHON ??
    environment.OPEN_WRANGLER_TEST_PYTHON ??
    resolve(repositoryRoot, ".venv", "bin", "python");
  if (!isAbsolute(candidate)) {
    throw new Error("Remote SSH acceptance requires an absolute pre-provisioned Python environment.");
  }
  return candidate;
}

async function writeRemoteFixture(paths, python) {
  const fixture = join(paths.workspace, "remote.parquet");
  const script = [
    "import polars as pl,sys",
    "pl.DataFrame({'city':['Milan','Rome','Berlin'],'value':[42,7,12]}).write_parquet(sys.argv[1])"
  ].join("\n");
  await runSetupCommand(
    python,
    ["-I", "-c", script, fixture],
    isolatedEnvironment(paths.remoteHome),
    "Remote Parquet fixture creation"
  );
}

function writeWorkspaceSettings(paths, python) {
  const settingsDirectory = join(paths.workspace, ".vscode");
  mkdirSync(settingsDirectory, { mode: 0o700 });
  writeFileSync(
    join(settingsDirectory, "settings.json"),
    `${JSON.stringify(
      {
        "openWrangler.pythonPath": python,
        "openWrangler.defaultBackend": "polars",
        "openWrangler.insightsOnOpen": false
      },
      null,
      2
    )}\n`,
    { encoding: "utf8", flag: "wx", mode: 0o600 }
  );
}

function writeLocalEditorSettings(paths, sshConfig) {
  writeEditorSettings(paths.userData, {
    "remote.SSH.configFile": sshConfig,
    "remote.SSH.path": "/usr/bin/ssh",
    "remote.SSH.remotePlatform": { "ow-loopback": "linux" },
    "remote.SSH.useLocalServer": true,
    "remote.SSH.useExecServer": true,
    "remote.SSH.localServerDownload": "always",
    "remote.SSH.enableDynamicForwarding": true,
    "remote.SSH.showLoginTerminal": false,
    "remote.SSH.loglevel": 3,
    "remote.SSH.maxReconnectionAttempts": 0,
    "telemetry.telemetryLevel": "off",
    "update.mode": "none",
    "extensions.autoUpdate": false,
    "extensions.autoCheckUpdates": false,
    "workbench.enableExperiments": false,
    "workbench.startupEditor": "none",
    "window.restoreWindows": "none",
    "git.enabled": false
  });
}

async function writeSshConfiguration(paths, runId, python) {
  const clientKey = join(paths.ssh, "client");
  const hostKey = join(paths.ssh, "host");
  const keyEnvironment = { PATH: "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin", LANG: "C.UTF-8" };
  await runSetupCommand(
    "/usr/bin/ssh-keygen",
    ["-q", "-t", "ed25519", "-N", "", "-f", clientKey],
    keyEnvironment,
    "Private SSH client-key creation"
  );
  await runSetupCommand(
    "/usr/bin/ssh-keygen",
    ["-q", "-t", "ed25519", "-N", "", "-f", hostKey],
    keyEnvironment,
    "Private SSH host-key creation"
  );
  copyFileSync(`${clientKey}.pub`, join(paths.ssh, "authorized_keys"), constants.COPYFILE_EXCL);
  chmodSync(join(paths.ssh, "authorized_keys"), 0o600);
  const hostPublicKey = readFileSync(`${hostKey}.pub`, "utf8").trim().split(/\s+/u).slice(0, 2).join(" ");
  const knownHosts = join(paths.ssh, "known_hosts");
  writeFileSync(knownHosts, `[127.0.0.1]:49321 ${hostPublicKey}\n`, { mode: 0o600, flag: "wx" });

  const clientConfig = join(paths.ssh, "config");
  writeFileSync(
    clientConfig,
    [
      "Host ow-loopback",
      "  HostName 127.0.0.1",
      "  Port 49321",
      `  User ${namespaceSshUser}`,
      `  IdentityFile ${clientKey}`,
      "  IdentitiesOnly yes",
      "  BatchMode yes",
      "  StrictHostKeyChecking yes",
      `  UserKnownHostsFile ${knownHosts}`,
      "  GlobalKnownHostsFile /dev/null",
      "  PasswordAuthentication no",
      "  KbdInteractiveAuthentication no",
      "  PreferredAuthentications publickey",
      "  ForwardAgent no",
      "  ForwardX11 no",
      "  RequestTTY no",
      "  CanonicalizeHostname no",
      "  ServerAliveInterval 5",
      "  ServerAliveCountMax 2"
    ].join("\n") + "\n",
    { mode: 0o600, flag: "wx" }
  );

  const serverConfig = join(paths.ssh, "sshd_config");
  const remoteEnvironment = {
    HOME: paths.remoteHome,
    USERPROFILE: paths.remoteHome,
    XDG_RUNTIME_DIR: join(paths.remoteHome, "runtime"),
    XDG_CONFIG_HOME: join(paths.remoteHome, "config"),
    XDG_CACHE_HOME: join(paths.remoteHome, "cache"),
    XDG_DATA_HOME: join(paths.remoteHome, "data"),
    XDG_STATE_HOME: join(paths.remoteHome, "state"),
    TMPDIR: join(paths.remoteHome, "tmp"),
    TMP: join(paths.remoteHome, "tmp"),
    TEMP: join(paths.remoteHome, "tmp"),
    OPEN_WRANGLER_EXTENSION_TESTS: "1",
    OPEN_WRANGLER_TEST_PHASE: REMOTE_WORKSPACE_PHASE,
    OPEN_WRANGLER_TEST_EDITOR: "vscode-remote-ssh",
    OPEN_WRANGLER_TEST_PYTHON: python,
    OPEN_WRANGLER_TEST_MODULE: testModule,
    OPEN_WRANGLER_TEST_RESULT: paths.result,
    OPEN_WRANGLER_TEST_PROGRESS: paths.progress,
    OPEN_WRANGLER_TEST_RUN_ID: runId
  };
  writeFileSync(
    serverConfig,
    [
      "Port 49321",
      "ListenAddress 127.0.0.1",
      `HostKey ${hostKey}`,
      `PidFile ${join(paths.ssh, "sshd.pid")}`,
      `AuthorizedKeysFile ${join(paths.ssh, "authorized_keys")}`,
      `AllowUsers ${namespaceSshUser}`,
      "PasswordAuthentication no",
      "KbdInteractiveAuthentication no",
      "ChallengeResponseAuthentication no",
      "UsePAM no",
      "PermitRootLogin prohibit-password",
      "StrictModes no",
      "AllowAgentForwarding no",
      "AllowTcpForwarding yes",
      "AllowStreamLocalForwarding yes",
      "GatewayPorts no",
      "X11Forwarding no",
      "PermitTTY no",
      "PrintMotd no",
      "PrintLastLog no",
      "PermitUserEnvironment no",
      "UseDNS no",
      "LogLevel VERBOSE",
      "Subsystem sftp internal-sftp",
      ...Object.entries(remoteEnvironment).map(([key, value]) => `SetEnv ${key}=${value}`)
    ].join("\n") + "\n",
    { mode: 0o600, flag: "wx" }
  );
  return Object.freeze({ clientConfig, serverConfig });
}

async function listExtensions(cli, extensions, userData, environment) {
  const result = await runSetupCommand(
    cli,
    [
      "--user-data-dir",
      userData,
      "--extensions-dir",
      extensions,
      "--list-extensions",
      "--show-versions",
      "--no-sandbox",
      "--ozone-platform=headless",
      "--disable-gpu"
    ],
    environment,
    "Pinned local extension inventory"
  );
  return result.stdout
    .trim()
    .split("\n")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean)
    .sort();
}

async function listServerExtensions(server, extensions, environment) {
  const result = await runSetupCommand(
    server,
    ["--extensions-dir", extensions, "--list-extensions", "--show-versions"],
    environment,
    "Pinned remote extension inventory"
  );
  return result.stdout
    .trim()
    .split("\n")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean)
    .sort();
}

function isolatedEnvironment(home) {
  return {
    PATH: "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
    LANG: "C.UTF-8",
    HOME: home,
    USERPROFILE: home,
    XDG_RUNTIME_DIR: join(home, "runtime"),
    XDG_CONFIG_HOME: join(home, "config"),
    XDG_CACHE_HOME: join(home, "cache"),
    XDG_DATA_HOME: join(home, "data"),
    XDG_STATE_HOME: join(home, "state"),
    TMPDIR: join(home, "tmp"),
    TMP: join(home, "tmp"),
    TEMP: join(home, "tmp")
  };
}

function runSetupCommand(executable, args, environment, label) {
  return runBoundedEditorCommand(
    { executable, args, environment, label },
    { timeoutMs: 120_000, maxOutputBytes: setupOutputLimit }
  );
}

function stageCandidate(source, destination) {
  const before = immutableCandidateReceipt(source);
  copyFileSync(source, destination, constants.COPYFILE_EXCL);
  chmodSync(destination, 0o600);
  const afterSource = immutableCandidateReceipt(source);
  const copied = immutableCandidateReceipt(destination);
  if (
    before.sha256 !== afterSource.sha256 ||
    before.sha256 !== copied.sha256 ||
    before.size !== copied.size ||
    before.dev !== afterSource.dev ||
    before.ino !== afterSource.ino
  ) {
    throw new Error("The candidate VSIX changed while it was staged for Remote SSH acceptance.");
  }
}

function immutableCandidateReceipt(path) {
  const metadata = lstatSync(path, { bigint: true });
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1n || metadata.size <= 0n) {
    throw new Error("Remote SSH acceptance requires one private regular candidate VSIX.");
  }
  return {
    dev: metadata.dev,
    ino: metadata.ino,
    size: metadata.size,
    sha256: createHash("sha256").update(readFileSync(path)).digest("hex")
  };
}

async function verifyCandidate(path) {
  await runSetupCommand(
    process.execPath,
    [resolve(repositoryRoot, "scripts", "verify-vsix.mjs"), path],
    createEditorAcceptanceEnvironment(),
    "Remote SSH candidate VSIX verification"
  );
}

function assertRegularCandidate(path) {
  if (!isAbsolute(path)) throw new Error("The Remote SSH candidate VSIX must use an absolute path.");
  immutableCandidateReceipt(path);
  immutableCandidateReceipt(testModule);
  immutableCandidateReceipt(childScript);
}

function preparePrivateParent(path) {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const metadata = lstatSync(path);
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || (metadata.mode & 0o777) !== 0o700) {
    throw new Error("Remote SSH acceptance requires one mode-0700 repository-private parent.");
  }
  return path;
}

function captureDirectoryReceipt(path) {
  const metadata = lstatSync(path, { bigint: true });
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error("The Remote SSH private root is unsafe.");
  }
  return Object.freeze({
    canonical: realpathSync(path),
    dev: metadata.dev,
    ino: metadata.ino,
    mode: metadata.mode,
    birthtimeNs: metadata.birthtimeNs
  });
}

function removePrivateRoot(path, receipt) {
  const metadata = lstatSync(path, { bigint: true });
  if (
    !metadata.isDirectory() ||
    metadata.isSymbolicLink() ||
    realpathSync(path) !== receipt.canonical ||
    metadata.dev !== receipt.dev ||
    metadata.ino !== receipt.ino ||
    metadata.mode !== receipt.mode ||
    metadata.birthtimeNs !== receipt.birthtimeNs
  ) {
    throw new Error("The Remote SSH private root changed identity before cleanup.");
  }
  rmSync(path, { recursive: true, force: true });
}

function validateNamespaceAttestation(contents, runId) {
  if (typeof contents !== "string" || Buffer.byteLength(contents, "utf8") > 16 * 1024) {
    throw new Error("The Remote SSH PID-namespace attestation is oversized.");
  }
  const lines = contents.endsWith("\n") ? contents.slice(0, -1).split("\n") : contents.split("\n");
  if (lines.length !== 1) throw new Error("The Remote SSH PID namespace published a malformed attestation.");
  const value = JSON.parse(lines[0]);
  if (
    value?.protocol !== 1 ||
    value.runId !== runId ||
    value.phase !== REMOTE_WORKSPACE_PHASE ||
    value.namespaceEmpty !== true ||
    value.network !== "unshared" ||
    value.remoteAuthority !== REMOTE_WORKSPACE_AUTHORITY ||
    value.version !== "1.130.0" ||
    value.commit !== PINNED_REMOTE_VSCODE_COMMIT ||
    Object.keys(value).sort().join(",") !== "commit,namespaceEmpty,network,phase,protocol,remoteAuthority,runId,version"
  ) {
    throw new Error("The Remote SSH PID namespace did not attest empty owned process and network state.");
  }
}
