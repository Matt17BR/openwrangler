import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { PUBLIC_MEDIA_MAX_FILE_BYTES, PUBLIC_MEDIA_PIXEL_RATIO } from "./public-media-contract.mjs";
import {
  assertExactSourceReadmeUrl,
  assertExpectedSurfaceContent,
  assertExpectedSurfaceVersion,
  assertRepresentativeImageSource,
  assertSourcePackageVersion,
  expectedRepresentativeReferences,
  extractImmutableProductReferences,
  parsePublicMediaVerifierArguments,
  publicSurfaceDefinitions
} from "./public-media-surface-contract.mjs";

const root = resolve(import.meta.dirname, "..");
const productImageRoot = resolve(root, "docs", "images", "readme", "v1.2");

async function main() {
  const { sourceSha, version } = parsePublicMediaVerifierArguments(process.argv.slice(2));
  const readme = readFileSync(resolve(root, "README.md"), "utf8");
  await verifyExactSource(sourceSha, version, readme);
  await verifyImmutablePublicBytes(readme);
  await verifyRenderedSurfaces(sourceSha, version, readme);
}

async function verifyExactSource(sourceSha, version, localReadme) {
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

async function verifyImmutablePublicBytes(readme) {
  const references = extractImmutableProductReferences(readme);
  if (references.length === 0) throw new Error("README does not expose immutable public product-media URLs.");

  for (const reference of references) {
    const local = readFileSync(resolve(productImageRoot, reference.relativePath));
    if (local.byteLength > PUBLIC_MEDIA_MAX_FILE_BYTES) {
      throw new Error(`${reference.relativePath} exceeds the public-media file budget.`);
    }
    const response = await fetch(reference.url, {
      headers: { "user-agent": "Open-Wrangler-public-media-verifier" },
      redirect: "follow"
    });
    if (!response.ok) throw new Error(`Could not fetch ${reference.url}: HTTP ${response.status}.`);
    const remote = await readBoundedResponse(response, reference.url);
    if (!remote.equals(local)) {
      throw new Error(
        `${reference.relativePath} differs from its immutable remote bytes (${sha256(local)} locally, ${sha256(remote)} remotely).`
      );
    }
  }
  console.log(`Verified ${references.length} immutable public PNG payloads byte-for-byte.`);
}

async function verifyRenderedSurfaces(sourceSha, version, readme) {
  const representativeImages = expectedRepresentativeReferences(readme);
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({
      viewport: { width: 1_440, height: 1_000 },
      deviceScaleFactor: PUBLIC_MEDIA_PIXEL_RATIO
    });
    const page = await context.newPage();
    for (const surface of publicSurfaceDefinitions(sourceSha)) {
      await page.goto(surface.url, { waitUntil: "domcontentloaded", timeout: 60_000 });
      if (surface.versionKind === "source") {
        assertExactSourceReadmeUrl(page.url(), sourceSha);
      } else if (surface.versionKind === "marketplace") {
        const renderedVersion = page.locator('td[role="definition"][aria-labelledby="version"]');
        await renderedVersion.waitFor({ state: "attached", timeout: 30_000 });
        assertExpectedSurfaceVersion(surface.name, (await renderedVersion.innerText()).trim(), version);
      } else {
        const renderedVersion = page.locator('select[aria-label="Version"]');
        await renderedVersion.waitFor({ state: "attached", timeout: 30_000 });
        assertExpectedSurfaceVersion(surface.name, await renderedVersion.inputValue(), version);
      }
      assertExpectedSurfaceContent(surface.name, await page.locator("body").innerText());

      for (const expected of representativeImages) {
        const image = page.locator(`img[alt=${JSON.stringify(expected.alt)}]`);
        if ((await image.count()) !== 1) {
          throw new Error(
            `${surface.name} must render exactly one representative image with alt ${JSON.stringify(expected.alt)}.`
          );
        }
        await image.waitFor({ state: "attached", timeout: 30_000 });
        await image.scrollIntoViewIfNeeded();
        await image.waitFor({ state: "visible", timeout: 30_000 });
        const dimensions = await image.evaluate((element, expectedRatio) => {
          const bounds = element.getBoundingClientRect();
          return {
            alt: element.alt,
            sourceUrl: element.getAttribute("src"),
            currentUrl: element.currentSrc,
            clientWidth: bounds.width,
            clientHeight: bounds.height,
            naturalWidth: element.naturalWidth,
            naturalHeight: element.naturalHeight,
            devicePixelRatio: globalThis.devicePixelRatio,
            expectedRatio
          };
        }, PUBLIC_MEDIA_PIXEL_RATIO);
        assertRepresentativeImageSource(surface.name, dimensions, expected.url);
        if (dimensions.devicePixelRatio !== PUBLIC_MEDIA_PIXEL_RATIO) {
          throw new Error(`${surface.name} did not run at the required DPR ${PUBLIC_MEDIA_PIXEL_RATIO}.`);
        }
        const minimumWidth = Math.ceil(dimensions.clientWidth * PUBLIC_MEDIA_PIXEL_RATIO);
        const minimumHeight = Math.ceil(dimensions.clientHeight * PUBLIC_MEDIA_PIXEL_RATIO);
        if (
          dimensions.clientWidth <= 0 ||
          dimensions.clientHeight <= 0 ||
          dimensions.naturalWidth < minimumWidth ||
          dimensions.naturalHeight < minimumHeight
        ) {
          throw new Error(
            `${surface.name} would upscale ${JSON.stringify(expected.alt)} at DPR ${PUBLIC_MEDIA_PIXEL_RATIO}: ` +
              `${dimensions.naturalWidth}x${dimensions.naturalHeight} natural for ` +
              `${dimensions.clientWidth}x${dimensions.clientHeight} CSS pixels.`
          );
        }
      }
      console.log(
        `Verified version, content, immutable sources, and DPR ${PUBLIC_MEDIA_PIXEL_RATIO} on ${surface.name}.`
      );
    }
  } finally {
    await browser.close();
  }
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
    redirect: "follow"
  });
  if (!response.ok) throw new Error(`Could not fetch ${source}: HTTP ${response.status}.`);
  return readBoundedResponse(response, source);
}

if (fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  await main();
}
