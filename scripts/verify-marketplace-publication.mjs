import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { parseStrictJson } from "./strict-json.mjs";
import { verifyCanonicalReleaseArtifact } from "./verify-canonical-release-artifact.mjs";
import { inspectVsixArchive, MAX_VSIX_BYTES, readBoundedVsixFileSnapshot } from "./vsix-archive.mjs";

export const MARKETPLACE_EXTENSION_ID = "Matt17BR.openwrangler";
export const MARKETPLACE_VSIX_SHA256_PROPERTY = "Microsoft.VisualStudio.Services.VsixSha256";
const MARKETPLACE_PUBLISHER = "Matt17BR";
const MARKETPLACE_EXTENSION = "openwrangler";
const GALLERY_QUERY_URL =
  "https://marketplace.visualstudio.com/_apis/public/gallery/extensionquery?api-version=7.2-preview.1";
const GALLERY_JSON_MAX_BYTES = 8 * 1024 * 1024;
const FULL_COMMIT = /^[0-9a-f]{40}$/u;

export class MarketplacePublicationPendingError extends Error {}

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

function propertyMap(properties) {
  if (!Array.isArray(properties)) {
    throw new Error("Marketplace version properties are missing.");
  }
  const result = new Map();
  for (const property of properties) {
    if (
      typeof property !== "object" ||
      property === null ||
      Array.isArray(property) ||
      typeof property.key !== "string" ||
      typeof property.value !== "string" ||
      result.has(property.key)
    ) {
      throw new Error("Marketplace version properties are malformed or duplicated.");
    }
    result.set(property.key, property.value);
  }
  return result;
}

function flagSet(flags) {
  if (typeof flags !== "string") {
    throw new Error("Marketplace validation flags are missing.");
  }
  return new Set(
    flags
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean)
  );
}

function exactMarketplaceVersion(gallery, version, candidateSha256, packageJson) {
  const extensions = gallery?.results?.[0]?.extensions;
  if (!Array.isArray(extensions) || extensions.length === 0) {
    throw new MarketplacePublicationPendingError(`Marketplace has not exposed ${MARKETPLACE_EXTENSION_ID} yet.`);
  }
  if (extensions.length !== 1) {
    throw new Error("Marketplace returned an ambiguous extension identity.");
  }
  const extension = extensions[0];
  if (
    typeof extension !== "object" ||
    extension === null ||
    Array.isArray(extension) ||
    extension.publisher?.publisherName?.toLowerCase() !== MARKETPLACE_PUBLISHER.toLowerCase() ||
    extension.extensionName !== MARKETPLACE_EXTENSION ||
    extension.displayName !== packageJson.displayName ||
    extension.shortDescription !== packageJson.description
  ) {
    throw new Error("Marketplace public extension metadata does not match the canonical package.");
  }
  const extensionFlags = flagSet(extension.flags);
  if (!extensionFlags.has("public")) {
    throw new MarketplacePublicationPendingError("Marketplace has not made the extension public yet.");
  }
  if (!Array.isArray(extension.versions)) {
    throw new MarketplacePublicationPendingError("Marketplace has not exposed extension versions yet.");
  }
  const matches = extension.versions.filter((candidate) => candidate?.version === version);
  if (matches.length === 0) {
    throw new MarketplacePublicationPendingError(`Marketplace has not exposed version ${version} yet.`);
  }
  if (matches.length !== 1) {
    throw new Error(`Marketplace returned duplicate metadata for version ${version}.`);
  }
  const published = matches[0];
  if (!flagSet(published.flags).has("validated")) {
    throw new MarketplacePublicationPendingError(`Marketplace version ${version} is not validated yet.`);
  }
  const properties = propertyMap(published.properties);
  const publishedSha256 = properties.get(MARKETPLACE_VSIX_SHA256_PROPERTY);
  if (publishedSha256 === undefined) {
    throw new MarketplacePublicationPendingError("Marketplace has not exposed its VSIX SHA-256 property yet.");
  }
  if (publishedSha256 !== candidateSha256) {
    throw new Error(`Marketplace version ${version} is already bound to different VSIX bytes (${publishedSha256}).`);
  }
  if (properties.get("Microsoft.VisualStudio.Code.Engine") !== packageJson.engines?.vscode) {
    throw new Error("Marketplace engine metadata differs from the canonical package.");
  }
  const extensionKind = Array.isArray(packageJson.extensionKind) ? packageJson.extensionKind.join(",") : undefined;
  if (properties.get("Microsoft.VisualStudio.Code.ExtensionKind") !== extensionKind) {
    throw new Error("Marketplace extension-kind metadata differs from the canonical package.");
  }
  const vsixAssets = Array.isArray(published.files)
    ? published.files.filter((file) => file?.assetType === "Microsoft.VisualStudio.Services.VSIXPackage")
    : [];
  if (vsixAssets.length !== 1 || typeof vsixAssets[0].source !== "string") {
    throw new MarketplacePublicationPendingError("Marketplace has not exposed one public VSIX asset yet.");
  }
  return published;
}

function semanticEntries(archive) {
  const sizes = new Map(archive.entrySizes);
  const digests = new Map(archive.entryDigests);
  return [...new Set(archive.archiveEntries)].sort().map((name) =>
    Object.freeze({
      name,
      sha256: digests.get(name),
      size: sizes.get(name)
    })
  );
}

function assertSameVsixSemantics(canonical, published) {
  const canonicalEntries = semanticEntries(canonical);
  const publishedEntries = semanticEntries(published);
  if (JSON.stringify(canonicalEntries) !== JSON.stringify(publishedEntries)) {
    throw new Error("Marketplace public VSIX entries or payload bytes differ from the canonical release artifact.");
  }
  if (
    canonical.packagedPackageJson !== published.packagedPackageJson ||
    canonical.vsixManifest !== published.vsixManifest
  ) {
    throw new Error("Marketplace public VSIX identity metadata differs from the canonical release artifact.");
  }
}

async function queryPublicMarketplace({ candidateSha256, fetchImpl, packageJson, version }) {
  const queryResponse = await fetchImpl(GALLERY_QUERY_URL, {
    method: "POST",
    headers: {
      Accept: "application/json;api-version=7.2-preview.1",
      "Content-Type": "application/json",
      "User-Agent": "OpenWrangler-marketplace-verifier/1"
    },
    body: JSON.stringify({
      filters: [
        {
          criteria: [{ filterType: 7, value: MARKETPLACE_EXTENSION_ID }],
          pageNumber: 1,
          pageSize: 1,
          sortBy: 0,
          sortOrder: 0
        }
      ],
      assetTypes: [],
      flags: 19
    }),
    redirect: "error"
  });
  if (queryResponse.status === 429 || queryResponse.status >= 500) {
    throw new MarketplacePublicationPendingError(
      `Marketplace public query is temporarily unavailable (${queryResponse.status}).`
    );
  }
  if (!queryResponse.ok) {
    throw new Error(`Marketplace public query failed with HTTP ${queryResponse.status}.`);
  }
  const galleryBytes = await readResponseBytes(queryResponse, GALLERY_JSON_MAX_BYTES, "Marketplace gallery response");
  let gallery;
  try {
    gallery = parseStrictJson(new TextDecoder("utf-8", { fatal: true }).decode(galleryBytes), {
      maxBytes: GALLERY_JSON_MAX_BYTES
    });
  } catch (error) {
    throw new Error("Marketplace gallery response is not valid bounded strict JSON.", { cause: error });
  }
  exactMarketplaceVersion(gallery, version, candidateSha256, packageJson);

  const packageUrl = `https://marketplace.visualstudio.com/_apis/public/gallery/publishers/${MARKETPLACE_PUBLISHER}/vsextensions/${MARKETPLACE_EXTENSION}/${version}/vspackage`;
  const packageResponse = await fetchImpl(packageUrl, {
    headers: {
      Accept: "application/vsix",
      "User-Agent": "OpenWrangler-marketplace-verifier/1"
    },
    redirect: "follow"
  });
  if (packageResponse.status === 404 || packageResponse.status === 429 || packageResponse.status >= 500) {
    throw new MarketplacePublicationPendingError(
      `Marketplace public VSIX is not available yet (${packageResponse.status}).`
    );
  }
  if (!packageResponse.ok) {
    throw new Error(`Marketplace public VSIX download failed with HTTP ${packageResponse.status}.`);
  }
  return readResponseBytes(packageResponse, MAX_VSIX_BYTES, "Marketplace public VSIX");
}

export async function verifyMarketplacePublication({
  attempts = 20,
  candidatePath,
  candidateSha256,
  delayMs = 15_000,
  fetchImpl = fetch,
  sleep = delay,
  version
}) {
  if (!/^[0-9a-f]{64}$/u.test(candidateSha256)) {
    throw new TypeError("Canonical Marketplace verification requires one lowercase SHA-256 digest.");
  }
  if (typeof version !== "string" || !/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u.test(version)) {
    throw new TypeError("Canonical Marketplace verification requires one numeric extension version.");
  }
  if (!Number.isSafeInteger(attempts) || attempts < 1 || attempts > 40) {
    throw new TypeError("Marketplace polling attempts must be an integer from 1 through 40.");
  }
  if (!Number.isSafeInteger(delayMs) || delayMs < 0 || delayMs > 60_000) {
    throw new TypeError("Marketplace polling delay must be an integer from 0 through 60000 milliseconds.");
  }
  const candidate = readBoundedVsixFileSnapshot(candidatePath, { requireOwner: true });
  const actualCandidateSha256 = createHash("sha256").update(candidate.bytes).digest("hex");
  if (actualCandidateSha256 !== candidateSha256) {
    throw new Error("Canonical Marketplace candidate changed before public verification.");
  }
  const canonicalArchive = await inspectVsixArchive(candidate.bytes);
  const packageJson = parseStrictJson(canonicalArchive.packagedPackageJson);
  if (
    packageJson?.publisher !== MARKETPLACE_PUBLISHER ||
    packageJson?.name !== MARKETPLACE_EXTENSION ||
    packageJson?.version !== version ||
    packageJson?.preview !== false
  ) {
    throw new Error("Canonical Marketplace candidate identity, version, or stable channel is invalid.");
  }

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const publishedBytes = await queryPublicMarketplace({
        candidateSha256,
        fetchImpl,
        packageJson,
        version
      });
      const publishedArchive = await inspectVsixArchive(publishedBytes);
      assertSameVsixSemantics(canonicalArchive, publishedArchive);
      const finalCandidate = readBoundedVsixFileSnapshot(candidatePath, { requireOwner: true });
      if (
        createHash("sha256").update(finalCandidate.bytes).digest("hex") !== candidateSha256 ||
        !finalCandidate.bytes.equals(candidate.bytes)
      ) {
        throw new Error("Canonical Marketplace candidate changed during public verification.");
      }
      return Object.freeze({
        candidateSha256,
        extensionId: MARKETPLACE_EXTENSION_ID,
        version
      });
    } catch (error) {
      if (!(error instanceof MarketplacePublicationPendingError) || attempt === attempts) {
        throw error;
      }
      await sleep(delayMs);
    }
  }
  throw new Error("Marketplace publication verification exhausted without a result.");
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
    throw new Error("Marketplace verification source did not resolve to one full Git commit.");
  }
  return commit;
}

async function runCli() {
  if (process.argv.length !== 3) {
    throw new Error("Pass exactly one downloaded canonical artifact directory.");
  }
  const root = realpathSync.native(resolve(import.meta.dirname, ".."));
  const canonical = await verifyCanonicalReleaseArtifact({
    directory: process.argv[2],
    expectedCommit: process.env.EXPECTED_SHA,
    releaseTag: process.env.RELEASE_TAG,
    sourceCommit: exactHead(root),
    sourcePackageJson: readFileSync(join(root, "package.json"), "utf8")
  });
  const receipt = await verifyMarketplacePublication({
    attempts: process.env.OPEN_WRANGLER_MARKETPLACE_VERIFY_ATTEMPTS
      ? Number(process.env.OPEN_WRANGLER_MARKETPLACE_VERIFY_ATTEMPTS)
      : undefined,
    candidatePath: canonical.candidatePath,
    candidateSha256: canonical.candidateSha256,
    version: canonical.version
  });
  console.log(
    `Verified public Marketplace publication ${receipt.extensionId} ${receipt.version} from ${receipt.candidateSha256}.`
  );
}

if (process.argv[1] !== undefined && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  await runCli();
}
