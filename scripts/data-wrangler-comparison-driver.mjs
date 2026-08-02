import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import {
  describeEditorAcceptanceHarnessFailure,
  EDITOR_ACCEPTANCE_PROGRESS_MAX_BYTES,
  EDITOR_ACCEPTANCE_PROGRESS_PROTOCOL,
  EDITOR_HARNESS_ERROR_MAX_CHARACTERS,
  EDITOR_HARNESS_RESULT_MAX_BYTES,
  runBoundedEditorCliCommand,
  serializeEditorAcceptanceHarnessOutcome
} from "./editor-acceptance.mjs";
import { DATA_WRANGLER_COMPARISON_DRIVER_EXTENSION } from "./data-wrangler-comparison-driver-contract.mjs";

export { DATA_WRANGLER_COMPARISON_DRIVER_EXTENSION } from "./data-wrangler-comparison-driver-contract.mjs";

const DRIVER_SOURCE_MAX_BYTES = 64 * 1024;
const DRIVER_MANIFEST_MAX_BYTES = 8 * 1024;
const DRIVER_VSIX_MAX_BYTES = 1024 * 1024;
const JOURNEY_GRAPH_MAX_FILES = 64;
const JOURNEY_GRAPH_MAX_BYTES = 2 * 1024 * 1024;
const TEST_MODULE_BASENAME = "dataWranglerComparisonNotebookTrial.js";
const ALLOWED_EXTERNAL_IMPORTS = new Set(["playwright-core", "vscode"]);
const PRODUCT_ENTRYPOINT_MARKERS = Object.freeze([
  "Matt17BR.openwrangler",
  "openwrangler_runtime",
  "/dist/extension.js",
  "\\dist\\extension.js",
  "/src/extension/extension",
  "\\src\\extension\\extension"
]);
const driverVsixReceipts = new WeakSet();

function fail(message) {
  throw new TypeError(message);
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value, expected, label) {
  if (!isRecord(value)) fail(`${label} must be an object.`);
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  if (actual.length !== sortedExpected.length || actual.some((key, index) => key !== sortedExpected[index])) {
    fail(`${label} has missing or unknown fields.`);
  }
}

function boundedSource(value, maximumBytes, label) {
  if (typeof value !== "string" || value.length === 0 || Buffer.byteLength(value, "utf8") > maximumBytes) {
    fail(`${label} is missing or too large.`);
  }
  return value;
}

function validateTestModulePath(path, { lstat = lstatSync, realpath = realpathSync } = {}) {
  if (
    typeof path !== "string" ||
    !isAbsolute(path) ||
    resolve(path) !== path ||
    /[\0\r\n]/u.test(path) ||
    basename(path) !== TEST_MODULE_BASENAME ||
    basename(dirname(path)) !== "extensionHost" ||
    basename(dirname(dirname(path))) !== "test" ||
    basename(dirname(dirname(dirname(path)))) !== "dist-test"
  ) {
    fail(`The comparison driver requires the exact compiled ${TEST_MODULE_BASENAME} module.`);
  }
  let metadata;
  let canonicalPath;
  try {
    metadata = lstat(path, { bigint: true });
    canonicalPath = realpath(path);
  } catch (error) {
    throw new Error("The comparison driver test module could not be inspected.", { cause: error });
  }
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.nlink !== 1n ||
    (typeof process.getuid === "function" && metadata.uid !== BigInt(process.getuid())) ||
    canonicalPath !== path
  ) {
    fail("The comparison driver test module must be one current-user-owned regular file at its canonical path.");
  }
  return path;
}

function isContainedPath(root, path) {
  const child = relative(root, path);
  return child.length > 0 && child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child);
}

function resolveRelativeJourneyImport(importer, specifier, root, exists) {
  const base = resolve(dirname(importer), specifier);
  const candidates = basename(base).includes(".") ? [base] : [`${base}.js`, `${base}.cjs`, resolve(base, "index.js")];
  const matches = candidates.filter((candidate) => exists(candidate));
  if (matches.length !== 1 || !isContainedPath(root, matches[0])) {
    fail("The comparison journey has an unresolved, ambiguous, or out-of-root relative import.");
  }
  return matches[0];
}

export function proveDataWranglerComparisonJourneyGraph(
  testModule,
  { exists = existsSync, lstat = lstatSync, readFile = readFileSync, realpath = realpathSync } = {}
) {
  validateTestModulePath(testModule, { lstat, realpath });
  const root = dirname(dirname(dirname(testModule)));
  const pending = [testModule];
  const visited = new Set();
  const modules = [];
  let totalBytes = 0;
  while (pending.length > 0) {
    const path = pending.pop();
    if (visited.has(path)) continue;
    if (visited.size >= JOURNEY_GRAPH_MAX_FILES) {
      fail("The comparison journey dependency graph exceeds its file bound.");
    }
    const canonicalPath = realpath(path);
    const metadata = lstat(path, { bigint: true });
    const pathWithinRoot = relative(root, canonicalPath).split(sep).join("/");
    if (
      canonicalPath !== path ||
      !metadata.isFile() ||
      metadata.isSymbolicLink() ||
      metadata.nlink !== 1n ||
      (typeof process.getuid === "function" && metadata.uid !== BigInt(process.getuid())) ||
      (!pathWithinRoot.startsWith("test/extensionHost/") && !pathWithinRoot.startsWith("shared/")) ||
      pathWithinRoot === "test/extensionHost/index.js"
    ) {
      fail("The comparison journey dependency graph left its neutral test/shared roots.");
    }
    const source = readFile(path, "utf8");
    const bytes = Buffer.byteLength(source, "utf8");
    totalBytes += bytes;
    if (bytes === 0 || totalBytes > JOURNEY_GRAPH_MAX_BYTES) {
      fail("The comparison journey dependency graph is empty or exceeds its byte bound.");
    }
    if (
      PRODUCT_ENTRYPOINT_MARKERS.some((marker) => source.includes(marker)) ||
      source.includes("vscode.extensions.getExtension")
    ) {
      fail("The comparison journey dependency graph can reach the Open Wrangler product extension.");
    }
    const requireCalls = [...source.matchAll(/require\s*\(/gu)];
    const literalRequires = [...source.matchAll(/require\s*\(\s*("(?:[^"\\]|\\.)*")\s*\)/gu)].map((match) =>
      JSON.parse(match[1])
    );
    if (requireCalls.length !== literalRequires.length) {
      fail("The comparison journey dependency graph contains a dynamic import.");
    }
    for (const specifier of literalRequires) {
      if (specifier.startsWith(".")) {
        pending.push(resolveRelativeJourneyImport(path, specifier, root, exists));
      } else if (!specifier.startsWith("node:") && !ALLOWED_EXTERNAL_IMPORTS.has(specifier)) {
        fail(`The comparison journey imports unapproved external package ${specifier}.`);
      }
    }
    visited.add(path);
    modules.push({
      path: pathWithinRoot,
      sha256: createHash("sha256").update(source, "utf8").digest("hex")
    });
  }
  modules.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  const graphSha256 = createHash("sha256").update(JSON.stringify(modules), "utf8").digest("hex");
  return Object.freeze({
    entry: relative(root, testModule).split(sep).join("/"),
    moduleCount: modules.length,
    totalBytes,
    graphSha256,
    modules: Object.freeze(modules.map((entry) => Object.freeze(entry)))
  });
}

function driverManifest() {
  return {
    name: DATA_WRANGLER_COMPARISON_DRIVER_EXTENSION.name,
    displayName: "Notebook comparison driver",
    version: DATA_WRANGLER_COMPARISON_DRIVER_EXTENSION.version,
    publisher: DATA_WRANGLER_COMPARISON_DRIVER_EXTENSION.publisher,
    private: true,
    engines: { vscode: "^1.106.0" },
    extensionKind: ["workspace"],
    main: "./extension.js",
    files: ["extension.js"],
    activationEvents: ["*"],
    capabilities: {
      untrustedWorkspaces: {
        supported: true
      }
    }
  };
}

function driverSource(testModule) {
  return `"use strict";
const crypto = require("node:crypto");
const fs = require("node:fs");
const vscode = require("vscode");
const runNotebookComparisonJourney = require(${JSON.stringify(testModule)}).run;

function publishFile(targetPath, contents) {
  const temporaryPath = targetPath + "." + process.pid + "." + crypto.randomUUID() + ".tmp";
  try {
    fs.writeFileSync(temporaryPath, contents, { encoding: "utf8", flag: "wx", mode: 0o600 });
    const temporary = fs.lstatSync(temporaryPath, { bigint: true });
    if (!temporary.isFile() || temporary.isSymbolicLink() || temporary.nlink !== 1n) {
      throw new Error("The comparison-driver temporary result is not exclusively owned.");
    }
    fs.renameSync(temporaryPath, targetPath);
  } finally {
    try { fs.rmSync(temporaryPath, { force: true }); } catch {}
  }
}

function recordProgress(runId, phase, checkpoint) {
  const progressPath = process.env.OPEN_WRANGLER_TEST_PROGRESS;
  if (!progressPath) return;
  const serialized = JSON.stringify({ protocol: ${EDITOR_ACCEPTANCE_PROGRESS_PROTOCOL}, runId, phase, checkpoint }) + "\\n";
  if (Buffer.byteLength(serialized, "utf8") > ${EDITOR_ACCEPTANCE_PROGRESS_MAX_BYTES}) {
    throw new Error("The comparison-driver progress envelope exceeded its fixed byte limit.");
  }
  publishFile(progressPath, serialized);
  publishFile(progressPath + "." + runId.replaceAll("-", "") + "." + phase + ".heartbeat", "");
}

const EDITOR_HARNESS_ERROR_MAX_CHARACTERS = ${EDITOR_HARNESS_ERROR_MAX_CHARACTERS};
const EDITOR_HARNESS_RESULT_MAX_BYTES = ${EDITOR_HARNESS_RESULT_MAX_BYTES};
const OVERSIZED_EDITOR_DIAGNOSTIC = "Acceptance failed with an oversized diagnostic.";
const describeFailure = ${describeEditorAcceptanceHarnessFailure.toString()};
const serializeOutcome = ${serializeEditorAcceptanceHarnessOutcome.toString()};

exports.activate = async function () {
  const phase = process.env.OPEN_WRANGLER_TEST_PHASE || "unknown";
  const runId = process.env.OPEN_WRANGLER_TEST_RUN_ID || "missing-run-id";
  const envelope = { protocol: ${EDITOR_ACCEPTANCE_PROGRESS_PROTOCOL}, runId, phase };
  recordProgress(runId, phase, phase + ":driver-start");
  let outcome;
  try {
    const evidence = await runNotebookComparisonJourney();
    outcome = evidence === undefined ? { ...envelope, ok: true } : { ...envelope, ok: true, evidence };
  } catch (error) {
    outcome = { ...envelope, ok: false, error: describeFailure(error) };
  }
  publishFile(process.env.OPEN_WRANGLER_TEST_RESULT, serializeOutcome(outcome, envelope));
  setTimeout(() => void vscode.commands.executeCommand("workbench.action.quit"), 2_000);
  setTimeout(() => void vscode.commands.executeCommand("workbench.action.closeWindow"), 500);
};
`;
}

export function validateDataWranglerComparisonDriverBundle({ manifest, source, expectedTestModule }) {
  exactKeys(
    manifest,
    [
      "name",
      "displayName",
      "version",
      "publisher",
      "private",
      "engines",
      "extensionKind",
      "main",
      "files",
      "activationEvents",
      "capabilities"
    ],
    "Comparison-driver manifest"
  );
  const expectedManifest = driverManifest();
  if (JSON.stringify(manifest) !== JSON.stringify(expectedManifest)) {
    fail("The comparison-driver manifest does not match its neutral locked package.");
  }
  boundedSource(source, DRIVER_SOURCE_MAX_BYTES, "Comparison-driver source");
  const expectedRequire = `require(${JSON.stringify(expectedTestModule)})`;
  if (!source.includes(`const runNotebookComparisonJourney = ${expectedRequire}.run;`)) {
    fail("The comparison driver is not pinned to its notebook journey module.");
  }
  const literalRequires = [...source.matchAll(/require\(("(?:[^"\\]|\\.)*")\)/gu)].map((match) => JSON.parse(match[1]));
  const expectedRequires = ["node:crypto", "node:fs", "vscode", expectedTestModule];
  if (
    literalRequires.length !== expectedRequires.length ||
    literalRequires.some((entry, index) => entry !== expectedRequires[index]) ||
    /require\((?!")/u.test(source)
  ) {
    fail("The comparison driver imports code outside its fixed neutral module list.");
  }
  if (
    PRODUCT_ENTRYPOINT_MARKERS.some((marker) => source.includes(marker)) ||
    source.includes("vscode.extensions.getExtension")
  ) {
    fail("The comparison driver may not import or activate the Open Wrangler product extension.");
  }
  return Object.freeze({
    extension: DATA_WRANGLER_COMPARISON_DRIVER_EXTENSION,
    manifestSha256: createHash("sha256").update(JSON.stringify(manifest), "utf8").digest("hex"),
    sourceSha256: createHash("sha256").update(source, "utf8").digest("hex")
  });
}

export function writeDataWranglerComparisonDriver(directory, testModule, dependencies = {}) {
  const hooks = {
    exists: existsSync,
    lstat: lstatSync,
    mkdir: mkdirSync,
    readFile: readFileSync,
    realpath: realpathSync,
    remove: rmSync,
    writeFile: writeFileSync,
    ...dependencies
  };
  const unknown = Object.keys(dependencies).filter(
    (key) => !["exists", "lstat", "mkdir", "readFile", "realpath", "remove", "writeFile"].includes(key)
  );
  if (unknown.length > 0) fail(`Unknown comparison-driver dependency ${unknown[0]}.`);
  if (
    typeof directory !== "string" ||
    !isAbsolute(directory) ||
    resolve(directory) !== directory ||
    /[\0\r\n]/u.test(directory)
  ) {
    fail("The comparison driver requires one canonical absolute output directory.");
  }
  validateTestModulePath(testModule, hooks);
  const journeyGraph = proveDataWranglerComparisonJourneyGraph(testModule, {
    exists: hooks.exists,
    lstat: hooks.lstat,
    readFile: hooks.readFile,
    realpath: hooks.realpath
  });
  const manifest = driverManifest();
  const source = driverSource(testModule);
  validateDataWranglerComparisonDriverBundle({ manifest, source, expectedTestModule: testModule });
  let created = false;
  try {
    hooks.mkdir(directory, { mode: 0o700 });
    created = true;
    hooks.writeFile(resolve(directory, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600
    });
    hooks.writeFile(resolve(directory, "extension.js"), source, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600
    });
    const writtenManifest = JSON.parse(
      boundedSource(
        hooks.readFile(resolve(directory, "package.json"), "utf8"),
        DRIVER_MANIFEST_MAX_BYTES,
        "Written comparison-driver manifest"
      )
    );
    const writtenSource = boundedSource(
      hooks.readFile(resolve(directory, "extension.js"), "utf8"),
      DRIVER_SOURCE_MAX_BYTES,
      "Written comparison-driver source"
    );
    const receipt = validateDataWranglerComparisonDriverBundle({
      manifest: writtenManifest,
      source: writtenSource,
      expectedTestModule: testModule
    });
    return Object.freeze({ directory, testModule, journeyGraph, ...receipt });
  } catch (error) {
    if (created) {
      try {
        hooks.remove(directory, { recursive: true, force: true });
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], "The comparison driver failed and could not clean up.");
      }
    }
    throw error;
  }
}

async function createDriverVsix(options) {
  const { createVSIX } = await import("@vscode/vsce");
  return createVSIX(options);
}

function captureDriverVsix(path, hooks) {
  const metadata = hooks.lstat(path, { bigint: true });
  const canonicalPath = hooks.realpath(path);
  if (
    canonicalPath !== path ||
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.nlink !== 1n ||
    metadata.size <= 0n ||
    metadata.size > BigInt(DRIVER_VSIX_MAX_BYTES) ||
    (typeof process.getuid === "function" && metadata.uid !== BigInt(process.getuid()))
  ) {
    fail("The packaged comparison driver must be one bounded current-user-owned VSIX.");
  }
  const bytes = hooks.readFile(path);
  if (!Buffer.isBuffer(bytes) || bytes.length !== Number(metadata.size)) {
    fail("The packaged comparison driver could not be read completely.");
  }
  return Object.freeze({
    path,
    bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    identity: Object.freeze({
      dev: metadata.dev.toString(),
      ino: metadata.ino.toString(),
      size: metadata.size.toString(),
      mtimeNs: metadata.mtimeNs.toString(),
      ctimeNs: metadata.ctimeNs.toString()
    })
  });
}

export async function packageDataWranglerComparisonDriver(
  { directory, testModule, vsixPath },
  { createVsix = createDriverVsix, ...fileDependencies } = {}
) {
  const pathExists = fileDependencies.exists ?? existsSync;
  if (
    typeof directory !== "string" ||
    !isAbsolute(directory) ||
    resolve(directory) !== directory ||
    typeof vsixPath !== "string" ||
    !isAbsolute(vsixPath) ||
    resolve(vsixPath) !== vsixPath ||
    /[\0\r\n]/u.test(vsixPath) ||
    basename(vsixPath) !== "notebook-comparison-driver.vsix" ||
    isContainedPath(directory, vsixPath) ||
    pathExists(vsixPath)
  ) {
    fail("The comparison driver requires one separate canonical notebook-comparison-driver.vsix path.");
  }
  if (typeof createVsix !== "function") fail("The comparison-driver packager must be a function.");
  const written = writeDataWranglerComparisonDriver(directory, testModule, fileDependencies);
  await createVsix({
    cwd: directory,
    packagePath: vsixPath,
    dependencies: false,
    skipLicense: true,
    allowStarActivation: true,
    allowMissingRepository: true
  });
  const hooks = {
    lstat: fileDependencies.lstat ?? lstatSync,
    readFile: fileDependencies.readFile ?? readFileSync,
    realpath: fileDependencies.realpath ?? realpathSync
  };
  const vsix = captureDriverVsix(vsixPath, hooks);
  const receipt = Object.freeze({ ...written, vsix });
  driverVsixReceipts.add(receipt);
  return receipt;
}

export function revalidateDataWranglerComparisonDriver(receipt, dependencies = {}) {
  if (!driverVsixReceipts.has(receipt)) {
    fail("Comparison-driver revalidation requires an authentic packaged receipt.");
  }
  const hooks = {
    lstat: dependencies.lstat ?? lstatSync,
    readFile: dependencies.readFile ?? readFileSync,
    realpath: dependencies.realpath ?? realpathSync
  };
  const manifest = JSON.parse(hooks.readFile(resolve(receipt.directory, "package.json"), "utf8"));
  const source = hooks.readFile(resolve(receipt.directory, "extension.js"), "utf8");
  const bundle = validateDataWranglerComparisonDriverBundle({
    manifest,
    source,
    expectedTestModule: receipt.testModule
  });
  const journeyGraph = proveDataWranglerComparisonJourneyGraph(receipt.testModule, {
    exists: dependencies.exists ?? existsSync,
    lstat: hooks.lstat,
    readFile: hooks.readFile,
    realpath: hooks.realpath
  });
  const current = captureDriverVsix(receipt.vsix.path, hooks);
  if (
    bundle.manifestSha256 !== receipt.manifestSha256 ||
    bundle.sourceSha256 !== receipt.sourceSha256 ||
    journeyGraph.graphSha256 !== receipt.journeyGraph.graphSha256 ||
    current.sha256 !== receipt.vsix.sha256 ||
    current.bytes !== receipt.vsix.bytes ||
    JSON.stringify(current.identity) !== JSON.stringify(receipt.vsix.identity)
  ) {
    fail("The packaged comparison driver changed after it was captured.");
  }
  return receipt;
}

export async function installDataWranglerComparisonDriver(
  { receipt, editor, userData, extensions, sandboxArgs, environment, label },
  { runCli = runBoundedEditorCliCommand } = {}
) {
  revalidateDataWranglerComparisonDriver(receipt);
  if (
    !isRecord(editor) ||
    typeof userData !== "string" ||
    typeof extensions !== "string" ||
    !Array.isArray(sandboxArgs) ||
    !isRecord(environment) ||
    typeof label !== "string" ||
    label.length === 0 ||
    /[\0\r\n]/u.test(label) ||
    typeof runCli !== "function"
  ) {
    fail("Comparison-driver installation received malformed editor inputs.");
  }
  const result = await runCli(
    {
      editor,
      args: [
        "--user-data-dir",
        userData,
        "--extensions-dir",
        extensions,
        "--install-extension",
        receipt.vsix.path,
        "--force",
        ...sandboxArgs
      ],
      environment,
      label
    },
    { timeoutMs: 60_000 }
  );
  revalidateDataWranglerComparisonDriver(receipt);
  return result;
}

function normalizeArmInventory(entries) {
  if (!Array.isArray(entries) || entries.length === 0 || entries.length > 64) {
    fail("Comparison-arm inventory must contain one to 64 extensions.");
  }
  const identities = new Set();
  const normalized = entries.map((entry) => {
    exactKeys(entry, ["extensionId", "version"], "Comparison-arm extension inventory entry");
    if (
      typeof entry.extensionId !== "string" ||
      !/^[A-Za-z0-9][A-Za-z0-9-]{0,63}\.[A-Za-z0-9][A-Za-z0-9-]{0,127}$/u.test(entry.extensionId) ||
      typeof entry.version !== "string" ||
      !/^[0-9A-Za-z][0-9A-Za-z._+-]{0,127}$/u.test(entry.version)
    ) {
      fail("Comparison-arm extension inventory entry is invalid.");
    }
    const identity = entry.extensionId.toLowerCase();
    if (identities.has(identity)) fail("Comparison-arm extension inventory IDs must be unique.");
    identities.add(identity);
    return { extensionId: entry.extensionId, version: entry.version };
  });
  normalized.sort((left, right) =>
    left.extensionId < right.extensionId ? -1 : left.extensionId > right.extensionId ? 1 : 0
  );
  return normalized;
}

export function assertDataWranglerComparisonArmInventory(entries, { product, expectedExtensions }) {
  if (product !== "open-wrangler" && product !== "data-wrangler") {
    fail("Comparison arm must name Open Wrangler or Data Wrangler.");
  }
  const normalized = normalizeArmInventory(entries);
  const expected = normalizeArmInventory(expectedExtensions);
  if (JSON.stringify(normalized) !== JSON.stringify(expected)) {
    fail("Comparison arm does not match its exact extension inventory.");
  }
  const ids = normalized.map((entry) => entry.extensionId.toLowerCase());
  const driverCount = ids.filter(
    (id) => id === DATA_WRANGLER_COMPARISON_DRIVER_EXTENSION.extensionId.toLowerCase()
  ).length;
  const openWranglerCount = ids.filter((id) => id === "matt17br.openwrangler").length;
  const dataWranglerCount = ids.filter((id) => id === "ms-toolsai.datawrangler").length;
  if (
    driverCount !== 1 ||
    (product === "open-wrangler" && (openWranglerCount !== 1 || dataWranglerCount !== 0)) ||
    (product === "data-wrangler" && (dataWranglerCount !== 1 || openWranglerCount !== 0))
  ) {
    fail("Comparison arm requires the neutral driver and exactly one measured product.");
  }
  return Object.freeze(normalized.map((entry) => Object.freeze(entry)));
}

export async function runDataWranglerComparisonNeutralDriverPhase(
  { product, receipt, expectedExtensions, driverInstallation, editorPhaseOptions },
  { installDriver = installDataWranglerComparisonDriver, readInventory, runPhase } = {}
) {
  if (
    typeof installDriver !== "function" ||
    typeof readInventory !== "function" ||
    typeof runPhase !== "function" ||
    !isRecord(driverInstallation) ||
    !isRecord(editorPhaseOptions)
  ) {
    fail("Neutral comparison phase requires driver installation, inventory, and phase callbacks.");
  }
  if (
    Object.hasOwn(editorPhaseOptions, "developmentPaths") &&
    (!Array.isArray(editorPhaseOptions.developmentPaths) || editorPhaseOptions.developmentPaths.length !== 0)
  ) {
    fail("Neutral comparison phases cannot load an extension development path.");
  }
  await installDriver({ receipt, ...driverInstallation });
  const before = assertDataWranglerComparisonArmInventory(await readInventory(), { product, expectedExtensions });
  const phaseResult = await runPhase({ ...editorPhaseOptions, developmentPaths: [] });
  const after = assertDataWranglerComparisonArmInventory(await readInventory(), { product, expectedExtensions });
  if (JSON.stringify(before) !== JSON.stringify(after)) {
    fail("Comparison-arm extension inventory changed during the measured phase.");
  }
  return Object.freeze({ installedExtensions: before, phaseResult });
}
