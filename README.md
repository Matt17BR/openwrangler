<p align="center">
  <img src="https://raw.githubusercontent.com/Matt17BR/openwrangler/3c512a6ed5ef645eb780ce0e01ea6c6e0f346dc2/assets/icon.png" width="128" height="128" alt="Open Wrangler logo">
</p>

<h1 align="center">Open Wrangler</h1>

<p align="center">A dataframe workbench for VS Code, Cursor, and other desktop VS Code forks. Open files and notebook dataframes with native Pandas and Polars support. DuckDB and PySpark viewing are experimental.</p>

<a href="https://github.com/Matt17BR/openwrangler/blob/3c512a6ed5ef645eb780ce0e01ea6c6e0f346dc2/docs/images/readme/v1.2/explore.png"><img alt="Open Wrangler in VS Code with its dataframe grid, column profiles, and native Activity Bar views" src="https://raw.githubusercontent.com/Matt17BR/openwrangler/3c512a6ed5ef645eb780ce0e01ea6c6e0f346dc2/docs/images/readme/v1.2/explore.png" width="1440" height="870"></a>

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

Open Wrangler requires VS Code 1.106 or newer and Python 3.10 through 3.14. It uses your configured Python path, selected environment, or a supported system interpreter. Missing packages are listed before the extension offers an explicit, confirm-before-install action.

Opening data or running Python requires a trusted workspace. Open Wrangler stays inactive in Restricted Mode.

<!-- open-wrangler-release-status:end -->

## Why Open Wrangler

- Pandas and Polars run natively. DuckDB and PySpark also run natively, with experimental viewing-only support.
- Each cleaning step previews changed values and generated code before you apply it.
- Filters and multi-column sorts change only the view. Exports write a separate file.
- The grid fetches visible rows and columns on demand. Supported file-backed Polars sources use lazy scans.

## Workbench

<a href="https://github.com/Matt17BR/openwrangler/blob/3c512a6ed5ef645eb780ce0e01ea6c6e0f346dc2/docs/images/readme/v1.2/gallery/sidebar-overview.png"><img alt="Open Wrangler showing Operations, Summary, Filters and Sorts, and Cleaning Steps beside a dataframe draft" src="https://raw.githubusercontent.com/Matt17BR/openwrangler/3c512a6ed5ef645eb780ce0e01ea6c6e0f346dc2/docs/images/readme/v1.2/gallery/sidebar-overview.png" width="1440" height="874"></a>

The sidebar keeps operations, dataset health, filters, sorts, and cleaning history beside the grid. See the
[product gallery](https://github.com/Matt17BR/openwrangler/blob/main/docs/media-gallery.md) for file entry points,
by-example transformations, themes, Cursor, DuckDB types, and notebook engines.

## Open and explore real files

Ordinary CSV and TSV files open with automatic delimiter, encoding, quote, and header detection. **Import
options** is available when a source needs an explicit override. Excel adds sheet selection; Parquet and
JSONL/NDJSON open directly.

<table>
  <tr>
    <td width="58%"><a href="https://github.com/Matt17BR/openwrangler/blob/3c512a6ed5ef645eb780ce0e01ea6c6e0f346dc2/docs/images/readme/v1.2/gallery/file-explorer-action.png"><img alt="Opening a CSV in Open Wrangler from the VS Code Explorer context menu" src="https://raw.githubusercontent.com/Matt17BR/openwrangler/3c512a6ed5ef645eb780ce0e01ea6c6e0f346dc2/docs/images/readme/v1.2/gallery/file-explorer-action-detail.png" width="920" height="616"></a></td>
    <td width="42%"><a href="https://github.com/Matt17BR/openwrangler/blob/3c512a6ed5ef645eb780ce0e01ea6c6e0f346dc2/docs/images/readme/v1.2/gallery/column-search-wide.png"><img alt="Searching to the final item in a 417-column synthetic dataframe" src="https://raw.githubusercontent.com/Matt17BR/openwrangler/3c512a6ed5ef645eb780ce0e01ea6c6e0f346dc2/docs/images/readme/v1.2/gallery/column-search-wide-detail.png" width="540" height="420"></a></td>
  </tr>
  <tr>
    <td>Open supported files from Explorer, the editor toolbar, tab menu, Command Palette, or <strong>Open With</strong>.</td>
    <td>Column search covers the full schema and includes data-type icons.</td>
  </tr>
</table>

<a href="https://github.com/Matt17BR/openwrangler/blob/3c512a6ed5ef645eb780ce0e01ea6c6e0f346dc2/docs/images/readme/v1.2/filter-result.png"><img alt="Open Wrangler showing a DACH filter, 14,285 matching rows, clear controls, and the same filter in the native sidebar" src="https://raw.githubusercontent.com/Matt17BR/openwrangler/3c512a6ed5ef645eb780ce0e01ea6c6e0f346dc2/docs/images/readme/v1.2/filter-result.png" width="1440" height="861"></a>

_Filter without changing the source: the result count, active predicate, grid, and clear controls stay together._

<table>
  <tr>
    <td width="50%"><a href="https://github.com/Matt17BR/openwrangler/blob/3c512a6ed5ef645eb780ce0e01ea6c6e0f346dc2/docs/images/readme/v1.2/gallery/histogram-hover.png"><img alt="A numeric histogram with an easy-to-target bin and exact interval and row count" src="https://raw.githubusercontent.com/Matt17BR/openwrangler/3c512a6ed5ef645eb780ce0e01ea6c6e0f346dc2/docs/images/readme/v1.2/gallery/histogram-hover.png" width="448" height="480"></a></td>
    <td width="50%"><a href="https://github.com/Matt17BR/openwrangler/blob/3c512a6ed5ef645eb780ce0e01ea6c6e0f346dc2/docs/images/readme/v1.2/gallery/sort-priority.png"><img alt="Two ordered sorts with inline priority, reorder, edit, and remove controls" src="https://raw.githubusercontent.com/Matt17BR/openwrangler/3c512a6ed5ef645eb780ce0e01ea6c6e0f346dc2/docs/images/readme/v1.2/gallery/sort-priority.png" width="448" height="480"></a></td>
  </tr>
  <tr>
    <td>Hover or focus any histogram bin to see its range and row count.</td>
    <td>Add multiple sort keys, then reorder them or change direction and null placement.</td>
  </tr>
</table>

## Transformations

Choose from 27 built-in operations, custom Pandas or Polars code, or transformations inferred from examples. A draft
stays separate until you apply it, and applied steps can be inspected, edited, or undone.

<a href="https://github.com/Matt17BR/openwrangler/blob/3c512a6ed5ef645eb780ce0e01ea6c6e0f346dc2/docs/images/readme/v1.2/workflow.png"><img alt="Open Wrangler reviewing a Polars draft with two viewing sorts, cleaning history, highlighted new values, Apply and Discard, and generated code" src="https://raw.githubusercontent.com/Matt17BR/openwrangler/3c512a6ed5ef645eb780ce0e01ea6c6e0f346dc2/docs/images/readme/v1.2/workflow.png" width="1440" height="870"></a>

_This preview shows the changed values and generated Polars code. The two sorts affect only the current view._

<table>
  <tr>
    <td width="50%"><a href="https://github.com/Matt17BR/openwrangler/blob/3c512a6ed5ef645eb780ce0e01ea6c6e0f346dc2/docs/images/readme/v1.2/gallery/latest-step-edited.png"><img alt="Cleaning Steps after editing the latest formula while preserving the earlier uppercase step" src="https://raw.githubusercontent.com/Matt17BR/openwrangler/3c512a6ed5ef645eb780ce0e01ea6c6e0f346dc2/docs/images/readme/v1.2/gallery/latest-step-edited-detail.png" width="448" height="440"></a></td>
    <td width="50%"><a href="https://github.com/Matt17BR/openwrangler/blob/3c512a6ed5ef645eb780ce0e01ea6c6e0f346dc2/docs/images/readme/v1.2/gallery/latest-step-undone.png"><img alt="Cleaning Steps after undoing the formula and retaining the uppercase step" src="https://raw.githubusercontent.com/Matt17BR/openwrangler/3c512a6ed5ef645eb780ce0e01ea6c6e0f346dc2/docs/images/readme/v1.2/gallery/latest-step-undone-detail.png" width="448" height="440"></a></td>
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
    <td width="44%"><a href="https://github.com/Matt17BR/openwrangler/blob/3c512a6ed5ef645eb780ce0e01ea6c6e0f346dc2/docs/images/readme/v1.2/gallery/notebook-variable-picker.png"><img alt="Notebook variable picker labeling Pandas, Polars, and DuckDB variables by engine and dataframe type" src="https://raw.githubusercontent.com/Matt17BR/openwrangler/3c512a6ed5ef645eb780ce0e01ea6c6e0f346dc2/docs/images/readme/v1.2/gallery/notebook-variable-picker-detail.png" width="602" height="380"></a></td>
    <td width="56%"><a href="https://github.com/Matt17BR/openwrangler/blob/3c512a6ed5ef645eb780ce0e01ea6c6e0f346dc2/docs/images/readme/v1.2/gallery/notebook-code-insertion.png"><img alt="Generated Pandas cleaning code inserted into the originating VS Code notebook" src="https://raw.githubusercontent.com/Matt17BR/openwrangler/3c512a6ed5ef645eb780ce0e01ea6c6e0f346dc2/docs/images/readme/v1.2/gallery/notebook-code-insertion-detail.png" width="1000" height="288"></a></td>
  </tr>
  <tr>
    <td>The notebook picker labels each live variable by engine and dataframe type.</td>
    <td>Insert generated code into the notebook that opened the dataframe.</td>
  </tr>
</table>

<table>
  <tr>
    <td width="50%"><a href="https://github.com/Matt17BR/openwrangler/blob/3c512a6ed5ef645eb780ce0e01ea6c6e0f346dc2/docs/images/readme/v1.2/notebook-pandas.png"><img alt="Pandas dataframe previewed inline inside a VS Code notebook" src="https://raw.githubusercontent.com/Matt17BR/openwrangler/3c512a6ed5ef645eb780ce0e01ea6c6e0f346dc2/docs/images/readme/v1.2/gallery/notebook-pandas-detail.png" width="698" height="535"></a></td>
    <td width="50%"><a href="https://github.com/Matt17BR/openwrangler/blob/3c512a6ed5ef645eb780ce0e01ea6c6e0f346dc2/docs/images/readme/v1.2/gallery/notebook-polars.png"><img alt="A native Polars notebook session with a formula draft and generated Polars code" src="https://raw.githubusercontent.com/Matt17BR/openwrangler/3c512a6ed5ef645eb780ce0e01ea6c6e0f346dc2/docs/images/readme/v1.2/gallery/notebook-polars-detail.png" width="884" height="675"></a></td>
  </tr>
  <tr>
    <td>Pandas outputs open as live Pandas dataframes.</td>
    <td>Polars dataframes stay native and generate Polars code.</td>
  </tr>
  <tr>
    <td width="50%"><a href="https://github.com/Matt17BR/openwrangler/blob/3c512a6ed5ef645eb780ce0e01ea6c6e0f346dc2/docs/images/readme/v1.2/gallery/notebook-duckdb.png"><img alt="A native DuckDB relation with filtering, paging, profiles, and ordered sorts" src="https://raw.githubusercontent.com/Matt17BR/openwrangler/3c512a6ed5ef645eb780ce0e01ea6c6e0f346dc2/docs/images/readme/v1.2/gallery/notebook-duckdb-detail.png" width="872" height="700"></a></td>
    <td width="50%"><a href="https://github.com/Matt17BR/openwrangler/blob/3c512a6ed5ef645eb780ce0e01ea6c6e0f346dc2/docs/images/readme/v1.2/gallery/notebook-pyspark.png"><img alt="An experimental native PySpark notebook session with profiles" src="https://raw.githubusercontent.com/Matt17BR/openwrangler/3c512a6ed5ef645eb780ce0e01ea6c6e0f346dc2/docs/images/readme/v1.2/gallery/notebook-pyspark-detail.png" width="820" height="610"></a></td>
  </tr>
  <tr>
    <td>DuckDB relations are view-only and do not require dataframe conversion.</td>
    <td>Experimental PySpark 4.2.x support provides viewing, filtering, sorting, paging, and profiles.</td>
  </tr>
</table>

DuckDB and PySpark notebook sessions are view-only. PySpark uses the notebook's Spark session and may scan and index
data for paging, so large or remote dataframes can be expensive to open. Open Wrangler does not install PySpark or
manage cluster authentication.

## Export

<table>
  <tr>
    <td width="50%"><a href="https://github.com/Matt17BR/openwrangler/blob/3c512a6ed5ef645eb780ce0e01ea6c6e0f346dc2/docs/images/readme/v1.2/gallery/export-script.png"><img alt="Generated native Polars cleaning code saved as a Python script" src="https://raw.githubusercontent.com/Matt17BR/openwrangler/3c512a6ed5ef645eb780ce0e01ea6c6e0f346dc2/docs/images/readme/v1.2/gallery/export-script-detail.png" width="995" height="230"></a></td>
    <td width="50%"><a href="https://github.com/Matt17BR/openwrangler/blob/3c512a6ed5ef645eb780ce0e01ea6c6e0f346dc2/docs/images/readme/v1.2/gallery/export-data.png"><img alt="A cleaned CSV exported separately and opened in VS Code" src="https://raw.githubusercontent.com/Matt17BR/openwrangler/3c512a6ed5ef645eb780ce0e01ea6c6e0f346dc2/docs/images/readme/v1.2/gallery/export-data-detail.png" width="995" height="344"></a></td>
  </tr>
  <tr>
    <td>Copy generated code, insert it into a notebook, or save it as a Python script.</td>
    <td>Export a cleaned CSV or Parquet file without overwriting the source.</td>
  </tr>
</table>

## Engines and formats

| Engine                      | Files                                  | Notebook data                | How it runs                                               |
| --------------------------- | -------------------------------------- | ---------------------------- | --------------------------------------------------------- |
| Polars                      | CSV, TSV, Parquet, JSONL/NDJSON, Excel | DataFrame, LazyFrame, Series | Native; lazy scans where the format permits               |
| Pandas                      | CSV, TSV, Parquet, JSONL/NDJSON, Excel | DataFrame, Series            | Native, including duplicate column labels                 |
| DuckDB, experimental        | CSV, TSV, Parquet, JSONL/NDJSON        | DuckDBPyRelation             | Native; notebook relations are viewing-only               |
| PySpark 4.2.x, experimental | Not currently supported                | DataFrame                    | Native notebook viewing, filtering, sorting, and profiles |

Automatic file selection prefers Polars, then DuckDB, then Pandas. A file backend can also be pinned in settings.
Notebook variables are matched to their supported native type, including Pandas 2 and 3, DuckDB relations, and
PySpark 4.2 DataFrames. Polars LazyFrames collect when opened from a notebook.

To keep a notebook result native to DuckDB, open the relation itself. For example,
`orders = duckdb.read_csv("orders.csv")`. Calling `orders.df()` explicitly creates a Pandas DataFrame, so Open
Wrangler correctly opens that resulting object with Pandas.

Pickle files are not supported because opening one can run arbitrary code. Convert trusted pickles to Parquet, CSV,
or JSONL first.

See the [operation and command reference](https://github.com/Matt17BR/openwrangler/blob/main/docs/reference.md)
for the complete surface.

## Performance and scale

The current installed-editor benchmark uses native Polars with a 100,000 by 50 CSV and a 1,000,000 by 20 Parquet
file. Open Wrangler can open larger datasets; usable size depends on the engine, format, operation, storage, memory,
and machine.

| Editor        | CSV first grid p95 | Parquet first grid p95 | Cached grid p95 | Uncached grid p95 |
| ------------- | ------------------ | ---------------------- | --------------- | ----------------- |
| VS Code 1.130 | 1.09 s             | 1.47 s                 | 63.8 ms         | 131.1 ms          |
| Cursor 3.13   | 1.91 s             | 1.72 s                 | 96.8 ms         | 148.2 ms          |

The [performance test documentation](https://github.com/Matt17BR/openwrangler/blob/main/docs/testing.md#performance-fixtures)
contains the method, raw samples, and cleanup checks.

Issue [#91](https://github.com/Matt17BR/openwrangler/issues/91) tracks a direct comparison with Microsoft Data
Wrangler. We will publish results only after both extensions have been tested with the same files, editor, Python
environment, and actions.

## Roadmap

- **Next in v1:** finish the distributed Spark follow-ups in
  [#36](https://github.com/Matt17BR/openwrangler/issues/36), test more VS Code-based desktop editors in
  [#86](https://github.com/Matt17BR/openwrangler/issues/86), and complete the Data Wrangler comparison in
  [#91](https://github.com/Matt17BR/openwrangler/issues/91). Support for other desktop forks is currently
  experimental.
- **v2:** add native R data frames, tibbles, and `data.table`, including Quarto and R Markdown workflows
  [#87](https://github.com/Matt17BR/openwrangler/issues/87).

## Contributing and support

Contributions are welcome. See
[CONTRIBUTING.md](https://github.com/Matt17BR/openwrangler/blob/main/CONTRIBUTING.md), use
[GitHub Issues](https://github.com/Matt17BR/openwrangler/issues) for bugs and feature requests, and follow
[SECURITY.md](https://github.com/Matt17BR/openwrangler/blob/main/SECURITY.md) for vulnerability reports.

## License

Open Wrangler is licensed under the [MIT License](https://github.com/Matt17BR/openwrangler/blob/main/LICENSE).
It is independently developed from public documentation and black-box behavior, uses no Microsoft Data Wrangler
code or assets, and is not affiliated with Microsoft.
