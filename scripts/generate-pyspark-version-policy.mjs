import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { format as formatWithPrettier, resolveConfig as resolvePrettierConfig } from "prettier";

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
validateExamples(contract, policy);
const prettierConfig = (await resolvePrettierConfig(typeScriptOutputPath)) ?? {};
const outputs = [
  [
    typeScriptOutputPath,
    await formatWithPrettier(renderTypeScript(contract, policy), {
      ...prettierConfig,
      filepath: typeScriptOutputPath,
      parser: "typescript"
    }),
    "TypeScript PySpark version policy"
  ],
  [pythonOutputPath, renderPython(contract, policy), "Python PySpark version policy"]
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
    !hasExactKeys(policyValue, ["localVersion", "maxCharacters", "release", "schemaVersion"]) ||
    policyValue.schemaVersion !== 1 ||
    !Number.isSafeInteger(policyValue.maxCharacters) ||
    policyValue.maxCharacters < 1 ||
    policyValue.maxCharacters > 256 ||
    !isPlainRecord(policyValue.release) ||
    !hasExactKeys(policyValue.release, ["components", "separator"]) ||
    policyValue.release.separator !== "." ||
    !Array.isArray(policyValue.release.components) ||
    policyValue.release.components.length !== 3 ||
    !isPlainRecord(policyValue.localVersion) ||
    !hasExactKeys(policyValue.localVersion, ["prefix", "segmentCharacters", "segmentSeparators"])
  ) {
    throw new Error("The declarative PySpark version policy is malformed.");
  }
  const [major, minor, patch] = policyValue.release.components;
  if (
    !isPlainRecord(major) ||
    !hasExactKeys(major, ["equals", "kind"]) ||
    major.kind !== "normalizedInteger" ||
    !Number.isSafeInteger(major.equals) ||
    major.equals < 0 ||
    !isPlainRecord(minor) ||
    !hasExactKeys(minor, ["equals", "kind"]) ||
    minor.kind !== "normalizedInteger" ||
    !Number.isSafeInteger(minor.equals) ||
    minor.equals < 0 ||
    !isPlainRecord(patch) ||
    !hasExactKeys(patch, ["kind"]) ||
    patch.kind !== "integer" ||
    policyValue.localVersion.prefix !== "+" ||
    policyValue.localVersion.segmentCharacters !== "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz" ||
    policyValue.localVersion.segmentSeparators !== "._-"
  ) {
    throw new Error("The declarative PySpark version policy must encode the reviewed final-release grammar.");
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

function validateExamples(contractValue, policy) {
  const classify = executableClassifier(policy, contractValue.acceptancePrereleaseDenial);
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

function executableClassifier(policy, acceptancePrereleaseDenial) {
  const denialVersions = new Set(acceptancePrereleaseDenial);
  return (version) => {
    if (isSupportedFinalVersion(version, policy)) return "supported-final";
    return denialVersions.has(version) ? "acceptance-denial" : "unsupported";
  };
}

function isSupportedFinalVersion(version, policy) {
  if (typeof version !== "string" || version.length === 0 || version.length > policy.maxCharacters) return false;
  const localParts = version.split(policy.localVersion.prefix);
  if (localParts.length > 2) return false;
  const releaseParts = localParts[0].split(policy.release.separator);
  if (
    releaseParts.length !== policy.release.components.length ||
    !releaseParts.every(isAsciiInteger) ||
    normalizeReleaseComponent(releaseParts[0]) !== String(policy.release.components[0].equals) ||
    normalizeReleaseComponent(releaseParts[1]) !== String(policy.release.components[1].equals)
  ) {
    return false;
  }
  return localParts.length === 1 || isValidLocalVersion(localParts[1], policy.localVersion);
}

function isAsciiInteger(value) {
  return value.length > 0 && [...value].every((character) => character >= "0" && character <= "9");
}

function isValidLocalVersion(value, policy) {
  if (value.length === 0) return false;
  let segmentLength = 0;
  for (const character of value) {
    if (policy.segmentCharacters.includes(character)) {
      segmentLength += 1;
      continue;
    }
    if (!policy.segmentSeparators.includes(character) || segmentLength === 0) return false;
    segmentLength = 0;
  }
  return segmentLength > 0;
}

function renderTypeScript(contractValue, policy) {
  const embeddedPython = renderEmbeddedPythonClassifier(contractValue, policy);
  return `/* Generated from fixtures/pyspark-version-contract.json. Do not edit. */
export const MAX_PYSPARK_VERSION_CHARACTERS = ${policy.maxCharacters};
export const PYSPARK_SUPPORTED_MAJOR = ${JSON.stringify(String(policy.release.components[0].equals))};
export const PYSPARK_SUPPORTED_MINOR = ${JSON.stringify(String(policy.release.components[1].equals))};
export const PYSPARK_ACCEPTANCE_PRERELEASE_DENIAL = Object.freeze(${JSON.stringify(
    contractValue.acceptancePrereleaseDenial
  )});
export const PYSPARK_VERSION_POLICY_PYTHON_SOURCE = ${JSON.stringify(embeddedPython)};

const ACCEPTANCE_PRERELEASE_DENIAL = new Set<string>(PYSPARK_ACCEPTANCE_PRERELEASE_DENIAL);
const LOCAL_VERSION_CHARACTERS = ${JSON.stringify(policy.localVersion.segmentCharacters)};
const LOCAL_VERSION_SEPARATORS = ${JSON.stringify(policy.localVersion.segmentSeparators)};

export type PySparkVersionClassification = "supported-final" | "acceptance-denial" | "unsupported";

export function classifyPySparkVersion(version: unknown): PySparkVersionClassification {
  if (isSupportedFinalVersion(version)) return "supported-final";
  return typeof version === "string" && ACCEPTANCE_PRERELEASE_DENIAL.has(version)
    ? "acceptance-denial"
    : "unsupported";
}

export function isSupportedPySparkVersion(version: unknown): boolean {
  return classifyPySparkVersion(version) === "supported-final";
}

export function safePySparkVersionDiagnostic(version: unknown): string | null {
  if (typeof version !== "string" || version.length === 0 || version.length > MAX_PYSPARK_VERSION_CHARACTERS) {
    return null;
  }
  return [...version].every((character) => {
    const codePoint = character.codePointAt(0)!;
    return codePoint >= 0x20 && codePoint <= 0x7e;
  })
    ? version
    : null;
}

function isSupportedFinalVersion(version: unknown): version is string {
  if (typeof version !== "string" || version.length === 0 || version.length > MAX_PYSPARK_VERSION_CHARACTERS) {
    return false;
  }
  const localParts = version.split("+");
  if (localParts.length > 2) return false;
  const releaseParts = localParts[0]!.split(".");
  if (
    releaseParts.length !== 3 ||
    !releaseParts.every(isAsciiInteger) ||
    normalizeReleaseComponent(releaseParts[0]!) !== PYSPARK_SUPPORTED_MAJOR ||
    normalizeReleaseComponent(releaseParts[1]!) !== PYSPARK_SUPPORTED_MINOR
  ) {
    return false;
  }
  return localParts.length === 1 || isValidLocalVersion(localParts[1]!);
}

function isAsciiInteger(value: string): boolean {
  return value.length > 0 && [...value].every((character) => character >= "0" && character <= "9");
}

function isValidLocalVersion(value: string): boolean {
  if (value.length === 0) return false;
  let segmentLength = 0;
  for (const character of value) {
    if (LOCAL_VERSION_CHARACTERS.includes(character)) {
      segmentLength += 1;
      continue;
    }
    if (!LOCAL_VERSION_SEPARATORS.includes(character) || segmentLength === 0) return false;
    segmentLength = 0;
  }
  return segmentLength > 0;
}

function normalizeReleaseComponent(component: string): string {
  let firstNonzero = 0;
  while (firstNonzero < component.length - 1 && component[firstNonzero] === "0") firstNonzero += 1;
  return component.slice(firstNonzero);
}
`;
}

function renderPython(contractValue, policy) {
  return `# Generated from fixtures/pyspark-version-contract.json. Do not edit.
from __future__ import annotations

MAX_PYSPARK_VERSION_CHARACTERS = ${policy.maxCharacters}
PYSPARK_SUPPORTED_MAJOR = ${JSON.stringify(String(policy.release.components[0].equals))}
PYSPARK_SUPPORTED_MINOR = ${JSON.stringify(String(policy.release.components[1].equals))}
PYSPARK_ACCEPTANCE_PRERELEASE_DENIAL = frozenset(${JSON.stringify(contractValue.acceptancePrereleaseDenial)})
_LOCAL_VERSION_CHARACTERS = frozenset(${JSON.stringify(policy.localVersion.segmentCharacters)})
_LOCAL_VERSION_SEPARATORS = frozenset(${JSON.stringify(policy.localVersion.segmentSeparators)})


def classify_pyspark_version(version: object) -> str:
    if _is_supported_final_version(version):
        return "supported-final"
    if isinstance(version, str) and version in PYSPARK_ACCEPTANCE_PRERELEASE_DENIAL:
        return "acceptance-denial"
    return "unsupported"


def is_supported_pyspark_version(version: object) -> bool:
    return classify_pyspark_version(version) == "supported-final"


def safe_pyspark_version_diagnostic(version: object) -> str | None:
    if not isinstance(version, str) or not 0 < len(version) <= MAX_PYSPARK_VERSION_CHARACTERS:
        return None
    return version if all(0x20 <= ord(character) <= 0x7E for character in version) else None


def _is_supported_final_version(version: object) -> bool:
    if not isinstance(version, str) or not 0 < len(version) <= MAX_PYSPARK_VERSION_CHARACTERS:
        return False
    local_parts = version.split("+")
    if len(local_parts) > 2:
        return False
    release_parts = local_parts[0].split(".")
    if (
        len(release_parts) != 3
        or not all(_is_ascii_integer(component) for component in release_parts)
        or _normalize_release_component(release_parts[0]) != PYSPARK_SUPPORTED_MAJOR
        or _normalize_release_component(release_parts[1]) != PYSPARK_SUPPORTED_MINOR
    ):
        return False
    return len(local_parts) == 1 or _is_valid_local_version(local_parts[1])


def _is_ascii_integer(value: str) -> bool:
    return bool(value) and all("0" <= character <= "9" for character in value)


def _is_valid_local_version(value: str) -> bool:
    if not value:
        return False
    segment_length = 0
    for character in value:
        if character in _LOCAL_VERSION_CHARACTERS:
            segment_length += 1
            continue
        if character not in _LOCAL_VERSION_SEPARATORS or segment_length == 0:
            return False
        segment_length = 0
    return segment_length > 0


def _normalize_release_component(component: str) -> str:
    return component.lstrip("0") or "0"
`;
}

function renderEmbeddedPythonClassifier(contractValue, policy) {
  return `def __ow_classify_pyspark_version_v1(__ow_value):
    if not isinstance(__ow_value, str) or not 0 < len(__ow_value) <= ${policy.maxCharacters}:
        return "unsupported"
    __ow_local_parts = __ow_value.split("+")
    __ow_supported = False
    if len(__ow_local_parts) <= 2:
        __ow_release_parts = __ow_local_parts[0].split(".")
        __ow_release_valid = (
            len(__ow_release_parts) == 3
            and all(__ow_part and all("0" <= __ow_character <= "9" for __ow_character in __ow_part) for __ow_part in __ow_release_parts)
            and (__ow_release_parts[0].lstrip("0") or "0") == ${JSON.stringify(
              String(policy.release.components[0].equals)
            )}
            and (__ow_release_parts[1].lstrip("0") or "0") == ${JSON.stringify(
              String(policy.release.components[1].equals)
            )}
        )
        if __ow_release_valid:
            if len(__ow_local_parts) == 1:
                __ow_supported = True
            else:
                __ow_local_value = __ow_local_parts[1]
                __ow_segment_length = 0
                __ow_local_valid = bool(__ow_local_value)
                for __ow_character in __ow_local_value:
                    if __ow_character in ${JSON.stringify(policy.localVersion.segmentCharacters)}:
                        __ow_segment_length += 1
                    elif __ow_character in ${JSON.stringify(
                      policy.localVersion.segmentSeparators
                    )} and __ow_segment_length > 0:
                        __ow_segment_length = 0
                    else:
                        __ow_local_valid = False
                        break
                __ow_supported = __ow_local_valid and __ow_segment_length > 0
    if __ow_supported:
        return "supported-final"
    return "acceptance-denial" if __ow_value in ${pythonTuple(
      contractValue.acceptancePrereleaseDenial
    )} else "unsupported"

def __ow_safe_pyspark_version_diagnostic_v1(__ow_value):
    if not isinstance(__ow_value, str) or not 0 < len(__ow_value) <= ${policy.maxCharacters}:
        return None
    return __ow_value if all(0x20 <= ord(__ow_character) <= 0x7e for __ow_character in __ow_value) else None
`;
}

function isPlainRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value, expected) {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return actual.length === sortedExpected.length && actual.every((key, index) => key === sortedExpected[index]);
}

function normalizeReleaseComponent(component) {
  let firstNonzero = 0;
  while (firstNonzero < component.length - 1 && component[firstNonzero] === "0") firstNonzero += 1;
  return component.slice(firstNonzero);
}

function pythonTuple(values) {
  return `(${values.map((value) => JSON.stringify(value)).join(", ")},)`;
}
