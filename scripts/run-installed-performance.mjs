import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  cpSync,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
  writeSync
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { createVSIX } from "@vscode/vsce";
import { open as openZip } from "yauzl";
import {
  configureEditorAcceptanceTempRoot,
  createEditorAcceptanceEnvironment,
  downloadEditorWithRetry,
  editorAcceptanceProgressPath,
  editorDisplayLaunchArgs,
  editorProcessTreeMayBeLive,
  resolveDownloadedEditorCliPath,
  runBoundedEditorCliCommand,
  runEditorAcceptancePhase,
  sanitizeEditorAcceptanceDiagnostic,
  spawnOwnedEditorProcess,
  startIsolatedEditorDisplay,
  validateEditorAcceptancePrivatePathOverrides,
  writeEditorAcceptanceHarness,
  writeEditorSettings
} from "./editor-acceptance.mjs";
import {
  createEditorAcceptancePrivateRootReceipt,
  removeEditorAcceptancePrivateRoot
} from "./packaged-editor-orchestration.mjs";
import {
  assertInstalledPerformanceReleaseGate,
  buildInstalledPerformanceReport,
  validateInstalledFixtureManifest,
  validateInstalledPerformancePhase,
  writeInstalledPerformanceReport
} from "./installed-performance-report.mjs";
import {
  createInstalledResourceSampler,
  readInstalledPlatformProvenance,
  readInstalledStorageProvenance
} from "./installed-performance-system.mjs";
import { prepareRepositoryLocalXvfb } from "./prepare-xvfb.mjs";

const root = resolve(import.meta.dirname, "..");
const INSTALLED_RUN_PROTOCOL = "openwrangler-installed-performance-run-v4";
const INSTALLED_PERFORMANCE_PHASES = [
  "perf-csv-cold",
  "perf-csv-warm",
  "perf-parquet-cold",
  "perf-parquet-warm",
  "perf-grid-interaction"
];
const EXPECTED_HARNESS = "openwrangler-tests.openwrangler-packaged-test-harness@0.0.0";
const VSIX_MAX_BYTES = 512 * 1024 * 1024;
const VSIX_PACKAGE_JSON_MAX_BYTES = 1024 * 1024;
const VSIX_MAX_ENTRIES = 100_000;
const OUTPUT_MAX_BYTES = 1024 * 1024;
const guardedCandidateReceipts = new WeakSet();

export function parseInstalledPerformanceArguments(arguments_) {
  const options = {
    smoke: false,
    editors: ["vscode", "cursor"],
    candidateOutput: resolve(root, "tmp", "performance", "openwrangler-installed-candidate.vsix"),
    output: resolve(root, "tmp", "performance", "installed-performance.json")
  };
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === "--smoke") {
      options.smoke = true;
      continue;
    }
    if (argument === "--editors") {
      const value = arguments_[++index];
      if (!value) throw new Error("--editors requires vscode, cursor, or vscode,cursor.");
      const editors = value
        .split(",")
        .map((entry) => entry.trim())
        .filter(Boolean);
      if (
        editors.length === 0 ||
        new Set(editors).size !== editors.length ||
        editors.some((entry) => entry !== "vscode" && entry !== "cursor")
      ) {
        throw new Error("--editors requires a unique comma-separated subset of vscode,cursor.");
      }
      options.editors = editors;
      continue;
    }
    if (argument === "--out") {
      const value = arguments_[++index];
      if (!value) throw new Error("--out requires one filesystem path.");
      options.output = resolve(root, value);
      continue;
    }
    if (argument === "--candidate-out") {
      const value = arguments_[++index];
      if (!value) throw new Error("--candidate-out requires one filesystem path.");
      options.candidateOutput = resolve(root, value);
      continue;
    }
    if (argument?.startsWith("--")) throw new Error(`Unknown installed-performance option ${argument}.`);
    throw new Error(
      "Installed performance packages its own clean-HEAD candidate; use --candidate-out to choose its destination."
    );
  }
  return options;
}

export function stageInstalledPerformanceVsix(source, destination) {
  const sourcePath = resolve(source);
  const destinationPath = resolve(destination);
  const sourceAtPath = lstatSync(sourcePath, { bigint: true });
  if (!sourceAtPath.isFile() || sourceAtPath.isSymbolicLink() || sourceAtPath.nlink !== 1n) {
    throw new Error("The installed-performance candidate must be a single-link regular VSIX.");
  }
  if (sourceAtPath.size <= 0n || sourceAtPath.size > BigInt(VSIX_MAX_BYTES)) {
    throw new Error("The installed-performance candidate has an invalid byte size.");
  }
  mkdirSync(dirname(destinationPath), { recursive: true, mode: 0o700 });
  assertAbsent(destinationPath, "staged installed-performance VSIX");

  let sourceDescriptor;
  let destinationDescriptor;
  let destinationIdentity;
  let complete = false;
  const digest = createHash("sha256");
  try {
    sourceDescriptor = openSync(sourcePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const openedSource = fstatSync(sourceDescriptor, { bigint: true });
    requireSameRegularFile(openedSource, sourceAtPath, "The candidate changed before it was staged.");
    destinationDescriptor = openSync(
      destinationPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
      0o600
    );
    destinationIdentity = fstatSync(destinationDescriptor, { bigint: true });
    if (!destinationIdentity.isFile() || destinationIdentity.nlink !== 1n) {
      throw new Error("The staged candidate is not an exclusively owned regular file.");
    }
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let total = 0;
    while (true) {
      const count = readSync(sourceDescriptor, buffer, 0, buffer.length, null);
      if (count === 0) break;
      digest.update(buffer.subarray(0, count));
      let offset = 0;
      while (offset < count) {
        const written = writeSync(destinationDescriptor, buffer, offset, count - offset);
        if (written === 0) throw new Error("The staged candidate copy made no write progress.");
        offset += written;
      }
      total += count;
    }
    if (BigInt(total) !== sourceAtPath.size) throw new Error("The staged candidate copy was incomplete.");
    fsyncSync(destinationDescriptor);
    const completedDestination = fstatSync(destinationDescriptor, { bigint: true });
    requireSameFileIdentity(
      completedDestination,
      destinationIdentity,
      "The staged candidate changed while it was written."
    );
    if (completedDestination.size !== sourceAtPath.size) {
      throw new Error("The staged candidate copy has an invalid published byte size.");
    }
    const completedSource = fstatSync(sourceDescriptor, { bigint: true });
    const completedSourcePath = lstatSync(sourcePath, { bigint: true });
    requireSameRegularFile(completedSource, sourceAtPath, "The candidate changed while it was staged.");
    requireSameRegularFile(completedSourcePath, sourceAtPath, "The candidate path changed while it was staged.");
    closeSync(destinationDescriptor);
    destinationDescriptor = undefined;
    closeSync(sourceDescriptor);
    sourceDescriptor = undefined;
    const published = lstatSync(destinationPath, { bigint: true });
    requireSameRegularFile(published, completedDestination, "The staged candidate path changed after publication.");
    complete = true;
    return {
      path: destinationPath,
      sha256: digest.digest("hex"),
      bytes: total
    };
  } finally {
    if (destinationDescriptor !== undefined) closeSync(destinationDescriptor);
    if (sourceDescriptor !== undefined) closeSync(sourceDescriptor);
    if (!complete && destinationIdentity !== undefined) removeIdentifiedFile(destinationPath, destinationIdentity);
  }
}

export async function readInstalledPerformanceCandidate(receipt) {
  if (!guardedCandidateReceipts.has(receipt)) {
    throw new Error("Installed performance candidate metadata requires one guarded build receipt.");
  }
  const packageJson = await readVsixPackageJson(receipt.path);
  if (
    packageJson.publisher !== "Matt17BR" ||
    packageJson.name !== "openwrangler" ||
    typeof packageJson.version !== "string" ||
    typeof packageJson.preview !== "boolean"
  ) {
    throw new Error("The staged VSIX does not identify one Open Wrangler candidate.");
  }
  return {
    extensionId: `${packageJson.publisher}.${packageJson.name}`,
    extensionVersion: packageJson.version,
    preview: packageJson.preview,
    buildMethod: "guarded-clean-head-v1",
    sourceCommit: receipt.source.commit,
    vsixSha256: receipt.sha256,
    vsixBytes: receipt.bytes
  };
}

export async function packageInstalledPerformanceCandidate({
  destination,
  snapshotDestination,
  environment = process.env,
  readSource = readSourceProvenance,
  build = runInstalledPerformanceBuild,
  packageCandidate = createInstalledPerformanceVsix,
  verifyCandidate = verifyInstalledPerformanceVsix,
  snapshotCandidate = stageInstalledPerformanceVsix
}) {
  if (typeof snapshotDestination !== "string" || snapshotDestination.length === 0) {
    throw new TypeError("Guarded installed-performance packaging requires a private snapshot destination.");
  }
  const before = readSource();
  requireCleanSource(before, "before candidate build");
  await build(environment);
  requireSameSource(readSource(), before, "during candidate build");
  await packageCandidate(destination);
  requireSameSource(readSource(), before, "during candidate packaging");
  await verifyCandidate(destination, environment);
  requireSameSource(readSource(), before, "during candidate verification");
  const snapshot = await snapshotCandidate(destination, snapshotDestination);
  requireSameSource(readSource(), before, "during candidate snapshot");
  const receipt = Object.freeze({
    path: snapshot.path,
    sha256: snapshot.sha256,
    bytes: snapshot.bytes,
    source: Object.freeze({ ...before })
  });
  guardedCandidateReceipts.add(receipt);
  return receipt;
}

export function writeInstalledPerformanceRun(destination, result) {
  const serialized = `${JSON.stringify(result, null, 2)}\n`;
  if (Buffer.byteLength(serialized, "utf8") > OUTPUT_MAX_BYTES) {
    throw new Error("The installed performance result exceeded its fixed 1 MiB limit.");
  }
  const target = resolve(destination);
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  assertReplaceableRegularFile(target, "installed performance result");
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
  let descriptor;
  let identity;
  let published = false;
  try {
    descriptor = openSync(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
      0o600
    );
    identity = fstatSync(descriptor, { bigint: true });
    if (!identity.isFile() || identity.nlink !== 1n) {
      throw new Error("The installed performance result temporary is not exclusively owned.");
    }
    writeFileSync(descriptor, serialized, "utf8");
    fsyncSync(descriptor);
    const complete = fstatSync(descriptor, { bigint: true });
    requireSameFileIdentity(complete, identity, "The installed performance result changed while it was written.");
    closeSync(descriptor);
    descriptor = undefined;
    assertReplaceableRegularFile(target, "installed performance result");
    const atPath = lstatSync(temporary, { bigint: true });
    requireSameRegularFile(atPath, complete, "The installed performance result temporary path changed.");
    renameSync(temporary, target);
    published = true;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    if (!published && identity !== undefined) removeIdentifiedFile(temporary, identity);
  }
}

export function cleanupInstalledPerformancePrivateRoot({
  processTreeUncertain,
  receipt,
  removePrivateRoot = removeEditorAcceptancePrivateRoot
}) {
  if (processTreeUncertain) return false;
  removePrivateRoot(receipt);
  return true;
}

export async function runInstalledPerformance(options, environment = process.env) {
  validateEditorAcceptancePrivatePathOverrides();
  if (process.platform !== "linux") {
    throw new Error("Strict installed performance evidence currently requires a Linux reference machine.");
  }
  const privateParent = resolve(root, "tmp", "ow");
  mkdirSync(privateParent, { recursive: true, mode: 0o700 });
  const privateRoot = mkdtempSync(join(privateParent, "x-"));
  const privateRootReceipt = createEditorAcceptancePrivateRootReceipt(privateRoot, { containedBy: privateParent });
  configureEditorAcceptanceTempRoot(privateRoot, environment);
  const privatePaths = [privateRoot, options.candidateOutput];
  let processTreeUncertain = false;
  let primaryError;
  let result;
  try {
    const builtCandidate = resolve(privateRoot, "built-candidate.vsix");
    const guardedCandidate = await packageInstalledPerformanceCandidate({
      destination: builtCandidate,
      snapshotDestination: resolve(privateRoot, "candidate.vsix"),
      environment
    });
    const sourceBefore = guardedCandidate.source;
    const candidate = await readInstalledPerformanceCandidate(guardedCandidate);
    const published = stageInstalledPerformanceVsix(guardedCandidate.path, options.candidateOutput);
    if (published.sha256 !== guardedCandidate.sha256 || published.bytes !== guardedCandidate.bytes) {
      throw new Error("The published installed-performance candidate does not match its private snapshot.");
    }
    requireSameSource(readSourceProvenance(), sourceBefore, "after candidate publication");
    const python = resolveTestPython(environment);
    const fixtureRoot = resolve(privateRoot, "f");
    const fixtureDirectory = resolve(fixtureRoot, "fixtures");
    const fixtureManifestPath = resolve(fixtureRoot, "performance-fixtures.json");
    mkdirSync(fixtureRoot, { recursive: true, mode: 0o700 });
    execFileSync(
      python,
      [
        resolve(root, "python", "benchmarks", "installed_editor_fixtures.py"),
        "--output-dir",
        fixtureDirectory,
        "--manifest-out",
        fixtureManifestPath,
        ...(options.smoke ? ["--smoke"] : [])
      ],
      {
        cwd: root,
        env: createEditorAcceptanceEnvironment(environment),
        maxBuffer: 64 * 1024,
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 120_000,
        windowsHide: true
      }
    );
    const fixtureManifest = validateInstalledFixtureManifest(readBoundedJson(fixtureManifestPath, 64 * 1024));

    const editors = await resolveEditors(options.editors, environment);
    const editorRuns = [];
    for (const editor of editors) {
      editorRuns.push(
        await runEditorPerformanceWithIsolatedDisplay({
          editor,
          stagedVsix: guardedCandidate.path,
          candidate,
          python,
          privateRoot,
          fixtureRoot,
          fixtureManifest,
          environment
        })
      );
    }
    const sourceAfter = readSourceProvenance();
    requireSameSource(sourceAfter, sourceBefore, "during the editor run");
    result = options.smoke
      ? {
          protocol: INSTALLED_RUN_PROTOCOL,
          generatedAtUtc: new Date().toISOString(),
          smoke: true,
          candidate,
          source: sourceAfter,
          fixtureManifest,
          editors: editorRuns
        }
      : buildInstalledPerformanceReport({
          generatedAtUtc: new Date().toISOString(),
          candidate,
          source: sourceAfter,
          fixtureManifest,
          editorRuns
        });
  } catch (error) {
    primaryError = error;
    processTreeUncertain ||= editorProcessTreeMayBeLive(error);
  }

  let cleanupError;
  try {
    cleanupInstalledPerformancePrivateRoot({
      processTreeUncertain,
      receipt: privateRootReceipt
    });
  } catch (error) {
    cleanupError = error;
  }

  const failures = [primaryError, cleanupError].filter((error) => error !== undefined);
  if (failures.length > 0) {
    const error = failures.length === 1 ? failures[0] : new AggregateError(failures, "Installed performance failed.");
    throw new Error(sanitizeEditorAcceptanceDiagnostic(error, privatePaths));
  }
  if (!result) throw new Error("Installed performance completed without a result.");
  if (options.smoke) writeInstalledPerformanceRun(options.output, result);
  else {
    writeInstalledPerformanceReport(options.output, result);
    assertInstalledPerformanceReleaseGate(result);
  }
  return result;
}

export function installedPerformanceDisplayMode(editor, environment = process.env) {
  const explicit = environment.OPEN_WRANGLER_EDITOR_DISPLAY;
  const mode = explicit ?? (editor?.key === "cursor" ? "xvfb" : "headless");
  if (!["headless", "xvfb", "current"].includes(mode)) {
    throw new Error('OPEN_WRANGLER_EDITOR_DISPLAY must be "headless", "xvfb", or "current".');
  }
  return mode;
}

async function runEditorPerformanceWithIsolatedDisplay(options) {
  const mode = installedPerformanceDisplayMode(options.editor, options.environment);
  const environment = { ...options.environment, OPEN_WRANGLER_EDITOR_DISPLAY: mode };
  if (mode === "xvfb" && !environment.OPEN_WRANGLER_XVFB_EXECUTABLE) {
    environment.OPEN_WRANGLER_XVFB_EXECUTABLE = await prepareRepositoryLocalXvfb();
  }
  let display;
  let result;
  let primaryError;
  let processTreeUncertain = false;
  try {
    display = await startIsolatedEditorDisplay({ environment });
    result = await runEditorPerformancePhases({
      ...options,
      environment,
      editorDisplayMode: display.mode
    });
  } catch (error) {
    primaryError = error;
    processTreeUncertain = editorProcessTreeMayBeLive(error);
  }
  let displayError;
  if (display) {
    try {
      await display.stop({ preservePrivateFiles: processTreeUncertain });
    } catch (error) {
      displayError = error;
    }
  }
  const failures = [primaryError, displayError].filter((error) => error !== undefined);
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) {
    throw new AggregateError(failures, `${options.editor.name} performance or display cleanup failed.`);
  }
  if (!result) throw new Error(`${options.editor.name} performance completed without a result.`);
  return result;
}

export async function runInstalledMeasuredEditorPhase({
  phase,
  sampler,
  runPhase,
  spawnOwned = spawnOwnedEditorProcess
}) {
  if (typeof runPhase !== "function" || typeof spawnOwned !== "function") {
    throw new TypeError("Installed performance requires callable phase and process launchers.");
  }
  let phaseError;
  let samplerStartError;
  let samplerEndError;
  let samplerStarted = false;
  const measuredSpawn = (...arguments_) => {
    const child = spawnOwned(...arguments_);
    try {
      sampler.begin(phase, child.pid);
      samplerStarted = true;
    } catch (error) {
      samplerStartError = error;
    }
    return child;
  };
  try {
    await runPhase(measuredSpawn);
  } catch (error) {
    phaseError = error;
  }
  if (samplerStarted) {
    try {
      sampler.end();
    } catch (error) {
      samplerEndError = error;
    }
  } else if (!phaseError && !samplerStartError) {
    samplerEndError = new Error("Installed performance completed an editor phase without attaching RSS sampling.");
  }
  const failures = [phaseError, samplerStartError, samplerEndError].filter((error) => error !== undefined);
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) {
    throw new AggregateError(failures, "Installed performance editor phase or RSS sampling failed.");
  }
}

async function runEditorPerformancePhases({
  editor,
  stagedVsix,
  candidate,
  python,
  privateRoot,
  fixtureRoot,
  fixtureManifest,
  environment,
  editorDisplayMode
}) {
  const profile = mkdtempSync(join(privateRoot, `p-${editor.key.slice(0, 1)}-`));
  const workspace = resolve(profile, "workspace");
  const userData = resolve(profile, "user");
  const extensions = resolve(profile, "extensions");
  const harness = resolve(profile, "harness");
  const harnessVsix = resolve(profile, "harness.vsix");
  prepareEditorWorkspace(workspace, fixtureRoot);
  writeEditorSettings(userData, {
    "window.dialogStyle": "custom",
    "window.menuStyle": "custom",
    "files.simpleDialog.enable": true,
    "extensions.autoCheckUpdates": false,
    "extensions.autoUpdate": false
  });
  writeEditorAcceptanceHarness(harness);
  await createVSIX({
    cwd: harness,
    packagePath: harnessVsix,
    dependencies: false,
    skipLicense: true,
    allowStarActivation: true,
    allowMissingRepository: true
  });

  const sandboxArgs = [
    ...(process.platform === "linux" ? ["--no-sandbox"] : []),
    ...editorDisplayLaunchArgs(process.platform, environment)
  ];
  const editorEnvironment = createEditorAcceptanceEnvironment(environment);
  const identifiedEditor = {
    ...editor,
    version: await readEditorVersion(editor, userData, extensions, sandboxArgs, editorEnvironment)
  };
  for (const [label, extension] of [
    ["Open Wrangler candidate", stagedVsix],
    ["installed-performance harness", harnessVsix]
  ]) {
    await runBoundedEditorCliCommand(
      {
        editor: identifiedEditor,
        args: [
          "--user-data-dir",
          userData,
          "--extensions-dir",
          extensions,
          "--install-extension",
          extension,
          "--force",
          ...sandboxArgs
        ],
        environment: editorEnvironment,
        label: `${identifiedEditor.name} ${label} installation`
      },
      { timeoutMs: 120_000 }
    );
  }
  const { stdout: installed } = await runBoundedEditorCliCommand(
    {
      editor: identifiedEditor,
      args: [
        "--user-data-dir",
        userData,
        "--extensions-dir",
        extensions,
        "--list-extensions",
        "--show-versions",
        ...sandboxArgs
      ],
      environment: editorEnvironment,
      label: `${identifiedEditor.name} installed-extension query`
    },
    { timeoutMs: 60_000 }
  );
  const installedLines = installed
    .split(/\r?\n/u)
    .map((line) => line.trim().toLowerCase())
    .filter(Boolean);
  const expectedCandidate = `${candidate.extensionId}@${candidate.extensionVersion}`.toLowerCase();
  if (!installedLines.includes(expectedCandidate) || !installedLines.includes(EXPECTED_HARNESS)) {
    throw new Error(`${identifiedEditor.name} did not report the exact installed candidate and harness.`);
  }

  const sampler = createInstalledResourceSampler();
  const phases = [];
  for (const phase of INSTALLED_PERFORMANCE_PHASES) {
    const runId = randomUUID();
    const resultPath = resolve(profile, `${phase}-result.json`);
    await runInstalledMeasuredEditorPhase({
      phase,
      sampler,
      runPhase: (spawnProcess) =>
        runEditorAcceptancePhase(
          {
            editor: identifiedEditor,
            workspace,
            userData,
            extensions,
            developmentPaths: [],
            testModule: resolve(root, "dist-test", "test", "extensionHost", "installedPerformance.js"),
            python,
            phase,
            resultPath,
            editorProductVersion: identifiedEditor.version,
            runId,
            progressPath: editorAcceptanceProgressPath(resultPath, runId, phase),
            requiresWorkbenchCdp: true
          },
          { environment, spawnProcess }
        )
    });
    const fragment = validateInstalledPerformancePhase(
      readBoundedJson(resolve(workspace, "results", `${phase}.json`), 256 * 1024),
      { runId, phase }
    );
    const expectedFixture = fixtureManifest.fixtures[fragment.fixture.format];
    if (
      fragment.editor.key !== identifiedEditor.key ||
      fragment.editor.productVersion !== identifiedEditor.version ||
      fragment.fixture.sha256 !== expectedFixture.sha256
    ) {
      throw new Error(`${identifiedEditor.name} ${phase} fragment does not match its installed run.`);
    }
    phases.push(fragment);
  }
  const runtime = phases[0].runtime;
  if (phases.some((phase) => JSON.stringify(phase.runtime) !== JSON.stringify(runtime))) {
    throw new Error(`${identifiedEditor.name} changed Python runtime provenance between performance phases.`);
  }
  const productConfiguration = phases[0].productConfiguration;
  if (phases.some((phase) => JSON.stringify(phase.productConfiguration) !== JSON.stringify(productConfiguration))) {
    throw new Error(`${identifiedEditor.name} changed shipped product configuration between performance phases.`);
  }
  return {
    provenance: {
      editor: phases[0].editor,
      runtime,
      productConfiguration,
      platform: readInstalledPlatformProvenance({ editorDisplayMode }),
      storage: readInstalledStorageProvenance(fixtureRoot)
    },
    resources: sampler.finish(),
    phases
  };
}

function prepareEditorWorkspace(workspace, fixtureRoot) {
  mkdirSync(workspace, { recursive: true, mode: 0o700 });
  cpSync(resolve(fixtureRoot, "fixtures"), resolve(workspace, "fixtures"), {
    recursive: true,
    errorOnExist: true,
    force: false
  });
  cpSync(resolve(fixtureRoot, "performance-fixtures.json"), resolve(workspace, "performance-fixtures.json"), {
    errorOnExist: true,
    force: false
  });
  mkdirSync(resolve(workspace, "benchmarks"), { recursive: true, mode: 0o700 });
  cpSync(
    resolve(root, "python", "benchmarks", "source_cache_control.py"),
    resolve(workspace, "benchmarks", "source_cache_control.py"),
    { errorOnExist: true, force: false }
  );
  mkdirSync(resolve(workspace, "results"), { recursive: true, mode: 0o700 });
  writeFileSync(resolve(workspace, "warmup.csv"), "c00,c01\n0,1\n1,2\n", {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600
  });
}

async function resolveEditors(requested, environment) {
  const candidates = [
    {
      name: "VS Code",
      key: "vscode",
      executable: environment.OPEN_WRANGLER_VSCODE_EXECUTABLE ?? "/usr/share/code/code",
      cli: environment.OPEN_WRANGLER_VSCODE_CLI ?? "/usr/share/code/bin/code",
      sharedDataDir: true
    },
    {
      name: "Cursor",
      key: "cursor",
      executable: environment.OPEN_WRANGLER_CURSOR_EXECUTABLE ?? "/usr/share/cursor/cursor",
      cli: environment.OPEN_WRANGLER_CURSOR_CLI ?? "/usr/share/cursor/bin/cursor",
      sharedDataDir: false
    }
  ].filter((editor) => requested.includes(editor.key) && existsSync(editor.executable) && existsSync(editor.cli));
  if (requested.includes("vscode") && !candidates.some((editor) => editor.key === "vscode")) {
    const executable = await downloadEditorWithRetry(environment.VSCODE_TEST_VERSION ?? "stable");
    const cli = resolveDownloadedEditorCliPath(executable);
    if (!existsSync(cli)) throw new Error("The downloaded VS Code CLI was not found.");
    candidates.unshift({ name: "VS Code", key: "vscode", executable, cli, sharedDataDir: true });
  }
  const missing = requested.filter((key) => !candidates.some((editor) => editor.key === key));
  if (missing.length > 0) {
    throw new Error(
      `Requested installed-performance editor(s) were not found: ${missing.join(", ")}. Configure the corresponding OPEN_WRANGLER_* executable and CLI paths.`
    );
  }
  return requested.map((key) => candidates.find((editor) => editor.key === key));
}

function resolveTestPython(environment) {
  const hosted = environment.pythonLocation
    ? process.platform === "win32"
      ? resolve(environment.pythonLocation, "python.exe")
      : resolve(environment.pythonLocation, "bin", "python")
    : undefined;
  const local =
    process.platform === "win32"
      ? resolve(root, ".venv", "Scripts", "python.exe")
      : resolve(root, ".venv", "bin", "python");
  const python = environment.OPEN_WRANGLER_TEST_PYTHON ?? (hosted && existsSync(hosted) ? hosted : local);
  if (!isAbsolute(python) || !existsSync(python)) {
    throw new Error("Installed performance requires an existing absolute OPEN_WRANGLER_TEST_PYTHON.");
  }
  return python;
}

async function readEditorVersion(editor, userData, extensions, sandboxArgs, environment) {
  const { stdout } = await runBoundedEditorCliCommand(
    {
      editor,
      args: ["--user-data-dir", userData, "--extensions-dir", extensions, "--version", ...sandboxArgs],
      environment,
      label: `${editor.name} version probe`
    },
    { timeoutMs: 30_000 }
  );
  const version = stdout
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .find((line) => /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u.test(line));
  if (!version) throw new Error(`${editor.name} did not report a numeric major.minor.patch version.`);
  return version;
}

function readSourceProvenance() {
  const commit = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 4 * 1024,
    timeout: 10_000
  }).trim();
  const trackedStatus = execFileSync("git", ["status", "--porcelain", "--untracked-files=no"], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 64 * 1024,
    timeout: 10_000
  });
  return { commit, trackedWorktreeDirty: trackedStatus.trim().length > 0 };
}

function requireCleanSource(source, stage) {
  if (!/^[0-9a-f]{40}$/u.test(source?.commit) || source.trackedWorktreeDirty !== false) {
    throw new Error(`Installed performance requires one clean exact HEAD ${stage}.`);
  }
}

function requireSameSource(current, expected, stage) {
  requireCleanSource(current, stage);
  if (current.commit !== expected.commit) {
    throw new Error(`The installed-performance source commit changed ${stage}.`);
  }
}

function runInstalledPerformanceBuild(environment) {
  for (const [script, timeout] of [
    ["clean", 60_000],
    ["build", 180_000],
    ["build:test-extension", 120_000]
  ]) {
    execFileSync("npm", ["run", script], {
      cwd: root,
      env: environment,
      maxBuffer: 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
      timeout,
      windowsHide: true
    });
  }
}

async function createInstalledPerformanceVsix(destination) {
  assertAbsent(destination, "guarded installed-performance candidate");
  await createVSIX({
    cwd: root,
    packagePath: destination,
    preRelease: true,
    allowStarActivation: false,
    allowMissingRepository: false
  });
}

function verifyInstalledPerformanceVsix(candidate, environment) {
  execFileSync(process.execPath, [resolve(root, "scripts", "verify-vsix.mjs"), candidate], {
    cwd: root,
    env: environment,
    maxBuffer: 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 60_000,
    windowsHide: true
  });
}

function readBoundedJson(file, maxBytes) {
  const before = lstatSync(file, { bigint: true });
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    before.nlink !== 1n ||
    before.size <= 0n ||
    before.size > BigInt(maxBytes)
  ) {
    throw new Error("Installed performance produced an invalid bounded JSON file.");
  }
  const contents = readFileSync(file, "utf8");
  const after = lstatSync(file, { bigint: true });
  requireSameRegularFile(after, before, "Installed performance JSON changed while it was read.");
  return JSON.parse(contents);
}

function readVsixPackageJson(vsix) {
  return new Promise((resolvePromise, rejectPromise) => {
    openZip(vsix, { autoClose: true, lazyEntries: true, validateEntrySizes: true }, (openError, archive) => {
      if (openError || !archive) {
        rejectPromise(openError ?? new Error("The installed-performance VSIX could not be opened."));
        return;
      }
      let entries = 0;
      let found = false;
      let settled = false;
      const settle = (error, value) => {
        if (settled) return;
        settled = true;
        archive.close();
        if (error) rejectPromise(error);
        else resolvePromise(value);
      };
      archive.on("error", (error) => settle(error));
      archive.on("entry", (entry) => {
        entries += 1;
        if (entries > VSIX_MAX_ENTRIES) {
          settle(new Error("The installed-performance VSIX exceeded the entry-count limit."));
          return;
        }
        if (entry.fileName !== "extension/package.json") {
          archive.readEntry();
          return;
        }
        if (found || entry.uncompressedSize <= 0 || entry.uncompressedSize > VSIX_PACKAGE_JSON_MAX_BYTES) {
          settle(new Error("The installed-performance VSIX has an invalid package manifest."));
          return;
        }
        found = true;
        archive.openReadStream(entry, (streamError, stream) => {
          if (streamError || !stream) {
            settle(streamError ?? new Error("The installed-performance package manifest could not be read."));
            return;
          }
          const chunks = [];
          let bytes = 0;
          stream.on("data", (chunk) => {
            bytes += chunk.length;
            if (bytes > VSIX_PACKAGE_JSON_MAX_BYTES) {
              stream.destroy(new Error("The installed-performance package manifest exceeded its byte limit."));
              return;
            }
            chunks.push(chunk);
          });
          stream.once("error", (error) => settle(error));
          stream.once("end", () => {
            try {
              settle(undefined, JSON.parse(Buffer.concat(chunks, bytes).toString("utf8")));
            } catch (error) {
              settle(error);
            }
          });
        });
      });
      archive.on("end", () => {
        if (!found) settle(new Error("The installed-performance VSIX is missing extension/package.json."));
      });
      archive.readEntry();
    });
  });
}

function requireSameRegularFile(actual, expected, message) {
  if (
    !actual.isFile() ||
    actual.isSymbolicLink() ||
    actual.nlink !== 1n ||
    actual.dev !== expected.dev ||
    actual.ino !== expected.ino ||
    actual.size !== expected.size
  ) {
    throw new Error(message);
  }
}

function requireSameFileIdentity(actual, expected, message) {
  if (
    !actual.isFile() ||
    actual.isSymbolicLink() ||
    actual.nlink !== 1n ||
    actual.dev !== expected.dev ||
    actual.ino !== expected.ino
  ) {
    throw new Error(message);
  }
}

function removeIdentifiedFile(file, identity) {
  try {
    const current = lstatSync(file, { bigint: true });
    requireSameFileIdentity(current, identity, "Owned temporary cleanup was withheld after an identity change.");
    rmSync(file);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

function assertAbsent(file, label) {
  try {
    lstatSync(file);
    throw new Error(`The ${label} destination must be absent.`);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

function assertReplaceableRegularFile(file, label) {
  try {
    const metadata = lstatSync(file, { bigint: true });
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1n) {
      throw new Error(`The ${label} destination must be absent or a single-link regular file.`);
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  try {
    const options = parseInstalledPerformanceArguments(process.argv.slice(2));
    await runInstalledPerformance(options);
    const relativeOutput = relative(root, options.output);
    const label =
      relativeOutput && relativeOutput !== ".." && !relativeOutput.startsWith(`..${sep}`) && !isAbsolute(relativeOutput)
        ? relativeOutput.replaceAll("\\", "/")
        : "the requested output file";
    console.log(`Installed performance passed; path-free results were written to ${label}.`);
    if (options.smoke) console.log("Smoke-sized fixtures were used; this is not release evidence.");
  } catch (error) {
    console.error(`Installed performance failed: ${sanitizeEditorAcceptanceDiagnostic(error)}`);
    process.exitCode = 1;
  }
}
