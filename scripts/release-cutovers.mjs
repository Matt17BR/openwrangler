import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
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
const MAX_TEXT_BYTES = 1_024;
const STABLE_ID = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u;
const STABLE_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u;
const SEMANTIC_VERSION =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;
const EXECUTABLE_OWNER = /^scripts\/[a-z0-9][a-z0-9.-]*\.mjs$/u;
const CONSUMER_PATH =
  /^(?:\.github\/workflows\/[a-z0-9][a-z0-9.-]*\.yml|azure-pipelines-marketplace\.yml|docs\/[a-z0-9][a-z0-9./-]*\.md|scripts\/[a-z0-9][a-z0-9.-]*\.mjs)$/u;
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
  Object.freeze(manifest.cutovers);
  return Object.freeze(manifest);
}

export function validateReleaseCutoverManifest(value) {
  if (!exactKeys(value, ["cutovers", "schemaVersion"])) {
    throw new Error("The release-cutover manifest must contain only schemaVersion and cutovers.");
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
    if (versions.has(firstApplicableVersion)) {
      throw new Error(`Release cutover version ${firstApplicableVersion} is duplicated.`);
    }
    versions.add(firstApplicableVersion);

    const executableOwner = boundedText(candidate.executableOwner, `${label} executableOwner`);
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
      const consumer = boundedText(value, `${label} consumer ${consumerIndex + 1}`);
      if (!CONSUMER_PATH.test(consumer)) {
        throw new Error(`${label} consumer ${consumerIndex + 1} must be one canonical repository path.`);
      }
      return consumer;
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

  return freezeManifest({ schemaVersion: 1, cutovers });
}

export function parseReleaseCutoverManifest(source) {
  if (typeof source !== "string" || Buffer.byteLength(source, "utf8") > MAX_MANIFEST_BYTES) {
    throw new Error(`The release-cutover manifest must be bounded to ${MAX_MANIFEST_BYTES} UTF-8 bytes.`);
  }
  return validateReleaseCutoverManifest(parseStrictJson(source, { maxBytes: MAX_MANIFEST_BYTES, maxDepth: 8 }));
}

export function renderReleaseCutoverManifest(manifest) {
  return `${JSON.stringify(validateReleaseCutoverManifest(manifest), null, 2)}\n`;
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

function readRepositoryText(path, maximumBytes = MAX_CONSUMER_BYTES, options = {}) {
  if (!CONSUMER_PATH.test(path) && path !== MANIFEST_PATH) {
    throw new Error(`Release-cutover repository path ${JSON.stringify(path)} is not canonical.`);
  }
  return readReleaseCutoverUtf8File(resolve(ROOT, path), maximumBytes, {
    ...options,
    containedBy: ROOT,
    label: options.label ?? path
  });
}

const manifestSource = readRepositoryText(MANIFEST_PATH, MAX_MANIFEST_BYTES);
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
  if (typeof version !== "string" || !SEMANTIC_VERSION.test(version)) {
    throw new TypeError("A release cutover version must be semantic.");
  }
  const coreAndPrerelease = version.split("+", 1)[0];
  const actual = coreAndPrerelease.split("-", 1)[0].split(".").map(Number);
  const required = releaseCutoverVersion(id, manifest).split(".").map(Number);
  for (let index = 0; index < required.length; index += 1) {
    if (actual[index] !== required[index]) return actual[index] > required[index];
  }
  return !coreAndPrerelease.includes("-");
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
  return Object.freeze([...new Set(validated.cutovers.flatMap(({ consumers }) => consumers))].sort());
}

export function assertReleaseCutoverConsumerInventory(sources, manifest = RELEASE_CUTOVER_MANIFEST) {
  if (!(sources instanceof Map)) throw new TypeError("Release-cutover consumers must be supplied as a Map.");
  const validated = validateReleaseCutoverManifest(manifest);
  const expectedPaths = releaseCutoverConsumerPaths(validated);
  const actualPaths = [...sources.keys()].sort();
  if (JSON.stringify(actualPaths) !== JSON.stringify(expectedPaths)) {
    throw new Error("Release-cutover consumer sources must exactly match the manifest inventory.");
  }
  for (const cutover of validated.cutovers) {
    for (const path of cutover.consumers) {
      const source = sources.get(path);
      if (typeof source !== "string" || !source.includes(cutover.id)) {
        throw new Error(`${path} must consume release cutover ${cutover.id}.`);
      }
    }
  }
}

export function checkReleaseCutoverRepository() {
  const currentManifestSource = readRepositoryText(MANIFEST_PATH, MAX_MANIFEST_BYTES);
  const manifest = parseReleaseCutoverManifest(currentManifestSource);
  if (currentManifestSource !== renderReleaseCutoverManifest(manifest)) {
    throw new Error(`${MANIFEST_PATH} is not in canonical generated form.`);
  }
  const documentation = readRepositoryText(DOCUMENTATION_PATH);
  assertReleaseCutoverDocumentationCurrent(documentation, manifest);
  const consumers = new Map(
    releaseCutoverConsumerPaths(manifest).map((path) => [
      path,
      path === DOCUMENTATION_PATH ? documentation : readRepositoryText(path)
    ])
  );
  assertReleaseCutoverConsumerInventory(consumers, manifest);
  const auditedSources = new Map(consumers);
  for (const path of RELEASE_CUTOVER_BOUNDARY_TEST_PATHS) {
    if (!auditedSources.has(path)) auditedSources.set(path, readRepositoryText(path));
  }
  assertNoRawReleaseCutoverVersions(auditedSources, manifest);
  return Object.freeze({ cutovers: manifest.cutovers.length, checkedPaths: auditedSources.size });
}

function main() {
  const arguments_ = process.argv.slice(2);
  if (arguments_.length > 1 || (arguments_[0] !== undefined && !["--check", "--write"].includes(arguments_[0]))) {
    throw new Error("Usage: node scripts/release-cutovers.mjs [--check|--write]");
  }
  if (arguments_[0] === "--write") {
    const path = resolve(ROOT, DOCUMENTATION_PATH);
    writeFileSync(path, replaceReleaseCutoverDocumentation(readRepositoryText(DOCUMENTATION_PATH)), "utf8");
  }
  checkReleaseCutoverRepository();
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
