# Product gallery

These scenes use generated business data and show Open Wrangler as users see it in VS Code and Cursor. Dataset
sizes in the images describe the example, not a row or column limit.

[Workbench](#workbench-at-a-glance) · [Files](#open-files-where-you-work) ·
[Explore](#explore-profile-and-navigate) · [Clean](#build-a-cleaning-plan) · [Export](#keep-the-result) ·
[Notebooks](#notebook-workflows) · [Editors](#editors-and-themes)

## Workbench at a glance

<img alt="Open Wrangler in VS Code with a Polars dataframe, column summaries, profiles, and native Activity Bar views" src="images/readme/v1.2/explore.png" width="1440" height="870">

The grid, column summaries, detailed profiles, and editor-native controls stay in one workspace.

<img alt="Operations, Summary, Filters and Sorts, and Cleaning Steps beside a dataframe draft" src="images/readme/v1.2/gallery/sidebar-overview.png" width="1440" height="874">

The sidebar keeps the operation catalog, dataset health, viewing state, and cleaning history visible beside the
data. Filters and sorts remain separate from applied cleaning steps.

## Open files where you work

<table>
  <tr>
    <td width="62%"><a href="images/readme/v1.2/gallery/file-explorer-action.png"><img alt="Opening a CSV in Open Wrangler from the VS Code Explorer context menu" src="images/readme/v1.2/gallery/file-explorer-action-detail.png" width="920" height="616"></a></td>
    <td width="38%"><a href="images/readme/v1.2/gallery/tab-context-menu.png"><img alt="Opening the active CSV in Open Wrangler from its editor-tab menu" src="images/readme/v1.2/gallery/tab-context-menu.png" width="540" height="570"></a></td>
  </tr>
  <tr>
    <td><strong>Explorer.</strong> Open CSV, TSV, Parquet, JSONL, NDJSON, or Excel files from the file tree.</td>
    <td><strong>Editor tab.</strong> The same action is available from an already-open file.</td>
  </tr>
</table>

<a href="images/readme/v1.2/gallery/file-title-action.png"><img alt="The branded Open in Open Wrangler action in a CSV editor title bar" src="images/readme/v1.2/gallery/file-title-action.png" width="1440" height="120"></a>

The editor-title action is the shortest route when the source is already open. CSV and TSV inputs infer delimiter,
encoding, quote style, and header automatically. **Import options** is an explicit override for unusual sources.

<img alt="Import options starting from the detected configuration for a semicolon-delimited CSV" src="images/readme/v1.2/gallery/import-options.png" width="1440" height="870">

## Explore, profile, and navigate

<img alt="A Polars file session filtered to 14,285 DACH rows with the active predicate and matching native sidebar state" src="images/readme/v1.2/filter-result.png" width="1440" height="861">

The result count, predicate, clear controls, grid, and native Filters / Sorts view stay synchronized without
changing the source.

<table>
  <tr>
    <td width="50%"><a href="images/readme/v1.2/gallery/histogram-hover.png"><img alt="A numeric histogram showing the exact interval and row count for a focused bin" src="images/readme/v1.2/gallery/histogram-hover.png" width="448" height="480"></a></td>
    <td width="50%"><a href="images/readme/v1.2/gallery/sort-priority.png"><img alt="Two ordered sorts with priority, reorder, edit, and remove controls" src="images/readme/v1.2/gallery/sort-priority.png" width="448" height="480"></a></td>
  </tr>
  <tr>
    <td><strong>Inspect distributions.</strong> Every bin has an easy-to-target interaction area and exact interval.</td>
    <td><strong>Control compound sorts.</strong> Reorder, change direction and null placement, or remove any key.</td>
  </tr>
</table>

<a href="images/readme/v1.2/gallery/column-search-wide.png"><img alt="Searching to the final result in a 417-column synthetic dataframe" src="images/readme/v1.2/gallery/column-search-wide-detail.png" width="540" height="420"></a>

Column search reaches the complete schema and keeps type icons, full names, and keyboard navigation available even
for very wide dataframes.

## Build a cleaning plan

<table>
  <tr>
    <td width="50%"><a href="images/readme/v1.2/gallery/operation-catalog.png"><img alt="The grouped Open Wrangler cleaning-operation catalog" src="images/readme/v1.2/gallery/operation-catalog.png" width="1280" height="874"></a></td>
    <td width="50%"><a href="images/readme/v1.2/gallery/operation-configuration.png"><img alt="Configuring a Formula column operation before preview" src="images/readme/v1.2/gallery/operation-configuration-detail.png" width="510" height="605"></a></td>
  </tr>
  <tr>
    <td><strong>Choose a task.</strong> Search or browse 27 built-in operations, custom code, and by-example transforms.</td>
    <td><strong>Configure safely.</strong> Parameters remain editable until Preview changes creates a draft.</td>
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
    <td><strong>Edit in place.</strong> Updating the latest step replaces it instead of duplicating history.</td>
    <td><strong>Undo precisely.</strong> Remove the latest step while keeping the rest of the plan and view.</td>
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
    <td><strong>Teach it.</strong> Provide exact input and output examples.</td>
    <td><strong>Review it.</strong> Confirm the deterministic candidate on unseen rows before applying.</td>
  </tr>
</table>

## Keep the result

<table>
  <tr>
    <td width="50%"><a href="images/readme/v1.2/gallery/export-script.png"><img alt="Generated native Polars cleaning code saved as a Python script" src="images/readme/v1.2/gallery/export-script-detail.png" width="995" height="230"></a></td>
    <td width="50%"><a href="images/readme/v1.2/gallery/export-data.png"><img alt="A cleaned CSV exported separately and opened in VS Code" src="images/readme/v1.2/gallery/export-data-detail.png" width="995" height="344"></a></td>
  </tr>
  <tr>
    <td><strong>Reusable code.</strong> Copy it, insert it into a notebook, or save a native Python script.</td>
    <td><strong>Separate output.</strong> Export cleaned CSV or Parquet without overwriting the source.</td>
  </tr>
</table>

## Notebook workflows

<table>
  <tr>
    <td width="51%"><a href="images/readme/v1.2/gallery/notebook-variable-picker.png"><img alt="Notebook variable picker labeling DuckDB, Pandas, and Polars variables by engine and dataframe type" src="images/readme/v1.2/gallery/notebook-variable-picker-detail.png" width="602" height="380"></a></td>
    <td width="49%"><a href="images/readme/v1.2/gallery/notebook-code-insertion.png"><img alt="Generated Pandas cleaning code inserted into the originating notebook" src="images/readme/v1.2/gallery/notebook-code-insertion-detail.png" width="1000" height="288"></a></td>
  </tr>
  <tr>
    <td><strong>Open the live object.</strong> Variables are labeled by engine and dataframe type before launch.</td>
    <td><strong>Keep the work reproducible.</strong> Insert generated code into the notebook that owns the data.</td>
  </tr>
</table>

<table>
  <tr>
    <td width="50%"><a href="images/readme/v1.2/notebook-pandas.png"><img alt="A Pandas dataframe previewed inline in a VS Code notebook" src="images/readme/v1.2/gallery/notebook-pandas-detail.png" width="698" height="535"></a></td>
    <td width="50%"><a href="images/readme/v1.2/gallery/notebook-polars.png"><img alt="A native Polars notebook session with a formula draft and generated Polars code" src="images/readme/v1.2/gallery/notebook-polars-detail.png" width="884" height="675"></a></td>
  </tr>
  <tr>
    <td><strong>Pandas.</strong> Preview inline, then open and edit the complete live dataframe.</td>
    <td><strong>Polars.</strong> Edit natively and generate executable Polars code.</td>
  </tr>
  <tr>
    <td width="50%"><a href="images/readme/v1.2/gallery/notebook-duckdb.png"><img alt="A native DuckDB relation with filtering, paging, profiles, and ordered sorts" src="images/readme/v1.2/gallery/notebook-duckdb-detail.png" width="872" height="700"></a></td>
    <td width="50%"><a href="images/readme/v1.2/gallery/notebook-pyspark.png"><img alt="An experimental native PySpark notebook session with exact profiles" src="images/readme/v1.2/gallery/notebook-pyspark-detail.png" width="820" height="610"></a></td>
  </tr>
  <tr>
    <td><strong>DuckDB, experimental.</strong> Query the same live relation without converting it.</td>
    <td><strong>PySpark 4.2.x, experimental.</strong> View, filter, sort, page, and profile in Spark.</td>
  </tr>
</table>

DuckDB and PySpark notebook sessions are currently viewing-only. PySpark uses the Spark session supplied by the
notebook and can be expensive to open on large or remote dataframes.

## Rich file types

<a href="images/readme/v1.2/gallery/duckdb-rich-parquet.png"><img alt="A DuckDB Parquet source with decimal, time-zone, list, and struct columns" src="images/readme/v1.2/gallery/duckdb-rich-parquet-detail.png" width="1500" height="595"></a>

Decimal, time-zone-aware timestamp, list, and struct values remain typed through the grid and summaries.

## Editors and themes

<table>
  <tr>
    <td width="50%"><a href="images/readme/v1.2/gallery/cursor-explore.png"><img alt="Open Wrangler running in Cursor" src="images/readme/v1.2/gallery/cursor-explore.png" width="1440" height="865"></a></td>
    <td width="50%"><a href="images/readme/v1.2/gallery/high-contrast-explore.png"><img alt="Open Wrangler populated with high-contrast theme tokens" src="images/readme/v1.2/gallery/high-contrast-explore.png" width="1440" height="845"></a></td>
  </tr>
  <tr>
    <td><strong>Cursor.</strong> VS Code and Cursor are release-tested from the same VSIX.</td>
    <td><strong>High contrast.</strong> Grid, views, profiles, and controls use native editor theme tokens.</td>
  </tr>
</table>

Other desktop VS Code forks are experimental. The automated visual and accessibility suite also covers light and
dark themes, 80% to 200% zoom, keyboard-only operation, loading and error states, empty frames, long Unicode
content, and narrow and wide layouts. See [Testing](testing.md) for the acceptance process.
