# Open Wrangler v1.1 media specification

This specification replaces evidence-heavy README captures with two concise product views. Existing release screenshots remain unchanged until both replacements pass the checklist below.

## Brand asset contract

- `assets/icon.svg` is the single editable gallery-icon master
- `npm run brand:generate` renders exact 128, 256, and 512 pixel PNGs and local light/dark contact sheets
- `npm run brand:check` verifies the SVG and PNG hashes against the generated manifest without requiring a browser
- `npm run brand:render-check` uses the lockfile-pinned Playwright Chromium to prove every PNG still matches the SVG master pixel for pixel
- `npm run test:webview-acceptance` runs the pixel-exact brand check in the browser-enabled visual CI lane
- `assets/icon.png` is the 512 pixel README and registry master and renders at 128 CSS pixels for a sharp,
  registry-portable presentation; arbitrary SVGs are not accepted by registry README validation
- `media/icon.png` is the packaged extension copy; generation writes it from the same 512 pixel render, and both
  brand checks fail if it diverges from the master
- `assets/activity-icon.svg` is a separate monochrome `currentColor` glyph for the Activity Bar

## README workbench image

- Output: `docs/images/readme/v1.1/workbench.png`
- Canvas: 1440 x 720 pixels
- Source: packaged VSIX in an isolated VS Code profile
- Data: deterministic 100,000-row, 15-column regional orders CSV with dates, categories, currency, quantities, nulls, and realistic customer and product labels
- State: automatic CSV import, `revenue` selected, selected-column Insights visible with min, max, mean, and median
- Composition: a light-theme grid overview and a focused dark-theme Insights crop from the same source state,
  selected column, and packaged session, combined into one diagonal split
- Framing: extension UI dominates the image; editor chrome remains visible enough to establish VS Code context

## README notebook image

- Output: `docs/images/readme/v1.1/notebooks.png`
- Canvas: 1440 x 600 pixels
- Source: packaged VSIX in an isolated VS Code profile
- Data: deterministic 100,000-row, 15-column regional orders frames
- Top card: `orders-analysis.ipynb`, Pandas `notebook_showcase`, saved Open Wrangler snapshot
- Bottom card: `orders-analysis.ipynb`, Polars `polars_frame`, live formula draft with computed values,
  added-column diff, and complete native Polars code visible
- Labels: small `Pandas snapshot` and `Polars live session` captions outside the product UI
- Composition: two full-width focus bands so notebook output, draft values, and code remain legible at registry width

## Linked gallery

The README may link to a separate gallery rather than stacking more full-width images.

- DuckDB: `docs/images/readme/v1.1/gallery/duckdb-rich-parquet.png`, a file-backed rich Parquet session with
  decimal, time-zone, list, and struct columns; do not imply notebook support
- PySpark: `docs/images/readme/v1.1/gallery/pyspark-live-notebook.png`, a real packaged VS Code and released
  Jupyter capture of a deterministic 100,000-row by 15-column Classic DataFrame
- The PySpark panel must say `Experimental` and `Viewing only`; it must not imply file opening, cleaning, export,
  code insertion, saved-output, or DuckDB notebook support
- Cursor: one optional compatibility capture using the same orders fixture and composition

## Capture checklist

- Use production bundles and a packaged VSIX
- Use isolated editor profiles and deterministic local fixtures
- Hide test names, temporary paths, notifications, hovers, and cursor focus rings
- Show complete headings, labels, operations, summaries, and generated code without clipping or overlap
- Keep the main subject legible at the README display width
- Use static PNGs with an sRGB profile and target 300 KiB or less for each primary README image
- Verify the final files on GitHub, Visual Studio Marketplace, and Open VSX
- Treat scale and performance statements as benchmark claims, not screenshot captions
