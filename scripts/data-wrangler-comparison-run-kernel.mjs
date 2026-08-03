import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readSync,
  realpathSync,
  rmdirSync,
  unlinkSync,
  writeSync
} from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { createDataWranglerComparisonCleanupUnsettledError } from "./data-wrangler-comparison-cleanup-safety.mjs";

const SHA256 = /^[0-9a-f]{64}$/u;
const KERNEL_NAME = /^dataframe-comparison-study-[a-z0-9][a-z0-9._-]{0,95}$/u;
const MAX_KERNELSPEC_BYTES = 64 * 1024;

function fail(message) {
  throw new TypeError(message);
}

function ownerMatches(metadata) {
  return typeof process.getuid !== "function" || metadata.uid === BigInt(process.getuid());
}

function sameStableIdentity(left, right) {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.uid === right.uid &&
    left.gid === right.gid
  );
}

function sameFileSnapshot(left, right) {
  return (
    sameStableIdentity(left, right) &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs &&
    left.nlink === right.nlink
  );
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

function assertPrivateDirectoryMetadata(metadata, label) {
  if (
    !metadata.isDirectory() ||
    metadata.isSymbolicLink() ||
    !ownerMatches(metadata) ||
    Number(metadata.mode & 0o777n) !== 0o700
  ) {
    fail(`${label} must be an owned mode-700 directory without symbolic links.`);
  }
}

function assertOwnedDirectoryDescriptor(metadata, label) {
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || !ownerMatches(metadata)) {
    fail(`${label} must be an owned directory.`);
  }
}

function assertOwnedKernelFile(metadata, label, { allowEmpty = false } = {}) {
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    !ownerMatches(metadata) ||
    metadata.nlink !== 1n ||
    metadata.size < (allowEmpty ? 0n : 1n) ||
    metadata.size > BigInt(MAX_KERNELSPEC_BYTES) ||
    Number(metadata.mode & 0o777n) !== 0o600
  ) {
    fail(`${label} must be one owned, singly linked mode-600 regular file within the kernelspec byte bound.`);
  }
}

function assertContained(root, path, label) {
  const contained = relative(root, path);
  if (contained.length === 0 || contained === ".." || contained.startsWith(`..${sep}`) || isAbsolute(contained)) {
    fail(`${label} must stay inside its private run root.`);
  }
}

function anchoredChild(parent, name) {
  if (
    parent?.descriptor === undefined ||
    typeof name !== "string" ||
    name.length === 0 ||
    name === "." ||
    name === ".." ||
    /[\0\r\n/\\]/u.test(name)
  ) {
    fail("Run-local Jupyter anchored path input is invalid.");
  }
  return `/proc/self/fd/${parent.descriptor}/${name}`;
}

function openDirectoryDescriptor(path) {
  return openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | (constants.O_NOFOLLOW ?? 0));
}

function openPrivateRoot(path) {
  canonicalAbsolutePath(path, "Run-local Jupyter root owner");
  const named = lstatSync(path, { bigint: true });
  assertPrivateDirectoryMetadata(named, "Run-local Jupyter root owner");
  if (realpathSync(path) !== path) {
    fail("Run-local Jupyter root owner must not traverse a symbolic link.");
  }
  const descriptor = openDirectoryDescriptor(path);
  try {
    const opened = fstatSync(descriptor, { bigint: true });
    assertPrivateDirectoryMetadata(opened, "Run-local Jupyter root owner");
    if (!sameStableIdentity(named, opened)) {
      fail("Run-local Jupyter root owner changed while it opened.");
    }
    return { path, name: null, parent: null, descriptor, identity: opened, created: false };
  } catch (error) {
    closeSync(descriptor);
    throw error;
  }
}

function revalidateDirectoryNode(node, label) {
  const opened = fstatSync(node.descriptor, { bigint: true });
  const named = lstatSync(node.path, { bigint: true });
  assertPrivateDirectoryMetadata(opened, label);
  assertPrivateDirectoryMetadata(named, label);
  if (
    !sameStableIdentity(node.identity, opened) ||
    !sameStableIdentity(opened, named) ||
    realpathSync(node.path) !== node.path
  ) {
    fail(`${label} changed identity or containment.`);
  }
  if (node.parent !== null) {
    const anchored = lstatSync(anchoredChild(node.parent, node.name), { bigint: true });
    assertPrivateDirectoryMetadata(anchored, label);
    if (!sameStableIdentity(opened, anchored)) fail(`${label} no longer belongs to its pinned named parent.`);
  }
  return opened;
}

function createPrivateDirectory(parent, name, runRoot, directories) {
  revalidateDirectoryNode(parent, "Run-local Jupyter named parent");
  const path = resolve(parent.path, name);
  assertContained(runRoot.path, path, `Run-local Jupyter ${name}`);
  const anchored = anchoredChild(parent, name);
  mkdirSync(anchored, { recursive: false, mode: 0o700 });
  let descriptor;
  let secured;
  try {
    descriptor = openDirectoryDescriptor(anchored);
    const opened = fstatSync(descriptor, { bigint: true });
    assertOwnedDirectoryDescriptor(opened, `Run-local Jupyter ${name}`);
    fchmodSync(descriptor, 0o700);
    secured = fstatSync(descriptor, { bigint: true });
    const named = lstatSync(anchored, { bigint: true });
    assertPrivateDirectoryMetadata(secured, `Run-local Jupyter ${name}`);
    assertPrivateDirectoryMetadata(named, `Run-local Jupyter ${name}`);
    if (!sameStableIdentity(secured, named)) fail(`Run-local Jupyter ${name} changed while it opened.`);
  } catch (error) {
    if (descriptor !== undefined) closeSync(descriptor);
    throw error;
  }
  const node = { path, name, parent, descriptor, identity: secured, created: true };
  directories.push(node);
  revalidateDirectoryNode(parent, "Run-local Jupyter named parent");
  revalidateDirectoryNode(node, `Run-local Jupyter ${name}`);
  return node;
}

function readDescriptorPositionally(descriptor, size, label) {
  const bytes = Buffer.alloc(size);
  let offset = 0;
  while (offset < bytes.length) {
    const count = readSync(descriptor, bytes, offset, bytes.length - offset, offset);
    if (count === 0) fail(`${label} ended before its declared size.`);
    offset += count;
  }
  return bytes;
}

function writeDescriptorExactly(descriptor, bytes, label) {
  let offset = 0;
  while (offset < bytes.length) {
    const count = writeSync(descriptor, bytes, offset, bytes.length - offset, null);
    if (count === 0) fail(`${label} stopped before all bytes were written.`);
    offset += count;
  }
}

function digest(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function validateKernelValue(bytes, kernel) {
  let value;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch {
    fail("The canonical comparison kernelspec is not valid JSON.");
  }
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    !Array.isArray(value.argv) ||
    !value.argv.includes("ipykernel_launcher") ||
    value.display_name !== kernel.displayName ||
    value.language !== "python"
  ) {
    fail("The canonical comparison kernelspec no longer matches its validated kernel identity.");
  }
}

function validateCanonicalKernelInput(kernel) {
  if (
    kernel === null ||
    typeof kernel !== "object" ||
    Array.isArray(kernel) ||
    !KERNEL_NAME.test(kernel.name ?? "") ||
    typeof kernel.displayName !== "string" ||
    kernel.displayName.length < 1 ||
    kernel.displayName.length > 128 ||
    /[\0\r\n/\\]/u.test(kernel.displayName) ||
    !SHA256.test(kernel.sha256 ?? "")
  ) {
    fail("Run-local Jupyter setup requires one validated canonical comparison kernel.");
  }
  const path = canonicalAbsolutePath(kernel.path, "Canonical comparison kernelspec");
  if (basename(path) !== "kernel.json" || basename(dirname(path)) !== kernel.name) {
    fail("The canonical comparison kernelspec path does not match its kernel name.");
  }
  return path;
}

function revalidateCanonicalParent(source) {
  const opened = fstatSync(source.parentDescriptor, { bigint: true });
  const named = lstatSync(source.parent, { bigint: true });
  assertPrivateDirectoryMetadata(opened, "Canonical comparison kernelspec parent");
  assertPrivateDirectoryMetadata(named, "Canonical comparison kernelspec parent");
  if (
    !sameStableIdentity(source.parentIdentity, opened) ||
    !sameStableIdentity(opened, named) ||
    realpathSync(source.parent) !== source.parent
  ) {
    fail("The canonical comparison kernelspec parent changed identity or containment.");
  }
}

function readAndRevalidateCanonicalKernel(source, kernel, expectedBytes) {
  revalidateCanonicalParent(source);
  const before = fstatSync(source.descriptor, { bigint: true });
  const namedBefore = lstatSync(source.anchoredPath, { bigint: true });
  assertOwnedKernelFile(before, "Canonical comparison kernelspec");
  assertOwnedKernelFile(namedBefore, "Canonical comparison kernelspec");
  if (!sameFileSnapshot(source.identity, before) || !sameFileSnapshot(before, namedBefore)) {
    fail("The canonical comparison kernelspec changed before its positional read.");
  }
  const bytes = readDescriptorPositionally(source.descriptor, Number(before.size), "Canonical comparison kernelspec");
  const after = fstatSync(source.descriptor, { bigint: true });
  const namedAfter = lstatSync(source.anchoredPath, { bigint: true });
  revalidateCanonicalParent(source);
  assertOwnedKernelFile(after, "Canonical comparison kernelspec");
  assertOwnedKernelFile(namedAfter, "Canonical comparison kernelspec");
  if (!sameFileSnapshot(before, after) || !sameFileSnapshot(after, namedAfter)) {
    fail("The canonical comparison kernelspec changed during its positional read.");
  }
  if (digest(bytes) !== kernel.sha256 || (expectedBytes !== undefined && !bytes.equals(expectedBytes))) {
    fail("The canonical comparison kernelspec bytes changed during run-local materialization.");
  }
  return bytes;
}

function openCanonicalKernel(kernel) {
  const path = validateCanonicalKernelInput(kernel);
  const parent = dirname(path);
  let parentDescriptor;
  let descriptor;
  try {
    parentDescriptor = openDirectoryDescriptor(parent);
    const parentOpened = fstatSync(parentDescriptor, { bigint: true });
    const parentNamed = lstatSync(parent, { bigint: true });
    assertPrivateDirectoryMetadata(parentOpened, "Canonical comparison kernelspec parent");
    assertPrivateDirectoryMetadata(parentNamed, "Canonical comparison kernelspec parent");
    if (!sameStableIdentity(parentNamed, parentOpened) || realpathSync(parent) !== parent) {
      fail("The canonical comparison kernelspec parent changed while it opened.");
    }
    const anchoredPath = `/proc/self/fd/${parentDescriptor}/kernel.json`;
    try {
      descriptor = openSync(
        anchoredPath,
        constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0)
      );
    } catch (error) {
      if (error?.code === "ELOOP") {
        fail("The canonical comparison kernelspec must be one owned, singly linked mode-600 regular file.");
      }
      throw error;
    }
    const opened = fstatSync(descriptor, { bigint: true });
    const named = lstatSync(anchoredPath, { bigint: true });
    assertOwnedKernelFile(opened, "Canonical comparison kernelspec");
    assertOwnedKernelFile(named, "Canonical comparison kernelspec");
    if (!sameFileSnapshot(named, opened)) fail("The canonical comparison kernelspec changed while it opened.");
    const source = {
      path,
      parent,
      parentDescriptor,
      parentIdentity: parentOpened,
      anchoredPath,
      descriptor,
      identity: opened
    };
    const bytes = readAndRevalidateCanonicalKernel(source, kernel);
    validateKernelValue(bytes, kernel);
    return { ...source, bytes };
  } catch (error) {
    if (descriptor !== undefined) closeSync(descriptor);
    if (parentDescriptor !== undefined) closeSync(parentDescriptor);
    throw error;
  }
}

function revalidateFileNode(node, label, { allowEmpty = false } = {}) {
  revalidateDirectoryNode(node.parent, `${label} named parent`);
  const anchored = lstatSync(anchoredChild(node.parent, node.name), { bigint: true });
  const named = lstatSync(node.path, { bigint: true });
  assertOwnedKernelFile(anchored, label, { allowEmpty });
  assertOwnedKernelFile(named, label, { allowEmpty });
  if (!sameFileSnapshot(node.identity, anchored) || !sameFileSnapshot(anchored, named)) {
    fail(`${label} changed identity or no longer belongs to its pinned parent.`);
  }
  revalidateDirectoryNode(node.parent, `${label} named parent`);
  return anchored;
}

function publishKernelFile(kernelDirectory, bytes, expectedSha256, files, hooks) {
  revalidateDirectoryNode(kernelDirectory, "Run-local kernelspec parent");
  hooks.beforePublish?.({
    jupyterRoot: kernelDirectory.parent.parent.parent.path,
    kernelDirectory: kernelDirectory.path,
    publishedPath: resolve(kernelDirectory.path, "kernel.json")
  });
  revalidateDirectoryNode(kernelDirectory, "Run-local kernelspec parent");
  const name = "kernel.json";
  const path = resolve(kernelDirectory.path, name);
  const anchored = anchoredChild(kernelDirectory, name);
  let descriptor;
  let node;
  try {
    descriptor = openSync(
      anchored,
      constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
      0o600
    );
    const created = fstatSync(descriptor, { bigint: true });
    assertOwnedKernelFile(created, "Run-local published kernelspec", { allowEmpty: true });
    node = { path, name, parent: kernelDirectory, identity: created, created: true };
    files.push(node);
    writeDescriptorExactly(descriptor, bytes, "Run-local published kernelspec");
    fsyncSync(descriptor);
    const afterWrite = fstatSync(descriptor, { bigint: true });
    const namedAfterWrite = lstatSync(anchored, { bigint: true });
    assertOwnedKernelFile(afterWrite, "Run-local published kernelspec");
    assertOwnedKernelFile(namedAfterWrite, "Run-local published kernelspec");
    if (!sameStableIdentity(node.identity, afterWrite) || !sameFileSnapshot(afterWrite, namedAfterWrite)) {
      fail("The run-local kernelspec changed identity while it was written.");
    }
    node.identity = afterWrite;
    const published = revalidateFileNode(node, "Run-local published kernelspec");
    const retained = fstatSync(descriptor, { bigint: true });
    assertOwnedKernelFile(retained, "Run-local published kernelspec");
    if (!sameFileSnapshot(published, retained)) fail("The run-local kernelspec changed on its retained descriptor.");
    const publishedBytes = readDescriptorPositionally(
      descriptor,
      Number(retained.size),
      "Run-local published kernelspec"
    );
    const after = fstatSync(descriptor, { bigint: true });
    if (
      !sameFileSnapshot(retained, after) ||
      !publishedBytes.equals(bytes) ||
      digest(publishedBytes) !== expectedSha256
    ) {
      fail("The run-local kernelspec bytes do not match the canonical kernelspec.");
    }
    revalidateFileNode(node, "Run-local published kernelspec");
    revalidateDirectoryNode(kernelDirectory, "Run-local kernelspec parent");
    hooks.afterPublish?.({
      jupyterRoot: kernelDirectory.parent.parent.parent.path,
      kernelDirectory: kernelDirectory.path,
      publishedPath: path
    });
    return path;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function assertExactCreatedTree(directories, files) {
  for (const directory of directories) revalidateDirectoryNode(directory, "Run-local cleanup directory");
  for (const file of files) revalidateFileNode(file, "Run-local cleanup file", { allowEmpty: true });
  for (const directory of directories) {
    const expectedNames = [
      ...directories.filter((candidate) => candidate.parent === directory).map((candidate) => candidate.name),
      ...files.filter((candidate) => candidate.parent === directory).map((candidate) => candidate.name)
    ].sort();
    const actualNames = readdirSync(`/proc/self/fd/${directory.descriptor}`).sort();
    if (
      actualNames.length !== expectedNames.length ||
      actualNames.some((name, index) => name !== expectedNames[index])
    ) {
      fail("Run-local Jupyter cleanup found an unknown, missing, or replaced descendant and retained the tree.");
    }
  }
}

function assertAnchoredEntryMissing(parent, name, label) {
  try {
    lstatSync(anchoredChild(parent, name), { bigint: true });
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  fail(`${label} still exists after exact cleanup.`);
}

function cleanupCreatedTree(runRoot, directories, files) {
  if (directories.length === 0 && files.length === 0) return;
  revalidateDirectoryNode(runRoot, "Run-local cleanup root owner");
  assertExactCreatedTree(directories, files);
  for (const file of [...files].reverse()) {
    revalidateFileNode(file, "Run-local cleanup file", { allowEmpty: true });
    unlinkSync(anchoredChild(file.parent, file.name));
    assertAnchoredEntryMissing(file.parent, file.name, "Run-local cleanup file");
    revalidateDirectoryNode(file.parent, "Run-local cleanup file parent");
  }
  for (const directory of [...directories].reverse()) {
    revalidateDirectoryNode(directory, "Run-local cleanup directory");
    if (readdirSync(`/proc/self/fd/${directory.descriptor}`).length !== 0) {
      fail("Run-local Jupyter cleanup retained a directory with an unknown descendant.");
    }
    revalidateDirectoryNode(directory.parent, "Run-local cleanup directory parent");
    rmdirSync(anchoredChild(directory.parent, directory.name));
    assertAnchoredEntryMissing(directory.parent, directory.name, "Run-local cleanup directory");
    revalidateDirectoryNode(directory.parent, "Run-local cleanup directory parent");
  }
  revalidateDirectoryNode(runRoot, "Run-local cleanup root owner");
}

function closeDescriptors(descriptors) {
  const errors = [];
  const closed = new Set();
  for (const descriptor of descriptors) {
    if (descriptor === undefined || closed.has(descriptor)) continue;
    closed.add(descriptor);
    try {
      closeSync(descriptor);
    } catch (error) {
      errors.push(error);
    }
  }
  return errors;
}

export function materializeDataWranglerComparisonRunKernel({ runRoot, kernel }, { beforePublish, afterPublish } = {}) {
  for (const [hook, label] of [
    [beforePublish, "publication"],
    [afterPublish, "post-publication"]
  ]) {
    if (hook !== undefined && typeof hook !== "function") fail(`Run-local Jupyter ${label} hook must be callable.`);
  }
  const source = openCanonicalKernel(kernel);
  let root;
  try {
    root = openPrivateRoot(runRoot);
  } catch (error) {
    const closeErrors = closeDescriptors([source.descriptor, source.parentDescriptor]);
    if (closeErrors.length === 0) throw error;
    throw new AggregateError(
      [error, ...closeErrors],
      "Run-local Jupyter root validation or canonical kernelspec cleanup failed."
    );
  }
  const directories = [];
  const files = [];
  let result;
  let operationError;
  try {
    const jupyterRoot = createPrivateDirectory(root, "jupyter", root, directories);
    const dataDir = createPrivateDirectory(jupyterRoot, "data", root, directories);
    const runtimeDir = createPrivateDirectory(jupyterRoot, "runtime", root, directories);
    const configDir = createPrivateDirectory(jupyterRoot, "config", root, directories);
    const path = createPrivateDirectory(jupyterRoot, "path", root, directories);
    const kernelsDirectory = createPrivateDirectory(dataDir, "kernels", root, directories);
    const kernelDirectory = createPrivateDirectory(kernelsDirectory, kernel.name, root, directories);
    const kernelspecPath = publishKernelFile(kernelDirectory, source.bytes, kernel.sha256, files, {
      beforePublish,
      afterPublish
    });
    readAndRevalidateCanonicalKernel(source, kernel, source.bytes);
    revalidateDirectoryNode(root, "Run-local Jupyter root owner");
    for (const directory of directories) {
      revalidateDirectoryNode(directory, "Run-local Jupyter directory");
    }
    revalidateFileNode(files[0], "Run-local published kernelspec");
    assertExactCreatedTree(directories, files);
    result = Object.freeze({
      kernelspecPath,
      sha256: kernel.sha256,
      jupyterEnvironment: Object.freeze({
        dataDir: dataDir.path,
        runtimeDir: runtimeDir.path,
        configDir: configDir.path,
        path: path.path
      })
    });
  } catch (error) {
    operationError = error;
  }

  const sourceCloseErrors = closeDescriptors([source.descriptor, source.parentDescriptor]);
  let cleanupError;
  if (operationError !== undefined || sourceCloseErrors.length > 0) {
    try {
      cleanupCreatedTree(root, directories, files);
    } catch (error) {
      cleanupError = error;
    }
  }
  const directoryCloseErrors = closeDescriptors([
    ...directories
      .slice()
      .reverse()
      .map((directory) => directory.descriptor),
    root.descriptor
  ]);
  const failures = [operationError, ...sourceCloseErrors, cleanupError, ...directoryCloseErrors].filter(
    (error) => error !== undefined
  );
  if (cleanupError !== undefined) {
    throw createDataWranglerComparisonCleanupUnsettledError(
      failures,
      "Run-local Jupyter materialization or exact cleanup failed; its created tree could not be retired safely."
    );
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) {
    throw new AggregateError(failures, "Run-local Jupyter materialization or exact cleanup failed.");
  }
  return result;
}
