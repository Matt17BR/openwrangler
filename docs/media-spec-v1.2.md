# Open Wrangler v1.2 product media

This specification adds reproducible product scenes that show how the packaged extension actually fits into
the editor. It supplements the compact v1.1 README assets; it does not replace or recompose them until the new
captures have passed packaged-editor acceptance.

## Source and capture contract

- Source: the real packaged VSIX in an isolated VS Code or Cursor profile.
- Viewport: 1440 × 900 CSS pixels at 100% zoom. The deterministic acceptance harness removes only the
  30-pixel native test-host title strip, so the final workbench PNG is 1440 × 870 pixels.
- Data: the deterministic 10,000-row `orders.csv` fixture derived from the packaged first-use journey. It includes a
  UTF-8 BOM, semicolon delimiter, quoted empty strings, missing values, dates, booleans, text, and numeric
  columns. No user or private data is allowed.
- Import: the production automatic CSV detector opens the fixture in a native Polars file session without an
  import-options prompt.
- Chrome: keep the native Activity Bar, the selected Open Wrangler icon, the Open Wrangler sidebar, the editor
  tab, and enough normal VS Code chrome to make the integration recognizable.
- Output: workbench PNGs named `<editor>-explore-dark.png` and `<editor>-workflow-dark.png`, with no
  post-processing beyond the deterministic test-host title-strip omission above. Do not crop further, scale,
  mask, place them in invented device frames, or substitute a browser-harness mock.
- Hygiene: no Quick Input, context menu, notification, hover, focus ring, test label, or temporary path may be
  visible. The fixture bytes must remain unchanged.

## Explore

The Explore scene demonstrates the extension as an editor product rather than only a dataframe grid.

- The Open Wrangler Activity Bar item is visibly selected. All four native views are expanded and populated:
  **Operations** shows real operation entries, **Summary** shows the active dataframe, **Filters / Sorts** shows
  the current empty viewing state, and **Cleaning Steps** shows Original data.
- **Summary** is expanded and shows the source, native Polars backend and editing mode, shape, column count,
  selected `revenue` column, missing cells, and duplicate rows.
- The production grid remains usable beside the sidebar.
- **Column profiles** is open for `revenue` and has finished loading exact Min, Max, Mean, Median, and the
  distribution.
- Sidebar rows, drawer statistics, visible grid headers, the source name, shape, and toolbar controls are fully
  contained; intentional horizontal grid scrolling is not clipping.

## Workflow

The Workflow scene demonstrates non-destructive viewing and cleaning together.

- **Filters / Sorts** is expanded and shows two ordered viewing sorts: `revenue` as Priority 1 and `market` as
  Priority 2.
- **Cleaning Steps** is expanded and shows Original data, one applied **Uppercase** step, and one separate
  **Uppercase** draft.
- The editor shows the production **Draft review** with its real data diff and Apply/Discard controls.
- The native bottom-panel **Code Preview** is visible and contains executable Polars code for both outputs,
  including `import polars as pl`.
- The grid, sidebar, draft review, and Code Preview remain simultaneously legible with no clipped labels,
  controls, or code.

## Publication gate

Do not reference these files from the README, marketplace listing, Open VSX listing, or compositor until exact
packaged captures exist and the geometry assertions pass. Once adopted, captions should explain the concrete
workflow shown instead of repeating generic feature claims.
