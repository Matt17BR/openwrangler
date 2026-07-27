import {
  chmodSync,
  constants,
  copyFileSync,
  cpSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readlinkSync,
  realpathSync
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { assertRemoteWorkspaceFileReceipt, captureRemoteWorkspaceFileReceipt } from "./remote-workspace-provenance.mjs";

const MAXIMUM_TREE_BYTES = 4 * 1024 * 1024 * 1024;
const MAXIMUM_TREE_FILES = 100_000;
const RECEIPT_PERMISSIONS = 0o777n;

export function stageRemoteWorkspaceExactFile(source, destination, mode = 0o600) {
  const sourcePath = canonicalRegularPath(source, "source");
  const stagedPath = boundedAbsolutePath(destination, "staged");
  if (!Number.isInteger(mode) || mode < 0 || mode > 0o777) {
    throw new Error("Remote SSH exact-file staging requires one bounded permissions mode.");
  }
  const sourceReceipt = captureRemoteWorkspaceFileReceipt(sourcePath);
  copyFileSync(sourcePath, stagedPath, constants.COPYFILE_EXCL);
  chmodSync(stagedPath, mode);
  assertRemoteWorkspaceFileReceipt(sourcePath, sourceReceipt);
  const stagedReceipt = captureRemoteWorkspaceFileReceipt(stagedPath);
  if (
    sourceReceipt.size !== stagedReceipt.size ||
    sourceReceipt.sha256 !== stagedReceipt.sha256 ||
    permissions(stagedReceipt) !== mode
  ) {
    throw new Error("A Remote SSH exact-file stage did not preserve its pinned source bytes and mode.");
  }
  return Object.freeze({ sourcePath, sourceReceipt, stagedPath, stagedReceipt, mode });
}

export function assertRemoteWorkspaceExactFileStage(stage) {
  if (
    !stage ||
    typeof stage !== "object" ||
    typeof stage.sourcePath !== "string" ||
    typeof stage.stagedPath !== "string" ||
    !Number.isInteger(stage.mode)
  ) {
    throw new Error("The Remote SSH exact-file stage receipt is malformed.");
  }
  const sourceReceipt = assertRemoteWorkspaceFileReceipt(stage.sourcePath, stage.sourceReceipt);
  const stagedReceipt = assertRemoteWorkspaceFileReceipt(stage.stagedPath, stage.stagedReceipt);
  if (
    sourceReceipt.size !== stagedReceipt.size ||
    sourceReceipt.sha256 !== stagedReceipt.sha256 ||
    permissions(stagedReceipt) !== stage.mode
  ) {
    throw new Error("A Remote SSH exact-file stage changed after its provenance was pinned.");
  }
  return stage;
}

export function stageRemoteWorkspaceTree(source, destination, rawBounds) {
  const sourceRoot = canonicalDirectoryPath(source, "source tree");
  const stagedRoot = boundedAbsolutePath(destination, "staged tree");
  const bounds = normalizeTreeBounds(rawBounds);
  if (isSameOrContained(sourceRoot, stagedRoot) || isSameOrContained(stagedRoot, sourceRoot)) {
    throw new Error("Remote SSH tree staging requires independent source and destination roots.");
  }
  const sourceManifest = captureRemoteWorkspaceTreeManifest(sourceRoot, bounds);
  mkdirSync(dirname(stagedRoot), { recursive: true, mode: 0o700 });
  cpSync(sourceRoot, stagedRoot, {
    recursive: true,
    errorOnExist: true,
    force: false,
    preserveTimestamps: true,
    verbatimSymlinks: true
  });
  const sourceAfter = captureRemoteWorkspaceTreeManifest(sourceRoot, bounds);
  const stagedManifest = captureRemoteWorkspaceTreeManifest(stagedRoot, bounds);
  if (
    !isDeepStrictEqual(sourceAfter, sourceManifest) ||
    !isDeepStrictEqual(treeContents(sourceManifest), treeContents(stagedManifest))
  ) {
    throw new Error(`The bounded ${bounds.label} changed while it was staged.`);
  }
  return Object.freeze({ sourceRoot, sourceManifest, stagedRoot, stagedManifest, bounds });
}

export function assertRemoteWorkspaceTreeStage(stage) {
  if (
    !stage ||
    typeof stage !== "object" ||
    typeof stage.sourceRoot !== "string" ||
    typeof stage.stagedRoot !== "string"
  ) {
    throw new Error("The Remote SSH tree-stage receipt is malformed.");
  }
  const bounds = normalizeTreeBounds(stage.bounds);
  const sourceManifest = captureRemoteWorkspaceTreeManifest(stage.sourceRoot, bounds);
  const stagedManifest = captureRemoteWorkspaceTreeManifest(stage.stagedRoot, bounds);
  if (
    !isDeepStrictEqual(sourceManifest, stage.sourceManifest) ||
    !isDeepStrictEqual(stagedManifest, stage.stagedManifest) ||
    !isDeepStrictEqual(treeContents(sourceManifest), treeContents(stagedManifest))
  ) {
    throw new Error(`The bounded ${bounds.label} changed after its provenance was pinned.`);
  }
  return stage;
}

export function captureRemoteWorkspaceTreeManifest(root, rawBounds) {
  const canonicalRoot = canonicalDirectoryPath(root, "tree");
  const bounds = normalizeTreeBounds(rawBounds);
  const files = [];
  const links = [];
  const directories = [];
  const queue = [canonicalRoot];
  let bytes = 0;
  let entries = 0;
  while (queue.length > 0) {
    const directory = queue.shift();
    const before = directoryReceipt(directory);
    const children = readdirSync(directory, { withFileTypes: true }).sort((left, right) =>
      left.name < right.name ? -1 : left.name > right.name ? 1 : 0
    );
    for (const entry of children) {
      entries += 1;
      if (entries > bounds.maximumFiles) {
        throw new Error(`${bounds.label} exceeded its fixed entry bound.`);
      }
      const path = join(directory, entry.name);
      const metadata = lstatSync(path, { bigint: true });
      if (metadata.isSymbolicLink()) {
        const target = readlinkSync(path);
        const targetReceipt = validateTreeSymlink(canonicalRoot, path, target, metadata, bounds);
        links.push(Object.freeze({ path: relative(canonicalRoot, path), ...targetReceipt }));
      }
      if (metadata.isDirectory()) {
        queue.push(path);
      } else if (metadata.isFile()) {
        const receipt = captureRemoteWorkspaceFileReceipt(path, {
          allowEmpty: true,
          maximumBytes: bounds.maximumFileBytes
        });
        if (receipt.size > BigInt(bounds.maximumFileBytes)) {
          throw new Error(`${bounds.label} contains an oversized file.`);
        }
        bytes += Number(receipt.size);
        if (bytes > bounds.maximumBytes) {
          throw new Error(`${bounds.label} exceeded its fixed byte bound.`);
        }
        files.push(Object.freeze({ path: relative(canonicalRoot, path), receipt }));
      } else if (!metadata.isSymbolicLink()) {
        throw new Error(`${bounds.label} contains an unsafe file.`);
      }
    }
    const after = directoryReceipt(directory);
    if (!isDeepStrictEqual(before, after)) {
      throw new Error(`${bounds.label} changed while its directory entries were captured.`);
    }
    directories.push(Object.freeze({ path: relative(canonicalRoot, directory) || ".", receipt: after }));
  }
  files.sort(compareManifestPath);
  links.sort(compareManifestPath);
  directories.sort(compareManifestPath);
  return Object.freeze({
    bytes,
    files: Object.freeze(files),
    links: Object.freeze(links),
    directories: Object.freeze(directories)
  });
}

function normalizeTreeBounds(value) {
  if (
    !value ||
    typeof value !== "object" ||
    typeof value.label !== "string" ||
    value.label.length <= 0 ||
    value.label.length > 128 ||
    !Number.isSafeInteger(value.maximumFiles) ||
    !Number.isSafeInteger(value.maximumBytes) ||
    !Number.isSafeInteger(value.maximumFileBytes) ||
    value.maximumFiles <= 0 ||
    value.maximumFiles > MAXIMUM_TREE_FILES ||
    value.maximumBytes <= 0 ||
    value.maximumBytes > MAXIMUM_TREE_BYTES ||
    value.maximumFileBytes <= 0 ||
    value.maximumFileBytes > value.maximumBytes ||
    (value.allowInternalSymlinks !== undefined && typeof value.allowInternalSymlinks !== "boolean") ||
    (value.allowedAbsoluteSymlinkRoots !== undefined &&
      (!Array.isArray(value.allowedAbsoluteSymlinkRoots) ||
        value.allowedAbsoluteSymlinkRoots.length > 8 ||
        value.allowedAbsoluteSymlinkRoots.some(
          (path, index, paths) =>
            typeof path !== "string" ||
            !isAbsolute(path) ||
            resolve(path) !== path ||
            realpathSync(path) !== path ||
            paths.indexOf(path) !== index
        )))
  ) {
    throw new Error("Remote SSH tree staging requires fixed bounded manifest limits.");
  }
  return Object.freeze({
    label: value.label,
    maximumFiles: value.maximumFiles,
    maximumBytes: value.maximumBytes,
    maximumFileBytes: value.maximumFileBytes,
    allowInternalSymlinks: value.allowInternalSymlinks === true,
    allowedAbsoluteSymlinkRoots: Object.freeze([...(value.allowedAbsoluteSymlinkRoots ?? [])])
  });
}

function treeContents(manifest) {
  return Object.freeze({
    bytes: manifest.bytes,
    directories: Object.freeze(manifest.directories.map((entry) => Object.freeze({ path: entry.path }))),
    links: Object.freeze(
      manifest.links.map((entry) =>
        Object.freeze({
          path: entry.path,
          target: entry.target,
          resolvedTarget: entry.resolvedTarget
        })
      )
    ),
    files: Object.freeze(
      manifest.files.map((entry) =>
        Object.freeze({
          path: entry.path,
          size: entry.receipt.size,
          sha256: entry.receipt.sha256,
          permissions: permissions(entry.receipt)
        })
      )
    )
  });
}

function validateTreeSymlink(root, path, target, metadata, bounds) {
  if (
    typeof target !== "string" ||
    target.length <= 0 ||
    target.length > 16_384 ||
    /[\0\r\n]/u.test(target) ||
    metadata.nlink !== 1n
  ) {
    throw new Error(`${bounds.label} contains an unsafe symbolic link.`);
  }
  const lexicalTarget = resolve(dirname(path), target);
  const internal = isSameOrContained(root, lexicalTarget);
  if (!internal && !isAbsolute(target)) {
    throw new Error(`${bounds.label} contains an escaping relative symbolic link.`);
  }
  if (internal && !bounds.allowInternalSymlinks) {
    throw new Error(`${bounds.label} contains a symbolic link.`);
  }
  const resolvedTarget = realpathSync(path);
  if (!isSameOrContained(root, resolvedTarget)) {
    const externalRoot = bounds.allowedAbsoluteSymlinkRoots.find((candidate) =>
      isSameOrContained(candidate, resolvedTarget)
    );
    const targetMetadata = lstatSync(resolvedTarget, { bigint: true });
    if (
      !externalRoot ||
      targetMetadata.isSymbolicLink() ||
      (!targetMetadata.isFile() && !targetMetadata.isDirectory()) ||
      targetMetadata.uid !== 0n ||
      Number(targetMetadata.mode & 0o022n) !== 0
    ) {
      throw new Error(`${bounds.label} contains an untrusted absolute symbolic link.`);
    }
  }
  return Object.freeze({
    target,
    resolvedTarget:
      internal && isSameOrContained(root, resolvedTarget) ? relative(root, resolvedTarget) : resolvedTarget,
    receipt: Object.freeze({
      dev: metadata.dev,
      ino: metadata.ino,
      mode: metadata.mode,
      nlink: metadata.nlink,
      uid: metadata.uid,
      gid: metadata.gid,
      size: metadata.size,
      mtimeNs: metadata.mtimeNs,
      ctimeNs: metadata.ctimeNs,
      birthtimeNs: metadata.birthtimeNs
    })
  });
}

function directoryReceipt(path) {
  const metadata = lstatSync(path, { bigint: true });
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error("Remote SSH tree staging requires one regular directory tree.");
  }
  const canonical = realpathSync(path);
  if (canonical !== path) {
    throw new Error("Remote SSH tree staging requires canonical directory paths.");
  }
  return Object.freeze({
    dev: metadata.dev,
    ino: metadata.ino,
    mode: metadata.mode,
    nlink: metadata.nlink,
    uid: metadata.uid,
    gid: metadata.gid,
    size: metadata.size,
    mtimeNs: metadata.mtimeNs,
    ctimeNs: metadata.ctimeNs,
    birthtimeNs: metadata.birthtimeNs
  });
}

function canonicalRegularPath(path, label) {
  const bounded = boundedAbsolutePath(path, label);
  const canonical = realpathSync(bounded);
  const metadata = lstatSync(bounded);
  if (canonical !== bounded || !metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error(`Remote SSH exact-file staging requires one canonical regular ${label}.`);
  }
  return canonical;
}

function canonicalDirectoryPath(path, label) {
  const bounded = boundedAbsolutePath(path, label);
  const canonical = realpathSync(bounded);
  const metadata = lstatSync(bounded);
  if (canonical !== bounded || !metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error(`Remote SSH tree staging requires one canonical regular ${label}.`);
  }
  return canonical;
}

function boundedAbsolutePath(path, label) {
  if (typeof path !== "string" || !isAbsolute(path) || path.length <= 0 || path.length > 16_384) {
    throw new Error(`Remote SSH staging requires one bounded absolute ${label} path.`);
  }
  return resolve(path);
}

function isSameOrContained(parent, candidate) {
  const relation = relative(parent, candidate);
  return relation.length === 0 || (relation !== ".." && !relation.startsWith(`..${sep}`) && !isAbsolute(relation));
}

function permissions(receipt) {
  return Number(receipt.mode & RECEIPT_PERMISSIONS);
}

function compareManifestPath(left, right) {
  return left.path < right.path ? -1 : left.path > right.path ? 1 : 0;
}
