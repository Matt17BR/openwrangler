#!/usr/bin/env node

import { createHash, randomUUID } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import {
  captureDataWranglerPreparationFile,
  captureDataWranglerProfileTree,
  createDataWranglerComparisonPreparationReceipt,
  createDataWranglerConfiguredTemplateCapture,
  digestDataWranglerComparisonPythonEnvironment,
  probeDataWranglerComparisonPython,
  queryDataWranglerTemplateInventory,
  loadDataWranglerComparisonPreparationReceipt,
  revalidateDataWranglerComparisonPreparationReceipt,
  writeDataWranglerComparisonPreparationReceipt
} from "./data-wrangler-comparison-preparation.mjs";
import { capturePreparedDataWranglerPublicUi } from "./data-wrangler-comparison-public-capture.mjs";
import {
  createDataWranglerComparisonDriverStudyReceipt,
  packageDataWranglerComparisonDriver,
  proveDataWranglerComparisonJourneyGraph
} from "./data-wrangler-comparison-driver.mjs";
import { captureDataWranglerComparisonEnvironment } from "./data-wrangler-comparison-environment.mjs";
import { createDataWranglerComparisonTemplateInventory } from "./data-wrangler-comparison-inventory.mjs";
import { validateDataWranglerComparisonCanonicalFixtures } from "./data-wrangler-comparison-fixtures.mjs";
import { capturePreparedProductWarmups } from "./data-wrangler-comparison-warmup.mjs";
import {
  buildDataWranglerStudyManifest,
  canonicalStudyJson,
  captureDataWranglerStudyMethodReceipt,
  digestStudyValue,
  writeDataWranglerStudySpecificationExclusive
} from "./data-wrangler-comparison-study.mjs";
import {
  assertCurrentDataWranglerComparisonPreregistration,
  createDataWranglerComparisonPreregistrationReceipt,
  DATA_WRANGLER_COMPARISON_JOURNEY_PATH,
  readDataWranglerComparisonPreregistration
} from "./data-wrangler-comparison-preregistration.mjs";
import { captureDataWranglerComparisonStudyV2Toolchain } from "./data-wrangler-comparison-cache-controller.mjs";
import {
  configureEditorAcceptanceTempRoot,
  createEditorAcceptanceEnvironment,
  sanitizeEditorAcceptanceDiagnostic
} from "./editor-acceptance.mjs";
import { PINNED_REMOTE_WORKSPACE_TARGETS } from "./remote-workspace-acquisition.mjs";
import {
  bootstrapDataWranglerComparisonConfiguredProfiles,
  COMPARISON_CONFIGURED_PROFILES_PROTOCOL,
  createDataWranglerComparisonPrivateRoot
} from "./run-data-wrangler-comparison.mjs";
import { runDataWranglerComparisonStudy } from "./run-data-wrangler-comparison-study.mjs";
import {
  createEditorAcceptancePrivateRootReceipt,
  removeEditorAcceptancePrivateRoot
} from "./packaged-editor-orchestration.mjs";
import { inspectVsixArchive, readBoundedVsixFileSnapshot } from "./vsix-archive.mjs";
import {
  digestLinuxStudySupervisorValue,
  LINUX_STUDY_SUPERVISOR_INVOCATION_POLICY,
  LINUX_STUDY_SUPERVISOR_PROTOCOL
} from "./linux-study-supervisor-client.mjs";
import { requireLinuxInotifyWatchHeadroom } from "./linux-inotify-watch-headroom.mjs";

const SUPERVISOR_PATH = resolve(import.meta.dirname, "linux-study-supervisor.py");
const CACHE_HARNESS_PATH = resolve(import.meta.dirname, "data-wrangler-comparison-cache-controller.mjs");

function fail(message) {
  throw new TypeError(message);
}

function parseArguments(argv, cwd = process.cwd()) {
  const pathFlags = [
    "--preregistration",
    "--candidate",
    "--python",
    "--cache-controller",
    "--csv",
    "--parquet",
    "--specification",
    "--manifest",
    "--preparation"
  ];
  const flags = [...pathFlags, "--cpu-list"];
  const usage = `Usage: npm run comparison:prepare -- ${flags.map((flag) => `${flag} <value>`).join(" ")}`;
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (
      !flags.includes(flag) ||
      values.has(flag) ||
      typeof value !== "string" ||
      value.length === 0 ||
      value.startsWith("--") ||
      /[\0\r\n]/u.test(value)
    ) {
      fail(usage);
    }
    values.set(flag, pathFlags.includes(flag) ? resolve(cwd, value) : value);
  }
  if (values.size !== flags.length) {
    fail(usage);
  }
  return Object.freeze(
    Object.fromEntries(
      flags.map((flag) => [flag.slice(2).replace(/-([a-z])/gu, (_m, c) => c.toUpperCase()), values.get(flag)])
    )
  );
}

function fileIdentity(receipt) {
  return structuredClone(receipt.filesystemIdentity);
}

export async function runDataWranglerComparisonPreparationWatchGate(dependencies) {
  let lease;
  let receipt;
  let runRoot;
  const errors = [];
  try {
    lease = dependencies.createWatchGatePrivateRoot();
    runRoot = lease.privateRoot;
    receipt = dependencies.createPrivateRootReceipt(runRoot, {
      containedBy: lease.privateParent
    });
    lease.revalidate();
  } catch (error) {
    errors.push(error);
  }
  try {
    lease?.close();
  } catch (error) {
    errors.push(error);
  }
  if (errors.length === 0) {
    try {
      await dependencies.requireWatchHeadroom({ runRoot });
    } catch (error) {
      errors.push(error);
    }
  }
  if (receipt !== undefined) {
    try {
      dependencies.removePrivateRoot(receipt);
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) {
    throw new AggregateError(errors, "The comparison preparation watch gate failed or did not clean up.");
  }
}

async function candidateIdentity(path) {
  const snapshot = readBoundedVsixFileSnapshot(path, { requireOwner: true });
  const archive = await inspectVsixArchive(snapshot.bytes);
  const packageJson = JSON.parse(archive.packagedPackageJson);
  if (
    packageJson.publisher !== "Matt17BR" ||
    packageJson.name !== "openwrangler" ||
    typeof packageJson.version !== "string"
  ) {
    fail("Comparison preparation candidate is not the Open Wrangler package.");
  }
  const receipt = captureDataWranglerPreparationFile(path, "Comparison preparation candidate");
  if (receipt.sha256 !== createHash("sha256").update(snapshot.bytes).digest("hex")) {
    fail("Comparison preparation candidate changed during archive inspection.");
  }
  return Object.freeze({ receipt, version: packageJson.version });
}

export function writeDataWranglerComparisonKernelSpec(studyRoot, pythonPath, pythonVersion, studyId = randomUUID()) {
  if (typeof pythonVersion !== "string" || !/^3\.12(?:\.\d+)?$/u.test(pythonVersion)) {
    fail("Comparison preparation kernel requires the probed CPython 3.12 version.");
  }
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(studyId)) {
    fail("Comparison preparation kernel requires its preregistered study UUID.");
  }
  const name = `dataframe-comparison-study-${studyId.replaceAll("-", "").toLowerCase()}`;
  const jupyterRoot = resolve(studyRoot, "jupyter");
  const environment = {
    dataDir: resolve(jupyterRoot, "data"),
    runtimeDir: resolve(jupyterRoot, "runtime"),
    configDir: resolve(jupyterRoot, "config"),
    path: resolve(jupyterRoot, "path")
  };
  const kernelDirectory = resolve(environment.dataDir, "kernels", name);
  for (const directory of [...Object.values(environment), kernelDirectory]) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    chmodSync(directory, 0o700);
  }
  const displayName = `Dataframe comparison study CPython ${pythonVersion} (private trial)`;
  const path = resolve(kernelDirectory, "kernel.json");
  const value = {
    argv: [pythonPath, "-I", "-Xfrozen_modules=off", "-m", "ipykernel_launcher", "-f", "{connection_file}"],
    display_name: displayName,
    language: "python",
    metadata: { debugger: false }
  };
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
  const receipt = captureDataWranglerPreparationFile(path, "Comparison preparation kernelspec");
  return Object.freeze({ path, name, displayName, environment, sha256: receipt.sha256 });
}

function editorAcquisitionRoot(studyRoot, editor) {
  const relativeExecutable = relative(studyRoot, editor.executable);
  const first = relativeExecutable.split(sep)[0];
  if (first.length === 0 || first === ".." || relativeExecutable.startsWith(`..${sep}`)) {
    fail("Comparison preparation editor is not inside its retained study root.");
  }
  return resolve(studyRoot, first);
}

function expectedExtensions(specification, candidateVersion, product) {
  const measured =
    product === "open-wrangler"
      ? { extensionId: "Matt17BR.openwrangler", version: candidateVersion }
      : { extensionId: "ms-toolsai.datawrangler", version: "1.24.2" };
  return createDataWranglerComparisonTemplateInventory(measured);
}

function assertTemplateInventory(actual, expected) {
  const normalize = (entries) => entries.map((entry) => `${entry.extensionId.toLowerCase()}@${entry.version}`).sort();
  const observed = normalize(actual);
  const required = normalize(expected);
  if (observed.length !== required.length || observed.some((entry, index) => entry !== required[index])) {
    fail("Comparison preparation profile does not contain its exact product extension inventory.");
  }
}

function updateFixture(specification, format, receipt) {
  const fixture = specification.fixtures.find((entry) => entry.format === format);
  if (fixture === undefined) fail(`Comparison preparation specification has no ${format} fixture.`);
  fixture.sha256 = receipt.sha256;
  fixture.filesystemIdentity = fileIdentity(receipt);
}

function assertPrivateOutputParent(path) {
  const parent = dirname(path);
  const metadata = lstatSync(parent, { bigint: true });
  if (
    realpathSync(parent) !== parent ||
    !metadata.isDirectory() ||
    metadata.isSymbolicLink() ||
    (metadata.mode & 0o777n) !== 0o700n ||
    (typeof process.getuid === "function" && metadata.uid !== BigInt(process.getuid()))
  ) {
    fail("Comparison preparation output parent must be one owned mode-0700 directory.");
  }
  return Object.freeze({
    path: parent,
    device: metadata.dev.toString(),
    inode: metadata.ino.toString(),
    owner: metadata.uid.toString(),
    mode: Number(metadata.mode & 0o777n)
  });
}

function assertPrivateArtifactRoot(parent, path) {
  const currentParent = assertPrivateOutputParent(resolve(parent.path, "specification.json"));
  const relativePath = relative(parent.path, path);
  const metadata = lstatSync(path, { bigint: true });
  if (
    currentParent.device !== parent.device ||
    currentParent.inode !== parent.inode ||
    currentParent.owner !== parent.owner ||
    currentParent.mode !== parent.mode ||
    resolve(path) !== path ||
    realpathSync(path) !== path ||
    relativePath.length === 0 ||
    relativePath === ".." ||
    relativePath.startsWith(`..${sep}`) ||
    !metadata.isDirectory() ||
    metadata.isSymbolicLink() ||
    (metadata.mode & 0o777n) !== 0o700n ||
    (typeof process.getuid === "function" && metadata.uid !== BigInt(process.getuid()))
  ) {
    fail("Comparison preparation driver root must be one private directory inside the output parent.");
  }
  return path;
}

function specificationFromPreregistration(preregistration) {
  return {
    studyId: preregistration.studyId,
    createdAtUtc: preregistration.createdAtUtc,
    preregistration: createDataWranglerComparisonPreregistrationReceipt(preregistration),
    method: structuredClone(preregistration.method),
    candidate: {
      extensionId: preregistration.design.candidate.extensionId,
      version: preregistration.design.candidate.version,
      sha256: "",
      filesystemIdentity: null
    },
    baseline: structuredClone(preregistration.design.baseline),
    editor: {
      id: preregistration.design.editor.id,
      version: "",
      sha256: "",
      uiLocale: preregistration.design.editor.uiLocale
    },
    python: null,
    fixtures: preregistration.design.fixtures.map((fixture) => ({
      ...structuredClone(fixture),
      sha256: "",
      filesystemIdentity: null
    })),
    provenance: {
      machine: null,
      cpu: null,
      power: null,
      storage: null,
      display: structuredClone(preregistration.design.environment.display),
      zoom: structuredClone(preregistration.design.environment.zoom),
      commonExtensions: structuredClone(preregistration.design.environment.commonExtensions),
      comparisonDriver: null,
      cacheToolchain: null,
      fixtureToolchain: null,
      templates: [],
      capabilities: [],
      controlProfile: null,
      ownershipTracker: null
    }
  };
}

function ownershipTrackerReceipt({ python, pythonFile, supervisorFile }) {
  return {
    protocol: LINUX_STUDY_SUPERVISOR_PROTOCOL,
    supervisorSource: {
      sha256: supervisorFile.sha256,
      filesystemIdentity: fileIdentity(supervisorFile)
    },
    pythonExecutable: {
      implementation: python.implementation,
      version: python.version,
      sha256: pythonFile.sha256,
      filesystemIdentity: fileIdentity(pythonFile)
    },
    invocationPolicySha256: digestLinuxStudySupervisorValue(LINUX_STUDY_SUPERVISOR_INVOCATION_POLICY)
  };
}

function pathExists(path) {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

function isCanonicalBootstrapPath(value) {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    isAbsolute(value) &&
    resolve(value) === value &&
    !/[\0\r\n]/u.test(value)
  );
}

function isStrictBootstrapDescendant(parent, value) {
  const relativePath = relative(parent, value);
  return (
    relativePath.length > 0 &&
    relativePath !== ".." &&
    !relativePath.startsWith(`..${sep}`) &&
    !isAbsolute(relativePath)
  );
}

export function validateDataWranglerComparisonConfiguredProfilesBootstrap(bootstrap, candidateSha256) {
  const profiles = bootstrap?.profiles;
  const editor = bootstrap?.editor;
  if (
    bootstrap?.protocol !== COMPARISON_CONFIGURED_PROFILES_PROTOCOL ||
    !/^[0-9a-f]{64}$/u.test(candidateSha256 ?? "") ||
    bootstrap.candidateSha256 !== candidateSha256 ||
    !isCanonicalBootstrapPath(bootstrap.studyRoot) ||
    !editor ||
    editor.name !== "VS Code" ||
    editor.key !== "vscode" ||
    editor.sharedDataDir !== true ||
    !isCanonicalBootstrapPath(editor.executable) ||
    !isCanonicalBootstrapPath(editor.cli) ||
    !isStrictBootstrapDescendant(bootstrap.studyRoot, editor.executable) ||
    !isStrictBootstrapDescendant(bootstrap.studyRoot, editor.cli) ||
    typeof editor.version !== "string" ||
    !/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u.test(editor.version) ||
    !Array.isArray(profiles) ||
    profiles.length !== 2 ||
    profiles[0]?.product !== "open-wrangler" ||
    profiles[1]?.product !== "data-wrangler" ||
    profiles.some(
      (profile) =>
        !profile ||
        profile.kind !== "configured-only" ||
        profile.configuredPythonProcessObservedDuringSetup !== true ||
        !isCanonicalBootstrapPath(profile.privateRoot) ||
        !isCanonicalBootstrapPath(profile.userData) ||
        !isCanonicalBootstrapPath(profile.extensions) ||
        !isStrictBootstrapDescendant(bootstrap.studyRoot, profile.privateRoot) ||
        profile.userData !== resolve(profile.privateRoot, "user") ||
        profile.extensions !== resolve(profile.privateRoot, "extensions") ||
        !Array.isArray(profile.sandboxArgs) ||
        profile.sandboxArgs.some((argument) => typeof argument !== "string" || /[\0\r\n]/u.test(argument)) ||
        !Array.isArray(profile.installedExtensions) ||
        !/^[0-9a-f]{64}$/u.test(profile.settingsSha256 ?? "") ||
        !profile.editor ||
        profile.editor.name !== editor.name ||
        profile.editor.key !== editor.key ||
        profile.editor.sharedDataDir !== editor.sharedDataDir ||
        profile.editor.executable !== editor.executable ||
        profile.editor.cli !== editor.cli ||
        profile.editor.version !== editor.version
    )
  ) {
    fail("Comparison preparation configured-profile bootstrap is malformed or mis-correlated.");
  }
  return bootstrap;
}

function planArguments(options) {
  return [
    "plan",
    "--spec",
    options.specification,
    "--out",
    options.manifest,
    "--preregistration",
    options.preregistration,
    "--preparation",
    options.preparation,
    "--cache-controller",
    options.cacheController,
    "--python",
    options.python
  ];
}

function assertPreparationTargets(receipt, options, preregistration) {
  if (
    receipt.preregistrationPath !== options.preregistration ||
    receipt.preregistrationSha256 !== digestStudyValue(preregistration) ||
    receipt.specificationPath !== options.specification ||
    receipt.manifestPath !== options.manifest
  ) {
    fail("Comparison preparation journal belongs to another preregistration or publication target.");
  }
}

export async function publishDataWranglerComparisonPreparationTransaction(
  { options, preregistration, receipt },
  { writeReceipt, writeStudySpecification, plan, publicationBoundary = () => undefined, cwd = process.cwd() }
) {
  assertPreparationTargets(receipt, options, preregistration);
  const preparationPublication = writeReceipt(options.preparation, receipt);
  await publicationBoundary("preparation", receipt);
  const specificationPublication = writeStudySpecification(options.specification, receipt.specification);
  await publicationBoundary("specification", receipt);
  const planned = plan(planArguments(options), { cwd });
  if (digestStudyValue(planned.output) !== receipt.manifestSha256) {
    fail("Comparison preparation planner did not publish the manifest authorized by its journal.");
  }
  await publicationBoundary("manifest", receipt);
  return Object.freeze({
    command: "prepare",
    specification: receipt.specification,
    specificationReceipt: specificationPublication,
    manifest: planned.output,
    manifestReceipt: planned.receipt,
    preparation: receipt,
    preparationReceipt: preparationPublication
  });
}

export async function prepareDataWranglerComparisonStudy(options, environment = process.env, overrides = {}) {
  const dependencies = {
    bootstrapConfiguredProfiles: bootstrapDataWranglerComparisonConfiguredProfiles,
    queryInventory: queryDataWranglerTemplateInventory,
    captureTree: captureDataWranglerProfileTree,
    candidateIdentity,
    probePython: probeDataWranglerComparisonPython,
    captureFile: captureDataWranglerPreparationFile,
    writeStudySpecification: writeDataWranglerStudySpecificationExclusive,
    captureCacheToolchain: captureDataWranglerComparisonStudyV2Toolchain,
    captureMethodology: captureDataWranglerStudyMethodReceipt,
    validateFixtures: validateDataWranglerComparisonCanonicalFixtures,
    plan: runDataWranglerComparisonStudy,
    createReceipt: createDataWranglerComparisonPreparationReceipt,
    writeReceipt: writeDataWranglerComparisonPreparationReceipt,
    loadReceipt: loadDataWranglerComparisonPreparationReceipt,
    revalidateReceipt: revalidateDataWranglerComparisonPreparationReceipt,
    capturePublicUi: capturePreparedDataWranglerPublicUi,
    captureWarmups: capturePreparedProductWarmups,
    readPreregistration: readDataWranglerComparisonPreregistration,
    assertCurrentPreregistration: assertCurrentDataWranglerComparisonPreregistration,
    packageDriver: packageDataWranglerComparisonDriver,
    createDriverStudyReceipt: createDataWranglerComparisonDriverStudyReceipt,
    proveJourneyGraph: proveDataWranglerComparisonJourneyGraph,
    createArtifactRoot: (parent) => mkdtempSync(resolve(parent, ".comparison-driver-")),
    captureEnvironment: captureDataWranglerComparisonEnvironment,
    createWatchGatePrivateRoot: createDataWranglerComparisonPrivateRoot,
    createPrivateRootReceipt: createEditorAcceptancePrivateRootReceipt,
    removePrivateRoot: removeEditorAcceptancePrivateRoot,
    requireWatchHeadroom: requireLinuxInotifyWatchHeadroom,
    buildManifest: buildDataWranglerStudyManifest,
    pathExists,
    publicationBoundary: () => undefined,
    ...overrides
  };
  const preregistration = dependencies.readPreregistration(options.preregistration);
  dependencies.assertCurrentPreregistration(
    preregistration,
    { journeyPath: DATA_WRANGLER_COMPARISON_JOURNEY_PATH },
    { proveJourneyGraph: dependencies.proveJourneyGraph }
  );
  const cacheHarness = dependencies.captureFile(
    CACHE_HARNESS_PATH,
    "Comparison preparation source-cache JavaScript harness"
  );
  const cacheController = dependencies.captureFile(
    options.cacheController,
    "Comparison preparation source-cache Python controller"
  );
  if (
    cacheHarness.sha256 !== preregistration.toolRecipes.cacheHarnessSha256 ||
    cacheController.sha256 !== preregistration.toolRecipes.cachePythonControllerSha256
  ) {
    fail("Comparison preparation source-cache harness or Python controller changed after preregistration.");
  }
  const cacheToolchain = dependencies.captureCacheToolchain({
    controllerPath: options.cacheController,
    pythonExecutablePath: options.python
  });
  if (cacheToolchain.controller.sha256 !== preregistration.toolRecipes.cachePythonControllerSha256) {
    fail("Comparison preparation source-cache toolchain does not use the preregistered Python controller.");
  }
  if (dependencies.pathExists(options.preparation)) {
    const receipt = dependencies.loadReceipt(options.preparation);
    assertPreparationTargets(receipt, options, preregistration);
    await dependencies.revalidateReceipt(receipt);
    const manifest = dependencies.buildManifest(receipt.specification);
    if (digestStudyValue(manifest) !== receipt.manifestSha256) {
      fail("Comparison preparation journal does not reconstruct its authorized manifest.");
    }
    return publishDataWranglerComparisonPreparationTransaction(
      { options, preregistration, receipt },
      {
        writeReceipt: dependencies.writeReceipt,
        writeStudySpecification: dependencies.writeStudySpecification,
        plan: dependencies.plan,
        publicationBoundary: dependencies.publicationBoundary
      }
    );
  }
  const outputParent = assertPrivateOutputParent(options.specification);
  await runDataWranglerComparisonPreparationWatchGate(dependencies);
  const specification = specificationFromPreregistration(preregistration);
  specification.provenance.cacheToolchain = structuredClone(cacheToolchain);
  const observedMethod = dependencies.captureMethodology();
  if (canonicalStudyJson(observedMethod) !== canonicalStudyJson(preregistration.method)) {
    fail("Comparison preparation methodology changed after preregistration.");
  }
  specification.method = structuredClone(observedMethod);
  const artifacts = dependencies.createArtifactRoot(outputParent.path);
  const artifactRoot = assertPrivateArtifactRoot(outputParent, artifacts);
  const driverDirectory = resolve(artifactRoot, "driver");
  const driverVsixPath = resolve(artifactRoot, "notebook-comparison-driver.vsix");
  const packaged = await dependencies.packageDriver({
    directory: driverDirectory,
    testModule: DATA_WRANGLER_COMPARISON_JOURNEY_PATH,
    vsixPath: driverVsixPath
  });
  const driverReceipt = dependencies.createDriverStudyReceipt(packaged);
  if (
    canonicalStudyJson(driverReceipt.journeyGraph) !== canonicalStudyJson(preregistration.driverRecipe.journeyGraph) ||
    driverReceipt.runtimeDependencies.playwrightCore.version !== preregistration.driverRecipe.playwrightCore.version ||
    driverReceipt.runtimeDependencies.playwrightCore.lockIntegrity !==
      preregistration.driverRecipe.playwrightCore.lockIntegrity
  ) {
    fail("Comparison preparation driver does not match the reviewed preregistration recipe.");
  }
  specification.provenance.comparisonDriver = structuredClone(driverReceipt);
  const candidate = await dependencies.candidateIdentity(options.candidate);
  if (candidate.version !== preregistration.design.candidate.version) {
    fail("Comparison preparation candidate version does not match the preregistration.");
  }
  const python = dependencies.probePython(options.python);
  const bootstrap = await dependencies.bootstrapConfiguredProfiles(
    { candidate: options.candidate, python: options.python },
    environment
  );
  validateDataWranglerComparisonConfiguredProfilesBootstrap(bootstrap, candidate.receipt.sha256);
  const studyRoot = bootstrap.studyRoot;
  const identifiedEditor = bootstrap.editor;
  const templateCapture = createDataWranglerConfiguredTemplateCapture(studyRoot);
  for (const profile of bootstrap.profiles) await templateCapture.capture(profile);
  const configuredTemplates = templateCapture.values();
  const profileEnvironment = createEditorAcceptanceEnvironment(environment, {
    OPEN_WRANGLER_EDITOR_DISPLAY: "headless",
    OPEN_WRANGLER_EDITOR_TEMP_ROOT: studyRoot
  });
  configureEditorAcceptanceTempRoot(studyRoot, profileEnvironment);
  const templateTrees = new Map();
  for (const product of ["open-wrangler", "data-wrangler"]) {
    const template = configuredTemplates.find((entry) => entry.product === product && entry.kind === "configured-only");
    const inventory = await dependencies.queryInventory(template, identifiedEditor, profileEnvironment);
    assertTemplateInventory(inventory, expectedExtensions(specification, candidate.version, product));
    templateTrees.set(
      `${product}:configured-only`,
      dependencies.captureTree(template.root, `Comparison ${product} configured template`, template.inventory)
        .treeSha256
    );
  }
  const pythonFile = dependencies.captureFile(options.python, "Comparison preparation Python", { executable: true });
  const ipykernel = python.packages.find((entry) => entry.name === "ipykernel");
  const kernel = writeDataWranglerComparisonKernelSpec(
    studyRoot,
    options.python,
    python.version,
    preregistration.studyId
  );
  const jupyterState = Object.entries(kernel.environment)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([name, root]) => ({ name, ...dependencies.captureTree(root) }));
  specification.candidate = {
    extensionId: "Matt17BR.openwrangler",
    version: candidate.version,
    sha256: candidate.receipt.sha256,
    filesystemIdentity: fileIdentity(candidate.receipt)
  };
  specification.baseline = { extensionId: "ms-toolsai.datawrangler", version: "1.24.2" };
  specification.editor = {
    id: "Microsoft.VisualStudioCode",
    version: identifiedEditor.version,
    sha256: PINNED_REMOTE_WORKSPACE_TARGETS.vscode.wireSha256,
    uiLocale: "en"
  };
  specification.python = {
    implementation: python.implementation,
    version: python.version,
    executableSha256: pythonFile.sha256,
    environmentSha256: digestDataWranglerComparisonPythonEnvironment({
      implementation: python.implementation,
      version: python.version,
      executableSha256: pythonFile.sha256,
      packages: python.packages,
      kernelspecSha256: kernel.sha256,
      jupyter: jupyterState
    }),
    packages: python.packages.map((entry) => ({ ...entry })),
    kernel: {
      implementation: "ipykernel",
      version: ipykernel.version,
      kernelspecName: kernel.name,
      kernelspecSha256: kernel.sha256
    }
  };
  const fixtureValidation = dependencies.validateFixtures({
    pythonPath: options.python,
    privateRoot: studyRoot,
    fixtures: specification.fixtures.map((fixture) => ({
      id: fixture.id,
      format: fixture.format,
      rows: fixture.rows,
      columns: fixture.columns,
      path: fixture.format === "csv" ? options.csv : options.parquet
    }))
  });
  specification.provenance.fixtureToolchain = fixtureValidation.toolchain;
  if (
    fixtureValidation.toolchain.generatorSha256 !== preregistration.toolRecipes.fixtureGeneratorSha256 ||
    fixtureValidation.toolchain.contractSha256 !== preregistration.toolRecipes.fixtureContractSha256
  ) {
    fail("Comparison preparation fixture tools changed after preregistration.");
  }
  for (const fixture of fixtureValidation.fixtures) updateFixture(specification, fixture.format, fixture);
  const environmentInputs = {
    cpuList: options.cpuList,
    display: preregistration.design.environment.display,
    zoom: preregistration.design.environment.zoom
  };
  const observedEnvironment = dependencies.captureEnvironment({
    ...environmentInputs,
    fixturePath: options.csv
  });
  const parquetEnvironment = dependencies.captureEnvironment({
    ...environmentInputs,
    fixturePath: options.parquet
  });
  if (canonicalStudyJson(observedEnvironment) !== canonicalStudyJson(parquetEnvironment)) {
    fail("Comparison preparation fixtures are not on one stable study machine and volume.");
  }
  for (const key of ["machine", "cpu", "power", "storage", "display", "zoom"]) {
    specification.provenance[key] = structuredClone(observedEnvironment[key]);
  }
  const supervisorFile = dependencies.captureFile(SUPERVISOR_PATH, "Comparison preparation process supervisor");
  const tracker = ownershipTrackerReceipt({ python, pythonFile, supervisorFile });
  if (
    supervisorFile.sha256 !== preregistration.toolRecipes.supervisorSourceSha256 ||
    tracker.invocationPolicySha256 !== preregistration.toolRecipes.supervisorInvocationPolicySha256 ||
    tracker.protocol !== preregistration.toolRecipes.supervisorProtocol
  ) {
    fail("Comparison preparation process supervisor changed after preregistration.");
  }
  specification.provenance.ownershipTracker = tracker;
  const warmups = await dependencies.captureWarmups(
    {
      specification,
      templates: configuredTemplates,
      templateTrees,
      studyRoot,
      editor: identifiedEditor,
      pythonPath: options.python,
      kernel,
      fixturePath: options.csv,
      driverDirectory,
      driverVsixPath
    },
    profileEnvironment
  );
  const templates = Object.freeze([...configuredTemplates, ...warmups.templates]);
  const warmupByProduct = new Map(warmups.provenance.map((entry) => [entry.product, entry]));
  for (const template of warmups.templates) {
    templateTrees.set(`${template.product}:warmed`, template.treeSha256);
  }
  const templateProvenance = ["open-wrangler", "data-wrangler"].map((product) => {
    const warmup = warmupByProduct.get(product);
    if (warmup === undefined) fail(`Comparison preparation omitted the ${product} public warm-up receipt.`);
    return {
      product,
      configuredOnlyReceiptSha256: templateTrees.get(`${product}:configured-only`),
      warmedReceiptSha256: templateTrees.get(`${product}:warmed`),
      warmupReceiptSha256: warmup.receiptSha256,
      warmupReceipt: structuredClone(warmup.receipt),
      publicConfigurationCompleted: true,
      publicWarmupCompleted: true,
      targetStateAbsent: true
    };
  });
  specification.provenance.templates = templateProvenance;
  const publicUi = await dependencies.capturePublicUi(
    {
      specification,
      templates,
      templateTrees,
      studyRoot,
      editor: identifiedEditor,
      pythonPath: options.python,
      kernel,
      fixturePaths: { csv: options.csv, parquet: options.parquet },
      driverDirectory,
      driverVsixPath
    },
    profileEnvironment
  );
  specification.provenance.capabilities = publicUi.capabilities.map((entry) => structuredClone(entry));
  specification.provenance.controlProfile = structuredClone(publicUi.controlProfile);
  const manifest = dependencies.buildManifest(specification);
  const installationRoot = editorAcquisitionRoot(studyRoot, identifiedEditor);
  const receipt = await dependencies.createReceipt({
    preregistrationPath: options.preregistration,
    preregistration,
    specificationPath: options.specification,
    specification,
    manifest,
    manifestPath: options.manifest,
    studyRoot,
    candidatePath: options.candidate,
    editor: {
      installationRoot,
      executable: identifiedEditor.executable,
      cli: identifiedEditor.cli
    },
    pythonPath: options.python,
    cacheControllerPath: options.cacheController,
    driverDirectory,
    driverVsixPath,
    fixturePaths: { csv: options.csv, parquet: options.parquet },
    kernelspecPath: kernel.path,
    templates,
    publicUiCaptures: publicUi.bindings,
    createdAtUtc: preregistration.createdAtUtc
  });
  return publishDataWranglerComparisonPreparationTransaction(
    { options, preregistration, receipt },
    {
      writeReceipt: dependencies.writeReceipt,
      writeStudySpecification: dependencies.writeStudySpecification,
      plan: dependencies.plan,
      publicationBoundary: dependencies.publicationBoundary
    }
  );
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const result = await prepareDataWranglerComparisonStudy(options);
  process.stdout.write(
    canonicalStudyJson({
      command: result.command,
      specificationSha256: digestStudyValue(result.specification),
      manifestSha256: digestStudyValue(result.manifest),
      preparationSha256: digestStudyValue(result.preparation)
    })
  );
}

export function describeDataWranglerComparisonPreparationFailure(error) {
  return sanitizeEditorAcceptanceDiagnostic(error);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    process.stderr.write(`${describeDataWranglerComparisonPreparationFailure(error)}\n`);
    process.exitCode = 1;
  });
}

export { parseArguments as parseDataWranglerComparisonPreparationArguments };
