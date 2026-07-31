<p align="center">
  <img src="https://raw.githubusercontent.com/Matt17BR/openwrangler/main/assets/icon.png" width="128" height="128" alt="Open Wrangler logo">
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

Open Wrangler requires Python 3.10 through 3.14. It uses your configured Python path, selected environment, or a supported system interpreter. Missing packages are listed before the extension offers an explicit, confirm-before-install action.

<!-- open-wrangler-release-status:end -->

## Why Open Wrangler

- **Stay native to the selected engine.** Polars remains Polars, DuckDB remains DuckDB, and Pandas remains
  Pandas. Polars and DuckDB operations never detour through Pandas.
- **Preview every change.** Review the draft result and exact data diff in the workbench, with executable
  engine-specific code in VS Code's native **Code Preview** panel, before applying or discarding a step.
- **Keep exploration separate from cleaning.** Filters and ordered multi-column sorts change the view, not the
  source or cleaning plan. The newest sort becomes priority 1, and priorities remain editable from Filters /
  Sorts in the workbench or Activity Bar. Exports always target a separate file.
- **Navigate large and wide tables efficiently.** The grid fetches bounded row and column blocks, while
  file-backed Polars sessions stay lazy where the format permits.

<a href="https://raw.githubusercontent.com/Matt17BR/openwrangler/main/docs/images/readme/v1.1/workbench.png"><img alt="The same Open Wrangler regional-orders session split between the default light and dark VS Code themes, with the virtualized grid and exact Revenue column profiles visible" src="https://raw.githubusercontent.com/Matt17BR/openwrangler/main/docs/images/readme/v1.1/workbench.png"></a>

_The same packaged session in VS Code's default light and dark themes._

## Quick start

1. Open a CSV, TSV, Parquet, JSONL/NDJSON, or Excel file and choose **Open in Open Wrangler** from the branded
   editor-toolbar action or context menu.
2. Open **Column profiles**, search, filter, and sort without changing the source.
3. Choose **Add step**, review the data diff in **Draft review** and the generated engine-specific code in
   **Code Preview**, then apply the step or discard it.
4. Choose **Export** to save cleaned CSV or Parquet data without overwriting the source.

Ordinary CSV and TSV opens infer the delimiter, encoding, quote style, and header automatically. Use **Import
options** only when a file needs an explicit override.

## Notebook workflows

When a trusted Python kernel becomes available, Open Wrangler prepares its Pandas, Polars, and DuckDB inline preview
without requiring an earlier Open Wrangler command. If Microsoft Data Wrangler is installed too, Open Wrangler
asks once which extension should own automatic previews; change that choice later with **Open Wrangler: Choose
Notebook Preview Provider**.

The inline table is a lightweight preview stored with the notebook, so it may show only part of a very large
dataframe. Its **Open in Open Wrangler** action loads the complete, current variable from that notebook's live
kernel and pages it as you navigate; it never substitutes the saved preview. If an older saved output has no
live-variable link, Open Wrangler asks you to run the cell again instead of opening a partial workbench.

The notebook toolbar's branded **Open in Open Wrangler** action can also discover supported variables from the
selected kernel and shows each engine and dataframe type. Preview portability limits apply only to the table
stored inside the notebook, not to live dataframes or CSV, TSV, Excel, Parquet, and JSONL files.

<a href="https://raw.githubusercontent.com/Matt17BR/openwrangler/main/docs/images/readme/v1.1/notebooks.png"><img alt="A Pandas dataframe rendered by Open Wrangler inside a real packaged VS Code Jupyter notebook" src="https://raw.githubusercontent.com/Matt17BR/openwrangler/main/docs/images/readme/v1.1/notebooks.png"></a>

_A real packaged VS Code notebook with a lightweight Pandas inline preview._

The [engine gallery](https://github.com/Matt17BR/openwrangler/blob/main/docs/media-gallery.md) also shows a live
native Polars notebook draft with generated Polars code, a native DuckDB rich-Parquet file session, and the
experimental PySpark notebook viewer. DuckDB relations open as native, viewing-only notebook sessions: paging,
filtering, sorting, and requested profiles run against the exact originating relation without converting it to
Pandas, Polars, or Arrow. Cleaning, code insertion, and data export remain unavailable for DuckDB notebook
relations.

PySpark 4.2 DataFrames can open as experimental, viewing-only live notebook sessions. Filtering, sorting, paging,
and requested profiles stay in Spark; only bounded results return to the notebook runtime. File sessions,
cleaning, exports, code insertion, and saved inline snapshots are not supported. Opening currently indexes and
counts the complete frame, while per-page transfer safeguards are not dataframe row limits. See the
[real packaged PySpark notebook capture](https://github.com/Matt17BR/openwrangler/blob/main/docs/media-gallery.md#pyspark-classic-live-notebook).

## Engines and formats

| Engine                    | Files                                  | Notebook data                | How it runs                                                           |
| ------------------------- | -------------------------------------- | ---------------------------- | --------------------------------------------------------------------- |
| Polars                    | CSV, TSV, Parquet, JSONL/NDJSON, Excel | DataFrame, LazyFrame, Series | Native; text and Parquet formats use lazy scans. Excel loads eagerly. |
| Pandas                    | CSV, TSV, Parquet, JSONL/NDJSON, Excel | DataFrame, Series            | Native, including duplicate column labels                             |
| DuckDB, preview           | CSV, TSV, Parquet, JSONL/NDJSON        | DuckDBPyRelation             | Native; notebook relations are viewing-only                           |
| PySpark 4.2, experimental | Not currently supported                | DataFrame                    | Viewing-only Spark queries with bounded returned results              |

Automatic file selection prefers Polars, then DuckDB, then Pandas. A file backend can also be pinned in settings.
Notebook variables are matched to their native supported dataframe type, including Pandas 2 and 3, DuckDB
relations, and PySpark 4.2 DataFrames. Polars LazyFrames collect when opened from a notebook.

To keep a notebook result native to DuckDB, open the relation itself. For example,
`orders = duckdb.read_csv("orders.csv")`. Calling `orders.df()` explicitly materializes a Pandas DataFrame, so
Open Wrangler correctly opens that resulting object with the Pandas backend.

Python pickle files are deliberately unsupported: loading a pickle can execute arbitrary code. Convert trusted
pickle data to Parquet, CSV, or JSONL in a controlled Python environment before opening it in Open Wrangler.

## From source to reusable code

Open Wrangler combines progressive, type-aware summaries, searchable navigation across the complete schema,
27 built-in cleaning operations, editable engine-native code, and replayable history. Numeric columns expose
complete distributions and scalar statistics, with lossless finite minimum and maximum values for wide integers
and decimals; text columns expose exact empty-string and character-length statistics. Copy generated Python, save
it as a script, insert it into the originating notebook, or export
cleaned CSV and Parquet data without overwriting the source.
Each open dataframe owns its view, cleaning plan, runtime session, and export target, so simultaneous tabs do
not share state.

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

| Target | Focus                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| v1.1.x | Real-user interaction and visual polish [#88](https://github.com/Matt17BR/openwrangler/issues/88), reproducible performance comparison [#91](https://github.com/Matt17BR/openwrangler/issues/91), native DuckDB notebook-relation viewing [#157](https://github.com/Matt17BR/openwrangler/issues/157), and bounded validation in other VS Code-based desktop IDEs [#86](https://github.com/Matt17BR/openwrangler/issues/86) |
| v1.2   | Graduate PySpark from its experimental, viewing-only preview to a supported scope after the distributed correctness, recovery, performance, and editor gates in [#36](https://github.com/Matt17BR/openwrangler/issues/36) are green                                                                                                                                                                                         |
| v2     | Native R data frames, tibbles, and `data.table`, including Quarto and R Markdown workflows [#87](https://github.com/Matt17BR/openwrangler/issues/87)                                                                                                                                                                                                                                                                        |

Patch releases ship as soon as a coherent user-facing improvement passes the exact-artifact release gates.

## Contributing and support

Contributions are welcome. See
[CONTRIBUTING.md](https://github.com/Matt17BR/openwrangler/blob/main/CONTRIBUTING.md), use
[GitHub Issues](https://github.com/Matt17BR/openwrangler/issues) for bugs and feature requests, and follow
[SECURITY.md](https://github.com/Matt17BR/openwrangler/blob/main/SECURITY.md) for vulnerability reports.

## License

Open Wrangler is licensed under the [MIT License](https://github.com/Matt17BR/openwrangler/blob/main/LICENSE).
It is independently developed from public documentation and black-box behavior, uses no Microsoft Data Wrangler
code or assets, and is not affiliated with Microsoft.
