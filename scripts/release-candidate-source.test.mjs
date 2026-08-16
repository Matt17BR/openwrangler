import assert from "node:assert/strict";
import test from "node:test";
import { inspectReleaseCandidate } from "./release-candidate-source.mjs";

const SHA = "0123456789abcdef0123456789abcdef01234567";

function response(value, { ok = true, status = 200 } = {}) {
  return {
    ok,
    status,
    async json() {
      return value;
    }
  };
}

function fixture(overrides = {}) {
  const run = {
    id: 123,
    path: ".github/workflows/release.yml",
    event: "workflow_dispatch",
    head_branch: "main",
    head_sha: SHA,
    status: "completed",
    conclusion: "success",
    run_attempt: 1,
    ...overrides.run
  };
  const jobs = {
    total_count: 3,
    jobs: [
      { name: "package", status: "completed", conclusion: "success" },
      { name: "Candidate acceptance / Candidate acceptance", status: "completed", conclusion: "success" },
      { name: "Remote SSH acceptance", status: "completed", conclusion: "success" }
    ],
    ...overrides.jobs
  };
  const artifacts = {
    total_count: 1,
    artifacts: [{ id: 456, name: "openwrangler-preview-release", expired: false }],
    ...overrides.artifacts
  };
  const requests = [];
  const fetch_ = async (url, options) => {
    requests.push({ url, options });
    if (url.endsWith("/jobs?per_page=100")) return response(jobs);
    if (url.endsWith("/artifacts?per_page=100")) return response(artifacts);
    return response(run);
  };
  return { fetch_, requests };
}

async function inspect(overrides = {}, fixtureOverrides = {}) {
  const value = fixture(fixtureOverrides);
  const result = await inspectReleaseCandidate({
    repository: "Matt17BR/openwrangler",
    candidateRunId: "123",
    expectedAutomationSha: SHA,
    channel: "preview",
    releaseTag: "v1.99.7",
    token: "test-token",
    fetch_: value.fetch_,
    ...overrides
  });
  return { result, requests: value.requests };
}

test("selects one unexpired artifact from an exact successful first-attempt candidate", async () => {
  const { result, requests } = await inspect();
  assert.deepEqual(result, {
    artifactId: 456,
    artifactName: "openwrangler-preview-release",
    candidateRunId: 123,
    expectedSha: SHA,
    releaseTag: "v1.99.7"
  });
  assert.equal(requests.length, 3);
  assert.ok(requests.every(({ options }) => options.headers.Authorization === "Bearer test-token"));
});

test("rejects reruns, base drift, failed fan-in, and expired or ambiguous artifacts", async () => {
  await assert.rejects(() => inspect({}, { run: { run_attempt: 2 } }), /first-attempt/u);
  await assert.rejects(
    () => inspect({}, { run: { head_sha: "abcdef0123456789abcdef0123456789abcdef01" } }),
    /exact protected main/u
  );
  await assert.rejects(
    () =>
      inspect(
        {},
        {
          jobs: {
            total_count: 3,
            jobs: [
              { name: "package", status: "completed", conclusion: "success" },
              { name: "Candidate acceptance / Candidate acceptance", status: "completed", conclusion: "failure" },
              { name: "Remote SSH acceptance", status: "completed", conclusion: "success" }
            ]
          }
        }
      ),
    /Candidate acceptance/u
  );
  await assert.rejects(
    () =>
      inspect(
        {},
        { artifacts: { total_count: 1, artifacts: [{ id: 456, name: "openwrangler-preview-release", expired: true }] } }
      ),
    /unexpired/u
  );
  await assert.rejects(
    () =>
      inspect(
        {},
        {
          artifacts: {
            total_count: 2,
            artifacts: [
              { id: 456, name: "openwrangler-preview-release", expired: false },
              { id: 789, name: "openwrangler-preview-release", expired: false }
            ]
          }
        }
      ),
    /exactly one/u
  );
});

test("binds stable candidates only to the stable workflow and artifact name", async () => {
  const { result } = await inspect(
    { channel: "stable", releaseTag: "v2.0.0" },
    {
      run: { path: ".github/workflows/stable-release.yml" },
      artifacts: {
        total_count: 1,
        artifacts: [{ id: 789, name: "openwrangler-stable-release", expired: false }]
      }
    }
  );
  assert.equal(result.artifactId, 789);
  assert.equal(result.artifactName, "openwrangler-stable-release");
});

test("rejects truncated candidate job and artifact inventories", async () => {
  await assert.rejects(() => inspect({}, { jobs: { total_count: 4 } }), /job inventory is malformed/u);
  await assert.rejects(() => inspect({}, { jobs: { total_count: 101 } }), /job inventory is malformed/u);
  await assert.rejects(() => inspect({}, { artifacts: { total_count: 2 } }), /artifact inventory is malformed/u);
  await assert.rejects(() => inspect({}, { artifacts: { total_count: 101 } }), /artifact inventory is malformed/u);
});
