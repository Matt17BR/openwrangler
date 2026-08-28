import { appendFileSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { DuplicateJsonKeyError, parseStrictJson } from "./strict-json.mjs";

export const NUMERIC_RELEASE_VERSION = /^(?<major>0|[1-9]\d*)\.(?<minor>0|[1-9]\d*)\.(?<patch>0|[1-9]\d*)$/u;
export const MAIN_RELEASE_BRANCH = "main";
const LAST_HISTORICAL_TAG_RECOVERY = Object.freeze([1n, 2n, 2n]);
const LAST_MANUAL_V2_PREVIEW = 7n;
const DAILY_PREVIEW_VERSION = /^1\.99\.(?<year>[2-9]\d{3})(?<month>0[1-9]|1[0-2])(?<day>0[1-9]|[12]\d|3[01])$/u;

export function dailyPreviewDateFromVersion(version) {
  const match = typeof version === "string" ? DAILY_PREVIEW_VERSION.exec(version) : null;
  if (match === null) return undefined;
  const year = Number(match.groups?.year);
  const month = Number(match.groups?.month);
  const day = Number(match.groups?.day);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    return undefined;
  }
  return `${match.groups.year}${match.groups.month}${match.groups.day}`;
}

export function dailyPreviewVersionFromDate(date) {
  if (typeof date !== "string" || !/^\d{8}$/u.test(date)) return undefined;
  const version = `1.99.${date}`;
  return dailyPreviewDateFromVersion(version) === date ? version : undefined;
}

export function isDailyPreviewVersion(version) {
  return dailyPreviewDateFromVersion(version) !== undefined;
}

function numericVersionParts(version) {
  const match = typeof version === "string" ? NUMERIC_RELEASE_VERSION.exec(version) : null;
  if (match === null) {
    return undefined;
  }
  return Object.freeze([
    BigInt(match.groups?.major ?? ""),
    BigInt(match.groups?.minor ?? ""),
    BigInt(match.groups?.patch ?? "")
  ]);
}

export function isHistoricalTagRecoveryVersion(version) {
  const parts = numericVersionParts(version);
  if (parts === undefined) {
    return false;
  }
  for (let index = 0; index < parts.length; index += 1) {
    if (parts[index] < LAST_HISTORICAL_TAG_RECOVERY[index]) return true;
    if (parts[index] > LAST_HISTORICAL_TAG_RECOVERY[index]) return false;
  }
  return true;
}

export function releaseSourcePolicyForVersion(version) {
  if (numericVersionParts(version) === undefined) {
    return undefined;
  }
  return Object.freeze({ branch: MAIN_RELEASE_BRANCH, ref: `refs/heads/${MAIN_RELEASE_BRANCH}`, version });
}

export function classifyNumericReleaseVersion(version) {
  const match = typeof version === "string" ? NUMERIC_RELEASE_VERSION.exec(version) : null;
  if (match === null) {
    return undefined;
  }
  const major = BigInt(match.groups?.major ?? "");
  const minor = BigInt(match.groups?.minor ?? "");
  const isLegacyPreview = major === 0n && minor % 2n === 1n;
  const patch = BigInt(match.groups?.patch ?? "");
  const isV2PreviewLine = major === 1n && minor === 99n;
  if (isV2PreviewLine && patch > LAST_MANUAL_V2_PREVIEW && !isDailyPreviewVersion(version)) return undefined;
  return Object.freeze({
    channel: isLegacyPreview || isV2PreviewLine ? "preview" : "stable",
    version
  });
}

export function inspectReleaseMetadata({ releaseTag, packageJson }) {
  const problems = [];
  let manifest;
  try {
    manifest = parseStrictJson(packageJson);
  } catch (error) {
    problems.push(
      error instanceof DuplicateJsonKeyError
        ? "package.json must not contain duplicate object keys."
        : "package.json must contain valid bounded JSON."
    );
  }
  if (typeof manifest !== "object" || manifest === null || Array.isArray(manifest)) {
    if (manifest !== undefined) {
      problems.push("package.json must contain a JSON object.");
    }
    return { problems, prerelease: undefined, version: undefined };
  }

  const version = typeof manifest.version === "string" ? manifest.version : undefined;
  const classification = classifyNumericReleaseVersion(version);
  if (classification === undefined) {
    problems.push(
      `Release versions must use Marketplace-compatible major.minor.patch numbers; received ${String(
        manifest.version
      )}.`
    );
  }
  const parts = numericVersionParts(version);
  if (parts?.[0] === 1n && parts[1] === 99n && parts[2] > LAST_MANUAL_V2_PREVIEW && !isDailyPreviewVersion(version)) {
    problems.push("Manual 1.99.N previews end at 1.99.7; automatic previews must use 1.99.YYYYMMDD.");
  }
  if (typeof manifest.preview !== "boolean") {
    problems.push('package.json "preview" must be an explicit boolean for every release.');
  }

  if (classification !== undefined && typeof manifest.preview === "boolean") {
    const isPreviewVersion = classification.channel === "preview";
    if (manifest.preview !== isPreviewVersion) {
      problems.push(
        isPreviewVersion
          ? `Preview-channel version ${version} requires package.json "preview" to be true.`
          : `Version ${version} is not a permitted preview-channel number and requires package.json "preview" to be false.`
      );
    }
  }

  if (version !== undefined && releaseTag !== `v${version}`) {
    problems.push(`Release tag ${String(releaseTag)} does not match package version v${version}.`);
  }

  return {
    problems,
    prerelease: typeof manifest.preview === "boolean" ? manifest.preview : undefined,
    version
  };
}

export function inspectPreviewReleaseMetadata(input) {
  const result = inspectReleaseMetadata(input);
  if (result.prerelease !== false) {
    return result;
  }
  return {
    ...result,
    problems: [
      ...result.problems,
      "The tag release workflow is preview-only; stable publication must promote provenance-bound tested artifacts without rebuilding them."
    ]
  };
}

export function inspectWorkflowReleaseMetadata(input, mode) {
  if (mode === undefined) {
    return inspectReleaseMetadata(input);
  }
  if (mode === "--preview-only") {
    return inspectPreviewReleaseMetadata(input);
  }
  throw new Error("release-metadata.mjs accepts only its stable-candidate mode or the exact --preview-only tag mode.");
}

function runCli() {
  if (process.argv.length > 3) {
    throw new Error(
      "release-metadata.mjs accepts only its stable-candidate mode or the exact --preview-only tag mode."
    );
  }
  const root = resolve(import.meta.dirname, "..");
  const result = inspectWorkflowReleaseMetadata(
    {
      releaseTag: process.env.RELEASE_TAG,
      packageJson: readFileSync(resolve(root, "package.json"), "utf8")
    },
    process.argv[2]
  );
  if (result.problems.length > 0 || result.version === undefined || result.prerelease === undefined) {
    throw new Error(`Release metadata validation failed:\n- ${result.problems.join("\n- ")}`);
  }
  if (!process.env.GITHUB_OUTPUT) {
    throw new Error("GITHUB_OUTPUT is required to publish validated release metadata.");
  }
  const sourcePolicy = releaseSourcePolicyForVersion(result.version);
  if (sourcePolicy === undefined) {
    throw new Error("Release metadata does not have a protected source-branch policy.");
  }

  appendFileSync(
    process.env.GITHUB_OUTPUT,
    `version=${result.version}\nprerelease=${String(result.prerelease)}\nsource_branch=${sourcePolicy.branch}\nsource_ref=${sourcePolicy.ref}\n`,
    "utf8"
  );
}

if (process.argv[1] !== undefined && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  runCli();
}
