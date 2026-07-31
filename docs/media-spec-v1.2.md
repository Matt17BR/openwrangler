# Open Wrangler v1.2 product media

This is the canonical v1.2 README and gallery contract. It presents the packaged extension as an editor product,
shows the workflows behind the feature claims, and keeps the README compact enough to scan.

## Source and capture contract

- Source: one verified VSIX installed into a disposable VS Code profile.
- Display: Chromium's zero-window headless platform. The run cannot open or focus a desktop window.
- Data: deterministic, license-clean fixtures only. No user or private data is read.
- Chrome: preserve the native Activity Bar, sidebar, editor tabs, notebook chrome, and bottom panel where they
  explain integration.
- Fidelity: omit only the native test-host title strip from the two 1440 × 870 file-workbench captures. Do not
  crop, scale, mask, add device frames, or reconstruct editor UI.
- Portability: full-scene README copies preserve every accepted source pixel and add only a standard sRGB PNG
  chunk when the native capture lacks one. Focused entry-point crops preserve the exact selected source pixels
  without scaling, masking, reconstruction, or annotation.
- Hygiene: reject visible Quick Input, context menus outside the entry-point scene, notifications, hovers,
  temporary paths, internal acceptance labels, clipped required text, or partially visible required controls.

## README sequence

The README uses five images in three moments instead of one uninterrupted screenshot wall:

1. `explore.png`: full-width 1440 × 870 workbench with the selected Open Wrangler Activity Bar item, all four
   populated native views, virtualized Polars grid, header summaries, and exact `revenue` profile.
2. `workflow.png`: full-width 1440 × 870 workbench with two ordered viewing sorts, applied history, a separate
   draft, data diff, Apply / Discard, and executable Polars code.
3. `notebook-pandas.png`: 1280 × 600 inline Pandas preview with honest captured/total row labels and the live
   **Open in Open Wrangler** action.
4. `gallery/notebook-polars.png` and `gallery/notebook-duckdb.png`: two linked 1440 × 900 images displayed
   side-by-side. Polars shows native editing and generated code; DuckDB shows native viewing, filtering,
   reorderable multi-sort, paging, and profiles without conversion.

Fixture sizes visible in these scenes are evidence, never product limits.

## Full gallery

`docs/media-gallery.md` adds:

- branded file entry points cropped from the accepted 1440 × 865 editor scenes: a 1440 × 120 title strip and a
  540 × 570 tab-menu view;
- the full-size Pandas, Polars, and DuckDB notebook scenes;
- a clearly labeled experimental, viewing-only PySpark 4.2 scene at 1440 × 900;
- a focused native DuckDB rich-Parquet scene with decimal, time-zone, list, and struct values;
- focused production-webview captures for a realistic by-example setup and its generalized result, the operation
  picker, applied-step inspection, and high-contrast rendering.

Every caption states what the image proves and distinguishes fully supported editing, supported viewing, and
experimental viewing-only surfaces.

## Scene assertions

### Explore

- **Operations**, **Summary**, **Filters / Sorts**, and **Cleaning Steps** are visible and populated.
- Summary shows the source, native backend, mode, shape, selected column, missing cells, and duplicate rows.
- Exact Min, Max, Mean, Median, standard deviation, and distribution are legible in **Column profiles**.
- Sidebar rows, drawer statistics, grid headers, source name, shape, toolbar, and status remain contained.

### Workflow

- `revenue` is Priority 1 and `market` Priority 2 in the non-destructive view.
- Cleaning Steps shows Original data, one applied Uppercase step, and a separate Uppercase draft.
- The draft's added column and changed values are visible beside Apply and Discard.
- Code Preview starts with `import polars as pl`, contains both transformations, and contains no unused import.

### Notebook engines

- Pandas labels the inline output as a portable capture while the action opens the complete live variable.
- Polars shows Editing and Polars badges, a formula draft, added-column diff, and complete generated code.
- DuckDB shows Viewing and DuckDB badges, the native relation shape, a real filter, ordered two-key sort, visible
  profiles, and no cleaning or export controls.
- PySpark shows Experimental, Viewing only, and PySpark badges, exact profiles, and no cleaning or export controls.

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
