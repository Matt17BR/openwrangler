import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseStrictJson } from "./strict-json.mjs";

const FULL_SHA = /^[0-9a-f]{40}$/u;
const NUMERIC_VERSION = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u;

export function dailyPreviewIdentity(environment = process.env) {
  const ref = environment.GITHUB_REF;
  const sourceSha = environment.GITHUB_SHA;
  if (ref !== "refs/heads/main") throw new Error("A daily preview must come from refs/heads/main.");
  if (!FULL_SHA.test(sourceSha ?? "")) throw new Error("GITHUB_SHA must be one lowercase commit SHA.");
  return Object.freeze({
    id: `main-${sourceSha.slice(0, 12)}`,
    version: `0.${BigInt(`0x${sourceSha.slice(0, 10)}`) * 2n + 1n}.${BigInt(`0x${sourceSha.slice(10, 20)}`)}`
  });
}

function parseVersionPair(packageJsonSource, runtimeVersionSource, label) {
  const manifest = parseStrictJson(packageJsonSource, { maxBytes: 1024 * 1024 });
  const runtimeVersion = /^__version__ = "([^"]+)"$/mu.exec(runtimeVersionSource)?.[1];
  if (
    manifest === null ||
    typeof manifest !== "object" ||
    Array.isArray(manifest) ||
    manifest.name !== "openwrangler" ||
    manifest.publisher !== "Matt17BR" ||
    !NUMERIC_VERSION.test(manifest.version ?? "") ||
    typeof manifest.preview !== "boolean" ||
    runtimeVersion !== manifest.version
  ) {
    throw new Error(`${label} extension and runtime version metadata must match.`);
  }
  return { manifest, version: manifest.version };
}

export function prepareDailyPreviewSource({
  packageJsonPath,
  runtimeVersionPath,
  sourcePackageJson,
  sourceRuntimeVersion,
  environment = process.env
}) {
  const identity = dailyPreviewIdentity(environment);
  const packagePath = resolve(packageJsonPath);
  const runtimePath = resolve(runtimeVersionPath);
  const currentPackage = readFileSync(packagePath, "utf8");
  const currentRuntime = readFileSync(runtimePath, "utf8");
  if (currentPackage !== sourcePackageJson || currentRuntime !== sourceRuntimeVersion) {
    throw new Error("Daily preview preparation requires unchanged source version files.");
  }
  const source = parseVersionPair(sourcePackageJson, sourceRuntimeVersion, "Source");
  if (source.version === identity.version) throw new Error("A daily preview must not reuse the source version.");
  const packageBytes = `${JSON.stringify({ ...source.manifest, version: identity.version, preview: true }, null, 2)}\n`;
  const runtimeBytes = currentRuntime.replace(/^__version__ = "[^"]+"$/mu, `__version__ = "${identity.version}"`);
  parseVersionPair(packageBytes, runtimeBytes, "Prepared daily preview");
  writeFileSync(packagePath, packageBytes, { flag: "w" });
  writeFileSync(runtimePath, runtimeBytes, { flag: "w" });
  return identity;
}

function appendOutputs(result, outputPath) {
  if (!outputPath) throw new Error("GITHUB_OUTPUT is required.");
  appendFileSync(outputPath, [`preview_id=${result.id}`, `extension_version=${result.version}`, ""].join("\n"), "utf8");
}

function main(arguments_, environment) {
  if (arguments_.length !== 1 || arguments_[0] !== "prepare") {
    throw new Error("Usage: node scripts/daily-preview-artifact.mjs prepare");
  }
  const sourcePackageJson = execFileSync("git", ["show", `${environment.GITHUB_SHA}:package.json`], {
    encoding: "utf8"
  });
  const sourceRuntimeVersion = execFileSync(
    "git",
    ["show", `${environment.GITHUB_SHA}:python/openwrangler_runtime/version.py`],
    { encoding: "utf8" }
  );
  appendOutputs(
    prepareDailyPreviewSource({
      packageJsonPath: "package.json",
      runtimeVersionPath: "python/openwrangler_runtime/version.py",
      sourcePackageJson,
      sourceRuntimeVersion,
      environment
    }),
    environment.GITHUB_OUTPUT
  );
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : undefined;
if (invokedPath === import.meta.url) {
  try {
    main(process.argv.slice(2), process.env);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : "Daily preview preparation failed."}\n`);
    process.exitCode = 1;
  }
}
