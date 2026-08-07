import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import MarkdownIt from "markdown-it";
import { chromium } from "playwright-core";

import {
  assertRenderedProductImage,
  PUBLIC_MEDIA_MAX_DISPLAY_WIDTH,
  PUBLIC_MEDIA_RESPONSIVE_WIDTHS
} from "./public-media-surface-contract.mjs";

const root = resolve(import.meta.dirname, "..");
const documents = [
  { name: "README", path: "README.md", baseUrl: "http://readme.local/README.md" },
  { name: "gallery", path: "docs/media-gallery.md", baseUrl: "http://readme.local/docs/media-gallery.md" }
];
const markdown = new MarkdownIt({ html: true, linkify: false, typographer: false });

const prepared = documents.map(prepareDocument);
const browser = await chromium.launch({ headless: true });
try {
  for (const document of prepared) await verifyDocument(browser, document);
} finally {
  await browser.close();
}

function prepareDocument(document) {
  const source = readFileSync(resolve(root, document.path), "utf8");
  const images = [];
  const routes = new Map();
  const annotated = source.replace(/<img\b[^>]*>/gu, (tag) => {
    const src = attribute(tag, "src");
    const localPath = repositoryImagePath(src, document.baseUrl);
    if (localPath === undefined || !localPath.startsWith("docs/images/")) return tag;
    if (attribute(tag, "height") !== undefined) {
      throw new Error(`${document.name} screenshot ${localPath} must not declare a height.`);
    }
    const width = Number(attribute(tag, "width"));
    if (!Number.isSafeInteger(width) || width < 1 || width > PUBLIC_MEDIA_MAX_DISPLAY_WIDTH) {
      throw new Error(`${document.name} screenshot ${localPath} has an invalid display width.`);
    }
    const bytes = readFileSync(resolve(root, localPath));
    const { naturalWidth, naturalHeight } = pngDimensions(bytes, localPath);
    const key = `${document.name}-${images.length}`;
    const url = new URL(src, document.baseUrl).href;
    images.push({
      alt: attribute(tag, "alt") ?? "",
      displayWidth: width,
      key,
      naturalHeight,
      naturalWidth,
      url
    });
    routes.set(url, bytes);
    return tag.replace("<img", `<img data-open-wrangler-image="${key}"`);
  });
  if (images.length === 0) throw new Error(`${document.name} has no screenshots to render.`);
  return {
    ...document,
    images,
    routes,
    html: `<!doctype html><html><head><base href="${document.baseUrl}"><style>
      * { box-sizing: border-box; }
      html, body { margin: 0; min-width: 0; width: 100%; }
      body { font: 16px/1.5 system-ui, sans-serif; }
      main { max-width: 100%; overflow-wrap: anywhere; padding: 20px; width: 100%; }
      img { max-width: 100%; }
      table { border-collapse: collapse; display: block; max-width: 100%; overflow-x: auto; width: 100%; }
      td, th { min-width: 0; vertical-align: top; }
    </style></head><body><main>${markdown.render(annotated)}</main></body></html>`
  };
}

async function verifyDocument(browser, document) {
  const context = await browser.newContext({ deviceScaleFactor: 2 });
  await context.route("**/*", async (route) => {
    const bytes = document.routes.get(route.request().url());
    if (bytes !== undefined) {
      await route.fulfill({ body: bytes, contentType: "image/png", status: 200 });
      return;
    }
    if (route.request().resourceType() === "image") {
      await route.fulfill({
        body: '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"/>',
        contentType: "image/svg+xml",
        status: 200
      });
      return;
    }
    await route.abort();
  });
  const page = await context.newPage();
  try {
    await page.setContent(document.html, { waitUntil: "load" });
    for (const viewportWidth of PUBLIC_MEDIA_RESPONSIVE_WIDTHS) {
      await page.setViewportSize({ width: viewportWidth, height: 900 });
      const result = await page.evaluate(() => {
        const root = document.documentElement;
        const measured = [...document.querySelectorAll("img[data-open-wrangler-image]")].map((element) => {
          const container = element.closest("td") ?? element.parentElement ?? document.body;
          const bounds = element.getBoundingClientRect();
          const containerBounds = container.getBoundingClientRect();
          return {
            alt: element.alt,
            clientHeight: bounds.height,
            clientLeft: bounds.left,
            clientRight: bounds.right,
            clientWidth: bounds.width,
            containerLeft: containerBounds.left,
            containerRight: containerBounds.right,
            containerWidth: containerBounds.width,
            currentUrl: element.currentSrc,
            devicePixelRatio: globalThis.devicePixelRatio,
            key: element.dataset.openWranglerImage,
            linked: element.closest("a")?.href.endsWith(".png") === true,
            naturalHeight: element.naturalHeight,
            naturalWidth: element.naturalWidth,
            sourceUrl: element.currentSrc,
            viewportWidth: globalThis.innerWidth
          };
        });
        return { clientWidth: root.clientWidth, measured, scrollWidth: root.scrollWidth };
      });
      assert.ok(
        result.scrollWidth <= result.clientWidth + 1,
        `${document.name} overflows horizontally at ${viewportWidth}px.`
      );
      assert.equal(result.measured.length, document.images.length);
      for (const expected of document.images) {
        const measured = result.measured.find((image) => image.key === expected.key);
        assert.ok(measured, `${document.name} did not render ${expected.key}.`);
        assert.equal(measured.linked, true, `${document.name} screenshot ${expected.alt} is not linked full-size.`);
        assertRenderedProductImage(`${document.name} at ${viewportWidth}px`, measured, expected);
      }
    }
  } finally {
    await page.close();
    await context.close();
  }
}

function attribute(tag, name) {
  return new RegExp(`\\b${name}="([^"]*)"`, "u").exec(tag)?.[1];
}

function repositoryImagePath(src, baseUrl) {
  if (src === undefined) return undefined;
  const url = new URL(src, baseUrl);
  if (url.hostname === "raw.githubusercontent.com") {
    const parts = url.pathname.split("/").filter(Boolean);
    return parts.slice(3).join("/");
  }
  if (url.hostname === "readme.local") return url.pathname.replace(/^\//u, "");
  return undefined;
}

function pngDimensions(bytes, path) {
  if (bytes.length < 24 || bytes.toString("ascii", 1, 4) !== "PNG") throw new Error(`${path} is not a PNG.`);
  return { naturalWidth: bytes.readUInt32BE(16), naturalHeight: bytes.readUInt32BE(20) };
}
