# Open Wrangler

Open Wrangler is an open-source dataframe viewer and cleaner for VS Code-family desktop editors. VS Code and Cursor are first-class targets; other VS Code-based desktop forks may work, but support is experimental. Open a file or notebook dataframe, explore it in a fast virtualized grid, build a repeatable cleaning plan, and export engine-native Python or cleaned data—all without changing the source.

Polars and Pandas are first-class backends. DuckDB provides a native file-backed path for larger local datasets.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/Matt17BR/openwrangler/main/docs/images/editor-acceptance/vscode-dark.png">
  <source media="(prefers-color-scheme: light)" srcset="https://raw.githubusercontent.com/Matt17BR/openwrangler/main/docs/images/editor-acceptance/vscode-light.png">
  <img alt="Open Wrangler running in VS Code" src="https://raw.githubusercontent.com/Matt17BR/openwrangler/main/docs/images/editor-acceptance/vscode-dark.png">
</picture>

<!-- open-wrangler-release-status:start -->

> **Release status:** Stable. Install from the [Visual Studio Marketplace](https://marketplace.visualstudio.com/items?itemName=Matt17BR.openwrangler), [Open VSX](https://open-vsx.org/extension/Matt17BR/openwrangler), or a [checksummed GitHub Release](https://github.com/Matt17BR/openwrangler/releases).

## Install

Open Wrangler requires Python 3.10–3.14 and a compatible desktop editor.

| Editor                      | Support      | Validation                        |
| --------------------------- | ------------ | --------------------------------- |
| VS Code                     | First-class  | Complete release suite            |
| Cursor                      | First-class  | Complete release suite            |
| Other VS Code desktop IDEs  | Experimental | Best-effort compatibility         |
| Browser-hosted `vscode.dev` | Unsupported  | Requires a desktop extension host |

VS Code and Cursor are release-tested. Other desktop forks that consume Open VSX may work—including [Antigravity](https://antigravity.google/docs/editor?app=antigravity)—but are not yet part of the release gate.

Install from the [Visual Studio Marketplace](https://marketplace.visualstudio.com/items?itemName=Matt17BR.openwrangler) or [Open VSX](https://open-vsx.org/extension/Matt17BR/openwrangler). For manual or offline installation, use the VSIX and matching checksum from a [GitHub Release](https://github.com/Matt17BR/openwrangler/releases).

On first open, Open Wrangler uses your configured Python path, selected Python environment, or a supported system interpreter. Missing dependencies are named and installed only after confirmation.

The checked-in [feature parity matrix](https://github.com/Matt17BR/openwrangler/blob/main/docs/feature-parity.md) records the tested 1.0 scope and its acceptance evidence. Real-world regressions remain release-blocking when discovered.

<!-- open-wrangler-release-status:end -->

## What it does

- Opens CSV, TSV, Parquet, JSONL, XLSX, and XLS from the Explorer, editor tab, editor toolbar, or Command Palette. Delimited files are detected automatically; import options remain available when correction is needed.
- Explores large and wide data through a virtualized, keyboard-accessible grid with search, progressive column insights, and filters and sorts that stay visible and individually removable.
- Keeps viewing filters and sorts separate from the cleaning plan.
- Previews all 27 built-in operations as a data diff with engine-native Python before apply or discard.
- Replays, edits, and undoes steps without modifying the original dataframe.
- Opens live Pandas and Polars notebook variables and expands saved notebook output as a read-only snapshot.
- Copies code, inserts it into the originating notebook, saves a script, or exports cleaned CSV/Parquet data to a new file.

## Engines and formats

| Backend | File sessions                   | Notebook variables | Notes                                                            |
| ------- | ------------------------------- | ------------------ | ---------------------------------------------------------------- |
| Polars  | CSV, TSV, Parquet, JSONL, Excel | Yes                | Native operations and lazy scans where the format allows         |
| DuckDB  | CSV, TSV, Parquet, JSONL        | Not yet            | Native lazy relations; no Pandas, Polars, or Arrow conversion    |
| Pandas  | CSV, TSV, Parquet, JSONL, Excel | Yes                | Position-safe support for duplicate and non-string column labels |

`auto` mode tries Polars, then DuckDB, then Pandas, skipping unavailable or incompatible choices. You can pin a backend in the Open Wrangler settings.

## Cleaning workflow

1. Filter, sort, inspect distributions, and select the columns you care about.
2. Add an operation and configure it.
3. Check the draft grid, diff, and generated code.
4. Apply or discard the draft, then export the committed plan when ready.

Applied steps form a replayable history. The latest step can be edited, steps can be undone, and viewing filters remain independent. The [generated reference](https://github.com/Matt17BR/openwrangler/blob/main/docs/reference.md) lists every operation, command, setting, and shortcut.

## Current limits

- PySpark is planned, but not implemented. The [engine proposal](https://github.com/Matt17BR/openwrangler/issues/36) requires distributed execution with no full-frame collection or implicit local-dataframe conversion.
- R dataframes and Quarto/R Markdown integration are a [post-1.0 architecture spike](https://github.com/Matt17BR/openwrangler/issues/87), not a Python conversion layer.
- DuckDB currently supports file-backed sessions only; Excel files and notebook variables use Polars or Pandas.
- Browser-hosted `vscode.dev` runtimes are outside the current scope.

## Develop and contribute

Follow the setup in [CONTRIBUTING.md](https://github.com/Matt17BR/openwrangler/blob/main/CONTRIBUTING.md), use `npm run build` while iterating, and run `npm test` for the complete TypeScript and Python regression suites. The [architecture guide](https://github.com/Matt17BR/openwrangler/blob/main/docs/architecture.md) explains the extension/runtime boundaries, and [testing.md](https://github.com/Matt17BR/openwrangler/blob/main/docs/testing.md) covers the acceptance suites. Security issues should follow [SECURITY.md](https://github.com/Matt17BR/openwrangler/blob/main/SECURITY.md).

Open Wrangler is an independent clean-room implementation inspired by the publicly documented behavior of Microsoft Data Wrangler. It does not use Microsoft code, branding, or assets and is not affiliated with Microsoft. Licensed under [MIT](https://github.com/Matt17BR/openwrangler/blob/main/LICENSE).
