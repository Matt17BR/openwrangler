import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
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
  GITHUB_RUN_ATTEMPT: "2",
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

test("qualification binds the exact workflow attempt, candidate, and performance report", () => {
  const fixture = manifestFixture();
  try {
    const verified = verifyReleaseCandidateManifest({
      path: fixture.path,
      candidateArtifactId: candidate.candidateArtifactId,
      candidateBytes: candidate.candidateBytes,
      candidateRunId: environment.GITHUB_RUN_ID,
      candidateRunAttempt: environment.GITHUB_RUN_ATTEMPT,
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
    assert.equal(verified.workflow.runAttempt, 2);
    assert.equal(verified.canonicalArtifact.name, "openwrangler-release-candidate-2");
    assert.equal(verified.qualification.performance.artifactName, "openwrangler-release-candidate-performance-2");
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("qualification rejects failed checks, malformed bytes, and a different attempt", () => {
  for (const overrides of [
    { candidateAcceptanceResult: "failure" },
    { remoteSshResult: "skipped" },
    { candidateSha256: "not-a-digest" },
    { releaseTag: "v1.99.7-preview" }
  ]) {
    assert.throws(() => createReleaseCandidateManifest({ ...candidate, ...overrides }), /malformed|tag/u);
  }
  const fixture = manifestFixture();
  try {
    assert.throws(
      () =>
        verifyReleaseCandidateManifest({
          path: fixture.path,
          candidateArtifactId: candidate.candidateArtifactId,
          candidateBytes: candidate.candidateBytes,
          candidateRunId: environment.GITHUB_RUN_ID,
          candidateRunAttempt: "1",
          candidateSha256: candidate.candidateSha256,
          performanceArtifactId: candidate.performanceArtifactId,
          performancePath: "performance.json",
          releaseTag: candidate.releaseTag,
          repository: environment.GITHUB_REPOSITORY,
          sourceSha,
          inspectPerformance: () => ({ bytes: Number(candidate.performanceBytes), sha256: candidate.performanceSha256 })
        }),
      /does not match/u
    );
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
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

function candidateApi({ overrides = {}, artifacts } = {}) {
  const run = {
    id: 123456789,
    path: ".github/workflows/release-candidate.yml",
    event: "workflow_dispatch",
    head_branch: "main",
    head_sha: sourceSha,
    status: "completed",
    conclusion: "success",
    run_attempt: 2,
    display_title: "Release candidate v2.0.0",
    ...overrides
  };
  const artifactList = artifacts ?? [
    { id: 4001, name: "openwrangler-release-candidate-2", expired: false },
    { id: 4002, name: "openwrangler-release-candidate-qualification-2", expired: false },
    { id: 4003, name: "openwrangler-release-candidate-performance-2", expired: false }
  ];
  return {
    async fetch_(url) {
      if (url.endsWith("/actions/runs/123456789")) return response(run);
      if (url.endsWith("/actions/runs/123456789/artifacts?per_page=100")) {
        return response({ total_count: artifactList.length, artifacts: artifactList });
      }
      throw new Error(`Unexpected URL ${url}`);
    }
  };
}

test("selects a successful rerun with its own artifacts and no arbitrary age gate", async () => {
  const selected = await inspectReleaseCandidateRun({
    repository: environment.GITHUB_REPOSITORY,
    candidateRunId: environment.GITHUB_RUN_ID,
    releaseTag: "v2.0.0",
    token: "token",
    fetch_: candidateApi().fetch_
  });
  assert.deepEqual(selected, {
    candidateArtifactId: 4001,
    performanceArtifactId: 4003,
    qualificationArtifactId: 4002,
    runId: 123456789,
    runAttempt: 2,
    sourceSha
  });
});

test("selection rejects wrong source, result, tag, and attempt artifacts", async () => {
  const cases = [
    candidateApi({ overrides: { head_branch: "release/old" } }),
    candidateApi({ overrides: { conclusion: "failure" } }),
    candidateApi({ overrides: { display_title: "Release candidate v2.0.1" } }),
    candidateApi({
      artifacts: [
        { id: 4001, name: "openwrangler-release-candidate-1", expired: false },
        { id: 4002, name: "openwrangler-release-candidate-qualification-2", expired: false },
        { id: 4003, name: "openwrangler-release-candidate-performance-2", expired: false }
      ]
    }),
    candidateApi({
      artifacts: [
        { id: 4001, name: "openwrangler-release-candidate-2", expired: false },
        { id: 4002, name: "openwrangler-release-candidate-qualification-2", expired: true },
        { id: 4003, name: "openwrangler-release-candidate-performance-2", expired: false }
      ]
    })
  ];
  for (const api of cases) {
    await assert.rejects(
      inspectReleaseCandidateRun({
        repository: environment.GITHUB_REPOSITORY,
        candidateRunId: environment.GITHUB_RUN_ID,
        releaseTag: "v2.0.0",
        token: "token",
        fetch_: api.fetch_
      }),
      /successful protected-main|unexpired/u
    );
  }
});
