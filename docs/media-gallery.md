# Product gallery

These scenes use generated business data and show Open Wrangler as users see it in VS Code and Cursor. Dataset
sizes in the images describe the example, not a row or column limit.

[Workbench](#grid-and-sidebar) · [Files](#file-entry-points) ·
[Explore](#filters-profiles-sorts-and-column-search) · [Clean](#cleaning-drafts-and-history) ·
[Export](#export-code-and-cleaned-data) · [Notebooks](#notebook-dataframes) ·
[R preview](#r-notebooks-open-wrangler-2) ·
[Editors](#editor-and-theme-support)

## Grid and sidebar

<img alt="Open Wrangler in VS Code with a Polars dataframe, column summaries, profiles, and native Activity Bar views" src="images/readme/v1.2/explore.png" width="1440" height="870">

The workbench places the grid, column summaries, detailed profiles, and editor controls together.

<img alt="Operations, Summary, Filters and Sorts, and Cleaning Steps beside a dataframe draft" src="images/readme/v1.2/gallery/sidebar-overview.png" width="1440" height="874">

Operations, dataset health, viewing state, and cleaning history appear beside the grid. Filters and sorts remain
separate from applied cleaning steps.

## File entry points

<table>
  <tr>
    <td width="62%"><a href="images/readme/v1.2/gallery/file-explorer-action.png"><img alt="Opening a CSV in Open Wrangler from the VS Code Explorer context menu" src="images/readme/v1.2/gallery/file-explorer-action-detail.png" width="920" height="616"></a></td>
    <td width="38%"><a href="images/readme/v1.2/gallery/tab-context-menu.png"><img alt="Opening the active CSV in Open Wrangler from its editor-tab menu" src="images/readme/v1.2/gallery/tab-context-menu.png" width="540" height="570"></a></td>
  </tr>
  <tr>
    <td>Use the Explorer context menu to open CSV, TSV, Parquet, JSONL, NDJSON, or Excel files.</td>
    <td>Use the editor-tab menu when the file is already open.</td>
  </tr>
</table>

<a href="images/readme/v1.2/gallery/file-title-action.png"><img alt="The branded Open in Open Wrangler action in a CSV editor title bar" src="images/readme/v1.2/gallery/file-title-action.png" width="1440" height="120"></a>

The editor-title action is the shortest route when the source is already open. CSV and TSV inputs infer delimiter,
encoding, quote style, and header automatically. **Import options** is an explicit override for unusual sources.

<img alt="Import options starting from the detected configuration for a semicolon-delimited CSV" src="images/readme/v1.2/gallery/import-options.png" width="1440" height="870">

## Filters, profiles, sorts, and column search

<img alt="A Polars file session filtered to 14,285 DACH rows with the active predicate and matching native sidebar state" src="images/readme/v1.2/filter-result.png" width="1440" height="861">

The result count, predicate, clear controls, grid, and native Filters / Sorts view stay synchronized without
changing the source.

<table>
  <tr>
    <td width="50%"><a href="images/readme/v1.2/gallery/histogram-hover.png"><img alt="Revenue column profile with exact statistics and a focused histogram bin showing 20,174 to 21,357 and 398 rows" src="images/readme/v1.2/gallery/histogram-hover.png" width="448" height="480"></a></td>
    <td width="50%"><a href="images/readme/v1.2/gallery/sort-priority.png"><img alt="Two ordered sorts with priority, reorder, edit, and remove controls" src="images/readme/v1.2/gallery/sort-priority.png" width="448" height="480"></a></td>
  </tr>
  <tr>
    <td>Focus a histogram bin to see its interval and row count.</td>
    <td>Reorder sort keys, change their direction and null placement, or remove them.</td>
  </tr>
</table>

<a href="images/readme/v1.2/gallery/column-search-wide.png"><img alt="Searching to the final result in a 417-column synthetic dataframe" src="images/readme/v1.2/gallery/column-search-wide-detail.png" width="540" height="420"></a>

Column search reaches the complete schema and keeps type icons, full names, and keyboard navigation available even
for very wide dataframes.

## Cleaning drafts and history

<table>
  <tr>
    <td width="50%"><a href="images/readme/v1.2/gallery/operation-catalog.png"><img alt="The grouped Open Wrangler cleaning-operation catalog" src="images/readme/v1.2/gallery/operation-catalog.png" width="1280" height="874"></a></td>
    <td width="50%"><a href="images/readme/v1.2/gallery/operation-configuration.png"><img alt="Configuring a Formula column operation before preview" src="images/readme/v1.2/gallery/operation-configuration-detail.png" width="510" height="605"></a></td>
  </tr>
  <tr>
    <td>Search or browse 28 operations, including custom code and transformations inferred from examples.</td>
    <td>Edit the operation parameters, then choose <strong>Preview changes</strong> to create a draft.</td>
  </tr>
</table>

<img alt="A Polars formula draft with ordered viewing sorts, highlighted added values, Apply and Discard, and generated code" src="images/readme/v1.2/workflow.png" width="1440" height="870">

Every operation follows draft → preview → apply or discard. The visible result and executable engine-native code
are available before a step joins the plan.

<table>
  <tr>
    <td width="50%"><a href="images/readme/v1.2/gallery/latest-step-edited.png"><img alt="Cleaning Steps after editing the latest formula while retaining the earlier uppercase step" src="images/readme/v1.2/gallery/latest-step-edited-detail.png" width="448" height="440"></a></td>
    <td width="50%"><a href="images/readme/v1.2/gallery/latest-step-undone.png"><img alt="Cleaning Steps after undoing the formula while retaining the earlier uppercase step" src="images/readme/v1.2/gallery/latest-step-undone-detail.png" width="448" height="440"></a></td>
  </tr>
  <tr>
    <td>Editing the latest step updates that history entry instead of adding a duplicate.</td>
    <td>Undo removes the latest step without clearing the rest of the plan, filters, or sorts.</td>
  </tr>
</table>

<a href="images/readme/v1.2/gallery/applied-step-inspection.png"><img alt="Inspecting an applied Formula column step with history controls visible" src="images/readme/v1.2/gallery/applied-step-inspection-detail.png" width="995" height="320"></a>

Select any applied step to inspect that point in history, then return to confirmed data without changing the plan.

<table>
  <tr>
    <td width="50%"><a href="images/readme/v1.2/gallery/by-example-setup.png"><img alt="Teaching a structured account-code transformation with two examples" src="images/readme/v1.2/gallery/by-example-setup-detail.png" width="660" height="760"></a></td>
    <td width="50%"><a href="images/readme/v1.2/gallery/by-example-preview.png"><img alt="Previewing the learned country-code transformation on unseen values" src="images/readme/v1.2/gallery/by-example-preview-detail.png" width="700" height="525"></a></td>
  </tr>
  <tr>
    <td>Enter exact input and output examples for the account-code transformation.</td>
    <td>Preview the inferred transformation on unseen rows before applying it.</td>
  </tr>
</table>

## Export code and cleaned data

<table>
  <tr>
    <td width="50%"><a href="images/readme/v1.2/gallery/export-script.png"><img alt="Generated native Polars cleaning code saved as a Python script" src="images/readme/v1.2/gallery/export-script-detail.png" width="995" height="230"></a></td>
    <td width="50%"><a href="images/readme/v1.2/gallery/export-data.png"><img alt="A cleaned CSV exported separately and opened in VS Code" src="images/readme/v1.2/gallery/export-data-detail.png" width="995" height="344"></a></td>
  </tr>
  <tr>
    <td>Copy generated code or save it as a Python or R script. Python sessions can also insert it into the notebook.</td>
    <td>Editing sessions backed by Pandas, Polars, or DuckDB can export a cleaned CSV or Parquet file without overwriting the source.</td>
  </tr>
</table>

## Notebook dataframes

<table>
  <tr>
    <td width="51%"><a href="images/readme/v1.2/gallery/notebook-variable-picker.png"><img alt="Notebook variable picker labeling DuckDB, Pandas, and Polars variables by engine and dataframe type" src="images/readme/v1.2/gallery/notebook-variable-picker-detail.png" width="602" height="380"></a></td>
    <td width="49%"><a href="images/readme/v1.2/gallery/notebook-code-insertion.png"><img alt="Generated Pandas cleaning code inserted into the originating notebook" src="images/readme/v1.2/gallery/notebook-code-insertion.png" width="1000" height="288"></a></td>
  </tr>
  <tr>
    <td>The notebook picker labels each live variable by engine and dataframe type.</td>
    <td>Insert generated code into the notebook that opened the dataframe.</td>
  </tr>
</table>

<table>
  <tr>
    <td width="50%"><a href="images/readme/v1.2/notebook-pandas.png"><img alt="A Pandas dataframe previewed inline in a VS Code notebook" src="images/readme/v1.2/gallery/notebook-pandas-detail.png" width="698" height="535"></a></td>
    <td width="50%"><a href="images/readme/v1.2/gallery/notebook-polars.png"><img alt="A native Polars notebook session with a formula draft and generated Polars code" src="images/readme/v1.2/gallery/notebook-polars-detail.png" width="884" height="675"></a></td>
  </tr>
  <tr>
    <td>Pandas outputs open as live Pandas dataframes.</td>
    <td>Polars dataframes stay native and generate Polars code.</td>
  </tr>
  <tr>
    <td width="50%"><a href="images/readme/v1.2/gallery/notebook-duckdb.png"><img alt="A native DuckDB relation with filtering, paging, profiles, and ordered sorts" src="images/readme/v1.2/gallery/notebook-duckdb-detail.png" width="872" height="700"></a></td>
    <td width="50%"><a href="images/readme/v1.2/gallery/notebook-pyspark.png"><img alt="PySpark dataframe grid beside the revenue profile, with Source Order, Viewing Only, and PySpark badges" src="images/readme/v1.2/gallery/notebook-pyspark-detail.png" width="820" height="610"></a></td>
  </tr>
  <tr>
    <td>Experimental DuckDB relations are view-only and do not require dataframe conversion.</td>
    <td>Local PySpark 4.2.x Classic and Connect batch DataFrames support viewing, filtering, sorting, paging, and profiles.</td>
  </tr>
</table>

PySpark support is notebook-only and view-only. It uses an existing local 4.2 Classic or Connect session. The first
page loads without counting or caching the entire DataFrame, and the exact row total appears after the last page. The
ordering badge distinguishes Spark source order from an explicit sort and explains why repeatable rows need a unique
final sort key.

## R notebooks (Open Wrangler 2)

<a href="images/editor-acceptance/vscode-notebook-r-picker-dark.png"><img alt="An R notebook variable picker listing a base data frame, data.table, and tibble" src="images/editor-acceptance/vscode-notebook-r-picker-detail-dark.png" width="1040" height="380"></a>

Open Wrangler 2 development builds discover base `data.frame`, tibble, and `data.table` variables in the active
IRkernel. Each variable stays in R.

<img alt="An R data frame in Open Wrangler with two filters, two ordered sorts, and an exact revenue profile" src="images/editor-acceptance/vscode-notebook-r-dark.png" width="1440" height="881">

The current R workbench supports paging, filters, multi-column sorts, value search, and column and dataset profiles.
Editing mode currently supports Rename Column, Drop Columns, Select Columns, Clone Column, Text Length, and Lowercase.
Select keeps the order in which the columns were chosen. Text Length counts Unicode characters. Lowercase can update a
character or factor column or create a new character column. Both keep `NA`. All six use draft preview, generated R,
apply, discard, inspection, latest-step editing, and undo. Generated R can be copied or saved as a `.R` script.

<img alt="An R Rename Column draft in Open Wrangler with the cleaning history, Apply and Discard controls, and native generated R" src="images/editor-acceptance/vscode-notebook-r-editing-dark.png" width="1440" height="900">

The image shows Rename Column in VS Code. Drop Columns, ordered Select Columns, Clone Column, Text Length, and Lowercase
use the same editing controls in VS Code and Cursor. These six operations work with base data frames, tibbles, and keyed data
tables; the other R cleaning operations are not available yet.

Other R cleaning operations, cleaned-data export, notebook insertion, Quarto, R Markdown, and plain `.R` files are
not supported yet. They are planned after the native notebook path is complete.

## DuckDB nested and temporal values

<a href="images/readme/v1.2/gallery/duckdb-rich-parquet.png"><img alt="A DuckDB Parquet source with decimal, time-zone, list, and struct columns" src="images/readme/v1.2/gallery/duckdb-rich-parquet-detail.png" width="1500" height="595"></a>

Decimal, time-zone-aware timestamp, list, and struct values remain typed through the grid and summaries.

## Editor and theme support

<table>
  <tr>
    <td width="50%"><a href="images/readme/v1.2/gallery/cursor-explore.png"><img alt="Open Wrangler running in Cursor" src="images/readme/v1.2/gallery/cursor-explore.png" width="1440" height="865"></a></td>
    <td width="50%"><a href="images/readme/v1.2/gallery/high-contrast-explore.png"><img alt="Open Wrangler in a high-contrast theme with the operations sidebar, orders grid, and revenue profile outlined in cyan" src="images/readme/v1.2/gallery/high-contrast-explore.png" width="1440" height="845"></a></td>
  </tr>
  <tr>
    <td>The same VSIX is release-tested in VS Code and Cursor.</td>
    <td>The grid, sidebars, profiles, and controls use the editor's high-contrast theme tokens.</td>
  </tr>
</table>

Other desktop VS Code forks are experimental. The automated visual and accessibility suite also covers light and
dark themes, 80% to 200% zoom, keyboard-only operation, loading and error states, empty frames, long Unicode
content, and narrow and wide layouts. See [Testing](testing.md) for the acceptance process.
