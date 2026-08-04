import { createHash, timingSafeEqual } from "node:crypto";
import { CANONICAL_RELEASE_ASSET_SPECS } from "./canonical-release-assets.mjs";
import { classifyNumericReleaseVersion } from "./release-metadata.mjs";
import { validateReleaseNotes } from "./release-notes.mjs";
import { parseStrictJson } from "./strict-json.mjs";

const EXPECTED_REPOSITORY = "Matt17BR/openwrangler";
const GITHUB_API_BASE = "https://api.github.com";
const GITHUB_UPLOAD_BASE = "https://uploads.github.com";
const GITHUB_API_VERSION = "2026-03-10";
const FULL_COMMIT = /^[0-9a-f]{40}$/u;
const RELEASE_JSON_MAX_BYTES = 4 * 1024 * 1024;
const GITHUB_REQUEST_TIMEOUT_MS = 30_000;
const RELEASES_PER_PAGE = 100;
const MAX_RELEASE_PAGES = 100;
const DISCOVERY_ATTEMPTS = 21;
const DISCOVERY_RETRY_MS = 250;
export const CANONICAL_GITHUB_RELEASE_ASSETS = Object.freeze(
  CANONICAL_RELEASE_ASSET_SPECS.map(({ contentType, name }) => Object.freeze({ contentType, name }))
);
const RELEASE_ASSET_MAXIMUM_BYTES = new Map(
  CANONICAL_RELEASE_ASSET_SPECS.map(({ maximumBytes, name }) => [name, maximumBytes])
);

export function parseGitHubImmutableReleaseExpectation(value) {
  if (value === undefined || value === "false") return false;
  if (value === "true") return true;
  throw new Error("GITHUB_IMMUTABLE_RELEASES_EXPECTED must be exactly true or false when provided.");
}

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

async function readJsonArray(response, label) {
  const bytes = await readBoundedResponse(response, RELEASE_JSON_MAX_BYTES, label);
  const value = parseStrictJson(bytes.toString("utf8"), { maxBytes: RELEASE_JSON_MAX_BYTES });
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be one JSON array.`);
  }
  return value;
}

function githubHeaders(token, accept = "application/vnd.github+json") {
  return {
    accept,
    authorization: `Bearer ${token}`,
    "user-agent": "openwrangler-release-publisher",
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

function validateInputs({
  assets,
  beforeMutation,
  channel,
  expectImmutable,
  expectedCommit,
  releaseNotes,
  releaseTag,
  repository,
  token,
  version
}) {
  if (repository !== EXPECTED_REPOSITORY) {
    throw new Error(`GitHub publication is restricted to ${EXPECTED_REPOSITORY}.`);
  }
  if (typeof token !== "string" || token.length < 1 || /[\0\r\n]/u.test(token)) {
    throw new Error("GITHUB_TOKEN must be a non-empty single-line token.");
  }
  if (!FULL_COMMIT.test(expectedCommit)) {
    throw new Error("EXPECTED_SHA must be one lowercase full Git commit ID.");
  }
  const classification = classifyNumericReleaseVersion(version);
  if (
    (channel !== "stable" && channel !== "preview") ||
    classification?.channel !== channel ||
    releaseTag !== `v${version}`
  ) {
    throw new Error("RELEASE_TAG, version, and channel must describe one permitted numeric extension release.");
  }
  if (typeof expectImmutable !== "boolean") {
    throw new Error("expectImmutable must be an explicit boolean.");
  }
  if (beforeMutation !== undefined && typeof beforeMutation !== "function") {
    throw new Error("beforeMutation must be a function when canonical file revalidation is required.");
  }
  validateReleaseNotes(releaseNotes);
  if (
    !Array.isArray(assets) ||
    assets.length !== CANONICAL_GITHUB_RELEASE_ASSETS.length ||
    CANONICAL_GITHUB_RELEASE_ASSETS.some(
      ({ name }, index) =>
        assets[index]?.name !== name ||
        assets[index]?.contentType !== CANONICAL_GITHUB_RELEASE_ASSETS[index].contentType ||
        !Buffer.isBuffer(assets[index]?.bytes) ||
        assets[index].bytes.length < 1 ||
        assets[index].bytes.length > RELEASE_ASSET_MAXIMUM_BYTES.get(name)
    )
  ) {
    throw new Error("GitHub publication requires the ordered canonical three release assets.");
  }
  return {
    apiRoot: `${GITHUB_API_BASE}/repos/${repository}`,
    expectedBody: releaseNotes,
    expectedName: `Open Wrangler ${releaseTag}`,
    prerelease: channel === "preview",
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

async function fetchPublishedRelease({ apiRoot, fetchImpl, headers, releaseTag }) {
  return requestJson(
    fetchImpl,
    `${apiRoot}/releases/tags/${encodeURIComponent(releaseTag)}`,
    { headers },
    "GitHub published release",
    [200, 404]
  );
}

async function listMatchingReleases({ apiRoot, fetchImpl, headers, releaseTag }) {
  const matching = [];
  for (let page = 1; page <= MAX_RELEASE_PAGES; page += 1) {
    const response = await fetchImpl(`${apiRoot}/releases?per_page=${RELEASES_PER_PAGE}&page=${page}`, {
      headers,
      signal: AbortSignal.timeout(GITHUB_REQUEST_TIMEOUT_MS)
    });
    if (response.status !== 200) {
      await readBoundedResponse(response, RELEASE_JSON_MAX_BYTES, "GitHub release inventory error");
      throw new Error(`GitHub release inventory failed with HTTP ${response.status}.`);
    }
    const releases = await readJsonArray(response, "GitHub release inventory");
    if (releases.length > RELEASES_PER_PAGE) {
      throw new Error("GitHub release inventory exceeded its requested page size.");
    }
    for (const release of releases) {
      requirePlainObject(release, "GitHub release inventory entry");
      if (release.tag_name === releaseTag) matching.push(release);
    }
    if (releases.length < RELEASES_PER_PAGE) return matching;
  }
  throw new Error("GitHub release inventory exceeds the bounded pagination window.");
}

function validateReleaseMetadata(
  release,
  { apiRoot, expectImmutable, expectedBody, expectedCommit, expectedName, phase, prerelease, releaseTag, uploadRoot }
) {
  requirePlainObject(release, "GitHub release");
  const expectedDraft = phase === "draft";
  if (phase !== "draft" && phase !== "public") {
    throw new Error("GitHub release validation requires a draft or public phase.");
  }
  if (
    !Number.isSafeInteger(release.id) ||
    release.id <= 0 ||
    release.tag_name !== releaseTag ||
    release.target_commitish !== expectedCommit ||
    release.name !== expectedName ||
    release.body !== expectedBody ||
    release.draft !== expectedDraft ||
    release.prerelease !== prerelease
  ) {
    throw new Error(`GitHub ${phase} release metadata conflicts with the accepted release.`);
  }
  if (
    (expectedDraft && release.immutable !== false) ||
    (!expectedDraft && typeof release.immutable !== "boolean") ||
    (!expectedDraft && expectImmutable && release.immutable !== true)
  ) {
    throw new Error(
      expectedDraft
        ? "GitHub draft release must remain mutable until publication."
        : "GitHub public release does not report the required immutable state."
    );
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
    throw new Error("GitHub release assets must be an array.");
  }
  const expectedAssets = new Map(CANONICAL_GITHUB_RELEASE_ASSETS.map((asset) => [asset.name, asset]));
  const discovered = new Map();
  for (const asset of release.assets) {
    requirePlainObject(asset, "GitHub release asset");
    const expected = typeof asset.name === "string" ? expectedAssets.get(asset.name) : undefined;
    if (
      expected === undefined ||
      discovered.has(asset.name) ||
      !Number.isSafeInteger(asset.id) ||
      asset.id <= 0 ||
      asset.state !== "uploaded" ||
      asset.content_type !== expected.contentType ||
      asset.label !== "" ||
      asset.url !== `${apiRoot}/releases/assets/${asset.id}`
    ) {
      throw new Error(`GitHub ${phase} release contains an unexpected or malformed asset.`);
    }
    discovered.set(asset.name, asset);
  }
  return discovered;
}

async function discoverRelease({ apiRoot, fetchImpl, headers, releaseTag, retryAbsent = false }) {
  for (let attempt = 1; attempt <= DISCOVERY_ATTEMPTS; attempt += 1) {
    const published = await fetchPublishedRelease({ apiRoot, fetchImpl, headers, releaseTag });
    const matching = await listMatchingReleases({ apiRoot, fetchImpl, headers, releaseTag });
    if (matching.length > 1) {
      throw new Error("GitHub contains multiple releases for the accepted tag.");
    }
    const sole = matching[0];
    if (published === undefined) {
      if (sole === undefined) {
        if (!retryAbsent || attempt === DISCOVERY_ATTEMPTS) {
          return Object.freeze({ phase: "absent", release: undefined });
        }
      } else if (sole.draft === true) {
        return Object.freeze({ phase: "draft", release: sole });
      } else if (sole.draft !== false) {
        throw new Error("GitHub release inventory contains an invalid publication state.");
      }
    } else if (sole !== undefined && sole.id !== published.id) {
      throw new Error("GitHub published release and complete release inventory identify different releases.");
    } else if (sole?.draft === false) {
      return Object.freeze({ phase: "public", release: published });
    } else if (sole !== undefined && sole.draft !== true) {
      throw new Error("GitHub release inventory contains an invalid publication state.");
    }
    if (attempt < DISCOVERY_ATTEMPTS) {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, DISCOVERY_RETRY_MS));
    }
  }
  throw new Error("GitHub published release and complete release inventory did not converge.");
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
    Math.min(RELEASE_ASSET_MAXIMUM_BYTES.get(expected.name), expected.bytes.length),
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
        throw new Error(`GitHub public release is missing ${expected.name}.`);
      }
      continue;
    }
    await verifyExistingAsset({ asset: existing, expected, fetchImpl, headers });
  }
}

async function createDraftRelease({
  apiRoot,
  beforeMutation,
  expectedBody,
  expectedCommit,
  expectedName,
  fetchImpl,
  headers,
  prerelease,
  releaseTag
}) {
  await beforeMutation?.();
  const response = await fetchImpl(`${apiRoot}/releases`, {
    body: JSON.stringify({
      body: expectedBody,
      draft: true,
      generate_release_notes: false,
      make_latest: "false",
      name: expectedName,
      prerelease,
      tag_name: releaseTag,
      target_commitish: expectedCommit
    }),
    headers: { ...headers, "content-type": "application/json" },
    method: "POST",
    signal: AbortSignal.timeout(GITHUB_REQUEST_TIMEOUT_MS)
  });
  if (response.status === 422) {
    await readBoundedResponse(response, RELEASE_JSON_MAX_BYTES, "GitHub draft release creation conflict");
    return undefined;
  }
  if (response.status !== 201) {
    await readBoundedResponse(response, RELEASE_JSON_MAX_BYTES, "GitHub draft release creation error");
    throw new Error(`GitHub draft release creation failed with HTTP ${response.status}.`);
  }
  return readJson(response, "Created GitHub draft release");
}

async function uploadAsset({ beforeMutation, expected, fetchImpl, headers, release }) {
  await beforeMutation?.();
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

async function publishDraftRelease({
  apiRoot,
  beforeMutation,
  expectedBody,
  expectedCommit,
  expectedName,
  fetchImpl,
  headers,
  prerelease,
  release
}) {
  await beforeMutation?.();
  const response = await fetchImpl(`${apiRoot}/releases/${release.id}`, {
    body: JSON.stringify({
      body: expectedBody,
      draft: false,
      make_latest: prerelease ? "false" : "true",
      name: expectedName,
      prerelease,
      tag_name: release.tag_name,
      target_commitish: expectedCommit
    }),
    headers: { ...headers, "content-type": "application/json" },
    method: "PATCH",
    signal: AbortSignal.timeout(GITHUB_REQUEST_TIMEOUT_MS)
  });
  if (response.status !== 200) {
    await readBoundedResponse(response, RELEASE_JSON_MAX_BYTES, "GitHub draft publication error");
    throw new Error(`GitHub draft publication failed with HTTP ${response.status}.`);
  }
  return readJson(response, "Published GitHub release");
}

export async function publishGitHubRelease({
  assets,
  beforeMutation,
  channel,
  expectImmutable,
  expectedCommit,
  fetchImpl = fetch,
  releaseNotes,
  releaseTag,
  repository,
  token,
  version
}) {
  const { apiRoot, expectedBody, expectedName, prerelease, uploadRoot } = validateInputs({
    assets,
    beforeMutation,
    channel,
    expectImmutable,
    expectedCommit,
    releaseNotes,
    releaseTag,
    repository,
    token,
    version
  });
  const headers = githubHeaders(token);
  const tagCommit = await resolveTagCommit({ apiRoot, fetchImpl, headers, releaseTag });
  if (tagCommit === undefined) {
    throw new Error("The accepted GitHub release tag must exist before release publication.");
  }
  if (tagCommit !== expectedCommit) {
    throw new Error("Existing GitHub release tag points at a different commit.");
  }

  const validation = {
    apiRoot,
    expectImmutable,
    expectedBody,
    expectedCommit,
    expectedName,
    prerelease,
    releaseTag,
    uploadRoot
  };
  let state = await discoverRelease({ apiRoot, fetchImpl, headers, releaseTag });
  if (state.phase === "public") {
    const discovered = validateReleaseMetadata(state.release, { ...validation, phase: "public" });
    await verifyReleaseAssets({ assets, discovered, fetchImpl, headers, requireComplete: true });
    if ((await resolveTagCommit({ apiRoot, fetchImpl, headers, releaseTag })) !== expectedCommit) {
      throw new Error("The accepted GitHub release tag changed during public release verification.");
    }
    return Object.freeze({ immutable: state.release.immutable, releaseId: state.release.id, releaseTag, version });
  }

  if (state.phase === "absent") {
    const created = await createDraftRelease({
      apiRoot,
      beforeMutation,
      expectedBody,
      expectedCommit,
      expectedName,
      fetchImpl,
      headers,
      prerelease,
      releaseTag
    });
    state = await discoverRelease({ apiRoot, fetchImpl, headers, releaseTag, retryAbsent: true });
    if (state.phase === "absent") {
      throw new Error("GitHub draft creation conflicted without an exact release to resume.");
    }
    if (created !== undefined && state.release.id !== created.id) {
      throw new Error("GitHub draft creation returned a different release from the complete inventory.");
    }
  }

  if (state.phase === "public") {
    const discovered = validateReleaseMetadata(state.release, { ...validation, phase: "public" });
    await verifyReleaseAssets({ assets, discovered, fetchImpl, headers, requireComplete: true });
    if ((await resolveTagCommit({ apiRoot, fetchImpl, headers, releaseTag })) !== expectedCommit) {
      throw new Error("The accepted GitHub release tag changed after draft creation conflict recovery.");
    }
    return Object.freeze({ immutable: state.release.immutable, releaseId: state.release.id, releaseTag, version });
  }

  const draftId = state.release.id;
  let release = state.release;
  let discovered = validateReleaseMetadata(release, { ...validation, phase: "draft" });
  await verifyReleaseAssets({ assets, discovered, fetchImpl, headers, requireComplete: false });
  for (const expected of assets) {
    if (discovered.has(expected.name)) continue;
    await uploadAsset({ beforeMutation, expected, fetchImpl, headers, release });
    state = await discoverRelease({ apiRoot, fetchImpl, headers, releaseTag, retryAbsent: true });
    if (state.phase === "absent") {
      throw new Error("GitHub draft release disappeared during asset publication.");
    }
    if (state.release.id !== draftId) {
      throw new Error("GitHub release identity changed during asset publication.");
    }
    if (state.phase === "public") {
      discovered = validateReleaseMetadata(state.release, { ...validation, phase: "public" });
      await verifyReleaseAssets({ assets, discovered, fetchImpl, headers, requireComplete: true });
      if ((await resolveTagCommit({ apiRoot, fetchImpl, headers, releaseTag })) !== expectedCommit) {
        throw new Error("The accepted GitHub release tag changed during concurrent publication.");
      }
      return Object.freeze({ immutable: state.release.immutable, releaseId: draftId, releaseTag, version });
    }
    release = state.release;
    discovered = validateReleaseMetadata(release, { ...validation, phase: "draft" });
    await verifyReleaseAssets({ assets, discovered, fetchImpl, headers, requireComplete: false });
  }

  state = await discoverRelease({ apiRoot, fetchImpl, headers, releaseTag });
  if (state.phase === "public") {
    if (state.release.id !== draftId) {
      throw new Error("GitHub release identity changed before draft publication.");
    }
    discovered = validateReleaseMetadata(state.release, { ...validation, phase: "public" });
    await verifyReleaseAssets({ assets, discovered, fetchImpl, headers, requireComplete: true });
    if ((await resolveTagCommit({ apiRoot, fetchImpl, headers, releaseTag })) !== expectedCommit) {
      throw new Error("The accepted GitHub release tag changed during concurrent publication.");
    }
    return Object.freeze({ immutable: state.release.immutable, releaseId: draftId, releaseTag, version });
  }
  if (state.phase !== "draft" || state.release.id !== draftId) {
    throw new Error("GitHub draft release changed before publication.");
  }
  release = state.release;
  discovered = validateReleaseMetadata(release, { ...validation, phase: "draft" });
  await verifyReleaseAssets({ assets, discovered, fetchImpl, headers, requireComplete: true });

  if ((await resolveTagCommit({ apiRoot, fetchImpl, headers, releaseTag })) !== expectedCommit) {
    throw new Error("The accepted GitHub release tag changed before draft publication.");
  }
  let patched;
  let publicationError;
  try {
    patched = await publishDraftRelease({
      apiRoot,
      beforeMutation,
      expectedBody,
      expectedCommit,
      expectedName,
      fetchImpl,
      headers,
      prerelease,
      release
    });
  } catch (error) {
    publicationError = error;
  }
  if (patched !== undefined) {
    discovered = validateReleaseMetadata(patched, { ...validation, phase: "public" });
    await verifyReleaseAssets({ assets, discovered, fetchImpl, headers, requireComplete: true });
  }

  state = await discoverRelease({ apiRoot, fetchImpl, headers, releaseTag, retryAbsent: true });
  if (state.phase !== "public" || state.release.id !== draftId) {
    if (publicationError !== undefined) throw publicationError;
    throw new Error("GitHub draft publication did not produce the exact public release.");
  }
  discovered = validateReleaseMetadata(state.release, { ...validation, phase: "public" });
  await verifyReleaseAssets({ assets, discovered, fetchImpl, headers, requireComplete: true });
  if ((await resolveTagCommit({ apiRoot, fetchImpl, headers, releaseTag })) !== expectedCommit) {
    throw new Error("The accepted GitHub release tag changed after publication.");
  }
  return Object.freeze({ immutable: state.release.immutable, releaseId: draftId, releaseTag, version });
}
