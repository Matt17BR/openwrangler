import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { classifyNumericReleaseVersion } from "./release-metadata.mjs";
import { parseStrictJson } from "./strict-json.mjs";

const PACKAGE_JSON_MAX_BYTES = 1024 * 1024;

function readPackageChannel(packageJson) {
  let manifest;
  try {
    manifest = parseStrictJson(packageJson, { maxBytes: PACKAGE_JSON_MAX_BYTES });
  } catch {
    throw new Error("package-current-channel requires one valid, bounded package.json without duplicate keys.");
  }
  if (typeof manifest !== "object" || manifest === null || Array.isArray(manifest)) {
    throw new Error("package-current-channel requires package.json to contain one JSON object.");
  }

  const classification = classifyNumericReleaseVersion(manifest.version);
  if (classification === undefined) {
    throw new Error("package-current-channel requires a Marketplace-compatible major.minor.patch version.");
  }
  if (typeof manifest.preview !== "boolean") {
    throw new Error('package-current-channel requires package.json "preview" to be an explicit boolean.');
  }

  const expectedPreview = classification.channel === "preview";
  if (manifest.preview !== expectedPreview) {
    throw new Error(
      expectedPreview
        ? `Preview-channel version ${classification.version} requires package.json "preview" to be true.`
        : `Stable-channel version ${classification.version} requires package.json "preview" to be false.`
    );
  }
  return classification.channel;
}

export function resolveCurrentChannelPackageArguments({ arguments_, packageJson }) {
  if (!Array.isArray(arguments_) || arguments_.some((argument) => typeof argument !== "string")) {
    throw new TypeError("Package arguments must be an array of strings.");
  }

  const channel = readPackageChannel(packageJson);
  const requestedPrerelease = arguments_[0] === "--pre-release";
  const outputArguments = requestedPrerelease ? arguments_.slice(1) : arguments_;
  if (
    outputArguments.length !== 2 ||
    outputArguments[0] !== "--out" ||
    outputArguments[1] === undefined ||
    outputArguments[1].length === 0 ||
    outputArguments[1].startsWith("-") ||
    /[\0\r\n]/u.test(outputArguments[1])
  ) {
    throw new Error(
      "Package arguments must be exactly --out <non-option path>, with an optional leading --pre-release."
    );
  }
  if (channel === "stable" && requestedPrerelease) {
    throw new Error("Stable-channel packaging must not receive --pre-release.");
  }

  return Object.freeze([
    "package",
    "--no-gitHubIssueLinking",
    ...(channel === "preview" ? ["--pre-release"] : []),
    "--out",
    outputArguments[1]
  ]);
}

function runCli() {
  const root = resolve(import.meta.dirname, "..");
  const arguments_ = resolveCurrentChannelPackageArguments({
    arguments_: process.argv.slice(2),
    packageJson: readFileSync(resolve(root, "package.json"), "utf8")
  });
  execFileSync(process.execPath, [resolve(root, "node_modules", "@vscode", "vsce", "vsce"), ...arguments_], {
    cwd: root,
    stdio: "inherit",
    windowsHide: true
  });
}

if (process.argv[1] !== undefined && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  runCli();
}
