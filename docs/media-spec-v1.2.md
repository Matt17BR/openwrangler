# Open Wrangler v1.2 product media

This is the canonical v1.2 README and gallery contract. It presents the packaged extension as an editor product,
shows the workflows behind the feature claims, and keeps the README compact enough to scan.

## Source and capture contract

- Source: one verified VSIX installed into a disposable VS Code profile.
- Display: Chromium's zero-window headless platform. The run cannot open or focus a desktop window.
- Data: deterministic, license-clean fixtures only. No user or private data is read.
- Chrome: preserve the native Activity Bar, sidebar, editor tabs, notebook chrome, and bottom panel where they
  explain integration.
- Fidelity: packaged-editor capture viewports are 1440 × 900 or 1280 × 900. The native workbench chrome is then
  trimmed to accepted 1440 × 870/874 or 1280 × 600/874 assets where the runner owns deterministic outer pixels.
  README details may select one documented, pixel-exact rectangle from a complete accepted scene; do not scale,
  mask, add device frames, or reconstruct editor UI.
- Portability: full-scene README copies preserve every accepted source pixel and add only a standard sRGB PNG
  chunk when the native capture lacks one. Focused entry-point crops preserve the exact selected source pixels
  without scaling, masking, reconstruction, or annotation.
- Hygiene: reject unrelated Quick Input, context menus, notifications, hovers, temporary paths, internal
  acceptance labels, clipped required text, or partially visible required controls. A Quick Pick or Save dialog
  may remain visible only when that exact native interaction is the subject of the scene; its state, destination
  suggestion, cancellation, and zero-write cleanup must be asserted by the packaged-editor harness. Copy receipts
  remain test evidence rather than public gallery media.

## README sequence

The README uses compact visual blocks instead of one uninterrupted screenshot wall. The generated inventory is
authoritative; do not maintain a handwritten asset count.

1. `explore.png`: full-width 1440 × 870 workbench with the selected Open Wrangler Activity Bar item, all four
   populated native views, virtualized Polars grid, header summaries, and exact `revenue` profile.
2. `gallery/sidebar-explore.png` and `gallery/sidebar-workflow.png`: two linked 448 × 500 pixel-exact details,
   displayed side-by-side, that make the native Activity Bar views legible without repeating another full editor
   scene. The first shows Operations and Summary; the second shows ordered Filters / Sorts and separate Cleaning
   Steps.
3. `gallery/operation-configuration-detail.png` and `gallery/applied-step-inspection-detail.png`: two pixel-exact
   details displayed side-by-side and linked to their complete packaged-editor scenes. They keep the full
   `revenue + 500 → projected_revenue` form and latest-step inspection controls legible at README width.
4. `gallery/column-search-wide.png`: one full-width 1440 × 865 schema-navigation scene that reaches item 417 of
   417 with type icons and complete names. The fixture proves the list is uncapped; it is not a column limit.
5. `workflow.png`: full-width 1440 × 870 workbench with two ordered viewing sorts, applied market normalization,
   a separate projected-revenue formula draft, data diff, Apply / Discard, and executable Polars code.
6. `gallery/histogram-hover.png` and `gallery/sort-priority.png`: two linked 448 × 480 pixel-exact details showing
   a sparse histogram bin's full-height interaction target and the native sidebar controls for reordering or
   removing compound sort keys.
7. `gallery/export-script-detail.png` and `gallery/export-data-detail.png`: two pixel-exact details linked to the
   complete 1440 × 870 packaged outcomes. The first opens the generated `.clean.py`; the second opens the
   separately exported cleaned file. The harness proves both were written through the real product path and that
   the source bytes never changed.
8. `gallery/notebook-variable-picker-detail.png` and `gallery/notebook-pandas-detail.png`: two pixel-exact details
   linked to complete packaged notebook scenes. The 1440 × 900 picker labels every fully visible live-variable row
   by engine/type; the separate 1280 × 600 Pandas scene shows the portable inline table.
9. `gallery/notebook-polars-detail.png`: a linked pixel-exact detail at full README content width. It keeps the
   engine badge, formula draft, added values, and generated code legible.
10. `gallery/notebook-duckdb-detail.png`: a linked pixel-exact detail at full README content width. It keeps the
    native grid, engine badge, filter, reorderable multi-sort, paging, and profiles legible without conversion.

The Polars and DuckDB links retain their complete 1440 × 900 packaged scenes. The two details appear one after
another at full README content width.

By-example remains represented in the gallery until its setup and result can be recaptured against a realistic
wide workflow without a dense JSON-editor-first presentation or an otherwise empty two-column canvas.

Fixture sizes visible in these scenes are evidence, never product limits.

## Full gallery

`docs/media-gallery.md` adds:

- branded file entry points cropped from the accepted 1440 × 865 editor scenes: a 1440 × 120 title strip and a
  540 × 570 tab-menu view;
- pixel-exact sidebar details cropped from the accepted Explore and Workflow scenes, showing the operation catalog,
  dataframe summary, ordered viewing state, and separate cleaning history at a readable size;
- a full native-sidebar overview with all four views populated, the complete catalog and configured Formula
  operation, and an applied-step inspection with its history controls visible;
- pixel-exact by-example details cropped from accepted production-webview scenes: a 1080 × 760 complete operation
  dialog whose real scrollable editor shows both mapping values and outputs, followed by the complete ten-row
  draft and its Apply / Discard controls;
- the full-size Pandas, Polars, and DuckDB notebook scenes, while README-specific notebook crops remain linked
  back to those complete sources;
- a clearly labeled experimental, viewing-only PySpark 4.2 scene at 1440 × 900;
- a focused native DuckDB rich-Parquet detail with decimal, time-zone, list, and struct values, linked to its
  complete 1920 × 640 source scene;
- the automatic-import override, complete wide-schema search, real script/data export outcomes, and a current
  Cursor workbench from the same candidate VSIX;
- focused packaged-editor details for exact histogram interaction and editable compound-sort priority;
- an applied `market equals "DACH"` file-filter result beside the matching native Filters / Sorts state, individual
  remove control, and Clear all control;
- the real 1440 × 900 notebook variable picker with native engine/type labels and no partially visible option row
  before a live launch;
- a separate real Jupyter picker filtered to `spark_classic_frame`, with complete **Viewing only**, **Full-frame
  open (scan, index, cache)**, and **Requires PySpark 4.2.x** guidance, dismissed without opening the variable;
- focused production-webview captures for a realistic by-example setup and its generalized result.

Every caption states what the image proves and distinguishes fully supported editing, supported viewing, and
experimental viewing-only surfaces.

## Remaining capture backlog

Capture these from the final packaged v1.2 candidate before publication:

- an Explorer-row context screenshot that complements the editor-title and tab entry points;
- executed applied-step edit/undo and notebook code insertion against realistic data; and
- a realistic high-contrast workbench scene that exercises the same populated product layout rather than a toy
  four-row harness fixture.

Do not substitute the older `vscode-columns-*`, `cursor-*`, `grid-view.png`, `filter-panel.png`, `wide-grid.png`,
or `notebook-preview.png` captures: they predate the current toolbar/sidebar presentation or do not prove the
workflow named above.

## Scene assertions

### Explore

- **Operations**, **Summary**, **Filters / Sorts**, and **Cleaning Steps** are visible and populated.
- Summary shows the source, native backend, mode, shape, selected column, missing cells, and duplicate rows.
- Exact Min, Max, Mean, Median, standard deviation, and distribution are legible in **Column profiles**.
- Sidebar rows, drawer statistics, grid headers, source name, shape, toolbar, and status remain contained.

### Workflow

- `revenue` is Priority 1 and `market` Priority 2 in the non-destructive view.
- Cleaning Steps shows Original data, one applied Uppercase normalization, and a separate Formula column draft.
- The projected-revenue draft's added column and changed values are visible beside Apply and Discard.
- Code Preview starts with `import polars as pl`, contains the market normalization and revenue projection, and
  contains no unused import.

### Viewing filters

- The deterministic orders fixture applies `market equals "DACH"` through the production filter drawer.
- The grid reports the exact filtered row count, and every visible market cell is `DACH`.
- The native **Filters / Sorts** view mirrors the same condition and keeps both individual removal and **Clear all**
  controls visible without clipping.
- Cleanup clears the filter through the real UI and restores the complete 100,000-row source view.

### Operation catalog and history

- The catalog shows grouped operations and leaves the dataframe and plan unchanged.
- Formula configuration shows `revenue`, `add`, `500`, `projected_revenue`, and Preview changes without overflow.
- Applied-step inspection selects the latest Formula column step, pauses viewing filters, and settles before
  capture.
- Show confirmed data, Edit latest, and Undo remain visible while the confirmed dataframe and filters are
  unchanged.

### Notebook engines

- Pandas labels the inline output as a portable capture while the action opens the complete live variable.
- Polars shows Editing and Polars badges, a formula draft, added-column diff, and complete generated code.
- DuckDB shows Viewing and DuckDB badges, the native relation shape, a real filter, ordered two-key sort, visible
  profiles, and no cleaning or export controls.
- PySpark shows Experimental, Viewing only, and PySpark badges, exact profiles, and no cleaning or export controls.
- The separate released-Jupyter PySpark picker shows the complete viewing-mode, full-frame-open, and 4.2.x
  prerequisite guidance on one fully visible `spark_classic_frame` row, then closes without selecting it.

## Reproduction and publication gate

Run:

```bash
npm run compose:readme-media
node --test scripts/readme-media.test.mjs
npm run verify:readme-media
```

Then inspect every README and gallery image at its rendered width. Do not publish a media change when any image
comes from a different VSIX, disagrees with the documented capability, clips required content, or fails the
pixel-equivalence check.
