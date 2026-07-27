import { appendFileSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { DuplicateJsonKeyError, parseStrictJson } from "./strict-json.mjs";

export const NUMERIC_RELEASE_VERSION = /^(?<major>0|[1-9]\d*)\.(?<minor>0|[1-9]\d*)\.(?<patch>0|[1-9]\d*)$/u;

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
  const versionMatch = version === undefined ? null : NUMERIC_RELEASE_VERSION.exec(version);
  if (versionMatch === null) {
    problems.push(
      `Release versions must use Marketplace-compatible major.minor.patch numbers; received ${String(
        manifest.version
      )}.`
    );
  }
  if (typeof manifest.preview !== "boolean") {
    problems.push('package.json "preview" must be an explicit boolean for every release.');
  }

  if (versionMatch !== null && typeof manifest.preview === "boolean") {
    const major = BigInt(versionMatch.groups?.major ?? "");
    const minor = BigInt(versionMatch.groups?.minor ?? "");
    const isPreviewVersion = major === 0n && minor % 2n === 1n;
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

function runCli() {
  const root = resolve(import.meta.dirname, "..");
  const result = inspectReleaseMetadata({
    releaseTag: process.env.RELEASE_TAG,
    packageJson: readFileSync(resolve(root, "package.json"), "utf8")
  });
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
