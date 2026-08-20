/* Generated from fixtures/pyspark-version-contract.json. Do not edit. */
export const MAX_PYSPARK_VERSION_CHARACTERS = 64;
export const PYSPARK_SUPPORTED_MAJOR = "4";
export const PYSPARK_SUPPORTED_MINOR = "2";
export const PYSPARK_ACCEPTANCE_PRERELEASE_DENIAL = Object.freeze(["4.2.0.dev5"]);
export const PYSPARK_VERSION_POLICY_PYTHON_SOURCE =
  'def __ow_classify_pyspark_version_v1(__ow_value):\n    if not isinstance(__ow_value, str) or not 0 < len(__ow_value) <= 64:\n        return "unsupported"\n    __ow_local_parts = __ow_value.split("+")\n    __ow_supported = False\n    if len(__ow_local_parts) <= 2:\n        __ow_release_parts = __ow_local_parts[0].split(".")\n        __ow_release_valid = (\n            len(__ow_release_parts) == 3\n            and all(__ow_part and all("0" <= __ow_character <= "9" for __ow_character in __ow_part) for __ow_part in __ow_release_parts)\n            and (__ow_release_parts[0].lstrip("0") or "0") == "4"\n            and (__ow_release_parts[1].lstrip("0") or "0") == "2"\n        )\n        if __ow_release_valid:\n            if len(__ow_local_parts) == 1:\n                __ow_supported = True\n            else:\n                __ow_local_value = __ow_local_parts[1]\n                __ow_segment_length = 0\n                __ow_local_valid = bool(__ow_local_value)\n                for __ow_character in __ow_local_value:\n                    if __ow_character in "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz":\n                        __ow_segment_length += 1\n                    elif __ow_character in "._-" and __ow_segment_length > 0:\n                        __ow_segment_length = 0\n                    else:\n                        __ow_local_valid = False\n                        break\n                __ow_supported = __ow_local_valid and __ow_segment_length > 0\n    if __ow_supported:\n        return "supported-final"\n    return "acceptance-denial" if __ow_value in ("4.2.0.dev5",) else "unsupported"\n\ndef __ow_safe_pyspark_version_diagnostic_v1(__ow_value):\n    if not isinstance(__ow_value, str) or not 0 < len(__ow_value) <= 64:\n        return None\n    return __ow_value if all(0x20 <= ord(__ow_character) <= 0x7e for __ow_character in __ow_value) else None\n';

const ACCEPTANCE_PRERELEASE_DENIAL = new Set<string>(PYSPARK_ACCEPTANCE_PRERELEASE_DENIAL);
const LOCAL_VERSION_CHARACTERS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const LOCAL_VERSION_SEPARATORS = "._-";

export type PySparkVersionClassification = "supported-final" | "acceptance-denial" | "unsupported";

export function classifyPySparkVersion(version: unknown): PySparkVersionClassification {
  if (isSupportedFinalVersion(version)) return "supported-final";
  return typeof version === "string" && ACCEPTANCE_PRERELEASE_DENIAL.has(version) ? "acceptance-denial" : "unsupported";
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
