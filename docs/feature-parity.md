# Feature parity matrix

Baseline: Microsoft Data Wrangler 1.24.2, observed and documented on 2026-07-15. This table records behavior, not implementation details.

Status values: **Done** has automated and editor acceptance evidence; **Partial** is usable but incomplete; **Planned** is not release-ready. Open Wrangler 1.0 requires every in-scope row to be **Done**.

The parity table covers Pandas and Polars. DuckDB file support is experimental. Local PySpark 4.2 Classic/Connect
notebook viewing has its own acceptance table below; neither changes what counts as Done for Pandas or Polars.

VS Code and Cursor are the first-class, release-blocking editor targets. Other VS Code-based desktop IDEs are experimental: their distribution registry and bounded smoke evidence are tracked separately in [issue #86](https://github.com/Matt17BR/openwrangler/issues/86) and do not inherit a compatibility claim from the VS Code/Cursor matrix. Google says [Antigravity is based on VS Code and downloads extensions from Open VSX](https://antigravity.google/docs/editor?app=antigravity). Open Wrangler 1.2.0 passed one bounded Antigravity Linux x64 install, activation, file-open, source-immutability, and cleanup smoke through Open VSX; the exact non-release-blocking record and its limitations are in [testing](testing.md#experimental-antigravity-smoke). Browser-hosted `vscode.dev` remains outside the local-runtime scope.

| Surface                                              | Pandas | Polars | Status | Required evidence                                                                     |
| ---------------------------------------------------- | -----: | -----: | ------ | ------------------------------------------------------------------------------------- |
| CSV/TSV/Parquet/Excel/JSONL entry points             |    Yes |    Yes | Done   | Auto delimited/first-sheet open, named picker, `.xls`; record:docs/testing.md         |
| Notebook variable viewer and toolbar                 |    Yes |    Yes | Done   | Proactive formatter, typed picker, released Jupyter matrix; record:docs/testing.md    |
| Inline notebook renderer and full-view expansion     |    Yes |    Yes | Done   | Captured expansion, bounded pager, exact editors; record:docs/testing.md              |
| Virtual grid, column sizing, navigation              |    Yes |    Yes | Done   | Hosted exact-artifact paint/scroll gate green; record:docs/testing.md                 |
| Dataset summary and quick insights                   |    Yes |    Yes | Done   | Typed profiles/stats plus packaged queries green; record:docs/testing.md              |
| Basic and advanced viewing filters                   |    Yes |    Yes | Done   | AND/OR engine, browser, and packaged green; record:docs/testing.md                    |
| Multi-column viewing sorts                           |    Yes |    Yes | Done   | Quick and ordered sort journeys green; record:docs/testing.md                         |
| Editing mode and operation catalog                   |    Yes |    Yes | Done   | Structural duplicate/non-string packaged matrix green; record:docs/testing.md         |
| Draft preview and data diff                          |    Yes |    Yes | Done   | Typed/identity diff and packaged previews green; record:docs/testing.md               |
| Cleaning-step history, edit, discard, undo           |    Yes |    Yes | Done   | Installed selection/diff/clear and shortcuts green; record:docs/testing.md            |
| Generated code preview and editing                   |    Yes |    Yes | Done   | Native code plus edited packaged exports green; record:docs/testing.md                |
| Sort/filter cleaning steps                           |    Yes |    Yes | Done   | Stable refs, native/code edges, packaged duplicates; record:docs/testing.md           |
| Select/drop/rename/clone/cast/formula/length         |    Yes |    Yes | Done   | Reordered mixed-label preview/apply/replay green; record:docs/testing.md              |
| Drop missing/duplicate rows                          |    Yes |    Yes | Done   | Stable refs, all row modes, code and packaged catalog; record:docs/testing.md         |
| Fill missing values                                  |    Yes |    Yes | Done   | Typed, grouped, ordered, and interpolated fills; record:docs/testing.md               |
| One-hot and multi-label binarization                 |    Yes |    Yes | Done   | Null/blank/collision and generated-code parity; record:docs/testing.md                |
| Find/replace/strip/split/case transforms             |    Yes |    Yes | Done   | Unicode/null plus packaged text preview/apply; record:docs/testing.md                 |
| Scale/round/floor/ceiling/datetime format            |    Yes |    Yes | Done   | Numeric edges plus packaged preview/apply; record:docs/testing.md                     |
| Group and aggregate                                  |    Yes |    Yes | Done   | Nullable order plus packaged preview/apply; record:docs/testing.md                    |
| Custom engine-native code                            |    Yes |    Yes | Done   | Trusted custom code plus installed Restricted Mode; record:docs/testing.md            |
| String/datetime/new-column by example                |    Yes |    Yes | Done   | Candidate matrix plus packaged confirmation; record:docs/testing.md                   |
| Copy/script/notebook code export                     |    Yes |    Yes | Done   | Edited buffer, source-safe Save/alias package green; record:docs/testing.md           |
| CSV and Parquet data export                          |    Yes |    Yes | Done   | Cross-engine atomic and packaged exports green; record:docs/testing.md                |
| Runtime selection, setup, change, clear              |    Yes |    Yes | Done   | Resolver, bounded preflight retry, exact install/reopen green; record:docs/testing.md |
| Original icons, native views, themes, accessibility  |    N/A |    N/A | Done   | Exact-head axe plus native VS Code/Cursor gates; record:docs/testing.md               |
| Runtime crash/reload/session replay                  |    Yes |    Yes | Done   | Packaged injected recovery/replay green; record:docs/testing.md                       |
| Column-projected grid-block transport                |    Yes |    Yes | Done   | Bounded row/column blocks plus native pushdown green; record:docs/testing.md          |
| Duplicate/non-string Pandas column operations        |    Yes |    N/A | Done   | All ID-backed families packaged and replayed; record:docs/testing.md                  |
| Restricted Mode and trust-gated execution            |    N/A |    N/A | Done   | Separate trusted/untrusted installed-editor runs green; record:docs/testing.md        |
| Installed-editor first-usable-grid performance       |    Yes |    Yes | Done   | Hosted 100k CSV/1M Parquet editor gate green; record:docs/testing.md                  |
| Cross-platform first-class editor package acceptance |    N/A |    N/A | Done   | Exact VS Code/Cursor OS + Remote SSH green; record:docs/testing.md                    |

Post-1.0 viewing-filter hardening keeps the completed filter surface usable as well as semantically correct. Focused React coverage proves that removing a final selected value removes the column filter itself, changing per-column logic cannot create an empty filter, and **Filter rows** stays disabled for an effective-empty query. A two-column interaction keeps every active filter visible, removes one value or predicate without disturbing siblings, and preserves sorts on the same or another column. The native Filters tree exercises the same whole-column removal through the host/webview action boundary.

**Fill missing values** works on one stable column at a time. Numeric columns can use the median of their present
values, and floating-point columns can use their mean. Text, categorical, and boolean columns can use the most common
non-missing value. Supported scalar columns can use an explicit value of the matching type. They can also use an
ordered list of same-type fallback columns: the first present value in each row wins, while a row with no present
fallback stays missing. Ordered data can use the previous or next value after an explicit stable multi-column sort.
The sort belongs to the cleaning step rather than the current view, and the result returns to its prior row order.
An optional maximum gap applies to a complete missing run; longer runs stay untouched. Forward fill leaves leading
gaps unresolved, while backward fill leaves trailing gaps unresolved. Numeric columns can calculate a median within
selected groups, floating-point columns can calculate a grouped mean, and text, categorical, and boolean columns can
use the most common value within each group. Null and NaN grouping keys share one group. If every target value in a
group is missing, those cells stay missing; tied most-common values do too. Row order does not change. Automatic
methods ignore both null and NaN. Floating-point columns can interpolate along one numeric, date, or date-time
coordinate. The coordinate must be complete, finite, and unique. Only missing runs with finite values on both sides
are filled; an optional limit leaves longer runs untouched. The calculation uses coordinate distance and returns rows
to their original order. Every draft reports the exact number of target values that are still missing after the
preview. When a global fill needs a value, a tie, an all-missing column, or an undefined mean asks the
user for another method. A no-op keeps the exact native column type.
On Python engines, a specific value or a fallback from a different categorical domain may widen the result to text;
the preview shows that type change. The most-common method uses an existing value and keeps its category type. Integer
and decimal medians must fit that type exactly; decimal values must also fit its scale, and datetime values must match
its timezone awareness. Applying the draft adds the step to Open Wrangler's cleaning plan. It never changes the
original dataframe. Generated Pandas, Polars, DuckDB, and R code uses the same rules. Focused tests cover the dialog
and the preview, apply, edit, discard, and undo lifecycle.

Cleaning-step preview, apply, latest-step edit, discard, and undo now preserve the independent viewing query instead of resetting it. Parameterized Pandas, Polars, and DuckDB runtime coverage keeps compatible selected values, searches, predicates, and ordered multi-sorts; prunes missing, ambiguous, or semantic-type-changed references; restores the exact pre-draft query on discard when the view was untouched; and keeps an explicit in-draft edit authoritative through Discard or Apply. Immediate undo restores the pre-first-apply query only when no later view edit occurred, including across latest-step replacement. Coordinator persistence restores the validated draft-base receipt before replaying a draft and then restores the independent current view; malformed or stale receipt/view sections fall back independently. React coverage verifies that confirmed Discard retains the runtime-published filters and sort priority.

Post-1.0 column navigation replaces the browser-native suggestion list with an accessible VS Code-native combobox. It exposes Codicon-based datatype symbols and text labels, searches names plus semantic and native types, disambiguates duplicate labels by position, and targets stable column IDs. Focused React coverage proves keyboard selection and duplicate-name navigation, while the packaged README capture requires the real typed popup to fit inside the workbench.

Pickle files do not open directly in Open Wrangler. A separate **Convert Trusted Pickle to Parquet…** file-menu action
is available for Pandas DataFrames in trusted workspaces. The user chooses a new destination and sees the exact Python
interpreter before any pickle code runs. Cancelling writes nothing, and Open Wrangler never overwrites the pickle. The
Parquet output uses the same symlink and atomic-write checks as data export and can be opened when conversion finishes.
Focused command, environment, worker, filesystem, Python, and manifest tests cover the failure paths. The packaged VS
Code and Cursor journey rejects an ordinary pickle open, declines once, converts a generated three-column fixture, and
opens the Parquet result. It also checks that no worker directory or transaction temp remains.

The released v1.1.1 notebook UX prepares automatic Pandas/Polars MIME formatters when a trusted, visible Jupyter notebook has a user-started kernel, rather than waiting for the first Open Wrangler command. Stable Jupyter lookup never creates a kernel, API-opened background notebooks remain untouched, and a visible notebook change bypasses retry backoff so a newly available kernel is handled promptly. If Microsoft Data Wrangler is installed, the default `ask` preference requires the user to choose which extension owns automatic dataframe previews before Open Wrangler registers a formatter; the provider remains changeable and a switch applies to new or restarted kernels. The notebook-toolbar action uses a bounded, kernel-backed QuickPick populated from canonical runtime types instead of asking users to type a variable name. Every discovery and launch retains the exact originating `NotebookDocument`, rejects duplicate same-URI document objects, and never retargets after focus changes.

Inline MIME v2 output shows every captured column and pages the captured rows at 10, 20, 50, or 100 rows per page. When the output retains one canonical live-variable link, its single **Open in Open Wrangler** action opens the complete current dataframe through the exact originating notebook and kernel; it never substitutes the saved capture. An unlinked output stays readable inline and tells the user to run the cell again instead of exposing a misleading open action. The notebook-toolbar and Jupyter Variables workflows remain additional live entry points. Focused unit, renderer, provenance, provider-conflict, restart, and packaged-editor acceptance defined in `docs/testing.md` must be green before this candidate is released.

Trusted Python `.py` editors expose **Open in Open Wrangler** before Jupyter has detected the file's cells. The
command runs only the `# %%` code cell under the cursor in the selected Python Interactive kernel. If the new window
has no kernel, Open Wrangler waits for Jupyter's first command to finish and for any delayed cell to appear before the
normal kernel picker opens once. It then restores the same source and cursor, waits for the exact new cell, and opens
a dataframe from that window. A missing marker, failed cell, changed source, or ambiguous window stops before variable
discovery. If Jupyter does not confirm whether the command started, Open Wrangler tells the user to check the
Interactive Window instead of running it again. The command never runs the whole file or switches to a different source.
Packaged released-Jupyter acceptance clicks the visible editor action against a private Python file and checks the
native Polars session, known page values, unchanged source bytes, and complete session cleanup.

## Native R preview

Open Wrangler 1.99 previews can open base `data.frame`, tibble, and `data.table` variables through IRkernel or from
the exact active terminal owned by the official R extension. The Operations view refreshes that terminal's loaded
dataframes and opens the selected object without converting it through Python. Changing or closing the R terminal
invalidates the list instead of retargeting another session.

IRkernel and active-terminal variables start in Viewing mode and can switch to Editing without changing the source
object. R documents follow the file start-mode setting, which defaults to Editing. Generated R can be copied or saved
from any editing session. Insertion is available only for an exact originating IRkernel notebook or Open
Wrangler-managed R document; an active terminal has no source document to edit.

A trusted local `.R`, `.Rmd`, or `.qmd` document on macOS or Linux can also run in an Open Wrangler-owned R process,
after which the user chooses one of the dataframes it created. R Markdown and Quarto use supported top-level `{r}`
cells rather than a document render. The editor-title action opens a dataframe from the selected official R terminal
when one is active and otherwise runs the current document. On macOS and Linux, the tab menu keeps explicit commands
for both paths. Pages, compound filters, ordered sorts,
value search, and column and dataset profiles run in R; the dataframe is not passed through Python. Editing mode
currently supports twenty-one cleaning operations: Filter Rows, Sort Rows, Drop Missing Rows, Fill Missing Values,
Drop Duplicates, Rename Column, Drop Columns, Select Columns, Clone Column, Convert type, Text Length, Lowercase,
Uppercase, Find and replace, Capitalize, Strip text, Split text, Round, Floor, Ceiling, and Group and aggregate. They follow the
same draft, code preview, apply, discard, inspection, edit-latest, and undo flow as the released Python engines. A
viewing filter or sort can be copied into a cleaning draft. Filters keep the typed distinction between `NA` and
`NaN`; sorts keep their compound priority, and both keep stable source-row identities through history and diffs.
Notebook variables open in Viewing mode by default. **Switch to Editing** in the dataframe toolbar atomically opens
the same live variable through its captured notebook and keeps the confirmed filters, sorts, widths, selection, and
grid position. A closed or replaced notebook fails the mode change without replacing the working Viewing session.
Drop Missing Rows treats `NA` and `NaN` as missing and can drop
rows when any or all selected columns are missing. Drop Duplicates compares selected columns, or all columns by
default, and can keep the first, last, or no row in each repeated group without changing source order. Select Columns
keeps the user's chosen order, and Clone Column gives the copy its own stable identity. Text Length accepts character
and factor input, keeps `NA`, and adds an integer column containing Unicode character counts under a stable derived
identity. The text operations accept character and factor input, convert factors to character, and keep `NA`.
Lowercase, Uppercase, Capitalize, Strip text, and Find and replace can update the source or append a character column.
Find and replace supports literal text and regular expressions. Strip text removes a literal set of characters from
both ends, or the default whitespace when no set is supplied. Split text uses a literal delimiter, adds a new column,
and returns `NA` when the requested part is missing. Convert type replaces one column under the same identity and
supports string, integer, float, boolean, date, and datetime targets. Failed parses become `NA`. It rejects active data-table
keys and conversions that would lose units or `integer64` precision. Generated R can be copied, saved as a `.R`
script, or inserted into the notebook or R document that opened the dataframe. Local R notebook and R document
sessions opened in Editing mode can export the committed cleaning result as CSV. Parquet export is also available when
`nanoparquet` 0.5.1 or newer is installed in the selected R environment; a session opened before installation must be
reopened so its capabilities can be refreshed.

Group and aggregate accepts one or more stable key references and any number of named aggregations. It supports sum,
mean, median, minimum, maximum, count, distinct count, first, and last. Groups keep first-seen order, and `NA` and
`NaN` keys share one missing group. The result keeps the source dataframe family, clears a `data.table` key, and gives
each group a new row identity. Integer and `integer64` sums are exact and fail if the result exceeds their supported
range. Their outputs stay ordinary R integer or `bit64::integer64`; base R and `bit64` do not have an exact 38-digit
integer type, so overflow fails before publication instead of changing the public type. Integer64 mean and median
perform exact decimal addition before producing their final double values. First and last follow source order.

Round, Floor, and Ceiling accept ordinary integer, double, and `integer64` columns. Ordinary integer and double
outputs are R doubles, while `integer64` stays exact. They keep `NA`, `NaN`, `Inf`, and `-Inf`; Round uses R's
ties-to-even rule. An active `data.table` key cannot be changed in place, but the result can be appended to a new
column.

Fill Missing Values offers the median of all non-missing numeric values, the mean of a double column, the most common
non-missing character, factor, or logical value, a specific typed value, or ordered same-row fallback columns. It can
also use the previous or next value in an explicit multi-column order, with an optional whole-run gap limit. The
result returns to its earlier row order. Median, mean, and most common value can also be calculated within selected
groups. All-missing groups and tied most-common values stay missing. Automatic fills ignore `NA` and `NaN`. Factor
order and existing levels are kept; new labels used by a fill are appended as levels. Double columns can interpolate
missing runs along an ordinary numeric, `Date`, or `POSIXct` coordinate. Signed 64-bit integers are not accepted as
interpolation coordinates. Signed 64-bit integers, dates, and datetimes keep their R types. Active data-table key
columns are blocked.

The default `collapse::qDF()` output follows the base `data.frame` path. Default `collapse::qTBL()` and `qDT()` output
follows the existing tibble and `data.table` paths. Open Wrangler does not require `collapse`, and grouped `GRP_df`
and indexed `indexed_frame` objects are not supported.

PR [#333](https://github.com/Matt17BR/openwrangler/pull/333) integrated the R notebook, document, editing, and export
work. Its reviewed head `3355f897f62f50d766a6dd906dffc649443fca68` passed
[CI](https://github.com/Matt17BR/openwrangler/actions/runs/31152735013),
[cross-platform tests](https://github.com/Matt17BR/openwrangler/actions/runs/31152735012), and
[CodeQL](https://github.com/Matt17BR/openwrangler/actions/runs/31152734985) before it was merged as
`66b52c92cf3dd1e6d157d9a335513a805acf9742`.

[Run 31062443212](https://github.com/Matt17BR/openwrangler/actions/runs/31062443212) is an earlier viewing and
recovery baseline from `6742255`. It used R 4.5.2 in VS Code and Cursor and a containerized IRkernel in VS Code,
covering filters, profiles, sort priority, kernel restart, source preservation, and cleanup. It predates R cleaning
support and does not cover the editing claims below.

The [product gallery](media-gallery.md#r-notebooks-and-documents-199-preview) shows the packaged IRkernel picker, viewing
workbench, Rename Column draft, and generated R inserted into the originating notebook. Packaged VS Code runs cover
the first twenty operations on a base data frame, including preview, apply, inspection, discard, latest-step editing,
and undo. Convert type is applied and undone. Drop Missing Rows and Drop Duplicates each cover preview, apply,
returning from step inspection, and undo. Cursor keeps a shorter installed-editor path within the existing phase
deadline: paging, profiles, filters, compound-sort priority, Viewing-to-Editing replay, Rename
preview/discard/apply/inspection/undo, one native tibble edit, and one keyed `data.table` edit. Its picker still checks
base, tibble, `data.table`, and supported `collapse` objects. Native R and cross-language tests cover all twenty-one
operations, plus class and key behavior for tibbles and data tables. They also cover row identity, compound
sort priority, typed filtering, mixed plans, ordered selection, type conversion, Unicode character counts, native R
text casing and replacement, `NA` preservation, stable retained and derived identities, duplicate names,
non-syntactic names, and executable generated R. The installed VS Code run opens the Round, Floor, and Ceiling forms and
checks positive and negative fractional results in the visible grid.
The packaged R run also inserts the current Rename code as one `r` cell without changing any existing cell. A
1,205-row notebook export applies that Rename, keeps an active filter and two sort keys, and saves all committed rows
through the public command. The installed VS Code journey checks the renamed CSV, unchanged notebook and view state,
and cleanup of both host and IRkernel artifacts. Native export tests cover the same contract outside the editor. A
second macOS/Linux run starts from a real `.R` file,
opens a discovered dataframe, inserts generated code back into that exact unsaved document, and reruns the result
without changing a decoy editor or either source file on disk.
The same VS Code acceptance phase includes realistic `.Rmd` and `.qmd` fixtures with first-line YAML, ignored prose, a
relative CSV read, native editing, and a generated fenced R cell. The R Markdown parser fixture also includes a non-R
cell and a disabled R cell. Focused tests cover nested presentation options and disabled external chunk references,
while malformed or enabled code-replacement options fail before R starts. Python-only documents do not start R; the
explicit R-document command explains that no R code chunk was found. The installed VS Code run locally on Linux covers
all three document types.
Cursor runs the complete plain `.R` document path, including cleaned CSV export; parser, runtime, and VS Code
acceptance cover the literate formats without repeating them in Cursor's single installed-editor phase.
The macOS preview and stable release cells must pass the same local document subjourney in packaged VS Code. Their Windows
counterparts run the complete local IRkernel journey but skip direct documents. Local Windows file menus are hidden;
remote-resource actions and the Command Palette remain reachable because static client keys cannot identify the
extension-host platform. The runtime platform check is authoritative. Remote R-document execution is experimental
and is not part of the release matrix. Direct document execution is disabled on a Windows extension host until the
extension can own the complete spawned process tree. Operations
outside the listed 21-operation set are not available in R yet.

Before a 2.0 tag can be published, both release workflows must pass the local `r-jupyter` journey in packaged VS Code
on hosted macOS and Windows. The freshly verified candidate VSIX is used directly; these jobs do not rebuild it or
substitute a smaller R smoke test.

| Surface                                       | Availability                    | Status  | Current checks                                                                                                                  | Release check   |
| --------------------------------------------- | ------------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------- | --------------- |
| Native R frame paging and typed cells         | 1.99 preview                    | Partial | Projected pages, row labels, local/remote packaged tests                                                                        | Preview release |
| Native R compound viewing filters             | 1.99 preview                    | Partial | R contracts and packaged value/predicate path                                                                                   | Preview release |
| Native R value search and selections          | 1.99 preview                    | Partial | Typed selection contracts and packaged value path                                                                               | Preview release |
| Native R ordered viewing sorts                | 1.99 preview                    | Partial | Pure-R tests and local/remote packaged tests                                                                                    | Preview release |
| Native R column and dataset profiles          | 1.99 preview                    | Partial | R 4.4/4.5 tests, packaged UI, and filtered contracts                                                                            | Preview release |
| Base `data.frame`, tibble, and `data.table`   | 1.99 preview                    | Partial | Native discovery, paging, queries, and profile tests                                                                            | Preview release |
| Exact IRkernel session transport              | 1.99 preview                    | Done    | Linux local VS Code/Cursor and remote VS Code; macOS/Windows VS Code gate                                                       | Preview release |
| Exact active R-terminal transport             | 1.99 preview                    | Partial | Public VS Code terminal API, Operations refresh/list, native request and cleanup tests; packaged VS Code/Cursor journey pending | Preview release |
| Owned `.R` source process                     | 1.99 preview                    | Partial | Real process contracts; local Linux VS Code/Cursor; local macOS VS Code                                                         | Preview release |
| Owned `.Rmd` and `.qmd` cell process          | 1.99 preview                    | Partial | Parser and real-R contracts; local Linux/macOS VS Code installed run                                                            | Preview release |
| Notebook workbench                            | 1.99 preview                    | Partial | Packaged viewing/editing, screenshots, production axe                                                                           | Preview release |
| R cleaning operations and generated code      | 21 operations                   | Partial | All 21 pass in native runtime and packaged VS Code; Cursor runs the representative path described above                         | Preview release |
| Copy or save generated R                      | 21 operations                   | Partial | Rename uses packaged save; all 21 generate executable code                                                                      | Preview release |
| Insert generated R into its IRkernel notebook | 1.99 preview                    | Partial | Shared exact-document helper and packaged VS Code run                                                                           | Preview release |
| Insert generated R into its source `.R` file  | 1.99 preview                    | Partial | Exact-document helper and packaged rerun                                                                                        | Preview release |
| Insert generated R into `.Rmd` and `.qmd`     | 1.99 preview                    | Partial | Exact-document tests and packaged VS Code run                                                                                   | Preview release |
| Cleaned-data export                           | R notebook/document CSV/Parquet | Partial | Native writers, bounded transfer, atomic save, installed notebook/document run                                                  | Preview release |
| Active R-terminal cleaned-data export         | 1.99 preview                    | Partial | Native writer and atomic-save tests; packaged VS Code/Cursor journey pending                                                    | Preview release |
| Quarto and R Markdown lexical R-cell run      | 1.99 preview                    | Partial | Parser, owned process, and packaged VS Code run                                                                                 | Preview release |

## DuckDB file-backed preview matrix

DuckDB keeps data as native lazy `DuckDBPyRelation` plans. The preview neither converts through Pandas, Polars, or Arrow nor installs/loads DuckDB extensions automatically. **Partial** below means the native runtime path has automated evidence but the complete installed-editor and release matrix is still pending; **Planned** means the surface is intentionally unavailable in this preview.

| Surface                                      | Availability        | Status  | Recorded evidence                                       | Remaining acceptance gate                                    |
| -------------------------------------------- | ------------------- | ------- | ------------------------------------------------------- | ------------------------------------------------------------ |
| CSV and TSV file sessions                    | Yes                 | Partial | Lazy native reads plus packaged VS Code/Cursor imports  | Malformed/options and cross-platform matrix                  |
| Parquet file sessions                        | Yes                 | Partial | Packaged rich typed page and source invalidation        | Large-scale and full cross-platform/repeated matrix          |
| JSONL file sessions                          | Yes                 | Partial | Native malformed-input diagnostic and packaged import   | Installed malformed/import-state interaction matrix          |
| Excel file sessions                          | No                  | Planned | Explicit diagnostic directs users to Pandas or Polars   | Deferred; no DuckDB Excel claim                              |
| `.duckdb` database/catalog/table browsing    | No                  | Planned | Not registered as a source kind                         | Deferred source/connection/security design                   |
| Notebook variables and inline MIME rendering | Viewing only        | Partial | Packaged native VS Code/Cursor Jupyter relation matrix  | Large relation, OS, and repeated recovery/performance matrix |
| Grid pages, typed cells, filters, and sorts  | Yes                 | Partial | Native rich-type matrix; packaged page and query slices | Large-scale mixed data and cross-platform matrix             |
| Summaries, statistics, and distinct values   | Yes                 | Partial | Exact profiles plus packaged progressive-query matrix   | Large-data resource and repeated performance evidence        |
| Complete 28-operation catalog                | Yes                 | Partial | All kinds native/generated; packaged group matrix green | Fill-missing editor journey and DuckDB semantic edge matrix  |
| Draft preview, diff, apply, and history      | Preview/apply slice | Partial | Runtime and packaged preview/diff/apply/replay          | DuckDB edit/discard/undo interaction matrix                  |
| Executable generated DuckDB code             | Yes                 | Partial | All kinds equal; packaged preview/copy/script green     | Edited-code execution acceptance                             |
| CSV and Parquet cleaned-data export          | Yes                 | Partial | Native/atomic packaged exports preserve source bytes    | Failure injection and cross-platform destination matrix      |
| Runtime crash/reload/session replay          | Yes                 | Partial | Backend-keyed two-process replay and injected recovery  | Cross-platform and repeated failure-injection matrix         |
| Runtime performance benchmark                | Diagnostic          | Partial | Opt-in direct/stdio smoke with provenance/resources     | Repeated full-size evidence; it is not a strict release gate |

### Native DuckDB replacement-kernel recovery evidence

Exact head `152d5cca95e4c57f0187d19bac00ed594ac04820` passed
[released-Jupyter run 30590890283](https://github.com/Matt17BR/openwrangler/actions/runs/30590890283).
The real packaged-Jupyter allow path records the following behavior:

- Retain a 100,000-row connection-private DuckDB relation alongside concurrent Polars and Pandas sessions
  during an actual kernel restart. Before replacement, confirm a filter, two ordered sort rules, the complete
  ordered public schema, one selected column, a resized width, and a nonzero viewport.
- Recreate the notebook variable in the exact observed replacement process and arm hard Pandas, Polars, and
  Arrow conversion traps before Open Wrangler may recover. Require the same public session and viewing state
  over a changed private runtime identity, then repeat a native numeric summary. Open Wrangler does not
  serialize relation SQL or imply that a connection-private object survives process death. The editor profile
  deliberately requests Editing; the runtime-confirmed DuckDB Viewing mode must be pinned for strict replay.
- Leave both the coordinator and replacement kernel manager with zero sessions after terminal cleanup while
  the replacement user relation and connection remain queryable. Focused exact-kernel tests also bind DuckDB
  opens to timeout and cancellation cleanup and prove old and replacement session IDs close only on their
  mapped kernel generations; the isolated denial phase retries a DuckDB-typed open after persisted permission
  denial.

## PySpark live-notebook viewer

Open Wrangler supports viewing local PySpark 4.2.x Classic and Connect batch DataFrames from live Jupyter notebooks
in VS Code and Cursor. PySpark support is notebook-only and view-only. Open Wrangler uses the notebook's existing
Spark session and does not install or configure Spark. Streaming DataFrames, files, cleaning, exports, saved output,
remote or authenticated clusters, and Spark provisioning are not supported.

Every open checks the value and PySpark version in the exact selected kernel before creating a session. The first
grid block loads without counting, globally indexing, or caching the whole dataframe. Pages advance sequentially,
and a short final page establishes the exact total. A changed page boundary asks the user to reopen the variable.
Spark does not guarantee source order, and rows tied across every sort key may move on rerun. Users who need
repeatable rows must end the sort list with a unique key.

Kernel restarts and replacement Classic or Connect DataFrames with the same schema restore the current view. A
temporary Connect outage leaves the grid available for retry. If the server loses the session or DataFrame, rerun
the defining cell and choose **Reconnect**. Work that has not started is dropped when the view changes; late results
from running work are ignored rather than interrupting the kernel, because a PySpark interrupt can cancel unrelated
notebook jobs.

Focused Classic and Connect tests cover projection, progressive paging, filters, ordered multi-column sorts,
profiles, restart/rebind, reconnect, and cleanup without conversion through Pandas or Arrow. A 1,000,000-row,
32-partition Classic regression proves the first page neither schedules every source partition nor creates a
persistent RDD. The released-Jupyter package phase has also passed local Classic and Connect in VS Code and Cursor.
Each release still reruns the package phase against the exact candidate VSIX.

Run [30975727813](https://github.com/Matt17BR/openwrangler/actions/runs/30975727813) tested commit
`2f2c3545ef049a2ddf23e338451bef0e91834316`. For its three
warm 1,000,000-row, 10-column, 32-partition samples, the median selected-column profile took 3.33 seconds in Classic
and 2.97 seconds in Connect; all-column profiling took 34.68 and 33.29 seconds. The all-column results were 8.1% and
13.0% lower than the preceding exact-main baseline. The selected-column differences were small enough to treat as
run-to-run variation. These measurements are used to spot regressions; they are not a pass/fail speed target.

| Surface                                        | v1.2 support       | Status       | Recorded evidence                                     | Boundary                                     |
| ---------------------------------------------- | ------------------ | ------------ | ----------------------------------------------------- | -------------------------------------------- |
| Local Classic DataFrame viewing                | Live notebook only | Done         | Version probe plus packaged VS Code/Cursor launch     | PySpark 4.2.x                                |
| Local Spark Connect DataFrame viewing          | Live notebook only | Done         | Packaged VS Code/Cursor launch and page queries       | Local Connect only                           |
| Progressive projected grid pages               | Viewing only       | Done         | Bounded blocks, lookahead, boundary checks, exact end | Sequential traversal                         |
| Basic/advanced filters and multi-column sorts  | Viewing only       | Done         | Native expressions and packaged filtered/sorted pages | Unique final key needed for repeatable ties  |
| Summaries, statistics, and distinct values     | Viewing only       | Done         | Native fixed-size aggregates and conversion guards    | Header profiles start off                    |
| Session recovery and non-interrupting disposal | Viewing only       | Done         | Classic/Connect rebind, restart, reconnect, cleanup   | Running Spark jobs are not interrupted       |
| VS Code/Cursor packaged acceptance             | Both editors       | Done         | Released Jupyter, restart, and cleanup phases         | Exact candidate rerun remains a release gate |
| Cleaning operations and history                | No                 | Out of scope | Capabilities reject editing                           | No distributed transformation plan in v1.2   |
| Script/notebook/data export                    | No                 | Out of scope | Capabilities reject export                            | No Spark export contract in v1.2             |
| Saved-output MIME formatter                    | No                 | Out of scope | `notebookOutput` is not advertised                    | Live variables only                          |
| File sessions and automatic backend selection  | No                 | Out of scope | `file` is not advertised                              | Notebook variables only                      |
| External or authenticated clusters             | No                 | Out of scope | Local endpoints are the tested contract               | No authentication or provisioning in v1.2    |

## Recorded acceptance evidence

Real-user first-use gate for v1.1.2:

- The packaged `platform-smoke` fixture is a deterministic 10,000-row × 15-column UTF-8-BOM, semicolon-delimited orders file rather than a toy comma-delimited table. Primary open must infer its import options without showing delimiter, encoding, header, or quote prompts.
- The workbench journey uses the visible product controls for newest-first multi-column sorting, visible and reorderable priorities, per-key removal, typed column search, exact numeric Insights, filtering and **Clear all**, an Uppercase draft, discard, apply, cleaned-data export, close and reopen, plan replay, and undo. Duplicate sort columns and stale native reorder actions fail closed, while clearing a column or the full view also clears any matching uncommitted sort edits. It requires human operation titles, material diff wording, automatic reveal of the added column, native Polars code, complete exported rows, and byte-identical source data.
- The same installed-editor journey clicks the file session's engine badge, selects Pandas in the real **Dataframe engine** picker, and switches back to Polars. Both changes keep one public session and preserve the file identity, selected column, widths, viewport, import options, and source bytes.
- VS Code and Cursor run the journey in disposable, unfocused profiles. The high-contrast capture at approximately 200% zoom additionally measures the toolbar, toolbar actions, and grid controls against their containers and rejects clipped or overflowing direct controls. Its capture path converts the zoomed CSS viewport to the complete physical workbench instead of accepting a cropped left edge.
- The allowlisted 77-entry final local candidate built from product commit `5ea2270` is 704,210 bytes and has SHA-256 `f170970cc1bd0e62e73151efd6c80ff2ab4f0d08c9304d4a27c7d15f775eb953`. Those exact bytes passed the complete packaged acceptance, including the realistic first-use journey, in isolated VS Code 1.130.0 on zero-window headless Ozone and Cursor 3.13.21 on a private Xvfb display. The stable release workflow must rebuild from the reviewed merge commit and repeat the exact-artifact gate before publication.

Viewing slice, 2026-07-15:

- `npm test`: 9 TypeScript and 16 Python tests passed. The Polars file test asserts a lazy source and fails if `to_pandas()` is called.
- `npm run test:extension-host` passed against local VS Code 1.128.0, activating the extension, verifying commands/views/settings, and opening `fixtures/sample.csv` through the real custom-editor contribution.
- The allowlisted prerelease VSIX installed successfully into isolated VS Code 1.128.0 and Cursor 3.11.19 profiles.
- The in-app browser exercised the built webview at 800px: drawer open/close, advanced OR selection, value-free null predicates, settled progressive requests, keyboard cell navigation, and column search/focus restoration.
- The 1,000 by 40 wide harness retained 7 rendered data columns and 39 rendered rows while exposing the full 41-column/1,001-row accessible grid counts. It jumped to column 39 and fetched rows 201 to 400 without unbounding the DOM.
- Approved browser baselines are checked into `docs/images/acceptance/` for light, dark, high contrast, 800/1280/1920px widths, and 80/100/150/200% zoom. `docs/images/wide-grid.png` records the wide-grid fixture.

This evidence advances viewing rows to **Partial**, not **Done**. Full interactive Cursor acceptance, malformed/type-edge fixtures, automated accessibility scans, and performance gates are still mandatory.

Editing engine slice, 2026-07-15:

- `npm test`: 9 TypeScript and 27 Python tests passed. Eleven parameterized operation tests cover the complete 27-operation registry across Pandas and Polars.
- Representative multi-step plans compile to standalone engine-native code and execute to the same semantic output as the runtime adapters.
- Polars transformation tests replace `DataFrame.to_pandas()` with a hard failure. No operation or generated Polars plan crosses through Pandas.

This evidence advances the operation rows to **Partial**. Editor controls, exhaustive typed-edge fixtures, workspace-trust enforcement for custom code, and real-editor acceptance remain mandatory.

Editing session slice, 2026-07-15:

- `npm test`: 9 TypeScript and 34 Python tests passed. Both engines cover preview, typed page diff, apply, latest-step edit, discard, stale-revision rejection, undo replay, immutable source protection, and viewing-mode rejection.
- Protocol v2 now validates transform steps and carries applied steps, an optional draft, preview diffs, generated code, and plan mutation responses.
- The extension coordinator maintains distinct public/runtime revisions and replays applied steps, the active draft, and the viewing query after runtime replacement.

This evidence advances draft/history rows to **Partial**. Stable identities through structural operations, UI shortcuts, persisted-plan reload, failure-injected editor recovery, and real-editor acceptance remain mandatory.

Editing UI slice, 2026-07-15:

- `npm test`: 13 TypeScript and 36 Python tests passed. React tests verify all 26 catalog entries, validated form output, explicit conversion of viewing filters into a cleaning step, and structural-step editing against its original input schema.
- `npm run test:extension-host` passed against local VS Code 1.128.0 with the new operation/apply/discard/edit/undo commands registered and the real custom editor opened.
- The in-app browser verified the complete accessible operation dialog and editable generated-code textbox. Automated captures record the operation dialog, draft grid/diff/code layout, and VS Code-token CodeMirror highlighting in `docs/images/acceptance/`.
- Custom-code preview requests are rejected by the extension host when Workspace Trust is absent. CodeMirror is shipped as a dedicated bottom-panel bundle; Monaco is not included.

This evidence keeps editing rows **Partial**. Stable structural identities, packaged reload acceptance, exhaustive operation-edge UI tests, packaged VS Code/Cursor interaction, and keyboard shortcut coverage remain mandatory.

Persistence slice, 2026-07-15:

- `npm test`: 16 TypeScript and 36 Python tests passed. Persistence tests cover stable source/import keys, replayable-state round trips, and rejection of malformed or unknown saved operations.
- Applied steps, the optional draft, and the independent viewing query are stored in workspace state and replayed through the validated runtime protocol when a source is reopened.
- `npm run test:extension-host` remained green on VS Code 1.128.0 after enabling workspace-state restoration.

This advances reload replay but keeps the row **Partial** until a failure-injected packaged-editor test applies a plan, reloads VS Code and Cursor, and verifies the reconstructed grid and cleanup behavior.

Export slice, 2026-07-15:

- `npm test`: 16 TypeScript and 43 Python tests passed. Both engines export committed plans to CSV and Parquet; Polars export fails the test if `to_pandas()` is called.
- Runtime tests prove view-only filters do not enter exported data, pending drafts and source overwrite are rejected, successful writes replace an existing destination, and failed writes preserve it while removing temporary files.
- Protocol v2 carries revision-checked export requests and typed completion responses. VS Code commands copy the editable code buffer, save a Python script, and prompt for an explicit cleaned-data destination under Workspace Trust.

This advances export rows to **Partial**. Notebook insertion, command-dialog integration tests, dependency diagnostics for Pandas-to-Parquet export, and packaged VS Code/Cursor interaction remain mandatory.

By-example slice, 2026-07-15:

- `npm test`: 17 TypeScript and 57 Python tests passed. Candidate fixtures cover slicing, splitting, concatenation with literals, regex extraction/replacement, lower/upper/capitalize, datetime parse/format, constants, and column arithmetic.
- The synthesizer ranks by deterministic complexity and canonical program order, rejects inconsistent examples, revalidates persisted programs, and reports equally simple matches as draft warnings.
- Pandas and Polars execute and compile the same selected AST natively. Cross-engine tests cover string synthesis, datetime formatting, arithmetic, session preview/apply, and a hard Polars-to-Pandas prohibition.
- The operation builder validates example JSON before dispatch; protocol-normalized steps persist the selected program so reload does not reselect a different candidate.

This advances by-example to **Partial**. More compound programs, null/type-edge inference, editable example-row capture from the real grid, keyboard acceptance, and packaged editor testing remain mandatory.

Notebook MIME and insertion slice, 2026-07-15:

- `npm test`: 20 TypeScript and 62 Python tests passed. Pandas/Polars helpers emit complete MIME v2 snapshots and remain engine-native.
- Shared TypeScript normalization validates MIME v2 into a read-only current session shape and rejects malformed or unknown-version payloads. The renderer presents invalid output as an accessible error.
- Formatters are registered inside the active kernel only after trusted stable-API access. Live-variable sources retain their originating notebook URI.
- The insertion command uses the currently edited CodeMirror buffer and a tagged Python cell. The real VS Code extension-host suite applies and verifies the notebook edit against an untitled Jupyter notebook.

This advances notebook rows to **Partial**. Real local/remote kernel formatter display, permission denial, kernel restart, saved v2 output in packaged VS Code/Cursor, and originating-notebook interaction remain mandatory.

Interface documentation and navigation slice, 2026-07-15:

- `docs/reference.md` is generated from the package command/settings/MIME contributions, Python operation IR registry, and canonical protocol schema. `npm run reference:check` reproduces it in memory and fails on byte-level drift as part of every strict check and package build.
- The extension contributes a native Getting Started walkthrough plus Open Source File and Open Getting Started commands. The extension-host suite verifies all 21 public commands and the walkthrough contribution against a real VS Code host.
- `npm run check`, all 20 TypeScript and 62 Python tests, the VS Code 1.128 extension-host suite, production build, and 51-entry VSIX allowlist verification passed.

This closes public-interface documentation drift and command-surface gaps, but does not advance feature rows to **Done** without the remaining packaged cross-editor acceptance.

Identity and structural-diff slice, 2026-07-15:

- Both engines attach private session row identities and preserve them through filters, sorts, projections, row deletion, and value transformations. Group/custom results receive a new identity generation; no identity enters user schema, profiling, duplicate counts, custom-code input, generated code, or CSV/Parquet exports.
- Column lineage is independent of names and positions. Automated tests cover rename, reorder, deletion, latest-step replacement, group keys/aggregates, and duplicate Pandas labels with deterministic IDs.
- Page diffs now join rows and columns by identity, so a sort is no longer reported as changed cells and a rename is no longer reported as a remove/add pair. Group replacements report the old and new row sets explicitly.
- All 20 TypeScript and 69 Python tests pass, including native Pandas/Polars lineage fixtures and the hard Polars-to-Pandas prohibition. Pandas viewing additionally covers duplicate and non-string labels; the 52-entry production VSIX passes the package allowlist.

This advances structural diff and typed-edge evidence but keeps the rows **Partial** until identifier-based operation parameters, packaged editor interaction, and the remaining nested/type matrix are green. The later stable-ID structural-operation slice below closes the parameter gap for seven operations; it does not retroactively close the broader duplicate/non-string matrix.

Jupyter recovery slice, 2026-07-15:

- A real local IPykernel test bootstraps the bundled agent, registers automatic MIME v2 formatters, renders live Pandas and Polars dataframes, opens both engines through protocol v2, restarts the kernel, bootstraps again, and receives a valid response after restart.
- The extension kernel lifecycle caches and bootstraps once, performs at most one reacquire/bootstrap retry after execution failure, and never retries acquisition/permission denial or logical detachment. Configured deadlines bound host reporting and stale-ignore late output without cancelling Jupyter execution.
- All 25 TypeScript and 70 Python tests pass. The lifecycle suite covers success, restart, repeated failure, denial/cancellation, and timeout; the real-kernel test guarantees cleanup in `finally`, and the 53-entry production VSIX passes its allowlist.

This advances notebook recovery and formatter evidence but keeps the notebook rows **Partial** until remote kernels and packaged VS Code/Cursor permission, restart, saved-output, and originating-notebook interaction are recorded.

Packaged editor slice, 2026-07-15:

- The 53-entry allowlisted VSIX installed into fresh VS Code 1.128.0 and Cursor 3.11.19 user/extension directories. Tests ran from a separate harness extension, ensuring no TypeScript checkout or development extension shadowed the packaged extension.
- Both editors activated the package, verified its publisher/gallery and Activity Bar assets, all 21 commands, Getting Started walkthrough, and MIME v2 contribution. Each opened the CSV custom editor, completed a real Polars runtime session through the packaged Python source, reopened the exact source URI, and applied a real notebook cell edit.
- This stronger test exposed and fixed the custom-editor path failing to enable webview scripts; previous tab-only extension-host acceptance could not detect that the runtime session never opened. Open Source File now also waits briefly for an in-flight active session instead of blocking on a notification.
- Linux CI now installs and exercises the VSIX against current VS Code after allowlist verification. Local release acceptance auto-detects and repeats the package test in Cursor without touching normal profiles.

This advances cross-editor/package evidence but keeps UI rows **Partial** until the full operation/export/reload/theme interaction checklist and screenshots are recorded from both packaged editors.

Visual and accessibility hardening slice, 2026-07-15:

- `npm run test:webview-acceptance` renders the production editor, notebook renderer, and Code Preview bundles into 22 Playwright-readable harnesses. It compares actual screenshots against checked-in baselines with an anti-aliasing-tolerant 1% pixel-delta gate and never mutates baselines during verification.
- Automated axe runs cover WCAG 2.0, 2.1, and 2.2 A/AA rules across dark, light, high-contrast dark/light, 800/1280/1920px widths, 80/100/150/200% zoom, operation/draft/by-example states, and explicit empty/loading/error/recovery/Unicode fixtures. Every non-minor violation is a CI failure.
- Scan findings produced product fixes: column menus and resizers now remain 24px targets at 80% zoom, resizers support Arrow/Home/End keys, generated-code overflow is keyboard focusable, empty grids announce `No rows`, and status/error regions use live semantics. Light-theme type labels now meet contrast requirements.

This advances theme and accessibility evidence but keeps the row **Partial** until the same core theme/zoom checklist is recorded in packaged VS Code and Cursor.

Performance hardening slice, 2026-07-15:

- On the reference Linux workstation, `npm run benchmark:runtime` returned the first complete 100k×50 CSV grid in 309.326ms and the first 1M×20 Parquet grid in 2,189.545ms, below the 3s/5s release limits. The source and every block remained native lazy Polars.
- Cached runtime page p95 was 66.800ms for CSV and 72.630ms for Parquet; distributed uncached page p95 was 68.077ms and 73.578ms, below the 100ms/500ms gates. Every close left zero retained `SessionManager` entries.
- Playwright measured the production 1,000×40 virtual grid independently at 31.6ms cached-scroll p95 and 92.8ms uncached-block p95. A smoke fixture runs in the normal Python suite, while a scheduled strict workflow uploads full-size JSON reports.

This advances the virtual-grid and recovery rows but keeps them **Partial** until packaged-editor reload/multi-session disposal and the remaining editor checklist are recorded.

Data-format and typed-edge hardening slice, 2026-07-15:

- Parameterized Pandas/Polars acceptance opens quoted/delimited CSV, headerless CSV, TSV, JSONL, Parquet, modern `.xlsx`, and a real legacy BIFF `.xls` workbook by name or zero-based sheet index. Pandas also retains its Latin-1 fixture; Polars CSV, TSV, JSONL, and Parquet sources are asserted to remain lazy.
- Zero-byte, BOM-only, and whitespace-only CSV/TSV sources open engine-natively as explicit 0-row × 0-column datasets in Pandas, Polars, and DuckDB. Parameterized runtime tests retain byte/mtime identity, exercise paging and exact statistics, and prove a non-empty unterminated quoted field still fails in each native reader.
- Primary file, editor-title, and custom-editor launches never prompt for delimited import fields. A pure 64 KiB detector covers misleading `.csv` suffixes, UTF-8 BOM and Windows-1252 input, comma/tab/semicolon/pipe structure, standard and single quotes, apostrophe-heavy values, numeric headerless input, and quoted delimiters/newlines. Native launch acceptance fails if an initial Quick Input appears; **Change Import Options** retains the explicit override workflow.
- Nested Polars Parquet coverage now includes unsigned 64-bit integers, decimal, time-zone datetime, list, struct, binary, categorical, duration, null, NaN, infinity, and a 20,000-character Unicode value while making `to_pandas()` fail. Container dtypes are classified by their outer type, and nested profiling remains available.
- NumPy/Pandas scalar tests prove large integers, nullable integers/booleans, `pd.NA`, `pd.NaT`, timezone timestamps, NaN, and infinity produce typed, strict-JSON-safe cells. Pandas frames with rows but zero visible columns and fully empty Polars frames remain schema-, summary-, and page-safe.
- Missing and malformed file opens now produce structured engine diagnostics for eager and lazy readers without retaining a session. Polars Excel correctly translates the public zero-based sheet index to the reader's one-based ID. The runtime and extension agree on format-specific parsers: Pandas `.xlsx` uses `openpyxl>=3.1.5`, Pandas `.xls` uses `xlrd>=2.0.1`, and Polars uses `fastexcel>=0.9` for both.
- Invalid UTF-8 replacement decoding is deterministic: `utf8-lossy` routes automatic sessions directly to Pandas, maps to UTF-8 with replacement error handling, and never probes Polars/DuckDB or reaches Python as a codec literal.

This completes automated format and source-type edge evidence but keeps entry-point and summary rows **Partial** until the packaged-editor fixture checklist and interactive import/error states are recorded in VS Code and Cursor.

Operation-edge hardening slice, 2026-07-15:

- Pandas and Polars runtime results and executable generated functions agree on stable multi-sort with independent null placement per column, `dropMissingRows` any/all semantics, `dropDuplicates` last/none modes, and finite-only min-max scaling. Round, floor, and ceiling preserve infinities without Pandas overflow.
- One-hot encoding ignores null categories in both engines. Multi-label encoding ignores null/blank labels and emits no empty-name column. Both operations reject existing/generated output-name collisions before returning a dataframe; Polars remains native throughout.
- Grouping preserves source encounter order. Polars nullable `nUnique`, `first`, and `last` now match Pandas, while duplicate aliases or aliases replacing a group key fail IR validation.
- Unicode casing uses one deterministic mapping across engines (`ß`, dotted `İ`, accents), nulls are preserved, and engine exceptions from custom code become structured diagnostics. Expanded IR validation rejects malformed sort/filter, categorical, text, numeric, datetime, and boolean parameters before execution.

This completes the listed automated operation-edge evidence but keeps operation rows **Partial** until identifier-based duplicate-column parameters and the packaged VS Code/Cursor operation checklist are green.

Packaged reload and recovery slice, 2026-07-15:

- The installed 53-entry VSIX passed a two-process seed/verify acceptance in isolated VS Code 1.128.0 and Cursor 3.11.19 profiles. The seed process applied a real Polars formula step, committed an independent descending viewing sort, closed the session, verified the Python runtime stopped, and reopened the source once before process exit.
- A fresh editor process reopened the same URI from workspace state and verified the step, sort, transformed schema, first row, and generated value. It then opened a concurrent Pandas TSV session, switched active-session ownership, injected a standalone runtime restart, and fetched both sessions concurrently.
- Recovery started exactly one replacement Python process, assigned both sessions new runtime IDs, replayed the Polars plan/view and Pandas source, and preserved both public session identities. A real CSV export matched the committed plan while the original fixture remained byte-for-byte unchanged.
- Both sessions were explicitly closed; acceptance waited for zero coordinator sessions and a stopped runtime. Runtime startup is single-flight across concurrent requests, stale starts are invalidated by a restart epoch, and the final session releases the standalone process.
- The extension-host acceptance also performs the seed/verify split with shared isolated VS Code state. Test controls are returned by activation only when `OPEN_WRANGLER_EXTENSION_TESTS=1`; production activation exposes no recovery or diagnostics surface.

This makes runtime crash/reload/session replay **Done**. Cleaning-history, export, and editor rows remain **Partial** because their remaining keyboard, Parquet-command, and full interactive operation/theme checklists are tracked separately.

Release-guardrail slice, 2026-07-15:

- Required CI coverage now enforces TypeScript/webview floors of 60% statements, 55% branches, 60% functions, and 65% lines plus a 78% Python-runtime floor. The initial accepted reports are 63.36/59.28/66.12/67.94% and 80.37%, respectively, and CI uploads their HTML/JSON/XML artifacts.
- A production dependency policy resolves the actual installed manifest for every non-development package, accepts only explicitly approved licenses, and requires a matching notice group. The current webview bundle contains 17 MIT packages and one CC-BY-4.0 Codicons package; the notice file now reflects Codicons' actual license.
- Pull-request validation retains npm and Python vulnerability audits. Every ready substantive pull request and exact release candidate packages and verifies on Linux/Python 3.10, macOS/Python 3.12, and Windows/Python 3.14; the release artifact cannot advance until that matrix passes. Protected-branch pushes run only `Fast feedback`. Stable publication must promote the already accepted artifact without rebuilding it.
- Screenshot capture now resolves the hosted CI interpreter before a local `.venv`, fixing the first full validate run's only failure while keeping local deterministic-environment preference.

These are release guardrails rather than user-visible parity rows. They remain mandatory for every subsequent slice and release tag.

Cleaning-history keyboard slice, 2026-07-15:

- Editing sessions expose state-scoped shortcuts for apply (`Ctrl/Cmd+Enter`), discard (`Escape`), edit latest (`Ctrl/Cmd+Shift+E`), and undo latest (`Ctrl/Cmd+Alt+Z`). VS Code context keys enable them only for an active Open Wrangler custom editor with the matching draft/history state.
- The production webview handles the same keys when focus remains inside its sandbox. It does not steal undo/edit shortcuts from inputs, textareas, selects, or editable code; buttons publish `aria-keyshortcuts` and visible hover titles.
- React interaction tests cover all four actions and editable-field isolation. Playwright loads the production draft bundle, triggers every shortcut by keyboard, validates the emitted protocol request, opens the latest-step editor, and closes it with Escape while the normal 22-harness axe/pixel/performance matrix remains green.
- The generated public reference includes the keybinding table. Real extension-host and installed-VSIX acceptance verify the exact VS Code/Cursor keybinding contributions, stateful history replay, and final cleanup.

This makes cleaning-step history/edit/discard/undo **Done**. The wider editing-mode row remains **Partial** until its complete packaged operation interaction checklist is green.

Packaged file and data-export slice, 2026-07-15:

- The installed VSIX custom editor now opens CSV, TSV, JSONL, Parquet, and XLSX in both isolated VS Code 1.128.0 and Cursor 3.11.19 runs. Acceptance pins TSV to Pandas and JSONL/Parquet/Excel to Polars, verifies exact shapes/backends through the active coordinator, closes every editor, and waits for zero sessions and a stopped runtime before continuing.
- The packaged test environment creates Parquet and a named Excel sheet through independent libraries, so those readers exercise real typed files rather than renamed or mocked payloads. The runtime suite separately covers both engines, CSV delimiter/quote/header/encoding variants, Excel name and zero-based index selection, malformed/missing inputs, lazy Polars formats, and typed edge data.
- After an injected runtime restart, both the transformed Polars session and concurrent Pandas session export CSV and Parquet. Acceptance verifies response shapes, CSV schemas, Parquet `PAR1` framing, and byte-identical CSV/TSV source fixtures. Unit/runtime coverage continues to enforce view-filter exclusion, draft/source-path rejection, atomic replacement, failure cleanup, and no Polars-to-Pandas conversion.
- The same expanded matrix passes development-host, installed-VSIX, reload/replay, and cleanup paths; temporary generated inputs and outputs are removed from isolated test directories.

This makes the recorded packaged readers and CSV/Parquet data export **Done**. The broader entry-point row remains **Partial** for packaged `.xls` and malformed-input UI evidence; code/notebook export is tracked separately.

Packaged operation-group slice, 2026-07-15:

- The extension-host and installed-VSIX suites open independent Pandas and Polars editing sessions and run representative row/order, column/formula, text, numeric, by-example, custom-code, and group/aggregation steps. Every step must complete draft preview, typed page diff, engine-native generated-code inspection, and explicit apply before the next step begins.
- The complete 27-operation registry remains covered by parameterized native-runtime and executable generated-code tests for both engines. Operation-edge fixtures add null/NaN, stable sort, duplicate keep modes, categorical collisions, Unicode, non-finite numbers, nullable aggregation, invalid parameters, and structured custom-code failures; Polars fails immediately on any `to_pandas()` path.
- The packaged by-example draft resolves and persists a deterministic uppercase program before confirmation. The broader automated candidate matrix covers slicing, splitting, concatenation, literals, regex extraction/replacement, casing, datetime parsing/formatting, and simple arithmetic, including ambiguity and failure diagnostics.
- Both engine sessions force a standalone runtime restart immediately after applying custom code, then fetch the replayed plan before grouping. The final schema and seven-step history are asserted, source CSV bytes remain unchanged, and close waits for zero coordinator sessions and no Python process.
- This matrix passes the development host plus the exact allowlisted VSIX in isolated VS Code 1.128.0 and Cursor 3.11.19 profiles. The production-bundle browser suite separately exercises the complete operation dialog, validated forms, draft/diff/code layout, by-example warnings, and apply/discard/edit/undo keyboard paths.

This completes the ordinary-schema packaged operation-family checklist and keeps draft/diff and by-example **Done**. The broader editing catalog remains **Partial** for duplicate/non-string column addressing, and custom code remains **Partial** for installed Restricted Mode evidence. Generated-code editing/export was still a separate **Partial** row at this checkpoint until the later clipboard/script/originating-notebook command matrix.

Packaged viewing-query slice, 2026-07-15:

- Independent Pandas and Polars viewing sessions run an advanced OR predicate across string and numeric columns followed by a two-column sort. The installed VSIX must return the same two typed rows in the same order, retain the exact view model, and keep the cleaning plan empty.
- Both engines resolve filtered column summaries, numeric profile bounds, exact missing/duplicate dataset counts, and searched distinct values through protocol v2. The source remains byte-identical and every session close waits for the standalone runtime to stop.
- The same matrix passes the development extension host and the exact package in isolated VS Code 1.128.0 and Cursor 3.11.19. Native engine fixtures separately cover AND/OR, null/NaN predicates, value filters, per-column null ordering, stable ties, typed/nested summaries, and lazy Polars query pushdown.
- The production-bundle Playwright gate covers row and column virtualization, bounded prefetch, column search, keyboard navigation/resizing, focus restoration, advanced-filter interaction, responsive layouts, all supported themes/zooms, and WCAG scans. Its wide-grid p95 is 31.6ms cached and 92.8ms uncached, below the 100ms/500ms limits; release-size runtime gates are also green.

This makes the production-bundle grid interaction, summaries/Quick Insights, viewing filters, and multi-column viewing sorts **Done** at the browser boundary. The combined virtual-grid row remains **Partial** until the installed editor reaches a measured first usable grid; import error-state interaction and editor chrome/theme sign-off remain tracked under their separate rows.

Editable code and runtime-selection slice, 2026-07-15:

- After every packaged Pandas and Polars representative plan, acceptance replaces the Code Preview buffer with an identifiable edit, invokes the real Copy Code command, reads the editor clipboard, invokes **Export Generated Script** with an isolated destination, and verifies both outputs byte-for-byte. The production CodeMirror bundle separately covers editing, syntax highlighting, overflow/focus behavior, and VS Code tokens under the visual/axe matrix.
- Successful copy/export notifications no longer block command completion while awaiting toast dismissal; clipboard and file writes remain awaited. The generated function before editing is still executed against both engines and compared with the native adapter result, with Polars conversion prohibited.
- Runtime acceptance invokes Change Runtime with an executable wrapper around the same supported interpreter but isolated from site packages. A Polars open returns the structured `missing_dependencies` diagnostic before process startup, points to the explicit install command, and retains no session.
- The Install Runtime Dependencies command receives an explicit decline and returns without running pip, changing configuration, or starting a process. Clear Runtime removes the workspace override and reveals the configured fallback. Resolver tests cover relative/absolute paths, the exact Python 3.10 to 3.14 range, and engine/format-specific modules; normal resolution still prefers explicit configuration, then the Python extension, then system interpreters.
- These command paths pass the development host and the rebuilt allowlisted VSIX in isolated VS Code 1.128.0 and Cursor 3.11.19. All temporary scripts and exported code are removed with the editor profile.

This makes generated-code preview/editing and runtime selection/setup/change/clear **Done**. The combined code-export row remains **Partial** only for its originating-notebook command path.

Packaged notebook and remote-kernel slice, 2026-07-15:

- Kernel bootstrap no longer inserts the local extension path. The extension validates and encodes only the packaged `openwrangler_runtime` sources, transfers them over `executeCode`, writes them beneath a content-addressed kernel-temporary directory, and imports the agent there. Unit tests reject incomplete/path-unsafe bundles and prove generated bootstrap code contains no local extension path.
- A stable-Jupyter-API acceptance extension runs a persistent Python namespace with an explicitly empty `PYTHONPATH`, creating a remote-filesystem boundary while retaining real Pandas and Polars dependencies. The installed Open Wrangler package transfers its own runtime, opens live variables for both engines, resolves typed pages, and never converts Polars to Pandas.
- A real local IPykernel test independently registers automatic Pandas/Polars MIME v2 formatters, renders both types, transports protocol v2 sessions, restarts the kernel, and bootstraps again. Lifecycle tests cover permission/acquisition denial, host-only detachment, reporting-only deadlines, one-shot reacquisition, and repeated failure.
- The packaged VS Code 1.128.0 and Cursor 3.11.19 flows open a real `.ipynb` containing saved MIME v2 output, verify that item survives deserialization, apply a Pandas notebook step, and invoke Insert Generated Code. The inserted tagged cell contains the edited CodeMirror buffer exactly and targets the originating notebook.
- The acceptance kernel object is then replaced while a Polars variable session is active. The first request rejects on the stale object, the stable API is reacquired, the transferred runtime is bootstrapped again, the unknown session is replayed from the still-live variable, and the original public session returns the expected page. A separate denied-access attempt creates no coordinator session.
- The production renderer/axe harness renders MIME v2 and clicks **Open in Open Wrangler**, asserting the full-view message contains the validated payload. Malformed versions remain accessible errors. This entire matrix runs from the allowlisted VSIX in isolated editor profiles.

At this checkpoint, the packaged stable-API acceptance-double and saved-snapshot flows plus clipboard/script/originating-notebook code export were complete. The notebook-variable row remained **Partial** pending the released Jupyter extension, while the coordinator-owned saved-output slice recorded below subsequently closed the separate inline full-view gap.

Open Wrangler rename and packaged-editor visual acceptance refresh, 2026-07-16:

- The renamed `matt17br.openwrangler@0.2.0-alpha.2` VSIX contains 55 allowlisted entries and has SHA-256 `24095102798b47b2ed5017fd8e143caf4d0baa3817b85cc70121221c34d501b9`. It is installed into disposable VS Code 1.128.1 and Cursor 3.11.19 profiles. Playwright connects to each isolated Electron workbench, opens the packaged custom editor and Open Wrangler Activity Bar container, and captures the real workbench below the native test-host title strip rather than reconstructing it in a browser shell.
- Both editors record dark and light themes at normal zoom plus a high-contrast theme at VS Code zoom level 4 (approximately 200%). The harness temporarily disables OS theme auto-detection, waits for the public active-theme kind to change, captures the workbench, and restores every setting. Cursor's isolated first-run login overlay is bypassed with its documented `--skip-onboarding` test-process flag; no normal editor profile is read or changed.
- At that checkpoint, six checked-in captures under `docs/images/editor-acceptance/` showed the then-current Activity Bar mark, native Operations, Summary, Filters/Sorts, and Cleaning Steps views, the custom grid, and the Code Preview panel. Later release evidence replaces those image files in place. Extension-host assertions independently verify that the current 128/256px gallery PNG and monochrome `currentColor` SVG are present in the installed package.
- The production-bundle matrix remains the exhaustive UI gate: 22 Playwright/axe harnesses cover dark, light, high-contrast dark/light, 800/1280/1920px widths, 80% to 200% zoom, interaction/state fixtures, keyboard paths, and WCAG 2.0/2.1/2.2 A/AA rules. The editor screenshots prove those token-driven surfaces integrate into both real workbench chromes.

- The packaged runtime-selection path exercises the canonical `openWrangler.pythonPath` setting, dependency diagnostics, explicit install decline, override clearing, and resolver fallback without mutating an environment.

This completed the then-recorded package/theme checklist. The matrix at the top is authoritative: the later 1.0 audit reopened incomplete behavior and evidence instead of preserving a stale all-green claim.

Final release-gate correction slice, 2026-07-15:

- Focused snapshot-model and filter/summary interaction tests hold TypeScript/webview coverage at 69.55% statements, 67.53% branches, 71.90% functions, and 72.57% lines; Python remains at 80.33%. The canonical-only suite contains 51 TypeScript and 112 Python tests.
- Those tests exposed and fixed saved-notebook snapshot semantics: null numeric cells no longer compare as zero, and multi-column sorts honor the requested null placement independently of ascending/descending direction.
- Visual and axe acceptance now use the Chromium revision pinned by `playwright-core` and the lockfile. CI installs that exact browser instead of inheriting a moving system Chrome, retaining the 1% visual threshold while eliminating browser-version drift.
- The rebuilt allowlisted VSIX passed the complete installed-package suite and real theme captures in VS Code 1.128.1 and Cursor 3.11.19 after these corrections.

Session-owned engine foundation, 2026-07-16:

- The ordered engine registry now creates a fresh Pandas or Polars adapter for every session, closes rejected detection candidates, validates factory/backend identity, and exposes immutable source/edit/lazy/export/interruption capabilities. Wire capabilities remain unchanged for all existing file, viewing, editing, and notebook-variable cases.
- Open responses are fully constructed before registration. Injected reader, schema, initial-page, initial-summary, and metadata failures each close the acquired adapter and leave the session map empty. Explicit close serializes behind in-flight work; concurrent shutdown joins pending opens and disposes every registered session; notebook snapshots enforce source capabilities and distinguish cleanup failure from an earlier rendering failure.
- Extension-host close failures are terminal and never replayed. Deactivation awaits bounded standalone and live-kernel cleanup, rejects work queued after close, closes late runtime opens without registering them, and lets the standalone server drain through stdin/EOF before force-kill fallback.
- `npm run check`, `npm test`, and `npm run test:coverage` pass with 58 TypeScript and 141 Python tests; Python runtime coverage rises to 82.69%. Focused registry, lifecycle, coordinator, process-shutdown, notebook, and server tests cover fresh ownership, diagnostic cleanup, capability gating, concurrent open/shutdown, late opens, transport failure, failed initialization, and unsupported backends.
- The strict runtime benchmark remains within every release ceiling: the 100k × 50 CSV reaches its first grid in 386.969 ms with 99.745 ms cached and 85.225 ms uncached page p95; the 1M × 20 Parquet reaches its first grid in 2,413.689 ms with 75.449 ms cached and 78.477 ms uncached page p95. Both retain zero sessions after close.
- The final 57-entry allowlisted VSIX has SHA-256 `4ac2368972e0f537c5611a59fb81918a177799086d621f6597782a184c9d064b` and passes the complete two-process packaged acceptance in isolated VS Code 1.128.1 and Cursor 3.11.19 profiles.

This strengthens the runtime crash/reload/session replay row without changing protocol v2 or the existing Pandas/Polars feature surface.

Progressive-grid, cache, and response-integrity slice, 2026-07-16:

- File-backed Polars open now returns exact shape, metadata-only schema, and the first typed block without an all-column null scan, eager summaries, or dataset statistics. Visible summaries stream one column at a time; exact dataset counts wait for the insights drawer. Numeric charts sample at most 4,096 deterministic valid values per column while null/NaN, distinct, top-value, and scalar metrics remain exact native aggregations.
- Every page, summary, values query, error, cancellation, and statistics response retains its request correlation. A separate opaque logical-view context protects the React model, retained panel snapshot, Activity Bar metadata, and persistence through A→B→A filters, rapid scrolling, runtime replay, and late background responses. Foreground page/mutation errors cannot be cleared or replaced by unrelated profiling work, and failed blocks expose an explicit same-block retry.
- One read-only page or values query can run beside an immutable background profiling lease. Transformations, exports, and close remain exclusive; waiting writers prevent new profiles from starving them. Queued obsolete profiles are cancelled without claiming to interrupt active Pandas/Polars work, superseded pages are rejected before persistence, replay rejects the former runtime generation and retires its old session, and grace-bounded kernel shutdown keeps a delayed close alive until active work settles.
- Runtime transformations and React foreground transitions now publish transactionally and restore their complete confirmed snapshot after late failures or cancellation. Grid and drawer summary owners release independently on hide, horizontal virtualization, and unmount; queued work is cancelled only after the last owner releases it. Stable schema IDs preserve filter selection through renames, empty-schema actions remain guarded, and scroll-driven page requests preserve roving keyboard focus.
- Both transports now apply strict nested protocol-v2 response validation, and the coordinator additionally requires the response kind, plan action, runtime ID, revision, column/export destination, and logical-view correlation expected by the request. Standalone cancellation waits for an authoritative original response. Jupyter acquisition/bootstrap are single-flight and generation-safe under one end-to-end deadline; only idempotent reads may retry after dispatch. Ambiguous mutations are never reissued, and later work first reconstructs the last confirmed runtime session. Cancelled, mismatched, failed, late-open, candidate, and retired-session cleanup use one bounded diagnostic path without restarting a live shared process on detached-cleanup timeout.
- Lazy-file sessions fingerprint the resolved source identity, size, and nanosecond modification time around every data read. Replacements, truncation, deletion, and schema changes clear the session-local 8-entry/16 MiB block cache and return a recoverable reopen diagnostic; view, draft, plan, and disposal changes also invalidate the cache. Pandas and Polars now expose the same disjoint null/NaN count contract, and alternating null/value data retains a non-empty deterministic histogram.
- Terminal close accepts the caller's last confirmed revision so an ambiguous mutation response cannot strand a newer live runtime session. Live and executable generated Pandas/Polars filters now match saved-output typed null/NaN predicates and value selections exactly, Polars distinct values omit those separately represented sentinels, and Pandas custom code receives recursively isolated object cells so nested source values remain immutable through preview and discard.
- The canonical stdio benchmark now measures real protocol-v2 newline-delimited JSON round trips separately from direct-manager cache timings and proves substantial page/profile overlap against an uncontented cache-miss baseline. On the reference Linux workstation, CSV cold-source first grid/warm reopen is 86.661/46.555ms, direct cached/cache-miss p95 is 0.100/31.625ms, stdio cache-miss p95 is 41.399ms, and the active-profile page is 42.584ms. Parquet is 59.695/43.600ms, 0.103/42.496ms, 46.386ms, and 56.941ms respectively. Both cold-source opens carry accepted per-file eviction evidence; both active-profile intervals were proven from runtime entry/exit events, returned the page before statistics, remained lazy, met every release and slice target, bounded cache weight, and retained zero sessions.
- `npm run check`, 208 TypeScript tests, 227 Python tests, extension-host/reload acceptance, the full strict benchmark, 22 visual/axe harnesses, and wide-grid cached/uncached p95 of 31.5/95.9ms are green. TypeScript coverage is 74.85% statements, 71.57% branches, 82.24% functions, and 77.90% lines; Python runtime coverage is 88.82%.
- The final 60-entry allowlisted `openwrangler.vsix` has SHA-256 `b93a06a9b024e764247c0619c7c5c22b5906bdef4f6a31a6e176dcdd31fe0d67`. That exact artifact passed the complete two-process installed-package matrix in disposable VS Code 1.128.1 and Cursor 3.11.19 profiles, including persisted-plan replay, concurrent Pandas/Polars crash recovery, viewing and editing operation groups, code/data/notebook exports, runtime selection diagnostics, icons/native contributions, source safety, and zero retained sessions/processes. The checked-in real workbench dark/light captures were refreshed from those isolated profiles.

This hardens the already-complete viewing, Quick Insights, recovery, and lifecycle rows without broadening the 1.0 engine or operation scope.

Native DuckDB file-backed preview slice, 2026-07-16:

- `.venv/bin/python -m pytest -q python/tests/test_duckdb_engine.py` passed all 5 engine-specific tests. These cover hardened/lazy CSV, TSV, Parquet, and JSONL reads; typed pages; filters/sorts; exact profiles and values; concurrent page/profile reads; native exports and cleanup; all 28 operations; executable generated-code equality; collisions and custom-code failures; and a file-session preview/apply/profile/export/close flow.
- `.venv/bin/python -m pytest -q python/tests/test_duckdb_engine.py python/tests/test_engine_registry.py python/tests/test_engine_lifecycle.py python/tests/test_typed_cells.py python/tests/test_performance_backends.py` passed all 41 focused engine, registry, lifecycle, typed-cell, and benchmark integration tests.
- `.venv/bin/python -m pytest -q python/tests` passed all 236 Python tests in 11.59 seconds after DuckDB registration. Conversion guards fail any DuckDB relation path that calls the Pandas, Polars, or Arrow conversion APIs.
- The opt-in benchmark smoke records the selected backend, package/runtime/machine/source provenance, native and lazy frame types, driver and standalone-process resource samples, direct `SessionManager` calls, and real protocol-v2 stdio boundaries. It explicitly labels those measurements as runtime rather than VS Code, Cursor, webview, or editor first-paint timings.
- Performance strict mode remains defined only for the native Polars path. Pandas and DuckDB reports are diagnostic comparisons, and a non-Polars `--strict` invocation is rejected rather than presented as release-gate evidence.
- `npm run test:extension-host` passes with backend-keyed persisted state for the same CSV: Polars replays its two-times formula and DuckDB independently replays its three-times formula across fresh editor processes. A later injected standalone-runtime restart concurrently reconstructs those two sessions plus Pandas with new internal IDs and one shared process generation.
- The packaged file matrix opens DuckDB CSV, TSV, JSONL, and Parquet sessions through the contributed custom editor. Independent DuckDB viewing acceptance runs typed paging, an advanced OR predicate, multi-column sorting, progressive summaries, exact dataset statistics, and searched distinct values while keeping the cleaning plan empty.
- The packaged editing matrix runs representative row/order, formula, text, numeric, by-example, custom-code, and aggregation steps through preview, typed diff, native generated-code inspection, apply, custom-code crash replay, editable Code Preview copy/script export, and final cleanup. Generated code is rejected if it references Pandas, Polars, PyArrow, or relation conversion APIs.
- DuckDB CSV and Parquet exports succeed after concurrent runtime recovery, preserve the source bytes, exclude private row identity, and leave zero sessions/processes. A dependency-isolated interpreter reports the exact tested requirement `duckdb>=1.5.4,<1.6` before runtime startup, and declining installation performs no mutation.
- The 22 production-bundle pixel baselines and all axe scenarios pass unchanged. TypeScript/webview coverage is 74.43% statements, 71.30% branches, 81.51% functions, and 77.61% lines; Python runtime coverage is 87.53%, including 81% statement coverage in the DuckDB adapter.
- The reproducible DuckDB 1.5.4 smoke on Python 3.14.4 retains native lazy relations and zero sessions. CSV cold stdio open/warm reopen is 43.858/29.966ms, direct cached/cache-miss p95 is 0.058/11.180ms, and stdio cache-miss p95 is 13.284ms. Parquet is 35.960/22.137ms, 0.061/10.082ms, and 12.266ms respectively. These small diagnostic fixtures are not editor-paint or release-limit claims.
- The exact 61-entry allowlisted `openwrangler.vsix` has SHA-256 `bfb9222e8a92cb56722938e09414eaa8491e944645a90c1368723898a92716ca`. Its expanded two-process matrix passes in disposable VS Code 1.128.1 and Cursor 3.11.19 profiles, with six real-workbench captures, source-safe exports, backend-specific persistence, injected recovery, and final cleanup. `npm audit` and `pip-audit` report no known vulnerabilities.

This establishes a tested native DuckDB file preview, not full DuckDB parity. The DuckDB-specific semantic edge matrix, large mixed/nested data, repeated full-size measurements, and CI across Linux/macOS/Windows remain pending. Excel, notebook variables/MIME, and `.duckdb` database browsing remain explicitly deferred.

Applied-step inspection slice, 2026-07-16:

- Every applied Cleaning Steps node now selects its stable step ID; Original Data and Escape return to the exact confirmed dataframe view, while latest-step editing remains a separate inline/context action.
- The coordinator validates inspection kind, revision, stable ID, step index, and both page boundaries, treats the read as idempotently recoverable, publishes only the newest bounded inspection, and clears it before mutations, recovery, disposal, or active-session changes. Inspection pages are never persisted as grid view state.
- The editor pages through the selected step's input/output boundary with filters, sorts, and profiling explicitly paused. Changed cells and added/removed columns are theme-highlighted with accessible before/after descriptions. Code Preview, copy, and script export use selected prefix code until inspection is cleared.
- Focused runtime, coordinator, panel-decoder, React, and DataGrid tests cover all three engines, no Polars conversion, paging, strict mismatch rejection, supersession, local errors, mutation clearing, keyboard clear, confirmed-view restoration, transport-failure replay/retry, and diff accessibility.
- Extension-host and installed-VSIX acceptance drive `openWrangler.selectStep` through the real custom editor, assert the selected input/output schema, added-column diff, prefix code, and unchanged revision, then select Original Data and verify exact restoration of filter/sort state, widths, selected column, vertical/horizontal viewport, metadata, and full-plan code.

This makes cleaning-step history/edit/discard/undo **Done**. At this checkpoint, broader duplicate/non-string operation acceptance, released-Jupyter integration, Restricted Mode, column-projected transport, installed-editor first-grid timing, and cross-platform packaged UI evidence remained incomplete; the later projection slice below closes only the column-transport item.

Stable-ID structural-operation slice, 2026-07-16:

- `selectColumns`, `dropColumns`, `renameColumn`, `cloneColumn`, `castColumn`, `formula`, and `textLength` now require public `{id, name}` references. Legacy strings, name-only or ID-only objects, extra fields, unknown/stale IDs, ID/name mismatches, duplicate list selections, and duplicate input-lineage IDs fail closed; there is no name-based compatibility fallback. Formula operands may intentionally reference the same column.
- The runtime binds each accepted reference against the exact step-input schema and lineage to a private `{id, name, position}` value before any adapter runs. Public plan/draft metadata and persisted replay state remain position-free. The parallel bound plan and bound draft drive preview, code generation, apply, latest-step replacement, undo replay, and applied-step inspection, and both participate in transactional rollback. Replacement retains the applied step ID, derives new-output IDs deterministically from that ID and the current output order, and rejects duplicate identities before publication, so dynamic and cross-kind edits replay with the exact published identities.
- Pandas runtime execution and executable generated code use visible-column positions, so one of two equal labels can be selected, dropped, renamed, cloned, cast, used in a formula, or measured without silently targeting its neighbor. Select/drop/rename lineage follows the exact referenced IDs through duplicate labels. The tuple-form row sentinel used under Pandas MultiIndex columns remains hidden from shape, schema, paging, and export. Polars and DuckDB consume already-verified bound names while remaining engine-native; DuckDB rejects case-fold-equivalent schemas instead of silently targeting the wrong identifier.
- Every operation now rejects an explicit input/output column in the private row-identity namespace case-insensitively before adapter dispatch, including legacy string-based transforms and aggregation aliases, while source, custom-code, and dynamically generated outputs keep a second schema guard. Every transformed result must leave at least one visible column so runtime, generated-code, and export row counts cannot diverge on engines that cannot represent a positive-height zero-column frame; supported immutable zero-column sources remain viewable.
- The production browser harness now includes an operation dialog with equal labels, a stringified non-string label, and an empty label. Every stable-reference option includes its ordinal, making even formatter-like literal names unambiguous, and Select Columns preserves and displays interaction order. Vite emits the Codicon font through a bundle-relative URL, the CSP permits that exact origin, and refreshed screenshots prove the actual icon glyphs render instead of blank placeholders.
- The focused binder, lineage, session, and transaction suites run across Pandas, Polars, and DuckDB and cover preview, public/private separation, apply, replay, inspection, dynamic/cross-kind latest-step edit, undo, pre-dispatch stale/collision/case-folded private-namespace rejection, all-transform zero-column rejection, DuckDB case-fold ambiguity, Pandas MultiIndex identity and safe structural append, exact edited-output replay, one-draft enforcement, and late-failure rollback. React/native-view regressions keep draft diffs on the correct committed or replacement input schema, disable every add/edit path until apply/discard, and open the generic picker for a no-argument Add Cleaning Step command.
- Runtime/kernel response validation rejects empty or duplicate stable column IDs and duplicate, reordered, or gapped positions independently across active, latest-step-input, and applied-step inspection schemas before they can enter coordinator or webview state.
- All 27 TypeScript suites (283 tests) and 378 Python tests pass; coverage is 73.45% TypeScript statements/70.96% branches and 88.31% Python statements. The 24 production webview harnesses remain axe-clean, the strict 100k × 50 CSV and 1M × 20 Parquet Polars gates pass, and extension-host reload acceptance is green. The exact 63-entry allowlisted `openwrangler.vsix` has SHA-256 `7b7fb9011d9bb762993af26ca0ba6973c307d12915ca7345b75508fd60c178d1`; that artifact passed isolated VS Code 1.128.1 and Cursor 3.11.19 packaged acceptance and was force-installed as `matt17br.openwrangler@0.3.0` in both local editors with no retired extension identity present.
- The matrix rows remain **Partial**. The evidence closes the stable-reference foundation for these seven operations, not every operation that accepts a column, and does not yet provide the complete duplicate/non-string type matrix or installed VS Code/Cursor interaction for those datasets.

Editor file-launch slice, 2026-07-16:

- One canonical `openWrangler.openFile` command now appears as **Open in Open Wrangler** in the Explorer context menu, editor-tab context menu, editor-title toolbar, and Command Palette for CSV, TSV, Parquet, JSONL, XLSX, and XLS resources. The case-insensitive predicates accept local and VS Code remote files and keep the compact toolbar action out of the Open Wrangler custom editor itself. The file and notebook actions use explicit light/dark 16-pixel vectors derived from the project's original jeep geometry, while the Activity Bar retains its `currentColor` vector so every native surface remains legible without a built-in or copied asset. Because Cursor 3.11 hides third-party title actions by default, the manifest contributes the command to Cursor's pinned-title-action default; explicit user configuration remains authoritative and no activation code mutates editor settings.
- The handler prefers the resource URI supplied by VS Code menus, then resolves active text, third-party custom, or modified diff tabs. Direct targets and native-picker results share the same validation. Untitled and unsupported schemes/formats, disabled formats, directories, special filesystem nodes, missing/inaccessible resources, and cancelled import configuration all stop before a panel or Python runtime is created. The exact persisted `vscode-remote` URI, including its authority, reaches resource-scoped Python settings and Python-extension environment resolution instead of being reconstructed as `file://`; malformed legacy metadata alone falls back to its concrete path. A generated Parquet file additionally runs through the installed command and remains byte-identical.
- The isolated editor harness connects to the actual Electron workbench, opens a JSONL source as text, clicks the visible editor-title icon, reselects and right-clicks the source tab, verifies the exact **Open in Open Wrangler** menu label, and clicks it. A disposable third-party CSV custom editor repeats the title-action route to cover Edit CSV-style integrations. Every path must open the selected session, preserve source bytes, close cleanly, and leave zero sessions/processes; Open Wrangler's own custom editor must show neither a duplicate title action nor a duplicate tab-menu action.
- This interaction exposed and corrected the former `activeCustomEditor` predicate to VS Code's real `activeCustomEditorId` key for the title action and all four cleaning-plan keybindings. The argument-only Jupyter variable-viewer command now has a distinct internal title and is hidden from the Command Palette, while its Jupyter-provided **Open in Open Wrangler** surface remains unchanged.
- All 28 TypeScript suites (305 tests) and 378 Python tests pass. The exact 63-entry allowlisted `openwrangler.vsix` has SHA-256 `1ba6fe3a8ba4e8bce96c0aa5530c48b84f1d3f71ea50e3e1fe133d4c316440a1`. Those bytes passed the complete two-process installed-package suite in disposable VS Code 1.128.1 and Cursor 3.11.19 profiles, including the ordinary-tab toolbar and menu clicks, the third-party CSV custom-editor route and its then-current import prompts, Cursor's declarative title-action pin with no stored profile override, own-editor duplicate suppression, source safety, and final zero-session/process cleanup. The prompt-based primary import behavior from that historical artifact is superseded by the automatic detector recorded above. The packaged README's PySpark tracking link was also expanded and inspected from the archive rather than inferred from its source Markdown.
- Rolling current-surface evidence: [VS Code title icon](images/editor-acceptance/vscode-file-title-action.png), [VS Code tab menu](images/editor-acceptance/vscode-tab-context-menu.png), [Cursor title icon](images/editor-acceptance/cursor-file-title-action.png), and [Cursor tab menu](images/editor-acceptance/cursor-tab-context-menu.png). These paths are refreshed from the latest validated release candidate and are not the exact screenshots from the historical 0.3.0 artifact; the preceding VSIX hash and packaged-acceptance record remain that artifact's exact evidence.

This closes editor-tab and editor-title launch parity. The combined file-entry row stays **Partial** only for the separately named packaged `.xls` and malformed-input UI evidence.

Column-projected transport slice, 2026-07-16:

- Protocol v2 now requires independently bounded row and column windows for initial open, ordinary pages, draft preview, applied-step inspection, apply, discard, and undo. Every page carries the ordered stable column IDs that define its row-vector values; the extension host rejects offsets, limits, IDs, row widths, diffs, or same-revision schemas that do not match the confirmed request/session before any state is published. Notebook MIME-v2 snapshots remain self-contained: exact legacy full-width pages migrate, partial/nonzero-offset snapshots fail closed, and the explicit Python helper caps embedded pages at 10,000 rows.
- Pandas slices visible columns positionally so duplicate and non-string labels remain unambiguous. Lazy Polars scans select only the private row identity and requested visible columns before terminal collection; real CSV and Parquet tests instrument that public call order and prohibit `to_pandas()`. DuckDB emits an explicit projected terminal selection without Pandas, Polars, or Arrow conversion. Cache identity includes both axes, and filters/sorts may reference columns that are intentionally absent from the returned block.
- The production grid keeps full-schema search, widths, selection, keyboard coordinates, and ARIA counts while retaining only bounded two-dimensional blocks. Diagonal scroll and mutation races cannot publish misaligned vectors; unavailable cleaning actions expose a real busy state instead of silently doing nothing. The pinned-browser suite verifies exact far-column values, cross-block focus, no more than two prefetched column blocks, all 24 axe harnesses, and pixel baselines. Wide-grid cached/uncached scrolling is 32.0/92.1ms p95, below its 100/500ms browser limits; these are webview-bundle measurements, not native editor paint.
- The strict Polars benchmark requests the shipped 16-column width and rotates nonzero horizontal offsets. For the 100k×50 CSV, cold-source stdio open/warm reopen is 67.419/32.749ms, direct cached/cache-miss p95 is 0.132/28.897ms, stdio cache-miss p95 is 30.584ms, and the active-profile page is 27.926ms. For the 1M×20 Parquet fixture those values are 59.334/34.592ms, 0.188/32.555ms, 39.340ms, and 13.293ms. Native lazy frames, source-cache eviction, active-profile overlap, bounded 8-entry/16 MiB caches, and zero retained sessions are proven; the measurements cover runtime/stdio boundaries, not VS Code or Cursor first paint.
- `npm run check`, all 30 TypeScript suites (327 tests), all 408 Python tests, extension-host/reload acceptance, browser acceptance, strict benchmark, and coverage are green. TypeScript coverage is 75.57% statements, 72.37% branches, 80.63% functions, and 78.82% lines; Python runtime coverage is 88.27%.
- The fresh 63-entry allowlisted `openwrangler.vsix` has SHA-256 `573d55999a0588fb9d4ff9b832c884ccb96fceca55971bde0d29a6d4e65f0db1`. Those exact bytes passed the complete two-process packaged matrix in disposable VS Code 1.128.1 and Cursor 3.11.19 profiles. A generated 300-column source was opened independently with Pandas, Polars, and DuckDB; each engine filtered and sorted on untransported columns, fetched columns 288 to 299 with exact endpoint values, preserved source bytes, closed all sessions, and stopped the standalone runtime.

This makes column-projected grid-block transport **Done** for Pandas and Polars and records additive DuckDB evidence. The broader virtual-grid row remains **Partial** only for installed-editor first-usable-grid timing; installed-editor performance and cross-platform package acceptance likewise remain **Partial** until their separately named gates are measured beyond this Linux workstation.

Stable-ID row/order-operation slice, 2026-07-16:

- `sortRows`, `filterRows`, `dropMissingRows`, and `dropDuplicates` now require public `{id, name}` references for every selected input column. Legacy strings, malformed or private bound objects, stale IDs, ID/name mismatches, stale filter semantic types, and repeated identities fail before adapter dispatch. Transform filter/sort types remain deliberately separate from name-addressed viewing state; copying a current viewing query resolves every name against the exact step-input schema and reports a missing or duplicate-name ambiguity instead of selecting the first match. Editing a saved filter defaults to its exact stored query and exposes replacement from the current viewing query as a separate explicit choice.
- The private binder adds exact input positions only to the executable plan. Pandas live execution and generated functions build filter masks, stable multi-sort orders, missing-value masks, and duplicate keys through `.iloc`, including duplicate labels and integer labels after an earlier reorder. Polars and DuckDB receive verified engine-native names only after binding and never convert through another dataframe engine. Omitted or explicitly empty missing-row keys and omitted duplicate-row keys mean all visible columns, exclude Open Wrangler's private row identity, and remain safe for a zero-column Polars frame.
- Focused protocol/React tests cover duplicate-safe ID-backed controls, faithful and explicit latest-filter replacement, latest-step edit defaults, strict transform decoding, ambiguous viewing-query conversion, all-column form semantics, and persistence that accepts stable cleaning steps while rejecting name-only saved cleaning without rejecting name-only viewing state. Runtime tests cover every engine's live/generated parity, null/NaN and keep modes, including non-float NaN inclusion as an explicit-false value filter. Tests also cover stale/repeated/type-mismatched references, integer and duplicate Pandas labels, zero-column behavior, private-row-ID exclusion in all-column missing/deduplication modes, and replay after a structural reorder.
- The installed VSIX's live-kernel acceptance creates a Pandas frame with two columns named `duplicate` plus integer label `7`. In disposable VS Code 1.128.1 and Cursor 3.11.19 profiles, the exact second duplicate and integer-labelled columns drive multi-sort, filter, missing-row, and duplicate-row drafts. Every intermediate preview is asserted before apply, public steps remain position-free, executable code is positional, an actual kernel replacement replays the one-row result, the originating variable remains unchanged, and final cleanup leaves zero sessions.
- `npm run check`, all 30 TypeScript suites (343 tests), all 442 Python tests, extension-host/reload acceptance, 24 pixel/axe production webview harnesses, strict performance gates, and coverage are green. TypeScript coverage is 76.26% statements, 73.18% branches, 81.28% functions, and 79.50% lines; Python runtime coverage is 88.30%. Browser cached/uncached wide-grid p95 is 32.1/86.1ms. The strict Polars 100k×50 CSV cold stdio open, direct cached/cache-miss p95, stdio cache-miss p95, and active-profile page are 52.911, 0.135, 26.805, 30.425, and 33.782ms respectively; the 1M×20 Parquet values are 47.457, 0.082, 31.187, 40.962, and 14.242ms. Both retain native lazy frames, accepted source-cache eviction, active profile overlap, and zero sessions.
- The final 63-entry allowlisted `openwrangler.vsix` has SHA-256 `8fd7a6d20eb585c01663be61cdd984ca7072d5ad1d594ec847444648f0a75a31`. Those exact bytes passed the complete two-process installed-package matrix in disposable VS Code 1.128.1 and Cursor 3.11.19 profiles. The archive contains no source, tests, ignored user files, retired product identity, or development compatibility alias.

This keeps sort/filter cleaning steps and missing/duplicate-row operations **Done** with exact-identity evidence. It advances the editing catalog and duplicate/non-string Pandas rows but leaves them **Partial** until the remaining categorical, text, numeric, datetime, grouping, and by-example column parameters use the same stable-reference contract and complete their installed-editor matrix.

Stable-ID value-operation slice, 2026-07-16:

- `oneHotEncode`, `multiLabelBinarize`, `findReplace`, `stripText`, `splitText`, `capitalizeText`, `lowerText`, `upperText`, `minMaxScale`, `roundNumber`, `floorNumber`, `ceilNumber`, and `formatDatetime` now require exact public `{id, name}` references for input columns. One-hot lists are non-empty and reject repeated identities. Legacy strings, malformed/private objects, stale IDs, ID/name mismatches, unknown lineage, output collisions, and private-row namespace names fail before adapter execution; public drafts, applied plans, persistence, and protocol metadata remain position-free.
- The shared binder resolves those references against each exact step-input schema and adds positions only to the private executable plan. Pandas live execution and generated functions use `.iloc` for the selected categorical/text/numeric/datetime series. Omitted or same-name outputs use positional replacement rather than duplicate-label assignment; explicit outputs append safely. One-hot and multi-label names derive from the referenced public label while duplicate generated names, retained-column collisions, and private-namespace outputs still fail. Polars and DuckDB receive verified native names and retain their no-conversion guarantees.
- Strict protocol, builder, binder, adapter, generated-code, lineage, and session tests cover every migrated operation across all editing-capable engines, including stale/repeated references, duplicate and integer-labelled Pandas columns, categorical collisions, empty literal find boundaries, in-place versus appended outputs, replay, inspection, undo, and public/private separation. The operation builder stores schema IDs, renders positional labels for equal names, restores edit defaults against the latest step-input schema without a name fallback, distinguishes omitted/default multi-label prefixes from explicit empty prefixes, and preserves protocol-valid empty find patterns.
- Development-host and installed-VSIX acceptance extend the existing live-kernel Pandas fixture to duplicate numeric, categorical, and datetime labels plus integer label `7`. Representative one-hot, uppercase, round, and datetime-format steps each prove the exact previewed target and operation-specific positional generated code before apply; the existing stable row/order sequence then reduces the cleaned result to one row. A real kernel replacement replays all eight steps to the same typed values, the originating dataframe equals its deep source snapshot before and after replacement, public references never expose positions, and close leaves zero coordinator sessions.

This advances the editing catalog and duplicate/non-string Pandas row but keeps both **Partial**. The migrated categorical/text/numeric/datetime families now have stable-reference and representative packaged evidence; structural operations still need their complete duplicate/non-string installed interaction cases, and `groupBy` plus `byExample` inputs remain name-addressed. No parity-complete or 1.0 claim follows from this slice.

Stable-ID group/by-example slice, 2026-07-16:

- `groupBy` keys and aggregation inputs plus `byExample` sources and every nested program column leaf now require exact public `{id, name}` references. By-example example inputs are ordered scalar arrays aligned with the selected source-reference order. Legacy strings, name-keyed maps, private positions, stale/name-mismatched IDs, duplicate keys/sources, outside-program references, alias collisions, and malformed persisted shapes fail closed; one input may still feed multiple uniquely aliased aggregations.
- The private binder resolves every reference against the precise step-input lineage and adds positions only to the executable draft/plan. Pandas live execution and generated functions group, aggregate, synthesize, and append through exact positions under duplicate and non-string labels; Polars and DuckDB consume verified native names without conversion. Grouped null and NaN keys form one missing group, every aggregate shares explicit null/NaN semantics, internal Pandas group labels cannot collide with user aliases, and lineage follows exact group-key identities.
- Deterministic by-example validation now ranks and revalidates one canonical AST, propagates null, compares finite numeric scalars without coercing booleans/strings, uses literal regex replacement and ASCII-only casing across engines, and rejects non-portable type/program combinations before dispatch. Resource guards pin 16 sources, 64 examples, 256 nodes, depth 64, 64 concat parts, 64 warning strings, 8 KiB per string, and 64 KiB total UTF-8 text. Cheap cardinality/node checks precede recursive accounting; TypeScript/persistence and Python enforce the same byte envelope, reject lone surrogates, and check both pre-synthesis input and retained canonical output.
- React acceptance proves duplicate-safe group controls, repeated aggregation values, ordered multi-source interaction, aligned JSON arrays, latest-step restoration, and no name fallback. Runtime/session coverage proves all three adapters' native/generated parity, draft/apply/inspection/replay/undo, immutable sources, public/private separation, exact duplicate/integer-labelled Pandas targets, incompatible-type rejection before adapter dispatch, checked positive/negative 38-digit boundaries, order-independent cancellation, UInt128/UHUGEINT and NumPy-object integers, typed-null group/string/datetime results, Pandas 2.x/3.x object-string min/max parity, exact nullable wide-integer Pandas grouping, context-independent Decimal sums, portable decimal mean/median floats, nanosecond temporal cells, and no Polars-to-Pandas conversion. Polars group sums use bounded native limb aggregates with a constant-size finalizer, and overflow raises an actionable error rather than wrap or panic. Persistence round-trips a lineage-valid canonical group/by-example sequence and rejects both retired shapes.
- The installed extension-host and exact packaged VSIX use a live Pandas kernel frame with duplicate labels and integer label `7`. By-example targets the exact non-string-labelled column; group-by keys on it and aggregates the exact second duplicate. Positional code, typed previews, public position-free metadata, kernel replacement/replay, deep source equality, and zero-session cleanup pass in isolated VS Code 1.128.1 and Cursor 3.11.19.
- `npm run check`, all 30 TypeScript suites (429 tests), all 765 Python tests, extension-host/reload acceptance, 24 pixel/axe browser harnesses, strict performance gates, and coverage are green. TypeScript coverage is 78.68% statements, 76.60% branches, 83.12% functions, and 81.97% lines; Python runtime coverage is 89.80%. Browser cached/uncached wide-grid p95 is 31.7/88.5ms. Strict Polars CSV/Parquet cold stdio opens are 71.467/49.162ms; direct cached/cache-miss p95 is 0.133/29.147ms and 0.090/39.587ms; stdio cache-miss p95 is 32.634/37.443ms. Both retain native lazy frames, accepted source-cache eviction, active-profile overlap, bounded caches, and zero sessions.
- The final 63-entry allowlisted `openwrangler.vsix` has SHA-256 `84962c6840c292b8f241d9b3c50bd29603e8cee48b2044cbedeaac9cc8885144`. Those exact bytes passed the complete two-process installed-package matrix in disposable VS Code 1.128.1 and Cursor 3.11.19 profiles. Archive inspection found no source, tests, maps, ignored user files, retired product identity, or compatibility alias.

This closes the stable-reference and duplicate/non-string installed evidence for grouping and by-example. Their existing operation rows remain **Done**. At this checkpoint the broader editing and duplicate/non-string rows stayed **Partial** only for the separately named structural-operation packaged matrix; the next slice records that final operation-family gate without making an overall 1.0 claim.

Structural duplicate/non-string packaged slice, 2026-07-16:

- A pristine live Pandas kernel frame contains duplicate numeric, categorical, and datetime labels plus integer label `7`. `selectColumns` first reorders both duplicate identities and the non-string identity. `cloneColumn`, `castColumn`, `formula`, `textLength`, `dropColumns`, and `renameColumn` then address those same identities only after their visible positions have changed; drop shifts the surviving duplicate again before rename binds it.
- Every operation completes draft preview and explicit apply. Acceptance checks the operation-specific positional Pandas code, exact typed cells, including the distinction between a source float NaN and a formula's nullable result, deterministic output IDs read from returned metadata, contiguous reordered lineage, and public drafts/plans with no private `position` field. Ambiguous `df['duplicate']` generated-code access is rejected.
- A real kernel-object replacement recreates the pristine variable, then the coordinator replays all seven structural steps into the same stable-ID schema and typed page. Deep equality before and after replacement proves that neither the original variable nor its recreated source is mutated. Explicit close leaves no coordinator session.
- `npm run check`, all 30 TypeScript suites (429 tests), all 765 Python tests, and the complete extension-host/reload suite are green. The 63-entry allowlisted `openwrangler.vsix` has SHA-256 `156e54f58792fb2a03d2a6003a9cc2f8f2ff47ae1c5f105f6cf558360bd4541c`; those exact bytes passed the two-process installed-package acceptance in disposable VS Code 1.128.1 and Cursor 3.11.19 profiles.

This makes the editing catalog, the seven structural-operation row, and duplicate/non-string Pandas operation acceptance **Done**. Runtime and generated-code coverage remains broader than the installed sample, while the package test now supplies the previously missing shifted-identity interaction and recovery evidence. This does not change the separately tracked Restricted Mode, notebook, import-error, installed-paint, or cross-platform release gaps.

Dependency-install confirmation safety slice, 2026-07-16:

- The public Install Runtime Dependencies command is zero-argument: boolean, object, and other hostile caller arguments are ignored, and production installation always opens the modal naming the exact unresolved requirements and target interpreter. Only the literal affirmative action may invoke `python -m pip install`; dismissal and Escape return false.
- The activation API returned under `OPEN_WRANGLER_EXTENSION_TESTS=1` exposes only a no-argument deterministic decline as its dependency-install decision seam. It cannot confirm installation or become a sticky decision consumed by a later public command; all affirmative paths use the real production modal. Workspace Trust remains mandatory for installation. A change to the `openWrangler.pythonPath` override invalidates the selection and clears its probe cache. A later successful dependency probe clears an older actionable install target while retaining its valid cache result; a decline retains the current diagnostic for an intentional retry. The resource-scoped Python-extension event and process-ownership evidence is recorded in the 2026-07-25 slices below.
- The development host records every invocation of its directly executable, no-pip isolated interpreter and uses the gated decline path where no workbench browser is available. The disposable installed-editor profile is preseeded with the editors' built-in custom dialog style so the same real modal API is CDP-visible instead of an OS-native message box. The VS Code/Cursor verify phase calls the public command with the former bypass value `true`, inspects the visible message/detail for `pandas, xlrd>=2.0.1` and the exact isolated interpreter path, dismisses it with Escape, and proves the invocation log, runtime generation/running state, and runtime setting are unchanged.
- Focused command-boundary and bridge tests cover hostile arguments, exact modal contents/options, cancellation, trust denial, affirmative pip arguments, the decline-only test gate, single-flight installation, selection changes during environment resolution, probing, modal display, progress, and process startup, stale-target invalidation, old-pip completion, successful-cache retention, restart behavior, and retryable missing diagnostics.
- The affirmative path now owns an exact no-shell, output-ignored pip child and registers a mutation barrier before package writes. The later lifecycle slice keys that barrier by the strictly probed package root rather than executable spelling. Lifecycle regressions prove active and already-stopping runtimes quiesce first, a failed runtime stop launches no pip and releases only after exact late exit, genuinely different package environments stay independent, and probe/start attempts fail closed while mutation is active. Shutdown waits briefly for authoritative close, never signals or kills pip, unreferences an unconfirmed child once, returns one latched failure to repeated callers, and suppresses late UI/cache publication. A host/OS interruption marker remains separately tracked in issue #79.

Recovery and editor-acceptance follow-up, 2026-07-17:

- Concurrent requests from three sessions still start exactly one replacement process, but the complete ordinary/recovery open-and-restore path is now serialized per shared runtime delegate. Deterministic unit barriers prove Pandas/Polars/DuckDB-style sessions cannot overlap native engine initialization or saved-state restoration, a fresh open waits behind active recovery, all public sessions recover with new runtime IDs, and unrelated delegates establish sessions concurrently.
- The installed third-party CSV-editor flow explicitly clicks the labeled Comma, UTF-8, and header defaults and confirms the quote input, removing its dependency on a globally focused Enter key in minimum-version workbenches. Recovery assertions now retain the full structured response in any failure report.
- `npm run check`, all 31 TypeScript suites (458 tests), all 765 Python tests, and coverage are green. TypeScript coverage is 80.15% statements, 77.27% branches, 84.27% functions, and 83.50% lines; Python runtime coverage is 89.82%. The exact Python 3.12.13/VS Code acceptance stack passes on both minimum VS Code 1.105.0 and current VS Code 1.129.0. Downloaded editor distributions are ignored, lint-excluded, and explicitly VSIX-excluded while remaining outside the package allowlist.

This hardens existing **Done** runtime-selection and recovery rows; it does not change any remaining parity status or make a 1.0 claim. The final 63-entry allowlisted `openwrangler.vsix` has SHA-256 `5bc4924f30d7e0ea7c9e15a0a05d9b78df85adff8470d16c982bb28fb10f410d`; those exact bytes passed the complete two-process installed-package acceptance in disposable VS Code 1.128.1 and Cursor 3.11.19 profiles.

Source-safe Python-script export slice, 2026-07-17:

- The public **Export Generated Script** command is zero-argument and ignores hostile URI/object arguments. After trust and active-code checks it always asks VS Code for a destination, rechecks trust after the dialog, and returns false on cancellation or failure. The environment-gated acceptance API is the only deterministic-destination seam and calls the same production writer. A public-command filesystem test returns a real `.py` hard-link alias from the Save-dialog boundary and proves the immutable dataframe source is not changed; the installed editor flow proves a hostile argument cannot bypass the visible Save dialog, exports the edited CodeMirror buffer byte-for-byte, and cancels a second dialog without creating a file.
- Public session metadata now pins the exact immutable `openSession` request source across initial, page, mutation, replay, and recovery responses, so malformed runtime source metadata cannot redirect the guard. Exact `vscode-remote` URIs retain their authority, a simultaneous remote workspace must name the same host, and local/cross-remote mismatches fail before Node filesystem I/O. The authority contract is unit-tested; an actual Remote SSH/WSL host run remains part of the separate remote/cross-platform hardening gate rather than being inferred from local paths.
- The writer checks exact, normalized, canonical, parent-symlink, direct-symlink, hard-link, platform-case, directory, virtual, and remote-host destinations. It captures usable identities for every concrete source, the selected destination, and its parent; reserves one of sixteen random sibling names exclusively; records the created file identity; writes and flushes the complete edited buffer; closes it; then revalidates source, destination, parent, and temp state immediately before one rename. Missing or all-zero source/destination identities fail closed. A source rename, appeared/replaced/deleted destination, changed parent, or substituted temp cannot be published; an unidentifiable or substituted temp is deliberately not removed by pathname.
- Fault injection covers non-collision exclusive-open failure, post-open identity failure, exhausted and retried name collisions, partial write, sync, first/cleanup close, source/destination/parent/temp revalidation, destination replacement, cleanup removal, already-absent cleanup, and second-validation `realpath`/`stat`/`lstat` failures. Every applicable failure preserves the protected source and any concurrently changed destination, removes only a still-identified owned temp, and retains both primary and cleanup errors when cleanup itself fails.
- `npm run check`, all 32 TypeScript suites (500 passing tests, one Windows-only skip), all 765 Python tests, both extension-host/reload stacks, 24 unchanged pixel/axe harnesses, and coverage are green. TypeScript coverage is 81.14% statements, 77.95% branches, 85.11% functions, and 84.41% lines; Python runtime coverage is 89.82%. The exact Python 3.12.13/VS Code acceptance stack passes on minimum VS Code 1.105.0 and current VS Code 1.129.0.
- The final 64-entry allowlisted `openwrangler.vsix` has SHA-256 `9eda4abf9dd7467cc58c4818ba0926085ea02d5826129596e94e1df2d995a50b`. Those exact bytes passed the complete two-process installed-package matrix with both editors explicitly required in disposable VS Code 1.128.1 and Cursor 3.11.19 profiles; a missing requested editor now fails instead of silently reducing the matrix.

This hardens the existing **Done** code-export row without changing the remaining Restricted Mode, notebook expansion, installed paint, remote-host, or cross-platform release gaps. It does not make a 1.0 or parity-complete claim.

Zero-window editor-acceptance harness, 2026-07-17:

- Six script-level lifecycle tests prove the Linux default removes desktop display and live-editor IPC access, creates and removes private mode-0700 runtime, home, config, cache, and data roots, disables login-shell resolution and persistent auxiliary services, restores the caller environment, reports the last durable acceptance checkpoint, scopes POSIX timeout cleanup to the spawned editor process group, requires an explicit visible-debug override, and keeps Xvfb as an explicit compatibility mode.
- The complete packaged-editor flow for the checksum-pinned artifact above passed on the default zero-window Ozone platform in disposable VS Code 1.128.1 and Cursor 3.11.19 profiles. A focused Cursor rerun after private-home isolation produced no normal-profile, NSS, Crashpad, analytics-database, or GPU-display errors; the final combined run passed with the same isolated environment.
- The follow-up runner gives each seed/verify phase a 300-second hard bound and a 180-second changed-checkpoint inactivity bound, records exact editor/version/phase/exit context, distinguishes spawn, early-exit, outer-timeout, result-protocol, explicit-test, runner, and interruption failures, and deliberately performs no automatic retry. Failure-only CI and release artifacts retain a seven-day, redacted, size-bounded allowlist of phase results/progress, selected editor/Open Wrangler logs, structured metadata, and a paths/types/sizes-only profile manifest; raw disposable profiles are deleted and never uploaded.

This changes test isolation, not product behavior or parity status. No result from this harness is treated as cross-platform evidence.

Notebook-origin provenance hardening, 2026-07-17:

- Renderer, variable-viewer, manual-launch, integration-check, coordinator, and insertion paths retain the exact open `NotebookDocument`; renderer messages additionally retain the exact visible sender editor. Focus changes, other splits, closed origins, and same-URI replacement objects are rejected instead of falling back to the active editor or a URI match.
- Every dispatched live-kernel session identity remains mapped to its exact kernel. Cancellation, timeout, malformed output, transport failure, late stale generations, wrong returned identities, duplicate IDs, provenance loss, early coordinator shutdown, and terminal close tests prove bounded one-time candidate cleanup without URI reacquisition. A wrong ID that names an existing live session cannot retire it, and an early idle notification cannot discard the mapping needed by delayed cleanup.
- Generated-code insertion repeats exact-object, version, cell-count, and same-URI uniqueness checks immediately before dispatch, serializes its own requests, and reports success only after the same object contains the uniquely marked Python cell. The stable VS Code notebook-edit API is URI-addressed; a deliberately emulated replacement after dispatch is therefore reported as indeterminate and is never retried, rolled back, or misreported as success.
- All 35 TypeScript suites pass with 542 tests and one platform skip; all 765 Python tests and six editor-isolation script tests pass. The strict native-Polars benchmark passes with 65.148 ms CSV and 52.519 ms Parquet cold-source protocol opens, 0.165/0.195 ms cached-page p95, and zero retained sessions. The exact 64-entry allowlisted `Matt17BR.openwrangler@0.3.0` candidate has SHA-256 `d8b8a322401c8682e4b8bdbf6262e07dd6dbcf62ec51a07784fe1a7f2760a71a`.
- Those exact bytes passed the complete zero-window packaged matrix in disposable VS Code 1.128.1 and Cursor 3.11.19 profiles. With notebooks A and B visible and B active, clicking A's real renderer action opened A's Polars variable and returned `101`, never acquired a kernel for B, inserted edited code only into A, preserved every existing cell in both notebooks, and closed with zero retained sessions. This records the tested behavior of that historical 0.3.0 artifact, not the current primary saved-output action.

This hardens notebook provenance and originating-notebook insertion without changing parity status. The notebook-variable row remains **Partial** until the released Jupyter extension is exercised in [issue #52](https://github.com/Matt17BR/openwrangler/issues/52). The coordinator-owned saved-output slice below closes the separate inline full-view gate from [issue #53](https://github.com/Matt17BR/openwrangler/issues/53).

Coordinator-owned saved-output slice, 2026-07-17:

- Earlier experimental releases could open captured notebook rows in the workbench. The current behavior removes that path: the primary action is live-only, an unlinked capture remains inline with a rerun hint, and captured rows never replace the complete current variable.
- Producer and consumer validation share hard limits for rows, columns, cells, UTF-8 payload size, field lengths, graph depth, and graph nodes. Python capture rejects oversize output incrementally instead of allocating a complete encoding, performs no eager profiling, and collects only one bounded terminal page from lazy Polars. Snapshot, live, and generated-code views share one strict literal fixture for null/NaN, wide integer/decimal, date/time-zone, exact duration, sort, and portable ASCII-folded search semantics. Bounded versioned typed-selection tokens keep display-equal integer `1` and string `"1"` separately selectable while preserving Pandas' native equality group for `1`, `1.0`, `True`, and `Decimal("1")`; malformed tokens and invalid literals fail before row evaluation, including empty and all-null captures. DuckDB preserves aware instants through `TIMESTAMPTZ` and serializes intervals from exact integer microseconds.
- The notebook renderer uses optional host messaging with an explicit `onRenderer:openWrangler.renderer` activation event, so its static saved preview remains portable when messaging is unavailable. This checkpoint's Cursor acceptance explicitly revealed virtualized output cells, switched two saved-output notebooks in the same editor group, retained the split-notebook provenance race, and verified the snapshot action without acquiring a kernel.
- Transient session panels use the distinct internal `openWrangler.session` view type and a session-keyed registry instead of colliding with the `openWrangler.viewer` custom editor. File panels still open immediately; notebook panels open once on webview readiness, so permission denial cannot silently retry after access is restored. Terminal close accepts the panel's last confirmed revision as advisory and removes the exact coordinator/runtime session.
- `npm run check`, 37 TypeScript files with 684 passing tests and one platform skip, 907 Python tests, seven editor-isolation script tests, extension-host/reload, 24 production visual/axe harnesses, coverage, license, and strict runtime benchmark gates are green. The 1M × 20 Parquet benchmark records a 50.477 ms cold-source protocol open, 0.104 ms cached-page p95, 34.506 ms uncached transport p95, and zero retained sessions; these are runtime boundaries, not editor-paint claims.
- The final allowlisted 67-entry `Matt17BR.openwrangler@0.3.0` VSIX is 518,365 bytes with SHA-256 `55decdfdf3f339b8e433fa9f50356b41c80a7198eda9b00be18f64e4c8a1c8f8`. Those exact bytes passed the complete seed/verify matrix in disposable zero-window VS Code 1.128.1 and Cursor 3.11.19 profiles, including file-title/tab launch surfaces, viewing/editing/export, notebook provenance, saved-output expansion, reload/recovery, and terminal session cleanup. Each invocation used one private workspace-local `tmp/ow/x-*` tree, and both extension-host and combined packaged-editor runs left that root empty afterward.

This advances **Inline notebook renderer and full-view expansion** to **Done**. It does not advance the separate released-Jupyter, Restricted Mode, first-paint, remote-host, or cross-platform rows and does not make a 1.0 parity claim.

Packaged-editor diagnostic hardening, 2026-07-22:

- That slice's TypeScript run covered 38 files with 690 passing tests and one platform skip; all 907 Python tests passed. The script suite contained 170 tests: 169 passed on Linux, where only the real Windows-supervisor smoke was skipped; the native Windows pull-request job required that smoke to pass. Standalone, seed, and verify phases retain distinct randomized result and run-specific progress files, durable checkpoints, a 300-second hard deadline, and a 180-second changed-checkpoint inactivity deadline. That hard deadline includes supervisor preparation, receipt validation, process spawn, and cancellable private debugging-port reservation. Major extension-host checkpoints publish through bounded, exclusive, randomized no-follow temporaries, and publication errors fail acceptance. Every outcome and checkpoint must match the current phase's strict `protocol`/`runId`/`phase` envelope; Windows observes a separate empty run/phase-derived heartbeat while the Job Object is live, so stale correlation cannot extend inactivity without opening mutable payloads, and the final read must retain the first-observed file identity. Spawn, premature-exit, timeout, result-protocol, explicit-test, runner, and interruption failures carry exact editor/version/phase/elapsed/exit/checkpoint context and are never retried automatically.
- Editor stdout/stderr is continuously drained through ownership verification under fixed bounds, discarded on success, and size-limited plus credential-redacted before failure reporting. The correlated Windows job-empty marker is removed before stderr accounting, returned output, or diagnostics; an unsafe non-piped supervisor stderr configuration is rejected before spawn. Split-marker/final-suffix backpressure tests prevent transform flush from dropping target output. The editor CLI, workbench, and private-display launchers inherit only the documented platform/isolation allowlist and runner-owned values; credential-bearing and authenticated-proxy variables are excluded.
- POSIX launches own process groups. Windows compiles the checked-in C# supervisor once per private run root inside the same command or phase deadline, pins that executable and parent identity plus SHA-256, permanently rejects an unverified build root, then uses the exact supervisor to create each target suspended, assign a parent-leased kill-on-close Job Object with an explicit inherited-handle list, and resume only after ownership succeeds. Normal completion requires exactly one random supervisor attestation that is absent from the target environment and emitted only after `ActiveProcessCount == 0`; every settled path closes control stdin. Any ambiguity permanently latches ownership uncertainty even if a matching marker or later exit/error arrives. The real Windows smoke proves the compile-once contract, natural descendant containment, forced termination, and malformed-frame rejection. Late child errors cannot impersonate exit, and downloader/display uncertainty propagates. Environment restoration after uncertainty is lexical only, the runner publishes no artifact or workflow output path, and no inherited private runtime, root, profile, result, progress, log, or staging path is inspected, traversed, or removed. Verified private and staging roots move to unadvertised random siblings and retain captured root/parent identity through deletion, so a rebound public path is never recursively removed.
- When ownership is verified, injected workbench, timeout, cleanup, pre-launch, recursive-metadata, hard-link, planted-entry, staging-root-replacement, and live path-swap failures prove that only bounded, redacted, allowlisted phase state and VS Code/Open Wrangler text logs survive profile deletion. Full evidence uses one verified descriptor per source, fixed candidate/scan/file/output bounds, complete admitted-source private-key screening, fail-closed containment and identity checks, an in-memory inventory receipt, and a second redaction pass while sealing. CI and release upload one exact receipt-bound JSON artifact for seven days; success and ownership uncertainty produce none. Pull-request and release workflows require native stable VS Code extension-host and exact packaged-artifact acceptance on macOS and Windows alongside Linux.
- Atomic progress replacement after a no-follow descriptor opens is treated as an expected publisher race only when that descriptor is already unlinked: the reader discards it and retries the new private entry. In-place mutation, linked or special files, oversize data, identity changes, and every result-file replacement remain fail-closed. Live notebook-variable panels now open before webview readiness and retain their single success or failure response for later publication; saved notebook-output panels remain lazy, and a denied live open cannot be retried by a delayed `ready` event.
- Standalone and live-kernel session creation share a dedicated configurable 60-second cold-initialization deadline without extending the 30-second recovery bound for pages, profiling, transformations, or exports. The first native Windows run still deadlocked at that complete 60-second bound both in packaged acceptance and in the fresh Python-only Polars-then-Pandas subprocess, proving that a longer transport timeout was not a fix. The standalone server now prepares the selected native backend through a separately owned transient adapter on its process-owned stdin reader thread before worker dispatch; the real source open remains asynchronous. A bounded fresh-process regression opens Polars and then Pandas in the same server, closes both correlated sessions, and exits on EOF. A fresh native Windows run remains the acceptance authority for this import-order fix.
- At that slice, `npm run check` and `npm test` were green. The script suite had 174 tests (173 passed on Linux with only the native Windows-supervisor smoke skipped), 40 TypeScript files had 715 passing tests and one platform skip, and all 917 Python tests passed locally, including transient-preparation ownership/failure cases, automatic and explicit backend selection, reader-thread dispatch ordering, and the mixed-engine subprocess regression. Native Windows acceptance was still required before that evidence could be treated as cross-platform.
- The rebuilt allowlisted 67-entry `Matt17BR.openwrangler@0.3.0` VSIX is 520,409 bytes with SHA-256 `49fb5a6eb9476fcb93b3704e8f0a11ba72f759fe7c0c6a7a2db6151a2b4249fc`. Those exact bytes passed standalone extension-host acceptance and the complete packaged seed/verify flow in disposable VS Code 1.129.1 and Cursor 3.12.29 profiles. VS Code used the zero-window headless-Ozone default. Cursor 3.12.29's early headless GTK `SIGABRT` is classified with an exact metadata-only diagnostic and is never retried or allowed to fall back to the desktop; its successful run used the explicit private-Xvfb compatibility mode, remained unfocused, and included the formerly racy second duplicate-column Pandas notebook launch. Both runs completed viewing, editing, export, notebook, recovery, and terminal-cleanup checks without using normal editor profiles.

This hardens the acceptance gate and its failure evidence. It changes neither the remaining parity status nor the macOS/Windows, remote-host, or installed-editor performance gates and does not make a 1.0 claim.

Windows Excel and native-editor closure, 2026-07-24:

- Hosted Windows Python 3.14 diagnostics localized the fresh Polars Excel stall to PyArrow's NumPy-backed native import beginning on a worker after the server's reader had returned to blocking stdin. Skipping Polars preparation and forcing Arrow's system allocator still stalled; initializing NumPy or PyArrow on the owner thread completed the open. The production path propagates the exact source descriptor into the separately owned transient adapter and preloads discoverable PyArrow only for Polars `.xls`/`.xlsx` sources. This covers `fastexcel` 0.9 to 0.14, which import PyArrow directly, and 0.15+, where Polars selects eager PyArrow output when available. Missing optional PyArrow keeps the newer capsule path; `fastexcel`, Calamine, and the source read remain worker-dispatched.
- `npm run check` and `npm test` are green at product commit `82e9017`: 175 script tests run with 174 passing on Linux and only the native Windows-supervisor smoke skipped, 40 TypeScript files have 715 passing tests and one platform skip, and all 923 Python tests pass. Hosted Windows runs execute the supervisor smoke. The strict runtime benchmark passes with 44.780 ms CSV and 46.826 ms Parquet cold-source protocol opens, 0.142/0.094 ms cached-page p95, 32.274/36.952 ms uncached transport p95, and zero retained sessions.
- The [cross-platform runtime run](https://github.com/Matt17BR/openwrangler/actions/runs/30079391797) is green on macOS with Python 3.12, Windows with Python 3.14, and Ubuntu with Python 3.10. The [native-editor CI run](https://github.com/Matt17BR/openwrangler/actions/runs/30079391880) is also green: macOS and Windows passed the real packaged-extension flow, along with coverage, Python 3.10/3.14, minimum/current VS Code extension-host, and validation jobs. The PR's separate CodeQL analyses passed as well.
- The allowlisted 67-entry `Matt17BR.openwrangler@0.3.0` VSIX is 523,569 bytes with SHA-256 `a54a6d61b9b4fa087e0b8e52b61fa3a1725ea56d9f2210d9477ffd48873a1ff3`. Those exact bytes passed the full local packaged flow in VS Code 1.129.1 using zero-window headless Ozone and Cursor 3.12.29 on a private Xvfb display. Both used disposable profiles, left no retained runtime or editor-acceptance root, and could not appear on or focus the user's desktop. The same product state passes all 24 production visual/axe harnesses and local zero-window extension-host acceptance.

This closes the Windows runtime and native packaged-editor blockers for this slice. It does not advance rows still gated by released Jupyter, Restricted Mode, remote hosts, first-paint editor measurements, or Cursor acceptance on macOS/Windows, and it does not make a 1.0 parity claim.

Import-option reconfiguration and Restricted Mode, 2026-07-24:

- The canonical import descriptor now has one exact, alias-free shape. Excel selectors use either a nonblank `sheetName` or a safe non-negative zero-based `sheetIndex`; selector-free custom-editor defaults resolve to index 0, and the two selectors or delimited fields cannot be mixed. Delimiter and quote values are one Unicode scalar value: lone high/low surrogates fail at every decoder while valid multibyte and supplementary characters remain representable. Pandas and Polars open real `.xlsx` and BIFF `.xls` fixtures by name and zero-based index, with Polars translating only at its private reader boundary.
- Automatic backend selection excludes Polars for a multibyte delimiter and excludes Polars/DuckDB for a multibyte quote. An explicitly pinned incompatible backend returns `unsupported_import_options` before environment resolution, dependency probes, or Python startup.
- **Change Import Options** is contributed to the configurable editor toolbar/tab menu and Command Palette and is also exposed inside the live grid and initial-load error. The webview flushes pending scroll/width/selection state before it enters the busy interlock, and the host refuses runtime or presentation-state work that races the transaction. Restored renderers keep bounded visibility-aware snapshot pulls alive until a matching final synchronization marker is committed and acknowledged from a post-commit effect. Pending grid state flushes before that acknowledgement; the host rejects and corrects replay-era writes until the exact marker arrives, while ordinary page revisions remain writable. Native commands use a separately correlated preparation action and fall back in the host exactly once if that action is not acknowledged; manual and correlated intents coalesce, and a busy renderer still flushes pending view state first. The coordinator keeps one public session ID, opens a private candidate, replays the confirmed plan, optional draft, and view, then publishes once. Cancellation, malformed output, replay failure, transport failure, and close races preserve the prior public snapshot; candidate and retired cleanup cannot restart the shared runtime or release its delegate early.
- Explicit **Change Import Options** CSV/TSV and Excel prompts stay open through incidental editor or webview focus transitions while Escape, cancellation tokens, and superseding actions remain authoritative. Native acceptance selects every QuickPick choice through bounded focus-checked keyboard navigation and records per-prompt checkpoints, including non-default encoding and damaged-file recovery from the real error-state action. Primary launches remain prompt-free.
- Confirmed file configuration v2 stores the concrete backend used by the session separately from the logical `auto` or explicit preference. A custom-editor recreation pins the concrete backend for the existing persistence/recovery key without converting an automatic choice into an explicit pin for the next import reconfiguration. VSIX verification independently rejects duplicate archive paths and requires packaged preview status to agree with the Marketplace prerelease manifest property.
- The complete local gate passed at product commit `66f4f1e`: 181 cross-platform runner tests (180 passing on Linux plus the expected Windows-supervisor smoke skip), 910 TypeScript tests (909 passing plus one intentional skip), 984 Python tests, strict type/lint/docs/license checks, both coverage thresholds, all 24 production visual/axe harnesses, zero-window extension-host acceptance, and the strict runtime benchmark. The Polars runtime/protocol boundary opened the cold 100k × 50 CSV in 60.109 ms and 1M × 20 Parquet in 54.109 ms; warm-source medians were 35.001/34.918 ms, cached-page p95 was 0.218/0.119 ms, and uncached protocol-page p95 was 27.262/36.115 ms. These are direct runtime and protocol measurements, not editor first-paint claims.
- The allowlisted 68-entry `Matt17BR.openwrangler@0.3.0` VSIX is 539,738 bytes with SHA-256 `6d9faada11b86a674837cd03ebd6cbd6ff89e4a1e20856e34915a16a742aac30`. Those exact bytes passed packaged VS Code 1.130.0 on zero-window headless Ozone and Cursor 3.13.10 on a private Xvfb display. Both editor runs used fresh profiles, exercised non-default delimited options, real BIFF `.xls` name/index selection in Pandas and Polars, live-grid/title/tab/error retry actions, cancellation, corrupt CSV/JSONL/Parquet/XLS sources, byte-identical inputs, exact renderer-state recovery, zero retained sessions, and stopped runtimes.
- The [full CI run](https://github.com/Matt17BR/openwrangler/actions/runs/30163621408) is green, including native packaged-editor acceptance on hosted Windows and macOS, validation, coverage, Python 3.10/3.14, and minimum/current VS Code extension hosts. The [cross-platform runtime run](https://github.com/Matt17BR/openwrangler/actions/runs/30163621402) passed on Windows 3.14, macOS 3.12, and Ubuntu 3.10; both [CodeQL analyses](https://github.com/Matt17BR/openwrangler/actions/runs/30163621399) passed. Successful native jobs retained no failure evidence.
- Each packaged editor also ran a separate fresh Restricted Mode profile with Workspace Trust enabled. The harness proved `workspace.isTrusted === false`, the installed package remained inactive, its command could not activate it, and no custom editor, coordinator API, dataframe session, or Python runtime appeared. The trusted packaged phases retain the existing custom-code interaction evidence.

This makes the file-entry, custom-code trust, and Restricted Mode rows **Done**. It does not advance released-Jupyter, first-usable-grid timing, complete release-platform UI, remote-host, or Cursor-on-macOS/Windows gates and does not make a 1.0 parity claim.

Resource-scoped Python environment invalidation, 2026-07-25:

- The optional Python integration now uses the released stable `@vscode/python-extension` environment API without adding a hard extension dependency. Activation is single-flight, subscribes before the first selection is consumed, forwards the exact resource object, and becomes terminal on disposal. Absence, disablement, activation failure, or a malformed optional API still permits system-interpreter discovery; disposal during activation or environment resolution cannot fall through and start an unscoped runtime.
- Standalone sessions are partitioned by Python selection scope: files in one workspace folder share a process, different workspace roots and exact external-file scopes remain isolated even when they resolve to the same executable, and session/cancellation responses route only through their exact owning slot. Requested session IDs are provisional until their correlated open succeeds. Ordinary queries cannot route through a provisional ID, and cleanup marks a reservation terminal before dispatch. Timeout, write failure, cancellation, wrong/duplicate identity, or cross-slot output cannot promote it; any later `sessionOpened` response fails closed and restarts only the affected slot.
- Workspace-folder, exact-file, sibling-file, and unscoped Python-extension events invalidate only the selections they can affect. A configured `openWrangler.pythonPath` remains authoritative. Per-scope epochs prevent deferred environment and dependency-probe results from republishing after a switch or shutdown. A successful confirmed `pip install` invalidates every active scope sharing its normalized probed package root even when the initiating target became stale, without discarding a newer selection for a genuinely different package environment.
- Focused bridge coverage composes real selection, slot, startup, stop, and routing logic across workspace roots while mocking the resolver, dependency probe, and child-process boundaries. It includes same-scope reuse, targeted event invalidation, targeted timeout and process failure, cross-slot duplicate rejection, provisional-close races, authoritative cancellation, deterministic multi-slot shutdown errors, terminal broker disposal, and stale environment/probe continuations.
- The canonical prerelease VSIX built from `8b61442` (including the resource-slot implementation at `cc8698d`) verified with 68 allowlisted entries and SHA-256 `03a2b477dda6a61dac90a7caeccd6d115a26316429cfbd8fa6af160e232d74bf`. That exact artifact passed in a fresh zero-window VS Code 1.130.0 profile and a private Xvfb Cursor 3.13.10 profile against `ms-python.python@2026.4.0`. Cursor used the manifest-validated official Microsoft VSIX because its registry could not resolve the pinned version by ID.
- In both editors, the packaged phase used two independently instrumented interpreters, committed a Polars formula step, switched A → B → A through the stable API, observed exactly one new runtime generation per switch, replayed the same plan and `21.0` first-row result, preserved the source bytes, and ended with zero sessions and no runtime. This strengthens the existing **Done** runtime-selection behavior without closing the remaining released-Jupyter, first-paint, remote-host, or release-platform gates, and it is not a parity-complete or 1.0 claim.

Bounded Python runtime-scope retention, 2026-07-25:

- The bridge now bounds the aggregate union of inactive runtime slots, environment selections, selection epochs, and recency metadata to 128 scope bundles. A monotonic least-recently-used index does not reorder the runtime-slot map, preserving deterministic shutdown and error ordering. Exact eviction also scrubs the evicted slot's stderr, exit error, and stale process-selection references.
- Exact-object leases span environment resolution, dependency probing, process selection/start/stop waits, and ownership handoff. Pending requests, provisional candidates, confirmed sessions, cancellation targets, stopping children, and the exact actionable missing-dependency target independently pin their scope. All-pinned scopes may temporarily exceed 128; the first ownership release trims the oldest newly inactive bundle immediately.
- Eviction is synchronous and identity-checked. Stale leases, environment resolutions, and dependency probes cannot touch or publish into a same-key replacement. Unresolved orphan selections fail closed. Completed dependency probes are independent of resource-scope retention and are bounded by their own exact-key least-recently-used cache, described in the acceptance record below.
- An unconfirmed process stop remains ownership, including after the bounded stop promise rejects. Concurrent reopen stays attached to the same exact slot, no replacement can start through the uncertainty window, shutdown retains the original failure, and only a later exit from that exact child permits eviction.
- The focused bridge suite passed all 88 tests at implementation commit `8f47187`, including pressure beyond the cap, exact missing-target/cancellation pins, deferred resolution and probe leases, temporary overflow, LRU refresh, orphan handling, same-key recreation, reopen-during-stop, and stale continuation rejection. Extension type-checking also passed.
- The canonical prerelease VSIX built from `ae71707` (including `8f47187`) verified with 68 allowlisted entries, 547,244 bytes, and SHA-256 `c120a74c249850cc74c5547d3c0ef9e837971d5b7babccb018994e1f6acd5660`. That exact artifact passed the complete packaged harness in a fresh zero-window VS Code 1.130.0 profile and a private Xvfb Cursor 3.13.10 profile against `ms-python.python@2026.4.0`. Both editors completed real file, dataframe-engine, notebook, recovery, export, and A → B → A Python-selection workflows without touching normal profiles and ended with no retained session or runtime.

This addresses the bounded-retention gate tracked in [issue #75](https://github.com/Matt17BR/openwrangler/issues/75) and hardens the existing **Done** runtime-selection behavior without changing parity status. Dependency-install ownership and bounded dependency probing are recorded separately below. This is not a parity-complete or 1.0 claim.

Dependency-mutation lifecycle completion, 2026-07-25:

- Python environment discovery and dependency probing now run in isolated mode under a controlled subprocess environment, ignoring inherited Python homes, paths, user sites, launchers, and environment-manager markers. Discovery strictly decodes the supported version plus canonical `realpath(sys.prefix)` and a usable string-safe filesystem device/inode identity; an all-zero identity fails closed. Mutation barriers, current selections, pending starts, active processes, and already-stopping children use that package-root identity, so `python`, `python3`, absolute paths, symlinks, Windows junctions, and Linux `/proc` aliases cannot mutate one environment concurrently. Dependency-cache entries additionally include the normalized executable and exact Python version, preventing distinct minor versions under one `/usr` prefix from sharing results while keeping broad alias invalidation.
- Runtime shutdown registers its exact stopping child before clearing active ownership or disposing a caller-supplied cancellation listener. A deliberately throwing listener cannot leak an untracked live child or let pip overtake quiescence. Exact close remains the only post-spawn exit proof; focused tests cover the full ten-minute command bound, one-time unref, same-error shutdown latching, barrier retention through late close, and zero post-disposal cache/UI publication.
- Approval now carries a target-scoped authorization epoch. After every matching runtime has quiesced, the bridge freshly resolves the selected interpreter and rechecks Workspace Trust, normalized executable, exact Python version, canonical root identity, requirements, lifecycle, and barrier ownership with no intervening await before spawn; an applicable configuration, Python-environment, trust, path, version, or filesystem-identity change launches no pip process, while an unrelated scope cannot cancel the approved target.
- The owned command is exactly `python -I -m pip install --no-input --no-user ...`. It disables pip configuration, denies every inherited `PIP_*` behavior except an explicit index/proxy/certificate/cache/network allowlist, and forces owned noninteractive/no-user values. Absolute and PATH-resolved interpreters both use a private mode-0700 empty directory through exact close; cleanup removes only that empty directory without recursive deletion. A successful install releases its barrier and scope lease before publishing its no-action information notification, so notification dismissal cannot block safe runtime reuse. The terminal real-editor scenario clicks the production modal against a private no-network fake pip interpreter, verifies exact isolated argv, disabled pip configuration, explicit no-user policy, private working-directory lifecycle, and sanitized environment, initiates the same bridge shutdown used by deactivation, proves both shutdown and command wait without signalling the child, then releases it and requires natural completion, false post-disposal command status, and zero runtime/session ownership.
- The hidden development-host gate passes on minimum VS Code 1.105.0 and current VS Code 1.130.0 with that terminal scenario. Its source fixtures now live in a per-run copied workspace, so an interrupted run cannot leave a stale temporary interpreter configured in the repository.
- Interpreter discovery additionally rejects workspace-shadowed bare commands, empty or relative `PATH` entries, incomplete Windows drive/UNC paths, batch launchers, and downstream paths that are not fully qualified. A launcher or wrapper may identify only one direct absolute `sys.executable`, which is re-probed before use without resolving a virtual environment through its base interpreter. Windows discovery uses only `py.exe -0p` with manager auto-install and legacy path search disabled, then validates a registered Python 3.10 to 3.14 executable. The development-host missing-dependency scenario now uses the same direct no-pip virtual-environment shape on every platform, so acceptance cannot accidentally validate a shell-wrapper behavior that production intentionally pins through.
- The full validation state is green: 181 of 182 editor-runner tests pass with the native-Windows-only case intentionally skipped, 1,038 of 1,039 TypeScript tests pass with one intentional skip, and all 984 Python tests pass. TypeScript coverage is 86.43% statements, 81.72% branches, 91.04% functions, and 89.62% lines; Python coverage is 89.90%.
- The canonical prerelease VSIX built from `f3c8600` verified with 70 allowlisted entries, 556,562 bytes, and SHA-256 `e4acef5881e58bde353776b01567d1a647f17709e2d93f1164cf3d645c09e3bc`. Those exact bytes passed the complete packaged harness in a fresh zero-window VS Code 1.130.0 profile and a private Xvfb Cursor 3.13.10 profile. Both editors exercised the production confirmation modal and terminal child-ownership scenario, finished with zero runtime/session ownership, deleted their disposable roots, and could not open or focus a window on the user's desktop.

This implements the in-process and development-host ownership gate tracked in [issue #76](https://github.com/Matt17BR/openwrangler/issues/76) without changing parity status. Persistent host/OS interruption recovery remains [issue #79](https://github.com/Matt17BR/openwrangler/issues/79); the bounded dependency-probe slice is recorded next. No parity-complete or 1.0 claim follows from this slice.

Single-flight and bounded dependency probes, 2026-07-26:

- Dependency probes coalesce only under an exact canonical identity containing the package-root filesystem identity, normalized fully qualified executable, exact Python version, and every field of every ordered dependency descriptor. A descriptor difference cannot share work even when two install specifications are identical.
- In-flight ownership is exact-object based. Scope invalidation, package mutation, same-key replacement, and shutdown detach every joined consumer; old success or rejection cannot delete, cache, or publish over the replacement. The deferred launch boundary rechecks ownership, bridge lifecycle, and the package-mutation barrier before a subprocess can start, so an overtaken probe cannot race pip or survive shutdown merely because its launch microtask was already queued.
- Successful completed results use a separate 128-entry least-recently-used cache whose hits refresh recency. Resource-scope eviction neither owns nor extends those entries. Probe errors remain uncached and retryable, missing requirements preserve descriptor order, and shutdown does not cancel or await a probe process that already started.
- Focused bridge coverage passes all 121 tests, including exact cross-scope single-flight, every descriptor field, old success/rejection versus replacement, same-key replacement before and after launch, the post-publication/pre-consumer boundary, package-root-wide invalidation, pre-launch shutdown and mutation, failure retry, hit refresh and 129th-entry eviction, and late completion after shutdown. The complete local suite passes 181 of 182 cross-platform runner tests with the native-Windows-only test skipped, 1,071 of 1,072 TypeScript tests with one intentional skip, and all 984 Python tests; strict formatting, linting, type, protocol, reference, documentation, and license checks are green.
- Native import-option commands now coalesce renderer, fallback, manual, and concurrent title-action paths under one complete transaction that remains pending through every prompt and runtime reconfiguration. Delayed grid virtualization, page retry, operation-dialog, and insights-drawer focus restoration retains ownership only while the webview document owns host focus and rechecks immediately before each focus call. Component regressions cover both focus-transfer directions, while packaged acceptance remains observation-only and never assigns focus itself.
- The canonical prerelease VSIX built from product commit `c0df7ea` verified with 70 allowlisted entries, 558,367 bytes, and SHA-256 `b60d1403b8a4b4ab5a859f1e5652c11c5b19e7b61228eac594d5947f787beafc`. Those exact bytes passed the complete packaged harness in a fresh zero-window VS Code 1.130.0 profile and a private Xvfb Cursor 3.13.10 profile against `ms-python.python@2026.4.0`, including the editor-title import action and every production prompt. Both runs completed with zero retained session or runtime and could not open or focus a window on the user's desktop.
- [Hosted CI run 30193144051](https://github.com/Matt17BR/openwrangler/actions/runs/30193144051) is green for the same product commit across validation, coverage, Python 3.10 and 3.14, minimum and current VS Code extension hosts, Linux packaged-editor acceptance, and native macOS and Windows packaged-editor acceptance. Every packaged-editor phase completed successfully and retained no failure diagnostics.

This completes implementation and acceptance for [issue #77](https://github.com/Matt17BR/openwrangler/issues/77). The slice is ready to merge through its stacked branch sequence. It hardens runtime selection without changing any user-visible parity row and is not a parity-complete or 1.0 claim.

Persistent dependency-mutation recovery, 2026-07-26:

- The selected interpreter now runs dependency changes through a bundled stdlib-only guard. One package-root-local OS lock covers durable exclusive marker creation, READY, exact-token GO authorization, isolated in-process pip, guard close, and later validation. Host loss before GO cannot begin package writes; host or operating-system interruption after GO leaves a UUID marker while the OS lock remains authoritative for whether the exact writer is still alive.
- Windows journals and leaves use a protected current-user/LocalSystem/Administrators DACL whose owner, protection flags, and exact ACE allowlist are validated through no-follow handles. The exact journal stays pinned against replacement for the complete OS-lock critical section; a broadened or inherited existing v1 journal fails closed without repair or deletion.
- Every standalone open reads guard status before consulting completed dependency probes or starting/reusing a runtime. Dirty, busy, malformed, unreadable, identity-changed, stale, and timed-out states fail closed as `dependency_environment_uncertain`; aliases of one canonical package root share the same block. Retained extension-host state is bounded and advisory, while the package-environment journal remains authoritative across VS Code/Cursor restarts.
- The zero-argument **Revalidate Runtime Dependencies** command is Workspace-Trust-gated and acts only on an exact host-retained selection, full executable/root identity, and marker token discovered from the guard. It checks fresh status before its modal, repeats identity, trust, selection, mutation-barrier, and exact-token status checks after confirmation and runtime quiescence, then asks a separate lock-owning validator to import and version-check the marker's recorded dependencies. Only a correlated exact-token validation removes the marker and reports success. A live writer remains busy; a changed marker requires a fresh confirmation.
- There is no token-bearing public argument, Clear, Ignore, expiry, record-only deletion, user-attestation bypass, or modal-free affirmative test API. Install and recovery are locally mutually exclusive, and stale completion can affect only its own exact UUID. The environment-gated extension test API exposes only deterministic decline.
- The canonical prerelease VSIX built from product commit `433c181` contains 71 allowlisted entries, is 584,979 bytes, and has SHA-256 `8cde02f78520be77b0163d5278ca2c3241d8a4792a5d81dc53da241edae5eb1b`. Those exact bytes passed the complete isolated package matrix in VS Code 1.130.0 on zero-window headless Ozone and Cursor 3.13.10 on a private Xvfb display. Separate opt-in runs in both editors installed and verified the pinned `ms-python.python@2026.4.0` VSIX and passed the released environment API's A → B → A selection/recovery phase. Each editor proved that an authorized guarded writer survives disposable-parent loss, blocks opens and recovery while its lock is live, retains uncertainty after writer exit and modal dismissal, clears only its exact marker after confirmed import/version validation, reopens the source, and finishes with zero retained sessions or runtime ownership. No run opened a desktop window or used a normal editor profile.
- The clean-source strict Polars benchmark at the same commit records 70.354 ms and 52.265 ms cold stdio open-to-first-grid protocol round trips for the 100k × 50 CSV and 1m × 20 Parquet fixtures. CSV/Parquet direct-manager cache-miss p95 is 32.142/35.922 ms, direct cached p95 is 0.137/0.081 ms, and real stdio cache-miss p95 is 31.060/37.097 ms; both fixtures close with zero retained sessions. These are runtime/protocol measurements, not editor-paint claims.
- [Hosted CI run 30199788071](https://github.com/Matt17BR/openwrangler/actions/runs/30199788071) is green for validation, coverage, Python 3.10 and 3.14, minimum/current VS Code extension hosts, and native macOS/Windows packaged-editor acceptance. [Cross-platform run 30199788072](https://github.com/Matt17BR/openwrangler/actions/runs/30199788072) is green for native Windows dependency guards on Python 3.10, 3.12, and 3.14 plus Linux, macOS, and Windows runtime suites; [CodeQL run 30199788065](https://github.com/Matt17BR/openwrangler/actions/runs/30199788065) is green for TypeScript and Python.

This hardens the existing **Done** runtime-selection row and completes the implementation and acceptance evidence for [issue #79](https://github.com/Matt17BR/openwrangler/issues/79). It does not close the remaining 1.0 gates or make a parity-complete claim.

Stable-ID column summaries and Insights polish, 2026-07-27:

- Summary requests now address the current schema by stable column ID. The runtime resolves IDs against exact positions, validates one matching result per request in order, and rejects missing, duplicate, unknown, or reordered output before it reaches coordinator state. Pandas duplicate and non-string labels are profiled positionally; Polars and DuckDB retain their validated native names. Saved snapshots, retained panel state, native Summary views, and React consumers use the same ID association.
- Exact scalar values are visually separated from distributions. Numeric column headers and the Summary drawer include minimum and maximum, while compact numeric, categorical, boolean, and datetime visuals expose useful visible labels and accessible names. A sampled label belongs only to evidence explicitly marked sampled and never qualifies exact counts or scalar statistics. Duplicate display labels use human positional disambiguation without leaking private IDs.
- The Insights drawer remains a nonmodal complementary landmark. Mouse and keyboard opening move focus to its deterministic Close control; Escape closes it and restores the exact connected opener when the webview still owns focus. The toolbar toggle declares the controlled region.
- Contract, engine, snapshot, coordinator, host-retention, native-view, React, screenshot, and axe regressions cover duplicate labels, out-of-order arrival, replay, all four summary families, 800px width, 200% zoom, non-color chart meaning, and exact focus return. The packaged live-Pandas acceptance requests both duplicate-label profiles before operations and again after a real kernel replacement.

This strengthens the existing **Done** dataset-summary row and the still-**Partial** release-platform visual/accessibility row for [issue #90](https://github.com/Matt17BR/openwrangler/issues/90). Broader workbench hierarchy, information-density, and interaction redesign remains explicitly post-1.0 work in [issue #88](https://github.com/Matt17BR/openwrangler/issues/88); it does not expand this bounded release slice. This does not close unrelated 1.0 gates or make a parity-complete claim.

Selected-column Insights hierarchy, 2026-07-29:

- Insights now opens on one stable selected column instead of rendering an accordion for every schema column. The focused view exposes exact numeric min, max, mean, median, and standard deviation; explicit datetime bounds and boolean counts; categorical and string top values; and visible null, NaN, distinct, empty-string, exact, and sampled labels.
- Live numeric distributions now count every finite value into at most 20 deterministic equal-width bins. Pandas computes the complete column directly, while Polars, DuckDB, and PySpark retain lazy/native execution and return only aggregate bin counts. Tests cover constant columns, empty/non-finite inputs, interior-edge placement, inclusive maxima, sparse tails beyond the former 4,096-row sample boundary, and count totals. Both grid headers and Insights render the same full-width chart; each bin exposes its exact interval and row count by hover, keyboard focus, and accessible name.
- Dataset and Filters are separate tab panels. Exact dataset statistics start only in Dataset, distinct-value work starts only in Filters, and leaving either view cancels its pending request. Duplicate display names remain positionally disambiguated while name-addressed viewing controls fail closed.
- Component coverage proves selected-column ownership transfer, stale-response rejection, rollback, duplicate-label safety, view-specific cancellation, and roving Arrow, Home, and End tab navigation. Production-bundle axe scans cover all three views at 800px and 200% zoom. A local wide-grid run recorded cached and uncached p95 interaction times of 32.0ms and 92.3ms.

This advances the chosen selected-column direction in [issue #88](https://github.com/Matt17BR/openwrangler/issues/88). The draft-review hierarchy is completed in the bounded slice below; the broader command-row redesign, refreshed packaged-editor screenshots, and complete VS Code and Cursor evidence remain follow-up work, so the issue stays open.

Exact text-column Insights, 2026-07-30:

- Protocol-v2 summaries may now carry an optional, backward-compatible `text` block for semantic string columns. Empty strings are counted exactly without trimming; nulls are excluded; and minimum, maximum, and mean lengths count Unicode code points rather than UTF-8 bytes or UTF-16 code units. An all-null text column reports zero empty strings without inventing length bounds.
- Pandas and eager Polars compute the metrics within their native frames; lazy Polars, DuckDB, and PySpark return only fixed-size native aggregate results. Pandas mixed-object and non-string categorical values measure the exact normalized text shown by grid cells, and conversion guards reject any detour through another dataframe engine. Saved notebook snapshots apply the same semantics to their bounded captured truth.
- Selected-column Insights exposes **Empty**, **Min length**, **Max length**, and **Mean length** beside the existing null, distinct, and top-value evidence. It omits an irrelevant zero-valued NaN row for text but preserves a positive Pandas NaN count. The deterministic text fixture `[null, "", "A", "é", "e\u0301", "😀"]` produces null `1`, empty `1`, minimum `0`, maximum `2`, and mean `1`.
- Contract, React, and all-engine regressions live in `src/test/protocolValidation.unit.test.ts`, `src/test/filterSummary.component.test.tsx`, and the four engine test modules. `scripts/capture-screenshots.mjs` and `scripts/test-webview-accessibility.mjs` exercise the real Pandas-produced metrics in an 800px selected-column drawer with keyboard focus restoration and axe coverage.

This closes the text-statistics sub-slice of [issue #88](https://github.com/Matt17BR/openwrangler/issues/88), not the issue's remaining workbench redesign or performance-comparison scope.

Compact draft-review hierarchy, 2026-07-31:

- A pending cleaning operation now uses one compact **Draft review** region for the human-readable operation, exact ordered schema diff, warnings, and one **Discard** / **Apply step** action pair. The data grid remains visible instead of being displaced by a second tall editor surface.
- Generated cleaning code appears only in the native **Code Preview** panel. Draft review and applied-step inspection no longer repeat a second inline code block, while the existing editable code-preview workflow remains unchanged.
- Production-bundle screenshot and axe acceptance covers ordinary and by-example drafts at 1280px, 800px, and 200% zoom. The checks require the review and grid to remain visible, keep overflow inside the grid scroller, preserve warning text exactly once, and reject duplicate code or action clusters.
- React regressions cover draft creation, apply/discard, applied-step inspection, and Code Preview publication; native-view and coordinator tests retain the same draft ownership and command boundaries.

This completes the draft-review sub-slice of [issue #88](https://github.com/Matt17BR/openwrangler/issues/88). The permanent command/status row and refreshed installed-editor visual evidence remain open.

Grid status and profile vocabulary, 2026-07-31:

- Row-block navigation now follows the scrolling table in a slim, non-sticky status bar. Transparent Previous and
  Next Codicon buttons retain their exact accessible names and native disabled behavior, while a separate polite,
  atomic **Visible rows** status announces only `Rows 1\u2013200 of 100,000` or `No rows`; PySpark
  instead says that the total appears after the last page until terminal promotion. Exact ranges use the same plain
  `Rows … of …` copy for every engine. The escape denotes the rendered U+2013 en dash.
- The selected-column surface is now visibly **Column profiles** and exposes the encompassing accessible name
  **Column profiles and filters**. Its established region and tab IDs, deterministic Close focus, Escape handling,
  exact opener restoration, and Column / Dataset / Filters ownership remain unchanged.
- Grid-header summaries remain an independent **Header profiles** toggle with a constant name and `aria-pressed`.
  `openWrangler.insightsOnOpen` keeps its public key and behavior. R and PySpark start this toggle off, with a tooltip
  explaining the profiling work that an explicit click starts.
- React, production-bundle screenshot, axe, forced-colors, narrow-width, 200%-zoom, packaged-layout, and PySpark
  media assertions cover direct status-bar placement, exact range text, Codicon presence, pressed state, and
  unclipped controls. Dedicated 100,000,000-row terminal fixtures prove the exact
  `Rows 99,999,801\u2013100,000,000 of 100,000,000` range at 320 CSS pixels and 200% zoom without status-bar,
  application, or document overflow. Historical Insights evidence above remains evidence for the behavior tested
  at that time.

This completes the bounded permanent grid-status sub-slice of [issue #88](https://github.com/Matt17BR/openwrangler/issues/88). Broader command-row redesign and refreshed installed-editor release evidence remain follow-up work; this does not make a parity-complete claim.

Lossless integer and decimal extrema, 2026-07-31:

- Protocol-v2 numeric summaries may carry a backward-compatible, paired `exactMin` / `exactMax` typed-cell
  encoding for integer and decimal columns. Existing JSON-number fields remain available for older consumers and
  approximate mean, median, standard deviation, and histogram math.
- Pandas, eager and lazy Polars, DuckDB, and PySpark reuse their already-computed native aggregate
  extrema; saved notebook previews compare the bounded captured typed cells directly. Conversion-trap tests
  prohibit Polars, DuckDB, and PySpark from detouring through another dataframe engine.
- Column headers and **Column profiles** prefer the lossless value while bounding the visible extrema so unusually
  long integers and decimals cannot distort the grid or drawer. The complete value remains available in the
  tooltip and accessibility text, so values outside JavaScript's safe range never silently round or disappear.
- Protocol, snapshot, engine, component, production-bundle screenshot, and axe regressions cover both field
  presence and display. Validation rejects partial pairs, wrong semantic types, null/NaN cells, malformed or
  non-canonical encodings, unsafe integers transported as numbers, and reversed extrema.

This strengthens the existing **Done** dataset-summary row and advances the column-profile polish tracked in
[issue #88](https://github.com/Matt17BR/openwrangler/issues/88). It does not change the viewing-only PySpark
surface defined above.

Released-Jupyter argument provenance slice, 2026-07-26:

- The variable-viewer command accepts `IJupyterVariable.fileName` as an actual `vscode.Uri` or the exact canonical JSON envelope produced when that URI crosses the Variables webview. The serialized form is accepted only after bounded component, descriptor, cache, Unicode, and exact round-trip validation; origin aliases fail closed.
- The command captures the sole open `NotebookDocument` for that URI at receipt. String lookalikes, conflicting fields, duplicate same-URI document objects, closure, and same-URI replacement all fail closed without reading or retargeting through the active notebook editor.
- Focused provenance coverage uses the released argument shape with another notebook active, verifies exact-object handoff into kernel acquisition and session coordination, and exercises malformed, conflicting, duplicate, agreeing, and replacement cases.

The notebook-variable row remains **Partial**. This slice closes the released command-argument mismatch, and the local packaged run recorded below closes the released-Jupyter functional gate for VS Code 1.130.0 and Cursor 3.13.10. Real remote-kernel and remaining release-platform evidence are still tracked in [issue #52](https://github.com/Matt17BR/openwrangler/issues/52).

Released-Jupyter packaged acceptance harness, 2026-07-26:

- The opt-in packaged harness pins and verifies `ms-toolsai.jupyter@2025.9.1`; optional extension-pack members are not treated as the compatibility gate. It uses separate private allow/deny profiles, workspaces, kernelspecs, and Jupyter/IPython roots. Both phases keep the real workbench on the zero-window CDP path.
- The runner derives exact `ipykernel`, Pandas, and Polars versions from the selected interpreter, installs their binary wheels into a disposable private kernel environment, and fails if that environment can already resolve `openwrangler_runtime`. Ordinary packaged-editor phases continue using the selected project interpreter.
- The acceptance contract drives Jupyter's actual consent dialog and Variables action plus Open Wrangler's notebook toolbar, covering Pandas and Polars DataFrame/Series values, automatic MIME v2 rendering and expansion, exact-origin generated-code insertion, restart/replay, and terminal session/kernel cleanup.
- Every notebook cell result must follow a fresh execution-summary event. Restart recovery observes the released stable API's real kernel status transition back to idle, proves the process changed, and proves the replacement kernel again lacks the runtime before Open Wrangler retransfers and replays it. A persisted denial must reach a new terminal panel error without another consent prompt.
- `.github/workflows/released-jupyter.yml` makes the VS Code phase manually dispatchable without adding it to required pull-request CI. Failures use the hardened exact-path sanitized-evidence handoff.

The notebook-variable row remains **Partial** pending the real remote-kernel and remaining release-platform evidence tracked in [issue #52](https://github.com/Matt17BR/openwrangler/issues/52). The local combined run below closes the released-Jupyter functional gate for both supported Linux desktop editors.

Real remote-Python Jupyter acceptance harness, 2026-07-26:

- The opt-in Linux phase uses the same packaged VSIX and pinned released Jupyter extension against a real Jupyter Server in an unprivileged, read-only, resource-bounded Docker container. The image is digest-pinned, every Python wheel is hash-locked, the exact kernelspec is proven through the authenticated server API, and no checkout/runtime path is mounted into the container.
- A run-derived hostname and public correlation ID prove remote identity. The private token has one redaction-friendly fixed shape, enters through bounded stdin and atomic private-file publication, and reaches the editor only through an owned mode-0400 descriptor under its isolated root. It is absent from Docker metadata, phase envelopes, logs, and workflow configuration.
- The remote phase follows the released server-collection and workbench kernel-picker path, then runs the existing Pandas/Polars DataFrame/Series, MIME-v2 renderer, exact-origin insertion, runtime-transfer, kernel-restart, plan-replay, and zero-session contract. Cleanup reattests the Docker engine and exact labelled container/image; ambiguous completion or disappearance suppresses evidence and preserves the private root.
- `.github/workflows/released-jupyter.yml` exposes this phase through manual dispatch. Pull requests use the unit, renderer, and extension-host contracts; preview and stable release candidates rerun the real packaged Jupyter journey before publication. The exact hosted acceptance recorded below is the authoritative Docker-backed Python result.

Local released-Jupyter evidence, 2026-07-26:

- The 70-entry, 592,787-byte packaged preview VSIX built from product commit `3b9c000` has SHA-256 `295183cee93dce7843a7470ddab47b2014e231b585e8b7bceb3e3bbdb96f359a`. Those exact bytes ran against VS Code 1.130.0 and Cursor 3.13.10 with `ms-toolsai.jupyter@2025.9.1`; the corrected exact-overflow acceptance harness is commit `23895f8`.
- Both editors passed the independent released-Jupyter deny and allow profiles on private Xvfb displays. The persisted consent-deny flow reached its terminal Open Wrangler diagnostic, while the allow flow selected the private kernel and used Jupyter's actual Variables action to open the exact Pandas notebook through the serialized `fileName` envelope. Neither editor used a normal profile, opened on the user's desktop, or retained its private run root.
- The allow flow passed exact-origin code insertion, freshly emitted MIME-v2 output, the nested packaged renderer action and snapshot expansion, Open Wrangler's notebook-toolbar input, Pandas and Polars DataFrame/Series sessions, the documented viewing-to-editing mode change, engine-native Polars preview/apply, kernel restart with plan replay, and terminal cleanup with zero retained sessions or kernel descendants.
- The renderer proof came from the same-origin nested guest's 716×107 preview and enabled 157×23 action. The outer custom-output host element measured 732×0 and was explicitly not used as renderer evidence. Each invocation then passed the ordinary packaged Restricted Mode, persistence seed, three-engine recovery/export, workbench, and final cleanup phases.

Exact released-Jupyter and remote acceptance, 2026-07-27:

- Exact head `c35940b9e1c78d09a6a8e147fcdcb26c4bd7e1dd` passed [released-Jupyter run 30225658199](https://github.com/Matt17BR/openwrangler/actions/runs/30225658199). One isolated, unfocused packaged VS Code invocation completed both the pinned released-Jupyter allow/deny contract and the separately owned digest-pinned Docker/Jupyter Server phase against the same verified 70-entry VSIX. It covered real Pandas/Polars DataFrame and Series values, Variables and notebook-toolbar launches, MIME v2 rendering, exact-origin insertion, runtime transfer, restart/replay, and terminal cleanup.
- The same head passed [CI run 30225658227](https://github.com/Matt17BR/openwrangler/actions/runs/30225658227), including minimum/current extension hosts and native macOS/Windows installed-editor acceptance; [cross-platform run 30225658207](https://github.com/Matt17BR/openwrangler/actions/runs/30225658207), including all declared runtime and Windows dependency-guard cells; and [CodeQL run 30225658242](https://github.com/Matt17BR/openwrangler/actions/runs/30225658242). No native or remote phase was retried, and no failure artifact was produced.
- Together with the recorded VS Code 1.130.0 and Cursor 3.13.10 local packaged runs above, this advances **Notebook variable viewer and toolbar** to **Done** and closes [issue #52](https://github.com/Matt17BR/openwrangler/issues/52). It does not close the remaining first-usable-grid timing or other 1.0 rows.

Bounded aggregate Python environment resolution, 2026-07-27:

- Every interpreter-selection attempt now owns one 30-second monotonic deadline spanning optional Python-extension activation and selected-environment lookup, system discovery, candidate probes, and a reported-executable re-probe. Individual subprocesses retain a 10-second ceiling reduced to the exact remaining aggregate budget. An explicit `openWrangler.pythonPath` remains authoritative and cannot silently fall through.
- Windows launcher results are parsed, case-insensitively deduplicated, ranked by supported minor version descending, normal ABI before free-threaded ABI, then normalized path, and capped at 16 candidates before filesystem checks. Linux and macOS preserve their fixed `python3`, then `python` order.
- Each unresolved resource selection owns an exact abort controller. Request cancellation, configuration or Python-selection invalidation, Workspace Trust loss, timeout, supersession, broker disposal, bridge disposal, and shutdown settle the old attempt without launching more candidates. Exact-object/current/trust guards prevent its late success or rejection from publishing, caching, deleting, or replacing a newer same-key selection. A timed-out caller can detach from shared Python-extension activation, but only a compatible API may later be cached by the still-live broker.
- The deterministic resolver/API/bridge suites pass 244 focused tests, including virtual-clock activation and selection delays, synchronous terminal boundaries before API work, abandoned-promise rejection handling, launcher delay, candidate ordering/exhaustion, shared-budget exhaustion, wrapper re-probe, exact-deadline races, cancellation before and after confirmation, same-scope joiners, exact invalidation/shutdown abort reasons, disposal, trust loss, supersession, and deliberately late completion. The separate serial real-platform smoke passes locally on Linux and records only stable failure classification, stage, process count, and candidate limit.
- Strict formatting, linting, type, protocol, reference, documentation, and license checks are green. The complete local suites pass 265 of 266 cross-platform runner tests with only the native-Windows supervisor smoke skipped, 1,274 of 1,275 TypeScript tests with one intentional platform skip, and all 1,027 Python tests with 17 optional-engine skips. The final product code passes the isolated zero-window VS Code 1.130.0 extension-host seed/verify flow without opening or focusing a desktop window.

This implements the local foundation hardening for [issue #84](https://github.com/Matt17BR/openwrangler/issues/84) and strengthens the existing **Done** runtime-selection row without changing parity status. Hosted Linux/macOS/Windows smoke plus minimum/current extension-host evidence remain required on the final pull-request commit. This is not a new engine, parity-complete, or 1.0 claim.

First-class editor platform and Remote SSH acceptance, 2026-07-27:

- [CI run 30277495429](https://github.com/Matt17BR/openwrangler/actions/runs/30277495429) for PR head `32706d60d55e9dde18c09d1a94c440358f9fcf42`, tested as synthetic merge `5d461d7e95366451586338868f7e40c613a30047` into base `10e55225172253c32fd8268cb50e384232ba4fed`, produced one 70-entry, 605,541-byte canonical VSIX with SHA-256 `66b62609899286ab3590f900588cf9afee9afe293b52bb4f1372ae7420397715`. CI reused those bytes for Linux packaged VS Code validation, native editor jobs, and Remote SSH without rebuilding the package; separate minimum/current extension-host jobs tested the same PR head.
- Stable VS Code passed the full isolated packaged harness on macOS 26.4 arm64 and Windows Server 2025 x64. Cursor 3.13.10 then passed the bounded platform smoke using its signed official macOS-universal and Windows-x64 artifacts in the same [macOS job](https://github.com/Matt17BR/openwrangler/actions/runs/30277495429/job/90016714183) and [Windows job](https://github.com/Matt17BR/openwrangler/actions/runs/30277495429/job/90016714101). The smoke covered gallery and Activity Bar icons, all four native views, VS Code theme tokens, file launch, grid keyboard navigation, source immutability, and terminal cleanup; the previously recorded Linux Cursor suite remains the deeper functional gate.
- The same candidate passed one [Remote SSH job](https://github.com/Matt17BR/openwrangler/actions/runs/30277495429/job/90016714005) on Ubuntu 24.04 Linux x64 with official VS Code 1.130.0 (`1b6a188127eeaf9194f945eb6eb89a657e93c54c`) and Remote SSH 0.124.0 (742,378 bytes; SHA-256 `1a891224e1291e89a405b90f5018555d6642ac66e2e68653970e4f155d766416`). The one-shot loopback fixture retained the remote authority and source, opened/paged/filtered through resource-scoped Python and Polars, preserved source bytes, ended with zero sessions or runtime, and verified complete editor, SSH, display, namespace, and private-root cleanup.
- The exact head also passed [cross-platform runtime run 30277495296](https://github.com/Matt17BR/openwrangler/actions/runs/30277495296), [released-Jupyter run 30277497874](https://github.com/Matt17BR/openwrangler/actions/runs/30277497874), and [CodeQL run 30277495873](https://github.com/Matt17BR/openwrangler/actions/runs/30277495873). No editor phase or Remote SSH attempt was retried, and successful editor/Remote phases produced no failure-diagnostic artifact.

This advances only **Original icons, native views, themes, accessibility** and **Cross-platform first-class editor package acceptance** to **Done**. Native Cursor on macOS/Windows is a bounded platform smoke, and Remote SSH evidence is the pinned Linux-x64 loopback fixture rather than every remote provider or host. At this checkpoint, installed-editor first-usable-grid performance and virtual-grid timing remained **Partial**; the later hosted record below closes them. Experimental VS Code forks and DuckDB completion are not implied.

Ambiguous Pandas viewing-name hardening, 2026-07-27:

- Live Pandas filters, sorts, and distinct-value lookup now reject both duplicate raw labels and distinct raw labels whose string forms collide, matching the existing saved-snapshot fail-closed behavior. Standalone and notebook transports preserve request and view correlation while returning the structured `ambiguous_view_column` diagnostic.
- The grid and Filters / Sorts drawer explain the ambiguity, distinguish selector entries by position, and disable only controls that would emit a name-addressed query. Stable-ID cleaning operations, paging, profiling, resizing, selection, and clear actions remain usable.
- Focused Pandas runtime, standalone protocol, kernel protocol, and React tests cover true duplicates and integer-`7`/string-`"7"` collisions. This closes a silent-first-column correctness gap without changing the status of any parity row or replacing packaged-editor evidence.

Installed-editor grid and performance acceptance, 2026-07-28:

- Exact source `cfc30e4fdb77711f9007b598bb9ad099dfcf5ca6` passed the single, non-retried [hosted evidence run 30320866354](https://github.com/Matt17BR/openwrangler/actions/runs/30320866354). Its sealed `openwrangler-installed-performance-evidence-report-v1` report is artifact `8674099196`, 92,583 bytes, with SHA-256 `46d7519df26890c44e5168be7d417da5c52713450cba4f5579e3b7673e3fcdee`; the report's evidence verdict is green with no failures.
- Official VS Code 1.130.0 and Cursor 3.13.10 each retained all ten cold-source and ten warm-source samples for the 100k×50 CSV and 1M×20 Parquet fixtures. VS Code CSV/Parquet cold p95 was 1,086.365/1,466.276 ms and Cursor was 1,907.449/1,715.429 ms, below the 3,000/5,000 ms limits. Warm p95 was 711.511/639.252 ms in VS Code and 1,546.690/1,528.144 ms in Cursor.
- Production-grid cached/uncached p95 was 63.8/131.1 ms in VS Code and 96.8/148.2 ms in Cursor, below the 100/500 ms limits. Renderer-heartbeat p95 was 14.1/14.7 ms. Both editors completed the real filter and sort controls while renderer and foreground-page probes stayed responsive, observed active profiling, authoritatively cancelled their queued companion requests, and finished with verified process/session cleanup.
- The evidence artifact is deliberately non-promotable and was not reused as release bytes. It closes **Virtual grid, column sizing, navigation** and **Installed-editor first-usable-grid performance** for the Pandas/Polars 1.0 matrix; the ordinary stable candidate is built afresh from the all-rows-**Done** source.

Operation-builder ergonomics slice, 2026-07-28:

- Column-list parameters now use an explicit accessible checklist, so selecting several columns no longer depends on a platform-specific Ctrl/Cmd gesture. Ordered operations retain the order in which boxes were checked and continue to submit stable column IDs.
- Sort rules and group aggregations expose per-row move and remove controls while retaining at least one required row. Moving or deleting one row preserves every remaining column, direction/calculation, null placement, and alias.
- Deterministic schema compatibility is applied before preview: numeric formulas/scaling/rounding expose numeric columns, text operations expose strings, datetime formatting exposes dates/datetimes, group and by-example inputs exclude nested/unknown values, and each aggregation calculation updates its compatible value columns.
- Focused React coverage exercises these controls, duplicate labels, ordering, removal, dynamic aggregation compatibility, and unchanged stable-reference output. Runtime IR validation remains authoritative; this UI slice does not weaken engine or generated-code acceptance.

Complete-schema and native live-notebook UX slice, 2026-07-30:

- Column search now virtualizes the complete matching schema rather than truncating at 100 results. The packaged
  VS Code and Cursor runs open a 417-column session, expose `aria-setsize="417"`, keep fewer than 30 options
  mounted, navigate to column 417 with End, select it, and reveal its far-right grid header.
- Saved MIME-v2 rows remain a portable inline preview only. An unlinked output exposes no workbench action and
  tells the user to rerun the cell. A canonically linked output exposes one **Open in Open Wrangler** action that
  opens the complete current variable through the exact visible notebook and selected kernel with fresh live
  session and column identities; it never substitutes captured rows.
- One allowlisted development VSIX with SHA-256
  `e4c97d7abd311f1669742331ed54b7f1a7f8ae7ad43272051450adddd4c37575` passed the complete isolated packaged
  matrix in VS Code 1.130.0 and Cursor 3.13.10. The same bytes passed the pinned
  `ms-toolsai.jupyter@2025.9.1` allow phase in both editors against a synthetic 100,000-row
  connection-private `DuckDBPyRelation`: base and far pages, filtered multi-sort, progressive numeric summary,
  restored view state, explicit complete unfiltered paging, authoritative close, and post-close user-relation
  reuse all stayed native. Conversion traps made any Pandas, Polars, or Arrow route fail the phase.
- At this 2026-07-30 checkpoint, the independent PySpark phase failed after its cleanup path and was deliberately
  excluded from the slice's evidence. That historical failure is superseded by the later never-cancel/detach
  correction and green packaged PySpark evidence recorded in the current viewer matrix above; it is
  not a current release blocker.

Primary cleaning-plan command row, 2026-07-31:

- Applied-plan status, **Edit latest**, and **Undo** now form one accessible **Cleaning plan** group inside the
  primary toolbar. The former permanent second cleaning bar is absent, while the exact visible labels, documented
  shortcuts, loading/projection disabled explanations, and draft ownership rules remain unchanged.
- The group stays contiguous in DOM and keyboard order between **Add step** and **Export**, and reflows as one row
  at narrow widths instead of displacing the grid. Production-bundle acceptance measures 1280, 620, and 320 CSS
  pixels, effective 200% zoom, forced colors, containment, tab order, grid visibility, and axe results.
- When a keyboard-focused **Undo** removes the final applied step, focus returns to **Add step** only if the
  webview owned focus both when the mutation began and when the correlated response arrived, and that exact Undo
  button remains the focus origin. The advertised shortcut follows the same restoration rule only when invoked
  from that button. Failed, cancelled, host-originated, shortcut-originated-elsewhere, deliberately refocused, and
  background-tab mutations do not steal focus.
- Focused React coverage exercises the exact restoration and no-steal paths. Existing extension-host acceptance
  locates the same named group during apply, reopen, and undo without changing runtime, protocol, persistence, or
  cleaning-plan semantics.

This completes the bounded command-row implementation in
[issue #88](https://github.com/Matt17BR/openwrangler/issues/88). One exact 726,757-byte VSIX from source
`bd6733b` (SHA-256 `1d3eba830d7b57eb95ddd5d4ac1718bc58a03de7924b49155ab37e3b5ad0f709`) passed the isolated zero-window packaged
journey in VS Code 1.130.0 and Cursor 3.13.10, including automatic import, keyboard navigation, multi-sort editing,
exact profiles, draft/apply/discard, native code preview, export, replay, Undo, Activity Bar views,
dependency-decline recovery, source immutability, and terminal cleanup. The final slice was then integrated at
protected-main commit [`704b428`](https://github.com/Matt17BR/openwrangler/commit/704b428c76a3d00b81165d7b315e9c55e2f7b418),
whose [required CI aggregate](https://github.com/Matt17BR/openwrangler/actions/runs/30687070036),
[cross-platform runtime](https://github.com/Matt17BR/openwrangler/actions/runs/30687070052), and
[CodeQL](https://github.com/Matt17BR/openwrangler/actions/runs/30687070043) gates passed before the issue closed.
This evidence closes that bounded post-1.0 refinement; it does not claim universal feature parity or v1.2 release
readiness.

## Explicitly deferred from 1.0

Copilot operations, DuckDB Excel and `.duckdb` database-browsing surfaces, non-dataframe tensor/list renderers, telemetry, and vscode.dev runtime support are out of scope. They must not block the Pandas/Polars 1.0 matrix and must not be represented as supported. DuckDB notebook relations remain intentionally limited to native viewing plus their portable inline preview; cleaning, generated-code insertion, and data export are unavailable. PySpark's supported v1.2 surface is the local, viewing-only live-notebook matrix above. Editing, exports, saved output, running-request cancellation, external or authenticated Spark Connect execution, and provisioning are not supported. Packaged VS Code/Cursor and local kernel-recovery evidence is recorded above; any future expansion needs its own acceptance evidence rather than broadening the current claim by implication. Editor-tab and editor-title file launching are part of the current 1.0 surface and have the acceptance evidence recorded above; they are not a PySpark prerequisite or a separate engine expansion. Open VSX and Visual Studio Marketplace publication remain the final release priority after parity, hardening, exact-artifact acceptance, checksum, and GitHub prerelease gates, as defined in `docs/releasing.md`.

R support belongs to Open Wrangler 2 and does not change the v1 matrix. Its runtime and release boundary is recorded in
[`docs/decisions/0001-native-r-runtime.md`](decisions/0001-native-r-runtime.md).
