import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { PNG } from "pngjs";

const root = resolve(import.meta.dirname, "..");

const nativeAssets = [
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
    x: 55,
    y: 65,
    width: 698,
    height: 535
  }),
  nativeCrop("gallery/notebook-polars-detail.png", "vscode-notebook-polars-dark.png", 1_440, 900, {
    x: 48,
    y: 115,
    width: 884,
    height: 675
  }),
  nativeCrop("gallery/notebook-duckdb-detail.png", "vscode-notebook-duckdb-dark.png", 1_440, 900, {
    x: 548,
    y: 63,
    width: 872,
    height: 700
  }),
  nativeCrop("gallery/notebook-pyspark-detail.png", "vscode-notebook-pyspark-dark.png", 1_440, 900, {
    x: 600,
    y: 63,
    width: 820,
    height: 610
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

test("pixel-exact media failures keep diagnostics bounded", () => {
  const actual = Buffer.alloc(1_000_000);
  const expected = Buffer.from(actual);
  expected[expected.length - 1] = 1;

  assert.throws(
    () => assertExactPixels(actual, expected, 500, "Synthetic media mismatch."),
    (error) => {
      const diagnostic = String(error);
      assert.ok(diagnostic.length < 512);
      assert.match(diagnostic, /pixel \(499, 499\), alpha; expected 1, received 0/u);
      assert.doesNotMatch(diagnostic, /<Buffer|actual:|expected:/u);
      return true;
    }
  );
});

test("v1.2 README media preserves exact packaged-editor scenes and tells the complete product story", () => {
  const packageJson = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
  const compositor = readFileSync(resolve(root, "scripts", "compose-readme-media.mjs"), "utf8");
  const captureScript = readFileSync(resolve(root, "scripts", "capture-screenshots.mjs"), "utf8");
  const packagedEditorRunner = readFileSync(resolve(root, "scripts", "run-packaged-editor-tests.mjs"), "utf8");
  const buildWebviews = readFileSync(resolve(root, "scripts", "build-webviews.mjs"), "utf8");
  const readme = readFileSync(resolve(root, "README.md"), "utf8");
  const gallery = readFileSync(resolve(root, "docs", "media-gallery.md"), "utf8");
  const legacyMediaSpec = readFileSync(resolve(root, "docs", "media-spec-v1.1.md"), "utf8");
  const mediaSpec = readFileSync(resolve(root, "docs", "media-spec-v1.2.md"), "utf8");
  const testing = readFileSync(resolve(root, "docs", "testing.md"), "utf8");
  const extensionHost = readFileSync(resolve(root, "src", "test", "extensionHost", "index.ts"), "utf8");
  const screenshotEvidence = readFileSync(
    resolve(root, "src", "test", "extensionHost", "screenshotEvidence.ts"),
    "utf8"
  );

  assert.equal(
    packageJson.scripts?.["compose:readme-media"],
    "node scripts/run-heavy-local-command.mjs compose:readme-media -- node scripts/compose-readme-media.mjs"
  );
  assert.equal(
    packageJson.scripts?.["verify:readme-media"],
    "node scripts/run-heavy-local-command.mjs verify:readme-media -- node scripts/compose-readme-media.mjs --verify"
  );
  assert.equal(
    packageJson.scripts?.["test:webview-acceptance"],
    "node scripts/run-heavy-local-command.mjs test:webview-acceptance -- npm run test:webview-acceptance:run"
  );
  assert.match(packageJson.scripts?.["test:webview-acceptance:run"] ?? "", /npm run verify:readme-media/u);
  assert.doesNotMatch(packageJson.scripts?.["test:scripts:portable:run"] ?? "", /scripts\/readme-media\.test\.mjs/u);
  assert.match(packageJson.scripts?.["test:scripts:portable:run"] ?? "", /&& npm run test:scripts:media$/u);
  assert.equal(
    packageJson.scripts?.["test:scripts:media"],
    "node scripts/run-heavy-local-command.mjs test:scripts:media -- npm run test:scripts:media:run"
  );
  assert.equal(
    packageJson.scripts?.["test:scripts:media:run"],
    "node --max-old-space-size=1024 --test --test-concurrency=1 scripts/readme-media.test.mjs"
  );
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
  const productMediaReferences = readme
    .split(/["']/u)
    .map(parseProductMediaReference)
    .filter((reference) => reference !== undefined);
  const immutableMediaReferences = productMediaReferences.filter((reference) => /^[0-9a-f]{40}$/u.test(reference.ref));
  assert.ok(immutableMediaReferences.length > 0, "README must use immutable public product-media URLs.");
  assert.deepEqual(
    new Set(immutableMediaReferences.map((reference) => reference.ref)).size,
    1,
    "Every README product-media URL must use one reviewed immutable media commit."
  );
  assert.equal(
    productMediaReferences.length,
    immutableMediaReferences.length,
    "README product media must not drift with a moving branch."
  );
  const declaredProductMedia = new Set([
    ...nativeAssets.map((asset) => asset.destination),
    "gallery/duckdb-rich-parquet.png"
  ]);
  const actualProductMedia = new Set(listRelativePngFiles(resolve(root, "docs", "images", "readme", "v1.2")));
  assert.deepEqual(
    [...actualProductMedia].sort(),
    [...declaredProductMedia].sort(),
    "The v1.2 media directory must contain exactly the declared public inventory."
  );
  const readmeMedia = productMediaReferences
    .map((reference) => reference.assetPath)
    .filter((assetPath) => assetPath.startsWith("docs/images/readme/v1.2/"))
    .map((assetPath) => assetPath.slice("docs/images/readme/v1.2/".length));
  const galleryMedia = [...gallery.matchAll(/images\/readme\/v1\.2\/([a-z0-9._/-]+\.png)/giu)].map((match) => match[1]);
  assert.deepEqual(
    [...new Set([...readmeMedia, ...galleryMedia])].sort(),
    [...declaredProductMedia].sort(),
    "Every declared v1.2 image must be referenced by the README or product gallery."
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
    assertExactPixels(
      PNG.sync.read(portable).data,
      expectedPixels,
      asset.outputWidth,
      `${asset.destination} must preserve its exact accepted source pixels.`
    );
  }

  for (const image of [
    "explore.png",
    "filter-result.png",
    "gallery/sidebar-overview.png",
    "gallery/file-explorer-action.png",
    "gallery/file-explorer-action-detail.png",
    "gallery/column-search-wide.png",
    "gallery/column-search-wide-detail.png",
    "workflow.png",
    "gallery/histogram-hover.png",
    "gallery/sort-priority.png",
    "gallery/latest-step-edited.png",
    "gallery/latest-step-edited-detail.png",
    "gallery/latest-step-undone.png",
    "gallery/latest-step-undone-detail.png",
    "gallery/export-script.png",
    "gallery/export-data.png",
    "gallery/notebook-variable-picker.png",
    "gallery/notebook-variable-picker-detail.png",
    "gallery/notebook-code-insertion.png",
    "gallery/notebook-code-insertion-detail.png",
    "notebook-pandas.png",
    "gallery/notebook-pandas-detail.png",
    "gallery/notebook-polars.png",
    "gallery/notebook-polars-detail.png",
    "gallery/notebook-duckdb.png",
    "gallery/notebook-duckdb-detail.png",
    "gallery/notebook-pyspark.png",
    "gallery/notebook-pyspark-detail.png",
    "gallery/export-script-detail.png",
    "gallery/export-data-detail.png"
  ]) {
    assert.ok(readme.includes(`docs/images/readme/v1.2/${image}`), `README must show ${image}.`);
  }
  assert.ok(
    !readme.includes("docs/images/readme/v1.2/gallery/by-example-setup.png"),
    "README must link to the gallery instead of presenting the scrollable setup editor as fully expanded."
  );
  assert.doesNotMatch(readme, /docs\/images\/readme\/v1\.1|docs\/images\/editor-acceptance/u);
  assert.match(readme, /The whole workflow stays in your editor/u);
  assert.match(readme, /dataframes in an open-source workbench/u);
  assert.match(readme, /Operations, dataset health, viewing state, and cleaning history remain visible/u);
  assert.match(readme, /14,285 matching rows/u);
  assert.match(readme, /automatic delimiter, encoding, quote, and header detection/u);
  assert.match(readme, /Open Wrangler stays inactive in Restricted Mode\./u);
  assert.match(readme, /Search the complete schema\./u);
  assert.match(readme, /Understand distributions\./u);
  assert.match(readme, /Control compound sorts\./u);
  assert.match(readme, /Choose from 27 built-in operations/u);
  assert.match(readme, /Review the visible result and executable Polars code before applying the step/u);
  assert.match(readme, /Insert generated cleaning code into the originating notebook/u);
  assert.match(readme, /opens the complete current live dataframe in the\s+workbench/u);
  assert.match(readme, /DuckDB, experimental\.<\/strong> Query the same live relation without converting it/u);
  assert.match(readme, /PySpark 4\.2\.x, experimental\.<\/strong> View, filter, sort, page, and profile in Spark/u);
  assert.match(readme, /These are evidence points, not row limits/u);
  assert.doesNotMatch(readme, /headline ceilings|10,000 rows|16 MiB|2,048 columns|100,000 cells/u);
  assert.doesNotMatch(readme, /\*\*Open saved\s+snapshot\*\*/u);
  assert.doesNotMatch(
    readme,
    /real packaged|complete packaged-editor scene|current grid-block|bounded viewing|portable table|bridge verifies/u
  );
  assert.match(readme, /Inspired by <a href="https:\/\/github\.com\/microsoft\/vscode-data-wrangler"/u);
  assert.match(readme, /If Microsoft\s+Data Wrangler is installed too[\s\S]{0,180}Choose\s+Notebook Preview Provider/u);
  assert.match(readme, /\| Other VS Code desktop forks \| Experimental/u);
  assert.match(readme, /\| DuckDB, experimental\s+\|/u);
  assert.doesNotMatch(readme, /\| DuckDB, preview/u);
  assert.match(readme, /loading a pickle can execute arbitrary code/u);
  assert.match(readme, /opening\s+a large or remote dataframe may be expensive/u);
  assert.match(readme, /does not install PySpark,\s+authenticate a cluster, or stop your session/u);
  assert.match(
    readme,
    /\*\*v1\.2:\*\* adds native PySpark 4\.2 notebook viewing and interaction refinements[\s\S]{0,250}#36[\s\S]{0,500}compatibility validation[\s\S]{0,200}#86[\s\S]{0,300}comparison[\s\S]{0,200}#91/u
  );
  assert.doesNotMatch(readme, /publish a reproducible Data Wrangler performance comparison/u);
  assert.match(readme, /\*\*v2:\*\* add native R data frames[\s\S]{0,200}#87/u);

  for (const image of [
    "images/readme/v1.2/explore.png",
    "images/readme/v1.2/gallery/histogram-hover.png",
    "images/readme/v1.2/gallery/sort-priority.png",
    "images/readme/v1.2/gallery/by-example-setup.png",
    "images/readme/v1.2/gallery/by-example-setup-detail.png",
    "images/readme/v1.2/gallery/by-example-preview.png",
    "images/readme/v1.2/gallery/by-example-preview-detail.png",
    "images/readme/v1.2/workflow.png",
    "images/readme/v1.2/gallery/file-title-action.png",
    "images/readme/v1.2/gallery/tab-context-menu.png",
    "images/readme/v1.2/gallery/notebook-variable-picker.png",
    "images/readme/v1.2/gallery/notebook-code-insertion.png",
    "images/readme/v1.2/notebook-pandas.png",
    "images/readme/v1.2/gallery/notebook-polars.png",
    "images/readme/v1.2/gallery/notebook-duckdb.png",
    "images/readme/v1.2/gallery/notebook-pyspark.png",
    "images/readme/v1.2/gallery/notebook-pyspark-detail.png",
    "images/readme/v1.2/gallery/sidebar-overview.png",
    "images/readme/v1.2/gallery/file-explorer-action.png",
    "images/readme/v1.2/gallery/file-explorer-action-detail.png",
    "images/readme/v1.2/gallery/latest-step-edited.png",
    "images/readme/v1.2/gallery/latest-step-undone.png",
    "images/readme/v1.2/gallery/high-contrast-explore.png",
    "images/readme/v1.2/gallery/operation-catalog.png",
    "images/readme/v1.2/gallery/operation-configuration.png",
    "images/readme/v1.2/gallery/applied-step-inspection.png",
    "images/readme/v1.2/gallery/duckdb-rich-parquet.png",
    "images/readme/v1.2/gallery/duckdb-rich-parquet-detail.png"
  ]) {
    assert.ok(gallery.includes(image), `Gallery must include ${image}.`);
  }
  assert.match(gallery, /Dataset\s+sizes in the images describe the example, not a row or column limit/u);
  assert.match(gallery, /Query the same live relation without converting it/u);
  assert.match(gallery, /PySpark 4\.2\.x, experimental/u);
  assert.match(gallery, /Teach it\./u);
  assert.match(gallery, /Review it\./u);
  assert.match(gallery, /^## Workbench at a glance$/mu);
  assert.match(
    gallery,
    /The sidebar keeps the operation catalog, dataset health, viewing state, and cleaning history/u
  );
  assert.match(gallery, /Inspect distributions\./u);
  assert.match(gallery, /Control compound sorts\./u);
  assert.match(
    gallery,
    /## Build a cleaning plan[\s\S]{0,1200}operation-catalog\.png[\s\S]{0,1200}operation-configuration\.png[\s\S]{0,1200}workflow\.png[\s\S]{0,2500}applied-step-inspection\.png/u
  );
  assert.match(gallery, /Open the live object\./u);
  assert.match(gallery, /Keep the work reproducible\./u);
  assert.match(gallery, /## Open files where you work/u);
  assert.match(gallery, /## Editors and themes/u);
  assert.doesNotMatch(
    gallery,
    /production webview|packaged extension|current grid-block|bounded, read-only projection/u
  );
  assert.match(
    gallery,
    /href="images\/readme\/v1\.2\/gallery\/by-example-setup\.png"[\s\S]{0,300}by-example-setup-detail\.png[\s\S]{0,900}href="images\/readme\/v1\.2\/gallery\/by-example-preview\.png"[\s\S]{0,300}by-example-preview-detail\.png/u
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

  assert.match(mediaSpec, /canonical README and gallery contract for v1\.2/u);
  assert.match(mediaSpec, /six visual chapters/u);
  assert.match(mediaSpec, /Crops select exact rectangles from accepted screenshots/u);
  assert.match(mediaSpec, /same source commit's\s+exact production webview bundle/u);
  assert.match(mediaSpec, /inventory test rejects both missing and orphaned public PNGs/u);
  assert.match(mediaSpec, /Private setup, restart-probe, and runtime-transfer cells are collapsed/u);
  assert.match(mediaSpec, /raw PySpark variable-picker capture is acceptance evidence, not public product media/u);
  assert.match(legacyMediaSpec, /\*\*Historical record\.\*\*/u);
  assert.match(legacyMediaSpec, /canonical v1\.2 media specification\]\(media-spec-v1\.2\.md\)/u);
  assert.doesNotMatch(legacyMediaSpec, /^## v1\.2 native notebook capture refresh$/mu);
  assert.match(testing, /compose:readme-media[\s\S]{0,160}accepted packaged-editor and\s+production-webview sources/u);
  assert.match(testing, /pixel-exact decoded output/u);
  assert.match(testing, /Generated-code insertion is proven through the exact `NotebookDocument`/u);
  assert.match(testing, /Private Monaco DOM structure is\s+not part of that proof/u);
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

function parseProductMediaReference(value) {
  if (!value.startsWith("https://")) return undefined;
  let url;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  if (url.username || url.password || url.port || url.search || url.hash) return undefined;

  const segments = url.pathname.split("/").filter(Boolean);
  let ref;
  let assetSegments;
  if (url.hostname === "raw.githubusercontent.com" && segments[0] === "Matt17BR" && segments[1] === "openwrangler") {
    ref = segments[2];
    assetSegments = segments.slice(3);
  } else if (
    url.hostname === "github.com" &&
    segments[0] === "Matt17BR" &&
    segments[1] === "openwrangler" &&
    (segments[2] === "blob" || segments[2] === "raw")
  ) {
    ref = segments[3];
    assetSegments = segments.slice(4);
  } else {
    return undefined;
  }

  const assetPath = assetSegments.join("/");
  if (
    assetPath !== "assets/icon.png" &&
    !(assetPath.startsWith("docs/images/readme/v1.2/") && assetPath.endsWith(".png"))
  ) {
    return undefined;
  }
  return { assetPath, ref };
}

function cropPixels(source, crop) {
  const result = Buffer.alloc(crop.width * crop.height * 4);
  for (let row = 0; row < crop.height; row += 1) {
    const sourceStart = ((crop.y + row) * source.width + crop.x) * 4;
    source.data.copy(result, row * crop.width * 4, sourceStart, sourceStart + crop.width * 4);
  }
  return result;
}

function assertExactPixels(actual, expected, width, message) {
  assert.equal(actual.length, expected.length, `${message} Pixel-buffer lengths differ.`);
  if (actual.equals(expected)) return;

  let offset = 0;
  while (offset < actual.length && actual[offset] === expected[offset]) offset += 1;
  const pixel = Math.floor(offset / 4);
  const channel = ["red", "green", "blue", "alpha"][offset % 4];
  assert.fail(
    `${message} First difference: pixel (${pixel % width}, ${Math.floor(pixel / width)}), ${channel}; expected ${expected[offset]}, received ${actual[offset]}.`
  );
}

function listRelativePngFiles(directory, prefix = "") {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) return listRelativePngFiles(resolve(directory, entry.name), relative);
    if (entry.isFile() && entry.name.endsWith(".png")) return [relative];
    return [];
  });
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
