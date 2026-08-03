import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  cpSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readSync,
  realpathSync,
  rmSync,
  statSync
} from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { recoverDataWranglerComparisonDriver } from "./data-wrangler-comparison-driver.mjs";
import { createDataWranglerComparisonTemplateInventory } from "./data-wrangler-comparison-inventory.mjs";
import { assertDataWranglerPublicUiManifestEntryMatchesPhase } from "./data-wrangler-comparison-public-phase-receipt.mjs";
import {
  buildDataWranglerStudyManifest,
  canonicalStudyJson,
  digestStudyValue
} from "./data-wrangler-comparison-study.mjs";
import {
  assertCurrentDataWranglerComparisonPreregistration,
  createDataWranglerComparisonPreregistrationReceipt,
  readDataWranglerComparisonPreregistration
} from "./data-wrangler-comparison-preregistration.mjs";
import {
  digestDurableJsonValue,
  publishDurableStudyJsonExclusive,
  recoverDurableStudyJsonPublication
} from "./durable-study-json.mjs";
import {
  configureEditorAcceptanceTempRoot,
  createEditorAcceptanceEnvironment,
  runBoundedEditorCliCommand
} from "./editor-acceptance.mjs";

export const DATA_WRANGLER_COMPARISON_PREPARATION_PROTOCOL = "openwrangler-data-wrangler-comparison-preparation-v2";

const SHA256 = /^[0-9a-f]{64}$/u;
const VERSION = /^[0-9A-Za-z][0-9A-Za-z._+-]{0,127}$/u;
const MAX_TREE_ENTRIES = 100_000;
const MAX_TREE_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_RELATIVE_PATH_BYTES = 512;
const MAX_TREE_DEPTH = 24;
const READ_BUFFER_BYTES = 1024 * 1024;
const MAX_PREPARATION_JSON_BYTES = 32 * 1024 * 1024;
const MAX_KERNELSPEC_BYTES = 64 * 1024;
const MAX_CANDIDATE_BYTES = 512 * 1024 * 1024;
const MAX_EDITOR_EXECUTABLE_BYTES = 512 * 1024 * 1024;
const MAX_EDITOR_CLI_BYTES = 4 * 1024 * 1024;
const MAX_PYTHON_EXECUTABLE_BYTES = 128 * 1024 * 1024;
const MAX_CACHE_CONTROLLER_BYTES = 4 * 1024 * 1024;
const MAX_FIXTURE_BYTES = 4 * 1024 * 1024 * 1024;
const MAX_GENERIC_PREPARATION_FILE_BYTES = 512 * 1024 * 1024;
const REQUIRED_PACKAGES = Object.freeze(["pandas", "polars", "pyarrow", "jupyter_core", "ipykernel"]);

export const DATA_WRANGLER_PREPARATION_FILE_LIMITS = Object.freeze({
  cacheController: MAX_CACHE_CONTROLLER_BYTES,
  candidate: MAX_CANDIDATE_BYTES,
  driverVsix: 64 * 1024 * 1024,
  editorCli: MAX_EDITOR_CLI_BYTES,
  editorExecutable: MAX_EDITOR_EXECUTABLE_BYTES,
  fixture: MAX_FIXTURE_BYTES,
  kernelspec: MAX_KERNELSPEC_BYTES,
  pythonExecutable: MAX_PYTHON_EXECUTABLE_BYTES
});

function fail(message) {
  throw new TypeError(message);
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value, required, label, optional = []) {
  if (!isRecord(value)) fail(`${label} must be an object.`);
  const allowed = new Set([...required, ...optional]);
  if (required.some((key) => !Object.hasOwn(value, key)) || Object.keys(value).some((key) => !allowed.has(key))) {
    fail(`${label} has missing or unknown fields.`);
  }
}

function canonicalAbsolutePath(value, label) {
  if (
    typeof value !== "string" ||
    !isAbsolute(value) ||
    resolve(value) !== value ||
    value.includes("\0") ||
    /[\r\n]/u.test(value)
  ) {
    fail(`${label} must be one canonical absolute path.`);
  }
  return value;
}

function sameMetadata(left, right) {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs &&
    left.mode === right.mode &&
    left.uid === right.uid &&
    left.gid === right.gid &&
    left.nlink === right.nlink
  );
}

function ownerMatches(metadata) {
  return typeof process.getuid !== "function" || metadata.uid === BigInt(process.getuid());
}

function fileIdentity(metadata) {
  return Object.freeze({
    device: metadata.dev.toString(),
    inode: metadata.ino.toString(),
    sizeBytes: Number(metadata.size),
    mtimeNs: metadata.mtimeNs.toString()
  });
}

export function revalidateDataWranglerPreparationFileIdentity(
  receipt,
  label,
  { executable = false, maximumBytes = MAX_GENERIC_PREPARATION_FILE_BYTES } = {}
) {
  if (
    !isRecord(receipt) ||
    typeof receipt.path !== "string" ||
    !SHA256.test(receipt.sha256 ?? "") ||
    !isRecord(receipt.filesystemIdentity)
  ) {
    fail(`${label} receipt is invalid.`);
  }
  const current = captureDataWranglerPreparationFile(receipt.path, label, { executable, maximumBytes });
  if (
    current.sha256 !== receipt.sha256 ||
    canonicalStudyJson(current.filesystemIdentity) !== canonicalStudyJson(receipt.filesystemIdentity)
  ) {
    fail(`${label} changed before the measured spawn.`);
  }
  return receipt;
}

function assertBoundedPreparationJsonFile(metadata, maximumBytes, label) {
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.nlink !== 1n ||
    !ownerMatches(metadata) ||
    metadata.size < 1n ||
    metadata.size > BigInt(maximumBytes)
  ) {
    fail(`${label} must be one owned, singly linked regular file within its byte bound.`);
  }
}

export function readBoundedDataWranglerPreparationJson(
  path,
  label,
  maximumBytes,
  { afterOpen = () => undefined } = {}
) {
  canonicalAbsolutePath(path, label);
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1 || maximumBytes > MAX_PREPARATION_JSON_BYTES) {
    fail(`${label} byte bound is invalid.`);
  }
  if (typeof afterOpen !== "function") fail(`${label} read hook must be callable.`);
  const parent = dirname(path);
  if (realpathSync(parent) !== parent) fail(`${label} parent must not traverse a symbolic link.`);
  const parentBefore = lstatSync(parent, { bigint: true });
  if (!parentBefore.isDirectory() || parentBefore.isSymbolicLink() || !ownerMatches(parentBefore)) {
    fail(`${label} parent must be one owned directory.`);
  }
  let parentDescriptor;
  let descriptor;
  try {
    parentDescriptor = openSync(parent, constants.O_RDONLY | constants.O_DIRECTORY | (constants.O_NOFOLLOW ?? 0));
    const parentOpened = fstatSync(parentDescriptor, { bigint: true });
    if (parentOpened.dev !== parentBefore.dev || parentOpened.ino !== parentBefore.ino) {
      fail(`${label} parent changed while it opened.`);
    }
    const anchoredPath = `/proc/self/fd/${parentDescriptor}/${basename(path)}`;
    const before = lstatSync(anchoredPath, { bigint: true });
    assertBoundedPreparationJsonFile(before, maximumBytes, label);
    descriptor = openSync(anchoredPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const opened = fstatSync(descriptor, { bigint: true });
    assertBoundedPreparationJsonFile(opened, maximumBytes, label);
    if (!sameMetadata(before, opened)) fail(`${label} changed while it opened.`);
    afterOpen({ path, parentDescriptor, descriptor });
    const bytes = Buffer.alloc(Number(opened.size));
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(descriptor, bytes, offset, bytes.length - offset, null);
      if (count === 0) fail(`${label} ended before its declared size.`);
      offset += count;
    }
    const after = fstatSync(descriptor, { bigint: true });
    const anchoredAfter = lstatSync(anchoredPath, { bigint: true });
    const namedParentAfter = lstatSync(parent, { bigint: true });
    if (
      !sameMetadata(opened, after) ||
      !sameMetadata(after, anchoredAfter) ||
      namedParentAfter.dev !== parentOpened.dev ||
      namedParentAfter.ino !== parentOpened.ino
    ) {
      fail(`${label} or its parent changed while it was read.`);
    }
    let value;
    try {
      value = JSON.parse(bytes.toString("utf8"));
    } catch {
      fail(`${label} is not valid bounded JSON.`);
    }
    return Object.freeze({
      value,
      receipt: Object.freeze({
        path,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        filesystemIdentity: fileIdentity(opened)
      })
    });
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    if (parentDescriptor !== undefined) closeSync(parentDescriptor);
  }
}

export function captureDataWranglerPreparationFile(
  path,
  label,
  { executable = false, maximumBytes = MAX_GENERIC_PREPARATION_FILE_BYTES } = {}
) {
  canonicalAbsolutePath(path, label);
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1 || maximumBytes > MAX_FIXTURE_BYTES) {
    fail(`${label} byte bound is invalid.`);
  }
  let descriptor;
  try {
    const before = lstatSync(path, { bigint: true });
    if (
      !before.isFile() ||
      before.isSymbolicLink() ||
      before.nlink !== 1n ||
      before.size <= 0n ||
      before.size > BigInt(maximumBytes) ||
      !ownerMatches(before) ||
      (executable && (before.mode & 0o111n) === 0n)
    ) {
      fail(`${label} must be one owned, singly linked${executable ? ", executable" : ""} regular file.`);
    }
    descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    const opened = fstatSync(descriptor, { bigint: true });
    if (!sameMetadata(before, opened)) fail(`${label} changed while it opened.`);
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(READ_BUFFER_BYTES);
    let bytes = 0;
    while (true) {
      const count = readSync(descriptor, buffer, 0, buffer.length, null);
      if (count === 0) break;
      bytes += count;
      hash.update(buffer.subarray(0, count));
    }
    const after = fstatSync(descriptor, { bigint: true });
    const namedAfter = lstatSync(path, { bigint: true });
    if (!sameMetadata(opened, after) || !sameMetadata(after, namedAfter) || BigInt(bytes) !== opened.size) {
      fail(`${label} changed while it was read.`);
    }
    return Object.freeze({ path, sha256: hash.digest("hex"), filesystemIdentity: fileIdentity(opened) });
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function privateDirectory(path, label) {
  canonicalAbsolutePath(path, label);
  const metadata = lstatSync(path, { bigint: true });
  if (
    !metadata.isDirectory() ||
    metadata.isSymbolicLink() ||
    !ownerMatches(metadata) ||
    (metadata.mode & 0o777n) !== 0o700n ||
    realpathSync(path) !== path
  ) {
    fail(`${label} must be one canonical, owned mode-0700 directory.`);
  }
  return metadata;
}

export function assertDataWranglerPreparationPrivateDirectory(path, label) {
  return privateDirectory(path, label);
}

function treeRelativePath(root, path) {
  const value = relative(root, path).split(sep).join("/");
  if (
    value.length === 0 ||
    value.startsWith("../") ||
    value === ".." ||
    value.split("/").length > MAX_TREE_DEPTH ||
    Buffer.byteLength(value, "utf8") > MAX_RELATIVE_PATH_BYTES ||
    value.includes("\0")
  ) {
    fail("Comparison template contains an unsafe relative path.");
  }
  return value;
}

function hashOwnedTreeFile(path, metadata) {
  let descriptor;
  try {
    descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const opened = fstatSync(descriptor, { bigint: true });
    if (!sameMetadata(metadata, opened)) fail("Comparison template file changed while it opened.");
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(READ_BUFFER_BYTES);
    let bytes = 0;
    while (true) {
      const count = readSync(descriptor, buffer, 0, buffer.length, null);
      if (count === 0) break;
      bytes += count;
      hash.update(buffer.subarray(0, count));
    }
    const after = fstatSync(descriptor, { bigint: true });
    if (!sameMetadata(opened, after) || BigInt(bytes) !== opened.size) {
      fail("Comparison template file changed while it was read.");
    }
    return hash.digest("hex");
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

export function captureDataWranglerProfileTree(root, label = "Comparison profile template") {
  const rootMetadata = privateDirectory(root, label);
  const directories = [];
  const files = [];
  const queue = [root];
  let totalBytes = 0;
  while (queue.length > 0) {
    const directory = queue.shift();
    const entries = readdirSync(directory, { withFileTypes: true }).sort((left, right) =>
      left.name < right.name ? -1 : left.name > right.name ? 1 : 0
    );
    for (const entry of entries) {
      if (directories.length + files.length >= MAX_TREE_ENTRIES) {
        fail(`${label} exceeds its entry bound.`);
      }
      const path = resolve(directory, entry.name);
      const relativePath = treeRelativePath(root, path);
      const metadata = lstatSync(path, { bigint: true });
      if (!ownerMatches(metadata) || metadata.isSymbolicLink()) fail(`${label} contains an unowned or linked entry.`);
      if (metadata.isDirectory()) {
        directories.push({ path: relativePath, mode: Number(metadata.mode & 0o777n) });
        queue.push(path);
        continue;
      }
      if (!metadata.isFile() || metadata.nlink !== 1n || metadata.size > BigInt(Number.MAX_SAFE_INTEGER)) {
        fail(`${label} contains a non-regular, linked, or oversized entry.`);
      }
      const sizeBytes = Number(metadata.size);
      totalBytes += sizeBytes;
      if (totalBytes > MAX_TREE_BYTES) fail(`${label} exceeds its byte bound.`);
      files.push({
        path: relativePath,
        mode: Number(metadata.mode & 0o777n),
        sizeBytes,
        sha256: hashOwnedTreeFile(path, metadata)
      });
      const namedAfter = lstatSync(path, { bigint: true });
      if (!sameMetadata(metadata, namedAfter)) fail(`${label} changed during traversal.`);
    }
  }
  directories.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  files.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  const currentRoot = lstatSync(root, { bigint: true });
  if (currentRoot.dev !== rootMetadata.dev || currentRoot.ino !== rootMetadata.ino) {
    fail(`${label} root changed during traversal.`);
  }
  const inventory = Object.freeze({ directories: Object.freeze(directories), files: Object.freeze(files) });
  return Object.freeze({
    root,
    rootIdentity: Object.freeze({ device: rootMetadata.dev.toString(), inode: rootMetadata.ino.toString() }),
    entryCount: directories.length + files.length,
    totalBytes,
    treeSha256: digestStudyValue(inventory)
  });
}

function parseInventory(stdout) {
  if (typeof stdout !== "string" || Buffer.byteLength(stdout, "utf8") > 64 * 1024) {
    fail("Comparison preparation extension inventory is absent or oversized.");
  }
  const entries = stdout
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const separator = line.lastIndexOf("@");
      if (separator < 3 || separator === line.length - 1)
        fail("Comparison preparation extension inventory is malformed.");
      return { extensionId: line.slice(0, separator), version: line.slice(separator + 1) };
    });
  if (entries.length === 0 || entries.length > 64) fail("Comparison preparation extension inventory is invalid.");
  return entries;
}

export async function queryDataWranglerTemplateInventory(
  template,
  editor,
  environment,
  { createScratch = mkdtempSync, copyTree = cpSync, runCli = runBoundedEditorCliCommand, removeTree = rmSync } = {}
) {
  const scratch = createScratch(resolve(dirname(template.root), ".inventory-"));
  try {
    copyTree(template.root, scratch, {
      recursive: true,
      errorOnExist: false,
      force: false,
      verbatimSymlinks: true
    });
    const { stdout } = await runCli(
      {
        editor,
        args: [
          "--user-data-dir",
          resolve(scratch, "user"),
          "--extensions-dir",
          resolve(scratch, "extensions"),
          "--list-extensions",
          "--show-versions",
          ...template.sandboxArgs
        ],
        environment,
        label: `Official VS Code ${template.product} ${template.kind} template inventory`
      },
      { timeoutMs: 60_000 }
    );
    return parseInventory(stdout);
  } finally {
    removeTree(scratch, { recursive: true, force: true });
  }
}

function expectedProductExtensions(manifest, product) {
  const productExtension =
    product === "open-wrangler"
      ? { extensionId: manifest.candidate.extensionId, version: manifest.candidate.version }
      : { extensionId: manifest.baseline.extensionId, version: manifest.baseline.version };
  return createDataWranglerComparisonTemplateInventory(productExtension);
}

function assertTemplateInventory(actual, expected) {
  const normalize = (entries) => entries.map((entry) => `${entry.extensionId.toLowerCase()}@${entry.version}`).sort();
  const observed = normalize(actual);
  const required = normalize(expected);
  if (observed.length !== required.length || observed.some((entry, index) => entry !== required[index])) {
    fail("Comparison preparation template does not contain its exact product extension inventory.");
  }
  return actual;
}

function verifyKernelSpec(path, pythonPath, manifest) {
  const { value, receipt: file } = readBoundedDataWranglerPreparationJson(
    path,
    "Comparison preparation kernelspec",
    MAX_KERNELSPEC_BYTES
  );
  if (
    !isRecord(value) ||
    !Array.isArray(value.argv) ||
    value.argv[0] !== pythonPath ||
    !value.argv.includes("ipykernel_launcher") ||
    value.display_name !== `Dataframe comparison study CPython ${manifest.python.version} (private trial)` ||
    !/^dataframe-comparison-study-[a-z0-9][a-z0-9._-]{0,95}$/u.test(basename(dirname(path))) ||
    basename(dirname(path)) !== manifest.python.kernel.kernelspecName ||
    file.sha256 !== manifest.python.kernel.kernelspecSha256
  ) {
    fail("Comparison preparation kernelspec does not select the manifest Python environment exactly.");
  }
  return Object.freeze({
    path,
    name: basename(dirname(path)),
    displayName: value.display_name,
    sha256: file.sha256,
    jupyterEnvironment: Object.freeze({
      dataDir: resolve(dirname(path), "..", ".."),
      runtimeDir: resolve(dirname(path), "..", "..", "..", "runtime"),
      configDir: resolve(dirname(path), "..", "..", "..", "config"),
      path: resolve(dirname(path), "..", "..", "..", "path")
    })
  });
}

function validatePreparationReceipt(value) {
  exactKeys(
    value,
    [
      "protocol",
      "preregistrationPath",
      "preregistrationSha256",
      "specificationPath",
      "specificationSha256",
      "specification",
      "manifestPath",
      "manifestSha256",
      "studyRoot",
      "candidate",
      "editor",
      "python",
      "cacheController",
      "driver",
      "fixtures",
      "selectedKernel",
      "templates",
      "publicUiCaptures",
      "createdAtUtc"
    ],
    "Comparison preparation receipt"
  );
  if (
    value.protocol !== DATA_WRANGLER_COMPARISON_PREPARATION_PROTOCOL ||
    !SHA256.test(value.preregistrationSha256) ||
    !SHA256.test(value.specificationSha256) ||
    !SHA256.test(value.manifestSha256) ||
    !isRecord(value.specification) ||
    digestStudyValue(value.specification) !== value.specificationSha256
  ) {
    fail("Comparison preparation receipt protocol or manifest digest is invalid.");
  }
  for (const [path, label] of [
    [value.preregistrationPath, "preregistration"],
    [value.specificationPath, "specification"],
    [value.manifestPath, "manifest"],
    [value.studyRoot, "study root"],
    [value.candidate?.path, "candidate"],
    [value.editor?.installationRoot, "editor installation root"],
    [value.editor?.executablePath, "editor executable"],
    [value.editor?.cliPath, "editor CLI"],
    [value.python?.path, "Python"],
    [value.cacheController?.path, "cache controller"],
    [value.driver?.directory, "driver directory"],
    [value.driver?.vsixPath, "driver VSIX"],
    [value.selectedKernel?.path, "kernelspec"]
  ])
    canonicalAbsolutePath(path, `Comparison preparation ${label}`);
  for (const [label, path] of Object.entries(value.selectedKernel?.jupyterEnvironment ?? {})) {
    canonicalAbsolutePath(path, `Comparison preparation Jupyter ${label}`);
  }
  if (
    !Array.isArray(value.fixtures) ||
    value.fixtures.length !== 2 ||
    !Array.isArray(value.templates) ||
    value.templates.length !== 4 ||
    !Array.isArray(value.publicUiCaptures) ||
    value.publicUiCaptures.length !== 3
  ) {
    fail("Comparison preparation receipt requires two fixtures, four profile templates, and three public-UI captures.");
  }
  return value;
}

function normalizePublicUiCaptureBindings(manifest, bindings, kernel) {
  if (!Array.isArray(bindings) || bindings.length !== 3) {
    fail("Comparison preparation requires two public capability captures and one neither-product control.");
  }
  const dataWranglerTemplate = manifest.provenance.templates.find((entry) => entry.product === "data-wrangler");
  const normalized = bindings.map((binding, index) => {
    exactKeys(
      binding,
      [
        "kind",
        "fixtureId",
        "captureId",
        "editorSha256",
        "templateProduct",
        "templateKind",
        "templateTreeSha256",
        "phaseReceiptSha256",
        "phaseReceipt"
      ],
      `Comparison public-UI capture binding ${index}`
    );
    const manifestEntry =
      binding.kind === "control"
        ? manifest.provenance.controlProfile
        : manifest.provenance.capabilities.find((entry) => entry.fixtureId === binding.fixtureId);
    const fixture = manifest.fixtures.find((entry) => entry.id === binding.fixtureId);
    if (
      !["capability", "control"].includes(binding.kind) ||
      typeof binding.fixtureId !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(binding.captureId) ||
      !SHA256.test(binding.editorSha256) ||
      binding.editorSha256 !== manifest.editor.sha256 ||
      binding.templateProduct !== "data-wrangler" ||
      binding.templateKind !== "configured-only" ||
      !SHA256.test(binding.templateTreeSha256) ||
      binding.templateTreeSha256 !== dataWranglerTemplate?.configuredOnlyReceiptSha256 ||
      !SHA256.test(binding.phaseReceiptSha256) ||
      binding.phaseReceiptSha256 !== digestStudyValue(binding.phaseReceipt) ||
      fixture === undefined ||
      manifestEntry?.fixtureId !== binding.fixtureId ||
      manifestEntry?.context?.captureId !== binding.captureId
    ) {
      fail("Comparison public-UI capture binding does not match its manifest editor, template, fixture, and receipt.");
    }
    assertDataWranglerPublicUiManifestEntryMatchesPhase(manifestEntry, {
      kind: binding.kind,
      fixtureId: binding.fixtureId,
      phaseReceipt: binding.phaseReceipt,
      context: manifestEntry.context,
      editor: manifest.editor,
      fixture,
      kernel: { name: kernel.name, displayName: kernel.displayName },
      python: { implementation: manifest.python.implementation, version: manifest.python.version }
    });
    return Object.freeze({ ...binding });
  });
  if (
    new Set(normalized.map((entry) => entry.captureId)).size !== 3 ||
    normalized.filter((entry) => entry.kind === "capability").length !== 2 ||
    normalized.filter((entry) => entry.kind === "control").length !== 1
  ) {
    fail("Comparison public-UI capture bindings are duplicated or incomplete.");
  }
  return Object.freeze(normalized);
}

export async function createDataWranglerComparisonPreparationReceipt(
  {
    preregistrationPath,
    preregistration,
    specificationPath,
    specification,
    manifest,
    manifestPath,
    studyRoot,
    candidatePath,
    editor,
    pythonPath,
    cacheControllerPath,
    driverDirectory,
    driverVsixPath,
    fixturePaths,
    kernelspecPath,
    templates,
    publicUiCaptures,
    createdAtUtc = new Date().toISOString()
  },
  { readInventory = queryDataWranglerTemplateInventory } = {}
) {
  const expectedManifest = buildDataWranglerStudyManifest(specification);
  if (canonicalStudyJson(expectedManifest) !== canonicalStudyJson(manifest)) {
    fail("Comparison preparation manifest is not derived from its exact prepared specification.");
  }
  const preregistrationReceipt = createDataWranglerComparisonPreregistrationReceipt(preregistration);
  if (
    specification.studyId !== preregistration.studyId ||
    canonicalStudyJson(specification.preregistration) !== canonicalStudyJson(preregistrationReceipt)
  ) {
    fail("Comparison preparation specification is not bound to its exact preregistration.");
  }
  privateDirectory(studyRoot, "Comparison preparation study root");
  const candidate = captureDataWranglerPreparationFile(candidatePath, "Comparison preparation candidate", {
    maximumBytes: MAX_CANDIDATE_BYTES
  });
  if (
    candidate.sha256 !== manifest.candidate.sha256 ||
    canonicalStudyJson(candidate.filesystemIdentity) !== canonicalStudyJson(manifest.candidate.filesystemIdentity)
  ) {
    fail("Comparison preparation candidate does not match the manifest.");
  }
  const editorExecutable = captureDataWranglerPreparationFile(
    editor.executable,
    "Comparison preparation editor executable",
    { executable: true, maximumBytes: MAX_EDITOR_EXECUTABLE_BYTES }
  );
  const editorCli = captureDataWranglerPreparationFile(editor.cli, "Comparison preparation editor CLI", {
    executable: true,
    maximumBytes: MAX_EDITOR_CLI_BYTES
  });
  const editorInstallation = captureDataWranglerProfileTree(
    editor.installationRoot,
    "Comparison preparation editor installation"
  );
  const cacheController = captureDataWranglerPreparationFile(
    cacheControllerPath,
    "Comparison preparation cache controller",
    { maximumBytes: MAX_CACHE_CONTROLLER_BYTES }
  );
  if (cacheController.sha256 !== manifest.provenance.cacheToolchain.controller.sha256) {
    fail("Comparison preparation cache controller does not match the manifest.");
  }
  const recoveredDriver = recoverDataWranglerComparisonDriver({
    directory: driverDirectory,
    vsixPath: driverVsixPath,
    expectedDriver: manifest.provenance.comparisonDriver
  });
  const fixtureReceipts = manifest.fixtures.map((fixture) => {
    const path = fixturePaths[fixture.format];
    const receipt = captureDataWranglerPreparationFile(path, `Comparison preparation ${fixture.format} fixture`, {
      maximumBytes: MAX_FIXTURE_BYTES
    });
    if (
      receipt.sha256 !== fixture.sha256 ||
      canonicalStudyJson(receipt.filesystemIdentity) !== canonicalStudyJson(fixture.filesystemIdentity)
    )
      fail(`Comparison preparation ${fixture.format} fixture does not match the manifest.`);
    return Object.freeze({ id: fixture.id, format: fixture.format, ...receipt });
  });
  const kernel = verifyKernelSpec(kernelspecPath, pythonPath, manifest);
  const python = captureDataWranglerComparisonPythonEnvironment({
    pythonPath,
    kernelspecPath,
    jupyterEnvironment: kernel.jupyterEnvironment
  });
  if (
    python.sha256 !== manifest.python.executableSha256 ||
    python.probe.implementation !== manifest.python.implementation ||
    python.probe.version !== manifest.python.version ||
    canonicalStudyJson(python.probe.packages) !== canonicalStudyJson(manifest.python.packages) ||
    python.kernelspec.sha256 !== manifest.python.kernel.kernelspecSha256 ||
    python.stateSha256 !== manifest.python.environmentSha256
  ) {
    fail("Comparison preparation Python, packages, or Jupyter kernel does not match the manifest.");
  }
  const environment = createEditorAcceptanceEnvironment(process.env, {
    OPEN_WRANGLER_EDITOR_DISPLAY: "headless",
    OPEN_WRANGLER_EDITOR_TEMP_ROOT: studyRoot
  });
  configureEditorAcceptanceTempRoot(studyRoot, environment);
  const templateReceipts = [];
  for (const product of ["open-wrangler", "data-wrangler"]) {
    for (const kind of ["configured-only", "warmed"]) {
      const template = templates.find((entry) => entry.product === product && entry.kind === kind);
      if (template === undefined) fail(`Comparison preparation omitted the ${product} ${kind} template.`);
      privateDirectory(template.root, `Comparison preparation ${product} ${kind} template`);
      for (const part of ["user", "extensions"]) {
        privateDirectory(resolve(template.root, part), `Comparison preparation ${product} ${kind} ${part}`);
      }
      const inventory = await readInventory(template, editor, environment);
      assertTemplateInventory(inventory, expectedProductExtensions(manifest, product));
      const tree = captureDataWranglerProfileTree(template.root, `Comparison preparation ${product} ${kind} template`);
      const expectedTemplate = manifest.provenance.templates.find((entry) => entry.product === product);
      const expectedSha256 =
        kind === "warmed" ? expectedTemplate.warmedReceiptSha256 : expectedTemplate.configuredOnlyReceiptSha256;
      if (tree.treeSha256 !== expectedSha256) {
        fail(`Comparison preparation ${product} ${kind} template does not match the manifest.`);
      }
      templateReceipts.push(
        Object.freeze({ product, kind, sandboxArgs: Object.freeze([...template.sandboxArgs]), inventory, ...tree })
      );
    }
  }
  const captureBindings = normalizePublicUiCaptureBindings(manifest, publicUiCaptures, kernel);
  const receipt = Object.freeze({
    protocol: DATA_WRANGLER_COMPARISON_PREPARATION_PROTOCOL,
    preregistrationPath,
    preregistrationSha256: digestStudyValue(preregistration),
    specificationPath,
    specificationSha256: digestStudyValue(specification),
    specification: structuredClone(specification),
    manifestPath,
    manifestSha256: digestStudyValue(manifest),
    studyRoot,
    candidate,
    editor: Object.freeze({
      id: manifest.editor.id,
      version: manifest.editor.version,
      distributionSha256: manifest.editor.sha256,
      installationRoot: editor.installationRoot,
      installationTreeSha256: editorInstallation.treeSha256,
      executablePath: editor.executable,
      executableSha256: editorExecutable.sha256,
      executableFilesystemIdentity: editorExecutable.filesystemIdentity,
      cliPath: editor.cli,
      cliSha256: editorCli.sha256,
      cliFilesystemIdentity: editorCli.filesystemIdentity
    }),
    python,
    cacheController,
    driver: Object.freeze({
      directory: driverDirectory,
      vsixPath: driverVsixPath,
      receiptSha256: digestStudyValue(manifest.provenance.comparisonDriver),
      recoveredVsixSha256: recoveredDriver.vsix.sha256
    }),
    fixtures: Object.freeze(fixtureReceipts),
    selectedKernel: kernel,
    templates: Object.freeze(templateReceipts),
    publicUiCaptures: captureBindings,
    createdAtUtc
  });
  validatePreparationReceipt(receipt);
  return receipt;
}

export async function revalidateDataWranglerComparisonPreparationReceipt(receipt, dependencies = {}) {
  validatePreparationReceipt(receipt);
  const preregistration = (dependencies.readPreregistration ?? readDataWranglerComparisonPreregistration)(
    receipt.preregistrationPath
  );
  (dependencies.assertCurrentPreregistration ?? assertCurrentDataWranglerComparisonPreregistration)(preregistration);
  if (
    digestStudyValue(preregistration) !== receipt.preregistrationSha256 ||
    canonicalStudyJson(createDataWranglerComparisonPreregistrationReceipt(preregistration)) !==
      canonicalStudyJson(receipt.specification.preregistration)
  ) {
    fail("Comparison preparation preregistration changed.");
  }
  const manifest = buildDataWranglerStudyManifest(receipt.specification);
  if (digestStudyValue(manifest) !== receipt.manifestSha256) fail("Comparison preparation manifest changed.");
  const recreated = await createDataWranglerComparisonPreparationReceipt(
    {
      preregistrationPath: receipt.preregistrationPath,
      preregistration,
      specificationPath: receipt.specificationPath,
      specification: receipt.specification,
      manifest,
      manifestPath: receipt.manifestPath,
      studyRoot: receipt.studyRoot,
      candidatePath: receipt.candidate.path,
      editor: {
        installationRoot: receipt.editor.installationRoot,
        executable: receipt.editor.executablePath,
        cli: receipt.editor.cliPath
      },
      pythonPath: receipt.python.path,
      cacheControllerPath: receipt.cacheController.path,
      driverDirectory: receipt.driver.directory,
      driverVsixPath: receipt.driver.vsixPath,
      fixturePaths: Object.fromEntries(receipt.fixtures.map((entry) => [entry.format, entry.path])),
      kernelspecPath: receipt.selectedKernel.path,
      templates: receipt.templates.map((entry) => ({
        product: entry.product,
        kind: entry.kind,
        root: entry.root,
        sandboxArgs: entry.sandboxArgs
      })),
      publicUiCaptures: receipt.publicUiCaptures,
      createdAtUtc: receipt.createdAtUtc
    },
    dependencies
  );
  if (canonicalStudyJson(recreated) !== canonicalStudyJson(receipt)) fail("Comparison preparation receipt changed.");
  return receipt;
}

export function createDataWranglerTemplateCapture(studyRoot) {
  privateDirectory(studyRoot, "Comparison preparation study root");
  const captured = new Map();
  return Object.freeze({
    async capture({ product, kind, userData, extensions, editor, sandboxArgs }) {
      const key = `${product}:${kind}`;
      if (captured.has(key)) fail(`Comparison preparation captured ${key} more than once.`);
      const root = resolve(studyRoot, "templates", product, kind);
      mkdirSync(root, { recursive: true, mode: 0o700 });
      const targetUser = resolve(root, "user");
      const targetExtensions = resolve(root, "extensions");
      cpSync(userData, targetUser, { recursive: true, errorOnExist: true, force: false, verbatimSymlinks: true });
      cpSync(extensions, targetExtensions, {
        recursive: true,
        errorOnExist: true,
        force: false,
        verbatimSymlinks: true
      });
      chmodSync(root, 0o700);
      chmodSync(targetUser, 0o700);
      chmodSync(targetExtensions, 0o700);
      captured.set(key, Object.freeze({ product, kind, root, editor, sandboxArgs: Object.freeze([...sandboxArgs]) }));
    },
    values() {
      if (captured.size !== 4) fail("Comparison preparation did not capture all four profile templates.");
      return Object.freeze([...captured.values()]);
    }
  });
}

export function cloneDataWranglerComparisonTemplate(receipt, { product, kind, cloneRoot }) {
  validatePreparationReceipt(receipt);
  const template = receipt.templates.find((entry) => entry.product === product && entry.kind === kind);
  if (template === undefined) fail("Comparison preparation has no matching profile template.");
  return cloneDataWranglerCapturedTemplate(template, { cloneRoot });
}

export function cloneDataWranglerCapturedTemplate(template, { cloneRoot }) {
  exactKeys(
    template,
    ["product", "kind", "root", "sandboxArgs", "treeSha256"],
    "Captured comparison profile template",
    ["editor", "userData", "extensions", "rootIdentity", "entryCount", "totalBytes", "inventory"]
  );
  if (
    !["open-wrangler", "data-wrangler"].includes(template.product) ||
    !["configured-only", "warmed"].includes(template.kind) ||
    typeof template.treeSha256 !== "string" ||
    !SHA256.test(template.treeSha256)
  ) {
    fail("Captured comparison profile template is invalid.");
  }
  if (statSync(cloneRoot, { throwIfNoEntry: false }) !== undefined)
    fail("Comparison profile clone target already exists.");
  const before = captureDataWranglerProfileTree(template.root);
  if (before.treeSha256 !== template.treeSha256) fail("Comparison profile template changed before cloning.");
  mkdirSync(cloneRoot, { recursive: false, mode: 0o700 });
  cpSync(template.root, cloneRoot, { recursive: true, errorOnExist: false, force: false, verbatimSymlinks: true });
  const modeQueue = [[template.root, cloneRoot]];
  while (modeQueue.length > 0) {
    const [sourceDirectory, targetDirectory] = modeQueue.shift();
    chmodSync(targetDirectory, Number(lstatSync(sourceDirectory, { bigint: true }).mode & 0o777n));
    for (const entry of readdirSync(sourceDirectory, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        modeQueue.push([resolve(sourceDirectory, entry.name), resolve(targetDirectory, entry.name)]);
      }
    }
  }
  const clone = captureDataWranglerProfileTree(cloneRoot, "Comparison profile clone");
  if (clone.treeSha256 !== template.treeSha256) {
    rmSync(cloneRoot, { recursive: true, force: true });
    fail("Comparison profile clone does not match its template.");
  }
  return Object.freeze({
    product: template.product,
    kind: template.kind,
    root: cloneRoot,
    userData: resolve(cloneRoot, "user"),
    extensions: resolve(cloneRoot, "extensions"),
    sandboxArgs: template.sandboxArgs,
    templateTreeSha256: template.treeSha256,
    cloneTreeSha256: clone.treeSha256
  });
}

export function retireDataWranglerComparisonTemplateClone(clone) {
  exactKeys(
    clone,
    ["product", "kind", "root", "userData", "extensions", "sandboxArgs", "templateTreeSha256", "cloneTreeSha256"],
    "Comparison profile clone"
  );
  privateDirectory(clone.root, "Comparison profile clone");
  const root = clone.root;
  rmSync(root, { recursive: true, force: false });
  if (lstatSync(dirname(root)).isDirectory() && statSync(root, { throwIfNoEntry: false }) !== undefined) {
    fail("Comparison profile clone remained after retirement.");
  }
  return Object.freeze({
    status: "retired",
    treeEmpty: true,
    rootNameSha256: createHash("sha256").update(basename(root)).digest("hex")
  });
}

export function writeDataWranglerComparisonPreparationReceipt(path, receipt) {
  validatePreparationReceipt(receipt);
  const sha256 = digestDurableJsonValue(receipt);
  const recovered = recoverDurableStudyJsonPublication(path, sha256);
  if (recovered.status !== "absent") return Object.freeze({ path: resolve(path), sha256, status: recovered.status });
  const publication = publishDurableStudyJsonExclusive(path, receipt);
  return Object.freeze({ path: resolve(path), sha256, status: publication.status });
}

export function loadDataWranglerComparisonPreparationReceipt(path) {
  const { value } = readBoundedDataWranglerPreparationJson(
    resolve(path),
    "Comparison preparation receipt",
    MAX_PREPARATION_JSON_BYTES
  );
  return validatePreparationReceipt(value);
}

export function probeDataWranglerComparisonPython(pythonPath) {
  const source = [
    "import hashlib, importlib, json, platform, sys",
    `names = ${JSON.stringify(REQUIRED_PACKAGES)}`,
    "versions = {name: importlib.import_module(name).__version__ for name in names}",
    "print(json.dumps({'implementation': platform.python_implementation(), 'version': platform.python_version(), 'packages': versions}, sort_keys=True))"
  ].join("\n");
  const value = JSON.parse(executeIdentityPinnedPreparationInterpreter(pythonPath, ["-I", "-c", source]));
  if (
    value.implementation !== "CPython" ||
    typeof value.version !== "string" ||
    !isRecord(value.packages) ||
    REQUIRED_PACKAGES.some((name) => !VERSION.test(value.packages[name]))
  )
    fail("Comparison preparation Python environment is incomplete or unsupported.");
  return Object.freeze({
    implementation: value.implementation,
    version: value.version,
    packages: Object.freeze(REQUIRED_PACKAGES.map((name) => Object.freeze({ name, version: value.packages[name] })))
  });
}

export function captureDataWranglerComparisonPythonEnvironment({ pythonPath, kernelspecPath, jupyterEnvironment }) {
  const interpreter = captureDataWranglerPreparationFile(pythonPath, "Comparison preparation Python", {
    executable: true,
    maximumBytes: MAX_PYTHON_EXECUTABLE_BYTES
  });
  const probe = probeDataWranglerComparisonPython(pythonPath);
  const kernelspec = readBoundedDataWranglerPreparationJson(
    kernelspecPath,
    "Comparison preparation kernelspec",
    MAX_KERNELSPEC_BYTES
  ).receipt;
  const jupyter = Object.entries(jupyterEnvironment)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([name, root]) => {
      if (!["configDir", "dataDir", "path", "runtimeDir"].includes(name)) {
        fail("Comparison preparation Jupyter environment has an unknown directory.");
      }
      return Object.freeze({ name, ...captureDataWranglerProfileTree(root, `Comparison Jupyter ${name}`) });
    });
  if (jupyter.length !== 4) fail("Comparison preparation Jupyter environment is incomplete.");
  const stateSha256 = digestDataWranglerComparisonPythonEnvironment({
    implementation: probe.implementation,
    version: probe.version,
    executableSha256: interpreter.sha256,
    packages: probe.packages,
    kernelspecSha256: kernelspec.sha256,
    jupyter
  });
  return Object.freeze({
    ...interpreter,
    probe,
    kernelspec: Object.freeze({ path: kernelspec.path, sha256: kernelspec.sha256 }),
    jupyter: Object.freeze(jupyter),
    stateSha256
  });
}

export function digestDataWranglerComparisonPythonEnvironment({
  implementation,
  version,
  executableSha256,
  packages,
  kernelspecSha256,
  jupyter
}) {
  return digestStudyValue({
    implementation,
    version,
    executableSha256,
    packages,
    kernelspecSha256,
    jupyter: jupyter.map(({ name, treeSha256 }) => ({ name, treeSha256 }))
  });
}

export function executeIdentityPinnedPreparationInterpreter(path, args) {
  canonicalAbsolutePath(path, "Comparison preparation interpreter");
  if (!Array.isArray(args) || args.some((entry) => typeof entry !== "string" || /[\0\r\n]/u.test(entry))) {
    fail("Comparison preparation interpreter arguments are invalid.");
  }
  let descriptor;
  try {
    const before = lstatSync(path, { bigint: true });
    if (
      !before.isFile() ||
      before.isSymbolicLink() ||
      before.nlink !== 1n ||
      !ownerMatches(before) ||
      (before.mode & 0o111n) === 0n
    ) {
      fail("Comparison preparation interpreter must be one owned, singly linked executable regular file.");
    }
    descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const opened = fstatSync(descriptor, { bigint: true });
    if (!sameMetadata(before, opened)) fail("Comparison preparation interpreter changed while it opened.");
    const output = execFileSync("/proc/self/fd/3", args, {
      argv0: path,
      encoding: "utf8",
      maxBuffer: 64 * 1024,
      timeout: 30_000,
      stdio: ["ignore", "pipe", "pipe", descriptor]
    });
    const after = fstatSync(descriptor, { bigint: true });
    const namedAfter = lstatSync(path, { bigint: true });
    if (!sameMetadata(opened, after) || !sameMetadata(after, namedAfter)) {
      fail("Comparison preparation interpreter changed while it executed.");
    }
    if (typeof output !== "string" || Buffer.byteLength(output, "utf8") > 64 * 1024) {
      fail("Comparison preparation interpreter output is absent or oversized.");
    }
    return output;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}
