import { appendFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const POSITIVE_INTEGER = /^[1-9][0-9]*$/u;
const SHA = /^[0-9a-f]{40}$/u;
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;
const RELEASE_TAG = /^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/u;
const CHANNELS = Object.freeze({
  preview: Object.freeze({
    artifactName: "openwrangler-preview-release",
    workflowPath: ".github/workflows/release.yml"
  }),
  stable: Object.freeze({
    artifactName: "openwrangler-stable-release",
    workflowPath: ".github/workflows/stable-release.yml"
  })
});

function positiveInteger(value, label) {
  if (!POSITIVE_INTEGER.test(String(value ?? ""))) throw new Error(`${label} must be a positive decimal integer.`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error(`${label} exceeds the safe integer range.`);
  return parsed;
}

async function readJson(response, label) {
  if (!response?.ok) throw new Error(`${label} request failed with HTTP ${response?.status ?? "unknown"}.`);
  return response.json();
}

export async function inspectReleaseCandidate({
  repository,
  candidateRunId,
  expectedAutomationSha,
  channel,
  releaseTag,
  token,
  fetch_ = fetch
}) {
  if (!REPOSITORY.test(repository ?? "")) throw new Error("GITHUB_REPOSITORY is invalid.");
  const runId = positiveInteger(candidateRunId, "CANDIDATE_RUN_ID");
  if (!SHA.test(expectedAutomationSha ?? "")) {
    throw new Error("EXPECTED_AUTOMATION_SHA must be an exact lowercase commit SHA.");
  }
  const contract = CHANNELS[channel];
  if (!contract) throw new Error("RELEASE_CHANNEL must be preview or stable.");
  if (!RELEASE_TAG.test(releaseTag ?? "")) throw new Error("RELEASE_TAG must be a canonical v-prefixed version.");
  if (typeof token !== "string" || token.length === 0 || /[\r\n]/u.test(token)) {
    throw new Error("GITHUB_TOKEN is required.");
  }
  const headers = { Accept: "application/vnd.github+json", Authorization: `Bearer ${token}` };
  const base = `https://api.github.com/repos/${repository}/actions/runs/${runId}`;
  const run = await readJson(await fetch_(base, { headers }), "Candidate run");
  if (
    run.id !== runId ||
    run.path !== contract.workflowPath ||
    run.event !== "workflow_dispatch" ||
    run.head_branch !== "main" ||
    run.head_sha !== expectedAutomationSha ||
    run.status !== "completed" ||
    run.conclusion !== "success" ||
    run.run_attempt !== 1
  ) {
    throw new Error(
      "The selected candidate is not a successful first-attempt run from the exact protected main commit."
    );
  }

  const jobs = await readJson(await fetch_(`${base}/jobs?per_page=100`, { headers }), "Candidate jobs");
  if (
    !Number.isSafeInteger(jobs.total_count) ||
    jobs.total_count <= 0 ||
    jobs.total_count > 100 ||
    !Array.isArray(jobs.jobs) ||
    jobs.jobs.length !== jobs.total_count
  ) {
    throw new Error("The candidate job inventory is malformed.");
  }
  const requiredJobs = ["package", "Candidate acceptance / Candidate acceptance", "Remote SSH acceptance"];
  for (const name of requiredJobs) {
    const matches = jobs.jobs.filter((job) => job?.name === name);
    if (matches.length !== 1 || matches[0]?.status !== "completed" || matches[0]?.conclusion !== "success") {
      throw new Error(`The candidate does not contain one successful ${name} job.`);
    }
  }

  const artifacts = await readJson(await fetch_(`${base}/artifacts?per_page=100`, { headers }), "Candidate artifacts");
  if (
    !Number.isSafeInteger(artifacts.total_count) ||
    artifacts.total_count > 100 ||
    !Array.isArray(artifacts.artifacts) ||
    artifacts.artifacts.length !== artifacts.total_count
  ) {
    throw new Error("The candidate artifact inventory is malformed.");
  }
  const matches = artifacts.artifacts.filter((artifact) => artifact?.name === contract.artifactName);
  if (
    matches.length !== 1 ||
    matches[0]?.expired !== false ||
    !Number.isSafeInteger(matches[0]?.id) ||
    matches[0].id <= 0
  ) {
    throw new Error(`The candidate must retain exactly one unexpired ${contract.artifactName} artifact.`);
  }
  return Object.freeze({
    artifactId: matches[0].id,
    artifactName: contract.artifactName,
    candidateRunId: runId,
    expectedSha: run.head_sha,
    releaseTag
  });
}

async function main(environment) {
  const result = await inspectReleaseCandidate({
    repository: environment.GITHUB_REPOSITORY,
    candidateRunId: environment.CANDIDATE_RUN_ID,
    expectedAutomationSha: environment.EXPECTED_AUTOMATION_SHA,
    channel: environment.RELEASE_CHANNEL,
    releaseTag: environment.RELEASE_TAG,
    token: environment.GITHUB_TOKEN
  });
  if (!environment.GITHUB_OUTPUT) throw new Error("GITHUB_OUTPUT is required.");
  appendFileSync(
    environment.GITHUB_OUTPUT,
    [
      `artifact_id=${result.artifactId}`,
      `artifact_name=${result.artifactName}`,
      `candidate_run_id=${result.candidateRunId}`,
      `expected_sha=${result.expectedSha}`,
      ""
    ].join("\n"),
    "utf8"
  );
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : undefined;
if (invokedPath === import.meta.url) {
  try {
    await main(process.env);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : "Candidate source validation failed."}\n`);
    process.exitCode = 1;
  }
}
