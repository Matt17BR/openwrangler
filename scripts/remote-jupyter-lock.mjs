import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const REPOSITORY_ROOT = resolve(import.meta.dirname, "..");

export const REMOTE_JUPYTER_INPUT_PATH = resolve(REPOSITORY_ROOT, "scripts", "remote-jupyter", "requirements.in");
export const REMOTE_JUPYTER_LOCK_PATH = resolve(REPOSITORY_ROOT, "scripts", "remote-jupyter", "requirements.txt");
export const REMOTE_R_JUPYTER_INPUT_PATH = resolve(REPOSITORY_ROOT, "scripts", "remote-jupyter", "requirements.r.in");
export const REMOTE_R_JUPYTER_LOCK_PATH = resolve(REPOSITORY_ROOT, "scripts", "remote-jupyter", "requirements.r.txt");
export const REMOTE_JUPYTER_DIRECT_DEPENDENCIES = Object.freeze([
  "duckdb",
  "fsspec",
  "ipykernel",
  "jupyter-server",
  "pandas",
  "polars"
]);
export const REMOTE_R_JUPYTER_DIRECT_DEPENDENCIES = Object.freeze(["jupyter-server"]);
export const REMOTE_JUPYTER_MINIMUM_SAFE_SERVER_VERSION = "2.20.0";
export const REMOTE_JUPYTER_LOCK_TOOL_VERSION = "0.11.32";
export const REMOTE_JUPYTER_LOCK_PYTHON_VERSION = "3.12";
export const REMOTE_JUPYTER_LOCK_PLATFORM = "x86_64-manylinux_2_28";
export const REMOTE_JUPYTER_LOCK_EXCLUDE_NEWER = "2026-07-27T00:00:00Z";
export const REMOTE_JUPYTER_FSSPEC_EXCLUDE_NEWER = "fsspec=2026-07-29T00:00:00Z";

const PACKAGE_NAME = /^[a-z][a-z0-9-]*$/u;
const PACKAGE_VERSION = /^[0-9]+(?:[._+-][0-9A-Za-z]+)*$/u;
const INPUT_LINE = /^([a-z][a-z0-9-]*)==([0-9]+(?:[._+-][0-9A-Za-z]+)*)$/u;
const LOCK_HEADER = /^([a-z][a-z0-9-]*)==([0-9]+(?:[._+-][0-9A-Za-z]+)*) \\$/u;
const LOCK_HASH = /^ {4}--hash=sha256:([0-9a-f]{64})( \\)?$/u;
const UV_VERSION_OUTPUT = /^uv ([0-9]+\.[0-9]+\.[0-9]+)(?: \([A-Za-z0-9_.-]+\))?\r?\n$/u;

function fail(message) {
  throw new Error(`Remote Jupyter lock contract failed: ${message}`);
}

export function isRemoteJupyterLockToolVersionOutput(output) {
  return UV_VERSION_OUTPUT.exec(output)?.[1] === REMOTE_JUPYTER_LOCK_TOOL_VERSION;
}

function canonicalLines(text, label) {
  if (typeof text !== "string" || text.length === 0) {
    fail(`${label} must be non-empty UTF-8 text.`);
  }
  if (!text.endsWith("\n") || text.includes("\r") || text.includes("\0")) {
    fail(`${label} must use canonical LF lines and end with one newline.`);
  }
  const lines = text.slice(0, -1).split("\n");
  if (lines.some((line) => line.length === 0)) {
    fail(`${label} may not contain blank lines.`);
  }
  return lines;
}

export function parseRemoteJupyterInput(text) {
  const entries = canonicalLines(text, "requirements.in").map((line) => {
    const match = INPUT_LINE.exec(line);
    if (!match) {
      fail("requirements.in must contain only exact normalized package pins.");
    }
    return { name: match[1], version: match[2] };
  });
  const names = entries.map(({ name }) => name);
  if (new Set(names).size !== names.length || names.some((name) => !PACKAGE_NAME.test(name))) {
    fail("requirements.in package names must be unique and normalized.");
  }
  if (names.some((name, index) => index > 0 && names[index - 1] >= name)) {
    fail("requirements.in package names must be strictly sorted.");
  }
  return entries;
}

export function parseRemoteJupyterLock(text) {
  const lines = canonicalLines(text, "requirements.txt");
  const entries = [];

  for (let index = 0; index < lines.length;) {
    const header = LOCK_HEADER.exec(lines[index]);
    if (!header || !PACKAGE_NAME.test(header[1]) || !PACKAGE_VERSION.test(header[2])) {
      fail(`requirements.txt line ${index + 1} must begin one exact normalized package entry.`);
    }
    index += 1;

    const hashes = [];
    while (index < lines.length) {
      const match = LOCK_HASH.exec(lines[index]);
      if (!match) break;
      hashes.push({ value: match[1], continued: match[2] !== undefined });
      index += 1;
    }
    if (hashes.length === 0) {
      fail(`requirements.txt package ${header[1]} must have at least one SHA-256 hash.`);
    }
    if (
      hashes.some(({ continued }, hashIndex) => continued !== hashIndex < hashes.length - 1) ||
      new Set(hashes.map(({ value }) => value)).size !== hashes.length ||
      hashes.some(({ value }, hashIndex) => hashIndex > 0 && hashes[hashIndex - 1].value >= value)
    ) {
      fail(`requirements.txt package ${header[1]} must have unique, sorted, canonical hash lines.`);
    }
    entries.push({
      name: header[1],
      version: header[2],
      hashes: hashes.map(({ value }) => value)
    });
  }

  const names = entries.map(({ name }) => name);
  if (new Set(names).size !== names.length || names.some((name, index) => index > 0 && names[index - 1] >= name)) {
    fail("requirements.txt package entries must be unique and strictly sorted.");
  }
  return entries;
}

function stableVersionParts(version, label) {
  const match = /^([0-9]+)\.([0-9]+)\.([0-9]+)$/u.exec(version);
  if (!match) {
    fail(`${label} must be an exact stable three-part release.`);
  }
  return match.slice(1).map(Number);
}

function compareStableVersions(left, right) {
  const leftParts = stableVersionParts(left, "Jupyter Server");
  const rightParts = stableVersionParts(right, "the minimum safe Jupyter Server version");
  for (let index = 0; index < leftParts.length; index += 1) {
    if (leftParts[index] !== rightParts[index]) {
      return leftParts[index] - rightParts[index];
    }
  }
  return 0;
}

function validateFixtureLock(inputText, lockText, directDependencies, { minimumPackages, forbiddenPackages = [] }) {
  const directEntries = parseRemoteJupyterInput(inputText);
  const lockedEntries = parseRemoteJupyterLock(lockText);
  const directNames = directEntries.map(({ name }) => name);

  if (
    directNames.length !== directDependencies.length ||
    directNames.some((name, index) => name !== directDependencies[index])
  ) {
    fail(`requirements.in must pin exactly ${directDependencies.join(", ")}.`);
  }
  if (lockedEntries.length < minimumPackages) {
    fail("requirements.txt must retain the complete transitive fixture closure.");
  }

  const lockedByName = new Map(lockedEntries.map((entry) => [entry.name, entry]));
  for (const direct of directEntries) {
    const locked = lockedByName.get(direct.name);
    if (!locked || locked.version !== direct.version) {
      fail(`direct pin ${direct.name} must match its hashed lock entry exactly.`);
    }
  }
  for (const packageName of forbiddenPackages) {
    if (lockedByName.has(packageName)) {
      fail(`requirements.txt must not include ${packageName}.`);
    }
  }

  const server = directEntries.find(({ name }) => name === "jupyter-server");
  if (!server || compareStableVersions(server.version, REMOTE_JUPYTER_MINIMUM_SAFE_SERVER_VERSION) < 0) {
    fail(`jupyter-server must remain at or above ${REMOTE_JUPYTER_MINIMUM_SAFE_SERVER_VERSION}.`);
  }

  return { directEntries, lockedEntries };
}

export function validateRemoteJupyterLock(inputText, lockText) {
  const result = validateFixtureLock(inputText, lockText, REMOTE_JUPYTER_DIRECT_DEPENDENCIES, {
    minimumPackages: 51
  });
  if (!result.lockedEntries.some(({ name }) => name === "polars-runtime-32")) {
    fail("requirements.txt must retain the native Polars runtime wheel.");
  }
  return result;
}

export function validateRemoteRJupyterLock(inputText, lockText) {
  return validateFixtureLock(inputText, lockText, REMOTE_R_JUPYTER_DIRECT_DEPENDENCIES, {
    minimumPackages: 40,
    forbiddenPackages: ["duckdb", "fsspec", "ipykernel", "ipython", "pandas", "polars", "polars-runtime-32"]
  });
}

function fixtureCompileArguments(inputPath, outputPath) {
  return [
    "pip",
    "compile",
    inputPath,
    "--python-version",
    REMOTE_JUPYTER_LOCK_PYTHON_VERSION,
    "--python-platform",
    REMOTE_JUPYTER_LOCK_PLATFORM,
    "--generate-hashes",
    "--only-binary=:all:",
    "--no-annotate",
    "--no-header",
    "--default-index",
    "https://pypi.org/simple",
    "--index-strategy",
    "first-index",
    "--no-sources",
    "--prerelease",
    "disallow",
    "--resolution",
    "highest",
    "--fork-strategy",
    "fewest",
    "--exclude-newer",
    REMOTE_JUPYTER_LOCK_EXCLUDE_NEWER,
    "--no-cache",
    "--no-config",
    "--no-progress",
    "--upgrade",
    "--output-file",
    outputPath
  ];
}

export function remoteJupyterCompileArguments(outputPath) {
  const argumentsList = fixtureCompileArguments(REMOTE_JUPYTER_INPUT_PATH, outputPath);
  argumentsList.splice(-3, 0, "--exclude-newer-package", REMOTE_JUPYTER_FSSPEC_EXCLUDE_NEWER);
  return argumentsList;
}

export function remoteRJupyterCompileArguments(outputPath) {
  return fixtureCompileArguments(REMOTE_R_JUPYTER_INPUT_PATH, outputPath);
}

export async function checkRemoteJupyterLockFiles() {
  const [inputText, lockText] = await Promise.all([
    readFile(REMOTE_JUPYTER_INPUT_PATH, "utf8"),
    readFile(REMOTE_JUPYTER_LOCK_PATH, "utf8")
  ]);
  return validateRemoteJupyterLock(inputText, lockText);
}

export async function checkRemoteRJupyterLockFiles() {
  const [inputText, lockText] = await Promise.all([
    readFile(REMOTE_R_JUPYTER_INPUT_PATH, "utf8"),
    readFile(REMOTE_R_JUPYTER_LOCK_PATH, "utf8")
  ]);
  return validateRemoteRJupyterLock(inputText, lockText);
}

async function main() {
  const [pythonFixture, rFixture] = await Promise.all([checkRemoteJupyterLockFiles(), checkRemoteRJupyterLockFiles()]);
  const server = pythonFixture.directEntries.find(({ name }) => name === "jupyter-server");
  process.stdout.write(
    `Remote Jupyter locks are canonical: Python ${pythonFixture.lockedEntries.length} packages, ` +
      `R ${rFixture.lockedEntries.length} packages, jupyter-server ${server?.version}.\n`
  );
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  await main();
}
