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

<a href="https://github.com/Matt17BR/openwrangler/blob/main/docs/images/readme/explore.png"><img alt="A Polars dataframe in VS Code with missing-value counts, column distributions and a detailed revenue profile" src="https://raw.githubusercontent.com/Matt17BR/openwrangler/main/docs/images/readme/explore.png" width="960"></a>

_Inspect missing values and distributions beside the rows you are exploring._

Select a column to see its profile, then click a category or histogram bin to filter the view. Search for columns,
combine filters, choose the order of sort keys, or copy a selection. Column profiles and the dataset summary help you
spot empty fields, unusual values and repeated records before deciding what to change.

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

## What you can do

- **Clean rows:** remove missing rows, remove duplicates, or flag repeated records with **Mark duplicates**.
- **Fill gaps:** use a fixed value, a statistic for the whole column or each group, a fallback column, ordered
  forward/backward fill, or interpolation.
- **Organize columns:** select, drop, rename, duplicate, and convert column types.
- **Clean text and categories:** trim spaces, replace text, change case, split into columns, extract with regular
  expressions, and encode categories.
- **Calculate values:** write numeric formulas, rank with ties, scale and round numbers, and format dates.
- **Create labels and flags:** use **Conditional column** for Text or Boolean results, including a separate result
  for missing inputs.
- **Reshape and summarize:** pivot between long and wide tables, or group rows and aggregate values.

Transform by Example infers a rule from your input/output examples. Preview it on other rows before applying it.
For work outside the catalog, a Custom Code step can use your dataframe engine directly. Available operations and
fill methods depend on the engine and column type; see the
[operation support guide](https://github.com/Matt17BR/openwrangler/blob/main/docs/feature-parity.md#cleaning-operations).

<a href="https://github.com/Matt17BR/openwrangler/blob/main/docs/images/readme/gallery/operation-catalog.png"><img alt="The searchable cleaning-operation picker in Open Wrangler" src="https://raw.githubusercontent.com/Matt17BR/openwrangler/main/docs/images/readme/gallery/operation-catalog.png" width="960"></a>

_Search or browse cleaning operations, then configure the selected step._

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

_A larger orders example: preview a new Polars formula column and its generated code before applying it._

Viewing filters and sorts change only the view. Add **Filter rows** or **Sort rows** steps to include them in the
cleaning plan.

## Review and revise your steps

Choose an applied step in **Cleaning Steps** to inspect its changes, then return to the confirmed data. You can edit
or delete earlier steps, or use **Undo** and **Redo**. Changing an earlier step replays the later steps so the result
and generated code follow the updated plan.

<a href="https://github.com/Matt17BR/openwrangler/blob/main/docs/images/readme/gallery/applied-step-inspection-detail.png"><img alt="Inspecting an applied Formula column step with its added column highlighted and history controls visible" src="https://raw.githubusercontent.com/Matt17BR/openwrangler/main/docs/images/readme/gallery/applied-step-inspection-detail.png" width="960"></a>

_Inspect an applied step without changing the confirmed data or viewing filters._

## Use notebook data and keep the code

Run the cell that creates your dataframe, choose **Open in Open Wrangler** from the notebook toolbar, and select
its variable. Supported dataframe outputs also offer an inline preview with an action to open the full workbench.
Pandas and Polars notebook sessions support the same viewing and cleaning workflow as files.

Copy the generated code, save a Python script, or insert it into the notebook that opened the dataframe. The code
uses the selected engine: Pandas stays Pandas and Polars stays Polars. You can review and reuse the cleaning function
in the rest of your analysis.

Generated Python defines a cleaning function; it does not load or export data automatically. To reuse it, load the
next input with the same engine and import settings, preserve the expected column names and order, then call the
generated function, for example `result = clean_data(next_frame)`.

<a href="https://github.com/Matt17BR/openwrangler/blob/main/docs/images/readme/gallery/notebook-code-insertion.png"><img alt="Generated Pandas cleaning code inserted into an orders-analysis notebook" src="https://raw.githubusercontent.com/Matt17BR/openwrangler/main/docs/images/readme/gallery/notebook-code-insertion.png" width="960"></a>

_Bring the cleaning function back into the notebook that opened the dataframe._

DuckDB notebook relations and local PySpark DataFrames support viewing, filters, sorts and profiles, with the limits
in the table below. Their notebook sessions do not offer cleaning or export.

## Work with R directly

Ordinary base `data.frame`, tibble and `data.table` objects in IRkernel notebooks have stable support in desktop
VS Code on Linux, macOS and Windows since [2.5.0](https://github.com/Matt17BR/openwrangler/releases/tag/v2.5.0).
Open Wrangler works directly in R, with no conversion through Python.

Preview cleaning steps, inspect history, copy or save generated R, and insert it back into the originating notebook.
CSV export is available; Parquet export requires `nanoparquet` and has type and precision limits.

<a href="https://github.com/Matt17BR/openwrangler/blob/main/docs/images/readme/gallery/notebook-r-editing.png"><img alt="An R Group and aggregate draft with regional totals, cleaning history and generated R" src="https://raw.githubusercontent.com/Matt17BR/openwrangler/main/docs/images/readme/gallery/notebook-r-editing.png" width="960"></a>

_Preview grouped R results alongside the cleaning history and generated R code._

R terminal sessions on Linux and managed `.R`, `.Rmd` and `.qmd` documents on Linux/macOS are **Preview**.
Cursor support is **experimental**. The [native R support guide](https://github.com/Matt17BR/openwrangler/blob/main/docs/feature-parity.md#native-r-support)
describes supported frame classes, operations and export limits.

## Supported dataframes

| Dataframe or source                       | View    | Cleaning and generated code         | Data export                |
| ----------------------------------------- | ------- | ----------------------------------- | -------------------------- |
| Pandas files and live dataframes          | Yes     | Pandas Python                       | CSV / Parquet              |
| Polars files and live dataframes          | Yes     | Polars Python                       | CSV / Parquet              |
| DuckDB files (experimental)               | Yes     | Supported operations, DuckDB Python | CSV / Parquet              |
| DuckDB notebook relations                 | Yes     | Unavailable                         | Unavailable                |
| Local PySpark Classic / Connect notebooks | Bounded | Unavailable                         | Unavailable                |
| R base data.frame, tibble, data.table     | Yes     | Supported operations, native R      | CSV / Parquet, with limits |

PySpark uses an existing local batch session. Open Wrangler does not install or configure Spark; streaming dataframes
and remote or authenticated clusters are unsupported.

## Compatibility and limits

Opening data, running code, and exporting require Workspace Trust. Open Wrangler stays inactive in Restricted Mode.

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

Browse the [product gallery](https://github.com/Matt17BR/openwrangler/blob/main/docs/media-gallery.md) and
[accessibility and keyboard guide](https://github.com/Matt17BR/openwrangler/blob/main/docs/accessibility.md).
The [product roadmap](https://github.com/Matt17BR/openwrangler/blob/main/docs/product-roadmap.md) tracks unscheduled
proposals such as explicit date parsing, nested-column expansion and guided reuse of a cleaning plan on another input.
For contributions, see [CONTRIBUTING.md](https://github.com/Matt17BR/openwrangler/blob/main/CONTRIBUTING.md).
Report bugs in [GitHub Issues](https://github.com/Matt17BR/openwrangler/issues), or follow
[SECURITY.md](https://github.com/Matt17BR/openwrangler/blob/main/SECURITY.md) for vulnerability reports.

Open Wrangler was built independently, inspired by [Microsoft Data Wrangler](https://github.com/microsoft/vscode-data-wrangler).
It uses no Microsoft Data Wrangler code or assets and is not affiliated with Microsoft.
Licensed under the [MIT License](https://github.com/Matt17BR/openwrangler/blob/main/LICENSE).
