import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { PNG } from "pngjs";

const root = resolve(import.meta.dirname, "..");

const nativeAssets = [
  nativeAsset("explore.png", "vscode-explore-dark.png", 1_440, 870),
  nativeAsset("workflow.png", "vscode-workflow-dark.png", 1_440, 870),
  nativeAsset("notebook-pandas.png", "vscode-notebook-pandas-dark.png", 1_280, 600),
  nativeAsset("gallery/column-search-wide.png", "vscode-column-search-wide-dark.png", 1_440, 865),
  nativeAsset("gallery/import-options.png", "vscode-import-options-dark.png", 1_440, 870),
  nativeAsset("gallery/export-script.png", "vscode-export-code-dark.png", 1_440, 870),
  nativeAsset("gallery/export-data.png", "vscode-export-data-dark.png", 1_440, 870),
  nativeAsset("gallery/cursor-explore.png", "cursor-explore-dark.png", 1_440, 865),
  nativeAsset("gallery/notebook-variable-picker.png", "vscode-notebook-variable-picker-dark.png", 1_280, 600),
  nativeAsset("gallery/notebook-polars.png", "vscode-notebook-polars-dark.png", 1_440, 900),
  nativeAsset("gallery/notebook-duckdb.png", "vscode-notebook-duckdb-dark.png", 1_440, 900),
  nativeAsset("gallery/notebook-pyspark.png", "vscode-notebook-pyspark-dark.png", 1_440, 900),
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
  acceptanceCrop("gallery/by-example-preview.png", "by-example-preview-dark-1280.png", 1_280, 760, {
    x: 0,
    y: 0,
    width: 1_280,
    height: 580
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

test("v1.2 README media preserves exact packaged-editor scenes and tells the complete product story", () => {
  const packageJson = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
  const compositor = readFileSync(resolve(root, "scripts", "compose-readme-media.mjs"), "utf8");
  const captureScript = readFileSync(resolve(root, "scripts", "capture-screenshots.mjs"), "utf8");
  const packagedEditorRunner = readFileSync(resolve(root, "scripts", "run-packaged-editor-tests.mjs"), "utf8");
  const buildWebviews = readFileSync(resolve(root, "scripts", "build-webviews.mjs"), "utf8");
  const readme = readFileSync(resolve(root, "README.md"), "utf8");
  const gallery = readFileSync(resolve(root, "docs", "media-gallery.md"), "utf8");
  const mediaSpec = readFileSync(resolve(root, "docs", "media-spec-v1.2.md"), "utf8");
  const testing = readFileSync(resolve(root, "docs", "testing.md"), "utf8");
  const extensionHost = readFileSync(resolve(root, "src", "test", "extensionHost", "index.ts"), "utf8");
  const screenshotEvidence = readFileSync(
    resolve(root, "src", "test", "extensionHost", "screenshotEvidence.ts"),
    "utf8"
  );

  assert.equal(packageJson.scripts?.["compose:readme-media"], "node scripts/compose-readme-media.mjs");
  assert.equal(packageJson.scripts?.["verify:readme-media"], "node scripts/compose-readme-media.mjs --verify");
  assert.match(packageJson.scripts?.["test:webview-acceptance"] ?? "", /npm run verify:readme-media/u);
  assert.match(packageJson.scripts?.["test:scripts:portable"] ?? "", /scripts\/readme-media\.test\.mjs/u);
  for (const asset of [
    "action-icon-dark.svg",
    "action-icon-light.svg",
    "activity-icon.svg",
    "icon.svg",
    "icon-128.png",
    "icon-256.png",
    "icon.png"
  ]) {
    assert.ok(buildWebviews.includes(`"${asset}"`), `The production build must verify ${asset}.`);
  }
  assert.match(buildWebviews, /packaged\.equals\(source\)/u);

  assert.match(compositor, /docs", "images", "readme", "v1\.2"/u);
  assert.match(compositor, /pixelmatch/u);
  assert.match(compositor, /addSrgbChunk/u);
  assert.doesNotMatch(compositor, /v1\.1|rotate\(|clip-path|transform:\s*scale\(/u);
  for (const asset of nativeAssets) {
    assert.ok(compositor.includes(`${asset.factory}("${asset.destination}", "${asset.source}"`));
  }
  assert.match(compositor, /function cropPng\(/u);
  assert.match(compositor, /source\.data\.copy\(result\.data/u);
  assert.match(readme, /<img src="assets\/icon\.png"/u);
  assert.doesNotMatch(
    readme,
    /raw\.githubusercontent\.com\/Matt17BR\/openwrangler\/main\/(?:assets|docs\/images\/readme)/u,
    "README product media must stay branch-relative so pull-request and branch previews render before merge."
  );

  assert.match(captureScript, /regional-orders-rich\.parquet/u);
  assert.match(captureScript, /backend="duckdb"/u);
  assert.match(captureScript, /FROM range\(100000\) AS rows\(row_id\)/u);
  assert.match(captureScript, /DECIMAL\(14, 2\)/u);
  assert.match(captureScript, /TIMESTAMPTZ/u);
  assert.match(captureScript, /STRUCT\(label VARCHAR, score INTEGER\)/u);
  assert.match(captureScript, /duckdb_rich = duckdb_manager\.open_session[\s\S]{0,300}page_size=200/u);
  assert.doesNotMatch(captureScript, /duckdbRich[\s\S]{0,500}notebookVariable/u);
  assert.match(captureScript, /readme\/v1\.2\/gallery\/duckdb-rich-parquet\.png/u);
  assert.doesNotMatch(captureScript, /readme\/v1\.1/u);

  assert.match(packagedEditorRunner, /resolve\(profile, "orders-analysis"\)/u);
  assert.doesNotMatch(packagedEditorRunner, /Open Wrangler Jupyter Allow/u);
  assert.doesNotMatch(packagedEditorRunner, /acceptanceMode === "full" && jupyterExtensionInstallTarget/u);
  assert.match(packagedEditorRunner, /if \(jupyterExtensionInstallTarget\) \{/u);
  assert.match(packagedEditorRunner, /"jupyter-pyspark"/u);
  assert.match(
    extensionHost,
    /platform-smoke:file-action:screenshots[\s\S]{0,1500}\$\{editorKey\}-file-title-action\.png[\s\S]{0,1500}\$\{editorKey\}-tab-context-menu\.png/u
  );
  assert.match(screenshotEvidence, /PACKAGED_NOTEBOOK_WORKBENCH_VIEWPORT = \{ width: 1_440, height: 900 \}/u);
  assert.match(
    screenshotEvidence,
    /PACKAGED_SCREENSHOT_SCENES = \[[\s\S]{0,600}"notebook-polars",[\s\S]{0,80}"notebook-duckdb",[\s\S]{0,80}"notebook-pyspark"/u
  );
  assert.match(extensionHost, /captureReleasedJupyterDuckDbRelation\(/u);
  assert.match(extensionHost, /packagedScreenshotFileName\([\s\S]{0,180}"notebook-duckdb", "dark"\)/u);
  assert.match(extensionHost, /async function captureNotebookWorkbenchScreenshot\(/u);
  assert.match(extensionHost, /A notebook workbench media scene requires the standard 1440 by 900 editor viewport/u);

  for (const asset of nativeAssets) {
    const acceptedPath = resolve(root, "docs", "images", asset.sourceDirectory, asset.source);
    const readmePath = resolve(root, "docs", "images", "readme", "v1.2", asset.destination);
    const accepted = readFileSync(acceptedPath);
    const portable = readFileSync(readmePath);
    assertPng(accepted, asset.sourceWidth, asset.sourceHeight, false);
    assertPng(portable, asset.outputWidth, asset.outputHeight, true);
    assert.ok(portable.byteLength < 1_024 * 1_024, `${asset.destination} should remain below 1 MiB.`);
    const acceptedImage = PNG.sync.read(accepted);
    const expectedPixels = asset.crop ? cropPixels(acceptedImage, asset.crop) : acceptedImage.data;
    assert.deepEqual(
      PNG.sync.read(portable).data,
      expectedPixels,
      `${asset.destination} must preserve its exact accepted source pixels.`
    );
  }

  for (const image of [
    "explore.png",
    "gallery/sidebar-explore.png",
    "gallery/sidebar-workflow.png",
    "gallery/column-search-wide.png",
    "workflow.png",
    "gallery/histogram-hover.png",
    "gallery/sort-priority.png",
    "gallery/export-script.png",
    "gallery/export-data.png",
    "gallery/notebook-variable-picker.png",
    "notebook-pandas.png",
    "gallery/notebook-polars-detail.png",
    "gallery/notebook-duckdb-detail.png"
  ]) {
    assert.ok(readme.includes(`docs/images/readme/v1.2/${image}`), `README must show ${image}.`);
  }
  assert.ok(
    !readme.includes("docs/images/readme/v1.2/gallery/by-example-setup.png"),
    "README must link to the gallery instead of presenting the scrollable setup editor as fully expanded."
  );
  assert.doesNotMatch(readme, /docs\/images\/readme\/v1\.1|docs\/images\/editor-acceptance/u);
  assert.match(readme, /Operations, Summary, Filters \/ Sorts, Cleaning Steps/u);
  assert.match(readme, /Native Activity Bar views/u);
  assert.match(readme, /Source at a glance\./u);
  assert.match(readme, /View and plan stay separate\./u);
  assert.match(readme, /Inspect every bin\./u);
  assert.match(readme, /Control compound sorts\./u);
  assert.match(readme, /actual engine and dataframe type visible/u);
  assert.match(readme, /reorderable sort priorities, applied history, a draft diff/u);
  assert.match(
    readme,
    /portable Pandas table stays inside the notebook[\s\S]{0,140}reconnects to the complete,\s+current live variable/u
  );
  assert.match(
    readme,
    /Notebook outputs stay compact;[\s\S]{0,180}reconnects to the complete current variable[\s\S]{0,160}saved output without its live kernel remains preview-only/u
  );
  assert.match(readme, /Polars editing\./u);
  assert.match(readme, /DuckDB exploration\./u);
  assert.match(readme, /without converting it to Pandas, Polars, or Arrow/u);
  assert.match(readme, /fixture sizes are evidence points, not row limits/u);
  assert.doesNotMatch(readme, /headline ceilings|10,000 rows|16 MiB|2,048 columns|100,000 cells/u);
  assert.doesNotMatch(readme, /\*\*Open saved\s+snapshot\*\*/u);
  assert.match(readme, /Inspired by <a href="https:\/\/github\.com\/microsoft\/vscode-data-wrangler"/u);
  assert.match(readme, /If Microsoft\s+Data Wrangler is installed too[\s\S]{0,180}Choose\s+Notebook Preview Provider/u);
  assert.match(readme, /\| Other VS Code desktop forks \| Experimental/u);
  assert.match(readme, /\| DuckDB\s+\|/u);
  assert.doesNotMatch(readme, /\| DuckDB, preview/u);
  assert.match(readme, /loading a pickle can execute arbitrary code/u);
  assert.match(
    readme,
    /PySpark 4\.2 DataFrames can open as experimental, viewing-only live notebook sessions\.[\s\S]{0,220}requested profiles stay in Spark; only bounded results return/u
  );
  assert.match(
    readme,
    /File sessions,\s+cleaning, exports, code insertion, and saved inline previews are not supported\./u
  );
  assert.match(readme, /\| v1\.2\s+\| Finish real-user interaction polish[\s\S]{0,500}#36/u);
  assert.match(readme, /\| v2\s+\| Native R data frames[\s\S]{0,200}#87/u);
  assert.match(readme, /The next public package is one coherent v1\.2 release/u);
  assert.match(readme, /Development commits are not published as a stream of patch releases/u);

  for (const image of [
    "images/readme/v1.2/explore.png",
    "images/readme/v1.2/gallery/sidebar-explore.png",
    "images/readme/v1.2/gallery/sidebar-workflow.png",
    "images/readme/v1.2/gallery/histogram-hover.png",
    "images/readme/v1.2/gallery/sort-priority.png",
    "images/readme/v1.2/gallery/by-example-setup.png",
    "images/readme/v1.2/gallery/by-example-preview.png",
    "images/readme/v1.2/workflow.png",
    "images/readme/v1.2/gallery/file-title-action.png",
    "images/readme/v1.2/gallery/tab-context-menu.png",
    "images/readme/v1.2/gallery/notebook-variable-picker.png",
    "images/readme/v1.2/notebook-pandas.png",
    "images/readme/v1.2/gallery/notebook-polars.png",
    "images/readme/v1.2/gallery/notebook-duckdb.png",
    "images/readme/v1.2/gallery/notebook-pyspark.png",
    "images/readme/v1.2/gallery/duckdb-rich-parquet.png",
    "images/readme/v1.2/gallery/duckdb-rich-parquet-detail.png"
  ]) {
    assert.ok(gallery.includes(image), `Gallery must include ${image}.`);
  }
  assert.match(gallery, /Fixture dimensions show\s+the\s+captured scenario, not product row or column limits/u);
  assert.match(gallery, /does not convert through Pandas,\s+Polars, or Arrow/u);
  assert.match(gallery, /experimental and viewing-only/u);
  assert.match(gallery, /Transform by example/u);
  assert.match(gallery, /Confirm the synthesized split across all ten unseen account IDs/u);
  assert.match(gallery, /## Native Activity Bar views/u);
  assert.match(gallery, /Operations and Summary remain useful without opening another editor tab/u);
  assert.match(gallery, /ordered priorities and never masquerade as cleaning steps/u);
  assert.match(gallery, /Sparse bins remain easy to inspect\./u);
  assert.match(gallery, /Compound sort order stays explicit\./u);
  assert.match(gallery, /Choose a live variable by engine/u);
  assert.match(gallery, /## Open files where you already work[\s\S]{0,120}### Editor title action/u);
  assert.match(gallery, /### Tab context menu/u);
  assert.match(
    gallery,
    /href="images\/readme\/v1\.2\/gallery\/by-example-setup\.png"[\s\S]{0,900}href="images\/readme\/v1\.2\/gallery\/by-example-preview\.png"/u
  );
  assert.doesNotMatch(gallery, /images\/readme\/v1\.1/u);

  const richDuckDb = readFileSync(
    resolve(root, "docs", "images", "readme", "v1.2", "gallery", "duckdb-rich-parquet.png")
  );
  assertPng(richDuckDb, 1_920, 640, true);
  assert.ok(richDuckDb.byteLength < 300 * 1_024);

  const richDuckDbDetail = readFileSync(
    resolve(root, "docs", "images", "readme", "v1.2", "gallery", "duckdb-rich-parquet-detail.png")
  );
  assertPng(richDuckDbDetail, 1_500, 595, true);
  assert.ok(richDuckDbDetail.byteLength < 300 * 1_024);

  assert.match(mediaSpec, /canonical v1\.2 README and gallery contract/u);
  assert.match(mediaSpec, /thirteen assets in ten compact visual blocks/u);
  assert.match(mediaSpec, /preserve the exact selected source pixels/u);
  assert.match(mediaSpec, /contains no unused import/u);
  assert.match(testing, /derives twenty-three assets from accepted packaged-editor and production-webview sources/u);
  assert.match(testing, /pixel-exact decoded output/u);
});

function nativeAsset(destination, source, width, height) {
  return {
    factory: "nativeAsset",
    destination,
    source,
    sourceDirectory: "editor-acceptance",
    sourceWidth: width,
    sourceHeight: height,
    outputWidth: width,
    outputHeight: height
  };
}

function nativeCrop(destination, source, sourceWidth, sourceHeight, crop) {
  return {
    factory: "nativeCrop",
    destination,
    source,
    sourceDirectory: "editor-acceptance",
    sourceWidth,
    sourceHeight,
    outputWidth: crop.width,
    outputHeight: crop.height,
    crop
  };
}

function acceptanceCrop(destination, source, sourceWidth, sourceHeight, crop) {
  return {
    factory: "acceptanceCrop",
    destination,
    source,
    sourceDirectory: "acceptance",
    sourceWidth,
    sourceHeight,
    outputWidth: crop.width,
    outputHeight: crop.height,
    crop
  };
}

function readmeCrop(destination, source, sourceWidth, sourceHeight, crop) {
  return {
    factory: "readmeCrop",
    destination,
    source,
    sourceDirectory: "readme/v1.2",
    sourceWidth,
    sourceHeight,
    outputWidth: crop.width,
    outputHeight: crop.height,
    crop
  };
}

function cropPixels(source, crop) {
  const result = Buffer.alloc(crop.width * crop.height * 4);
  for (let row = 0; row < crop.height; row += 1) {
    const sourceStart = ((crop.y + row) * source.width + crop.x) * 4;
    source.data.copy(result, row * crop.width * 4, sourceStart, sourceStart + crop.width * 4);
  }
  return result;
}

function assertPng(png, width, height, requireSrgb) {
  assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  assert.equal(png.readUInt32BE(16), width);
  assert.equal(png.readUInt32BE(20), height);
  if (requireSrgb) assert.ok(pngChunkTypes(png).includes("sRGB"));
}

function pngChunkTypes(png) {
  const types = [];
  let offset = 8;
  while (offset + 12 <= png.length) {
    const length = png.readUInt32BE(offset);
    const type = png.toString("ascii", offset + 4, offset + 8);
    types.push(type);
    offset += length + 12;
    if (type === "IEND") break;
  }
  assert.equal(types.at(-1), "IEND");
  assert.equal(offset, png.length);
  return types;
}
