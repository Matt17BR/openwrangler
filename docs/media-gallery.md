# Product gallery

These scenes use generated business data and show Open Wrangler as users see it in VS Code and Cursor. Dataset
sizes in the images describe the example, not a row or column limit.

[Workbench](#grid-and-sidebar) · [Files](#file-entry-points) ·
[Explore](#filters-profiles-sorts-and-column-search) · [Clean](#cleaning-drafts-and-history) ·
[Export](#export-code-and-cleaned-data) · [Notebooks](#notebook-dataframes) ·
[R preview](#r-notebooks-and-documents-199-preview) ·
[Editors](#editor-and-theme-support)

## Grid and sidebar

<a href="images/readme/v1.2/explore.png"><img alt="Open Wrangler in VS Code with a Polars dataframe, column summaries, profiles, and native Activity Bar views" src="images/readme/v1.2/explore.png" width="960"></a>

The workbench places the grid, column summaries, detailed profiles, and editor controls together.

<a href="images/readme/v1.2/gallery/sidebar-overview.png"><img alt="Operations, Summary, Filters and Sorts, and Cleaning Steps beside a dataframe draft" src="images/readme/v1.2/gallery/sidebar-overview.png" width="960"></a>

Operations, dataset health, viewing state, and cleaning history appear beside the grid. Filters and sorts remain
separate from applied cleaning steps.

## File entry points

<table>
  <tr>
    <td width="62%"><a href="images/readme/v1.2/gallery/file-explorer-action.png"><img alt="Opening a CSV in Open Wrangler from the VS Code Explorer context menu" src="images/readme/v1.2/gallery/file-explorer-action-detail.png" width="920"></a></td>
    <td width="38%"><a href="images/readme/v1.2/gallery/tab-context-menu.png"><img alt="Opening the active CSV in Open Wrangler from its editor-tab menu" src="images/readme/v1.2/gallery/tab-context-menu.png" width="540"></a></td>
  </tr>
  <tr>
    <td>Use the Explorer context menu to open CSV, TSV, Parquet, JSONL, NDJSON, or Excel files.</td>
    <td>Use the editor-tab menu when the file is already open.</td>
  </tr>
</table>

<a href="images/readme/v1.2/gallery/file-title-action.png"><img alt="The branded Open in Open Wrangler action in a CSV editor title bar" src="images/readme/v1.2/gallery/file-title-action.png" width="960"></a>

The editor-title action is the shortest route when the source is already open. CSV and TSV inputs infer delimiter,
encoding, quote style, and header automatically. **Import options** is an explicit override for unusual sources.

<a href="images/readme/v1.2/gallery/import-options.png"><img alt="Import options starting from the detected configuration for a semicolon-delimited CSV" src="images/readme/v1.2/gallery/import-options.png" width="960"></a>

## Filters, profiles, sorts, and column search

<a href="images/readme/v1.2/filter-result.png"><img alt="A Polars file session filtered to 14,287 Benelux rows with Filter and Clear in Column profiles and matching native sidebar state" src="images/readme/v1.2/filter-result.png" width="960"></a>

Click a column header to select it, or click a category or histogram bin in the header or Column profiles to filter.
The grid, profiles, and Filters / Sorts view stay synchronized. Above the grid, each active rule can be removed, the
latest filter can be undone, or all filters can be cleared without changing the source.

<table>
  <tr>
    <td width="50%"><a href="images/readme/v1.2/gallery/histogram-hover.png"><img alt="Revenue column profile with Counts and % controls and a focused 20,174 to 21,357 bin tooltip showing 398 rows (0.4%)" src="images/readme/v1.2/gallery/histogram-hover.png" width="448"></a></td>
    <td width="50%"><a href="images/readme/v1.2/gallery/sort-priority.png"><img alt="Two ordered sorts with priority, reorder, edit, and remove controls" src="images/readme/v1.2/gallery/sort-priority.png" width="448"></a></td>
  </tr>
  <tr>
    <td>Counts / % is shared by header summaries and Column profiles. Focus a histogram bin to see its range, row count, and percentage.</td>
    <td>Reorder sort keys, change their direction and null placement, or remove them.</td>
  </tr>
</table>

When a categorical profile has more entries than fit in its summary, **More values…** opens the searchable value
list without running the profile again.

<a href="images/readme/v1.2/gallery/column-search-wide.png"><img alt="Searching to the final result in a 417-column synthetic dataframe" src="images/readme/v1.2/gallery/column-search-wide-detail.png" width="540"></a>

Column search reaches the complete schema and keeps type icons, full names, and keyboard navigation available even
for very wide dataframes.

## Cleaning drafts and history

<table>
  <tr>
    <td width="50%"><a href="images/readme/v1.2/gallery/operation-catalog.png"><img alt="The grouped Open Wrangler cleaning-operation catalog" src="images/readme/v1.2/gallery/operation-catalog.png" width="960"></a></td>
    <td width="50%"><a href="images/readme/v1.2/gallery/operation-configuration.png"><img alt="Filling missing revenue values with the mean for each market and segment" src="images/readme/v1.2/gallery/operation-configuration-detail.png" width="510"></a></td>
  </tr>
  <tr>
    <td>Search or browse 28 operations, including custom code and transformations inferred from examples.</td>
    <td>Choose methods that fit the column type, including statistics by group, interpolation, ordered fills, and same-row fallbacks.</td>
  </tr>
</table>

<a href="images/readme/v1.2/workflow.png"><img alt="A Polars formula draft with ordered viewing sorts, highlighted added values, Apply and Discard, and generated code" src="images/readme/v1.2/workflow.png" width="960"></a>

Every operation follows draft → preview → apply or discard. The visible result and executable engine-native code
are available before a step joins the plan.

<table>
  <tr>
    <td width="50%"><a href="images/readme/v1.2/gallery/latest-step-edited.png"><img alt="Cleaning Steps after editing the latest formula while retaining the earlier uppercase step" src="images/readme/v1.2/gallery/latest-step-edited-detail.png" width="448"></a></td>
    <td width="50%"><a href="images/readme/v1.2/gallery/latest-step-undone.png"><img alt="Cleaning Steps after undoing the formula while retaining the earlier uppercase step" src="images/readme/v1.2/gallery/latest-step-undone-detail.png" width="448"></a></td>
  </tr>
  <tr>
    <td>Editing the latest step updates that history entry instead of adding a duplicate.</td>
    <td>Undo removes the latest step without clearing the rest of the plan, filters, or sorts.</td>
  </tr>
</table>

<a href="images/readme/v1.2/gallery/applied-step-inspection.png"><img alt="Inspecting an applied Formula column step with history controls visible" src="images/readme/v1.2/gallery/applied-step-inspection-detail.png" width="960"></a>

Select any applied step to inspect that point in history, then return to confirmed data without changing the plan.

<table>
  <tr>
    <td width="50%"><a href="images/readme/v1.2/gallery/by-example-setup.png"><img alt="Teaching a structured account-code transformation with two examples" src="images/readme/v1.2/gallery/by-example-setup-detail.png" width="660"></a></td>
    <td width="50%"><a href="images/readme/v1.2/gallery/by-example-preview.png"><img alt="Previewing the learned country-code transformation on unseen values" src="images/readme/v1.2/gallery/by-example-preview-detail.png" width="700"></a></td>
  </tr>
  <tr>
    <td>Enter exact input and output examples for the account-code transformation.</td>
    <td>Preview the inferred transformation on unseen rows before applying it.</td>
  </tr>
</table>

## Export code and cleaned data

<table>
  <tr>
    <td width="50%"><a href="images/readme/v1.2/gallery/export-script.png"><img alt="Generated native Polars cleaning code saved as a Python script" src="images/readme/v1.2/gallery/export-script-detail.png" width="960"></a></td>
    <td width="50%"><a href="images/readme/v1.2/gallery/export-data.png"><img alt="A cleaned CSV exported separately and opened in VS Code" src="images/readme/v1.2/gallery/export-data-detail.png" width="960"></a></td>
  </tr>
  <tr>
    <td>Copy generated code or save it as a Python or R script. Notebook sessions and Open Wrangler-managed R documents can also insert it into the source that opened the dataframe.</td>
    <td>Pandas, Polars, DuckDB, and local R editing sessions can export cleaned data without overwriting the source. R uses nanoparquet for Parquet files.</td>
  </tr>
</table>

## Notebook dataframes

<table>
  <tr>
    <td width="51%"><a href="images/readme/v1.2/gallery/notebook-variable-picker.png"><img alt="Notebook variable picker labeling DuckDB, Pandas, and Polars variables by engine and dataframe type" src="images/readme/v1.2/gallery/notebook-variable-picker-detail.png" width="602"></a></td>
    <td width="49%"><a href="images/readme/v1.2/gallery/notebook-code-insertion.png"><img alt="Generated Pandas cleaning code inserted into the originating notebook" src="images/readme/v1.2/gallery/notebook-code-insertion.png" width="960"></a></td>
  </tr>
  <tr>
    <td>The notebook picker labels each live variable by engine and dataframe type.</td>
    <td>Insert generated code into the notebook that opened the dataframe.</td>
  </tr>
</table>

<table>
  <tr>
    <td width="50%"><a href="images/readme/v1.2/notebook-pandas.png"><img alt="A Pandas dataframe previewed inline in a VS Code notebook" src="images/readme/v1.2/gallery/notebook-pandas-detail.png" width="698"></a></td>
    <td width="50%"><a href="images/readme/v1.2/gallery/notebook-polars.png"><img alt="A native Polars notebook session with a formula draft and generated Polars code" src="images/readme/v1.2/gallery/notebook-polars-detail.png" width="884"></a></td>
  </tr>
  <tr>
    <td>Pandas outputs open as live Pandas dataframes.</td>
    <td>Polars dataframes stay native and generate Polars code.</td>
  </tr>
  <tr>
    <td width="50%"><a href="images/readme/v1.2/gallery/notebook-duckdb.png"><img alt="A native DuckDB relation with filtering, paging, profiles, and ordered sorts" src="images/readme/v1.2/gallery/notebook-duckdb-detail.png" width="872"></a></td>
    <td width="50%"><a href="images/readme/v1.2/gallery/notebook-pyspark.png"><img alt="PySpark dataframe grid beside the revenue profile, with Source Order, Viewing Only, and PySpark badges" src="images/readme/v1.2/gallery/notebook-pyspark-detail.png" width="820"></a></td>
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

## R notebooks and documents (1.99 preview)

<a href="images/editor-acceptance/vscode-notebook-r-operations-dark.png"><img alt="Open Wrangler Operations listing base data.frame, tibble, data.table, and collapse dataframes from IRkernel" src="images/editor-acceptance/vscode-notebook-r-operations-detail-dark.png" width="960"></a>

Operations lists base `data.frame`, tibble, and `data.table` objects from the active IRkernel, including supported
collapse frames. Open Wrangler opens them without converting them to Python.

<a href="images/readme/v1.2/gallery/r-quarto-variable-picker.png"><img alt="A rendered Quarto table beside the source document and Open Wrangler dataframe picker" src="images/readme/v1.2/gallery/r-quarto-variable-picker-detail.png" width="960"></a>

For `.Rmd` and `.qmd` files, put the cursor in an enabled R or Python chunk and choose **Open in Open Wrangler**.
Open Wrangler runs only that chunk in its existing R or Python session, then lists the dataframes from that session.
This scene pairs the official Quarto preview with the dataframe picker; rendering remains separate from execution.

**Run R Document in Open Wrangler…** is the explicit all-R fallback for trusted `.R`, `.Rmd`, and `.qmd` files. It
runs a plain R file or the document's top-level R chunks in a separate Open Wrangler process and includes unsaved
changes. It does not replace the cursor-owned path for mixed R and Python documents.

<a href="images/editor-acceptance/vscode-notebook-r-dark.png"><img alt="An R data frame in Open Wrangler with filters, ordered sorts, and a revenue profile" src="images/editor-acceptance/vscode-notebook-r-dark.png" width="960"></a>

The workbench pages through the R object and supports filters, ordered sorts, value search, and column and dataset
profiles. Viewing changes do not alter the source object.

<a href="images/readme/v1.2/gallery/notebook-r-editing.png"><img alt="An R cleaning draft with history, Apply and Discard controls, and generated R" src="images/readme/v1.2/gallery/notebook-r-editing.png" width="960"></a>

Editing follows the same draft, preview, code, and apply workflow as the Python engines. This example groups regional
orders and shows the changed data, cleaning history, and generated R before applying the step.

<a href="images/editor-acceptance/vscode-notebook-r-code-insertion-dark.png"><img alt="Generated R cleaning code inserted into the notebook that opened the dataframe" src="images/editor-acceptance/vscode-notebook-r-code-insertion-detail-dark.png" width="960"></a>

Generated R can be copied, saved as a script, or inserted into the notebook or R document that opened the dataframe.
See the [operation and command reference](reference.md) for the current R operation and export support.

Frames created with `collapse::qDF()`, `qTBL()`, and `qDT()` use the matching base-frame, tibble, and data-table paths.
Grouped `GRP_df` and indexed `indexed_frame` objects are not supported. R notebooks work on Windows; direct document
runs currently require macOS or Linux.

## DuckDB nested and temporal values

<a href="images/readme/v1.2/gallery/duckdb-rich-parquet.png"><img alt="A DuckDB Parquet source with decimal, time-zone, list, and struct columns" src="images/readme/v1.2/gallery/duckdb-rich-parquet-detail.png" width="960"></a>

Decimal, time-zone-aware timestamp, list, and struct values remain typed through the grid and summaries.

## Editor and theme support

<table>
  <tr>
    <td width="50%"><a href="images/readme/v1.2/gallery/cursor-explore.png"><img alt="Open Wrangler running in Cursor" src="images/readme/v1.2/gallery/cursor-explore.png" width="960"></a></td>
    <td width="50%"><a href="images/readme/v1.2/gallery/high-contrast-explore.png"><img alt="Open Wrangler in a high-contrast theme with the operations sidebar, orders grid, and revenue profile outlined in cyan" src="images/readme/v1.2/gallery/high-contrast-explore.png" width="960"></a></td>
  </tr>
  <tr>
    <td>The same VSIX is release-tested in VS Code and Cursor.</td>
    <td>The grid, sidebars, profiles, and controls use the editor's high-contrast theme tokens.</td>
  </tr>
</table>

Other desktop VS Code forks are experimental. The automated visual and accessibility suite also covers light and
dark themes, 80% to 200% zoom, keyboard-only operation, loading and error states, empty frames, long Unicode
content, and narrow and wide layouts. See [Testing](testing.md) for the acceptance process.
