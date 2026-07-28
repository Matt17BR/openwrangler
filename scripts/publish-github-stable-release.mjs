import { execFileSync } from "node:child_process";
import { createHash, timingSafeEqual } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseStrictJson } from "./strict-json.mjs";
import { verifyCanonicalReleaseArtifact } from "./verify-canonical-release-artifact.mjs";

const EXPECTED_REPOSITORY = "Matt17BR/openwrangler";
const GITHUB_API_BASE = "https://api.github.com";
const GITHUB_UPLOAD_BASE = "https://uploads.github.com";
const GITHUB_API_VERSION = "2026-03-10";
const FULL_COMMIT = /^[0-9a-f]{40}$/u;
const STABLE_TAG = /^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u;
const RELEASE_JSON_MAX_BYTES = 4 * 1024 * 1024;
const ASSET_MAX_BYTES = 32 * 1024 * 1024;
const GITHUB_REQUEST_TIMEOUT_MS = 30_000;
const CANONICAL_ASSETS = Object.freeze([
  Object.freeze({ contentType: "application/octet-stream", name: "openwrangler.vsix" }),
  Object.freeze({ contentType: "application/json", name: "openwrangler.vsix.provenance.json" }),
  Object.freeze({ contentType: "text/plain; charset=utf-8", name: "openwrangler.vsix.sha256" })
]);

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function requirePlainObject(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be one JSON object.`);
  }
  return value;
}

async function readBoundedResponse(response, maxBytes, label) {
  const declaredLength = response.headers.get("content-length");
  if (declaredLength !== null && (!/^(?:0|[1-9]\d*)$/u.test(declaredLength) || Number(declaredLength) > maxBytes)) {
    throw new Error(`${label} exceeds its response-size bound.`);
  }
  if (response.body === null) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      total += result.value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new Error(`${label} exceeds its response-size bound.`);
      }
      chunks.push(Buffer.from(result.value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total);
}

async function readJson(response, label) {
  const bytes = await readBoundedResponse(response, RELEASE_JSON_MAX_BYTES, label);
  return requirePlainObject(parseStrictJson(bytes.toString("utf8"), { maxBytes: RELEASE_JSON_MAX_BYTES }), label);
}

function githubHeaders(token, accept = "application/vnd.github+json") {
  return {
    accept,
    authorization: `Bearer ${token}`,
    "user-agent": "openwrangler-stable-release",
    "x-github-api-version": GITHUB_API_VERSION
  };
}

async function requestJson(fetchImpl, url, options, label, allowedStatuses) {
  const response = await fetchImpl(url, { ...options, signal: AbortSignal.timeout(GITHUB_REQUEST_TIMEOUT_MS) });
  if (!allowedStatuses.includes(response.status)) {
    await readBoundedResponse(response, RELEASE_JSON_MAX_BYTES, `${label} error`);
    throw new Error(`${label} failed with HTTP ${response.status}.`);
  }
  if (response.status === 404) {
    await readBoundedResponse(response, RELEASE_JSON_MAX_BYTES, label);
    return undefined;
  }
  return readJson(response, label);
}

function validateInputs({ assets, expectedCommit, releaseTag, repository, token, version }) {
  if (repository !== EXPECTED_REPOSITORY) {
    throw new Error(`GitHub publication is restricted to ${EXPECTED_REPOSITORY}.`);
  }
  if (typeof token !== "string" || token.length < 1 || /[\0\r\n]/u.test(token)) {
    throw new Error("GITHUB_TOKEN must be a non-empty single-line token.");
  }
  if (!FULL_COMMIT.test(expectedCommit)) {
    throw new Error("EXPECTED_SHA must be one lowercase full Git commit ID.");
  }
  if (!STABLE_TAG.test(releaseTag) || releaseTag !== `v${version}`) {
    throw new Error("RELEASE_TAG must exactly match one stable extension version.");
  }
  if (
    !Array.isArray(assets) ||
    assets.length !== CANONICAL_ASSETS.length ||
    CANONICAL_ASSETS.some(
      ({ name }, index) =>
        assets[index]?.name !== name ||
        !Buffer.isBuffer(assets[index]?.bytes) ||
        assets[index].bytes.length < 1 ||
        assets[index].bytes.length > ASSET_MAX_BYTES
    )
  ) {
    throw new Error("GitHub publication requires the ordered canonical three release assets.");
  }
  return {
    apiRoot: `${GITHUB_API_BASE}/repos/${repository}`,
    expectedName: `Open Wrangler ${releaseTag}`,
    uploadRoot: `${GITHUB_UPLOAD_BASE}/repos/${repository}`
  };
}

async function resolveTagCommit({ apiRoot, fetchImpl, headers, releaseTag }) {
  const encodedTag = encodeURIComponent(releaseTag);
  const reference = await requestJson(
    fetchImpl,
    `${apiRoot}/git/ref/tags/${encodedTag}`,
    { headers },
    "GitHub release tag",
    [200, 404]
  );
  if (reference === undefined) return undefined;
  if (reference.ref !== `refs/tags/${releaseTag}`) {
    throw new Error("GitHub returned a different release tag reference.");
  }
  let object = requirePlainObject(reference.object, "GitHub release tag object");
  const visited = new Set();
  for (let depth = 0; depth < 8; depth += 1) {
    if (typeof object.sha !== "string" || !FULL_COMMIT.test(object.sha) || visited.has(object.sha)) {
      throw new Error("GitHub returned an invalid or cyclic release tag object.");
    }
    visited.add(object.sha);
    if (object.type === "commit") return object.sha;
    if (object.type !== "tag") {
      throw new Error("GitHub release tag must resolve to a commit.");
    }
    const annotated = await requestJson(
      fetchImpl,
      `${apiRoot}/git/tags/${object.sha}`,
      { headers },
      "GitHub annotated release tag",
      [200]
    );
    object = requirePlainObject(annotated.object, "GitHub annotated release tag object");
  }
  throw new Error("GitHub release tag exceeds the supported annotation depth.");
}

async function fetchRelease({ apiRoot, fetchImpl, headers, releaseTag }) {
  return requestJson(
    fetchImpl,
    `${apiRoot}/releases/tags/${encodeURIComponent(releaseTag)}`,
    { headers },
    "GitHub stable release",
    [200, 404]
  );
}

function validateReleaseMetadata(release, { apiRoot, expectedCommit, expectedName, releaseTag, uploadRoot }) {
  requirePlainObject(release, "GitHub stable release");
  if (
    !Number.isSafeInteger(release.id) ||
    release.id <= 0 ||
    release.tag_name !== releaseTag ||
    release.target_commitish !== expectedCommit ||
    release.name !== expectedName ||
    release.draft !== false ||
    release.prerelease !== false
  ) {
    throw new Error("Existing GitHub release metadata conflicts with the accepted stable release.");
  }
  const expectedUploadPrefix = `${uploadRoot}/releases/${release.id}/assets`;
  if (
    typeof release.upload_url !== "string" ||
    !release.upload_url.startsWith(expectedUploadPrefix) ||
    release.upload_url.slice(expectedUploadPrefix.length) !== "{?name,label}"
  ) {
    throw new Error("GitHub returned an unexpected release upload endpoint.");
  }
  if (!Array.isArray(release.assets)) {
    throw new Error("GitHub stable release assets must be an array.");
  }
  const expectedNames = new Set(CANONICAL_ASSETS.map(({ name }) => name));
  const discovered = new Map();
  for (const asset of release.assets) {
    requirePlainObject(asset, "GitHub release asset");
    if (
      typeof asset.name !== "string" ||
      !expectedNames.has(asset.name) ||
      discovered.has(asset.name) ||
      !Number.isSafeInteger(asset.id) ||
      asset.id <= 0 ||
      asset.state !== "uploaded" ||
      asset.url !== `${apiRoot}/releases/assets/${asset.id}`
    ) {
      throw new Error("GitHub stable release contains an unexpected or malformed asset.");
    }
    discovered.set(asset.name, asset);
  }
  return discovered;
}

async function verifyExistingAsset({ asset, expected, fetchImpl, headers }) {
  if (asset.size !== expected.bytes.length) {
    throw new Error(`GitHub asset ${expected.name} has a conflicting byte size.`);
  }
  const expectedDigest = sha256(expected.bytes);
  if (asset.digest !== undefined && asset.digest !== `sha256:${expectedDigest}`) {
    throw new Error(`GitHub asset ${expected.name} has a conflicting digest.`);
  }
  const response = await fetchImpl(asset.url, {
    headers: { ...headers, accept: "application/octet-stream" },
    redirect: "follow",
    signal: AbortSignal.timeout(GITHUB_REQUEST_TIMEOUT_MS)
  });
  if (response.status !== 200) {
    await readBoundedResponse(response, RELEASE_JSON_MAX_BYTES, `GitHub asset ${expected.name} error`);
    throw new Error(`GitHub asset ${expected.name} could not be downloaded.`);
  }
  const publicBytes = await readBoundedResponse(
    response,
    Math.min(ASSET_MAX_BYTES, expected.bytes.length),
    expected.name
  );
  if (
    publicBytes.length !== expected.bytes.length ||
    !timingSafeEqual(
      createHash("sha256").update(publicBytes).digest(),
      createHash("sha256").update(expected.bytes).digest()
    )
  ) {
    throw new Error(`GitHub asset ${expected.name} does not match the accepted canonical bytes.`);
  }
}

async function verifyReleaseAssets({ assets, discovered, fetchImpl, headers, requireComplete }) {
  for (const expected of assets) {
    const existing = discovered.get(expected.name);
    if (existing === undefined) {
      if (requireComplete) {
        throw new Error(`GitHub stable release is missing ${expected.name}.`);
      }
      continue;
    }
    await verifyExistingAsset({ asset: existing, expected, fetchImpl, headers });
  }
}

async function createRelease({ apiRoot, expectedCommit, expectedName, fetchImpl, headers, releaseTag }) {
  const response = await fetchImpl(`${apiRoot}/releases`, {
    body: JSON.stringify({
      draft: false,
      generate_release_notes: true,
      make_latest: "true",
      name: expectedName,
      prerelease: false,
      tag_name: releaseTag,
      target_commitish: expectedCommit
    }),
    headers: { ...headers, "content-type": "application/json" },
    method: "POST",
    signal: AbortSignal.timeout(GITHUB_REQUEST_TIMEOUT_MS)
  });
  if (response.status === 422) {
    await readBoundedResponse(response, RELEASE_JSON_MAX_BYTES, "GitHub release creation conflict");
    return undefined;
  }
  if (response.status !== 201) {
    await readBoundedResponse(response, RELEASE_JSON_MAX_BYTES, "GitHub release creation error");
    throw new Error(`GitHub stable release creation failed with HTTP ${response.status}.`);
  }
  return readJson(response, "Created GitHub stable release");
}

async function uploadAsset({ expected, fetchImpl, headers, release }) {
  const uploadUrl = release.upload_url.slice(0, -"{?name,label}".length);
  const url = new URL(uploadUrl);
  url.searchParams.set("name", expected.name);
  const response = await fetchImpl(url, {
    body: expected.bytes,
    headers: { ...headers, "content-type": expected.contentType },
    method: "POST",
    signal: AbortSignal.timeout(GITHUB_REQUEST_TIMEOUT_MS)
  });
  if (response.status === 422) {
    await readBoundedResponse(response, RELEASE_JSON_MAX_BYTES, `GitHub asset ${expected.name} conflict`);
    return false;
  }
  if (response.status !== 201) {
    await readBoundedResponse(response, RELEASE_JSON_MAX_BYTES, `GitHub asset ${expected.name} upload error`);
    throw new Error(`GitHub asset ${expected.name} upload failed with HTTP ${response.status}.`);
  }
  await readJson(response, `Uploaded GitHub asset ${expected.name}`);
  return true;
}

export async function publishGitHubStableRelease({
  assets,
  expectedCommit,
  fetchImpl = fetch,
  releaseTag,
  repository,
  token,
  version
}) {
  const { apiRoot, expectedName, uploadRoot } = validateInputs({
    assets,
    expectedCommit,
    releaseTag,
    repository,
    token,
    version
  });
  const headers = githubHeaders(token);
  const tagCommit = await resolveTagCommit({ apiRoot, fetchImpl, headers, releaseTag });
  if (tagCommit !== undefined && tagCommit !== expectedCommit) {
    throw new Error("Existing GitHub release tag points at a different commit.");
  }

  let release = await fetchRelease({ apiRoot, fetchImpl, headers, releaseTag });
  if (release === undefined) {
    release = await createRelease({
      apiRoot,
      expectedCommit,
      expectedName,
      fetchImpl,
      headers,
      releaseTag
    });
    if (release === undefined) {
      release = await fetchRelease({ apiRoot, fetchImpl, headers, releaseTag });
    }
    if (release === undefined) {
      throw new Error("GitHub release creation conflicted without an exact release to resume.");
    }
  }

  let discovered = validateReleaseMetadata(release, {
    apiRoot,
    expectedCommit,
    expectedName,
    releaseTag,
    uploadRoot
  });
  await verifyReleaseAssets({ assets, discovered, fetchImpl, headers, requireComplete: false });
  for (const expected of assets) {
    if (discovered.has(expected.name)) continue;
    await uploadAsset({ expected, fetchImpl, headers, release });
    release = await fetchRelease({ apiRoot, fetchImpl, headers, releaseTag });
    if (release === undefined) {
      throw new Error("GitHub stable release disappeared during asset publication.");
    }
    discovered = validateReleaseMetadata(release, {
      apiRoot,
      expectedCommit,
      expectedName,
      releaseTag,
      uploadRoot
    });
    await verifyReleaseAssets({ assets, discovered, fetchImpl, headers, requireComplete: false });
  }

  release = await fetchRelease({ apiRoot, fetchImpl, headers, releaseTag });
  discovered = validateReleaseMetadata(release, {
    apiRoot,
    expectedCommit,
    expectedName,
    releaseTag,
    uploadRoot
  });
  await verifyReleaseAssets({ assets, discovered, fetchImpl, headers, requireComplete: true });
  if ((await resolveTagCommit({ apiRoot, fetchImpl, headers, releaseTag })) !== expectedCommit) {
    throw new Error("The accepted GitHub release is not public at the expected commit.");
  }
  return Object.freeze({ releaseId: release.id, releaseTag, version });
}

function exactHead(root) {
  const commit = execFileSync("git", ["rev-parse", "--verify", "HEAD^{commit}"], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 4096,
    timeout: 10_000,
    windowsHide: true
  }).trim();
  if (!FULL_COMMIT.test(commit)) {
    throw new Error("The checked-out release source did not resolve to one full Git commit.");
  }
  return commit;
}

async function runCli() {
  if (process.argv.length !== 3) {
    throw new Error("Pass exactly one downloaded canonical artifact directory.");
  }
  const root = realpathSync.native(resolve(import.meta.dirname, ".."));
  const directory = resolve(process.argv[2]);
  const receipt = await verifyCanonicalReleaseArtifact({
    directory,
    expectedCommit: process.env.EXPECTED_SHA,
    releaseTag: process.env.RELEASE_TAG,
    sourceCommit: exactHead(root),
    sourcePackageJson: readFileSync(join(root, "package.json"), "utf8")
  });
  const assets = CANONICAL_ASSETS.map(({ contentType, name }) =>
    Object.freeze({ bytes: readFileSync(join(directory, name)), contentType, name })
  );
  if (sha256(assets[0].bytes) !== receipt.candidateSha256 || basename(receipt.candidatePath) !== assets[0].name) {
    throw new Error("The canonical VSIX changed before GitHub publication.");
  }
  const result = await publishGitHubStableRelease({
    assets,
    expectedCommit: receipt.sourceCommit,
    releaseTag: receipt.releaseTag,
    repository: process.env.GITHUB_REPOSITORY,
    token: process.env.GITHUB_TOKEN,
    version: receipt.version
  });
  console.log(`GitHub release ${result.releaseTag} is exact and public.`);
}

if (process.argv[1] !== undefined && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  await runCli();
}
