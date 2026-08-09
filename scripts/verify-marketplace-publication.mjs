import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { PNG } from "pngjs";
import { parseStrictJson } from "./strict-json.mjs";
import { verifyRegistryReleaseArtifactFromCheckout } from "./verify-registry-release-artifact.mjs";
import { inspectVsixArchive, MAX_VSIX_BYTES, readBoundedVsixFileSnapshot } from "./vsix-archive.mjs";
import { inspectVsixPreReleaseMetadata } from "./vsix-contents.mjs";

export const MARKETPLACE_EXTENSION_ID = "Matt17BR.openwrangler";
export const MARKETPLACE_VSIX_SHA256_PROPERTY = "Microsoft.VisualStudio.Services.VsixSha256";
const MARKETPLACE_PUBLISHER = "Matt17BR";
const MARKETPLACE_EXTENSION = "openwrangler";
const GALLERY_QUERY_URL =
  "https://marketplace.visualstudio.com/_apis/public/gallery/extensionquery?api-version=7.2-preview.1";
const GALLERY_JSON_MAX_BYTES = 8 * 1024 * 1024;
const GALLERY_ICON_MAX_BYTES = 2 * 1024 * 1024;
const SMALL_ICON_MAX_BYTES = 256 * 1024;
const MARKETPLACE_REQUEST_TIMEOUT_MS = 15_000;
const ICON_COMPARISON_GRID_SIZE = 12;
const ICON_MAX_NORMALIZED_DIFFERENCE = 0.03;
const DEFAULT_ICON_ASSET = "Microsoft.VisualStudio.Services.Icons.Default";
const SMALL_ICON_ASSET = "Microsoft.VisualStudio.Services.Icons.Small";
const VSIX_ASSET = "Microsoft.VisualStudio.Services.VSIXPackage";
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

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

function pngDimensions(bytes, label) {
  if (
    !Buffer.isBuffer(bytes) ||
    bytes.length < 24 ||
    !bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE) ||
    bytes.readUInt32BE(8) !== 13 ||
    bytes.toString("ascii", 12, 16) !== "IHDR"
  ) {
    throw new Error(`${label} is not a canonical PNG image.`);
  }
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  if (width < 1 || height < 1) {
    throw new Error(`${label} has invalid PNG dimensions.`);
  }
  return Object.freeze({ height, width });
}

function premultipliedCellAverage(image, column, row) {
  const left = Math.floor((column * image.width) / ICON_COMPARISON_GRID_SIZE);
  const right = Math.floor(((column + 1) * image.width) / ICON_COMPARISON_GRID_SIZE);
  const top = Math.floor((row * image.height) / ICON_COMPARISON_GRID_SIZE);
  const bottom = Math.floor(((row + 1) * image.height) / ICON_COMPARISON_GRID_SIZE);
  const totals = [0, 0, 0, 0];
  let pixels = 0;
  for (let y = top; y < bottom; y += 1) {
    for (let x = left; x < right; x += 1) {
      const offset = (y * image.width + x) * 4;
      const alpha = image.data[offset + 3] / 255;
      totals[0] += image.data[offset] * alpha;
      totals[1] += image.data[offset + 1] * alpha;
      totals[2] += image.data[offset + 2] * alpha;
      totals[3] += image.data[offset + 3];
      pixels += 1;
    }
  }
  return totals.map((total) => total / pixels);
}

function normalizedIconDifference(left, right) {
  let difference = 0;
  for (let row = 0; row < ICON_COMPARISON_GRID_SIZE; row += 1) {
    for (let column = 0; column < ICON_COMPARISON_GRID_SIZE; column += 1) {
      const leftCell = premultipliedCellAverage(left, column, row);
      const rightCell = premultipliedCellAverage(right, column, row);
      for (let channel = 0; channel < 4; channel += 1) {
        difference += Math.abs(leftCell[channel] - rightCell[channel]);
      }
    }
  }
  return difference / (ICON_COMPARISON_GRID_SIZE ** 2 * 4 * 255);
}

function exactAssetSource(files, assetType, version) {
  if (!Array.isArray(files)) {
    throw new MarketplacePublicationPendingError("Marketplace has not exposed public version assets yet.");
  }
  const matches = files.filter((file) => file?.assetType === assetType);
  if (matches.length === 0) {
    throw new MarketplacePublicationPendingError(`Marketplace has not exposed ${assetType} yet.`);
  }
  if (matches.length !== 1 || typeof matches[0].source !== "string") {
    throw new Error(`Marketplace returned ambiguous or malformed ${assetType} metadata.`);
  }
  let source;
  try {
    source = new URL(matches[0].source);
  } catch (error) {
    throw new Error(`Marketplace returned an invalid ${assetType} URL.`, { cause: error });
  }
  const expectedPrefix = `/extensions/${MARKETPLACE_PUBLISHER.toLowerCase()}/${MARKETPLACE_EXTENSION}/${version}/`;
  if (
    source.protocol !== "https:" ||
    source.username !== "" ||
    source.password !== "" ||
    source.port !== "" ||
    source.search !== "" ||
    source.hash !== "" ||
    source.hostname.toLowerCase() !== `${MARKETPLACE_PUBLISHER.toLowerCase()}.gallerycdn.vsassets.io` ||
    !source.pathname.toLowerCase().startsWith(expectedPrefix.toLowerCase()) ||
    !source.pathname.endsWith(`/${assetType}`)
  ) {
    throw new Error(`Marketplace returned an unexpected ${assetType} URL.`);
  }
  return source.href;
}

function exactMarketplaceVersion(gallery, version, candidateSha256, packageJson, prerelease) {
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
    extension.displayName !== packageJson.displayName
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
  if (extension.versions[0]?.version === version) {
    const publicTags = Array.isArray(extension.tags) ? new Set(extension.tags) : new Set();
    const keywords = Array.isArray(packageJson.keywords) ? packageJson.keywords : [];
    if (
      extension.shortDescription !== packageJson.description ||
      keywords.some((keyword) => !publicTags.has(keyword))
    ) {
      throw new Error("Marketplace listing copy does not match the current canonical package.");
    }
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
  if (properties.get("Microsoft.VisualStudio.Services.Links.Learn") !== packageJson.homepage) {
    throw new Error("Marketplace homepage metadata differs from the canonical package.");
  }
  const extensionKind = Array.isArray(packageJson.extensionKind) ? packageJson.extensionKind.join(",") : undefined;
  if (properties.get("Microsoft.VisualStudio.Code.ExtensionKind") !== extensionKind) {
    throw new Error("Marketplace extension-kind metadata differs from the canonical package.");
  }
  const publishedPrerelease = properties.get("Microsoft.VisualStudio.Code.PreRelease");
  if ((prerelease && publishedPrerelease !== "true") || (!prerelease && publishedPrerelease !== undefined)) {
    throw new Error("Marketplace pre-release metadata differs from the canonical package channel.");
  }
  return Object.freeze({
    defaultIconUrl: exactAssetSource(published.files, DEFAULT_ICON_ASSET, version),
    smallIconUrl: exactAssetSource(published.files, SMALL_ICON_ASSET, version),
    vsixUrl: exactAssetSource(published.files, VSIX_ASSET, version)
  });
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

async function readMarketplaceAsset(fetchImpl, url, maximumBytes, label) {
  let response;
  try {
    response = await fetchImpl(url, {
      headers: {
        Accept: "image/png",
        "User-Agent": "OpenWrangler-marketplace-verifier/1"
      },
      redirect: "follow",
      signal: AbortSignal.timeout(MARKETPLACE_REQUEST_TIMEOUT_MS)
    });
  } catch (error) {
    if (
      error instanceof TypeError ||
      (typeof error === "object" && error !== null && (error.name === "AbortError" || error.name === "TimeoutError"))
    ) {
      throw new MarketplacePublicationPendingError(`${label} request was temporarily unavailable.`);
    }
    throw error;
  }
  if (response.status === 404 || response.status === 429 || response.status >= 500) {
    throw new MarketplacePublicationPendingError(`${label} is not available yet (${response.status}).`);
  }
  if (!response.ok) {
    throw new Error(`${label} download failed with HTTP ${response.status}.`);
  }
  if (!/^image\/png(?:\s*;|$)/iu.test(response.headers.get("content-type") ?? "")) {
    throw new Error(`${label} does not use the image/png media type.`);
  }
  return readResponseBytes(response, maximumBytes, label);
}

async function queryPublicMarketplace({
  candidateIconSha256,
  candidateIconSize,
  candidateSha256,
  fetchImpl,
  packageJson,
  prerelease,
  version
}) {
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
      flags: 23
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
  const assets = exactMarketplaceVersion(gallery, version, candidateSha256, packageJson, prerelease);

  const defaultIcon = await readMarketplaceAsset(
    fetchImpl,
    assets.defaultIconUrl,
    GALLERY_ICON_MAX_BYTES,
    "Marketplace default gallery icon"
  );
  const defaultDimensions = pngDimensions(defaultIcon, "Marketplace default gallery icon");
  if (
    defaultDimensions.width !== 512 ||
    defaultDimensions.height !== 512 ||
    defaultIcon.length !== candidateIconSize ||
    createHash("sha256").update(defaultIcon).digest("hex") !== candidateIconSha256
  ) {
    throw new Error("Marketplace serves a default gallery icon that differs from the canonical VSIX.");
  }
  let decodedDefaultIcon;
  try {
    decodedDefaultIcon = PNG.sync.read(defaultIcon);
    if (decodedDefaultIcon.width !== 512 || decodedDefaultIcon.height !== 512) {
      throw new Error("decoded dimensions differ");
    }
  } catch (error) {
    throw new Error("Marketplace default gallery icon is not a valid 512 by 512 pixel PNG.", { cause: error });
  }

  const smallIcon = await readMarketplaceAsset(
    fetchImpl,
    assets.smallIconUrl,
    SMALL_ICON_MAX_BYTES,
    "Marketplace small gallery icon"
  );
  const smallDimensions = pngDimensions(smallIcon, "Marketplace small gallery icon");
  if (smallDimensions.width !== 72 || smallDimensions.height !== 72) {
    throw new Error("Marketplace small gallery icon is not the expected 72 by 72 pixel derivative.");
  }
  let decodedSmallIcon;
  try {
    decodedSmallIcon = PNG.sync.read(smallIcon);
    if (decodedSmallIcon.width !== 72 || decodedSmallIcon.height !== 72) {
      throw new Error("decoded dimensions differ");
    }
  } catch (error) {
    throw new Error("Marketplace small gallery icon is not a valid 72 by 72 pixel PNG.", { cause: error });
  }
  if (normalizedIconDifference(decodedDefaultIcon, decodedSmallIcon) > ICON_MAX_NORMALIZED_DIFFERENCE) {
    throw new Error("Marketplace small gallery icon does not visually match the canonical VSIX icon.");
  }

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
  prerelease,
  requireRFrameContract = true,
  sleep = delay,
  version
}) {
  if (!/^[0-9a-f]{64}$/u.test(candidateSha256)) {
    throw new TypeError("Canonical Marketplace verification requires one lowercase SHA-256 digest.");
  }
  if (typeof version !== "string" || !/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u.test(version)) {
    throw new TypeError("Canonical Marketplace verification requires one numeric extension version.");
  }
  if (typeof prerelease !== "boolean") {
    throw new TypeError("Canonical Marketplace verification requires an explicit pre-release boolean.");
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
  const canonicalArchive = await inspectVsixArchive(candidate.bytes, { requireRFrameContract });
  const candidateIconSize = new Map(canonicalArchive.entrySizes).get("extension/media/icon.png");
  const candidateIconSha256 = new Map(canonicalArchive.entryDigests).get("extension/media/icon.png");
  if (
    !Number.isSafeInteger(candidateIconSize) ||
    candidateIconSize < 1 ||
    candidateIconSize > GALLERY_ICON_MAX_BYTES ||
    typeof candidateIconSha256 !== "string" ||
    !/^[0-9a-f]{64}$/u.test(candidateIconSha256)
  ) {
    throw new Error("Canonical Marketplace candidate does not expose one bounded gallery icon receipt.");
  }
  const packageJson = parseStrictJson(canonicalArchive.packagedPackageJson);
  const preReleaseProblems = inspectVsixPreReleaseMetadata(
    canonicalArchive.packagedPackageJson,
    canonicalArchive.vsixManifest
  );
  if (
    packageJson?.publisher !== MARKETPLACE_PUBLISHER ||
    packageJson?.name !== MARKETPLACE_EXTENSION ||
    packageJson?.version !== version ||
    packageJson?.preview !== prerelease ||
    preReleaseProblems.length > 0
  ) {
    throw new Error("Canonical Marketplace candidate identity, version, or release channel is invalid.");
  }

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const publishedBytes = await queryPublicMarketplace({
        candidateIconSha256,
        candidateIconSize,
        candidateSha256,
        fetchImpl,
        packageJson,
        prerelease,
        version
      });
      const publishedArchive = await inspectVsixArchive(publishedBytes, { requireRFrameContract });
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

async function runCli() {
  if (process.argv.length !== 3) {
    throw new Error("Pass exactly one downloaded canonical artifact directory.");
  }
  const root = realpathSync.native(resolve(import.meta.dirname, ".."));
  const prerelease =
    process.env.RELEASE_PRERELEASE === "true" ? true : process.env.RELEASE_PRERELEASE === "false" ? false : undefined;
  const canonical = await verifyRegistryReleaseArtifactFromCheckout({
    automationCommit: process.env.AUTOMATION_SHA,
    directory: process.argv[2],
    expectedCommit: process.env.EXPECTED_SHA,
    prerelease,
    releaseTag: process.env.RELEASE_TAG,
    root
  });
  const receipt = await verifyMarketplacePublication({
    attempts: process.env.OPEN_WRANGLER_MARKETPLACE_VERIFY_ATTEMPTS
      ? Number(process.env.OPEN_WRANGLER_MARKETPLACE_VERIFY_ATTEMPTS)
      : undefined,
    candidatePath: canonical.candidatePath,
    candidateSha256: canonical.candidateSha256,
    prerelease: canonical.prerelease,
    requireRFrameContract: canonical.requireRFrameContract,
    version: canonical.version
  });
  console.log(
    `Verified public Marketplace publication ${receipt.extensionId} ${receipt.version} from ${receipt.candidateSha256}.`
  );
}

if (process.argv[1] !== undefined && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  await runCli();
}
