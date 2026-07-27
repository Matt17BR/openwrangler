import { appendFileSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { DuplicateJsonKeyError, parseStrictJson } from "./strict-json.mjs";

export const NUMERIC_RELEASE_VERSION = /^(?<major>0|[1-9]\d*)\.(?<minor>0|[1-9]\d*)\.(?<patch>0|[1-9]\d*)$/u;

export function classifyNumericReleaseVersion(version) {
  const match = typeof version === "string" ? NUMERIC_RELEASE_VERSION.exec(version) : null;
  if (match === null) {
    return undefined;
  }
  const major = BigInt(match.groups?.major ?? "");
  const minor = BigInt(match.groups?.minor ?? "");
  return Object.freeze({
    channel: major === 0n && minor % 2n === 1n ? "preview" : "stable",
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

  appendFileSync(
    process.env.GITHUB_OUTPUT,
    `version=${result.version}\nprerelease=${String(result.prerelease)}\n`,
    "utf8"
  );
}

if (process.argv[1] !== undefined && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  runCli();
}
