<p align="center">
  <img src="https://raw.githubusercontent.com/Matt17BR/openwrangler/bafa557b73899489fe8c425ed7250f49fd893d3a/assets/icon.png" width="128" height="128" alt="Open Wrangler logo">
</p>

<h1 align="center">Open Wrangler</h1>

<p align="center">A dataframe workbench for VS Code, Cursor, and other desktop VS Code forks. It supports native Pandas and Polars editing, DuckDB and PySpark viewing, and early R notebook support in Open Wrangler 2 development builds.</p>

<a href="https://github.com/Matt17BR/openwrangler/blob/bafa557b73899489fe8c425ed7250f49fd893d3a/docs/images/readme/v1.2/explore.png"><img alt="Open Wrangler in VS Code with its dataframe grid, column profiles, and native Activity Bar views" src="https://raw.githubusercontent.com/Matt17BR/openwrangler/bafa557b73899489fe8c425ed7250f49fd893d3a/docs/images/readme/v1.2/explore.png" width="1440" height="870"></a>

_The workbench shows the dataframe, column profiles, filters, and cleaning steps in one editor._

<p align="center">Open Wrangler is an open-source project inspired by <a href="https://github.com/microsoft/vscode-data-wrangler">Microsoft Data Wrangler</a>. It was built independently and uses no Microsoft Data Wrangler code or assets.</p>

<!-- open-wrangler-release-status:start -->

<p align="center">
  <a href="https://github.com/Matt17BR/openwrangler/releases"><img src="https://img.shields.io/github/v/release/Matt17BR/openwrangler?display_name=tag&amp;sort=semver" alt="Latest GitHub release"></a>
  <a href="https://github.com/Matt17BR/openwrangler/actions/workflows/ci.yml"><img src="https://github.com/Matt17BR/openwrangler/actions/workflows/ci.yml/badge.svg?branch=main" alt="CI status"></a>
  <a href="https://marketplace.visualstudio.com/items?itemName=Matt17BR.openwrangler"><img src="https://vsmarketplacebadges.dev/version-short/Matt17BR.openwrangler.svg" alt="Visual Studio Marketplace version"></a>
  <a href="https://open-vsx.org/extension/Matt17BR/openwrangler"><img src="https://img.shields.io/open-vsx/v/Matt17BR/openwrangler?label=Open%20VSX" alt="Open VSX version"></a>
  <a href="https://github.com/Matt17BR/openwrangler/blob/main/LICENSE"><img src="https://img.shields.io/github/license/Matt17BR/openwrangler" alt="MIT license"></a>
</p>

## Install

- [Visual Studio Marketplace](https://marketplace.visualstudio.com/items?itemName=Matt17BR.openwrangler)
- [Open VSX](https://open-vsx.org/extension/Matt17BR/openwrangler)
- Manual or offline install from a [checksummed GitHub Release](https://github.com/Matt17BR/openwrangler/releases)

For a downloaded VSIX, open the Extensions view and choose **Views and More Actions → Install from VSIX…**.

| Editor                      | Support        |
| --------------------------- | -------------- |
| VS Code                     | Release-tested |
| Cursor                      | Release-tested |
| Other VS Code desktop forks | Experimental   |
| Browser-hosted `vscode.dev` | Unsupported    |

Open Wrangler requires VS Code 1.106 or newer. File sources and Python notebook dataframes use Python 3.10 through
3.14 from your configured path, selected environment, or a supported system interpreter. If a required Python package
is missing, Open Wrangler lists it and asks before installing anything. Native R notebook sessions use the selected
IRkernel instead of Python.

Opening data or using a notebook kernel requires a trusted workspace. Open Wrangler stays inactive in Restricted Mode.

<!-- open-wrangler-release-status:end -->

## Why Open Wrangler

- View and clean Pandas or Polars data without conversion. DuckDB viewing is experimental. Local PySpark 4.2 Classic/Connect batch DataFrames can be viewed from notebooks without leaving Spark.
- Each cleaning step previews changed values and generated code before you apply it.
- Filters and multi-column sorts change only the view. Exports write a separate file.
- The grid fetches visible rows and columns on demand. Supported file-backed Polars sources use lazy scans.

## Workbench

<a href="https://github.com/Matt17BR/openwrangler/blob/bafa557b73899489fe8c425ed7250f49fd893d3a/docs/images/readme/v1.2/gallery/sidebar-overview.png"><img alt="Open Wrangler showing Operations, Summary, Filters and Sorts, and Cleaning Steps beside a dataframe draft" src="https://raw.githubusercontent.com/Matt17BR/openwrangler/bafa557b73899489fe8c425ed7250f49fd893d3a/docs/images/readme/v1.2/gallery/sidebar-overview.png" width="1440" height="874"></a>

The sidebar keeps operations, dataset health, filters, sorts, and cleaning history beside the grid. See the
[product gallery](https://github.com/Matt17BR/openwrangler/blob/main/docs/media-gallery.md) for file entry points,
by-example transformations, themes, Cursor, DuckDB types, and notebook engines.

## Open files

Ordinary CSV and TSV files open with automatic delimiter, encoding, quote, and header detection. **Import
options** is available when a source needs an explicit override. Excel adds sheet selection; Parquet and
JSONL/NDJSON open directly.

<table>
  <tr>
    <td width="58%"><a href="https://github.com/Matt17BR/openwrangler/blob/bafa557b73899489fe8c425ed7250f49fd893d3a/docs/images/readme/v1.2/gallery/file-explorer-action.png"><img alt="Opening a CSV in Open Wrangler from the VS Code Explorer context menu" src="https://raw.githubusercontent.com/Matt17BR/openwrangler/bafa557b73899489fe8c425ed7250f49fd893d3a/docs/images/readme/v1.2/gallery/file-explorer-action-detail.png" width="920" height="616"></a></td>
    <td width="42%"><a href="https://github.com/Matt17BR/openwrangler/blob/bafa557b73899489fe8c425ed7250f49fd893d3a/docs/images/readme/v1.2/gallery/column-search-wide.png"><img alt="Searching to the final item in a 417-column synthetic dataframe" src="https://raw.githubusercontent.com/Matt17BR/openwrangler/bafa557b73899489fe8c425ed7250f49fd893d3a/docs/images/readme/v1.2/gallery/column-search-wide-detail.png" width="540" height="420"></a></td>
  </tr>
  <tr>
    <td>Open supported files from Explorer, the editor toolbar, tab menu, Command Palette, or <strong>Open With</strong>.</td>
    <td>Column search covers the full schema and includes data-type icons.</td>
  </tr>
</table>

<a href="https://github.com/Matt17BR/openwrangler/blob/bafa557b73899489fe8c425ed7250f49fd893d3a/docs/images/readme/v1.2/filter-result.png"><img alt="Open Wrangler showing a DACH filter, 14,285 matching rows, clear controls, and the same filter in the native sidebar" src="https://raw.githubusercontent.com/Matt17BR/openwrangler/bafa557b73899489fe8c425ed7250f49fd893d3a/docs/images/readme/v1.2/filter-result.png" width="1440" height="861"></a>

_The active filter matches 14,285 rows. The grid and sidebar show the same predicate and clear controls without
changing the source._

<table>
  <tr>
    <td width="50%"><a href="https://github.com/Matt17BR/openwrangler/blob/bafa557b73899489fe8c425ed7250f49fd893d3a/docs/images/readme/v1.2/gallery/histogram-hover.png"><img alt="Revenue column profile with exact statistics and a focused histogram bin showing 20,174 to 21,357 and 398 rows" src="https://raw.githubusercontent.com/Matt17BR/openwrangler/bafa557b73899489fe8c425ed7250f49fd893d3a/docs/images/readme/v1.2/gallery/histogram-hover.png" width="448" height="480"></a></td>
    <td width="50%"><a href="https://github.com/Matt17BR/openwrangler/blob/bafa557b73899489fe8c425ed7250f49fd893d3a/docs/images/readme/v1.2/gallery/sort-priority.png"><img alt="Two ordered sorts with inline priority, reorder, edit, and remove controls" src="https://raw.githubusercontent.com/Matt17BR/openwrangler/bafa557b73899489fe8c425ed7250f49fd893d3a/docs/images/readme/v1.2/gallery/sort-priority.png" width="448" height="480"></a></td>
  </tr>
  <tr>
    <td>Hover or focus any histogram bin to see its range and row count.</td>
    <td>Add multiple sort keys, then reorder them or change direction and null placement.</td>
  </tr>
</table>

## Transformations

Choose from 28 operations, including filling missing values, custom Pandas or Polars code, and transformations inferred
from examples. A draft stays separate until you apply it, and applied steps can be inspected, edited, or undone.

<a href="https://github.com/Matt17BR/openwrangler/blob/bafa557b73899489fe8c425ed7250f49fd893d3a/docs/images/readme/v1.2/workflow.png"><img alt="Open Wrangler reviewing a Polars draft with two viewing sorts, cleaning history, highlighted new values, Apply and Discard, and generated code" src="https://raw.githubusercontent.com/Matt17BR/openwrangler/bafa557b73899489fe8c425ed7250f49fd893d3a/docs/images/readme/v1.2/workflow.png" width="1440" height="870"></a>

_This preview shows the changed values and generated Polars code. The two sorts affect only the current view._

<table>
  <tr>
    <td width="50%"><a href="https://github.com/Matt17BR/openwrangler/blob/bafa557b73899489fe8c425ed7250f49fd893d3a/docs/images/readme/v1.2/gallery/latest-step-edited.png"><img alt="Cleaning Steps after editing the latest formula while preserving the earlier uppercase step" src="https://raw.githubusercontent.com/Matt17BR/openwrangler/bafa557b73899489fe8c425ed7250f49fd893d3a/docs/images/readme/v1.2/gallery/latest-step-edited-detail.png" width="448" height="440"></a></td>
    <td width="50%"><a href="https://github.com/Matt17BR/openwrangler/blob/bafa557b73899489fe8c425ed7250f49fd893d3a/docs/images/readme/v1.2/gallery/latest-step-undone.png"><img alt="Cleaning Steps after undoing the formula and retaining the uppercase step" src="https://raw.githubusercontent.com/Matt17BR/openwrangler/bafa557b73899489fe8c425ed7250f49fd893d3a/docs/images/readme/v1.2/gallery/latest-step-undone-detail.png" width="448" height="440"></a></td>
  </tr>
  <tr>
    <td>Editing the latest step updates that history entry instead of adding a duplicate.</td>
    <td>Undo removes the latest step without clearing filters or sorts.</td>
  </tr>
</table>

## Notebook workflows

In trusted Python notebooks, Open Wrangler previews Pandas, Polars, and DuckDB outputs and lists live variables from
the notebook toolbar. **Open in Open Wrangler** loads the current live dataframe. If you reopened a notebook and only
its saved output is available, rerun the cell first.

If Microsoft Data Wrangler is installed too, choose which extension owns automatic previews with **Open Wrangler:
Choose Notebook Preview Provider**.

<table>
  <tr>
    <td width="44%"><a href="https://github.com/Matt17BR/openwrangler/blob/bafa557b73899489fe8c425ed7250f49fd893d3a/docs/images/readme/v1.2/gallery/notebook-variable-picker.png"><img alt="Notebook variable picker labeling Pandas, Polars, and DuckDB variables by engine and dataframe type" src="https://raw.githubusercontent.com/Matt17BR/openwrangler/bafa557b73899489fe8c425ed7250f49fd893d3a/docs/images/readme/v1.2/gallery/notebook-variable-picker-detail.png" width="602" height="380"></a></td>
    <td width="56%"><a href="https://github.com/Matt17BR/openwrangler/blob/bafa557b73899489fe8c425ed7250f49fd893d3a/docs/images/readme/v1.2/gallery/notebook-code-insertion.png"><img alt="Generated Pandas cleaning code inserted into the originating VS Code notebook" src="https://raw.githubusercontent.com/Matt17BR/openwrangler/bafa557b73899489fe8c425ed7250f49fd893d3a/docs/images/readme/v1.2/gallery/notebook-code-insertion.png" width="1000" height="288"></a></td>
  </tr>
  <tr>
    <td>The notebook picker labels each live variable by engine and dataframe type.</td>
    <td>Insert generated code into the notebook that opened the dataframe.</td>
  </tr>
</table>

<table>
  <tr>
    <td width="50%"><a href="https://github.com/Matt17BR/openwrangler/blob/bafa557b73899489fe8c425ed7250f49fd893d3a/docs/images/readme/v1.2/notebook-pandas.png"><img alt="Pandas dataframe previewed inline inside a VS Code notebook" src="https://raw.githubusercontent.com/Matt17BR/openwrangler/bafa557b73899489fe8c425ed7250f49fd893d3a/docs/images/readme/v1.2/gallery/notebook-pandas-detail.png" width="698" height="535"></a></td>
    <td width="50%"><a href="https://github.com/Matt17BR/openwrangler/blob/bafa557b73899489fe8c425ed7250f49fd893d3a/docs/images/readme/v1.2/gallery/notebook-polars.png"><img alt="A native Polars notebook session with a formula draft and generated Polars code" src="https://raw.githubusercontent.com/Matt17BR/openwrangler/bafa557b73899489fe8c425ed7250f49fd893d3a/docs/images/readme/v1.2/gallery/notebook-polars-detail.png" width="884" height="675"></a></td>
  </tr>
  <tr>
    <td>Pandas outputs open as live Pandas dataframes.</td>
    <td>Polars dataframes stay native and generate Polars code.</td>
  </tr>
  <tr>
    <td width="50%"><a href="https://github.com/Matt17BR/openwrangler/blob/bafa557b73899489fe8c425ed7250f49fd893d3a/docs/images/readme/v1.2/gallery/notebook-duckdb.png"><img alt="A native DuckDB relation with filtering, paging, profiles, and ordered sorts" src="https://raw.githubusercontent.com/Matt17BR/openwrangler/bafa557b73899489fe8c425ed7250f49fd893d3a/docs/images/readme/v1.2/gallery/notebook-duckdb-detail.png" width="872" height="700"></a></td>
    <td width="50%"><a href="https://github.com/Matt17BR/openwrangler/blob/bafa557b73899489fe8c425ed7250f49fd893d3a/docs/images/readme/v1.2/gallery/notebook-pyspark.png"><img alt="PySpark dataframe grid beside the revenue profile, with Source Order, Viewing Only, and PySpark badges" src="https://raw.githubusercontent.com/Matt17BR/openwrangler/bafa557b73899489fe8c425ed7250f49fd893d3a/docs/images/readme/v1.2/gallery/notebook-pyspark-detail.png" width="820" height="610"></a></td>
  </tr>
  <tr>
    <td>DuckDB relations are view-only and do not require dataframe conversion.</td>
    <td>Local PySpark 4.2.x Classic and Connect batch DataFrames support viewing, filtering, sorting, paging, and profiles.</td>
  </tr>
</table>

PySpark support is notebook-only and view-only. It uses an existing local 4.2 Classic or Connect session; Open
Wrangler does not install or configure Spark. Streaming DataFrames and remote or authenticated clusters are not
supported.

PySpark loads pages sequentially. The toolbar says **Source order** until you add a sort, then **Sorted**. Spark can
change source order, and rows tied across every sort key can move when it reruns the DataFrame. Use a unique final
sort key when you need repeatable rows.

Open Wrangler does not count or cache the whole PySpark dataframe before showing the first page; the row total
appears after the final page. If the data changes while you page through it, Open Wrangler asks you to reopen the
variable. A temporary Spark Connect outage leaves the current grid in place and shows **Retry page**. If the server
has lost the session or dataframe, rerun the cell that creates the same variable and choose **Reconnect**. The old
grid stays visible unless that reconnect works.

Closing the view leaves Spark work that has already started alone, so Open Wrangler cannot cancel unrelated notebook
jobs.

Open Wrangler 2 development builds can also open base R `data.frame`, tibble, and `data.table` variables from
IRkernel. The R workbench supports paging, filters, multi-column sorts, value search, and profiles. Editing mode
currently supports **Rename Column**, **Drop Columns**, **Select Columns**, **Clone Column**, **Convert type**,
**Text Length**, and **Lowercase**. Select Columns keeps the order in which columns are chosen. Text Length accepts character and factor
columns and counts Unicode characters. Lowercase accepts the same inputs and can update the source column or write to
a new character column. Convert type handles strings, integers, floating-point values, booleans, dates, and datetimes.
Values that cannot be converted become `NA`. All seven operations can be previewed, applied, discarded, inspected,
edited, or undone.
Generated R can be copied, saved as a `.R` script, or inserted into the notebook that opened the dataframe.

Convert type does not change an active `data.table` key column. Clone that column first, then convert the copy.

Other R cleaning operations, cleaned-data export, live dataframes from plain `.R` documents, R Markdown, and Quarto
are not supported yet. They are planned after the native notebook path is complete. The
[current R notebook screenshots](https://github.com/Matt17BR/openwrangler/blob/v2/docs/media-gallery.md#r-notebooks-open-wrangler-2)
show the live variable picker, profiles, a Rename Column draft, and generated R inserted into its notebook.

## Export

<table>
  <tr>
    <td width="50%"><a href="https://github.com/Matt17BR/openwrangler/blob/bafa557b73899489fe8c425ed7250f49fd893d3a/docs/images/readme/v1.2/gallery/export-script.png"><img alt="Generated native Polars cleaning code saved as a Python script" src="https://raw.githubusercontent.com/Matt17BR/openwrangler/bafa557b73899489fe8c425ed7250f49fd893d3a/docs/images/readme/v1.2/gallery/export-script-detail.png" width="995" height="230"></a></td>
    <td width="50%"><a href="https://github.com/Matt17BR/openwrangler/blob/bafa557b73899489fe8c425ed7250f49fd893d3a/docs/images/readme/v1.2/gallery/export-data.png"><img alt="A cleaned CSV exported separately and opened in VS Code" src="https://raw.githubusercontent.com/Matt17BR/openwrangler/bafa557b73899489fe8c425ed7250f49fd893d3a/docs/images/readme/v1.2/gallery/export-data-detail.png" width="995" height="344"></a></td>
  </tr>
  <tr>
    <td>Copy generated code or save it as a Python or R script. Python and R notebook sessions can also insert it into the notebook that opened the dataframe.</td>
    <td>Editing sessions backed by Pandas, Polars, or DuckDB can export a cleaned CSV or Parquet file without overwriting the source.</td>
  </tr>
</table>

## Engines and formats

| Engine               | Files                                  | Notebook data                         | How it runs                                                   |
| -------------------- | -------------------------------------- | ------------------------------------- | ------------------------------------------------------------- |
| Polars               | CSV, TSV, Parquet, JSONL/NDJSON, Excel | DataFrame, LazyFrame, Series          | Native; lazy scans for CSV, TSV, Parquet, and JSONL           |
| Pandas               | CSV, TSV, Parquet, JSONL/NDJSON, Excel | DataFrame, Series                     | Native, including duplicate column labels                     |
| DuckDB, experimental | CSV, TSV, Parquet, JSONL/NDJSON        | DuckDBPyRelation                      | Native; notebook relations are viewing-only                   |
| PySpark 4.2.x        | No                                     | Local Classic/Connect batch DataFrame | Native notebook viewing, filtering, sorting, and profiles     |
| R (v2 development)   | No                                     | `data.frame`, tibble, `data.table`    | Native IRkernel viewing and seven current cleaning operations |

Automatic file selection prefers Polars, then DuckDB, then Pandas. A file backend can also be pinned in settings.
Notebook variables are matched to their supported native type, including Pandas 2 and 3, DuckDB relations, and local
PySpark 4.2 Classic/Connect batch DataFrames. Polars LazyFrames collect when opened from a notebook.

To keep a notebook result native to DuckDB, open the relation itself. For example,
`orders = duckdb.read_csv("orders.csv")`. Calling `orders.df()` explicitly creates a Pandas DataFrame, so Open
Wrangler correctly opens that resulting object with Pandas.

For a trusted Pandas pickle, right-click the file and choose **Convert Trusted Pickle to Parquet…**. Open Wrangler
asks where to save the Parquet file and asks again before Python loads the pickle. The conversion is saved separately;
Open Wrangler never overwrites the pickle.

See the [operation and command reference](https://github.com/Matt17BR/openwrangler/blob/main/docs/reference.md)
for the complete surface.

## Performance and scale

Open Wrangler fetches the rows and columns needed by the grid instead of loading the whole dataset into the webview.
The 1.2.1 benchmark uses a 100,000 × 50 CSV and a 1,000,000 × 20 Parquet file. Larger datasets can work, but the
practical limit depends on the engine and machine.

We compared Open Wrangler 1.2.1 with Microsoft Data Wrangler 1.24.2 on the same machine. The table reports median
times; the faster result is **bold**. Data Wrangler converts Polars data to Pandas for these workflows, while Open
Wrangler runs it with Polars.

| Data           | Task                  | Open Wrangler | Data Wrangler |
| -------------- | --------------------- | ------------: | ------------: |
| Pandas CSV     | Show notebook preview |    **0.34 s** |        1.49 s |
| Pandas CSV     | Open workbench        |    **0.60 s** |        1.01 s |
| Pandas CSV     | Profile every column  |    **5.58 s** |       18.80 s |
| Polars CSV     | Show notebook preview |    **0.32 s** |        1.50 s |
| Polars CSV     | Open workbench        |    **0.53 s** |        0.99 s |
| Polars CSV     | Profile every column  |    **5.54 s** |       18.81 s |
| Pandas Parquet | Show notebook preview |    **0.24 s** |        1.53 s |
| Pandas Parquet | Open workbench        |    **0.67 s** |        0.69 s |
| Pandas Parquet | Profile every column  |    **7.64 s** |        7.95 s |
| Polars Parquet | Show notebook preview |    **0.20 s** |        1.49 s |
| Polars Parquet | Open workbench        |    **0.48 s** |        0.69 s |
| Polars Parquet | Profile every column  |    **7.20 s** |        8.23 s |

The [full results](https://github.com/Matt17BR/openwrangler/blob/main/docs/performance/data-wrangler-1.2.1/review.md)
include p95 timings, memory use, outcome counts, exact versions, and the test method. Small Pandas/Polars differences
within Data Wrangler are not conversion benchmarks: variables were created before timing, and the measured UI work
dominates those rows. The
[installed-editor benchmarks](https://github.com/Matt17BR/openwrangler/blob/main/docs/testing.md#performance-fixtures)
cover first-grid and scrolling performance in VS Code and Cursor.

These are the current stable results. We will rerun the comparison from the exact Open Wrangler 2 release candidate
before v2 ships.

## Roadmap

- **v1:** keep improving performance, DuckDB coverage, and support for other desktop VS Code forks. Fork support is
  currently experimental.
- **v2:** finish native R notebook support for data frames, tibbles, and `data.table`, then add Quarto and R Markdown.
  Rename, Drop, Select, Clone, Convert type, Text Length, and Lowercase are available now. Generated R can be inserted
  into its originating notebook. The rest of the cleaning catalog, data export, and plain `.R` workflows are planned
  after the native notebook path is complete. The
  [R architecture decision](https://github.com/Matt17BR/openwrangler/blob/main/docs/decisions/0001-native-r-runtime.md)
  records the IRkernel-first plan and release boundary. Progress is tracked in
  [#87](https://github.com/Matt17BR/openwrangler/issues/87).

## Contributing and support

Contributions are welcome. See
[CONTRIBUTING.md](https://github.com/Matt17BR/openwrangler/blob/main/CONTRIBUTING.md), use
[GitHub Issues](https://github.com/Matt17BR/openwrangler/issues) for bugs and feature requests, and follow
[SECURITY.md](https://github.com/Matt17BR/openwrangler/blob/main/SECURITY.md) for vulnerability reports.

## License

Open Wrangler is licensed under the [MIT License](https://github.com/Matt17BR/openwrangler/blob/main/LICENSE).
It is not affiliated with Microsoft.
