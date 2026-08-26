import {
  closeSync,
  constants,
  fchmodSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  realpathSync,
  writeSync
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { parseStrictJson } from "./strict-json.mjs";
import { MAX_VSIX_BYTES } from "./vsix-archive.mjs";

export const GITHUB_RELEASE_REPOSITORY = "Matt17BR/openwrangler";
export const CANONICAL_RELEASE_FILES = Object.freeze([
  "openwrangler.vsix",
  "openwrangler.vsix.provenance.json",
  "openwrangler.vsix.sha256"
]);
export const PREVIEW_RELEASE_FILES = Object.freeze([...CANONICAL_RELEASE_FILES]);
const STABLE_TAG = /^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u;
const RELEASE_JSON_MAX_BYTES = 1024 * 1024;
const MAX_RELEASE_POLL_ATTEMPTS = 60;
const FILE_LIMITS = new Map([
  ["openwrangler.vsix", MAX_VSIX_BYTES],
  ["openwrangler.vsix.provenance.json", 4096],
  ["openwrangler.vsix.sha256", 512]
]);

export class GithubReleasePendingError extends Error {}

function fetchResponse(fetchImpl, url, init) {
  const responsePromise = fetchImpl(url, init);
  return Promise.resolve(responsePromise).catch(() => {
    throw new GithubReleasePendingError("GitHub release transport failed before a response was received.");
  });
}

function assertStableTag(releaseTag) {
  if (typeof releaseTag !== "string" || !STABLE_TAG.test(releaseTag)) {
    throw new Error("RELEASE_TAG must be one canonical numeric vmajor.minor.patch tag.");
  }
}

async function readResponseBytes(response, maximumBytes, label) {
  const declared = response.headers.get("content-length");
  if (declared !== null && (!/^(?:0|[1-9]\d*)$/u.test(declared) || BigInt(declared) > BigInt(maximumBytes))) {
    throw new Error(`${label} exceeds its declared byte limit.`);
  }
  if (response.body === null) {
    throw new Error(`${label} did not provide a response body.`);
  }
  const reader = response.body.getReader();
  const chunks = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      length += value.byteLength;
      if (length > maximumBytes) {
        throw new Error(`${label} exceeds its byte limit.`);
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, length);
}

function validateReleaseAssetUrl(url, releaseTag, fileName) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`GitHub release asset ${fileName} has an invalid download URL.`);
  }
  const expectedPath = `/${GITHUB_RELEASE_REPOSITORY}/releases/download/${releaseTag}/${fileName}`;
  if (
    parsed.protocol !== "https:" ||
    parsed.hostname !== "github.com" ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.port !== "" ||
    parsed.search !== "" ||
    parsed.hash !== "" ||
    parsed.pathname !== expectedPath
  ) {
    throw new Error(`GitHub release asset ${fileName} does not use its canonical public download URL.`);
  }
  return parsed.href;
}

function releaseFiles(prerelease) {
  if (prerelease === false) {
    return CANONICAL_RELEASE_FILES;
  }
  if (prerelease === true) {
    return PREVIEW_RELEASE_FILES;
  }
  throw new TypeError("GitHub release download requires an explicit pre-release boolean.");
}

function parseReleaseMetadata(bytes, prerelease, releaseTag) {
  const release = parseStrictJson(new TextDecoder("utf-8", { fatal: true }).decode(bytes), {
    maxBytes: RELEASE_JSON_MAX_BYTES
  });
  const expectedFiles = releaseFiles(prerelease);
  if (
    typeof release !== "object" ||
    release === null ||
    Array.isArray(release) ||
    release.tag_name !== releaseTag ||
    release.prerelease !== prerelease ||
    typeof release.draft !== "boolean" ||
    release.html_url !== `https://github.com/${GITHUB_RELEASE_REPOSITORY}/releases/tag/${releaseTag}` ||
    !Array.isArray(release.assets)
  ) {
    throw new Error("The GitHub release is not one public release in the requested channel for the selected tag.");
  }
  if (release.draft) {
    throw new GithubReleasePendingError(`GitHub release ${releaseTag} is still a draft.`);
  }
  const assets = new Map();
  for (const asset of release.assets) {
    if (
      typeof asset !== "object" ||
      asset === null ||
      Array.isArray(asset) ||
      typeof asset.name !== "string" ||
      !Number.isSafeInteger(asset.size) ||
      asset.size < 0 ||
      typeof asset.browser_download_url !== "string"
    ) {
      throw new Error("The GitHub release contains malformed asset metadata.");
    }
    if (!expectedFiles.includes(asset.name)) {
      throw new Error(`The GitHub release contains unexpected asset ${asset.name}.`);
    }
    if (assets.has(asset.name)) {
      throw new Error(`The GitHub release contains duplicate asset ${asset.name}.`);
    }
    if (asset.state !== "uploaded" || asset.size === 0) {
      throw new GithubReleasePendingError(`GitHub release asset ${asset.name} is not uploaded yet.`);
    }
    assets.set(asset.name, asset);
  }
  if (expectedFiles.some((name) => !assets.has(name))) {
    throw new GithubReleasePendingError("The GitHub release does not expose its complete canonical asset set yet.");
  }
  return assets;
}

async function fetchReleaseAssets({ fetchImpl, prerelease, releaseTag, signal }) {
  const releaseUrl = `https://api.github.com/repos/${GITHUB_RELEASE_REPOSITORY}/releases/tags/${encodeURIComponent(
    releaseTag
  )}`;
  const response = await fetchResponse(fetchImpl, releaseUrl, {
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": "OpenWrangler-marketplace-promotion/1",
      "X-GitHub-Api-Version": "2022-11-28"
    },
    redirect: "error",
    signal
  });
  if (response.status === 404) {
    throw new GithubReleasePendingError(`GitHub release ${releaseTag} is not public yet.`);
  }
  if (response.status === 403 || response.status === 429 || response.status >= 500) {
    throw new GithubReleasePendingError(`GitHub release lookup is temporarily unavailable (${response.status}).`);
  }
  if (!response.ok) {
    throw new Error(`GitHub release lookup failed with HTTP ${response.status}.`);
  }
  const metadata = await readResponseBytes(response, RELEASE_JSON_MAX_BYTES, "GitHub release metadata");
  const assets = parseReleaseMetadata(metadata, prerelease, releaseTag);
  const expectedFiles = releaseFiles(prerelease);
  const downloaded = new Map();
  for (const fileName of expectedFiles) {
    const asset = assets.get(fileName);
    const limit = FILE_LIMITS.get(fileName);
    if (asset.size > limit) {
      throw new Error(`GitHub release asset ${fileName} exceeds its byte limit.`);
    }
    const assetResponse = await fetchResponse(
      fetchImpl,
      validateReleaseAssetUrl(asset.browser_download_url, releaseTag, fileName),
      {
        headers: {
          Accept: "application/octet-stream",
          "User-Agent": "OpenWrangler-marketplace-promotion/1"
        },
        redirect: "follow",
        signal
      }
    );
    if (!assetResponse.ok) {
      throw new GithubReleasePendingError(
        `GitHub release asset ${fileName} is not downloadable yet (${assetResponse.status}).`
      );
    }
    const bytes = await readResponseBytes(assetResponse, limit, `GitHub release asset ${fileName}`);
    if (bytes.length !== asset.size) {
      throw new Error(`GitHub release asset ${fileName} differs from its declared size.`);
    }
    downloaded.set(fileName, bytes);
  }
  return downloaded;
}

function canonicalOutputDirectory(outputDirectory) {
  if (typeof outputDirectory !== "string" || outputDirectory.length === 0) {
    throw new TypeError("Canonical GitHub release download requires one output directory.");
  }
  const requested = resolve(outputDirectory);
  const parent = dirname(requested);
  const parentMetadata = lstatSync(parent, { bigint: true });
  if (
    !parentMetadata.isDirectory() ||
    parentMetadata.isSymbolicLink() ||
    realpathSync.native(parent) !== parent ||
    (typeof process.getuid === "function" && parentMetadata.uid !== BigInt(process.getuid())) ||
    basename(requested) === "." ||
    basename(requested) === ".."
  ) {
    throw new Error("The canonical download parent must be one canonical, owned, non-symlinked directory.");
  }
  return requested;
}

function writeExclusiveFile(path, bytes) {
  const noFollow = constants.O_NOFOLLOW ?? 0;
  const descriptor = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollow, 0o600);
  try {
    let offset = 0;
    while (offset < bytes.length) {
      offset += writeSync(descriptor, bytes, offset, bytes.length - offset);
    }
    fchmodSync(descriptor, 0o600);
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

export async function downloadCanonicalGithubRelease({
  attempts = 40,
  delayMs = 60_000,
  fetchImpl = fetch,
  outputDirectory,
  prerelease,
  releaseTag,
  sleep = delay,
  timeoutMs = 45 * 60_000
}) {
  assertStableTag(releaseTag);
  const expectedFiles = releaseFiles(prerelease);
  if (!Number.isSafeInteger(attempts) || attempts < 1 || attempts > MAX_RELEASE_POLL_ATTEMPTS) {
    throw new TypeError(
      `GitHub release polling attempts must be an integer from 1 through ${MAX_RELEASE_POLL_ATTEMPTS}.`
    );
  }
  if (!Number.isSafeInteger(delayMs) || delayMs < 0 || delayMs > 60_000) {
    throw new TypeError("GitHub release polling delay must be an integer from 0 through 60000 milliseconds.");
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60 * 60_000) {
    throw new TypeError("GitHub release handoff timeout must be an integer from 1 through 3600000 milliseconds.");
  }
  const output = canonicalOutputDirectory(outputDirectory);
  const controller = new AbortController();
  const timeout = globalThis.setTimeout(() => controller.abort(), timeoutMs);
  timeout.unref?.();
  let files;
  try {
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        files = await fetchReleaseAssets({ fetchImpl, prerelease, releaseTag, signal: controller.signal });
        break;
      } catch (error) {
        if (controller.signal.aborted) {
          throw new Error("GitHub release handoff exceeded its overall deadline.");
        }
        if (!(error instanceof GithubReleasePendingError) || attempt === attempts) {
          throw error;
        }
        try {
          await sleep(delayMs, undefined, { signal: controller.signal });
        } catch (sleepError) {
          if (controller.signal.aborted) {
            throw new Error("GitHub release handoff exceeded its overall deadline.");
          }
          throw sleepError;
        }
      }
    }
  } finally {
    globalThis.clearTimeout(timeout);
  }
  mkdirSync(output, { mode: 0o700, recursive: false });
  for (const fileName of expectedFiles) {
    writeExclusiveFile(join(output, fileName), files.get(fileName));
  }
  return Object.freeze({
    directory: output,
    files: expectedFiles
  });
}

export function githubReleasePollingOptions(environment = process.env) {
  return Object.freeze({
    attempts: environment.OPEN_WRANGLER_GITHUB_RELEASE_ATTEMPTS
      ? Number(environment.OPEN_WRANGLER_GITHUB_RELEASE_ATTEMPTS)
      : undefined,
    delayMs: environment.OPEN_WRANGLER_GITHUB_RELEASE_DELAY_MS
      ? Number(environment.OPEN_WRANGLER_GITHUB_RELEASE_DELAY_MS)
      : undefined,
    timeoutMs: environment.OPEN_WRANGLER_GITHUB_RELEASE_TIMEOUT_MS
      ? Number(environment.OPEN_WRANGLER_GITHUB_RELEASE_TIMEOUT_MS)
      : undefined
  });
}

async function runCli() {
  if (process.argv.length !== 3) {
    throw new Error("Pass exactly one canonical release output directory.");
  }
  const receipt = await downloadCanonicalGithubRelease({
    ...githubReleasePollingOptions(process.env),
    outputDirectory: process.argv[2],
    prerelease:
      process.env.RELEASE_PRERELEASE === "true" ? true : process.env.RELEASE_PRERELEASE === "false" ? false : undefined,
    releaseTag: process.env.RELEASE_TAG
  });
  console.log(`Downloaded ${receipt.files.length} canonical GitHub release assets for ${process.env.RELEASE_TAG}.`);
}

if (process.argv[1] !== undefined && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  await runCli();
}
