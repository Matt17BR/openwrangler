import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const root = resolve(import.meta.dirname, "..");

test("README media is compact, portable, and composition-verified", () => {
  const packageJson = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
  const compositor = readFileSync(resolve(root, "scripts", "compose-readme-media.mjs"), "utf8");
  const captureScript = readFileSync(resolve(root, "scripts", "capture-screenshots.mjs"), "utf8");
  const packagedEditorRunner = readFileSync(resolve(root, "scripts", "run-packaged-editor-tests.mjs"), "utf8");
  const buildWebviews = readFileSync(resolve(root, "scripts", "build-webviews.mjs"), "utf8");
  const readme = readFileSync(resolve(root, "README.md"), "utf8");
  const gallery = readFileSync(resolve(root, "docs", "media-gallery.md"), "utf8");

  assert.equal(packageJson.scripts?.["compose:readme-media"], "node scripts/compose-readme-media.mjs");
  assert.equal(packageJson.scripts?.["verify:readme-media"], "node scripts/compose-readme-media.mjs --verify");
  assert.match(packageJson.scripts?.["test:webview-acceptance"] ?? "", /npm run verify:readme-media/u);
  assert.match(packageJson.scripts?.["test:scripts"] ?? "", /scripts\/readme-media\.test\.mjs/u);
  for (const asset of ["activity-icon.svg", "icon.svg", "icon-128.png", "icon-256.png", "icon.png"]) {
    assert.ok(buildWebviews.includes(`"${asset}"`), `The production build must verify ${asset}.`);
  }
  assert.match(buildWebviews, /packaged\.equals\(source\)/u);
  assert.match(compositor, /vscode-hero-dark\.png/u);
  assert.match(compositor, /vscode-hero-light\.png/u);
  assert.match(compositor, /vscode-notebook-pandas-dark\.png/u);
  assert.match(compositor, /vscode-notebook-polars-dark\.png/u);
  assert.match(compositor, /vscode-notebook-pyspark-dark\.png/u);
  assert.match(compositor, /pixelmatch/u);
  assert.match(compositor, /sRGB/u);
  assert.doesNotMatch(compositor, /rotate\(|clip-path:\s*polygon|transform:\s*scale\(/u);
  assert.doesNotMatch(packagedEditorRunner, /acceptanceMode === "full" && jupyterExtensionInstallTarget/u);
  assert.match(packagedEditorRunner, /if \(jupyterExtensionInstallTarget\) \{/u);
  assert.match(packagedEditorRunner, /"jupyter-pyspark"/u);
  assert.match(
    readFileSync(resolve(root, "src", "test", "extensionHost", "index.ts"), "utf8"),
    /platform-smoke:file-action:screenshots[\s\S]{0,1500}\$\{editorKey\}-file-title-action\.png[\s\S]{0,1500}\$\{editorKey\}-tab-context-menu\.png/u
  );
  assert.match(captureScript, /regional-orders-rich\.parquet/u);
  assert.match(captureScript, /backend="duckdb"/u);
  assert.match(captureScript, /DECIMAL\(14, 2\)/u);
  assert.match(captureScript, /TIMESTAMPTZ/u);
  assert.match(captureScript, /STRUCT\(label VARCHAR, score INTEGER\)/u);
  assert.doesNotMatch(captureScript, /duckdbRich[\s\S]{0,500}notebookVariable/u);

  for (const [name, width, height] of [
    ["workbench.png", 1_920, 830],
    ["notebooks.png", 1_920, 450]
  ]) {
    const path = resolve(root, "docs", "images", "readme", "v1.1", name);
    const png = readFileSync(path);
    assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
    assert.equal(png.readUInt32BE(16), width);
    assert.equal(png.readUInt32BE(20), height);
    assert.ok(png.byteLength < 300 * 1_024, `${name} should remain compact at README display size.`);
    assert.ok(pngChunkTypes(png).includes("sRGB"), `${name} should declare the standard sRGB color space.`);
    assert.ok(readme.includes(`docs/images/readme/v1.1/${name}`));
  }

  assert.equal(readme.match(/docs\/images\/readme\/v1\.1\/(?:workbench|notebooks)\.png/gu)?.length, 4);
  assert.equal(
    readme.match(
      /<a href="https:\/\/raw\.githubusercontent\.com\/Matt17BR\/openwrangler\/main\/docs\/images\/readme\/v1\.1\/(?:workbench|notebooks)\.png"><img /gu
    )?.length,
    2
  );
  assert.doesNotMatch(readme, /docs\/images\/editor-acceptance\/vscode-(?:hero|notebook)/u);
  assert.doesNotMatch(readme, /The image automatically follows your GitHub theme\./u);
  assert.match(readme, /assets\/icon\.png" width="128" height="128"/u);
  assert.doesNotMatch(readme, /<img[^>]+assets\/icon\.svg[^>]+Open Wrangler logo/u);
  assert.match(
    readme,
    /Files and live variables are not capped at 10,000 rows[\s\S]{0,220}Only a saved\s+inline snapshot is bounded for notebook portability, with headline ceilings of 10,000 rows, 2,048 columns,\s+100,000 cells, and 16 MiB\./u
  );
  assert.match(
    readme,
    /If Microsoft Data Wrangler is installed too, Open Wrangler\s+asks once which extension should own automatic previews/u
  );
  assert.match(readme, /10\/20\/50\/100-row pages/u);
  assert.match(readme, /\*\*Open saved\s+snapshot\*\* keeps the portable captured result available as a fallback/u);
  assert.match(readme, /engine gallery/u);
  assert.match(readme, /DuckDB notebook relations are not yet supported/u);
  assert.match(readme, /loading a pickle can execute arbitrary code/u);
  assert.match(readme, /real packaged PySpark notebook capture/u);
  assert.match(
    readme,
    /PySpark 4\.2 DataFrames can open as experimental, viewing-only live notebook sessions\.[\s\S]{0,220}requested profiles stay in Spark; only bounded results return/u
  );
  assert.match(
    readme,
    /File sessions,\s+cleaning, exports, code insertion, and saved inline snapshots are not supported\./u
  );
  assert.match(readme, /indexes and\s+counts the complete frame[\s\S]{0,100}not dataframe row limits/u);
  assert.match(readme, /\| v1\.1\.2\s+\| Late August 2026/u);
  assert.match(readme, /roughly biweekly patch\s+trains and six-to-eight-week minor releases/u);
  assert.doesNotMatch(readme, /complex-value nodes, and nesting depth/u);

  const galleryImage = readFileSync(
    resolve(root, "docs", "images", "readme", "v1.1", "gallery", "duckdb-rich-parquet.png")
  );
  assert.equal(galleryImage.readUInt32BE(16), 1_440);
  assert.equal(galleryImage.readUInt32BE(20), 640);
  assert.ok(galleryImage.byteLength < 300 * 1_024);
  assert.match(gallery, /file-backed DuckDB Parquet source/u);
  assert.match(gallery, /DuckDB notebook\s+relations are not currently supported\./u);
  assert.match(gallery, /images\/readme\/v1\.1\/gallery\/duckdb-rich-parquet\.png/u);

  const polarsImage = readFileSync(resolve(root, "docs", "images", "readme", "v1.1", "gallery", "notebook-polars.png"));
  assert.equal(polarsImage.readUInt32BE(16), 1_920);
  assert.equal(polarsImage.readUInt32BE(20), 760);
  assert.ok(polarsImage.byteLength < 300 * 1_024);
  assert.ok(pngChunkTypes(polarsImage).includes("sRGB"));
  assert.match(gallery, /(?:Polars live|live native Polars) notebook/u);
  assert.match(gallery, /images\/readme\/v1\.1\/gallery\/notebook-polars\.png/u);

  const pysparkImage = readFileSync(
    resolve(root, "docs", "images", "readme", "v1.1", "gallery", "pyspark-live-notebook.png")
  );
  assert.equal(pysparkImage.readUInt32BE(16), 1_440);
  assert.equal(pysparkImage.readUInt32BE(20), 640);
  assert.ok(pysparkImage.byteLength < 300 * 1_024);
  assert.ok(pngChunkTypes(pysparkImage).includes("sRGB"));
  assert.match(gallery, /real packaged VS Code and Jupyter path/u);
  assert.match(gallery, /experimental, viewing-only live notebook session/u);
  assert.match(gallery, /No PySpark file opening, cleaning, data export, code insertion, or saved inline snapshot/u);
  assert.match(gallery, /images\/readme\/v1\.1\/gallery\/pyspark-live-notebook\.png/u);
});

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
