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
combine filters, choose the order of sort keys, or copy a selection. Column profiles and the dataset summary help you
spot empty fields, unusual values and repeated records before deciding what to change.

## Install

- **Stable:** [Visual Studio Marketplace](https://marketplace.visualstudio.com/items?itemName=Matt17BR.openwrangler),
  the newest non-preview version in [Open VSX](https://open-vsx.org/extension/Matt17BR/openwrangler), or the
  [latest GitHub release](https://github.com/Matt17BR/openwrangler/releases/latest).
- **Preview:** choose **Install Pre-Release Version** in your editor, or download a
  [GitHub prerelease](https://github.com/Matt17BR/openwrangler/releases).
- **From source:** [build and install the current main branch](https://github.com/Matt17BR/openwrangler/blob/main/CONTRIBUTING.md#build-and-install-from-source).

For a downloaded VSIX, use **Views and More Actions > Install from VSIX...** in the Extensions view.
See the [latest release notes](https://github.com/Matt17BR/openwrangler/releases/latest) or
[full changelog](https://github.com/Matt17BR/openwrangler/blob/main/CHANGELOG.md) for changes.

Features marked **2.6** require version 2.6.0 or newer, or a current
[source build](https://github.com/Matt17BR/openwrangler/blob/main/CONTRIBUTING.md#build-and-install-from-source).

## What you can do

- **Clean rows:** remove missing rows, remove duplicates, or flag repeated records with **Mark duplicates**.
- **Fill gaps:** use a fixed value, a statistic for the whole column or each group, a fallback column, ordered
  forward/backward fill, or interpolation.
- **Organize columns:** select, drop, rename, duplicate, and convert column types.
- **Clean text and categories:** trim spaces, replace text, change case, split into columns, extract with regular
  expressions, and encode categories.
- **Calculate values:** write numeric formulas, rank with ties, scale and round numbers, and format dates.
- **Create labels and flags:** use **Conditional column** for Text or Boolean results, including a separate result
  for missing inputs.
- **Reshape and summarize:** pivot between long and wide tables, or group rows and aggregate values.

Transform by Example infers a rule from your input/output examples. Preview it on other rows before applying it.
For work outside the catalog, a Custom Code step can use your dataframe engine directly. Available operations and
fill methods depend on the engine and column type; see the
[operation support guide](https://github.com/Matt17BR/openwrangler/blob/main/docs/feature-parity.md#cleaning-operations).

In **2.6**, opening a specific operation gives its settings the full dialog width. **Choose operation** shows or hides
the catalog without clearing unfinished fields. **Add step** starts with the catalog open.

<a href="https://github.com/Matt17BR/openwrangler/blob/main/docs/images/readme/gallery/operation-catalog.png"><img alt="The searchable cleaning-operation picker in Open Wrangler" src="https://raw.githubusercontent.com/Matt17BR/openwrangler/main/docs/images/readme/gallery/operation-catalog.png" width="960"></a>

_Search or browse cleaning operations, then configure the selected step._

## From data to code

**1. Open a source.** Save the [four-row sample CSV](https://raw.githubusercontent.com/Matt17BR/openwrangler/main/fixtures/sample.csv)
in your workspace, then choose **Open in Open Wrangler** from Explorer, an editor tab, or the toolbar. You can also
open TSV, Parquet, JSONL/NDJSON, and Excel files, or a supported live dataframe from a notebook output or toolbar.

**2. Preview a change.** Files open in Editing by default. If the sample opens in Viewing, set
`openWrangler.fileStartMode` to `editing` in Settings, close its Open Wrangler tab, and reopen the file.
Choose **Add step**, then **Drop missing rows** on **sales**.
Choose **Preview changes**: Paris disappears from the sample draft, leaving Milan, Rome, and Berlin. Review the
changed values and generated code before choosing **Apply step** or **Discard**.

**3. Keep the result and code.** Copy the generated code or use **Open Wrangler: Export Generated Script**.
Supported notebook and R-document sessions can insert code into the originating document. Export cleaned data to a
separate CSV or Parquet file; Open Wrangler never overwrites the source.

<a href="https://github.com/Matt17BR/openwrangler/blob/main/docs/images/readme/workflow.png"><img alt="A Polars formula draft with an added column, Apply and Discard actions, and generated Python code" src="https://raw.githubusercontent.com/Matt17BR/openwrangler/main/docs/images/readme/workflow.png" width="960"></a>

_A larger orders example: preview a new Polars formula column and its generated code before applying it._

Viewing filters and sorts change only the view. Add **Filter rows** or **Sort rows** steps to include them in the
cleaning plan.

## Review and revise your steps

Choose an applied step in **Cleaning Steps** to inspect its changes, then choose **Current view** to return. You can edit
or delete earlier steps, or use **Undo** and **Redo**. Changing an earlier step replays the later steps so the result
and generated code follow the updated plan.

In **2.6**, use **Open Wrangler: Open Another File with This Plan** to repeat confirmed steps on a file matching the
plan's original column names and types, even when their order changes. It opens a separate Editing session using the
same engine and import options. This supports Pandas, Polars, DuckDB and native R file plans without Custom Code or an
unfinished draft. Choose a file that is not already open in Open Wrangler and has no saved work for those import
options. Both source files remain unchanged.

<a href="https://github.com/Matt17BR/openwrangler/blob/main/docs/images/readme/gallery/applied-step-inspection.png"><img alt="Applied Formula-step inspection with projected_revenue highlighted, Edit and Delete controls, and Code Preview labeled Inspecting step 2 of 2" src="https://raw.githubusercontent.com/Matt17BR/openwrangler/main/docs/images/readme/gallery/applied-step-inspection-detail.png" width="960"></a>

_Inspect an applied step alongside its scoped code without changing the confirmed data or viewing filters._

## Use notebook data and keep the code

Run the cell that creates your dataframe, choose **Open in Open Wrangler** from the notebook toolbar, and select
its variable. Supported dataframe outputs also offer an inline preview with an action to open the full workbench.
The sidebar's **Data sources** view lists discovered Python and R dataframes; **Operations** holds the cleaning catalog.
Pandas and Polars notebook sessions support the same viewing and cleaning workflow as files.

Jupyter's separate Variables view can intermittently remain blank. The toolbar entry above does not use that view.
See the [known limitation](https://github.com/Matt17BR/openwrangler/blob/main/docs/feature-parity.md#sessions-and-generated-code).

Copy the generated code, save a Python script, or insert it into the notebook that opened the dataframe. The code
uses the selected engine: Pandas stays Pandas and Polars stays Polars. You can review and reuse the cleaning function
in the rest of your analysis.

Generated Python defines a cleaning function; it does not load or export data automatically. To reuse it, load the
next input with the same engine and import settings, preserve the expected column names and order, then call the
generated function, for example `result = clean_data(next_frame)`.
In **2.6**, DuckDB plans containing Custom Code require the input's exact connection:
`result = clean_data(next_frame, connection=con)`. Return Custom results derived from `df`, rather than a separate
connection. Regenerate exported scripts to receive the new capture behavior. See the
[capture requirements](https://github.com/Matt17BR/openwrangler/blob/main/docs/feature-parity.md#sessions-and-generated-code).

<a href="https://github.com/Matt17BR/openwrangler/blob/main/docs/images/editor-acceptance/vscode-notebook-code-insertion-dark.png"><img alt="Generated Pandas cleaning code inserted into an orders-analysis notebook" src="https://raw.githubusercontent.com/Matt17BR/openwrangler/main/docs/images/readme/gallery/notebook-code-insertion.png" width="960"></a>

_Bring the cleaning function back into the notebook that opened the dataframe._

DuckDB notebook relations and local PySpark DataFrames support viewing, filters, sorts and profiles, with the limits
in the table below. Their notebook sessions do not offer cleaning or export.
In **2.6**, Polars live notebook LazyFrames and lazy Custom Code results retain their complete native output to keep
row identities stable across pages. These results must fit memory, including old and new results retained during a
cleaning preview.
DuckDB notebook opening also captures the full result and asks you to select its originating connection. Keep that
connection open while viewing. File Custom results use private native snapshots. These captures increase memory,
execution time and temporary storage; the [capture requirements](https://github.com/Matt17BR/openwrangler/blob/main/docs/feature-parity.md#sessions-and-generated-code)
describe the limits. Automatic inline previews remain bounded.

## Work with R directly

Ordinary base `data.frame`, tibble and `data.table` objects in IRkernel notebooks have stable support in desktop
VS Code on Linux, macOS and Windows since [2.5.0](https://github.com/Matt17BR/openwrangler/releases/tag/v2.5.0).
Open Wrangler works directly in R, with no conversion through Python.

Preview cleaning steps, inspect history, copy or save generated R, and insert it back into the originating notebook.
CSV export is available; Parquet export requires `nanoparquet` and has type and precision limits.

<a href="https://github.com/Matt17BR/openwrangler/blob/main/docs/images/readme/gallery/notebook-r-editing.png"><img alt="An R Group and aggregate draft with regional totals, cleaning history and generated R" src="https://raw.githubusercontent.com/Matt17BR/openwrangler/main/docs/images/readme/gallery/notebook-r-editing.png" width="960"></a>

_Preview grouped R results alongside the cleaning history and generated R code._

In **2.6**, local R file support is **Preview**. On Linux, macOS and Windows, choose R from the dataframe engine picker to open CSV, TSV,
Parquet, JSONL/NDJSON or an Excel worksheet, or set `openWrangler.defaultBackend` to `r` before opening a file.
Auto also tries R when no compatible Python interpreter or file engine is available. An explicit Python engine choice
or a file-read error does not switch to R. CSV/TSV import options include UTF-16 and single-byte encodings,
ASCII delimiter/quote choices and headerless input. Quoted text retains its embedded line endings.
Parquet needs `nanoparquet`; Excel needs `readxl`. R loads the complete file into memory and requires an installed
Rscript; it does not need Python. The **Open Wrangler R** output channel records the selected
Rscript path. Choosing R from a Python session opens a separate tab and
preserves the existing steps. Changing an R file's import options also opens a separate session.

Custom Code can call installed R packages such as `dplyr`, `data.table` and `collapse`, and return a supported
base `data.frame`, tibble or `data.table`. In **2.6**, the result can change between these frame classes.

In **2.6**, R also displays homogeneous atomic list columns and flat scalar records. Use Explode List, or Extract Struct Fields
followed by dropping the parent column, to produce scalar columns for CSV or Parquet export. Recursive containers
remain unsupported.

R terminal sessions on Linux and managed `.R`, `.Rmd` and `.qmd` documents on Linux/macOS are **Preview**.
Cursor support is **experimental**. The [native R support guide](https://github.com/Matt17BR/openwrangler/blob/main/docs/feature-parity.md#native-r-support)
describes supported frame classes, operations and export limits.

## Supported dataframes

In **2.6**, use **Open Wrangler: Open DuckDB Table** to choose a local database and explore its base tables with the grid,
filters and profiles. Multiple tables can stay open. Close all its viewers before writing to the database.
Views, SQL editing, cleaning and exports are unavailable for this entry point. Computed columns can change between queries.

| Dataframe or source                               | View    | Cleaning and generated code         | Data export                |
| ------------------------------------------------- | ------- | ----------------------------------- | -------------------------- |
| Pandas files and live dataframes                  | Yes     | Pandas Python                       | CSV / Parquet              |
| Polars files and live dataframes                  | Yes     | Polars Python                       | CSV / Parquet              |
| DuckDB CSV / TSV / Parquet / JSONL (experimental) | Yes     | Supported operations, DuckDB Python | CSV / Parquet              |
| DuckDB database tables (experimental, **2.6**)    | Yes     | Unavailable                         | Unavailable                |
| DuckDB notebook relations                         | Yes     | Unavailable                         | Unavailable                |
| Local PySpark Classic / Connect notebooks         | Bounded | Unavailable                         | Unavailable                |
| R base data.frame, tibble, data.table             | Yes     | Supported operations, native R      | CSV / Parquet, with limits |

PySpark uses an existing local batch session. Open Wrangler does not install or configure Spark; streaming dataframes
and remote or authenticated clusters are unsupported.

In our [local CSV comparison](https://github.com/Matt17BR/openwrangler/blob/main/docs/performance/2026-09-16-released-products/review.md),
median times favored Open Wrangler with Polars for opening files and showing the three tested column profiles.
Pandas results were mixed, and Data Wrangler opened already-loaded notebook dataframes sooner.

## Compatibility and limits

Opening data, running code, and exporting require Workspace Trust. Open Wrangler stays inactive in Restricted Mode.

Use VS Code 1.106 or newer. Python workflows require Python 3.10 through 3.14. Missing packages are named before
Open Wrangler asks to install them. Other VS Code-based desktop editors have limited compatibility coverage;
browser-hosted editors are unsupported, and Remote SSH is outside current coverage.

For Windows Python notebooks, minimum CPython patches are 3.10.15, 3.11.10, and 3.12.4; supported 3.13 and 3.14
releases also qualify. Use the default local per-user temporary directory with its standard profile protections.
Custom or redirected temporary paths are unsupported.

See [supported environments](https://github.com/Matt17BR/openwrangler/blob/main/docs/feature-parity.md#supported-environments),
[file-reader and export limits](https://github.com/Matt17BR/openwrangler/blob/main/docs/feature-parity.md#files-and-exports),
and [notebook runtime recovery](https://github.com/Matt17BR/openwrangler/blob/main/docs/architecture.md#notebook-kernel-terminal-and-document-provenance).
The [reference](https://github.com/Matt17BR/openwrangler/blob/main/docs/reference.md) lists commands, settings, and operation parameters.

## Support and project

Browse the [product gallery](https://github.com/Matt17BR/openwrangler/blob/main/docs/media-gallery.md) and
[accessibility and keyboard guide](https://github.com/Matt17BR/openwrangler/blob/main/docs/accessibility.md).
The [product roadmap](https://github.com/Matt17BR/openwrangler/blob/main/docs/product-roadmap.md) tracks unscheduled
proposals such as matching renamed columns when reusing a plan, DuckDB notebook cleaning, and two-input workflows.
For contributions, see [CONTRIBUTING.md](https://github.com/Matt17BR/openwrangler/blob/main/CONTRIBUTING.md).
Report bugs in [GitHub Issues](https://github.com/Matt17BR/openwrangler/issues), or follow
[SECURITY.md](https://github.com/Matt17BR/openwrangler/blob/main/SECURITY.md) for vulnerability reports.

Open Wrangler grew out of an appreciation for [Microsoft Data Wrangler](https://github.com/microsoft/vscode-data-wrangler)
and a desire to extend the idea as an open-source project. It is independently built, supports more dataframe engines
natively, and is not affiliated with Microsoft. Licensed under the
[MIT License](https://github.com/Matt17BR/openwrangler/blob/main/LICENSE).
