<p align="center">
  <img src="https://raw.githubusercontent.com/Matt17BR/openwrangler/9fc096eabb1d0b5c0a66c3371a2a8ff8ce40de22/assets/icon.png" width="128" height="128" alt="Open Wrangler logo">
</p>

<h1 align="center">Open Wrangler</h1>

Open Wrangler is a visual dataframe editor for VS Code and editors based on it. Open files or live notebook data,
make changes visually, and keep the generated Python or R code.

<p align="center">
  <a href="https://github.com/Matt17BR/openwrangler/releases/latest"><img src="https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fapi.github.com%2Frepos%2FMatt17BR%2Fopenwrangler%2Freleases%2Flatest&amp;query=%24.tag_name&amp;label=stable&amp;color=blue" alt="Latest stable GitHub release"></a>
  <a href="https://github.com/Matt17BR/openwrangler/actions/workflows/ci.yml"><img src="https://github.com/Matt17BR/openwrangler/actions/workflows/ci.yml/badge.svg?event=pull_request" alt="Pull request CI status"></a>
  <a href="https://marketplace.visualstudio.com/items?itemName=Matt17BR.openwrangler"><img src="https://img.shields.io/badge/VS%20Marketplace-install-blue" alt="Install from Visual Studio Marketplace"></a>
  <a href="https://open-vsx.org/extension/Matt17BR/openwrangler"><img src="https://img.shields.io/badge/Open%20VSX-install-blue" alt="Install from Open VSX"></a>
  <a href="https://github.com/Matt17BR/openwrangler/blob/main/LICENSE"><img src="https://img.shields.io/github/license/Matt17BR/openwrangler" alt="MIT license"></a>
</p>

## What you can do

- **Explore data:** browse rows, inspect column profiles and summaries, filter, sort, and copy a selection.
- **Clean rows:** remove missing rows, remove duplicates, or flag repeated records with **Mark duplicates**.
- **Fill gaps:** use a fixed value, a statistic, another column, forward or backward fill, or interpolation.
- **Organize columns:** select, drop, rename, duplicate, and convert column types.
- **Clean text and categories:** trim spaces, replace text, change case, split columns, extract with regular expressions,
  and encode categories.
- **Calculate values:** write formulas, rank with ties, scale and round numbers, and format dates.
- **Reshape and summarize:** pivot between long and wide tables, or group rows and aggregate values.

You can also suggest a transformation with examples or write a custom code step.
[Operation availability depends on the engine](https://github.com/Matt17BR/openwrangler/blob/main/docs/feature-parity.md#cleaning-operations).

## Install

- **Stable:** [Visual Studio Marketplace](https://marketplace.visualstudio.com/items?itemName=Matt17BR.openwrangler),
  the newest non-preview version in [Open VSX](https://open-vsx.org/extension/Matt17BR/openwrangler), or the
  [latest GitHub release](https://github.com/Matt17BR/openwrangler/releases/latest).
- **Preview:** choose **Install Pre-Release Version** in your editor, or download a
  [GitHub prerelease](https://github.com/Matt17BR/openwrangler/releases).
- **From source:** [build and install the current main branch](https://github.com/Matt17BR/openwrangler/blob/main/CONTRIBUTING.md).

For a downloaded VSIX, use **Views and More Actions > Install from VSIX...** in the Extensions view.
See the [latest release notes](https://github.com/Matt17BR/openwrangler/releases/latest) or
[full changelog](https://github.com/Matt17BR/openwrangler/blob/main/CHANGELOG.md) for changes.

## From data to code

**1. Open a source.** Save the [four-row sample CSV](https://raw.githubusercontent.com/Matt17BR/openwrangler/main/fixtures/sample.csv)
in your workspace, then choose **Open in Open Wrangler** from Explorer, an editor tab, or the toolbar. You can also
open TSV, Parquet, JSONL/NDJSON, and Excel files, or a supported live dataframe from a notebook output or toolbar.

**2. Preview a change.** Switch to Editing if needed, choose **Add step**, then **Drop missing rows** on **sales**.
Choose **Preview changes**: Paris disappears from the sample draft, leaving Milan, Rome, and Berlin. Review the
changed values and generated code before choosing **Apply step** or **Discard**.

**3. Keep the result and code.** Copy the generated code or use **Open Wrangler: Export Generated Script**.
Supported notebook and R-document sessions can insert code into the originating document. Export cleaned data to a
separate CSV or Parquet file; Open Wrangler never overwrites the source.

<a href="https://github.com/Matt17BR/openwrangler/blob/main/docs/images/readme/workflow.png"><img alt="A Polars formula draft with an added column, Apply and Discard actions, and generated Python code" src="https://raw.githubusercontent.com/Matt17BR/openwrangler/main/docs/images/readme/workflow.png" width="960"></a>

_A Polars formula step adds a column. The preview shows its values and generated code before you apply it._

Viewing filters and sorts change only the view. Add **Filter rows** or **Sort rows** steps to include them in the
cleaning plan. Applied steps can be inspected, edited, deleted, undone, or redone.

Opening data, running code, and exporting require Workspace Trust. Open Wrangler stays inactive in Restricted Mode.

## Supported dataframes

| Dataframe or source                             | View    | Cleaning and generated code         | Data export                |
| ----------------------------------------------- | ------- | ----------------------------------- | -------------------------- |
| Pandas files and live dataframes                | Yes     | Pandas Python                       | CSV / Parquet              |
| Polars files and live dataframes                | Yes     | Polars Python                       | CSV / Parquet              |
| DuckDB files (experimental)                     | Yes     | Supported operations, DuckDB Python | CSV / Parquet              |
| DuckDB notebook relations                       | Yes     | Unavailable                         | Unavailable                |
| Local PySpark Classic / Connect notebooks       | Bounded | Unavailable                         | Unavailable                |
| R base data.frame, tibble, data.table (Preview) | Yes     | Supported operations, native R      | CSV / Parquet, with limits |

**R support is Preview** for ordinary frames. See
[native R support and limits](https://github.com/Matt17BR/openwrangler/blob/main/docs/feature-parity.md#native-r-preview)
and the [first stable R notebook scope](https://github.com/Matt17BR/openwrangler/blob/main/docs/feature-parity.md#first-stable-r-notebook-scope).

PySpark uses an existing local batch session. Open Wrangler does not install or configure Spark; streaming dataframes
and remote or authenticated clusters are unsupported.

## Compatibility and limits

Use VS Code 1.106 or newer. Python workflows require Python 3.10 through 3.14. Missing packages are named before
Open Wrangler asks to install them. Other VS Code-based desktop editors have limited compatibility coverage;
browser-hosted editors are unsupported, and Remote SSH is outside current coverage.

For Windows Python notebooks, minimum CPython patches are 3.10.15, 3.11.10, and 3.12.4; supported 3.13 and 3.14
releases also qualify. Use the default local per-user temporary directory with its standard profile protections.
Custom or redirected temporary paths are unsupported.

See [supported environments](https://github.com/Matt17BR/openwrangler/blob/main/docs/feature-parity.md#supported-environments),
[file-reader and export limits](https://github.com/Matt17BR/openwrangler/blob/main/docs/feature-parity.md#files-and-exports),
and [notebook runtime recovery](https://github.com/Matt17BR/openwrangler/blob/main/docs/architecture.md#notebook-kernel-terminal-and-document-provenance).
The [reference](https://github.com/Matt17BR/openwrangler/blob/main/docs/reference.md) lists commands, settings, and operation parameters.

## Support and project

Browse the [product gallery](https://github.com/Matt17BR/openwrangler/blob/main/docs/media-gallery.md),
[accessibility and keyboard guide](https://github.com/Matt17BR/openwrangler/blob/main/docs/accessibility.md), and
[Data Wrangler comparison](https://github.com/Matt17BR/openwrangler/blob/main/docs/performance-comparison.md).
For contributions, see [CONTRIBUTING.md](https://github.com/Matt17BR/openwrangler/blob/main/CONTRIBUTING.md).
Report bugs in [GitHub Issues](https://github.com/Matt17BR/openwrangler/issues), or follow
[SECURITY.md](https://github.com/Matt17BR/openwrangler/blob/main/SECURITY.md) for vulnerability reports.

Open Wrangler was built independently, inspired by [Microsoft Data Wrangler](https://github.com/microsoft/vscode-data-wrangler).
It uses no Microsoft Data Wrangler code or assets and is not affiliated with Microsoft.
Licensed under the [MIT License](https://github.com/Matt17BR/openwrangler/blob/main/LICENSE).
