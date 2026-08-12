import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  opendirSync,
  readSync,
  realpathSync,
  unlinkSync,
  writeSync
} from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { reconcileOpenWranglerCompiledCommonJsClosure } from "./remote-workspace-staging.mjs";

const repositoryRoot = resolve(import.meta.dirname, "..");
const PACKAGE_MANIFEST_MAX_BYTES = 64 * 1024;
const OUTPUT_ROOTS = new Set(["dist", "dist-test"]);

export const JS_YAML_VENDOR_ASSET = Object.freeze({
  bytes: 122_488,
  output: "extension/vendor/js-yaml.js",
  packageManifest: "node_modules/js-yaml/package.json",
  packageName: "js-yaml",
  packageVersion: "5.2.3",
  sha256: "f1499c20ab232a283f6f9f85aeecc99dceab175e8dd4005bd3d764848f3e5965",
  source: "node_modules/js-yaml/dist/js-yaml.cjs.js"
});

function canonicalRepositoryRoot(root) {
  const requested = resolve(root);
  const canonical = realpathSync.native(requested);
  const metadata = lstatSync(canonical, { bigint: true });
  if (canonical !== requested || !metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error("The extension vendor repository root must be one canonical directory.");
  }
  return canonical;
}

function requireRelativePath(path, label) {
  if (
    typeof path !== "string" ||
    path.length === 0 ||
    isAbsolute(path) ||
    path.split(/[\\/]/u).some((part) => part === "" || part === "." || part === "..")
  ) {
    throw new Error(`${label} has an invalid relative path.`);
  }
}

function containedPath(root, relativePath, label) {
  requireRelativePath(relativePath, label);
  const target = resolve(root, relativePath);
  const fromRoot = relative(root, target);
  if (fromRoot === "" || fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
    throw new Error(`${label} escapes the extension vendor repository root.`);
  }
  return target;
}

function assertCanonicalDirectory(path, label) {
  const metadata = lstatSync(path, { bigint: true });
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || realpathSync.native(path) !== path) {
    throw new Error(`${label} must be one canonical directory without links.`);
  }
  return Object.freeze({ dev: metadata.dev, ino: metadata.ino });
}

function assertPathParents(root, target, label, { create = false } = {}) {
  const fromRoot = relative(root, dirname(target));
  const components = fromRoot === "" ? [] : fromRoot.split(sep);
  let current = root;
  const receipts = [Object.freeze({ path: root, ...assertCanonicalDirectory(root, `${label} repository root`) })];
  let missing = false;
  for (const component of components) {
    current = resolve(current, component);
    if (missing && !create) continue;
    try {
      const receipt = assertCanonicalDirectory(current, `${label} parent`);
      receipts.push(Object.freeze({ path: current, ...receipt }));
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      missing = true;
      if (!create) continue;
      try {
        mkdirSync(current, { mode: 0o755 });
      } catch (mkdirError) {
        if (mkdirError?.code !== "EEXIST") throw mkdirError;
      }
      const receipt = assertCanonicalDirectory(current, `${label} parent`);
      receipts.push(Object.freeze({ path: current, ...receipt }));
    }
  }
  return Object.freeze(receipts);
}

function assertParentReceipts(receipts, label) {
  for (const receipt of receipts) {
    const metadata = lstatSync(receipt.path, { bigint: true });
    if (
      !metadata.isDirectory() ||
      metadata.isSymbolicLink() ||
      metadata.dev !== receipt.dev ||
      metadata.ino !== receipt.ino ||
      realpathSync.native(receipt.path) !== receipt.path
    ) {
      throw new Error(`${label} parent changed during extension vendor staging.`);
    }
  }
}

function requireRegularFile(metadata, label, maximumBytes) {
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.nlink !== 1n ||
    metadata.size <= 0n ||
    metadata.size > BigInt(maximumBytes) ||
    metadata.size > BigInt(Number.MAX_SAFE_INTEGER)
  ) {
    throw new Error(`${label} must be one bounded single-link regular file.`);
  }
}

function requireNewOutputFile(metadata, label) {
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1n || metadata.size !== 0n) {
    throw new Error(`${label} must begin as one empty single-link regular file.`);
  }
}

function sameImmutableFile(left, right) {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

function readPinnedFile(path, label, maximumBytes) {
  let descriptor;
  let result;
  let failure;
  try {
    descriptor = openSync(
      path,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0) | (constants.O_CLOEXEC ?? 0)
    );
    const opened = fstatSync(descriptor, { bigint: true });
    const namedBefore = lstatSync(path, { bigint: true });
    requireRegularFile(opened, label, maximumBytes);
    requireRegularFile(namedBefore, label, maximumBytes);
    if (!sameImmutableFile(opened, namedBefore)) throw new Error(`${label} changed before its descriptor was pinned.`);
    const bytes = Buffer.alloc(Number(opened.size));
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(descriptor, bytes, offset, bytes.length - offset, null);
      if (!Number.isSafeInteger(count) || count <= 0) throw new Error(`${label} ended before its validated byte size.`);
      offset += count;
    }
    const completed = fstatSync(descriptor, { bigint: true });
    const namedAfter = lstatSync(path, { bigint: true });
    requireRegularFile(completed, label, maximumBytes);
    requireRegularFile(namedAfter, label, maximumBytes);
    if (!sameImmutableFile(opened, completed) || !sameImmutableFile(completed, namedAfter)) {
      throw new Error(`${label} changed while it was read.`);
    }
    result = Object.freeze({ bytes, file: opened });
  } catch (error) {
    failure = error?.code === "ENOENT" ? new Error(`${label} is missing.`) : error;
  }
  if (descriptor !== undefined) {
    try {
      closeSync(descriptor);
    } catch (error) {
      failure = failure
        ? new AggregateError([failure, error], `${label} failed and its descriptor could not close.`)
        : error;
    }
  }
  if (failure) throw failure;
  return result;
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function readVendorSource(root) {
  const manifestPath = containedPath(root, JS_YAML_VENDOR_ASSET.packageManifest, "js-yaml package manifest");
  const sourcePath = containedPath(root, JS_YAML_VENDOR_ASSET.source, "js-yaml vendor source");
  const manifestParents = assertPathParents(root, manifestPath, "js-yaml package manifest");
  const sourceParents = assertPathParents(root, sourcePath, "js-yaml vendor source");
  const manifest = readPinnedFile(manifestPath, "js-yaml package manifest", PACKAGE_MANIFEST_MAX_BYTES);
  let parsed;
  try {
    parsed = JSON.parse(manifest.bytes.toString("utf8"));
  } catch {
    throw new Error("The js-yaml package manifest is not valid JSON.");
  }
  if (
    !parsed ||
    parsed.name !== JS_YAML_VENDOR_ASSET.packageName ||
    parsed.version !== JS_YAML_VENDOR_ASSET.packageVersion ||
    parsed.main !== "./dist/js-yaml.cjs.js" ||
    parsed.exports?.["."]?.require !== "./dist/js-yaml.cjs.js"
  ) {
    throw new Error("The js-yaml package identity or CommonJS entrypoint does not match the pinned vendor asset.");
  }
  const source = readPinnedFile(sourcePath, "js-yaml vendor source", JS_YAML_VENDOR_ASSET.bytes);
  if (source.bytes.length !== JS_YAML_VENDOR_ASSET.bytes || sha256(source.bytes) !== JS_YAML_VENDOR_ASSET.sha256) {
    throw new Error("The js-yaml vendor source does not match its pinned size and SHA-256.");
  }
  assertParentReceipts(manifestParents, "js-yaml package manifest");
  assertParentReceipts(sourceParents, "js-yaml vendor source");
  return Object.freeze({ manifest, source });
}

function outputTarget(root, outputRoot) {
  if (!OUTPUT_ROOTS.has(outputRoot)) {
    throw new Error("The extension vendor output root must be dist or dist-test.");
  }
  return containedPath(root, `${outputRoot}/${JS_YAML_VENDOR_ASSET.output}`, "js-yaml vendor output");
}

function inspectVendorDirectory(root, outputRoot, source) {
  const target = outputTarget(root, outputRoot);
  const parents = assertPathParents(root, target, "js-yaml vendor output");
  const vendorDirectory = dirname(target);
  let directory;
  try {
    directory = assertCanonicalDirectory(vendorDirectory, "Extension vendor output directory");
  } catch (error) {
    if (error?.code === "ENOENT") return Object.freeze({ exists: false, parents, target });
    throw error;
  }
  const names = [];
  const handle = opendirSync(vendorDirectory);
  try {
    let entry;
    while ((entry = handle.readSync()) !== null) names.push(entry.name);
  } finally {
    handle.closeSync();
  }
  const after = assertCanonicalDirectory(vendorDirectory, "Extension vendor output directory");
  if (after.dev !== directory.dev || after.ino !== directory.ino) {
    throw new Error("The extension vendor output directory changed while it was inspected.");
  }
  if (names.some((name) => name !== "js-yaml.js")) {
    throw new Error("The extension vendor output directory contains an unexpected asset.");
  }
  if (!names.includes("js-yaml.js")) return Object.freeze({ exists: false, parents, target });
  const output = readPinnedFile(target, `js-yaml vendor output ${outputRoot}`, JS_YAML_VENDOR_ASSET.bytes);
  if (!output.bytes.equals(source.bytes) || sha256(output.bytes) !== JS_YAML_VENDOR_ASSET.sha256) {
    throw new Error(`The js-yaml vendor output ${outputRoot} is stale or unexpected.`);
  }
  assertParentReceipts(parents, "js-yaml vendor output");
  return Object.freeze({ exists: true, output, parents, target });
}

export function guardExtensionVendorAssets({ root = repositoryRoot, outputRoot } = {}) {
  const canonicalRoot = canonicalRepositoryRoot(root);
  const { source } = readVendorSource(canonicalRoot);
  inspectVendorDirectory(canonicalRoot, outputRoot, source);
}

function writeAll(descriptor, bytes, label) {
  let offset = 0;
  while (offset < bytes.length) {
    const count = writeSync(descriptor, bytes, offset, bytes.length - offset);
    if (!Number.isSafeInteger(count) || count <= 0) throw new Error(`${label} write made no progress.`);
    offset += count;
  }
}

function createVendorOutput(target, parents, bytes, label) {
  let descriptor;
  let opened;
  let failure;
  let closeFailed = false;
  try {
    descriptor = openSync(
      target,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        (constants.O_NOFOLLOW ?? 0) |
        (constants.O_CLOEXEC ?? 0),
      0o644
    );
    opened = fstatSync(descriptor, { bigint: true });
    requireNewOutputFile(opened, label);
    const named = lstatSync(target, { bigint: true });
    requireNewOutputFile(named, label);
    if (opened.dev !== named.dev || opened.ino !== named.ino) {
      throw new Error(`${label} path does not identify its exclusive output descriptor.`);
    }
    assertParentReceipts(parents, label);
    writeAll(descriptor, bytes, label);
    fsyncSync(descriptor);
    const completed = fstatSync(descriptor, { bigint: true });
    const namedAfter = lstatSync(target, { bigint: true });
    requireRegularFile(completed, label, JS_YAML_VENDOR_ASSET.bytes);
    requireRegularFile(namedAfter, label, JS_YAML_VENDOR_ASSET.bytes);
    if (
      opened.dev !== completed.dev ||
      opened.ino !== completed.ino ||
      !sameImmutableFile(completed, namedAfter) ||
      completed.size !== BigInt(bytes.length)
    ) {
      throw new Error(`${label} changed while it was written.`);
    }
  } catch (error) {
    failure = error;
  }
  if (descriptor !== undefined) {
    try {
      closeSync(descriptor);
    } catch (error) {
      closeFailed = true;
      failure = failure
        ? new AggregateError([failure, error], `${label} failed and its descriptor could not close.`)
        : error;
    }
  }
  if (failure) {
    if (opened !== undefined && !closeFailed) {
      try {
        const named = lstatSync(target, { bigint: true });
        if (
          named.isFile() &&
          !named.isSymbolicLink() &&
          named.nlink === 1n &&
          named.dev === opened.dev &&
          named.ino === opened.ino
        ) {
          unlinkSync(target);
        }
      } catch {
        // A substituted or uncertain generated path is retained untouched.
      }
    }
    throw failure;
  }
}

export function copyExtensionVendorAssets({ root = repositoryRoot, outputRoot } = {}) {
  const canonicalRoot = canonicalRepositoryRoot(root);
  const before = readVendorSource(canonicalRoot);
  const inspected = inspectVendorDirectory(canonicalRoot, outputRoot, before.source);
  if (!inspected.exists) {
    const parents = assertPathParents(canonicalRoot, inspected.target, "js-yaml vendor output", { create: true });
    createVendorOutput(inspected.target, parents, before.source.bytes, `js-yaml vendor output ${outputRoot}`);
  }
  const verified = inspectVendorDirectory(canonicalRoot, outputRoot, before.source);
  if (!verified.exists) throw new Error(`The js-yaml vendor output ${outputRoot} was not created.`);
  const after = readVendorSource(canonicalRoot);
  if (
    !sameImmutableFile(before.manifest.file, after.manifest.file) ||
    !sameImmutableFile(before.source.file, after.source.file)
  ) {
    throw new Error("The pinned js-yaml package changed during extension vendor staging.");
  }
  return Object.freeze({
    output: Object.freeze({ bytes: verified.output.bytes.length, sha256: sha256(verified.output.bytes) }),
    outputRoot
  });
}

if (process.argv[1] !== undefined && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  if (process.argv.length === 3) {
    copyExtensionVendorAssets({ outputRoot: process.argv[2] });
    reconcileOpenWranglerCompiledCommonJsClosure({ root: repositoryRoot, outputRoot: process.argv[2] });
  } else if (process.argv.length === 4 && process.argv[2] === "--guard-output-tree") {
    guardExtensionVendorAssets({ outputRoot: process.argv[3] });
  } else {
    throw new Error(
      "copy-extension-vendor-assets accepts only dist, dist-test, or --guard-output-tree followed by one output root."
    );
  }
}
