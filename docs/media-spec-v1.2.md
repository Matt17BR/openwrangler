# Open Wrangler v1.2 product media

This is the canonical README and gallery contract for v1.2. The media must explain the product to a prospective
user, match the packaged extension, and remain readable at its rendered width.

## Source and capture contract

- Install one verified VSIX into a disposable editor profile for every scene that claims editor integration.
- Run native VS Code/Cursor capture through the zero-window headless platform so no desktop window can open or
  steal focus. Focused webview-only scenes may instead use lockfile-pinned Chromium with the same source commit's
  exact production webview bundle; they must not imply editor integration that the browser harness did not test.
- Use deterministic, license-clean fixtures. Never read or display user or private data.
- Capture every public README/gallery source at **2× physical density** while retaining the documented logical
  viewport and crop coordinates. The dedicated public capture path is the only 2× path; ordinary
  visual-regression baselines remain at 1× so this requirement cannot quadruple the routine visual-test workload.
- Keep editor chrome when it explains integration: Activity Bar, sidebar, tabs, notebook toolbar, and code panel.
- Reject clipped required text, partial grid rows, unrelated dialogs, notifications, temporary paths, fixture
  markers, setup cells, or acceptance-only labels.
- Crops select exact rectangles from accepted screenshots. Do not scale, mask, annotate, recolor, or reconstruct
  editor UI. The compositor records whether each source came from packaged-editor acceptance or the production
  webview harness, converts each logical crop to physical pixels exactly once, and the inventory test rejects both
  missing and orphaned public PNGs.
- Add only the standard sRGB PNG chunk when preparing portable copies.
- Every README and gallery screenshot uses a width-only presentation capped at 960 CSS pixels. The browser derives
  height from the PNG's aspect ratio, and the PNG supplies at least two physical pixels per rendered CSS pixel after
  a host applies responsive `max-width` constraints.
- Keep the lossless inventory within 2 MiB per PNG and 32 MiB for the complete inventory. Do not satisfy either
  budget through lossy encoding, image resizing, or a lower capture density.

The packaged workbench starts at 1440 × 900 or 1280 × 900. Some grid captures trim only the measured partial
bottom row after verifying the complete layout. Notebook crops remove empty canvas or private collapsed cells,
never visible product controls.

## README story

The README uses six visual chapters instead of an unexplained screenshot wall:

1. **Explore:** `explore.png` and `gallery/sidebar-overview.png` introduce the grid, profiles, and all four native
   views.
2. **Open and navigate:** the Explorer action, full-schema search, filter result, histogram, and compound-sort
   controls show how users reach and understand data.
3. **Clean:** `workflow.png` plus the edit/undo pair show draft, generated code, applied history, and precise
   recovery.
4. **Notebooks:** the live-variable picker, generated-code insertion, Pandas/Polars/DuckDB/PySpark matrix, and R
   editing scene show how each engine behaves.
5. **Export:** paired script and data outcomes show reproducible code and separate cleaned files.
6. **Evidence and roadmap:** concise engine, format, and compatibility tables plus a short performance summary and
   future scope follow the visual proof.

## Public media inventory

### Workbench and files

- `explore.png`: 1440 × 870 full workbench.
- `gallery/sidebar-overview.png`: 1440 × 874 with Operations, Summary, Filters / Sorts, and Cleaning Steps.
- `gallery/file-explorer-action.png`: 1440 × 870; `file-explorer-action-detail.png`: 920 × 616.
- `gallery/file-title-action.png`: 1440 × 120; `gallery/tab-context-menu.png`: 540 × 570.
- `gallery/import-options.png`: 1440 × 870 explicit override flow.

### Explore and clean

- `filter-result.png`: 1440 × 846 with a Benelux header-profile filter, its Column-profile Clear action, and
  synchronized sidebar state.
- `gallery/histogram-hover.png`: 448 × 480 with Counts / % controls and a focused tooltip that includes the bin's
  rows and percentage; `gallery/sort-priority.png`: 448 × 480 with ordered-sort interaction details.
- `gallery/column-search-wide.png`: 1440 × 865; `column-search-wide-detail.png`: 540 × 420.
- `gallery/operation-catalog.png`: complete operation selection.
- `gallery/operation-configuration.png`: grouped mean missing-value configuration for `revenue`, using `market` and
  `segment` as group keys before preview.
- `workflow.png`: 1440 × 870 draft, highlighted values, Apply / Discard, history, and native Polars code.
- `gallery/applied-step-inspection.png`: 1440 × 870; detail: 995 × 320.
- `gallery/latest-step-edited.png` and `gallery/latest-step-undone.png`: 1440 × 856; details: 448 × 440.
- `gallery/by-example-setup.png` and `gallery/by-example-preview.png`: complete dialogs with readable details.
  These focused webview-only scenes come from the current production-bundle browser harness.

### Notebooks and engines

- Accepted notebook source captures use a 1440 × 900 workbench except the 1280 × 600 Pandas inline scene.
- `gallery/notebook-variable-picker.png`: 1040 × 590; detail: 602 × 380. It shows an actual inline preview behind
  native DuckDB, Pandas, and Polars choices and contains no private setup source.
- `notebook-pandas.png`: 1210 × 540. Its 698 × 535 detail keeps the executed source cell, engine label, paging
  state, and one complete ten-row inline page readable in a half-width README cell; the full source retains the
  notebook toolbar and live Open action.
- `gallery/notebook-code-insertion.png`: 1000 × 288. It shows the generated Pandas function inside the exact
  originating notebook without empty canvas. The image is already tightly framed, so it has no duplicate detail copy.
- `gallery/notebook-polars.png`: complete source; its 884 × 675 detail focuses the draft, representative grid
  columns, and complete visible native Polars function.
- `gallery/notebook-duckdb.png`: complete source; its 872 × 700 detail keeps complete native column boundaries and
  focuses the Viewing / DuckDB badges, active filter, and editable two-key sort order.
- `gallery/notebook-pyspark.png`: complete source; its 820 × 610 detail focuses the Source order / Viewing only /
  PySpark badges, representative native rows, exact statistics, and distribution.
- `gallery/notebook-r-editing.png`: complete R notebook workbench with a Group and aggregate draft, generated R, and
  the native cleaning history.
- `vscode-notebook-r-operations-dark.png`: complete R notebook source beside the Operations list; its
  `vscode-notebook-r-operations-detail-dark.png` crop keeps the supported IRkernel dataframe rows readable.
- `gallery/r-quarto-variable-picker.png`: complete Quarto source document beside its rendered preview and native
  dataframe picker; its 1440 × 760 detail keeps all three parts readable in the README.

The cropped notebook and Quarto images use exact source pixels rather than resized workbenches. Each links to its
complete accepted source scene.

The setup cell is too implementation-focused for product documentation, so the public gallery uses the PySpark
workbench screenshot instead.

### Results, rich types, and editors

- `gallery/export-script.png` / `export-script-detail.png` and `gallery/export-data.png` /
  `export-data-detail.png` show the real export outcomes.
- `gallery/duckdb-rich-parquet.png` and `duckdb-rich-parquet-detail.png` show decimal, time-zone, list, and struct
  values from a generated Parquet source in the current production-bundle browser harness.
- `gallery/cursor-explore.png` and `gallery/high-contrast-explore.png` show the same product in Cursor and with
  high-contrast theme tokens.

## Required scene assertions

### Workbench

- Operations, Summary, Filters / Sorts, and Cleaning Steps are visible and populated.
- Summary identifies source, backend, mode, shape, selected column, missing cells, and duplicate rows.
- Numeric profiles show Min, Max, Mean, Median, standard deviation, Counts / % controls, and a usable distribution.
- Column names, type icons, sidebar rows, toolbar controls, and profile values remain contained.

### Viewing and history

- The filter scene shows the exact row count, `Filter: Benelux`, its Column-profile Clear action, and matching native
  Filters / Sorts state.
- The sort scene shows two keys, priorities, directions, null placement, reorder controls, and removal.
- Column search reaches the final fixture column without capping the result list.
- A new operation remains a draft until Apply; viewing filters/sorts remain outside the cleaning plan.
- Editing the latest step replaces it; Undo removes exactly that step and retains earlier work.

### Notebook engines

- The variable picker labels every visible row by native engine and type.
- Pandas shows ten complete preview rows and opens the complete live dataframe when available.
- Polars shows Editing and Polars badges, one draft, changed values, and executable Polars code.
- DuckDB shows Viewing and DuckDB badges, native relation shape, filter, paging, profiles, and ordered sorts without
  conversion.
- PySpark shows Source order, Viewing only, and PySpark badges, exact profiles, accessible ordering help, and no
  cleaning/export controls.
- Generated-code insertion is verified through the public `NotebookDocument`: one uniquely marked cell is added to
  the exact origin, surrounding cells remain unchanged, and that cell is visibly revealed before capture.
- Private setup, restart-probe, and runtime-transfer cells are collapsed before public notebook screenshots.

## Reproduction and publication gate

Run:

```bash
npm run compose:readme-media
npm run test:scripts:media
npm run verify:readme-media
```

Then inspect every README and gallery image at its rendered width. Do not publish when an image disagrees with the
documented capability, comes from another VSIX, contains internal setup content, or fails pixel equivalence.

After GitHub and both registries have rendered a release README, install the lockfile-pinned Chromium and run
`npm run verify:public-media-surfaces -- --source-sha "$RELEASE_SOURCE_SHA" --version "$RELEASE_VERSION"` from the
exact released source checkout. The SHA must be lowercase 40-hex and the version must be semantic without a leading
`v`. Starting with `1.2.1`, the verifier byte-compares the exact source README and package version; rejects an
undeclared media series; pre-stats a bounded inventory before any full file read; checks all 48 PNGs for chunk CRC,
ordered structure, complete decode, reviewed natural dimensions, standard sRGB, per-file and total budgets, and
immutable remote bytes; and opens GitHub, Visual Studio Marketplace, and Open VSX at DPR 2. Every one of the 20
rendered README images must retain its exact reviewed `src`/`currentSrc` and natural dimensions. Their width-only
presentation may not exceed 960 CSS pixels, its container, or the viewport, must preserve the natural aspect ratio, and must retain
at least two natural pixels per rendered CSS pixel. Four representative images repeat those checks near 760px and
1400px viewport widths. Before publication, `npm run verify:readme-responsive-render` renders the actual local README
and gallery at both widths, checks every screenshot and full-size link, and rejects document-level horizontal
overflow. A promotion with the contract on protected `main` runs the public check after registry
verification, with forty fresh-context attempts at thirty-second intervals inside a thirty-minute public-propagation
window. Only typed stale/unavailable registry observations retry; deterministic contract failures stop immediately.
The check can fail workflow success but cannot undo the public writes it observes. The same reviewed `main` contract
covers stable and preview releases.
