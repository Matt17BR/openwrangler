import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { appendFileSync, lstatSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const SHA = /^[0-9a-f]{40}$/u;
const POSITIVE_INTEGER = /^[1-9][0-9]*$/u;
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;
const PROTOCOL = "openwrangler-canary-provenance-v1";
const VSIX_NAME = "openwrangler-canary.vsix";
const CHECKSUM_NAME = `${VSIX_NAME}.sha256`;
const PROVENANCE_NAME = `${VSIX_NAME}.provenance.json`;
const NUMERIC_VERSION = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u;

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function requireRegularFile(path, label) {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
    throw new Error(`${label} must be a singly linked regular file.`);
  }
  if (!Number.isSafeInteger(stat.size) || stat.size <= 0) throw new Error(`${label} must not be empty.`);
  return stat;
}

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

export function canaryIdentity(environment) {
  const repository = environment.GITHUB_REPOSITORY;
  const ref = environment.GITHUB_REF;
  const sourceSha = environment.GITHUB_SHA;
  if (!REPOSITORY.test(repository ?? "")) throw new Error("GITHUB_REPOSITORY is invalid.");
  if (ref !== "refs/heads/main") throw new Error("A canary must come from refs/heads/main.");
  if (!SHA.test(sourceSha ?? "")) throw new Error("GITHUB_SHA must be an exact lowercase commit SHA.");
  const runId = positiveInteger(environment.GITHUB_RUN_ID, "GITHUB_RUN_ID");
  const runNumber = positiveInteger(environment.GITHUB_RUN_NUMBER, "GITHUB_RUN_NUMBER");
  const runAttempt = positiveInteger(environment.GITHUB_RUN_ATTEMPT, "GITHUB_RUN_ATTEMPT");
  if (runAttempt !== 1) throw new Error("Canary evidence may come only from a first workflow attempt.");
  return Object.freeze({
    canaryId: `main-${sourceSha.slice(0, 12)}`,
    canaryVersion: `0.${BigInt(`0x${sourceSha.slice(0, 10)}`) * 2n + 1n}.${BigInt(`0x${sourceSha.slice(10, 20)}`)}`,
    ref,
    repository,
    runAttempt,
    runId,
    runNumber,
    sourceSha
  });
}

function parseSourceVersion(packageJson, runtimeVersion, label) {
  const manifest = JSON.parse(packageJson);
  if (
    manifest === null ||
    typeof manifest !== "object" ||
    Array.isArray(manifest) ||
    !NUMERIC_VERSION.test(manifest.version ?? "") ||
    typeof manifest.preview !== "boolean"
  ) {
    throw new Error(`${label} package metadata is invalid.`);
  }
  const runtimeMatch = /^\s*__version__ = "([^"]+)"\s*$/mu.exec(runtimeVersion);
  if (runtimeMatch?.[1] !== manifest.version) {
    throw new Error(`${label} extension and runtime versions do not match.`);
  }
  return { manifest, version: manifest.version };
}

export function prepareCanarySource({
  packageJsonPath,
  runtimeVersionPath,
  sourcePackageJson,
  sourceRuntimeVersion,
  environment = process.env
}) {
  const identity = canaryIdentity(environment);
  const currentPackageJson = readFileSync(resolve(packageJsonPath), "utf8");
  const currentRuntimeVersion = readFileSync(resolve(runtimeVersionPath), "utf8");
  if (currentPackageJson !== sourcePackageJson || currentRuntimeVersion !== sourceRuntimeVersion) {
    throw new Error("Canary version preparation requires the exact unmodified protected-main metadata.");
  }
  const source = parseSourceVersion(sourcePackageJson, sourceRuntimeVersion, "Protected-main");
  if (source.version === identity.canaryVersion) {
    throw new Error("Canary build identity must differ from the protected-main release identity.");
  }
  const packageStat = requireRegularFile(resolve(packageJsonPath), "package.json");
  const runtimeStat = requireRegularFile(resolve(runtimeVersionPath), "Runtime version metadata");
  const packageBytes = `${JSON.stringify({ ...source.manifest, version: identity.canaryVersion, preview: true }, null, 2)}\n`;
  const runtimeBytes = currentRuntimeVersion.replace(
    /^\s*__version__ = "[^"]+"\s*$/mu,
    `__version__ = "${identity.canaryVersion}"`
  );
  writeFileSync(resolve(packageJsonPath), packageBytes, { mode: packageStat.mode });
  writeFileSync(resolve(runtimeVersionPath), runtimeBytes, { mode: runtimeStat.mode });
  parseSourceVersion(packageBytes, runtimeBytes, "Prepared canary");
  return Object.freeze({ ...identity, sourceVersion: source.version, version: identity.canaryVersion });
}

export function createCanaryArtifact({ candidatePath, packageJsonPath, sourceVersion, environment = process.env }) {
  const identity = canaryIdentity(environment);
  const resolvedCandidate = resolve(candidatePath);
  if (basename(resolvedCandidate) !== VSIX_NAME) {
    throw new Error(`The canary VSIX must be named ${VSIX_NAME}.`);
  }
  const candidateStat = requireRegularFile(resolvedCandidate, "The canary VSIX");
  const candidateBytes = readFileSync(resolvedCandidate);
  const digest = sha256(candidateBytes);
  const packageJson = JSON.parse(readFileSync(resolve(packageJsonPath), "utf8"));
  if (packageJson.version !== identity.canaryVersion || packageJson.preview !== true) {
    throw new Error("The packaged canary metadata must use the source-derived disposable preview identity.");
  }
  if (!NUMERIC_VERSION.test(sourceVersion ?? "") || sourceVersion === packageJson.version) {
    throw new Error("The canary manifest requires the distinct protected-main source version.");
  }

  const provenance = {
    protocol: PROTOCOL,
    channel: "canary",
    disposable: true,
    canaryId: identity.canaryId,
    source: {
      repository: identity.repository,
      ref: identity.ref,
      sha: identity.sourceSha,
      version: sourceVersion
    },
    workflow: {
      name: "Daily canary",
      runId: identity.runId,
      runNumber: identity.runNumber,
      runAttempt: identity.runAttempt
    },
    extension: {
      version: packageJson.version,
      preview: packageJson.preview
    },
    artifact: {
      file: VSIX_NAME,
      bytes: candidateStat.size,
      sha256: digest
    }
  };
  const directory = dirname(resolvedCandidate);
  writeFileSync(join(directory, CHECKSUM_NAME), `${digest}  ${VSIX_NAME}\n`, { flag: "wx", mode: 0o600 });
  writeFileSync(join(directory, PROVENANCE_NAME), `${JSON.stringify(provenance, null, 2)}\n`, {
    flag: "wx",
    mode: 0o600
  });
  return Object.freeze({
    ...identity,
    bytes: candidateStat.size,
    sha256: digest,
    sourceVersion,
    version: packageJson.version
  });
}

export function verifyCanaryArtifact({ directory, environment = process.env }) {
  const identity = canaryIdentity(environment);
  const resolvedDirectory = resolve(directory);
  const candidatePath = join(resolvedDirectory, VSIX_NAME);
  const checksumPath = join(resolvedDirectory, CHECKSUM_NAME);
  const provenancePath = join(resolvedDirectory, PROVENANCE_NAME);
  const candidateStat = requireRegularFile(candidatePath, "The canary VSIX");
  requireRegularFile(checksumPath, "The canary checksum");
  requireRegularFile(provenancePath, "The canary provenance");
  const digest = sha256(readFileSync(candidatePath));
  if (readFileSync(checksumPath, "utf8") !== `${digest}  ${VSIX_NAME}\n`) {
    throw new Error("The canary checksum receipt does not match the VSIX.");
  }
  const provenanceText = readFileSync(provenancePath, "utf8");
  if (!provenanceText.endsWith("\n")) throw new Error("The canary provenance must end with one newline.");
  const provenance = JSON.parse(provenanceText);
  exactKeys(
    provenance,
    ["protocol", "channel", "disposable", "canaryId", "source", "workflow", "extension", "artifact"],
    "Canary provenance"
  );
  exactKeys(provenance.source, ["repository", "ref", "sha", "version"], "Canary source provenance");
  exactKeys(provenance.workflow, ["name", "runId", "runNumber", "runAttempt"], "Canary workflow provenance");
  exactKeys(provenance.extension, ["version", "preview"], "Canary extension provenance");
  exactKeys(provenance.artifact, ["file", "bytes", "sha256"], "Canary artifact provenance");
  if (
    provenance.protocol !== PROTOCOL ||
    provenance.channel !== "canary" ||
    provenance.disposable !== true ||
    provenance.canaryId !== identity.canaryId ||
    provenance.source.repository !== identity.repository ||
    provenance.source.ref !== identity.ref ||
    provenance.source.sha !== identity.sourceSha ||
    !NUMERIC_VERSION.test(provenance.source.version ?? "") ||
    provenance.source.version === provenance.extension.version ||
    provenance.workflow.name !== "Daily canary" ||
    provenance.workflow.runId !== identity.runId ||
    provenance.workflow.runNumber !== identity.runNumber ||
    provenance.workflow.runAttempt !== identity.runAttempt ||
    provenance.extension.version !== identity.canaryVersion ||
    provenance.extension.preview !== true ||
    provenance.artifact.file !== VSIX_NAME ||
    provenance.artifact.bytes !== candidateStat.size ||
    provenance.artifact.sha256 !== digest
  ) {
    throw new Error("The canary provenance does not match its source, workflow, or VSIX.");
  }
  return Object.freeze({
    ...identity,
    bytes: candidateStat.size,
    sha256: digest,
    sourceVersion: provenance.source.version,
    version: provenance.extension.version
  });
}

function appendOutputs(result, outputPath) {
  if (!outputPath) throw new Error("GITHUB_OUTPUT is required.");
  appendFileSync(
    outputPath,
    [
      `canary_id=${result.canaryId}`,
      `candidate_sha256=${result.sha256}`,
      `candidate_bytes=${result.bytes}`,
      `extension_version=${result.version}`,
      ...(result.sourceVersion === undefined ? [] : [`source_version=${result.sourceVersion}`]),
      ""
    ].join("\n"),
    "utf8"
  );
}

function main(arguments_, environment) {
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
      prepareCanarySource({
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
      createCanaryArtifact({
        candidatePath: target,
        packageJsonPath: "package.json",
        sourceVersion: environment.CANARY_SOURCE_VERSION,
        environment
      }),
      environment.GITHUB_OUTPUT
    );
    return;
  }
  if (command === "verify" && target && rest.length === 0) {
    verifyCanaryArtifact({ directory: target, environment });
    return;
  }
  throw new Error("Usage: node scripts/canary-artifact.mjs <prepare|create VSIX|verify DIRECTORY>");
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : undefined;
if (invokedPath === import.meta.url) {
  try {
    main(process.argv.slice(2), process.env);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : "Canary artifact validation failed."}\n`);
    process.exitCode = 1;
  }
}
