import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pixelmatch from "pixelmatch";
import { chromium } from "playwright-core";
import { PNG } from "pngjs";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const assetsDirectory = resolve(root, "assets");
const reviewDirectory = resolve(root, "tmp", "brand-review");
const iconSourcePath = resolve(assetsDirectory, "icon.svg");
const activitySourcePath = resolve(assetsDirectory, "activity-icon.svg");
const manifestPath = resolve(root, "scripts", "brand-assets.manifest.json");
const outputs = new Map([
  [128, resolve(assetsDirectory, "icon-128.png")],
  [256, resolve(assetsDirectory, "icon-256.png")],
  [512, resolve(assetsDirectory, "icon.png")]
]);
const contactSheetSizes = [16, 24, 32, 48, 72, 128];
const requestedCheck = process.argv.includes("--check");
const requestedRenderCheck = process.argv.includes("--render-check");
const requestedContactSheet = process.argv.includes("--contact-sheet");
const unexpectedArguments = process.argv
  .slice(2)
  .filter((argument) => argument !== "--check" && argument !== "--render-check" && argument !== "--contact-sheet");

if (unexpectedArguments.length > 0) {
  throw new Error(`Unknown brand asset option: ${unexpectedArguments.join(", ")}`);
}
if (requestedCheck && requestedRenderCheck) {
  throw new Error("Brand asset checking accepts either --check or --render-check, not both.");
}
if (requestedCheck && requestedContactSheet) {
  throw new Error("Manifest checking does not render contact sheets.");
}

const iconSource = readFileSync(iconSourcePath, "utf8");
const activitySource = readFileSync(activitySourcePath, "utf8");
assertSafeSvg(iconSource, "gallery icon", "0 0 512 512");
assertSafeSvg(activitySource, "Activity Bar icon", "0 0 24 24");
if (!activitySource.includes("currentColor")) {
  throw new Error("The Activity Bar icon must derive every visible mark from currentColor.");
}

if (requestedCheck) {
  assertAssetManifest(iconSource, activitySource);
  console.log("Brand sources and PNG assets match the generated manifest.");
  process.exitCode = 0;
} else {
  await renderBrandAssets();
}

async function renderBrandAssets() {
  const temporaryDirectory = mkdtempSync(join(tmpdir(), "openwrangler-brand-"));
  const browser = await chromium.launch({ headless: true });

  try {
    const rendered = new Map();
    for (const [size, destination] of outputs) {
      const temporaryPath = resolve(temporaryDirectory, basename(destination));
      await renderSvg(browser, iconSource, size, temporaryPath);
      assertPng(temporaryPath, size, size);
      rendered.set(size, temporaryPath);
    }
    const renderedActivityPath = resolve(temporaryDirectory, "activity-icon.png");
    await renderSvg(browser, activitySource, 24, renderedActivityPath);
    assertPng(renderedActivityPath, 24, 24);
    assertMaximumTransparentInsets(rendered.get(512), {
      top: 8,
      right: 8,
      bottom: 8,
      left: 8
    });
    assertMaximumTransparentInsets(renderedActivityPath, {
      top: 1,
      right: 0,
      bottom: 1,
      left: 0
    });

    if (requestedRenderCheck) {
      for (const [size, destination] of outputs) {
        assertEquivalentPng(rendered.get(size), destination, size);
      }
    } else {
      for (const [size, destination] of outputs) {
        writeFileSync(destination, readFileSync(rendered.get(size)));
      }
      writeAssetManifest(iconSource, activitySource);
    }

    if (requestedContactSheet) {
      mkdirSync(reviewDirectory, { recursive: true });
      const gallerySheetPath = resolve(reviewDirectory, "icon-contact-sheet.png");
      const activitySheetPath = resolve(reviewDirectory, "activity-icon-contact-sheet.png");
      await renderGalleryContactSheet(browser, iconSource, gallerySheetPath);
      await renderActivityContactSheet(browser, activitySource, activitySheetPath);
      assertPng(gallerySheetPath, 1_480, 1_320);
      assertPng(activitySheetPath, 1_100, 430);
      console.log(`Rendered ${gallerySheetPath}`);
      console.log(`Rendered ${activitySheetPath}`);
    }

    console.log(
      requestedRenderCheck
        ? "Brand SVG sources and generated PNG assets match pixel for pixel."
        : "Generated 128, 256, and 512 pixel brand PNG assets."
    );
  } finally {
    await browser.close();
    rmSync(temporaryDirectory, { force: true, recursive: true });
  }
}

function assertSafeSvg(source, label, expectedViewBox) {
  if (!source.includes(`viewBox="${expectedViewBox}"`)) {
    throw new Error(`The ${label} must use viewBox ${expectedViewBox}.`);
  }
  if (
    /<(?:script|foreignObject|image|use|filter)\b/iu.test(source) ||
    /\b(?:href|xlink:href|style)=/iu.test(source) ||
    /url\s*\(/iu.test(source)
  ) {
    throw new Error(`The ${label} must remain a self-contained, script-free vector.`);
  }
}

async function renderSvg(activeBrowser, source, size, destination) {
  const page = await activeBrowser.newPage({
    viewport: { width: size, height: size }
  });
  try {
    await page.setContent(
      `<!doctype html><style>html,body{margin:0;width:100%;height:100%;background:transparent}svg{display:block;width:100%;height:100%}</style>${source}`
    );
    await page.screenshot({
      path: destination,
      omitBackground: true
    });
  } finally {
    await page.close();
  }
}

function assertPng(path, expectedWidth, expectedHeight) {
  const png = PNG.sync.read(readFileSync(path));
  if (png.width !== expectedWidth || png.height !== expectedHeight) {
    throw new Error(`${basename(path)} is ${png.width}x${png.height}; expected ${expectedWidth}x${expectedHeight}.`);
  }
}

function assertMaximumTransparentInsets(path, maximumInsets) {
  const png = PNG.sync.read(readFileSync(path));
  let minX = png.width;
  let minY = png.height;
  let maxX = -1;
  let maxY = -1;

  for (let y = 0; y < png.height; y += 1) {
    for (let x = 0; x < png.width; x += 1) {
      if (png.data[(y * png.width + x) * 4 + 3] === 0) continue;
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
  }

  if (maxX < 0 || maxY < 0) {
    throw new Error(`${basename(path)} rendered without any visible pixels.`);
  }
  const actualInsets = {
    top: minY,
    right: png.width - maxX - 1,
    bottom: png.height - maxY - 1,
    left: minX
  };
  for (const side of ["top", "right", "bottom", "left"]) {
    if (actualInsets[side] > maximumInsets[side]) {
      throw new Error(
        `${basename(path)} leaves ${actualInsets[side]} transparent pixels on the ${side}; expected at most ${maximumInsets[side]}.`
      );
    }
  }
}

function assertEquivalentPng(actualPath, expectedPath, size) {
  const actual = PNG.sync.read(readFileSync(actualPath));
  const expected = PNG.sync.read(readFileSync(expectedPath));
  if (actual.width !== expected.width || actual.height !== expected.height) {
    throw new Error(`${basename(expectedPath)} does not have the generated ${size}x${size} dimensions.`);
  }
  const differences = pixelmatch(actual.data, expected.data, undefined, size, size, {
    threshold: 0
  });
  if (differences !== 0) {
    throw new Error(`${basename(expectedPath)} differs from the SVG master at ${differences} pixels.`);
  }
}

function writeAssetManifest(icon, activity) {
  const manifest = {
    version: 1,
    sources: {
      "activity-icon.svg": sha256(activity),
      "icon.svg": sha256(icon)
    },
    outputs: Object.fromEntries(
      [...outputs.entries()].map(([size, path]) => [
        basename(path),
        {
          size,
          sha256: sha256(readFileSync(path))
        }
      ])
    )
  };
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}

function assertAssetManifest(icon, activity) {
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch {
    throw new Error("The generated brand asset manifest is missing or malformed.");
  }
  if (
    manifest?.version !== 1 ||
    manifest.sources?.["icon.svg"] !== sha256(icon) ||
    manifest.sources?.["activity-icon.svg"] !== sha256(activity)
  ) {
    throw new Error("The brand SVG sources differ from the generated asset manifest.");
  }
  for (const [size, path] of outputs) {
    assertPng(path, size, size);
    const entry = manifest.outputs?.[basename(path)];
    if (entry?.size !== size || entry?.sha256 !== sha256(readFileSync(path))) {
      throw new Error(`${basename(path)} differs from the generated brand asset manifest.`);
    }
  }
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function renderGalleryContactSheet(activeBrowser, source, destination) {
  const page = await activeBrowser.newPage({
    viewport: { width: 1_480, height: 1_320 }
  });
  const encoded = svgDataUrl(source);
  const compactCards = ["light", "dark"]
    .map(
      (theme) => `
        <section class="compact ${theme}">
          <h2>${theme === "light" ? "Light surface" : "Dark surface"}</h2>
          <div class="sizes">
            ${contactSheetSizes
              .map(
                (size) => `
                  <figure>
                    <div class="icon-slot"><img src="${encoded}" width="${size}" height="${size}" alt=""></div>
                    <figcaption>${size} px</figcaption>
                  </figure>`
              )
              .join("")}
          </div>
        </section>`
    )
    .join("");
  const largeCards = ["light", "dark"]
    .map(
      (theme) => `
        <figure class="large ${theme}">
          <img src="${encoded}" width="512" height="512" alt="">
          <figcaption>512 px, ${theme} surface</figcaption>
        </figure>`
    )
    .join("");
  await page.setContent(`<!doctype html>
    <style>
      *{box-sizing:border-box}
      html,body{margin:0;width:100%;height:100%;font-family:Arial,sans-serif;background:#d8dce5;color:#111827}
      body{padding:36px}
      h1{font-size:28px;margin:0 0 8px}
      p{margin:0 0 24px;color:#4b5563}
      .compact{border-radius:18px;padding:20px 24px;margin:0 0 18px}
      .light{background:#f7f8fa;color:#111827}
      .dark{background:#17191e;color:#f4f6fb}
      h2{font-size:17px;margin:0 0 16px}
      .sizes{display:grid;grid-template-columns:repeat(6,1fr);gap:12px}
      figure{margin:0}
      .icon-slot{height:132px;display:grid;place-items:center;border:1px solid rgba(127,127,127,.22);border-radius:12px}
      figcaption{text-align:center;font-size:13px;margin-top:8px;opacity:.8}
      .large-grid{display:grid;grid-template-columns:1fr 1fr;gap:18px;margin-top:20px}
      .large{border-radius:18px;height:570px;display:grid;place-items:center;padding:18px}
      .large figcaption{display:none}
      img{display:block}
    </style>
    <h1>Open Wrangler gallery icon validation</h1>
    <p>SVG master rendered at exact output sizes. No CSS scaling is applied.</p>
    ${compactCards}
    <div class="large-grid">${largeCards}</div>`);
  await page.screenshot({ path: destination });
  await page.close();
}

async function renderActivityContactSheet(activeBrowser, source, destination) {
  const page = await activeBrowser.newPage({
    viewport: { width: 1_100, height: 430 }
  });
  const sizes = [16, 24, 32, 48, 72];
  const sections = [
    ["VS Code dark", "#181818", "#c5c5c5"],
    ["VS Code light", "#f3f3f3", "#424242"]
  ]
    .map(([label, background, foreground]) => {
      const themedSource = source.replaceAll("currentColor", foreground);
      const encoded = svgDataUrl(themedSource);
      return `
        <section style="background:${background};color:${foreground}">
          <h2>${label}</h2>
          <div class="sizes">
            ${sizes
              .map(
                (size) => `
                  <figure>
                    <div class="icon-slot" style="color:${foreground}">
                      <img src="${encoded}" width="${size}" height="${size}" alt="">
                    </div>
                    <figcaption>${size} px</figcaption>
                  </figure>`
              )
              .join("")}
          </div>
        </section>`;
    })
    .join("");
  await page.setContent(`<!doctype html>
    <style>
      *{box-sizing:border-box}
      html,body{margin:0;width:100%;height:100%;font-family:Arial,sans-serif;background:#d8dce5;color:#111827}
      body{padding:28px}
      h1{font-size:24px;margin:0 0 18px}
      .grid{display:grid;grid-template-columns:1fr 1fr;gap:18px}
      section{height:320px;border-radius:16px;padding:22px}
      h2{font-size:17px;margin:0 0 28px}
      .sizes{display:grid;grid-template-columns:repeat(5,1fr);gap:10px}
      figure{margin:0;text-align:center}
      .icon-slot{height:150px;display:grid;place-items:center}
      figcaption{font-size:12px;opacity:.8}
      img{display:block}
    </style>
    <h1>Open Wrangler Activity Bar icon validation</h1>
    <div class="grid">${sections}</div>`);
  await page.screenshot({ path: destination });
  await page.close();
}

function svgDataUrl(source) {
  return `data:image/svg+xml;base64,${Buffer.from(source).toString("base64")}`;
}
