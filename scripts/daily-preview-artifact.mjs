import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { withPinnedCanonicalReleaseAssets } from "./canonical-release-assets.mjs";
import { readOwnedVsixSnapshot } from "./release-readiness.mjs";
import { parseStrictJson } from "./strict-json.mjs";

const FULL_SHA = /^[0-9a-f]{40}$/u;
const POSITIVE_INTEGER = /^[1-9][0-9]*$/u;
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;
const NUMERIC_VERSION = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u;
const PROTOCOL = "openwrangler-daily-preview-v1";
const VSIX_NAME = "openwrangler.vsix";
const CHECKSUM_NAME = `${VSIX_NAME}.sha256`;
const PROVENANCE_NAME = `${VSIX_NAME}.provenance.json`;

function positiveInteger(value, label) {
  if (!POSITIVE_INTEGER.test(value ?? "")) throw new Error(`${label} must be a positive decimal integer.`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error(`${label} exceeds the safe integer range.`);
  return parsed;
}

function exactKeys(value, expected, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new Error(`${label} has an unexpected shape.`);
  }
}

export function dailyPreviewIdentity(environment = process.env) {
  const repository = environment.GITHUB_REPOSITORY;
  const ref = environment.GITHUB_REF;
  const sourceSha = environment.GITHUB_SHA;
  if (!REPOSITORY.test(repository ?? "")) throw new Error("GITHUB_REPOSITORY is invalid.");
  if (ref !== "refs/heads/main") throw new Error("A daily preview must come from refs/heads/main.");
  if (!FULL_SHA.test(sourceSha ?? "")) throw new Error("GITHUB_SHA must be one lowercase commit SHA.");
  const runAttempt = positiveInteger(environment.GITHUB_RUN_ATTEMPT, "GITHUB_RUN_ATTEMPT");
  if (runAttempt !== 1) throw new Error("Daily preview evidence may come only from the first workflow attempt.");
  const runId = positiveInteger(environment.GITHUB_RUN_ID, "GITHUB_RUN_ID");
  const runNumber = positiveInteger(environment.GITHUB_RUN_NUMBER, "GITHUB_RUN_NUMBER");
  const version = `0.${BigInt(`0x${sourceSha.slice(0, 10)}`) * 2n + 1n}.${BigInt(`0x${sourceSha.slice(10, 20)}`)}`;
  return Object.freeze({
    id: `main-${sourceSha.slice(0, 12)}`,
    ref,
    repository,
    runAttempt,
    runId,
    runNumber,
    sourceSha,
    version
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
    throw new Error("Daily preview preparation requires exact unmodified protected-main version metadata.");
  }
  const source = parseVersionPair(sourcePackageJson, sourceRuntimeVersion, "Protected-main");
  if (source.version === identity.version)
    throw new Error("A daily preview must not reuse the source release identity.");
  const packageBytes = `${JSON.stringify({ ...source.manifest, version: identity.version, preview: true }, null, 2)}\n`;
  const runtimeBytes = currentRuntime.replace(/^__version__ = "[^"]+"$/mu, `__version__ = "${identity.version}"`);
  parseVersionPair(packageBytes, runtimeBytes, "Prepared daily preview");
  writeFileSync(packagePath, packageBytes, { flag: "w" });
  writeFileSync(runtimePath, runtimeBytes, { flag: "w" });
  return Object.freeze({ ...identity, sourceVersion: source.version });
}

export function createDailyPreviewArtifact({
  candidatePath,
  packageJsonPath,
  sourceVersion,
  environment = process.env
}) {
  const identity = dailyPreviewIdentity(environment);
  const resolvedCandidate = resolve(candidatePath);
  if (basename(resolvedCandidate) !== VSIX_NAME) throw new Error(`The daily preview VSIX must be named ${VSIX_NAME}.`);
  const candidate = readOwnedVsixSnapshot(resolvedCandidate);
  const packageJson = parseStrictJson(readFileSync(resolve(packageJsonPath), "utf8"), { maxBytes: 1024 * 1024 });
  if (packageJson?.version !== identity.version || packageJson?.preview !== true) {
    throw new Error("The packaged daily preview must use the source-derived disposable identity.");
  }
  if (!NUMERIC_VERSION.test(sourceVersion ?? "") || sourceVersion === identity.version) {
    throw new Error("The daily preview requires a distinct protected-main source version.");
  }
  const provenance = {
    protocol: PROTOCOL,
    kind: "daily-preview",
    disposable: true,
    id: identity.id,
    source: {
      repository: identity.repository,
      ref: identity.ref,
      sha: identity.sourceSha,
      version: sourceVersion
    },
    workflow: {
      name: "Daily preview",
      runId: identity.runId,
      runNumber: identity.runNumber,
      runAttempt: identity.runAttempt
    },
    extension: { version: identity.version, preview: true },
    artifact: { file: VSIX_NAME, bytes: candidate.bytes.length, sha256: candidate.sha256 }
  };
  const directory = dirname(resolvedCandidate);
  writeFileSync(join(directory, CHECKSUM_NAME), `${candidate.sha256}  ${VSIX_NAME}\n`, { flag: "wx", mode: 0o600 });
  writeFileSync(join(directory, PROVENANCE_NAME), `${JSON.stringify(provenance, null, 2)}\n`, {
    flag: "wx",
    mode: 0o600
  });
  return Object.freeze({
    ...identity,
    bytes: candidate.bytes.length,
    sha256: candidate.sha256,
    sourceVersion
  });
}

export async function verifyDailyPreviewArtifact({ directory, environment = process.env }) {
  const identity = dailyPreviewIdentity(environment);
  return withPinnedCanonicalReleaseAssets(directory, (pinned) => {
    const [candidate, provenanceAsset, checksum] = pinned.assets;
    const checksumText = checksum.bytes.toString("utf8");
    if (checksumText !== `${candidate.sha256}  ${VSIX_NAME}\n`) {
      throw new Error("The daily preview checksum does not match the VSIX.");
    }
    const provenance = parseStrictJson(provenanceAsset.bytes.toString("utf8"), { maxBytes: 4 * 1024 });
    exactKeys(
      provenance,
      ["protocol", "kind", "disposable", "id", "source", "workflow", "extension", "artifact"],
      "Daily preview provenance"
    );
    exactKeys(provenance.source, ["repository", "ref", "sha", "version"], "Daily preview source");
    exactKeys(provenance.workflow, ["name", "runId", "runNumber", "runAttempt"], "Daily preview workflow");
    exactKeys(provenance.extension, ["version", "preview"], "Daily preview extension");
    exactKeys(provenance.artifact, ["file", "bytes", "sha256"], "Daily preview artifact");
    if (
      provenance.protocol !== PROTOCOL ||
      provenance.kind !== "daily-preview" ||
      provenance.disposable !== true ||
      provenance.id !== identity.id ||
      provenance.source.repository !== identity.repository ||
      provenance.source.ref !== identity.ref ||
      provenance.source.sha !== identity.sourceSha ||
      !NUMERIC_VERSION.test(provenance.source.version ?? "") ||
      provenance.source.version === identity.version ||
      provenance.workflow.name !== "Daily preview" ||
      provenance.workflow.runId !== identity.runId ||
      provenance.workflow.runNumber !== identity.runNumber ||
      provenance.workflow.runAttempt !== identity.runAttempt ||
      provenance.extension.version !== identity.version ||
      provenance.extension.preview !== true ||
      provenance.artifact.file !== VSIX_NAME ||
      provenance.artifact.bytes !== candidate.bytes.length ||
      provenance.artifact.sha256 !== candidate.sha256
    ) {
      throw new Error("The daily preview provenance does not match its source, workflow, or VSIX.");
    }
    pinned.assertUnchanged();
    return Object.freeze({
      ...identity,
      bytes: candidate.bytes.length,
      sha256: candidate.sha256,
      sourceVersion: provenance.source.version
    });
  });
}

function appendOutputs(result, outputPath) {
  if (!outputPath) throw new Error("GITHUB_OUTPUT is required.");
  appendFileSync(
    outputPath,
    [
      `preview_id=${result.id}`,
      `candidate_sha256=${result.sha256 ?? ""}`,
      `candidate_bytes=${result.bytes ?? ""}`,
      `extension_version=${result.version}`,
      ...(result.sourceVersion === undefined ? [] : [`source_version=${result.sourceVersion}`]),
      ""
    ].join("\n"),
    "utf8"
  );
}

async function main(arguments_, environment) {
  const [command, target, ...rest] = arguments_;
  if (command === "prepare" && target === undefined && rest.length === 0) {
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
    return;
  }
  if (command === "create" && target && rest.length === 0) {
    appendOutputs(
      createDailyPreviewArtifact({
        candidatePath: target,
        packageJsonPath: "package.json",
        sourceVersion: environment.DAILY_PREVIEW_SOURCE_VERSION,
        environment
      }),
      environment.GITHUB_OUTPUT
    );
    return;
  }
  if (command === "verify" && target && rest.length === 0) {
    await verifyDailyPreviewArtifact({ directory: target, environment });
    return;
  }
  throw new Error("Usage: node scripts/daily-preview-artifact.mjs <prepare|create VSIX|verify DIRECTORY>");
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : undefined;
if (invokedPath === import.meta.url) {
  try {
    await main(process.argv.slice(2), process.env);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : "Daily preview validation failed."}\n`);
    process.exitCode = 1;
  }
}
