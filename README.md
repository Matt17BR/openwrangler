<p align="center">
  <img src="https://raw.githubusercontent.com/Matt17BR/openwrangler/9fc096eabb1d0b5c0a66c3371a2a8ff8ce40de22/assets/icon.png" width="128" height="128" alt="Open Wrangler logo">
</p>

<h1 align="center">Open Wrangler</h1>

<p align="center">Open source dataframe workbench for VS Code and Cursor: Pandas and Polars editing, experimental DuckDB file editing and relation viewing, stable PySpark 4.2.x notebook viewing, and preview native R.</p>

<a href="https://github.com/Matt17BR/openwrangler/blob/9fc096eabb1d0b5c0a66c3371a2a8ff8ce40de22/docs/images/readme/v1.2/explore.png"><img alt="Open Wrangler in VS Code with its dataframe grid, column profiles, and native Activity Bar views" src="https://raw.githubusercontent.com/Matt17BR/openwrangler/9fc096eabb1d0b5c0a66c3371a2a8ff8ce40de22/docs/images/readme/v1.2/explore.png" width="960"></a>

<p align="center">Open Wrangler is an open-source project inspired by <a href="https://github.com/microsoft/vscode-data-wrangler">Microsoft Data Wrangler</a>. It was built independently and uses no Microsoft Data Wrangler code or assets.</p>

<!-- open-wrangler-release-status:start -->

<p align="center">
  <a href="https://github.com/Matt17BR/openwrangler/releases"><img src="https://img.shields.io/github/v/release/Matt17BR/openwrangler?display_name=tag&amp;sort=semver" alt="Latest GitHub release"></a>
  <a href="https://github.com/Matt17BR/openwrangler/actions/workflows/ci.yml"><img src="https://github.com/Matt17BR/openwrangler/actions/workflows/ci.yml/badge.svg?event=pull_request" alt="Pull request CI status"></a>
  <a href="https://marketplace.visualstudio.com/items?itemName=Matt17BR.openwrangler"><img src="https://vsmarketplacebadges.dev/version-short/Matt17BR.openwrangler.svg" alt="Visual Studio Marketplace version"></a>
  <a href="https://open-vsx.org/extension/Matt17BR/openwrangler"><img src="https://img.shields.io/open-vsx/v/Matt17BR/openwrangler?label=Open%20VSX" alt="Open VSX version"></a>
  <a href="https://github.com/Matt17BR/openwrangler/blob/main/LICENSE"><img src="https://img.shields.io/github/license/Matt17BR/openwrangler" alt="MIT license"></a>
</p>

## Install

- **Latest stable:** choose **Install** on the [Visual Studio Marketplace](https://marketplace.visualstudio.com/items?itemName=Matt17BR.openwrangler), choose the newest
  stable version from [Open VSX](https://open-vsx.org/extension/Matt17BR/openwrangler)'s version list, or download the [latest stable GitHub Release](https://github.com/Matt17BR/openwrangler/releases/latest).
- **Latest preview:** choose **Install Pre-Release Version** on the editor listing. Other Open VSX clients may label
  this differently; select the newest version marked as preview. The same VSIX is available from [GitHub prereleases](https://github.com/Matt17BR/openwrangler/releases).
- **Current `main`:** build the latest source below. It may be ahead of the published preview.

For a downloaded VSIX, open the Extensions view and choose **Views and More Actions → Install from VSIX…**.

To build and install the current `main` branch:

```bash
git clone --depth 1 --branch main https://github.com/Matt17BR/openwrangler.git
cd openwrangler
npm ci --ignore-scripts
npm run package:dev
```

The shallow clone retains `.git` for package source guards without downloading repository history or release tags.

Then run `code --install-extension openwrangler-dev.vsix --force` or
`cursor --install-extension openwrangler-dev.vsix --force`.

| Editor                      | Support        |
| --------------------------- | -------------- |
| VS Code                     | Release-tested |
| Cursor                      | Release-tested |
| Other VS Code desktop forks | Experimental   |
| Browser-hosted `vscode.dev` | Unsupported    |

Open Wrangler requires VS Code 1.106 or newer. File sources and Python notebook dataframes use Python 3.10 through
3.14 from your configured path, selected environment, or a supported system interpreter. If a required Python package
is missing, Open Wrangler lists it and asks before installing anything.

R support uses the environment that owns the dataframe: the selected IRkernel for a notebook, the selected official
VS Code R terminal for an interactive session, or the `Rscript` chosen by `openWrangler.rscriptPath` or `PATH` for
a trusted `.R`, `.Rmd`, or `.qmd` document. Install `jsonlite` and `rlang` in that same environment. Parquet
export also needs `nanoparquet` 0.5.1 or newer there; CSV export does not. R notebooks remain available on Windows,
but direct R-document execution is currently limited to macOS and Linux.

Opening data or using a notebook kernel requires a trusted workspace. Open Wrangler stays inactive in Restricted Mode.

<!-- open-wrangler-release-status:end -->

Native R is a channel-neutral **Preview** feature. It can ship in a stable Open Wrangler release without becoming
stable support. The current source supports the complete generated operation catalog. R Custom Code runs arbitrary R
in the selected environment and is unavailable in Restricted Mode.

The R Preview has these notebook, terminal, and document entry points:

| Workflow                               | How it opens dataframes                                                                 | Available in                                                      |
| -------------------------------------- | --------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| IRkernel notebook                      | From Operations, the notebook toolbar, or Jupyter Variables                             | VS Code on Linux, macOS, and Windows; Cursor on Linux             |
| Selected VS Code R terminal            | Select the terminal; Operations reads vscode-R's dataframe list and keeps it up to date | VS Code and Cursor on Linux                                       |
| `.Rmd` or `.qmd` cursor chunk          | Put the cursor in an enabled R or Python chunk, then choose **Open in Open Wrangler**   | Desktop hosts with the corresponding official editor integrations |
| Explicit `.R`, `.Rmd`, or `.qmd` R run | Choose **Run R Document in Open Wrangler…** to start an Open Wrangler-managed R process | VS Code and Cursor on Linux; VS Code on macOS                     |

R-document support follows the machine running the extension host. Remote document execution is experimental, and a
Windows extension host rejects it. IRkernel notebooks work on Windows.

Release qualification covers local desktop VS Code and Cursor. Remote SSH is not release-qualified.

## Workbench

The workbench shows the grid, column profiles, filters, sorts, and cleaning history together. Pandas, Polars, R, and
file-backed DuckDB remain in their native engines; DuckDB notebook relations and PySpark notebook dataframes are
view-only. Filters and sorts change only the view, cleaning drafts show changed values and generated code before they
are applied, and exports write a separate file. The grid fetches visible row and column blocks on demand.

## Open files

Open CSV, TSV, Parquet, JSONL/NDJSON, and Excel files from Explorer, the editor toolbar or tab menu, the Command
Palette, or **Open With**. CSV and TSV sources use automatic delimiter, encoding, quote, and header detection;
BOM-marked UTF-16 files open through Pandas. **Open Wrangler: Change Import Options** provides explicit delimited-file
options and Excel sheet selection.

The grid supports full-schema column search, typed filters, ordered multi-column sorts, cell and rectangular
selection, and copying displayed values. Null and NaN remain distinct filter values. See
[Accessibility and keyboard use](https://github.com/Matt17BR/openwrangler/blob/main/docs/accessibility.md) for grid
shortcuts, focus behavior, screen-reader semantics, and current limits.

## Transformations

Editing mode provides 32 operations for rows, columns, types, text, categorical and numeric data, missing values,
reshaping, grouped summaries, custom engine-native code, and transformations inferred from examples. A draft remains
separate until it is applied. Applied steps can be inspected, edited, deleted, or undone without clearing viewing
filters and sorts. The
[generated operation reference](https://github.com/Matt17BR/openwrangler/blob/main/docs/reference.md#transformation-operations)
lists the current parameters and supported methods.

## Notebook workflows

In trusted Python notebooks and Python Interactive windows, Open Wrangler previews Pandas, Polars, and DuckDB outputs.
The notebook toolbar and Operations view list supported Pandas, Polars, DuckDB, and local PySpark variables.
**Open in Open Wrangler** loads the current live variable from the notebook's kernel. Unassigned supported results can
be opened while they remain available in that kernel. If formatter setup finishes after the first supported result,
that output upgrades automatically without a rerun or fallback action.

Supported live dataframes open in Viewing mode by default. Viewing filters and sorts only the grid; it does not build
a cleaning plan or change the source. Use **Switch to Editing** to build a plan. DuckDB and PySpark sessions remain
view-only.

Python files have the same action in the editor toolbar and tab menu. For an ordinary `.py` file, Open Wrangler runs
the file in Python Interactive and opens the live dataframe you choose. If the file uses `# %%` cells, it runs only
the cell under the cursor.

If Microsoft Data Wrangler is installed too, choose which extension owns automatic previews with **Open Wrangler:
Choose Notebook Preview Provider**.

PySpark support is notebook-only and view-only. It uses an existing local stable/final PySpark 4.2.x Classic or
Connect batch session; Open Wrangler does not install or configure Spark. Streaming DataFrames and remote or
authenticated clusters are unsupported. Pages load sequentially, and a unique final sort key is required when row
order must remain repeatable across Spark executions.

Open Wrangler handles base R `data.frame`, tibble, and `data.table` objects in the R process where they already live.
IRkernel and selected-terminal dataframes open in Viewing mode and can switch to Editing without overwriting the live
object. Managed R documents use the file start-mode setting. Use **Open Wrangler: Refresh R Dataframes** if the
selected terminal's vscode-R metadata is unavailable. In `.Rmd` and `.qmd` editors, **Open in Open Wrangler** runs
only the enabled chunk at the cursor; **Run R Document in Open Wrangler…** runs a trusted local R document or its
supported top-level R cells on macOS and Linux.

Generated R can be copied or saved from every R session. It can be inserted only into the IRkernel notebook or
managed R document that opened the dataframe. Local R editing sessions export cleaned CSV, and export Parquet when
`nanoparquet` 0.5.1 or newer is installed in the owning R environment.

Ordinary frames created with `collapse::qDF()`, `qTBL()`, and `qDT()` use the existing dataframe, tibble, and
data-table paths without adding `collapse` as a dependency. Grouped `GRP_df` and indexed `indexed_frame` objects are
unsupported.

## Export

Copy generated code or use **Open Wrangler: Export Generated Script** to save Python or R. Notebook and managed
R-document sessions can insert code into the document that opened the dataframe. Pandas, Polars, DuckDB, and local R
editing sessions export cleaned CSV or Parquet to a separate destination.

## Engines and formats

| Engine                      | Files                                     | Notebook data                         | How it runs                                                |
| --------------------------- | ----------------------------------------- | ------------------------------------- | ---------------------------------------------------------- |
| Polars                      | CSV, TSV, Parquet, JSONL/NDJSON, Excel    | DataFrame, LazyFrame, Series          | Native; LazyFrame sessions stay lazy                       |
| Pandas                      | CSV, TSV, Parquet, JSONL/NDJSON, Excel    | DataFrame, Series                     | Native, including duplicate column labels                  |
| DuckDB, experimental        | CSV, TSV, Parquet, JSONL/NDJSON           | DuckDBPyRelation                      | Native; notebook relations are viewing-only                |
| PySpark 4.2.x, stable/final | No                                        | Local Classic/Connect batch DataFrame | Native notebook viewing, filtering, sorting, and profiles  |
| R (Preview)                 | Local `.R`, `.Rmd`, `.qmd` on macOS/Linux | `data.frame`, tibble, `data.table`    | IRkernel, selected VS Code R terminal, or document Rscript |

Automatic file selection prefers Polars, then DuckDB, then Pandas. A file backend can also be pinned in settings.
Notebook variables are matched to their supported native type, including Pandas 2 and 3, DuckDB relations, and local
stable/final PySpark 4.2.x Classic/Connect batch DataFrames. Notebook Polars LazyFrames retain their lazy plan; pages
and profiles collect bounded results. Operations whose output columns depend on dataframe values may materialize a
lazy result for preview.

For a trusted Pandas pickle, right-click the file and choose **Convert Trusted Pickle to Parquet…**. Open Wrangler
asks where to save the Parquet file and asks again before Python loads the pickle. The conversion is saved separately;
Open Wrangler never overwrites the pickle.

See the generated reference for all public
[commands](https://github.com/Matt17BR/openwrangler/blob/main/docs/reference.md#commands),
[settings](https://github.com/Matt17BR/openwrangler/blob/main/docs/reference.md#settings), and
[transformation operations](https://github.com/Matt17BR/openwrangler/blob/main/docs/reference.md#transformation-operations).

## Performance

Open Wrangler sends visible grid blocks to the webview. File-backed Polars sessions use lazy scans, and Pandas,
DuckDB, and Spark work stays in its native engine. The
[Data Wrangler comparison](https://github.com/Matt17BR/openwrangler/blob/main/docs/performance-comparison.md) is an
optional historical study of public-UI workloads and dated reviews.

## Roadmap

The [product roadmap](https://github.com/Matt17BR/openwrangler/blob/main/docs/product-roadmap.md) records current
support boundaries and priorities. Native R remains Preview.

## Contributing and support

Contributions are welcome. See
[CONTRIBUTING.md](https://github.com/Matt17BR/openwrangler/blob/main/CONTRIBUTING.md), use
[GitHub Issues](https://github.com/Matt17BR/openwrangler/issues) for bugs and feature requests, and follow
[SECURITY.md](https://github.com/Matt17BR/openwrangler/blob/main/SECURITY.md) for vulnerability reports.

## License

Open Wrangler is licensed under the [MIT License](https://github.com/Matt17BR/openwrangler/blob/main/LICENSE).
It is not affiliated with Microsoft.
