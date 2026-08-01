import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { PUBLIC_MEDIA_MAX_FILE_BYTES, PUBLIC_MEDIA_PIXEL_RATIO } from "./public-media-contract.mjs";

const root = resolve(import.meta.dirname, "..");
const productImageRoot = resolve(root, "docs", "images", "readme", "v1.2");
const surfaces = [
  { name: "GitHub", url: "https://github.com/Matt17BR/openwrangler" },
  {
    name: "Visual Studio Marketplace",
    url: "https://marketplace.visualstudio.com/items?itemName=Matt17BR.openwrangler"
  },
  { name: "Open VSX", url: "https://open-vsx.org/extension/Matt17BR/openwrangler" }
];
const representativeImages = [
  "Open Wrangler in VS Code with its dataframe grid, column profiles, and native Activity Bar views",
  "A numeric histogram with an easy-to-target bin and exact interval and row count"
];

await verifyImmutablePublicBytes();
await verifyRenderedDensity();

async function verifyImmutablePublicBytes() {
  const readme = readFileSync(resolve(root, "README.md"), "utf8");
  const references = [...readme.matchAll(/<img\b[^>]*\bsrc="([^"]+)"[^>]*>/giu)]
    .map((match) => immutableProductReference(match[1]))
    .filter((reference) => reference !== undefined);
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

async function verifyRenderedDensity() {
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({
      viewport: { width: 1_440, height: 1_000 },
      deviceScaleFactor: PUBLIC_MEDIA_PIXEL_RATIO
    });
    const page = await context.newPage();
    for (const surface of surfaces) {
      await page.goto(surface.url, { waitUntil: "domcontentloaded", timeout: 60_000 });
      for (const alt of representativeImages) {
        const image = page.locator(`img[alt=${JSON.stringify(alt)}]`).first();
        await image.waitFor({ state: "attached", timeout: 30_000 });
        await image.scrollIntoViewIfNeeded();
        await image.waitFor({ state: "visible", timeout: 30_000 });
        const dimensions = await image.evaluate((element, expectedRatio) => {
          const bounds = element.getBoundingClientRect();
          return {
            clientWidth: bounds.width,
            clientHeight: bounds.height,
            naturalWidth: element.naturalWidth,
            naturalHeight: element.naturalHeight,
            devicePixelRatio: globalThis.devicePixelRatio,
            expectedRatio
          };
        }, PUBLIC_MEDIA_PIXEL_RATIO);
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
            `${surface.name} would upscale ${JSON.stringify(alt)} at DPR ${PUBLIC_MEDIA_PIXEL_RATIO}: ` +
              `${dimensions.naturalWidth}x${dimensions.naturalHeight} natural for ` +
              `${dimensions.clientWidth}x${dimensions.clientHeight} CSS pixels.`
          );
        }
      }
      console.log(`Verified DPR ${PUBLIC_MEDIA_PIXEL_RATIO} rendering on ${surface.name}.`);
    }
  } finally {
    await browser.close();
  }
}

function immutableProductReference(source) {
  let url;
  try {
    url = new URL(source);
  } catch {
    return undefined;
  }
  if (url.hostname !== "raw.githubusercontent.com") return undefined;
  const prefix = "/Matt17BR/openwrangler/";
  if (!url.pathname.startsWith(prefix)) return undefined;
  const remainder = url.pathname.slice(prefix.length);
  const separator = remainder.indexOf("/");
  if (separator < 0 || !/^[0-9a-f]{40}$/u.test(remainder.slice(0, separator))) return undefined;
  const assetPath = remainder.slice(separator + 1);
  const mediaPrefix = "docs/images/readme/v1.2/";
  if (!assetPath.startsWith(mediaPrefix) || !assetPath.endsWith(".png")) return undefined;
  const relativePath = assetPath.slice(mediaPrefix.length);
  if (!relativePath || relativePath.split("/").some((part) => part === "" || part === "." || part === "..")) {
    throw new Error("README contains a malformed public-media path.");
  }
  return { url: url.href, relativePath };
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

if (fileURLToPath(import.meta.url) !== process.argv[1]) {
  throw new Error("The public-media surface verifier must run as a direct script.");
}
