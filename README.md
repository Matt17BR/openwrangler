<p align="center">
  <img src="https://raw.githubusercontent.com/Matt17BR/openwrangler/main/assets/icon-128.png" width="112" height="112" alt="Open Wrangler logo">
</p>

<h1 align="center">Open Wrangler</h1>

<p align="center">An independent, open-source take on <a href="https://github.com/microsoft/vscode-data-wrangler">Microsoft Data Wrangler</a>'s visual workflow, built for native Polars, DuckDB, and Pandas across VS Code-family desktop editors.</p>

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

Open Wrangler is developed clean-room from public documentation and black-box behavior. It keeps the familiar
explore, transform, and export loop while extending that product direction for native Polars and DuckDB
workflows alongside Pandas, an open-source implementation, and distribution across more VS Code-based desktop
editors.

## Why Open Wrangler

- **Stay native to your engine.** Polars remains Polars, DuckDB remains DuckDB, and Pandas remains Pandas. Open
  Wrangler does not route Polars or DuckDB work through Pandas.
- **See the result before committing it.** Every cleaning step has a draft, data diff, and executable
  engine-specific code preview before you apply or discard it.
- **Explore without rewriting the source.** Viewing filters and sorts are separate from the cleaning plan, and
  exports always target a new file.
- **Work with large and wide tables.** The grid virtualizes rows and columns, fetches bounded blocks, and keeps
  file-backed Polars sessions lazy where the source format allows it.
- **Use the editor you prefer.** VS Code and Cursor are release-tested. Other desktop editors built on VS Code
  extension APIs can install the VSIX or use Open VSX, with experimental support tracked openly.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/Matt17BR/openwrangler/main/docs/images/editor-acceptance/vscode-hero-dark.png">
  <source media="(prefers-color-scheme: light)" srcset="https://raw.githubusercontent.com/Matt17BR/openwrangler/main/docs/images/editor-acceptance/vscode-hero-light.png">
  <img alt="Open Wrangler exploring a regional orders dataset with column summaries in VS Code" src="https://raw.githubusercontent.com/Matt17BR/openwrangler/main/docs/images/editor-acceptance/vscode-hero-dark.png">
</picture>

_Explore a 10,000-row orders dataset with a virtualized grid, progressive insights, and selected-column
statistics. The image automatically follows your GitHub theme._

## Quick start

1. Open a CSV, TSV, Parquet, JSONL, or Excel file and choose **Open in Open Wrangler** from the editor toolbar or context menu.
2. Explore column summaries, search, filter, and sort without changing the source.
3. Choose **Add step**, review the data diff and generated code, then apply the step or discard it.

For Jupyter notebooks, choose **Open Variable** in the notebook toolbar, then enter a Pandas or Polars dataframe variable name.

## Find columns by type

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/Matt17BR/openwrangler/main/docs/images/editor-acceptance/vscode-columns-dark.png">
  <source media="(prefers-color-scheme: light)" srcset="https://raw.githubusercontent.com/Matt17BR/openwrangler/main/docs/images/editor-acceptance/vscode-columns-light.png">
  <img alt="Open Wrangler column search showing datatype icons over a wide orders dataset" src="https://raw.githubusercontent.com/Matt17BR/openwrangler/main/docs/images/editor-acceptance/vscode-columns-dark.png">
</picture>

_Search a wide dataframe by column name, semantic type, or native dtype, then jump to the exact stable column._

## From source to reusable code

Open Wrangler combines the data grid with progressive summaries, 27 built-in cleaning operations, editable
engine-native code, and replayable history. Copy the generated Python, save it as a script, insert it into the
originating notebook, or export cleaned CSV and Parquet data without overwriting the source.

## Engines and formats

| Engine | Files                           | Notebook data                | How it runs                               |
| ------ | ------------------------------- | ---------------------------- | ----------------------------------------- |
| Polars | CSV, TSV, Parquet, JSONL, Excel | DataFrame, LazyFrame, Series | Native, with lazy scans where supported   |
| Pandas | CSV, TSV, Parquet, JSONL, Excel | DataFrame, Series            | Native, including duplicate column labels |
| DuckDB | CSV, TSV, Parquet, JSONL        | Not currently supported      | Native file-backed relations              |

Automatic backend selection prefers Polars, then DuckDB, then Pandas. A backend can also be pinned in settings.

## Preview, diff, and apply

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/Matt17BR/openwrangler/main/docs/images/editor-acceptance/vscode-transform-dark.png">
  <source media="(prefers-color-scheme: light)" srcset="https://raw.githubusercontent.com/Matt17BR/openwrangler/main/docs/images/editor-acceptance/vscode-transform-light.png">
  <img alt="Open Wrangler previewing a numeric transformation with its data diff and generated Polars code" src="https://raw.githubusercontent.com/Matt17BR/openwrangler/main/docs/images/editor-acceptance/vscode-transform-dark.png">
</picture>

_A real Polars draft keeps changed cells, the data diff, and generated code visible together. Nothing enters the
cleaning history until you choose Apply._

See the [operation and command reference](https://github.com/Matt17BR/openwrangler/blob/main/docs/reference.md)
for the complete surface.

## Performance, with evidence

Open Wrangler's release gates exercise a 100,000 by 50 CSV and a 1,000,000 by 20 Parquet fixture, including
lazy execution, projected paging, cache behavior, and installed-editor first-grid checks. The detailed evidence
lives in the [feature parity record](https://github.com/Matt17BR/openwrangler/blob/main/docs/feature-parity.md).

A fair, reproducible black-box comparison with Microsoft Data Wrangler is still in progress in
[issue #91](https://github.com/Matt17BR/openwrangler/issues/91). Until the same files, environments, versions,
and user-visible timing boundaries can be compared, Open Wrangler does not claim to be universally faster.

## Roadmap

| Track                     | What comes next                                                                                                                      |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Workbench and insights    | A calmer hierarchy and richer type-aware summaries in [#88](https://github.com/Matt17BR/openwrangler/issues/88)                      |
| Performance comparison    | Reproducible Open Wrangler and Data Wrangler measurements in [#91](https://github.com/Matt17BR/openwrangler/issues/91)               |
| DuckDB depth              | Richer typed Parquet and ingestion coverage in [#127](https://github.com/Matt17BR/openwrangler/issues/127)                           |
| PySpark                   | A native distributed dataframe backend, without `toPandas()`, in [#36](https://github.com/Matt17BR/openwrangler/issues/36)           |
| More VS Code-based IDEs   | Small compatibility smokes and documented support tiers in [#86](https://github.com/Matt17BR/openwrangler/issues/86)                 |
| R, Quarto, and R Markdown | A native R feasibility track for data frames, tibbles, and `data.table` in [#87](https://github.com/Matt17BR/openwrangler/issues/87) |

## Contributing and support

Contributions are welcome. Start with
[CONTRIBUTING.md](https://github.com/Matt17BR/openwrangler/blob/main/CONTRIBUTING.md), report bugs and feature
requests through [GitHub Issues](https://github.com/Matt17BR/openwrangler/issues), and report vulnerabilities
according to [SECURITY.md](https://github.com/Matt17BR/openwrangler/blob/main/SECURITY.md).

## License

Open Wrangler is licensed under the [MIT License](https://github.com/Matt17BR/openwrangler/blob/main/LICENSE).
It is independently developed from public documentation and black-box behavior, uses no Microsoft code or
assets, and is not affiliated with Microsoft.
