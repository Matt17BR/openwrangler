import { createHash } from "node:crypto";
import {
  closeSync,
  constants as fileSystemConstants,
  fstatSync,
  lstatSync,
  openSync,
  opendirSync,
  readFileSync,
  readSync,
  realpathSync
} from "node:fs";
import { relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { PNG } from "pngjs";
import {
  PUBLIC_MEDIA_MAX_FILE_BYTES,
  PUBLIC_MEDIA_MAX_TOTAL_BYTES,
  PUBLIC_MEDIA_PIXEL_RATIO,
  publicMediaPhysicalLength
} from "./public-media-contract.mjs";
import {
  PUBLIC_MEDIA_ASSETS,
  PUBLIC_MEDIA_MAX_DIRECTORY_DEPTH,
  PUBLIC_MEDIA_MAX_INVENTORY_ENTRIES,
  PUBLIC_MEDIA_MAX_RELATIVE_PATH_BYTES,
  PUBLIC_MEDIA_SERIES_PATH,
  PUBLIC_README_IMAGE_COUNT
} from "./public-media-inventory.mjs";
import {
  assertExactSourceReadmeUrl,
  assertExpectedSurfaceContent,
  assertExpectedSurfaceVersion,
  assertRepresentativeImageSource,
  assertRenderedProductImage,
  assertSourcePackageVersion,
  expectedRepresentativeReferences,
  extractDeclaredPublicMediaPaths,
  extractImmutableProductReferences,
  parsePublicMediaVerifierArguments,
  PUBLIC_MEDIA_CONTEXT_CLEANUP_TIMEOUT_MS,
  PUBLIC_MEDIA_FETCH_TIMEOUT_MS,
  PUBLIC_MEDIA_PROPAGATION_ATTEMPTS,
  PUBLIC_MEDIA_PROPAGATION_DELAY_MS,
  PUBLIC_MEDIA_PROPAGATION_TIMEOUT_MS,
  PUBLIC_MEDIA_RENDER_ATTEMPT_TIMEOUT_MS,
  PUBLIC_MEDIA_RESPONSIVE_WIDTHS,
  publicMediaVerificationRequired,
  publicSurfaceDefinitions
} from "./public-media-surface-contract.mjs";

const automationRoot = resolve(import.meta.dirname, "..");
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

export class RetryablePublicMediaObservationError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = "RetryablePublicMediaObservationError";
  }
}

async function main() {
  const { sourceSha, version, sourceRoot, waitForPropagation } = parsePublicMediaVerifierArguments(
    process.argv.slice(2)
  );
  if (!publicMediaVerificationRequired(version)) {
    console.log(`Public README media verification starts with v1.2.1; historical ${version} recovery is unchanged.`);
    return;
  }
  const root = resolveVerifiedSourceRoot(sourceRoot);
  const productImageRoot = resolve(root, ...PUBLIC_MEDIA_SERIES_PATH.split("/").filter(Boolean));
  const readme = readFileSync(resolve(root, "README.md"), "utf8");
  const gallery = readFileSync(resolve(root, "docs", "media-gallery.md"), "utf8");
  const references = verifyLocalPublicMedia(productImageRoot, readme, gallery);
  await verifyExactSource(root, sourceSha, version, readme);
  await verifyImmutablePublicBytes(references);
  await verifyRenderedSurfaces(sourceSha, version, readme, references, waitForPropagation);
}

export function resolveVerifiedSourceRoot(sourceRoot, checkoutRoot = automationRoot) {
  const checkoutMetadata = lstatSync(checkoutRoot);
  if (!checkoutMetadata.isDirectory() || checkoutMetadata.isSymbolicLink()) {
    throw new Error("The automation checkout must identify one real directory.");
  }
  const canonicalAutomationRoot = realpathSync.native(checkoutRoot);
  if (sourceRoot === undefined) return canonicalAutomationRoot;
  const candidate = resolve(checkoutRoot, sourceRoot);
  const metadata = lstatSync(candidate);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error("--source-root must identify one real directory below the automation checkout.");
  }
  const canonicalCandidate = realpathSync.native(candidate);
  if (!canonicalCandidate.startsWith(`${canonicalAutomationRoot}${sep}`)) {
    throw new Error("--source-root must remain below the automation checkout after canonicalization.");
  }
  return canonicalCandidate;
}

export function verifyLocalPublicMedia(productImageRoot, readme, gallery) {
  const expectedPaths = PUBLIC_MEDIA_ASSETS.map((asset) => asset.relativePath).sort();
  const declaredPaths = extractDeclaredPublicMediaPaths(readme, gallery);
  if (JSON.stringify(declaredPaths) !== JSON.stringify(expectedPaths)) {
    throw new Error("README and gallery media references differ from the canonical public-media inventory.");
  }
  const inventory = inspectLocalPublicMediaInventory(productImageRoot);
  const actualPaths = inventory.files.map((file) => file.relativePath);
  if (JSON.stringify(actualPaths) !== JSON.stringify(expectedPaths)) {
    throw new Error("The public-media directory differs from the canonical declared inventory.");
  }

  const assetByPath = new Map(PUBLIC_MEDIA_ASSETS.map((asset) => [asset.relativePath, asset]));
  const localBytes = new Map();
  for (const asset of PUBLIC_MEDIA_ASSETS) {
    const file = inventory.byRelativePath.get(asset.relativePath);
    if (file === undefined) throw new Error(`${asset.relativePath} is absent from the preflighted inventory.`);
    const bytes = readPreflightedFile(file);
    assertPngContract(bytes, asset);
    localBytes.set(asset.relativePath, bytes);
  }

  const references = extractImmutableProductReferences(readme);
  if (references.length !== PUBLIC_README_IMAGE_COUNT) {
    throw new Error(`README must expose exactly ${PUBLIC_README_IMAGE_COUNT} immutable public product images.`);
  }
  const seenAlts = new Set();
  const seenPaths = new Set();
  const mediaSourceShas = new Set();
  const displayed = [];
  for (const reference of references) {
    const asset = assetByPath.get(reference.relativePath);
    if (asset === undefined) {
      throw new Error(`${reference.relativePath} is absent from the declared public-media inventory.`);
    }
    const naturalWidth = publicMediaPhysicalLength(asset.logicalWidth);
    const naturalHeight = publicMediaPhysicalLength(asset.logicalHeight);
    if (naturalWidth < reference.displayWidth * PUBLIC_MEDIA_PIXEL_RATIO) {
      throw new Error(`${reference.relativePath} does not supply two source pixels per declared CSS pixel.`);
    }
    if (seenAlts.has(reference.alt) || seenPaths.has(reference.relativePath)) {
      throw new Error("README public product images require unique alt text and source paths.");
    }
    seenAlts.add(reference.alt);
    seenPaths.add(reference.relativePath);
    mediaSourceShas.add(reference.sourceSha);
    displayed.push({ ...reference, naturalWidth, naturalHeight });
  }
  if (mediaSourceShas.size !== 1) {
    throw new Error("README public product images must share one immutable reviewed media commit.");
  }
  console.log(
    `Verified ${PUBLIC_MEDIA_ASSETS.length} declared sRGB PNGs and width-only README presentations within the media budgets.`
  );
  return { displayed, localBytes, mediaSourceSha: [...mediaSourceShas][0] };
}

async function verifyExactSource(root, sourceSha, version, localReadme) {
  const localPackage = readFileSync(resolve(root, "package.json"), "utf8");
  assertSourcePackageVersion(localPackage, version);

  const remoteReadme = await fetchBounded(
    `https://raw.githubusercontent.com/Matt17BR/openwrangler/${sourceSha}/README.md`
  );
  if (!remoteReadme.equals(Buffer.from(localReadme))) {
    throw new Error("The exact source commit README does not byte-match the reviewed local README.");
  }
  const remotePackage = await fetchBounded(
    `https://raw.githubusercontent.com/Matt17BR/openwrangler/${sourceSha}/package.json`
  );
  assertSourcePackageVersion(remotePackage.toString("utf8"), version);
  console.log(`Verified exact source ${sourceSha} at version ${version}.`);
}

async function verifyImmutablePublicBytes(references) {
  for (const asset of PUBLIC_MEDIA_ASSETS) {
    const local = references.localBytes.get(asset.relativePath);
    if (local === undefined) throw new Error(`${asset.relativePath} is absent from the verified local byte set.`);
    const source =
      `https://raw.githubusercontent.com/Matt17BR/openwrangler/${references.mediaSourceSha}/` +
      `${PUBLIC_MEDIA_SERIES_PATH}${asset.relativePath}`;
    const response = await fetch(source, {
      headers: { "user-agent": "Open-Wrangler-public-media-verifier" },
      redirect: "follow",
      signal: AbortSignal.timeout(PUBLIC_MEDIA_FETCH_TIMEOUT_MS)
    });
    if (!response.ok) throw new Error(`Could not fetch immutable public media: HTTP ${response.status}.`);
    const remote = await readBoundedResponse(response, source);
    if (!remote.equals(local)) {
      throw new Error(
        `${asset.relativePath} differs from its immutable remote bytes ` +
          `(${sha256(local)} locally, ${sha256(remote)} remotely).`
      );
    }
  }
  references.localBytes.clear();
  console.log(`Verified all ${PUBLIC_MEDIA_ASSETS.length} immutable public PNG payloads byte-for-byte.`);
}

async function verifyRenderedSurfaces(sourceSha, version, readme, references, waitForPropagation) {
  const representatives = expectedRepresentativeReferences(readme).map((representative) => {
    const displayed = references.displayed.find(
      (image) =>
        image.alt === representative.alt &&
        image.url === representative.url &&
        image.displayWidth === representative.displayWidth
    );
    if (displayed === undefined) {
      throw new Error("Rendered public-media verification omitted one required representative image.");
    }
    return displayed;
  });
  const browser = await chromium.launch({ headless: true });
  const attempts = waitForPropagation ? PUBLIC_MEDIA_PROPAGATION_ATTEMPTS : 1;
  try {
    await runPublicMediaPropagation({
      attempts,
      attempt: ({ attemptTimeoutMilliseconds }) =>
        runFreshPublicMediaContextAttempt({
          attemptTimeoutMilliseconds,
          createContext: async () => {
            const context = await browser.newContext({
              viewport: { width: Math.max(...PUBLIC_MEDIA_RESPONSIVE_WIDTHS), height: 1_000 },
              deviceScaleFactor: PUBLIC_MEDIA_PIXEL_RATIO
            });
            context.setDefaultTimeout(30_000);
            context.setDefaultNavigationTimeout(60_000);
            return context;
          },
          verifyContext: (context) =>
            verifyRenderedSurfacesInContext(context, sourceSha, version, references.displayed, representatives)
        })
    });
  } finally {
    await browser.close();
  }
}

export async function runPublicMediaPropagation({
  attempt,
  attempts = PUBLIC_MEDIA_PROPAGATION_ATTEMPTS,
  delayMilliseconds = PUBLIC_MEDIA_PROPAGATION_DELAY_MS,
  timeoutMilliseconds = PUBLIC_MEDIA_PROPAGATION_TIMEOUT_MS,
  attemptTimeoutMilliseconds = PUBLIC_MEDIA_RENDER_ATTEMPT_TIMEOUT_MS,
  now = Date.now,
  sleep = delay,
  report = (message) => console.log(message)
}) {
  if (
    typeof attempt !== "function" ||
    typeof now !== "function" ||
    typeof sleep !== "function" ||
    typeof report !== "function"
  ) {
    throw new TypeError("Public-media propagation requires injected attempt, clock, delay, and report functions.");
  }
  for (const value of [attempts, delayMilliseconds, timeoutMilliseconds, attemptTimeoutMilliseconds]) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new TypeError("Public-media propagation bounds must be positive safe integers.");
    }
  }
  const deadline = now() + timeoutMilliseconds;
  for (let attemptNumber = 1; attemptNumber <= attempts; attemptNumber += 1) {
    const remaining = deadline - now();
    if (remaining <= 0) throw new Error("Public README media exceeded its bounded propagation deadline.");
    try {
      return await attempt({
        attemptNumber,
        attemptTimeoutMilliseconds: Math.min(remaining, attemptTimeoutMilliseconds)
      });
    } catch (error) {
      if (!(error instanceof RetryablePublicMediaObservationError)) throw error;
      if (attemptNumber === attempts) throw error;
      report(`Public README media has not propagated (attempt ${attemptNumber}/${attempts}): ${boundedError(error)}`);
      const boundedDelay = Math.min(delayMilliseconds, Math.max(0, deadline - now()));
      if (boundedDelay <= 0) throw new Error("Public README media exceeded its bounded propagation deadline.");
      await sleep(boundedDelay);
    }
  }
  throw new Error("Public README media exhausted its bounded propagation attempts.");
}

export async function runFreshPublicMediaContextAttempt({
  createContext,
  verifyContext,
  attemptTimeoutMilliseconds,
  cleanupTimeoutMilliseconds = PUBLIC_MEDIA_CONTEXT_CLEANUP_TIMEOUT_MS
}) {
  if (typeof createContext !== "function" || typeof verifyContext !== "function") {
    throw new TypeError("A public-media render attempt requires injected context creation and verification.");
  }
  for (const value of [attemptTimeoutMilliseconds, cleanupTimeoutMilliseconds]) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new TypeError("Public-media render and cleanup bounds must be positive safe integers.");
    }
  }
  let context;
  let expired = false;
  const work = (async () => {
    const created = await createContext();
    context = created;
    if (expired) {
      await closeContextBounded(created, cleanupTimeoutMilliseconds).catch(() => {});
      throw new Error("A public-media browser context completed after its attempt deadline.");
    }
    return verifyContext(created);
  })();
  let timeout;
  try {
    return await Promise.race([
      work,
      new Promise((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error("One public README media render attempt exceeded its bounded deadline.")),
          attemptTimeoutMilliseconds
        );
      })
    ]);
  } finally {
    expired = true;
    clearTimeout(timeout);
    void work.catch(() => {});
    if (context !== undefined) await closeContextBounded(context, cleanupTimeoutMilliseconds);
  }
}

async function verifyRenderedSurfacesInContext(context, sourceSha, version, displayedImages, representativeImages) {
  const page = await context.newPage();
  for (const surface of publicSurfaceDefinitions(sourceSha)) {
    await page.setViewportSize({ width: Math.max(...PUBLIC_MEDIA_RESPONSIVE_WIDTHS), height: 1_000 });
    await observeRegistryPropagation(surface, "is unavailable", () =>
      page.goto(surface.url, { waitUntil: "domcontentloaded", timeout: 60_000 })
    );
    if (surface.versionKind === "source") {
      assertExactSourceReadmeUrl(page.url(), sourceSha);
    } else if (surface.versionKind === "marketplace") {
      const renderedVersion = page.locator('td[role="definition"][aria-labelledby="version"]');
      const renderedVersionText = await observeRegistryPropagation(surface, "has not exposed its version", async () => {
        await renderedVersion.waitFor({ state: "attached", timeout: 30_000 });
        return (await renderedVersion.innerText()).trim();
      });
      await observeRegistryPropagation(surface, "still exposes stale version metadata", () =>
        assertExpectedSurfaceVersion(surface.name, renderedVersionText, version)
      );
    } else {
      const renderedVersion = page.locator('select[aria-label="Version"]');
      const renderedVersionText = await observeRegistryPropagation(surface, "has not exposed its version", async () => {
        await renderedVersion.waitFor({ state: "attached", timeout: 30_000 });
        return renderedVersion.inputValue();
      });
      await observeRegistryPropagation(surface, "still exposes stale version metadata", () =>
        assertExpectedSurfaceVersion(surface.name, renderedVersionText, version)
      );
    }
    const bodyText = await observeRegistryPropagation(surface, "has not exposed its README", () =>
      page.locator("body").innerText()
    );
    await observeRegistryPropagation(surface, "still exposes stale README content", () =>
      assertExpectedSurfaceContent(surface.name, bodyText)
    );

    for (const expected of displayedImages) {
      const dimensions = await measureRenderedImage(page, surface, expected);
      await observeRegistryPropagation(surface, "still exposes stale README image sources", () =>
        assertRepresentativeImageSource(surface.name, dimensions, expected.url)
      );
      assertRenderedProductImage(surface.name, dimensions, expected);
    }
    for (const width of PUBLIC_MEDIA_RESPONSIVE_WIDTHS) {
      await page.setViewportSize({ width, height: 1_000 });
      for (const expected of representativeImages) {
        const dimensions = await measureRenderedImage(page, surface, expected);
        assertRenderedProductImage(`${surface.name} at ${width}px`, dimensions, expected);
      }
    }
    console.log(
      `Verified version, content, immutable sources, and ${displayedImages.length} DPR ${PUBLIC_MEDIA_PIXEL_RATIO} ` +
        `README images on ${surface.name}, including responsive checks at ${PUBLIC_MEDIA_RESPONSIVE_WIDTHS.join("/")}px.`
    );
  }
}

async function measureRenderedImage(page, surface, expected) {
  const image = page.locator(`img[alt=${JSON.stringify(expected.alt)}]`);
  return observeRegistryPropagation(surface, "has not rendered the complete README image set", async () => {
    if ((await image.count()) !== 1) {
      throw new Error(`${surface.name} must render exactly one README image with alt ${JSON.stringify(expected.alt)}.`);
    }
    await image.waitFor({ state: "attached", timeout: 30_000 });
    await image.scrollIntoViewIfNeeded();
    await image.waitFor({ state: "visible", timeout: 30_000 });
    await page.waitForFunction(
      (expectedAlt) => {
        const matches = [...document.querySelectorAll("img")].filter((element) => element.alt === expectedAlt);
        return matches.length === 1 && matches[0].complete && matches[0].naturalWidth > 0;
      },
      expected.alt,
      { timeout: 30_000 }
    );
    return image.evaluate((element) => {
      let container = element.closest("td");
      for (
        let candidate = element.parentElement;
        container === null && candidate !== null;
        candidate = candidate.parentElement
      ) {
        const display = globalThis.getComputedStyle(candidate).display;
        if (["block", "flex", "grid", "table-cell"].includes(display)) container = candidate;
      }
      container ??= document.body;
      const bounds = element.getBoundingClientRect();
      const containerBounds = container.getBoundingClientRect();
      return {
        alt: element.alt,
        sourceUrl: element.getAttribute("src"),
        currentUrl: element.currentSrc,
        clientWidth: bounds.width,
        clientHeight: bounds.height,
        clientLeft: bounds.left,
        clientRight: bounds.right,
        viewportWidth: globalThis.innerWidth,
        containerWidth: containerBounds.width,
        containerLeft: containerBounds.left,
        containerRight: containerBounds.right,
        naturalWidth: element.naturalWidth,
        naturalHeight: element.naturalHeight,
        devicePixelRatio: globalThis.devicePixelRatio
      };
    });
  });
}

export function assertPngContract(bytes, asset) {
  if (!bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
    throw new Error(`${asset.relativePath} is not a PNG file.`);
  }
  let offset = PNG_SIGNATURE.length;
  let index = 0;
  let idatBytes = 0;
  let sawIdat = false;
  let endedIdat = false;
  let sawSrgb = false;
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const end = offset + 12 + length;
    if (end > bytes.length) throw new Error(`${asset.relativePath} contains a malformed PNG chunk sequence.`);
    const type = bytes.toString("ascii", offset + 4, offset + 8);
    if (!/^[A-Za-z]{4}$/u.test(type)) throw new Error(`${asset.relativePath} contains an invalid PNG chunk type.`);
    const expectedCrc = bytes.readUInt32BE(end - 4);
    const actualCrc = crc32(bytes.subarray(offset + 4, end - 4));
    if (actualCrc !== expectedCrc) throw new Error(`${asset.relativePath} contains an invalid ${type} chunk CRC.`);
    if (index === 0) {
      if (type !== "IHDR" || length !== 13) {
        throw new Error(`${asset.relativePath} must start with one standard PNG IHDR chunk.`);
      }
      const width = bytes.readUInt32BE(offset + 8);
      const height = bytes.readUInt32BE(offset + 12);
      if (
        width !== publicMediaPhysicalLength(asset.logicalWidth) ||
        height !== publicMediaPhysicalLength(asset.logicalHeight)
      ) {
        throw new Error(`${asset.relativePath} differs from its declared exact 2x physical dimensions.`);
      }
      if (
        bytes[offset + 16] !== 8 ||
        (bytes[offset + 17] !== 2 && bytes[offset + 17] !== 6) ||
        bytes[offset + 18] !== 0 ||
        bytes[offset + 19] !== 0 ||
        bytes[offset + 20] !== 0
      ) {
        throw new Error(`${asset.relativePath} must use the reviewed non-interlaced 8-bit RGB or RGBA PNG format.`);
      }
    } else if (type === "IHDR") {
      throw new Error(`${asset.relativePath} contains more than one PNG IHDR chunk.`);
    }
    if (type === "sRGB") {
      if (sawSrgb || sawIdat || length !== 1 || bytes[offset + 8] !== 0) {
        throw new Error(`${asset.relativePath} must declare one standard perceptual sRGB chunk.`);
      }
      sawSrgb = true;
    }
    if (type === "IDAT") {
      if (endedIdat) throw new Error(`${asset.relativePath} contains non-consecutive PNG IDAT chunks.`);
      sawIdat = true;
      idatBytes += length;
    } else if (sawIdat && type !== "IEND") {
      endedIdat = true;
    }
    offset = end;
    index += 1;
    if (type === "IEND") {
      if (length !== 0 || offset !== bytes.length) {
        throw new Error(`${asset.relativePath} contains a malformed PNG terminator.`);
      }
      if (!sawSrgb) throw new Error(`${asset.relativePath} must declare the standard sRGB color space.`);
      if (!sawIdat || idatBytes === 0) throw new Error(`${asset.relativePath} must contain PNG image data.`);
      let decoded;
      try {
        decoded = PNG.sync.read(bytes, { checkCRC: true });
      } catch {
        throw new Error(`${asset.relativePath} could not be decoded as the declared PNG image.`);
      }
      if (
        decoded.width !== publicMediaPhysicalLength(asset.logicalWidth) ||
        decoded.height !== publicMediaPhysicalLength(asset.logicalHeight)
      ) {
        throw new Error(`${asset.relativePath} decoded to unexpected physical dimensions.`);
      }
      return;
    }
  }
  throw new Error(`${asset.relativePath} contains a malformed PNG chunk sequence.`);
}

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

export function inspectLocalPublicMediaInventory(root) {
  const rootMetadata = lstatSync(root);
  if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()) {
    throw new Error("The public-media root must be one real directory.");
  }
  const directories = [{ absolutePath: root, depth: 0 }];
  const files = [];
  let entryCount = 0;
  let totalBytes = 0;
  while (directories.length > 0) {
    const directory = directories.shift();
    const handle = opendirSync(directory.absolutePath);
    try {
      for (let entry = handle.readSync(); entry !== null; entry = handle.readSync()) {
        entryCount += 1;
        if (entryCount > PUBLIC_MEDIA_MAX_INVENTORY_ENTRIES) {
          throw new Error("The public-media inventory exceeds its bounded entry count.");
        }
        const absolutePath = resolve(directory.absolutePath, entry.name);
        const relativePath = relative(root, absolutePath).replaceAll("\\", "/");
        assertBoundedRelativeMediaPath(relativePath);
        const metadata = lstatSync(absolutePath);
        if (metadata.isSymbolicLink()) throw new Error("Public-media inventory may not contain symbolic links.");
        if (metadata.isDirectory()) {
          const depth = directory.depth + 1;
          if (depth > PUBLIC_MEDIA_MAX_DIRECTORY_DEPTH) {
            throw new Error("The public-media inventory exceeds its bounded directory depth.");
          }
          directories.push({ absolutePath, depth });
        } else if (metadata.isFile() && entry.name.endsWith(".png")) {
          if (metadata.size > PUBLIC_MEDIA_MAX_FILE_BYTES) {
            throw new Error(`${relativePath} exceeds the public-media file budget.`);
          }
          totalBytes += metadata.size;
          if (totalBytes > PUBLIC_MEDIA_MAX_TOTAL_BYTES) {
            throw new Error("The complete public-media inventory exceeds its bounded size budget.");
          }
          files.push({
            absolutePath,
            relativePath,
            size: metadata.size,
            device: metadata.dev,
            inode: metadata.ino
          });
        } else {
          throw new Error("Public-media inventory may contain only regular PNG files and directories.");
        }
      }
    } finally {
      handle.closeSync();
    }
  }
  files.sort((left, right) => {
    if (left.relativePath < right.relativePath) return -1;
    if (left.relativePath > right.relativePath) return 1;
    return 0;
  });
  return {
    files,
    byRelativePath: new Map(files.map((file) => [file.relativePath, file])),
    totalBytes
  };
}

export function assertBoundedRelativeMediaPath(relativePath) {
  if (
    typeof relativePath !== "string" ||
    relativePath === "" ||
    Buffer.byteLength(relativePath, "utf8") > PUBLIC_MEDIA_MAX_RELATIVE_PATH_BYTES
  ) {
    throw new Error("The public-media inventory contains an overlong or malformed relative path.");
  }
}

function readPreflightedFile(file) {
  const descriptor = openSync(file.absolutePath, fileSystemConstants.O_RDONLY | (fileSystemConstants.O_NOFOLLOW ?? 0));
  try {
    const metadata = fstatSync(descriptor);
    if (
      !metadata.isFile() ||
      metadata.dev !== file.device ||
      metadata.ino !== file.inode ||
      metadata.size !== file.size ||
      metadata.size > PUBLIC_MEDIA_MAX_FILE_BYTES
    ) {
      throw new Error(`${file.relativePath} changed after public-media inventory preflight.`);
    }
    const bytes = Buffer.allocUnsafe(metadata.size);
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(descriptor, bytes, offset, bytes.length - offset, offset);
      if (count === 0) throw new Error(`${file.relativePath} changed while its bytes were read.`);
      offset += count;
    }
    const trailing = Buffer.allocUnsafe(1);
    if (readSync(descriptor, trailing, 0, 1, offset) !== 0) {
      throw new Error(`${file.relativePath} grew while its bytes were read.`);
    }
    return bytes;
  } finally {
    closeSync(descriptor);
  }
}

async function observeRegistryPropagation(surface, description, operation) {
  try {
    return await operation();
  } catch (error) {
    if (surface.versionKind === "source" || error instanceof RetryablePublicMediaObservationError) throw error;
    throw new RetryablePublicMediaObservationError(`${surface.name} ${description}: ${boundedError(error)}`, {
      cause: error
    });
  }
}

async function closeContextBounded(context, timeoutMilliseconds) {
  let timeout;
  try {
    await Promise.race([
      context.close(),
      new Promise((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error("Public-media browser-context cleanup exceeded its bounded deadline.")),
          timeoutMilliseconds
        );
      })
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

function boundedError(error) {
  const text = (error instanceof Error ? error.message : String(error)).replace(/\s+/gu, " ").trim();
  return text.length <= 320 ? text : `${text.slice(0, 317)}...`;
}

function delay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function readBoundedResponse(response, source) {
  const declaredLength = response.headers.get("content-length");
  if (
    declaredLength !== null &&
    (!/^\d+$/u.test(declaredLength) || Number(declaredLength) > PUBLIC_MEDIA_MAX_FILE_BYTES)
  ) {
    throw new Error(`${source} exceeds the public-media file budget.`);
  }
  if (!response.body) throw new Error(`${source} returned no response body.`);
  const chunks = [];
  let total = 0;
  for await (const chunk of response.body) {
    total += chunk.byteLength;
    if (total > PUBLIC_MEDIA_MAX_FILE_BYTES) {
      await response.body.cancel().catch(() => {});
      throw new Error(`${source} exceeds the public-media file budget.`);
    }
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks, total);
}

async function fetchBounded(source) {
  const response = await fetch(source, {
    headers: { "user-agent": "Open-Wrangler-public-media-verifier" },
    redirect: "follow",
    signal: AbortSignal.timeout(PUBLIC_MEDIA_FETCH_TIMEOUT_MS)
  });
  if (!response.ok) throw new Error(`Could not fetch ${source}: HTTP ${response.status}.`);
  return readBoundedResponse(response, source);
}

if (fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  await main();
}
