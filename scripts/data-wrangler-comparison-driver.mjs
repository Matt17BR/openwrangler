import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  closeSync,
  constants as fsConstants,
  cpSync,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { inflateRawSync } from "node:zlib";
import ts from "typescript";
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
const DRIVER_VSIX_MAX_BYTES = 32 * 1024 * 1024;
const DRIVER_VSIX_MAX_ENTRIES = 324;
const DRIVER_VSIX_ENTRY_MAX_BYTES = 8 * 1024 * 1024;
const DRIVER_VSIX_UNCOMPRESSED_MAX_BYTES = 32 * 1024 * 1024;
const DRIVER_VSIX_ENTRY_NAME_MAX_BYTES = 512;
const JOURNEY_GRAPH_MAX_FILES = 64;
const JOURNEY_GRAPH_MAX_BYTES = 2 * 1024 * 1024;
const PLAYWRIGHT_GRAPH_MAX_FILES = 256;
const PLAYWRIGHT_GRAPH_MAX_BYTES = 32 * 1024 * 1024;
const PLAYWRIGHT_FILE_MAX_BYTES = 8 * 1024 * 1024;
const PACKAGE_LOCK_MAX_BYTES = 4 * 1024 * 1024;
const PLAYWRIGHT_CORE_LOCKED_VERSION = "1.61.1";
const TEST_MODULE_BASENAME = "dataWranglerComparisonNotebookTrial.js";
const JOURNEY_ENTRY = `test/extensionHost/${TEST_MODULE_BASENAME}`;
const PACKAGED_JOURNEY_REQUIRE = `./journey/${JOURNEY_ENTRY}`;
const PLAYWRIGHT_PACKAGE_ROOT = realpathSync(dirname(fileURLToPath(import.meta.resolve("playwright-core"))));
const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ALLOWED_EXTERNAL_IMPORTS = new Set([
  "node:assert/strict",
  "node:child_process",
  "node:crypto",
  "node:fs",
  "node:path",
  "node:perf_hooks",
  "playwright-core",
  "vscode"
]);
const EDITOR_TEMP_ROOT_ENV = "OPEN_WRANGLER_EDITOR_TEMP_ROOT";
const DRIVER_ARCHIVE_METADATA_PATHS = new Set(["[Content_Types].xml", "extension.vsixmanifest"]);
const PRODUCT_ENTRYPOINT_MARKERS = Object.freeze([
  "Matt17BR.openwrangler",
  "openwrangler_runtime",
  "/dist/extension.js",
  "\\dist\\extension.js",
  "/src/extension/extension",
  "\\src\\extension\\extension"
]);
const driverVsixReceipts = new WeakSet();
const driverProfileReceipts = new WeakSet();
const driverProfileFilesystemReceipts = new WeakMap();

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

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
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

function sameMetadata(left, right) {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

function validateCanonicalDirectory(path, label, { lstat = lstatSync, realpath = realpathSync } = {}) {
  if (typeof path !== "string" || !isAbsolute(path) || resolve(path) !== path || /[\0\r\n]/u.test(path)) {
    fail(`${label} must be one canonical absolute directory.`);
  }
  let metadata;
  let canonicalPath;
  try {
    metadata = lstat(path, { bigint: true });
    canonicalPath = realpath(path);
  } catch (error) {
    throw new Error(`${label} could not be inspected.`, { cause: error });
  }
  if (
    canonicalPath !== path ||
    !metadata.isDirectory() ||
    metadata.isSymbolicLink() ||
    (typeof process.getuid === "function" && metadata.uid !== BigInt(process.getuid()))
  ) {
    fail(`${label} must be one current-user-owned directory at its canonical path.`);
  }
  return path;
}

function captureDirectoryIdentity(
  path,
  label,
  { requirePrivateMode = false, lstat = lstatSync, realpath = realpathSync } = {}
) {
  validateCanonicalDirectory(path, label, { lstat, realpath });
  const metadata = lstat(path, { bigint: true });
  if (requirePrivateMode && (metadata.mode & 0o777n) !== 0o700n) {
    fail(`${label} must use private mode 0700.`);
  }
  return Object.freeze({
    path,
    device: metadata.dev.toString(),
    inode: metadata.ino.toString(),
    owner: metadata.uid.toString(),
    mode: Number(metadata.mode & 0o777n)
  });
}

function revalidateDirectoryIdentity(
  receipt,
  label,
  { requirePrivateMode = false, lstat = lstatSync, realpath = realpathSync } = {}
) {
  const current = captureDirectoryIdentity(receipt.path, label, { requirePrivateMode, lstat, realpath });
  if (
    current.device !== receipt.device ||
    current.inode !== receipt.inode ||
    current.owner !== receipt.owner ||
    current.mode !== receipt.mode
  ) {
    fail(`${label} changed after its filesystem identity was pinned.`);
  }
  return receipt;
}

function requirePhysicalContainment(root, child, label) {
  const childPath = relative(root.path, child.path);
  if (childPath.length === 0 || childPath === ".." || childPath.startsWith(`..${sep}`) || isAbsolute(childPath)) {
    fail(`${label} must stay inside the private comparison profile root.`);
  }
}

function readStableOwnedFile(path, maximumBytes, label, hooks) {
  let before;
  let canonicalBefore;
  try {
    before = hooks.lstat(path, { bigint: true });
    canonicalBefore = hooks.realpath(path);
  } catch (error) {
    throw new Error(`${label} could not be inspected.`, { cause: error });
  }
  if (
    canonicalBefore !== path ||
    !before.isFile() ||
    before.isSymbolicLink() ||
    before.nlink !== 1n ||
    before.size <= 0n ||
    before.size > BigInt(maximumBytes) ||
    (typeof process.getuid === "function" && before.uid !== BigInt(process.getuid()))
  ) {
    fail(`${label} must be one bounded current-user-owned regular file at its canonical path.`);
  }
  const bytes = hooks.readFile(path);
  const after = hooks.lstat(path, { bigint: true });
  const canonicalAfter = hooks.realpath(path);
  if (
    !Buffer.isBuffer(bytes) ||
    bytes.length !== Number(before.size) ||
    canonicalAfter !== path ||
    !sameMetadata(before, after)
  ) {
    fail(`${label} changed while it was read.`);
  }
  return bytes;
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

function isExactModuleExportsReference(node) {
  return (
    ts.isIdentifier(node) &&
    node.text === "module" &&
    ts.isPropertyAccessExpression(node.parent) &&
    node.parent.expression === node &&
    node.parent.name.text === "exports" &&
    ts.isBinaryExpression(node.parent.parent) &&
    node.parent.parent.left === node.parent &&
    node.parent.parent.operatorToken.kind === ts.SyntaxKind.EqualsToken
  );
}

function isOrdinaryPropertyNamedModule(node) {
  if (!ts.isIdentifier(node) || node.text !== "module") return false;
  const parent = node.parent;
  return (
    (ts.isPropertyAccessExpression(parent) && parent.name === node) ||
    (ts.isPropertyAssignment(parent) && parent.name === node) ||
    (ts.isMethodDeclaration(parent) && parent.name === node) ||
    (ts.isGetAccessorDeclaration(parent) && parent.name === node) ||
    (ts.isSetAccessorDeclaration(parent) && parent.name === node)
  );
}

/**
 * Enumerate literal CommonJS imports in the reviewed source graph. This is an
 * integrity and review aid, not a JavaScript capability boundary: the checked-in
 * source, compiler, Node, VS Code, and the named packages are trusted inputs.
 */
function staticCommonJsDependencies(source, label) {
  const sourceFile = ts.createSourceFile(label, source, ts.ScriptTarget.ES2022, true, ts.ScriptKind.JS);
  if (sourceFile.parseDiagnostics.length > 0) {
    fail(`${label} is not parseable JavaScript.`);
  }
  const specifiers = [];
  const visit = (node) => {
    if (
      ts.isImportDeclaration(node) ||
      ts.isImportEqualsDeclaration(node) ||
      (ts.isExportDeclaration(node) && node.moduleSpecifier !== undefined) ||
      node.kind === ts.SyntaxKind.ImportKeyword
    ) {
      fail(`${label} contains an unsupported module loader.`);
    }
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "require") {
      if (node.arguments.length !== 1 || !ts.isStringLiteral(node.arguments[0])) {
        fail(`${label} contains a dynamic require.`);
      }
      specifiers.push(node.arguments[0].text);
    }
    if (ts.isIdentifier(node) && node.text === "require") {
      const directStaticRequire =
        ts.isCallExpression(node.parent) &&
        node.parent.expression === node &&
        node.parent.arguments.length === 1 &&
        ts.isStringLiteral(node.parent.arguments[0]);
      if (!directStaticRequire) {
        fail(`${label} contains an unsupported module-loader reference.`);
      }
    }
    if (
      ts.isIdentifier(node) &&
      node.text === "module" &&
      !isExactModuleExportsReference(node) &&
      !isOrdinaryPropertyNamedModule(node)
    ) {
      fail(`${label} contains a CommonJS loader outside the literal import inventory.`);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return specifiers;
}

function proveJourneyGraph(
  root,
  entry,
  { exists = existsSync, lstat = lstatSync, readFile = readFileSync, realpath = realpathSync } = {}
) {
  const pending = [entry];
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
    const metadataAfter = lstat(path, { bigint: true });
    const canonicalPathAfter = realpath(path);
    if (canonicalPathAfter !== path || !sameMetadata(metadata, metadataAfter)) {
      fail("The comparison journey dependency graph changed while it was read.");
    }
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
    const literalRequires = staticCommonJsDependencies(source, "Comparison journey module");
    for (const specifier of literalRequires) {
      if (specifier.startsWith(".")) {
        pending.push(resolveRelativeJourneyImport(path, specifier, root, exists));
      } else if (!ALLOWED_EXTERNAL_IMPORTS.has(specifier)) {
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
    entry: relative(root, entry).split(sep).join("/"),
    moduleCount: modules.length,
    totalBytes,
    graphSha256,
    modules: Object.freeze(modules.map((entry) => Object.freeze(entry)))
  });
}

export function proveDataWranglerComparisonJourneyGraph(
  testModule,
  { exists = existsSync, lstat = lstatSync, readFile = readFileSync, realpath = realpathSync } = {}
) {
  validateTestModulePath(testModule, { lstat, realpath });
  const root = dirname(dirname(dirname(testModule)));
  return proveJourneyGraph(root, testModule, { exists, lstat, readFile, realpath });
}

function provePackagedJourneyGraph(
  directory,
  { exists = existsSync, lstat = lstatSync, readFile = readFileSync, realpath = realpathSync } = {}
) {
  validateCanonicalDirectory(directory, "Comparison-driver directory", { lstat, realpath });
  const root = resolve(directory, "journey");
  validateCanonicalDirectory(root, "Comparison-driver journey directory", { lstat, realpath });
  return proveJourneyGraph(root, resolve(root, JOURNEY_ENTRY), { exists, lstat, readFile, realpath });
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
    dependencies: { "playwright-core": PLAYWRIGHT_CORE_LOCKED_VERSION },
    bundledDependencies: ["playwright-core"],
    activationEvents: ["*"],
    capabilities: {
      untrustedWorkspaces: {
        supported: true
      }
    }
  };
}

function driverSource() {
  return `"use strict";
const crypto = require("node:crypto");
const fs = require("node:fs");
const vscode = require("vscode");
const runNotebookComparisonJourney = require(${JSON.stringify(PACKAGED_JOURNEY_REQUIRE)}).run;

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

export function validateDataWranglerComparisonDriverBundle({ manifest, source }) {
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
      "dependencies",
      "bundledDependencies",
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
  const expectedRequire = `require(${JSON.stringify(PACKAGED_JOURNEY_REQUIRE)})`;
  if (!source.includes(`const runNotebookComparisonJourney = ${expectedRequire}.run;`)) {
    fail("The comparison driver is not pinned to its notebook journey module.");
  }
  const literalRequires = staticCommonJsDependencies(source, "Comparison-driver source");
  const expectedRequires = ["node:crypto", "node:fs", "vscode", PACKAGED_JOURNEY_REQUIRE];
  if (
    literalRequires.length !== expectedRequires.length ||
    literalRequires.some((entry, index) => entry !== expectedRequires[index])
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
  const source = driverSource();
  const manifestText = `${JSON.stringify(manifest, null, 2)}\n`;
  validateDataWranglerComparisonDriverBundle({ manifest, source });
  let created = false;
  try {
    hooks.mkdir(directory, { mode: 0o700 });
    created = true;
    hooks.writeFile(resolve(directory, "package.json"), manifestText, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600
    });
    hooks.writeFile(resolve(directory, "extension.js"), source, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600
    });
    const sourceRoot = dirname(dirname(dirname(testModule)));
    for (const module of journeyGraph.modules) {
      const sourcePath = resolve(sourceRoot, module.path);
      const destination = resolve(directory, "journey", module.path);
      const bytes = hooks.readFile(sourcePath);
      if (
        !Buffer.isBuffer(bytes) ||
        createHash("sha256").update(bytes).digest("hex") !== module.sha256 ||
        !isContainedPath(directory, destination)
      ) {
        fail("The comparison journey changed before it could be copied into the driver.");
      }
      hooks.mkdir(dirname(destination), { recursive: true, mode: 0o700 });
      hooks.writeFile(destination, bytes, { flag: "wx", mode: 0o600 });
    }
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
      source: writtenSource
    });
    const copiedGraph = provePackagedJourneyGraph(directory, {
      exists: hooks.exists,
      lstat: hooks.lstat,
      readFile: hooks.readFile,
      realpath: hooks.realpath
    });
    if (JSON.stringify(copiedGraph) !== JSON.stringify(journeyGraph)) {
      fail("The packaged comparison journey does not match the proven source graph.");
    }
    return Object.freeze({
      directory,
      journeyGraph: copiedGraph,
      packageFiles: Object.freeze({
        packageJsonSha256: createHash("sha256").update(manifestText, "utf8").digest("hex"),
        extensionSourceSha256: createHash("sha256").update(source, "utf8").digest("hex")
      }),
      ...receipt
    });
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

function capturePlaywrightRuntime(root, hooks) {
  validateCanonicalDirectory(root, "Comparison-driver Playwright runtime", hooks);
  const pending = [root];
  const files = [];
  let totalBytes = 0;
  while (pending.length > 0) {
    const directory = pending.pop();
    const entries = hooks
      .readdir(directory, { withFileTypes: true })
      .sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
    for (const entry of entries) {
      if (/[/\\\0\r\n]/u.test(entry.name) || entry.isSymbolicLink()) {
        fail("The comparison-driver Playwright runtime contains an unsafe entry.");
      }
      const path = resolve(directory, entry.name);
      if (!isContainedPath(root, path)) {
        fail("The comparison-driver Playwright runtime escaped its package root.");
      }
      if (entry.isDirectory()) {
        validateCanonicalDirectory(path, "Comparison-driver Playwright directory", hooks);
        pending.push(path);
        continue;
      }
      if (!entry.isFile() || files.length >= PLAYWRIGHT_GRAPH_MAX_FILES) {
        fail("The comparison-driver Playwright runtime exceeds its file bound or contains a special file.");
      }
      const bytes = readStableOwnedFile(path, PLAYWRIGHT_FILE_MAX_BYTES, "Comparison-driver Playwright file", hooks);
      totalBytes += bytes.length;
      if (totalBytes > PLAYWRIGHT_GRAPH_MAX_BYTES) {
        fail("The comparison-driver Playwright runtime exceeds its byte bound.");
      }
      files.push({
        path: relative(root, path).split(sep).join("/"),
        sha256: createHash("sha256").update(bytes).digest("hex")
      });
    }
  }
  files.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  const packageEntry = files.find((entry) => entry.path === "package.json");
  if (packageEntry === undefined) fail("The comparison-driver Playwright runtime has no package manifest.");
  const packageJson = JSON.parse(
    readStableOwnedFile(
      resolve(root, "package.json"),
      16 * 1024,
      "Comparison-driver Playwright manifest",
      hooks
    ).toString("utf8")
  );
  if (
    !isRecord(packageJson) ||
    packageJson.name !== "playwright-core" ||
    typeof packageJson.version !== "string" ||
    !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(packageJson.version)
  ) {
    fail("The comparison-driver Playwright runtime has an invalid package identity.");
  }
  return Object.freeze({
    version: packageJson.version,
    fileCount: files.length,
    totalBytes,
    treeSha256: createHash("sha256").update(JSON.stringify(files), "utf8").digest("hex"),
    files: Object.freeze(files.map((entry) => Object.freeze(entry)))
  });
}

function lockedPlaywrightRuntime(hooks) {
  const lockPath = resolve(REPOSITORY_ROOT, "package-lock.json");
  const lock = JSON.parse(
    readStableOwnedFile(lockPath, PACKAGE_LOCK_MAX_BYTES, "Comparison-driver package lock", hooks).toString("utf8")
  );
  const entry = lock?.packages?.["node_modules/playwright-core"];
  if (
    !isRecord(entry) ||
    typeof entry.version !== "string" ||
    typeof entry.integrity !== "string" ||
    !/^sha512-[A-Za-z0-9+/]+={0,2}$/u.test(entry.integrity)
  ) {
    fail("The comparison-driver package lock does not pin Playwright Core.");
  }
  if (entry.version !== PLAYWRIGHT_CORE_LOCKED_VERSION) {
    fail("The comparison-driver Playwright Core lock changed without updating its private package.");
  }
  return Object.freeze({ version: entry.version, lockIntegrity: entry.integrity });
}

function copyPlaywrightRuntime(directory, hooks) {
  const locked = lockedPlaywrightRuntime(hooks);
  const source = capturePlaywrightRuntime(PLAYWRIGHT_PACKAGE_ROOT, hooks);
  if (source.version !== locked.version) {
    fail("The installed Playwright Core runtime does not match package-lock.json.");
  }
  const destination = resolve(directory, "node_modules", "playwright-core");
  hooks.mkdir(dirname(destination), { recursive: true, mode: 0o700 });
  hooks.copy(PLAYWRIGHT_PACKAGE_ROOT, destination, {
    recursive: true,
    dereference: true,
    errorOnExist: true,
    force: false,
    preserveTimestamps: true
  });
  const copied = capturePlaywrightRuntime(destination, hooks);
  if (JSON.stringify(source) !== JSON.stringify(copied)) {
    fail("The packaged Playwright Core runtime does not match the lockfile-pinned installation.");
  }
  return Object.freeze({ ...copied, lockIntegrity: locked.lockIntegrity });
}

function smokePackagedJourneyModule(directory, hooks) {
  const smokeRoot = hooks.mkdtemp(resolve(tmpdir(), "ow-comparison-driver-smoke-"));
  try {
    const vscodeStubRoot = resolve(smokeRoot, "node_modules", "vscode");
    hooks.mkdir(vscodeStubRoot, { recursive: true, mode: 0o700 });
    hooks.writeFile(
      resolve(vscodeStubRoot, "index.js"),
      `"use strict";\nconst recursive = new Proxy(function () { return recursive; }, {\n  get(_target, key) { return key === "__esModule" ? true : key === "then" ? undefined : recursive; },\n  construct() { return recursive; }\n});\nmodule.exports = recursive;\n`,
      { encoding: "utf8", flag: "wx", mode: 0o600 }
    );
    const inherited = {};
    for (const key of ["PATH", "Path", "PATHEXT", "SystemRoot", "WINDIR", "COMSPEC", "LD_LIBRARY_PATH"]) {
      if (typeof process.env[key] === "string") inherited[key] = process.env[key];
    }
    hooks.execFile(
      process.execPath,
      [
        "--no-addons",
        "-e",
        `const value = require(${JSON.stringify(PACKAGED_JOURNEY_REQUIRE)}); if (typeof value.run !== "function") process.exit(91);`
      ],
      {
        cwd: directory,
        env: {
          ...inherited,
          HOME: smokeRoot,
          NODE_PATH: resolve(smokeRoot, "node_modules"),
          TMPDIR: smokeRoot
        },
        maxBuffer: 64 * 1024,
        stdio: "pipe",
        timeout: 30_000
      }
    );
  } catch (error) {
    throw new Error("The self-contained comparison journey could not load in an isolated Node process.", {
      cause: error
    });
  } finally {
    hooks.remove(smokeRoot, { recursive: true, force: true });
  }
}

async function createDriverVsix(options) {
  const { createVSIX } = await import("@vscode/vsce");
  return createVSIX(options);
}

const driverArchiveCrcTable = new Uint32Array(256);
for (let index = 0; index < driverArchiveCrcTable.length; index += 1) {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) value = (value & 1) === 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  driverArchiveCrcTable[index] = value >>> 0;
}

function driverArchiveCrc32(bytes) {
  let value = 0xffffffff;
  for (const byte of bytes) value = (driverArchiveCrcTable[(value ^ byte) & 0xff] ^ (value >>> 8)) >>> 0;
  return (value ^ 0xffffffff) >>> 0;
}

function decodeDriverArchiveName(bytes) {
  let value;
  try {
    value = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    throw new Error("Comparison-driver VSIX contains an invalid UTF-8 entry name.", { cause: error });
  }
  if (
    value.length === 0 ||
    Buffer.byteLength(value, "utf8") > DRIVER_VSIX_ENTRY_NAME_MAX_BYTES ||
    value.startsWith("/") ||
    value.includes("\\") ||
    /[\0\r\n]/u.test(value) ||
    value.split("/").some((part) => part.length === 0 || part === "." || part === "..")
  ) {
    fail("Comparison-driver VSIX contains an unsafe entry name.");
  }
  return value;
}

function inspectDataWranglerComparisonDriverArchive(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length === 0 || bytes.length > DRIVER_VSIX_MAX_BYTES) {
    fail("Comparison-driver VSIX bytes are missing or exceed their fixed bound.");
  }
  const endSignature = 0x06054b50;
  let endOffset = -1;
  for (let index = bytes.length - 22; index >= Math.max(0, bytes.length - 65_557); index -= 1) {
    if (bytes.readUInt32LE(index) === endSignature && index + 22 + bytes.readUInt16LE(index + 20) === bytes.length) {
      endOffset = index;
      break;
    }
  }
  if (endOffset < 0) fail("Comparison-driver VSIX has no exact bounded end record.");
  const disk = bytes.readUInt16LE(endOffset + 4);
  const centralDisk = bytes.readUInt16LE(endOffset + 6);
  const entriesOnDisk = bytes.readUInt16LE(endOffset + 8);
  const entryCount = bytes.readUInt16LE(endOffset + 10);
  const centralBytes = bytes.readUInt32LE(endOffset + 12);
  const centralOffset = bytes.readUInt32LE(endOffset + 16);
  if (
    disk !== 0 ||
    centralDisk !== 0 ||
    entriesOnDisk !== entryCount ||
    entryCount < 1 ||
    entryCount > DRIVER_VSIX_MAX_ENTRIES ||
    centralOffset + centralBytes !== endOffset ||
    bytes.readUInt16LE(endOffset + 20) !== 0
  ) {
    fail("Comparison-driver VSIX uses an unsupported split, ZIP64, or oversized directory.");
  }
  const entries = [];
  const paths = new Set();
  const localRanges = [];
  let totalCompressedBytes = 0;
  let totalUncompressedBytes = 0;
  let cursor = centralOffset;
  for (let index = 0; index < entryCount; index += 1) {
    if (cursor + 46 > endOffset || bytes.readUInt32LE(cursor) !== 0x02014b50) {
      fail("Comparison-driver VSIX has a malformed central directory.");
    }
    const versionMadeBy = bytes.readUInt16LE(cursor + 4);
    const flags = bytes.readUInt16LE(cursor + 8);
    const method = bytes.readUInt16LE(cursor + 10);
    const expectedCrc = bytes.readUInt32LE(cursor + 16);
    const compressedBytes = bytes.readUInt32LE(cursor + 20);
    const uncompressedBytes = bytes.readUInt32LE(cursor + 24);
    const nameBytes = bytes.readUInt16LE(cursor + 28);
    const extraBytes = bytes.readUInt16LE(cursor + 30);
    const commentBytes = bytes.readUInt16LE(cursor + 32);
    const startDisk = bytes.readUInt16LE(cursor + 34);
    const externalAttributes = bytes.readUInt32LE(cursor + 38);
    const localOffset = bytes.readUInt32LE(cursor + 42);
    const nextCursor = cursor + 46 + nameBytes + extraBytes + commentBytes;
    if (
      nextCursor > endOffset ||
      ((versionMadeBy >>> 8) & 0xff) !== 3 ||
      ((externalAttributes >>> 16) & 0o170000) !== 0o100000 ||
      startDisk !== 0 ||
      extraBytes !== 0 ||
      commentBytes !== 0 ||
      (flags & ~0x0808) !== 0 ||
      (flags & 0x0800) === 0 ||
      (method !== 0 && method !== 8) ||
      compressedBytes > DRIVER_VSIX_MAX_BYTES ||
      uncompressedBytes > DRIVER_VSIX_ENTRY_MAX_BYTES
    ) {
      fail("Comparison-driver VSIX contains an unsupported or oversized ZIP entry.");
    }
    const path = decodeDriverArchiveName(bytes.subarray(cursor + 46, cursor + 46 + nameBytes));
    if (paths.has(path)) fail("Comparison-driver VSIX contains a duplicate entry.");
    paths.add(path);

    if (localOffset + 30 > centralOffset || bytes.readUInt32LE(localOffset) !== 0x04034b50) {
      fail("Comparison-driver VSIX has a malformed local entry header.");
    }
    const localFlags = bytes.readUInt16LE(localOffset + 6);
    const localMethod = bytes.readUInt16LE(localOffset + 8);
    const localCrc = bytes.readUInt32LE(localOffset + 14);
    const localCompressedBytes = bytes.readUInt32LE(localOffset + 18);
    const localUncompressedBytes = bytes.readUInt32LE(localOffset + 22);
    const localNameBytes = bytes.readUInt16LE(localOffset + 26);
    const localExtraBytes = bytes.readUInt16LE(localOffset + 28);
    const dataOffset = localOffset + 30 + localNameBytes + localExtraBytes;
    const dataEnd = dataOffset + compressedBytes;
    if (
      localFlags !== flags ||
      localMethod !== method ||
      localNameBytes !== nameBytes ||
      localExtraBytes !== 0 ||
      dataEnd > centralOffset ||
      !bytes.subarray(localOffset + 30, localOffset + 30 + localNameBytes).equals(Buffer.from(path, "utf8"))
    ) {
      fail("Comparison-driver VSIX central and local entry records disagree.");
    }
    let localEnd = dataEnd;
    if ((flags & 0x0008) !== 0) {
      if (
        localCrc !== 0 ||
        localCompressedBytes !== 0 ||
        localUncompressedBytes !== 0 ||
        dataEnd + 16 > centralOffset ||
        bytes.readUInt32LE(dataEnd) !== 0x08074b50 ||
        bytes.readUInt32LE(dataEnd + 4) !== expectedCrc ||
        bytes.readUInt32LE(dataEnd + 8) !== compressedBytes ||
        bytes.readUInt32LE(dataEnd + 12) !== uncompressedBytes
      ) {
        fail("Comparison-driver VSIX has a malformed data descriptor.");
      }
      localEnd += 16;
    } else if (
      localCrc !== expectedCrc ||
      localCompressedBytes !== compressedBytes ||
      localUncompressedBytes !== uncompressedBytes
    ) {
      fail("Comparison-driver VSIX local sizes or CRC disagree with its central directory.");
    }
    const compressed = bytes.subarray(dataOffset, dataEnd);
    let contents;
    try {
      contents =
        method === 0
          ? Buffer.from(compressed)
          : inflateRawSync(compressed, { maxOutputLength: DRIVER_VSIX_ENTRY_MAX_BYTES });
    } catch (error) {
      throw new Error(`Comparison-driver VSIX entry ${path} could not be decompressed safely.`, { cause: error });
    }
    if (contents.length !== uncompressedBytes || driverArchiveCrc32(contents) !== expectedCrc) {
      fail("Comparison-driver VSIX entry bytes do not match their size and CRC.");
    }
    totalCompressedBytes += compressedBytes;
    totalUncompressedBytes += uncompressedBytes;
    if (totalCompressedBytes > DRIVER_VSIX_MAX_BYTES || totalUncompressedBytes > DRIVER_VSIX_UNCOMPRESSED_MAX_BYTES) {
      fail("Comparison-driver VSIX exceeds its aggregate byte budget.");
    }
    localRanges.push([localOffset, localEnd]);
    entries.push(Object.freeze({ path, sha256: createHash("sha256").update(contents).digest("hex") }));
    cursor = nextCursor;
  }
  if (cursor !== endOffset) fail("Comparison-driver VSIX central directory has trailing data.");
  localRanges.sort((left, right) => left[0] - right[0]);
  if (localRanges[0][0] !== 0 || localRanges.at(-1)[1] !== centralOffset) {
    fail("Comparison-driver VSIX contains data outside its exact local-entry inventory.");
  }
  for (let index = 1; index < localRanges.length; index += 1) {
    if (localRanges[index][0] !== localRanges[index - 1][1]) {
      fail("Comparison-driver VSIX local entries overlap or leave unaccounted data.");
    }
  }
  entries.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  return Object.freeze({
    entryCount: entries.length,
    totalUncompressedBytes,
    inventorySha256: createHash("sha256").update(JSON.stringify(entries), "utf8").digest("hex"),
    entries: Object.freeze(entries)
  });
}

function expectedDriverArchiveEntries({ packageFiles, journeyGraph, runtimeDependencies }) {
  return [
    { path: "extension/package.json", sha256: packageFiles.packageJsonSha256 },
    { path: "extension/extension.js", sha256: packageFiles.extensionSourceSha256 },
    ...journeyGraph.modules.map((entry) => ({
      path: `extension/journey/${entry.path}`,
      sha256: entry.sha256
    })),
    ...runtimeDependencies.playwrightCore.files.map((entry) => ({
      path: `extension/node_modules/playwright-core/${entry.path}`,
      sha256: entry.sha256
    }))
  ].sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
}

function assertDriverArchiveMatchesSource(archive, sourceReceipt) {
  const expected = expectedDriverArchiveEntries(sourceReceipt);
  const metadata = archive.entries.filter((entry) => DRIVER_ARCHIVE_METADATA_PATHS.has(entry.path));
  const packaged = archive.entries.filter((entry) => !DRIVER_ARCHIVE_METADATA_PATHS.has(entry.path));
  if (
    metadata.length !== DRIVER_ARCHIVE_METADATA_PATHS.size ||
    metadata.some((entry) => !DRIVER_ARCHIVE_METADATA_PATHS.has(entry.path)) ||
    JSON.stringify(packaged) !== JSON.stringify(expected) ||
    archive.entryCount !== expected.length + DRIVER_ARCHIVE_METADATA_PATHS.size
  ) {
    fail("Comparison-driver VSIX inventory does not exactly match its audited source graph.");
  }
  return archive;
}

function readDriverVsixSnapshot(path, hooks) {
  let descriptor;
  try {
    descriptor = hooks.open(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    const before = hooks.fstat(descriptor, { bigint: true });
    const namedBefore = hooks.lstat(path, { bigint: true });
    const canonicalBefore = hooks.realpath(path);
    if (
      canonicalBefore !== path ||
      !before.isFile() ||
      before.nlink !== 1n ||
      !namedBefore.isFile() ||
      namedBefore.isSymbolicLink() ||
      namedBefore.nlink !== 1n ||
      namedBefore.dev !== before.dev ||
      namedBefore.ino !== before.ino ||
      before.size <= 0n ||
      before.size > BigInt(DRIVER_VSIX_MAX_BYTES) ||
      (typeof process.getuid === "function" && before.uid !== BigInt(process.getuid()))
    ) {
      fail("The packaged comparison driver must be one bounded current-user-owned VSIX.");
    }
    const bytes = hooks.readFile(descriptor);
    const after = hooks.fstat(descriptor, { bigint: true });
    const namedAfter = hooks.lstat(path, { bigint: true });
    const canonicalAfter = hooks.realpath(path);
    if (
      !Buffer.isBuffer(bytes) ||
      bytes.length !== Number(before.size) ||
      canonicalAfter !== path ||
      !sameMetadata(before, after) ||
      !sameMetadata(namedBefore, namedAfter) ||
      namedAfter.dev !== after.dev ||
      namedAfter.ino !== after.ino
    ) {
      fail("The packaged comparison driver changed while its descriptor was read.");
    }
    return Object.freeze({ bytes, metadata: after });
  } finally {
    if (descriptor !== undefined) hooks.close(descriptor);
  }
}

function captureDriverVsix(path, hooks, sourceReceipt) {
  if (
    !isRecord(sourceReceipt) ||
    !isRecord(sourceReceipt.packageFiles) ||
    !isRecord(sourceReceipt.runtimeDependencies)
  ) {
    fail("Comparison-driver VSIX inspection requires its audited source receipt.");
  }
  const snapshot = readDriverVsixSnapshot(path, hooks);
  const metadata = snapshot.metadata;
  const archive = assertDriverArchiveMatchesSource(
    inspectDataWranglerComparisonDriverArchive(snapshot.bytes),
    sourceReceipt
  );
  return Object.freeze({
    path,
    bytes: snapshot.bytes.length,
    sha256: createHash("sha256").update(snapshot.bytes).digest("hex"),
    identity: Object.freeze({
      dev: metadata.dev.toString(),
      ino: metadata.ino.toString(),
      size: metadata.size.toString(),
      mtimeNs: metadata.mtimeNs.toString(),
      ctimeNs: metadata.ctimeNs.toString()
    }),
    archive
  });
}

export async function packageDataWranglerComparisonDriver(
  { directory, testModule, vsixPath },
  {
    createVsix = createDriverVsix,
    copy = cpSync,
    execFile = execFileSync,
    mkdtemp = mkdtempSync,
    readdir = readdirSync,
    ...fileDependencies
  } = {}
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
  const runtimeHooks = {
    copy,
    execFile,
    lstat: fileDependencies.lstat ?? lstatSync,
    mkdir: fileDependencies.mkdir ?? mkdirSync,
    mkdtemp,
    readFile: fileDependencies.readFile ?? readFileSync,
    readdir,
    realpath: fileDependencies.realpath ?? realpathSync,
    remove: fileDependencies.remove ?? rmSync,
    writeFile: fileDependencies.writeFile ?? writeFileSync
  };
  const playwrightCore = copyPlaywrightRuntime(directory, runtimeHooks);
  smokePackagedJourneyModule(directory, runtimeHooks);
  await createVsix({
    cwd: directory,
    packagePath: vsixPath,
    dependencies: true,
    skipLicense: true,
    allowStarActivation: true,
    allowMissingRepository: true
  });
  const hooks = {
    close: fileDependencies.close ?? closeSync,
    fstat: fileDependencies.fstat ?? fstatSync,
    lstat: fileDependencies.lstat ?? lstatSync,
    open: fileDependencies.open ?? openSync,
    readFile: fileDependencies.readFile ?? readFileSync,
    realpath: fileDependencies.realpath ?? realpathSync
  };
  const sourceReceipt = Object.freeze({
    ...written,
    runtimeDependencies: Object.freeze({ playwrightCore })
  });
  const vsix = captureDriverVsix(vsixPath, hooks, sourceReceipt);
  const receipt = Object.freeze({
    ...sourceReceipt,
    vsix
  });
  driverVsixReceipts.add(receipt);
  return receipt;
}

export function revalidateDataWranglerComparisonDriver(receipt, dependencies = {}) {
  if (!driverVsixReceipts.has(receipt)) {
    fail("Comparison-driver revalidation requires an authentic packaged receipt.");
  }
  const hooks = {
    close: dependencies.close ?? closeSync,
    fstat: dependencies.fstat ?? fstatSync,
    lstat: dependencies.lstat ?? lstatSync,
    open: dependencies.open ?? openSync,
    readFile: dependencies.readFile ?? readFileSync,
    readdir: dependencies.readdir ?? readdirSync,
    realpath: dependencies.realpath ?? realpathSync
  };
  validateCanonicalDirectory(receipt.directory, "Comparison-driver directory", hooks);
  const manifestBytes = readStableOwnedFile(
    resolve(receipt.directory, "package.json"),
    DRIVER_MANIFEST_MAX_BYTES,
    "Comparison-driver manifest",
    hooks
  );
  const manifest = JSON.parse(manifestBytes.toString("utf8"));
  const sourceBytes = readStableOwnedFile(
    resolve(receipt.directory, "extension.js"),
    DRIVER_SOURCE_MAX_BYTES,
    "Comparison-driver source",
    hooks
  );
  const source = sourceBytes.toString("utf8");
  const bundle = validateDataWranglerComparisonDriverBundle({
    manifest,
    source
  });
  const journeyGraph = provePackagedJourneyGraph(receipt.directory, {
    exists: dependencies.exists ?? existsSync,
    lstat: hooks.lstat,
    readFile: hooks.readFile,
    realpath: hooks.realpath
  });
  const playwrightCore = capturePlaywrightRuntime(resolve(receipt.directory, "node_modules", "playwright-core"), hooks);
  const current = captureDriverVsix(receipt.vsix.path, hooks, receipt);
  if (
    bundle.manifestSha256 !== receipt.manifestSha256 ||
    bundle.sourceSha256 !== receipt.sourceSha256 ||
    JSON.stringify(journeyGraph) !== JSON.stringify(receipt.journeyGraph) ||
    !isRecord(receipt.packageFiles) ||
    createHash("sha256").update(manifestBytes).digest("hex") !== receipt.packageFiles.packageJsonSha256 ||
    createHash("sha256").update(sourceBytes).digest("hex") !== receipt.packageFiles.extensionSourceSha256 ||
    !isRecord(receipt.runtimeDependencies) ||
    !isRecord(receipt.runtimeDependencies.playwrightCore) ||
    playwrightCore.version !== receipt.runtimeDependencies.playwrightCore.version ||
    playwrightCore.fileCount !== receipt.runtimeDependencies.playwrightCore.fileCount ||
    playwrightCore.totalBytes !== receipt.runtimeDependencies.playwrightCore.totalBytes ||
    playwrightCore.treeSha256 !== receipt.runtimeDependencies.playwrightCore.treeSha256 ||
    typeof receipt.runtimeDependencies.playwrightCore.lockIntegrity !== "string" ||
    current.sha256 !== receipt.vsix.sha256 ||
    current.bytes !== receipt.vsix.bytes ||
    JSON.stringify(current.identity) !== JSON.stringify(receipt.vsix.identity) ||
    JSON.stringify(current.archive) !== JSON.stringify(receipt.vsix.archive)
  ) {
    fail("The packaged comparison driver changed after it was captured.");
  }
  return receipt;
}

function studyReceiptFromDriverReceipt(receipt) {
  const modules = receipt.journeyGraph.modules.map((module) =>
    Object.freeze({ path: module.path, sha256: module.sha256 })
  );
  return Object.freeze({
    extensionId: DATA_WRANGLER_COMPARISON_DRIVER_EXTENSION.extensionId,
    version: DATA_WRANGLER_COMPARISON_DRIVER_EXTENSION.version,
    vsix: Object.freeze({
      sha256: receipt.vsix.sha256,
      filesystemIdentity: Object.freeze({
        device: receipt.vsix.identity.dev,
        inode: receipt.vsix.identity.ino,
        sizeBytes: receipt.vsix.bytes,
        mtimeNs: receipt.vsix.identity.mtimeNs
      }),
      archive: Object.freeze({
        ...receipt.vsix.archive,
        entries: Object.freeze(receipt.vsix.archive.entries.map((entry) => Object.freeze({ ...entry })))
      })
    }),
    packageFiles: Object.freeze({ ...receipt.packageFiles }),
    runtimeDependencies: Object.freeze({
      playwrightCore: Object.freeze({
        ...receipt.runtimeDependencies.playwrightCore,
        files: Object.freeze(
          receipt.runtimeDependencies.playwrightCore.files.map((entry) => Object.freeze({ ...entry }))
        )
      })
    }),
    journeyGraph: Object.freeze({
      entry: receipt.journeyGraph.entry,
      moduleCount: receipt.journeyGraph.moduleCount,
      totalBytes: receipt.journeyGraph.totalBytes,
      graphSha256: receipt.journeyGraph.graphSha256,
      modules: Object.freeze(modules)
    })
  });
}

export function createDataWranglerComparisonDriverStudyReceipt(receipt, dependencies = {}) {
  revalidateDataWranglerComparisonDriver(receipt, dependencies);
  return studyReceiptFromDriverReceipt(receipt);
}

export function recoverDataWranglerComparisonDriver(
  { directory, vsixPath, expectedDriver },
  {
    exists = existsSync,
    lstat = lstatSync,
    readFile = readFileSync,
    readdir = readdirSync,
    realpath = realpathSync
  } = {}
) {
  validateCanonicalDirectory(directory, "Comparison-driver recovery directory", { lstat, realpath });
  if (
    typeof vsixPath !== "string" ||
    !isAbsolute(vsixPath) ||
    resolve(vsixPath) !== vsixPath ||
    /[\0\r\n]/u.test(vsixPath) ||
    basename(vsixPath) !== "notebook-comparison-driver.vsix" ||
    !isRecord(expectedDriver) ||
    !isRecord(expectedDriver.packageFiles) ||
    !isRecord(expectedDriver.runtimeDependencies) ||
    !isRecord(expectedDriver.runtimeDependencies.playwrightCore)
  ) {
    fail("Comparison-driver recovery requires explicit canonical paths and an immutable study receipt.");
  }
  const hooks = {
    close: closeSync,
    fstat: fstatSync,
    lstat,
    open: openSync,
    readFile,
    readdir,
    realpath
  };
  const manifestBytes = readStableOwnedFile(
    resolve(directory, "package.json"),
    DRIVER_MANIFEST_MAX_BYTES,
    "Recovered comparison-driver manifest",
    hooks
  );
  const manifest = JSON.parse(manifestBytes.toString("utf8"));
  const sourceBytes = readStableOwnedFile(
    resolve(directory, "extension.js"),
    DRIVER_SOURCE_MAX_BYTES,
    "Recovered comparison-driver source",
    hooks
  );
  const source = sourceBytes.toString("utf8");
  const bundle = validateDataWranglerComparisonDriverBundle({ manifest, source });
  const journeyGraph = provePackagedJourneyGraph(directory, { exists, lstat, readFile, realpath });
  const capturedPlaywright = capturePlaywrightRuntime(resolve(directory, "node_modules", "playwright-core"), hooks);
  const expectedPlaywright = expectedDriver.runtimeDependencies.playwrightCore;
  if (
    typeof expectedPlaywright.lockIntegrity !== "string" ||
    !/^sha512-[A-Za-z0-9+/]+={0,2}$/u.test(expectedPlaywright.lockIntegrity)
  ) {
    fail("The immutable study receipt has no valid Playwright Core lock integrity.");
  }
  const playwrightCore = Object.freeze({
    ...capturedPlaywright,
    lockIntegrity: expectedPlaywright.lockIntegrity
  });
  const sourceReceipt = Object.freeze({
    directory,
    journeyGraph,
    ...bundle,
    packageFiles: Object.freeze({
      packageJsonSha256: createHash("sha256").update(manifestBytes).digest("hex"),
      extensionSourceSha256: createHash("sha256").update(sourceBytes).digest("hex")
    }),
    runtimeDependencies: Object.freeze({ playwrightCore })
  });
  const vsix = captureDriverVsix(vsixPath, hooks, sourceReceipt);
  const receipt = Object.freeze({
    ...sourceReceipt,
    vsix
  });
  if (canonicalJson(studyReceiptFromDriverReceipt(receipt)) !== canonicalJson(expectedDriver)) {
    fail("The recovered comparison driver does not match the immutable study manifest.");
  }
  driverVsixReceipts.add(receipt);
  revalidateDataWranglerComparisonDriver(receipt, { exists, lstat, readFile, readdir, realpath });
  return receipt;
}

export function createDataWranglerComparisonDriverProfile({
  product,
  privateRoot,
  templateKind,
  templateReceiptSha256,
  editor,
  userData,
  extensions,
  sandboxArgs,
  environment,
  installLabel,
  inventoryLabel
}) {
  if (
    (product !== "open-wrangler" && product !== "data-wrangler") ||
    (templateKind !== "configured-only" && templateKind !== "warmed") ||
    typeof templateReceiptSha256 !== "string" ||
    !/^[0-9a-f]{64}$/u.test(templateReceiptSha256) ||
    !isRecord(editor) ||
    typeof editor.name !== "string" ||
    editor.name.length === 0 ||
    typeof userData !== "string" ||
    !isAbsolute(userData) ||
    resolve(userData) !== userData ||
    typeof extensions !== "string" ||
    !isAbsolute(extensions) ||
    resolve(extensions) !== extensions ||
    typeof privateRoot !== "string" ||
    !isAbsolute(privateRoot) ||
    resolve(privateRoot) !== privateRoot ||
    /[\0\r\n]/u.test(privateRoot) ||
    privateRoot === userData ||
    privateRoot === extensions ||
    userData === extensions ||
    /[\0\r\n]/u.test(userData) ||
    /[\0\r\n]/u.test(extensions) ||
    !Array.isArray(sandboxArgs) ||
    sandboxArgs.length > 16 ||
    sandboxArgs.some(
      (argument) =>
        typeof argument !== "string" || argument.length === 0 || argument.length > 256 || /[\0\r\n]/u.test(argument)
    ) ||
    !isRecord(environment) ||
    environment[EDITOR_TEMP_ROOT_ENV] !== privateRoot ||
    typeof installLabel !== "string" ||
    installLabel.length === 0 ||
    installLabel.length > 128 ||
    /[\0\r\n]/u.test(installLabel) ||
    typeof inventoryLabel !== "string" ||
    inventoryLabel.length === 0 ||
    inventoryLabel.length > 128 ||
    /[\0\r\n]/u.test(inventoryLabel)
  ) {
    fail("Comparison-driver profile is malformed.");
  }
  const privateRootIdentity = captureDirectoryIdentity(privateRoot, "Comparison-driver private profile root", {
    requirePrivateMode: true
  });
  const userDataIdentity = captureDirectoryIdentity(userData, "Comparison-driver user-data directory", {
    requirePrivateMode: true
  });
  const extensionsIdentity = captureDirectoryIdentity(extensions, "Comparison-driver extensions directory", {
    requirePrivateMode: true
  });
  requirePhysicalContainment(privateRootIdentity, userDataIdentity, "Comparison-driver user-data directory");
  requirePhysicalContainment(privateRootIdentity, extensionsIdentity, "Comparison-driver extensions directory");
  const physicalIdentities = [privateRootIdentity, userDataIdentity, extensionsIdentity].map(
    (entry) => `${entry.device}:${entry.inode}`
  );
  if (new Set(physicalIdentities).size !== physicalIdentities.length) {
    fail("Comparison-driver profile directories must have distinct filesystem identities.");
  }
  const profile = Object.freeze({
    product,
    privateRoot,
    templateKind,
    templateReceiptSha256,
    editor: Object.freeze({ ...editor }),
    userData,
    extensions,
    sandboxArgs: Object.freeze([...sandboxArgs]),
    environment: Object.freeze({ ...environment }),
    installLabel,
    inventoryLabel
  });
  driverProfileReceipts.add(profile);
  driverProfileFilesystemReceipts.set(
    profile,
    Object.freeze({ privateRoot: privateRootIdentity, userData: userDataIdentity, extensions: extensionsIdentity })
  );
  return profile;
}

function requireComparisonDriverProfile(profile, dependencies = {}) {
  if (!driverProfileReceipts.has(profile)) {
    fail("Comparison-driver work requires one authentic sealed editor profile.");
  }
  const filesystem = driverProfileFilesystemReceipts.get(profile);
  if (!isRecord(filesystem)) {
    fail("Comparison-driver profile has no pinned filesystem receipt.");
  }
  revalidateDirectoryIdentity(filesystem.privateRoot, "Comparison-driver private profile root", {
    requirePrivateMode: true,
    ...dependencies
  });
  revalidateDirectoryIdentity(filesystem.userData, "Comparison-driver user-data directory", {
    requirePrivateMode: true,
    ...dependencies
  });
  revalidateDirectoryIdentity(filesystem.extensions, "Comparison-driver extensions directory", {
    requirePrivateMode: true,
    ...dependencies
  });
  requirePhysicalContainment(filesystem.privateRoot, filesystem.userData, "Comparison-driver user-data directory");
  requirePhysicalContainment(filesystem.privateRoot, filesystem.extensions, "Comparison-driver extensions directory");
  if (profile.environment[EDITOR_TEMP_ROOT_ENV] !== profile.privateRoot) {
    fail("Comparison-driver profile no longer names its private root in the editor environment.");
  }
  return profile;
}

export async function installDataWranglerComparisonDriver(
  { receipt, profile },
  {
    chmod = chmodSync,
    close = closeSync,
    fsync = fsyncSync,
    fstat = fstatSync,
    lstat = lstatSync,
    mkdtemp = mkdtempSync,
    open = openSync,
    readFile = readFileSync,
    realpath = realpathSync,
    remove = rmSync,
    runCli = runBoundedEditorCliCommand,
    writeFile = writeFileSync
  } = {}
) {
  revalidateDataWranglerComparisonDriver(receipt);
  if (typeof runCli !== "function") {
    fail("Comparison-driver installation received malformed editor inputs.");
  }
  const hooks = { chmod, close, fsync, fstat, lstat, mkdtemp, open, readFile, realpath, remove, writeFile };
  requireComparisonDriverProfile(profile, { lstat, realpath });
  const installParentIdentity = captureDirectoryIdentity(
    dirname(receipt.vsix.path),
    "Comparison-driver VSIX parent",
    hooks
  );
  const original = readDriverVsixSnapshot(receipt.vsix.path, hooks);
  const originalArchive = assertDriverArchiveMatchesSource(
    inspectDataWranglerComparisonDriverArchive(original.bytes),
    receipt
  );
  if (
    createHash("sha256").update(original.bytes).digest("hex") !== receipt.vsix.sha256 ||
    JSON.stringify(originalArchive) !== JSON.stringify(receipt.vsix.archive)
  ) {
    fail("The comparison-driver VSIX changed before its private install snapshot was created.");
  }
  const installRoot = hooks.mkdtemp(resolve(dirname(receipt.vsix.path), ".ow-driver-install-"));
  const installPath = resolve(installRoot, "notebook-comparison-driver.vsix");
  let installRootIdentity;
  let descriptor;
  let result;
  let primaryError;
  try {
    installRootIdentity = captureDirectoryIdentity(installRoot, "Private comparison-driver install root", {
      requirePrivateMode: true,
      lstat,
      realpath
    });
    requirePhysicalContainment(installParentIdentity, installRootIdentity, "Private comparison-driver install root");
    descriptor = hooks.open(
      installPath,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | (fsConstants.O_NOFOLLOW ?? 0),
      0o600
    );
    hooks.writeFile(descriptor, original.bytes);
    hooks.fsync(descriptor);
    hooks.close(descriptor);
    descriptor = undefined;
    hooks.chmod(installPath, 0o400);
    const before = captureDriverVsix(installPath, hooks, receipt);
    if (
      before.sha256 !== receipt.vsix.sha256 ||
      JSON.stringify(before.archive) !== JSON.stringify(receipt.vsix.archive)
    ) {
      fail("The private comparison-driver install snapshot does not match its audited VSIX.");
    }
    requireComparisonDriverProfile(profile, { lstat, realpath });
    let cliError;
    try {
      result = await runCli(
        {
          editor: profile.editor,
          args: [
            "--user-data-dir",
            profile.userData,
            "--extensions-dir",
            profile.extensions,
            "--install-extension",
            installPath,
            "--force",
            ...profile.sandboxArgs
          ],
          environment: profile.environment,
          label: profile.installLabel
        },
        { timeoutMs: 60_000 }
      );
    } catch (error) {
      cliError = error;
    }
    try {
      requireComparisonDriverProfile(profile, { lstat, realpath });
    } catch (error) {
      if (cliError !== undefined) {
        throw new AggregateError(
          [cliError, error],
          "Comparison-driver installation failed and its private editor profile also changed."
        );
      }
      throw error;
    }
    if (cliError !== undefined) throw cliError;
    const after = captureDriverVsix(installPath, hooks, receipt);
    if (JSON.stringify(before) !== JSON.stringify(after)) {
      fail("The private comparison-driver install snapshot changed while the editor used it.");
    }
    revalidateDataWranglerComparisonDriver(receipt);
  } catch (error) {
    primaryError = error;
  } finally {
    if (descriptor !== undefined) {
      try {
        hooks.close(descriptor);
      } catch (error) {
        primaryError =
          primaryError === undefined
            ? error
            : new AggregateError([primaryError, error], "Comparison-driver installation and descriptor close failed.");
      }
    }
    if (installRootIdentity !== undefined) {
      try {
        revalidateDirectoryIdentity(installParentIdentity, "Comparison-driver VSIX parent", { lstat, realpath });
        revalidateDirectoryIdentity(installRootIdentity, "Private comparison-driver install root", {
          requirePrivateMode: true,
          lstat,
          realpath
        });
        hooks.remove(installRootIdentity.path, { recursive: true, force: true });
      } catch (error) {
        primaryError =
          primaryError === undefined
            ? error
            : new AggregateError([primaryError, error], "Comparison-driver installation and cleanup failed.");
      }
    }
  }
  if (primaryError !== undefined) throw primaryError;
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

function validateExpectedTemplate(expectedTemplate) {
  exactKeys(expectedTemplate, ["kind", "receiptSha256"], "Expected comparison profile template");
  if (
    (expectedTemplate.kind !== "configured-only" && expectedTemplate.kind !== "warmed") ||
    typeof expectedTemplate.receiptSha256 !== "string" ||
    !/^[0-9a-f]{64}$/u.test(expectedTemplate.receiptSha256)
  ) {
    fail("Expected comparison profile template is invalid.");
  }
  return expectedTemplate;
}

export async function runDataWranglerComparisonNeutralDriverPhase(
  { product, receipt, expectedDriver, expectedExtensions, expectedTemplate, profile, editorPhaseOptions, prevalidated },
  {
    captureDriverReceipt = createDataWranglerComparisonDriverStudyReceipt,
    installDriver = installDataWranglerComparisonDriver,
    onAfterValidation = () => undefined,
    readInventory,
    runPhase
  } = {}
) {
  requireComparisonDriverProfile(profile);
  if (
    typeof captureDriverReceipt !== "function" ||
    typeof installDriver !== "function" ||
    typeof onAfterValidation !== "function" ||
    typeof readInventory !== "function" ||
    typeof runPhase !== "function" ||
    !isRecord(expectedDriver) ||
    !isRecord(editorPhaseOptions)
  ) {
    fail("Neutral comparison phase requires driver installation, inventory, and phase callbacks.");
  }
  if (profile.product !== product) {
    fail("Neutral comparison phase product does not match its sealed editor profile.");
  }
  validateExpectedTemplate(expectedTemplate);
  if (
    profile.templateKind !== expectedTemplate.kind ||
    profile.templateReceiptSha256 !== expectedTemplate.receiptSha256
  ) {
    fail("Neutral comparison phase template does not match its sealed editor profile.");
  }
  for (const field of ["editor", "userData", "extensions", "developmentPaths"]) {
    if (Object.hasOwn(editorPhaseOptions, field)) {
      fail(`Neutral comparison phase options cannot override their sealed ${field} value.`);
    }
  }
  const expectedInventory = assertDataWranglerComparisonArmInventory(expectedExtensions, {
    product,
    expectedExtensions
  });
  let driverBefore;
  let before;
  if (prevalidated === undefined) {
    const driverBeforeInstall = captureDriverReceipt(receipt);
    if (canonicalJson(driverBeforeInstall) !== canonicalJson(expectedDriver)) {
      fail("The neutral driver does not match the immutable study manifest before installation.");
    }
    await installDriver({ receipt, profile });
    driverBefore = captureDriverReceipt(receipt);
    before = assertDataWranglerComparisonArmInventory(await readInventory({ profile, stage: "before" }), {
      product,
      expectedExtensions: expectedInventory
    });
  } else {
    exactKeys(prevalidated, ["driver", "installedExtensions"], "Prevalidated neutral-driver state");
    driverBefore = prevalidated.driver;
    before = assertDataWranglerComparisonArmInventory(prevalidated.installedExtensions, {
      product,
      expectedExtensions: expectedInventory
    });
  }
  if (canonicalJson(driverBefore) !== canonicalJson(expectedDriver)) {
    fail("The installed neutral driver does not match the immutable study manifest.");
  }
  let phaseResult;
  let phaseError;
  try {
    requireComparisonDriverProfile(profile);
    phaseResult = await runPhase(
      {
        ...editorPhaseOptions,
        editor: profile.editor,
        userData: profile.userData,
        extensions: profile.extensions,
        developmentPaths: []
      },
      { driverBefore, environment: profile.environment }
    );
  } catch (error) {
    phaseError = error;
  }
  let after;
  let driverAfter;
  let validationError;
  try {
    requireComparisonDriverProfile(profile);
    after = assertDataWranglerComparisonArmInventory(await readInventory({ profile, stage: "after" }), {
      product,
      expectedExtensions: expectedInventory
    });
    driverAfter = captureDriverReceipt(receipt);
    if (JSON.stringify(before) !== JSON.stringify(after)) {
      fail("Comparison-arm extension inventory changed during the measured phase.");
    }
    if (
      canonicalJson(driverBefore) !== canonicalJson(driverAfter) ||
      canonicalJson(driverAfter) !== canonicalJson(expectedDriver)
    ) {
      fail("The neutral comparison driver changed during the measured phase.");
    }
    await onAfterValidation({ driverBefore, driverAfter, installedExtensions: before });
  } catch (error) {
    validationError = error;
  }
  if (phaseError !== undefined && validationError !== undefined) {
    throw new AggregateError(
      [phaseError, validationError],
      "The measured phase failed and its terminal neutral-driver validation also failed."
    );
  }
  if (phaseError !== undefined) throw phaseError;
  if (validationError !== undefined) throw validationError;
  return Object.freeze({ installedExtensions: before, driverBefore, driverAfter, phaseResult });
}
