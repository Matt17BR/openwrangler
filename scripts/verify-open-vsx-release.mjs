import { execFileSync } from "node:child_process";
import { createHash, timingSafeEqual } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseStrictJson } from "./strict-json.mjs";
import { verifyCanonicalReleaseArtifact } from "./verify-canonical-release-artifact.mjs";
import { inspectVsixArchive } from "./vsix-archive.mjs";

const OPEN_VSX_ROOT = "https://open-vsx.org";
const OPEN_VSX_NAMESPACE = "Matt17BR";
const OPEN_VSX_EXTENSION = "openwrangler";
const OPEN_VSX_DISPLAY_NAME = "Open Wrangler";
const FULL_COMMIT = /^[0-9a-f]{40}$/u;
const LOWER_SHA256 = /^[0-9a-f]{64}$/u;
const STABLE_VERSION = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u;
const METADATA_MAX_BYTES = 1024 * 1024;
const VSIX_MAX_BYTES = 32 * 1024 * 1024;
const ICON_MAX_BYTES = 2 * 1024 * 1024;
const POST_PUBLISH_ATTEMPTS = 91;
const POST_PUBLISH_DELAY_MS = 10_000;
const OPEN_VSX_REQUEST_TIMEOUT_MS = 15_000;

function isTransientStatus(status) {
  return status === 404 || status === 429 || (status >= 500 && status <= 599);
}

function requirePlainObject(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be one JSON object.`);
  }
  return value;
}

async function readBoundedResponse(response, maxBytes, label) {
  const declaredLength = response.headers.get("content-length");
  const contentEncoding = response.headers.get("content-encoding");
  const hasIdentityEncoding = contentEncoding === null || contentEncoding === "" || contentEncoding === "identity";
  if (
    declaredLength !== null &&
    hasIdentityEncoding &&
    (!/^(?:0|[1-9]\d*)$/u.test(declaredLength) || Number(declaredLength) > maxBytes)
  ) {
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

function exactPublicUrls(root, version) {
  const encodedVersion = encodeURIComponent(version);
  const api = `${root}/api/${OPEN_VSX_NAMESPACE}/${OPEN_VSX_EXTENSION}/${encodedVersion}`;
  const fileRoot = `${api}/file`;
  return Object.freeze({
    api,
    download: `${fileRoot}/${OPEN_VSX_NAMESPACE}.${OPEN_VSX_EXTENSION}-${encodedVersion}.vsix`,
    icon: `${fileRoot}/icon.png`,
    sha256: `${fileRoot}/${OPEN_VSX_NAMESPACE}.${OPEN_VSX_EXTENSION}-${encodedVersion}.sha256`
  });
}

function validateMetadata(metadata, { channel, packageJson, urls, version }) {
  requirePlainObject(metadata, "Open VSX release metadata");
  const files = requirePlainObject(metadata.files, "Open VSX release files");
  const downloads = requirePlainObject(metadata.downloads, "Open VSX release downloads");
  const publisher = requirePlainObject(metadata.publishedBy, "Open VSX release publisher");
  const allVersions = requirePlainObject(metadata.allVersions, "Open VSX release versions");
  if (
    metadata.namespace !== OPEN_VSX_NAMESPACE ||
    metadata.name !== OPEN_VSX_EXTENSION ||
    metadata.version !== version ||
    metadata.displayName !== OPEN_VSX_DISPLAY_NAME ||
    metadata.targetPlatform !== "universal" ||
    metadata.preRelease !== (channel === "preview") ||
    metadata.preview !== (channel === "preview") ||
    metadata.downloadable !== true ||
    metadata.deprecated !== false ||
    publisher.loginName !== OPEN_VSX_NAMESPACE ||
    files.download !== urls.download ||
    files.icon !== urls.icon ||
    files.sha256 !== urls.sha256 ||
    downloads.universal !== urls.download ||
    allVersions[version] !== urls.api
  ) {
    throw new Error("Open VSX metadata conflicts with the accepted stable extension.");
  }
  if (metadata.verified !== true) {
    throw new Error("Open VSX does not report Matt17BR as a verified publisher for this namespace.");
  }
  const keywords = Array.isArray(packageJson.keywords) ? packageJson.keywords : [];
  const publicTags = Array.isArray(metadata.tags) ? new Set(metadata.tags) : new Set();
  if (
    metadata.description !== packageJson.description ||
    metadata.homepage !== packageJson.homepage ||
    keywords.some((keyword) => !publicTags.has(keyword))
  ) {
    throw new Error("Open VSX listing copy differs from the canonical package.");
  }
}

export async function verifyOpenVsxReleaseOnce({
  candidateBytes,
  candidateSha256,
  channel = "stable",
  fetchImpl = fetch,
  inspectCandidate = inspectVsixArchive,
  requireRFrameContract = true,
  root = OPEN_VSX_ROOT,
  version
}) {
  if (
    !Buffer.isBuffer(candidateBytes) ||
    candidateBytes.length < 1 ||
    candidateBytes.length > VSIX_MAX_BYTES ||
    !LOWER_SHA256.test(candidateSha256) ||
    !STABLE_VERSION.test(version) ||
    (channel !== "stable" && channel !== "preview") ||
    createHash("sha256").update(candidateBytes).digest("hex") !== candidateSha256
  ) {
    throw new Error("Open VSX verification requires one bounded checksum-matched canonical VSIX.");
  }
  const urls = exactPublicUrls(root, version);
  const response = await fetchImpl(urls.api, {
    headers: { accept: "application/json", "user-agent": "openwrangler-stable-release" },
    redirect: "error",
    signal: AbortSignal.timeout(OPEN_VSX_REQUEST_TIMEOUT_MS)
  });
  if (response.status === 404) {
    await readBoundedResponse(response, METADATA_MAX_BYTES, "Open VSX metadata response");
    return Object.freeze({ status: "missing" });
  }
  if (isTransientStatus(response.status)) {
    await readBoundedResponse(response, METADATA_MAX_BYTES, "Open VSX metadata response");
    return Object.freeze({ status: "transient" });
  }
  if (response.status !== 200) {
    await readBoundedResponse(response, METADATA_MAX_BYTES, "Open VSX metadata error");
    throw new Error(`Open VSX metadata failed with HTTP ${response.status}.`);
  }
  const metadataBytes = await readBoundedResponse(response, METADATA_MAX_BYTES, "Open VSX metadata");
  const metadata = parseStrictJson(metadataBytes.toString("utf8"), { maxBytes: METADATA_MAX_BYTES });
  const candidateArchive = await inspectCandidate(candidateBytes, { requireRFrameContract });
  const packageJson = requirePlainObject(
    parseStrictJson(candidateArchive.packagedPackageJson),
    "Canonical VSIX package metadata"
  );
  validateMetadata(metadata, { channel, packageJson, urls, version });
  const candidateIconSize = new Map(candidateArchive.entrySizes).get("extension/media/icon.png");
  const candidateIconSha256 = new Map(candidateArchive.entryDigests).get("extension/media/icon.png");
  if (
    !Number.isSafeInteger(candidateIconSize) ||
    candidateIconSize < 1 ||
    candidateIconSize > ICON_MAX_BYTES ||
    !LOWER_SHA256.test(candidateIconSha256)
  ) {
    throw new Error("The canonical VSIX does not expose one bounded gallery icon receipt.");
  }

  const checksumResponse = await fetchImpl(urls.sha256, {
    headers: { accept: "text/plain", "user-agent": "openwrangler-stable-release" },
    redirect: "follow",
    signal: AbortSignal.timeout(OPEN_VSX_REQUEST_TIMEOUT_MS)
  });
  if (isTransientStatus(checksumResponse.status)) {
    await readBoundedResponse(checksumResponse, METADATA_MAX_BYTES, "Open VSX checksum response");
    return Object.freeze({ status: "transient" });
  }
  if (checksumResponse.status !== 200) {
    await readBoundedResponse(checksumResponse, METADATA_MAX_BYTES, "Open VSX checksum error");
    throw new Error(`Open VSX checksum failed with HTTP ${checksumResponse.status}.`);
  }
  const publicChecksum = (await readBoundedResponse(checksumResponse, 65, "Open VSX checksum")).toString("utf8");
  if (!/^[0-9a-f]{64}\n?$/u.test(publicChecksum) || publicChecksum.trim() !== candidateSha256) {
    throw new Error("Open VSX checksum conflicts with the accepted canonical VSIX.");
  }

  const downloadResponse = await fetchImpl(urls.download, {
    headers: { accept: "application/octet-stream", "user-agent": "openwrangler-stable-release" },
    redirect: "follow",
    signal: AbortSignal.timeout(OPEN_VSX_REQUEST_TIMEOUT_MS)
  });
  if (isTransientStatus(downloadResponse.status)) {
    await readBoundedResponse(downloadResponse, METADATA_MAX_BYTES, "Open VSX VSIX response");
    return Object.freeze({ status: "transient" });
  }
  if (downloadResponse.status !== 200) {
    await readBoundedResponse(downloadResponse, METADATA_MAX_BYTES, "Open VSX VSIX error");
    throw new Error(`Open VSX VSIX download failed with HTTP ${downloadResponse.status}.`);
  }
  const publicVsix = await readBoundedResponse(
    downloadResponse,
    Math.min(VSIX_MAX_BYTES, candidateBytes.length),
    "Open VSX VSIX"
  );
  if (
    publicVsix.length !== candidateBytes.length ||
    !timingSafeEqual(
      createHash("sha256").update(publicVsix).digest(),
      createHash("sha256").update(candidateBytes).digest()
    )
  ) {
    throw new Error("Open VSX serves different bytes from the accepted canonical VSIX.");
  }

  const iconResponse = await fetchImpl(urls.icon, {
    headers: { accept: "image/png", "user-agent": "openwrangler-stable-release" },
    redirect: "follow",
    signal: AbortSignal.timeout(OPEN_VSX_REQUEST_TIMEOUT_MS)
  });
  if (isTransientStatus(iconResponse.status)) {
    await readBoundedResponse(iconResponse, METADATA_MAX_BYTES, "Open VSX icon response");
    return Object.freeze({ status: "transient" });
  }
  if (iconResponse.status !== 200) {
    await readBoundedResponse(iconResponse, METADATA_MAX_BYTES, "Open VSX icon error");
    throw new Error(`Open VSX icon failed with HTTP ${iconResponse.status}.`);
  }
  const publicIcon = await readBoundedResponse(iconResponse, ICON_MAX_BYTES, "Open VSX icon");
  if (
    publicIcon.length !== candidateIconSize ||
    createHash("sha256").update(publicIcon).digest("hex") !== candidateIconSha256
  ) {
    throw new Error("Open VSX serves a gallery icon that differs from the canonical VSIX.");
  }
  return Object.freeze({
    publishedBy: metadata.publishedBy.loginName,
    status: "exact",
    version,
    verifiedNamespace: metadata.verified
  });
}

export async function waitForOpenVsxRelease({
  attempts = POST_PUBLISH_ATTEMPTS,
  candidateBytes,
  candidateSha256,
  channel = "stable",
  delay = (milliseconds) => new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds)),
  delayMs = POST_PUBLISH_DELAY_MS,
  fetchImpl = fetch,
  inspectCandidate = inspectVsixArchive,
  requireRFrameContract = true,
  root = OPEN_VSX_ROOT,
  version
}) {
  if (!Number.isSafeInteger(attempts) || attempts < 1 || attempts > POST_PUBLISH_ATTEMPTS) {
    throw new Error("Open VSX verification attempts are outside the reviewed bound.");
  }
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    let result;
    try {
      result = await verifyOpenVsxReleaseOnce({
        candidateBytes,
        candidateSha256,
        channel,
        fetchImpl,
        inspectCandidate,
        requireRFrameContract,
        root,
        version
      });
    } catch (error) {
      if (!(error instanceof TypeError) && error?.name !== "TimeoutError") throw error;
      result = Object.freeze({ status: "transient" });
    }
    if (result.status === "exact") return result;
    if (attempt < attempts) await delay(delayMs);
  }
  throw new Error(`Open VSX did not expose the accepted ${channel} release within the verification window.`);
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
  if (process.argv.length !== 4 || (process.argv[3] !== "--preflight" && process.argv[3] !== "--verify")) {
    throw new Error("Pass one canonical artifact directory and either --preflight or --verify.");
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
  const candidateBytes = readFileSync(receipt.candidatePath);
  const options = {
    candidateBytes,
    candidateSha256: receipt.candidateSha256,
    version: receipt.version
  };
  if (process.argv[3] === "--preflight") {
    const result = await verifyOpenVsxReleaseOnce(options);
    if (result.status === "transient") {
      throw new Error("Open VSX preflight could not distinguish an absent release from a registry outage.");
    }
    console.log(
      result.status === "exact"
        ? `Open VSX already serves the exact ${receipt.extensionId} ${receipt.version} VSIX.`
        : `Open VSX ${receipt.extensionId} ${receipt.version} is available for exact publication.`
    );
    return;
  }
  const result = await waitForOpenVsxRelease(options);
  console.log(`Open VSX serves the exact ${receipt.extensionId} ${result.version} VSIX from ${result.publishedBy}.`);
}

if (process.argv[1] !== undefined && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  await runCli();
}
