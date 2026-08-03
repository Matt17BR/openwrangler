import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
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
  readdirSync,
  readSync,
  realpathSync,
  writeFileSync
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import {
  PINNED_JUPYTER_EXTENSION_ID,
  PINNED_PYTHON_EXTENSION_ID,
  configureEditorAcceptanceTempRoot,
  createEditorAcceptanceEnvironment,
  editorAcceptanceProgressPath,
  editorDisplayLaunchArgs,
  editorProcessTreeMayBeLive,
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
  buildDataWranglerComparisonSmokeReport,
  COMPARISON_PHASE_PROTOCOL,
  DATA_WRANGLER_BASELINE_VERSION,
  validateDataWranglerComparisonPhase
} from "./data-wrangler-comparison-report.mjs";
import { validateInstalledFixtureManifest } from "./installed-performance-report.mjs";
import {
  createEditorAcceptancePrivateRootReceipt,
  removeEditorAcceptancePrivateRoot
} from "./packaged-editor-orchestration.mjs";
import { acquirePinnedVSCodeClient } from "./remote-workspace-acquisition.mjs";
import {
  readBoundedJson,
  readInstalledPerformanceFragment,
  revalidateInstalledPerformanceVsix,
  stageInstalledPerformanceVsix
} from "./run-installed-performance.mjs";
import { requireLinuxInotifyWatchHeadroom } from "./linux-inotify-watch-headroom.mjs";

const root = resolve(import.meta.dirname, "..");
const COMPARISON_FRAGMENT_MAX_BYTES = 16 * 1024;
const COMPARISON_REPORT_MAX_BYTES = 1024 * 1024;
const EXTENSION_LIST_MAX_BYTES = 64 * 1024;
const NUMERIC_VERSION = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:[-+][0-9A-Za-z.-]+)?$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const PYTHON_VERSION = /^3\.(?:10|11|12|13|14)(?:\.\d+)?(?:[-+][0-9A-Za-z.-]+)?$/u;
const PACKAGE_VERSION = /^[0-9A-Za-z](?:[0-9A-Za-z._+-]{0,126}[0-9A-Za-z])?$/u;
const COMPARISON_RUN_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const INSTALLED_EXTENSION =
  /^([A-Za-z0-9][A-Za-z0-9-]{0,63}\.[A-Za-z0-9][A-Za-z0-9-]{0,127})@([0-9A-Za-z][0-9A-Za-z._+-]{0,127})$/u;
const PROC_FILE_MAX_BYTES = 64 * 1024;
const PROC_ENTRY_LIMIT = 32_768;
const PROCESS_SHAPE_LIMIT = 8;
const PROCESS_SHAPE_ARGUMENT_LIMIT = 12;
const comparisonInputReceipts = new WeakSet();
const comparisonProductEditorPhasePlans = new WeakSet();

export const COMPARISON_PRODUCT_FRAGMENT_PROTOCOL = "openwrangler-comparison-product-fragment-v1";
export const COMPARISON_CONFIGURED_PROFILES_PROTOCOL = "openwrangler-comparison-configured-profiles-v1";
export const DATA_WRANGLER_MARKETPLACE_EXTENSION = `ms-toolsai.datawrangler@${DATA_WRANGLER_BASELINE_VERSION}`;
export const COMPARISON_TEST_PHASES = Object.freeze({
  "open-wrangler": "comparison-open-wrangler",
  "data-wrangler": "comparison-data-wrangler"
});
export const DATA_WRANGLER_FIRST_USE_SETUP_PHASE = "comparison-data-wrangler-setup";
export const OPEN_WRANGLER_FIRST_USE_SETUP_PHASE = "comparison-open-wrangler-setup";
export const COMPARISON_COMMON_EXTENSION_LOCK = Object.freeze([
  "ms-python.debugpy@2026.6.0",
  PINNED_PYTHON_EXTENSION_ID,
  "ms-python.vscode-pylance@2026.3.1",
  "ms-python.vscode-python-envs@1.36.0",
  PINNED_JUPYTER_EXTENSION_ID,
  "ms-toolsai.jupyter-keymap@1.1.2",
  "ms-toolsai.jupyter-renderers@1.3.0",
  "ms-toolsai.vscode-jupyter-cell-tags@0.1.9",
  "ms-toolsai.vscode-jupyter-slideshow@0.1.6"
]);

const PRODUCT_INSTALLS = Object.freeze({
  "open-wrangler": Object.freeze([...COMPARISON_COMMON_EXTENSION_LOCK, "candidate"]),
  "data-wrangler": Object.freeze([...COMPARISON_COMMON_EXTENSION_LOCK, DATA_WRANGLER_MARKETPLACE_EXTENSION])
});

export function parseDataWranglerComparisonArguments(arguments_, environment = process.env, cwd = process.cwd()) {
  if (!Array.isArray(arguments_)) {
    throw new TypeError("Comparison runner arguments must be an array.");
  }
  const values = new Map();
  for (let index = 0; index < arguments_.length; index += 1) {
    const flag = arguments_[index];
    if (!["--candidate", "--python", "--out"].includes(flag)) {
      throw new Error(`Unknown comparison runner argument ${JSON.stringify(flag)}.`);
    }
    if (values.has(flag)) {
      throw new Error(`Comparison runner argument ${flag} may be supplied only once.`);
    }
    const value = arguments_[index + 1];
    if (typeof value !== "string" || value.length === 0 || value.startsWith("--") || /[\0\r\n]/u.test(value)) {
      throw new Error(`Comparison runner argument ${flag} requires one path.`);
    }
    values.set(flag, value);
    index += 1;
  }

  const candidate = values.get("--candidate");
  if (!candidate) {
    throw new Error("Comparison runner requires --candidate <Open Wrangler VSIX>.");
  }
  const python =
    values.get("--python") ?? environment.OPEN_WRANGLER_TEST_PYTHON ?? resolve(root, ".venv", "bin", "python");
  if (!isAbsolute(python) || /[\0\r\n]/u.test(python)) {
    throw new Error("Comparison runner Python must be an absolute path.");
  }

  const options = Object.freeze({
    candidate: resolve(cwd, candidate),
    python: resolve(python),
    output: resolve(cwd, values.get("--out") ?? join("tmp", "comparison", "data-wrangler-smoke.json"))
  });
  assertComparisonPathSeparation(options);
  return options;
}

export function captureComparisonInputFile(file, { label, executable = false } = {}) {
  if (
    typeof file !== "string" ||
    !isAbsolute(file) ||
    /[\0\r\n]/u.test(file) ||
    typeof label !== "string" ||
    label.length === 0 ||
    label.length > 128 ||
    /[\0\r\n]/u.test(label) ||
    typeof executable !== "boolean"
  ) {
    throw new TypeError("Comparison input capture requires one absolute file, bounded label, and executable flag.");
  }
  const path = resolve(file);
  const snapshot = readComparisonInputSnapshot(path, {
    label,
    executable
  });
  const receipt = Object.freeze({
    path,
    canonicalPath: snapshot.canonicalPath,
    label,
    executable,
    metadata: snapshot.metadata
  });
  comparisonInputReceipts.add(receipt);
  return receipt;
}

export function revalidateComparisonInputFile(receipt) {
  if (!comparisonInputReceipts.has(receipt)) {
    throw new Error("Comparison input revalidation requires an authentic captured receipt.");
  }
  const current = readComparisonInputSnapshot(receipt.path, {
    label: receipt.label,
    executable: receipt.executable
  });
  if (current.canonicalPath !== receipt.canonicalPath || !sameInputMetadata(current.metadata, receipt.metadata)) {
    throw new Error(`${receipt.label} changed after its identity was captured.`);
  }
  return receipt;
}

export function parseInstalledComparisonExtensions(stdout, productKey) {
  requireProductKey(productKey);
  if (typeof stdout !== "string" || Buffer.byteLength(stdout, "utf8") > EXTENSION_LIST_MAX_BYTES) {
    throw new Error("The installed-extension inventory is absent or oversized.");
  }
  const extensions = stdout
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const match = INSTALLED_EXTENSION.exec(line);
      if (!match) {
        throw new Error("The official VS Code CLI returned a malformed installed-extension inventory.");
      }
      return `${match[1].toLowerCase()}@${match[2]}`;
    })
    .sort();
  if (extensions.length === 0 || extensions.length > 64 || new Set(extensions).size !== extensions.length) {
    throw new Error("The installed-extension inventory must contain between 1 and 64 unique entries.");
  }

  const productEntries = extensions.filter((entry) =>
    entry.startsWith(productKey === "open-wrangler" ? "matt17br.openwrangler@" : "ms-toolsai.datawrangler@")
  );
  const productEntry =
    productKey === "open-wrangler"
      ? productEntries.length === 1
        ? productEntries[0]
        : undefined
      : DATA_WRANGLER_MARKETPLACE_EXTENSION;
  const expected = [...COMPARISON_COMMON_EXTENSION_LOCK.map((entry) => entry.toLowerCase()), productEntry].sort();
  if (
    productEntry === undefined ||
    productEntries.length !== 1 ||
    extensions.length !== expected.length ||
    extensions.some((entry, index) => entry !== expected[index])
  ) {
    throw new Error(`${productKey} did not report its exact locked comparison extension inventory.`);
  }
  return Object.freeze(extensions);
}

export function installedComparisonProductVersion(installedExtensions, productKey) {
  requireProductKey(productKey);
  if (!Array.isArray(installedExtensions)) {
    throw new TypeError("Installed comparison extensions must be an array.");
  }
  const id = productKey === "open-wrangler" ? "matt17br.openwrangler@" : "ms-toolsai.datawrangler@";
  const matches = installedExtensions.filter((entry) => entry.startsWith(id));
  if (matches.length !== 1) {
    throw new Error(`${productKey} must have exactly one installed product version.`);
  }
  const version = matches[0].slice(id.length);
  if (!NUMERIC_VERSION.test(version)) {
    throw new Error(`${productKey} reported an invalid product version.`);
  }
  if (productKey === "data-wrangler" && version !== DATA_WRANGLER_BASELINE_VERSION) {
    throw new Error(`Data Wrangler must be installed at exact version ${DATA_WRANGLER_BASELINE_VERSION}.`);
  }
  return version;
}

export async function installComparisonExtension(
  { editor, userData, extensions, target, kind, allowedPrivateVsixPaths = [], sandboxArgs, environment, label },
  { runCli = runBoundedEditorCliCommand } = {}
) {
  if (
    !editor ||
    typeof editor !== "object" ||
    typeof userData !== "string" ||
    typeof extensions !== "string" ||
    !Array.isArray(sandboxArgs) ||
    !environment ||
    typeof environment !== "object" ||
    typeof label !== "string" ||
    label.length === 0 ||
    /[\0\r\n]/u.test(label)
  ) {
    throw new TypeError("Comparison extension installation received malformed editor inputs.");
  }
  let installTarget;
  if (kind === "marketplace") {
    const allowed = new Set([...COMPARISON_COMMON_EXTENSION_LOCK, DATA_WRANGLER_MARKETPLACE_EXTENSION]);
    if (typeof target !== "string" || target !== target.trim() || !allowed.has(target)) {
      throw new Error("Comparison Marketplace installation accepts only its exact pinned extension IDs.");
    }
    installTarget = target;
  } else if (kind === "owned-vsix") {
    if (
      typeof target !== "string" ||
      !isAbsolute(target) ||
      basename(resolve(target)) !== "openwrangler.vsix" ||
      !allowedPrivateVsixPaths.map((entry) => resolve(entry)).includes(resolve(target))
    ) {
      throw new Error("Comparison VSIX installation accepts only the runner-owned Open Wrangler candidate.");
    }
    installTarget = resolve(target);
  } else {
    throw new Error("Comparison extension installation kind must be marketplace or owned-vsix.");
  }

  return runCli(
    {
      editor,
      args: [
        "--user-data-dir",
        userData,
        "--extensions-dir",
        extensions,
        "--install-extension",
        installTarget,
        "--force",
        ...sandboxArgs
      ],
      environment,
      label
    },
    { timeoutMs: 180_000 }
  );
}

export function normalizeComparisonProductEvidence({
  fragment,
  expectedRunId,
  productKey,
  editorVersion,
  installedExtensions,
  candidateSha256,
  configuredPythonProcessObservedDuringProductRun
}) {
  requireProductKey(productKey);
  if (configuredPythonProcessObservedDuringProductRun !== true) {
    throw new TypeError("Comparison product normalization requires an outer owned-process Python observation.");
  }
  exactKeys(
    fragment,
    ["protocol", "runId", "phase", "productKey", "configuredPythonEnvironment", "samples"],
    "comparison product fragment"
  );
  if (
    fragment.protocol !== COMPARISON_PRODUCT_FRAGMENT_PROTOCOL ||
    fragment.runId !== expectedRunId ||
    fragment.phase !== COMPARISON_TEST_PHASES[productKey] ||
    fragment.productKey !== productKey
  ) {
    throw new TypeError("Comparison product fragment is malformed or mis-correlated.");
  }
  if (!Array.isArray(fragment.samples) || fragment.samples.length !== 2) {
    throw new TypeError("Comparison product fragment must contain CSV and Parquet phases.");
  }
  const version = installedComparisonProductVersion(installedExtensions, productKey);
  const configuredPythonEnvironment = normalizeConfiguredPythonEnvironment(fragment.configuredPythonEnvironment);
  const product = {
    key: productKey,
    id: productKey === "open-wrangler" ? "Matt17BR.openwrangler" : "ms-toolsai.datawrangler",
    version,
    installation: productKey === "open-wrangler" ? "candidate-vsix" : "official-vscode-marketplace",
    candidateSha256: productKey === "open-wrangler" ? candidateSha256 : null
  };
  const editor = {
    id: "microsoft.vscode",
    version: editorVersion,
    officialDistribution: true,
    displayMode: "headless"
  };
  const seenFormats = new Set();
  const phases = fragment.samples.map((entry) => {
    exactKeys(entry, ["fixture", "diagnostic", "proofs"], "comparison product phase");
    exactKeys(
      entry.proofs,
      ["telemetryDisabled", "sourceIdentityStable", "sourceUnchanged"],
      "comparison product phase proofs"
    );
    const format = entry.fixture?.format;
    if ((format !== "csv" && format !== "parquet") || seenFormats.has(format)) {
      throw new TypeError("Comparison product phases must contain unique CSV and Parquet fixtures.");
    }
    seenFormats.add(format);
    return validateDataWranglerComparisonPhase({
      protocol: COMPARISON_PHASE_PROTOCOL,
      runId: expectedRunId,
      product: structuredClone(product),
      editor: structuredClone(editor),
      fixture: structuredClone(entry.fixture),
      diagnostic: structuredClone(entry.diagnostic),
      proofs: {
        ...structuredClone(entry.proofs),
        configuredPythonProcessObservedDuringProductRun,
        cleanupVerified: true
      },
      installedExtensions: [...installedExtensions]
    });
  });
  if (!seenFormats.has("csv") || !seenFormats.has("parquet")) {
    throw new TypeError("Comparison product phases must contain CSV and Parquet fixtures.");
  }
  return Object.freeze({
    configuredPythonEnvironment,
    phases: Object.freeze(phases)
  });
}

export async function runDataWranglerComparison(options, environment = process.env, overrides = {}) {
  const dependencies = comparisonDependencies(overrides);
  validateComparisonOptions(options);
  const session = await runComparisonEditorSession({
    options,
    environment,
    dependencies,
    purpose: "smoke"
  });
  const { candidateReceipt, fixtureManifest, productRuns } = session;
  const [firstProductRun, secondProductRun] = productRuns;
  if (
    !fixtureManifest ||
    !firstProductRun ||
    !secondProductRun ||
    JSON.stringify(firstProductRun.configuredPythonEnvironment) !==
      JSON.stringify(secondProductRun.configuredPythonEnvironment)
  ) {
    throw new Error("The configured Python environment changed between comparison product runs.");
  }
  const phases = productRuns.flatMap((run) => run.phases);
  if (!candidateReceipt || phases.length !== 4) {
    throw new Error("Data Wrangler comparison smoke completed without four validated phases.");
  }

  const report = buildDataWranglerComparisonSmokeReport({
    generatedAtUtc: dependencies.now().toISOString(),
    configuredPythonEnvironment: firstProductRun.configuredPythonEnvironment,
    fixtureManifest,
    phases
  });
  assertComparisonPathSeparation(options);
  dependencies.writeReport(options.output, report);
  return report;
}

export async function bootstrapDataWranglerComparisonConfiguredProfiles(
  options,
  environment = process.env,
  overrides = {}
) {
  const dependencies = comparisonDependencies(overrides);
  validateComparisonBootstrapOptions(options);
  const session = await runComparisonEditorSession({
    options,
    environment,
    dependencies,
    purpose: "configured-profiles"
  });
  const profiles = session.productRuns.map((run) => run.profile);
  if (
    !session.candidateReceipt ||
    profiles.length !== 2 ||
    profiles[0]?.product !== "open-wrangler" ||
    profiles[1]?.product !== "data-wrangler" ||
    profiles.some((profile) => profile.kind !== "configured-only")
  ) {
    throw new Error("Comparison configured-profile bootstrap did not produce both exact product profiles.");
  }
  const editor = profiles[0].editor;
  if (
    profiles.some(
      (profile) =>
        profile.editor.executable !== editor.executable ||
        profile.editor.cli !== editor.cli ||
        profile.editor.version !== editor.version
    )
  ) {
    throw new Error("Official VS Code changed between configured-profile bootstrap products.");
  }
  return Object.freeze({
    protocol: COMPARISON_CONFIGURED_PROFILES_PROTOCOL,
    studyRoot: session.privateRoot,
    candidateSha256: session.candidateReceipt.sha256,
    editor,
    profiles: Object.freeze(profiles)
  });
}

async function runComparisonEditorSession({ options, environment, dependencies, purpose }) {
  dependencies.validatePrivatePathOverrides();
  if (dependencies.platform !== "linux" || dependencies.architecture !== "x64") {
    throw new Error("The clean-room Data Wrangler comparison supports only Linux x64.");
  }
  const inputReceipts = dependencies.captureInputs(options);
  exactKeys(inputReceipts, ["candidate", "python"], "comparison input receipts");

  const runEnvironment = { ...environment };
  delete runEnvironment.OPEN_WRANGLER_CAPTURE_EDITOR_SCREENSHOTS;
  runEnvironment.OPEN_WRANGLER_EDITOR_DISPLAY = "headless";

  const privateParent = resolve(root, "tmp", "ow");
  dependencies.mkdir(privateParent, { recursive: true, mode: 0o700 });
  const privateRoot = dependencies.mkdtemp(join(privateParent, "x-"));
  const rootReceipt = dependencies.createPrivateRootReceipt(privateRoot, {
    containedBy: privateParent
  });
  dependencies.configureTempRoot(privateRoot, runEnvironment);
  const privatePaths = [privateRoot, options.candidate, options.python];

  let display;
  let primaryError;
  let displayError;
  let cleanupError;
  let processTreeUncertain = false;
  let candidateReceipt;
  let fixtureManifest;
  let productRuns;
  try {
    dependencies.buildTestRuntime(runEnvironment);
    const testModule = resolve(root, "dist-test", "test", "extensionHost", "dataWranglerComparison.js");
    if (!dependencies.exists(testModule)) {
      throw new Error("The comparison editor-host module was not produced by build:test-extension.");
    }

    candidateReceipt = dependencies.stageCandidate(options.candidate, resolve(privateRoot, "openwrangler.vsix"));
    const fixtureRoot = purpose === "smoke" ? resolve(privateRoot, "fixtures-root") : undefined;
    if (purpose === "smoke") {
      dependencies.revalidateInput(inputReceipts.python);
      fixtureManifest = dependencies.generateFixtures({
        pythonReceipt: inputReceipts.python,
        fixtureRoot,
        environment: runEnvironment
      });
    }
    const harnessDevelopmentPath = await dependencies.createHarness(privateRoot);
    const acquisition = await dependencies.acquireVscode(privateRoot);
    validateOfficialVSCodeAcquisition(acquisition);

    display = await dependencies.startDisplay({
      environment: runEnvironment
    });
    if (display?.isolated !== true || display?.mode !== "headless" || typeof display.stop !== "function") {
      throw new Error("Comparison editor work requires one zero-window, isolated headless Ozone environment.");
    }

    productRuns = [];
    let editorVersion;
    for (const productKey of ["open-wrangler", "data-wrangler"]) {
      const runProduct = purpose === "smoke" ? dependencies.runProduct : dependencies.runConfiguredProduct;
      const run = await runProduct({
        productKey,
        editor: acquisition.editor,
        editorVersion,
        candidateReceipt,
        harnessDevelopmentPath,
        pythonReceipt: inputReceipts.python,
        privateRoot,
        ...(fixtureRoot === undefined ? {} : { fixtureRoot }),
        testModule,
        environment: runEnvironment,
        ...(purpose === "smoke" ? { captureTemplate: dependencies.captureTemplate } : {})
      });
      dependencies.revalidateInput(inputReceipts.python);
      editorVersion ??= run.editorVersion;
      if (run.editorVersion !== editorVersion) {
        throw new Error("Official VS Code changed version between comparison products.");
      }
      productRuns.push(run);
    }
    if (purpose === "smoke") {
      const [firstProductRun, secondProductRun] = productRuns;
      if (
        !firstProductRun ||
        !secondProductRun ||
        JSON.stringify(firstProductRun.configuredPythonEnvironment) !==
          JSON.stringify(secondProductRun.configuredPythonEnvironment)
      ) {
        throw new Error("The configured Python environment changed between comparison product runs.");
      }
      if (!fixtureManifest || productRuns.flatMap((run) => run.phases).length !== 4) {
        throw new Error("Data Wrangler comparison smoke completed without four validated phases.");
      }
    } else {
      const profiles = productRuns.map((run) => run.profile);
      const editor = profiles[0]?.editor;
      if (
        profiles.length !== 2 ||
        profiles[0]?.product !== "open-wrangler" ||
        profiles[1]?.product !== "data-wrangler" ||
        profiles.some(
          (profile) =>
            profile.kind !== "configured-only" ||
            profile.configuredPythonProcessObservedDuringSetup !== true ||
            profile.editor.executable !== editor?.executable ||
            profile.editor.cli !== editor?.cli ||
            profile.editor.version !== editor?.version
        )
      ) {
        throw new Error("Comparison configured-profile bootstrap did not retain both exact product profiles.");
      }
    }
    dependencies.revalidateInput(inputReceipts.candidate);
    dependencies.revalidateInput(inputReceipts.python);
    dependencies.revalidateCandidate(candidateReceipt);
  } catch (error) {
    primaryError = error;
    processTreeUncertain ||= dependencies.processTreeMayBeLive(error);
  }

  if (display) {
    try {
      await display.stop({ preservePrivateFiles: processTreeUncertain });
    } catch (error) {
      displayError = error;
      processTreeUncertain ||= dependencies.processTreeMayBeLive(error);
    }
  }

  if (
    !processTreeUncertain &&
    ((purpose !== "configured-profiles" && !dependencies.retainPrivateRoot) ||
      primaryError !== undefined ||
      displayError !== undefined)
  ) {
    try {
      dependencies.removePrivateRoot(rootReceipt);
    } catch (error) {
      cleanupError = error;
    }
  }
  const failures = [primaryError, displayError, cleanupError].filter((error) => error !== undefined);
  if (failures.length > 0) {
    const error =
      failures.length === 1
        ? failures[0]
        : new AggregateError(failures, "Data Wrangler comparison editor work failed or could not clean up.");
    throw new Error(dependencies.sanitize(error, privatePaths));
  }
  if (!candidateReceipt || !Array.isArray(productRuns) || productRuns.length !== 2) {
    throw new Error("Data Wrangler comparison editor work completed without both validated products.");
  }
  return Object.freeze({ privateRoot, candidateReceipt, fixtureManifest, productRuns: Object.freeze(productRuns) });
}

export function dataWranglerComparisonKernelLabel(runId) {
  if (typeof runId !== "string" || !COMPARISON_RUN_ID.test(runId)) {
    throw new TypeError("Data Wrangler comparison kernel selection requires one correlated v4 run ID.");
  }
  return `Open Wrangler comparison runtime ${runId}`;
}

export function writeDataWranglerComparisonJupyterEnvironment(directory, pythonReceipt, runId) {
  if (typeof directory !== "string" || !isAbsolute(directory) || /[\0\r\n]/u.test(directory) || existsSync(directory)) {
    throw new Error("Data Wrangler comparison requires one new absolute private Jupyter directory.");
  }
  revalidateComparisonInputFile(pythonReceipt);
  const python = pythonReceipt.path;
  const label = dataWranglerComparisonKernelLabel(runId);
  const dataDir = resolve(directory, "data");
  const runtimeDir = resolve(directory, "runtime");
  const configDir = resolve(directory, "config");
  const pathDirectory = resolve(directory, "path");
  const kernelName = `openwrangler-comparison-${runId.replaceAll("-", "")}`;
  const kernelDirectory = resolve(dataDir, "kernels", kernelName);
  for (const path of [dataDir, runtimeDir, configDir, pathDirectory, kernelDirectory]) {
    mkdirSync(path, { recursive: true, mode: 0o700 });
  }
  writeFileSync(
    resolve(kernelDirectory, "kernel.json"),
    `${JSON.stringify(
      {
        argv: [python, "-I", "-Xfrozen_modules=off", "-m", "ipykernel_launcher", "-f", "{connection_file}"],
        display_name: label,
        language: "python",
        metadata: { debugger: false }
      },
      null,
      2
    )}\n`,
    { encoding: "utf8", flag: "wx", mode: 0o600 }
  );
  revalidateComparisonInputFile(pythonReceipt);
  return Object.freeze({
    label,
    jupyterEnvironment: Object.freeze({ dataDir, runtimeDir, configDir, path: pathDirectory })
  });
}

export function createComparisonProductEditorPhasePlan(input) {
  exactKeys(
    input,
    [
      "productKey",
      "diagnosticPhase",
      "diagnosticResultPath",
      "firstUseSetupResultPath",
      "userData",
      "jupyterEnvironment"
    ],
    "comparison product editor phase-plan input"
  );
  const { productKey, diagnosticPhase, diagnosticResultPath, firstUseSetupResultPath, userData, jupyterEnvironment } =
    input;
  requireProductKey(productKey);
  if (diagnosticPhase !== COMPARISON_TEST_PHASES[productKey]) {
    throw new TypeError("Comparison product phase plan requires its exact diagnostic phase.");
  }
  for (const [value, label] of [
    [userData, "user-data directory"],
    [diagnosticResultPath, "diagnostic result"]
  ]) {
    if (typeof value !== "string" || !isAbsolute(value) || /[\0\r\n]/u.test(value)) {
      throw new TypeError(`Comparison product phase plan requires one absolute ${label} path.`);
    }
  }

  const diagnostic = Object.freeze({
    kind: "diagnostic",
    phase: diagnosticPhase,
    resultPath: diagnosticResultPath,
    userData,
    jupyterEnvironment,
    reportsFragment: true
  });
  if (
    typeof firstUseSetupResultPath !== "string" ||
    !isAbsolute(firstUseSetupResultPath) ||
    /[\0\r\n]/u.test(firstUseSetupResultPath) ||
    firstUseSetupResultPath === diagnosticResultPath
  ) {
    throw new TypeError("Comparison phase plan requires one distinct absolute setup result path.");
  }
  if (productKey === "data-wrangler") {
    exactKeys(
      jupyterEnvironment,
      ["dataDir", "runtimeDir", "configDir", "path"],
      "Data Wrangler comparison Jupyter environment"
    );
    for (const value of Object.values(jupyterEnvironment)) {
      if (typeof value !== "string" || !isAbsolute(value) || /[\0\r\n]/u.test(value)) {
        throw new TypeError("Data Wrangler comparison phase plan requires absolute private Jupyter paths.");
      }
    }
  } else if (jupyterEnvironment !== null) {
    throw new TypeError("Open Wrangler comparison setup must not include Data Wrangler Jupyter state.");
  }
  const plan = Object.freeze([
    Object.freeze({
      kind: "first-use-setup",
      phase: productKey === "data-wrangler" ? DATA_WRANGLER_FIRST_USE_SETUP_PHASE : OPEN_WRANGLER_FIRST_USE_SETUP_PHASE,
      resultPath: firstUseSetupResultPath,
      userData,
      jupyterEnvironment,
      reportsFragment: false
    }),
    diagnostic
  ]);
  comparisonProductEditorPhasePlans.add(plan);
  return plan;
}

export async function runComparisonProductEditorPhases({
  phasePlan,
  runPhase,
  beforePhase = () => undefined,
  afterPhase = () => undefined
}) {
  if (!comparisonProductEditorPhasePlans.has(phasePlan) || typeof runPhase !== "function") {
    throw new TypeError("Comparison product execution requires one authentic phase plan and phase callback.");
  }
  if (typeof beforePhase !== "function" || typeof afterPhase !== "function") {
    throw new TypeError("Comparison product execution requires callable pre-phase and post-phase observers.");
  }
  let diagnosticResult;
  let diagnosticCompleted = false;
  for (const phase of phasePlan) {
    await beforePhase(phase);
    const result = await runPhase(phase);
    await afterPhase(phase, result);
    if (phase.reportsFragment) {
      if (diagnosticCompleted) {
        throw new Error("Comparison product execution encountered more than one reporting diagnostic phase.");
      }
      diagnosticResult = result;
      diagnosticCompleted = true;
    }
  }
  if (!diagnosticCompleted) {
    throw new Error("Comparison product execution completed without its reporting diagnostic phase.");
  }
  return diagnosticResult;
}

export async function runComparisonProduct({
  productKey,
  editor,
  editorVersion: knownEditorVersion,
  candidateReceipt,
  harnessDevelopmentPath,
  pythonReceipt,
  privateRoot,
  fixtureRoot,
  testModule,
  environment,
  captureTemplate = () => undefined,
  requireWatchHeadroom = requireLinuxInotifyWatchHeadroom
}) {
  return runComparisonProductInternal(
    {
      productKey,
      editor,
      editorVersion: knownEditorVersion,
      candidateReceipt,
      harnessDevelopmentPath,
      pythonReceipt,
      privateRoot,
      fixtureRoot,
      testModule,
      environment,
      captureTemplate,
      requireWatchHeadroom
    },
    { configuredOnly: false }
  );
}

export async function runComparisonProductConfiguredSetup(input) {
  return runComparisonProductInternal(input, { configuredOnly: true });
}

async function runComparisonProductInternal(
  {
    productKey,
    editor,
    editorVersion: knownEditorVersion,
    candidateReceipt,
    harnessDevelopmentPath,
    pythonReceipt,
    privateRoot,
    fixtureRoot,
    testModule,
    environment,
    captureTemplate = () => undefined,
    requireWatchHeadroom = requireLinuxInotifyWatchHeadroom
  },
  { configuredOnly }
) {
  requireProductKey(productKey);
  if (typeof captureTemplate !== "function" || typeof requireWatchHeadroom !== "function") {
    throw new TypeError("Comparison product preparation requires callable template capture and watch-headroom gates.");
  }
  revalidateComparisonInputFile(pythonReceipt);
  const python = pythonReceipt.path;
  const profile = mkdtempSync(join(privateRoot, productKey === "open-wrangler" ? "p-o-" : "p-d-"));
  const workspace = resolve(profile, "workspace");
  const userData = resolve(profile, "user");
  const extensions = resolve(profile, "extensions");
  if (configuredOnly) {
    if (fixtureRoot !== undefined) {
      throw new Error("Configured-profile setup must not receive smoke fixtures.");
    }
    prepareComparisonSetupWorkspace(workspace);
  } else {
    prepareComparisonDiagnosticWorkspace(workspace, fixtureRoot);
  }
  writeEditorSettings(userData, comparisonEditorSettings(python));

  const sandboxArgs = ["--no-sandbox", ...editorDisplayLaunchArgs("linux", environment)];
  const editorEnvironment = createEditorAcceptanceEnvironment(environment);
  const editorVersion =
    knownEditorVersion ??
    (await readOfficialVSCodeVersion({
      editor,
      userData,
      extensions,
      sandboxArgs,
      environment: editorEnvironment
    }));
  const identifiedEditor = Object.freeze({ ...editor, version: editorVersion });
  const allowedPrivateVsixPaths = [candidateReceipt.path];
  for (const install of PRODUCT_INSTALLS[productKey]) {
    if (install === "candidate") {
      revalidateInstalledPerformanceVsix(candidateReceipt);
      await installComparisonExtension({
        editor: identifiedEditor,
        userData,
        extensions,
        target: candidateReceipt.path,
        kind: "owned-vsix",
        allowedPrivateVsixPaths,
        sandboxArgs,
        environment: editorEnvironment,
        label: "Official VS Code Open Wrangler comparison candidate installation"
      });
      revalidateInstalledPerformanceVsix(candidateReceipt);
    } else {
      await installComparisonExtension({
        editor: identifiedEditor,
        userData,
        extensions,
        target: install,
        kind: "marketplace",
        sandboxArgs,
        environment: editorEnvironment,
        label: `Official VS Code ${marketplaceInstallLabel(install)} installation`
      });
    }
  }

  const runId = randomUUID();
  const phase = COMPARISON_TEST_PHASES[productKey];
  const resultPath = resolve(profile, `${phase}-result.json`);
  const dataWranglerKernel =
    productKey === "data-wrangler"
      ? writeDataWranglerComparisonJupyterEnvironment(resolve(profile, "jupyter"), pythonReceipt, runId)
      : undefined;
  const inventoryInput = {
    editor: identifiedEditor,
    userData,
    extensions,
    sandboxArgs,
    environment: editorEnvironment,
    productKey
  };
  const phasePlan = createComparisonProductEditorPhasePlan({
    productKey,
    diagnosticPhase: phase,
    diagnosticResultPath: resultPath,
    firstUseSetupResultPath: resolve(
      profile,
      `${productKey === "data-wrangler" ? DATA_WRANGLER_FIRST_USE_SETUP_PHASE : OPEN_WRANGLER_FIRST_USE_SETUP_PHASE}-result.json`
    ),
    userData,
    jupyterEnvironment: dataWranglerKernel?.jupyterEnvironment ?? null
  });
  const runObservedPhase = (launch) =>
    runComparisonObservedEditorPhase({
      productKey,
      pythonReceipt,
      runPhase: (spawnProcess) =>
        runEditorAcceptancePhase(
          {
            editor: identifiedEditor,
            workspace,
            userData: launch.userData,
            extensions,
            developmentPaths: [harnessDevelopmentPath],
            testModule,
            python,
            phase: launch.phase,
            resultPath: launch.resultPath,
            editorProductVersion: editorVersion,
            runId,
            progressPath: editorAcceptanceProgressPath(launch.resultPath, runId, launch.phase),
            requiresWorkbenchCdp: true,
            jupyterEnvironment: launch.jupyterEnvironment ?? undefined
          },
          { environment, spawnProcess }
        )
    });
  if (configuredOnly) {
    const setupLaunch = phasePlan[0];
    if (setupLaunch?.kind !== "first-use-setup") {
      throw new Error("Configured-profile bootstrap did not derive its exact first-use phase.");
    }
    const { installedExtensions, phaseResult: observed } = await runComparisonInventoryGuard({
      readInventory: () => readComparisonInstalledExtensions(inventoryInput),
      runPhase: async () => {
        await requireWatchHeadroom({ runRoot: profile });
        return runObservedPhase(setupLaunch);
      }
    });
    installedComparisonProductVersion(installedExtensions, productKey);
    if (observed.configuredPythonProcessObservedDuringProductRun !== true) {
      throw new Error(`${productKey} configured-profile setup did not prove its exact Python runtime.`);
    }
    const profileDescriptor = Object.freeze({
      product: productKey,
      kind: "configured-only",
      privateRoot: profile,
      userData,
      extensions,
      editor: identifiedEditor,
      sandboxArgs: Object.freeze([...sandboxArgs]),
      installedExtensions: Object.freeze([...installedExtensions]),
      configuredPythonProcessObservedDuringSetup: true
    });
    return Object.freeze({ editorVersion, profile: profileDescriptor });
  }
  const { installedExtensions, phaseResult: observed } = await runComparisonInventoryGuard({
    readInventory: () => readComparisonInstalledExtensions(inventoryInput),
    runPhase: () =>
      runComparisonProductEditorPhases({
        phasePlan,
        runPhase: runObservedPhase,
        beforePhase: () => requireWatchHeadroom({ runRoot: profile }),
        afterPhase: async (launch) => {
          if (launch.kind === "first-use-setup") {
            await captureTemplate({
              product: productKey,
              kind: "configured-only",
              privateRoot: profile,
              userData,
              extensions,
              editor: identifiedEditor,
              sandboxArgs,
              environment: editorEnvironment
            });
          }
        }
      })
  });
  const fragment = readInstalledPerformanceFragment(
    resolve(workspace, "results", `${phase}.json`),
    COMPARISON_FRAGMENT_MAX_BYTES,
    observed.receipt
  );
  const evidence = normalizeComparisonProductEvidence({
    fragment,
    expectedRunId: runId,
    productKey,
    editorVersion,
    installedExtensions,
    candidateSha256: candidateReceipt.sha256,
    configuredPythonProcessObservedDuringProductRun: observed.configuredPythonProcessObservedDuringProductRun
  });
  await captureTemplate({
    product: productKey,
    kind: "warmed",
    privateRoot: profile,
    userData,
    extensions,
    editor: identifiedEditor,
    sandboxArgs,
    environment: editorEnvironment
  });
  return Object.freeze({ editorVersion, ...evidence });
}

export async function runComparisonObservedEditorPhase(
  {
    productKey,
    pythonReceipt,
    runPhase,
    observer = createComparisonPythonProcessObserver({
      productKey,
      pythonReceipt
    })
  },
  { spawnOwned = spawnOwnedEditorProcess } = {}
) {
  requireProductKey(productKey);
  if (
    typeof runPhase !== "function" ||
    typeof spawnOwned !== "function" ||
    !observer ||
    typeof observer.begin !== "function" ||
    typeof observer.end !== "function"
  ) {
    throw new TypeError("Observed comparison phase requires one phase launcher, owned spawn, and process observer.");
  }
  revalidateComparisonInputFile(pythonReceipt);
  let phaseError;
  let observerStartError;
  let observerEndError;
  let observerStarted = false;
  let receipt;
  const observedSpawn = (...arguments_) => {
    const child = spawnOwned(...arguments_);
    try {
      observer.begin(child.pid);
      observerStarted = true;
    } catch (error) {
      observerStartError = error;
    }
    return child;
  };
  try {
    receipt = await runPhase(observedSpawn);
  } catch (error) {
    phaseError = error;
  }
  let configuredPythonProcessObservedDuringProductRun = false;
  if (observerStarted) {
    try {
      configuredPythonProcessObservedDuringProductRun = observer.end() === true;
    } catch (error) {
      observerEndError = error;
    }
  } else if (!phaseError && !observerStartError) {
    observerEndError = new Error("Comparison phase completed without an owned editor-process observation.");
  }
  const failures = [phaseError, observerStartError, observerEndError].filter((error) => error !== undefined);
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) {
    throw new AggregateError(failures, "Comparison editor phase or Python-process observation failed.");
  }
  revalidateComparisonInputFile(pythonReceipt);
  if (!configuredPythonProcessObservedDuringProductRun) {
    throw new Error(
      `${productKey} did not execute the exact configured Python runtime in its owned editor process tree.`
    );
  }
  return Object.freeze({ receipt, configuredPythonProcessObservedDuringProductRun: true });
}

export function createComparisonPythonProcessObserver({
  productKey,
  pythonReceipt,
  intervalMs = 25,
  inspect = observeComparisonPythonProcessGroup,
  setTimer = setInterval,
  clearTimer = clearInterval
}) {
  requireProductKey(productKey);
  revalidateComparisonInputFile(pythonReceipt);
  if (
    !Number.isSafeInteger(intervalMs) ||
    intervalMs < 10 ||
    intervalMs > 1_000 ||
    typeof inspect !== "function" ||
    typeof setTimer !== "function" ||
    typeof clearTimer !== "function"
  ) {
    throw new TypeError("Comparison Python observer requires a bounded interval and timer callbacks.");
  }
  let activeProcessGroup;
  let timer;
  let observed = false;
  let failure;
  const candidateShapes = new Set();
  const sample = () => {
    if (activeProcessGroup === undefined || observed || failure) return;
    try {
      observed = inspect(activeProcessGroup, {
        productKey,
        pythonReceipt,
        recordCandidateShape(shape) {
          if (
            candidateShapes.size < PROCESS_SHAPE_LIMIT &&
            typeof shape === "string" &&
            shape.length > 0 &&
            Buffer.byteLength(shape, "utf8") <= 512
          ) {
            candidateShapes.add(shape);
          }
        }
      });
    } catch (error) {
      failure = error;
    }
  };
  return Object.freeze({
    begin(processGroupId) {
      if (activeProcessGroup !== undefined || !Number.isSafeInteger(processGroupId) || processGroupId <= 0) {
        throw new Error("Comparison Python observation requires one positive, non-overlapping editor process group.");
      }
      revalidateComparisonInputFile(pythonReceipt);
      activeProcessGroup = processGroupId;
      sample();
      timer = setTimer(sample, intervalMs);
      timer?.unref?.();
    },
    end() {
      if (activeProcessGroup === undefined) {
        throw new Error("Comparison Python observation has no active editor process group.");
      }
      if (timer !== undefined) clearTimer(timer);
      timer = undefined;
      activeProcessGroup = undefined;
      revalidateComparisonInputFile(pythonReceipt);
      if (failure) throw failure;
      if (!observed) {
        const diagnostic =
          candidateShapes.size === 0
            ? " No exact-executable Python candidate was observed."
            : ` Safe command shapes: ${[...candidateShapes].sort().join("; ")}.`;
        throw new Error(
          `${productKey} never executed the exact configured Python runtime with its product-specific signature.${diagnostic}`
        );
      }
      return true;
    }
  });
}

export function observeComparisonPythonProcessGroup(
  processGroupId,
  { productKey, pythonReceipt, procRoot = "/proc", recordCandidateShape }
) {
  requireProductKey(productKey);
  revalidateComparisonInputFile(pythonReceipt);
  if (
    !Number.isSafeInteger(processGroupId) ||
    processGroupId <= 0 ||
    typeof procRoot !== "string" ||
    !isAbsolute(procRoot)
  ) {
    throw new TypeError("Comparison Python observation requires one process group and procfs root.");
  }
  let entries;
  try {
    entries = readdirSync(procRoot, { withFileTypes: true });
  } catch (error) {
    throw new Error("Comparison Python observation could not enumerate the owned process tree.", { cause: error });
  }
  if (entries.length > PROC_ENTRY_LIMIT) {
    throw new Error("Comparison Python observation exceeded its bounded procfs entry count.");
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^[1-9]\d*$/u.test(entry.name)) continue;
    const processRoot = join(procRoot, entry.name);
    try {
      const before = parseComparisonProcessStat(readBoundedComparisonProcFile(join(processRoot, "stat")));
      if (!before || before.processGroupId !== processGroupId) continue;
      const command = readBoundedComparisonProcFile(join(processRoot, "cmdline")).split("\0").filter(Boolean);
      if (realpathSync(join(processRoot, "exe")) !== pythonReceipt.canonicalPath) {
        continue;
      }
      recordCandidateShape?.(
        comparisonPythonCommandShape(command, {
          argv0Exact: command[0] === pythonReceipt.path
        })
      );
      if (command[0] !== pythonReceipt.path || !comparisonPythonCommandMatches(productKey, command)) continue;
      const after = parseComparisonProcessStat(readBoundedComparisonProcFile(join(processRoot, "stat")));
      if (
        after &&
        after.pid === before.pid &&
        after.processGroupId === before.processGroupId &&
        after.startTime === before.startTime
      ) {
        return true;
      }
    } catch (error) {
      if (!["EACCES", "ENOENT", "ESRCH"].includes(error?.code)) throw error;
    }
  }
  return false;
}

export function comparisonPythonCommandShape(command, { argv0Exact } = {}) {
  if (
    !Array.isArray(command) ||
    typeof argv0Exact !== "boolean" ||
    command.some((entry) => typeof entry !== "string" || Buffer.byteLength(entry, "utf8") > PROC_FILE_MAX_BYTES)
  ) {
    throw new TypeError("Comparison Python command shape requires bounded command arguments and argv0 identity.");
  }
  if (command.length === 0) return "argv0=absent argc=0";
  const known = new Set([
    "-I",
    "-Xfrozen_modules=off",
    "-s",
    "-m",
    "-f",
    "--f",
    "ipykernel_launcher",
    "openwrangler_runtime.server"
  ]);
  const safeArguments = command.slice(1, PROCESS_SHAPE_ARGUMENT_LIMIT + 1).map((argument) => {
    if (known.has(argument)) return argument;
    if (/^(?:--?f)=/u.test(argument)) return `${argument.slice(0, argument.indexOf("=") + 1)}<path>`;
    if (argument.startsWith("-")) return "<flag>";
    return "<arg>";
  });
  const truncated = command.length - 1 > PROCESS_SHAPE_ARGUMENT_LIMIT ? " …" : "";
  return `argv0=${argv0Exact ? "exact" : "alias"} argc=${command.length - 1} ${safeArguments.join(" ")}${truncated}`.trim();
}

export function comparisonPythonCommandMatches(productKey, command) {
  requireProductKey(productKey);
  if (
    !Array.isArray(command) ||
    command.length < 4 ||
    command.some((entry) => typeof entry !== "string" || Buffer.byteLength(entry, "utf8") > PROC_FILE_MAX_BYTES)
  ) {
    return false;
  }
  if (productKey === "open-wrangler") {
    return (
      command.length === 4 && command[1] === "-s" && command[2] === "-m" && command[3] === "openwrangler_runtime.server"
    );
  }

  const allowedPrefixes = [[], ["-I"], ["-Xfrozen_modules=off"], ["-I", "-Xfrozen_modules=off"]];
  return allowedPrefixes.some((prefix) => {
    if (!prefix.every((entry, index) => command[index + 1] === entry)) return false;
    const kernelArguments = command.slice(prefix.length + 1);
    if (kernelArguments[0] !== "-m" || kernelArguments[1] !== "ipykernel_launcher") return false;
    return (
      (kernelArguments.length === 4 && ["-f", "--f"].includes(kernelArguments[2]) && kernelArguments[3].length > 0) ||
      (kernelArguments.length === 3 && /^(?:--?f)=.+/u.test(kernelArguments[2]))
    );
  });
}

export async function runComparisonInventoryGuard({ readInventory, runPhase }) {
  if (typeof readInventory !== "function" || typeof runPhase !== "function") {
    throw new TypeError("Comparison inventory guard requires inventory and phase callbacks.");
  }
  const installedExtensions = await readInventory();
  const phaseResult = await runPhase();
  const installedExtensionsAfter = await readInventory();
  if (
    installedExtensions.length !== installedExtensionsAfter.length ||
    installedExtensions.some((entry, index) => entry !== installedExtensionsAfter[index])
  ) {
    throw new Error("The exact installed-extension inventory changed during the diagnostic editor phase.");
  }
  return Object.freeze({ installedExtensions, phaseResult });
}

async function readComparisonInstalledExtensions({
  editor,
  userData,
  extensions,
  sandboxArgs,
  environment,
  productKey
}) {
  const { stdout } = await runBoundedEditorCliCommand(
    {
      editor,
      args: [
        "--user-data-dir",
        userData,
        "--extensions-dir",
        extensions,
        "--list-extensions",
        "--show-versions",
        ...sandboxArgs
      ],
      environment,
      label: `Official VS Code ${productKey} installed-extension inventory`
    },
    { timeoutMs: 60_000 }
  );
  return parseInstalledComparisonExtensions(stdout, productKey);
}

export async function readOfficialVSCodeVersion({
  editor,
  userData,
  extensions,
  sandboxArgs,
  environment,
  runCli = runBoundedEditorCliCommand
}) {
  const { stdout } = await runCli(
    {
      editor,
      args: ["--user-data-dir", userData, "--extensions-dir", extensions, "--version", ...sandboxArgs],
      environment,
      label: "Official VS Code comparison version probe"
    },
    { timeoutMs: 30_000 }
  );
  const versions = stdout
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => NUMERIC_VERSION.test(line));
  if (versions.length !== 1) {
    throw new Error("Official VS Code did not report exactly one numeric product version.");
  }
  return versions[0];
}

function comparisonDependencies(overrides) {
  const defaults = {
    platform: process.platform,
    architecture: process.arch,
    exists: existsSync,
    mkdir: mkdirSync,
    mkdtemp: mkdtempSync,
    createPrivateRootReceipt: createEditorAcceptancePrivateRootReceipt,
    configureTempRoot: configureEditorAcceptanceTempRoot,
    validatePrivatePathOverrides: validateEditorAcceptancePrivatePathOverrides,
    captureInputs: (options) => ({
      candidate: captureComparisonInputFile(options.candidate, {
        label: "Open Wrangler candidate"
      }),
      python: captureComparisonInputFile(options.python, {
        label: "Comparison Python interpreter",
        executable: true
      })
    }),
    revalidateInput: revalidateComparisonInputFile,
    buildTestRuntime: runComparisonTestBuild,
    stageCandidate: stageInstalledPerformanceVsix,
    revalidateCandidate: revalidateInstalledPerformanceVsix,
    generateFixtures: generateComparisonFixtures,
    createHarness: createComparisonHarness,
    acquireVscode: acquirePinnedVSCodeClient,
    startDisplay: startIsolatedEditorDisplay,
    runProduct: runComparisonProduct,
    runConfiguredProduct: runComparisonProductConfiguredSetup,
    captureTemplate: () => undefined,
    retainPrivateRoot: false,
    processTreeMayBeLive: editorProcessTreeMayBeLive,
    removePrivateRoot: removeEditorAcceptancePrivateRoot,
    sanitize: sanitizeEditorAcceptanceDiagnostic,
    writeReport: writeDataWranglerComparisonReport,
    now: () => new Date()
  };
  const unknown = Object.keys(overrides).filter((key) => !Object.hasOwn(defaults, key));
  if (unknown.length > 0) {
    throw new Error(`Unknown comparison dependency override ${JSON.stringify(unknown[0])}.`);
  }
  return { ...defaults, ...overrides };
}

function validateComparisonOptions(options) {
  exactKeys(options, ["candidate", "python", "output"], "comparison options");
  for (const [key, value] of Object.entries(options)) {
    if (typeof value !== "string" || !isAbsolute(value) || value.length === 0 || /[\0\r\n]/u.test(value)) {
      throw new Error(`Comparison option ${key} must be an absolute path.`);
    }
  }
  assertComparisonPathSeparation(options);
}

function validateComparisonBootstrapOptions(options) {
  exactKeys(options, ["candidate", "python"], "comparison configured-profile bootstrap options");
  for (const [key, value] of Object.entries(options)) {
    if (typeof value !== "string" || !isAbsolute(value) || value.length === 0 || /[\0\r\n]/u.test(value)) {
      throw new Error(`Comparison configured-profile bootstrap option ${key} must be an absolute path.`);
    }
  }
}

export function assertComparisonPathSeparation({ candidate, python, output }) {
  const resolvedOutput = resolve(output);
  const canonicalOutput = canonicalComparisonPotentialPath(resolvedOutput);
  for (const [protectedPath, label] of [
    [candidate, "Open Wrangler candidate"],
    [python, "configured Python interpreter"]
  ]) {
    const resolvedProtectedPath = resolve(protectedPath);
    if (
      resolvedOutput === resolvedProtectedPath ||
      canonicalOutput === canonicalComparisonPotentialPath(resolvedProtectedPath)
    ) {
      throw new Error(`The comparison output must not overwrite or alias the ${label}.`);
    }
    if (existsSync(resolvedProtectedPath) && existsSync(resolvedOutput)) {
      const protectedMetadata = lstatSync(resolvedProtectedPath, { bigint: true });
      const outputMetadata = lstatSync(resolvedOutput, { bigint: true });
      if (protectedMetadata.dev === outputMetadata.dev && protectedMetadata.ino === outputMetadata.ino) {
        throw new Error(`The comparison output must not overwrite or alias the ${label}.`);
      }
    }
  }
}

export function writeDataWranglerComparisonReport(destination, report, hooks = {}) {
  if (
    typeof destination !== "string" ||
    !isAbsolute(destination) ||
    /[\0\r\n]/u.test(destination) ||
    !hooks ||
    typeof hooks !== "object" ||
    Array.isArray(hooks) ||
    Object.keys(hooks).some(
      (key) => !["beforeExclusiveOpen", "afterExclusiveOpen", "beforePathValidation"].includes(key)
    ) ||
    (hooks.beforeExclusiveOpen !== undefined && typeof hooks.beforeExclusiveOpen !== "function") ||
    (hooks.afterExclusiveOpen !== undefined && typeof hooks.afterExclusiveOpen !== "function") ||
    (hooks.beforePathValidation !== undefined && typeof hooks.beforePathValidation !== "function")
  ) {
    throw new TypeError("Comparison report publication requires one absolute path and optional boundary hook.");
  }
  const serialized = JSON.stringify(report, null, 2);
  if (typeof serialized !== "string") {
    throw new TypeError("The comparison report must be JSON-serializable.");
  }
  const bytes = Buffer.from(`${serialized}\n`, "utf8");
  if (bytes.length === 0 || bytes.length > COMPARISON_REPORT_MAX_BYTES) {
    throw new Error("The comparison report exceeded its fixed 1 MiB limit.");
  }

  const target = resolve(destination);
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  requireAbsentComparisonReportPath(target);
  let descriptor;
  let identity;
  let published = false;
  let operationError;
  try {
    hooks.beforeExclusiveOpen?.(target);
    try {
      descriptor = openSync(
        target,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
        0o600
      );
    } catch (error) {
      throw new Error("The comparison report destination must remain absent at its exclusive-open boundary.", {
        cause: error
      });
    }
    identity = fstatSync(descriptor, { bigint: true });
    requireComparisonReportIdentity(identity, 1n, "exclusive destination");
    hooks.afterExclusiveOpen?.(target);
    writeFileSync(descriptor, bytes);
    fsyncSync(descriptor);
    const complete = fstatSync(descriptor, { bigint: true });
    requireSameComparisonReportOwnership(
      complete,
      identity,
      1n,
      "The comparison report descriptor changed while it was written."
    );
    if (complete.size !== BigInt(bytes.length)) {
      throw new Error("The comparison report descriptor has an invalid byte size.");
    }
    identity = complete;
    hooks.beforePathValidation?.(target);
    const atPath = lstatSync(target, { bigint: true });
    requireSameComparisonReportFile(
      atPath,
      identity,
      1n,
      true,
      "The comparison report destination path changed during publication."
    );
    closeSync(descriptor);
    descriptor = undefined;
    const closedPath = lstatSync(target, { bigint: true });
    requireSameComparisonReportFile(
      closedPath,
      identity,
      1n,
      true,
      "The comparison report destination changed while its descriptor closed."
    );
    published = true;
  } catch (error) {
    operationError = error;
  }

  let closeError;
  if (descriptor !== undefined) {
    try {
      closeSync(descriptor);
    } catch (error) {
      closeError = error;
    }
  }
  if (operationError !== undefined && closeError !== undefined) {
    throw new AggregateError(
      [operationError, closeError],
      "Comparison report publication failed and its bound descriptor could not close."
    );
  }
  if (operationError !== undefined) throw operationError;
  if (closeError !== undefined) throw closeError;
  if (!published) {
    throw new Error("Comparison report publication completed without a validated exclusive destination.");
  }
}

function requireAbsentComparisonReportPath(file) {
  try {
    lstatSync(file);
    throw new Error("The comparison report destination must be absent; existing files are never replaced.");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

function requireComparisonReportIdentity(metadata, expectedLinkCount, description) {
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== expectedLinkCount) {
    throw new Error(`The comparison report ${description} must have its expected regular-file link.`);
  }
}

function requireSameComparisonReportOwnership(actual, expected, expectedLinkCount, message) {
  requireComparisonReportIdentity(actual, expectedLinkCount, "file");
  if (
    actual.dev !== expected.dev ||
    actual.ino !== expected.ino ||
    actual.mode !== expected.mode ||
    actual.uid !== expected.uid ||
    actual.gid !== expected.gid ||
    actual.birthtimeNs !== expected.birthtimeNs
  ) {
    throw new Error(message);
  }
}

function requireSameComparisonReportFile(actual, expected, expectedLinkCount, compareCtime, message) {
  requireSameComparisonReportOwnership(actual, expected, expectedLinkCount, message);
  if (
    actual.size !== expected.size ||
    actual.mtimeNs !== expected.mtimeNs ||
    (compareCtime && actual.ctimeNs !== expected.ctimeNs)
  ) {
    throw new Error(message);
  }
}

function canonicalComparisonPotentialPath(value) {
  let cursor = resolve(value);
  const missingSegments = [];
  while (true) {
    try {
      return resolve(realpathSync(cursor), ...missingSegments.reverse());
    } catch (error) {
      if (error?.code !== "ENOENT" && error?.code !== "ENOTDIR") throw error;
    }
    const parent = dirname(cursor);
    if (parent === cursor) throw new Error("The comparison output path has no resolvable ancestor.");
    missingSegments.push(basename(cursor));
    cursor = parent;
  }
}

function normalizeConfiguredPythonEnvironment(value) {
  exactKeys(
    value,
    [
      "pythonVersion",
      "pythonImplementation",
      "pythonExecutableSha256",
      "installedPandasVersion",
      "installedPyarrowVersion",
      "installedJupyterCoreVersion",
      "installedIpykernelVersion"
    ],
    "comparison configured Python environment"
  );
  if (!PYTHON_VERSION.test(value.pythonVersion)) {
    throw new TypeError("Comparison configured Python version is invalid.");
  }
  if (value.pythonImplementation !== "CPython") {
    throw new TypeError("Comparison configured Python implementation must be CPython.");
  }
  if (!SHA256.test(value.pythonExecutableSha256)) {
    throw new TypeError("Comparison configured Python executable SHA-256 is invalid.");
  }
  for (const key of [
    "installedPandasVersion",
    "installedPyarrowVersion",
    "installedJupyterCoreVersion",
    "installedIpykernelVersion"
  ]) {
    if (!PACKAGE_VERSION.test(value[key])) {
      throw new TypeError(`Comparison configured Python package version ${key} is invalid.`);
    }
  }
  return Object.freeze(structuredClone(value));
}

function runComparisonTestBuild(environment) {
  execFileSync("npm", ["run", "build:test-extension"], {
    cwd: root,
    env: createEditorAcceptanceEnvironment(environment),
    maxBuffer: 64 * 1024,
    stdio: "ignore",
    timeout: 180_000,
    windowsHide: true
  });
}

function generateComparisonFixtures({ pythonReceipt, fixtureRoot, environment }) {
  mkdirSync(fixtureRoot, { recursive: true, mode: 0o700 });
  const fixtureDirectory = resolve(fixtureRoot, "fixtures");
  const manifestPath = resolve(fixtureRoot, "performance-fixtures.json");
  const python = revalidateComparisonInputFile(pythonReceipt).path;
  execFileSync(
    python,
    [
      resolve(root, "python", "benchmarks", "installed_editor_fixtures.py"),
      "--output-dir",
      fixtureDirectory,
      "--manifest-out",
      manifestPath,
      "--smoke"
    ],
    {
      cwd: root,
      env: createEditorAcceptanceEnvironment(environment),
      maxBuffer: 64 * 1024,
      stdio: "ignore",
      timeout: 120_000,
      windowsHide: true
    }
  );
  const manifest = validateInstalledFixtureManifest(readBoundedJson(manifestPath, 64 * 1024));
  if (manifest.smoke !== true) {
    throw new Error("Comparison fixture generation did not use smoke sizing.");
  }
  return manifest;
}

async function createComparisonHarness(privateRoot) {
  const directory = resolve(privateRoot, "harness");
  writeEditorAcceptanceHarness(directory);
  return directory;
}

function prepareComparisonSetupWorkspace(workspace) {
  mkdirSync(workspace, { recursive: true, mode: 0o700 });
  mkdirSync(resolve(workspace, "results"), {
    recursive: true,
    mode: 0o700
  });
  writeFileSync(resolve(workspace, "warmup.csv"), "c00,c01\n0,1\n1,2\n", { encoding: "utf8", flag: "wx", mode: 0o600 });
}

function prepareComparisonDiagnosticWorkspace(workspace, fixtureRoot) {
  prepareComparisonSetupWorkspace(workspace);
  cpSync(resolve(fixtureRoot, "fixtures"), resolve(workspace, "fixtures"), {
    recursive: true,
    errorOnExist: true,
    force: false
  });
  cpSync(resolve(fixtureRoot, "performance-fixtures.json"), resolve(workspace, "performance-fixtures.json"), {
    errorOnExist: true,
    force: false
  });
  mkdirSync(resolve(workspace, "benchmarks"), {
    recursive: true,
    mode: 0o700
  });
  cpSync(
    resolve(root, "python", "benchmarks", "source_cache_control.py"),
    resolve(workspace, "benchmarks", "source_cache_control.py"),
    { errorOnExist: true, force: false }
  );
}

function comparisonEditorSettings(python) {
  return {
    "telemetry.telemetryLevel": "off",
    "extensions.autoCheckUpdates": false,
    "extensions.autoUpdate": false,
    "extensions.ignoreRecommendations": true,
    "git.enabled": false,
    "git.openRepositoryInParentFolders": "never",
    "files.watcherExclude": {
      "**": true
    },
    "window.dialogStyle": "custom",
    "window.menuStyle": "custom",
    "files.simpleDialog.enable": true,
    "python.defaultInterpreterPath": python,
    "python.useEnvironmentsExtension": false,
    "openWrangler.pythonPath": python,
    "openWrangler.defaultBackend": "pandas",
    "openWrangler.fileStartMode": "editing",
    "openWrangler.insightsOnOpen": false
  };
}

function validateOfficialVSCodeAcquisition(acquisition) {
  if (
    !acquisition ||
    typeof acquisition !== "object" ||
    acquisition.editor?.name !== "VS Code" ||
    acquisition.editor?.key !== "vscode" ||
    acquisition.editor?.sharedDataDir !== true ||
    !isAbsolute(acquisition.editor?.executable ?? "") ||
    !isAbsolute(acquisition.editor?.cli ?? "")
  ) {
    throw new Error("Comparison smoke requires the pinned official VS Code distribution.");
  }
}

function marketplaceInstallLabel(extension) {
  if (extension === DATA_WRANGLER_MARKETPLACE_EXTENSION)
    return `Marketplace Data Wrangler ${DATA_WRANGLER_BASELINE_VERSION}`;
  if (COMPARISON_COMMON_EXTENSION_LOCK.includes(extension)) {
    return `pinned ${extension.slice(0, extension.lastIndexOf("@"))} dependency`;
  }
  throw new Error("Unknown comparison Marketplace extension.");
}

function requireProductKey(value) {
  if (value !== "open-wrangler" && value !== "data-wrangler") {
    throw new TypeError("Comparison product must be open-wrangler or data-wrangler.");
  }
}

function readComparisonInputSnapshot(path, { label, executable }) {
  let descriptor;
  try {
    descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    const opened = fstatSync(descriptor, { bigint: true });
    const named = lstatSync(path, { bigint: true });
    requireComparisonInputMetadata(opened, { label, executable });
    requireComparisonInputMetadata(named, { label, executable });
    if (!sameInputMetadata(named, opened)) {
      throw new Error(`${label} changed while its identity was captured.`);
    }
    const canonicalPath = realpathSync(path);
    const completed = fstatSync(descriptor, { bigint: true });
    const completedNamed = lstatSync(path, { bigint: true });
    if (!sameInputMetadata(completed, opened) || !sameInputMetadata(completedNamed, opened)) {
      throw new Error(`${label} changed while its identity was captured.`);
    }
    return Object.freeze({
      canonicalPath,
      metadata: Object.freeze(inputMetadata(opened))
    });
  } catch (error) {
    if (error?.code === "ELOOP") {
      throw new Error(`${label} must not be a symbolic link.`, {
        cause: error
      });
    }
    if (descriptor === undefined) {
      throw new Error(`${label} could not be opened as a pinned input.`, {
        cause: error
      });
    }
    throw error;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function requireComparisonInputMetadata(metadata, { label, executable }) {
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.nlink !== 1n ||
    metadata.size <= 0n ||
    (typeof process.getuid === "function" && metadata.uid !== BigInt(process.getuid())) ||
    (executable && (metadata.mode & 0o111n) === 0n)
  ) {
    throw new Error(
      `${label} must be a current-user-owned, single-link, non-empty regular${executable ? " executable" : ""} file.`
    );
  }
}

function inputMetadata(metadata) {
  return {
    dev: metadata.dev,
    ino: metadata.ino,
    mode: metadata.mode,
    nlink: metadata.nlink,
    uid: metadata.uid,
    gid: metadata.gid,
    size: metadata.size,
    mtimeNs: metadata.mtimeNs,
    ctimeNs: metadata.ctimeNs
  };
}

function sameInputMetadata(actual, expected) {
  const normalized = inputMetadata(actual);
  return Object.keys(normalized).every((key) => normalized[key] === expected[key]);
}

function parseComparisonProcessStat(value) {
  if (typeof value !== "string" || value.length === 0 || Buffer.byteLength(value, "utf8") > PROC_FILE_MAX_BYTES) {
    return undefined;
  }
  const open = value.indexOf("(");
  const close = value.lastIndexOf(")");
  if (open <= 0 || close <= open) return undefined;
  const pid = strictPositiveInteger(value.slice(0, open).trim());
  const fields = value
    .slice(close + 1)
    .trim()
    .split(/\s+/u);
  const processGroupId = strictPositiveInteger(fields[2]);
  const startTime = strictPositiveInteger(fields[19]);
  if (pid === undefined || processGroupId === undefined || startTime === undefined || fields.length < 22) {
    return undefined;
  }
  return { pid, processGroupId, startTime };
}

function readBoundedComparisonProcFile(file) {
  const buffer = Buffer.allocUnsafe(PROC_FILE_MAX_BYTES + 1);
  let descriptor;
  try {
    descriptor = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    const bytes = readSync(descriptor, buffer, 0, buffer.length, 0);
    if (bytes > PROC_FILE_MAX_BYTES) {
      throw new Error("Comparison Python observation encountered an oversized procfs field.");
    }
    return buffer.subarray(0, bytes).toString("utf8");
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function strictPositiveInteger(value) {
  if (typeof value !== "string" || !/^[1-9]\d*$/u.test(value)) {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function exactKeys(value, expected, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object.`);
  }
  const actual = Object.keys(value).sort();
  const canonicalExpected = [...expected].sort();
  if (actual.length !== canonicalExpected.length || actual.some((key, index) => key !== canonicalExpected[index])) {
    throw new TypeError(`${label} has missing or unknown fields.`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  try {
    const options = parseDataWranglerComparisonArguments(process.argv.slice(2));
    await runDataWranglerComparison(options);
    const output = relative(root, options.output);
    const label =
      output && output !== ".." && !output.startsWith(`..${sep}`) && !isAbsolute(output)
        ? output.replaceAll("\\", "/")
        : "the requested output file";
    console.log(`Clean-room comparison feasibility smoke passed; its path-free diagnostic was written to ${label}.`);
  } catch (error) {
    console.error(`Clean-room comparison smoke failed: ${sanitizeEditorAcceptanceDiagnostic(error)}`);
    process.exitCode = 1;
  }
}
