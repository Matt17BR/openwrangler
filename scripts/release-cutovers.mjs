import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseStrictJson } from "./strict-json.mjs";

const ROOT = resolve(import.meta.dirname, "..");
const MANIFEST_PATH = "fixtures/release-cutovers.v1.json";
const DOCUMENTATION_PATH = "docs/releasing.md";
const DOCUMENTATION_START = "<!-- release-cutovers:start -->";
const DOCUMENTATION_END = "<!-- release-cutovers:end -->";
const MAX_MANIFEST_BYTES = 32 * 1024;
const MAX_CUTOVERS = 16;
const MAX_TEXT_BYTES = 1_024;
const STABLE_ID = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u;
const STABLE_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u;
const SEMANTIC_VERSION =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;
const EXECUTABLE_OWNER = /^scripts\/[a-z0-9][a-z0-9.-]*\.mjs$/u;
const ENTRY_KEYS = Object.freeze([
  "affectedCapability",
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
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) {
      throw new Error(`${label} must not contain control characters.`);
    }
  }
  return value;
}

function freezeManifest(manifest) {
  for (const cutover of manifest.cutovers) Object.freeze(cutover);
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
    return {
      id,
      affectedCapability: boundedText(candidate.affectedCapability, `${label} affectedCapability`),
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

const manifestSource = readFileSync(resolve(ROOT, MANIFEST_PATH), "utf8");
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
  const actual = version.split(/[+-]/u, 1)[0].split(".").map(Number);
  const required = releaseCutoverVersion(id, manifest).split(".").map(Number);
  for (let index = 0; index < required.length; index += 1) {
    if (actual[index] !== required[index]) return actual[index] > required[index];
  }
  return true;
}

function markdownText(value) {
  return value.replaceAll("`", "\\`");
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
      `- \`${cutover.id}\` starts at \`${cutover.firstApplicableVersion}\` and affects ${markdownText(cutover.affectedCapability)}.`,
      `  Executable owner: \`${cutover.executableOwner}\`. Rationale: ${markdownText(cutover.rationale)}`,
      `  Recovery: ${markdownText(cutover.recoveryBehavior)}`
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

function allowedDocumentationOccurrence(source, offset, version) {
  const range = documentationRange(source);
  if (offset >= range.start && offset < range.end) return true;
  const lineStart = source.lastIndexOf("\n", offset) + 1;
  const lineEnd = source.indexOf("\n", offset);
  const line = source.slice(lineStart, lineEnd < 0 ? source.length : lineEnd);
  return line === `RELEASE_VERSION="${version}" # replace with the released semantic version, without v`;
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
        if (
          path === DOCUMENTATION_PATH &&
          allowedDocumentationOccurrence(source, offset, cutover.firstApplicableVersion)
        ) {
          continue;
        }
        throw new Error(
          `${path} duplicates raw release cutover ${cutover.id} at ${cutover.firstApplicableVersion}; consume ${MANIFEST_PATH}.`
        );
      }
    }
  }
}

export function checkReleaseCutoverRepository() {
  const currentManifestSource = readFileSync(resolve(ROOT, MANIFEST_PATH), "utf8");
  const manifest = parseReleaseCutoverManifest(currentManifestSource);
  if (currentManifestSource !== renderReleaseCutoverManifest(manifest)) {
    throw new Error(`${MANIFEST_PATH} is not in canonical generated form.`);
  }
  const documentation = readFileSync(resolve(ROOT, DOCUMENTATION_PATH), "utf8");
  assertReleaseCutoverDocumentationCurrent(documentation, manifest);
  const sources = new Map([
    [DOCUMENTATION_PATH, documentation],
    ...[...new Set(manifest.cutovers.map(({ executableOwner }) => executableOwner))].map((path) => [
      path,
      readFileSync(resolve(ROOT, path), "utf8")
    ]),
    ...RELEASE_CUTOVER_BOUNDARY_TEST_PATHS.map((path) => [path, readFileSync(resolve(ROOT, path), "utf8")])
  ]);
  assertNoRawReleaseCutoverVersions(sources, manifest);
  return Object.freeze({ cutovers: manifest.cutovers.length, checkedPaths: sources.size });
}

function main() {
  const arguments_ = process.argv.slice(2);
  if (arguments_.length > 1 || (arguments_[0] !== undefined && !["--check", "--write"].includes(arguments_[0]))) {
    throw new Error("Usage: node scripts/release-cutovers.mjs [--check|--write]");
  }
  if (arguments_[0] === "--write") {
    const path = resolve(ROOT, DOCUMENTATION_PATH);
    writeFileSync(path, replaceReleaseCutoverDocumentation(readFileSync(path, "utf8")), "utf8");
  }
  checkReleaseCutoverRepository();
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
