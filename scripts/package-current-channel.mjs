import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdtempSync,
  openSync,
  readFileSync,
  realpathSync,
  rmdirSync,
  unlinkSync,
  writeSync
} from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { TextDecoder } from "node:util";
import { createVSIX } from "@vscode/vsce";
import { classifyNumericReleaseVersion } from "./release-metadata.mjs";
import { assertReproducibleVsixArchive, canonicalizeVsixArchive } from "./reproducible-vsix.mjs";
import {
  assertInstalledPerformancePackageInventory,
  assertNoPackageableUntrackedFiles,
  assertSameInstalledPerformancePackageSources
} from "./run-installed-performance.mjs";
import { parseStrictJson } from "./strict-json.mjs";
import { inspectVsixArchive, readBoundedVsixFileSnapshot } from "./vsix-archive.mjs";

const PACKAGE_JSON_MAX_BYTES = 1024 * 1024;
const MAX_ENTRY_PATH_BYTES = 1024;
const MAX_GIT_INDEX_ENTRIES = 65_536;
const MAX_GIT_INDEX_BYTES = 16 * 1024 * 1024;
const GIT_TIMEOUT_MS = 10_000;
const GIT_OBJECT_ID = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u;
const WINDOWS_RESERVED_BASENAME = /^(?:aux|com[1-9¹²³]|con|lpt[1-9¹²³]|nul|prn)$/iu;
const WINDOWS_INVALID_CHARACTERS = new Set('<>:"|?*');
const PORTABLE_MODES = new Set(["100644", "100755"]);
const PRIVATE_DIRECTORY_PREFIX = ".openwrangler-package-";
const RAW_CANDIDATE_NAME = "raw-candidate.vsix";
const CANONICAL_CANDIDATE_NAME = "canonical-candidate.vsix";
const root = resolve(import.meta.dirname, "..");
const PACKAGING_HOOK_NAMES = Object.freeze([
  "afterCanonicalStaged",
  "afterLink",
  "afterPrivateDirectoryCreated",
  "afterRawCandidateCreated",
  "afterStagingUnlink",
  "beforeFinalRead",
  "beforePublish"
]);

function readPackageChannel(packageJson) {
  let manifest;
  try {
    manifest = parseStrictJson(packageJson, { maxBytes: PACKAGE_JSON_MAX_BYTES });
  } catch {
    throw new Error("package-current-channel requires one valid, bounded package.json without duplicate keys.");
  }
  if (typeof manifest !== "object" || manifest === null || Array.isArray(manifest)) {
    throw new Error("package-current-channel requires package.json to contain one JSON object.");
  }

  const classification = classifyNumericReleaseVersion(manifest.version);
  if (classification === undefined) {
    throw new Error("package-current-channel requires a Marketplace-compatible major.minor.patch version.");
  }
  if (typeof manifest.preview !== "boolean") {
    throw new Error('package-current-channel requires package.json "preview" to be an explicit boolean.');
  }

  const expectedPreview = classification.channel === "preview";
  if (manifest.preview !== expectedPreview) {
    throw new Error(
      expectedPreview
        ? `Preview-channel version ${classification.version} requires package.json "preview" to be true.`
        : `Stable-channel version ${classification.version} requires package.json "preview" to be false.`
    );
  }
  return classification.channel;
}

function resolveCurrentChannelPackageRequest({ arguments_, packageJson }) {
  if (!Array.isArray(arguments_) || arguments_.some((argument) => typeof argument !== "string")) {
    throw new TypeError("Package arguments must be an array of strings.");
  }

  const channel = readPackageChannel(packageJson);
  const requestedPrerelease = arguments_[0] === "--pre-release";
  const outputArguments = requestedPrerelease ? arguments_.slice(1) : arguments_;
  if (
    outputArguments.length !== 2 ||
    outputArguments[0] !== "--out" ||
    outputArguments[1] === undefined ||
    outputArguments[1].length === 0 ||
    outputArguments[1].startsWith("-") ||
    /[\0\r\n]/u.test(outputArguments[1])
  ) {
    throw new Error(
      "Package arguments must be exactly --out <non-option path>, with an optional leading --pre-release."
    );
  }
  if (channel === "stable" && requestedPrerelease) {
    throw new Error("Stable-channel packaging must not receive --pre-release.");
  }

  return Object.freeze({ channel, output: outputArguments[1] });
}

export function resolveCurrentChannelPackageArguments({ arguments_, packageJson }) {
  const request = resolveCurrentChannelPackageRequest({ arguments_, packageJson });
  return Object.freeze([
    "package",
    "--no-gitHubIssueLinking",
    ...(request.channel === "preview" ? ["--pre-release"] : []),
    "--out",
    request.output
  ]);
}

function sameNode(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function sameFileSnapshot(left, right) {
  return (
    sameNode(left, right) &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

function requireCurrentOwner(identity, label) {
  if (typeof process.getuid === "function" && identity.uid !== BigInt(process.getuid())) {
    throw new Error(`${label} must be owned by the current user.`);
  }
}

export function isPrivatePackagingDirectoryMode(mode, { platform = process.platform } = {}) {
  if (typeof mode !== "bigint" || typeof platform !== "string" || platform.length === 0) {
    throw new TypeError("Private packaging directory mode validation requires a bigint mode and platform.");
  }
  return platform === "win32" ? (mode & 0o200n) !== 0n : (mode & 0o777n) === 0o700n;
}

export function isPortableHostPackageFileMode(mode, { platform = process.platform } = {}) {
  if (typeof mode !== "bigint" || typeof platform !== "string" || platform.length === 0) {
    throw new TypeError("Host package file mode validation requires a bigint mode and platform.");
  }
  return platform === "win32" ? (mode & 0o200n) !== 0n : (mode & 0o777n) === 0o644n;
}

function readNamedIdentity(path, label) {
  try {
    return lstatSync(path, { bigint: true });
  } catch (error) {
    throw new Error(`${label} could not be inspected.`, { cause: error });
  }
}

function assertPathAbsent(path, label) {
  try {
    lstatSync(path);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw new Error(`${label} absence could not be verified.`, { cause: error });
  }
  throw new Error(`${label} must not already exist.`);
}

function captureOwnedRegularFile(path, label) {
  const identity = readNamedIdentity(path, label);
  if (!identity.isFile() || identity.nlink !== 1n || identity.size <= 0n) {
    throw new Error(`${label} must be one non-empty regular file with one name.`);
  }
  requireCurrentOwner(identity, label);
  return identity;
}

function requireNamedFileSnapshot(path, expected, label, { links } = {}) {
  const current = readNamedIdentity(path, label);
  if (
    !current.isFile() ||
    !sameFileSnapshot(current, expected) ||
    (links !== undefined && !links.includes(current.nlink))
  ) {
    throw new Error(`${label} changed identity or bytes.`);
  }
  requireCurrentOwner(current, label);
  return current;
}

function capturePinnedDirectory(path, label, { privateDirectory = false } = {}) {
  const canonical = realpathSync(path);
  if (canonical !== path) {
    throw new Error(`${label} must use its canonical path without symbolic-link aliases.`);
  }
  const identity = readNamedIdentity(path, label);
  if (!identity.isDirectory()) throw new Error(`${label} must be one directory.`);
  if (privateDirectory) {
    requireCurrentOwner(identity, label);
    if (!isPrivatePackagingDirectoryMode(identity.mode)) {
      throw new Error(`${label} must have private writable host permissions.`);
    }
  }
  return Object.freeze({ canonical, identity, path });
}

function revalidatePinnedDirectory(receipt, label, { privateDirectory = false } = {}) {
  const canonical = realpathSync(receipt.path);
  const identity = readNamedIdentity(receipt.path, label);
  if (
    canonical !== receipt.canonical ||
    !identity.isDirectory() ||
    !sameNode(identity, receipt.identity) ||
    (privateDirectory && !isPrivatePackagingDirectoryMode(identity.mode))
  ) {
    throw new Error(`${label} changed identity.`);
  }
  if (privateDirectory) requireCurrentOwner(identity, label);
  return identity;
}

function fsyncDirectory(path) {
  if (process.platform === "win32") return;
  const descriptor = openSync(path, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0));
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function writeExclusiveCanonicalCandidate(path, bytes) {
  let descriptor;
  let openedIdentity;
  let failure;
  try {
    descriptor = openSync(
      path,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
      0o600
    );
    openedIdentity = fstatSync(descriptor, { bigint: true });
    if (!openedIdentity.isFile() || openedIdentity.nlink !== 1n || openedIdentity.size !== 0n) {
      throw new Error("Canonical candidate staging did not acquire one exclusive regular file.");
    }
    requireCurrentOwner(openedIdentity, "Canonical candidate staging");
    let offset = 0;
    while (offset < bytes.length) {
      const written = writeSync(descriptor, bytes, offset, bytes.length - offset, offset);
      if (!Number.isSafeInteger(written) || written <= 0) {
        throw new Error("Canonical candidate staging did not write its complete byte set.");
      }
      offset += written;
    }
    fchmodSync(descriptor, 0o644);
    fsyncSync(descriptor);
  } catch (error) {
    failure = error;
  }
  if (descriptor !== undefined) {
    try {
      closeSync(descriptor);
    } catch (error) {
      failure =
        failure === undefined
          ? error
          : new AggregateError([failure, error], "Canonical candidate staging and descriptor close both failed.");
    }
  }
  let identity;
  if (failure === undefined) {
    try {
      identity = captureOwnedRegularFile(path, "Canonical candidate staging");
      if (!isPortableHostPackageFileMode(identity.mode)) {
        throw new Error("Canonical candidate staging does not have the required writable host file mode.");
      }
    } catch (error) {
      failure = error;
    }
  }
  if (failure !== undefined) {
    if (openedIdentity !== undefined) {
      try {
        removeOwnedName(path, openedIdentity, "Canonical candidate staging");
      } catch (error) {
        failure = new AggregateError(
          [failure, error],
          "Canonical candidate staging and verified partial-file cleanup both failed."
        );
      }
    }
    throw failure;
  }
  return identity;
}

function assertSameArchiveInventory(left, right) {
  if (left.entryCount !== right.entryCount) {
    throw new Error("Canonical packaging changed the VSIX entry count.");
  }
  for (const field of ["entryDigests", "entrySizes"]) {
    const leftEntries = new Map(left[field]);
    const rightEntries = new Map(right[field]);
    if (
      leftEntries.size !== rightEntries.size ||
      [...leftEntries].some(([path, value]) => rightEntries.get(path) !== value)
    ) {
      throw new Error("Canonical packaging changed the VSIX entry inventory or bytes.");
    }
  }
}

function assertCanonicalReceiptMatches(expected, actual) {
  for (const field of [
    "protocol",
    "canonicalBytes",
    "canonicalSha256",
    "entryCount",
    "inventorySha256",
    "uncompressedBytes"
  ]) {
    if (expected[field] !== actual[field]) {
      throw new Error("Canonical candidate validation returned an inconsistent receipt.");
    }
  }
}

function assertPackageOutputSeparated(output, packageSource, repositoryRoot) {
  const normalizedOutput = process.platform === "win32" ? output.toLowerCase() : output;
  for (const source of [...packageSource.trackedFiles, ...packageSource.generatedFiles]) {
    const sourcePath = resolve(repositoryRoot, source.path);
    const normalizedSource = process.platform === "win32" ? sourcePath.toLowerCase() : sourcePath;
    if (normalizedOutput === normalizedSource) {
      throw new Error("Package output must remain separate from every package source file.");
    }
  }
}

function removeOwnedName(path, expected, label) {
  let current;
  try {
    current = lstatSync(path, { bigint: true });
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw new Error(`${label} cleanup could not inspect its path.`, { cause: error });
  }
  if (!current.isFile() || !sameNode(current, expected)) {
    throw new Error(`${label} cleanup refused a substituted path.`);
  }
  unlinkSync(path);
  assertPathAbsent(path, `${label} cleaned path`);
  return true;
}

function removePinnedPrivateDirectory(receipt) {
  revalidatePinnedDirectory(receipt, "Packaging private directory", { privateDirectory: true });
  rmdirSync(receipt.path);
  assertPathAbsent(receipt.path, "Packaging private directory cleaned path");
}

function portablePathIdentity(path, label) {
  if (
    typeof path !== "string" ||
    path.length === 0 ||
    path.startsWith("/") ||
    /^[A-Za-z]:/u.test(path) ||
    path.includes("\\") ||
    path !== path.normalize("NFC") ||
    Buffer.byteLength(path, "utf8") > MAX_ENTRY_PATH_BYTES
  ) {
    throw new Error(`${label} must be one normalized portable relative path.`);
  }

  const segments = path.split("/");
  for (const segment of segments) {
    if (
      segment.length === 0 ||
      segment === "." ||
      segment === ".." ||
      segment.trim() !== segment ||
      segment.endsWith(".") ||
      Buffer.byteLength(segment, "utf8") > 255
    ) {
      throw new Error(`${label} must be one normalized portable relative path.`);
    }
    for (const character of segment) {
      const codePoint = character.codePointAt(0);
      if (
        codePoint === undefined ||
        codePoint <= 0x1f ||
        codePoint === 0x7f ||
        (codePoint >= 0xd800 && codePoint <= 0xdfff) ||
        WINDOWS_INVALID_CHARACTERS.has(character)
      ) {
        throw new Error(`${label} must be one normalized portable relative path.`);
      }
    }
    const basename = segment.split(".", 1)[0];
    if (basename !== undefined && WINDOWS_RESERVED_BASENAME.test(basename)) {
      throw new Error(`${label} must be one normalized portable relative path.`);
    }
  }

  return path.toUpperCase().toLowerCase().normalize("NFC");
}

function requireCollisionFreePaths(paths, label) {
  const identities = paths.map((path) => portablePathIdentity(path, label));
  const identitySet = new Set(identities);
  if (identitySet.size !== identities.length) {
    throw new Error(`${label} contains duplicate, case-colliding, or file-ancestor paths.`);
  }
  for (const identity of identities) {
    const segments = identity.split("/");
    for (let index = 1; index < segments.length; index += 1) {
      if (identitySet.has(segments.slice(0, index).join("/"))) {
        throw new Error(`${label} contains duplicate, case-colliding, or file-ancestor paths.`);
      }
    }
  }
}

function normalizeTrackedModes(trackedModes) {
  if (!(trackedModes instanceof Map) || trackedModes.size > MAX_GIT_INDEX_ENTRIES) {
    throw new TypeError("Package-source tracked modes must be one bounded Map.");
  }
  const normalized = new Map();
  for (const [path, mode] of trackedModes) {
    portablePathIdentity(path, "Git tracked path");
    if (!PORTABLE_MODES.has(mode)) {
      throw new Error("Git tracked files must use portable regular-file modes 100644 or 100755.");
    }
    normalized.set(path, mode);
  }
  requireCollisionFreePaths([...normalized.keys()], "Git tracked paths");
  return normalized;
}

function decodeGitIndexOutput(output) {
  let bytes;
  if (typeof output === "string") {
    bytes = Buffer.from(output, "utf8");
  } else if (Buffer.isBuffer(output) || output instanceof Uint8Array) {
    bytes = Buffer.from(output);
  } else {
    throw new TypeError("Git tracked-mode runner must return bytes or text.");
  }
  if (bytes.length > MAX_GIT_INDEX_BYTES) {
    throw new Error("Git tracked-mode output exceeds its byte bound.");
  }
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch (error) {
    throw new Error("Git tracked-mode output must contain valid UTF-8.", { cause: error });
  }
}

export function readGitTrackedModes({ cwd = process.cwd(), runGit = execFileSync } = {}) {
  if (typeof cwd !== "string" || cwd.length === 0 || typeof runGit !== "function") {
    throw new TypeError("Git tracked-mode reader requires one repository path and runner.");
  }
  const output = runGit("git", ["ls-files", "--stage", "-z"], {
    cwd,
    encoding: "buffer",
    maxBuffer: MAX_GIT_INDEX_BYTES,
    timeout: GIT_TIMEOUT_MS,
    windowsHide: true
  });
  const text = decodeGitIndexOutput(output);
  if (text.length > 0 && !text.endsWith("\0")) {
    throw new Error("Git tracked-mode output ended before its NUL record terminator.");
  }
  const records = text.length === 0 ? [] : text.slice(0, -1).split("\0");
  if (records.length > MAX_GIT_INDEX_ENTRIES) {
    throw new Error("Git tracked-mode output exceeds its entry bound.");
  }
  const trackedModes = new Map();
  for (const record of records) {
    const separator = record.indexOf("\t");
    const header = separator === -1 ? "" : record.slice(0, separator);
    const path = separator === -1 ? "" : record.slice(separator + 1);
    const match = /^(\d{6}) ([0-9a-f]+) ([0-3])$/u.exec(header);
    if (match === null || !GIT_OBJECT_ID.test(match[2])) {
      throw new Error("Git tracked-mode output contains one malformed index record.");
    }
    const [, mode, , stage] = match;
    portablePathIdentity(path, "Git tracked path");
    if (stage !== "0") {
      throw new Error("Git tracked-mode output contains an unresolved nonzero index stage.");
    }
    if (!PORTABLE_MODES.has(mode)) {
      throw new Error("Git tracked-mode output contains a symlink, submodule, or unsupported mode.");
    }
    if (trackedModes.has(path)) {
      throw new Error("Git tracked-mode output contains a duplicate path.");
    }
    trackedModes.set(path, mode);
  }
  return normalizeTrackedModes(trackedModes);
}

function freezePackageResult({ output, snapshot, receipt }) {
  return Object.freeze({
    bytes: snapshot.bytes.length,
    path: output,
    protocol: receipt.protocol,
    sha256: receipt.canonicalSha256
  });
}

function validatePackagingDependencies(dependencies, hooks) {
  for (const [name, dependency] of Object.entries(dependencies)) {
    if (typeof dependency !== "function") {
      throw new TypeError(`package-current-channel dependency ${name} must be a function.`);
    }
  }
  if (hooks === null || typeof hooks !== "object" || Array.isArray(hooks)) {
    throw new TypeError("package-current-channel hooks must be one object.");
  }
  for (const name of Reflect.ownKeys(hooks)) {
    if (typeof name !== "string" || !PACKAGING_HOOK_NAMES.includes(name) || typeof hooks[name] !== "function") {
      throw new TypeError("package-current-channel hooks must use only the reviewed function-valued hook names.");
    }
  }
}

export async function packageCurrentChannel(
  { arguments_, packageJson, repositoryRoot = root } = {},
  {
    assertCanonicalArchive = assertReproducibleVsixArchive,
    assertPackageInventory = assertInstalledPerformancePackageInventory,
    assertPackageSources = assertNoPackageableUntrackedFiles,
    assertSamePackageSources = assertSameInstalledPerformancePackageSources,
    canonicalizeArchive = canonicalizeVsixArchive,
    createVsix = createVSIX,
    inspectArchive = inspectVsixArchive,
    linkFile = linkSync,
    pinGitModes = ({ cwd }) => readGitTrackedModes({ cwd }),
    readVsixSnapshot = readBoundedVsixFileSnapshot,
    removeDirectory = removePinnedPrivateDirectory,
    removeOwnedFile = removeOwnedName,
    syncDirectory = fsyncDirectory,
    unlinkFile = unlinkSync,
    writeCanonicalCandidate = writeExclusiveCanonicalCandidate,
    hooks = {}
  } = {}
) {
  if (typeof repositoryRoot !== "string" || !isAbsolute(repositoryRoot)) {
    throw new TypeError("package-current-channel requires one absolute repository root.");
  }
  validatePackagingDependencies(
    {
      assertCanonicalArchive,
      assertPackageInventory,
      assertPackageSources,
      assertSamePackageSources,
      canonicalizeArchive,
      createVsix,
      inspectArchive,
      linkFile,
      pinGitModes,
      readVsixSnapshot,
      removeDirectory,
      removeOwnedFile,
      syncDirectory,
      unlinkFile,
      writeCanonicalCandidate
    },
    hooks
  );
  const request = resolveCurrentChannelPackageRequest({ arguments_, packageJson });
  const repository = realpathSync(repositoryRoot);
  if (repository !== repositoryRoot) {
    throw new Error("package-current-channel requires the canonical repository-root path.");
  }
  const output = resolve(repository, request.output);
  if (basename(output).length === 0 || dirname(output) === output) {
    throw new Error("Package output must name one file below an existing directory.");
  }
  const parent = capturePinnedDirectory(dirname(output), "Package output parent");
  const packageSource = await assertPackageSources();
  assertPackageOutputSeparated(output, packageSource, repository);
  assertPathAbsent(output, "Package output");
  const trackedModes = pinGitModes({ cwd: repository });
  for (const { path } of packageSource.trackedFiles) {
    if (!trackedModes.has(path)) throw new Error("Package source is missing its tracked Git index mode.");
  }

  let privateDirectory;
  let rawPath;
  let rawIdentity;
  let stagePath;
  let stageIdentity;
  let publicIdentityReceipt;
  let publicationStarted = false;
  let primaryError;
  let result;
  try {
    revalidatePinnedDirectory(parent, "Package output parent");
    const privatePath = mkdtempSync(join(parent.path, PRIVATE_DIRECTORY_PREFIX));
    const createdPrivateIdentity = readNamedIdentity(privatePath, "Packaging private directory");
    if (!createdPrivateIdentity.isDirectory()) {
      throw new Error("Packaging private directory creation did not return one directory.");
    }
    requireCurrentOwner(createdPrivateIdentity, "Packaging private directory");
    chmodSync(privatePath, 0o700);
    privateDirectory = capturePinnedDirectory(privatePath, "Packaging private directory", {
      privateDirectory: true
    });
    if (!sameNode(createdPrivateIdentity, privateDirectory.identity)) {
      throw new Error("Packaging private directory changed while its permissions were established.");
    }
    syncDirectory(parent.path);
    hooks.afterPrivateDirectoryCreated?.({ output, privatePath });

    rawPath = join(privatePath, RAW_CANDIDATE_NAME);
    stagePath = join(privatePath, `${randomUUID()}-${CANONICAL_CANDIDATE_NAME}`);
    assertPathAbsent(rawPath, "Raw VSIX candidate");
    assertPathAbsent(stagePath, "Canonical VSIX staging path");
    await createVsix({
      allowMissingRepository: false,
      allowStarActivation: false,
      cwd: repository,
      gitHubIssueLinking: false,
      packagePath: rawPath,
      preRelease: request.channel === "preview"
    });
    rawIdentity = captureOwnedRegularFile(rawPath, "Raw VSIX candidate");
    hooks.afterRawCandidateCreated?.({ output, privatePath, rawPath });
    const rawSnapshot = readVsixSnapshot(rawPath, { requireOwner: true });
    requireNamedFileSnapshot(rawPath, rawIdentity, "Raw VSIX candidate", { links: [1n] });

    const afterRawSource = await assertPackageSources();
    assertSamePackageSources(packageSource, afterRawSource);
    const rawArchive = await inspectArchive(rawSnapshot.bytes);
    assertPackageInventory(packageSource, rawArchive.archiveEntries, rawArchive.entryDigests);

    const canonical = await canonicalizeArchive(rawSnapshot.bytes);
    const afterCanonicalSource = await assertPackageSources();
    assertSamePackageSources(packageSource, afterCanonicalSource);
    const canonicalArchive = await inspectArchive(canonical.bytes);
    assertSameArchiveInventory(rawArchive, canonicalArchive);
    assertPackageInventory(packageSource, canonicalArchive.archiveEntries, canonicalArchive.entryDigests);

    stageIdentity = writeCanonicalCandidate(stagePath, canonical.bytes);
    hooks.afterCanonicalStaged?.({ output, privatePath, rawPath, stagePath });
    const stagedSnapshot = readVsixSnapshot(stagePath, { requireOwner: true });
    requireNamedFileSnapshot(stagePath, stageIdentity, "Canonical VSIX staging", { links: [1n] });
    if (!stagedSnapshot.bytes.equals(canonical.bytes)) {
      throw new Error("Canonical VSIX staging changed the canonical candidate bytes.");
    }
    const stagedReceipt = await assertCanonicalArchive(stagedSnapshot.bytes);
    assertCanonicalReceiptMatches(canonical.receipt, stagedReceipt);

    removeOwnedFile(rawPath, rawIdentity, "Raw VSIX candidate");
    rawIdentity = undefined;
    syncDirectory(privatePath);
    revalidatePinnedDirectory(privateDirectory, "Packaging private directory", { privateDirectory: true });
    revalidatePinnedDirectory(parent, "Package output parent");
    assertPathAbsent(output, "Package output");
    hooks.beforePublish?.({ output, privatePath, stagePath });
    revalidatePinnedDirectory(parent, "Package output parent");
    revalidatePinnedDirectory(privateDirectory, "Packaging private directory", { privateDirectory: true });
    requireNamedFileSnapshot(stagePath, stageIdentity, "Canonical VSIX staging", { links: [1n] });
    assertPathAbsent(output, "Package output");

    publicationStarted = true;
    publicIdentityReceipt = stageIdentity;
    linkFile(stagePath, output);
    syncDirectory(parent.path);
    syncDirectory(privatePath);
    const linkedStage = readNamedIdentity(stagePath, "Linked canonical VSIX staging");
    const linkedOutput = readNamedIdentity(output, "Linked package output");
    if (
      !linkedStage.isFile() ||
      !linkedOutput.isFile() ||
      !sameNode(linkedStage, stageIdentity) ||
      !sameNode(linkedOutput, stageIdentity) ||
      linkedStage.nlink !== 2n ||
      linkedOutput.nlink !== 2n
    ) {
      throw new Error("Atomic package publication did not create the exact two-name transition.");
    }
    hooks.afterLink?.({ output, privatePath, stagePath });
    const verifiedLinkedOutput = readNamedIdentity(output, "Linked package output");
    const verifiedLinkedStage = readNamedIdentity(stagePath, "Linked canonical VSIX staging");
    if (
      !sameNode(verifiedLinkedOutput, stageIdentity) ||
      !sameNode(verifiedLinkedStage, stageIdentity) ||
      verifiedLinkedOutput.nlink !== 2n ||
      verifiedLinkedStage.nlink !== 2n
    ) {
      throw new Error("Atomic package publication changed before staging-name retirement.");
    }

    unlinkFile(stagePath);
    stageIdentity = undefined;
    hooks.afterStagingUnlink?.({ output, privatePath, stagePath });
    assertPathAbsent(stagePath, "Retired canonical VSIX staging path");
    syncDirectory(privatePath);
    syncDirectory(parent.path);
    const publicIdentity = captureOwnedRegularFile(output, "Published package output");
    if (
      publicIdentity.nlink !== 1n ||
      !sameNode(publicIdentity, verifiedLinkedOutput) ||
      !isPortableHostPackageFileMode(publicIdentity.mode)
    ) {
      throw new Error("Published package output must retain exactly one name and the required writable host mode.");
    }
    publicIdentityReceipt = publicIdentity;

    hooks.beforeFinalRead?.({ output, privatePath });
    const finalSnapshot = readVsixSnapshot(output, { requireOwner: true });
    requireNamedFileSnapshot(output, publicIdentity, "Published package output", { links: [1n] });
    if (!finalSnapshot.bytes.equals(stagedSnapshot.bytes)) {
      throw new Error("Published package output changed after atomic publication.");
    }
    const finalArchive = await inspectArchive(finalSnapshot.bytes);
    assertSameArchiveInventory(canonicalArchive, finalArchive);
    assertPackageInventory(packageSource, finalArchive.archiveEntries, finalArchive.entryDigests);
    const finalModes = pinGitModes({ cwd: repository });
    const finalSource = await assertPackageSources();
    assertSamePackageSources(packageSource, finalSource);
    for (const { path } of packageSource.trackedFiles) {
      if (finalModes.get(path) !== trackedModes.get(path)) {
        throw new Error("Packaged source Git index mode changed during package creation.");
      }
    }
    requireNamedFileSnapshot(output, publicIdentity, "Published package output", { links: [1n] });

    removeDirectory(privateDirectory);
    privateDirectory = undefined;
    syncDirectory(parent.path);
    revalidatePinnedDirectory(parent, "Package output parent");
    requireNamedFileSnapshot(output, publicIdentity, "Published package output", { links: [1n] });
    result = freezePackageResult({
      output,
      snapshot: finalSnapshot,
      receipt: stagedReceipt
    });
  } catch (error) {
    primaryError = error;
  }

  const cleanupErrors = [];
  if (primaryError !== undefined && publicationStarted && publicIdentityReceipt !== undefined) {
    try {
      removeOwnedFile(output, publicIdentityReceipt, "Published package output");
      syncDirectory(parent.path);
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  for (const [path, identity, label] of [
    [stagePath, stageIdentity, "Canonical VSIX staging"],
    [rawPath, rawIdentity, "Raw VSIX candidate"]
  ]) {
    if (path === undefined || identity === undefined) continue;
    try {
      removeOwnedFile(path, identity, label);
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  if (privateDirectory !== undefined) {
    try {
      removeDirectory(privateDirectory);
      syncDirectory(parent.path);
    } catch (error) {
      cleanupErrors.push(error);
    }
  }

  const failures = [primaryError, ...cleanupErrors].filter((error) => error !== undefined);
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) {
    throw new AggregateError(failures, "Canonical package creation and verified cleanup both failed.");
  }
  if (result === undefined) throw new Error("Canonical package creation completed without a result.");
  return result;
}

async function runCli() {
  await packageCurrentChannel({
    arguments_: process.argv.slice(2),
    packageJson: readFileSync(resolve(root, "package.json"), "utf8"),
    repositoryRoot: root
  });
}

if (process.argv[1] !== undefined && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  await runCli();
}
