import { createHash, randomBytes } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { reconcileOpenWranglerCompiledCommonJsClosure } from "./remote-workspace-staging.mjs";

const repositoryRoot = resolve(import.meta.dirname, "..");
const MAX_PACKAGE_MANIFEST_BYTES = 64 * 1024;
const MAX_VENDOR_BYTES = 1024 * 1024;
const OUTPUT_ROOTS = new Set(["dist", "dist-test"]);

export const JS_YAML_VENDOR_ASSET = Object.freeze({
  output: "extension/vendor/js-yaml.js",
  packageManifest: "node_modules/js-yaml/package.json",
  packageName: "js-yaml",
  source: "node_modules/js-yaml/dist/js-yaml.cjs.js"
});

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function canonicalRepositoryRoot(root) {
  const requested = resolve(root);
  let metadata;
  let canonical;
  try {
    metadata = lstatSync(requested);
    canonical = realpathSync.native(requested);
  } catch (error) {
    if (error?.code === "ENOENT") throw new Error("The extension vendor repository root is missing.");
    throw error;
  }
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || canonical !== requested) {
    throw new Error("The extension vendor repository root must be one canonical directory.");
  }
  return requested;
}

function containedPath(root, relativePath, label) {
  if (
    typeof relativePath !== "string" ||
    relativePath.length === 0 ||
    isAbsolute(relativePath) ||
    relativePath.split(/[\\/]/u).some((part) => part === "" || part === "." || part === "..")
  ) {
    throw new Error(`${label} has an invalid relative path.`);
  }
  const target = resolve(root, relativePath);
  const fromRoot = relative(root, target);
  if (fromRoot === "" || fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
    throw new Error(`${label} escapes the repository root.`);
  }
  return target;
}

function requireRealParentDirectories(root, target, label) {
  const fromRoot = relative(root, dirname(target));
  const components = fromRoot === "" ? [] : fromRoot.split(sep);
  let current = root;
  for (const component of components) {
    current = resolve(current, component);
    let metadata;
    try {
      metadata = lstatSync(current);
    } catch (error) {
      if (error?.code === "ENOENT") throw new Error(`${label} parent is missing.`);
      throw error;
    }
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new Error(`${label} ancestry must contain only real directories.`);
    }
  }
}

function readRegularFile(path, label, maximumBytes) {
  let descriptor;
  try {
    descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  } catch (error) {
    if (error?.code === "ENOENT") throw new Error(`${label} is missing.`);
    if (error?.code === "ELOOP") {
      throw new Error(`${label} must be one non-empty regular file no larger than ${maximumBytes} bytes.`);
    }
    throw error;
  }
  try {
    const before = fstatSync(descriptor, { bigint: true });
    const namedBefore = lstatSync(path, { bigint: true });
    if (
      !before.isFile() ||
      !namedBefore.isFile() ||
      namedBefore.isSymbolicLink() ||
      before.dev !== namedBefore.dev ||
      before.ino !== namedBefore.ino ||
      before.size <= 0n ||
      before.size > BigInt(maximumBytes)
    ) {
      throw new Error(`${label} must be one non-empty regular file no larger than ${maximumBytes} bytes.`);
    }
    const bytes = readFileSync(descriptor);
    const after = fstatSync(descriptor, { bigint: true });
    const namedAfter = lstatSync(path, { bigint: true });
    if (
      bytes.length !== Number(before.size) ||
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeNs !== after.mtimeNs ||
      before.ctimeNs !== after.ctimeNs ||
      namedAfter.dev !== after.dev ||
      namedAfter.ino !== after.ino ||
      !namedAfter.isFile() ||
      namedAfter.isSymbolicLink()
    ) {
      throw new Error(`${label} changed while it was read.`);
    }
    return bytes;
  } finally {
    closeSync(descriptor);
  }
}

function readVendorSource(root) {
  const manifestPath = containedPath(root, JS_YAML_VENDOR_ASSET.packageManifest, "js-yaml package manifest");
  const sourcePath = containedPath(root, JS_YAML_VENDOR_ASSET.source, "js-yaml CommonJS entrypoint");
  requireRealParentDirectories(root, manifestPath, "js-yaml package manifest");
  requireRealParentDirectories(root, sourcePath, "js-yaml CommonJS entrypoint");
  const manifestBytes = readRegularFile(manifestPath, "js-yaml package manifest", MAX_PACKAGE_MANIFEST_BYTES);
  let manifest;
  try {
    manifest = JSON.parse(manifestBytes.toString("utf8"));
  } catch {
    throw new Error("The js-yaml package manifest is not valid JSON.");
  }
  if (
    manifest?.name !== JS_YAML_VENDOR_ASSET.packageName ||
    typeof manifest.version !== "string" ||
    !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u.test(manifest.version) ||
    manifest.main !== "./dist/js-yaml.cjs.js" ||
    manifest.exports?.["."]?.require !== "./dist/js-yaml.cjs.js"
  ) {
    throw new Error("The installed js-yaml package must expose its documented CommonJS entrypoint.");
  }
  return Object.freeze({
    bytes: readRegularFile(sourcePath, "js-yaml CommonJS entrypoint", MAX_VENDOR_BYTES),
    version: manifest.version
  });
}

function ensureDirectoryTree(root, target, { create = false } = {}) {
  const fromRoot = relative(root, target);
  const components = fromRoot === "" ? [] : fromRoot.split(sep);
  let current = root;
  for (const component of ["", ...components]) {
    if (component !== "") current = resolve(current, component);
    if (!existsSync(current)) {
      if (!create) return false;
      mkdirSync(current);
    }
    const metadata = lstatSync(current);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new Error("The extension vendor output tree must contain only real directories.");
    }
  }
  return true;
}

function outputTarget(root, outputRoot) {
  if (!OUTPUT_ROOTS.has(outputRoot)) {
    throw new Error("The extension vendor output root must be dist or dist-test.");
  }
  return containedPath(root, `${outputRoot}/${JS_YAML_VENDOR_ASSET.output}`, "js-yaml vendor output");
}

function inspectVendorDirectory(root, outputRoot) {
  const target = outputTarget(root, outputRoot);
  const directory = dirname(target);
  if (!ensureDirectoryTree(root, directory)) return Object.freeze({ exists: false, target });
  const names = readdirSync(directory);
  if (names.some((name) => name !== "js-yaml.js")) {
    throw new Error("The extension vendor output directory contains an unexpected asset.");
  }
  if (!names.includes("js-yaml.js")) return Object.freeze({ exists: false, target });
  readRegularFile(target, `js-yaml vendor output ${outputRoot}`, MAX_VENDOR_BYTES);
  return Object.freeze({ exists: true, target });
}

export function guardExtensionVendorAssets({ root = repositoryRoot, outputRoot } = {}) {
  const canonicalRoot = canonicalRepositoryRoot(root);
  readVendorSource(canonicalRoot);
  inspectVendorDirectory(canonicalRoot, outputRoot);
}

export function copyExtensionVendorAssets({ root = repositoryRoot, outputRoot } = {}) {
  const canonicalRoot = canonicalRepositoryRoot(root);
  const source = readVendorSource(canonicalRoot);
  const inspected = inspectVendorDirectory(canonicalRoot, outputRoot);
  ensureDirectoryTree(canonicalRoot, dirname(inspected.target), { create: true });

  const temporary = `${inspected.target}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
  try {
    writeFileSync(temporary, source.bytes, { flag: "wx", mode: 0o600 });
    const copied = readRegularFile(temporary, "temporary js-yaml vendor output", MAX_VENDOR_BYTES);
    if (!copied.equals(source.bytes)) throw new Error("The temporary js-yaml vendor output differs from its source.");
    renameSync(temporary, inspected.target);
  } finally {
    rmSync(temporary, { force: true });
  }

  const output = readRegularFile(inspected.target, `js-yaml vendor output ${outputRoot}`, MAX_VENDOR_BYTES);
  if (!output.equals(source.bytes)) throw new Error(`The js-yaml vendor output ${outputRoot} differs from its source.`);
  return Object.freeze({
    output: Object.freeze({ bytes: output.length, sha256: sha256(output) }),
    outputRoot,
    version: source.version
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
