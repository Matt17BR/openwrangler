<p align="center">
  <img src="https://raw.githubusercontent.com/Matt17BR/openwrangler/c3f490645c56e67aa7c94dd978b37447a8356ec6/assets/icon.png" width="128" height="128" alt="Open Wrangler logo">
</p>

<h1 align="center">Open Wrangler</h1>

<p align="center">Visual dataframe exploration and reproducible cleaning for VS Code-family desktop editors, with engine-native Polars, DuckDB, and Pandas execution.</p>

<p align="center">Inspired by <a href="https://github.com/microsoft/vscode-data-wrangler">Microsoft Data Wrangler</a>'s explore, transform, and export workflow, Open Wrangler is an independent clean-room implementation, not a fork. It uses no Microsoft Data Wrangler code or assets.</p>

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

<!-- open-wrangler-release-status:end -->

## Why Open Wrangler

- **Stay native to the selected engine.** Polars remains Polars, DuckDB remains DuckDB, and Pandas remains
  Pandas. Polars and DuckDB operations never detour through Pandas.
- **Preview every change.** Review the draft result and a bounded, typed diff for the current grid block, with
  executable engine-specific code in VS Code's native **Code Preview** panel, before applying or discarding a
  step.
- **Keep exploration separate from cleaning.** Filters and ordered multi-column sorts change the view, not the
  source or cleaning plan. The newest sort becomes priority 1, and priorities remain editable from Filters /
  Sorts in the workbench or Activity Bar. Exports always target a separate file.
- **Navigate large and wide tables efficiently.** The grid fetches bounded row and column blocks, while
  file-backed Polars sessions stay lazy where the format permits.

<a href="https://github.com/Matt17BR/openwrangler/blob/c3f490645c56e67aa7c94dd978b37447a8356ec6/docs/images/readme/v1.2/explore.png"><img alt="Open Wrangler in VS Code with its Activity Bar views, virtualized dataframe grid, header summaries, and exact revenue column profile" src="https://raw.githubusercontent.com/Matt17BR/openwrangler/c3f490645c56e67aa7c94dd978b37447a8356ec6/docs/images/readme/v1.2/explore.png"></a>

_Explore a real packaged Polars file session with Operations, Summary, Filters / Sorts, Cleaning Steps, and exact
column profiles beside the grid._

### Native Activity Bar views

<table>
  <tr>
    <td width="50%"><a href="https://github.com/Matt17BR/openwrangler/blob/c3f490645c56e67aa7c94dd978b37447a8356ec6/docs/images/readme/v1.2/gallery/sidebar-explore.png"><img alt="Open Wrangler Activity Bar views showing the transformation catalog and active dataframe summary" src="https://raw.githubusercontent.com/Matt17BR/openwrangler/c3f490645c56e67aa7c94dd978b37447a8356ec6/docs/images/readme/v1.2/gallery/sidebar-explore.png"></a></td>
    <td width="50%"><a href="https://github.com/Matt17BR/openwrangler/blob/c3f490645c56e67aa7c94dd978b37447a8356ec6/docs/images/readme/v1.2/gallery/sidebar-workflow.png"><img alt="Open Wrangler Activity Bar views showing ordered viewing sorts and separate cleaning history" src="https://raw.githubusercontent.com/Matt17BR/openwrangler/c3f490645c56e67aa7c94dd978b37447a8356ec6/docs/images/readme/v1.2/gallery/sidebar-workflow.png"></a></td>
  </tr>
  <tr>
    <td><strong>Source at a glance.</strong> Browse transformations and check backend, shape, selected column, missing cells, and duplicates beside the dataframe.</td>
    <td><strong>View and plan stay separate.</strong> Reorder multi-column sort priorities while applied and draft cleaning steps remain independently visible.</td>
  </tr>
</table>

## Quick start

1. Open a CSV, TSV, Parquet, JSONL/NDJSON, or Excel file and choose **Open in Open Wrangler** from the branded
   editor-toolbar action or context menu.
2. Open **Column profiles**, search, filter, and sort without changing the source.
3. Choose **Add step**, review the data diff in **Draft review** and the generated engine-specific code in
   **Code Preview**, then apply the step or discard it.
4. Choose **Export** to save cleaned CSV or Parquet data without overwriting the source.

Ordinary CSV and TSV opens infer the delimiter, encoding, quote style, and header automatically. Use **Import
options** only when a file needs an explicit override.

### Build, preview, and revisit a cleaning plan

<table>
  <tr>
    <td width="50%"><a href="https://github.com/Matt17BR/openwrangler/blob/c3f490645c56e67aa7c94dd978b37447a8356ec6/docs/images/readme/v1.2/gallery/operation-configuration.png"><img alt="A Formula column operation configured as revenue plus 500 into projected_revenue, ready to preview" src="https://raw.githubusercontent.com/Matt17BR/openwrangler/c3f490645c56e67aa7c94dd978b37447a8356ec6/docs/images/readme/v1.2/gallery/operation-configuration-detail.png"></a></td>
    <td width="50%"><a href="https://github.com/Matt17BR/openwrangler/blob/c3f490645c56e67aa7c94dd978b37447a8356ec6/docs/images/readme/v1.2/gallery/applied-step-inspection.png"><img alt="The latest applied Formula column step selected for read-only inspection with Edit latest, Undo, and Show confirmed data visible" src="https://raw.githubusercontent.com/Matt17BR/openwrangler/c3f490645c56e67aa7c94dd978b37447a8356ec6/docs/images/readme/v1.2/gallery/applied-step-inspection-detail.png"></a></td>
  </tr>
  <tr>
    <td><strong>Configure precisely.</strong> Search the catalog, fill the operation parameters, then preview before the plan changes.</td>
    <td><strong>Revisit safely.</strong> Inspect an applied result without changing the confirmed dataframe; edit or undo the latest step explicitly.</td>
  </tr>
</table>

<a href="https://github.com/Matt17BR/openwrangler/blob/c3f490645c56e67aa7c94dd978b37447a8356ec6/docs/images/readme/v1.2/gallery/column-search-wide.png"><img alt="Open Wrangler searching all 417 columns in a realistic wide dataframe, with data-type icons and the final result visible" src="https://raw.githubusercontent.com/Matt17BR/openwrangler/c3f490645c56e67aa7c94dd978b37447a8356ec6/docs/images/readme/v1.2/gallery/column-search-wide.png"></a>

_Search the complete schema, not a truncated first page. Type icons distinguish text, integer, number, and boolean
columns before you navigate._

### Profiles and sort controls that stay usable

<table>
  <tr>
    <td width="50%"><a href="https://github.com/Matt17BR/openwrangler/blob/c3f490645c56e67aa7c94dd978b37447a8356ec6/docs/images/readme/v1.2/gallery/histogram-hover.png"><img alt="An exact numeric profile with a full-height histogram bin focused and its interval and row count visible" src="https://raw.githubusercontent.com/Matt17BR/openwrangler/c3f490645c56e67aa7c94dd978b37447a8356ec6/docs/images/readme/v1.2/gallery/histogram-hover.png"></a></td>
    <td width="50%"><a href="https://github.com/Matt17BR/openwrangler/blob/c3f490645c56e67aa7c94dd978b37447a8356ec6/docs/images/readme/v1.2/gallery/sort-priority.png"><img alt="Open Wrangler Filters and Sorts sidebar with two ordered sorts and visible reorder and remove controls" src="https://raw.githubusercontent.com/Matt17BR/openwrangler/c3f490645c56e67aa7c94dd978b37447a8356ec6/docs/images/readme/v1.2/gallery/sort-priority.png"></a></td>
  </tr>
  <tr>
    <td><strong>Inspect every bin.</strong> The whole bin height is an interactive target, including visually small values, with an exact interval and row count.</td>
    <td><strong>Control compound sorts.</strong> New sorts become priority 1; reorder or remove keys inline, or open one to change its direction and null placement.</td>
  </tr>
</table>

<a href="https://github.com/Matt17BR/openwrangler/blob/c3f490645c56e67aa7c94dd978b37447a8356ec6/docs/images/readme/v1.2/workflow.png"><img alt="Open Wrangler reviewing a Polars cleaning draft with ordered viewing sorts, cleaning history, a current-block data diff, Apply and Discard controls, and executable generated code" src="https://raw.githubusercontent.com/Matt17BR/openwrangler/c3f490645c56e67aa7c94dd978b37447a8356ec6/docs/images/readme/v1.2/workflow.png"></a>

_Viewing state and cleaning stay separate: reorderable sort priorities, applied history, a current-block draft
diff, and executable Polars code remain reviewable before **Apply step**._

## From exploration to reusable output

Open Wrangler combines progressive, type-aware summaries, searchable navigation across the complete schema,
27 built-in cleaning operations, editable engine-native code, deterministic transformations learned from
examples, and replayable history. Numeric columns expose distributions plus lossless finite minimum and maximum
values for wide integers and decimals; text columns expose exact empty-string and character-length statistics.

<table>
  <tr>
    <td width="50%"><a href="https://github.com/Matt17BR/openwrangler/blob/c3f490645c56e67aa7c94dd978b37447a8356ec6/docs/images/readme/v1.2/gallery/export-script.png"><img alt="Open Wrangler generated Polars cleaning script saved and opened in VS Code" src="https://raw.githubusercontent.com/Matt17BR/openwrangler/c3f490645c56e67aa7c94dd978b37447a8356ec6/docs/images/readme/v1.2/gallery/export-script-detail.png"></a></td>
    <td width="50%"><a href="https://github.com/Matt17BR/openwrangler/blob/c3f490645c56e67aa7c94dd978b37447a8356ec6/docs/images/readme/v1.2/gallery/export-data.png"><img alt="A separate cleaned CSV export opened with generated columns and profiles" src="https://raw.githubusercontent.com/Matt17BR/openwrangler/c3f490645c56e67aa7c94dd978b37447a8356ec6/docs/images/readme/v1.2/gallery/export-data-detail.png"></a></td>
  </tr>
  <tr>
    <td><strong>Keep the code.</strong> Copy it, insert it into the originating notebook, or save a standalone Python script.</td>
    <td><strong>Keep the source.</strong> Export cleaned CSV or Parquet to a separate destination; Open Wrangler never overwrites the input.</td>
  </tr>
</table>

The [product gallery](https://github.com/Matt17BR/openwrangler/blob/main/docs/media-gallery.md) also shows
by-example synthesis, import overrides, file entry points, richer data types, PySpark, and Cursor.

## Notebook workflows

In a trusted Python notebook, Open Wrangler renders lightweight Pandas, Polars, and DuckDB previews automatically.
Notebook outputs stay compact; **Open in Open Wrangler** reconnects to the complete current variable and pages it
in the workbench. A saved output without its live kernel remains preview-only and asks you to rerun the cell.

The notebook toolbar can also discover supported variables and shows each engine and dataframe type. If Microsoft
Data Wrangler is installed too, choose which extension owns automatic previews with **Open Wrangler: Choose
Notebook Preview Provider**.

<table>
  <tr>
    <td width="50%"><a href="https://github.com/Matt17BR/openwrangler/blob/c3f490645c56e67aa7c94dd978b37447a8356ec6/docs/images/readme/v1.2/gallery/notebook-variable-picker.png"><img alt="The Open Wrangler notebook variable picker identifying live DuckDB, Pandas, and Polars variables by engine and dataframe type" src="https://raw.githubusercontent.com/Matt17BR/openwrangler/c3f490645c56e67aa7c94dd978b37447a8356ec6/docs/images/readme/v1.2/gallery/notebook-variable-picker-detail.png"></a></td>
    <td width="50%"><a href="https://github.com/Matt17BR/openwrangler/blob/c3f490645c56e67aa7c94dd978b37447a8356ec6/docs/images/readme/v1.2/notebook-pandas.png"><img alt="A portable Pandas dataframe preview rendered by Open Wrangler inside a real packaged VS Code notebook" src="https://raw.githubusercontent.com/Matt17BR/openwrangler/c3f490645c56e67aa7c94dd978b37447a8356ec6/docs/images/readme/v1.2/gallery/notebook-pandas-detail.png"></a></td>
  </tr>
  <tr>
    <td><strong>Choose the real engine.</strong> The notebook toolbar labels each live variable with its dataframe type before launch.</td>
    <td><strong>Stay in the notebook.</strong> Keep a portable table inline, then open the complete current live dataframe in the workbench.</td>
  </tr>
</table>

<a href="https://github.com/Matt17BR/openwrangler/blob/c3f490645c56e67aa7c94dd978b37447a8356ec6/docs/images/readme/v1.2/gallery/notebook-polars-detail.png"><img alt="A live native Polars notebook session in Open Wrangler with a formula-column draft and generated Polars code" src="https://raw.githubusercontent.com/Matt17BR/openwrangler/c3f490645c56e67aa7c94dd978b37447a8356ec6/docs/images/readme/v1.2/gallery/notebook-polars-detail.png"></a>

_**Polars editing.** Preview a formula column, its added values, and executable native Polars code before applying
the draft. Open the image for the complete packaged-editor scene._

<a href="https://github.com/Matt17BR/openwrangler/blob/c3f490645c56e67aa7c94dd978b37447a8356ec6/docs/images/readme/v1.2/gallery/notebook-duckdb-detail.png"><img alt="A live native DuckDB relation in Open Wrangler with an exact filter, two ordered sorts, paging, and column profiles" src="https://raw.githubusercontent.com/Matt17BR/openwrangler/c3f490645c56e67aa7c94dd978b37447a8356ec6/docs/images/readme/v1.2/gallery/notebook-duckdb-detail.png"></a>

_**DuckDB exploration.** Filter, profile, page, and reorder multi-column sorts against the originating relation.
Open the image for the complete packaged-editor scene._

DuckDB relations open as native, viewing-only notebook sessions: paging, filtering, sorting, and requested
profiles run against the exact originating relation without converting it to Pandas, Polars, or Arrow. Cleaning,
code insertion, and data export remain unavailable for DuckDB notebook relations.

PySpark 4.2.x DataFrames can open as experimental, viewing-only live notebook sessions. The live bridge checks the
exact selected Python kernel and rejects the open before publishing a runtime session if PySpark is missing or unsupported. For Classic,
start your own `SparkSession` with Java 17+ and `JAVA_HOME` configured. For Connect, supply an already configured
and authenticated session; only local Connect is release-tested today. Open Wrangler does not install PySpark,
start or authenticate a cluster, or stop your Spark session. See the
[official PySpark setup guide](https://spark.apache.org/docs/4.2.0/api/python/getting_started/install.html).

Opening is intentionally more work than fetching a first page: Spark scans the complete DataFrame, assigns stable
row positions, caches an Open Wrangler-owned indexed child, and computes the exact row total. That can be expensive
for a large or remote DataFrame. After opening, filtering, sorting, paging, and requested profiles stay in Spark and
only bounded results return to the notebook runtime. File sessions, cleaning, exports, code insertion, and saved
inline previews are not supported. The [product gallery](https://github.com/Matt17BR/openwrangler/blob/main/docs/media-gallery.md#notebook-workflows)
shows the real packaged PySpark scene.

## Engines and formats

| Engine                    | Files                                  | Notebook data                | How it runs                                                           |
| ------------------------- | -------------------------------------- | ---------------------------- | --------------------------------------------------------------------- |
| Polars                    | CSV, TSV, Parquet, JSONL/NDJSON, Excel | DataFrame, LazyFrame, Series | Native; text and Parquet formats use lazy scans. Excel loads eagerly. |
| Pandas                    | CSV, TSV, Parquet, JSONL/NDJSON, Excel | DataFrame, Series            | Native, including duplicate column labels                             |
| DuckDB                    | CSV, TSV, Parquet, JSONL/NDJSON        | DuckDBPyRelation             | Native; notebook relations are viewing-only                           |
| PySpark 4.2, experimental | Not currently supported                | DataFrame                    | Full-frame open/index/cache; then native bounded viewing results      |

Automatic file selection prefers Polars, then DuckDB, then Pandas. A file backend can also be pinned in settings.
Notebook variables are matched to their native supported dataframe type, including Pandas 2 and 3, DuckDB
relations, and PySpark 4.2 DataFrames. Polars LazyFrames collect when opened from a notebook.

To keep a notebook result native to DuckDB, open the relation itself. For example,
`orders = duckdb.read_csv("orders.csv")`. Calling `orders.df()` explicitly materializes a Pandas DataFrame, so
Open Wrangler correctly opens that resulting object with the Pandas backend.

Python pickle files are deliberately unsupported: loading a pickle can execute arbitrary code. Convert trusted
pickle data to Parquet, CSV, or JSONL in a controlled Python environment before opening it in Open Wrangler.

See the [operation and command reference](https://github.com/Matt17BR/openwrangler/blob/main/docs/reference.md)
for the complete surface.

## Performance, with evidence

Current installed-editor benchmarks cover first-grid opening for a 100,000 by 50 CSV and a 1,000,000 by 20
Parquet file through native Polars. The Parquet scenario also measures cached scrolling, uncached paging,
filtering, and sorting. These fixture sizes are evidence points, not row limits. Practical scale depends on the
backend, format, operation, storage, memory, and machine. The detailed evidence lives in the
[feature parity record](https://github.com/Matt17BR/openwrangler/blob/main/docs/feature-parity.md).

A fair, reproducible black-box comparison with Microsoft Data Wrangler is still in progress in the
[performance comparison tracker](https://github.com/Matt17BR/openwrangler/issues/91). Until the same files,
environments, versions, and user-visible timing boundaries can be compared, Open Wrangler does not claim to be
universally faster.

## Roadmap

| Target | Focus                                                                                                                                                                                                                                                                                                                                                            |
| ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| v1.2   | Finish real-user interaction polish, publish a reproducible Data Wrangler performance comparison [#91](https://github.com/Matt17BR/openwrangler/issues/91), validate another desktop VS Code fork [#86](https://github.com/Matt17BR/openwrangler/issues/86), and complete the supported PySpark scope [#36](https://github.com/Matt17BR/openwrangler/issues/36). |
| v2     | Native R data frames, tibbles, and `data.table`, including Quarto and R Markdown workflows [#87](https://github.com/Matt17BR/openwrangler/issues/87).                                                                                                                                                                                                            |

The next public package is one coherent v1.2 release after its realistic editor journeys and exact-artifact
release gates pass. Development commits are not published as a stream of patch releases.

## Contributing and support

Contributions are welcome. See
[CONTRIBUTING.md](https://github.com/Matt17BR/openwrangler/blob/main/CONTRIBUTING.md), use
[GitHub Issues](https://github.com/Matt17BR/openwrangler/issues) for bugs and feature requests, and follow
[SECURITY.md](https://github.com/Matt17BR/openwrangler/blob/main/SECURITY.md) for vulnerability reports.

## License

Open Wrangler is licensed under the [MIT License](https://github.com/Matt17BR/openwrangler/blob/main/LICENSE).
It is independently developed from public documentation and black-box behavior, uses no Microsoft Data Wrangler
code or assets, and is not affiliated with Microsoft.
