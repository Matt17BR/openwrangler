<p align="center">
  <img src="https://raw.githubusercontent.com/Matt17BR/openwrangler/9fc096eabb1d0b5c0a66c3371a2a8ff8ce40de22/assets/icon.png" width="128" height="128" alt="Open Wrangler logo">
</p>

<h1 align="center">Open Wrangler</h1>

Open Wrangler is a visual dataframe editor for VS Code and editors based on it. Open files or live notebook data,
make changes visually, and keep the generated Python or R code.

<a href="https://github.com/Matt17BR/openwrangler/blob/main/docs/images/readme/explore.png"><img alt="Open Wrangler in VS Code with a dataframe grid, column profiles, filters, sorts, and cleaning history" src="https://raw.githubusercontent.com/Matt17BR/openwrangler/main/docs/images/readme/explore.png" width="960"></a>

_Explore rows, profiles, filters, and cleaning history in one workbench._

<p align="center">
  <a href="https://github.com/Matt17BR/openwrangler/releases/latest"><img src="https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fapi.github.com%2Frepos%2FMatt17BR%2Fopenwrangler%2Freleases%2Flatest&amp;query=%24.tag_name&amp;label=stable&amp;color=blue" alt="Latest stable GitHub release"></a>
  <a href="https://github.com/Matt17BR/openwrangler/actions/workflows/ci.yml"><img src="https://github.com/Matt17BR/openwrangler/actions/workflows/ci.yml/badge.svg?event=pull_request" alt="Pull request CI status"></a>
  <a href="https://marketplace.visualstudio.com/items?itemName=Matt17BR.openwrangler"><img src="https://img.shields.io/badge/VS%20Marketplace-install-blue" alt="Install from Visual Studio Marketplace"></a>
  <a href="https://open-vsx.org/extension/Matt17BR/openwrangler"><img src="https://img.shields.io/badge/Open%20VSX-install-blue" alt="Install from Open VSX"></a>
  <a href="https://github.com/Matt17BR/openwrangler/blob/main/LICENSE"><img src="https://img.shields.io/github/license/Matt17BR/openwrangler" alt="MIT license"></a>
</p>

## Install

- **Stable:** choose **Install** on the [Visual Studio Marketplace](https://marketplace.visualstudio.com/items?itemName=Matt17BR.openwrangler), select the newest non-preview
  version in [Open VSX](https://open-vsx.org/extension/Matt17BR/openwrangler)'s version list, or download the [latest stable GitHub release](https://github.com/Matt17BR/openwrangler/releases/latest).
- **Preview:** choose **Install Pre-Release Version** on the editor listing, or download a preview from
  [GitHub prereleases](https://github.com/Matt17BR/openwrangler/releases).
- **From source:** [build and install the current `main` branch](https://github.com/Matt17BR/openwrangler/blob/main/CONTRIBUTING.md).
  It may contain changes newer than the published preview.

For a downloaded VSIX, open the Extensions view and choose **Views and More Actions → Install from VSIX…**.

## A five-minute path from data to code

**1. Open a source.** For CSV, TSV, Parquet, JSONL/NDJSON, or Excel, choose **Open in Open Wrangler** from Explorer,
an editor tab, or the editor toolbar. In a Python notebook, run a supported dataframe and choose **Open in Open
Wrangler** on its output or from the notebook toolbar.

For a quick example, save the [four-row sample CSV](https://raw.githubusercontent.com/Matt17BR/openwrangler/main/fixtures/sample.csv)
in your workspace.

<a href="https://github.com/Matt17BR/openwrangler/blob/main/docs/images/readme/notebook-pandas.png"><img alt="A live Pandas dataframe output in a VS Code notebook with the Open in Open Wrangler action" src="https://raw.githubusercontent.com/Matt17BR/openwrangler/main/docs/images/readme/notebook-pandas.png" width="960"></a>

_Open a live notebook dataframe from its output and continue in the workbench._

**2. Preview a transformation.** If your notebook session opens in Viewing mode and supports editing, choose
**Switch to Editing** first. Choose **Add step**, select an operation, configure it, then choose **Preview changes**.
Where a form offers column search, changing the search keeps your selections. Changed values and generated code appear
as a draft. Viewing filters and sorts affect only the current view. Use **Sort rows** or **Filter rows** to add a
cleaning step.

With that sample, preview **Drop missing rows** on **sales**: Paris disappears from the draft, leaving Milan, Rome,
and Berlin.

<a href="https://github.com/Matt17BR/openwrangler/blob/main/docs/images/readme/workflow.png"><img alt="A Polars transformation draft with highlighted changed values, Apply and Discard actions, and generated code" src="https://raw.githubusercontent.com/Matt17BR/openwrangler/main/docs/images/readme/workflow.png" width="960"></a>

_Preview changed values and generated code before applying a step._

**3. Apply the step and keep the code.** Choose **Apply step**, then copy the generated code or use **Open Wrangler:
Export Generated Script**. Supported notebook and R-document sessions can insert code into the document that opened
the dataframe. Cleaned-data export always asks for a separate CSV or Parquet destination; Open Wrangler never
overwrites the source.

Opening data, running code, or exporting requires a trusted workspace. Open Wrangler stays inactive in Restricted
Mode.

## Core capabilities

- Explore a paged grid with column profiles, dataset summaries, typed filters, ordered sorts, full-schema search,
  rectangular selection, and copy.
- Clean rows, columns, types, text, categories, numbers, dates, missing values, and reshaped data. Drafts can be
  applied or discarded, and applied steps can be inspected, edited, deleted, or undone.
- Keep executable code for the selected engine beside the preview. Viewing filters and sorts remain separate from
  the cleaning plan and exported result.
- Open delimited text, Parquet, JSON Lines, and Excel files, or continue from live notebook and interactive dataframes.

**Current source:** Redo restores an undone command while its runtime session remains open. Dense Rank
adds numeric ranks while preserving ties and missing values. Mark Duplicates flags repeated groups without removing
records. For published availability, see the
[latest stable release notes](https://github.com/Matt17BR/openwrangler/releases/latest).

## View, edit, and export

Viewing includes filters, sorts, profiles and copy within each engine's limits. Pandas and Polars are the primary
stable-release scope; the experimental and Preview capabilities below have additional feature and testing limits.

| Dataframe or source                       | View    | Cleaning and generated code         | Data export                |
| ----------------------------------------- | ------- | ----------------------------------- | -------------------------- |
| Pandas files and live dataframes          | Yes     | Pandas Python                       | CSV / Parquet              |
| Polars files and live dataframes          | Yes     | Polars Python                       | CSV / Parquet              |
| DuckDB files — experimental               | Yes     | Supported operations, DuckDB Python | CSV / Parquet              |
| DuckDB notebook relations                 | Yes     | Unavailable                         | Unavailable                |
| Local PySpark Classic / Connect notebooks | Bounded | Unavailable                         | Unavailable                |
| R base `data.frame` — Preview             | Yes     | Supported operations, native R      | CSV / Parquet, with limits |
| R ordinary tibble — Preview               | Yes     | Supported operations, native R      | CSV / Parquet, with limits |
| R ordinary `data.table` — Preview         | Yes     | Supported operations, native R      | CSV / Parquet, with limits |

**Native R remains Preview even in stable extension releases.** Default `collapse::qDF()`, `qTBL()` and `qDT()` outputs
use the three R frame paths above. Grouped or rowwise tibbles, collapse `GRP_df` / `indexed_frame` objects, and unsupported
classes or attributes are refused. Input support does not imply support for every operation in those packages:
generated R uses one native dialect with class-specific operations, rather than selectable dplyr or collapse dialects.
See the [native R support and limits](https://github.com/Matt17BR/openwrangler/blob/main/docs/feature-parity.md#native-r-preview).

Cleaning sessions can copy or save generated code. Insertion targets only the originating notebook or managed document;
active R terminals have no document for insertion. Data export writes to a separate destination. The
[support details](https://github.com/Matt17BR/openwrangler/blob/main/docs/feature-parity.md) describe available
operations, remaining implementation limits and the evidence for each workflow.

The [generated reference](https://github.com/Matt17BR/openwrangler/blob/main/docs/reference.md) lists every command,
setting, operation, and supported parameter in the current source.

## Compatibility and limits

Open Wrangler requires VS Code 1.106 or newer. VS Code is the primary target. On Linux, Cursor is one tested
compatibility example for installation, activation, and representative grid, cleaning, export, and recovery flows.
It is not tested across every VS Code feature. Support for other VS Code-based desktop editors is experimental.
Browser-hosted editors are unsupported, and Remote SSH is outside the current compatibility coverage. Python file
and notebook workflows use Python 3.10 through 3.14. If a required package is missing, Open Wrangler names it and
asks before installing anything.

On Windows, Polars cannot open JSONL/NDJSON paths with glob characters such as `[` in a filename or folder name.
To use Pandas, set `openWrangler.defaultBackend` to `pandas` in Settings, then run **Open Wrangler: Open File Path**
and select the file again. Auto does not switch engines after a file-read error. Pandas uses its own parser and may
infer different types. See the [file-reader limits](https://github.com/Matt17BR/openwrangler/blob/main/docs/feature-parity.md)
and [#986](https://github.com/Matt17BR/openwrangler/issues/986).

For Windows Python notebooks, minimum CPython patch releases are 3.10.15, 3.11.10 and 3.12.4; supported 3.13
and 3.14 releases also qualify. These notebooks require the default local per-user temporary directory with its
standard profile protections. Custom or redirected temporary paths are unsupported.

To recover a kernel with older or unverified Open Wrangler imports, restart it and rerun the dataframe-creation cells
without importing `openwrangler_runtime`. Open the dataframe through the Open Wrangler notebook toolbar or variable
command to load the bundled runtime; then import and use `show` if needed. Explicit `show` remains supported for
static output. The
[architecture notes](https://github.com/Matt17BR/openwrangler/blob/main/docs/architecture.md#notebook-kernel-terminal-and-document-provenance)
describe runtime reuse and temporary-directory requirements.

For R, IRkernel works in VS Code on Linux, macOS and Windows, and in Cursor on Linux. Selected R terminal workflows are available on Linux. Direct `.R`, `.Rmd`, and
`.qmd` execution is available on macOS and Linux, not Windows; R Markdown and Quarto run selected code chunks rather
than rendering the document. Install `jsonlite` and `rlang` in the owning R environment. Parquet export also requires
`nanoparquet` 0.5.1 or newer.

<a href="https://github.com/Matt17BR/openwrangler/blob/main/docs/images/readme/gallery/notebook-r-editing.png"><img alt="An R notebook dataframe with a Group and aggregate draft, changed values, Apply and Discard actions, and generated R" src="https://raw.githubusercontent.com/Matt17BR/openwrangler/main/docs/images/readme/gallery/notebook-r-editing.png" width="960"></a>

_Use the same draft-and-code workflow with an R notebook dataframe._

DuckDB file editing is experimental and partial. DuckDB notebook relations and PySpark notebook dataframes are
view-only. PySpark uses an existing local Classic or Connect batch session; Open Wrangler does not install or
configure Spark. Streaming dataframes and remote or authenticated clusters are unsupported.

See [feature parity and current limits](https://github.com/Matt17BR/openwrangler/blob/main/docs/feature-parity.md),
[accessibility and keyboard use](https://github.com/Matt17BR/openwrangler/blob/main/docs/accessibility.md), the
[product gallery](https://github.com/Matt17BR/openwrangler/blob/main/docs/media-gallery.md), and the dated
[Data Wrangler comparison](https://github.com/Matt17BR/openwrangler/blob/main/docs/performance-comparison.md).

## Support and project

Open Wrangler is an open-source project inspired by
[Microsoft Data Wrangler](https://github.com/microsoft/vscode-data-wrangler). It was built independently, uses no
Microsoft Data Wrangler code or assets, and is not affiliated with Microsoft.

Contributions are welcome. See
[CONTRIBUTING.md](https://github.com/Matt17BR/openwrangler/blob/main/CONTRIBUTING.md), use
[GitHub Issues](https://github.com/Matt17BR/openwrangler/issues) for bugs and feature requests, and follow
[SECURITY.md](https://github.com/Matt17BR/openwrangler/blob/main/SECURITY.md) for vulnerability reports.

Open Wrangler is licensed under the [MIT License](https://github.com/Matt17BR/openwrangler/blob/main/LICENSE).
