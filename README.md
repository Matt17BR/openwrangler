<p align="center">
  <img src="https://raw.githubusercontent.com/Matt17BR/openwrangler/9fc096eabb1d0b5c0a66c3371a2a8ff8ce40de22/assets/icon.png" width="128" height="128" alt="Open Wrangler logo">
</p>

<h1 align="center">Open Wrangler</h1>

<p align="center">Open source dataframe workbench for VS Code and Cursor: Pandas and Polars editing, experimental DuckDB file editing and relation viewing, stable PySpark 4.2.x notebook viewing, and preview native R.</p>

<a href="https://github.com/Matt17BR/openwrangler/blob/9fc096eabb1d0b5c0a66c3371a2a8ff8ce40de22/docs/images/readme/v1.2/explore.png"><img alt="Open Wrangler in VS Code with its dataframe grid, column profiles, and native Activity Bar views" src="https://raw.githubusercontent.com/Matt17BR/openwrangler/9fc096eabb1d0b5c0a66c3371a2a8ff8ce40de22/docs/images/readme/v1.2/explore.png" width="960"></a>

_The workbench shows the dataframe, column profiles, filters, and cleaning steps in one editor._

<p align="center">Open Wrangler is an open-source project inspired by <a href="https://github.com/microsoft/vscode-data-wrangler">Microsoft Data Wrangler</a>. It was built independently and uses no Microsoft Data Wrangler code or assets.</p>

<!-- open-wrangler-release-status:start -->

<p align="center">
  <a href="https://github.com/Matt17BR/openwrangler/releases"><img src="https://img.shields.io/github/v/release/Matt17BR/openwrangler?display_name=tag&amp;sort=semver" alt="Latest GitHub release"></a>
  <a href="https://github.com/Matt17BR/openwrangler/actions/workflows/ci.yml"><img src="https://github.com/Matt17BR/openwrangler/actions/workflows/ci.yml/badge.svg?branch=main" alt="CI status"></a>
  <a href="https://marketplace.visualstudio.com/items?itemName=Matt17BR.openwrangler"><img src="https://vsmarketplacebadges.dev/version-short/Matt17BR.openwrangler.svg" alt="Visual Studio Marketplace version"></a>
  <a href="https://open-vsx.org/extension/Matt17BR/openwrangler"><img src="https://img.shields.io/open-vsx/v/Matt17BR/openwrangler?label=Open%20VSX" alt="Open VSX version"></a>
  <a href="https://github.com/Matt17BR/openwrangler/blob/main/LICENSE"><img src="https://img.shields.io/github/license/Matt17BR/openwrangler" alt="MIT license"></a>
</p>

> Open Wrangler 1.99 previews version 2. Features and behavior may still change.

## Install

| Editor                      | Support        |
| --------------------------- | -------------- |
| VS Code                     | Release-tested |
| Cursor                      | Release-tested |
| Other VS Code desktop forks | Experimental   |
| Browser-hosted `vscode.dev` | Unsupported    |

- **Latest stable:** choose **Install** on the [Visual Studio Marketplace](https://marketplace.visualstudio.com/items?itemName=Matt17BR.openwrangler), choose the newest
  stable version from [Open VSX](https://open-vsx.org/extension/Matt17BR/openwrangler)'s version list, or download the [latest stable GitHub Release](https://github.com/Matt17BR/openwrangler/releases/latest).
- **Latest preview:** choose **Install Pre-Release Version** on the editor listing. Other Open VSX clients may label
  this differently; select the newest `1.99.x` version. The same VSIX is available from [GitHub prereleases](https://github.com/Matt17BR/openwrangler/releases).
- **Current `main`:** build the latest source below. It may be ahead of the published preview.

For a downloaded VSIX, open the Extensions view and choose **Views and More Actions → Install from VSIX…**.

To build and install the current `main` branch:

```bash
git clone https://github.com/Matt17BR/openwrangler.git
cd openwrangler
npm ci --ignore-scripts
npm run package:dev
```

Then run `code --install-extension openwrangler-dev.vsix --force` or
`cursor --install-extension openwrangler-dev.vsix --force`.

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

The unpublished 1.99.7 candidate contains all 28 native-R cleaning operations, adding **Transform by Example** and
**Custom Code**. Disposable nonpublishing previews may exercise its packaging path; any future release
candidate requires explicit review, a same-byte soak, and a separate one-shot promotion.
Dedicated source contracts exercise the exact ordered catalog and executable production-generated R. A separate host
contract proves byte-exact clipboard and atomic script saves with one distinct executable operation-labelled buffer
per catalog entry. Candidate acceptance requires all 28 advertised capabilities and exercises Custom Code through
representative installed R paths; exhaustive installed execution of every operation and a reviewed performance record
remain outstanding, so Native R stays **Partial**. R Custom Code runs trusted arbitrary R in the selected environment;
it is not a sandbox and is unavailable in Restricted Mode.

The same catalog evidence fixes generated **Strip Text** for default or explicit mixed control/Unicode character sets,
and makes **Clone Column** preserve element names without invoking user-defined methods attached to dataframe-name
metadata.

The 1.99 preview has these R and literate-document entry points:

| Workflow                               | How it opens dataframes                                                                 | Available in                                                      |
| -------------------------------------- | --------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| IRkernel notebook                      | From Operations, the notebook toolbar, or Jupyter Variables                             | VS Code on Linux, macOS, and Windows; Cursor on Linux             |
| Selected VS Code R terminal            | Select the terminal; Operations reads vscode-R's dataframe list and keeps it up to date | VS Code and Cursor on Linux                                       |
| `.Rmd` or `.qmd` cursor chunk          | Put the cursor in an enabled R or Python chunk, then choose **Open in Open Wrangler**   | Desktop hosts with the corresponding official editor integrations |
| Explicit `.R`, `.Rmd`, or `.qmd` R run | Choose **Run R Document in Open Wrangler…** to start an Open Wrangler-managed R process | VS Code and Cursor on Linux; VS Code on macOS                     |

R-document support follows the machine running the extension host. Remote document execution is experimental, and a
Windows extension host rejects it. IRkernel notebooks work on Windows.

## Why Open Wrangler

- View and clean Pandas, Polars, R, or file-backed DuckDB data without conversion. DuckDB notebook relations and local stable/final PySpark 4.2.x Classic/Connect dataframes are view-only.
- Each cleaning step previews changed values and generated code before you apply it.
- Filters and multi-column sorts change only the view. Active typed filters stay above the grid, where each rule can
  be removed, all filters can be cleared without dropping sorts, and the latest confirmed filter change can be
  undone independently of cleaning history. Exports write a separate file.
- The grid fetches visible rows and columns on demand. Supported file-backed sources and live notebook Polars
  LazyFrames keep their lazy plans.

## Workbench

<a href="https://github.com/Matt17BR/openwrangler/blob/9fc096eabb1d0b5c0a66c3371a2a8ff8ce40de22/docs/images/readme/v1.2/gallery/sidebar-overview.png"><img alt="Open Wrangler showing Operations, Summary, Filters and Sorts, and Cleaning Steps beside a dataframe draft" src="https://raw.githubusercontent.com/Matt17BR/openwrangler/9fc096eabb1d0b5c0a66c3371a2a8ff8ce40de22/docs/images/readme/v1.2/gallery/sidebar-overview.png" width="960"></a>

The sidebar keeps operations, dataset health, filter and sort builders, and cleaning history beside the grid. Active
filter rules remain visible in a compact row above the data while the sidebar is closed. See the
[product gallery](https://github.com/Matt17BR/openwrangler/blob/main/docs/media-gallery.md) for file entry points,
by-example transformations, themes, Cursor, DuckDB types, and notebook engines.

If an unexpected renderer failure stops the workbench, Open Wrangler replaces the editor content with a focused
**Reload Open Wrangler** action. Reloading restores the view from the existing session instead of opening another one.

## Open files

Ordinary CSV and TSV files open with automatic delimiter, encoding, quote, and header detection. BOM-marked UTF-16LE
and UTF-16BE files open through Pandas automatically. **Import options** is available when a source needs an explicit
override. Excel adds sheet selection; Parquet and JSONL/NDJSON open directly.

<table>
  <tr>
    <td width="58%"><a href="https://github.com/Matt17BR/openwrangler/blob/9fc096eabb1d0b5c0a66c3371a2a8ff8ce40de22/docs/images/readme/v1.2/gallery/file-explorer-action.png"><img alt="Opening a CSV in Open Wrangler from the VS Code Explorer context menu" src="https://raw.githubusercontent.com/Matt17BR/openwrangler/9fc096eabb1d0b5c0a66c3371a2a8ff8ce40de22/docs/images/readme/v1.2/gallery/file-explorer-action-detail.png" width="920"></a></td>
    <td width="42%"><a href="https://github.com/Matt17BR/openwrangler/blob/9fc096eabb1d0b5c0a66c3371a2a8ff8ce40de22/docs/images/readme/v1.2/gallery/column-search-wide.png"><img alt="Searching to the final item in a 417-column synthetic dataframe" src="https://raw.githubusercontent.com/Matt17BR/openwrangler/9fc096eabb1d0b5c0a66c3371a2a8ff8ce40de22/docs/images/readme/v1.2/gallery/column-search-wide-detail.png" width="540"></a></td>
  </tr>
  <tr>
    <td>Open supported files from Explorer, the editor toolbar, tab menu, Command Palette, or <strong>Open With</strong>.</td>
    <td>Column search covers the full schema and includes data-type icons.</td>
  </tr>
</table>

<a href="https://github.com/Matt17BR/openwrangler/blob/9fc096eabb1d0b5c0a66c3371a2a8ff8ce40de22/docs/images/readme/v1.2/filter-result.png"><img alt="Open Wrangler showing 14,287 Benelux rows, Filter and Clear in Column profiles, and the same filter in the native sidebar" src="https://raw.githubusercontent.com/Matt17BR/openwrangler/9fc096eabb1d0b5c0a66c3371a2a8ff8ce40de22/docs/images/readme/v1.2/filter-result.png" width="960"></a>

_The active filter matches 14,287 rows. Column profiles, the grid, and the sidebar show the same filter and Clear
action without changing the source._

Hover or right-click a scalar grid cell to keep or exclude its exact value. Null and NaN have separate actions.
Drag across cells with a mouse or pen, or extend the focused selection with Shift+click or Shift+Arrow, to select a
rectangle. Ctrl/Cmd+click starts a new rectangle; non-contiguous selections are not supported. Select a column header,
or press Ctrl/Cmd+Space while it is focused, to prepare the whole filtered and sorted data column. The grid footer
copies one cell, the loaded columns in its row, the selected range, or the prepared column as tab-separated displayed
values; Ctrl/Cmd+C copies the current cell range or prepared column. An off-block keyboard rectangle remains selected,
but Copy range and Ctrl/Cmd+C report that every selected row and column must be loaded before copying. They do not copy
a partial rectangle.

<table>
  <tr>
    <td width="50%"><a href="https://github.com/Matt17BR/openwrangler/blob/9fc096eabb1d0b5c0a66c3371a2a8ff8ce40de22/docs/images/readme/v1.2/gallery/histogram-hover.png"><img alt="Revenue column profile with Counts and % controls and a focused 20,174 to 21,357 bin tooltip showing 398 rows (0.4%)" src="https://raw.githubusercontent.com/Matt17BR/openwrangler/9fc096eabb1d0b5c0a66c3371a2a8ff8ce40de22/docs/images/readme/v1.2/gallery/histogram-hover.png" width="448"></a></td>
    <td width="50%"><a href="https://github.com/Matt17BR/openwrangler/blob/9fc096eabb1d0b5c0a66c3371a2a8ff8ce40de22/docs/images/readme/v1.2/gallery/sort-priority.png"><img alt="Two ordered sorts with inline priority, reorder, edit, and remove controls" src="https://raw.githubusercontent.com/Matt17BR/openwrangler/9fc096eabb1d0b5c0a66c3371a2a8ff8ce40de22/docs/images/readme/v1.2/gallery/sort-priority.png" width="448"></a></td>
  </tr>
  <tr>
    <td>Switch between counts and percentages from the grid or column panel. Hover or focus a bin for both, or click a value or bin to filter. In a compact but usable grid, exact header statistics stay visible while taller distributions hide and return automatically as the layout changes.</td>
    <td>Add multiple sort keys, then reorder them or change direction and null placement.</td>
  </tr>
</table>

## Transformations

Choose from 32 operations, including filling missing values, multi-output literal splitting, portable
regular-expression extraction, deterministic Pivot longer and Pivot wider, engine-native custom Python or R code, and
transformations inferred from examples. A draft stays separate until you apply it. Any applied step can be inspected,
edited, or deleted. Cleaning Undo removes the most recent committed step. Reordering committed steps is not supported.

Fill Missing Values shows only methods that work with the selected column. Choices that need a group, coordinate,
sort key, or fallback column appear only when the dataframe has a compatible column.

Pivot longer turns 2–64 ordered, exactly compatible scalar columns into one label column and one value column. It
keeps unselected columns, preserves values without common-type coercion, and emits selected-column-major rows.

Pivot wider uses one text/factor key column and one scalar value column with 2–64 explicitly declared typed keys and
output names. Duplicate identifier/key rows fail instead of aggregating; missing declared combinations become typed
nulls, retained identifiers keep their public lineage, and groups follow first source occurrence.

| Column type                | Methods                                                                                                           |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Floating point             | Median, mean, grouped median or mean, linear interpolation, previous or next value, fallback columns, fixed value |
| Integer or decimal         | Median, grouped median, previous or next value, fallback columns, fixed value                                     |
| Text, category, or boolean | Most common value across the column or within groups, previous or next value, fallback columns, fixed value       |
| Date or date-time          | Previous or next value, fallback columns, fixed value                                                             |
| Duration or binary         | Previous or next value                                                                                            |
| Unknown scalar type        | Fixed typed value                                                                                                 |

Ordered fills use sort keys you choose and can leave long gaps untouched. Fallback columns are checked in your chosen
order on the same row. Every preview reports how many values are still missing before you apply the step.

<a href="https://github.com/Matt17BR/openwrangler/blob/9fc096eabb1d0b5c0a66c3371a2a8ff8ce40de22/docs/images/readme/v1.2/workflow.png"><img alt="Open Wrangler reviewing a Polars draft with two viewing sorts, cleaning history, highlighted new values, Apply and Discard, and generated code" src="https://raw.githubusercontent.com/Matt17BR/openwrangler/9fc096eabb1d0b5c0a66c3371a2a8ff8ce40de22/docs/images/readme/v1.2/workflow.png" width="960"></a>

_This preview shows the changed values and generated Polars code. The two sorts affect only the current view._

<table>
  <tr>
    <td width="50%"><a href="https://github.com/Matt17BR/openwrangler/blob/9fc096eabb1d0b5c0a66c3371a2a8ff8ce40de22/docs/images/readme/v1.2/gallery/latest-step-edited.png"><img alt="Cleaning Steps after editing the latest formula while preserving the earlier uppercase step" src="https://raw.githubusercontent.com/Matt17BR/openwrangler/9fc096eabb1d0b5c0a66c3371a2a8ff8ce40de22/docs/images/readme/v1.2/gallery/latest-step-edited-detail.png" width="448"></a></td>
    <td width="50%"><a href="https://github.com/Matt17BR/openwrangler/blob/9fc096eabb1d0b5c0a66c3371a2a8ff8ce40de22/docs/images/readme/v1.2/gallery/latest-step-undone.png"><img alt="Cleaning Steps after undoing the formula and retaining the uppercase step" src="https://raw.githubusercontent.com/Matt17BR/openwrangler/9fc096eabb1d0b5c0a66c3371a2a8ff8ce40de22/docs/images/readme/v1.2/gallery/latest-step-undone-detail.png" width="448"></a></td>
  </tr>
  <tr>
    <td>Editing the latest step updates that history entry instead of adding a duplicate.</td>
    <td>Undo removes the latest step without clearing filters or sorts.</td>
  </tr>
</table>

## Notebook workflows

In trusted Python notebooks and Python Interactive windows, Open Wrangler previews Pandas, Polars, and DuckDB outputs
and lists the live dataframes in Operations and the notebook action. **Open in Open Wrangler** loads the current live
dataframe from that same kernel. Unassigned results such as `orders.tail(20)` also get the button while the result is
still available in the kernel. If the first result appears before Open Wrangler's formatter is ready, use **Open in
Open Wrangler** below that cell. It opens the executed result without running the cell again.

Supported live dataframes open in Viewing mode by default. Viewing filters and sorts only the grid; it does not build
a cleaning plan or change the source. Use **Switch to Editing** to build a plan. You can return with **Switch to
Viewing** while the plan is empty and no draft is open. DuckDB notebook relations remain view-only.

Python files have the same action in the editor toolbar and tab menu. For an ordinary `.py` file, Open Wrangler runs
the file in Python Interactive and opens the live dataframe you choose. If the file uses `# %%` cells, it runs only
the cell under the cursor. Once the Interactive window is open, its own **Open in Open Wrangler** action lists the
dataframes already in memory without rerunning the source cell.

If Microsoft Data Wrangler is installed too, choose which extension owns automatic previews with **Open Wrangler:
Choose Notebook Preview Provider**.

<table>
  <tr>
    <td width="44%"><a href="https://github.com/Matt17BR/openwrangler/blob/9fc096eabb1d0b5c0a66c3371a2a8ff8ce40de22/docs/images/readme/v1.2/gallery/notebook-variable-picker.png"><img alt="Notebook variable picker labeling Pandas, Polars, and DuckDB variables by engine and dataframe type" src="https://raw.githubusercontent.com/Matt17BR/openwrangler/9fc096eabb1d0b5c0a66c3371a2a8ff8ce40de22/docs/images/readme/v1.2/gallery/notebook-variable-picker-detail.png" width="602"></a></td>
    <td width="56%"><a href="https://github.com/Matt17BR/openwrangler/blob/9fc096eabb1d0b5c0a66c3371a2a8ff8ce40de22/docs/images/readme/v1.2/gallery/notebook-code-insertion.png"><img alt="Generated Pandas cleaning code inserted into the originating VS Code notebook" src="https://raw.githubusercontent.com/Matt17BR/openwrangler/9fc096eabb1d0b5c0a66c3371a2a8ff8ce40de22/docs/images/readme/v1.2/gallery/notebook-code-insertion.png" width="960"></a></td>
  </tr>
  <tr>
    <td>The notebook picker labels each live variable by engine and dataframe type.</td>
    <td>Insert generated code into the notebook that opened the dataframe.</td>
  </tr>
</table>

<table>
  <tr>
    <td width="50%"><a href="https://github.com/Matt17BR/openwrangler/blob/9fc096eabb1d0b5c0a66c3371a2a8ff8ce40de22/docs/images/readme/v1.2/notebook-pandas.png"><img alt="Pandas dataframe previewed inline inside a VS Code notebook" src="https://raw.githubusercontent.com/Matt17BR/openwrangler/9fc096eabb1d0b5c0a66c3371a2a8ff8ce40de22/docs/images/readme/v1.2/gallery/notebook-pandas-detail.png" width="698"></a></td>
    <td width="50%"><a href="https://github.com/Matt17BR/openwrangler/blob/9fc096eabb1d0b5c0a66c3371a2a8ff8ce40de22/docs/images/readme/v1.2/gallery/notebook-polars.png"><img alt="A native Polars notebook session with a formula draft and generated Polars code" src="https://raw.githubusercontent.com/Matt17BR/openwrangler/9fc096eabb1d0b5c0a66c3371a2a8ff8ce40de22/docs/images/readme/v1.2/gallery/notebook-polars-detail.png" width="884"></a></td>
  </tr>
  <tr>
    <td>Pandas outputs open as live Pandas dataframes.</td>
    <td>Polars dataframes stay native and generate Polars code.</td>
  </tr>
  <tr>
    <td width="50%"><a href="https://github.com/Matt17BR/openwrangler/blob/9fc096eabb1d0b5c0a66c3371a2a8ff8ce40de22/docs/images/readme/v1.2/gallery/notebook-duckdb.png"><img alt="A native DuckDB relation with filtering, paging, profiles, and ordered sorts" src="https://raw.githubusercontent.com/Matt17BR/openwrangler/9fc096eabb1d0b5c0a66c3371a2a8ff8ce40de22/docs/images/readme/v1.2/gallery/notebook-duckdb-detail.png" width="872"></a></td>
    <td width="50%"><a href="https://github.com/Matt17BR/openwrangler/blob/9fc096eabb1d0b5c0a66c3371a2a8ff8ce40de22/docs/images/readme/v1.2/gallery/notebook-pyspark.png"><img alt="PySpark dataframe grid beside the revenue profile, with Source Order, Viewing Only, and PySpark badges" src="https://raw.githubusercontent.com/Matt17BR/openwrangler/9fc096eabb1d0b5c0a66c3371a2a8ff8ce40de22/docs/images/readme/v1.2/gallery/notebook-pyspark-detail.png" width="820"></a></td>
  </tr>
  <tr>
    <td>DuckDB relations are view-only and do not require dataframe conversion.</td>
    <td>Local stable/final PySpark 4.2.x Classic and Connect batch DataFrames support viewing, filtering, sorting, paging, and profiles.</td>
  </tr>
</table>

PySpark support is notebook-only and view-only. It uses an existing local stable/final PySpark 4.2.x Classic or Connect session; Open
Wrangler does not install or configure Spark. Streaming DataFrames and remote or authenticated clusters are not
supported.

PySpark loads pages sequentially. The toolbar says **Source order** until you add a sort, then **Sorted**. Spark can
change source order, and rows tied across every sort key can move when it reruns the DataFrame. Use a unique final
sort key when you need repeatable rows.

Open Wrangler does not count or cache the whole PySpark dataframe before showing the first page; the row total
appears after the final page. If the data changes while you page through it, Open Wrangler asks you to reopen the
variable. A temporary Spark Connect outage leaves the current grid in place and shows **Retry page**. If the server
has lost the session or dataframe, rerun the cell that creates the same variable and choose **Reconnect**. The old
grid stays visible unless that reconnect works.

Closing the view leaves Spark work that has already started alone, so Open Wrangler cannot cancel unrelated notebook
jobs.

Open Wrangler handles base R `data.frame`, tibble, and `data.table` objects in the R process where they already live.
The entry point determines which process owns the session:

- In an IRkernel notebook, open a loaded dataframe from Operations, the notebook toolbar, or Jupyter Variables.
  Operations refreshes after a cell finishes. The dataframe opens in Viewing mode; use **Switch to Editing** when you
  want to build a cleaning plan. You can return to Viewing while the plan is empty and no draft is open. Generated R
  can be inserted into that exact notebook.
- For an interactive session from the official R extension, select its terminal. Operations reads the dataframe
  names already maintained by vscode-R; it does not run anything in R just to fill the sidebar. If that metadata is
  unavailable, use **Refresh R dataframes**. Opening a dataframe or refreshing explicitly connects Open Wrangler to
  that exact R process. **Start R and show dataframes…** opens a session when none is running. The list and every
  opened dataframe stay tied to that terminal. These dataframes open in Viewing mode and can switch to Editing.
  They can return to Viewing while the cleaning plan is empty and no draft is open. The **Open in Open Wrangler**
  title action uses this session while it is active. Generated R can be copied or saved, but it cannot be inserted
  because the terminal has no source document.
- In an `.Rmd` or `.qmd` editor, the primary **Open in Open Wrangler** action detects the fenced chunk at the exact
  cursor. It runs only that enabled chunk in its existing R or Python session and then opens a dataframe from that
  session. R Markdown and knitr/reticulate Quarto Python chunks stay in the selected R terminal;
  Jupyter Quarto Python chunks use the exact resulting Interactive Window. Common labels and `#|` option lines are
  accepted; Quarto supports backtick and tilde fences, while R Markdown uses backtick fences. Select the owning R
  terminal before an R-backed run. Open Wrangler reports missing Quarto, R, or Jupyter support before asking for a
  session. Ambiguous executor metadata, a terminal switch, or a changed cursor/document stops the open. Outside a
  runnable chunk, the action asks which session to use when both R and Python are available. It never renders or runs
  the complete document.
- On local macOS and Linux workspaces, **Run R Document in Open Wrangler…** runs a trusted `.R` file or the supported
  top-level R cells in an `.Rmd` or `.qmd` document, including unsaved changes. It uses its own R process and follows
  the file start-mode setting, which defaults to Editing. This does not replace Quarto or R Markdown rendering.
  Generated R can be inserted back into the exact open document. This explicit all-R fallback remains separate from
  the cursor-owned mixed-language action.

Remote R-document execution is experimental.

<a href="https://github.com/Matt17BR/openwrangler/blob/9fc096eabb1d0b5c0a66c3371a2a8ff8ce40de22/docs/images/readme/v1.2/gallery/r-quarto-variable-picker.png"><img alt="A rendered Quarto table beside the source document and Open Wrangler dataframe picker" src="https://raw.githubusercontent.com/Matt17BR/openwrangler/9fc096eabb1d0b5c0a66c3371a2a8ff8ce40de22/docs/images/readme/v1.2/gallery/r-quarto-variable-picker-detail.png" width="960"></a>

Switching a live notebook or terminal dataframe from Viewing to Editing keeps its filters, sorts, column widths, and
grid position. Open Wrangler does not overwrite the live R object.

The R workbench supports paging, filters, multi-column sorts, value search, profiles, and cleaning steps for rows,
columns, text, numbers, missing values, and grouped summaries. Missing values can use a typed value, median, mean,
mode, a fallback column, ordered forward or backward fill, grouped statistics, or numeric interpolation when the
column type supports it. Numeric columns can also be scaled to 0–1 or transformed with Round, Floor, and Ceiling.
Formula creates a numeric column from another column and either a second column or a finite scalar. Date and datetime
columns can be formatted in place or into a new text column. POSIXct values use their declared time zone, or UTC
when none is declared. One-hot encoding accepts one or more supported scalar columns, while multi-label binarization
splits a text or factor column on an exact delimiter. Both produce deterministic integer indicator columns, ignore
missing or blank categories, and can keep or drop their selected inputs.
Transform by Example accepts ordered source columns and example input/output rows, deterministically infers a portable
program, and shows that canonical program with its generated R before creating a new column. Retained plans replay the
same program instead of inferring it again.
Every draft shows the changed data and generated R before it is applied. Applied steps can be inspected, edited, or
undone. A generated script publishes `open_wrangler_result`; if the source already uses that name, it preserves the
source and publishes `open_wrangler_result_2`. The [generated reference](https://github.com/Matt17BR/openwrangler/blob/main/docs/reference.md#transformation-operations)
lists the operation parameters; the workbench shows only the operations supported by the active dataframe.

Large R frames are profiled in chunks. Row and missing-value counts, common numeric and text statistics, and date ranges
stay exact. Histograms and categories may use a clearly labeled sample; searches still scan the full column. Very broad
searches ask for a more specific term.

<a href="https://github.com/Matt17BR/openwrangler/blob/9fc096eabb1d0b5c0a66c3371a2a8ff8ce40de22/docs/images/readme/v1.2/gallery/notebook-r-editing.png"><img alt="An R Group and aggregate draft for regional orders with cleaning history, Apply and Discard controls, and generated R" src="https://raw.githubusercontent.com/Matt17BR/openwrangler/9fc096eabb1d0b5c0a66c3371a2a8ff8ce40de22/docs/images/readme/v1.2/gallery/notebook-r-editing.png" width="960"></a>

The draft groups regional orders by market and channel and previews total revenue before the step is applied.

Generated R can always be copied or saved as a script. Insertion is available only when the session came from an
IRkernel notebook or an Open Wrangler-managed R document, because those workflows retain an exact source document.
Local R sessions opened in Editing mode can export cleaned CSV files. They can also export Parquet when
`nanoparquet` 0.5.1 or newer is installed in the R environment that owns the dataframe. Reopen the dataframe after
installing the package so Open Wrangler can refresh its export choices.

Ordinary frames created with `collapse::qDF()`, `qTBL()`, and `qDT()` use the existing dataframe, tibble, and
data-table paths without adding `collapse` as a dependency. Their atomic and classed columns may retain ordinary
element names when they open. Grouped `GRP_df` and indexed `indexed_frame` objects are not supported. The [R gallery](https://github.com/Matt17BR/openwrangler/blob/main/docs/media-gallery.md#r-notebooks-and-documents-199-preview)
also shows the variable picker, profiles, and generated code inserted into a notebook.

## Export

<table>
  <tr>
    <td width="50%"><a href="https://github.com/Matt17BR/openwrangler/blob/9fc096eabb1d0b5c0a66c3371a2a8ff8ce40de22/docs/images/readme/v1.2/gallery/export-script.png"><img alt="Generated native Polars cleaning code saved as a Python script" src="https://raw.githubusercontent.com/Matt17BR/openwrangler/9fc096eabb1d0b5c0a66c3371a2a8ff8ce40de22/docs/images/readme/v1.2/gallery/export-script-detail.png" width="960"></a></td>
    <td width="50%"><a href="https://github.com/Matt17BR/openwrangler/blob/9fc096eabb1d0b5c0a66c3371a2a8ff8ce40de22/docs/images/readme/v1.2/gallery/export-data.png"><img alt="A cleaned CSV exported separately and opened in VS Code" src="https://raw.githubusercontent.com/Matt17BR/openwrangler/9fc096eabb1d0b5c0a66c3371a2a8ff8ce40de22/docs/images/readme/v1.2/gallery/export-data-detail.png" width="960"></a></td>
  </tr>
  <tr>
    <td>Copy generated code or save it as a Python or R script. Notebook and R-source sessions can also insert it into the document that opened the dataframe.</td>
    <td>Pandas, Polars, DuckDB, and local R editing sessions export cleaned CSV or Parquet files. R uses nanoparquet for Parquet.</td>
  </tr>
</table>

## Engines and formats

| Engine                      | Files                                     | Notebook data                         | How it runs                                                |
| --------------------------- | ----------------------------------------- | ------------------------------------- | ---------------------------------------------------------- |
| Polars                      | CSV, TSV, Parquet, JSONL/NDJSON, Excel    | DataFrame, LazyFrame, Series          | Native; LazyFrame sessions stay lazy                       |
| Pandas                      | CSV, TSV, Parquet, JSONL/NDJSON, Excel    | DataFrame, Series                     | Native, including duplicate column labels                  |
| DuckDB, experimental        | CSV, TSV, Parquet, JSONL/NDJSON           | DuckDBPyRelation                      | Native; notebook relations are viewing-only                |
| PySpark 4.2.x, stable/final | No                                        | Local Classic/Connect batch DataFrame | Native notebook viewing, filtering, sorting, and profiles  |
| R (1.99 preview)            | Local `.R`, `.Rmd`, `.qmd` on macOS/Linux | `data.frame`, tibble, `data.table`    | IRkernel, selected VS Code R terminal, or document Rscript |

Automatic file selection prefers Polars, then DuckDB, then Pandas. A file backend can also be pinned in settings.
Notebook variables are matched to their supported native type, including Pandas 2 and 3, DuckDB relations, and local
stable/final PySpark 4.2.x Classic/Connect batch DataFrames. Polars LazyFrames remain lazy when opened from a notebook. Pages and
profiles collect only bounded results. One-hot encode and Multi-label binarize materialize a lazy result when you
preview those operations because their output columns depend on the values in the dataframe. Custom Polars code can
also choose to return an eager DataFrame.

To keep a notebook result native to DuckDB, open the relation itself. For example,
`orders = duckdb.read_csv("orders.csv")`. Calling `orders.df()` explicitly creates a Pandas DataFrame, so Open
Wrangler correctly opens that resulting object with Pandas.

For a trusted Pandas pickle, right-click the file and choose **Convert Trusted Pickle to Parquet…**. Open Wrangler
asks where to save the Parquet file and asks again before Python loads the pickle. The conversion is saved separately;
Open Wrangler never overwrites the pickle.

See the [operation and command reference](https://github.com/Matt17BR/openwrangler/blob/main/docs/reference.md)
for the complete surface.

## Performance

Open Wrangler fetches the grid blocks you can see instead of loading the whole dataset into the webview. File-backed
Polars sessions use lazy scans, and live notebook LazyFrames keep their existing lazy plan. Filtering, sorting, and
column selection stay in that plan until a bounded result or explicit export is requested. Pandas data stays in
Pandas, and DuckDB relations stay in DuckDB.

The latest reviewed comparison found faster notebook previews and CSV column profiling in Open Wrangler; Parquet
workbench and profiling times were close. One important difference is how Polars is handled: Open Wrangler keeps it in
Polars, while Data Wrangler converts it to Pandas. The benchmark starts after loading, so it does not measure the
conversion itself.

See the [dated benchmark report](https://github.com/Matt17BR/openwrangler/blob/main/docs/performance/data-wrangler-1.2.1/review.md)
for the test setup and reviewed results.

## Roadmap

The [product roadmap](https://github.com/Matt17BR/openwrangler/blob/main/docs/product-roadmap.md) records verified
support boundaries, acceptance criteria, and the P1-P5 order. The project is in a maintainability-first scope freeze:
bounded fidelity and daily-use work continues, while new backend, platform, and editor breadth waits for the documented
approachability gates. Native R preview status remains in
[#87](https://github.com/Matt17BR/openwrangler/issues/87). Stable 2.0 also requires correcting silent Pandas index loss
on export.

## Contributing and support

Contributions are welcome. See
[CONTRIBUTING.md](https://github.com/Matt17BR/openwrangler/blob/main/CONTRIBUTING.md), use
[GitHub Issues](https://github.com/Matt17BR/openwrangler/issues) for bugs and feature requests, and follow
[SECURITY.md](https://github.com/Matt17BR/openwrangler/blob/main/SECURITY.md) for vulnerability reports.

## License

Open Wrangler is licensed under the [MIT License](https://github.com/Matt17BR/openwrangler/blob/main/LICENSE).
It is not affiliated with Microsoft.
