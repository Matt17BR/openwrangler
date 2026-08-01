<p align="center">
  <img src="https://raw.githubusercontent.com/Matt17BR/openwrangler/e5f4ffd86a4807fd996e54f0ac3c3a8434285237/assets/icon.png" width="128" height="128" alt="Open Wrangler logo">
</p>

<h1 align="center">Open Wrangler</h1>

<p align="center">Explore, profile, clean, and export dataframes in an open-source workbench for VS Code-family desktop editors, with native Polars, Pandas, DuckDB, and experimental PySpark workflows.</p>

<a href="https://github.com/Matt17BR/openwrangler/blob/e5f4ffd86a4807fd996e54f0ac3c3a8434285237/docs/images/readme/v1.2/explore.png"><img alt="Open Wrangler in VS Code with its dataframe grid, column profiles, and native Activity Bar views" src="https://raw.githubusercontent.com/Matt17BR/openwrangler/e5f4ffd86a4807fd996e54f0ac3c3a8434285237/docs/images/readme/v1.2/explore.png"></a>

_Explore, profile, filter, and navigate a Polars dataframe without leaving VS Code._

<p align="center">Inspired by <a href="https://github.com/microsoft/vscode-data-wrangler">Microsoft Data Wrangler</a>'s explore, transform, and export workflow, Open Wrangler is an independent clean-room implementation with native multi-engine execution. It uses no Microsoft Data Wrangler code or assets.</p>

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

- **Work in the engine you chose.** Polars remains Polars, DuckDB remains DuckDB, Pandas remains Pandas, and
  experimental PySpark viewing stays in Spark.
- **Preview before applying.** Every cleaning step shows highlighted before-and-after values and executable
  engine-specific code before it changes the plan.
- **Explore without changing the source.** Filters and ordered multi-column sorts affect only the current view.
  Exports always target a separate file.
- **Navigate large and wide data efficiently.** The grid fetches row and column windows on demand; file-backed
  Polars sessions stay lazy where the format permits.

## The whole workflow stays in VS Code

<a href="https://github.com/Matt17BR/openwrangler/blob/e5f4ffd86a4807fd996e54f0ac3c3a8434285237/docs/images/readme/v1.2/gallery/sidebar-overview.png"><img alt="Open Wrangler showing Operations, Summary, Filters and Sorts, and Cleaning Steps beside a dataframe draft" src="https://raw.githubusercontent.com/Matt17BR/openwrangler/e5f4ffd86a4807fd996e54f0ac3c3a8434285237/docs/images/readme/v1.2/gallery/sidebar-overview.png"></a>

Operations, dataset health, viewing state, and cleaning history remain visible beside the data. The
[full product gallery](https://github.com/Matt17BR/openwrangler/blob/main/docs/media-gallery.md) also covers file
entry points, by-example transformations, themes, Cursor, rich DuckDB types, and every notebook engine.

## Open and explore real files

Ordinary CSV and TSV files open with automatic delimiter, encoding, quote, and header detection. **Import
options** is available when a source needs an explicit override. Excel adds sheet selection; Parquet and
JSONL/NDJSON open directly.

<table>
  <tr>
    <td width="58%"><a href="https://github.com/Matt17BR/openwrangler/blob/e5f4ffd86a4807fd996e54f0ac3c3a8434285237/docs/images/readme/v1.2/gallery/file-explorer-action.png"><img alt="Opening a CSV in Open Wrangler from the VS Code Explorer context menu" src="https://raw.githubusercontent.com/Matt17BR/openwrangler/e5f4ffd86a4807fd996e54f0ac3c3a8434285237/docs/images/readme/v1.2/gallery/file-explorer-action-detail.png"></a></td>
    <td width="42%"><a href="https://github.com/Matt17BR/openwrangler/blob/e5f4ffd86a4807fd996e54f0ac3c3a8434285237/docs/images/readme/v1.2/gallery/column-search-wide.png"><img alt="Searching to the final item in a 417-column synthetic dataframe" src="https://raw.githubusercontent.com/Matt17BR/openwrangler/e5f4ffd86a4807fd996e54f0ac3c3a8434285237/docs/images/readme/v1.2/gallery/column-search-wide-detail.png"></a></td>
  </tr>
  <tr>
    <td><strong>Open from where you work.</strong> Use the Explorer, editor toolbar, tab menu, Command Palette, or custom-editor picker.</td>
    <td><strong>Search the complete schema.</strong> Type icons and virtualized results make very wide dataframes navigable.</td>
  </tr>
</table>

<a href="https://github.com/Matt17BR/openwrangler/blob/e5f4ffd86a4807fd996e54f0ac3c3a8434285237/docs/images/readme/v1.2/filter-result.png"><img alt="Open Wrangler showing a DACH filter, 14,285 matching rows, clear controls, and the same filter in the native sidebar" src="https://raw.githubusercontent.com/Matt17BR/openwrangler/e5f4ffd86a4807fd996e54f0ac3c3a8434285237/docs/images/readme/v1.2/filter-result.png"></a>

_Filter without changing the source: the result count, active predicate, grid, and clear controls stay together._

<table>
  <tr>
    <td width="50%"><a href="https://github.com/Matt17BR/openwrangler/blob/e5f4ffd86a4807fd996e54f0ac3c3a8434285237/docs/images/readme/v1.2/gallery/histogram-hover.png"><img alt="A numeric histogram with an easy-to-target bin and exact interval and row count" src="https://raw.githubusercontent.com/Matt17BR/openwrangler/e5f4ffd86a4807fd996e54f0ac3c3a8434285237/docs/images/readme/v1.2/gallery/histogram-hover.png"></a></td>
    <td width="50%"><a href="https://github.com/Matt17BR/openwrangler/blob/e5f4ffd86a4807fd996e54f0ac3c3a8434285237/docs/images/readme/v1.2/gallery/sort-priority.png"><img alt="Two ordered sorts with inline priority, reorder, edit, and remove controls" src="https://raw.githubusercontent.com/Matt17BR/openwrangler/e5f4ffd86a4807fd996e54f0ac3c3a8434285237/docs/images/readme/v1.2/gallery/sort-priority.png"></a></td>
  </tr>
  <tr>
    <td><strong>Understand distributions.</strong> Every bin is an accessible full-height target with its interval and row count.</td>
    <td><strong>Control compound sorts.</strong> New keys become priority 1; reorder, edit, or remove them inline.</td>
  </tr>
</table>

## Clean with a plan

Choose from 27 built-in operations, custom engine-native code, or deterministic transformations learned from
examples. A draft remains separate until you apply it, and applied steps can be inspected, edited, or undone.

<a href="https://github.com/Matt17BR/openwrangler/blob/e5f4ffd86a4807fd996e54f0ac3c3a8434285237/docs/images/readme/v1.2/workflow.png"><img alt="Open Wrangler reviewing a Polars draft with two viewing sorts, cleaning history, highlighted new values, Apply and Discard, and generated code" src="https://raw.githubusercontent.com/Matt17BR/openwrangler/e5f4ffd86a4807fd996e54f0ac3c3a8434285237/docs/images/readme/v1.2/workflow.png"></a>

_Review the visible result and executable Polars code before applying the step. Viewing sorts remain separate from
the cleaning plan._

<table>
  <tr>
    <td width="50%"><a href="https://github.com/Matt17BR/openwrangler/blob/e5f4ffd86a4807fd996e54f0ac3c3a8434285237/docs/images/readme/v1.2/gallery/latest-step-edited.png"><img alt="Cleaning Steps after editing the latest formula while preserving the earlier uppercase step" src="https://raw.githubusercontent.com/Matt17BR/openwrangler/e5f4ffd86a4807fd996e54f0ac3c3a8434285237/docs/images/readme/v1.2/gallery/latest-step-edited-detail.png"></a></td>
    <td width="50%"><a href="https://github.com/Matt17BR/openwrangler/blob/e5f4ffd86a4807fd996e54f0ac3c3a8434285237/docs/images/readme/v1.2/gallery/latest-step-undone.png"><img alt="Cleaning Steps after undoing the formula and retaining the uppercase step" src="https://raw.githubusercontent.com/Matt17BR/openwrangler/e5f4ffd86a4807fd996e54f0ac3c3a8434285237/docs/images/readme/v1.2/gallery/latest-step-undone-detail.png"></a></td>
  </tr>
  <tr>
    <td><strong>Edit in place.</strong> Updating the latest step replaces it instead of duplicating history.</td>
    <td><strong>Undo precisely.</strong> Remove the latest step while retaining the earlier plan and viewing state.</td>
  </tr>
</table>

## Notebook workflows

In trusted Python notebooks, Open Wrangler renders inline Pandas, Polars, and DuckDB previews and discovers live
variables from the notebook toolbar. **Open in Open Wrangler** opens the complete current live dataframe in the
workbench. If only a saved output remains, rerun the cell to reconnect to the live variable.

If Microsoft Data Wrangler is installed too, choose which extension owns automatic previews with **Open Wrangler:
Choose Notebook Preview Provider**.

<table>
  <tr>
    <td width="44%"><a href="https://github.com/Matt17BR/openwrangler/blob/e5f4ffd86a4807fd996e54f0ac3c3a8434285237/docs/images/readme/v1.2/gallery/notebook-variable-picker.png"><img alt="Notebook variable picker labeling Pandas, Polars, and DuckDB variables by engine and dataframe type" src="https://raw.githubusercontent.com/Matt17BR/openwrangler/e5f4ffd86a4807fd996e54f0ac3c3a8434285237/docs/images/readme/v1.2/gallery/notebook-variable-picker-detail.png"></a></td>
    <td width="56%"><a href="https://github.com/Matt17BR/openwrangler/blob/e5f4ffd86a4807fd996e54f0ac3c3a8434285237/docs/images/readme/v1.2/gallery/notebook-code-insertion.png"><img alt="Generated Pandas cleaning code inserted into the originating VS Code notebook" src="https://raw.githubusercontent.com/Matt17BR/openwrangler/e5f4ffd86a4807fd996e54f0ac3c3a8434285237/docs/images/readme/v1.2/gallery/notebook-code-insertion-detail.png"></a></td>
  </tr>
  <tr>
    <td><strong>Choose the live engine.</strong> Variables are labeled by dataframe type before launch.</td>
    <td><strong>Keep the result reproducible.</strong> Insert generated cleaning code into the originating notebook.</td>
  </tr>
</table>

<table>
  <tr>
    <td width="50%"><a href="https://github.com/Matt17BR/openwrangler/blob/e5f4ffd86a4807fd996e54f0ac3c3a8434285237/docs/images/readme/v1.2/notebook-pandas.png"><img alt="Pandas dataframe previewed inline inside a VS Code notebook" src="https://raw.githubusercontent.com/Matt17BR/openwrangler/e5f4ffd86a4807fd996e54f0ac3c3a8434285237/docs/images/readme/v1.2/gallery/notebook-pandas-detail.png"></a></td>
    <td width="50%"><a href="https://github.com/Matt17BR/openwrangler/blob/e5f4ffd86a4807fd996e54f0ac3c3a8434285237/docs/images/readme/v1.2/gallery/notebook-polars.png"><img alt="A native Polars notebook session with a formula draft and generated Polars code" src="https://raw.githubusercontent.com/Matt17BR/openwrangler/e5f4ffd86a4807fd996e54f0ac3c3a8434285237/docs/images/readme/v1.2/gallery/notebook-polars-detail.png"></a></td>
  </tr>
  <tr>
    <td><strong>Pandas.</strong> Preview inline, then open and edit the complete live dataframe.</td>
    <td><strong>Polars.</strong> Edit natively and generate executable Polars code.</td>
  </tr>
  <tr>
    <td width="50%"><a href="https://github.com/Matt17BR/openwrangler/blob/e5f4ffd86a4807fd996e54f0ac3c3a8434285237/docs/images/readme/v1.2/gallery/notebook-duckdb.png"><img alt="A native DuckDB relation with filtering, paging, profiles, and ordered sorts" src="https://raw.githubusercontent.com/Matt17BR/openwrangler/e5f4ffd86a4807fd996e54f0ac3c3a8434285237/docs/images/readme/v1.2/gallery/notebook-duckdb-detail.png"></a></td>
    <td width="50%"><a href="https://github.com/Matt17BR/openwrangler/blob/e5f4ffd86a4807fd996e54f0ac3c3a8434285237/docs/images/readme/v1.2/gallery/notebook-pyspark.png"><img alt="An experimental native PySpark notebook session with profiles" src="https://raw.githubusercontent.com/Matt17BR/openwrangler/e5f4ffd86a4807fd996e54f0ac3c3a8434285237/docs/images/readme/v1.2/gallery/notebook-pyspark-detail.png"></a></td>
  </tr>
  <tr>
    <td><strong>DuckDB, experimental.</strong> Query the same live relation without converting it.</td>
    <td><strong>PySpark 4.2.x, experimental.</strong> View, filter, sort, page, and profile in Spark.</td>
  </tr>
</table>

DuckDB and PySpark notebook sessions are currently viewing-only. For PySpark, you provide and retain the Spark
session; opening a large or remote dataframe may be expensive because Open Wrangler must establish stable paging
and an exact row count. If you stop and recreate a local Classic or Connect Spark session, then recreate the
same-named DataFrame with the same schema in that notebook kernel, the next read reconnects without losing the
confirmed filter, sort order, column selection, or grid position. Open Wrangler does not install PySpark,
authenticate a cluster, or stop your session.

## Keep the result

<table>
  <tr>
    <td width="50%"><a href="https://github.com/Matt17BR/openwrangler/blob/e5f4ffd86a4807fd996e54f0ac3c3a8434285237/docs/images/readme/v1.2/gallery/export-script.png"><img alt="Generated native Polars cleaning code saved as a Python script" src="https://raw.githubusercontent.com/Matt17BR/openwrangler/e5f4ffd86a4807fd996e54f0ac3c3a8434285237/docs/images/readme/v1.2/gallery/export-script-detail.png"></a></td>
    <td width="50%"><a href="https://github.com/Matt17BR/openwrangler/blob/e5f4ffd86a4807fd996e54f0ac3c3a8434285237/docs/images/readme/v1.2/gallery/export-data.png"><img alt="A cleaned CSV exported separately and opened in VS Code" src="https://raw.githubusercontent.com/Matt17BR/openwrangler/e5f4ffd86a4807fd996e54f0ac3c3a8434285237/docs/images/readme/v1.2/gallery/export-data-detail.png"></a></td>
  </tr>
  <tr>
    <td><strong>Reusable code.</strong> Copy it, insert it into a notebook, or save an engine-native Python script.</td>
    <td><strong>Separate output.</strong> Export cleaned CSV or Parquet without overwriting the source.</td>
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

Python pickle files are deliberately unsupported: loading a pickle can execute arbitrary code. Convert trusted
pickle data to Parquet, CSV, or JSONL in a controlled Python environment before opening it.

See the [operation and command reference](https://github.com/Matt17BR/openwrangler/blob/main/docs/reference.md)
for the complete surface.

## Performance, with evidence

Current installed-editor benchmarks cover first-grid opening for a 100,000 by 50 CSV and a 1,000,000 by 20
Parquet file through native Polars. The Parquet scenario also measures cached scrolling, uncached paging,
filtering, and sorting. These fixture sizes are evidence points, not row limits. Practical scale depends on the
backend, format, operation, storage, memory, and machine. See the
[feature parity record](https://github.com/Matt17BR/openwrangler/blob/main/docs/feature-parity.md) for details.

A fair, reproducible black-box comparison with Microsoft Data Wrangler is tracked in
[#91](https://github.com/Matt17BR/openwrangler/issues/91). Until both products are measured against the same files,
environment, versions, and user-visible timing boundaries, Open Wrangler does not claim to be universally faster.

## Roadmap

- **v1.2:** finish real-user interaction polish and harden experimental PySpark 4.2 notebook viewing
  [#36](https://github.com/Matt17BR/openwrangler/issues/36). Other desktop forks remain experimental while their
  bounded smoke [#86](https://github.com/Matt17BR/openwrangler/issues/86) and the reproducible Data Wrangler
  comparison study [#91](https://github.com/Matt17BR/openwrangler/issues/91) continue.
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
