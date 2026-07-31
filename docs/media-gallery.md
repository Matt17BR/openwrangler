# Product gallery

The full editor scenes below come from the packaged extension running against realistic, license-clean fixtures.
Focused interaction scenes use the same production webview bundle and deterministic fixtures. Visible dimensions
describe the captured scenario, not a product row or column limit.

[Explore](#explore-in-vs-code) · [Open files](#open-files-where-you-already-work) ·
[Profile and navigate](#profile-and-navigate) · [Transform](#build-and-review-a-cleaning-plan) ·
[Export](#export-code-and-clean-data) · [Notebooks](#notebook-workflows) · [Editors](#vscode-and-cursor)

## Explore in VS Code

![Open Wrangler in VS Code with the selected Activity Bar icon, native dataframe views, a virtualized Polars grid, header summaries, and the exact revenue profile](images/readme/v1.2/explore.png)

The workbench keeps the virtualized grid, header summaries, exact profiles, and editor-native controls together.
Only requested row and column blocks cross the runtime boundary.

### Native Activity Bar views

![All four Open Wrangler Activity Bar views populated beside a realistic dataframe](images/readme/v1.2/gallery/sidebar-overview.png)

Operations, Summary, Filters / Sorts, and Cleaning Steps stay useful without another editor tab. This scene shows
the native backend and shape, exact dataset counts, an editable two-key sort, one applied step, and a separate
draft at the same time.

## Open files where you already work

### Editor title action

[![The branded Open in Open Wrangler action in a CSV editor title bar](images/readme/v1.2/gallery/file-title-action.png)](images/readme/v1.2/gallery/file-title-action.png)

Open a supported file without leaving its current editor.

### Tab context menu

<a href="images/readme/v1.2/gallery/tab-context-menu.png"><img alt="The Open in Open Wrangler command in a CSV editor tab context menu" src="images/readme/v1.2/gallery/tab-context-menu.png" width="540"></a>

The same command is available from the open editor tab.

CSV and TSV inputs infer delimiter, encoding, quote style, and header automatically. **Import options** remains
available for explicit overrides.

![Open Wrangler Import options opened on the delimiter inferred from a semicolon-delimited CSV](images/readme/v1.2/gallery/import-options.png)

The ordinary open path asks no questions. When a source is unusual, **Import options** starts from the detected
configuration instead of asking the user to reconstruct it from memory.

## Profile and navigate

<table>
  <tr>
    <td width="50%"><a href="images/readme/v1.2/gallery/histogram-hover.png"><img alt="An exact numeric profile with a full-height histogram bin focused and its interval and row count visible" src="images/readme/v1.2/gallery/histogram-hover.png"></a></td>
    <td width="50%"><a href="images/readme/v1.2/gallery/sort-priority.png"><img alt="The Filters and Sorts sidebar with two ordered sorts and visible reorder and remove controls" src="images/readme/v1.2/gallery/sort-priority.png"></a></td>
  </tr>
  <tr>
    <td><strong>Inspect sparse bins.</strong> Keyboard focus and pointer hover use the full bin height, then expose the exact interval and row count.</td>
    <td><strong>Control compound sorts.</strong> The latest key becomes priority 1; inline actions reorder, edit, or remove keys without changing the source.</td>
  </tr>
</table>

![Open Wrangler column search showing the final result in a realistic 417-column dataframe](images/readme/v1.2/gallery/column-search-wide.png)

Column search virtualizes the complete schema and keeps type icons, full names, and keyboard position available.
The scene reaches item 417 of 417 to prove the list is not capped at its first page; 417 is a fixture size, not a
product limit.

## Build and review a cleaning plan

### Choose from the complete operation catalog

![The packaged Open Wrangler operation picker showing its grouped cleaning catalog beside the native Operations view](images/readme/v1.2/gallery/operation-catalog.png)

Search or browse the operation set by task. Opening the catalog does not change the dataframe or cleaning plan.

### Configure before anything changes

![A Formula column operation configured as revenue plus 500 into projected_revenue, ready to preview](images/readme/v1.2/gallery/operation-configuration.png)

The selected source column, operator, value, and output remain visible together. **Preview changes** creates a
draft; it does not commit the step.

### Preview the draft and generated code

![Open Wrangler reviewing a Polars draft with two ordered viewing sorts, cleaning history, a current grid-block diff, and generated code](images/readme/v1.2/workflow.png)

Viewing sorts remain separate from the cleaning plan. The draft highlights its added values, exposes Apply and
Discard, and generates executable Polars code in the native bottom panel before the step is committed.

### Inspect applied history

![Open Wrangler inspecting the latest applied Formula column step with filters paused and history controls visible](images/readme/v1.2/gallery/applied-step-inspection.png)

Selecting an applied step opens a bounded, read-only projection while the confirmed dataframe and filters remain
unchanged. **Show confirmed data**, **Edit latest**, and **Undo** are visible here; their executed journeys remain
separate acceptance scenarios.

### Transform by example

<a href="images/readme/v1.2/gallery/by-example-setup.png"><img alt="Open Wrangler by-example setup with structured account-code examples" src="images/readme/v1.2/gallery/by-example-setup.png"></a>

**Teach it.** Give exact source/output examples such as `DACH-DE-00482 → DE` and
`NORDICS-SE-01940 → SE`. Both mappings remain visible before deterministic synthesis begins.

<a href="images/readme/v1.2/gallery/by-example-preview.png"><img alt="Open Wrangler by-example preview deriving country codes for unseen structured account IDs" src="images/readme/v1.2/gallery/by-example-preview.png"></a>

**Review it.** Confirm the synthesized split across all ten unseen account IDs and use Apply or Discard only after
the candidate program has been previewed.

## Export code and clean data

<table>
  <tr>
    <td width="50%"><a href="images/readme/v1.2/gallery/export-script.png"><img alt="A generated native Polars cleaning script saved and opened in VS Code" src="images/readme/v1.2/gallery/export-script.png"></a></td>
    <td width="50%"><a href="images/readme/v1.2/gallery/export-data.png"><img alt="A separate cleaned CSV export opened after the source workflow" src="images/readme/v1.2/gallery/export-data.png"></a></td>
  </tr>
  <tr>
    <td><strong>Reusable code.</strong> The saved script contains the applied engine-native cleaning plan.</td>
    <td><strong>Separate output.</strong> The cleaned file opens normally while the source bytes remain unchanged.</td>
  </tr>
</table>

## Notebook workflows

### Choose a live variable by engine

![The Open Wrangler notebook variable picker identifying live DuckDB, Pandas, and Polars variables by engine and dataframe type](images/readme/v1.2/gallery/notebook-variable-picker.png)

The notebook toolbar discovers supported variables from the active kernel and labels each candidate with its
actual engine and dataframe type before launch.

### Pandas inline preview

![A Pandas dataframe rendered by Open Wrangler inside a packaged VS Code Jupyter notebook](images/readme/v1.2/notebook-pandas.png)

The portable inline table stays with the notebook. When the originating live variable is available, the action
opens the complete current dataframe in the workbench rather than limiting exploration to captured rows.

### Polars live editing

![A live native Polars notebook session with a formula-column draft and generated Polars code](images/readme/v1.2/gallery/notebook-polars.png)

The dataframe remains in Polars while Open Wrangler pages, profiles, previews the draft, computes the current
grid-block diff, and generates native code.

### DuckDB live relation

![A live native DuckDB relation with an exact filter, ordered two-key sort, paging, and column profiles](images/readme/v1.2/gallery/notebook-duckdb.png)

The viewing-only session queries the exact originating `DuckDBPyRelation`; it does not convert through Pandas,
Polars, or Arrow.

### PySpark Classic live notebook

![An experimental PySpark Classic notebook DataFrame with selected revenue column profiles](images/readme/v1.2/gallery/notebook-pyspark.png)

PySpark 4.2.x support is experimental and viewing-only. The exact selected Python kernel must already contain a
user-managed Classic or Connect session. Opening scans the complete DataFrame, assigns stable row positions, caches
an Open Wrangler-owned indexed child, and computes the exact row total; this can be expensive on large or remote
data. Filtering, sorting, paging, and requested profiling then run in Spark and return only bounded results. The
packaged scene validates local Classic; external or authenticated Connect remains unclaimed. File opening,
cleaning, export, code insertion, and saved inline previews are not supported.

## Rich DuckDB file types

<a href="images/readme/v1.2/gallery/duckdb-rich-parquet.png"><img alt="A file-backed DuckDB Parquet source with decimal, time-zone, list, and struct columns" src="images/readme/v1.2/gallery/duckdb-rich-parquet-detail.png"></a>

This focused production-webview scene uses a native DuckDB session over a deterministic 100,000-row Parquet
fixture. Decimal, time-zone-aware timestamp, list, and struct values remain typed through the grid and summaries.

## VS Code and Cursor

![The packaged Open Wrangler workbench in an isolated Cursor profile](images/readme/v1.2/gallery/cursor-explore.png)

VS Code and Cursor are release-tested from the same VSIX. Other desktop VS Code forks are experimental until
their marketplace, menus, notebook APIs, and packaged install path are validated.

The automated visual and accessibility suite also covers light, dark, and high-contrast themes, 80% to 200% zoom,
keyboard-only operation, loading and error states, empty frames, long Unicode content, and narrow and wide
layouts. Those regression images remain in the testing record rather than being presented as product media.
