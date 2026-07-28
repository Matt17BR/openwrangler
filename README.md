<p align="center">
  <img src="https://raw.githubusercontent.com/Matt17BR/openwrangler/main/assets/icon-128.png" width="112" height="112" alt="Open Wrangler logo">
</p>

<h1 align="center">Open Wrangler</h1>

<p align="center">An open-source dataframe viewer and cleaner for VS Code and Cursor, with native Polars, DuckDB, and Pandas workflows.</p>

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/Matt17BR/openwrangler/main/docs/images/editor-acceptance/vscode-hero-dark.png">
  <source media="(prefers-color-scheme: light)" srcset="https://raw.githubusercontent.com/Matt17BR/openwrangler/main/docs/images/editor-acceptance/vscode-hero-light.png">
  <img alt="Open Wrangler exploring a regional orders dataset with column summaries in VS Code" src="https://raw.githubusercontent.com/Matt17BR/openwrangler/main/docs/images/editor-acceptance/vscode-hero-dark.png">
</picture>

<!-- open-wrangler-release-status:start -->

> **Release status:** Stable

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

VS Code and Cursor are release-tested. Other VS Code desktop forks may work, but support is experimental.

Open Wrangler requires Python 3.10–3.14. It uses your configured Python path, selected environment, or a supported system interpreter. Missing packages are listed before the extension offers an explicit, confirm-before-install action.

<!-- open-wrangler-release-status:end -->

## Quick start

1. Open a CSV, TSV, Parquet, JSONL, or Excel file and choose **Open in Open Wrangler** from the editor toolbar or context menu.
2. Explore column summaries, search, filter, and sort without changing the source.
3. Choose **Add step**, review the data diff and generated code, then apply the step or discard it.

For notebooks, run a Pandas or Polars dataframe and use the Open Wrangler variable or notebook action.

## Capabilities

- Virtualized rows and columns for large and wide data, with keyboard navigation and accessible grid semantics.
- Progressive summaries with missing and distinct counts, distributions, and numeric minimum and maximum values.
- Twenty-seven built-in cleaning operations plus editable engine-native code, all using preview → apply or discard.
- Replayable cleaning history with edit and undo, kept separate from viewing filters and sorts.
- Copy or save generated Python, insert it into the originating notebook, or export cleaned CSV and Parquet files.

## Engines and formats

| Engine | Files                           | Notebook data                | Execution                                 |
| ------ | ------------------------------- | ---------------------------- | ----------------------------------------- |
| Polars | CSV, TSV, Parquet, JSONL, Excel | DataFrame, LazyFrame, Series | Native; lazy file scans where supported   |
| DuckDB | CSV, TSV, Parquet, JSONL        | —                            | Native file-backed relations              |
| Pandas | CSV, TSV, Parquet, JSONL, Excel | DataFrame, Series            | Native, including duplicate column labels |

Automatic backend selection prefers Polars, then DuckDB, then Pandas. A backend can also be pinned in settings.

## Preview every change

Drafts keep the changed cells, data diff, and generated Python visible together before anything is applied.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/Matt17BR/openwrangler/main/docs/images/editor-acceptance/vscode-transform-dark.png">
  <source media="(prefers-color-scheme: light)" srcset="https://raw.githubusercontent.com/Matt17BR/openwrangler/main/docs/images/editor-acceptance/vscode-transform-light.png">
  <img alt="Open Wrangler previewing a numeric transformation with its data diff and generated Polars code" src="https://raw.githubusercontent.com/Matt17BR/openwrangler/main/docs/images/editor-acceptance/vscode-transform-dark.png">
</picture>

See the [operation and command reference](https://github.com/Matt17BR/openwrangler/blob/main/docs/reference.md) for the complete surface.

## Contributing and support

Contributions are welcome; start with [CONTRIBUTING.md](https://github.com/Matt17BR/openwrangler/blob/main/CONTRIBUTING.md). Report bugs and feature requests through [GitHub Issues](https://github.com/Matt17BR/openwrangler/issues), and report vulnerabilities according to [SECURITY.md](https://github.com/Matt17BR/openwrangler/blob/main/SECURITY.md).

## License

Open Wrangler is licensed under the [MIT License](https://github.com/Matt17BR/openwrangler/blob/main/LICENSE). It is independently developed from public documentation, uses no Microsoft code or assets, and is not affiliated with Microsoft.
