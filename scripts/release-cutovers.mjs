import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  opendirSync,
  realpathSync,
  writeFileSync
} from "node:fs";
import { dirname, posix, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { TextDecoder } from "node:util";
import { readBoundedRegularFile } from "./bounded-file-read.mjs";
import { parseStrictJson } from "./strict-json.mjs";

const ROOT = resolve(import.meta.dirname, "..");
const MANIFEST_PATH = "fixtures/release-cutovers.v1.json";
const DOCUMENTATION_PATH = "docs/releasing.md";
const DOCUMENTATION_START = "<!-- release-cutovers:start -->";
const DOCUMENTATION_END = "<!-- release-cutovers:end -->";
const MAX_MANIFEST_BYTES = 32 * 1024;
const MAX_CONSUMER_BYTES = 2 * 1024 * 1024;
const MAX_CUTOVERS = 16;
const MAX_CONSUMERS_PER_CUTOVER = 16;
const MAX_CONSUMER_INVENTORY = 64;
const MAX_TEXT_BYTES = 1_024;
const MAX_REPOSITORY_PATH_BYTES = 256;
const MAX_REPOSITORY_SCAN_ENTRIES = 4_096;
const MAX_REPOSITORY_SCAN_BYTES = 64 * 1024 * 1024;
const MAX_JAVASCRIPT_TOKENS = 262_144;
const MAX_SEMVER_COMPONENT_DIGITS = 128;
const STABLE_ID = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u;
const STABLE_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u;
const SEMANTIC_VERSION =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;
const EXECUTABLE_OWNER = /^scripts\/[a-z0-9][a-z0-9.-]*\.mjs$/u;
const CONSUMER_PATH =
  /^(?:\.github\/workflows\/[a-z0-9][a-z0-9.-]*\.ya?ml|azure-pipelines-marketplace\.yml|docs\/[a-z0-9][a-z0-9./-]*\.md|scripts\/[a-z0-9][a-z0-9.-]*\.mjs)$/u;
const UNSAFE_PLAIN_TEXT = /[\\`*_{}()<>&#!|~]|\[|\]/u;
const UNSAFE_UNICODE = /[\p{Cc}\p{Cs}\p{Co}\p{Zl}\p{Zp}\p{Bidi_Control}\p{Default_Ignorable_Code_Point}]/u;
const ENTRY_KEYS = Object.freeze([
  "affectedCapability",
  "consumers",
  "executableOwner",
  "firstApplicableVersion",
  "id",
  "rationale",
  "recoveryBehavior"
]);
const CONSUMER_INVENTORY_KEYS = Object.freeze(["cutoverIds", "path"]);
const NON_CONSUMER_AUTHORITY_PATHS = Object.freeze(
  new Set(["scripts/release-cutovers.mjs", "scripts/release-cutovers.test.mjs"])
);

export const RELEASE_CUTOVER_BOUNDARY_TEST_PATHS = Object.freeze([
  "scripts/public-media-surfaces.test.mjs",
  "scripts/release-cutovers.test.mjs"
]);

const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

function exactKeys(value, expected) {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...expected].sort())
  );
}

function boundedText(value, label) {
  if (typeof value !== "string" || value.trim() !== value || value.length === 0) {
    throw new Error(`${label} must be one non-empty trimmed string.`);
  }
  if (Buffer.byteLength(value, "utf8") > MAX_TEXT_BYTES) {
    throw new Error(`${label} exceeds its ${MAX_TEXT_BYTES}-byte bound.`);
  }
  if (value.normalize("NFC") !== value) {
    throw new Error(`${label} must use NFC Unicode.`);
  }
  if (UNSAFE_UNICODE.test(value)) {
    throw new Error(`${label} must not contain control, private, surrogate, or default-ignorable characters.`);
  }
  if (UNSAFE_PLAIN_TEXT.test(value)) {
    throw new Error(`${label} must contain plain text without Markdown or HTML metacharacters.`);
  }
  return value;
}

function freezeManifest(manifest) {
  for (const cutover of manifest.cutovers) {
    Object.freeze(cutover.consumers);
    Object.freeze(cutover);
  }
  for (const consumer of manifest.consumerInventory) {
    Object.freeze(consumer.cutoverIds);
    Object.freeze(consumer);
  }
  Object.freeze(manifest.cutovers);
  Object.freeze(manifest.consumerInventory);
  return Object.freeze(manifest);
}

function canonicalRepositoryPath(value, label, { consumer = false } = {}) {
  const path = boundedText(value, label);
  if (
    Buffer.byteLength(path, "utf8") > MAX_REPOSITORY_PATH_BYTES ||
    path.startsWith("/") ||
    path.endsWith("/") ||
    path.includes("\\") ||
    path.includes("//") ||
    posix.normalize(path) !== path
  ) {
    throw new Error(`${label} must be one byte-canonical repository-relative path.`);
  }
  const segments = path.split("/");
  if (segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")) {
    throw new Error(`${label} must not contain empty, dot, or dot-dot segments.`);
  }
  if (consumer && !CONSUMER_PATH.test(path)) {
    throw new Error(`${label} must be one canonical release-cutover consumer path.`);
  }
  return path;
}

function compareCanonicalNumericComponent(left, right) {
  if (left.length !== right.length) return left.length > right.length ? 1 : -1;
  return left === right ? 0 : left > right ? 1 : -1;
}

function parseSemanticVersion(version, label) {
  if (
    typeof version !== "string" ||
    Buffer.byteLength(version, "utf8") > MAX_TEXT_BYTES ||
    !SEMANTIC_VERSION.test(version)
  ) {
    throw new TypeError(`${label} must be semantic.`);
  }
  const coreAndPrerelease = version.split("+", 1)[0];
  const [core, prerelease] = coreAndPrerelease.split("-", 2);
  const components = core.split(".");
  if (components.some((component) => component.length > MAX_SEMVER_COMPONENT_DIGITS)) {
    throw new TypeError(`${label} has an oversized numeric component.`);
  }
  return Object.freeze({ components: Object.freeze(components), prerelease: prerelease !== undefined });
}

export function validateReleaseCutoverManifest(value) {
  if (!exactKeys(value, ["consumerInventory", "cutovers", "schemaVersion"])) {
    throw new Error("The release-cutover manifest must contain only schemaVersion, cutovers, and consumerInventory.");
  }
  if (value.schemaVersion !== 1) {
    throw new Error("The release-cutover manifest schemaVersion must be 1.");
  }
  if (!Array.isArray(value.cutovers) || value.cutovers.length === 0 || value.cutovers.length > MAX_CUTOVERS) {
    throw new Error(`The release-cutover manifest must contain 1..${MAX_CUTOVERS} cutovers.`);
  }

  const ids = new Set();
  const versions = new Set();
  const cutovers = value.cutovers.map((candidate, index) => {
    const label = `Release cutover ${index + 1}`;
    if (!exactKeys(candidate, ENTRY_KEYS)) {
      throw new Error(`${label} must contain exactly ${ENTRY_KEYS.join(", ")}.`);
    }
    const id = boundedText(candidate.id, `${label} id`);
    if (!STABLE_ID.test(id)) throw new Error(`${label} id must be one stable lowercase identifier.`);
    if (ids.has(id)) throw new Error(`Release cutover id ${id} is duplicated.`);
    ids.add(id);

    const firstApplicableVersion = boundedText(candidate.firstApplicableVersion, `${label} firstApplicableVersion`);
    if (!STABLE_VERSION.test(firstApplicableVersion)) {
      throw new Error(`${label} firstApplicableVersion must be one canonical stable semantic version.`);
    }
    parseSemanticVersion(firstApplicableVersion, `${label} firstApplicableVersion`);
    if (versions.has(firstApplicableVersion)) {
      throw new Error(`Release cutover version ${firstApplicableVersion} is duplicated.`);
    }
    versions.add(firstApplicableVersion);

    const executableOwner = canonicalRepositoryPath(candidate.executableOwner, `${label} executableOwner`, {
      consumer: true
    });
    if (!EXECUTABLE_OWNER.test(executableOwner)) {
      throw new Error(`${label} executableOwner must be one canonical scripts/*.mjs path.`);
    }
    if (
      !Array.isArray(candidate.consumers) ||
      candidate.consumers.length === 0 ||
      candidate.consumers.length > MAX_CONSUMERS_PER_CUTOVER
    ) {
      throw new Error(`${label} consumers must contain 1..${MAX_CONSUMERS_PER_CUTOVER} paths.`);
    }
    const consumers = candidate.consumers.map((value, consumerIndex) => {
      return canonicalRepositoryPath(value, `${label} consumer ${consumerIndex + 1}`, { consumer: true });
    });
    if (
      new Set(consumers).size !== consumers.length ||
      JSON.stringify(consumers) !== JSON.stringify([...consumers].sort())
    ) {
      throw new Error(`${label} consumers must be unique and bytewise sorted.`);
    }
    if (!consumers.includes(executableOwner)) {
      throw new Error(`${label} consumers must include its executable owner.`);
    }
    return {
      id,
      affectedCapability: boundedText(candidate.affectedCapability, `${label} affectedCapability`),
      consumers,
      firstApplicableVersion,
      rationale: boundedText(candidate.rationale, `${label} rationale`),
      recoveryBehavior: boundedText(candidate.recoveryBehavior, `${label} recoveryBehavior`),
      executableOwner
    };
  });

  if (
    !Array.isArray(value.consumerInventory) ||
    value.consumerInventory.length === 0 ||
    value.consumerInventory.length > MAX_CONSUMER_INVENTORY
  ) {
    throw new Error(`The release-cutover consumer inventory must contain 1..${MAX_CONSUMER_INVENTORY} entries.`);
  }
  const consumerInventory = value.consumerInventory.map((candidate, index) => {
    const label = `Release-cutover consumer inventory entry ${index + 1}`;
    if (!exactKeys(candidate, CONSUMER_INVENTORY_KEYS)) {
      throw new Error(`${label} must contain exactly ${CONSUMER_INVENTORY_KEYS.join(", ")}.`);
    }
    const path = canonicalRepositoryPath(candidate.path, `${label} path`, { consumer: true });
    if (
      !Array.isArray(candidate.cutoverIds) ||
      candidate.cutoverIds.length === 0 ||
      candidate.cutoverIds.length > MAX_CUTOVERS
    ) {
      throw new Error(`${label} cutoverIds must contain 1..${MAX_CUTOVERS} identifiers.`);
    }
    const cutoverIds = candidate.cutoverIds.map((id, cutoverIndex) => {
      const cutoverId = boundedText(id, `${label} cutover id ${cutoverIndex + 1}`);
      if (!STABLE_ID.test(cutoverId) || !ids.has(cutoverId)) {
        throw new Error(`${label} names an unknown release cutover ${JSON.stringify(cutoverId)}.`);
      }
      return cutoverId;
    });
    if (
      new Set(cutoverIds).size !== cutoverIds.length ||
      JSON.stringify(cutoverIds) !== JSON.stringify([...cutoverIds].sort())
    ) {
      throw new Error(`${label} cutoverIds must be unique and bytewise sorted.`);
    }
    return { path, cutoverIds };
  });
  const inventoryPaths = consumerInventory.map(({ path }) => path);
  if (
    new Set(inventoryPaths).size !== inventoryPaths.length ||
    JSON.stringify(inventoryPaths) !== JSON.stringify([...inventoryPaths].sort())
  ) {
    throw new Error("Release-cutover consumer inventory paths must be unique and bytewise sorted.");
  }
  const declaredAssociations = new Map();
  for (const cutover of cutovers) {
    for (const path of cutover.consumers) {
      const cutoverIds = declaredAssociations.get(path) ?? [];
      cutoverIds.push(cutover.id);
      declaredAssociations.set(path, cutoverIds);
    }
  }
  const inventoryAssociations = new Map(consumerInventory.map(({ path, cutoverIds }) => [path, cutoverIds]));
  for (const cutoverIds of declaredAssociations.values()) cutoverIds.sort();
  if (
    JSON.stringify([...declaredAssociations].sort()) !==
    JSON.stringify([...inventoryAssociations].map(([path, cutoverIds]) => [path, [...cutoverIds]]).sort())
  ) {
    throw new Error("Release-cutover consumer arrays and the independent consumer inventory must agree exactly.");
  }

  return freezeManifest({ schemaVersion: 1, consumerInventory, cutovers });
}

export function parseReleaseCutoverManifest(source) {
  if (typeof source !== "string" || Buffer.byteLength(source, "utf8") > MAX_MANIFEST_BYTES) {
    throw new Error(`The release-cutover manifest must be bounded to ${MAX_MANIFEST_BYTES} UTF-8 bytes.`);
  }
  return validateReleaseCutoverManifest(parseStrictJson(source, { maxBytes: MAX_MANIFEST_BYTES, maxDepth: 8 }));
}

export function renderReleaseCutoverManifest(manifest) {
  const validated = validateReleaseCutoverManifest(manifest);
  const serializable = JSON.parse(JSON.stringify(validated));
  const replacements = [];
  for (let index = 0; index < serializable.consumerInventory.length; index += 1) {
    const marker = `__OPEN_WRANGLER_CUTOVER_IDS_${index}__`;
    const cutoverIds = `[${serializable.consumerInventory[index].cutoverIds.map((id) => JSON.stringify(id)).join(", ")}]`;
    replacements.push([JSON.stringify(marker), cutoverIds]);
    serializable.consumerInventory[index].cutoverIds = marker;
  }
  let source = JSON.stringify(serializable, null, 2);
  for (const [marker, cutoverIds] of replacements) source = source.replace(marker, cutoverIds);
  return `${source}\n`;
}

export function readReleaseCutoverUtf8File(path, maximumBytes, options = {}) {
  const label = options.label ?? "Release-cutover file";
  let bytes;
  try {
    bytes = readBoundedRegularFile(path, maximumBytes, options);
  } catch (error) {
    throw new Error(`${label} could not be read through one stable file identity.`, { cause: error });
  }
  try {
    return UTF8_DECODER.decode(bytes);
  } catch (error) {
    throw new Error(`${label} must contain valid UTF-8.`, { cause: error });
  }
}

function repositoryMetadataSnapshot(metadata, label, { directory = false, maximumBytes } = {}) {
  if (
    (directory ? !metadata.isDirectory() : !metadata.isFile()) ||
    metadata.isSymbolicLink() ||
    (!directory &&
      (metadata.nlink !== 1n ||
        metadata.size <= 0n ||
        maximumBytes === undefined ||
        metadata.size > BigInt(maximumBytes)))
  ) {
    throw new Error(`${label} is not one bounded no-follow ${directory ? "directory" : "regular file"}.`);
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

function sameRepositoryMetadata(left, right) {
  return Object.keys(left).every((key) => left[key] === right[key]);
}

function throwReleaseCutoverFailures(failures) {
  if (failures.length === 0) return;
  if (failures.length === 1) throw failures[0];
  throw new AggregateError(failures, failures[0].message, { cause: failures[0] });
}

function attemptReleaseCutoverStep(failures, step) {
  try {
    return step();
  } catch (error) {
    failures.push(error);
    return undefined;
  }
}

function repositoryNamespacePaths(root) {
  const paths = [];
  for (let path = root; ; path = dirname(path)) {
    paths.push(path);
    if (dirname(path) === path) break;
  }
  return paths.reverse();
}

function captureRepositoryNamespace(root) {
  return Object.freeze(
    repositoryNamespacePaths(root).map((path) => {
      const metadata = repositoryMetadataSnapshot(lstatSync(path, { bigint: true }), "Repository namespace", {
        directory: true
      });
      if (realpathSync(path) !== path) {
        throw new Error("The release-cutover repository namespace must be byte-canonical and symlink-free.");
      }
      return Object.freeze({ metadata, path });
    })
  );
}

function assertRepositoryNamespaceCurrent(rootHandle) {
  try {
    for (const entry of rootHandle.namespace) {
      const current = repositoryMetadataSnapshot(lstatSync(entry.path, { bigint: true }), "Repository namespace", {
        directory: true
      });
      if (realpathSync(entry.path) !== entry.path || !sameRepositoryMetadata(entry.metadata, current)) {
        throw new Error(
          `The release-cutover repository namespace changed during its bounded scan at ${JSON.stringify(entry.path)}.`
        );
      }
    }
  } catch (error) {
    if (error instanceof Error && /repository namespace changed/u.test(error.message)) throw error;
    throw new Error("The release-cutover repository namespace changed during its bounded scan.", { cause: error });
  }
}

function withRepositoryNamespace(rootHandle, operation) {
  assertRepositoryNamespaceCurrent(rootHandle);
  const failures = [];
  const result = attemptReleaseCutoverStep(failures, operation);
  attemptReleaseCutoverStep(failures, () => assertRepositoryNamespaceCurrent(rootHandle));
  throwReleaseCutoverFailures(failures);
  return result;
}

function openRepositoryRoot(root) {
  if (typeof root !== "string" || resolve(root) !== root) {
    throw new Error("The release-cutover repository root must be one canonical absolute directory.");
  }
  const namespace = captureRepositoryNamespace(root);
  const descriptor = openSync(
    root,
    constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0) | (constants.O_CLOEXEC ?? 0)
  );
  try {
    const opened = repositoryMetadataSnapshot(fstatSync(descriptor, { bigint: true }), "Repository root", {
      directory: true
    });
    const named = repositoryMetadataSnapshot(lstatSync(root, { bigint: true }), "Repository root", {
      directory: true
    });
    if (!sameRepositoryMetadata(opened, named) || !sameRepositoryMetadata(opened, namespace.at(-1).metadata)) {
      throw new Error("The release-cutover repository root changed before its scan.");
    }
    const rootHandle = Object.freeze({ descriptor, namespace, opened });
    assertRepositoryNamespaceCurrent(rootHandle);
    return rootHandle;
  } catch (error) {
    const failures = [error];
    attemptReleaseCutoverStep(failures, () => closeSync(descriptor));
    throwReleaseCutoverFailures(failures);
  }
}

function assertRepositoryRootCurrent(root, rootHandle) {
  assertRepositoryNamespaceCurrent(rootHandle);
  const opened = repositoryMetadataSnapshot(fstatSync(rootHandle.descriptor, { bigint: true }), "Repository root", {
    directory: true
  });
  const named = repositoryMetadataSnapshot(lstatSync(root, { bigint: true }), "Repository root", {
    directory: true
  });
  if (
    realpathSync(root) !== root ||
    !sameRepositoryMetadata(rootHandle.opened, opened) ||
    !sameRepositoryMetadata(opened, named)
  ) {
    throw new Error("The release-cutover repository root changed during its complete scan.");
  }
  return named;
}

function captureRepositorySources(root, rootHandle, discoverPaths, options = {}) {
  const rootBefore = assertRepositoryRootCurrent(root, rootHandle);
  const discovered = withRepositoryNamespace(rootHandle, () => discoverPaths(rootHandle));
  if (!Array.isArray(discovered) || discovered.length === 0 || discovered.length > MAX_REPOSITORY_SCAN_ENTRIES) {
    throw new Error(`The release-cutover repository scan must contain 1..${MAX_REPOSITORY_SCAN_ENTRIES} paths.`);
  }
  const paths = discovered.map((path, index) => canonicalRepositoryPath(path, `Repository scan path ${index + 1}`));
  if (new Set(paths).size !== paths.length) {
    throw new Error("The release-cutover repository scan contains duplicate paths.");
  }
  paths.sort();

  let aggregateBytes = 0;
  const preflight = new Map();
  const identities = new Set();
  for (const path of paths) {
    const absolutePath = resolve(root, path);
    const maximumBytes = path === MANIFEST_PATH ? MAX_MANIFEST_BYTES : MAX_CONSUMER_BYTES;
    const metadata = withRepositoryNamespace(rootHandle, () => {
      if (realpathSync(absolutePath) !== absolutePath) {
        throw new Error(`${path} is not byte-canonical beneath the release-cutover repository root.`);
      }
      return repositoryMetadataSnapshot(lstatSync(absolutePath, { bigint: true }), path, { maximumBytes });
    });
    const identity = `${metadata.dev}:${metadata.ino}`;
    if (identities.has(identity)) {
      throw new Error(`${path} aliases another release-cutover repository file identity.`);
    }
    identities.add(identity);
    aggregateBytes += Number(metadata.size);
    if (aggregateBytes > MAX_REPOSITORY_SCAN_BYTES) {
      throw new Error(`The release-cutover repository scan exceeds ${MAX_REPOSITORY_SCAN_BYTES} bytes.`);
    }
    preflight.set(path, Object.freeze({ absolutePath, maximumBytes, metadata }));
  }

  const sources = new Map();
  const receipts = new Map();
  for (const path of paths) {
    const { absolutePath, maximumBytes, metadata } = preflight.get(path);
    const source = withRepositoryNamespace(rootHandle, () =>
      readReleaseCutoverUtf8File(absolutePath, maximumBytes, {
        afterOpenForTest: options.afterOpenForTest,
        containedBy: root,
        label: "Release-cutover repository source"
      })
    );
    const completed = withRepositoryNamespace(rootHandle, () => {
      const snapshot = repositoryMetadataSnapshot(lstatSync(absolutePath, { bigint: true }), path, { maximumBytes });
      if (realpathSync(absolutePath) !== absolutePath || !sameRepositoryMetadata(metadata, snapshot)) {
        throw new Error(`${path} changed across its release-cutover repository read.`);
      }
      return snapshot;
    });
    sources.set(path, source);
    receipts.set(path, completed);
  }
  const rootAfter = assertRepositoryRootCurrent(root, rootHandle);
  if (!sameRepositoryMetadata(rootBefore, rootAfter)) {
    throw new Error("The release-cutover repository root changed during one scan pass.");
  }
  return Object.freeze({ paths: Object.freeze(paths), receipts, root: rootAfter, sources });
}

function sameRepositoryView(left, right) {
  if (!sameRepositoryMetadata(left.root, right.root) || JSON.stringify(left.paths) !== JSON.stringify(right.paths)) {
    return false;
  }
  return left.paths.every(
    (path) =>
      left.sources.get(path) === right.sources.get(path) &&
      sameRepositoryMetadata(left.receipts.get(path), right.receipts.get(path))
  );
}

function readStableRepositorySources(root, discoverPaths, options = {}) {
  const { afterDirectoryOpenForTest, afterOpenForTest, betweenPassesForTest } = options;
  if (betweenPassesForTest !== undefined && typeof betweenPassesForTest !== "function") {
    throw new TypeError("The release-cutover between-pass hook must be a function.");
  }
  if (afterOpenForTest !== undefined && typeof afterOpenForTest !== "function") {
    throw new TypeError("The release-cutover after-open hook must be a function.");
  }
  if (afterDirectoryOpenForTest !== undefined && typeof afterDirectoryOpenForTest !== "function") {
    throw new TypeError("The release-cutover after-directory-open hook must be a function.");
  }
  const rootHandle = openRepositoryRoot(root);
  let restore;
  let first;
  let second;
  const failures = [];
  first = attemptReleaseCutoverStep(failures, () => captureRepositorySources(root, rootHandle, discoverPaths, options));
  if (failures.length === 0) {
    restore = attemptReleaseCutoverStep(failures, () =>
      betweenPassesForTest?.(Object.freeze({ rootDescriptor: rootHandle.descriptor }))
    );
    if (failures.length === 0 && restore !== undefined && typeof restore !== "function") {
      failures.push(new TypeError("The release-cutover between-pass hook must return a restore function."));
      restore = undefined;
    }
  }
  if (failures.length === 0) {
    second = attemptReleaseCutoverStep(failures, () =>
      captureRepositorySources(root, rootHandle, discoverPaths, options)
    );
  }
  if (restore !== undefined) {
    attemptReleaseCutoverStep(failures, restore);
    restore = undefined;
  }
  attemptReleaseCutoverStep(failures, () => assertRepositoryRootCurrent(root, rootHandle));
  if (first !== undefined && second !== undefined && !sameRepositoryView(first, second)) {
    failures.push(new Error("The release-cutover repository view changed between its two bounded scan passes."));
  }
  attemptReleaseCutoverStep(failures, () => closeSync(rootHandle.descriptor));
  throwReleaseCutoverFailures(failures);
  return first.sources;
}

export function readStableReleaseCutoverSources(root, paths, options = {}) {
  if (!Array.isArray(paths)) throw new TypeError("Stable release-cutover paths must be an array.");
  return readStableRepositorySources(root, () => [...paths], options);
}

function discoverRepositoryAuditPaths(root, rootHandle, { afterDirectoryOpenForTest } = {}) {
  const paths = new Set([MANIFEST_PATH, "package.json", "azure-pipelines-marketplace.yml"]);
  let entries = 0;
  const roots = Object.freeze([
    Object.freeze({ directory: ".github/workflows", extensions: Object.freeze([".yaml", ".yml"]) }),
    Object.freeze({ directory: "docs", extensions: Object.freeze([".md"]) }),
    Object.freeze({ directory: "scripts", extensions: Object.freeze([".mjs"]) })
  ]);
  for (const { directory, extensions } of roots) {
    const pending = [directory];
    while (pending.length > 0) {
      const relativeDirectory = pending.pop();
      const absoluteDirectory = resolve(root, relativeDirectory);
      withRepositoryNamespace(rootHandle, () => {
        const metadata = lstatSync(absoluteDirectory, { bigint: true });
        repositoryMetadataSnapshot(metadata, relativeDirectory, { directory: true });
        if (realpathSync(absoluteDirectory) !== absoluteDirectory) {
          throw new Error(`${relativeDirectory} is not a canonical release-cutover scan directory.`);
        }
        const handle = opendirSync(absoluteDirectory);
        const failures = [];
        try {
          afterDirectoryOpenForTest?.(Object.freeze({ handle, path: relativeDirectory }));
          for (let entry = handle.readSync(); entry !== null; entry = handle.readSync()) {
            entries += 1;
            if (entries > MAX_REPOSITORY_SCAN_ENTRIES) {
              throw new Error(`The release-cutover tree scan exceeds ${MAX_REPOSITORY_SCAN_ENTRIES} entries.`);
            }
            const path = canonicalRepositoryPath(`${relativeDirectory}/${entry.name}`, "Repository tree entry");
            const absolutePath = resolve(root, path);
            const entryMetadata = lstatSync(absolutePath, { bigint: true });
            if (entryMetadata.isSymbolicLink()) {
              throw new Error(`${path} is a symbolic link inside the release-cutover scan tree.`);
            }
            if (entryMetadata.isDirectory()) {
              pending.push(path);
            } else if (entryMetadata.isFile() && extensions.some((extension) => path.endsWith(extension))) {
              paths.add(path);
            }
          }
        } catch (error) {
          failures.push(error);
        }
        attemptReleaseCutoverStep(failures, () => handle.closeSync());
        throwReleaseCutoverFailures(failures);
      });
    }
  }
  return [...paths].sort();
}

const manifestSource = readStableReleaseCutoverSources(ROOT, [MANIFEST_PATH]).get(MANIFEST_PATH);
export const RELEASE_CUTOVER_MANIFEST = parseReleaseCutoverManifest(manifestSource);

export function releaseCutover(id, manifest = RELEASE_CUTOVER_MANIFEST) {
  if (typeof id !== "string") throw new TypeError("A release cutover requires one stable identifier.");
  const match = manifest.cutovers.find((candidate) => candidate.id === id);
  if (match === undefined) throw new Error(`Unknown release cutover ${JSON.stringify(id)}.`);
  return match;
}

export function releaseCutoverVersion(id, manifest = RELEASE_CUTOVER_MANIFEST) {
  return releaseCutover(id, manifest).firstApplicableVersion;
}

export function releaseCutoverApplies(id, version, manifest = RELEASE_CUTOVER_MANIFEST) {
  const actual = parseSemanticVersion(version, "A release cutover version");
  const required = parseSemanticVersion(releaseCutoverVersion(id, manifest), "A release cutover boundary");
  for (let index = 0; index < required.components.length; index += 1) {
    const comparison = compareCanonicalNumericComponent(actual.components[index], required.components[index]);
    if (comparison !== 0) return comparison > 0;
  }
  return !actual.prerelease;
}

export function renderReleaseCutoverDocumentation(manifest = RELEASE_CUTOVER_MANIFEST) {
  const validated = validateReleaseCutoverManifest(manifest);
  const lines = [
    DOCUMENTATION_START,
    "",
    "The versioned `fixtures/release-cutovers.v1.json` manifest is authoritative for these historical public-media",
    "boundaries. Current automation reads the manifest; recovery reads the exact tag's own automation and must not",
    "substitute current package requirements.",
    ""
  ];
  for (const cutover of validated.cutovers) {
    lines.push(
      `- \`${cutover.id}\` starts at \`${cutover.firstApplicableVersion}\` and affects ${cutover.affectedCapability}.`,
      `  Executable owner: \`${cutover.executableOwner}\`. Rationale: ${cutover.rationale}`,
      `  Recovery: ${cutover.recoveryBehavior}`
    );
  }
  lines.push("", DOCUMENTATION_END);
  return `${lines.join("\n")}\n`;
}

function documentationRange(source) {
  const start = source.indexOf(DOCUMENTATION_START);
  const end = source.indexOf(DOCUMENTATION_END);
  if (start < 0 || end < start || source.indexOf(DOCUMENTATION_START, start + 1) >= 0) {
    throw new Error(`${DOCUMENTATION_PATH} must contain one release-cutover documentation block.`);
  }
  if (source.indexOf(DOCUMENTATION_END, end + 1) >= 0) {
    throw new Error(`${DOCUMENTATION_PATH} must contain one release-cutover documentation block.`);
  }
  return { start, end: end + DOCUMENTATION_END.length + (source[end + DOCUMENTATION_END.length] === "\n" ? 1 : 0) };
}

export function assertReleaseCutoverDocumentationCurrent(source, manifest = RELEASE_CUTOVER_MANIFEST) {
  const range = documentationRange(source);
  if (source.slice(range.start, range.end) !== renderReleaseCutoverDocumentation(manifest)) {
    throw new Error(`${DOCUMENTATION_PATH} has stale release-cutover documentation.`);
  }
}

export function replaceReleaseCutoverDocumentation(source, manifest = RELEASE_CUTOVER_MANIFEST) {
  const range = documentationRange(source);
  return `${source.slice(0, range.start)}${renderReleaseCutoverDocumentation(manifest)}${source.slice(range.end)}`;
}

function rawOccurrences(source, version) {
  const escaped = version.replaceAll(".", "\\.");
  return [...source.matchAll(new RegExp(`(?<![0-9])${escaped}(?![0-9])`, "gu"))].map((match) => match.index);
}

function allowedDocumentationOccurrence(path, source, offset, version) {
  const lineStart = source.lastIndexOf("\n", offset) + 1;
  const lineEnd = source.indexOf("\n", offset);
  const line = source.slice(lineStart, lineEnd < 0 ? source.length : lineEnd);
  if (line === `RELEASE_VERSION="${version}" # replace with the released semantic version, without v`) return true;
  if (path === "docs/testing.md") {
    const performanceStart = source.indexOf("\n## Data Wrangler comparison\n");
    if (performanceStart >= 0 && offset > performanceStart) return true;
    return false;
  }
  if (path !== DOCUMENTATION_PATH) return false;
  const range = documentationRange(source);
  return offset >= range.start && offset < range.end;
}

export function assertNoRawReleaseCutoverVersions(
  sources,
  manifest = RELEASE_CUTOVER_MANIFEST,
  boundaryTestPaths = RELEASE_CUTOVER_BOUNDARY_TEST_PATHS
) {
  if (!(sources instanceof Map)) throw new TypeError("Release-cutover raw-version sources must be a Map.");
  if (
    JSON.stringify([...boundaryTestPaths].sort()) !== JSON.stringify([...RELEASE_CUTOVER_BOUNDARY_TEST_PATHS].sort())
  ) {
    throw new Error("Release-cutover boundary-test allowlist drifted.");
  }
  const allowedTests = new Set(boundaryTestPaths);
  for (const [path, source] of sources) {
    if (typeof path !== "string" || typeof source !== "string") {
      throw new TypeError("Release-cutover raw-version sources require string paths and contents.");
    }
    for (const cutover of manifest.cutovers) {
      const occurrences = rawOccurrences(source, cutover.firstApplicableVersion);
      for (const offset of occurrences) {
        if (allowedTests.has(path)) continue;
        if (allowedDocumentationOccurrence(path, source, offset, cutover.firstApplicableVersion)) {
          continue;
        }
        throw new Error(
          `${path} duplicates raw release cutover ${cutover.id} at ${cutover.firstApplicableVersion}; consume ${MANIFEST_PATH}.`
        );
      }
    }
  }
}

export function releaseCutoverConsumerPaths(manifest = RELEASE_CUTOVER_MANIFEST) {
  const validated = validateReleaseCutoverManifest(manifest);
  return Object.freeze(validated.consumerInventory.map(({ path }) => path));
}

function tokenizeJavaScript(source) {
  const tokens = [];
  const append = (kind, value, start, end, plain = true) => {
    tokens.push(Object.freeze({ end, kind, plain, start, value }));
    if (tokens.length > MAX_JAVASCRIPT_TOKENS) {
      throw new Error(`A release-cutover JavaScript source exceeds ${MAX_JAVASCRIPT_TOKENS} tokens.`);
    }
  };
  for (let index = 0; index < source.length;) {
    const character = source[index];
    const next = source[index + 1];
    if (/\s/u.test(character)) {
      index += 1;
      continue;
    }
    if (character === "/" && next === "/") {
      index += 2;
      while (index < source.length && source[index] !== "\n") index += 1;
      continue;
    }
    if (character === "/" && next === "*") {
      const start = index;
      index += 2;
      while (index < source.length && !(source[index] === "*" && source[index + 1] === "/")) index += 1;
      if (index >= source.length) {
        throw new Error(`A release-cutover JavaScript source has an unterminated comment at byte ${start}.`);
      }
      index += 2;
      continue;
    }
    if (
      character === "/" &&
      (tokens.length === 0 ||
        ["(", "[", "{", "=", ":", ",", ";", "!", "&&", "||", "?", "=>", "return"].includes(tokens.at(-1).value))
    ) {
      const start = index;
      let escaped = false;
      let characterClass = false;
      index += 1;
      while (index < source.length) {
        const candidate = source[index];
        if (escaped) escaped = false;
        else if (candidate === "\\") escaped = true;
        else if (candidate === "[") characterClass = true;
        else if (candidate === "]") characterClass = false;
        else if (candidate === "/" && !characterClass) break;
        index += 1;
      }
      if (index >= source.length) {
        throw new Error(`A release-cutover JavaScript source has an unterminated regular expression at byte ${start}.`);
      }
      index += 1;
      while (index < source.length && /[A-Za-z]/u.test(source[index])) index += 1;
      append("regular-expression", source.slice(start, index), start, index, false);
      continue;
    }
    if (character === '"' || character === "'" || character === "`") {
      const quote = character;
      const start = index;
      let plain = true;
      let value = "";
      index += 1;
      while (index < source.length && source[index] !== quote) {
        if (source[index] === "\\") {
          plain = false;
          if (index + 1 >= source.length) break;
          value += source[index];
          value += source[index + 1];
          index += 2;
          continue;
        }
        if (quote === "`" && source[index] === "$" && source[index + 1] === "{") plain = false;
        value += source[index];
        index += 1;
      }
      if (index >= source.length) {
        throw new Error(`A release-cutover JavaScript source has an unterminated string at byte ${start}.`);
      }
      index += 1;
      append("string", value, start, index, plain);
      continue;
    }
    if (/[A-Za-z_$]/u.test(character)) {
      const start = index;
      index += 1;
      while (index < source.length && /[A-Za-z0-9_$]/u.test(source[index])) index += 1;
      append("identifier", source.slice(start, index), start, index);
      continue;
    }
    const operator = ["===", "!==", "=>", "&&", "||", "?.", "==", "!=", "<=", ">="].find((value) =>
      source.startsWith(value, index)
    );
    if (operator !== undefined) {
      append("punctuator", operator, index, index + operator.length);
      index += operator.length;
      continue;
    }
    append("punctuator", character, index, index + 1);
    index += 1;
  }
  return Object.freeze(tokens);
}

function javascriptPairs(tokens) {
  const opening = new Map([
    ["(", ")"],
    ["[", "]"],
    ["{", "}"]
  ]);
  const pairs = new Map();
  const stack = [];
  for (let index = 0; index < tokens.length; index += 1) {
    if (tokens[index].kind !== "punctuator") continue;
    const value = tokens[index].value;
    if (opening.has(value)) stack.push(Object.freeze({ index, value }));
    else if ([")", "]", "}"].includes(value)) {
      const entry = stack.pop();
      if (entry === undefined || opening.get(entry.value) !== value) {
        throw new Error(
          `A release-cutover JavaScript source has unbalanced syntax near byte ${tokens[index].start} (${entry?.value ?? "empty"} at ${entry === undefined ? "none" : tokens[entry.index].start} before ${value}).`
        );
      }
      pairs.set(entry.index, index);
      pairs.set(index, entry.index);
    }
  }
  if (stack.length > 0) {
    throw new Error(
      `A release-cutover JavaScript source has unbalanced syntax near byte ${tokens[stack.at(-1).index].start}.`
    );
  }
  return pairs;
}

function importedJavaScriptBindings(tokens, moduleNames, importedNames) {
  const bindings = new Map();
  for (let index = 0; index < tokens.length; index += 1) {
    if (tokens[index].value !== "import" || tokens[index + 1]?.value !== "{") continue;
    let close = index + 2;
    while (close < tokens.length && !(tokens[close].kind === "punctuator" && tokens[close].value === "}")) {
      close += 1;
    }
    if (close >= tokens.length || tokens[close + 1]?.value !== "from" || tokens[close + 2]?.kind !== "string") {
      continue;
    }
    const moduleName = tokens[close + 2];
    if (!moduleName.plain || !moduleNames.has(moduleName.value)) continue;
    for (let cursor = index + 2; cursor < close;) {
      const imported = tokens[cursor];
      if (imported?.kind !== "identifier") {
        cursor += 1;
        continue;
      }
      let local = imported;
      let localIndex = cursor;
      if (tokens[cursor + 1]?.value === "as" && tokens[cursor + 2]?.kind === "identifier") {
        local = tokens[cursor + 2];
        localIndex = cursor + 2;
        cursor += 3;
      } else {
        cursor += 1;
      }
      if (importedNames(imported.value)) {
        bindings.set(local.value, Object.freeze({ imported: imported.value, tokenIndex: localIndex }));
      }
      if (tokens[cursor]?.value === ",") cursor += 1;
    }
    index = close + 2;
  }
  return bindings;
}

function hasShadowingJavaScriptBinding(tokens, pairs, name, importTokenIndex) {
  for (let index = 0; index < tokens.length; index += 1) {
    if (tokens[index].value !== name || index === importTokenIndex) continue;
    const previous = tokens[index - 1]?.value;
    if (
      ["const", "let", "var", "class", "function"].includes(previous) ||
      tokens[index + 1]?.value === "=>" ||
      ["=", "++", "--"].includes(tokens[index + 1]?.value)
    ) {
      return true;
    }
    if (["{", "[", ":", ","].includes(previous)) {
      for (let cursor = index - 1; cursor >= 0 && ![";", "="].includes(tokens[cursor].value); cursor -= 1) {
        if (["const", "let", "var"].includes(tokens[cursor].value)) return true;
      }
    }
  }
  for (let index = 0; index < tokens.length; index += 1) {
    if (!["function", "catch"].includes(tokens[index].value)) continue;
    let open = index + 1;
    if (tokens[index].value === "function" && tokens[open]?.kind === "identifier") open += 1;
    if (tokens[open]?.value !== "(") continue;
    const close = pairs.get(open);
    if (close !== undefined && tokens.slice(open + 1, close).some((token) => token.value === name)) return true;
  }
  for (let index = 0; index < tokens.length; index += 1) {
    if (tokens[index].value !== "=>") continue;
    const previous = tokens[index - 1];
    if (previous?.value === name) return true;
    if (previous?.value === ")") {
      const open = pairs.get(index - 1);
      if (open !== undefined && tokens.slice(open + 1, index - 1).some((token) => token.value === name)) return true;
    }
  }
  return false;
}

function statementTokenRange(tokens, pairs, start) {
  if (tokens[start]?.value === "{") return Object.freeze([start, pairs.get(start)]);
  let end = start;
  while (end < tokens.length && ![";", "}"].includes(tokens[end].value)) end += 1;
  return Object.freeze([start, end]);
}

function isStaticallyDeadJavaScriptToken(tokens, pairs, tokenIndex) {
  for (let index = 0; index < tokenIndex; index += 1) {
    if (!["if", "while"].includes(tokens[index].value) || tokens[index + 1]?.value !== "(") continue;
    const conditionClose = pairs.get(index + 1);
    if (conditionClose === undefined) continue;
    const condition = tokens.slice(index + 2, conditionClose);
    if (condition.length !== 1 || !["false", "true"].includes(condition[0].value)) continue;
    const consequent = statementTokenRange(tokens, pairs, conditionClose + 1);
    if (condition[0].value === "false" && tokenIndex >= consequent[0] && tokenIndex <= consequent[1]) return true;
    const elseIndex = consequent[1] + 1;
    if (tokens[index].value === "if" && condition[0].value === "true" && tokens[elseIndex]?.value === "else") {
      const alternative = statementTokenRange(tokens, pairs, elseIndex + 1);
      if (tokenIndex >= alternative[0] && tokenIndex <= alternative[1]) return true;
    }
  }
  let boundary = tokenIndex - 1;
  while (boundary >= 0 && ![";", "{", "}"].includes(tokens[boundary].value)) boundary -= 1;
  const prefix = tokens.slice(boundary + 1, tokenIndex).map(({ value }) => value);
  if (
    prefix.some((value, index) => value === "false" && prefix[index + 1] === "&&") ||
    prefix.some((value, index) => value === "true" && prefix[index + 1] === "||")
  ) {
    return true;
  }
  return false;
}

const RELEASE_AUTHORITY_EXPORTS = new Set(["releaseCutover", "releaseCutoverApplies", "releaseCutoverVersion"]);
const RELEASE_AUTHORITY_MODULES = new Set(["./release-cutovers.mjs", "./scripts/release-cutovers.mjs"]);

function javascriptCallArgumentCount(tokens, pairs, open) {
  const close = pairs.get(open);
  if (close === undefined || close === open + 1) return close === undefined ? undefined : 0;
  let count = 1;
  for (let index = open + 1; index < close; index += 1) {
    const nestedClose = pairs.get(index);
    if (nestedClose !== undefined && nestedClose > index) {
      index = nestedClose;
    } else if (tokens[index].value === ",") count += 1;
  }
  return count;
}

function authorityBoundJavaScriptCutoverIds(source, cutoverIds) {
  const tokens = tokenizeJavaScript(source);
  const pairs = javascriptPairs(tokens);
  const bindings = importedJavaScriptBindings(tokens, RELEASE_AUTHORITY_MODULES, (name) =>
    RELEASE_AUTHORITY_EXPORTS.has(name)
  );
  const consumed = new Set();
  for (const [local, binding] of bindings) {
    if (hasShadowingJavaScriptBinding(tokens, pairs, local, binding.tokenIndex)) continue;
    for (let index = 0; index < tokens.length; index += 1) {
      if (
        tokens[index].value !== local ||
        tokens[index + 1]?.value !== "(" ||
        [".", "?."].includes(tokens[index - 1]?.value) ||
        isStaticallyDeadJavaScriptToken(tokens, pairs, index)
      ) {
        continue;
      }
      const expectedArguments = binding.imported === "releaseCutoverApplies" ? 2 : 1;
      if (javascriptCallArgumentCount(tokens, pairs, index + 1) !== expectedArguments) continue;
      const id = tokens[index + 2];
      if (id?.kind === "string" && id.plain && cutoverIds.has(id.value)) consumed.add(id.value);
    }
  }
  return Object.freeze({ consumed, pairs, tokens });
}

function inlineNodeModulePrograms(source) {
  const marker = "node --input-type=module -e '";
  const programs = [];
  let offset = 0;
  while (offset < source.length) {
    const start = source.indexOf(marker, offset);
    if (start < 0) break;
    const programStart = start + marker.length;
    const end = source.indexOf("'", programStart);
    if (end < 0) throw new Error("A release-cutover inline Node module command is unterminated.");
    programs.push(source.slice(programStart, end));
    offset = end + 1;
  }
  return Object.freeze(programs);
}

function executableReplacementCutoverIds(tokens, pairs, cutoverIds) {
  const inspectorImports = importedJavaScriptBindings(
    tokens,
    new Set(["./marketplace-promotion-workflow.mjs", "./open-vsx-promotion-workflow.mjs"]),
    (name) => name.startsWith("inspect")
  );
  let hasInspectorCall = false;
  for (const [local, binding] of inspectorImports) {
    if (hasShadowingJavaScriptBinding(tokens, pairs, local, binding.tokenIndex)) continue;
    hasInspectorCall ||= tokens.some(
      (token, index) =>
        token.value === local &&
        tokens[index + 1]?.value === "(" &&
        !isStaticallyDeadJavaScriptToken(tokens, pairs, index)
    );
  }
  if (!hasInspectorCall) return Object.freeze([]);
  const consumed = [];
  for (let index = 0; index < tokens.length; index += 1) {
    if (
      tokens[index].value !== "replace" ||
      tokens[index - 1]?.value !== "." ||
      tokens[index + 1]?.value !== "(" ||
      isStaticallyDeadJavaScriptToken(tokens, pairs, index)
    ) {
      continue;
    }
    const argument = tokens[index + 2];
    if (argument?.kind !== "string" || !argument.plain) continue;
    for (const id of cutoverIds) {
      if (argument.value === `releaseCutoverVersion("${id}")`) {
        consumed.push(id);
      }
    }
  }
  return Object.freeze(consumed);
}

function semanticJavaScriptCutoverIds(source, cutoverIds) {
  const direct = authorityBoundJavaScriptCutoverIds(source, cutoverIds);
  const consumed = new Set(direct.consumed);
  for (let index = 0; index < direct.tokens.length; index += 1) {
    const token = direct.tokens[index];
    if (token.kind !== "string") continue;
    const programs = inlineNodeModulePrograms(token.value);
    if (programs.length === 0 || isStaticallyDeadJavaScriptToken(direct.tokens, direct.pairs, index)) continue;
    for (const program of programs) {
      for (const id of authorityBoundJavaScriptCutoverIds(program, cutoverIds).consumed) consumed.add(id);
    }
  }
  for (const id of executableReplacementCutoverIds(direct.tokens, direct.pairs, cutoverIds)) consumed.add(id);
  return Object.freeze([...consumed].sort());
}

function stripHashComments(source) {
  return source
    .split("\n")
    .map((line) => {
      let quote;
      for (let index = 0; index < line.length; index += 1) {
        const character = line[index];
        if (quote !== undefined) {
          if (character === "\\") index += 1;
          else if (character === quote) quote = undefined;
        } else if (character === '"' || character === "'") {
          quote = character;
        } else if (character === "#") {
          return line.slice(0, index);
        }
      }
      return line;
    })
    .join("\n");
}

function semanticCutoverIds(path, source, cutoverIds) {
  if (NON_CONSUMER_AUTHORITY_PATHS.has(path)) return Object.freeze([]);
  if (!cutoverIds.some((id) => source.includes(id)) && !source.includes("release-cutovers.mjs")) {
    return Object.freeze([]);
  }
  const ids = new Set(cutoverIds);
  let consumed;
  if (path.endsWith(".md")) {
    const semanticSource = source.replaceAll(/<!--[\s\S]*?-->/gu, "");
    consumed = cutoverIds.filter((id) => semanticSource.includes(`\`${id}\``));
  } else if (path.endsWith(".mjs")) {
    consumed = semanticJavaScriptCutoverIds(source, ids);
  } else {
    const semanticSource = stripHashComments(source);
    consumed = [];
    for (const program of inlineNodeModulePrograms(semanticSource)) {
      for (const id of authorityBoundJavaScriptCutoverIds(program, ids).consumed) consumed.push(id);
    }
    consumed = [...new Set(consumed)].sort();
  }
  if (
    !path.endsWith(".md") &&
    source.includes("release-cutovers.mjs") &&
    cutoverIds.some((id) => source.includes(id) && !consumed.includes(id))
  ) {
    throw new Error(`${path} references a release cutover without one authority-bound executable invocation.`);
  }
  return Object.freeze([...consumed].sort());
}

export function discoverReleaseCutoverConsumers(sources, manifest = RELEASE_CUTOVER_MANIFEST) {
  if (!(sources instanceof Map)) throw new TypeError("Release-cutover consumers must be supplied as a Map.");
  if (sources.size > MAX_REPOSITORY_SCAN_ENTRIES) {
    throw new Error(`Release-cutover consumer discovery exceeds ${MAX_REPOSITORY_SCAN_ENTRIES} sources.`);
  }
  const validated = validateReleaseCutoverManifest(manifest);
  const cutoverIds = validated.cutovers.map(({ id }) => id);
  const discovered = new Map();
  for (const [pathValue, source] of sources) {
    const path = canonicalRepositoryPath(pathValue, "Release-cutover source path");
    if (typeof source !== "string" || Buffer.byteLength(source, "utf8") > MAX_CONSUMER_BYTES) {
      throw new TypeError(`${path} must supply one bounded string release-cutover source.`);
    }
    let consumed;
    try {
      consumed = semanticCutoverIds(path, source, cutoverIds);
    } catch (error) {
      throw new Error(`${path} could not prove its bounded release-cutover semantics.`, { cause: error });
    }
    if (consumed.length > 0) {
      canonicalRepositoryPath(path, "Discovered release-cutover consumer path", { consumer: true });
      discovered.set(path, consumed);
    }
  }
  return discovered;
}

export function assertReleaseCutoverConsumerInventory(sources, manifest = RELEASE_CUTOVER_MANIFEST) {
  const validated = validateReleaseCutoverManifest(manifest);
  const discovered = discoverReleaseCutoverConsumers(sources, validated);
  const expected = new Map(validated.consumerInventory.map(({ path, cutoverIds }) => [path, cutoverIds]));
  const ordered = (entries) => [...entries].sort(([left], [right]) => (left === right ? 0 : left < right ? -1 : 1));
  if (JSON.stringify(ordered(discovered)) !== JSON.stringify(ordered(expected))) {
    throw new Error("Semantically discovered release-cutover consumers must exactly match the independent inventory.");
  }
  return discovered;
}

function tokenizePortableShellCommands(command) {
  const commands = [];
  let currentCommand = [];
  let currentToken = "";
  let quote;
  const pushToken = () => {
    if (currentToken.length > 0) currentCommand.push(currentToken);
    currentToken = "";
  };
  const pushCommand = () => {
    pushToken();
    if (currentCommand.length > 0) commands.push(Object.freeze(currentCommand));
    currentCommand = [];
  };
  for (let index = 0; index < command.length; index += 1) {
    const character = command[index];
    if (quote !== undefined) {
      if (character === quote) quote = undefined;
      else if (character === "\\" && quote === '"' && index + 1 < command.length) {
        index += 1;
        currentToken += command[index];
      } else currentToken += character;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      continue;
    }
    if (character === "\\") {
      if (index + 1 >= command.length) throw new Error("The portable script-test inventory has a dangling escape.");
      index += 1;
      currentToken += command[index];
      continue;
    }
    if (/\s/u.test(character)) {
      pushToken();
      continue;
    }
    if ([";", "|", "&"].includes(character)) {
      if ((character === "|" || character === "&") && command[index + 1] === character) index += 1;
      pushCommand();
      continue;
    }
    currentToken += character;
  }
  if (quote !== undefined) throw new Error("The portable script-test inventory has an unterminated quote.");
  pushCommand();
  return Object.freeze(commands);
}

export function assertReleaseCutoverTestInventory(packageSource) {
  if (typeof packageSource !== "string" || Buffer.byteLength(packageSource, "utf8") > MAX_CONSUMER_BYTES) {
    throw new TypeError("The release-cutover package inventory must be one bounded string.");
  }
  const packageJson = parseStrictJson(packageSource, { maxBytes: MAX_CONSUMER_BYTES, maxDepth: 16 });
  const command = packageJson?.scripts?.["test:scripts:portable:run"];
  if (typeof command !== "string") {
    throw new Error("package.json must declare the canonical portable script-test inventory.");
  }
  const owner = "scripts/release-cutovers.test.mjs";
  const commands = tokenizePortableShellCommands(command);
  const owningCommands = commands.filter(
    (arguments_) => arguments_[0] === "node" && arguments_[1] === "--test" && arguments_.includes(owner)
  );
  const ownerArguments = owningCommands.flatMap((arguments_) => arguments_.filter((argument) => argument === owner));
  if (owningCommands.length !== 1 || ownerArguments.length !== 1) {
    throw new Error(
      `The canonical portable script-test inventory must contain ${owner} exactly once as one exact node --test argument.`
    );
  }
}

export function checkReleaseCutoverRepository(options = {}) {
  const root = options.root ?? ROOT;
  const sources = readStableRepositorySources(
    root,
    (rootHandle) => discoverRepositoryAuditPaths(root, rootHandle, options),
    options
  );
  const currentManifestSource = sources.get(MANIFEST_PATH);
  const manifest = parseReleaseCutoverManifest(currentManifestSource);
  if (currentManifestSource !== renderReleaseCutoverManifest(manifest)) {
    throw new Error(`${MANIFEST_PATH} is not in canonical generated form.`);
  }
  const documentation = sources.get(DOCUMENTATION_PATH);
  assertReleaseCutoverDocumentationCurrent(documentation, manifest);
  const consumers = assertReleaseCutoverConsumerInventory(sources, manifest);
  assertReleaseCutoverTestInventory(sources.get("package.json"));
  const auditedSources = new Map([...consumers.keys()].map((path) => [path, sources.get(path)]));
  for (const path of RELEASE_CUTOVER_BOUNDARY_TEST_PATHS) {
    if (!auditedSources.has(path)) auditedSources.set(path, sources.get(path));
  }
  assertNoRawReleaseCutoverVersions(auditedSources, manifest);
  return Object.freeze({ cutovers: manifest.cutovers.length, checkedPaths: auditedSources.size + 1 });
}

function main() {
  const arguments_ = process.argv.slice(2);
  if (arguments_.length > 1 || (arguments_[0] !== undefined && !["--check", "--write"].includes(arguments_[0]))) {
    throw new Error("Usage: node scripts/release-cutovers.mjs [--check|--write]");
  }
  if (arguments_[0] === "--write") {
    const path = resolve(ROOT, DOCUMENTATION_PATH);
    const documentation = readStableReleaseCutoverSources(ROOT, [DOCUMENTATION_PATH]).get(DOCUMENTATION_PATH);
    writeFileSync(path, replaceReleaseCutoverDocumentation(documentation), "utf8");
  }
  checkReleaseCutoverRepository();
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
