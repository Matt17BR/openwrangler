import { spawnSync } from "node:child_process";
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  ftruncateSync,
  lstatSync,
  openSync,
  opendirSync,
  readSync,
  realpathSync,
  unlinkSync,
  writeSync
} from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

const repositoryRoot = resolve(import.meta.dirname, "..");
const MAX_RUNTIME_ASSET_BYTES = 64 * 1024;
const MAX_ENTRYPOINT_BYTES = 1024 * 1024;
const MAX_PREFLIGHT_OUTPUT_BYTES = 16 * 1024;
const PREFLIGHT_TIMEOUT_MS = 10_000;
const MAX_OUTPUT_TREE_ENTRIES = 4_096;
const MAX_OUTPUT_TREE_DEPTH = 16;
const EXTENSION_TEST_ENTRYPOINT = "dist-test/test/extensionHost/installedPerformance.js";
const ENTRYPOINT_PREFLIGHT = String.raw`
const Module = require("node:module");
const path = require("node:path");
const entrypoint = process.argv[1];
const root = process.argv[2];
const originalLoad = Module._load;
Module._load = function(request, parent, isMain) {
  if (request === "vscode") return Object.freeze({});
  return Reflect.apply(originalLoad, this, arguments);
};
const loaded = require(entrypoint);
if (typeof loaded.run !== "function") {
  throw new TypeError("The installed-performance extension-test entrypoint must export run.");
}
const localRoot = path.join(root, "dist-test") + path.sep;
const loadedLocalModules = Object.keys(require.cache)
  .filter((file) => file.startsWith(localRoot))
  .sort();
process.stdout.write(JSON.stringify(loadedLocalModules));
`;

// TypeScript resolves the sibling .d.cts declarations for these CommonJS
// modules and therefore does not emit their implementations. This fixed list
// is the sole owner of staging those runtime bytes into dist-test.
export const EXTENSION_TEST_RUNTIME_ASSETS = Object.freeze([
  Object.freeze({
    source: "src/shared/installedPerformanceFixtureManifest.cjs",
    output: "dist-test/shared/installedPerformanceFixtureManifest.cjs"
  }),
  Object.freeze({
    source: "src/shared/strictJson.cjs",
    output: "dist-test/shared/strictJson.cjs"
  })
]);
export const EXTENSION_TEST_COMPILED_MODULES = Object.freeze([
  EXTENSION_TEST_ENTRYPOINT,
  "dist-test/test/extensionHost/fragmentPublication.js",
  "dist-test/test/extensionHost/identifiedTemporary.js",
  "dist-test/test/extensionHost/progress.js",
  "dist-test/test/extensionHost/rendererGridScrollMeasurement.js"
]);

function readBoundedRegularAsset(path, label, maxBytes = MAX_RUNTIME_ASSET_BYTES) {
  let descriptor;
  let failure;
  let result;
  try {
    descriptor = openSync(
      path,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0) | (constants.O_CLOEXEC ?? 0)
    );
    const opened = fstatSync(descriptor, { bigint: true });
    const namedBefore = lstatSync(path, { bigint: true });
    requireReadableAsset(opened, label, maxBytes);
    requireReadableAsset(namedBefore, label, maxBytes);
    if (!sameImmutableFile(opened, namedBefore)) {
      throw new Error(`${label} changed before its descriptor was pinned.`);
    }
    const bytes = Buffer.alloc(Number(opened.size));
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(descriptor, bytes, offset, bytes.length - offset, null);
      if (!Number.isSafeInteger(count) || count <= 0) {
        throw new Error(`${label} ended before its validated byte size.`);
      }
      offset += count;
    }
    const completed = fstatSync(descriptor, { bigint: true });
    const namedAfter = lstatSync(path, { bigint: true });
    requireReadableAsset(completed, label, maxBytes);
    requireReadableAsset(namedAfter, label, maxBytes);
    if (!sameImmutableFile(opened, completed) || !sameImmutableFile(completed, namedAfter)) {
      throw new Error(`${label} changed while it was read.`);
    }
    result = Object.freeze({ bytes, file: immutableFileReceipt(completed) });
  } catch (error) {
    failure = error?.code === "ENOENT" ? new Error(`${label} is missing.`) : error;
  }
  if (descriptor !== undefined) {
    try {
      closeSync(descriptor);
    } catch (error) {
      failure = failure
        ? new AggregateError([failure, error], `${label} failed and its read descriptor could not close.`)
        : error;
    }
  }
  if (failure) throw failure;
  return result;
}

function requireReadableAsset(metadata, label, maxBytes) {
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.nlink !== 1n ||
    metadata.size <= 0n ||
    metadata.size > BigInt(maxBytes) ||
    metadata.size > BigInt(Number.MAX_SAFE_INTEGER)
  ) {
    throw new Error(`${label} must be one bounded single-link regular file.`);
  }
}

function sameImmutableFile(actual, expected) {
  return (
    actual.dev === expected.dev &&
    actual.ino === expected.ino &&
    actual.size === expected.size &&
    actual.mtimeNs === expected.mtimeNs &&
    actual.ctimeNs === expected.ctimeNs
  );
}

function immutableFileReceipt(metadata) {
  return Object.freeze({
    dev: metadata.dev,
    ino: metadata.ino,
    size: metadata.size,
    mtimeNs: metadata.mtimeNs,
    ctimeNs: metadata.ctimeNs
  });
}

function sameFileIdentity(actual, expected) {
  return actual.dev === expected.dev && actual.ino === expected.ino;
}

function canonicalRepositoryRoot(root) {
  const requested = resolve(root);
  const canonical = realpathSync.native(requested);
  const metadata = lstatSync(canonical, { bigint: true });
  if (canonical !== requested || !metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error("The extension-test repository root must be one canonical directory.");
  }
  return canonical;
}

function captureContainedTarget(root, relativePath, label) {
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
    throw new Error(`${label} escapes the extension-test repository root.`);
  }
  const parentRelative = dirname(fromRoot);
  const components = parentRelative === "." ? [] : parentRelative.split(sep);
  const parents = [];
  let current = root;
  for (const component of ["", ...components]) {
    if (component !== "") current = resolve(current, component);
    let metadata;
    try {
      metadata = lstatSync(current, { bigint: true });
    } catch {
      throw new Error(`${label} parent is missing.`);
    }
    if (!metadata.isDirectory() || metadata.isSymbolicLink() || realpathSync.native(current) !== current) {
      throw new Error(`${label} parent must not contain symbolic links.`);
    }
    parents.push(Object.freeze({ path: current, dev: metadata.dev, ino: metadata.ino }));
  }
  return Object.freeze({ target, parents: Object.freeze(parents) });
}

function assertContainedParents(receipt, label) {
  for (const parent of receipt.parents) {
    const metadata = lstatSync(parent.path, { bigint: true });
    if (
      !metadata.isDirectory() ||
      metadata.isSymbolicLink() ||
      metadata.dev !== parent.dev ||
      metadata.ino !== parent.ino ||
      realpathSync.native(parent.path) !== parent.path
    ) {
      throw new Error(`${label} parent changed during extension-test asset staging.`);
    }
  }
}

function readContainedAsset(root, relativePath, label, maxBytes = MAX_RUNTIME_ASSET_BYTES) {
  const receipt = captureContainedTarget(root, relativePath, label);
  const snapshot = readBoundedRegularAsset(receipt.target, label, maxBytes);
  assertContainedParents(receipt, label);
  return Object.freeze({ bytes: snapshot.bytes, file: snapshot.file, receipt });
}

function inspectOutputTree(directory, state, depth) {
  if (depth > MAX_OUTPUT_TREE_DEPTH) {
    throw new Error("The extension-test output tree exceeds its directory-depth limit.");
  }
  const before = lstatSync(directory, { bigint: true });
  if (!before.isDirectory() || before.isSymbolicLink() || realpathSync.native(directory) !== directory) {
    throw new Error("The extension-test output tree must not contain symbolic links.");
  }
  const handle = opendirSync(directory);
  try {
    let entry;
    while ((entry = handle.readSync()) !== null) {
      state.entries += 1;
      if (state.entries > MAX_OUTPUT_TREE_ENTRIES) {
        throw new Error("The extension-test output tree exceeds its entry limit.");
      }
      const child = resolve(directory, entry.name);
      const metadata = lstatSync(child, { bigint: true });
      if (metadata.isSymbolicLink()) {
        throw new Error("The extension-test output tree must not contain symbolic links.");
      }
      if (metadata.isDirectory()) {
        inspectOutputTree(child, state, depth + 1);
      } else if (!metadata.isFile() || metadata.nlink !== 1n) {
        throw new Error("The extension-test output tree may contain only single-link regular files and directories.");
      }
    }
  } finally {
    handle.closeSync();
  }
  const after = lstatSync(directory, { bigint: true });
  if (
    !after.isDirectory() ||
    after.isSymbolicLink() ||
    after.dev !== before.dev ||
    after.ino !== before.ino ||
    realpathSync.native(directory) !== directory
  ) {
    throw new Error("The extension-test output tree changed while it was inspected.");
  }
}

export function assertExtensionTestOutputTreeSafe({ root = repositoryRoot } = {}) {
  const canonicalRoot = canonicalRepositoryRoot(root);
  const output = captureContainedTarget(canonicalRoot, "dist-test", "Extension-test compiler output dist-test");
  let metadata;
  try {
    metadata = lstatSync(output.target, { bigint: true });
  } catch (error) {
    if (error?.code === "ENOENT") {
      assertContainedParents(output, "Extension-test compiler output dist-test");
      return;
    }
    throw error;
  }
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || realpathSync.native(output.target) !== output.target) {
    throw new Error("The extension-test compiler output must be absent or one canonical directory.");
  }
  assertContainedParents(output, "Extension-test compiler output dist-test");
  inspectOutputTree(output.target, { entries: 0 }, 0);
  assertContainedParents(output, "Extension-test compiler output dist-test");
}

function requireWritableOutput(metadata, label) {
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1n) {
    throw new Error(`${label} must be absent or one single-link regular generated file.`);
  }
}

function writeAll(descriptor, bytes, label) {
  let offset = 0;
  while (offset < bytes.length) {
    const written = writeSync(descriptor, bytes, offset, bytes.length - offset);
    if (!Number.isSafeInteger(written) || written <= 0) {
      throw new Error(`${label} write made no progress.`);
    }
    offset += written;
  }
}

function stageRuntimeAsset(prepared) {
  const { bytes, label, output } = prepared;
  let existing;
  try {
    existing = lstatSync(output.target, { bigint: true });
    requireWritableOutput(existing, label);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  assertContainedParents(output, label);

  let descriptor;
  let opened;
  let created = false;
  let failure;
  let closeFailed = false;
  try {
    if (existing === undefined) {
      descriptor = openSync(
        output.target,
        constants.O_WRONLY |
          constants.O_CREAT |
          constants.O_EXCL |
          (constants.O_NOFOLLOW ?? 0) |
          (constants.O_CLOEXEC ?? 0),
        0o644
      );
      created = true;
      opened = fstatSync(descriptor, { bigint: true });
      requireWritableOutput(opened, label);
      const named = lstatSync(output.target, { bigint: true });
      requireWritableOutput(named, label);
      if (!sameFileIdentity(opened, named)) {
        throw new Error(`${label} path does not identify its exclusive output descriptor.`);
      }
    } else {
      descriptor = openSync(
        output.target,
        constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_CLOEXEC ?? 0)
      );
      opened = fstatSync(descriptor, { bigint: true });
      requireWritableOutput(opened, label);
      if (!sameFileIdentity(opened, existing)) {
        throw new Error(`${label} changed before its existing output descriptor was pinned.`);
      }
    }
    assertContainedParents(output, label);
    if (!created) ftruncateSync(descriptor, 0);
    writeAll(descriptor, bytes, label);
    fsyncSync(descriptor);
    const completed = fstatSync(descriptor, { bigint: true });
    const named = lstatSync(output.target, { bigint: true });
    requireWritableOutput(completed, label);
    requireWritableOutput(named, label);
    if (
      !sameFileIdentity(opened, completed) ||
      !sameFileIdentity(completed, named) ||
      completed.size !== BigInt(bytes.length)
    ) {
      throw new Error(`${label} changed while its bytes were staged.`);
    }
    assertContainedParents(output, label);
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
    if (created && opened !== undefined && !closeFailed) {
      try {
        assertContainedParents(output, label);
        const named = lstatSync(output.target, { bigint: true });
        if (named.isFile() && !named.isSymbolicLink() && named.nlink === 1n && sameFileIdentity(named, opened)) {
          unlinkSync(output.target);
        }
      } catch {
        // An uncertain or substituted path is deliberately retained untouched.
      }
    }
    throw failure;
  }
}

function sameAssetSnapshot(actual, expected) {
  return (
    actual.bytes.equals(expected.bytes) &&
    actual.file.dev === expected.file.dev &&
    actual.file.ino === expected.file.ino &&
    actual.file.size === expected.file.size &&
    actual.file.mtimeNs === expected.file.mtimeNs &&
    actual.file.ctimeNs === expected.file.ctimeNs
  );
}

export function verifyExtensionTestRuntimeAssets({ root = repositoryRoot, spawnPreflight = spawnSync } = {}) {
  const canonicalRoot = canonicalRepositoryRoot(root);
  const assetsBefore = [];
  for (const asset of EXTENSION_TEST_RUNTIME_ASSETS) {
    const source = readContainedAsset(canonicalRoot, asset.source, `Extension-test source ${asset.source}`);
    const output = readContainedAsset(canonicalRoot, asset.output, `Extension-test output ${asset.output}`);
    if (!source.bytes.equals(output.bytes)) {
      throw new Error(`Extension-test output ${asset.output} does not match ${asset.source}.`);
    }
    assetsBefore.push(Object.freeze({ asset, output, source }));
  }
  const compiledBefore = EXTENSION_TEST_COMPILED_MODULES.map((modulePath) =>
    readContainedAsset(canonicalRoot, modulePath, `Extension-test compiled module ${modulePath}`, MAX_ENTRYPOINT_BYTES)
  );
  const entrypointBefore = compiledBefore[0];
  const entrypointPath = entrypointBefore.receipt.target;
  const environment = {};
  for (const key of ["SystemRoot", "SYSTEMROOT", "WINDIR"]) {
    if (typeof process.env[key] === "string") environment[key] = process.env[key];
  }
  const result = spawnPreflight(process.execPath, ["-e", ENTRYPOINT_PREFLIGHT, entrypointPath, canonicalRoot], {
    cwd: canonicalRoot,
    encoding: "utf8",
    env: environment,
    maxBuffer: MAX_PREFLIGHT_OUTPUT_BYTES,
    stdio: ["ignore", "pipe", "pipe"],
    timeout: PREFLIGHT_TIMEOUT_MS,
    windowsHide: true
  });
  if (result.error !== undefined || result.status !== 0 || result.signal !== null) {
    const detail = `${result.stderr ?? ""}`
      .replaceAll(canonicalRoot, "<repository>")
      .trim()
      .slice(0, MAX_PREFLIGHT_OUTPUT_BYTES);
    throw new Error(
      `Extension-test entrypoint ${EXTENSION_TEST_ENTRYPOINT} could not load without an editor.${detail ? `\n${detail}` : ""}`
    );
  }
  let loadedLocalModules;
  try {
    loadedLocalModules = JSON.parse(`${result.stdout ?? ""}`);
  } catch {
    throw new Error("Extension-test entrypoint preflight returned an invalid local-module closure.");
  }
  const expectedLocalModules = [
    ...EXTENSION_TEST_COMPILED_MODULES,
    ...EXTENSION_TEST_RUNTIME_ASSETS.map(({ output }) => output)
  ]
    .map((path) => resolve(canonicalRoot, path))
    .sort();
  if (
    !Array.isArray(loadedLocalModules) ||
    loadedLocalModules.length !== expectedLocalModules.length ||
    loadedLocalModules.some((path, index) => typeof path !== "string" || path !== expectedLocalModules[index])
  ) {
    throw new Error("Extension-test entrypoint loaded an incomplete or unknown local-module closure.");
  }
  const compiledAfter = EXTENSION_TEST_COMPILED_MODULES.map((modulePath) =>
    readContainedAsset(canonicalRoot, modulePath, `Extension-test compiled module ${modulePath}`, MAX_ENTRYPOINT_BYTES)
  );
  for (let index = 0; index < EXTENSION_TEST_COMPILED_MODULES.length; index += 1) {
    if (!sameAssetSnapshot(compiledBefore[index], compiledAfter[index])) {
      throw new Error(
        `Extension-test compiled module ${EXTENSION_TEST_COMPILED_MODULES[index]} changed during its load preflight.`
      );
    }
  }
  for (const before of assetsBefore) {
    const sourceAfter = readContainedAsset(
      canonicalRoot,
      before.asset.source,
      `Extension-test source ${before.asset.source}`
    );
    const outputAfter = readContainedAsset(
      canonicalRoot,
      before.asset.output,
      `Extension-test output ${before.asset.output}`
    );
    if (
      !sameAssetSnapshot(sourceAfter, before.source) ||
      !sameAssetSnapshot(outputAfter, before.output) ||
      !sourceAfter.bytes.equals(outputAfter.bytes)
    ) {
      throw new Error(
        `Extension-test runtime asset ${before.asset.output} changed during the entrypoint load preflight.`
      );
    }
  }
  return Object.freeze({
    compiledModules: Object.freeze(
      EXTENSION_TEST_COMPILED_MODULES.map((path, index) => Object.freeze({ file: compiledAfter[index].file, path }))
    ),
    runtimeAssets: Object.freeze(
      assetsBefore.map(({ asset, output, source }) =>
        Object.freeze({ output: output.file, path: asset.output, source: source.file })
      )
    )
  });
}

export function copyExtensionTestRuntimeAssets({ root = repositoryRoot } = {}) {
  const canonicalRoot = canonicalRepositoryRoot(root);
  assertExtensionTestOutputTreeSafe({ root: canonicalRoot });
  const prepared = EXTENSION_TEST_RUNTIME_ASSETS.map((asset) => {
    const label = `Extension-test output ${asset.output}`;
    const source = readContainedAsset(canonicalRoot, asset.source, `Extension-test source ${asset.source}`);
    const output = captureContainedTarget(canonicalRoot, asset.output, label);
    let existing;
    try {
      existing = lstatSync(output.target, { bigint: true });
      requireWritableOutput(existing, label);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    assertContainedParents(output, label);
    return Object.freeze({ bytes: source.bytes, label, output });
  });
  for (const asset of prepared) {
    stageRuntimeAsset(asset);
  }
  verifyExtensionTestRuntimeAssets({ root: canonicalRoot });
}

if (process.argv[1] !== undefined && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  if (process.argv.length === 2) {
    copyExtensionTestRuntimeAssets();
  } else if (process.argv.length === 3 && process.argv[2] === "--guard-output-tree") {
    assertExtensionTestOutputTreeSafe();
  } else {
    throw new Error("copy-extension-test-runtime-assets accepts only --guard-output-tree.");
  }
}
