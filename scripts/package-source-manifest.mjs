import { execFileSync } from "node:child_process";
import { TextDecoder } from "node:util";
import { parseStrictJson } from "./strict-json.mjs";

export const PACKAGE_SOURCE_MANIFEST_PROTOCOL = "openwrangler-package-source-manifest-v1";

const MAX_ARCHIVE_ENTRIES = 4096;
const MAX_ENTRY_PATH_BYTES = 1024;
const MAX_ENTRY_BYTES = 32 * 1024 * 1024;
const MAX_ARCHIVE_BYTES = 256 * 1024 * 1024;
const MAX_GIT_INDEX_ENTRIES = 65_536;
const MAX_GIT_INDEX_BYTES = 16 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 4 * 1024 * 1024;
const GIT_TIMEOUT_MS = 10_000;
const SHA256 = /^[0-9a-f]{64}$/u;
const GIT_OBJECT_ID = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u;
const WINDOWS_RESERVED_BASENAME = /^(?:aux|com[1-9¹²³]|con|lpt[1-9¹²³]|nul|prn)$/iu;
const WINDOWS_INVALID_CHARACTERS = new Set('<>:"|?*');
const PORTABLE_MODES = new Set(["100644", "100755"]);
const VSCE_METADATA_PATHS = Object.freeze(["[Content_Types].xml", "extension.vsixmanifest"]);

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function requireExactKeys(value, expected, label) {
  if (!isPlainObject(value)) {
    throw new TypeError(`${label} must be one plain object.`);
  }
  const actual = Reflect.ownKeys(value);
  if (
    actual.some((key) => typeof key !== "string") ||
    actual.length !== expected.length ||
    expected.some((key) => !Object.hasOwn(value, key))
  ) {
    throw new Error(`${label} must contain only its exact contract fields.`);
  }
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

function bytewiseCompare(left, right) {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
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

function archivePathForSource(sourcePath) {
  portablePathIdentity(sourcePath, "Package source path");
  const lower = sourcePath.toLowerCase();
  if (lower === "readme.md") return "extension/readme.md";
  if (lower === "changelog.md") return "extension/changelog.md";
  if (lower === "license" || lower === "license.txt" || lower === "license.md") {
    return "extension/LICENSE.txt";
  }
  return `extension/${sourcePath}`;
}

function requireDigest(value, label) {
  if (typeof value !== "string" || !SHA256.test(value)) {
    throw new Error(`${label} must be one lowercase SHA-256 digest.`);
  }
  return value;
}

function requireBoundedBytes(value, label, { nonEmpty = false } = {}) {
  if (!Number.isSafeInteger(value) || value < (nonEmpty ? 1 : 0) || value > MAX_ENTRY_BYTES) {
    throw new Error(`${label} exceeds its bounded byte size.`);
  }
  return value;
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

function requireFileIdentity(identity, bytes, label) {
  if (
    !isPlainObject(identity) ||
    !["dev", "ino", "size", "mtimeNs", "ctimeNs"].every(
      (field) => Object.hasOwn(identity, field) && typeof identity[field] === "bigint"
    ) ||
    identity.size !== BigInt(bytes)
  ) {
    throw new Error(`${label} does not contain its existing pinned file identity.`);
  }
}

function normalizePackageSources(packageSource, trackedModes) {
  if (
    !isPlainObject(packageSource) ||
    !Array.isArray(packageSource.packageFiles) ||
    !Array.isArray(packageSource.trackedFiles) ||
    !Array.isArray(packageSource.generatedFiles) ||
    packageSource.packageFiles.length === 0 ||
    packageSource.packageFiles.length > MAX_ARCHIVE_ENTRIES - VSCE_METADATA_PATHS.length
  ) {
    throw new TypeError("Package-source manifest requires one bounded package-source receipt.");
  }

  const packageFiles = packageSource.packageFiles.map((path) => {
    portablePathIdentity(path, "Package source path");
    return path;
  });
  requireCollisionFreePaths(packageFiles, "Package source paths");
  const packageFileSet = new Set(packageFiles);
  const modes = normalizeTrackedModes(trackedModes);
  const seenSources = new Set();
  const sources = [];
  let packageSourceBytes = 0;

  for (const [collection, sourceKind] of [
    [packageSource.trackedFiles, "tracked"],
    [packageSource.generatedFiles, "generated"]
  ]) {
    for (const receipt of collection) {
      if (!isPlainObject(receipt)) {
        throw new Error(`Package-source ${sourceKind} receipt must be one object.`);
      }
      const { path: sourcePath, archiveEntry, bytes, sha256, fileIdentity } = receipt;
      portablePathIdentity(sourcePath, `Package-source ${sourceKind} path`);
      const archivePath = archivePathForSource(sourcePath);
      if (archiveEntry !== archivePath || !packageFileSet.has(sourcePath) || seenSources.has(sourcePath)) {
        throw new Error(`Package-source ${sourceKind} receipt does not map one unique package source.`);
      }
      requireBoundedBytes(bytes, `Package-source ${sourceKind} bytes`, { nonEmpty: sourceKind === "generated" });
      requireDigest(sha256, `Package-source ${sourceKind} digest`);
      requireFileIdentity(fileIdentity, bytes, `Package-source ${sourceKind} receipt`);
      const mode = sourceKind === "generated" ? "100644" : modes.get(sourcePath);
      if (mode === undefined) {
        throw new Error("Package-source manifest is missing one tracked Git index mode.");
      }
      packageSourceBytes += bytes;
      if (!Number.isSafeInteger(packageSourceBytes) || packageSourceBytes > MAX_ARCHIVE_BYTES) {
        throw new Error("Package sources exceed their aggregate byte budget.");
      }
      seenSources.add(sourcePath);
      sources.push({ archivePath, sourcePath, sourceKind, mode, bytes, sha256 });
    }
  }

  if (seenSources.size !== packageFileSet.size || packageFiles.some((path) => !seenSources.has(path))) {
    throw new Error("Package-source receipt is missing or adds one package source.");
  }
  requireCollisionFreePaths(
    sources.map(({ archivePath }) => archivePath),
    "Mapped package archive paths"
  );
  return { packageSourceBytes, sources };
}

function normalizeArchivePairs(items, kind) {
  if (!Array.isArray(items) || items.length > MAX_ARCHIVE_ENTRIES) {
    throw new TypeError(`Inspected VSIX ${kind} must be one bounded array.`);
  }
  const values = new Map();
  for (const item of items) {
    if (!Array.isArray(item) || item.length !== 2) {
      throw new Error(`Inspected VSIX ${kind} contains a malformed entry.`);
    }
    const [archivePath, value] = item;
    portablePathIdentity(archivePath, `Inspected VSIX ${kind} path`);
    if (values.has(archivePath)) {
      throw new Error(`Inspected VSIX ${kind} contains a duplicate archive path.`);
    }
    if (kind === "entry digests") {
      requireDigest(value, "Inspected VSIX entry digest");
    } else {
      requireBoundedBytes(value, "Inspected VSIX entry bytes");
    }
    values.set(archivePath, value);
  }
  requireCollisionFreePaths([...values.keys()], `Inspected VSIX ${kind} paths`);
  return values;
}

function normalizeArchive(archive, expectedSources) {
  if (
    !isPlainObject(archive) ||
    !Array.isArray(archive.archiveEntries) ||
    archive.archiveEntries.length === 0 ||
    archive.archiveEntries.length > MAX_ARCHIVE_ENTRIES
  ) {
    throw new TypeError("Package-source manifest requires one fully inspected bounded VSIX archive.");
  }
  const archiveEntries = archive.archiveEntries.map((archivePath) => {
    portablePathIdentity(archivePath, "Inspected VSIX archive path");
    return archivePath;
  });
  requireCollisionFreePaths(archiveEntries, "Inspected VSIX archive paths");
  const archiveEntrySet = new Set(archiveEntries);
  if (archiveEntrySet.size !== archiveEntries.length) {
    throw new Error("Inspected VSIX archive entries must be unique.");
  }
  const digests = normalizeArchivePairs(archive.entryDigests, "entry digests");
  const sizes = normalizeArchivePairs(archive.entrySizes, "entry sizes");
  for (const values of [digests, sizes]) {
    if (
      values.size !== archiveEntrySet.size ||
      archiveEntries.some((archivePath) => !values.has(archivePath)) ||
      [...values.keys()].some((archivePath) => !archiveEntrySet.has(archivePath))
    ) {
      throw new Error("Inspected VSIX archive entries, digests, and sizes must cover the exact same paths.");
    }
  }
  if (archive.entryCount !== undefined && archive.entryCount !== archiveEntries.length) {
    throw new Error("Inspected VSIX entry count is inconsistent with its archive inventory.");
  }

  const expectedPaths = [...VSCE_METADATA_PATHS, ...expectedSources.map(({ archivePath }) => archivePath)];
  requireCollisionFreePaths(expectedPaths, "Expected package archive paths");
  const expectedPathSet = new Set(expectedPaths);
  if (
    expectedPathSet.size !== archiveEntrySet.size ||
    expectedPaths.some((archivePath) => !archiveEntrySet.has(archivePath)) ||
    archiveEntries.some((archivePath) => !expectedPathSet.has(archivePath))
  ) {
    throw new Error("Inspected VSIX is missing or adds one package source or VSCE metadata entry.");
  }

  let archiveBytes = 0;
  for (const archivePath of archiveEntries) {
    archiveBytes += sizes.get(archivePath);
    if (!Number.isSafeInteger(archiveBytes) || archiveBytes > MAX_ARCHIVE_BYTES) {
      throw new Error("Inspected VSIX entries exceed their aggregate byte budget.");
    }
  }
  for (const source of expectedSources) {
    if (digests.get(source.archivePath) !== source.sha256 || sizes.get(source.archivePath) !== source.bytes) {
      throw new Error("Inspected VSIX package source bytes drifted from the pinned package inputs.");
    }
  }
  for (const archivePath of VSCE_METADATA_PATHS) {
    requireBoundedBytes(sizes.get(archivePath), "VSCE-generated metadata bytes", { nonEmpty: true });
  }
  return { archiveBytes, digests, sizes };
}

function makeEntry({ archivePath, sourcePath, sourceKind, mode, bytes, sha256 }) {
  return Object.freeze({ archivePath, sourcePath, sourceKind, mode, bytes, sha256 });
}

function makeTotals({ archiveEntries, archiveBytes, packageSources, packageSourceBytes, metadataBytes }) {
  return Object.freeze({
    archiveEntries,
    archiveBytes,
    packageSources,
    packageSourceBytes,
    vsceMetadataEntries: VSCE_METADATA_PATHS.length,
    vsceMetadataBytes: metadataBytes
  });
}

function buildExpectedManifest({ packageSource, archive, trackedModes }) {
  const { packageSourceBytes, sources } = normalizePackageSources(packageSource, trackedModes);
  const { archiveBytes, digests, sizes } = normalizeArchive(archive, sources);
  const entries = [
    ...sources,
    ...VSCE_METADATA_PATHS.map((archivePath) => ({
      archivePath,
      sourcePath: null,
      sourceKind: null,
      mode: "100644",
      bytes: sizes.get(archivePath),
      sha256: digests.get(archivePath)
    }))
  ]
    .sort((left, right) => bytewiseCompare(left.archivePath, right.archivePath))
    .map(makeEntry);
  const metadataBytes = VSCE_METADATA_PATHS.reduce((total, archivePath) => total + sizes.get(archivePath), 0);
  return Object.freeze({
    protocol: PACKAGE_SOURCE_MANIFEST_PROTOCOL,
    entries: Object.freeze(entries),
    totals: makeTotals({
      archiveEntries: entries.length,
      archiveBytes,
      packageSources: sources.length,
      packageSourceBytes,
      metadataBytes
    })
  });
}

function canonicalizeManifest(manifest) {
  requireExactKeys(manifest, ["protocol", "entries", "totals"], "Package-source manifest");
  if (manifest.protocol !== PACKAGE_SOURCE_MANIFEST_PROTOCOL) {
    throw new Error("Package-source manifest protocol is unsupported.");
  }
  if (
    !Array.isArray(manifest.entries) ||
    manifest.entries.length < VSCE_METADATA_PATHS.length + 1 ||
    manifest.entries.length > MAX_ARCHIVE_ENTRIES
  ) {
    throw new Error("Package-source manifest entries must be one bounded non-empty array.");
  }

  const entries = [];
  const archivePaths = [];
  const sourcePaths = [];
  let packageSources = 0;
  let packageSourceBytes = 0;
  let metadataEntries = 0;
  let metadataBytes = 0;
  let archiveBytes = 0;
  for (const entry of manifest.entries) {
    requireExactKeys(
      entry,
      ["archivePath", "sourcePath", "sourceKind", "mode", "bytes", "sha256"],
      "Package-source manifest entry"
    );
    const { archivePath, sourcePath, sourceKind, mode, bytes, sha256 } = entry;
    portablePathIdentity(archivePath, "Package-source manifest archive path");
    requireDigest(sha256, "Package-source manifest digest");
    const isMetadata = VSCE_METADATA_PATHS.includes(archivePath);
    if (isMetadata) {
      if (sourcePath !== null || sourceKind !== null || mode !== "100644") {
        throw new Error("VSCE-generated metadata entries must use their exact portable contract.");
      }
      requireBoundedBytes(bytes, "VSCE-generated metadata bytes", { nonEmpty: true });
      metadataEntries += 1;
      metadataBytes += bytes;
    } else {
      portablePathIdentity(sourcePath, "Package-source manifest source path");
      if (!new Set(["tracked", "generated"]).has(sourceKind)) {
        throw new Error("Package-source manifest source kind must be tracked or generated.");
      }
      if (archivePathForSource(sourcePath) !== archivePath) {
        throw new Error("Package-source manifest source path does not map to its archive path.");
      }
      if (!PORTABLE_MODES.has(mode) || (sourceKind === "generated" && mode !== "100644")) {
        throw new Error("Package-source manifest entry uses a noncanonical portable mode.");
      }
      requireBoundedBytes(bytes, "Package-source manifest source bytes", { nonEmpty: sourceKind === "generated" });
      sourcePaths.push(sourcePath);
      packageSources += 1;
      packageSourceBytes += bytes;
    }
    archivePaths.push(archivePath);
    archiveBytes += bytes;
    if (
      !Number.isSafeInteger(archiveBytes) ||
      !Number.isSafeInteger(packageSourceBytes) ||
      !Number.isSafeInteger(metadataBytes) ||
      archiveBytes > MAX_ARCHIVE_BYTES
    ) {
      throw new Error("Package-source manifest aggregate bytes exceed their bound.");
    }
    entries.push(makeEntry({ archivePath, sourcePath, sourceKind, mode, bytes, sha256 }));
  }
  requireCollisionFreePaths(archivePaths, "Package-source manifest archive paths");
  requireCollisionFreePaths(sourcePaths, "Package-source manifest source paths");
  for (let index = 1; index < entries.length; index += 1) {
    if (bytewiseCompare(entries[index - 1].archivePath, entries[index].archivePath) >= 0) {
      throw new Error("Package-source manifest entries must use exact UTF-8 bytewise archive-path order.");
    }
  }
  if (
    metadataEntries !== VSCE_METADATA_PATHS.length ||
    VSCE_METADATA_PATHS.some((archivePath) => !archivePaths.includes(archivePath))
  ) {
    throw new Error("Package-source manifest must contain exactly both VSCE-generated metadata entries.");
  }

  requireExactKeys(
    manifest.totals,
    [
      "archiveEntries",
      "archiveBytes",
      "packageSources",
      "packageSourceBytes",
      "vsceMetadataEntries",
      "vsceMetadataBytes"
    ],
    "Package-source manifest totals"
  );
  const expectedTotals = makeTotals({
    archiveEntries: entries.length,
    archiveBytes,
    packageSources,
    packageSourceBytes,
    metadataBytes
  });
  for (const [key, value] of Object.entries(expectedTotals)) {
    if (manifest.totals[key] !== value) {
      throw new Error("Package-source manifest aggregate accounting is inconsistent.");
    }
  }
  return Object.freeze({
    protocol: PACKAGE_SOURCE_MANIFEST_PROTOCOL,
    entries: Object.freeze(entries),
    totals: expectedTotals
  });
}

function serializeCanonicalManifest(manifest) {
  return Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}

export function buildPackageSourceManifest({ packageSource, archive, trackedModes } = {}) {
  return canonicalizeManifest(buildExpectedManifest({ packageSource, archive, trackedModes }));
}

export function validatePackageSourceManifest(manifest, bindings) {
  const canonical = canonicalizeManifest(manifest);
  if (bindings !== undefined) {
    requireExactKeys(bindings, ["packageSource", "archive", "trackedModes"], "Package-source bindings");
    const expected = canonicalizeManifest(buildExpectedManifest(bindings));
    if (!serializeCanonicalManifest(canonical).equals(serializeCanonicalManifest(expected))) {
      throw new Error("Package-source manifest drifted from its pinned package sources or inspected VSIX.");
    }
  }
  return canonical;
}

export function serializePackageSourceManifest(manifest) {
  const bytes = serializeCanonicalManifest(validatePackageSourceManifest(manifest));
  if (bytes.length > MAX_MANIFEST_BYTES) {
    throw new Error("Package-source manifest exceeds its serialized byte bound.");
  }
  return bytes;
}

function decodeManifestBytes(input) {
  let bytes;
  if (typeof input === "string") {
    bytes = Buffer.from(input, "utf8");
  } else if (Buffer.isBuffer(input) || input instanceof Uint8Array) {
    bytes = Buffer.from(input);
  } else {
    throw new TypeError("Package-source manifest input must be UTF-8 bytes or text.");
  }
  if (bytes.length === 0 || bytes.length > MAX_MANIFEST_BYTES) {
    throw new Error("Package-source manifest input exceeds its bounded byte size.");
  }
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch (error) {
    throw new Error("Package-source manifest must contain valid UTF-8.", { cause: error });
  }
  return { bytes, text };
}

export function parsePackageSourceManifest(input) {
  const { bytes, text } = decodeManifestBytes(input);
  const canonical = validatePackageSourceManifest(parseStrictJson(text));
  if (!bytes.equals(serializeCanonicalManifest(canonical))) {
    throw new Error("Package-source manifest bytes are not in canonical JSON form.");
  }
  return canonical;
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
