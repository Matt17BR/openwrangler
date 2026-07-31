import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pixelmatch from "pixelmatch";
import { PNG } from "pngjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const editorImages = resolve(root, "docs", "images", "editor-acceptance");
const acceptanceImages = resolve(root, "docs", "images", "acceptance");
const readmeImages = resolve(root, "docs", "images", "readme", "v1.2");
const verify = process.argv.includes("--verify");
const unexpectedArguments = process.argv.slice(2).filter((argument) => argument !== "--verify");

if (unexpectedArguments.length > 0) {
  throw new Error(`Unknown README media option: ${unexpectedArguments.join(", ")}`);
}

const assets = [
  nativeAsset("explore.png", "vscode-explore-dark.png", 1_440, 870),
  nativeAsset("filter-result.png", "vscode-filter-result-dark.png", 1_440, 862),
  nativeAsset("workflow.png", "vscode-workflow-dark.png", 1_440, 870),
  nativeCrop("notebook-pandas.png", "vscode-notebook-pandas-dark.png", 1_280, 600, {
    x: 45,
    y: 25,
    width: 1_210,
    height: 540
  }),
  nativeAsset("gallery/column-search-wide.png", "vscode-column-search-wide-dark.png", 1_440, 865),
  nativeAsset("gallery/file-explorer-action.png", "vscode-file-explorer-action-dark.png", 1_440, 870),
  nativeAsset("gallery/high-contrast-explore.png", "vscode-high-contrast-explore-high-contrast.png", 1_440, 846),
  nativeAsset("gallery/import-options.png", "vscode-import-options-dark.png", 1_440, 870),
  nativeAsset("gallery/export-script.png", "vscode-export-code-dark.png", 1_440, 870),
  nativeAsset("gallery/export-data.png", "vscode-export-data-dark.png", 1_440, 870),
  nativeAsset("gallery/cursor-explore.png", "cursor-explore-dark.png", 1_440, 865),
  nativeCrop("gallery/notebook-variable-picker.png", "vscode-notebook-variable-picker-dark.png", 1_440, 900, {
    x: 45,
    y: 20,
    width: 1_040,
    height: 590
  }),
  nativeCrop("gallery/notebook-code-insertion.png", "vscode-notebook-code-insertion-dark.png", 1_440, 900, {
    x: 45,
    y: 29,
    width: 1_000,
    height: 288
  }),
  nativeAsset("gallery/notebook-polars.png", "vscode-notebook-polars-dark.png", 1_440, 900),
  nativeAsset("gallery/notebook-duckdb.png", "vscode-notebook-duckdb-dark.png", 1_440, 900),
  nativeAsset("gallery/notebook-pyspark.png", "vscode-notebook-pyspark-dark.png", 1_440, 900),
  nativeAsset("gallery/sidebar-overview.png", "vscode-sidebar-overview-dark.png", 1_440, 874),
  nativeAsset("gallery/operation-catalog.png", "vscode-operation-catalog-dark.png", 1_280, 874),
  nativeAsset("gallery/operation-configuration.png", "vscode-operation-configuration-dark.png", 1_280, 874),
  nativeAsset("gallery/applied-step-inspection.png", "vscode-applied-step-inspection-dark.png", 1_440, 870),
  nativeAsset("gallery/latest-step-edited.png", "vscode-latest-step-edited-dark.png", 1_440, 865),
  nativeAsset("gallery/latest-step-undone.png", "vscode-latest-step-undone-dark.png", 1_440, 865),
  nativeCrop("gallery/file-explorer-action-detail.png", "vscode-file-explorer-action-dark.png", 1_440, 870, {
    x: 48,
    y: 0,
    width: 920,
    height: 616
  }),
  nativeCrop("gallery/column-search-wide-detail.png", "vscode-column-search-wide-dark.png", 1_440, 865, {
    x: 850,
    y: 54,
    width: 540,
    height: 420
  }),
  nativeCrop("gallery/latest-step-edited-detail.png", "vscode-latest-step-edited-dark.png", 1_440, 865, {
    x: 0,
    y: 0,
    width: 448,
    height: 440
  }),
  nativeCrop("gallery/latest-step-undone-detail.png", "vscode-latest-step-undone-dark.png", 1_440, 865, {
    x: 0,
    y: 0,
    width: 448,
    height: 440
  }),
  nativeCrop("gallery/notebook-code-insertion-detail.png", "vscode-notebook-code-insertion-dark.png", 1_440, 900, {
    x: 45,
    y: 29,
    width: 1_000,
    height: 288
  }),
  nativeCrop("gallery/operation-configuration-detail.png", "vscode-operation-configuration-dark.png", 1_280, 874, {
    x: 744,
    y: 170,
    width: 510,
    height: 605
  }),
  nativeCrop("gallery/applied-step-inspection-detail.png", "vscode-applied-step-inspection-dark.png", 1_440, 870, {
    x: 445,
    y: 28,
    width: 995,
    height: 320
  }),
  nativeCrop("gallery/export-script-detail.png", "vscode-export-code-dark.png", 1_440, 870, {
    x: 445,
    y: 0,
    width: 995,
    height: 230
  }),
  nativeCrop("gallery/export-data-detail.png", "vscode-export-data-dark.png", 1_440, 870, {
    x: 445,
    y: 0,
    width: 995,
    height: 344
  }),
  nativeCrop("gallery/notebook-variable-picker-detail.png", "vscode-notebook-variable-picker-dark.png", 1_440, 900, {
    x: 420,
    y: 31,
    width: 602,
    height: 380
  }),
  nativeCrop("gallery/notebook-pandas-detail.png", "vscode-notebook-pandas-dark.png", 1_280, 600, {
    x: 52,
    y: 148,
    width: 1_205,
    height: 370
  }),
  nativeCrop("gallery/notebook-polars-detail.png", "vscode-notebook-polars-dark.png", 1_440, 900, {
    x: 48,
    y: 32,
    width: 1_372,
    height: 758
  }),
  nativeCrop("gallery/notebook-duckdb-detail.png", "vscode-notebook-duckdb-dark.png", 1_440, 900, {
    x: 48,
    y: 32,
    width: 1_372,
    height: 868
  }),
  nativeCrop("gallery/notebook-pyspark-detail.png", "vscode-notebook-pyspark-dark.png", 1_440, 900, {
    x: 48,
    y: 32,
    width: 1_372,
    height: 820
  }),
  nativeCrop("gallery/sidebar-explore.png", "vscode-explore-dark.png", 1_440, 870, {
    x: 0,
    y: 0,
    width: 448,
    height: 500
  }),
  nativeCrop("gallery/sidebar-workflow.png", "vscode-workflow-dark.png", 1_440, 870, {
    x: 0,
    y: 0,
    width: 448,
    height: 500
  }),
  nativeCrop("gallery/histogram-hover.png", "vscode-histogram-hover-dark.png", 1_440, 870, {
    x: 992,
    y: 160,
    width: 448,
    height: 480
  }),
  nativeCrop("gallery/sort-priority.png", "vscode-sort-priority-dark.png", 1_440, 870, {
    x: 0,
    y: 60,
    width: 448,
    height: 480
  }),
  acceptanceCrop("gallery/by-example-setup.png", "by-example-dialog-dark-1280.png", 1_280, 960, {
    x: 100,
    y: 100,
    width: 1_080,
    height: 760
  }),
  acceptanceCrop("gallery/by-example-setup-detail.png", "by-example-dialog-dark-1280.png", 1_280, 960, {
    x: 520,
    y: 100,
    width: 660,
    height: 760
  }),
  acceptanceCrop("gallery/by-example-preview.png", "by-example-preview-dark-1280.png", 1_280, 760, {
    x: 0,
    y: 0,
    width: 1_280,
    height: 760
  }),
  acceptanceCrop("gallery/by-example-preview-detail.png", "by-example-preview-dark-1280.png", 1_280, 760, {
    x: 0,
    y: 55,
    width: 700,
    height: 525
  }),
  nativeCrop("gallery/file-title-action.png", "vscode-file-title-action.png", 1_440, 865, {
    x: 0,
    y: 0,
    width: 1_440,
    height: 120
  }),
  nativeCrop("gallery/tab-context-menu.png", "vscode-tab-context-menu.png", 1_440, 865, {
    x: 0,
    y: 0,
    width: 540,
    height: 570
  }),
  readmeCrop("gallery/duckdb-rich-parquet-detail.png", "gallery/duckdb-rich-parquet.png", 1_920, 640, {
    x: 0,
    y: 45,
    width: 1_500,
    height: 595
  })
];

for (const asset of assets) {
  const source = readFileSync(asset.source);
  assertPng(source, asset.source, asset.sourceWidth, asset.sourceHeight, false);
  const rendered = asset.crop ? cropPng(source, asset.crop) : source;
  const portable = addSrgbChunk(rendered);
  const destination = resolve(readmeImages, asset.destination);
  mkdirSync(dirname(destination), { recursive: true });
  if (verify) {
    const expected = readFileSync(destination);
    assertEquivalentPng(portable, expected, destination, asset.outputWidth, asset.outputHeight);
  } else {
    writeFileSync(destination, portable);
  }
  console.log(`${verify ? "Verified" : "Copied"} ${destination}`);
}

function nativeAsset(destination, sourceName, width, height) {
  return {
    destination,
    source: resolve(editorImages, sourceName),
    sourceWidth: width,
    sourceHeight: height,
    outputWidth: width,
    outputHeight: height
  };
}

function nativeCrop(destination, sourceName, sourceWidth, sourceHeight, crop) {
  return {
    destination,
    source: resolve(editorImages, sourceName),
    sourceWidth,
    sourceHeight,
    outputWidth: crop.width,
    outputHeight: crop.height,
    crop
  };
}

function acceptanceCrop(destination, sourceName, sourceWidth, sourceHeight, crop) {
  return {
    destination,
    source: resolve(acceptanceImages, sourceName),
    sourceWidth,
    sourceHeight,
    outputWidth: crop.width,
    outputHeight: crop.height,
    crop
  };
}

function readmeCrop(destination, sourceName, sourceWidth, sourceHeight, crop) {
  return {
    destination,
    source: resolve(readmeImages, sourceName),
    sourceWidth,
    sourceHeight,
    outputWidth: crop.width,
    outputHeight: crop.height,
    crop
  };
}

function cropPng(bytes, crop) {
  const source = PNG.sync.read(bytes);
  if (
    crop.x < 0 ||
    crop.y < 0 ||
    crop.width <= 0 ||
    crop.height <= 0 ||
    crop.x + crop.width > source.width ||
    crop.y + crop.height > source.height
  ) {
    throw new Error("README media crop must stay within its accepted native capture.");
  }
  const result = new PNG({ width: crop.width, height: crop.height });
  for (let row = 0; row < crop.height; row += 1) {
    const sourceStart = ((crop.y + row) * source.width + crop.x) * 4;
    const sourceEnd = sourceStart + crop.width * 4;
    source.data.copy(result.data, row * crop.width * 4, sourceStart, sourceEnd);
  }
  return PNG.sync.write(result);
}

function assertPng(bytes, path, expectedWidth, expectedHeight, requireSrgb) {
  const image = PNG.sync.read(bytes);
  if (image.width !== expectedWidth || image.height !== expectedHeight) {
    throw new Error(
      `${basename(path)} is ${image.width}x${image.height}; expected ${expectedWidth}x${expectedHeight}.`
    );
  }
  if (requireSrgb && !pngChunkTypes(bytes).includes("sRGB")) {
    throw new Error(`${basename(path)} must declare the standard sRGB color space.`);
  }
}

function assertEquivalentPng(actual, expected, path, width, height) {
  assertPng(actual, path, width, height, true);
  assertPng(expected, path, width, height, true);
  const actualImage = PNG.sync.read(actual);
  const expectedImage = PNG.sync.read(expected);
  const differences = pixelmatch(actualImage.data, expectedImage.data, undefined, width, height, {
    threshold: 0
  });
  if (differences !== 0) {
    throw new Error(`${basename(path)} differs from its accepted native capture at ${differences} pixels.`);
  }
}

function addSrgbChunk(png) {
  const chunks = pngChunkTypes(png);
  if (chunks.includes("sRGB")) return png;
  if (chunks[0] !== "IHDR") throw new Error("README media must start with a PNG IHDR chunk.");
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
