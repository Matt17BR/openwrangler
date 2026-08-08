import { randomUUID } from "node:crypto";
import {
  chmodSync,
  constants,
  copyFileSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  writeFileSync
} from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createVSIX } from "@vscode/vsce";
import {
  createEditorAcceptanceEnvironment,
  editorProcessTreeMayBeLive,
  writeEditorAcceptanceHarness,
  writeEditorSettings
} from "./editor-acceptance.mjs";
import {
  acquirePinnedRemoteWorkspaceArtifacts,
  assertPinnedRemoteArtifactReceipt,
  extractPinnedDropbearRuntime,
  extractPinnedRemoteTar,
  PINNED_REMOTE_SSH_EXTENSION_ID,
  PINNED_REMOTE_SSH_BYTES,
  PINNED_REMOTE_SSH_SHA256,
  PINNED_REMOTE_SSH_VERSION,
  PINNED_REMOTE_VSCODE_COMMIT,
  validatePinnedRemoteInstallations,
  validateRemoteSshVsix
} from "./remote-workspace-acquisition.mjs";
import {
  assertRemoteWorkspaceHost,
  copyPrivatePythonEnvironment,
  createRemoteWorkspaceHostIsolationDigest,
  createRemoteWorkspaceBwrapArguments,
  createRemoteWorkspaceCommandRunner,
  createRemoteWorkspaceLayout,
  createRemoteWorkspaceNamespaceLayout,
  namespaceRemoteWorkspaceImmutablePath,
  REMOTE_WORKSPACE_PHASE_NODE_MAXIMUM_BYTES,
  REMOTE_WORKSPACE_PHASE_TIMEOUT_MS,
  validateRemoteWorkspaceBootstrapAttestation,
  validateRemoteWorkspaceCandidateExpectation,
  validateRemoteWorkspaceCandidatePath,
  writeRemoteWorkspacePhaseDescriptor
} from "./remote-workspace-acceptance.mjs";
import { redactEditorAcceptanceText } from "./editor-acceptance-evidence.mjs";
import {
  acceptRemoteWorkspaceCandidate,
  assertRemoteWorkspaceCandidateReceipt,
  assertRemoteWorkspaceFileReceipt,
  captureRemoteWorkspaceFileReceipt,
  stageRemoteWorkspaceCandidate
} from "./remote-workspace-provenance.mjs";
import {
  assertRemoteWorkspaceImmutableInputRegistry,
  createRemoteWorkspaceImmutableInputRegistry,
  openRemoteWorkspaceImmutableInputLeases
} from "./remote-workspace-launch.mjs";
import {
  assertRemoteWorkspaceExactFileStage,
  assertRemoteWorkspaceTreeStage,
  stageRemoteWorkspaceExactFile,
  stageRemoteWorkspaceTree
} from "./remote-workspace-staging.mjs";
import {
  assertRemoteWorkspacePhaseLoaderStage,
  stageRemoteWorkspacePhaseLoader
} from "./remote-workspace-phase-loader.mjs";
import {
  assertEditorAcceptancePrivateRootReceipt,
  createEditorAcceptancePrivateRootReceipt,
  removeEditorAcceptancePrivateRoot
} from "./packaged-editor-orchestration.mjs";
import {
  assertRemoteWorkspaceOwnedFileCleanupReceipt,
  createRemoteWorkspaceOwnedFileCleanupReceipt,
  removeRemoteWorkspaceOwnedFile
} from "./remote-workspace-cleanup.mjs";
import { validateRemoteWorkspaceTerminal } from "./remote-workspace-terminal.mjs";
import { prepareRepositoryLocalXvfb } from "./prepare-xvfb.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const candidateArguments = process.argv.slice(2);
let candidatePath;
const scriptsRoot = resolve(repositoryRoot, "scripts");
const testModule = resolve(repositoryRoot, "dist-test", "test", "extensionHost", "index.js");
const testModuleRoot = resolve(repositoryRoot, "dist-test");
const playwrightCoreRoot = resolve(repositoryRoot, "node_modules", "playwright-core");
const packageJson = JSON.parse(readFileSync(resolve(repositoryRoot, "package.json"), "utf8"));
const packageLock = JSON.parse(readFileSync(resolve(repositoryRoot, "package-lock.json"), "utf8"));
const pinnedPlaywrightCoreVersion = packageLock.packages?.["node_modules/playwright-core"]?.version;
const expectedCandidate = `${packageJson.publisher}.${packageJson.name}@${packageJson.version}`.toLowerCase();
const expectedHarness = "openwrangler-tests.openwrangler-packaged-test-harness@0.0.0";
const namespaceSshUser = "openwrangler";
const setupOutputLimit = 64 * 1024;
let layout;
let rootReceipt;
let hostSentinel;
let hostSentinelReceipt;
let hostHome;
let hostHomeReceipt;
let descriptorReceipt;
let candidateExpectation;
let candidateSourceReceipt;
let stagedCandidateReceipt;
let phaseCleanupAuthorized = true;
const commandRunner = createRemoteWorkspaceCommandRunner();

try {
  if (process.env.OPEN_WRANGLER_EDITOR_DISPLAY !== "xvfb") {
    throw new Error(
      "Remote SSH acceptance requires the explicit private Xvfb compatibility mode; set OPEN_WRANGLER_EDITOR_DISPLAY=xvfb."
    );
  }
  if (candidateArguments.length !== 3) {
    throw new Error("Remote SSH acceptance requires exactly: <candidate.vsix> <lowercase-sha256> <byte-size>.");
  }
  candidatePath = validateRemoteWorkspaceCandidatePath(candidateArguments[0]);
  candidateExpectation = validateRemoteWorkspaceCandidateExpectation(candidateArguments[1], candidateArguments[2]);
  candidateSourceReceipt = assertRegularCandidate(candidatePath, candidateExpectation);
  const tools = await assertRemoteWorkspaceHost({}, { runCommand: commandRunner.run });
  const preparedXvfb = await prepareRepositoryLocalXvfb();
  assertRemoteWorkspaceCandidateReceipt(candidatePath, candidateSourceReceipt, candidateExpectation);
  await verifyCandidate(candidatePath);
  const privateParent = preparePrivateParent(resolve(repositoryRoot, "tmp", "remote-workspace"));
  layout = createRemoteWorkspaceLayout(privateParent);
  rootReceipt = createEditorAcceptancePrivateRootReceipt(layout.root, { containedBy: privateParent });
  const phaseNodeStage = stageRemoteWorkspaceExactFile(
    realpathSync(process.execPath),
    join(layout.immutable, "phase-node"),
    0o700,
    { maximumBytes: REMOTE_WORKSPACE_PHASE_NODE_MAXIMUM_BYTES }
  );
  const namespaceLayout = createRemoteWorkspaceNamespaceLayout(layout);
  const runId = randomUUID();
  hostSentinel = join(privateParent, `.host-private-${runId}`);
  writeFileSync(hostSentinel, randomUUID(), { encoding: "utf8", flag: "wx", mode: 0o600 });
  hostSentinelReceipt = createRemoteWorkspaceOwnedFileCleanupReceipt(hostSentinel, {
    parentContainedBy: dirname(privateParent)
  });
  hostHome = realpathSync(homedir());
  hostHomeReceipt = captureDirectoryReceipt(hostHome);
  const hostIsolationSha256 = createRemoteWorkspaceHostIsolationDigest(hostHome, hostSentinel);
  const phaseLoaderStage = stageRemoteWorkspacePhaseLoader(scriptsRoot, layout.phaseRuntime, preparedXvfb);
  const xvfbStage = phaseLoaderStage.xvfbStage;
  const testModuleStage = stageTestModuleTree(layout.remoteTestModule);
  const playwrightStage = stageTestRuntimeDependency(
    playwrightCoreRoot,
    join(layout.remoteTestModule, "node_modules", "playwright-core"),
    {
      name: "playwright-core",
      version: pinnedPlaywrightCoreVersion,
      maximumFiles: 256,
      maximumBytes: 24 * 1024 * 1024,
      maximumFileBytes: 8 * 1024 * 1024
    }
  );
  const treeStages = [testModuleStage.stage, playwrightStage];
  const acquisition = await acquirePinnedRemoteWorkspaceArtifacts(layout.root, {
    artifactPaths: artifactOverrides(process.env)
  });
  const sshServer = await extractPinnedDropbearRuntime(acquisition.artifacts, layout.sshRuntime, {
    dpkgDeb: tools.dpkgDeb,
    runCommand: commandRunner.run
  });
  writePrivateAccountDatabase(layout.accounts, tools.uid, tools.gid, namespaceLayout.remoteHome);
  const clientRoot = layout.client;
  await extractPinnedRemoteTar(acquisition.artifacts.vscode, clientRoot, { runCommand: commandRunner.run });

  const remoteServerBase = layout.remoteServerBase;
  await extractPinnedRemoteTar(acquisition.artifacts.cli, remoteServerBase, { runCommand: commandRunner.run });
  const unpackedCli = join(remoteServerBase, "code");
  const committedCli = join(remoteServerBase, `code-${PINNED_REMOTE_VSCODE_COMMIT}`);
  renameSync(unpackedCli, committedCli);
  chmodSync(committedCli, 0o755);

  const serverRoot = join(remoteServerBase, "cli", "servers", `Stable-${PINNED_REMOTE_VSCODE_COMMIT}`, "server");
  mkdirSync(serverRoot, { recursive: true, mode: 0o700 });
  await extractPinnedRemoteTar(acquisition.artifacts.server, serverRoot, { runCommand: commandRunner.run });
  const installation = await validatePinnedRemoteInstallations(
    {
      clientRoot,
      cliPath: committedCli,
      serverRoot
    },
    {
      runCommand: commandRunner.run
    }
  );

  stagedCandidateReceipt = stageRemoteWorkspaceCandidate(
    candidatePath,
    layout.candidate,
    candidateSourceReceipt,
    candidateExpectation
  );
  assertRemoteWorkspaceCandidateReceipt(layout.candidate, stagedCandidateReceipt, candidateExpectation);
  await verifyCandidate(layout.candidate);
  const sourcePython = resolveSourcePython(process.env);
  const systemPython = realpathSync(sourcePython);
  const python = await copyPrivatePythonEnvironment(sourcePython, layout.python, {
    runCommand: commandRunner.run
  });
  writeRemoteFixture(layout);
  writeWorkspaceSettings(layout, namespaceRemoteWorkspaceImmutablePath(layout, python.executable));

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
  const ssh = await writeSshConfiguration(layout, namespaceLayout, sshServer, tools);
  writeLocalEditorSettings(layout, ssh.namespaceClientConfig);

  const setupEnvironment = isolatedEnvironment(layout.localHome);
  await assertPinnedRemoteArtifactReceipt(acquisition.artifacts.remoteSsh);
  await validateRemoteSshVsix(acquisition.artifacts.remoteSsh.path);
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
  assertRemoteWorkspaceCandidateReceipt(candidatePath, candidateSourceReceipt, candidateExpectation);
  assertRemoteWorkspaceCandidateReceipt(layout.candidate, stagedCandidateReceipt, candidateExpectation);
  await runSetupCommand(
    installation.serverExecutable,
    ["--extensions-dir", layout.remoteExtensions, "--install-extension", layout.candidate, "--force"],
    remoteEnvironment,
    "Pinned remote candidate installation"
  );
  await runSetupCommand(
    installation.serverExecutable,
    ["--extensions-dir", layout.remoteExtensions, "--install-extension", harnessVsix, "--force"],
    remoteEnvironment,
    "Pinned remote harness installation"
  );
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

  writeRemoteWorkspacePhaseDescriptor(layout.descriptor, {
    runId,
    layout: namespaceLayout,
    editor: namespaceRemoteWorkspaceImmutablePath(layout, installation.clientExecutable),
    xvfb: namespaceRemoteWorkspaceImmutablePath(layout, xvfbStage.stagedPath),
    testModule: namespaceRemoteWorkspaceImmutablePath(layout, testModuleStage.entrypoint),
    python: namespaceRemoteWorkspaceImmutablePath(layout, python.executable),
    user: namespaceSshUser,
    sshConfig: ssh.namespaceClientConfig,
    sshServer: namespaceRemoteWorkspaceImmutablePath(layout, sshServer.executable),
    sshLibraryPath: namespaceRemoteWorkspaceImmutablePath(layout, sshServer.libraryPath),
    sshHostKey: ssh.namespaceHostKey,
    sshAuthorizedKeys: ssh.namespaceAuthorizedKeys,
    hostHome,
    hostSentinel,
    uid: tools.uid,
    gid: tools.gid,
    candidateReceipt: candidateExpectation,
    remoteSshReceipt: {
      version: PINNED_REMOTE_SSH_VERSION,
      bytes: PINNED_REMOTE_SSH_BYTES,
      sha256: PINNED_REMOTE_SSH_SHA256
    }
  });
  descriptorReceipt = captureRemoteWorkspaceFileReceipt(layout.descriptor);
  const immutableInputs = createRemoteWorkspaceImmutableInputRegistry(
    {
      localHome: layout.localHome,
      userData: layout.userData,
      remoteHome: layout.remoteHome,
      output: layout.output,
      descriptor: layout.descriptor,
      phaseNode: phaseNodeStage.stagedPath,
      phaseRuntime: layout.phaseRuntime,
      client: layout.client,
      localExtensions: layout.localExtensions,
      localSettings: join(layout.userData, "User", "settings.json"),
      remoteCli: committedCli,
      remoteServer: serverRoot,
      remoteExtensions: layout.remoteExtensions,
      remoteTestModule: layout.remoteTestModule,
      python: layout.python,
      sshRuntime: join(layout.sshRuntime, "runtime"),
      sshTomcrypt: join(layout.sshRuntime, "runtime", "lib", "libtomcrypt.so.1"),
      sshTommath: join(layout.sshRuntime, "runtime", "lib", "libtommath.so.1"),
      ssh: layout.ssh,
      workspace: layout.workspace,
      "account:group": join(layout.accounts, "group"),
      "account:hosts": join(layout.accounts, "hosts"),
      "account:machine-id": join(layout.accounts, "machine-id"),
      "account:nsswitch.conf": join(layout.accounts, "nsswitch.conf"),
      "account:os-release": join(layout.accounts, "os-release"),
      "account:passwd": join(layout.accounts, "passwd"),
      "account:resolv.conf": join(layout.accounts, "resolv.conf"),
      "account:shadow": join(layout.accounts, "shadow"),
      hostHome,
      hostSentinel
    },
    { commit: PINNED_REMOTE_VSCODE_COMMIT, uid: tools.uid, gid: tools.gid }
  );
  await assertAcceptanceProvenance({
    candidatePath,
    candidateSourceReceipt,
    stagedCandidatePath: layout.candidate,
    stagedCandidateReceipt,
    candidateExpectation,
    remoteSshArtifact: acquisition.artifacts.remoteSsh
  });
  assertStagedRuntimeInputs(phaseNodeStage, phaseLoaderStage, treeStages);
  assertEditorAcceptancePrivateRootReceipt(rootReceipt);
  assertRemoteWorkspaceFileReceipt(layout.descriptor, descriptorReceipt);
  assertRemoteWorkspaceOwnedFileCleanupReceipt(hostSentinelReceipt);
  assertDirectoryReceipt(hostHome, hostHomeReceipt);
  const sealPhaseLaunch = (bootstrapPreflight = false) => {
    assertStagedRuntimeInputs(phaseNodeStage, phaseLoaderStage, treeStages);
    const leases = openRemoteWorkspaceImmutableInputLeases(immutableInputs);
    try {
      const args = createRemoteWorkspaceBwrapArguments({
        root: layout.root,
        descriptor: layout.descriptor,
        childScript: phaseLoaderStage.entrypoint,
        systemPython,
        systemRuntimeDirectories: python.systemRuntimeDirectories,
        immutableMounts: leases.mounts,
        uid: tools.uid,
        gid: tools.gid,
        bootstrapPreflight,
        tools
      });
      return {
        args,
        inheritedFileDescriptors: leases.inheritedFileDescriptors,
        release: leases.release
      };
    } catch (error) {
      leases.release();
      throw error;
    }
  };
  const bootstrap = await commandRunner.run(
    {
      executable: tools.bwrap,
      args: [],
      environment: createEditorAcceptanceEnvironment(),
      label: "Remote SSH exact private-layout bootstrap preflight",
      beforeSpawn() {
        return sealPhaseLaunch(true);
      }
    },
    {
      timeoutMs: 60_000,
      maxOutputBytes: setupOutputLimit,
      terminationGraceMs: 5_000,
      killGraceMs: 5_000
    }
  );
  if (bootstrap.stderr !== "") {
    throw new Error("The Remote SSH exact private-layout bootstrap preflight emitted unexpected diagnostics.");
  }
  validateRemoteWorkspaceBootstrapAttestation(bootstrap.stdout, { runId });
  assertStagedRuntimeInputs(phaseNodeStage, phaseLoaderStage, treeStages);
  assertRemoteWorkspaceImmutableInputRegistry(immutableInputs);
  assertEditorAcceptancePrivateRootReceipt(rootReceipt);
  assertRemoteWorkspaceFileReceipt(layout.descriptor, descriptorReceipt);
  assertRemoteWorkspaceOwnedFileCleanupReceipt(hostSentinelReceipt);
  assertDirectoryReceipt(hostHome, hostHomeReceipt);
  phaseCleanupAuthorized = false;
  const phaseResult = await commandRunner.run(
    {
      executable: tools.bwrap,
      args: [],
      environment: createEditorAcceptanceEnvironment(),
      label: "Official VS Code Remote SSH packaged acceptance",
      beforeSpawn() {
        return sealPhaseLaunch();
      }
    },
    {
      timeoutMs: REMOTE_WORKSPACE_PHASE_TIMEOUT_MS,
      maxOutputBytes: setupOutputLimit,
      terminationGraceMs: 5_000,
      killGraceMs: 5_000
    }
  );
  const terminal = await validateRemoteWorkspaceTerminal({
    stdout: phaseResult.stdout,
    stderr: phaseResult.stderr,
    resultPath: layout.result,
    expected: {
      runId,
      ...candidateExpectation,
      hostIsolationSha256
    },
    async revalidate() {
      assertStagedRuntimeInputs(phaseNodeStage, phaseLoaderStage, treeStages);
      assertRemoteWorkspaceImmutableInputRegistry(immutableInputs);
      assertEditorAcceptancePrivateRootReceipt(rootReceipt);
      assertRemoteWorkspaceFileReceipt(layout.descriptor, descriptorReceipt);
      assertRemoteWorkspaceOwnedFileCleanupReceipt(hostSentinelReceipt);
      assertDirectoryReceipt(hostHome, hostHomeReceipt);
      await assertAcceptanceProvenance({
        candidatePath,
        candidateSourceReceipt,
        stagedCandidatePath: layout.candidate,
        stagedCandidateReceipt,
        candidateExpectation,
        remoteSshArtifact: acquisition.artifacts.remoteSsh
      });
    }
  });
  phaseCleanupAuthorized = true;
  if (terminal.result.outcome === "failure") {
    const diagnostic = redactEditorAcceptanceText(terminal.result.error, [
      [layout.root, "<private-root>"],
      [candidatePath, "<candidate-vsix>"],
      [hostHome, "<host-home>"],
      [hostSentinel, "<host-sentinel>"]
    ]);
    throw new Error(
      `Open Wrangler Remote SSH acceptance failed: ${
        diagnostic === undefined ? "<redacted-sensitive-diagnostic>" : diagnostic.slice(-8_192)
      }`
    );
  }
  removeEditorAcceptancePrivateRoot(rootReceipt, {
    processTreeVerifiedStopped: true,
    privatePathsVerified: true
  });
  rootReceipt = undefined;
  removeRemoteWorkspaceOwnedFile(hostSentinelReceipt, {
    processTreeVerifiedStopped: true,
    privatePathsVerified: true
  });
  hostSentinel = undefined;
  hostSentinelReceipt = undefined;
  console.log(
    `Open Wrangler Remote SSH acceptance passed with official VS Code ${installation.version} (${installation.commit}).`
  );
} catch (error) {
  if (commandRunner.ownershipUncertain() || editorProcessTreeMayBeLive(error)) {
    throw new Error(
      "Remote SSH acceptance lost PID-namespace ownership; no private result, logs, profile, or artifact path was inspected or removed."
    );
  }
  if (!phaseCleanupAuthorized) {
    throw new Error(
      "Remote SSH acceptance did not prove its complete terminal boundary; private cleanup was withheld and unvalidated diagnostics were suppressed."
    );
  }
  const cleanupErrors = [];
  if (layout && rootReceipt) {
    try {
      removeEditorAcceptancePrivateRoot(rootReceipt, {
        processTreeVerifiedStopped: true,
        privatePathsVerified: true
      });
    } catch (cleanupError) {
      cleanupErrors.push(cleanupError);
    }
  }
  if (hostSentinel && hostSentinelReceipt) {
    try {
      removeRemoteWorkspaceOwnedFile(hostSentinelReceipt, {
        processTreeVerifiedStopped: true,
        privatePathsVerified: true
      });
    } catch (cleanupError) {
      cleanupErrors.push(cleanupError);
    }
  }
  if (cleanupErrors.length > 0) {
    throw new AggregateError([error, ...cleanupErrors], "Remote SSH acceptance and verified private cleanup failed.");
  }
  throw error;
}

function artifactOverrides(environment) {
  const values = {
    vscode: environment.OPEN_WRANGLER_REMOTE_VSCODE_ARCHIVE,
    cli: environment.OPEN_WRANGLER_REMOTE_CLI_ARCHIVE,
    server: environment.OPEN_WRANGLER_REMOTE_SERVER_ARCHIVE,
    remoteSsh: environment.OPEN_WRANGLER_REMOTE_SSH_VSIX,
    dropbear: environment.OPEN_WRANGLER_REMOTE_DROPBEAR_DEB,
    tomcrypt: environment.OPEN_WRANGLER_REMOTE_TOMCRYPT_DEB,
    tommath: environment.OPEN_WRANGLER_REMOTE_TOMMATH_DEB
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

function stageTestModuleTree(destination) {
  const bounds = {
    label: "Remote SSH test module",
    maximumFiles: 256,
    maximumBytes: 8 * 1024 * 1024,
    maximumFileBytes: 2 * 1024 * 1024
  };
  const stagedRoot = join(destination, "dist-test");
  const stage = stageRemoteWorkspaceTree(testModuleRoot, stagedRoot, bounds);
  return Object.freeze({
    entrypoint: join(stagedRoot, relative(testModuleRoot, testModule)),
    stage
  });
}

function stageTestRuntimeDependency(source, destination, identity) {
  if (
    typeof identity?.name !== "string" ||
    typeof identity?.version !== "string" ||
    !identity.name ||
    !identity.version
  ) {
    throw new Error("The Remote SSH test dependency is not pinned by the lockfile.");
  }
  const packagePath = join(source, "package.json");
  const packageReceipt = captureRemoteWorkspaceFileReceipt(packagePath);
  const metadata = JSON.parse(readFileSync(packagePath, "utf8"));
  assertRemoteWorkspaceFileReceipt(packagePath, packageReceipt);
  if (metadata.name !== identity.name || metadata.version !== identity.version) {
    throw new Error("The Remote SSH test dependency does not match its lockfile identity.");
  }
  const stage = stageRemoteWorkspaceTree(source, destination, {
    label: `Remote SSH ${identity.name} dependency`,
    maximumFiles: identity.maximumFiles,
    maximumBytes: identity.maximumBytes,
    maximumFileBytes: identity.maximumFileBytes
  });
  assertRemoteWorkspaceFileReceipt(packagePath, packageReceipt);
  return stage;
}

function assertStagedRuntimeInputs(phaseNodeStage, phaseLoaderStage, treeStages) {
  assertRemoteWorkspaceExactFileStage(phaseNodeStage);
  assertRemoteWorkspacePhaseLoaderStage(phaseLoaderStage);
  for (const stage of treeStages) assertRemoteWorkspaceTreeStage(stage);
}

function writeRemoteFixture(paths) {
  writeFileSync(join(paths.workspace, "remote.csv"), "city,value\nMilan,42\nRome,7\nBerlin,12\n", {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600
  });
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

function writePrivateAccountDatabase(directory, uid, gid, home) {
  for (const [name, contents, mode] of [
    ["passwd", `${namespaceSshUser}:x:${uid}:${gid}:Open Wrangler Remote:${home}:/bin/sh\n`, 0o600],
    ["group", `${namespaceSshUser}:x:${gid}:\n`, 0o600],
    ["shadow", `${namespaceSshUser}:NP:20500:0:99999:7:::\n`, 0o600],
    ["nsswitch.conf", "passwd: files\ngroup: files\nshadow: files\nhosts: files\n", 0o600],
    ["hosts", "127.0.0.1 localhost openwrangler-remote-acceptance\n::1 localhost\n", 0o600],
    ["resolv.conf", "# Private network namespace: no resolver configured.\n", 0o600],
    ["machine-id", "6f70656e7772616e676c657274657374\n", 0o600],
    ["os-release", 'NAME="Open Wrangler acceptance"\nID=openwrangler-acceptance\nVERSION_ID="1"\n', 0o600]
  ]) {
    writeFileSync(join(directory, name), contents, {
      encoding: "utf8",
      flag: "wx",
      mode
    });
  }
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

async function writeSshConfiguration(paths, namespacePaths, sshServer, tools) {
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
    tools.dynamicLoader,
    ["--library-path", sshServer.libraryPath, sshServer.keygen, "-t", "ed25519", "-f", hostKey],
    keyEnvironment,
    "Private Dropbear host-key creation"
  );
  copyFileSync(`${clientKey}.pub`, join(paths.ssh, "authorized_keys"), constants.COPYFILE_EXCL);
  chmodSync(join(paths.ssh, "authorized_keys"), 0o600);
  const hostPublicKeyOutput = await runSetupCommand(
    tools.dynamicLoader,
    ["--library-path", sshServer.libraryPath, sshServer.keygen, "-y", "-f", hostKey],
    keyEnvironment,
    "Private Dropbear host public-key derivation"
  );
  const hostPublicKeyLine = hostPublicKeyOutput.stdout
    .split("\n")
    .map((value) => value.trim())
    .find((value) => value.startsWith("ssh-ed25519 "));
  const hostPublicKeyParts = hostPublicKeyLine?.split(/\s+/u);
  if (
    !hostPublicKeyParts ||
    hostPublicKeyParts.length < 2 ||
    hostPublicKeyParts[0] !== "ssh-ed25519" ||
    !/^[A-Za-z0-9+/]+={0,2}$/u.test(hostPublicKeyParts[1])
  ) {
    throw new Error("The pinned Dropbear host key did not produce one canonical Ed25519 public key.");
  }
  const hostPublicKey = hostPublicKeyParts.slice(0, 2).join(" ");
  const knownHosts = join(paths.ssh, "known_hosts");
  writeFileSync(knownHosts, `[127.0.0.1]:49321 ${hostPublicKey}\n`, { mode: 0o600, flag: "wx" });

  const clientConfig = join(paths.ssh, "config");
  const namespaceClientKey = join(namespacePaths.ssh, "client");
  const namespaceKnownHosts = join(namespacePaths.ssh, "known_hosts");
  writeFileSync(
    clientConfig,
    [
      "Host ow-loopback",
      "  HostName 127.0.0.1",
      "  Port 49321",
      `  User ${namespaceSshUser}`,
      `  IdentityFile ${namespaceClientKey}`,
      "  IdentitiesOnly yes",
      "  BatchMode yes",
      "  StrictHostKeyChecking yes",
      `  UserKnownHostsFile ${namespaceKnownHosts}`,
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

  return Object.freeze({
    clientConfig,
    namespaceClientConfig: join(namespacePaths.ssh, "config"),
    hostKey,
    namespaceHostKey: join(namespacePaths.ssh, "host"),
    authorizedKeys: paths.ssh,
    namespaceAuthorizedKeys: namespacePaths.ssh
  });
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
  return commandRunner.run(
    { executable, args, environment, label },
    { timeoutMs: 120_000, maxOutputBytes: setupOutputLimit }
  );
}

async function verifyCandidate(path) {
  await runSetupCommand(
    process.execPath,
    [resolve(repositoryRoot, "scripts", "verify-vsix.mjs"), path],
    createEditorAcceptanceEnvironment(),
    "Remote SSH candidate VSIX verification"
  );
}

function assertRegularCandidate(path, expectation) {
  if (!isAbsolute(path)) throw new Error("The Remote SSH candidate VSIX must use an absolute path.");
  const receipt = acceptRemoteWorkspaceCandidate(path, expectation);
  captureRemoteWorkspaceFileReceipt(testModule);
  return receipt;
}

async function assertAcceptanceProvenance({
  candidatePath,
  candidateSourceReceipt,
  stagedCandidatePath,
  stagedCandidateReceipt,
  candidateExpectation,
  remoteSshArtifact
}) {
  assertRemoteWorkspaceCandidateReceipt(candidatePath, candidateSourceReceipt, candidateExpectation);
  assertRemoteWorkspaceCandidateReceipt(stagedCandidatePath, stagedCandidateReceipt, candidateExpectation);
  await assertPinnedRemoteArtifactReceipt(remoteSshArtifact);
  await validateRemoteSshVsix(remoteSshArtifact.path);
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

function assertDirectoryReceipt(path, receipt) {
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
    throw new Error("The Remote SSH host directory changed identity after it was pinned.");
  }
  return receipt;
}
