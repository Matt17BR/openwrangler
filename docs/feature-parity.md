# Feature parity matrix

This is the normative capability ledger for the current source. The generated [interface reference](reference.md) is
authoritative for command, setting, protocol, MIME, and operation names. The optional
[Data Wrangler comparison](performance-comparison.md) is retained as historical product evidence, not as a
stable-release gate.

**Done** is the standing capability status: the surface is implemented and backed by its current source or installed
owner. **Partial** means the capability is usable but remains deliberately limited or lacks evidence for part of its
claim. **Planned** means it is unavailable. **Out of scope** means it is deliberately unavailable for the stated
surface.

The Pandas and Polars rows below are required for stable releases.

| Surface                                             | Pandas |  Polars | Status  | Required evidence                                                                                                                                                                                         |
| --------------------------------------------------- | -----: | ------: | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CSV/TSV/Parquet/Excel/JSONL entry points            |    Yes | Partial | Partial | Native readers and file-launch surfaces; Windows Polars JSONL/NDJSON path limits remain in #986; test:python/tests/test_pandas_engine.py; test:python/tests/test_polars_engine.py; record:docs/testing.md |
| Notebook variable viewer and toolbar                |    Yes |     Yes | Done    | Exact-notebook discovery, Python Interactive, and installed Jupyter owner; test:src/test/notebookPreviewCoordinator.unit.test.ts; record:docs/testing.md                                                  |
| Inline notebook renderer and full-view expansion    |    Yes |     Yes | Done    | Bounded MIME rendering and exact live-value expansion; test:src/test/notebookRenderer.unit.test.ts; record:docs/testing.md                                                                                |
| Virtual grid, column sizing, navigation             |    Yes |     Yes | Done    | Projected virtualization, keyboard navigation, range copy, and column copy; test:src/test/webview.component.test.tsx; record:docs/testing.md                                                              |
| Dataset summary and quick insights                  |    Yes |     Yes | Done    | Native profiles, exact sums, typed extrema, and accessible charts; test:src/test/numericSummary.component.test.tsx; record:docs/testing.md                                                                |
| Basic and advanced viewing filters                  |    Yes |     Yes | Done    | Typed values, predicates, AND/OR composition, and filter history; test:python/tests/test_filter_logic.py; test:src/test/filterPanel.component.test.tsx                                                    |
| Multi-column viewing sorts                          |    Yes |     Yes | Done    | Ordered priorities and stable native execution; test:python/tests/test_pandas_engine.py; test:python/tests/test_polars_engine.py                                                                          |
| Editing mode and operation catalog                  |    Yes |     Yes | Done    | All 32 generated catalog operations and the installed picker; test:python/tests/test_operations.py; test:src/test/operations.unit.test.ts; record:docs/testing.md                                         |
| Draft preview and data diff                         |    Yes |     Yes | Done    | Typed identity diff plus preview/apply rollback; test:src/test/dataGridDiff.component.test.tsx; record:docs/testing.md                                                                                    |
| Cleaning-step history, edit, discard, undo          |    Yes |     Yes | Done    | Latest and earlier step edit/delete, suffix replay, discard, and undo; test:src/test/sessionCoordinator.planRewrite.unit.test.ts; record:docs/testing.md                                                  |
| Generated code preview and editing                  |    Yes |     Yes | Done    | Editable native code and runtime-equivalent execution; test:src/test/codePreviewSynchronization.unit.test.ts; record:docs/testing.md                                                                      |
| Sort/filter cleaning steps                          |    Yes |     Yes | Done    | Stable-reference live and generated contracts; test:python/tests/test_operation_edges.py; record:docs/testing.md                                                                                          |
| Select/drop/rename/clone/cast/formula/length        |    Yes |     Yes | Done    | Stable lineage, duplicate-label handling, and generated parity; test:python/tests/test_operation_edges.py; record:docs/testing.md                                                                         |
| Drop missing/duplicate rows                         |    Yes |     Yes | Done    | All public row-reduction modes and generated parity; test:python/tests/test_operation_edges.py; record:docs/testing.md                                                                                    |
| Fill missing values                                 |    Yes |     Yes | Done    | Typed global, fallback, directional, grouped, and interpolation methods; test:python/tests/test_operation_edges.py; record:docs/testing.md                                                                |
| One-hot and multi-label binarization                |    Yes |     Yes | Done    | Null, blank, collision, and generated-code parity; test:python/tests/test_operation_edges.py; record:docs/testing.md                                                                                      |
| Find/replace/strip/split/case transforms            |    Yes |     Yes | Done    | Text transforms, multi-output split, and portable regex extraction; test:python/tests/test_operation_edges.py; record:docs/testing.md                                                                     |
| Scale/round/floor/ceiling/datetime format           |    Yes |     Yes | Done    | Live/generated numeric boundaries and datetime contracts; test:python/tests/test_round_number.py; test:python/tests/test_operation_edges.py; record:docs/testing.md                                       |
| Group and aggregate                                 |    Yes |     Yes | Done    | Ordered groups and normalized numeric aggregation; test:python/tests/test_group_numeric_parity.py; record:docs/testing.md                                                                                 |
| Custom engine-native code                           |    Yes |     Yes | Done    | Trusted isolated input, output validation, and executable native code; test:python/tests/test_pandas_engine.py; test:python/tests/test_polars_engine.py                                                   |
| String/datetime/new-column by example               |    Yes |     Yes | Done    | Bounded deterministic synthesis and native execution; test:python/tests/test_by_example.py; record:docs/testing.md                                                                                        |
| Copy/script/notebook code export                    |    Yes |     Yes | Done    | Editable-buffer copy, source-safe script save, and session-pinned notebook insertion; test:src/test/safeFileExport.unit.test.ts; test:src/test/notebookInsertion.unit.test.ts                             |
| CSV and Parquet data export                         |    Yes |     Yes | Done    | Configurable native serialization and host-owned publication; test:src/test/safePythonDataExport.unit.test.ts; record:docs/testing.md                                                                     |
| Runtime selection, setup, change, clear             |    Yes |     Yes | Done    | Resource-scoped selection, dependency confirmation, engine change, and cleanup; test:src/test/runtimeCommands.unit.test.ts; record:docs/testing.md                                                        |
| Original icons, native views, themes, accessibility |    N/A |     N/A | Done    | Theme-token UI, keyboard semantics, and editor views; test:src/test/webview.component.test.tsx; record:docs/testing.md                                                                                    |
| Runtime crash/reload/session replay                 |    Yes |     Yes | Done    | Backend-pinned replay, closure-aware follow-ups, and cleanup; test:src/test/sessionCoordinator.recovery.unit.test.ts; record:docs/testing.md                                                              |
| Column-projected grid-block transport               |    Yes |     Yes | Done    | Bounded row/column windows with native projection pushdown; test:src/test/appColumnProjection.component.test.tsx; record:docs/testing.md                                                                  |
| Duplicate/non-string Pandas column operations       |    Yes |     N/A | Done    | Positional binding, stable IDs, index fidelity, and replay; test:python/tests/test_pandas_engine.py; test:python/tests/test_pandas_index_fidelity.py                                                      |
| Restricted Mode and trust-gated execution           |    N/A |     N/A | Done    | Untrusted execution denial and trusted installed journey; test:src/test/packageManifest.unit.test.ts; record:docs/testing.md                                                                              |
| Installed-editor first-usable-grid performance      |    Yes |     Yes | Done    | Pinned VS Code installed-performance consumes the canonical candidate; test:python/tests/test_performance_harness.py; workflow:.github/workflows/release-candidate.yml; record:docs/testing.md            |
| VS Code package acceptance and compatibility seam   |    N/A |     N/A | Done    | Canonical candidate in pinned VS Code installed-performance and bounded Linux Cursor platform smoke; workflow:.github/workflows/release-candidate.yml; record:docs/testing.md                             |

Open Wrangler targets desktop VS Code and editors based on it. Release-candidate performance is qualified in pinned
VS Code. Bounded Linux Cursor platform smoke is one concrete compatibility example. It covers representative grid,
cleaning, export, and recovery flows, but not the full VS Code qualification matrix.

A failed Python viewing page retains the last confirmed query, so later Apply and Discard do not use an unseen
filter. Spark also retains the prior view's continuation anchors when a replacement page fails.

The operation catalog search exposes its accessible name before and after entering a query.

Redo re-executes the latest undone command in editing-capable Python and native R sessions. Multiple Undos retain
their command order; a new committed branch clears them. History lasts only for the current runtime session,
including renderer remounts, and ends on close or recovery. Custom Code can produce a different result when re-executed.
The button and registered command share the normal draft, pending-work and trusted-execution gates; no default
keyboard shortcut overrides text-field editing.

File inputs include `.xls` and `.xlsx` workbooks plus `.jsonl` and `.ndjson` aliases. Pandas supports duplicate and
non-string labels and exposes named index or MultiIndex row labels independently of ordinary columns. Column
operations bind those inputs by stable identity and position, but name-addressed viewing filters and sorts fail closed
when duplicate or display-colliding labels are ambiguous. Pandas CSV and Parquet exports require an explicit
preserve-or-omit index choice. Polars uses native string column names; ordinary lazy operations stay lazy, while
one-hot encoding, multi-label encoding, and custom code may materialize. Pandas accepts its supported text encodings
and Unicode CSV syntax; Polars CSV export remains UTF-8 with single-byte delimiter and quote syntax. Excel accepts
exactly one sheet name or zero-based sheet index; delimited syntax characters are one Unicode scalar each. Import
options may therefore make Pandas the only compatible backend. Direct pickle opening is unavailable; the trusted
Pandas-only conversion command writes a separate Parquet file.

Python live entry points include the notebook toolbar, Jupyter Variables, linked MIME output, and `.py` or `# %%`
execution through Python Interactive. MIME v2 is a static capture, not session or export data: it is capped at 10,000
rows, 2,048 columns, 100,000 cells, 16 MiB, 64 graph levels, and 1,000,000 graph nodes, and pages at 10, 20, 50, or
100 rows. Its full-view action opens only the exact current live value in the originating notebook and kernel.
Cleaned-data export requires no draft and writes the committed plan, never the viewing filters or sorts, to a local
file destination through the shared publication boundary.
Script and data exports protect the session's concrete source files even after a rename. They also reject source-path
replacement during code synchronization or destination selection. If source identity is unavailable, viewing remains
available and export requires reopening the dataframe.

Discovery selections remain bound to their originating Python kernel until the initial session opens. Direct active-R
opens likewise retain the terminal selected when the command starts. Replacing either runtime before that open
completes requires a new open action; discovery and bridge regression tests cover these transitions.
With no notebook open, the Operations view offers **Start R and show dataframes…** after the R terminal closes.
R terminal discovery can start before R's first prompt; short command lines avoid truncation by terminal startup input.

Canceling file-editor or Code Preview resolution stops deferred setup without replacing an existing view. The file,
lazy-provider, and native-view owner tests cover cancellation during loading and file preflight.

Delayed grid navigation preserves newer header and control focus. Column drags stop after host view restoration,
a logical-view change or disabled controls. Existing App, clipboard and resize component owners cover these changes.

Min-max Scale preserves ratios for finite extremes and exact numeric ranges in live and generated code. The Python
engine matrix is in `python/tests/test_min_max_scale.py`; native R cases remain in
`r/tests/complete_catalog_contract.R`. Pandas and Polars CSV/Parquet writers use identity-checked handles before
truncation, with replacement-race coverage in `python/tests/test_configurable_export.py`.

Floor and Ceiling retain exact integer and Decimal values in the Python editing engines, with matching generated
code. Pandas Convert Type rejects values outside its signed integer target instead of wrapping them. The operation
and session-transaction tests cover value boundaries, missing values and rollback.

Round retains exact integer and Decimal values in live and generated Python execution, including half-even ties
and negative precision. Pandas may retain large integers in object storage. Polars, DuckDB and Arrow Decimal output
storage may widen or reduce scale; results beyond usable native capacity are rejected. Arrow Decimal results preserve
existing CSV and Parquet export support.

Polars Formula requires a numeric release version from 1.36 onward for two-column addition, subtraction or
multiplication producing UInt128. Earlier versions and nonnumeric or prerelease version labels refuse this combination
before previewing; scalar forms retain their existing behavior.

Polars datetime formatting preserves native time zones and nanosecond fractions in live and generated code.
`python/tests/test_operation_edges.py` covers eager/lazy frames, native temporal and text inputs, nulls, and source
identity.

Polars grouped median Fill works on the declared minimum runtime, including native integer and Decimal targets.
Its live and generated paths preserve exact values and retain fractional-median and Decimal-scale refusals.

Pandas mixed object columns keep distinct large numeric values in filters, counts, sorting, duplicate removal,
Group By, Pivot and grouped Fill. Selected rows retain their original stored values, and grouped output preserves
its representative labels. Filter text and selected integer tokens keep exact integer values through the UI.
Extended NumPy floating values that would lose precision or range at the display or selected query boundary are
refused with an explicit conversion message. Representable values remain supported; exact native CSV export and
explicit conversion operations keep their existing behavior.

Pandas Formula modulo supports Arrow integer columns, including signed and unsigned 64-bit extrema, with matching
generated code and Parquet output. Null operands remain null; present zero divisors are refused without changing
the confirmed plan. Other Formula arithmetic repairs eligible UInt64 operand-inference failures and widens selected
Decimal128 operations to Decimal256, retaining native precision and scale. UInt64 addition and subtraction also accept
negative integer literals with magnitude at most UInt64 maximum when every result fits UInt64. A UInt64 left column
also accepts signed right columns, including mixed positive and negative adjustments and signed 64-bit minimum,
when every repaired result fits UInt64. Missing operands remain missing. Existing native successes remain unchanged.
Reversed negative-column operands, negative multiply/power and widest or negative-scale Decimal capacity gaps remain
tracked in [#979](https://github.com/Matt17BR/openwrangler/issues/979).

Formula preserves newly entered large integer literals through preview, apply, saved plans and generated code.
Polars checks native capacity for these strings on integer columns and for integer arithmetic in saved plans
whose source changes to Boolean. DuckDB retains its native arithmetic promotion.
R accepts only literals exactly representable by its existing numeric scalar types. Decimal and exponent input
retain floating-point interpretation. Previously rounded numeric plans require re-entering the original literal;
this change cannot recover digits already lost.

Pandas Arrow date columns, including Parquet imports, retain date-range profiles, typed filters and stable sorting.
Parquet imports preserve exact nullable integer row-index values, including adjacent integers above 2^53. Row labels
follow filtered and sorted rows; the index-fidelity owner checks these through actual file sessions.

Native Pandas Arrow `bool8` and UUID columns support logical cell values, profiles, value selections, sorting and
existing compatible cleaning operations. Nonzero `bool8` storage reads as true; UUIDs use canonical strings.
Selected rows retain their original native arrays. CSV and Parquet exports preserve the logical values, including
selected index levels. Native extension Parquet files reopen with the same logical Boolean and string values.
Pandas object-dtype UUIDs also share their canonical text value with profiles, selections, sorting, duplicates and
exports. UUID objects and matching canonical strings count as one value; other spellings remain distinct. Selected
rows retain the original UUID objects, and unrelated object values are not converted to strings.

Pandas scalar Arrow dictionaries use logical values for profiles, value selection, filters, sorting and row removal.
Null dictionary entries and duplicate values across chunks retain their meaning. Nested and arbitrary extension
dictionary values do not gain scalar operations. Integer filtering, sorting, directional Fill and Drop Duplicates
preserve exact large values in Sparse columns, including returned columns that were not used as keys.
Convert Type uses the dictionary's logical input type, so valid casts work across chunks and signed-integer range
checks also cover encoded unsigned values.
Fill supports logical dictionary values across its existing methods and retains encoded targets when no cells change.
Generated Fill code treats native Arrow dates as dates, including empty and all-null columns.
CSV and Parquet writers support scalar dictionary columns and preserved index levels, including null codebook entries.
Group By, Pivot and grouped Fill share missing-value and signed-zero key equality for Arrow float32/float64 columns.
Group By preserves computed NaN separately from an empty group's null result.
Group By Count accepts Sparse columns, including missing and empty inputs, while preserving other aggregates on
the same column.
Group By, Pivot and grouped Fill preserve distinct Sparse integer keys, including adjacent large values and native
fill values. Current Pandas still rejects fractional fills that only the supported minimum accepts.

Polars and DuckDB enum profiles and typed filters use string values even when category labels resemble numeric or
container type names. Fixed-size DuckDB arrays remain containers, with unsupported comparisons and sorts refused.
Polars By Example supports exact unsigned cancellation and multiplication by zero on the minimum runtime.
Multi-label binarization retains empty, missing and repeated-label behavior across supported Polars versions.
Polars JSONL/NDJSON reads the selected file on Unix even when its path contains glob syntax or percent-looking text.
On Windows, ordinary paths and local-drive verbatim paths such as `\\?\C:\data\sample.jsonl` retain exact file identity.
Paths containing `*`, `?`, or `[` after that prefix, and unsupported verbatim prefixes, remain refused. Full Windows
literal-path support remains open in [#986](https://github.com/Matt17BR/openwrangler/issues/986).

Unnamed columns support viewing, profiling, keyboard selection, and copy. Their cell menus, header sorts, profile
actions, and Filters / Sorts consistently disable name-addressed actions without leaving a page request pending.
App regressions check these actions against the host message decoder. Toggling an ordinary value preserves null and
NaN selections. Supported scalar selections remain
checked beside their corresponding typed values. Saved Filter Rows steps accept historical `inf` and `-inf` values
without dropping the cleaning plan during replay.
Python and native R reject malformed viewing structures before execution. Native R applies the same array and
logic admission checks to Filter Rows drafts; valid empty filters and existing native operand behavior remain.
Python also rejects over-nested, non-finite or invalid-UTF-8 viewing operands before query work, preserving the
runtime for a valid follow-up. Exact wide integers and supported opaque JSON values retain their representation.

Multi-column cleaning forms support search, including Select/Drop columns, Drop missing rows, Drop duplicates,
One-hot encoding, Group keys, and Transform by example. Search retains hidden selections and their required order;
operation-builder tests verify the exact submitted references, saved selections, and optional full-schema defaults.

Visual baselines and axe scans are not exhaustive assistive-technology certification or proof that every virtualized
cell is simultaneously present in the DOM.

The catalog contains 32 operations: five row/order, seven column/type, ten categorical/text, five numeric/datetime,
two reshape, Group and aggregate, Transform by example, and Custom code. The exact names and parameters are in the
[generated catalog](reference.md#transformation-operations). Transpose, explode, and unnest are not hidden catalog
entries.

## Release rule

A stable release requires every required Pandas and Polars row above to be **Done**, no known release-blocking defect,
and one exact candidate to pass the [qualification flow](releasing.md#release-candidate). Preview,
experimental, Partial, Planned, and Out-of-scope rows do not block stable publication when their public labels and
limits remain accurate.

Polars Pivot Wider accepts public identifier and key columns named `len` and output names resembling temporary
columns. Native eager/lazy and executable generated-code regressions cover collisions and duplicate null keys in
`python/tests/test_pivot_wider.py`.

## Native R preview

Value selections and numeric predicates retain adjacent R doubles and finite extrema in live and generated filtering.
Typed temporal selections use the same exact numeric payloads. Invalid previews preserve the confirmed result.

Native R live and generated medians use the same midpoint calculation for Group By and Fill Missing Values,
including subnormal and extreme doubles. This correction does not expand the supported frame or transport scope.

Native R keeps the **Preview** label in every release channel. These rows describe the current capability and its
limits; none is a stable-release gate.

| Surface                                       | Availability                    | Status  | Current owner                                                       |
| --------------------------------------------- | ------------------------------- | ------- | ------------------------------------------------------------------- |
| Native R frame paging and typed cells         | Preview                         | Partial | Projected native frame contracts, empty subsets and installed pages |
| Native R compound viewing filters             | Preview                         | Partial | Native predicate contracts and installed value paths                |
| Native R value search and selections          | Preview                         | Partial | Typed selection and bounded search contracts                        |
| Native R ordered viewing sorts                | Preview                         | Partial | Native stable-sort contracts and editor paths                       |
| Native R column and dataset profiles          | Preview                         | Partial | Exact and sampled native profile contracts                          |
| Base `data.frame`, tibble, and `data.table`   | Preview                         | Partial | Native discovery, paging, query, and profile contracts              |
| Exact IRkernel session transport              | Preview                         | Done    | Exact-kernel ownership and supported desktop-host journeys          |
| Exact active R-terminal transport             | Preview                         | Partial | Official-R-terminal discovery and callback contracts                |
| Cursor-owned `.Rmd` and `.qmd` R/Python chunk | Preview                         | Partial | Executor-aware exact-origin contracts                               |
| Owned `.R` source process                     | macOS and Linux Preview         | Partial | Owned-process lifecycle contracts                                   |
| Owned `.Rmd` and `.qmd` cell process          | macOS and Linux Preview         | Partial | Lexical-cell and owned-process contracts                            |
| Notebook workbench                            | Preview                         | Partial | Installed viewing/editing and verified kernel-restart recovery      |
| R cleaning operations and generated code      | Generated catalog               | Partial | Native live/generated values, metadata, and replay contracts        |
| Copy or save generated R                      | Generated catalog               | Partial | Editable-buffer copy and atomic script-save contracts               |
| Insert generated R into its IRkernel notebook | Preview                         | Partial | Exact-document insertion contracts                                  |
| Insert generated R into its source `.R` file  | macOS and Linux Preview         | Partial | Exact-document insertion and supported-host rerun                   |
| Insert generated R into `.Rmd` and `.qmd`     | macOS and Linux Preview         | Partial | Exact-document insertion contracts                                  |
| Cleaned-data export                           | R notebook/document CSV/Parquet | Partial | Native writers and host-owned atomic publication                    |
| Active R-terminal cleaned-data export         | Preview                         | Partial | Native streaming and host-owned atomic publication                  |
| Quarto and R Markdown lexical R-cell run      | Preview                         | Partial | Exact lexical-cell routing contracts                                |

The accepted frame boundary is base `data.frame`, tibble, and `data.table`, including ordinary default
`collapse::qDF()`, `qTBL()`, and `qDT()` outputs through those same paths. Grouped `GRP_df`, `indexed_frame`,
unsupported attributes, and unsupported cell classes are rejected. Direct `.R`, `.Rmd`, and `.qmd` execution is
limited to macOS and Linux; IRkernel remains cross-platform. R Markdown and Quarto support runs selected lexical
cells, not document-render semantics. An active R terminal has no source document for generated-code insertion.
An R page that exceeds the transport limit after ASCII escaping returns a request error without terminating the
standalone runtime. A smaller page remains available; opening and mutation responses still validate before commit.
Large R profiles retain exact cheap statistics but sample histograms, categories, and duplicate populations with
explicit sample labels.

The complete current operation set has direct native live, generated-code, and replay contracts. The exact names and
parameters live in the [generated reference](reference.md#transformation-operations). CSV export is UTF-8 with
double-quote syntax. Parquet export additionally requires `nanoparquet` 0.5.1 or newer in the selected R environment,
and notebook export is available only from the current local extension host. Fill interpolation does not accept
`integer64` coordinates, and active `data.table` keys restrict in-place changes. The durable ownership boundary lives
in the [Native R ADR](decisions/0001-native-r-runtime.md).

## DuckDB experimental file support

DuckDB file sessions remain native and connection-scoped. They do not convert through Pandas, Polars, or Arrow, and
extension auto-install, autoload, and external-file caching stay disabled.
Parquet exports store top-level HUGEINT/UHUGEINT values exactly as Decimal with up to 38 digits, preserving nulls.
Values outside that range and nested 128-bit integer fields are refused before publication. These fields reopen
with Decimal storage. Parquet also refuses interval precision or capacity loss and time-zone map-key changes.
Top-level TIMETZ values retain their UTC time; DuckDB 1.5.4 requires explicit conversion for nested nonzero offsets.
Representable intervals, compatible keys, nulls and empty containers remain supported. CSV retains its native text
output.

| Surface                                      | Availability       | Status  | Current evidence                               | Limit or missing proof                              |
| -------------------------------------------- | ------------------ | ------- | ---------------------------------------------- | --------------------------------------------------- |
| CSV and TSV file sessions                    | Yes                | Partial | Native lazy reader and packaged import slices  | Complete import-option and cross-platform matrix    |
| Parquet file sessions                        | Yes                | Partial | Native typed pages and source invalidation     | Large-scale and repeated cross-platform matrix      |
| JSONL file sessions                          | Yes                | Partial | Native malformed-input and packaged import     | Installed malformed/import-state interaction matrix |
| Excel file sessions                          | No                 | Planned | Explicit unsupported diagnostic                | Use Pandas or Polars                                |
| `.duckdb` database/catalog/table browsing    | No                 | Planned | Source kind is not registered                  | Separate connection, discovery, and security design |
| Notebook variables and inline MIME rendering | Viewing only       | Partial | Native relation package slices                 | No cleaning, code insertion, or data export         |
| Grid pages, typed cells, filters, and sorts  | Yes                | Partial | Native rich-type and query contracts           | Large-scale mixed-data and cross-platform matrix    |
| Summaries, statistics, and distinct values   | Yes                | Partial | Native fixed-size profile contracts            | Repeated large-data resource evidence               |
| Complete 32-operation catalog                | File sessions only | Partial | Exact direct live/generated catalog equality   | Complete installed catalog and semantic-edge matrix |
| Draft preview, diff, apply, and history      | File sessions only | Partial | Runtime and representative packaged lifecycle  | Complete edit/discard/undo interaction matrix       |
| Executable generated DuckDB code             | File sessions only | Partial | Direct equality and packaged copy/script slice | Edited-code execution acceptance                    |
| CSV and Parquet cleaned-data export          | File sessions only | Partial | Native export and publication failure tests    | Cross-platform installed destination matrix         |
| Runtime crash/reload/session replay          | Yes                | Partial | Backend-keyed replay and injected recovery     | Repeated cross-platform failure matrix              |
| Runtime performance benchmark                | Diagnostic         | Partial | Direct and stdio smoke                         | No strict DuckDB release threshold                  |

DuckDB file imports support CSV, TSV, Parquet, and JSONL. A multibyte quote character is incompatible and fails
before runtime startup. CSV export is UTF-8 with single-byte delimiter and quote syntax. DuckDB rejects schemas whose
identifiers differ only by case. Notebook `DuckDBPyRelation` values retain the user's relation for serialized viewing
only; closing releases Open Wrangler's reference and never closes the user's connection.

## PySpark live-notebook viewing

Only stable/final PySpark 4.2.x local Classic and local Connect batch DataFrames are supported. PySpark is
notebook-only and viewing-only. It uses the notebook's existing Spark session and never converts through a local
dataframe engine.

| Surface                                        | Availability       | Status       | Current evidence                             | Boundary                                    |
| ---------------------------------------------- | ------------------ | ------------ | -------------------------------------------- | ------------------------------------------- |
| Local Classic DataFrame viewing                | Live notebook only | Done         | Direct stable/final-version path             | Installed prerelease denial is unearned     |
| Local Spark Connect DataFrame viewing          | Live notebook only | Done         | Direct and installed local Connect path      | Local Connect only                          |
| Progressive projected grid pages               | Viewing only       | Done         | Lookahead, boundary, and terminal-page tests | Sequential traversal                        |
| Basic/advanced filters and multi-column sorts  | Viewing only       | Done         | Native expressions and packaged queries      | Unique final key needed for repeatable ties |
| Summaries, statistics, and distinct values     | Viewing only       | Done         | Native fixed-size aggregate tests            | Header profiles start off                   |
| Session recovery and non-interrupting disposal | Viewing only       | Done         | Classic/Connect rebind and cleanup           | Running Spark work is not interrupted       |
| Cleaning operations and history                | No                 | Out of scope | Editing capability is absent                 | No distributed transformation plan          |
| Script/notebook/data export                    | No                 | Out of scope | Export capability is absent                  | No Spark export contract                    |
| Saved-output MIME formatter                    | No                 | Out of scope | Saved-output capability is absent            | Live variables only                         |
| File sessions and automatic backend selection  | No                 | Out of scope | File capability is absent                    | Notebook variables only                     |
| Streaming, external, or authenticated clusters | No                 | Out of scope | Local batch contract only                    | No authentication or provisioning           |

The first page does not count, globally index, cache, or persist the whole dataframe. Paging advances sequentially;
only a short terminal page establishes an exact total. Spark does not promise source order, and repeatable sorted ties
need a unique final key. Queued or stale work is dropped, but running notebook work is detached and ignored rather
than interrupted. Persistence, Spark provisioning, cluster authentication, and lifecycle ownership remain outside
the contract.

## Deferred and unsupported scope

These dispositions do not block stable publication unless a release starts advertising the capability.

| Surface                                                                                   | Current disposition                                                                                   |
| ----------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Cleaning-step reorder                                                                     | Deferred; edit and delete earlier steps are supported, but no move primitive exists                   |
| Transpose, explode, and unnest                                                            | Planned after the implemented deterministic split, regex, and pivot operations                        |
| Rank/window operations, broader formulas, and assertions                                  | Planned operation work                                                                                |
| Joins and merge                                                                           | Deferred until multi-source identity, lifecycle, persistence, and source-immutability have one design |
| Portable cleaning recipes and batch apply                                                 | Planned after the deterministic operation primitives                                                  |
| Natural-language and Copilot operations                                                   | Deferred until deterministic operations and portable recipe validation exist                          |
| DuckDB Excel and database browsing                                                        | Planned experimental expansion; not part of current support                                           |
| Debugger variables and non-dataframe list, dictionary, array, tensor, or scalar renderers | Deferred entry-point and data-model work                                                              |
| Browser, code-server, virtual-workspace, and Remote SSH hosts                             | Not release-qualified; the desktop target is VS Code and editors based on it                          |
| VS Code-based desktop editors                                                             | Bounded Linux Cursor platform smoke is representative; broader compatibility remains experimental     |
| Localization and telemetry                                                                | Deferred product breadth                                                                              |
| Broader cross-engine CSV codec parity and polished row-header presentation                | Deferred and explicitly nonblocking in the product roadmap                                            |

The current priorities and deferral dependencies live in the [product roadmap](product-roadmap.md).
