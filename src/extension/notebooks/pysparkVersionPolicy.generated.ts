/* Generated from fixtures/pyspark-version-contract.json. Do not edit. */
export const MAX_PYSPARK_VERSION_CHARACTERS = 64;
export const PYSPARK_SUPPORTED_MAJOR = "4";
export const PYSPARK_SUPPORTED_MINOR = "2";
export const PYSPARK_ACCEPTANCE_PRERELEASE_DENIAL = Object.freeze(["4.2.0.dev5"]);
export const PYSPARK_FINAL_VERSION_PATTERN =
  "^([0123456789]+)\\.([0123456789]+)\\.[0123456789]+(?:\\+[0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz]+(?:[._\\-][0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz]+)*)?$";

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
