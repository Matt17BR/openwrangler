import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const repositoryRoot = resolve(import.meta.dirname, "..");
const contractPath = resolve(repositoryRoot, "fixtures", "pyspark-version-contract.json");
const typeScriptOutputPath = resolve(
  repositoryRoot,
  "src",
  "extension",
  "notebooks",
  "pysparkVersionPolicy.generated.ts"
);
const pythonOutputPath = resolve(
  repositoryRoot,
  "python",
  "openwrangler_runtime",
  "pyspark_version_policy_generated.py"
);
const mode = process.argv[2];

if (!["--check", "--write"].includes(mode) || process.argv.length !== 3) {
  throw new Error("Usage: node scripts/generate-pyspark-version-policy.mjs --check|--write");
}

const contract = JSON.parse(await readFile(contractPath, "utf8"));
const policy = validatePolicy(contract);
const pattern = renderVersionPattern(policy);
const outputs = [
  [typeScriptOutputPath, renderTypeScript(policy, pattern), "TypeScript PySpark version policy"],
  [pythonOutputPath, renderPython(policy, pattern), "Python PySpark version policy"]
];

if (mode === "--check") {
  const stale = [];
  for (const [outputPath, expected, label] of outputs) {
    const actual = await readFile(outputPath, "utf8").catch(() => "");
    if (actual !== expected) stale.push(label);
  }
  if (stale.length > 0) {
    throw new Error(`${stale.join(" and ")} generated output is stale; run this script with --write.`);
  }
  process.stdout.write("Generated PySpark version policies are current.\n");
} else {
  await Promise.all(outputs.map(([outputPath, output]) => writeFile(outputPath, output, "utf8")));
  process.stdout.write("Generated PySpark version policies.\n");
}

function validatePolicy(contractValue) {
  if (!isPlainRecord(contractValue) || !hasExactKeys(contractValue, ["acceptedFinal", "policy", "rejected"])) {
    throw new Error("The PySpark version contract must contain exactly policy, acceptedFinal, and rejected.");
  }
  const policyValue = contractValue.policy;
  if (
    !isPlainRecord(policyValue) ||
    !hasExactKeys(policyValue, ["maxCharacters", "supportedRelease", "versionGrammar"]) ||
    !Number.isSafeInteger(policyValue.maxCharacters) ||
    policyValue.maxCharacters < 1 ||
    policyValue.maxCharacters > 256 ||
    !isPlainRecord(policyValue.supportedRelease) ||
    !hasExactKeys(policyValue.supportedRelease, ["major", "minor"]) ||
    !Number.isSafeInteger(policyValue.supportedRelease.major) ||
    policyValue.supportedRelease.major < 0 ||
    !Number.isSafeInteger(policyValue.supportedRelease.minor) ||
    policyValue.supportedRelease.minor < 0 ||
    !isPlainRecord(policyValue.versionGrammar) ||
    !hasExactKeys(policyValue.versionGrammar, ["localCharacters", "localSeparators", "releaseCharacters"])
  ) {
    throw new Error("The declarative PySpark version policy is malformed.");
  }
  const { localCharacters, localSeparators, releaseCharacters } = policyValue.versionGrammar;
  if (
    releaseCharacters !== "0123456789" ||
    localCharacters !== "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz" ||
    localSeparators !== "._-"
  ) {
    throw new Error("The PySpark version grammar must use the reviewed ASCII release and local character sets.");
  }
  return policyValue;
}

function renderVersionPattern(policy) {
  const releaseClass = characterClass(policy.versionGrammar.releaseCharacters);
  const localClass = characterClass(policy.versionGrammar.localCharacters);
  const separatorClass = characterClass(policy.versionGrammar.localSeparators);
  return `^(${releaseClass}+)\\.(${releaseClass}+)\\.${releaseClass}+(?:\\+${localClass}+(?:${separatorClass}${localClass}+)*)?$`;
}

function characterClass(value) {
  return `[${[...value].map((character) => character.replace(/[\\\]^-]/gu, "\\$&")).join("")}]`;
}

function renderTypeScript(policy, pattern) {
  return `/* Generated from fixtures/pyspark-version-contract.json. Do not edit. */
export const MAX_PYSPARK_VERSION_CHARACTERS = ${policy.maxCharacters};
export const PYSPARK_SUPPORTED_MAJOR = ${JSON.stringify(String(policy.supportedRelease.major))};
export const PYSPARK_SUPPORTED_MINOR = ${JSON.stringify(String(policy.supportedRelease.minor))};
export const PYSPARK_FINAL_VERSION_PATTERN =
  ${JSON.stringify(pattern)};

const FINAL_PYSPARK_VERSION = new RegExp(PYSPARK_FINAL_VERSION_PATTERN, "u");

export function isSupportedPySparkVersion(version: string): boolean {
  if (version.length === 0 || version.length > MAX_PYSPARK_VERSION_CHARACTERS) return false;
  const match = FINAL_PYSPARK_VERSION.exec(version);
  if (!match) return false;
  return (
    normalizeReleaseComponent(match[1]!) === PYSPARK_SUPPORTED_MAJOR &&
    normalizeReleaseComponent(match[2]!) === PYSPARK_SUPPORTED_MINOR
  );
}

function normalizeReleaseComponent(component: string): string {
  return component.replace(/^0+/u, "") || "0";
}
`;
}

function renderPython(policy, pattern) {
  return `# Generated from fixtures/pyspark-version-contract.json. Do not edit.
from __future__ import annotations

import re

MAX_PYSPARK_VERSION_CHARACTERS = ${policy.maxCharacters}
PYSPARK_SUPPORTED_MAJOR = ${JSON.stringify(String(policy.supportedRelease.major))}
PYSPARK_SUPPORTED_MINOR = ${JSON.stringify(String(policy.supportedRelease.minor))}
PYSPARK_FINAL_VERSION_PATTERN = (
${pythonStringChunks(pattern)
  .map((chunk) => `    ${JSON.stringify(chunk)}`)
  .join("\n")}
)

_FINAL_PYSPARK_VERSION = re.compile(PYSPARK_FINAL_VERSION_PATTERN)


def is_supported_pyspark_version(version: str) -> bool:
    if not 0 < len(version) <= MAX_PYSPARK_VERSION_CHARACTERS:
        return False
    match = _FINAL_PYSPARK_VERSION.fullmatch(version)
    if match is None:
        return False
    return (
        _normalize_release_component(match[1]) == PYSPARK_SUPPORTED_MAJOR
        and _normalize_release_component(match[2]) == PYSPARK_SUPPORTED_MINOR
    )


def _normalize_release_component(component: str) -> str:
    return component.lstrip("0") or "0"
`;
}

function isPlainRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function pythonStringChunks(value) {
  const chunks = [];
  let offset = 0;
  while (offset < value.length) {
    let end = Math.min(offset + 80, value.length);
    while (end < value.length && value[end - 1] === "\\") end -= 1;
    if (end === offset) end += 1;
    chunks.push(value.slice(offset, end));
    offset = end;
  }
  return chunks;
}

function hasExactKeys(value, expected) {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return actual.length === sortedExpected.length && actual.every((key, index) => key === sortedExpected[index]);
}
