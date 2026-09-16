# Feature parity matrix

This is the normative capability ledger for the current source. The generated [interface reference](reference.md) is
authoritative for command, setting, protocol, MIME, and operation names.

**Done** is the standing capability status: the surface is implemented and backed by its current source or installed
owner. **Partial** means the capability is usable but remains deliberately limited or lacks evidence for part of its
claim. **Unavailable** means the capability is not implemented. **Out of scope** means it is deliberately unavailable
for the stated surface.

The Pandas and Polars rows below are required for stable releases.

| Surface                                                     | Pandas | Polars | Status | Required evidence                                                                                                                                                                              |
| ----------------------------------------------------------- | -----: | -----: | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| File entry points; Windows Polars JSONL excludes glob paths |    Yes |    Yes | Done   | Native readers and file-launch surfaces within the path limits below; test:python/tests/test_pandas_engine.py; test:python/tests/test_polars_engine.py; record:docs/testing.md                 |
| Notebook variable viewer and toolbar                        |    Yes |    Yes | Done   | Exact-notebook and Interactive opens; [Variables limitation](#sessions-and-generated-code); test:src/test/notebookPreviewCoordinator.unit.test.ts; record:docs/testing.md                      |
| Inline notebook renderer and full-view expansion            |    Yes |    Yes | Done   | Bounded MIME rendering and exact live-value expansion; test:src/test/notebookRenderer.unit.test.ts; record:docs/testing.md                                                                     |
| Virtual grid, column sizing, navigation                     |    Yes |    Yes | Done   | Projected virtualization, keyboard navigation, range copy, and column copy; test:src/test/webview.component.test.tsx; record:docs/testing.md                                                   |
| Dataset summary and quick insights                          |    Yes |    Yes | Done   | Native profiles, exact sums, typed extrema and accessible charts; test:src/test/numericSummary.component.test.tsx; test:python/tests/test_polars_engine.py                                     |
| Basic and advanced viewing filters                          |    Yes |    Yes | Done   | Typed filters and value-preserving history; test:python/tests/test_filter_logic.py; test:src/test/filterPanel.component.test.tsx; test:src/test/filterHistory.unit.test.ts                     |
| Multi-column viewing sorts                                  |    Yes |    Yes | Done   | Ordered priorities and stable native execution; test:python/tests/test_pandas_engine.py; test:python/tests/test_polars_engine.py                                                               |
| Editing mode and operation catalog                          |    Yes |    Yes | Done   | Supported catalog operations and the installed picker; test:python/tests/test_operations.py; test:src/test/operations.unit.test.ts; record:docs/testing.md                                     |
| Draft preview and data diff                                 |    Yes |    Yes | Done   | Typed identity diff plus preview/apply rollback; test:src/test/dataGridDiff.component.test.tsx; record:docs/testing.md                                                                         |
| Cleaning-step history, edit, discard, undo                  |    Yes |    Yes | Done   | Latest and earlier step edit/delete, suffix replay, discard, and undo; test:src/test/sessionCoordinator.planRewrite.unit.test.ts; record:docs/testing.md                                       |
| Generated code preview and editing                          |    Yes |    Yes | Done   | Editable native code and runtime-equivalent execution; test:src/test/codePreviewSynchronization.unit.test.ts; record:docs/testing.md                                                           |
| Sort/filter cleaning steps                                  |    Yes |    Yes | Done   | Stable-reference live and generated contracts; test:python/tests/test_operation_edges.py; record:docs/testing.md                                                                               |
| Select/drop/rename/clone/cast/formula/length                |    Yes |    Yes | Done   | Stable lineage, duplicate-label handling, and generated parity; test:python/tests/test_operation_edges.py; record:docs/testing.md                                                              |
| Drop missing/duplicate rows                                 |    Yes |    Yes | Done   | All public row-reduction modes and generated parity; test:python/tests/test_operation_edges.py; record:docs/testing.md                                                                         |
| Mark duplicate groups                                       |    Yes |    Yes | Done   | Retained-row flags with native equality and generated parity; test:python/tests/test_mark_duplicates.py; record:docs/testing.md                                                                |
| Fill missing values                                         |    Yes |    Yes | Done   | Typed global, fallback, directional, grouped, and interpolation methods; test:python/tests/test_operation_edges.py; record:docs/testing.md                                                     |
| One-hot and multi-label binarization                        |    Yes |    Yes | Done   | Null, blank, collision, and generated-code parity; test:python/tests/test_operation_edges.py; record:docs/testing.md                                                                           |
| Find/replace/strip/split/case transforms                    |    Yes |    Yes | Done   | Text transforms, multi-output split, and portable regex extraction; test:python/tests/test_operation_edges.py; record:docs/testing.md                                                          |
| Scale/rank/round/floor/ceiling/datetime format              |    Yes |    Yes | Done   | Live/generated numeric and datetime contracts; test:python/tests/test_dense_rank.py; test:python/tests/test_round_number.py; record:docs/testing.md                                            |
| Group and aggregate                                         |    Yes |    Yes | Done   | Ordered groups and normalized numeric aggregation; test:python/tests/test_group_numeric_parity.py; record:docs/testing.md                                                                      |
| Custom engine-native code                                   |    Yes |    Yes | Done   | Trusted isolated input, output validation, and executable native code; test:python/tests/test_pandas_engine.py; test:python/tests/test_polars_engine.py                                        |
| String/datetime/new-column by example                       |    Yes |    Yes | Done   | Bounded deterministic synthesis and native execution; test:python/tests/test_by_example.py; record:docs/testing.md                                                                             |
| Copy/script/notebook code export                            |    Yes |    Yes | Done   | Editable-buffer copy, source-safe script save, and session-pinned notebook insertion; test:src/test/safeFileExport.unit.test.ts; test:src/test/notebookInsertion.unit.test.ts                  |
| CSV and Parquet data export                                 |    Yes |    Yes | Done   | Configurable native serialization and host-owned publication; test:src/test/safePythonDataExport.unit.test.ts; record:docs/testing.md                                                          |
| Runtime selection, setup, change, clear                     |    Yes |    Yes | Done   | Resource-scoped selection, dependency confirmation, engine change, and cleanup; test:src/test/runtimeCommands.unit.test.ts; record:docs/testing.md                                             |
| Original icons, native views, themes, accessibility         |    N/A |    N/A | Done   | Theme-token UI, keyboard semantics, and editor views; test:src/test/webview.component.test.tsx; record:docs/testing.md                                                                         |
| Runtime crash/reload/session replay                         |    Yes |    Yes | Done   | Backend-pinned replay, closure-aware follow-ups, and cleanup; test:src/test/sessionCoordinator.recovery.unit.test.ts; record:docs/testing.md                                                   |
| Column-projected grid-block transport                       |    Yes |    Yes | Done   | Bounded row/column windows with native projection pushdown; test:src/test/appColumnProjection.component.test.tsx; record:docs/testing.md                                                       |
| Duplicate/non-string Pandas column operations               |    Yes |    N/A | Done   | Positional binding, stable IDs, index fidelity, and replay; test:python/tests/test_pandas_engine.py; test:python/tests/test_pandas_index_fidelity.py                                           |
| Restricted Mode and trust-gated execution                   |    N/A |    N/A | Done   | Untrusted execution denial and trusted installed journey; test:src/test/packageManifest.unit.test.ts; record:docs/testing.md                                                                   |
| Installed-editor first-usable-grid performance              |    Yes |    Yes | Done   | Pinned VS Code installed-performance consumes the canonical candidate; test:python/tests/test_performance_harness.py; workflow:.github/workflows/release-candidate.yml; record:docs/testing.md |
| VS Code package acceptance and compatibility seam           |    N/A |    N/A | Done   | Canonical candidate in pinned VS Code installed-performance and bounded Linux Cursor platform smoke; workflow:.github/workflows/release-candidate.yml; record:docs/testing.md                  |

## Supported environments

Open Wrangler targets desktop VS Code and editors based on it. Release-candidate performance is qualified in pinned
VS Code. Bounded Linux Cursor platform smoke is one concrete compatibility example. It covers representative grid,
cleaning, export, and recovery flows, but not the full VS Code qualification matrix.

Supported Python dependencies installed as hard links are recognized within the existing
[version and module-origin checks](architecture.md#trust-source-integrity-and-export).

Runtime selection commands change only the workspace Python override. User and Remote `openWrangler.pythonPath`
values remain unchanged.
Dependency errors identify the Python executable, version, selection source and unmet package requirements. When
DuckDB is available, they explain its required supporting packages. **Install required packages**
opens the existing confirmation for that environment. After a failed file-engine change, a successful installation
retries the requested engine while the original confirmed view remains available.

## Files and exports

File inputs include CSV, TSV, Parquet, `.xls` and `.xlsx` workbooks, and `.jsonl` and `.ndjson` aliases.
Polars JSONL/NDJSON reads the selected file on Unix even when its path contains glob syntax or percent-looking text.
On Windows, ordinary paths and local-drive verbatim paths such as `\\?\C:\data\sample.jsonl` retain exact file identity.
The stable file entry-point scope excludes Windows Polars JSONL/NDJSON paths containing `*`, `?`, or `[` apart from the
structural `\\?\C:\` local-drive prefix. This includes parent folder names; unsupported verbatim prefixes are also refused.
The missing literal-path capability is documented in
[#986](https://github.com/Matt17BR/openwrangler/issues/986); the narrower scope does not resolve it. Ordinary Unicode,
spaces, percent-looking names and closing brackets remain supported. See the precise native path and ownership
rules in [Architecture](architecture.md#polars); the current evidence does not establish arbitrary UNC, device or
long-path support.

Auto prefers a compatible Python engine in Polars, DuckDB, then Pandas order. If no compatible Python interpreter or
file engine is available, it tries R for supported local files. Explicit Python engine choices, broken configured Python paths, unexpected environment
errors and file-read failures do not switch to R. To use
Pandas instead, set `openWrangler.defaultBackend` to `pandas` in Settings, then run **Open Wrangler: Open File Path**
and select the same file. This uses Pandas' native parser, inferred types and eager snapshot costs; it is not a
transparent Polars substitution. The setting affects future file opens, while existing sessions keep their engine.

Import inference preserves UTF-8 characters crossing its sample boundary and recognizes uniform CR records.
Polars receives the detected line ending; Import Options can override it with **CR** or **LF or CRLF**. Polars requires
consistent record endings. A sample without complete records may need an explicit choice; inference does not validate
the full file. Existing LF/CRLF file settings and saved-state keys remain unchanged.

CSV/TSV imports preserve native empty fields and whitespace values, including headerless all-null TSV records.
Python file engines open files with no bytes or only a UTF-8 BOM with an empty schema; R refuses those inputs.
Other blank records follow the selected reader.
Pandas accepts its supported text encodings and Unicode CSV syntax; Polars CSV export remains UTF-8 with single-byte
delimiter and quote syntax. Polars refuses syntax characters that its numeric, Boolean or temporal column types could
emit unescaped, including for empty and all-null columns. Standard comma, tab, semicolon and pipe with ordinary quotes
remain supported; Null and textlike columns retain custom syntax. See the [Polars export rules](architecture.md#polars).
Excel accepts exactly one nonempty sheet name or zero-based sheet index. Whitespace-only names are preserved in
selection and reopening. Polars refuses a missing Excel path instead of reading similarly named workbooks; it also
refuses whole-workbook Python buffering if the selected path disappears before native parsing.
Delimited syntax characters are one Unicode scalar each. Import options may therefore make
Pandas the only compatible backend. Direct pickle opening is unavailable; the trusted Pandas-only conversion command
writes a separate Parquet file.

Cleaned-data export requires no draft and writes the committed plan, never the viewing filters or sorts, to a local
file destination through the shared [publication boundary](architecture.md#trust-source-integrity-and-export).
Pandas CSV and Parquet exports require an explicit preserve-or-omit index choice. Pandas and Polars CSV/Parquet writers
use identity-checked handles before truncation.
Pandas CSV preserves exact Arrow temporal values and missing categories. Arrow timestamps stored in seconds,
milliseconds or microseconds require UTC and local years 1 through 9999; an unsupported export leaves the destination unchanged.
Pandas exports negative-scale Arrow Decimal columns and requested row labels to Parquet at scale zero, preserving
logical values and nulls. This includes original operands retained by Formula. The source keeps its original storage;
reopened values use Pandas Decimal objects. Unsupported scales, capacities and categorical storage follow the
[Pandas export limits](architecture.md#pandas).
Script and data exports protect the session's concrete source files even after a rename. They also reject source-path
replacement during code synchronization or destination selection. If source identity is unavailable, viewing remains
available and export requires reopening the dataframe.

## Sessions and generated code

DuckDB table, Excel worksheet and R dataframe pickers show special names with JSON escapes so names such as
`$(add)` remain text. Search the displayed spelling; selecting an item keeps its original name.

Python live entry points include the notebook toolbar, Jupyter Variables, linked MIME output, and `.py` or `# %%`
execution through Python Interactive. MIME v2 is a static capture, not session or export data: it is capped at 10,000
rows, 2,048 columns, 100,000 cells, 16 MiB, 64 graph levels, and 1,000,000 graph nodes, and pages at 10, 20, 50, or
100 rows. Its full-view action opens only the exact current live value in the originating notebook and kernel.
Existing saved MIME-v2 outputs remain readable. A running Python kernel reuses only the same verified bundled
runtime; older or partial imports require a manual kernel restart. Explicit `show` remains supported for static
output; live reopening follows the [notebook recovery order](architecture.md#notebook-kernel-terminal-and-document-provenance)
so the host loads the verified bundle before `show` is imported. Windows notebook patch-version and temporary-directory
limits are in the
[compatibility notes](../README.md#compatibility-and-limits).

Jupyter's Variables view can intermittently remain blank before Open Wrangler receives an open request.
This [unresolved limitation](https://github.com/Matt17BR/openwrangler/issues/1498) was observed with Jupyter 2025.9.1
in Linux VS Code 1.137.0. Open values from the Open Wrangler notebook toolbar or an available inline output action.
These entry points do not use the Variables view. Installed checks cover specific toolbar and inline opens in normal
operation; recovery after the blank view failure remains unverified.

Polars live notebook LazyFrames are evaluated once at opening and retain their complete native result. Lazy Custom Code
results are retained in the same way, including in generated code. Subsequent pages and column projections keep row
identities stable even when the original query had no unique order. These full results must fit memory; page limits do
not bound capture, and a mutation can retain old and new results together. The native LazyFrame type is preserved, but
later projections cannot avoid that initial work. Python Object values retain their caller-owned references.

DuckDB notebook opening captures the full native result to keep values and row identities stable across pages,
column windows and whole-column copy. Select the connection that created the relation and keep it open while using
the viewer. Expose private connections as notebook variables, or explicitly select DuckDB's default connection when
that is the owner. Another connection to the same database does not qualify. Automatic inline previews remain bounded
and do not require this selection.

DuckDB file Custom Code also captures each complete result into private native storage. Captures increase execution
time, memory and temporary disk use, and previews can retain old and new results together. Page limits do not bound
that work. Replay may evaluate volatile code again; it does not change rows already retained by an existing capture.
Generated DuckDB plans containing Custom Code require `clean_data(frame, connection=con)`, where `con` created
`frame`. Each Custom result must derive from its supplied `df`; returning a relation from another connection is
refused. This includes independent `duckdb.sql(...)` results that older file sessions could rebind. Later native
queries over generated results can also incur substantial materialization overhead.

Open Wrangler never commits, rolls back or closes a notebook's connection. Native queries can invalidate a pending
result, and execution errors may abort an active transaction. Resolve that transaction in the notebook before
reopening the viewer. The [DuckDB contract](architecture.md#duckdb) describes ownership and capture costs.

Generated Python keeps import and helper bindings local. Pandas and Polars notebook inputs named like those bindings
remain available after executing the program; an input named `clean_data` uses the generated function `clean_data_1`.
The [architecture contract](architecture.md#engine-boundaries-and-capabilities) describes scope and caller limitations.
Polars viewing and built-in cleaning use literal column names, including `*` and `^a.*$`. Generated selectors
resolve those names against each step's current input.

Live and generated Python Custom Code preserve multiline and continued string values, comments and valid indentation.
Syntax errors refer to the entered code's lines.

Discovery selections remain bound to their originating Python kernel until the initial session opens. Direct active-R
opens likewise retain the terminal selected when the command starts. Replacing either runtime before that open
completes requires a new open action.
Data sources lists cached Python and R dataframes and keeps **Open a data file** available while a dataframe is open.
Operations contains the cleaning catalog for the active dataframe.
With no notebook open, Data sources offers **Start R and show dataframes…** after the R terminal closes.
R terminal discovery can start before R's first prompt; short command lines avoid truncation by terminal startup input.
Terminal commands honor vscode-R's `r.bracketedPaste` setting. Enable it when using radian so multiline commands
arrive as one expression. Canceling a request stops waiting; R may still be running that work.

Canceling file-editor or Code Preview resolution stops deferred setup without replacing an existing view, including
during loading or file preflight.

## Cleaning operations

The complete operation list and parameters are in the [generated catalog](reference.md#transformation-operations).
Extract Struct Fields copies known scalar fields from a Struct column into new columns in Polars editing sessions
and DuckDB file sessions. Enter each exact field name and its output name; the parent column and rows stay intact.
For example, extract `city` from an `address` Struct as `customer_city`. Missing parents produce missing outputs.
Choose up to 64 fields, with the [native type and naming limits](architecture.md#engine-boundaries-and-capabilities).
Pandas and R do not support this operation.

Explode List turns one native Polars List column into rows and repeats the other columns. Empty or missing lists keep
one row with a missing value. The operation expands one level: List and Struct children keep their types. For example,
explode a list of addresses, then use Extract Struct Fields to copy each address's city. Fixed-size Array columns and
Object-containing lists are unsupported. Pandas, DuckDB and R do not support Explode List.
Lazy input is read into memory before preview so the growth check and expansion use the same values. The result stays
lazy, but later steps cannot reduce that initial read. The [capacity limit](architecture.md#engine-boundaries-and-capabilities)
does not guarantee that an input or its expanded output will fit in memory.

Automatic field discovery, recursive flattening and transpose remain unavailable.

Conditional Column adds one Text or Boolean column using an existing typed predicate. All three results are explicit
and may be null; empty text and false remain values. Pandas, Polars, DuckDB and native R use their existing predicate
and input limits. See the [conditional result contract](architecture.md#engine-boundaries-and-capabilities) for missing
inputs and output bounds.

Find and Replace uses the selected engine's native regex syntax. In regex replacements, `$1` inserts the first
capture group in Polars; Pandas, DuckDB and R use `\1`. With regular expressions off, replacement text is literal.
Extract regex group uses its separate portable pattern subset.
DuckDB's Lowercase, Uppercase, Capitalize, Strip, Split, Find and Replace, and Split Text into Columns use built-in
text functions even when generated code runs on a connection with caller-defined functions of the same names.
Functions deliberately used by the input relation retain their caller-defined behavior.

Dense Rank appends ranks from a numeric column without reordering rows. For `[20, 10, 20, missing]`, ascending ranks
are `[2, 1, 2, missing]`; descending ranks are `[1, 2, 1, missing]`. It ranks the cleaning input independently of viewing
filters and sorts. Pandas, Polars, DuckDB file sessions and native R support the same value rules; native integer
storage and capacity limits remain engine-specific. General window and partitioned ranking operations are unavailable.

Mark Duplicates adds a Boolean column for reviewing repeated selected keys without removing any records. For keys
`[a, a, b]`, it produces `[true, true, false]`. Hidden matching rows still count because the operation uses the complete
cleaning input. Pandas, Polars, DuckDB file sessions and native R preserve their existing duplicate-key semantics,
including supported missing and classed values. Select at least one comparison column and a fresh output name.

Min-max Scale preserves ratios for finite extremes and exact numeric ranges in live and generated code for the Python
editing engines and native R.

Convert Type to Datetime can parse Text dates in a selected `DD/MM/YYYY`, `MM/DD/YYYY` or `YYYY-MM-DD` layout.
For example, `02/03/2026` means 2 March with the first layout and 3 February with the second. Dates must match exactly;
invalid or out-of-range values become missing, and valid dates become midnight. Native date ranges differ.
Clone the column first to keep its text values, then convert the clone.

To create an integer year, month or day column, select the typed temporal column in Format Datetime, enter `%Y`,
`%m` or `%d` and give the output a new name. Convert that output to Integer. Missing values remain missing. These
composed workflows support Pandas, Polars, DuckDB file sessions and native R within their existing temporal limits.
Format an already zoned column directly, without first converting it to Date or Datetime. Pandas, Polars and R use
the column's timezone; R uses UTC when none is recorded. DuckDB file sessions use UTC, while standalone generated
code uses the caller connection's timezone. A stored DuckDB instant does not retain its original named zone.

Floor and Ceiling retain exact integer and Decimal values in the Python editing engines, with matching generated
code. Pandas Convert Type rejects values outside its signed integer target instead of wrapping them. The operation
and session-transaction tests cover value boundaries, missing values and rollback.

Round retains exact integer and Decimal values in live and generated Python execution, including half-even ties
and negative precision. Pandas may retain large integers in object storage. Polars, DuckDB and Arrow Decimal output
storage may widen or reduce scale; results beyond usable native capacity are rejected. Arrow Decimal results preserve
existing CSV and Parquet export support. Pandas checks stored Arrow Decimal values before choosing its zero shortcut,
so understated precision cannot silently turn a nonzero rounded result into zero.
Polars Floor, Ceiling and Round support Decimal carries in streaming file previews and generated code, including
values at the maximum precision.

Pandas Formula rejects integer wraparound and lossy floating-point promotion in addition, subtraction, multiplication
and nonnegative integer powers. NumPy, nullable and Sparse integer columns retain correct native results and types,
including exact promotions. Generated code applies the same checks to all affected rows, including those outside
the displayed page.

Pandas Formula supports exact Arrow integer modulo and selected signed/unsigned addition, subtraction,
multiplication and positive integer powers. Successful native results keep their types; supported repairs can widen
to Int64 or UInt64, but the complete result must fit one output type. Modulo preserves nulls and refuses a zero divisor
when both operands are present. Power support depends on the exponent type, column signs and result capacity.

Pandas Formula supports selected Arrow Decimal addition, subtraction, multiplication and division, including
widening to Decimal256 and operations on negative-scale columns. Additional negative-scale support accepts another
Arrow Decimal column, a NumPy, built-in Pandas nullable or Arrow integer column of at most 64 bits, or an exact integer
literal. Sparse, object and custom extension companions are excluded. Native capacity limits can still refuse
mathematically representable results, including empty and all-null inputs outside the supported repairs. Nulls remain
null; native arithmetic determines the result scale and division rounding, so a negative source scale may change.

Live execution and generated code apply the same rules; refusals preserve source data and the confirmed plan.
The [Pandas arithmetic contract](architecture.md#pandas) defines the exact operand domains, widening paths, scalar
identity repairs and Decimal multiplication cases. The existing [export limits](#files-and-exports) still apply.

Polars Formula requires a numeric release version from 1.36 onward for two-column addition, subtraction or
multiplication producing UInt128. Earlier versions and nonnumeric or prerelease version labels refuse this combination
before previewing; scalar forms retain their existing behavior.

Formula preserves newly entered large integer literals through preview, apply, saved plans and generated code.
Polars checks native capacity for these strings on integer columns and for integer arithmetic in saved plans
whose source changes to Boolean. DuckDB retains exact native promotions and refuses the lossy integer results
described in its [experimental support section](#duckdb-experimental-file-support).
R accepts only literals exactly representable by its existing numeric scalar types. Decimal and exponent input
retain floating-point interpretation. Previously rounded numeric plans require re-entering the original literal;
this change cannot recover digits already lost.

Polars Format Datetime uses native Polars syntax and retains time zones and nanosecond fractions. Convert Type to
Datetime preserves an existing Datetime column's unit and timezone; converting it to Date uses its local calendar day.
String-to-Datetime accepts year-month-day dates and `T` or space-separated times at microsecond precision.
Recognized timezone-bearing text is refused when evaluated; other invalid or unsupported text becomes null.
These rules apply to eager and lazy frames, including empty frames, null values and generated code. See
[Polars temporal bounds](architecture.md#polars) for recognized spellings and evaluation limits.

Pandas Convert Type to Datetime preserves Arrow timestamp storage. Converting Arrow timestamps to Date preserves
local calendar days or refuses values outside date32 capacity. Format Datetime uses Python `strftime` syntax with
microsecond fractions and supports native Arrow dates outside the nanosecond range. Unsupported typed formatting
ranges are refused; invalid text retains null coercion. Live and generated code follow the same rules. See
[Pandas temporal bounds](architecture.md#pandas) for capacity, format and timezone details.

Polars grouped median Fill works on the declared minimum runtime, including native integer and Decimal targets.
Its live and generated paths preserve exact values and retain fractional-median and Decimal-scale refusals.

Python Fill interpolation preserves equal nonzero anchors and avoids premature rounding at midpoints between
subnormal endpoints. Other floating-point interpolation retains its existing precision limits; live execution and
generated code agree.

Polars Pivot Longer accepts compatible lazy categorical columns before their values have been evaluated. Shared
category mappings retain their dtype; separate mappings and differently ordered Enums remain incompatible.

Pandas Pivot Wider preserves object identifiers containing `NaT` and mixed scalar values in generated code.
Native Arrow timestamp and duration identifiers retain their exact ticks and remain distinct from null groups,
including the minimum int64 value and dictionary-encoded identifiers.
Integer `1` and string `"1"` remain distinct keys. Generated Group By preserves the same integral object-key values
and dtypes as live execution. Pandas treats its actual `NA` and `NaT` sentinels as missing; similarly named custom
values are preserved in pages, nested cells, Pivot and Fill. Integral objects retain exact Group By keys even when
their class names resemble temporal types. Scalar class names alone do not determine how cells are displayed.
Pandas `Timedelta` subclasses retain nanoseconds. Existing native type and hashability limits remain.

Polars Pivot Wider accepts public identifier and key columns named `len` and output names resembling temporary
columns. Native eager/lazy execution and generated code agree on these names and duplicate null keys.
An empty input produces zero rows even when no identifier columns remain, preserving the declared output types.

## Native values and precision

Missing counts in Pandas profiles and Dataset statistics distinguish ordinary NumPy floating NaN from infinities when the
legacy `mode.use_inf_as_na` option is enabled.

Pandas supports duplicate and non-string labels and exposes named index or MultiIndex row labels independently of
ordinary columns. Column operations bind those inputs by stable identity and position, but name-addressed viewing
filters and sorts fail closed when multiple columns share the same name string. Column choices add position labels when ordinary spaces,
tabs or line breaks would make different names appear identical. Literal names resembling position labels remain
distinguishable. Operations and viewing queries retain the original column names. Polars uses native string column names.
Generated Python checks destination names before appending or renaming a column. Harmless extra columns and valid
in-place replacements remain supported, including after earlier steps.
Generated DuckDB refuses case-insensitive input and intermediate-column collisions, including categorical and Custom Code
results, before later expressions can read the wrong column. Case-only Rename remains supported.
Generated Pandas and Polars Custom Code refuses a zero-column result at the same step as live Preview.
Typed zero-row results, Series and Custom Code that creates a source's first column remain supported.
Custom Code checks lazy output expressions beyond the displayed columns before confirmation, with the same
check in generated code. Polars retains the complete lazy Custom result as described above; replay executes the code
again. Other operations keep their native lazy evaluation and operation-specific guards, without a guarantee that all
later queries will succeed. One-hot encoding and multi-label encoding materialize their results. Explode List retains its current input for the growth check and keeps
lazy expansion over that retained input.

Pandas mixed object columns keep distinct large numeric values in filters, counts, sorting, duplicate removal,
Group By, Pivot and grouped Fill. Selected rows retain their original stored values, and grouped output preserves
its representative labels. Filter text and selected integer tokens keep exact integer values through the UI.
Value choices retain a bounded set of ranked labels; full native counts and text search keep their existing memory costs.
Pandas integer profiles and value choices retain exact counts and values beyond floating-point range. Profiles keep
exact extrema and sums; unavailable approximate statistics show `n/a`, and unrepresentable histograms are omitted.
Extended NumPy floating values that would lose precision or range at the display or selected query boundary are
refused with an explicit conversion message. Representable values remain supported; exact native CSV export and
explicit conversion operations keep their existing behavior.

Polars equality and selected-value filters accept labels absent from an Enum's categories while preserving its type
and declared ordering. Polars Decimal and temporal filters preserve comparison boundaries between stored values,
including full-width Decimal extrema. Pandas native timestamp and duration value selections do not match rounded
neighbors at coarser storage precision. Live viewing and generated Filter Rows agree.

Pandas timestamps preserve nanosecond fractions and time-zone offsets that include seconds, such as historical
Berlin offsets. Grid cells, nested values, profiles and value choices use valid datetime text. Searches recognize
corrected labels while retaining ordinary value counts. Filter inputs retain microsecond precision and minute-resolution offsets.
Datetime value searches also accept displayed midnight labels and a space in place of NumPy's ISO `T` separator.

Pandas object columns treat NumPy datetime and duration `NaT` as null in profiles, filters and cleaning operations,
including generated code. Floating NaN remains separate.

Python duration cells preserve exact seconds, including large microsecond values and NumPy unit multipliers.
Selections from Pandas duration choices or the grid must fit microsecond precision and the Python timedelta range.
Finer or wider values cannot be selected. Pandas durations stored in seconds, milliseconds or microseconds remain
displayable outside the nanosecond range.
Duration filters in Pandas, Polars and DuckDB retain exact microseconds when notebook code changes Decimal precision,
including in generated Python. Calendar and unitless NumPy durations remain displayable but cannot be selected as seconds.
Previously saved selections with rounded temporal values must be cleared and reselected.

Pandas object duration choices count and compare fixed-unit NumPy, ordinary Pandas and Python duration values by
exact elapsed time. Equal values share one choice with the first source spelling. Live and generated filters retain
fine-unit neighbors and wide values without converting the source to nanoseconds. Mixed columns containing an
ordinary NumPy or Pandas duration together with calendar/unitless durations or custom scalar types refuse counts
and present-value comparisons; paging and null-only filters remain available. Pure custom-only columns keep their
existing native behavior.
Built-in Python timedelta object columns keep their source spelling in profiles and value choices, so displayed
labels can be searched without changing counts or selection values. Object duration searches retain their existing
representation limits.

Pandas Arrow duration pages, profiles and choices preserve valid int64 extrema and dictionary labels. The minimum
microsecond value remains selectable; native and generated filters compare it exactly without an overflowing conversion.

NumPy-backed Pandas duration columns and categories search the labels shown in value choices, including whole days
and large durations. Direct and dictionary-encoded Arrow duration columns and Arrow-backed duration categories also
accept their displayed labels while retaining native raw-text searches. Matching unused duration categories remain
available with zero counts. Supported Sparse choices search displayed labels, including whole days, and retain raw
clock matches.

Pandas temporal categories preserve exact displayed values, missing counts and directional Fill anchors. Supported
duration choices select the exact stored rows, including positive NumPy unit multipliers and Arrow extrema, in live
and generated filters. Values outside the existing filter range or precision remain visible with selection unavailable.
Zero-unit duration categories remain viewable but refuse nonempty duration membership.

Pandas Sparse durations with positive second, millisecond, microsecond or nanosecond multipliers preserve physical
values in cells, choices, profiles and value selections, including generated filters. Simple Sparse duration index
labels retain the same values. Value selections follow the bounds above. Scalar preparation for these operations and
export refuses zero-unit Sparse durations and used fills that cannot be represented exactly; unrelated operations
retain their native limits. Profiles, choices and nonempty membership also refuse finer units, calendar or unitless
storage and multiplied coarse units, including some representable values.
Ordinary coarse units and existing empty/null page behavior remain available.
CSV export refuses nonempty multiplied Sparse duration data or preserved indexes before changing the destination;
empty exports and omitted indexes remain available.

Polars Datetime and Duration columns retain nanoseconds in grid cells, value choices and profile labels, and datetime
offsets retain seconds. Duration choices now work and use native signed-unit labels, such as `1m 40s 1µs`.
Datetime labels retain the native unit's three, six or nine fractional digits. Search accepts the displayed labels,
padded fractions and either a `T` or space datetime separator.
Values beyond the existing filter precision remain visible but cannot be selected. Datetime and Duration values
inside Polars lists, fixed arrays and structs retain their precision in grid text, copied cells and profile labels.
Null containers, null children and empty containers stay distinct. Complex-value selection and comparisons remain unavailable,
and native List value-choice requests can still refuse.

Python engines refuse nested mapping output when distinct keys would become the same JSON key, such as `1` and `"1"`.
Pandas row-index labels use the same refusal rule. The source remains unchanged, and pages excluding the affected
rows remain available. Projecting other data columns can omit a problematic cell but cannot omit a row-index label.
This check cannot restore entries already lost when an engine converts native values to Python.

On Pandas versions that infer temporal count keys from object columns, profiles and value choices refuse nonzero
NumPy datetime values with unit multipliers or units finer than nanoseconds. Fixed-unit duration counts use exact
comparison keys instead. This conservative datetime restriction includes some exactly representable values, such as `datetime64[1000ps]`,
and prevents choices from selecting the wrong source rows. Profiles and choices also refuse calendar and unitless
NumPy durations, including zero, when the count index would assign them a fixed unit. Native datetime/duration columns
and current Pandas object-preserving counts are unaffected. Paging remains available after refusal.

Python datetime filters and explicitly entered Fill values accept fractions up to six digits and timezone offsets
with or without a colon. These spellings behave consistently on Python 3.10 and newer; malformed offset components
are rejected.

Pandas Arrow date columns, including Parquet imports, retain date-range profiles, typed filters and stable sorting.
Parquet imports preserve exact nullable integer row-index values, including adjacent integers above 2^53. Row labels
follow filtered and sorted rows in file sessions.
Present extreme Arrow timestamps and durations also keep exact row labels, including copied row-index text,
instead of appearing as null. This preserves existing index and MultiIndex label conventions.
Nullable integer data and integer children in lists, structs and maps also retain exact values and missingness through
editing and export. Repaired columns use native Arrow storage; unrelated columns keep ordinary Pandas decoding.
Parquet Struct columns containing nanosecond timestamps through Struct or List children also preserve their timestamp
types through native editing, generated Clone and Parquet export. This includes large and fixed-size lists. Display,
text conversion, comparisons and CSV export refuse present minimum nanosecond timestamps or durations in those
children or Map siblings instead of treating them as missing. Other native endpoint and timezone limits remain.
Profiles, value choices and single-column duplicate comparisons preserve exact nested integer values and missingness.
Pandas can refuse to count duplicates across columns containing lists, dictionaries, sets or NumPy arrays. Dataset
statistics retain exact missing-value counts for those native unhashable-key failures, and show the duplicate count
as **Unavailable for these column values**. Other native failures retain their errors; cleaning operations are unchanged.

Nonempty lazy Polars frames with Object columns also retain exact Dataset missing-value counts and show the duplicate
count as unavailable. Empty frames retain zero counts. Eager statistics keep their native behavior; Object-column
profiling remains unsupported.

Native Pandas Arrow `bool8` and UUID columns support logical cell values, profiles, value selections, sorting and
existing compatible cleaning operations. Nonzero `bool8` storage reads as true; UUIDs use canonical strings.
Selected rows retain their original native arrays. CSV and Parquet exports preserve the logical values, including
selected index levels. Native extension Parquet files reopen with the same logical Boolean and string values.
Pandas object-dtype UUIDs also share their canonical text value with profiles, selections, sorting, duplicates and
exports. UUID objects and matching canonical strings count as one value; other spellings remain distinct. Selected
rows retain the original UUID objects, and unrelated object values are not converted to strings.

Pandas scalar Arrow dictionaries use logical values for profiles, value selection, filters, sorting and row removal.
Null dictionary entries and duplicate values across chunks retain their meaning. Nested and arbitrary extension
dictionary values do not gain scalar operations.
Convert Type uses the dictionary's logical input type, so valid casts work across chunks and signed-integer range
checks also cover encoded unsigned values.
Fill supports logical dictionary values across its existing methods and retains encoded targets when no cells change.
Generated Fill code treats native Arrow dates as dates, including empty and all-null columns.
CSV and Parquet writers support scalar dictionary columns and preserved index levels, including null codebook entries.

Nullable Arrow integers, timestamps and durations preserve exact duplicate membership, including nanosecond
differences, in live and generated row removal and dataset duplicate counts. Retained rows keep their original arrays.
Arrow timestamp and duration missing-value filters, pages and profiles preserve present nanosecond extrema.
Supported Fill methods retain valid temporal values in targets, donors and directional anchors. The minimum
nanosecond timestamp is displayed; using it as a filter value remains unsupported under the existing input precision.
Group By, Pivot and grouped Fill share missing-value and signed-zero key equality for Arrow float32/float64 columns.
Group By preserves computed NaN separately from an empty group's null result.

Pandas integer filtering, sorting, directional Fill and Drop Duplicates preserve exact large values in Sparse columns,
including returned columns that were not used as keys. Sparse integer dataset duplicate counts agree with the existing
exact row-removal comparison. Missing-cell totals agree with per-column counts for Sparse and mixed Dense/Sparse dataframes.
Group By Count accepts Sparse columns, including missing and empty inputs, while preserving other aggregates on
the same column.
Group By, Pivot and grouped Fill preserve distinct Sparse integer keys, including adjacent large values and native
fill values. Current Pandas still rejects fractional fills that only the supported minimum accepts.

Polars and DuckDB enum profiles and typed filters use string values even when category labels resemble numeric or
container type names. Fixed-size DuckDB arrays remain containers, with unsupported comparisons and sorts refused.
Polars By Example supports exact unsigned cancellation and multiplication by zero on the minimum runtime.
Polars and DuckDB refuse By Example date transformations when native month-name parsing or formatting disagrees with
the supplied examples. Numeric month values or Custom Code can express an alternative. Matching examples do not
guarantee the intended language on other rows; inspect Preview before applying the transformation.
Polars One-hot and Multi-label generated code supports dropping every original column, including on single-column
inputs. Pandas and Polars generated categorical code rejects results with no visible columns, matching live Preview;
empty-row inputs remain valid when a visible column is retained.
Generated Pandas One-hot names preserve native floating-point labels, keeping later column bindings and collision
checks aligned with live results.

## Viewing and editing controls

Generated Python Filter Rows rejects reused inputs whose selected filter columns have changed semantic type.
DuckDB also refuses missing filter or sort columns instead of silently skipping their rules. Compatible physical
types, including different integer widths, remain usable; existing column-binding requirements still apply.

Filter choices retain their counts while selecting values in the same column. Changes to the other filters, sort
or AND/OR logic clear affected choices; Search loads the current choices without changing existing selections.
Opening value filters from a header, the Filters tab or Show More selects the requested column with fresh search input.
Editing a sort from the sidebar selects its column while preserving unfinished filter and sort input.
Sort edits made while an earlier query is pending remain available if that query fails; applying them stays explicit.
New filters can replace a pending filter Undo; confirmed changes remain undoable.
While new filters or sorts are loading, value-search text stays editable; Search becomes available when the view is ready.
Pandas and Polars keep values visible and searchable when they cannot be selected within the supported precision or
range. Those actions are unavailable in the picker, summary and header profile; supported values use exact filter
operands. Existing saved selections remain removable through the filter controls.

A refused Python viewing page retains the previous query. Editing uses the
[accepted viewing query](architecture.md#protocol-and-publication) even after a successful page is superseded.
Spark preserves that view's paging state through failed or superseded replacements.
Concurrent grid presentation saves preserve current sort publication and newer file-session recovery state.
Failed recovery-storage writes retain the current selection and layout during the session. Reopening uses the last
successfully saved state, as the storage warning explains.
Saved cleaning steps and drafts require Editing mode. A Viewing open preserves saved work. For sources that support
Editing, it explains how to change the start-mode setting, close the panel and reopen the same dataframe.
If a saved cleaning plan cannot replay, Open Wrangler asks before discarding it to reopen original data. Dismissing
the prompt keeps the saved steps and draft for another attempt; an explicit reset starts a new plan.
Runtime recovery refreshes the grid and profiles together, while retaining a failed operation's inputs and error.
A newer page request takes precedence over a pending recovery refresh.
When a Python dataset shrinks, paging can return the valid empty end and the grid moves back within the remaining rows.
If the recovered grid cannot be read, Open Wrangler reports the failure and keeps any existing complete view.

The operation catalog search exposes its accessible name before and after entering a query.
Moving or removing a focused form row, or clearing unavailable selections, keeps keyboard focus inside the operation dialog.
Column search keeps arrow and page-key navigation aligned with the displayed results when cleaning changes the schema.
Small editor panes preserve room for the grid header and a row while the workbench scrolls around wrapped controls.
In narrow panes, the source name and actions share toolbar rows when space allows.
Column profiles and filters stay beside the grid, or below it in narrow panes, without covering the selected cell.
Selecting an uncalculated statistic in native Summary opens the Dataset view and requests its counts. Failed requests
show their error with an explicit retry instead of continuing to display a profiling indicator.
R honors the header-profile opening preference, as local Python engines do; PySpark still starts with profiles off.
Sampled distributions show the sample count used and the full non-missing population.
Compact categorical headers group every value outside their three displayed categories into Other.
Expanded header profiles align their statistics dividers and center complete chart groups across the visible columns.
Mixed chart types can increase header height; the existing compact mode preserves space in short editors.
The stacked layout shows fewer rows and scrolls to reach longer filter forms.
During applied-step inspection, **Viewing filters paused** expands to reveal the retained rules. Clearing inspection
restores the full viewing-filter bar.
Column search reveals and focuses its target within both the table and editor viewport, including when the same column
is selected again, without replacing a later focus choice.
Focused draft buttons return keyboard focus to Add step, and deletion confirmation retains focus through Cancel.
Read-only Code Preview supports Tab entry and keyboard navigation through long programs while refusing edits.
Code Preview identifies a completed applied-step inspection above the code, including in the default docked panel. Copy and script
export use the displayed code, including manual edits; cleaned-data export still uses the committed plan.
History inspection controls ignore stale clicks after switching dataframes or changing the plan.
Formula steps expose their saved output names in Cleaning Steps tooltips and accessible names, including after later
Rename or Drop steps.
Numeric histogram arrows use the highlighted bin as their starting point after pointer hover.
Integer-bin clicks use whole-number bounds and include the final upper edge. Filtering from rounded large-integer
histograms is unavailable; use explicit column filters or exact value choices. Their hover and keyboard descriptions
remain available.
Staged viewing sorts retire rules invalidated by Rename, Drop, identity replacement or a semantic type change.
Unaffected staged rules remain, and Undo does not restore a rule already retired from the draft.

Redo re-executes the latest undone command in editing-capable Python and native R sessions. Multiple Undos retain
their command order; a new committed branch clears them. History lasts only for the current runtime session,
including renderer remounts, and ends on close or recovery. Custom Code can produce a different result when re-executed.
Pandas, Polars, DuckDB and native R reuse one input/output pair while inspecting a step whose prefix includes Custom Code.
Paging and changing visible columns preserve that inspected result. The first inspection can differ from the original
Apply. Retention can hold full frames and, for DuckDB, private native checkpoints. The pair lasts until another step is
inspected, the revision changes, the source is invalidated, or the session closes.
Successful history changes close saved-step editors so reopening a step uses its current input schema. Failed
changes and ordinary new-operation forms retain typed input.
Earlier-step edits and deletions remove viewing filters and sorts made incompatible by the resulting schema while
retaining unaffected rules. Applying an earlier replacement can restore its saved view on columns recreated by the
remaining steps; viewing changes made during the draft take precedence.
The button and registered command share the normal draft, pending-work and trusted-execution gates; no default
keyboard shortcut overrides text-field editing.

Delayed grid navigation preserves newer header and control focus. Column drags stop after host view restoration,
a logical-view change or disabled controls.

Unnamed columns support viewing, profiling, keyboard selection, and copy. Their cell menus, header sorts, profile
actions, and Filters / Sorts consistently disable name-addressed actions without leaving a page request pending.
Toggling an ordinary value preserves null and NaN selections. Saved scalar selections remain checked where the picker recognizes their typed equivalent.
Other raw selections may have no checked counterpart and remain removable through their chips. Saved Filter Rows steps accept historical `inf` and `-inf` values
without dropping the cleaning plan during replay.
Python and native R reject malformed viewing structures before execution. Native R applies the same array and
logic admission checks to Filter Rows drafts; valid empty filters and existing native operand behavior remain.
Python also rejects over-nested, non-finite or invalid-UTF-8 viewing operands before query work, preserving the
runtime for a valid follow-up. Exact wide integers and supported opaque JSON values retain their representation.
Recognized Polars panic exceptions return a request error in standalone and notebook sessions, preserving the prior
confirmed state for a follow-up request. This does not recover a native process crash.

Multi-column cleaning forms support search, including Select/Drop columns, Drop missing rows, Drop duplicates, Mark duplicates,
One-hot encoding, Group keys, and Transform by example. Search retains hidden and saved column selections so Preview
submits their original references in the required order. Searching alone leaves optional full-schema defaults unchanged.
If a schema change removes selected columns, forms retain those dependencies until the user explicitly clears them.
The repair message explains when this will select all columns. A nonempty search remains clearable after the schema
shrinks to one or zero available columns.
Single-column forms also retain targets across schema changes. A missing or incompatible target displays an empty
selection and requires a new choice before Preview; it does not silently switch to the first available column.

Visual baselines and axe scans are not exhaustive assistive-technology certification or proof that every virtualized
cell is simultaneously present in the DOM.

## Release rule

A stable release requires every required Pandas and Polars row above to be **Done**, no known release-blocking defect,
and one exact candidate to pass the [qualification flow](releasing.md#release-candidate). Outside the required
Pandas/Polars table, accurate Preview, experimental, Partial, Unavailable and Out-of-scope labels do not themselves block
stable publication. Explicit candidate checks, including the R notebook matrix, must still pass.

## Native R support

R notebook support is stable since Open Wrangler 2.5.0 for the ordinary frame scope below in IRkernel notebooks
in desktop VS Code on Linux, macOS and Windows. Published 2.4.0 keeps R support Preview; its candidate did not include
the three-platform R notebook qualification.

Native R already supports paging, typed filters, sorts, profiles, cleaning, generated R and data export within the
limits below. Support labels describe the qualification commitment for each entry path.

| Entry path                                          | Support                                                                                       | Generated code and data export                         |
| --------------------------------------------------- | --------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| IRkernel notebook in desktop VS Code                | Stable since 2.5.0 on Linux, macOS and Windows; exact notebook, kernel and variable ownership | Copy, save, notebook insertion, CSV and Parquet        |
| Active terminal managed by the official R extension | Preview on Linux; exact terminal and process ownership                                        | Copy, save, CSV and Parquet; no document for insertion |
| Managed `.R`, `.Rmd` or `.qmd` document             | Preview on Linux and macOS; exact document/version and owned R process                        | Copy, save, source-document insertion, CSV and Parquet |
| Local CSV, TSV, Parquet, JSONL or Excel file        | Preview on Linux and macOS; exact file/options and owned R process                            | Copy, save, CSV and Parquet; no document insertion     |
| IRkernel notebook in Cursor on Linux                | Experimental editor compatibility with narrower coverage                                      | Only the capabilities of its documented execution path |

The [architecture](architecture.md#native-r) defines frame, precision, source and transport guarantees.
[Testing](testing.md#native-r-editor-dependencies) identifies the native and installed checks for each path.

Local R files use a base `data.frame` with the existing R cleaning operations. File sessions can restore saved plans;
live R notebook, document and terminal sessions do not use workspace persistence.
Select R explicitly in the engine picker or `openWrangler.defaultBackend`, or let Auto select R when no compatible
Python interpreter or file engine is available. Switching between R and Python opens a separate session and retains the original plan.
R import-options changes also create a separate session. **Open Another File with This Plan** remains Python-only.

R CSV/TSV imports accept UTF-8, explicit UTF-8-lossy, UTF-16LE/BE, ISO-8859-1 and Windows-1252, with distinct ASCII
delimiter/quote choices and LF, CRLF or CR records. Quoted CR/CRLF normalize to LF. Headerless input and duplicate/empty
column names are supported; malformed records and strict decoding failures are refused. Empty and `NA` fields are
missing; dates and integers that would lose precision stay text. R loads the full file into memory before returning
bounded pages, and editing can require additional copies. It needs Rscript, not Python. Parquet and JSONL/NDJSON
also admit flat scalar data; Excel opens the selected worksheet. Parquet requires `nanoparquet`, Excel requires
`readxl`, and large integer input requires `bit64`. The [reader contract](architecture.md#parquet-jsonl-and-excel-files)
describes type and precision limits, spreadsheet missing-value rules and eager loading. Windows file execution
remains unavailable.
Installed CSV workflows have been verified in desktop VS Code on Linux and macOS. The
[macOS check](https://github.com/Matt17BR/openwrangler/actions/runs/35094083555/job/104787104263) covers native cells,
Rename Preview/Apply, generated R, protected all-row CSV export and session/process cleanup. Local R file support is
Preview; this evidence does not qualify Windows file execution or every parser option.

### First stable R notebook scope

The stable R notebook scope for 2.5.0 covers ordinary base `data.frame`, tibble and `data.table` values in IRkernel notebooks
in desktop VS Code on Linux, macOS and Windows. It includes viewing, the supported cleaning catalog and history,
generated R copy/save/insertion, CSV/Parquet export and kernel-restart recovery. The frame and export limitations below
are part of that promise, including the ordinary default collapse outputs. Terminal and managed-document paths
remain Preview; Cursor remains experimental.

The [2.5.0 candidate](https://github.com/Matt17BR/openwrangler/actions/runs/34852510128) passed the default journeys
on all three platforms on its original attempt, using the same immutable VSIX. The
[delivery issue](https://github.com/Matt17BR/openwrangler/issues/1381) records matching native/source evidence,
package and runtime versions, reliability review and publication verification. Later stable releases retain the
[native and installed qualification requirements](releasing.md#release-candidate).

The historical [R acceptance timeout](https://github.com/Matt17BR/openwrangler/issues/1088) remains unexplained;
later passes do not establish its cause or recurrence rate. Unsupported grouped/indexed objects, full Quarto rendering,
Windows managed-document execution and alternate dplyr/collapse code dialects remain outside this notebook scope.

Supported frames are base `data.frame`, tibble and `data.table`, including ordinary default `collapse::qDF()`,
`qTBL()` and `qDT()` outputs. Grouped `GRP_df`, `indexed_frame`, unsupported attributes and unsupported cell classes
are refused. IRkernel works across the supported desktop platforms; direct `.R`, `.Rmd` and `.qmd` execution is
limited to macOS and Linux. Literate support runs selected lexical R cells, without promising document-render
semantics. An active R terminal has no source document for generated-code insertion.

Sessions honor the opening and ordinary request timeout settings; invalid values use defaults and fractions round
upward to whole milliseconds. Exports retain their separate 30-minute default. Large R profiles count every finite
value in numeric histograms and retain exact categorical counts within the [documented memory bounds](architecture.md#viewing-and-profiling).
Larger categorical distributions and duplicate estimates label their sampled population. Large numeric columns retain
exact distinct counts through 10,000 values; higher cardinalities and large numeric medians remain unavailable. An oversized page returns a request error; a smaller page remains
available without restarting the standalone runtime.

The [generated reference](reference.md#transformation-operations) lists the complete operation set and parameters.
Custom Code can call installed packages such as `dplyr`, `data.table` and `collapse`, and return a supported base
`data.frame`, tibble or `data.table` even when the input uses another admitted class. Preview, history, profiling,
export and generated code retain that result's class. Grouped objects, unsupported attributes and cell classes still
require an explicit conversion. Missing packages and failed code leave the confirmed result available.
Custom Code can create the first column of a supported zero-column source, with inspection, Undo and Redo. Drop
Missing Rows and Drop Duplicates may retain an empty schema; Custom Code output still requires a column.
Sorting and reducing rows work with ordinary `read.csv` inputs, preserving native row-name behavior. Active
`data.table` keys restrict in-place changes. Fill interpolation requires ordinary numeric or temporal coordinates
and does not accept integer64 coordinates. Formula accepts exactly representable large integer literals and refuses
inexact neighbors; ordinary R arithmetic limits still apply. Integer and integer64 aggregate outputs retain their
native range limits. One-hot encoding refuses a selection that produces no indicators, including solely empty or
all-missing duration columns. Other selected columns can still contribute categories. One-hot and Multi-label can
replace every original `data.table` column, including on single-column inputs, with matching generated R code.

CSV export uses UTF-8, double quotes and LF records. Fractional durations retain decimal points regardless of
`OutDec`; duration NaN refuses export because the writer would otherwise make it indistinguishable from missing.
Dates, timestamps and integer64 values are quoted when using custom delimiters. Numeric and logical columns with
non-missing values refuse delimiters their native text could contain, even when the current values do not contain
them. Comma, tab, semicolon and pipe remain available; empty and all-missing columns do not impose this restriction.
Timestamp rounding carries invalid `:60` seconds into the correct date and local time, including DST transitions.
Timestamp text can still lose precision and omits time-zone information. Review the [export rules](architecture.md#native-r)
before using CSV to transfer timestamps.

Parquet export requires `nanoparquet` 0.5.1 or newer in the selected R environment. Timestamps must be exactly
representable in microseconds; sub-microsecond values and some values reconstructed by differently rounding readers
are refused. Missing timestamps remain supported. A refused export preserves the source and cleaning plan.
Notebook export is available only from the current local extension host.

## DuckDB experimental file support

CSV, TSV, JSONL/NDJSON and Parquet imports preserve the selected file when ordinary filenames or directories contain
wildcard characters. Unix paths combining backslashes and glob syntax, and Windows drive/share/device anchors with
glob syntax, are refused. Choose another supported engine or a path without those characters. Ordinary local-drive
paths retain native lazy reading; the full cross-platform import matrix remains incomplete.

CSV and TSV imports retain literal `#` values and disable automatic preamble skipping. Files beginning with CR or LF
after an optional UTF-8 BOM are refused, including leading blank lines and an empty one-column first record. Use
Pandas or Polars for these files. Empty/BOM-only files, leading spaces, missing first TSV fields and ordinary quoted
multiline fields remain supported. A BOM before a quoted multiline header can cause a native refusal. Irregular
nonempty records must parse without skipping or cause an import refusal.

CSV and TSV headers containing an ASCII apostrophe (`'`) are refused because the supported DuckDB serializer can change
their names when reopening the native query. Use Pandas or Polars for those files. Apostrophes in file paths, headerless
values, JSONL keys and Parquet headers are supported. Standalone generated programs given an externally loaded DuckDB
CSV relation with affected headers inherit the same native limitation.

DuckDB CSV, TSV, Parquet and JSONL sessions run natively, without converting through Pandas, Polars or Arrow.
Generated programs reuse the input relation's connection, including its private tables and functions. Live and
generated execution check computed cleaning results beyond the displayed rows and columns before confirmation.
Rename, Select Columns and Drop Columns remain lazy, so later reads can reveal source errors. Volatile inputs can
change after validation. The [DuckDB architecture](architecture.md#duckdb) defines connection setup, cleanup and
validation costs.

Caller-defined DuckDB functions do not replace Open Wrangler's viewing statistics, value searches or filter tests.
Functions used by the source relation keep their original behavior.

For top-level `TIMESTAMP_NS` columns, the grid, filter choices and profiles display timestamps without rounding.
Exact microsecond values remain selectable. Finer fractions and timestamp infinities can be displayed but cannot be
selected with the current filter format; choices are disabled and cell-filter requests refuse without changing the view.
TIMESTAMP_NS values inside DuckDB lists, arrays, structs and maps also retain their precision in grid text, copied
cells and successful profile/choice output. Distinct timestamp Map keys keep their associated values. Top-level Maps
with scalar Union keys refuse display if Python would merge distinct entries. Maps nested inside other containers
remain outside this check; Union values can still lose temporal precision or member distinctions. Complex-value
selection and comparisons are unavailable; profiles and choices can still refuse values near the lower nanosecond
endpoint. Native source values and generated transformations retain their existing behavior.

DuckDB Convert Type to Datetime preserves typed timestamp precision and TIMESTAMPTZ instants. Converting nanosecond
timestamps to Date keeps their calendar day. Format Datetime uses DuckDB syntax, preserving nanosecond fractions and
wide dates; zoned values use the execution connection's timezone. Formatting can refuse finer-than-microsecond values
near the lower nanosecond endpoint; exact microsecond-aligned values remain supported there. These rules apply to live
and generated code. Use Custom Code for explicit precision or timezone conversions.

Split Column delimiters and literal Find/Replace values can contain NUL characters in live and generated DuckDB code.
Leading, trailing and repeated delimiters preserve empty fields; missing fields and null source values stay null.
Generated One-hot encoding preserves binary categories even when the input connection defines a `from_hex` macro.

Formula rejects lossy DOUBLE promotion for addition, subtraction, multiplication and modulo on native integer types
through 128 bits, retaining correct results and types. Live and generated checks use the same operand pair; explicit
floating and Decimal inputs, division and power retain native behavior. Programmatic and generated multiplication
and modulo also check BIGNUM integer pairs. Selected BIGNUM operands must fit the signed 128-bit range, apart from
native zero results proved by zero-product or unit-divisor identities. Wider pairs can refuse even when their result
is exact. Null operands and modulo by zero retain native behavior. BIGNUM remains outside numeric form choices.

Generated Sort Rows preserves input columns and stable ties after Rename or when a saved program runs on new input.
Live and generated Pivot operations preserve valid requested output names, including names resembling temporary
columns. Multi-label Encoding accepts `label` as an input or unrelated column name, with matching null and empty-label
behavior. Reused Sort Rows, Pivot Wider, Drop Duplicates and Mark Duplicates programs reject missing selected inputs.

Drop Duplicates retains original floating values, including negative zero in LIST and STRUCT keys, in live and
generated code.

Parquet exports store top-level HUGEINT/UHUGEINT values exactly as Decimal with up to 38 digits, preserving nulls.
Values outside that range and nested 128-bit integer fields are refused before publication. These fields reopen
with Decimal storage. Parquet also refuses interval precision or capacity loss and time-zone map-key changes.
Top-level TIMETZ values retain their UTC time; DuckDB 1.5.4 requires explicit conversion for nested nonzero offsets.
Representable intervals, compatible keys, nulls and empty containers remain supported. CSV retains its native text
output.

| Surface                                      | Availability       | Status      | Current evidence                                        | Limit or missing proof                              |
| -------------------------------------------- | ------------------ | ----------- | ------------------------------------------------------- | --------------------------------------------------- |
| CSV and TSV file sessions                    | Yes                | Partial     | Native lazy reader and packaged import slices           | Complete import-option and cross-platform matrix    |
| Parquet file sessions                        | Yes                | Partial     | Native typed pages and source invalidation              | Large-scale and repeated cross-platform matrix      |
| JSONL file sessions                          | Yes                | Partial     | Native malformed-input and packaged import              | Installed malformed/import-state interaction matrix |
| Excel file sessions                          | No                 | Unavailable | Explicit unsupported diagnostic                         | Use Pandas or Polars                                |
| Local database base-table browsing           | Viewing only       | Partial     | Native owners and installed Linux/macOS/Windows pickers | No views; shared native resources between viewers   |
| Notebook variables and inline MIME rendering | Viewing only       | Partial     | Native relation package slices                          | No cleaning, code insertion, or data export         |
| Grid pages, typed cells, filters, and sorts  | Yes                | Partial     | Native rich-type and query contracts                    | Large-scale mixed-data and cross-platform matrix    |
| Summaries, statistics, and distinct values   | Yes                | Partial     | Native fixed-size profile contracts                     | Repeated large-data resource evidence               |
| Supported cleaning operations                | File sessions only | Partial     | Exact direct live/generated catalog equality            | Complete installed catalog and semantic-edge matrix |
| Draft preview, diff, apply, and history      | File sessions only | Partial     | Runtime and representative packaged lifecycle           | Complete edit/discard/undo interaction matrix       |
| Executable generated DuckDB code             | File sessions only | Partial     | Direct equality and packaged copy/script slice          | Edited-code execution acceptance                    |
| CSV and Parquet cleaned-data export          | File sessions only | Partial     | Native export and publication failure tests             | Cross-platform installed destination matrix         |
| Runtime crash/reload/session replay          | Yes                | Partial     | Backend-keyed replay and injected recovery              | Repeated cross-platform failure matrix              |
| Runtime performance benchmark                | Diagnostic         | Partial     | Direct and stdio smoke                                  | No strict DuckDB release threshold                  |

DuckDB file imports support CSV, TSV, Parquet, and JSONL. A multibyte quote character is incompatible and fails
before runtime startup. CSV export is UTF-8 with single-byte delimiter and quote syntax. DuckDB rejects schemas whose
identifiers differ only by case. Notebook `DuckDBPyRelation` values are captured on their explicitly selected originating
connection for serialized viewing only. Closing releases Open Wrangler's references and never closes the user's
connection. See the [capture requirements and costs](#sessions-and-generated-code).

**Open Wrangler: Open DuckDB Table** chooses a local database and one base table without SQL. It supports viewing,
filters, sorts and profiles through a retained read-only connection. Multiple tables from the same database can stay
open in one Python runtime. Close all its viewers before using a writer. Views, SQL editing, cleaning, code generation and
exports remain unavailable for database tables; references to DuckDB file editing above mean CSV, TSV, Parquet and JSONL.
Computed columns keep their native expressions and can change between queries. No immutable snapshot is promised.
If a page extends beyond its reported row total, it is refused while the previous view is retained. Use stable inputs
for repeatable filtering and counts; other differences between volatile evaluations may not be detected.
Readers share DuckDB's worker, memory and spill resources. If the database file changes while a viewer remains open,
close its existing viewers before opening the replacement. Different path aliases are not guaranteed to share a reader.
Current and minimum native owners cover exact table selection, WAL preservation, writer conflicts and cleanup.
A focused Linux check observed private disk spill during an integer sort on both native versions with a reduced
query-memory allowance. Other memory-limited queries can still fail; see the
[database qualification scope](https://github.com/Matt17BR/openwrangler/issues/1387).
The installed file-input journey verifies the command, both pickers, exact selected-table rows, filtering and reader
cleanup in [macOS/Windows](https://github.com/Matt17BR/openwrangler/actions/runs/34947969563) and
[Linux](https://github.com/Matt17BR/openwrangler/actions/runs/34947972421) VS Code. These source-build checks preserve
the database bytes; they do not qualify views or simultaneous viewers.

## PySpark live-notebook viewing

Only stable/final PySpark 4.2.x local Classic and local Connect batch DataFrames are supported. PySpark is
notebook-only and viewing-only. It uses the notebook's existing Spark session and never converts through a local
dataframe engine.

| Surface                                        | Availability       | Status       | Current evidence                            | Boundary                                    |
| ---------------------------------------------- | ------------------ | ------------ | ------------------------------------------- | ------------------------------------------- |
| Local Classic DataFrame viewing                | Live notebook only | Done         | Direct stable/final-version path            | Installed prerelease denial is unearned     |
| Local Spark Connect DataFrame viewing          | Live notebook only | Done         | Direct and installed local Connect path     | Local Connect only                          |
| Progressive projected grid pages               | Viewing only       | Done         | Lookahead, accepted-view and terminal tests | Sequential paging with bounded anchors      |
| Basic/advanced filters and multi-column sorts  | Viewing only       | Done         | Native expressions and packaged queries     | Unique final key needed for repeatable ties |
| Summaries, statistics, and distinct values     | Viewing only       | Done         | Native fixed-size aggregate tests           | Header profiles start off                   |
| Session recovery and non-interrupting disposal | Viewing only       | Done         | Classic/Connect rebind and cleanup          | Running Spark work is not interrupted       |
| Cleaning operations and history                | No                 | Out of scope | Editing capability is absent                | No distributed transformation plan          |
| Script/notebook/data export                    | No                 | Out of scope | Export capability is absent                 | No Spark export contract                    |
| Saved-output MIME formatter                    | No                 | Out of scope | Saved-output capability is absent           | Live variables only                         |
| File sessions and automatic backend selection  | No                 | Out of scope | File capability is absent                   | Notebook variables only                     |
| Streaming, external, or authenticated clusters | No                 | Out of scope | Local batch contract only                   | No authentication or provisioning           |

The first page does not count, globally index, cache, or persist the whole dataframe. Paging advances sequentially;
only a short terminal page establishes an exact total. Spark does not promise source order, and repeatable sorted ties
need a unique final key. Queued or stale work is dropped, but running notebook work is detached and ignored rather
than interrupted. Persistence, Spark provisioning, cluster authentication, and lifecycle ownership remain outside
the contract.

## Reuse a file cleaning plan

**Open Wrangler: Open Another File with This Plan** opens a separate Editing session with a confirmed built-in
plan from a Pandas, Polars or DuckDB file session. The selected file must have matching original column names and
types, in any order, and uses the same engine and import options. The target keeps its column order unless a cleaning
step changes it. An unfinished draft, Custom Code, ambiguous column names, a target already open in Open Wrangler,
or saved target work prevents reuse. Full replay must succeed before the new session is shown. Viewing filters and
sorts are not copied, and both source files remain unchanged.

Mapping renamed columns, notebook inputs, recipe files and batch execution remain unavailable. DuckDB keeps its
experimental file-editing status. Source evidence: test:src/test/fileOpen.unit.test.ts;
test:src/test/sessionCoordinator.persistence.unit.test.ts; test:src/test/sessionPersistenceStore.unit.test.ts.
The [architecture contract](architecture.md#sources-sessions-and-data-flow) records source identity and late-cancellation
semantics. The existing daily-core journey owns the installed command, file picker and rendered target interaction.

## Deferred and unsupported scope

These dispositions do not block stable publication unless a release starts advertising the capability.

| Surface                                                                                   | Current disposition                                                                                     |
| ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Cleaning-step reorder                                                                     | Deferred; edit and delete earlier steps are supported, but no move primitive exists                     |
| Transpose and recursive flattening                                                        | Unavailable; see the supported List and Struct operations above                                         |
| General windows, partitioned ranking, and data-quality assertions                         | Unavailable as built-in operations; Dense Rank is available                                             |
| Joins and merge                                                                           | Deferred until multi-source identity, lifecycle, persistence, and source-immutability have one design   |
| Portable cleaning recipes and batch apply                                                 | No public recipe format or batch runner; exported native scripts can be reused                          |
| Natural-language and Copilot operations                                                   | Unavailable                                                                                             |
| DuckDB Excel and database views                                                           | Unsupported; use Pandas or Polars for Excel files; database base tables have a viewing-only entry point |
| Debugger variables and non-dataframe list, dictionary, array, tensor, or scalar renderers | Deferred entry-point and data-model work                                                                |
| Browser, code-server, virtual-workspace, and Remote SSH hosts                             | Not release-qualified; the desktop target is VS Code and editors based on it                            |
| VS Code-based desktop editors                                                             | Bounded Linux Cursor platform smoke is representative; broader compatibility remains experimental       |
| Localization and telemetry                                                                | Deferred product breadth                                                                                |
| Broader cross-engine CSV codec parity and polished row-header presentation                | Deferred                                                                                                |

Current proposals and their scope are tracked in the [product roadmap](product-roadmap.md).
