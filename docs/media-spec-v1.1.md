# Open Wrangler v1.1 media specification

This specification replaces evidence-heavy README captures with two concise product views and a linked notebook
gallery. Editor and notebook images come from the packaged extension running in an isolated profile. The DuckDB
file gallery uses the same production webview bundle and bundled native runtime in the deterministic browser
harness so its rich Parquet fixture can be reproduced without presenting a mocked interface.

## Brand asset contract

- `assets/icon.svg` is the single editable gallery-icon master
- `npm run brand:generate` renders exact 128, 256, and 512 pixel PNGs and local light/dark contact sheets
- `npm run brand:check` verifies the SVG and PNG hashes against the generated manifest without requiring a browser
- `npm run brand:render-check` uses the lockfile-pinned Playwright Chromium to prove every PNG still matches the SVG master pixel for pixel
- `npm run test:webview-acceptance` runs the pixel-exact brand check in the browser-enabled visual CI lane
- `assets/icon.png` is the 512 pixel README and registry master and renders at 128 CSS pixels for a sharp,
  registry-portable presentation; arbitrary SVGs are not accepted by registry README validation
- the production Vite build copies both canonical SVGs and all three generated PNGs into disposable `media/`
  and fails if any packaged copy is not byte-identical
- `assets/activity-icon.svg` is a separate monochrome `currentColor` glyph used only by surfaces that theme it
  as a mask, including the Activity Bar and native view containers
- `assets/action-icon-light.svg` and `assets/action-icon-dark.svg` preserve the same vehicle geometry on the
  16 pixel command-icon canvas while using explicit VS Code foreground colors for light and dark surfaces;
  command contributions must use the manifest's `{ light, dark }` icon form because an externally loaded SVG
  cannot inherit `currentColor` from a toolbar
- brand render acceptance loads both action icons as external images on their intended surfaces and requires
  visible, contrasting pixels, so a black-on-dark command icon is release-blocking
- generated gallery icons leave at most 8 transparent pixels at 512 pixels, and the 24 pixel Activity Bar
  rendering reaches the outer pixel columns with no more than one transparent row above or below
- release postflight requires Open VSX and the Visual Studio Marketplace to serve the packaged 512 pixel icon
  byte for byte; the Marketplace must also expose a valid 72 pixel thumbnail that visually matches that master

## README workbench image

- Output: `docs/images/readme/v1.1/workbench.png`
- Canvas: 1920 x 830 pixels
- Source: packaged VSIX in an isolated VS Code profile
- Data: deterministic 100,000-row, 15-column regional orders CSV with dates, categories, currency, quantities, nulls, and realistic customer and product labels
- State: automatic CSV import, `revenue` selected, selected-column Insights visible with min, max, mean, and median
- Composition: the same full-size packaged session in VS Code's default light and dark themes, joined at a
  straight vertical midpoint with no scaling, diagonal mask, or decorative overlay
- Framing: extension UI dominates the image; editor chrome remains visible enough to establish VS Code context

## README notebook image

- Output: `docs/images/readme/v1.1/notebooks.png`
- Canvas: 1280 x 600 pixels
- Source: packaged VSIX in an isolated VS Code profile
- Data: deterministic 100,000-row, 15-column regional orders frames
- State: `orders-analysis.ipynb`, Pandas `orders_df`, and an Open Wrangler inline dataframe preview
- Composition: one unaltered capture from a real 1280-pixel-wide editor viewport, retaining the notebook chrome,
  output, extension controls, and native horizontal-scroll affordance; no post-capture crop, custom card, mock
  frame, or decorative background
- Framing: the standard-width viewport shows a useful subset of the realistic 15-column dataframe while keeping
  native labels legible when the image is rendered at README width

## Linked gallery

The README may link to a separate gallery rather than stacking more full-width images.

- DuckDB: `docs/images/readme/v1.1/gallery/duckdb-rich-parquet.png`, a deterministic 100,000-row file-backed
  1920 x 640 rich Parquet session captured from the production webview and native DuckDB runtime in the browser
  harness, with decimal, time-zone, list, and struct columns; the caption must keep this file-backed scene distinct
  from the separately supported native, viewing-only live `DuckDBPyRelation` notebook path
- Polars: `docs/images/readme/v1.1/gallery/notebook-polars.png`, an unaltered 1920 x 760 packaged-editor capture
  of a live native Polars notebook session, including its generated Polars code
- PySpark: `docs/images/readme/v1.1/gallery/pyspark-live-notebook.png`, the unaltered 1920 x 640 native packaged
  VS Code and released-Jupyter capture of a deterministic 100,000-row by 15-column Classic DataFrame; the
  compositor may add only the sRGB metadata chunk and must not crop, scale, frame, badge, or decorate it
- The PySpark panel must say `Experimental` and `Viewing only`; it must not imply PySpark file opening, cleaning,
  export, code insertion, or saved-output support
- Cursor: one optional compatibility capture using the same orders fixture and composition

## Capture checklist

- Use production bundles throughout; use the packaged VSIX for every editor/notebook capture
- Use isolated editor profiles for packaged captures and deterministic local fixtures throughout
- Hide test names, temporary paths, notifications, hovers, and cursor focus rings
- Show complete headings, labels, operations, summaries, and generated code without clipping or overlap
- Use VS Code's named default light and dark themes; never choose the first installed theme by contribution order
- Preserve the editor's native geometry. Do not scale, rotate, diagonally mask, or place captures in invented cards
- Keep the main subject legible at the README display width
- Verify toolbar action icons on both light and dark editor surfaces rather than inferring their color from the
  Activity Bar rendering
- Use static PNGs with an sRGB profile and target 300 KiB or less for each primary README image
- Verify the final files and corrected logo on GitHub, Visual Studio Marketplace, and Open VSX
- Treat scale and performance statements as benchmark claims, not screenshot captions
