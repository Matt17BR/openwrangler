import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  createReleaseCandidateManifest,
  inspectReleaseCandidateRun,
  verifyReleaseCandidateManifest,
  writeReleaseCandidateManifest
} from "./release-candidate.mjs";

const sourceSha = "0123456789abcdef0123456789abcdef01234567";
const environment = Object.freeze({
  GITHUB_REF: "refs/heads/main",
  GITHUB_REPOSITORY: "Matt17BR/openwrangler",
  GITHUB_RUN_ATTEMPT: "1",
  GITHUB_RUN_ID: "123456789",
  GITHUB_SHA: sourceSha
});
const candidate = Object.freeze({
  candidateArtifactId: "4001",
  candidateBytes: "5123456",
  candidateSha256: "a".repeat(64),
  releaseTag: "v2.0.0",
  candidateAcceptanceResult: "success",
  performanceArtifactId: "4003",
  performanceBytes: "12345",
  performanceSha256: "b".repeat(64),
  remoteSshResult: "success",
  environment
});

function manifestFixture() {
  const root = mkdtempSync(join(tmpdir(), "ow-release-candidate-"));
  const directory = join(root, "qualification");
  mkdirSync(directory, { mode: 0o700 });
  const path = join(directory, "release-candidate.json");
  writeReleaseCandidateManifest(path, candidate);
  return { path, root };
}

test("creates and verifies one bounded exact-byte qualification manifest", () => {
  const value = manifestFixture();
  try {
    const verified = verifyReleaseCandidateManifest({
      path: value.path,
      candidateArtifactId: candidate.candidateArtifactId,
      candidateBytes: candidate.candidateBytes,
      candidateRunId: environment.GITHUB_RUN_ID,
      candidateSha256: candidate.candidateSha256,
      performanceArtifactId: candidate.performanceArtifactId,
      performancePath: "performance.json",
      releaseTag: candidate.releaseTag,
      repository: environment.GITHUB_REPOSITORY,
      sourceSha,
      inspectPerformance: () => ({
        bytes: Number(candidate.performanceBytes),
        sha256: candidate.performanceSha256
      })
    });
    assert.deepEqual(verified, createReleaseCandidateManifest(candidate));
    assert.equal(verified.qualification.performance.artifactName, "openwrangler-release-candidate-performance");
  } finally {
    rmSync(value.root, { recursive: true, force: true });
  }
});

test("manifest validation rejects reruns, failed owners, changed bytes, and extra fields", () => {
  for (const overrides of [
    { environment: { ...environment, GITHUB_RUN_ATTEMPT: "2" } },
    { candidateAcceptanceResult: "failure" },
    { remoteSshResult: "skipped" },
    { candidateSha256: "not-a-digest" },
    { releaseTag: "v1.99.7-preview" }
  ]) {
    assert.throws(
      () => createReleaseCandidateManifest({ ...candidate, ...overrides }),
      /first workflow attempt|malformed|tag/u
    );
  }

  const value = manifestFixture();
  try {
    const expanded = { ...createReleaseCandidateManifest(candidate), unexpected: true };
    writeFileSync(value.path, `${JSON.stringify(expanded)}\n`);
    assert.throws(
      () =>
        verifyReleaseCandidateManifest({
          path: value.path,
          candidateArtifactId: candidate.candidateArtifactId,
          candidateBytes: candidate.candidateBytes,
          candidateRunId: environment.GITHUB_RUN_ID,
          candidateSha256: candidate.candidateSha256,
          performanceArtifactId: candidate.performanceArtifactId,
          performancePath: "performance.json",
          releaseTag: candidate.releaseTag,
          repository: environment.GITHUB_REPOSITORY,
          sourceSha,
          inspectPerformance: () => ({
            bytes: Number(candidate.performanceBytes),
            sha256: candidate.performanceSha256
          })
        }),
      /unexpected shape/u
    );
  } finally {
    rmSync(value.root, { recursive: true, force: true });
  }
});

function response(body, { ok = true, status = 200 } = {}) {
  return {
    ok,
    status,
    async json() {
      return structuredClone(body);
    }
  };
}

function candidateApi({ now, overrides = {}, artifacts, jobs: jobsOverride, runs } = {}) {
  const completed = new Date(now - 8 * 24 * 60 * 60 * 1000).toISOString();
  const created = new Date(now - 8 * 24 * 60 * 60 * 1000 - 60_000).toISOString();
  const run = {
    id: 123456789,
    path: ".github/workflows/release-candidate.yml",
    event: "workflow_dispatch",
    head_branch: "main",
    head_sha: sourceSha,
    status: "completed",
    conclusion: "success",
    run_attempt: 1,
    display_title: "Release candidate v2.0.0",
    created_at: created,
    updated_at: completed,
    ...overrides
  };
  const artifactList = artifacts ?? [
    { id: 4001, name: "openwrangler-release-candidate", expired: false },
    { id: 4002, name: "openwrangler-release-candidate-qualification", expired: false },
    { id: 4003, name: "openwrangler-release-candidate-performance", expired: false }
  ];
  const jobs = jobsOverride ?? {
    total_count: 4,
    jobs: [
      { name: "Package the immutable candidate", status: "completed", conclusion: "success" },
      { name: "Candidate acceptance / Candidate acceptance", status: "completed", conclusion: "success" },
      { name: "Remote SSH acceptance", status: "completed", conclusion: "success" },
      { name: "Seal candidate qualification", status: "completed", conclusion: "success" }
    ]
  };
  const runList = runs ?? [run];
  const fetch_ = async (url) => {
    if (url.endsWith("/actions/runs/123456789")) return response(run);
    if (url.endsWith("/actions/runs/123456789/jobs?per_page=100")) return response(jobs);
    if (url.includes("/actions/runs/123456789/artifacts")) {
      return response({ total_count: artifactList.length, artifacts: artifactList });
    }
    if (url.includes("/actions/workflows/")) {
      return response({ total_count: runList.length, workflow_runs: runList });
    }
    throw new Error(`Unexpected URL ${url}`);
  };
  return { fetch_, run };
}

test("selects one successful first-attempt candidate after a seven-day soak", async () => {
  const now = Date.UTC(2026, 7, 17, 12);
  const api = candidateApi({ now });
  const selected = await inspectReleaseCandidateRun({
    repository: environment.GITHUB_REPOSITORY,
    candidateRunId: environment.GITHUB_RUN_ID,
    releaseTag: "v2.0.0",
    token: "token",
    now,
    fetch_: api.fetch_
  });
  assert.deepEqual(selected, {
    candidateArtifactId: 4001,
    completedAt: api.run.updated_at,
    performanceArtifactId: 4003,
    qualificationArtifactId: 4002,
    runId: 123456789,
    sourceSha
  });
});

test("selection fails closed for soak, source, owner, artifact, rerun, and supersession drift", async () => {
  const now = Date.UTC(2026, 7, 17, 12);
  const cases = [
    candidateApi({ now, overrides: { updated_at: new Date(now - 6 * 24 * 60 * 60 * 1000).toISOString() } }),
    candidateApi({ now, overrides: { updated_at: new Date(now - 15 * 24 * 60 * 60 * 1000).toISOString() } }),
    candidateApi({ now, overrides: { run_attempt: 2 } }),
    candidateApi({ now, overrides: { head_branch: "release/old" } }),
    candidateApi({
      now,
      jobs: {
        total_count: 4,
        jobs: [
          { name: "Package the immutable candidate", status: "completed", conclusion: "success" },
          { name: "Candidate acceptance / Candidate acceptance", status: "completed", conclusion: "success" },
          { name: "Remote SSH acceptance", status: "completed", conclusion: "failure" },
          { name: "Seal candidate qualification", status: "completed", conclusion: "skipped" }
        ]
      }
    }),
    candidateApi({
      now,
      artifacts: [
        { id: 4001, name: "openwrangler-release-candidate", expired: false },
        { id: 4002, name: "openwrangler-release-candidate-qualification", expired: true },
        { id: 4003, name: "openwrangler-release-candidate-performance", expired: false }
      ]
    })
  ];
  const base = candidateApi({ now });
  cases.push(
    candidateApi({
      now,
      runs: [
        base.run,
        {
          id: 123456790,
          display_title: "Release candidate v2.0.0",
          created_at: new Date(Date.parse(base.run.created_at) + 60_000).toISOString()
        }
      ]
    })
  );
  for (const api of cases) {
    await assert.rejects(
      inspectReleaseCandidateRun({
        repository: environment.GITHUB_REPOSITORY,
        candidateRunId: environment.GITHUB_RUN_ID,
        releaseTag: "v2.0.0",
        token: "token",
        now,
        fetch_: api.fetch_
      }),
      /soaked|successful Remote SSH|unexpired|newer successful/u
    );
  }
});
