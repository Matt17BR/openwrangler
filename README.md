<p align="center">
  <img src="https://raw.githubusercontent.com/Matt17BR/openwrangler/9fc096eabb1d0b5c0a66c3371a2a8ff8ce40de22/assets/icon.png" width="128" height="128" alt="Open Wrangler logo">
</p>

<h1 align="center">Open Wrangler</h1>

Open Wrangler is a visual dataframe editor for VS Code and editors based on it. Open files or live notebook data,
make changes visually, and keep the generated Python or R code.

<p align="center">
  <a href="https://github.com/Matt17BR/openwrangler/releases/latest"><img src="https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fapi.github.com%2Frepos%2FMatt17BR%2Fopenwrangler%2Freleases%2Flatest&amp;query=%24.tag_name&amp;label=stable&amp;color=blue" alt="Latest stable GitHub release"></a>
  <a href="https://github.com/Matt17BR/openwrangler/actions/workflows/ci.yml"><img src="https://github.com/Matt17BR/openwrangler/actions/workflows/ci.yml/badge.svg?event=pull_request" alt="Pull request CI status"></a>
  <a href="https://marketplace.visualstudio.com/items?itemName=Matt17BR.openwrangler"><img src="https://img.shields.io/badge/VS%20Marketplace-install-blue" alt="Install from Visual Studio Marketplace"></a>
  <a href="https://open-vsx.org/extension/Matt17BR/openwrangler"><img src="https://img.shields.io/badge/Open%20VSX-install-blue" alt="Install from Open VSX"></a>
  <a href="https://github.com/Matt17BR/openwrangler/blob/main/LICENSE"><img src="https://img.shields.io/github/license/Matt17BR/openwrangler" alt="MIT license"></a>
</p>

<a href="https://github.com/Matt17BR/openwrangler/blob/main/docs/images/readme/explore.png"><img alt="A Polars dataframe in VS Code with missing-value counts, column distributions and a detailed revenue profile" src="https://raw.githubusercontent.com/Matt17BR/openwrangler/main/docs/images/readme/explore.png" width="960"></a>

_Inspect missing values and distributions beside the rows you are exploring._

Select a column to see its profile, then click a category or histogram bin to filter the view. Search for columns,
jump to a row with `Ctrl+G`, combine filters, order sort keys, and copy selections. The dataset summary shows empty
fields, unusual values and repeated records before you decide what to change.

## Install

- **Stable:** [Visual Studio Marketplace](https://marketplace.visualstudio.com/items?itemName=Matt17BR.openwrangler),
  the newest non-preview version on [Open VSX](https://open-vsx.org/extension/Matt17BR/openwrangler), or the
  [latest GitHub release](https://github.com/Matt17BR/openwrangler/releases/latest).
- **Preview:** choose **Install Pre-Release Version** in your editor, or download a
  [GitHub prerelease](https://github.com/Matt17BR/openwrangler/releases).
- **From source:** [build and install the current main branch](https://github.com/Matt17BR/openwrangler/blob/main/CONTRIBUTING.md#build-and-install-from-source).

To install a downloaded VSIX, use **Views and More Actions > Install from VSIX...** in the Extensions view. The
[changelog](https://github.com/Matt17BR/openwrangler/blob/main/CHANGELOG.md) lists the changes in each release.

## What you can do

- **Clean rows:** drop missing rows or duplicates, or flag repeated records with **Mark duplicates**.
- **Fill gaps:** use a fixed value, a column or group statistic, a fallback column, forward or backward fill, or
  interpolation.
- **Organize columns:** select, drop, rename, duplicate, and convert column types.
- **Clean text and categories:** trim spaces, replace text, change case, split, extract with regular expressions, and
  encode categories.
- **Calculate values:** write formulas, rank with ties, scale and round numbers, and format dates.
- **Create labels and flags:** build Text or Boolean results with **Conditional column**.
- **Reshape and summarize:** pivot between long and wide tables, or group rows and aggregate values.

**Transform by Example** learns a rule from your input and output examples and previews it on other rows. **Custom
Code** runs your own code in the dataframe's engine. Operations and fill methods vary by engine and column type; see
the [operation support guide](https://github.com/Matt17BR/openwrangler/blob/main/docs/feature-parity.md#cleaning-operations).

<a href="https://github.com/Matt17BR/openwrangler/blob/main/docs/images/readme/gallery/operation-catalog.png"><img alt="The searchable cleaning-operation picker in Open Wrangler" src="https://raw.githubusercontent.com/Matt17BR/openwrangler/main/docs/images/readme/gallery/operation-catalog.png" width="960"></a>

_Search or browse cleaning operations, then configure the selected step._

## From data to code

1. **Open a source.** Save the [four-row sample CSV](https://raw.githubusercontent.com/Matt17BR/openwrangler/main/fixtures/sample.csv)
   in your workspace and choose **Open in Open Wrangler** from Explorer, an editor tab, or the editor toolbar. TSV,
   Parquet, JSONL/NDJSON, and Excel files open the same way.
2. **Preview a change.** Choose **Add step**, then **Drop missing rows** on **sales**, then **Preview changes**. Paris
   disappears from the draft, leaving Milan, Rome, and Berlin. Review the changed values and generated code, then
   choose **Apply step** or **Discard**.
3. **Keep the result and code.** Copy the code, save it with **Open Wrangler: Export Generated Script**, or insert it
   into the notebook or R document that opened the data. Cleaned data exports to a separate CSV or Parquet file, so
   the source is never overwritten.

Files open in Editing unless `openWrangler.fileStartMode` is set to `viewing`. The engine picker in the toolbar switches
a file between Pandas, Polars, DuckDB and the R libraries in the same tab and replays your steps. If a step can't run with
the new engine, Open Wrangler asks before leaving it behind.

<a href="https://github.com/Matt17BR/openwrangler/blob/main/docs/images/readme/workflow.png"><img alt="A Polars formula draft with an added column, Apply and Discard actions, and generated Python code" src="https://raw.githubusercontent.com/Matt17BR/openwrangler/main/docs/images/readme/workflow.png" width="960"></a>

_Preview a new Polars formula column and its generated code before applying it._

Viewing filters and sorts change only what you see. Add a **Filter rows** or **Sort rows** step to make them part of
the cleaning plan.

## Review and revise your steps

Choose an applied step in **Cleaning Steps** to inspect its changes, then choose **Current view** to return. You can
edit or delete earlier steps, or use **Undo** and **Redo**. Later steps replay, so the result and code follow the
updated plan.

**Open Wrangler: Open Another File with This Plan** repeats the confirmed steps on another file with the same columns,
in any order. If a column was renamed, Open Wrangler asks which column replaces it. The new tab stays a preview until
you choose **Keep plan**, and neither file changes. Plans with Custom Code or an unfinished draft can't be copied.

<a href="https://github.com/Matt17BR/openwrangler/blob/main/docs/images/readme/gallery/applied-step-inspection.png"><img alt="Applied Formula-step inspection with projected_revenue highlighted, Edit and Delete controls, and Code Preview labeled Inspecting step 2 of 2" src="https://raw.githubusercontent.com/Matt17BR/openwrangler/main/docs/images/readme/gallery/applied-step-inspection-detail.png" width="960"></a>

_Inspect an applied step and its code without changing the confirmed data or viewing filters._

## Use notebook data

Run the cell that creates your dataframe, choose **Open in Open Wrangler** from the notebook toolbar, and pick the
variable. Dataframe outputs also show an inline preview with an **Open in Open Wrangler** button, and the side bar's
**Data Sources** view lists the Python and R dataframes it finds.

<a href="https://github.com/Matt17BR/openwrangler/blob/main/docs/images/readme/notebook-pandas.png"><img alt="A Pandas dataframe previewed inline below a notebook cell, with Rows, Previous and Next controls and an Open in Open Wrangler button" src="https://raw.githubusercontent.com/Matt17BR/openwrangler/main/docs/images/readme/notebook-pandas.png" width="960"></a>

_A notebook output previews the dataframe inline and opens it in the full workbench._

Pandas and Polars dataframes support the same viewing and cleaning workflow as files, and the generated code uses the
same library. The code defines a cleaning function: load the next input with the same engine and columns, then call
`result = clean_data(next_frame)`. DuckDB plans with Custom Code also take the input's connection,
`clean_data(next_frame, connection=con)`, and their Custom Code must return a result derived from `df`.

- **DuckDB relations** support native cleaning, generated code and export, except Custom Code. Opening one captures
  its full result and asks for its connection; keep that connection open, and commit or roll back any open
  transaction before cleaning or exporting.
- **Polars LazyFrames** and lazy Custom Code results are collected in full to keep row identities stable, so they must
  fit in memory.
- **PySpark** DataFrames from an existing local batch session support viewing, filters, sorts and profiles. Open
  Wrangler does not install or configure Spark; streaming dataframes and remote clusters are unsupported.

The [capture requirements](https://github.com/Matt17BR/openwrangler/blob/main/docs/feature-parity.md#sessions-and-generated-code)
list the memory and storage cost of each capture.

## Work with R

Open Wrangler works in R directly, with no conversion through Python. Base `data.frame`, tibble and `data.table`
objects in IRkernel notebooks are supported in desktop VS Code on Linux, macOS and Windows. Preview steps, inspect the
history, and copy, save or insert the generated R.

Choose **R · base**, **R · dplyr**, **R · data.table** or **R · collapse** for cleaning and generated code, either in
the engine picker or with `openWrangler.defaultRLibrary`. The package must be installed in the R environment that owns the dataframe. Custom
Code can call any installed package and return a base `data.frame`, tibble or `data.table`.

<a href="https://github.com/Matt17BR/openwrangler/blob/main/docs/images/readme/gallery/notebook-r-editing.png"><img alt="An R Group and aggregate draft with regional totals, cleaning history and generated R" src="https://raw.githubusercontent.com/Matt17BR/openwrangler/main/docs/images/readme/gallery/notebook-r-editing.png" width="960"></a>

_Preview grouped R results alongside the cleaning history and generated R code._

**R files (Preview).** Choose R in the engine picker, or set `openWrangler.defaultBackend` to `r`, to open CSV, TSV,
Parquet, JSONL/NDJSON or Excel files with Rscript alone. Auto also uses R when no compatible Python engine is
available. R loads the whole file into memory. Parquet needs `arrow` and `nanoparquet` (and `clock` for exact
timestamps), and Excel needs `readxl`. If a package is missing, the file view offers **Install required packages**.

R shows nanosecond and time-zone-free Parquet timestamps exactly, and displays homogeneous list columns and flat
records. Use **Explode List** or **Extract Struct Fields** to turn nested values into exportable columns. The
[native R support guide](https://github.com/Matt17BR/openwrangler/blob/main/docs/feature-parity.md#native-r-support)
lists the operations each library supports, including
[timestamp limits](https://github.com/Matt17BR/openwrangler/blob/main/docs/feature-parity.md#frames-cleaning-and-export-limits).

R terminal sessions on Linux and `.R`, `.Rmd` and `.qmd` documents on Linux and macOS are Preview. Cursor support is
experimental.

## Supported dataframes

| Dataframe or source                               | View    | Cleaning and generated code         | Data export                |
| ------------------------------------------------- | ------- | ----------------------------------- | -------------------------- |
| Pandas files and live dataframes                  | Yes     | Pandas Python                       | CSV / Parquet              |
| Polars files and live dataframes                  | Yes     | Polars Python                       | CSV / Parquet              |
| DuckDB CSV / TSV / Parquet / JSONL (experimental) | Yes     | Supported operations, DuckDB Python | CSV / Parquet              |
| DuckDB database tables and views (experimental)   | Yes     | Unavailable                         | Unavailable                |
| DuckDB notebook relations                         | Yes     | Supported operations, DuckDB Python | CSV / Parquet              |
| Local PySpark Classic / Connect notebooks         | Bounded | Unavailable                         | Unavailable                |
| R base data.frame, tibble, data.table             | Yes     | Supported operations, native R      | CSV / Parquet, with limits |

**Open Wrangler: Open DuckDB Table** browses the tables and views of a local database. A view runs once when opened,
and its viewer shows a fixed copy of the rows. Close the viewers before writing to the database.

In the [latest local performance comparison](https://github.com/Matt17BR/openwrangler/blob/main/docs/performance/2026-09-19-release-preparation/review.md),
Polars had the shortest median times for opening the tested CSV files and showing column profiles. The report also
covers native R and the limits of its six-column synthetic fixtures.

## Compatibility and limits

- Use VS Code 1.106 or newer. Opening data, running code and exporting require Workspace Trust, so Open Wrangler stays
  inactive in Restricted Mode.
- Python workflows need Python 3.10 to 3.14. Open Wrangler names any missing packages before offering to install
  them.
- Windows Python notebooks need CPython 3.10.15, 3.11.10, 3.12.4 or a later patch, or any supported 3.13 or 3.14
  release, and the default per-user temporary directory.
- Other VS Code-based desktop editors have limited coverage. Browser-hosted editors are unsupported, and Remote SSH is
  not yet covered.

See [supported environments](https://github.com/Matt17BR/openwrangler/blob/main/docs/feature-parity.md#supported-environments),
[file-reader and export limits](https://github.com/Matt17BR/openwrangler/blob/main/docs/feature-parity.md#files-and-exports),
and [notebook runtime recovery](https://github.com/Matt17BR/openwrangler/blob/main/docs/architecture.md#notebook-kernel-terminal-and-document-provenance).
The [reference](https://github.com/Matt17BR/openwrangler/blob/main/docs/reference.md) lists commands, settings, and
operation parameters.

## Support and project

Browse the [product gallery](https://github.com/Matt17BR/openwrangler/blob/main/docs/media-gallery.md), the
[accessibility and keyboard guide](https://github.com/Matt17BR/openwrangler/blob/main/docs/accessibility.md), or the
[product roadmap](https://github.com/Matt17BR/openwrangler/blob/main/docs/product-roadmap.md). To contribute, see
[CONTRIBUTING.md](https://github.com/Matt17BR/openwrangler/blob/main/CONTRIBUTING.md). Report bugs in
[GitHub Issues](https://github.com/Matt17BR/openwrangler/issues), and follow
[SECURITY.md](https://github.com/Matt17BR/openwrangler/blob/main/SECURITY.md) for vulnerability reports.

Open Wrangler grew out of an appreciation for [Microsoft Data Wrangler](https://github.com/microsoft/vscode-data-wrangler)
and a desire to extend the idea as an open-source project. It was built independently, supports more dataframe
engines natively, and is not affiliated with Microsoft. Licensed under the
[MIT License](https://github.com/Matt17BR/openwrangler/blob/main/LICENSE).
