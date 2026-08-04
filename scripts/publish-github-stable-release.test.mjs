import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { publishGitHubRelease } from "./github-release-publisher.mjs";
import {
  parseGitHubImmutableReleaseExpectation,
  publishGitHubStableRelease
} from "./publish-github-stable-release.mjs";
import { readReleaseNotesFromCommit } from "./release-notes.mjs";

const repository = "Matt17BR/openwrangler";
const apiRoot = `https://api.github.com/repos/${repository}`;
const uploadRoot = `https://uploads.github.com/repos/${repository}`;
const expectedCommit = "a".repeat(40);
const releaseNotes = "Open Wrangler now publishes release notes from the tagged source.\n";
const stable = Object.freeze({ channel: "stable", releaseTag: "v1.2.3", version: "1.2.3" });
const preview = Object.freeze({ channel: "preview", releaseTag: "v0.3.0", version: "0.3.0" });
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

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), {
    headers: { "content-type": "application/json" },
    status
  });
}

function releaseAsset(name, bytes, id) {
  const canonical = assets.find((asset) => asset.name === name);
  return {
    content_type: canonical?.contentType ?? "application/octet-stream",
    digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
    id,
    label: "",
    name,
    size: bytes.length,
    state: "uploaded",
    url: `${apiRoot}/releases/assets/${id}`
  };
}

function exactAssets() {
  return assets.map((asset, index) => releaseAsset(asset.name, asset.bytes, index + 1));
}

function releaseMetadata({
  channel = "stable",
  draft = false,
  immutable = false,
  releaseAssets = [],
  releaseId = 71,
  releaseTag = channel === "stable" ? stable.releaseTag : preview.releaseTag,
  version = channel === "stable" ? stable.version : preview.version,
  ...overrides
} = {}) {
  return {
    assets: releaseAssets,
    body: releaseNotes,
    draft,
    id: releaseId,
    immutable,
    name: `Open Wrangler v${version}`,
    prerelease: channel === "preview",
    tag_name: releaseTag,
    target_commitish: expectedCommit,
    upload_url: `${uploadRoot}/releases/${releaseId}/assets{?name,label}`,
    ...overrides
  };
}

function githubFixture({
  afterPatch,
  assetByteOverrides = new Map(),
  createConflict,
  createConflictProvidesRelease = false,
  hiddenInventoryReadsAfterMutation = 0,
  initialReleases = [],
  immutableOnPublish = false,
  inventoryPrefix = [],
  malformedInventory,
  publishOnSecondCompleteDraftLookup = false,
  publishConflict,
  publishConflictBecomesPublic = false,
  patchFailureAfterCommit,
  staleDraftInventoryOnce = false,
  tagCommits = [expectedCommit],
  transitionAfterPublishedMiss = false,
  uploadConflictName,
  uploadConflictProvidesAsset = false
} = {}) {
  const releases = initialReleases.map(clone);
  const assetBytes = new Map();
  for (const release of releases) {
    for (const asset of release.assets ?? []) {
      const expected = assets.find((candidate) => candidate.name === asset.name);
      if (expected !== undefined) assetBytes.set(asset.id, expected.bytes);
    }
  }
  for (const [id, bytes] of assetByteOverrides) assetBytes.set(id, bytes);
  let nextAssetId = 100;
  let tagRequest = 0;
  let completeDraftLookups = 0;
  let returnedStaleDraftInventory = false;
  let transitionedAfterMiss = false;
  let hiddenInventoryReads = 0;
  const requests = [];
  const fetchImpl = async (input, options = {}) => {
    const url = String(input);
    const method = options.method ?? "GET";
    requests.push({ body: options.body, method, url });
    if (options.headers !== undefined) {
      assert.match(options.headers.authorization ?? "", /^Bearer /u);
    }

    const tagMatch = url.match(new RegExp(`^${apiRoot}/git/ref/tags/(.+)$`, "u"));
    if (tagMatch !== null && method === "GET") {
      const commit = tagCommits[Math.min(tagRequest, tagCommits.length - 1)];
      tagRequest += 1;
      return commit === undefined
        ? jsonResponse({ message: "Not Found" }, 404)
        : jsonResponse({
            object: { sha: commit, type: "commit" },
            ref: `refs/tags/${decodeURIComponent(tagMatch[1])}`
          });
    }

    const publishedMatch = url.match(new RegExp(`^${apiRoot}/releases/tags/(.+)$`, "u"));
    if (publishedMatch !== null && method === "GET") {
      const tag = decodeURIComponent(publishedMatch[1]);
      const completeDraft = releases.find(
        (candidate) =>
          candidate.tag_name === tag && candidate.draft === true && candidate.assets.length === assets.length
      );
      if (completeDraft !== undefined) {
        completeDraftLookups += 1;
        if (publishOnSecondCompleteDraftLookup && completeDraftLookups === 2) {
          completeDraft.draft = false;
          completeDraft.immutable = immutableOnPublish;
        }
      }
      const release = releases.find((candidate) => candidate.tag_name === tag && candidate.draft === false);
      if (release === undefined && transitionAfterPublishedMiss && !transitionedAfterMiss) {
        const draft = releases.find((candidate) => candidate.tag_name === tag && candidate.draft === true);
        if (draft !== undefined) {
          transitionedAfterMiss = true;
          draft.draft = false;
          draft.immutable = immutableOnPublish;
        }
      }
      return release === undefined ? jsonResponse({ message: "Not Found" }, 404) : jsonResponse(clone(release));
    }

    if (url.startsWith(`${apiRoot}/releases?`) && method === "GET") {
      if (malformedInventory !== undefined) return jsonResponse(malformedInventory);
      if (hiddenInventoryReads > 0) {
        hiddenInventoryReads -= 1;
        return jsonResponse([]);
      }
      const page = Number(new URL(url).searchParams.get("page"));
      const inventory = [...inventoryPrefix, ...releases];
      if (staleDraftInventoryOnce && !returnedStaleDraftInventory) {
        const published = inventory.find(
          (release) => release.tag_name === stable.releaseTag && release.draft === false
        );
        if (published !== undefined) {
          returnedStaleDraftInventory = true;
          const stale = { ...clone(published), draft: true, immutable: false };
          return jsonResponse([stale]);
        }
      }
      return jsonResponse(clone(inventory.slice((page - 1) * 100, page * 100)));
    }

    if (url === `${apiRoot}/releases` && method === "POST") {
      if (createConflict) {
        if (createConflictProvidesRelease) {
          releases.push(
            releaseMetadata({
              channel: JSON.parse(options.body).prerelease ? "preview" : "stable",
              draft: true
            })
          );
        }
        return jsonResponse({ message: "conflict" }, 422);
      }
      assert.equal(
        releases.some((release) => release.tag_name === stable.releaseTag),
        false
      );
      const body = JSON.parse(options.body);
      assert.equal(body.draft, true);
      assert.equal(body.body, releaseNotes);
      assert.equal(body.generate_release_notes, false);
      assert.equal(body.make_latest, "false");
      const created = releaseMetadata({
        body: body.body,
        channel: body.prerelease ? "preview" : "stable",
        draft: true,
        releaseId: 71,
        releaseTag: body.tag_name,
        version: body.tag_name.slice(1)
      });
      releases.push(created);
      hiddenInventoryReads = hiddenInventoryReadsAfterMutation;
      return jsonResponse(clone(created), 201);
    }

    const patchMatch = url.match(new RegExp(`^${apiRoot}/releases/(\\d+)$`, "u"));
    if (patchMatch !== null && method === "PATCH") {
      const release = releases.find((candidate) => candidate.id === Number(patchMatch[1]));
      assert.ok(release);
      const body = JSON.parse(options.body);
      assert.equal(body.body, releaseNotes);
      assert.equal(body.draft, false);
      assert.equal(body.make_latest, body.prerelease ? "false" : "true");
      if (publishConflict) {
        if (publishConflictBecomesPublic) {
          release.draft = false;
          release.immutable = immutableOnPublish;
        }
        return jsonResponse({ message: "conflict" }, 422);
      }
      release.draft = false;
      release.immutable = immutableOnPublish;
      if (patchFailureAfterCommit === "network") {
        throw new Error("simulated network loss after publication");
      }
      if (patchFailureAfterCommit === "server") {
        return jsonResponse({ message: "temporary server failure" }, 503);
      }
      const response = jsonResponse(clone(release));
      afterPatch?.(release, releases);
      return response;
    }

    const uploadMatch = url.match(new RegExp(`^${uploadRoot}/releases/(\\d+)/assets\\?`, "u"));
    if (uploadMatch !== null && method === "POST") {
      const release = releases.find((candidate) => candidate.id === Number(uploadMatch[1]));
      assert.ok(release);
      assert.equal(release.draft, true);
      const name = new URL(url).searchParams.get("name");
      const expected = assets.find((asset) => asset.name === name);
      assert.ok(expected);
      assert.equal(options.headers["content-type"], expected.contentType);
      assert.deepEqual(Buffer.from(options.body), expected.bytes);
      if (name === uploadConflictName) {
        if (uploadConflictProvidesAsset) {
          const provided = releaseAsset(expected.name, expected.bytes, nextAssetId);
          nextAssetId += 1;
          release.assets.push(provided);
          assetBytes.set(provided.id, expected.bytes);
        }
        return jsonResponse({ message: "conflict" }, 422);
      }
      const created = releaseAsset(expected.name, expected.bytes, nextAssetId);
      nextAssetId += 1;
      release.assets.push(created);
      assetBytes.set(created.id, expected.bytes);
      hiddenInventoryReads = hiddenInventoryReadsAfterMutation;
      return jsonResponse(clone(created), 201);
    }

    const assetMatch = url.match(new RegExp(`^${apiRoot}/releases/assets/(\\d+)$`, "u"));
    if (assetMatch !== null && method === "GET") {
      const bytes = assetBytes.get(Number(assetMatch[1]));
      return bytes === undefined ? jsonResponse({ message: "Not Found" }, 404) : new Response(bytes);
    }
    throw new Error(`Unexpected fake GitHub request: ${method} ${url}`);
  };
  return { fetchImpl, releases, requests };
}

function publish(fetchImpl, options = {}) {
  const release = options.release ?? stable;
  return publishGitHubRelease({
    assets,
    channel: release.channel,
    expectImmutable: options.expectImmutable ?? false,
    expectedCommit,
    fetchImpl,
    releaseNotes,
    releaseTag: release.releaseTag,
    repository,
    token: "test-token",
    version: release.version
  });
}

test("accepts an already exact public release without mutation", async () => {
  const fixture = githubFixture({
    initialReleases: [releaseMetadata({ immutable: true, releaseAssets: exactAssets() })]
  });
  assert.deepEqual(await publish(fixture.fetchImpl, { expectImmutable: true }), {
    immutable: true,
    releaseId: 71,
    releaseTag: stable.releaseTag,
    version: stable.version
  });
  assert.equal(
    fixture.requests.some((request) => request.method !== "GET"),
    false
  );
});

test("creates a draft, verifies all three assets, and only then publishes", async () => {
  const fixture = githubFixture();
  const result = await publish(fixture.fetchImpl);
  assert.equal(result.releaseId, 71);
  assert.equal(fixture.releases[0].draft, false);
  assert.deepEqual(
    fixture.releases[0].assets.map((asset) => asset.name),
    assets.map((asset) => asset.name)
  );
  const mutationMethods = fixture.requests
    .filter((request) => request.method !== "GET")
    .map((request) => request.method);
  assert.deepEqual(mutationMethods, ["POST", "POST", "POST", "POST", "PATCH"]);
});

test("retries temporary absent inventories after mutations without delaying initial discovery", async () => {
  const fixture = githubFixture({ hiddenInventoryReadsAfterMutation: 1 });
  assert.equal((await publish(fixture.fetchImpl)).releaseId, 71);
  const firstMutation = fixture.requests.findIndex((request) => request.method !== "GET");
  assert.equal(
    fixture.requests.slice(0, firstMutation).filter((request) => request.url.startsWith(`${apiRoot}/releases?`)).length,
    1
  );
});

test("reads release notes from the exact commit instead of the mutable checkout", (context) => {
  const root = mkdtempSync(join(tmpdir(), "ow-release-notes-"));
  context.after(() => rmSync(root, { force: true, recursive: true }));
  execFileSync("git", ["init", "--quiet"], { cwd: root });
  mkdirSync(join(root, "docs", "release-notes"), { recursive: true });
  const notesPath = join(root, "docs", "release-notes", "1.2.3.md");
  writeFileSync(notesPath, releaseNotes);
  execFileSync("git", ["add", "."], { cwd: root });
  execFileSync(
    "git",
    [
      "-c",
      "user.name=Open Wrangler",
      "-c",
      "user.email=test@example.invalid",
      "commit",
      "--quiet",
      "-m",
      "release notes"
    ],
    {
      cwd: root
    }
  );
  const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  writeFileSync(notesPath, "Unreviewed working-tree replacement.\n");
  assert.equal(readReleaseNotesFromCommit({ commit, root, version: "1.2.3" }), releaseNotes);
  assert.throws(() => readReleaseNotesFromCommit({ commit, root, version: "1.2.4" }), /must contain release notes/u);

  writeFileSync(notesPath, Buffer.from([0x23, 0x20, 0x52, 0x65, 0x6c, 0x65, 0x61, 0x73, 0x65, 0x0a, 0xff, 0x0a]));
  execFileSync("git", ["add", "."], { cwd: root });
  execFileSync(
    "git",
    [
      "-c",
      "user.name=Open Wrangler",
      "-c",
      "user.email=test@example.invalid",
      "commit",
      "--quiet",
      "-m",
      "invalid release notes"
    ],
    { cwd: root }
  );
  const invalidCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  assert.throws(
    () => readReleaseNotesFromCommit({ commit: invalidCommit, root, version: "1.2.3" }),
    /must be valid UTF-8/u
  );

  writeFileSync(notesPath, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("# Release\nCafé\n")]));
  execFileSync("git", ["add", "."], { cwd: root });
  execFileSync(
    "git",
    [
      "-c",
      "user.name=Open Wrangler",
      "-c",
      "user.email=test@example.invalid",
      "commit",
      "--quiet",
      "-m",
      "byte-order mark"
    ],
    { cwd: root }
  );
  const bomCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  assert.throws(
    () => readReleaseNotesFromCommit({ commit: bomCommit, root, version: "1.2.3" }),
    /must use canonical UTF-8 without a byte-order mark/u
  );

  const unicodeReleaseNotes = "# Release\nCafé users can open 日本語 columns.\n";
  writeFileSync(notesPath, unicodeReleaseNotes);
  execFileSync("git", ["add", "."], { cwd: root });
  execFileSync(
    "git",
    [
      "-c",
      "user.name=Open Wrangler",
      "-c",
      "user.email=test@example.invalid",
      "commit",
      "--quiet",
      "-m",
      "unicode release notes"
    ],
    { cwd: root }
  );
  const unicodeCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  assert.equal(readReleaseNotesFromCommit({ commit: unicodeCommit, root, version: "1.2.3" }), unicodeReleaseNotes);
});

test("revalidates pinned canonical files immediately before every release mutation", async () => {
  const fixture = githubFixture();
  let guardCalls = 0;
  await assert.rejects(
    publishGitHubRelease({
      assets,
      beforeMutation() {
        guardCalls += 1;
        throw new Error("canonical sidecar drifted");
      },
      channel: stable.channel,
      expectImmutable: false,
      expectedCommit,
      fetchImpl: fixture.fetchImpl,
      releaseNotes,
      releaseTag: stable.releaseTag,
      repository,
      token: "test-token",
      version: stable.version
    }),
    /canonical sidecar drifted/u
  );
  assert.equal(guardCalls, 1);
  assert.equal(
    fixture.requests.some((request) => request.method !== "GET"),
    false
  );
});

test("resumes an exact partial draft without replacing retained assets", async () => {
  const retained = releaseAsset(assets[0].name, assets[0].bytes, 1);
  const fixture = githubFixture({
    initialReleases: [releaseMetadata({ draft: true, releaseAssets: [retained] })]
  });
  await publish(fixture.fetchImpl);
  assert.equal(fixture.releases[0].assets[0].id, retained.id);
  assert.equal(fixture.requests.filter((request) => request.method === "POST").length, 2);
});

test("resumes create and upload conflicts only when the discovered draft is exact", async () => {
  const creation = githubFixture({ createConflict: true, createConflictProvidesRelease: true });
  await publish(creation.fetchImpl);
  assert.equal(creation.releases[0].draft, false);

  const missingCreation = githubFixture({ createConflict: true });
  await assert.rejects(publish(missingCreation.fetchImpl), /conflicted without an exact release/u);

  const upload = githubFixture({ uploadConflictName: assets[0].name, uploadConflictProvidesAsset: true });
  await publish(upload.fetchImpl);
  assert.equal(upload.releases[0].draft, false);

  const unresolved = githubFixture({ uploadConflictName: assets[0].name });
  await assert.rejects(publish(unresolved.fetchImpl), /missing openwrangler\.vsix/u);
});

test("accepts exact concurrent publication across every draft-to-public observation", async () => {
  const fixture = githubFixture({ publishConflict: true, publishConflictBecomesPublic: true });
  const result = await publish(fixture.fetchImpl);
  assert.equal(result.releaseId, 71);
  assert.equal(fixture.releases[0].draft, false);

  const unresolved = githubFixture({ publishConflict: true });
  await assert.rejects(publish(unresolved.fetchImpl), /failed with HTTP 422/u);

  const beforePatch = githubFixture({ publishOnSecondCompleteDraftLookup: true });
  const beforePatchResult = await publish(beforePatch.fetchImpl);
  assert.equal(beforePatchResult.releaseId, 71);
  assert.equal(
    beforePatch.requests.some((request) => request.method === "PATCH"),
    false
  );

  const missThenPublicInventory = githubFixture({
    initialReleases: [releaseMetadata({ draft: true, releaseAssets: exactAssets() })],
    transitionAfterPublishedMiss: true
  });
  assert.equal((await publish(missThenPublicInventory.fetchImpl)).releaseId, 71);

  const publishedThenStaleDraft = githubFixture({
    initialReleases: [releaseMetadata({ releaseAssets: exactAssets() })],
    staleDraftInventoryOnce: true
  });
  assert.equal((await publish(publishedThenStaleDraft.fetchImpl)).releaseId, 71);
});

test("reconciles network and server failures after PATCH may have committed", async () => {
  const network = githubFixture({ patchFailureAfterCommit: "network" });
  assert.equal((await publish(network.fetchImpl)).releaseId, 71);

  const server = githubFixture({ patchFailureAfterCommit: "server" });
  assert.equal((await publish(server.fetchImpl)).releaseId, 71);
});

test("publishes preview releases with prerelease metadata and never marks them latest", async () => {
  const fixture = githubFixture();
  await publish(fixture.fetchImpl, { release: preview });
  assert.equal(fixture.releases[0].prerelease, true);
  const patch = fixture.requests.find((request) => request.method === "PATCH");
  assert.equal(JSON.parse(patch.body).make_latest, "false");
});

test("requires public immutability only after the repository contract expects it", async () => {
  const mutable = githubFixture({
    initialReleases: [releaseMetadata({ immutable: false, releaseAssets: exactAssets() })]
  });
  assert.equal((await publish(mutable.fetchImpl)).immutable, false);
  await assert.rejects(publish(mutable.fetchImpl, { expectImmutable: true }), /required immutable state/u);

  const alreadyImmutable = githubFixture({
    initialReleases: [releaseMetadata({ immutable: true, releaseAssets: exactAssets() })]
  });
  assert.equal((await publish(alreadyImmutable.fetchImpl, { expectImmutable: false })).immutable, true);

  const missingImmutable = releaseMetadata({ releaseAssets: exactAssets() });
  delete missingImmutable.immutable;
  const absentField = githubFixture({ initialReleases: [missingImmutable] });
  await assert.rejects(publish(absentField.fetchImpl), /required immutable state/u);

  const immutable = githubFixture({ immutableOnPublish: true });
  assert.equal((await publish(immutable.fetchImpl, { expectImmutable: true })).immutable, true);
});

test("fails closed on partial public releases without attempting repair", async () => {
  const fixture = githubFixture({
    initialReleases: [releaseMetadata({ releaseAssets: [exactAssets()[0]] })]
  });
  await assert.rejects(publish(fixture.fetchImpl), /public release is missing/u);
  assert.equal(
    fixture.requests.some((request) => request.method !== "GET"),
    false
  );
});

test("rejects duplicate, disagreeing, or conflicting release records", async () => {
  const duplicate = githubFixture({
    initialReleases: [releaseMetadata({ draft: true }), releaseMetadata({ draft: true, releaseId: 72 })]
  });
  await assert.rejects(publish(duplicate.fetchImpl), /multiple releases/u);

  const wrongDraft = githubFixture({
    initialReleases: [releaseMetadata({ draft: true, name: "Other release" })]
  });
  await assert.rejects(publish(wrongDraft.fetchImpl), /metadata conflicts/u);

  const immutableDraft = githubFixture({
    initialReleases: [releaseMetadata({ draft: true, immutable: true })]
  });
  await assert.rejects(publish(immutableDraft.fetchImpl), /must remain mutable/u);

  const missingBody = releaseMetadata({ draft: true });
  delete missingBody.body;
  await assert.rejects(publish(githubFixture({ initialReleases: [missingBody] }).fetchImpl), /metadata conflicts/u);

  const unexpected = githubFixture({
    initialReleases: [
      releaseMetadata({
        draft: true,
        releaseAssets: [{ ...releaseAsset("other.zip", Buffer.from("other"), 9), name: "other.zip" }]
      })
    ]
  });
  await assert.rejects(publish(unexpected.fetchImpl), /unexpected or malformed asset/u);

  const conflictBytes = Buffer.from("different");
  const conflicting = githubFixture({
    initialReleases: [releaseMetadata({ draft: true, releaseAssets: [releaseAsset(assets[0].name, conflictBytes, 8)] })]
  });
  await assert.rejects(publish(conflicting.fetchImpl), /conflicting byte size|conflicting digest/u);

  const claimedExact = exactAssets();
  const wrongDownload = githubFixture({
    assetByteOverrides: new Map([[claimedExact[0].id, Buffer.from("nope")]]),
    initialReleases: [releaseMetadata({ releaseAssets: claimedExact })]
  });
  await assert.rejects(publish(wrongDownload.fetchImpl), /does not match the accepted canonical bytes/u);

  const wrongContentType = exactAssets();
  wrongContentType[0].content_type = "text/plain";
  await assert.rejects(
    publish(
      githubFixture({
        initialReleases: [releaseMetadata({ draft: true, releaseAssets: wrongContentType })]
      }).fetchImpl
    ),
    /unexpected or malformed asset/u
  );

  const labeled = exactAssets();
  labeled[0].label = "replacement";
  await assert.rejects(
    publish(githubFixture({ initialReleases: [releaseMetadata({ draft: true, releaseAssets: labeled })] }).fetchImpl),
    /unexpected or malformed asset/u
  );
});

test("rejects tag absence, tag drift, and an initially conflicting tag", async () => {
  await assert.rejects(publish(githubFixture({ tagCommits: [undefined] }).fetchImpl), /tag must exist/u);
  await assert.rejects(publish(githubFixture({ tagCommits: ["b".repeat(40)] }).fetchImpl), /different commit/u);
  await assert.rejects(
    publish(githubFixture({ tagCommits: [expectedCommit, expectedCommit, "b".repeat(40)] }).fetchImpl),
    /changed after publication/u
  );
});

test("detects release or asset drift after the PATCH response", async () => {
  const metadataDrift = githubFixture({ afterPatch: (release) => (release.name = "Changed") });
  await assert.rejects(publish(metadataDrift.fetchImpl), /metadata conflicts/u);

  const assetDrift = githubFixture({
    afterPatch: (release) => {
      release.assets[0].size += 1;
    }
  });
  await assert.rejects(publish(assetDrift.fetchImpl), /conflicting byte size/u);
});

test("enumerates beyond the first release page before creating a draft", async () => {
  const prefix = Array.from({ length: 100 }, (_, index) => ({ tag_name: `v9.9.${index}` }));
  const fixture = githubFixture({
    initialReleases: [releaseMetadata({ draft: true })],
    inventoryPrefix: prefix
  });
  await publish(fixture.fetchImpl);
  assert.ok(fixture.requests.some((request) => request.url.endsWith("page=2")));
  assert.equal(fixture.requests.filter((request) => request.url === `${apiRoot}/releases`).length, 0);
});

test("rejects malformed release inventory and generic input ambiguity", async () => {
  await assert.rejects(publish(githubFixture({ malformedInventory: {} }).fetchImpl), /must be one JSON array/u);
  await assert.rejects(
    publishGitHubRelease({
      assets,
      channel: "preview",
      expectImmutable: false,
      expectedCommit,
      fetchImpl: githubFixture().fetchImpl,
      releaseNotes,
      releaseTag: stable.releaseTag,
      repository,
      token: "test-token",
      version: stable.version
    }),
    /version, and channel/u
  );
  await assert.rejects(
    publishGitHubRelease({
      assets,
      channel: "stable",
      expectImmutable: "false",
      expectedCommit,
      fetchImpl: githubFixture().fetchImpl,
      releaseNotes,
      releaseTag: stable.releaseTag,
      repository,
      token: "test-token",
      version: stable.version
    }),
    /explicit boolean/u
  );
  await assert.rejects(
    publishGitHubRelease({
      assets: assets.map((asset, index) => (index === 0 ? { ...asset, contentType: "text/plain" } : asset)),
      channel: "stable",
      expectImmutable: false,
      expectedCommit,
      fetchImpl: githubFixture().fetchImpl,
      releaseNotes,
      releaseTag: stable.releaseTag,
      repository,
      token: "test-token",
      version: stable.version
    }),
    /canonical three release assets/u
  );
  await assert.rejects(
    publishGitHubRelease({
      assets,
      beforeMutation: true,
      channel: "stable",
      expectImmutable: false,
      expectedCommit,
      fetchImpl: githubFixture().fetchImpl,
      releaseNotes,
      releaseTag: stable.releaseTag,
      repository,
      token: "test-token",
      version: stable.version
    }),
    /beforeMutation must be a function/u
  );
});

test("rejects missing, malformed, or mismatched release notes before mutation", async () => {
  for (const invalid of [undefined, "", "spaces only\n   ", "missing newline", "windows\r\n", "nul\0byte\n"]) {
    await assert.rejects(
      publishGitHubRelease({
        assets,
        channel: stable.channel,
        expectImmutable: false,
        expectedCommit,
        fetchImpl: async () => {
          throw new Error("invalid release notes must fail before network access");
        },
        releaseNotes: invalid,
        releaseTag: stable.releaseTag,
        repository,
        token: "test-token",
        version: stable.version
      }),
      /Release notes must be non-empty UTF-8 Markdown/u
    );
  }

  const fixture = githubFixture({
    initialReleases: [releaseMetadata({ body: "Different release notes.\n", releaseAssets: exactAssets() })]
  });
  await assert.rejects(publish(fixture.fetchImpl), /metadata conflicts/u);
  assert.equal(
    fixture.requests.some((request) => request.method !== "GET"),
    false
  );
});

test("uses the 128 MiB VSIX ceiling without widening bounded sidecars", async () => {
  const widerVsix = assets.map((asset, index) =>
    index === 0 ? { ...asset, bytes: Buffer.alloc(32 * 1024 * 1024 + 1) } : asset
  );
  let requests = 0;
  await assert.rejects(
    publishGitHubRelease({
      assets: widerVsix,
      channel: "stable",
      expectImmutable: false,
      expectedCommit,
      fetchImpl: async () => {
        requests += 1;
        return jsonResponse({ message: "Not Found" }, 404);
      },
      releaseTag: stable.releaseTag,
      releaseNotes,
      repository,
      token: "test-token",
      version: stable.version
    }),
    /tag must exist/u
  );
  assert.equal(requests, 1);

  for (const [index, bytes] of [
    [1, Buffer.alloc(4 * 1024 + 1)],
    [2, Buffer.alloc(513)]
  ]) {
    await assert.rejects(
      publishGitHubRelease({
        assets: assets.map((asset, assetIndex) => (assetIndex === index ? { ...asset, bytes } : asset)),
        channel: "stable",
        expectImmutable: false,
        expectedCommit,
        fetchImpl: async () => {
          throw new Error("oversized sidecars must fail before network access");
        },
        releaseTag: stable.releaseTag,
        releaseNotes,
        repository,
        token: "test-token",
        version: stable.version
      }),
      /canonical three release assets/u
    );
  }
});

test("retains the stable compatibility export", async () => {
  const fixture = githubFixture({
    initialReleases: [releaseMetadata({ releaseAssets: exactAssets() })]
  });
  const result = await publishGitHubStableRelease({
    assets,
    expectImmutable: false,
    expectedCommit,
    fetchImpl: fixture.fetchImpl,
    releaseNotes,
    releaseTag: stable.releaseTag,
    repository,
    token: "test-token",
    version: stable.version
  });
  assert.equal(result.releaseTag, stable.releaseTag);
});

test("parses the immutable-release rollout expectation without truthy coercion", () => {
  assert.equal(parseGitHubImmutableReleaseExpectation(undefined), false);
  assert.equal(parseGitHubImmutableReleaseExpectation("false"), false);
  assert.equal(parseGitHubImmutableReleaseExpectation("true"), true);
  assert.throws(() => parseGitHubImmutableReleaseExpectation("1"), /exactly true or false/u);
  assert.throws(() => parseGitHubImmutableReleaseExpectation("TRUE"), /exactly true or false/u);
});
