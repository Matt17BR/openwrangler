import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdtempSync,
  openSync,
  readSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmdirSync,
  unlinkSync,
  writeSync
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  CANONICAL_PREVIEW_RELEASE_ARTIFACT_PROTOCOL,
  CANONICAL_RELEASE_ARTIFACT_PROTOCOL,
  PERFORMANCE_EVIDENCE_ARTIFACT_PROTOCOL,
  PERFORMANCE_EVIDENCE_ARTIFACT_ROLE,
  assertInstalledPerformancePackageInventory,
  assertNoPackageableUntrackedFiles,
  assertSameInstalledPerformancePackageSources,
  validateInstalledPerformanceProvenance,
  validatePreviewReleaseProvenance,
  validatePerformanceEvidenceProvenance
} from "./run-installed-performance.mjs";
import {
  inspectPerformanceEvidenceCandidateReadiness,
  inspectPreviewReleaseReadiness,
  inspectStableReleaseReadiness,
  readOwnedVsixSnapshot,
  readReleaseSourceSnapshot,
  readStableVsixPayload
} from "./release-readiness.mjs";
import { classifyNumericReleaseVersion } from "./release-metadata.mjs";
import { parseStrictJson } from "./strict-json.mjs";
import { readBoundedVsixFileSnapshot } from "./vsix-archive.mjs";

const repositoryRoot = resolve(import.meta.dirname, "..");
const FULL_COMMIT_ID = /^[0-9a-f]{40}$/u;
const STABLE_RELEASE_TAG = /^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u;
const PROVENANCE_MAX_BYTES = 4096;
const CHECKSUM_MAX_BYTES = 512;
export const CANONICAL_RELEASE_PUBLICATION_MODE = "stable-release";
export const PREVIEW_RELEASE_PUBLICATION_MODE = "preview-release";
export const PERFORMANCE_EVIDENCE_PUBLICATION_MODE = "performance-evidence";
const CANONICAL_FILES = Object.freeze([
  "openwrangler.vsix",
  "openwrangler.vsix.sha256",
  "openwrangler.vsix.provenance.json"
]);
export { CANONICAL_RELEASE_ARTIFACT_PROTOCOL };
export const validateCanonicalReleaseProvenance = validateInstalledPerformanceProvenance;
export { CANONICAL_PREVIEW_RELEASE_ARTIFACT_PROTOCOL };
export { validatePreviewReleaseProvenance };
export { PERFORMANCE_EVIDENCE_ARTIFACT_PROTOCOL, PERFORMANCE_EVIDENCE_ARTIFACT_ROLE };
export const validatePerformanceEvidenceCandidateProvenance = validatePerformanceEvidenceProvenance;

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function sameIdentity(left, right) {
  return left !== undefined && right !== undefined && left.dev === right.dev && left.ino === right.ino;
}

function fileIdentity(metadata) {
  return Object.freeze({
    ctimeNs: metadata.ctimeNs,
    dev: metadata.dev,
    ino: metadata.ino,
    mode: metadata.mode,
    mtimeNs: metadata.mtimeNs,
    size: metadata.size,
    uid: metadata.uid
  });
}

function matchesFileReceipt(metadata, receipt) {
  return (
    receipt !== undefined &&
    metadata.isFile() &&
    !metadata.isSymbolicLink() &&
    metadata.nlink === 1n &&
    metadata.dev === receipt.identity.dev &&
    metadata.ino === receipt.identity.ino &&
    metadata.mode === receipt.identity.mode &&
    metadata.uid === receipt.identity.uid &&
    metadata.size === receipt.identity.size &&
    metadata.size === BigInt(receipt.size) &&
    metadata.mtimeNs === receipt.identity.mtimeNs &&
    metadata.ctimeNs === receipt.identity.ctimeNs
  );
}

function directoryIdentity(metadata) {
  return Object.freeze({
    dev: metadata.dev,
    ino: metadata.ino,
    mode: metadata.mode,
    nlink: metadata.nlink,
    uid: metadata.uid
  });
}

function isCurrentUserOwned(metadata) {
  return typeof process.getuid !== "function" || metadata.uid === BigInt(process.getuid());
}

function runGit(root, arguments_, { maxBuffer = 64 * 1024 } = {}) {
  return execFileSync("git", arguments_, {
    cwd: root,
    encoding: "utf8",
    maxBuffer,
    timeout: 10_000,
    windowsHide: true
  });
}

function canonicalRepositoryRoot(root) {
  const requested = resolve(root);
  const canonical = realpathSync.native(requested);
  const metadata = lstatSync(requested, { bigint: true });
  if (canonical !== requested || !metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error("The canonical release repository root must be one canonical directory.");
  }
  const topLevel = realpathSync.native(
    resolve(runGit(canonical, ["rev-parse", "--show-toplevel"], { maxBuffer: 4096 }).trim())
  );
  if (topLevel !== canonical) {
    throw new Error("Canonical release publication must run from the exact Git repository root.");
  }
  return canonical;
}

export function readCanonicalReleaseSourceBinding({ expectedCommit, releaseTag, root }) {
  if (typeof expectedCommit !== "string" || !FULL_COMMIT_ID.test(expectedCommit)) {
    throw new Error("EXPECTED_SHA must be one full lowercase hexadecimal Git commit ID.");
  }
  if (typeof releaseTag !== "string" || !STABLE_RELEASE_TAG.test(releaseTag)) {
    throw new Error("RELEASE_TAG must be one vmajor.minor.patch tag.");
  }
  const canonicalRoot = canonicalRepositoryRoot(root);
  const source = readReleaseSourceSnapshot({ expectedCommit, root: canonicalRoot });
  const trackedStatus = runGit(
    canonicalRoot,
    ["--no-optional-locks", "status", "--porcelain=v1", "--untracked-files=no"],
    { maxBuffer: 1024 * 1024 }
  );
  if (trackedStatus.length !== 0) {
    throw new Error("Canonical release publication requires one clean tracked worktree and index.");
  }
  const tagCommit = runGit(canonicalRoot, ["rev-parse", "--verify", "--end-of-options", `${releaseTag}^{commit}`], {
    maxBuffer: 4096
  }).trim();
  if (!FULL_COMMIT_ID.test(tagCommit) || tagCommit !== expectedCommit) {
    throw new Error("RELEASE_TAG must resolve to the exact EXPECTED_SHA commit.");
  }
  return Object.freeze({
    ...source,
    releaseTag,
    root: canonicalRoot,
    tagCommit
  });
}

export function readPreviewReleaseSourceBinding({ expectedCommit, releaseTag, root }) {
  if (typeof expectedCommit !== "string" || !FULL_COMMIT_ID.test(expectedCommit)) {
    throw new Error("EXPECTED_SHA must be one full lowercase hexadecimal Git commit ID.");
  }
  if (typeof releaseTag !== "string" || !STABLE_RELEASE_TAG.test(releaseTag)) {
    throw new Error("RELEASE_TAG must be one vmajor.minor.patch tag.");
  }
  const canonicalRoot = canonicalRepositoryRoot(root);
  const source = readReleaseSourceSnapshot({ expectedCommit, root: canonicalRoot });
  const trackedStatus = runGit(
    canonicalRoot,
    ["--no-optional-locks", "status", "--porcelain=v1", "--untracked-files=no"],
    { maxBuffer: 1024 * 1024 }
  );
  if (trackedStatus.length !== 0) {
    throw new Error("Canonical preview publication requires one clean tracked worktree and index.");
  }
  return Object.freeze({
    ...source,
    releaseTag,
    root: canonicalRoot
  });
}

function sameVsixIdentity(left, right) {
  return (
    left?.dev === right?.dev &&
    left?.ino === right?.ino &&
    left?.size === right?.size &&
    left?.mtimeNs === right?.mtimeNs &&
    left?.ctimeNs === right?.ctimeNs
  );
}

function revalidateCandidate(candidatePath, expected) {
  const current = readOwnedVsixSnapshot(candidatePath);
  if (
    current.sha256 !== expected.sha256 ||
    !current.bytes.equals(expected.bytes) ||
    !sameVsixIdentity(current.sourceIdentity, expected.sourceIdentity)
  ) {
    throw new Error("The candidate changed during canonical artifact publication.");
  }
}

function parseStableSourceManifest(sourcePackageJson) {
  const manifest = parseStrictJson(sourcePackageJson, { maxBytes: 1024 * 1024 });
  const version = manifest?.version;
  if (
    typeof manifest !== "object" ||
    manifest === null ||
    Array.isArray(manifest) ||
    manifest.publisher !== "Matt17BR" ||
    manifest.name !== "openwrangler" ||
    typeof version !== "string" ||
    classifyNumericReleaseVersion(version)?.channel !== "stable" ||
    version.startsWith("0.") ||
    manifest.preview !== false
  ) {
    throw new Error(
      "The canonical artifact source manifest must describe stable Matt17BR.openwrangler 1.0.0 or newer."
    );
  }
  return Object.freeze({
    extensionId: `${manifest.publisher}.${manifest.name}`,
    preview: manifest.preview,
    version
  });
}

function parsePreviewSourceManifest(sourcePackageJson) {
  const manifest = parseStrictJson(sourcePackageJson, { maxBytes: 1024 * 1024 });
  const version = manifest?.version;
  if (
    typeof manifest !== "object" ||
    manifest === null ||
    Array.isArray(manifest) ||
    manifest.publisher !== "Matt17BR" ||
    manifest.name !== "openwrangler" ||
    typeof version !== "string" ||
    classifyNumericReleaseVersion(version)?.channel !== "preview" ||
    manifest.preview !== true
  ) {
    throw new Error("The canonical preview source manifest must describe preview Matt17BR.openwrangler metadata.");
  }
  return Object.freeze({
    extensionId: `${manifest.publisher}.${manifest.name}`,
    preview: manifest.preview,
    version
  });
}

function publicationContract(publicationMode) {
  if (publicationMode === CANONICAL_RELEASE_PUBLICATION_MODE) {
    return Object.freeze({
      inspectReadiness: inspectStableReleaseReadiness,
      parseSourceManifest: parseStableSourceManifest,
      provenanceProtocol: CANONICAL_RELEASE_ARTIFACT_PROTOCOL,
      readSourceBinding: readCanonicalReleaseSourceBinding,
      readinessLabel: "Canonical stable release",
      validateProvenance: validateCanonicalReleaseProvenance
    });
  }
  if (publicationMode === PREVIEW_RELEASE_PUBLICATION_MODE) {
    return Object.freeze({
      inspectReadiness: inspectPreviewReleaseReadiness,
      parseSourceManifest: parsePreviewSourceManifest,
      provenanceProtocol: CANONICAL_PREVIEW_RELEASE_ARTIFACT_PROTOCOL,
      readSourceBinding: readPreviewReleaseSourceBinding,
      readinessLabel: "Canonical preview release",
      validateProvenance: validatePreviewReleaseProvenance
    });
  }
  if (publicationMode === PERFORMANCE_EVIDENCE_PUBLICATION_MODE) {
    return Object.freeze({
      inspectReadiness: inspectPerformanceEvidenceCandidateReadiness,
      parseSourceManifest: parseStableSourceManifest,
      provenanceProtocol: PERFORMANCE_EVIDENCE_ARTIFACT_PROTOCOL,
      readSourceBinding: readCanonicalReleaseSourceBinding,
      readinessLabel: "Performance-evidence candidate",
      validateProvenance: validatePerformanceEvidenceCandidateProvenance
    });
  }
  throw new TypeError(
    "Canonical artifact publication mode must be stable-release, preview-release, or performance-evidence."
  );
}

function provenanceBytes({ contract, expectedCommit, manifest, publicationMode, releaseTag, snapshot }) {
  const evidenceOnly = publicationMode === PERFORMANCE_EVIDENCE_PUBLICATION_MODE;
  const provenance = contract.validateProvenance({
    protocol: contract.provenanceProtocol,
    ...(evidenceOnly ? { artifactRole: PERFORMANCE_EVIDENCE_ARTIFACT_ROLE } : {}),
    extensionId: manifest.extensionId,
    extensionVersion: manifest.version,
    preview: manifest.preview,
    releaseTag,
    sourceCommit: expectedCommit,
    vsixSha256: snapshot.sha256,
    vsixBytes: snapshot.bytes.length
  });
  const bytes = Buffer.from(`${JSON.stringify(provenance, null, 2)}\n`, "utf8");
  if (bytes.length <= 0 || bytes.length > PROVENANCE_MAX_BYTES) {
    throw new Error("Canonical release provenance exceeds its byte budget.");
  }
  contract.validateProvenance(parseStrictJson(bytes.toString("utf8"), { maxBytes: PROVENANCE_MAX_BYTES }));
  return bytes;
}

function assertOutputDestination(outputDirectory) {
  if (typeof outputDirectory !== "string" || outputDirectory.length === 0) {
    throw new TypeError("Canonical release publication requires one output directory.");
  }
  const outputPath = resolve(outputDirectory);
  const outputName = basename(outputPath);
  if (outputName === "." || outputName === ".." || /[\0\r\n]/u.test(outputName)) {
    throw new Error("The canonical release output directory name is malformed.");
  }
  const parentPath = dirname(outputPath);
  const canonicalParent = realpathSync.native(parentPath);
  const parent = lstatSync(parentPath, { bigint: true });
  if (
    canonicalParent !== parentPath ||
    !parent.isDirectory() ||
    parent.isSymbolicLink() ||
    !isCurrentUserOwned(parent) ||
    (process.platform !== "win32" && (parent.mode & 0o022n) !== 0n)
  ) {
    throw new Error(
      "The canonical release output parent must be one canonical, current-user-owned, non-group-writable directory."
    );
  }
  assertPathAbsent(
    outputPath,
    "The canonical release output directory must not exist; pre-created empty directories cannot be atomically published."
  );
  return Object.freeze({
    outputName,
    outputPath,
    parentIdentity: directoryIdentity(parent),
    parentPath
  });
}

function assertPathAbsent(path, message) {
  try {
    lstatSync(path);
  } catch (error) {
    if (error?.code === "ENOENT") {
      return;
    }
    throw error;
  }
  throw new Error(message);
}

function assertParentUnchanged(destination) {
  const current = lstatSync(destination.parentPath, { bigint: true });
  if (
    !current.isDirectory() ||
    current.isSymbolicLink() ||
    realpathSync.native(destination.parentPath) !== destination.parentPath ||
    !sameIdentity(current, destination.parentIdentity) ||
    current.mode !== destination.parentIdentity.mode ||
    current.uid !== destination.parentIdentity.uid
  ) {
    throw new Error("The canonical release output parent changed during publication.");
  }
}

function openDirectoryDescriptor(path) {
  if (process.platform === "win32") {
    return undefined;
  }
  return openSync(path, constants.O_RDONLY | (constants.O_CLOEXEC ?? 0));
}

function syncDirectory(path) {
  const descriptor = openDirectoryDescriptor(path);
  if (descriptor === undefined) {
    return;
  }
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function writeOwnedFile(path, bytes) {
  let descriptor;
  let receipt;
  let failure;
  try {
    descriptor = openSync(
      path,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        (constants.O_NOFOLLOW ?? 0) |
        (constants.O_CLOEXEC ?? 0),
      0o600
    );
    const opened = fstatSync(descriptor, { bigint: true });
    if (!opened.isFile() || opened.nlink !== 1n || !isCurrentUserOwned(opened)) {
      throw new Error(`Canonical release output ownership could not be established: ${basename(path)}.`);
    }
    let offset = 0;
    while (offset < bytes.length) {
      const written = writeSync(descriptor, bytes, offset, bytes.length - offset);
      if (!Number.isSafeInteger(written) || written <= 0) {
        throw new Error(`Canonical release output write made no progress: ${basename(path)}.`);
      }
      offset += written;
    }
    fsyncSync(descriptor);
    fchmodSync(descriptor, 0o444);
    fsyncSync(descriptor);
    const completed = fstatSync(descriptor, { bigint: true });
    const named = lstatSync(path, { bigint: true });
    if (
      !completed.isFile() ||
      completed.nlink !== 1n ||
      !sameIdentity(opened, completed) ||
      !sameIdentity(completed, named) ||
      completed.size !== BigInt(bytes.length) ||
      !isCurrentUserOwned(completed)
    ) {
      throw new Error(`Canonical release output changed while it was written: ${basename(path)}.`);
    }
    receipt = Object.freeze({
      identity: fileIdentity(completed),
      name: basename(path),
      sha256: sha256(bytes),
      size: bytes.length
    });
  } catch (error) {
    failure = error;
  } finally {
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor);
      } catch (error) {
        failure ??= error;
      }
    }
  }
  if (failure !== undefined) {
    let cleanupError;
    if (receipt !== undefined) {
      try {
        const named = lstatSync(path, { bigint: true });
        if (!matchesFileReceipt(named, receipt)) {
          throw new Error(`Refusing to clean a changed canonical release file: ${basename(path)}.`);
        }
        unlinkSync(path);
      } catch (error) {
        cleanupError = error;
      }
    } else {
      cleanupError = new Error(
        `Refusing to clean a canonical release file without a complete receipt: ${basename(path)}.`
      );
    }
    throw cleanupError === undefined
      ? failure
      : new AggregateError(
          [failure, cleanupError],
          `Canonical release file publication and cleanup failed: ${basename(path)}.`
        );
  }
  if (receipt === undefined || !matchesFileReceipt(lstatSync(path, { bigint: true }), receipt)) {
    throw new Error(`Canonical release output identity was lost after close: ${basename(path)}.`);
  }
  return receipt;
}

function assertDirectoryIdentity(path, expected, label) {
  const current = lstatSync(path, { bigint: true });
  if (
    !current.isDirectory() ||
    current.isSymbolicLink() ||
    !isCurrentUserOwned(current) ||
    !sameIdentity(current, expected) ||
    current.mode !== expected.mode ||
    current.nlink !== expected.nlink ||
    current.uid !== expected.uid
  ) {
    throw new Error(`${label} changed during canonical release publication.`);
  }
  return current;
}

function repinDirectoryAfterOwnedFileWrites(path, expected, fileReceipts) {
  const current = lstatSync(path, { bigint: true });
  if (
    !current.isDirectory() ||
    current.isSymbolicLink() ||
    !isCurrentUserOwned(current) ||
    !sameIdentity(current, expected) ||
    current.mode !== expected.mode ||
    current.uid !== expected.uid
  ) {
    throw new Error("The private canonical release directory changed while its owned files were written.");
  }
  const names = readdirSync(path).sort();
  const expectedNames = [...CANONICAL_FILES].sort();
  if (names.length !== expectedNames.length || names.some((name, index) => name !== expectedNames[index])) {
    throw new Error("The private canonical release directory gained an unowned entry while its files were written.");
  }
  for (const name of names) {
    if (!matchesFileReceipt(lstatSync(join(path, name), { bigint: true }), fileReceipts.get(name))) {
      throw new Error(`Canonical release file identity changed before directory repinning: ${name}.`);
    }
  }
  return directoryIdentity(current);
}

function assertExactInventory(directory, directoryReceipt, fileReceipts) {
  assertDirectoryIdentity(directory, directoryReceipt, "The canonical release directory");
  const names = readdirSync(directory).sort();
  const expectedNames = [...CANONICAL_FILES].sort();
  if (names.length !== expectedNames.length || names.some((name, index) => name !== expectedNames[index])) {
    throw new Error("The canonical release directory must contain exactly the three canonical files.");
  }
  for (const name of CANONICAL_FILES) {
    const receipt = fileReceipts.get(name);
    const current = lstatSync(join(directory, name), { bigint: true });
    if (!matchesFileReceipt(current, receipt) || !isCurrentUserOwned(current)) {
      throw new Error(`Canonical release file identity changed: ${name}.`);
    }
  }
}

function readAndValidatePublishedFiles(directory, directoryReceipt, fileReceipts, expected) {
  assertExactInventory(directory, directoryReceipt, fileReceipts);
  const vsixPath = join(directory, CANONICAL_FILES[0]);
  const vsix = readBoundedVsixFileSnapshot(vsixPath, { requireOwner: true });
  if (
    !vsix.bytes.equals(expected.snapshot.bytes) ||
    sha256(vsix.bytes) !== expected.snapshot.sha256 ||
    !sameIdentity(vsix.identity, fileReceipts.get(CANONICAL_FILES[0])?.identity)
  ) {
    throw new Error("Published canonical VSIX does not match the inspected candidate.");
  }

  for (const [name, maximumBytes, expectedBytes] of [
    [CANONICAL_FILES[1], CHECKSUM_MAX_BYTES, expected.checksum],
    [CANONICAL_FILES[2], PROVENANCE_MAX_BYTES, expected.provenance]
  ]) {
    const path = join(directory, name);
    const descriptor = openSync(
      path,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0) | (constants.O_CLOEXEC ?? 0)
    );
    try {
      const before = fstatSync(descriptor, { bigint: true });
      const receipt = fileReceipts.get(name);
      if (!matchesFileReceipt(before, receipt) || before.size <= 0n || before.size > BigInt(maximumBytes)) {
        throw new Error(`Published canonical file is not one bounded retained identity: ${name}.`);
      }
      const bytes = Buffer.alloc(Number(before.size));
      let offset = 0;
      while (offset < bytes.length) {
        const count = readSync(descriptor, bytes, offset, bytes.length - offset, null);
        if (count <= 0) {
          throw new Error(`Published canonical file ended before its retained size: ${name}.`);
        }
        offset += count;
      }
      const after = fstatSync(descriptor, { bigint: true });
      const named = lstatSync(path, { bigint: true });
      if (!matchesFileReceipt(after, receipt) || !matchesFileReceipt(named, receipt) || !bytes.equals(expectedBytes)) {
        throw new Error(`Published canonical file changed during final verification: ${name}.`);
      }
      if (name.endsWith(".json")) {
        expected.validateProvenance(parseStrictJson(bytes.toString("utf8"), { maxBytes: PROVENANCE_MAX_BYTES }));
      }
    } finally {
      closeSync(descriptor);
    }
  }
  assertExactInventory(directory, directoryReceipt, fileReceipts);
}

function cleanupOwnedDirectory(path, directoryReceipt, fileReceipts) {
  assertDirectoryIdentity(path, directoryReceipt, "The failed canonical release directory");
  const names = readdirSync(path).sort();
  if (names.some((name) => !CANONICAL_FILES.includes(name))) {
    throw new Error("Refusing to clean a canonical release directory containing an unowned entry.");
  }
  for (const name of names) {
    const receipt = fileReceipts.get(name);
    const named = lstatSync(join(path, name), { bigint: true });
    if (!matchesFileReceipt(named, receipt)) {
      throw new Error(`Refusing to clean an unverified canonical release file: ${name}.`);
    }
  }
  for (const name of names) {
    unlinkSync(join(path, name));
  }
  rmdirSync(path);
}

function sameSourceBinding(current, expected) {
  if (
    current.root !== expected.root ||
    current.commit !== expected.commit ||
    current.releaseTag !== expected.releaseTag ||
    current.tagCommit !== expected.tagCommit
  ) {
    throw new Error("The canonical release source binding changed during publication.");
  }
}

export function createCanonicalReleaseDependencies({ packageSourceOptions } = {}) {
  if (
    packageSourceOptions !== undefined &&
    (packageSourceOptions === null || typeof packageSourceOptions !== "object" || Array.isArray(packageSourceOptions))
  ) {
    throw new TypeError("Canonical release package-source options must be one object.");
  }
  return Object.freeze({
    assertPackageInventory: assertInstalledPerformancePackageInventory,
    assertSamePackageSources: assertSameInstalledPerformancePackageSources,
    pinPackageSources: () => assertNoPackageableUntrackedFiles(packageSourceOptions)
  });
}

export async function createCanonicalReleaseArtifact({
  candidatePath,
  dependencies = createCanonicalReleaseDependencies(),
  expectedCommit,
  hooks = {},
  outputDirectory,
  publicationMode = CANONICAL_RELEASE_PUBLICATION_MODE,
  releaseTag,
  root = repositoryRoot
}) {
  const contract = publicationContract(publicationMode);
  if (
    typeof candidatePath !== "string" ||
    candidatePath.length === 0 ||
    dependencies === null ||
    typeof dependencies !== "object" ||
    typeof dependencies.pinPackageSources !== "function" ||
    typeof dependencies.assertPackageInventory !== "function" ||
    typeof dependencies.assertSamePackageSources !== "function" ||
    hooks === null ||
    typeof hooks !== "object"
  ) {
    throw new TypeError("Canonical release artifact publication arguments are malformed.");
  }
  for (const hook of ["afterCandidateRead", "beforePublishRename", "afterPublishRename"]) {
    if (hooks[hook] !== undefined && typeof hooks[hook] !== "function") {
      throw new TypeError(`Canonical release test hook ${hook} must be a function.`);
    }
  }

  const destination = assertOutputDestination(outputDirectory);
  const resolvedCandidate = resolve(candidatePath);
  if (resolvedCandidate === destination.outputPath) {
    throw new Error("The candidate and canonical release output directory must be distinct.");
  }
  const sourceBefore = contract.readSourceBinding({ expectedCommit, releaseTag, root });
  const packageSources = await dependencies.pinPackageSources();
  const snapshot = readOwnedVsixSnapshot(resolvedCandidate);
  await hooks.afterCandidateRead?.({ candidatePath: resolvedCandidate, snapshot });
  const packaged = await readStableVsixPayload(snapshot.bytes);
  dependencies.assertPackageInventory(packageSources, packaged.archiveEntries, packaged.entryDigests);
  const problems = contract.inspectReadiness({
    releaseTag,
    sourcePackageJson: sourceBefore.files.get("package.json"),
    pythonVersionFile: sourceBefore.files.get("python/openwrangler_runtime/version.py"),
    featureParity: sourceBefore.files.get("docs/feature-parity.md"),
    changelog: sourceBefore.files.get("CHANGELOG.md"),
    readme: sourceBefore.files.get("README.md"),
    packagedPackageJson: packaged.packagedPackageJson,
    packagedPythonVersionFile: packaged.packagedPythonVersionFile,
    packagedReadme: packaged.packagedReadme,
    trackedEvidencePaths: sourceBefore.trackedPaths,
    vsixManifest: packaged.vsixManifest
  });
  if (problems.length > 0) {
    throw new Error(`${contract.readinessLabel} readiness failed:\n- ${problems.join("\n- ")}`);
  }
  const manifest = contract.parseSourceManifest(sourceBefore.files.get("package.json"));
  if (releaseTag !== `v${manifest.version}`) {
    throw new Error("RELEASE_TAG must exactly match the source package version.");
  }
  const checksum = Buffer.from(`${snapshot.sha256}  ${CANONICAL_FILES[0]}\n`, "utf8");
  const provenance = provenanceBytes({
    contract,
    expectedCommit,
    manifest,
    publicationMode,
    releaseTag,
    snapshot
  });
  revalidateCandidate(resolvedCandidate, snapshot);
  const sourceBeforeStaging = contract.readSourceBinding({ expectedCommit, releaseTag, root });
  sameSourceBinding(sourceBeforeStaging, sourceBefore);
  const packageSourcesBeforeStaging = await dependencies.pinPackageSources();
  dependencies.assertSamePackageSources(packageSources, packageSourcesBeforeStaging);

  let publicationPath;
  let directoryReceipt;
  const fileReceipts = new Map();
  let renamed = false;
  let failure;
  try {
    assertParentUnchanged(destination);
    assertPathAbsent(destination.outputPath, "The canonical release output path appeared before private staging.");
    publicationPath = mkdtempSync(join(destination.parentPath, `.${destination.outputName}.tmp-`));
    const stage = lstatSync(publicationPath, { bigint: true });
    if (!stage.isDirectory() || stage.isSymbolicLink() || !isCurrentUserOwned(stage)) {
      throw new Error("The private canonical release staging directory is not current-user-owned.");
    }
    directoryReceipt = directoryIdentity(stage);
    for (const [name, bytes] of [
      [CANONICAL_FILES[0], snapshot.bytes],
      [CANONICAL_FILES[1], checksum],
      [CANONICAL_FILES[2], provenance]
    ]) {
      fileReceipts.set(name, writeOwnedFile(join(publicationPath, name), bytes));
    }
    directoryReceipt = repinDirectoryAfterOwnedFileWrites(publicationPath, directoryReceipt, fileReceipts);
    syncDirectory(publicationPath);
    assertExactInventory(publicationPath, directoryReceipt, fileReceipts);
    revalidateCandidate(resolvedCandidate, snapshot);
    const sourceBeforeRename = contract.readSourceBinding({ expectedCommit, releaseTag, root });
    sameSourceBinding(sourceBeforeRename, sourceBefore);
    await hooks.beforePublishRename?.({
      outputDirectory: destination.outputPath,
      stagingDirectory: publicationPath
    });
    revalidateCandidate(resolvedCandidate, snapshot);
    const sourceAfterHook = contract.readSourceBinding({ expectedCommit, releaseTag, root });
    sameSourceBinding(sourceAfterHook, sourceBefore);
    assertParentUnchanged(destination);
    assertExactInventory(publicationPath, directoryReceipt, fileReceipts);
    assertPathAbsent(destination.outputPath, "The canonical release output path appeared before atomic publication.");
    renameSync(publicationPath, destination.outputPath);
    publicationPath = destination.outputPath;
    renamed = true;
    syncDirectory(destination.parentPath);
    await hooks.afterPublishRename?.({ outputDirectory: destination.outputPath });
    readAndValidatePublishedFiles(destination.outputPath, directoryReceipt, fileReceipts, {
      checksum,
      provenance,
      snapshot,
      validateProvenance: contract.validateProvenance
    });
    revalidateCandidate(resolvedCandidate, snapshot);
    const sourceAfter = contract.readSourceBinding({ expectedCommit, releaseTag, root });
    sameSourceBinding(sourceAfter, sourceBefore);
    readAndValidatePublishedFiles(destination.outputPath, directoryReceipt, fileReceipts, {
      checksum,
      provenance,
      snapshot,
      validateProvenance: contract.validateProvenance
    });
    return Object.freeze({
      directory: destination.outputPath,
      files: Object.freeze(
        CANONICAL_FILES.map((name) =>
          Object.freeze({
            name,
            sha256: fileReceipts.get(name).sha256,
            size: fileReceipts.get(name).size
          })
        )
      ),
      publicationMode,
      releaseTag,
      sourceCommit: expectedCommit,
      vsixSha256: snapshot.sha256
    });
  } catch (error) {
    failure = error;
  }

  if (publicationPath !== undefined && directoryReceipt !== undefined) {
    try {
      cleanupOwnedDirectory(publicationPath, directoryReceipt, fileReceipts);
      if (renamed) {
        syncDirectory(destination.parentPath);
      }
    } catch (cleanupError) {
      throw new AggregateError([failure, cleanupError], "Canonical release artifact publication and cleanup failed.");
    }
  }
  throw failure;
}

export function parseCanonicalReleaseArtifactArguments(arguments_) {
  const modeFlag = arguments_.length === 4 ? arguments_.at(-1) : undefined;
  const publicationMode =
    modeFlag === "--performance-evidence"
      ? PERFORMANCE_EVIDENCE_PUBLICATION_MODE
      : modeFlag === "--preview-release"
        ? PREVIEW_RELEASE_PUBLICATION_MODE
        : modeFlag === undefined
          ? CANONICAL_RELEASE_PUBLICATION_MODE
          : undefined;
  const positional = publicationMode === CANONICAL_RELEASE_PUBLICATION_MODE ? arguments_ : arguments_.slice(0, -1);
  if (
    publicationMode === undefined ||
    positional.length !== 3 ||
    positional[1] !== "--out-dir" ||
    typeof positional[0] !== "string" ||
    positional[0].length === 0 ||
    typeof positional[2] !== "string" ||
    positional[2].length === 0
  ) {
    throw new Error(
      "Pass one prebuilt candidate and a new output directory: <candidate.vsix> --out-dir <directory> [--preview-release|--performance-evidence]."
    );
  }
  return Object.freeze({
    candidatePath: positional[0],
    outputDirectory: positional[2],
    publicationMode
  });
}

async function runCli() {
  const options = parseCanonicalReleaseArtifactArguments(process.argv.slice(2));
  const result = await createCanonicalReleaseArtifact({
    candidatePath: resolve(repositoryRoot, options.candidatePath),
    expectedCommit: process.env.EXPECTED_SHA,
    outputDirectory: resolve(repositoryRoot, options.outputDirectory),
    publicationMode: options.publicationMode,
    releaseTag: process.env.RELEASE_TAG,
    root: repositoryRoot
  });
  console.log(
    `Published ${result.publicationMode} artifact ${result.releaseTag} (${result.vsixSha256}) to ${basename(result.directory)}.`
  );
}

if (process.argv[1] !== undefined && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  await runCli();
}
