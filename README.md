# Open Wrangler

Open Wrangler is an open-source dataframe viewer and cleaner for VS Code-family desktop editors. VS Code and Cursor are first-class targets; other VS Code-based desktop forks may work, but support is experimental. Open a file or notebook dataframe, explore it in a fast virtualized grid, build a repeatable cleaning plan, and export engine-native Python or cleaned data—all without changing the source.

Polars and Pandas are first-class backends. DuckDB provides a native file-backed path for larger local datasets.

<!-- open-wrangler-release-status:start -->

> **Release status:** Stable. Install the checksummed VSIX from [GitHub Releases](https://github.com/Matt17BR/openwrangler/releases).

## Install

Open Wrangler requires Python 3.10–3.14 and a compatible desktop editor.

| Editor                                          | Support      | Release coverage                                       |
| ----------------------------------------------- | ------------ | ------------------------------------------------------ |
| VS Code                                         | First-class  | Full automated and release matrix                      |
| Cursor                                          | First-class  | Full automated and release matrix                      |
| Other VS Code-based IDEs, including Antigravity | Experimental | Best-effort; bounded smokes after Open VSX publication |
| Browser-hosted `vscode.dev`                     | Unsupported  | No local Python/runtime extension host                 |

Google says [Antigravity's editor is based on VS Code and downloads extensions from Open VSX](https://antigravity.google/docs/editor?app=antigravity). Open VSX publication can make Open Wrangler discoverable there; it does not certify compatibility. Experimental editors receive isolated functional smokes and do not inherit the VS Code/Cursor support guarantee.

Download both `openwrangler.vsix` and `openwrangler.vsix.sha256` from the matching [GitHub Release](https://github.com/Matt17BR/openwrangler/releases), verify the checksum, then choose **Views and More Actions → Install from VSIX…** in the Extensions view.

Open Wrangler resolves your configured Python path, selected Python environment, or a system interpreter in that order. It checks only the packages required for the chosen backend and file format, names the exact interpreter and dependencies, and asks before running `pip`; it never installs packages silently.

This stable release satisfies every in-scope row in the checked-in [feature parity matrix](https://github.com/Matt17BR/openwrangler/blob/main/docs/feature-parity.md).

<!-- open-wrangler-release-status:end -->

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/Matt17BR/openwrangler/main/docs/images/editor-acceptance/vscode-dark.png">
  <source media="(prefers-color-scheme: light)" srcset="https://raw.githubusercontent.com/Matt17BR/openwrangler/main/docs/images/editor-acceptance/vscode-light.png">
  <img alt="Open Wrangler running in VS Code" src="https://raw.githubusercontent.com/Matt17BR/openwrangler/main/docs/images/editor-acceptance/vscode-dark.png">
</picture>

## What it does

- Opens CSV, TSV, Parquet, JSONL, XLSX, and XLS files from the Explorer, editor tab, editor title bar, or Command Palette.
- Changes CSV, TSV, and Excel import options without losing the current cleaning plan or view.
- Pages through wide and large datasets with row and column virtualization, typed values, keyboard navigation, column search, and progressive insights.
- Keeps filters and sorts separate from cleaning steps, so exploration never silently changes exported results.
- Previews every transformation as a data diff with editable, backend-native Python before you apply it.
- Provides 27 built-in operations across row, column, text, categorical, numeric, datetime, grouping, custom-code, and by-example workflows.
- Replays, edits, and undoes cleaning steps while preserving the original dataframe.
- Opens live Polars and Pandas variables from Jupyter and can insert the generated cleaning function back into the originating notebook. PySpark 4.2 DataFrames have a separate experimental, viewing-only path.
- Expands saved notebook output into a read-only, filterable snapshot without starting Jupyter; variable-linked output also offers an explicit action for the linked live dataframe in its originating notebook.
- Copies code, saves a Python script, or atomically exports cleaned data to a new CSV or Parquet file.

<table>
  <tr>
    <th width="50%">Explore</th>
    <th width="50%">Transform</th>
  </tr>
  <tr>
    <td><img src="https://raw.githubusercontent.com/Matt17BR/openwrangler/main/docs/images/grid-view.png" alt="Virtualized dataframe grid with column insights"></td>
    <td><img src="https://raw.githubusercontent.com/Matt17BR/openwrangler/main/docs/images/acceptance/draft-preview-dark-1280.png" alt="Transformation preview with data diff and generated code"></td>
  </tr>
  <tr>
    <td>Filter, sort, profile, and navigate without changing the cleaning plan.</td>
    <td>Review the data diff and generated code before applying a step.</td>
  </tr>
</table>

## Engines and formats

| Backend       | File sessions                   | Notebook variables        | Notes                                                            |
| ------------- | ------------------------------- | ------------------------- | ---------------------------------------------------------------- |
| Polars        | CSV, TSV, Parquet, JSONL, Excel | Yes                       | Native operations and lazy scans where the format allows         |
| DuckDB        | CSV, TSV, Parquet, JSONL        | Not yet                   | Native lazy relations; no Pandas, Polars, or Arrow conversion    |
| Pandas        | CSV, TSV, Parquet, JSONL, Excel | Yes                       | Position-safe support for duplicate and non-string column labels |
| PySpark 4.2.x | No                              | Experimental viewing only | Spark-side queries; only bounded results return to Python        |

`auto` mode tries Polars, then DuckDB, then Pandas, skipping unavailable or incompatible choices. You can pin a backend in the Open Wrangler settings.

## Cleaning workflow

1. Filter, sort, inspect distributions, and select the columns you care about.
2. Add an operation and configure it.
3. Check the draft grid, diff, and generated code.
4. Apply or discard the draft, then export the committed plan when ready.

Applied steps form a replayable history. The latest step can be edited, steps can be undone, and viewing filters remain independent. The [generated reference](https://github.com/Matt17BR/openwrangler/blob/main/docs/reference.md) lists every operation, command, setting, and shortcut.

## Current limits

- PySpark 4.2 live-notebook viewing is experimental. It has no file sessions, cleaning operations, generated-code/data export, saved-output formatter, or packaged-editor/recovery guarantee yet; local Spark Connect is tested, while external and authenticated Connect servers still need acceptance. Follow the remaining [engine gates](https://github.com/Matt17BR/openwrangler/issues/36).
- R dataframes and Quarto/R Markdown integration are a [post-1.0 architecture spike](https://github.com/Matt17BR/openwrangler/issues/87), not a Python conversion layer.
- DuckDB currently supports file-backed sessions only; Excel files and notebook variables use Polars or Pandas.
- Browser-hosted `vscode.dev` runtimes are outside the current scope.

## Develop and contribute

Follow the setup in [CONTRIBUTING.md](https://github.com/Matt17BR/openwrangler/blob/main/CONTRIBUTING.md), use `npm run build` while iterating, and run `npm test` for the complete TypeScript and Python regression suites. The [architecture guide](https://github.com/Matt17BR/openwrangler/blob/main/docs/architecture.md) explains the extension/runtime boundaries, and [testing.md](https://github.com/Matt17BR/openwrangler/blob/main/docs/testing.md) covers the acceptance suites. Security issues should follow [SECURITY.md](https://github.com/Matt17BR/openwrangler/blob/main/SECURITY.md).

Open Wrangler is an independent clean-room implementation inspired by the publicly documented behavior of Microsoft Data Wrangler. It does not use Microsoft code, branding, or assets and is not affiliated with Microsoft. Licensed under [MIT](https://github.com/Matt17BR/openwrangler/blob/main/LICENSE).
