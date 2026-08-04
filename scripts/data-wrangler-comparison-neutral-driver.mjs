import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  copyFileSync,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import {
  configureEditorAcceptanceTempRoot,
  createEditorAcceptanceEnvironment,
  editorDisplayLaunchArgs,
  runEditorAcceptancePhase,
  spawnOwnedEditorProcess,
  startIsolatedEditorDisplay,
  writeEditorAcceptanceHarness,
  writeEditorSettings
} from "./editor-acceptance.mjs";
import { startLinuxPssSampler } from "./linux-pss-sampler.mjs";
import {
  COMPARISON_COMMON_EXTENSION_LOCK,
  DATA_WRANGLER_MARKETPLACE_EXTENSION,
  installComparisonExtension,
  verifyComparisonExtensionInventory
} from "./data-wrangler-comparison-install.mjs";
import { summarizeStudyPssSamples } from "./data-wrangler-comparison-report.mjs";

const REQUEST_PROTOCOL = "openwrangler-comparison-trial-request-v1";
const RESULT_PROTOCOL = "openwrangler-comparison-trial-result-v1";
const MAX_JSON_BYTES = 8 * 1024 * 1024;
const SHA256 = /^[0-9a-f]{64}$/u;

export function comparisonProductSettings(product) {
  return product === "open-wrangler"
    ? { "openWrangler.notebookPreviewProvider": "openWrangler" }
    : {
        "dataWrangler.outputRenderer.enabled": true,
        "dataWrangler.outputRenderer.enabledTypes": {
          "pandas.core.frame.DataFrame": true,
          "pandas.DataFrame": true,
          "polars.dataframe.frame.DataFrame": true
        }
      };
}

export async function runDataWranglerComparisonNeutralDriver({ requestPath, outputPath }) {
  const request = readJson(requestPath);
  validateRequest(request);
  requireContained(request.isolatedRoot, requestPath, "request");
  requireContained(request.isolatedRoot, outputPath, "result");
  requireContained(request.isolatedRoot, request.notebookPath, "notebook");
  requireContained(request.isolatedRoot, request.cell.source, "source");
  verifyFileHash(request.candidate.path, request.candidate.sha256, "Open Wrangler candidate");
  verifyFileHash(request.editor.path, request.editor.sha256, "VS Code executable");
  verifyFileHash(request.editor.cliPath, request.editor.cliSha256, "VS Code CLI");
  verifyFileHash(request.python.path, request.python.sha256, "Python executable");
  verifyComparisonSource(request.cell.source, request.cell.sourceSha256);

  const environment = { ...process.env, OPEN_WRANGLER_EDITOR_DISPLAY: "headless" };
  configureEditorAcceptanceTempRoot(request.isolatedRoot, environment);
  const isolatedEnvironment = createEditorAcceptanceEnvironment(environment);
  const userData = join(request.isolatedRoot, "user-data");
  const extensions = join(dirname(request.isolatedRoot), `prepared-extensions-${request.product}`);
  const harness = join(request.isolatedRoot, "harness");
  const acceptanceResult = join(request.isolatedRoot, "acceptance.json");
  const hostResult = join(request.isolatedRoot, "host-result.json");
  const hostRequest = join(request.isolatedRoot, "host-request.json");
  const candidate = join(request.isolatedRoot, "openwrangler.vsix");
  const jupyterEnvironment = createComparisonJupyterEnvironment(request.isolatedRoot, request.python.path);
  mkdirSync(userData, { recursive: true, mode: 0o700 });
  copyFileSync(request.candidate.path, candidate);
  chmodSync(candidate, 0o400);
  verifyFileHash(candidate, request.candidate.sha256, "private Open Wrangler candidate");
  writeJsonAtomic(hostRequest, comparisonHostRequest(request));
  writeEditorAcceptanceHarness(harness);
  writeEditorSettings(userData, {
    "python.defaultInterpreterPath": request.python.path,
    "openWrangler.pythonPath": request.python.path,
    ...comparisonProductSettings(request.product),
    "telemetry.telemetryLevel": "off",
    "update.mode": "none",
    "extensions.autoUpdate": false,
    "extensions.autoCheckUpdates": false,
    "workbench.startupEditor": "none",
    "window.dialogStyle": "custom",
    "files.simpleDialog.enable": true
  });

  const editor = {
    name: "VS Code",
    key: "vscode",
    version: request.editor.version,
    executable: request.editor.path,
    cli: request.editor.cliPath
  };
  let display;
  let sampler;
  let samples = [];
  let phaseError;
  try {
    display = await startIsolatedEditorDisplay({ environment });
    const sandboxArgs = ["--no-sandbox", ...editorDisplayLaunchArgs("linux", environment)];
    await prepareExtensionDirectory({
      request,
      editor,
      userData,
      extensions,
      candidate,
      sandboxArgs,
      environment: isolatedEnvironment
    });

    environment.OPEN_WRANGLER_COMPARISON_REQUEST_PATH = hostRequest;
    environment.OPEN_WRANGLER_COMPARISON_RESULT_PATH = hostResult;
    const testModule = resolve(
      import.meta.dirname,
      "..",
      "dist-test",
      "test",
      "extensionHost",
      "dataWranglerComparisonNotebookTrial.js"
    );
    if (!existsSync(testModule)) {
      throw new Error("Run npm run build:test-extension before the comparison study.");
    }
    await runEditorAcceptancePhase(
      {
        editor,
        workspace: request.isolatedRoot,
        userData,
        extensions,
        developmentPaths: [harness],
        testModule,
        python: request.python.path,
        phase: "comparison-study",
        resultPath: acceptanceResult,
        editorProductVersion: request.editor.version,
        requiresWorkbenchCdp: true,
        jupyterEnvironment,
        runId: randomUUID()
      },
      {
        environment,
        spawnProcess: (...arguments_) => {
          const child = spawnOwnedEditorProcess(...arguments_);
          sampler = startLinuxPssSampler(child.pid, { intervalMs: 200 });
          return child;
        }
      }
    );
  } catch (error) {
    phaseError = error;
  } finally {
    try {
      samples = sampler?.stop({ captureFinal: false }) ?? [];
    } catch (error) {
      phaseError = phaseError ? new AggregateError([phaseError, error]) : error;
    }
    try {
      await display?.stop({ preservePrivateFiles: false });
    } catch (error) {
      phaseError = phaseError ? new AggregateError([phaseError, error]) : error;
    }
    try {
      verifyComparisonSource(request.cell.source, request.cell.sourceSha256);
    } catch (error) {
      phaseError = phaseError ? new AggregateError([phaseError, error]) : error;
    }
  }
  if (phaseError) throw phaseError;

  const host = readJson(hostResult);
  if (
    host.protocol !== RESULT_PROTOCOL ||
    host.trialId !== request.trialId ||
    host.product !== request.product ||
    host.engine !== request.cell.engine ||
    host.format !== request.cell.format ||
    host.kind !== request.kind ||
    host.order !== request.order
  ) {
    throw new Error("The neutral host returned a mismatched result.");
  }
  const result = {
    ...host,
    memory: host.status === "success" ? summarizePss(samples, host.milestones) : null,
    provenance: {
      candidate: { version: request.candidate.version, sha256: request.candidate.sha256 },
      dataWranglerVersion: request.dataWranglerVersion,
      editor: { version: request.editor.version, sha256: request.editor.sha256 },
      python: { version: request.python.version, sha256: request.python.sha256 }
    }
  };
  writeJsonAtomic(outputPath, result);
  return result;
}

function createComparisonJupyterEnvironment(root, python) {
  const base = join(root, "jupyter");
  const dataDir = join(base, "data");
  const runtimeDir = join(base, "runtime");
  const configDir = join(base, "config");
  const path = join(base, "path");
  const kernel = join(dataDir, "kernels", "openwrangler-comparison");
  for (const directory of [dataDir, runtimeDir, configDir, path, kernel]) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
  }
  writeJsonAtomic(join(kernel, "kernel.json"), {
    argv: [python, "-I", "-m", "ipykernel_launcher", "-f", "{connection_file}"],
    display_name: "Python 3.12 (Comparison)",
    language: "python",
    metadata: { debugger: false }
  });
  return { dataDir, runtimeDir, configDir, path };
}

export function comparisonHostRequest(request) {
  return {
    ...request,
    cell: {
      id: request.cell.id,
      engine: request.cell.engine,
      format: request.cell.format,
      rows: request.cell.rows,
      columns: request.cell.columns,
      source: request.cell.source,
      variableName: request.cell.variableName
    },
    editor: {
      path: request.editor.path,
      version: request.editor.version,
      sha256: request.editor.sha256
    }
  };
}

async function prepareExtensionDirectory({
  request,
  editor,
  userData,
  extensions,
  candidate,
  sandboxArgs,
  environment
}) {
  const marker = join(extensions, ".openwrangler-comparison.json");
  const expected = {
    product: request.product,
    candidateSha256: request.candidate.sha256,
    dataWranglerVersion: request.dataWranglerVersion,
    commonExtensions: [...COMPARISON_COMMON_EXTENSION_LOCK]
  };
  const verifyInventory = () =>
    verifyComparisonExtensionInventory({
      editor,
      userData,
      extensions,
      sandboxArgs,
      environment,
      product: request.product,
      productVersion: request.product === "open-wrangler" ? request.candidate.version : request.dataWranglerVersion,
      label: `Verify ${request.product} comparison extensions`
    });
  if (existsSync(marker) && JSON.stringify(readJson(marker)) === JSON.stringify(expected)) {
    await verifyInventory();
    return;
  }
  rmSync(extensions, { force: true, recursive: true });
  mkdirSync(extensions, { recursive: true, mode: 0o700 });
  for (const target of COMPARISON_COMMON_EXTENSION_LOCK) {
    await installComparisonExtension({
      editor,
      userData,
      extensions,
      target,
      kind: "marketplace",
      sandboxArgs,
      environment,
      label: `Install ${target}`
    });
  }
  if (request.product === "open-wrangler") {
    await installComparisonExtension({
      editor,
      userData,
      extensions,
      target: candidate,
      kind: "owned-vsix",
      allowedPrivateVsixPaths: [candidate],
      sandboxArgs,
      environment,
      label: "Install the Open Wrangler candidate"
    });
  } else {
    await installComparisonExtension({
      editor,
      userData,
      extensions,
      target: DATA_WRANGLER_MARKETPLACE_EXTENSION,
      kind: "marketplace",
      sandboxArgs,
      environment,
      label: "Install Microsoft Data Wrangler 1.24.2"
    });
  }
  await verifyInventory();
  writeJsonAtomic(marker, expected);
}

export function summarizePss(samples, milestones) {
  return summarizeStudyPssSamples(samples, milestones);
}

function validateRequest(request) {
  if (
    !request ||
    request.protocol !== REQUEST_PROTOCOL ||
    !["open-wrangler", "data-wrangler"].includes(request.product) ||
    !["warm", "cold"].includes(request.kind) ||
    !Number.isSafeInteger(request.order) ||
    request.order < 0 ||
    request.order > 255 ||
    request.preActionSettleMs !== 10_000 ||
    !isAbsolute(request.isolatedRoot) ||
    !isAbsolute(request.notebookPath) ||
    !isAbsolute(request.cell?.source) ||
    !SHA256.test(request.cell?.sourceSha256 ?? "") ||
    !isAbsolute(request.candidate?.path) ||
    !SHA256.test(request.candidate?.sha256 ?? "") ||
    !isAbsolute(request.editor?.path) ||
    !isAbsolute(request.editor?.cliPath) ||
    !SHA256.test(request.editor?.sha256 ?? "") ||
    !SHA256.test(request.editor?.cliSha256 ?? "") ||
    !isAbsolute(request.python?.path) ||
    !SHA256.test(request.python?.sha256 ?? "")
  ) {
    throw new TypeError("Neutral comparison request is malformed.");
  }
}

export function verifyComparisonSource(path, expected) {
  verifyFileHash(path, expected, "private comparison source");
}

function requireContained(root, path, label) {
  const canonicalRoot = realpathSync(root);
  const canonical = existsSync(path) ? realpathSync(path) : resolve(path);
  const child = relative(canonicalRoot, canonical);
  if (child === "" || child === ".." || child.startsWith(`..${sep}`) || isAbsolute(child)) {
    throw new Error(`Comparison ${label} must stay inside its isolated root.`);
  }
}

function verifyFileHash(path, expected, label) {
  const actual = createHash("sha256").update(readPinnedRegularFile(path, label)).digest("hex");
  if (actual !== expected) throw new Error(`${label} SHA-256 changed.`);
}

function readJson(path) {
  return JSON.parse(readPinnedRegularFile(path, "Comparison JSON", MAX_JSON_BYTES).toString("utf8"));
}

function readPinnedRegularFile(path, label, maxBytes) {
  const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
  let descriptor;
  try {
    descriptor = openSync(path, constants.O_RDONLY | noFollow);
    const descriptorBefore = fstatSync(descriptor, { bigint: true });
    const pathBefore = lstatSync(path, { bigint: true });
    if (
      !descriptorBefore.isFile() ||
      !pathBefore.isFile() ||
      pathBefore.isSymbolicLink() ||
      !sameFileSnapshot(descriptorBefore, pathBefore) ||
      descriptorBefore.size <= 0n ||
      (maxBytes !== undefined && descriptorBefore.size > BigInt(maxBytes))
    ) {
      throw new Error(`${label} is missing, unsafe, or too large.`);
    }
    const content = readFileSync(descriptor);
    const descriptorAfter = fstatSync(descriptor, { bigint: true });
    const pathAfter = lstatSync(path, { bigint: true });
    if (
      BigInt(content.byteLength) !== descriptorBefore.size ||
      !sameFileSnapshot(descriptorBefore, descriptorAfter) ||
      !sameFileSnapshot(descriptorBefore, pathAfter)
    ) {
      throw new Error(`${label} changed while it was read.`);
    }
    return content;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function sameFileSnapshot(left, right) {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.nlink === right.nlink &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

function writeJsonAtomic(path, value) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}

function parseArguments(arguments_) {
  if (arguments_.length !== 4 || arguments_[0] !== "--request" || arguments_[2] !== "--out") {
    throw new Error("Usage: data-wrangler-comparison-neutral-driver --request <request.json> --out <result.json>");
  }
  return { requestPath: resolve(arguments_[1]), outputPath: resolve(arguments_[3]) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runDataWranglerComparisonNeutralDriver(parseArguments(process.argv.slice(2))).catch((error) => {
    console.error(`Neutral comparison driver failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
