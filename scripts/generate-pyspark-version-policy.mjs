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
const policy = validateContract(contract);
const pattern = renderVersionPattern(policy);
validateExamples(contract, policy, pattern);
const outputs = [
  [typeScriptOutputPath, renderTypeScript(contract, policy, pattern), "TypeScript PySpark version policy"],
  [pythonOutputPath, renderPython(contract, policy, pattern), "Python PySpark version policy"]
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

function validateContract(contractValue) {
  if (
    !isPlainRecord(contractValue) ||
    !hasExactKeys(contractValue, ["acceptancePrereleaseDenial", "acceptedFinal", "policy", "rejected"])
  ) {
    throw new Error(
      "The PySpark version contract must contain exactly policy, acceptedFinal, acceptancePrereleaseDenial, and rejected."
    );
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
  const exampleGroups = [contractValue.acceptedFinal, contractValue.acceptancePrereleaseDenial];
  if (
    !exampleGroups.every(
      (group) => Array.isArray(group) && group.length > 0 && group.every((version) => typeof version === "string")
    ) ||
    !isPlainRecord(contractValue.rejected) ||
    Object.keys(contractValue.rejected).length === 0 ||
    !Object.values(contractValue.rejected).every(
      (group) => Array.isArray(group) && group.length > 0 && group.every((version) => typeof version === "string")
    )
  ) {
    throw new Error("The PySpark version contract examples must be non-empty string collections.");
  }
  const examples = [...contractValue.acceptedFinal, ...contractValue.acceptancePrereleaseDenial];
  for (const group of Object.values(contractValue.rejected)) examples.push(...group);
  if (new Set(examples).size !== examples.length) {
    throw new Error("Every PySpark version contract example must have one classification.");
  }
  return policyValue;
}

function validateExamples(contractValue, policy, pattern) {
  const classify = executableClassifier(policy, pattern, contractValue.acceptancePrereleaseDenial);
  if (!contractValue.acceptedFinal.every((version) => classify(version) === "supported-final")) {
    throw new Error("Every acceptedFinal PySpark example must satisfy the generated final-release policy.");
  }
  if (!contractValue.acceptancePrereleaseDenial.every((version) => classify(version) === "acceptance-denial")) {
    throw new Error("Every acceptancePrereleaseDenial PySpark example must have the generated denial classification.");
  }
  if (
    !Object.values(contractValue.rejected)
      .flat()
      .every((version) => classify(version) === "unsupported")
  ) {
    throw new Error("Every rejected PySpark example must remain unsupported by the generated policy.");
  }
}

function executableClassifier(policy, pattern, acceptancePrereleaseDenial) {
  const finalVersion = new RegExp(pattern, "u");
  const denialVersions = new Set(acceptancePrereleaseDenial);
  return (version) => {
    if (version.length === 0 || version.length > policy.maxCharacters) return "unsupported";
    const match = finalVersion.exec(version);
    if (
      match &&
      normalizeReleaseComponent(match[1]) === String(policy.supportedRelease.major) &&
      normalizeReleaseComponent(match[2]) === String(policy.supportedRelease.minor)
    ) {
      return "supported-final";
    }
    return denialVersions.has(version) ? "acceptance-denial" : "unsupported";
  };
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

function renderTypeScript(contractValue, policy, pattern) {
  return `/* Generated from fixtures/pyspark-version-contract.json. Do not edit. */
export const MAX_PYSPARK_VERSION_CHARACTERS = ${policy.maxCharacters};
export const PYSPARK_SUPPORTED_MAJOR = ${JSON.stringify(String(policy.supportedRelease.major))};
export const PYSPARK_SUPPORTED_MINOR = ${JSON.stringify(String(policy.supportedRelease.minor))};
export const PYSPARK_ACCEPTANCE_PRERELEASE_DENIAL = Object.freeze(${JSON.stringify(
    contractValue.acceptancePrereleaseDenial
  )});
export const PYSPARK_FINAL_VERSION_PATTERN =
  ${JSON.stringify(pattern)};

const FINAL_PYSPARK_VERSION = new RegExp(PYSPARK_FINAL_VERSION_PATTERN, "u");
const ACCEPTANCE_PRERELEASE_DENIAL = new Set<string>(PYSPARK_ACCEPTANCE_PRERELEASE_DENIAL);

export type PySparkVersionClassification = "supported-final" | "acceptance-denial" | "unsupported";

export function classifyPySparkVersion(version: string): PySparkVersionClassification {
  if (version.length === 0 || version.length > MAX_PYSPARK_VERSION_CHARACTERS) return "unsupported";
  const match = FINAL_PYSPARK_VERSION.exec(version);
  if (
    match &&
    normalizeReleaseComponent(match[1]!) === PYSPARK_SUPPORTED_MAJOR &&
    normalizeReleaseComponent(match[2]!) === PYSPARK_SUPPORTED_MINOR
  ) {
    return "supported-final";
  }
  return ACCEPTANCE_PRERELEASE_DENIAL.has(version) ? "acceptance-denial" : "unsupported";
}

export function isSupportedPySparkVersion(version: string): boolean {
  return classifyPySparkVersion(version) === "supported-final";
}

function normalizeReleaseComponent(component: string): string {
  return component.replace(/^0+/u, "") || "0";
}
`;
}

function renderPython(contractValue, policy, pattern) {
  return `# Generated from fixtures/pyspark-version-contract.json. Do not edit.
from __future__ import annotations

import re

MAX_PYSPARK_VERSION_CHARACTERS = ${policy.maxCharacters}
PYSPARK_SUPPORTED_MAJOR = ${JSON.stringify(String(policy.supportedRelease.major))}
PYSPARK_SUPPORTED_MINOR = ${JSON.stringify(String(policy.supportedRelease.minor))}
PYSPARK_ACCEPTANCE_PRERELEASE_DENIAL = frozenset(${JSON.stringify(contractValue.acceptancePrereleaseDenial)})
PYSPARK_FINAL_VERSION_PATTERN = (
${pythonStringChunks(pattern)
  .map((chunk) => `    ${JSON.stringify(chunk)}`)
  .join("\n")}
)

_FINAL_PYSPARK_VERSION = re.compile(PYSPARK_FINAL_VERSION_PATTERN)


def classify_pyspark_version(version: str) -> str:
    if not 0 < len(version) <= MAX_PYSPARK_VERSION_CHARACTERS:
        return "unsupported"
    match = _FINAL_PYSPARK_VERSION.fullmatch(version)
    if (
        match is not None
        and _normalize_release_component(match[1]) == PYSPARK_SUPPORTED_MAJOR
        and _normalize_release_component(match[2]) == PYSPARK_SUPPORTED_MINOR
    ):
        return "supported-final"
    return "acceptance-denial" if version in PYSPARK_ACCEPTANCE_PRERELEASE_DENIAL else "unsupported"


def is_supported_pyspark_version(version: str) -> bool:
    return classify_pyspark_version(version) == "supported-final"


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

function normalizeReleaseComponent(component) {
  return component.replace(/^0+/u, "") || "0";
}
