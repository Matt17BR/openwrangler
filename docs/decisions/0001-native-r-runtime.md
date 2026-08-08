# Native R runtime for Open Wrangler 2

- Status: Accepted; amended for owned R-document processes and active R terminals
- Date: 2026-08-03

## Context

Before work on v2 began, Open Wrangler handled dataframe work through Python. R support needs to keep R objects and
package semantics, including `data.frame`, tibble, and `data.table`. Sending those objects through Python would change types, null handling,
categorical behavior, and generated code. It would also make a Python environment an unnecessary requirement for an R
workflow.

R notebooks already have a well-defined execution owner: the selected IRkernel. The official VS Code R extension can
own a second kind of live session in its R terminal. Ordinary `.R` files can instead use an Open Wrangler-owned
process. R Markdown and Quarto use that same process model for a smaller feature: Open Wrangler runs their supported R
cells without taking over either extension's render process.

## Decision

Open Wrangler 2 runs R dataframes in R. It does not convert them through Python or use a Python compatibility
layer.

The host exposes a `RuntimeIdentity` derived from confirmed session metadata. The protocol keeps `backend` as its
engine discriminator. R sessions add an explicit dataframe flavor (`data.frame`, tibble, or `data.table`) so the UI
can describe the object without guessing from `backend`. Their `RuntimeIdentity.codeDialect` is `r.base`, which labels
the shared Code Preview as R without changing the private kernel transport.

The first implementation slice is a transport-neutral frame/page contract. It has these invariants:

- The producer runs in R and accepts only canonical base `data.frame`, tibble, and `data.table` classes.
- Standalone contract captures own an isolated R snapshot. `data.table` snapshots use `data.table::copy()`.
- A live IRkernel session keeps the verified variable binding instead. Each page, sort, or profile reads the current
  object through that binding and rejects a changed shape, schema, class, or row-name mode.
- Column identity starts from the source position but remains stable when editing moves a retained column. Duplicate
  and non-syntactic names remain usable without rewriting the source or assigning identity by name.
- R-specific factor, ordered-factor, Date, POSIXct, difftime, and integer64 metadata crosses the boundary explicitly.
- Plain-double `NA`, `NaN`, positive infinity, and negative infinity remain distinct typed values. Non-finite
  classed temporal values and fractional Dates are rejected instead of being relabeled or rounded.
- Display text does not inherit `options(OutDec)` or the process time zone. POSIXct values with a null or empty
  timezone display in UTC while retaining that original metadata, and reserved integer missing-value sentinels are
  never accepted as ordinary values.
- Read-only filters and sorts use the captured stable column ID and name. They remain stable with duplicate names,
  keep source row IDs, and never become cleaning steps. Filters support compound AND/OR logic, typed predicates, and
  selected values; sorts choose direction and missing-value placement independently for each key.
- Row, column, cell, factor-level, text, and encoded-payload limits are checked by the R producer and again by the
  TypeScript decoder. The producer accounts for metadata and cells while building a page and stops before allocating
  a complete oversized page or JSON string.
- Bounded explicit row names cross as row labels and remain attached to their source rows after sorting. Unsupported
  classes, nested columns, and unrecognized attributes fail before a page is published. The contract does not
  silently flatten them.

The live notebook slice now connects this contract to the shared workbench. `DataBackend` includes `r`, session
metadata records the R dataframe flavor, and `RKernelBridge` adapts the private R transport to protocol v2 and the
shared session coordinator. The notebook command discovers supported R variables and opens the same grid, Activity
Bar views, and profile drawer used by Python-backed sessions. The Python runtime does not decode or execute the
private R transport.

IRkernel is the first supported R transport. A notebook launch must stay bound to the exact `NotebookDocument` and
kernel captured when the user starts it. Kernel lookup, dispatch, recovery, and cleanup may not retarget through the
active editor, a matching URI, a replacement document, or another R session.

The active-terminal transport connects to the exact official R terminal selected before discovery starts. Open
Wrangler sends its bundled dispatcher through VS Code's public terminal API, uses private response files for bounded
requests, and lists supported dataframes in the Operations view. Opening an item transfers that same transport to the
workbench. Changing or closing the terminal invalidates the list and session; Open Wrangler never searches for a
replacement terminal or reads vscode-R's private storage, sockets, or process state.

The host creates the candidate session ID before dispatch and maps it to that kernel. A malformed, cancelled, timed
out, or stale open keeps a continuation on the original operation. When that operation settles, the host makes one
bounded direct close attempt for the known candidate on the same kernel; it does not look the kernel up again or retry
against a replacement. A kernel restart ends that kernel's sessions and invalidates the mapping. An operation that
never settles may detach from the UI, but its ownership record remains until the kernel ends or the continuation can
perform that close.

The current notebook viewer does not copy the complete dataframe when a session opens. It records the source binding
and structural descriptor, then reads current values for pages, filters, sorts, value searches, and profiles without
writing to the object. Column values return bounded counts and typed selections. Profiles and dataset statistics use
the current viewing filters, and the private dataset-statistics response binds its counts to the filtered row total
from the same request. Same-schema changes made in the notebook are therefore visible; structural changes ask the
user to reopen the frame.

Editing currently supports Filter Rows, Sort Rows, Drop Missing Rows, Fill Missing Values, Drop Duplicates, Rename
Column, Drop Columns, Select Columns, Clone Column, Convert type, Text Length, Lowercase, Uppercase, Find and replace,
Capitalize, Strip text, Split text, Round, Floor, and Ceiling. The first draft takes an isolated original: base data
frames and tibbles use R serialization, while data tables use `data.table::copy()`. The runtime keeps committed and draft results separate,
resolves every target by stable ID and captured name, and advances the session revision for preview, apply, discard,
latest-step replacement, and undo. Applied-step inspection replays only the selected plan prefix. The kernel returns
its code, input page, and output page separately, so two large pages are never forced into one response. Page
responses omit schemas; the host restores the exact schemas it retained for that plan step before publishing the
inspection.

Filter Rows and Sort Rows use the same typed rules as the read-only view, but become explicit cleaning steps only
when the user creates a draft. Each source row has a private stable identity that survives filtering, sorting, plan
history, and diff inspection. Active row counts are tracked separately from that source identity domain. Sort keys
are applied in priority order with stable ties and independent missing-value placement. Filtering distinguishes `NA`
from `NaN`. A filter keeps a compatible `data.table` key; an explicit sort clears it because the new row order no
longer follows that key.

Drop Missing Rows treats both `NA` and `NaN` as missing. It can remove rows when any selected column is missing or
only when all selected columns are missing. Drop Duplicates compares selected columns, or all columns when none are
specified, and can keep the first, last, or no row from each repeated group. Both operations keep source order,
stable row identities, explicit row names, and compatible data-table keys.

Fill Missing Values offers a typed value, an exact numeric median, the mean of a double column, or the most common
non-missing value for character, factor, and logical columns. It also accepts an ordered list of same-type fallback
columns and takes the first present value from each row. Directional fills use an explicit stable sort, restore the
original row order, and optionally leave missing runs above a chosen length untouched. Median, mean, and most common
value can also be calculated within selected groups. All-missing groups stay missing, as do groups where two or more
values tie for most common. Automatic methods ignore `NA` and `NaN`. Double columns can use linear interpolation
along an ordinary numeric, `Date`, or `POSIXct` coordinate. The coordinate must be complete, finite, and unique;
`integer64` coordinates are rejected. Factors, ordered factors, `integer64`, dates, and datetimes stay in their native
R types.
Active data-table key columns are rejected because changing a key value could invalidate the stored order.

Dropping columns keeps retained IDs stable and refuses to remove the final column. Selecting columns preserves the
chosen order. Cloning appends a copy with its own stable derived ID, which later steps can address directly. The
Text Length operation accepts character and factor columns, keeps `NA` values, and appends a derived integer column
whose stable ID can be used by later steps. It counts Unicode characters rather than encoded bytes. The operations
keep compatible data-table keys. The text operations accept character and factor columns, convert factors to
character, and keep `NA`. Lowercase, Uppercase, Capitalize, Strip text, and Find and replace either update the column
or append a character column with a stable derived ID. Find and replace can use literal text or a regular expression.
Strip text removes the default whitespace or a literal character set from both ends. Split text uses a literal
delimiter, appends a new character column, and returns `NA` when the requested part does not exist. An in-place change
to a data-table key column is rejected; choosing a new output column keeps the key and row order. Generated R repeats
the position and name checks and returns a copied result. Native, cross-language, and packaged-editor tests cover source isolation, executable
code, keyed data tables, duplicate names, non-syntactic names, row identity, and mixed plans.

Convert type replaces one column while keeping its stable ID, name, and position. It supports character, integer,
double, logical, Date, and UTC POSIXct output. An `integer64` source stays `integer64` when the target is integer.
Factors convert through their labels, failed parses become `NA`, and conversions that would lose units or `integer64`
precision are rejected. A keyed `data.table` column must be cloned before it can be converted. Generated R applies the
same checks and conversion rules.

Round, Floor, and Ceiling accept ordinary integer, double, and `integer64` columns. Ordinary integer and double
outputs are R doubles, while `integer64` outputs stay exact integers. The operations keep `NA`, `NaN`, `Inf`, and
`-Inf`. Round follows R's ties-to-even rule. A keyed `data.table` column cannot be changed in place, but the result can
be appended as a new column without changing the key.

IRkernel sessions can insert generated R into the exact `NotebookDocument` captured when the dataframe session
opened. The shared notebook helper creates one `r` cell and confirms that exact cell before reporting success. It does
not rediscover the notebook from the active editor after an await.

On macOS and Linux, R documents use a second supported transport. The command captures the sole open `TextDocument`, its version,
and its complete in-memory text. It starts a private `Rscript --vanilla` process in the source directory and evaluates
plain R once in a dedicated environment. Relative reads and `source()` therefore behave like the file itself,
while console output stays separate from the file-based request channel. The process owns every discovered dataframe
session and is stopped when its final panel closes. Generated code is inserted with one `WorkspaceEdit` only after the
same document object and version are rechecked; success requires the complete resulting text to match.

For `.Rmd` and `.qmd`, the command accepts top-level backtick-fenced `{r}` cells and a bounded first-line YAML block.
It blanks prose for display diagnostics but sends each enabled cell to R as a separate source unit. The process reads
and parses every unit before evaluating them in order in the shared document environment. This prevents syntax from
joining across cell boundaries. The command rejects alternate engines, indented R cells, later metadata blocks, raw
HTML/TeX containers, ambiguous option syntax, and unsupported YAML forms. It does not promise knitr or Quarto render
semantics; code that changes knitr defaults cannot change this lexical cell selection.

Generated R is appended to R Markdown or Quarto as a top-level `{r}` cell. R Markdown insertion rejects a generated
line that knitr would interpret as the end of the cell.

Direct `.R` execution remains disabled on Windows until the extension can own and stop every descendant process;
IRkernel notebook support remains available there.

The document command never infers ownership from a terminal, global R state, or a document path. The separate active-R
command works only with an exact official R terminal captured before it yields. Open Wrangler does not attach to a
Quarto or R Markdown render process and does not inspect private Quarto or vscode-R sockets, temporary state,
extension storage, or process-discovery details.

Public R builds use the `1.99.x` preview channel. A preview may ship only after `data.frame`, tibble, and
`data.table` viewing plus the advertised editing workflow pass real IRkernel tests and packaged VS Code and Cursor
acceptance. A stable 2.0 release must have native R transformation and generated-code coverage for every R surface it
advertises. The `.R` path may be advertised after its owned-process journey passes in packaged VS Code and Cursor.
Quarto and R Markdown may be advertised only after their owned-document journey passes the same release gates.

## Consequences

- The grid and transformation model are shared. Runtime processes, object ownership, type handling, and generated
  code stay native to the selected language and dataframe flavor.
- R viewing includes pages, compound filters, ordered sorts, value search and selection, and profiles. Editing mode
  currently adds Filter Rows, Sort Rows, Drop Missing Rows, Fill Missing Values, Drop Duplicates, Rename Column, Drop
  Columns, Select Columns, Clone Column, Convert type, Text Length, Lowercase, Uppercase, Find and replace, Capitalize,
  Strip text, Split text, Round, Floor, Ceiling, and Group and aggregate with generated R code. Generated R can be
  inserted into the originating IRkernel notebook or R document. R notebook sessions and local R document sessions
  opened in Editing mode can export their committed result as CSV or, when `nanoparquet` 0.5.1 or newer is installed,
  Parquet. The Parquet writer runs in the same R process and does not convert through Python, Arrow, or another dataframe. A
  document process exposes only its private artifact to the host;
  IRkernel returns offset-addressed canonical-base64 chunks from an artifact owned by that exact kernel. Both routes end in the
  extension-host atomic save path. Operations outside the current 21-operation set are not supported yet.
- Group sums keep ordinary R integer or `bit64::integer64` output. Base R and `bit64` do not have an exact 38-digit
  integer type, so the runtime rejects an out-of-range sum before publishing a result instead of stringifying it or
  routing it through another engine. Integer64 mean and median perform exact decimal addition before their final
  double result.
- Ordinary frames returned by `collapse::qDF()`, `qTBL()`, and `qDT()` use the existing data-frame, tibble, and
  data-table paths. Grouped `GRP_df` and indexed `indexed_frame` objects are outside the supported class contract.
- Dataframes from the active official R terminal use the same native R contract and workbench. Refresh and open stay
  pinned to that terminal, while **Run R Document** continues to own a separate process.
- The old R branches are design input only. Their speculative shared types and detached kernel timeout model will not
  be carried forward.
- R 4.4 and 4.5 contract tests must pass before a change to the producer or decoder can merge. Real IRkernel and
  packaged-editor tests remain required before any user-facing R claim.
- A preview label does not relax notebook ownership, cleanup, or packaged-editor acceptance.
