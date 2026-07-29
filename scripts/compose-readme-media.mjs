import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pixelmatch from "pixelmatch";
import { chromium } from "playwright-core";
import { PNG } from "pngjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const editorImages = resolve(root, "docs", "images", "editor-acceptance");
const readmeImages = resolve(root, "docs", "images", "readme", "v1.1");
const verify = process.argv.includes("--verify");
const unexpectedArguments = process.argv.slice(2).filter((argument) => argument !== "--verify");

if (unexpectedArguments.length > 0) {
  throw new Error(`Unknown README media option: ${unexpectedArguments.join(", ")}`);
}

const compositions = [
  {
    name: "workbench",
    width: 1_920,
    height: 830,
    destination: resolve(readmeImages, "workbench.png"),
    sources: {
      dark: sourceImage("vscode-hero-dark.png", 1_920, 830),
      light: sourceImage("vscode-hero-light.png", 1_920, 830)
    },
    render: renderWorkbench
  },
  {
    name: "notebooks",
    width: 1_920,
    height: 450,
    destination: resolve(readmeImages, "notebooks.png"),
    sources: {
      pandas: sourceImage("vscode-notebook-pandas-dark.png", 1_920, 450)
    },
    render: renderNotebooks
  },
  {
    name: "notebook-polars",
    width: 1_920,
    height: 760,
    destination: resolve(readmeImages, "gallery", "notebook-polars.png"),
    sources: {
      polars: sourceImage("vscode-notebook-polars-dark.png", 1_920, 760)
    },
    render: renderPolarsNotebook
  },
  {
    name: "pyspark-live-notebook",
    width: 1_440,
    height: 640,
    destination: resolve(readmeImages, "gallery", "pyspark-live-notebook.png"),
    sources: {
      pyspark: sourceImage("vscode-notebook-pyspark-dark.png", 1_920, 640)
    },
    render: renderPySparkNotebook
  }
];

const temporaryDirectory = mkdtempSync(join(tmpdir(), "openwrangler-readme-media-"));
const browser = await chromium.launch({ headless: true });

try {
  mkdirSync(readmeImages, { recursive: true });
  for (const composition of compositions) {
    const temporaryPath = resolve(temporaryDirectory, `${composition.name}.png`);
    await renderComposition(browser, composition, temporaryPath);
    if (verify) {
      assertEquivalentPng(temporaryPath, composition.destination, composition.width, composition.height);
    } else {
      writeFileSync(composition.destination, readFileSync(temporaryPath));
    }
    console.log(`${verify ? "Verified" : "Rendered"} ${composition.destination}`);
  }
} finally {
  await browser.close();
  rmSync(temporaryDirectory, { force: true, recursive: true });
}

function sourceImage(name, width, height) {
  const path = resolve(editorImages, name);
  const bytes = readFileSync(path);
  const image = PNG.sync.read(bytes);
  if (image.width !== width || image.height !== height) {
    throw new Error(`${name} is ${image.width}x${image.height}; expected ${width}x${height}.`);
  }
  return {
    name,
    dataUrl: `data:image/png;base64,${bytes.toString("base64")}`
  };
}

async function renderComposition(activeBrowser, composition, destination) {
  const page = await activeBrowser.newPage({
    deviceScaleFactor: 1,
    viewport: {
      width: composition.width,
      height: composition.height
    }
  });
  try {
    await page.setContent(composition.render(composition.sources), { waitUntil: "load" });
    await page.evaluate(async () => {
      await document.fonts.ready;
      const images = [...document.images];
      await Promise.all(
        images.map(
          (image) =>
            image.complete ||
            new Promise((resolveImage, rejectImage) => {
              image.addEventListener("load", resolveImage, { once: true });
              image.addEventListener("error", rejectImage, { once: true });
            })
        )
      );
    });
    const png = await page.screenshot({
      animations: "disabled",
      caret: "hide",
      fullPage: false
    });
    writeFileSync(destination, addSrgbChunk(png));
    assertPng(destination, composition.width, composition.height, true);
  } finally {
    await page.close();
  }
}

function renderWorkbench(sources) {
  return documentTemplate(
    "The same Open Wrangler workbench in the default VS Code light and dark themes",
    `
      <main class="workbench">
        <img class="workbenchImage" src="${sources.dark.dataUrl}" alt="">
        <div class="lightHalf">
          <img class="workbenchImage" src="${sources.light.dataUrl}" alt="">
        </div>
      </main>
    `,
    `
      .workbench {
        height: 100%;
        overflow: hidden;
        position: relative;
        width: 100%;
      }
      .workbenchImage {
        display: block;
        height: 830px;
        position: absolute;
        width: 1920px;
      }
      .lightHalf {
        bottom: 0;
        left: 0;
        overflow: hidden;
        position: absolute;
        top: 0;
        width: 50%;
      }
    `
  );
}

function renderNotebooks(sources) {
  return documentTemplate(
    "Open Wrangler Pandas dataframe preview inside a real VS Code notebook",
    `
      <img class="nativeCapture" src="${sources.pandas.dataUrl}" alt="">
    `,
    `
      .nativeCapture {
        display: block;
        height: 450px;
        width: 1920px;
      }
    `
  );
}

function renderPolarsNotebook(sources) {
  return documentTemplate(
    "Open Wrangler live Polars dataframe workflow in VS Code",
    `<img class="nativeCapture" src="${sources.polars.dataUrl}" alt="">`,
    `
      .nativeCapture {
        display: block;
        height: 760px;
        width: 1920px;
      }
    `
  );
}

function renderPySparkNotebook(sources) {
  return documentTemplate(
    "Open Wrangler experimental live PySpark notebook session",
    `
      <main class="pysparkCard">
        <header class="pysparkHeader">
          <div>
            <h1>PySpark Classic live notebook</h1>
            <p>Real 100,000 x 15 regional-orders DataFrame through the packaged VS Code and Jupyter path</p>
          </div>
          <div class="badges" aria-label="PySpark support status">
            <span class="engineBadge">PySpark 4.2</span>
            <span class="statusBadge">Experimental</span>
            <span class="statusBadge">Viewing only</span>
          </div>
        </header>
        <div class="pysparkStage">
          <img src="${sources.pyspark.dataUrl}" alt="">
        </div>
        <footer class="pysparkFooter">
          Live notebook variable · Spark-side filtering, sorting, paging, and profiling · no cleaning or export
        </footer>
      </main>
    `,
    `
      body {
        background:
          radial-gradient(circle at 80% -60%, rgba(20, 184, 166, 0.26), transparent 55%),
          #070b12;
      }
      .pysparkCard {
        color: #f8fafc;
        height: 100%;
        padding: 16px;
        width: 100%;
      }
      .pysparkHeader {
        align-items: center;
        display: flex;
        height: 70px;
        justify-content: space-between;
        padding: 0 14px;
      }
      .pysparkHeader h1 {
        font-size: 19px;
        line-height: 24px;
        margin: 0;
      }
      .pysparkHeader p {
        color: #94a3b8;
        font-size: 11px;
        line-height: 15px;
        margin: 3px 0 0;
      }
      .badges {
        align-items: center;
        display: flex;
        gap: 8px;
      }
      .badges span {
        border: 1px solid currentColor;
        border-radius: 999px;
        font-size: 10px;
        font-weight: 700;
        letter-spacing: 0.05em;
        padding: 5px 9px;
        text-transform: uppercase;
      }
      .engineBadge { color: #fbbf24; }
      .statusBadge { color: #5eead4; }
      .pysparkStage {
        background: #181818;
        border: 1px solid #334155;
        border-radius: 8px;
        height: 470px;
        overflow: hidden;
        width: 100%;
      }
      .pysparkStage img {
        display: block;
        height: auto;
        width: 100%;
      }
      .pysparkFooter {
        align-items: center;
        color: #94a3b8;
        display: flex;
        font-size: 11px;
        height: 68px;
        justify-content: center;
        letter-spacing: 0.02em;
      }
    `
  );
}

function documentTemplate(accessibleTitle, body, styles) {
  return `<!doctype html>
    <html lang="en">
      <head>
        <meta charset="utf-8">
        <meta name="color-scheme" content="dark light">
        <title>${accessibleTitle}</title>
        <style>
          * { box-sizing: border-box; }
          html, body { height: 100%; margin: 0; overflow: hidden; width: 100%; }
          body { font-family: "Liberation Sans", Arial, sans-serif; }
          ${styles}
        </style>
      </head>
      <body>${body}</body>
    </html>`;
}

function assertPng(path, expectedWidth, expectedHeight, requireSrgb) {
  const bytes = readFileSync(path);
  const png = PNG.sync.read(bytes);
  if (png.width !== expectedWidth || png.height !== expectedHeight) {
    throw new Error(`${basename(path)} is ${png.width}x${png.height}; expected ${expectedWidth}x${expectedHeight}.`);
  }
  if (requireSrgb && !pngChunkTypes(bytes).includes("sRGB")) {
    throw new Error(`${basename(path)} must declare the standard sRGB color space.`);
  }
}

function assertEquivalentPng(actualPath, expectedPath, width, height) {
  assertPng(actualPath, width, height, true);
  assertPng(expectedPath, width, height, true);
  const actual = PNG.sync.read(readFileSync(actualPath));
  const expected = PNG.sync.read(readFileSync(expectedPath));
  const differences = pixelmatch(actual.data, expected.data, undefined, width, height, {
    threshold: 0
  });
  if (differences !== 0) {
    throw new Error(`${basename(expectedPath)} differs from its deterministic composition at ${differences} pixels.`);
  }
}

function addSrgbChunk(png) {
  const chunks = pngChunkTypes(png);
  if (chunks.includes("sRGB")) return png;
  if (chunks[0] !== "IHDR") throw new Error("A composed README image must start with a PNG IHDR chunk.");
  const ihdrLength = png.readUInt32BE(8);
  const insertOffset = 8 + 12 + ihdrLength;
  const type = Buffer.from("sRGB", "ascii");
  const data = Buffer.from([0]);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([type, data])));
  const chunk = Buffer.concat([length, type, data, crc]);
  return Buffer.concat([png.subarray(0, insertOffset), chunk, png.subarray(insertOffset)]);
}

function pngChunkTypes(png) {
  if (!png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    throw new Error("README media must be a PNG file.");
  }
  const types = [];
  let offset = 8;
  while (offset + 12 <= png.length) {
    const length = png.readUInt32BE(offset);
    const type = png.toString("ascii", offset + 4, offset + 8);
    types.push(type);
    offset += length + 12;
    if (type === "IEND") break;
  }
  if (types.at(-1) !== "IEND" || offset !== png.length) {
    throw new Error("README media contains a malformed PNG chunk sequence.");
  }
  return types;
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
