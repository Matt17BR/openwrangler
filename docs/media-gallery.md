# Product gallery

These scenes use deterministic, license-clean fixtures. Full-editor images come from the real packaged VSIX in
an isolated VS Code profile; focused UI images load the same production webview bundle. Fixture dimensions show
the captured scenario, not product row or column limits.

## Explore in VS Code

![Open Wrangler in VS Code with the selected Activity Bar icon, Operations, Summary, Filters and Sorts, Cleaning Steps, a virtualized Polars grid, and exact revenue profiles](images/readme/v1.2/explore.png)

The native sidebar keeps the operation catalog, active dataframe summary, viewing state, and cleaning history
visible beside the grid. Header summaries and the **Column profiles** drawer show exact statistics and a complete
distribution for the selected numeric column.

## Review a cleaning workflow

![Open Wrangler reviewing a Polars draft with two ordered viewing sorts, cleaning history, a data diff, and generated code](images/readme/v1.2/workflow.png)

The newest viewing sort is priority 1, priorities remain reorderable, and neither sort becomes a cleaning step.
The separate draft adds a column, highlights changed values, exposes Apply and Discard, and generates executable
Polars code in the native bottom panel.

## Open files where you already work

### Editor title action

[![The branded Open in Open Wrangler action in a CSV editor title bar](images/readme/v1.2/gallery/file-title-action.png)](images/readme/v1.2/gallery/file-title-action.png)

Open a supported file without leaving its current editor.

### Tab context menu

<a href="images/readme/v1.2/gallery/tab-context-menu.png"><img alt="The Open in Open Wrangler command in a CSV editor tab context menu" src="images/readme/v1.2/gallery/tab-context-menu.png" width="540"></a>

The same command is available from the open editor tab.

CSV and TSV inputs infer delimiter, encoding, quote style, and header automatically. **Import options** remains
available for explicit overrides.

## Notebook workflows

### Pandas inline preview

![A Pandas dataframe rendered by Open Wrangler inside a packaged VS Code Jupyter notebook](images/readme/v1.2/notebook-pandas.png)

The portable inline table is stored with the notebook. **Open in Open Wrangler** reconnects to the complete,
current live variable and pages it in the workbench.

### Polars live editing

![A live native Polars notebook session with a formula-column draft and generated Polars code](images/readme/v1.2/gallery/notebook-polars.png)

The dataframe remains in Polars while Open Wrangler pages, profiles, previews the draft, computes the diff, and
generates native code.

### DuckDB live relation

![A live native DuckDB relation with an exact filter, ordered two-key sort, paging, and column profiles](images/readme/v1.2/gallery/notebook-duckdb.png)

The viewing-only session queries the exact originating `DuckDBPyRelation`; it does not convert through Pandas,
Polars, or Arrow. The image shows a real filter, two reorderable sort priorities, requested profiles, and bounded
paging.

### PySpark Classic live notebook

![An experimental PySpark Classic notebook DataFrame with selected revenue column profiles](images/readme/v1.2/gallery/notebook-pyspark.png)

PySpark 4.2 support is experimental and viewing-only. Filtering, sorting, paging, and requested profiling run in
Spark; only bounded results return to the notebook runtime. File opening, cleaning, export, code insertion, and
saved inline snapshots are not supported.

## Rich DuckDB file types

![A file-backed DuckDB Parquet source with decimal, time-zone, list, and struct columns](images/readme/v1.2/gallery/duckdb-rich-parquet.png)

This focused production-webview scene uses a native DuckDB session over a deterministic 100,000-row Parquet
fixture. Decimal, time-zone-aware timestamp, list, and struct values remain typed through the grid and summaries.

## Transform by example

<table>
  <tr>
    <td width="50%"><a href="images/acceptance/by-example-dialog-dark-1280.png"><img alt="Open Wrangler by-example setup with two structured account-code examples" src="images/acceptance/by-example-dialog-dark-1280.png"></a></td>
    <td width="50%"><a href="images/acceptance/by-example-preview-dark-1280.png"><img alt="Open Wrangler by-example preview deriving country codes for ten structured account IDs" src="images/acceptance/by-example-preview-dark-1280.png"></a></td>
  </tr>
  <tr>
    <td><strong>Teach it.</strong> Give two source/output examples using the selected input columns.</td>
    <td><strong>Review it.</strong> Confirm the synthesized split across unseen account IDs before applying the new column.</td>
  </tr>
</table>

## Focused interaction and accessibility states

<table>
  <tr>
    <td width="50%"><a href="images/acceptance/operation-dialog-dark-1280.png"><img alt="Open Wrangler operation picker with searchable transformation groups" src="images/acceptance/operation-dialog-dark-1280.png"></a></td>
    <td width="50%"><a href="images/acceptance/step-inspection-dark-1280.png"><img alt="Open Wrangler inspecting an applied cleaning step and its data diff" src="images/acceptance/step-inspection-dark-1280.png"></a></td>
  </tr>
  <tr>
    <td><strong>Operation picker.</strong> Search the complete transformation catalog by task.</td>
    <td><strong>History inspection.</strong> Select an applied step without mutating the current plan.</td>
  </tr>
</table>

![Open Wrangler grid in a high-contrast theme](images/acceptance/grid-high-contrast-1280.png)

**High contrast.** The production UI follows VS Code theme tokens and remains keyboard accessible.
