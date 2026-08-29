import { appendFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const FULL_SHA = /^[0-9a-f]{40}$/u;
const POSITIVE_INTEGER = /^[1-9][0-9]*$/u;
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;
const RELEASE_TAG = /^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u;
const WORKFLOW_PATH = ".github/workflows/release-candidate.yml";
const CANDIDATE_ARTIFACT = "openwrangler-release-candidate";

function positiveInteger(value, label) {
  if (!POSITIVE_INTEGER.test(String(value ?? ""))) throw new Error(`${label} must be a positive decimal integer.`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error(`${label} exceeds the safe integer range.`);
  return parsed;
}

function releaseVersion(releaseTag) {
  if (!RELEASE_TAG.test(releaseTag ?? "")) throw new Error("RELEASE_TAG must be one stable vmajor.minor.patch tag.");
  return releaseTag.slice(1);
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

export async function inspectReleaseCandidateRun({ repository, candidateRunId, releaseTag, token, fetch_ = fetch }) {
  if (!REPOSITORY.test(repository ?? "")) throw new Error("GITHUB_REPOSITORY is invalid.");
  const runId = positiveInteger(candidateRunId, "CANDIDATE_RUN_ID");
  releaseVersion(releaseTag);
  if (typeof token !== "string" || token.length === 0 || /[\r\n]/u.test(token))
    throw new Error("GITHUB_TOKEN is required.");
  const headers = { Accept: "application/vnd.github+json", Authorization: `Bearer ${token}` };
  const root = `https://api.github.com/repos/${repository}`;
  const run = await readJson(await fetch_(`${root}/actions/runs/${runId}`, { headers }), "Candidate run");
  if (
    run.id !== runId ||
    run.path !== WORKFLOW_PATH ||
    run.event !== "workflow_dispatch" ||
    run.head_branch !== "main" ||
    !FULL_SHA.test(run.head_sha ?? "") ||
    run.status !== "completed" ||
    run.conclusion !== "success" ||
    run.run_attempt !== 1 ||
    run.display_title !== `Release candidate ${releaseTag}`
  ) {
    throw new Error("The selected run is not one successful first-attempt protected-main candidate.");
  }

  const artifactResponse = await readJson(
    await fetch_(`${root}/actions/runs/${runId}/artifacts?per_page=100`, { headers }),
    "Candidate artifacts"
  );
  if (
    artifactResponse.total_count !== 1 ||
    !Array.isArray(artifactResponse.artifacts) ||
    artifactResponse.artifacts.length !== 1
  ) {
    throw new Error("The candidate run must retain exactly one artifact.");
  }
  const candidateArtifact = artifactByName(artifactResponse.artifacts, CANDIDATE_ARTIFACT);

  return Object.freeze({
    candidateArtifactId: candidateArtifact.id,
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
      `candidate_run_id=${result.runId}`,
      `source_sha=${result.sourceSha}`,
      ""
    ].join("\n"),
    "utf8"
  );
}

async function main(arguments_, environment) {
  const [command, target, ...rest] = arguments_;
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
  throw new Error("Usage: node scripts/release-candidate.mjs select");
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
