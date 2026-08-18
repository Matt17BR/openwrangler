import { appendFileSync, closeSync, constants, fstatSync, openSync, readSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { assertInstalledPerformanceReleaseGate } from "./installed-performance-report.mjs";
import { parseStrictJson } from "./strict-json.mjs";

const FULL_SHA = /^[0-9a-f]{40}$/u;
const POSITIVE_INTEGER = /^[1-9][0-9]*$/u;
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;
const RELEASE_TAG = /^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const PROTOCOL = "openwrangler-release-candidate-v1";
const WORKFLOW_PATH = ".github/workflows/release-candidate.yml";
const CANDIDATE_ARTIFACT = "openwrangler-release-candidate";
const QUALIFICATION_ARTIFACT = "openwrangler-release-candidate-qualification";
const PERFORMANCE_ARTIFACT = "openwrangler-release-candidate-performance";
const MANIFEST_MAX_BYTES = 16 * 1024;
const PERFORMANCE_MAX_BYTES = 1024 * 1024;
const MINIMUM_SOAK_MS = 7 * 24 * 60 * 60 * 1000;
const MAXIMUM_SOAK_MS = 14 * 24 * 60 * 60 * 1000;

function positiveInteger(value, label) {
  if (!POSITIVE_INTEGER.test(String(value ?? ""))) throw new Error(`${label} must be a positive decimal integer.`);
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

function releaseVersion(releaseTag) {
  if (!RELEASE_TAG.test(releaseTag ?? "")) throw new Error("RELEASE_TAG must be one stable vmajor.minor.patch tag.");
  return releaseTag.slice(1);
}

function workflowIdentity(environment) {
  const repository = environment.GITHUB_REPOSITORY;
  const sourceSha = environment.GITHUB_SHA;
  if (!REPOSITORY.test(repository ?? "")) throw new Error("GITHUB_REPOSITORY is invalid.");
  if (environment.GITHUB_REF !== "refs/heads/main") {
    throw new Error("A release candidate must come from refs/heads/main.");
  }
  if (!FULL_SHA.test(sourceSha ?? "")) throw new Error("GITHUB_SHA must be one lowercase commit SHA.");
  const runAttempt = positiveInteger(environment.GITHUB_RUN_ATTEMPT, "GITHUB_RUN_ATTEMPT");
  if (runAttempt !== 1) throw new Error("Release candidates may come only from the first workflow attempt.");
  return Object.freeze({
    repository,
    runAttempt,
    runId: positiveInteger(environment.GITHUB_RUN_ID, "GITHUB_RUN_ID"),
    sourceSha
  });
}

function readBoundedOwnedFile(path, { label, maxBytes }) {
  const resolved = resolve(path);
  let descriptor;
  try {
    descriptor = openSync(resolved, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_CLOEXEC ?? 0));
    const metadata = fstatSync(descriptor, { bigint: true });
    if (
      !metadata.isFile() ||
      metadata.isSymbolicLink() ||
      metadata.nlink !== 1n ||
      metadata.size <= 0n ||
      metadata.size > BigInt(maxBytes) ||
      (typeof process.getuid === "function" && metadata.uid !== BigInt(process.getuid()))
    ) {
      throw new Error(`${label} must be one bounded owned regular file.`);
    }
    const bytes = Buffer.alloc(Number(metadata.size));
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(descriptor, bytes, offset, bytes.length - offset, null);
      if (!Number.isSafeInteger(count) || count <= 0) throw new Error(`${label} ended early.`);
      offset += count;
    }
    const completed = fstatSync(descriptor, { bigint: true });
    if (
      completed.dev !== metadata.dev ||
      completed.ino !== metadata.ino ||
      completed.size !== metadata.size ||
      completed.mtimeNs !== metadata.mtimeNs ||
      completed.ctimeNs !== metadata.ctimeNs
    ) {
      throw new Error(`${label} changed while it was read.`);
    }
    return bytes;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function validateManifest(manifest) {
  exactKeys(
    manifest,
    ["protocol", "repository", "workflow", "release", "canonicalArtifact", "qualification"],
    "Release-candidate manifest"
  );
  exactKeys(manifest.workflow, ["path", "runId", "runAttempt", "sourceSha"], "Candidate workflow");
  exactKeys(manifest.release, ["tag", "version"], "Candidate release");
  exactKeys(manifest.canonicalArtifact, ["id", "name", "vsixBytes", "vsixSha256"], "Candidate canonical artifact");
  exactKeys(manifest.qualification, ["candidateAcceptance", "remoteSsh", "performance"], "Candidate qualification");
  exactKeys(
    manifest.qualification.performance,
    ["artifactId", "artifactName", "reportBytes", "reportSha256"],
    "Candidate performance qualification"
  );
  if (
    manifest.protocol !== PROTOCOL ||
    !REPOSITORY.test(manifest.repository ?? "") ||
    manifest.workflow.path !== WORKFLOW_PATH ||
    !Number.isSafeInteger(manifest.workflow.runId) ||
    manifest.workflow.runId <= 0 ||
    manifest.workflow.runAttempt !== 1 ||
    !FULL_SHA.test(manifest.workflow.sourceSha ?? "") ||
    manifest.release.version !== releaseVersion(manifest.release.tag) ||
    !Number.isSafeInteger(manifest.canonicalArtifact.id) ||
    manifest.canonicalArtifact.id <= 0 ||
    manifest.canonicalArtifact.name !== CANDIDATE_ARTIFACT ||
    !Number.isSafeInteger(manifest.canonicalArtifact.vsixBytes) ||
    manifest.canonicalArtifact.vsixBytes <= 0 ||
    !SHA256.test(manifest.canonicalArtifact.vsixSha256 ?? "") ||
    manifest.qualification.candidateAcceptance !== "success" ||
    manifest.qualification.remoteSsh !== "success" ||
    !Number.isSafeInteger(manifest.qualification.performance.artifactId) ||
    manifest.qualification.performance.artifactId <= 0 ||
    manifest.qualification.performance.artifactName !== PERFORMANCE_ARTIFACT ||
    !Number.isSafeInteger(manifest.qualification.performance.reportBytes) ||
    manifest.qualification.performance.reportBytes <= 0 ||
    manifest.qualification.performance.reportBytes > PERFORMANCE_MAX_BYTES ||
    !SHA256.test(manifest.qualification.performance.reportSha256 ?? "")
  ) {
    throw new Error("The release-candidate manifest is malformed or incomplete.");
  }
  return manifest;
}

export function createReleaseCandidateManifest({
  candidateArtifactId,
  candidateBytes,
  candidateSha256,
  releaseTag,
  candidateAcceptanceResult,
  performanceArtifactId,
  performanceBytes,
  performanceSha256,
  remoteSshResult,
  environment = process.env
}) {
  const identity = workflowIdentity(environment);
  const manifest = {
    protocol: PROTOCOL,
    repository: identity.repository,
    workflow: {
      path: WORKFLOW_PATH,
      runId: identity.runId,
      runAttempt: identity.runAttempt,
      sourceSha: identity.sourceSha
    },
    release: { tag: releaseTag, version: releaseVersion(releaseTag) },
    canonicalArtifact: {
      id: positiveInteger(candidateArtifactId, "CANDIDATE_ARTIFACT_ID"),
      name: CANDIDATE_ARTIFACT,
      vsixBytes: positiveInteger(candidateBytes, "CANDIDATE_BYTES"),
      vsixSha256: candidateSha256
    },
    qualification: {
      candidateAcceptance: candidateAcceptanceResult,
      remoteSsh: remoteSshResult,
      performance: {
        artifactId: positiveInteger(performanceArtifactId, "PERFORMANCE_ARTIFACT_ID"),
        artifactName: PERFORMANCE_ARTIFACT,
        reportBytes: positiveInteger(performanceBytes, "PERFORMANCE_BYTES"),
        reportSha256: performanceSha256
      }
    }
  };
  return Object.freeze(validateManifest(manifest));
}

export function writeReleaseCandidateManifest(path, options) {
  const manifest = createReleaseCandidateManifest(options);
  const bytes = `${JSON.stringify(manifest, null, 2)}\n`;
  if (Buffer.byteLength(bytes, "utf8") > MANIFEST_MAX_BYTES) {
    throw new Error("The release-candidate manifest exceeds its byte budget.");
  }
  writeFileSync(resolve(path), bytes, { flag: "wx", mode: 0o600 });
  return manifest;
}

export function verifyReleaseCandidateManifest({
  path,
  candidateArtifactId,
  candidateBytes,
  candidateRunId,
  candidateSha256,
  performanceArtifactId,
  performancePath,
  releaseTag,
  repository,
  sourceSha,
  inspectPerformance = inspectPerformanceReport
}) {
  const manifest = validateManifest(
    parseStrictJson(
      readBoundedOwnedFile(path, {
        label: "The release-candidate manifest",
        maxBytes: MANIFEST_MAX_BYTES
      }).toString("utf8"),
      {
        maxBytes: MANIFEST_MAX_BYTES
      }
    )
  );
  if (
    manifest.repository !== repository ||
    manifest.workflow.runId !== positiveInteger(candidateRunId, "CANDIDATE_RUN_ID") ||
    manifest.workflow.sourceSha !== sourceSha ||
    manifest.release.tag !== releaseTag ||
    manifest.canonicalArtifact.id !== positiveInteger(candidateArtifactId, "CANDIDATE_ARTIFACT_ID") ||
    manifest.canonicalArtifact.vsixBytes !== positiveInteger(candidateBytes, "CANDIDATE_BYTES") ||
    manifest.canonicalArtifact.vsixSha256 !== candidateSha256 ||
    manifest.qualification.performance.artifactId !== positiveInteger(performanceArtifactId, "PERFORMANCE_ARTIFACT_ID")
  ) {
    throw new Error("The release-candidate manifest does not match the selected run or canonical VSIX.");
  }
  const performance = inspectPerformance(performancePath);
  if (
    performance.bytes !== manifest.qualification.performance.reportBytes ||
    performance.sha256 !== manifest.qualification.performance.reportSha256
  ) {
    throw new Error("The installed-performance report does not match the candidate manifest.");
  }
  return Object.freeze(manifest);
}

export function inspectPerformanceReport(path) {
  const bytes = readBoundedOwnedFile(path, {
    label: "The installed-performance report",
    maxBytes: PERFORMANCE_MAX_BYTES
  });
  const report = parseStrictJson(bytes.toString("utf8"), { maxBytes: PERFORMANCE_MAX_BYTES });
  assertInstalledPerformanceReleaseGate(report, { requiredEditors: ["vscode"] });
  return Object.freeze({
    bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex")
  });
}

async function readJson(response, label) {
  if (!response?.ok) throw new Error(`${label} request failed with HTTP ${response?.status ?? "unknown"}.`);
  return response.json();
}

function artifactByName(artifacts, name) {
  const matches = artifacts.filter((artifact) => artifact?.name === name);
  if (
    matches.length !== 1 ||
    matches[0]?.expired !== false ||
    !Number.isSafeInteger(matches[0]?.id) ||
    matches[0].id <= 0
  ) {
    throw new Error(`The candidate must retain exactly one unexpired ${name} artifact.`);
  }
  return matches[0];
}

export async function inspectReleaseCandidateRun({
  repository,
  candidateRunId,
  releaseTag,
  token,
  now = Date.now(),
  fetch_ = fetch
}) {
  if (!REPOSITORY.test(repository ?? "")) throw new Error("GITHUB_REPOSITORY is invalid.");
  const runId = positiveInteger(candidateRunId, "CANDIDATE_RUN_ID");
  releaseVersion(releaseTag);
  if (typeof token !== "string" || token.length === 0 || /[\r\n]/u.test(token))
    throw new Error("GITHUB_TOKEN is required.");
  if (!Number.isFinite(now)) throw new Error("Candidate selection requires the current time.");
  const headers = { Accept: "application/vnd.github+json", Authorization: `Bearer ${token}` };
  const root = `https://api.github.com/repos/${repository}`;
  const run = await readJson(await fetch_(`${root}/actions/runs/${runId}`, { headers }), "Candidate run");
  const completedAt = Date.parse(run.updated_at ?? "");
  const createdAt = Date.parse(run.created_at ?? "");
  const age = now - completedAt;
  if (
    run.id !== runId ||
    run.path !== WORKFLOW_PATH ||
    run.event !== "workflow_dispatch" ||
    run.head_branch !== "main" ||
    !FULL_SHA.test(run.head_sha ?? "") ||
    run.status !== "completed" ||
    run.conclusion !== "success" ||
    run.run_attempt !== 1 ||
    run.display_title !== `Release candidate ${releaseTag}` ||
    !Number.isFinite(completedAt) ||
    !Number.isFinite(createdAt) ||
    age < MINIMUM_SOAK_MS ||
    age > MAXIMUM_SOAK_MS
  ) {
    throw new Error("The selected run is not one successfully soaked first-attempt protected-main candidate.");
  }

  const jobsResponse = await readJson(
    await fetch_(`${root}/actions/runs/${runId}/jobs?per_page=100`, { headers }),
    "Candidate jobs"
  );
  if (
    !Number.isSafeInteger(jobsResponse.total_count) ||
    jobsResponse.total_count <= 0 ||
    jobsResponse.total_count > 100 ||
    !Array.isArray(jobsResponse.jobs) ||
    jobsResponse.jobs.length !== jobsResponse.total_count
  ) {
    throw new Error("The candidate job inventory is malformed or too large.");
  }
  for (const name of [
    "Package the immutable candidate",
    "Candidate acceptance / Candidate acceptance",
    "Remote SSH acceptance",
    "Seal candidate qualification"
  ]) {
    const matches = jobsResponse.jobs.filter((job) => job?.name === name);
    if (matches.length !== 1 || matches[0].status !== "completed" || matches[0].conclusion !== "success") {
      throw new Error(`The candidate is missing one successful ${name} job.`);
    }
  }

  const artifactResponse = await readJson(
    await fetch_(`${root}/actions/runs/${runId}/artifacts?per_page=100`, { headers }),
    "Candidate artifacts"
  );
  if (
    !Number.isSafeInteger(artifactResponse.total_count) ||
    artifactResponse.total_count <= 0 ||
    artifactResponse.total_count > 100 ||
    !Array.isArray(artifactResponse.artifacts) ||
    artifactResponse.artifacts.length !== artifactResponse.total_count
  ) {
    throw new Error("The candidate artifact inventory is malformed or too large.");
  }
  const candidateArtifact = artifactByName(artifactResponse.artifacts, CANDIDATE_ARTIFACT);
  const qualificationArtifact = artifactByName(artifactResponse.artifacts, QUALIFICATION_ARTIFACT);
  const performanceArtifact = artifactByName(artifactResponse.artifacts, PERFORMANCE_ARTIFACT);

  const runsResponse = await readJson(
    await fetch_(
      `${root}/actions/workflows/${encodeURIComponent(WORKFLOW_PATH)}/runs?branch=main&event=workflow_dispatch&status=success&per_page=100`,
      { headers }
    ),
    "Successful candidate runs"
  );
  if (
    !Number.isSafeInteger(runsResponse.total_count) ||
    runsResponse.total_count <= 0 ||
    !Array.isArray(runsResponse.workflow_runs) ||
    runsResponse.workflow_runs.length > 100 ||
    !runsResponse.workflow_runs.some((entry) => entry?.id === runId)
  ) {
    throw new Error("The successful candidate run inventory is incomplete.");
  }
  if (
    runsResponse.workflow_runs.some(
      (entry) =>
        entry?.id !== runId &&
        entry?.display_title === `Release candidate ${releaseTag}` &&
        Date.parse(entry?.created_at ?? "") > createdAt
    )
  ) {
    throw new Error("A newer successful candidate invalidates the selected run.");
  }

  return Object.freeze({
    candidateArtifactId: candidateArtifact.id,
    completedAt: run.updated_at,
    performanceArtifactId: performanceArtifact.id,
    qualificationArtifactId: qualificationArtifact.id,
    runId,
    sourceSha: run.head_sha
  });
}

function appendOutputs(result, outputPath) {
  if (!outputPath) throw new Error("GITHUB_OUTPUT is required.");
  appendFileSync(
    outputPath,
    [
      `candidate_artifact_id=${result.candidateArtifactId}`,
      `qualification_artifact_id=${result.qualificationArtifactId}`,
      `performance_artifact_id=${result.performanceArtifactId}`,
      `candidate_run_id=${result.runId}`,
      `source_sha=${result.sourceSha}`,
      `completed_at=${result.completedAt}`,
      ""
    ].join("\n"),
    "utf8"
  );
}

async function main(arguments_, environment) {
  const [command, target, ...rest] = arguments_;
  if (command === "create" && target && rest.length === 0) {
    writeReleaseCandidateManifest(target, {
      candidateArtifactId: environment.CANDIDATE_ARTIFACT_ID,
      candidateBytes: environment.CANDIDATE_BYTES,
      candidateSha256: environment.CANDIDATE_SHA256,
      releaseTag: environment.RELEASE_TAG,
      candidateAcceptanceResult: environment.CANDIDATE_ACCEPTANCE_RESULT,
      performanceArtifactId: environment.PERFORMANCE_ARTIFACT_ID,
      performanceBytes: environment.PERFORMANCE_BYTES,
      performanceSha256: environment.PERFORMANCE_SHA256,
      remoteSshResult: environment.REMOTE_SSH_RESULT,
      environment
    });
    return;
  }
  if (command === "verify" && target && rest.length === 0) {
    verifyReleaseCandidateManifest({
      path: target,
      candidateArtifactId: environment.CANDIDATE_ARTIFACT_ID,
      candidateBytes: environment.CANDIDATE_BYTES,
      candidateRunId: environment.CANDIDATE_RUN_ID,
      candidateSha256: environment.CANDIDATE_SHA256,
      performanceArtifactId: environment.PERFORMANCE_ARTIFACT_ID,
      performancePath: environment.PERFORMANCE_REPORT,
      releaseTag: environment.RELEASE_TAG,
      repository: environment.GITHUB_REPOSITORY,
      sourceSha: environment.CANDIDATE_SOURCE_SHA
    });
    return;
  }
  if (command === "performance" && target && rest.length === 0) {
    const result = inspectPerformanceReport(target);
    if (!environment.GITHUB_OUTPUT) throw new Error("GITHUB_OUTPUT is required.");
    appendFileSync(
      environment.GITHUB_OUTPUT,
      `performance_bytes=${result.bytes}\nperformance_sha256=${result.sha256}\n`,
      "utf8"
    );
    return;
  }
  if (command === "select" && target === undefined && rest.length === 0) {
    appendOutputs(
      await inspectReleaseCandidateRun({
        repository: environment.GITHUB_REPOSITORY,
        candidateRunId: environment.CANDIDATE_RUN_ID,
        releaseTag: environment.RELEASE_TAG,
        token: environment.GITHUB_TOKEN
      }),
      environment.GITHUB_OUTPUT
    );
    return;
  }
  throw new Error("Usage: node scripts/release-candidate.mjs <create FILE|verify FILE|performance FILE|select>");
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : undefined;
if (invokedPath === import.meta.url) {
  try {
    await main(process.argv.slice(2), process.env);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : "Release-candidate validation failed."}\n`);
    process.exitCode = 1;
  }
}
