import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { verifyOpenVsxReleaseOnce, waitForOpenVsxRelease } from "./verify-open-vsx-release.mjs";

const root = "https://registry.example";
const version = "1.0.1";
const candidateBytes = Buffer.from("canonical-vsix");
const candidateSha256 = createHash("sha256").update(candidateBytes).digest("hex");
const api = `${root}/api/Matt17BR/openwrangler/${version}`;
const download = `${api}/file/Matt17BR.openwrangler-${version}.vsix`;
const checksum = `${api}/file/Matt17BR.openwrangler-${version}.sha256`;

function metadata(overrides = {}) {
  return {
    allVersions: { [version]: api },
    deprecated: false,
    displayName: "Open Wrangler",
    downloadable: true,
    downloads: { universal: download },
    files: { download, sha256: checksum },
    name: "openwrangler",
    namespace: "Matt17BR",
    preRelease: false,
    preview: false,
    publishedBy: { loginName: "Matt17BR" },
    targetPlatform: "universal",
    unrelatedPublisher: true,
    verified: false,
    version,
    ...overrides
  };
}

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), { status });
}

function exactFetch({ manifest = metadata(), sha = candidateSha256, vsix = candidateBytes } = {}) {
  return async (url) => {
    if (url === api) return jsonResponse(manifest);
    if (url === checksum) return new Response(sha);
    if (url === download) return new Response(vsix);
    throw new Error(`Unexpected Open VSX URL: ${url}`);
  };
}

function verify(fetchImpl) {
  return verifyOpenVsxReleaseOnce({
    candidateBytes,
    candidateSha256,
    fetchImpl,
    root,
    version
  });
}

test("verifies exact stable Open VSX metadata, checksum, publisher, and VSIX bytes", async () => {
  assert.deepEqual(await verify(exactFetch()), {
    publishedBy: "Matt17BR",
    status: "exact",
    verifiedNamespace: false,
    version
  });
});

test("verifies preview metadata only for an explicitly preview candidate", async () => {
  const preview = metadata({ preRelease: true, preview: true });
  assert.equal(
    (
      await verifyOpenVsxReleaseOnce({
        candidateBytes,
        candidateSha256,
        channel: "preview",
        fetchImpl: exactFetch({ manifest: preview }),
        root,
        version
      })
    ).status,
    "exact"
  );
  await assert.rejects(verify(exactFetch({ manifest: preview })), /metadata conflicts/u);
});

test("distinguishes an absent version from a transient registry response", async () => {
  assert.equal((await verify(async () => jsonResponse({ error: "missing" }, 404))).status, "missing");
  assert.equal((await verify(async () => jsonResponse({ error: "busy" }, 503))).status, "transient");
});

test("rejects conflicting metadata, checksum, bytes, and preview versions", async () => {
  await assert.rejects(
    verify(exactFetch({ manifest: metadata({ publishedBy: { loginName: "someone-else" } }) })),
    /metadata conflicts/u
  );
  await assert.rejects(verify(exactFetch({ manifest: metadata({ preRelease: true }) })), /metadata conflicts/u);
  await assert.rejects(verify(exactFetch({ sha: "f".repeat(64) })), /checksum conflicts/u);
  await assert.rejects(verify(exactFetch({ vsix: Buffer.from("different") })), /different bytes/u);
  await assert.rejects(
    verifyOpenVsxReleaseOnce({
      candidateBytes,
      candidateSha256,
      fetchImpl: exactFetch(),
      root,
      version: "1.0.1-beta.1"
    }),
    /bounded checksum-matched canonical VSIX/u
  );
});

test("post-publish verification retries only missing or transient public metadata", async () => {
  let attempt = 0;
  const delays = [];
  const fetchImpl = async (url) => {
    if (url === api) {
      attempt += 1;
      if (attempt === 1) return jsonResponse({ error: "missing" }, 404);
      if (attempt === 2) return jsonResponse({ error: "busy" }, 503);
      return jsonResponse(metadata());
    }
    if (url === checksum) return new Response(candidateSha256);
    if (url === download) return new Response(candidateBytes);
    throw new Error(`Unexpected Open VSX URL: ${url}`);
  };
  const result = await waitForOpenVsxRelease({
    attempts: 3,
    candidateBytes,
    candidateSha256,
    delay: async (milliseconds) => {
      delays.push(milliseconds);
    },
    delayMs: 7,
    fetchImpl,
    root,
    version
  });
  assert.equal(result.status, "exact");
  assert.deepEqual(delays, [7, 7]);
});

test("post-publish verification remains bounded and fails closed", async () => {
  await assert.rejects(
    waitForOpenVsxRelease({
      attempts: 2,
      candidateBytes,
      candidateSha256,
      delay: async () => {},
      fetchImpl: async () => jsonResponse({ error: "missing" }, 404),
      root,
      version
    }),
    /within the verification window/u
  );
  await assert.rejects(
    waitForOpenVsxRelease({
      attempts: 92,
      candidateBytes,
      candidateSha256,
      fetchImpl: exactFetch(),
      root,
      version
    }),
    /outside the reviewed bound/u
  );
});

test("default post-publish verification covers the reviewed fifteen-minute propagation window", async () => {
  let attempts = 0;
  const result = await waitForOpenVsxRelease({
    candidateBytes,
    candidateSha256,
    delay: async () => {},
    fetchImpl: async (url) => {
      if (url === api) {
        attempts += 1;
        return attempts < 91 ? jsonResponse({ error: "missing" }, 404) : jsonResponse(metadata());
      }
      if (url === checksum) return new Response(candidateSha256);
      if (url === download) return new Response(candidateBytes);
      throw new Error(`Unexpected Open VSX URL: ${url}`);
    },
    root,
    version
  });
  assert.equal(result.status, "exact");
  assert.equal(attempts, 91);
});
