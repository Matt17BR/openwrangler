<p align="center">
  <img src="https://raw.githubusercontent.com/Matt17BR/openwrangler/main/assets/icon.png" width="128" height="128" alt="Open Wrangler logo">
</p>

<h1 align="center">Open Wrangler</h1>

<p align="center">Visual dataframe exploration and reproducible cleaning for VS Code and Cursor, with engine-native Polars, DuckDB, and Pandas execution.</p>

<p align="center">Inspired by <a href="https://github.com/microsoft/vscode-data-wrangler">Microsoft Data Wrangler</a>'s explore, transform, and export workflow, Open Wrangler is an independent clean-room implementation, not a fork. It uses no Microsoft code or assets.</p>

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
- **Preview every change.** Review the draft result, data diff, and executable engine-specific code before
  applying or discarding a step.
- **Keep exploration separate from cleaning.** Filters and sorts change the view, not the source or cleaning
  plan. Exports always target a separate file.
- **Navigate large and wide tables efficiently.** The grid fetches bounded row and column blocks, while
  file-backed Polars sessions stay lazy where the format permits.

<img alt="Open Wrangler exploring regional orders with exact revenue statistics in matched light and dark VS Code themes" src="https://raw.githubusercontent.com/Matt17BR/openwrangler/main/docs/images/readme/v1.1/workbench.png">

_A live regional-orders file session with a virtualized grid and exact Revenue statistics. The light and dark
halves use the same data and layout._

## Quick start

1. Open a CSV, TSV, Parquet, JSONL, or Excel file and choose **Open in Open Wrangler** from the editor toolbar
   or context menu.
2. Explore column summaries, search, filter, and sort without changing the source.
3. Choose **Add step**, review the data diff and generated code, then apply the step or discard it.

## Notebook workflows

Displaying a Pandas or Polars dataframe can produce an inline preview after Jupyter grants kernel access. A saved
inline output captures at most 10,000 rows and 100,000 cells, so it stays reproducible with the notebook. This
snapshot bound is not a dataframe limit: live notebook variables and file sessions fetch bounded pages from the
current source instead.

Choose **Open Variable** from the notebook toolbar or Jupyter Variables to open the current dataframe as a live
session, clean it, and insert generated code back into that same notebook.

<img alt="Pandas saved output beside a live Polars notebook session with a draft data diff and native code" src="https://raw.githubusercontent.com/Matt17BR/openwrangler/main/docs/images/readme/v1.1/notebooks.png">

_Pandas saved output on the left; a live Polars formula draft, added-column diff, and executable Polars code on
the right._

DuckDB remains native for supported file sessions. Notebook relations are not yet supported.

PySpark 4.2 DataFrames can open as experimental, viewing-only live notebook sessions. Filtering, sorting,
paging, and profiling stay in Spark, while only bounded results return to the notebook runtime. File sessions,
cleaning steps, exports, and saved inline snapshots are not supported for PySpark yet. Opening a session currently
indexes and counts the complete frame. Each requested grid page is checked in Spark before collection and then
bounded again by serialized size, complex-value nodes, and nesting depth. These are page-transfer safeguards, not
dataframe row limits. Insights stay off until requested because each profile runs Spark queries.

## Engines and formats

| Engine                    | Files                           | Notebook data                | How it runs                                                                 |
| ------------------------- | ------------------------------- | ---------------------------- | --------------------------------------------------------------------------- |
| Polars                    | CSV, TSV, Parquet, JSONL, Excel | DataFrame, LazyFrame, Series | Native; supported file formats use lazy scans. Notebook LazyFrames collect. |
| Pandas                    | CSV, TSV, Parquet, JSONL, Excel | DataFrame, Series            | Native, including duplicate column labels                                   |
| DuckDB, preview           | CSV, TSV, Parquet, JSONL        | Not currently supported      | Native file-backed relations                                                |
| PySpark 4.2, experimental | Not currently supported         | DataFrame                    | Viewing-only Spark queries with bounded returned results                    |

Automatic file selection prefers Polars, then DuckDB, then Pandas. A file backend can also be pinned in settings.
Notebook variables are matched to their native supported dataframe type, including PySpark 4.2 DataFrames.

## From source to reusable code

Open Wrangler combines progressive summaries, column search, 27 built-in cleaning operations, editable
engine-native code, and replayable history. Copy generated Python, save it as a script, insert it into the
originating notebook, or export cleaned CSV and Parquet data without overwriting the source.

See the [operation and command reference](https://github.com/Matt17BR/openwrangler/blob/main/docs/reference.md)
for the complete surface.

## Performance, with evidence

Current installed-editor benchmarks cover a 100,000 by 50 CSV and a 1,000,000 by 20 Parquet file through native
Polars, including first-grid, cached scrolling, uncached paging, filtering, and sorting. These fixture sizes are
evidence points, not row limits. Practical scale depends on the backend, format, operation, storage, memory, and
machine. The detailed evidence lives in the
[feature parity record](https://github.com/Matt17BR/openwrangler/blob/main/docs/feature-parity.md).

A fair, reproducible black-box comparison with Microsoft Data Wrangler is still in progress in the
[performance comparison tracker](https://github.com/Matt17BR/openwrangler/issues/91). Until the same files,
environments, versions, and user-visible timing boundaries can be compared, Open Wrangler does not claim to be
universally faster.

## Roadmap

| Track                     | What comes next                                                                                                                                    |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Workbench and insights    | A calmer hierarchy and richer type-aware summaries in [#88](https://github.com/Matt17BR/openwrangler/issues/88)                                    |
| Performance comparison    | Reproducible Open Wrangler and Data Wrangler measurements in [#91](https://github.com/Matt17BR/openwrangler/issues/91)                             |
| PySpark                   | External clusters, cancellation, and realistic partitioned-data evidence in [#36](https://github.com/Matt17BR/openwrangler/issues/36)              |
| More VS Code-based IDEs   | Broader compatibility checks for VS Code-based desktop IDEs in [#86](https://github.com/Matt17BR/openwrangler/issues/86)                           |
| R, Quarto, and R Markdown | Explore native data-frame, tibble, and `data.table` support for Quarto and R Markdown in [#87](https://github.com/Matt17BR/openwrangler/issues/87) |

## Contributing and support

Contributions are welcome. See
[CONTRIBUTING.md](https://github.com/Matt17BR/openwrangler/blob/main/CONTRIBUTING.md), use
[GitHub Issues](https://github.com/Matt17BR/openwrangler/issues) for bugs and feature requests, and follow
[SECURITY.md](https://github.com/Matt17BR/openwrangler/blob/main/SECURITY.md) for vulnerability reports.

## License

Open Wrangler is licensed under the [MIT License](https://github.com/Matt17BR/openwrangler/blob/main/LICENSE).
It is independently developed from public documentation and black-box behavior, uses no Microsoft code or
assets, and is not affiliated with Microsoft.
