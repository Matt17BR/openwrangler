import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { publishGitHubStableRelease } from "./publish-github-stable-release.mjs";

const repository = "Matt17BR/openwrangler";
const apiRoot = `https://api.github.com/repos/${repository}`;
const uploadRoot = `https://uploads.github.com/repos/${repository}`;
const expectedCommit = "a".repeat(40);
const releaseTag = "v1.0.1";
const version = "1.0.1";
const assets = [
  { bytes: Buffer.from("vsix"), contentType: "application/octet-stream", name: "openwrangler.vsix" },
  {
    bytes: Buffer.from('{"provenance":true}\n'),
    contentType: "application/json",
    name: "openwrangler.vsix.provenance.json"
  },
  {
    bytes: Buffer.from(`${"1".repeat(64)}\n`),
    contentType: "text/plain; charset=utf-8",
    name: "openwrangler.vsix.sha256"
  }
];

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), {
    headers: { "content-type": "application/json" },
    status
  });
}

function releaseAsset(name, bytes, id) {
  return {
    digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
    id,
    name,
    size: bytes.length,
    state: "uploaded",
    url: `${apiRoot}/releases/assets/${id}`
  };
}

function releaseMetadata(releaseAssets = []) {
  return {
    assets: releaseAssets,
    draft: false,
    id: 71,
    name: `Open Wrangler ${releaseTag}`,
    prerelease: false,
    tag_name: releaseTag,
    target_commitish: expectedCommit,
    upload_url: `${uploadRoot}/releases/71/assets{?name,label}`
  };
}

function githubFixture({
  existingAssets = [],
  release = releaseMetadata(existingAssets),
  releaseAbsent = false,
  tagCommit = expectedCommit
} = {}) {
  const assetBytes = new Map(
    existingAssets.map((asset) => [asset.id, assets.find((expected) => expected.name === asset.name)?.bytes])
  );
  let currentRelease = releaseAbsent ? undefined : release;
  let currentTag = tagCommit;
  let nextAssetId = 100;
  const requests = [];
  const fetchImpl = async (input, options = {}) => {
    const url = String(input);
    requests.push({ method: options.method ?? "GET", url });
    assert.equal(options.headers?.token, undefined);
    if (options.headers !== undefined) {
      assert.match(options.headers.authorization ?? "", /^Bearer /u);
    }
    if (url === `${apiRoot}/git/ref/tags/${releaseTag}` && (options.method ?? "GET") === "GET") {
      return currentTag === undefined
        ? jsonResponse({ message: "Not Found" }, 404)
        : jsonResponse({
            object: { sha: currentTag, type: "commit" },
            ref: `refs/tags/${releaseTag}`
          });
    }
    if (url === `${apiRoot}/releases/tags/${releaseTag}` && (options.method ?? "GET") === "GET") {
      return currentRelease === undefined ? jsonResponse({ message: "Not Found" }, 404) : jsonResponse(currentRelease);
    }
    if (url === `${apiRoot}/releases` && options.method === "POST") {
      assert.equal(currentRelease, undefined);
      const body = JSON.parse(options.body);
      assert.equal(body.prerelease, false);
      assert.equal(body.target_commitish, expectedCommit);
      currentTag = expectedCommit;
      currentRelease = releaseMetadata([]);
      return jsonResponse(currentRelease, 201);
    }
    if (url.startsWith(`${uploadRoot}/releases/71/assets?`) && options.method === "POST") {
      const name = new URL(url).searchParams.get("name");
      const expected = assets.find((asset) => asset.name === name);
      assert.ok(expected);
      assert.deepEqual(Buffer.from(options.body), expected.bytes);
      const created = releaseAsset(expected.name, expected.bytes, nextAssetId);
      nextAssetId += 1;
      assetBytes.set(created.id, expected.bytes);
      currentRelease = { ...currentRelease, assets: [...currentRelease.assets, created] };
      return jsonResponse(created, 201);
    }
    const assetMatch = url.match(/\/releases\/assets\/(\d+)$/u);
    if (assetMatch !== null) {
      const bytes = assetBytes.get(Number(assetMatch[1]));
      return bytes === undefined ? jsonResponse({ message: "Not Found" }, 404) : new Response(bytes);
    }
    throw new Error(`Unexpected fake GitHub request: ${options.method ?? "GET"} ${url}`);
  };
  return { fetchImpl, requests, release: () => currentRelease };
}

function publish(fetchImpl) {
  return publishGitHubStableRelease({
    assets,
    expectedCommit,
    fetchImpl,
    releaseTag,
    repository,
    token: "test-token",
    version
  });
}

test("accepts an already exact GitHub release without mutating it", async () => {
  const existingAssets = assets.map((asset, index) => releaseAsset(asset.name, asset.bytes, index + 1));
  const fixture = githubFixture({ existingAssets });
  const result = await publish(fixture.fetchImpl);
  assert.deepEqual(result, { releaseId: 71, releaseTag, version });
  assert.equal(
    fixture.requests.some((request) => request.method === "POST"),
    false
  );
});

test("creates an absent release and uploads each canonical asset exactly once", async () => {
  const fixture = githubFixture({ releaseAbsent: true, tagCommit: undefined });
  await publish(fixture.fetchImpl);
  assert.deepEqual(
    fixture.release().assets.map((asset) => asset.name),
    assets.map((asset) => asset.name)
  );
  assert.equal(fixture.requests.filter((request) => request.method === "POST").length, 4);
});

test("resumes a partial exact release without replacing its existing asset", async () => {
  const retained = releaseAsset(assets[0].name, assets[0].bytes, 1);
  const fixture = githubFixture({ existingAssets: [retained] });
  await publish(fixture.fetchImpl);
  assert.equal(fixture.requests.filter((request) => request.method === "POST").length, 2);
  assert.equal(fixture.release().assets[0].id, retained.id);
});

test("rejects conflicting tags, metadata, assets, and preview channels", async () => {
  await assert.rejects(publish(githubFixture({ tagCommit: "b".repeat(40) }).fetchImpl), /different commit/u);

  const previewFixture = githubFixture({
    release: { ...releaseMetadata([]), prerelease: true }
  });
  await assert.rejects(publish(previewFixture.fetchImpl), /metadata conflicts/u);

  const unexpectedFixture = githubFixture({
    existingAssets: [{ ...releaseAsset("other.vsix", Buffer.from("other"), 1), name: "other.vsix" }]
  });
  await assert.rejects(publish(unexpectedFixture.fetchImpl), /unexpected or malformed asset/u);

  const wrongBytes = Buffer.from("nope");
  const conflictingAsset = releaseAsset(assets[0].name, wrongBytes, 1);
  const conflictFixture = githubFixture({ existingAssets: [conflictingAsset] });
  await assert.rejects(publish(conflictFixture.fetchImpl), /conflicting byte size|conflicting digest/u);

  await assert.rejects(
    publishGitHubStableRelease({
      assets,
      expectedCommit,
      fetchImpl: githubFixture().fetchImpl,
      releaseTag: "v1.0.1-beta.1",
      repository,
      token: "test-token",
      version: "1.0.1-beta.1"
    }),
    /stable extension version/u
  );
});
