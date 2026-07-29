import assert from "node:assert/strict";
import test from "node:test";
import {
  AZURE_DEVOPS_PROFILE_URL,
  AZURE_DEVOPS_RESOURCE_ID,
  marketplaceIdentityProfileMain,
  resolveMarketplaceIdentityProfile
} from "./marketplace-identity-profile.mjs";

const profileId = "584ec93a-2c66-4d01-b78d-3d32c0aad1b3";
const secretToken = "header.payload.signature";

function profileResponse(body = JSON.stringify({ displayName: "Open Wrangler publisher", id: profileId })) {
  return new Response(body, {
    headers: { "content-type": "application/json" },
    status: 200
  });
}

test("resolves one Marketplace identity UUID through the official bounded Azure DevOps profile flow", async () => {
  const calls = [];
  const azureCliCalls = [];
  const resolved = await resolveMarketplaceIdentityProfile({
    fetchImpl: async (url, init) => {
      calls.push({ init, url });
      return profileResponse();
    },
    runAzureCli: (...arguments_) => {
      azureCliCalls.push(arguments_);
      return `${secretToken}\n`;
    }
  });

  assert.equal(resolved, profileId);
  assert.deepEqual(azureCliCalls, [
    [
      "az",
      [
        "account",
        "get-access-token",
        "--resource",
        AZURE_DEVOPS_RESOURCE_ID,
        "--query",
        "accessToken",
        "--output",
        "tsv",
        "--only-show-errors"
      ],
      {
        encoding: "utf8",
        maxBuffer: 32 * 1024,
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 30_000,
        windowsHide: true
      }
    ]
  ]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, AZURE_DEVOPS_PROFILE_URL);
  assert.equal(calls[0].init.method, "GET");
  assert.equal(calls[0].init.redirect, "error");
  assert.equal(calls[0].init.headers.Accept, "application/json");
  assert.equal(calls[0].init.headers.Authorization, `Bearer ${secretToken}`);
  assert.ok(calls[0].init.signal instanceof AbortSignal);
  assert.equal(AZURE_DEVOPS_RESOURCE_ID, "499b84ac-1321-427f-aa17-267ca6975798");
});

test("prints only the validated Marketplace profile ID on success", async () => {
  let stdout = "";
  let stderr = "";
  const exitCode = await marketplaceIdentityProfileMain({
    fetchImpl: async () => profileResponse(),
    runAzureCli: () => secretToken,
    stderr: { write: (value) => (stderr += value) },
    stdout: { write: (value) => (stdout += value) }
  });

  assert.equal(exitCode, 0);
  assert.equal(stdout, `Marketplace identity profile ID: ${profileId}\n`);
  assert.equal(stderr, "");
  assert.doesNotMatch(stdout, /header|payload|signature|displayName/u);
});

test("fails closed without disclosing the token or profile response", async () => {
  const sensitiveResponse = JSON.stringify({
    displayName: "private publisher name",
    emailAddress: "private@example.com",
    id: "not-a-uuid"
  });
  let stdout = "";
  let stderr = "";
  const exitCode = await marketplaceIdentityProfileMain({
    fetchImpl: async () => profileResponse(sensitiveResponse),
    runAzureCli: () => secretToken,
    stderr: { write: (value) => (stderr += value) },
    stdout: { write: (value) => (stdout += value) }
  });

  assert.equal(exitCode, 1);
  assert.equal(stdout, "");
  assert.equal(stderr, "Marketplace identity profile lookup failed.\n");
  assert.doesNotMatch(stderr, /header|payload|signature|private|example\.com|not-a-uuid/u);
});

test("rejects malformed credentials, responses, duplicate IDs, and oversized bodies within fixed bounds", async () => {
  await assert.rejects(
    resolveMarketplaceIdentityProfile({
      fetchImpl: async () => profileResponse(),
      runAzureCli: () => `token with spaces ${secretToken}`
    }),
    /invalid Azure DevOps resource token/u
  );
  await assert.rejects(
    resolveMarketplaceIdentityProfile({
      fetchImpl: async () => new Response("", { status: 401 }),
      runAzureCli: () => secretToken
    }),
    /did not accept/u
  );
  await assert.rejects(
    resolveMarketplaceIdentityProfile({
      fetchImpl: async () => profileResponse(`{"id":"${profileId}","id":"${profileId}"}`),
      runAzureCli: () => secretToken
    }),
    /invalid bounded profile/u
  );
  await assert.rejects(
    resolveMarketplaceIdentityProfile({
      fetchImpl: async () => profileResponse("x".repeat(65 * 1024)),
      runAzureCli: () => secretToken
    }),
    /invalid bounded profile/u
  );
});
