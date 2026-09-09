# Architecture

Open Wrangler is a VS Code extension with a sandboxed React workbench and bundled native runtimes. This document
describes the durable ownership and safety boundaries. It intentionally leaves operation parameters to the generated
[reference](reference.md), qualification procedures to [testing](testing.md), and release procedure to
[releasing](releasing.md). Product status and incomplete acceptance gates belong in the
[feature-parity matrix](feature-parity.md), not here.

## Component ownership

- `src/extension/` owns VS Code APIs, workspace trust, commands, source discovery, custom editors, notebook and
  terminal provenance, runtime processes, session coordination, persistence, export, and recovery. Only this layer
  can read editor state, start a process, use a kernel, or authorize and select a user destination. It owns temporary
  file identity and the final commit; runtimes may write a host-issued temporary or their own private artifacts.
- `src/shared/` owns the versioned protocol types, validators, operation catalog, stable column references, typed
  values, and limits shared by the host and renderers. Generated protocol and reference files derive from these
  registries.
- `src/webviews/` owns the React grid, operation forms, profiling presentation, generated-code editor, and notebook
  output renderer. It has no Node or filesystem access and communicates only through validated messages.
- `python/openwrangler_runtime/` owns Python dataframe adapters, native queries and transformations, profiling,
  generated Python code, and file-data export.
- `r/openwrangler_runtime/` owns the native R frame contract used in IRkernel, an exact official R terminal, or an
  Open Wrangler-owned `Rscript` process. R frames never cross through Python.
- `protocol/openwrangler.v2.schema.json` is the canonical coordinator-facing request and response schema. Its
  generator emits five checked-in artifacts: TypeScript protocol types, TypeScript operation catalog, TypeScript
  limits, Python operation catalog, and Python limits. It does not generate the full Python runtime protocol. Native R
  has a separate private transport v14 and frame contract v5, which `RKernelBridge` adapts to and from coordinator
  protocol v2.

Native tree views and Code Preview keep their original lazy provider registrations until shutdown. Loading the
view owner attaches delegates and tree-change forwarding without unregistering a view while VS Code resolves it.
Lazy variable providers show a pending snapshot only until their owner loads. A loaded owner's absent notebook
snapshot remains absent, allowing the Operations view to offer the idle R action.
Editor and Code Preview resolution retain VS Code's exact cancellation token through loading and file preflight.
Canceled resolution leaves existing view ownership intact and does not start panel setup or publish late file errors.
Activation installs its lightweight gates before the first yield. Elapsed setup time does not invalidate successful
registration; lifecycle cancellation and actual initialization errors still shut down initialized owners.

Automatic Code Preview focus keeps renderer synchronization marked as layout-pending until the focus command
settles. Acknowledging another synchronization during that command does not repeat focus or report a settled layout.
Discarding the draft, changing the reveal setting, or deactivating the panel does not settle an in-flight command.

The extension host is the authority at every boundary. A webview cannot select a different source, session, kernel,
terminal, or export destination by supplying an identifier the host did not issue and retain.

## Sources, sessions, and data flow

The protocol recognizes five source kinds: `file`, `notebookVariable`, `documentVariable`, `rInteractiveVariable`,
and `notebookOutput`. The host resolves each source to an exact owner before opening it:

- a file URI plus validated format-specific import options;
- one live variable in one exact notebook and kernel;
- one variable produced from an exact source document execution;
- one variable in one exact official R terminal and process; or
- a bounded static notebook capture.

`notebookOutput` describes capture metadata; it does not authorize a workbench or runtime session. Only a validated
live link may open the current value represented by a capture.

The source dataframe is immutable from Open Wrangler's perspective. A live session owns a source descriptor, a
confirmed backend, an independent viewing query, an ordered cleaning plan, at most one draft, generated code, and a
revision. Filters and sorts used to view data never enter the cleaning plan or alter the source. Applying a draft
publishes a new cleaned result; discarding it restores the last confirmed state. Export writes a separate destination.

The normal flow is:

1. The extension validates the source, its provenance, import options, engine choice, and trust requirements.
2. The coordinator creates a host-known candidate identity and opens the source in the exact runtime owner.
3. The runtime validates the request, creates a session-owned native engine, and returns schema, capabilities, a
   bounded initial page, and generated code.
4. The host confirms the candidate, assigns it to the panel, and publishes one validated snapshot to the webview.
5. Later pages, profiles, viewing queries, previews, mutations, and exports route through that confirmed session only.
6. Closing the editor, losing its runtime, or replacing import options retires the corresponding runtime session and
   invalidates work that can no longer belong to the active view.

A failed open retains no session. A file session opened lazily represents exactly the source fingerprint observed at
open. Reads check that fingerprint before and after work; replacement, deletion, resize, or schema change invalidates
cached blocks and returns a recoverable reopen diagnostic. Page caches are session-local, bounded by entry count and
payload weight, and keyed by both row and column projection. A view, source, plan, draft, or disposal change
invalidates incompatible entries.

Changing import options is a host-owned session swap. The coordinator quiesces accepted work, opens a private
candidate against the same immutable source, replays the confirmed plan, draft, and view, publishes the replacement
once, and then retires the prior runtime. Failure leaves the prior confirmed session unchanged. The public session
identity remains stable while the runtime identity may change.

## Protocol and publication

Every coordinator-facing request and response uses protocol v2, passes strict decoding, and carries the identifiers
needed to correlate it to a request and session. Python bridges implement that boundary directly; `RKernelBridge`
validates and translates between it and native R's private transport and frame contracts. Public transform parameters
never contain private bound positions. Unknown fields, malformed unions, invalid limits, stale identities, and schema
inconsistencies fail before adapter dispatch or UI publication.
Python request enums require string values before membership checks. Present `backend`, `mode` and `cloneFrom`
options must satisfy their existing schemas; explicit null is not an omitted option. Malformed values return the
existing `invalid_request` classification. Omitted options retain their defaults. Failures raised after decoding
keep their existing `engine_error` or `runtime_error` classifications.

Python's standalone and notebook request handlers return a bounded, correlated `runtime_error` for a recognized
Polars `PanicException` after the operation unwinds. Recognition requires identical public and already-loaded native
exception exports; error handling does not import an optional engine. Missing or divergent exports retain ordinary
`Exception` handling. Caller interrupts, exits and other `BaseException` subclasses keep their existing propagation.
This does not retry the operation, restart the runtime or cover native process crashes.

Runtime work has three relevant classes:

- mutations and exports are exclusive;
- a foreground read may overtake an immutable background profiling lease; and
- background profiles use bounded capacity and are cancelled or drained during close.

Each logical view has an opaque context, and each request within it has a `viewRequestId`. Session revision or filter
equality is not enough to establish freshness. Pages, summaries, statistics, values, errors, and profiles update the
UI or retained panel state only while their request belongs to the active confirmed view. Cancellation is
authoritative only when the original correlated request returns. A cancellation acknowledgement may remove queued
work, but it cannot invent completion for running work or conceal a mutation that may have committed.

Python and R kernel execution is not treated as safely interruptible. Timeout or cancellation stops publication and
triggers bounded cleanup; it does not claim that user-owned kernel work was interrupted. Idempotent summary and
dataset-statistics reads may recover once after a lost runtime when the view is still current. Mutation retry rules do
not change, and concurrent recovery shares one replacement per runtime owner.
Recovery checks the originating session and source after opening its candidate and around each replayed request.
Close, cancellation or supersession stops subsequent replay, including fallback viewing requests. Already-started
execution retains its settlement barrier before candidate cleanup.
Detached saved-view restoration also waits for the originating execution before closing its candidate.

Python page reads stage the viewing query, shapes and bounded cache under the existing foreground-read lock. The
previous view remains authoritative until page construction, metadata, source validation and the owning engine's
request scope succeed. Public page responses are checked with their real correlation fields before committing the
candidate view. This preserves the separate page and complete-frame size limits. Failure preserves the previous
query, epoch and frame identities; a changed or lost source still invalidates cached data.
Cache invalidation uses the same reentrant state lock, so a late background failure cannot have its invalidated
blocks restored by a foreground candidate. It does not join request admission or wait for profiling leases.
Spark owns a page-only scope for its continuation anchors. A rejected candidate therefore cannot prevent the prior
view from continuing after a cached page, and background profile failure cannot roll back newer foreground paging.

Mutation state crosses the runtime and webview boundary atomically. Preview, apply, discard, undo, redo, import replacement,
and recovery either publish a complete confirmed snapshot or restore the prior revision, plan, draft, metadata, page
cache, code, selected column, and profiling ownership. No layer constructs a plausible partial result after an
ambiguous response.

A failed or cancelled operation preview reports its error inside the dialog that submitted it, alongside the retained
inputs. The mutation snapshot owns that dialog context and operation kind; unrelated actions keep their workspace
errors. Error text and code settle together, and changing the operation, closing the dialog or replacing the session
clears its preview error.
A successful accepted plan update also closes an editing dialog whose applied step no longer exists, using the
existing focus restoration. Failed updates, surviving step targets and ordinary new-operation forms retain their input.

Retained multi-column forms submit unavailable selected IDs to the existing parameter validator instead of silently
dropping dependencies. An explicit repair action removes those selections; optional forms explain when clearing them
will select all columns. Toggling another checkbox preserves unavailable IDs, and a nonempty column search remains
clearable after the schema shrinks.
Single-column forms retain the chosen ID when its option disappears or becomes incompatible. They display an empty
selection, so the existing required-field validation prevents submission until the user chooses a compatible column.
If that ID becomes eligible again, its current name is restored. Controlled forms keep the parent value authoritative;
an empty parent value remains visibly empty when options appear. Uncontrolled forms choose an initial default only once.

Redo retains the commands removed by Undo in the exact runtime session. It binds the next saved command to the
current confirmed input and executes that step once; it does not replay the preceding plan or retain old dataframe
results. Already-synthesized By Example programs remain part of the saved command. Stable column IDs, captured
names and the existing operation-specific type checks still decide whether a command can bind. Generated code
contains only the active plan. Custom Code can produce a different result when re-executed.

Active and undone commands share the existing native plan bounds. Preview, Discard, viewing changes and failures
that leave the same runtime intact preserve the undone suffix. A successful new Apply or plan rewrite clears it.
Close, import/backend/source replacement and runtime recovery end this history; persistence stores only the active
plan and draft. Renderer remounts preserve history while that runtime remains alive. Redo uses the existing single
view-restoration receipt for a following Undo, including its guard against replacing newer user filters.

`canRedo` is optional last-confirmed metadata; absence means unavailable. Draft, mode, pending-work and Workspace
Trust checks still gate execution. A Redo request and its success, error or cancellation carry the same
`viewRequestId`. Only a matching `redo_unavailable` refusal clears retained availability without a new revision,
including the panel snapshot used for renderer synchronization. Other errors retain it. Runtime loss can leave the
last displayed availability stale until a fresh metadata response or the first Redo refusal. No automatic replay
reconstructs an undone command in a replacement runtime.

Redo rechecks Workspace Trust after queued work, before native dispatch and between recovery awaits. Python retains
request correlation when cancellation arrives before dispatch, including during listener registration, so an
undispatched cancellation does not trigger ambiguous-mutation recovery.

## Runtime ownership

The standalone Python runtime is single-flight per Python-selection scope. A workspace folder, an exact external
resource, and the default resource have separate process, startup, pending, provisional, and confirmed-session state.
Requests and cancellations route through the exact owner. Restart invalidates that owner's pending start; closing its
last session stops its process after bounded stdin/EOF shutdown. A forced kill is reserved for recovery or an expired
shutdown bound.

The bounded Python stderr buffer belongs to the current process. A retired process's late stderr remains in the
output channel history but cannot enter a replacement process's error details.

Python and native R child processes retain a stdin error listener through shutdown and retirement. Failed write
callbacks own request rejection; the separate stream error cannot escape into the extension host or change
cancellation, restart, or exit handling. A failed Python cancellation write still awaits the original response.

A requested session ID is provisional until the exact still-pending tuple of session ID, open request ID, and Python
scope receives its correlated open response. While provisional, it may route only `closeSession` terminal cleanup;
ordinary work routes only through confirmed ownership. A late, ambiguous, or mismatched promotion restarts that scope
only. A `closeSession` revision is advisory so terminal cleanup can use the last confirmed revision after an ambiguous
mutation. Unknown sessions remain errors, and every open-failure, explicit-close, shutdown, or recovery path invokes
session cleanup at most once.

Engine registries hold factories, not shared adapters. Each live or transient session owns one engine instance, and
open failure, close, shutdown, and notebook snapshot completion clean it up at most once. The standalone server
prepares native dependencies before dispatching session work; preparation does not authorize conversion through a
different dataframe engine.

Live notebook sessions instead belong to their exact kernel. R document-process sessions belong to their exact
Open Wrangler process, and interactive R sessions belong to their exact terminal. These owners never share a session
merely because another resource has the same URI, variable name, or display label.

## Engine boundaries and capabilities

Every cleaning operation except Custom Code addresses input columns through public `{id, name}` references. The runtime
binds public references against the exact input schema and lineage to private positions before execution. Unknown, stale, repeated where
disallowed, type/name-mismatched, colliding, or private row-identity references fail closed. The current catalog and
parameters are listed in the generated [transformation reference](reference.md#transformation-operations).

Generated Python rechecks destinations for column appends, renames and optional replacements at each affected step.
The shared column-binding policy distinguishes a fresh output from replacement of the selected source column;
unrelated extra columns remain valid. Pandas compares displayed names while retaining positional input checks.
Polars inspects lazy schema metadata. For nonempty plans, generated DuckDB checks its input and each intermediate
schema for case-insensitive name collisions before another step can read an ambiguous column. This includes categorical outputs
and Custom Code. Case-only Rename remains valid. Optional outputs replace the selected source only when the name matches exactly.
Generated DuckDB query helpers use the input relation's connection. Existing operation-specific output
guards keep their stronger validation. Scalar destination guards reuse the step's output-name literal; the retained-plan
and generated-code limits remain unchanged.

Generated Pandas and Polars Custom Code checks each result for at least one column after native type validation and
Series normalization, matching live result admission. The shared Custom invocation emitter owns this metadata check
and its contribution to the generated-code size limit. Typed zero-row results remain valid. A Custom function may
build an empty-column intermediate or add the first column of an empty source, provided its final result has a column.
Empty plans and zero-column viewing or row operations retain their existing behavior.

Viewing `FilterModel` and `SortRule` remain name-addressed, presentation-only queries. A committed Filter Rows or Sort
Rows step uses a separate transform filter/sort IR whose column operands are stable `{id, name}` references. The two
representations are never inferred from one another by name fallback.

A locally staged sort order binds each rule to its unique column ID, name and semantic type. Schema changes
permanently retire rules whose owner disappeared, changed or became ineligible, preserving unaffected rule order.
The panel uses the confirmed model directly when no local difference is staged. An authoritative sort-model
replacement resets local edits; the existing Clear-column action preserves its explicitly staged sibling rules.
Confirmed viewing sorts retain their name/type reconciliation policy.

The Python decoder validates viewing record shapes, list fields and scalar enums before engine dispatch. Native R
also distinguishes JSON objects from arrays before list conversion and validates scalar logic and operators. Its
Filter Rows decoder preserves explicit null logic for rejection. Empty viewing lists and backend-specific operand
semantics remain valid under their existing contracts.

Python viewing operands follow the shared JSON depth and finite-number rules without coercing accepted integers
or opaque containers. Python also requires UTF-8-valid strings and keys for response publication; lone surrogates
are refused before native work even though the shared syntax guard accepts them. The primitive-string limit applies
only at the operand root, and request framing retains its existing byte bound.

Float filter values accept explicit `Infinity` and `-Infinity`, plus the historical `inf` and `-inf` spellings used
in saved Filter Rows steps. These aliases do not admit NaN or finite text that overflows. The shared literal fixture
defines accepted and rejected forms for live and generated execution.

Python datetime filter and explicit Fill values accept one to six fractional digits and minute-resolution offsets
written as `+0530` or `+05:30`. The common decoder pads fractions and inserts the offset colon before native parsing,
so accepted spellings have the same meaning on Python 3.10 and newer. Offset hours above 23 and minutes above 59
are rejected before normalization. Generated filters use the same checks; generated Fill uses the validated native
value's canonical literal. Calendar validity, timezone awareness and each engine's storage limits still apply.

Formula retains large bare decimal integer input as canonical text through the webview, public plan, persistence
and replay. Its additive v2 scalar representation accepts existing finite numbers or canonical integer strings with
at most 309 digits whose Number conversion remains finite. Form input is bounded to 4,096 characters before parsing.
Leading signs and zeros are normalized on entry; stored strings reject redundant signs, zeros and whitespace.
Decimal and exponent input retain binary64 interpretation. Unsafe integral binary64 values that JSON would spell as
plain integers use their actual integer text, avoiding a second rounding at the runtime boundary.
Execution and generated code decode the retained text in the owning engine. Polars and DuckDB refuse text outside
native signed/unsigned 128-bit literal capacity. R requires an exactly representable ordinary numeric scalar; it
does not add an integer64 scalar type. Native arithmetic promotion and output limits still apply.
Legacy numeric plans retain their replay behavior. If an earlier numeric representation lost digits, the original
literal must be entered again; its original spelling cannot be reconstructed from the saved number.

Min-max Scale computes exact integer and decimal offsets before converting them to double-precision ratios.
Float32 and float64 ranges that overflow on subtraction use wider or scaled operands; ordinary ranges retain their
precision, including subnormal values. Live execution and standalone generated code use equivalent arithmetic in
the owning engine.

Round accepts finite integer decimal precision, including negative values for rounding to tens and larger units.
Python engines round exact integers and Decimal values before floating conversion, using half-even ties. Ordinary
floating and text coercion keep their existing behavior. Precision outside a storage type's useful range produces the
corresponding unchanged value or signed zero without constructing an unbounded scale. Intermediate scaling must not
overflow a representable result or wrap an integer. Live and generated code preserve missing and non-finite values;
a floating result that exceeds its output type becomes signed infinity.

Pandas may retain large exact integers in object storage. Polars and DuckDB retain native numeric storage, widening
or reducing fractional scale when needed for a carry. Arrow Decimals keep their original dtype when possible;
otherwise they use the smallest compatible native width and scale. A nonnegative source scale stays nonnegative so
rounding does not remove existing Parquet export support. Already negative scales must remain readable by Arrow.
Polars, DuckDB and Arrow Decimal results beyond usable native capacity are rejected without a floating or object
fallback. Object Decimal arithmetic uses its own precision context and preserves the caller's.
DuckDB compares the rounded unsigned 128-bit coefficient against its exact capacity before the final native cast;
some native Windows casts otherwise wrap an overflowing value. The same expression owns live and generated checks.

Floor and Ceiling preserve exact integer inputs and round Decimal values before any floating conversion. Decimal
output storage may reduce fractional scale so an integral carry remains representable. Ordinary floating and text
coercion retain their existing behavior, including separate Arrow null and valid-NaN states.

Polars Decimal Floor and Ceiling divide the native Int128 coefficient by the source scale factor and return
Decimal(38,0), avoiding an overflowing intermediate at the old scale. For Round with a nonnegative reduced scale,
precision below 38 is widened before native rounding. At precision 38, rows whose rounded coefficient would exceed
capacity are masked before rounding and receive exact target-typed endpoints. At zero decimal places, the half-even
ties at ±0.5 still produce zero. Native expressions preserve nulls; negative-precision Round retains its existing local
Decimal context. Live and generated paths agree. The physical coefficient mapping, also used by Min-max Scale, is
checked on minimum and current Polars; `to_physical` does not promise representation stability across future versions.

Dense Rank appends one integer column while preserving the cleaning input's row order, existing column identities
and source values. Viewing filters and sorts do not define the rank population. Equal present values share a rank;
ascending or descending ranks start at one without gaps. Missing inputs, including NaN, produce missing ranks;
signed zeros tie and infinities remain present. The new column reports its own nullability and uses the engine's
native integer output width within its existing row capacity. Output collisions and stale references fail before
publication. Live and generated execution use the same comparison and missing-value rules.

Mark Duplicates appends a present Boolean for every row, true for every member of a repeated group of selected keys.
The selection must contain at least one column. The complete cleaning input defines membership independently of
viewing filters, sorts and pages. Each engine retains its selected Drop Duplicates equality and admission rules,
including missing-value distinctions. Original values, order and identities remain intact. The output uses its own
Boolean type while preserving the engine's conservative schema nullability policy. An empty input retains its
schema and gains an empty Boolean column. Live and generated code apply the same rules and output-name checks.

### Pandas

Pandas executes viewing, all catalog operations, profiling, generated code, and supported exports in Pandas.
Duplicate and non-string labels are addressed positionally after binding. Object-dtype cells are recursively isolated
before trusted custom code, preview, rollback, or generated-code execution so nested user objects cannot mutate the
source. Typed null, NaN, decimal, datetime, and wide-integer behavior is normalized at the protocol boundary.
Datetime cells and nested values share one formatter. Pandas Timestamp nanoseconds are inserted into the time
fraction while preserving the complete native offset, including offset seconds. Ordinary Timestamp profile and
value-choice labels reuse this formatter with their existing space separator. Other scalar labels retain native string conversion. Search keeps
its original per-row text and counting order, correcting only affected timestamp and present temporal-extremum text.
Numeric dtypes and dedicated string dtypes bypass the temporal search scan. Ordinary datetime objects retain their existing formatting;
timestamp conversion and input precision stay with their existing owners.
Native Arrow date32 and date64 columns retain date semantics for schemas, profiles, value selections and sorting,
including when loaded from Parquet.
Parquet reads repair nullable integer index levels from their exact physical fields while retaining ordinary Pandas
data-column decoding. The supplemental read uses the same open file and checks its fingerprint across the reads
before publishing the repaired index. A changed source is refused; this guard does not persist beyond the read.
Native Arrow `bool8` and UUID Parquet fields reopen as logical booleans and canonical strings. A local schema copy
repairs only their canonical unsupported Pandas dtype metadata; unrelated invalid metadata retains native refusal.
The same descriptor and fingerprint guard covers their schema, data and any supplemental index reads.
Scalar Arrow dictionaries expose their logical value type while retaining the physical dtype in schema metadata.
Profiles and query keys use logical values, including null dictionary entries and repeated values across chunks.
Schema nullability checks native validity masks and referenced codebook entries without decoding value payloads.
String keys share decoded dictionary entries rather than expanding the text payload once per row. Row selection
retains encoded columns; it may normalize codebooks or widen their index type when native chunk unification requires
it. Source arrays remain unchanged.
Native Arrow `bool8` and UUID columns use logical booleans and canonical UUID strings for pages, queries, profiles
and selected cleaning operands. Row selection retains their physical arrays; unchanged Fill targets and direct
copies retain storage as well. Pages prepare only projected rows and leave dictionary scalar iteration bounded by
the requested page. Arbitrary Arrow extensions do not gain this conversion.
Object-dtype UUIDs share their canonical string value across those same query, cleaning and export owners.
Pandas' native inference excludes definite non-UUID inputs; ambiguous inputs are inspected exactly, with an array
copy allocated only when a UUID is found. Other objects and missing representations remain unchanged. Query results
select the original physical rows, while derived logical values and exported UUIDs use canonical text.
Integer filters compare within the native storage range and handle out-of-range operands without floating conversion.
Sorting, duplicate detection and directional Fill share exact temporary row keys. Row selection preserves Sparse
integer values and their fill convention, including columns that did not participate in the query.
Nullable Arrow integer, timestamp and duration keys retain their exact values during duplicate comparison, including
nanosecond differences. Dataset duplicate counts use the same comparison keys. These temporary keys preserve value
ordering; temporal keys use integer storage values so present extrema remain distinct from nulls.
Retained columns and native indexes keep their original representation.
Arrow timestamp and duration null masks use native validity, including logical null entries in dictionaries.
Pages and profile labels retain native context for present nanosecond extrema that Pandas boxes as `NaT`.
Page context is prepared after row and column projection; profile extrema use native aggregation. Supported Fill
methods retain native temporal donors and directional anchors in live and generated code. Source arrays stay unchanged.
Using the minimum nanosecond timestamp as a filter value remains unsupported under the existing microsecond input precision.
Single-column Sparse integer duplicate counts also use the existing exact row keys, retaining native fill conventions.
The missing-cell total sums the per-column counts, including Sparse columns, without a second aggregate scan.
Mixed object columns compare native NumPy numeric scalars through exact temporary keys. Counts, sorting,
duplicates, grouping and Pivot share those keys while retaining original source scalars and representative labels.
Group By retains the first key representative; Pivot retains the first complete identifier row for each group.
Integer filter text remains exact through the webview. Pandas object columns accept exact integer selection tokens
for integral values; physically floating columns retain their existing floating-token contract. Null and NaN
selections remain separate. Ordinary native numeric arrays keep their native comparison path.
Finite native NumPy extended floating values must round-trip through binary64 before scalar transport or selected
query-key preparation. Values that would lose precision or range are refused before display, grouping or ordered
aggregation can collapse them. Representable values and genuine NaN or infinity retain their existing behavior.
The guard does not rewrite source values or scan unrelated projected columns. Exact native CSV export and explicit
Floor or Convert Type operations retain their own conversion rules.
Numeric, text, Convert Type and pivot operations prepare only their selected dictionary operands. Existing native
conversion rules, arithmetic limits and output validation apply to those logical values; unrelated columns retain
their encoded storage.
Formula modulo supports Arrow integer operands using native unsigned magnitudes and the divisor's sign, with no
floating conversion. The result uses the widest operand width and the divisor's signedness. Integer literals must
fit within 64-bit capacity at the runtime boundary. Null operands
produce nulls, and a zero divisor is rejected only where both operands are present. Generated modulo code uses the
same calculation.

Formula add, subtract, multiply and nonnegative integer power check ordinary integer results for wraparound and
lossy floating-point promotion. This covers NumPy, built-in Pandas nullable and Sparse integer columns, integer
literals and Boolean companions. Validation compares each active integer pair with its actual native result;
correct results retain their native values and inferred dtype. Power validation bounds exact work by the native
result's capacity. Sparse validation reads only the selected columns into exact temporary object arrays.
Missing-power identities, noninteger Sparse fills and Boolean-only operations retain their native behavior.
Explicit floating-point and Decimal arithmetic, division, negative or fractional powers, modulo and By Example
keep their existing paths. Live Formula and generated code share the same validation.

Arrow-backed Formula preserves successful native results and types. After eligible coercion failures,
UInt64 add, subtract, multiply and power may use exact UInt64 literals or convert nonnegative signed companion
columns in either column order. Signed companions must be 8–64-bit native NumPy, built-in Pandas nullable or Arrow
integers; Sparse and arbitrary extension types are excluded from repair.

UInt64-left add and subtract also repair negative integer literals of magnitude at most UInt64 maximum and signed
columns of any sign. Addition allows either column order. Repaired results must fit UInt64; nulls remain null, and
intermediates cannot overflow when the requested result fits. This includes signed 64-bit minimum. Mixed-sign
columns require two checked operations; other repairs require one.

After existing native and eligible repairs fail, multiplication of fixed-width integer operands up to 64 bits may use
an exact native Decimal256 intermediate when at least one column uses Arrow. The result returns as Int64 if it fits,
or UInt64 otherwise. This policy applies only to newly admitted results; successful native types stay unchanged.
True overflow and columns needing both negative results and values above Int64 maximum retain the original refusal.
Only selected operands gain temporary storage. Boolean, Sparse, arbitrary extension, floating and Decimal operands
remain on their existing paths.

Selected Decimal128 operands may widen to Decimal256 for add, subtract, multiply and divide, retaining each operand's
precision and scale. Native arithmetic determines the result type. Live and generated Formula apply the same policy;
By Example remains unchanged. Reversed negative-column subtraction, negative power and widest or negative-scale
Decimal capacity gaps remain tracked in
[#979](https://github.com/Matt17BR/openwrangler/issues/979).

Convert Type's integer target is nullable signed 64-bit storage. Unsigned or floating values outside that range and
present infinities are rejected before conversion; failed previews or applies preserve the confirmed session state.
Fill reads selected dictionary targets, donors and keys as logical values. Filled targets use native logical storage;
targets with no filled cells and unrelated encoded columns retain their dictionary representation. Decimal capacity
and timezone checks still apply to replacement literals when the target has no missing cells.
CSV and Parquet export prepare logical scalar dictionary, `bool8` and UUID columns in a temporary frame. Preserved
index levels use the same logical values; changed MultiIndex levels are rebuilt from actual row labels so equivalent
values coalesce. Parquet omits an unrequested index before native dtype inspection. Source arrays, index levels and
codes remain unchanged. Exported `bool8` and UUID fields use Boolean and string storage respectively.
Group By treats input NaN as missing while retaining NaN computed from present aggregate operands. Arrow float32 and
float64 grouping keys use the same missing-value and signed-zero equality as other numeric keys. Group By retains
its native representative key; Pivot retains each first identifier row. Grouped Fill shares this key equality without
changing the stored keys.
Sparse Count uses a temporary presence mask for that aggregation alone. Keys, source storage and other aggregates
on the same column retain their own numeric behavior.
Integer group keys use native factorization codes and exact scalar labels. Group By and Pivot restore those labels;
grouped Fill uses the same temporary identities while retaining source keys. Sparse fill values retain their native
numeric equality and first representative, including fractional fills accepted by the minimum Pandas version.

### Polars

For a new Formula integer string and an integer source, Polars checks the selected column's native minimum and
maximum before add, subtract, multiply or integer power. It uses the smallest common native integer capacity at
least as wide as the source, checking operands and result bounds; unsupported capacity is refused. Only the two
aggregate values cross into Python. Division retains native floating output, and modulo retains native null and
sign behavior.

Ordinary integer Formula keeps its inferred native output dtype and refuses overflow or casts that would introduce
nulls for present operand pairs. Polars scans the selected operands using each row's actual pair; integer powers use
bounded exact limits. When UInt64 and signed integers of at most 64 bits promote to Float64, an exact native Int128
reference detects result precision loss. Correct native floating results and modulo-zero NaN remain unchanged.
Only one guard Boolean crosses into Python. Integer-result addition, subtraction and multiplication also check
Boolean operands as zero or one, including saved steps replayed after a source type change and integer-string
operands on Boolean columns. The existing integer-string bounds avoid a second scan on ordinary integer columns.
Floating and Decimal operands, and division, retain native arithmetic.
Two-column addition, subtraction or multiplication producing UInt128 requires a recognized stable Polars release
from 1.36 onward. Earlier native kernels can panic depending on collection shape, so the Formula preflight refuses
this combination before returning a result, including lazy plans. Scalar operands and other operations retain their
existing paths; nonnumeric or prerelease version labels are conservatively refused for this combination.
Generated code performs the same checks. A caller-owned LazyFrame must keep its external inputs stable between
these checks and later collection; the checks do not materialize or snapshot the frame.

Polars Custom Code runs a native per-column count over a returned LazyFrame to catch expression errors outside the
previewed columns before accepting that Custom step. Generated code does the same immediately after Custom Code,
before a later step can discard its output. The existing Custom operation owns this check; ordinary operations retain
their own type, capacity and preflight checks without an added full-width scan after every step. Visible-column and
identity validation still apply to all cleaning results.

The Custom count uses `pl.collect_all` with `engine="in-memory"`, which respects that choice on minimum Polars even
under caller-configured streaming. The aggregate is discarded and the same LazyFrame is retained. It does not prove
that every relational operator will execute: native optimization can remove work unnecessary to the count. Later reads
can evaluate the plan again; mutable inputs and nondeterministic code are not snapshotted. The small count result does
not bound native execution memory.

Other lazy expression errors follow native evaluation. For example, Format Datetime can fail when present values are
formatted, while an all-null result succeeds or a later projection removes the unused expression. Empty generated plans
remain identity functions. Viewing keeps its projected reads and does not run Custom result validation.

Eager and lazy Polars paths remain Polars-native and never call `to_pandas()`. Lazy file viewing projects before
collection and transports only bounded terminal results. One-hot encoding and multi-label binarization are explicit
cleaning exceptions: each materializes the complete lazy frame in Polars to derive its dynamic output columns. They do
not convert through another dataframe engine. Viewing, all catalog operations, profiling, generated code, and
supported exports stay in Polars. PyArrow is optional and limited to native dependency preparation where the Polars
Excel reader requires it; it is not a transport conversion path.

CSV and Parquet readers disable native glob expansion. On Unix, JSONL/NDJSON opens the selected path through a
builtin stream and gives Polars ownership of a duplicated native descriptor. If duplication falls back to a Python
buffer read, the reader returns no source bytes and refuses the temporary plan. The session still checks its source
fingerprint before and after reads. On Windows, JSONL/NDJSON forwards the normalized absolute path unchanged. The glob
check excludes only the structural `\\?\C:\` local-drive prefix; it still refuses `*`, `?`, or `[` in the remaining
path and unsupported verbatim prefixes because the supported scanner cannot disable glob expansion.

Datetime formatting preserves native Date and Datetime columns, including time zones and nanosecond precision,
before formatting the result as text. Live execution and generated code parse text only for non-temporal inputs.
Grouped integer and Decimal medians retain the target dtype and reject unrepresentable midpoints only when a group
needs filling. Empty groups stay null, and constructing a grouped Fill plan does not collect a lazy frame.
Exact By Example arithmetic returns typed native batches when unsigned operands require the checked scalar path.
Multi-label discovery uses the available native explode API while retaining its existing null and empty-label rules.

Generated Fill Missing Values code includes only the helpers referenced by the complete cleaning plan and their
dependencies. Polars and DuckDB share the selector for their controlled helper declarations; each engine owns its
helper implementations. The emitted programs remain standalone.

### DuckDB

DuckDB file sessions retain a connection-free native SQL plan plus immutable column and type metadata. Each request
creates and closes its own hardened connection, and any `DuckDBPyRelation` is dereferenced before that connection
closes. DuckDB never converts through Pandas, Polars, or Arrow, and extension auto-install, autoload, and external-file
caching remain disabled.

Generated Sort Rows, Drop Duplicates and Mark Duplicates reserve current input names and requested keys when choosing
temporary row ordinals. Missing requested keys are rejected; an internal ordinal cannot supply them. Native
case-insensitive key binding remains valid. Sort Rows preserves every user column and input order within ties.

Pivot Longer and Pivot Wider reserve requested output names alongside input names when allocating temporary columns,
in live and generated execution. Generated Pivot Wider also reserves its requested value-column name so a missing
input cannot bind to a synthesized helper. These reservations use schema metadata without evaluating source rows.
Multi-label discovery qualifies both the source column and the extracted label so their names cannot make the
existing native query ambiguous.

Generated queries execute their composed SQL on the input relation's connection, so a same-named table or function
on the module's default connection cannot substitute different data. Each call removes its unused query view before
returning the native lazy result; earlier returned results remain independent of subsequent helper calls.
Generated queries and notebook requests check the native catalog before creating an alias and remove only the last
observed view identity. They preserve observed caller replacements. A constant native relation retains the connection
during the call so cleanup can inspect ownership even if the source table disappears. These metadata queries add
catalog work without evaluating source rows. A failed ownership lookup prevents removal and preserves an existing
error; without an earlier error, the cleanup failure propagates. The identity check and removal are separate native
operations and do not promise atomicity against arbitrary concurrent caller DDL.

DuckDB evaluates computed cleaning results across every physical output column before publication, including errors
outside the requested page. The existing result-validation hook receives the operation kind from Session. Rename,
Select Columns and Drop Columns only project existing fields, so they skip the additional hash aggregate while keeping
visible-column, addressability and identity validation. An explicit validation call without operation context still
checks the whole result. One DuckDB-owned classification also controls generated checks.

Other operations, including Formula and Custom Code, retain the native aggregate before a later projection can remove
an erroneous output. The hash primitives resolve from DuckDB's built-in catalog; generated code evaluates on the input
relation's connection. The scalar is discarded without retaining a materialized frame, connection or cache. This work
remains necessary to force lazy arithmetic guards, including mixed-integer precision checks.

Structural steps preserve native lazy input evaluation: an inherited expression error may surface on a later read,
and a Drop can remove an unused erroneous expression. They add no full-result validation scan or retained snapshot.
Computed-result checks can also be followed by a different outcome for volatile inputs. Empty plans remain no-ops.

Formula checks addition, subtraction, multiplication and modulo when both selected operands have native fixed-width
integer types, through 128 bits, and DuckDB promotes the result to DOUBLE. Each evaluated expression checks its actual
operand pair and result, refusing precision loss while retaining correct native values and types. Its own arithmetic
resolves from the built-in catalog, so caller macros cannot replace the guard's primitives. Metadata inspection does
not evaluate source values. The embedded check adds native work and may allocate hash state for distinct operand
pairs; it does not retain a frame or introduce a Python row loop. Generated code applies the same check and includes
its helpers once under the existing code-size limit.
Other native result types, explicit floating or Decimal operands, division, power and By Example retain their existing
paths. BIGNUM source operands are outside this check and remain unavailable in numeric form choices. Programmatic or
generated BIGNUM multiplication and modulo can still lose precision; that separate gap is tracked in
[#1094](https://github.com/Matt17BR/openwrangler/issues/1094).

CSV, TSV, JSONL, and Parquet file sessions support native viewing and all catalog operations in both live and
generated code. DuckDB file editing remains experimental. Excel and database browsing are not supported. A live
notebook `DuckDBPyRelation` is the sole relation-retention exception. Its exact user-owned relation is serialized on
its originating connection, is viewing-only, and is released without closing or mutating the user's relation.
Each terminal request removes its temporary query view after consuming the results, including when the query fails,
under the catalog ownership rules above. The notebook lock serializes Open Wrangler requests.

Drop Duplicates materializes its numbered input once, computes membership by row ordinal, and returns values from
the selected original rows. Native partitioning cannot replace those values with a normalized key or another
representative's payload. Scalar and nested floating values retain the sign of zero; null and NaN remain distinct
duplicate groups in live and generated code.

### PySpark

Open Wrangler supports local PySpark 4.2.x Classic and Connect dataframes as live-notebook, viewing-only sources.
Pre-release PySpark builds are not supported. Open Wrangler does not clean PySpark dataframes, generate cleaning code
for them, or export them. Projection, filtering, sorting, counting, and aggregation stay in Spark. The runtime never
calls `toPandas()`, `toArrow()`, or an unbounded `collect()`/iterator. A page must pass Spark-side transport-byte
preflight before values are collected and then remain inside the cell, strict-protocol-byte, complex-node, and
nesting-depth limits. Only that bounded page/value sample or a fixed-size aggregate result crosses into the kernel
process.

### Native R

Numeric filter operands and typed temporal payloads retain their finite native R value without a text round trip.
The same parser preserves numeric replacements at the frame boundary; public Fill requests still require replacement
text. Explicit Infinity tokens and text retain their separate rules, and native floating columns refuse integer-cell
selection tokens. Generated Filter Rows uses the validated keys from this owner.

Native R sessions operate directly on R `data.frame`, tibble, and `data.table` frames. IRkernel, exact official
R-terminal, and owned `Rscript` transports share the same native frame contract and current operation catalog,
including generated R. The runtime never routes an R frame through Python. The public status remains Preview and
Partial because of the row-specific limitations recorded in the feature-parity matrix.

Drop Duplicates and dataset duplicate statistics share an exact integer64 comparison owner. All three frame flavors
use temporary decimal text keys, including for the two supported signed extrema. A data.table comparison remains a data.table
so other columns retain their native equality and configured numeric rounding. Original values and metadata remain
intact, and generated row reduction uses the same rule.
Repeated column labels become unique only in the isolated comparison table, so selected column identities cannot
collapse to the first matching name.

Native R response encoding stays inside the correlated request error boundary. Oversized ASCII string expansion is
refused before assembling the escaped response, and the final serialized output retains its complete transport cap.
Opening and editing still preflight the complete encoded reply before publishing session state.

R frame validation accepts native compact zero-row metadata while independently checking column lengths. Live and
generated input/output validation apply the same rule, so native empty subsets do not become malformed frames.
Mutation and inspection decoders distinguish a known empty schema from missing host context. They retain exact
schema, row-identity and diff checks for zero-column sources. Generated code accepts the same sources; the native
frame and operation boundaries are defined in [ADR 0001](decisions/0001-native-r-runtime.md).

Generated R follows the live operation's native column-metadata behavior at each step. It normalizes element names
on its already-isolated `data.table` result without making another full data copy; Clone, Dense Rank, Mark Duplicates
and Custom Code retain their explicit named-input behavior. This keeps later attribute-sensitive custom code consistent
with the preview.

Generated Fill Missing Values code includes only the helper families used by the complete plan. Repeated and mixed
steps retain each required family once, including scalar datetime and numeric midpoint dependencies.
Median and exact-midpoint interpolation share the native R midpoint owner. Unequal finite pairs use
`base::mean.default` directly, keeping user S3 methods out of the arithmetic; equal-value and non-finite behavior
remain explicit in that owner.
Directional Fill uses the same native missing-run and donor-selection function in live execution and standalone
generated code. Frame validation, stable sorting, key restrictions, and isolated publication remain with their
existing owners.

Find and Replace shares its prepared regex calculation between live R and generated code. Each step prepares its
own replacement state once; a generated plan includes the function once when a regex step needs it. Literal steps
omit that function and unused regex branches. Input validation, frame isolation and publication remain with their
existing owners; the shared calculation checks projected UTF-8 output size before replacement.

Generated R Group By retains zero groups for empty inputs and preserves the live result's column types.
It loads bit64 before grouping when a selected key or aggregation uses integer64, so missing detection,
key comparison and subsetting retain native values even in a fresh R session.
Integer sums and integer64 sum, mean and median share the live exact-sum arithmetic. Generated plans include these
functions once when needed, reusing unsigned addition if coarse Round also needs it. Ordinary integer sums retain
bounded native batches; integer64 accumulation and existing result-range refusals remain unchanged.

Built-in R means and profile medians use primitive numeric calculations that bypass registered S3 mean methods.
Live operations and their generated programs agree; Custom Code retains the caller's ordinary R dispatch.
Profile calculation and precision limits are described in [ADR 0001](decisions/0001-native-r-runtime.md).

One-hot encoding derives indicators only from present categories with nonempty labels. Empty and all-missing
duration columns contribute no categories; if no selected column contributes an indicator, the operation refuses
before publishing a result. Other selected columns can still supply valid categories.
Generated One-hot code normalizes text before choosing categories and comparing indicator values, matching live
execution across text encodings. It validates the complete input before formatting distinct category labels.
Multi-label encoding retains its per-row text preparation.

Integer64 One-hot Encode retains all native primitive validations but includes arithmetic code only when a Formula
operand in the same plan needs it. Drop Duplicates retains its separate character-comparison binding.

Notebook work stays in the selected IRkernel. An existing official R-terminal variable stays pinned to the exact
terminal and process that exposed it. Passive discovery reads bounded vscode-R metadata as an untrusted hint and
sends no R command. An explicit Open or Refresh action revalidates that terminal and process, then uses terminal
`sendText` to install or drive Open Wrangler's private dispatcher. Open Wrangler never writes vscode-R's files or
silently moves the session to another terminal. On macOS and Linux, trusted `.R`, `.Rmd`, and `.qmd` sources may use
an Open Wrangler-owned `Rscript` process. Windows does not claim this direct document-process path. Literate documents
resolve the owning executor before choosing R or Python; the fence label alone is not authority.

[ADR 0001: Native R runtime for Open Wrangler 2](decisions/0001-native-r-runtime.md) explains why Native R has its own
runtime and language boundary. The generated reference lists the current operations, and the feature-parity matrix
lists the current limitations.

## Schemas and bounded transport

Every schema that crosses the runtime, host, or webview boundary has non-empty unique column IDs and positions exactly
`0..n-1`. Active, latest-step-input, and applied-step-inspection schemas are validated independently. Column names are
display data; IDs establish identity. A private row identity supports stable viewing but cannot be named by any public
operation and never appears in pages, generated public metadata, or exports.

Semantic column families follow the native outer type. Enum labels, nested child types and timezone metadata do not
change that family; fixed-size arrays remain containers. DuckDB schema, profiles, view validation and value selections
share its existing engine-specific classifier. Known scalar storage wrappers retain their explicit interpretation.

Viewing filters and sorts address columns by name and require a unique, non-empty name. Cell menus, column headers,
profile actions, and the filter panel share that eligibility check. Unnamed columns still support viewing, profiling,
selection, and copy; their name-based actions explain why they are unavailable.

Typed cells are strict-JSON-safe and preserve the distinctions needed by filtering, rendering, saved notebook output,
and engine-normalized transformations. Nested and scalar values pass bounded depth, node, text, and byte validation.
User-derived keys in extension and webview state are held in `Map` or `Set`, not dynamic object properties.

For framed Python runtime requests, the notebook bridge retains only the current request's marked response, bounded
by the runtime's 17 MiB frame ceiling. Output before and after that frame is discarded. Framing and decoding failures drain the exact kernel
execution before returning an error; a complete frame also waits for that execution to settle before publication.
Missing, duplicate, malformed and oversized frames produce diagnostics without copying their payload. This bounds
the bridge's retained frame and marker lookbehind, not memory already allocated by Jupyter or an individual output item.

Notebook variable discovery and notebook-open preflight share a collector capped at 64 KiB of retained UTF-8 text,
128 output objects and 256 items. Raw text size is checked before decoding; decoded size is checked before retention.
Malformed, oversized or structured-error output is discarded while the exact execution drains to settlement.
Preflight uses the bridge's existing host deadline and never interrupts unrelated kernel work. Unknown preflight
execution failures produce a fixed diagnostic without copying the kernel error.

Every live grid request is a two-dimensional row-and-column window. The protocol caps one page at 10,000 rows and 256
columns. The response returns the exact ordered stable `columnIds` corresponding to every row vector; a missing,
reordered, duplicated, or partial identity list fails closed. Filters, sorts, full-schema ARIA coordinates, generated
code, and exports remain independent of the transported projection.

Profiles are progressive and bounded. The initial open does not profile all columns, background capacity is limited,
and values or aggregates cross the runtime boundary only as bounded samples or fixed-size results. Applied-step
inspection is also bounded, read-only, and ephemeral; it replays only the selected prefix and never changes the live
plan or revision.

Saved notebook MIME v2 is one bounded static inline capture. Its caps are 10,000 rows, 2,048 columns, 100,000 cells,
16 MiB, 64 graph levels, and 1,000,000 graph nodes, with separate field-text limits. It is full-width and carries exact
`columnIds`. The inline renderer pages only captured rows and never treats them as a live session, cleaning source,
export source, or fallback. An Open action is offered only for a validated live link and opens the current live value
through its exact notebook and kernel.

## Notebook, kernel, terminal, and document provenance

Notebook launch retains the exact open `NotebookDocument` captured at command or renderer-message receipt. Renderer
actions also retain the exact visible sender `NotebookEditor`. Before and after every await, the host requires that
document object to remain the sole open object for its URI and revalidates the selected kernel. It never reacquires an
origin from `activeNotebookEditor`, a matching URI, or another split after work has started.

Python variable discovery retains its exact kernel and observes that kernel's generation through the picker or
cached variable list. Opening a selection rechecks that receipt and gives the new bridge its own observation until
the runtime session is confirmed. Refreshing the list cannot retire an already opened session, and a stale selection
cannot bootstrap or execute against a replacement kernel.

The host creates each live-kernel candidate session ID before dispatch and maps it to the exact kernel. A malformed,
cancelled, timed-out, stale, or mis-correlated open makes one bounded direct cleanup attempt for that candidate on the
same mapped kernel. Cleanup never looks up a replacement kernel by URI. Kernel replacement invalidates every session
owned by the old kernel; recovery may reopen only against the still-exact originating document and its newly selected
kernel.

Generated-code insertion captures the originating session and document before trust or Code Preview synchronization
waits. The acquired code must belong to that session. Immediately before dispatch, insertion repeats exact document
object, version, and URI-uniqueness checks. Insertion writes code into the document; it does not execute the kernel. Success is reported only after the same notebook contains the uniquely marked inserted cell. Because the
stable VS Code edit API is URI-addressed, an accepted edit that cannot be proven against the original object is
indeterminate: Open Wrangler does not retry, roll it back, or claim success against a replacement document.

R terminal sessions apply the equivalent rule to the exact terminal object and process ID. Direct active-R opens
capture that terminal before cleaning up a previous transport; changing terminals requires a new open action.
Terminal dispatch is one correlated R expression with short physical lines, so a new terminal can accept it before
R changes its input mode. Long path literals remain escaped and are split into bounded string expressions.
R and Quarto document commands retain the exact editor, document, version, URI, selection, parsed chunk, and resolved
executor across every activation, discovery, picker, execution, and focus-restoration await.

## Persistence and recovery

Persisted state is keyed by both source identity and confirmed backend. The cleaning section contains validated
committed steps, at most one draft, and its confirmed base-view receipt. The viewing section independently contains
the confirmed filter/sort model and bounded presentation state such as stable-ID widths, selection, and viewport.
Malformed or stale viewing state falls back to an empty view without dropping valid cleaning. Only cleaning replay
failure reopens the immutable original.

Confirmed file configuration stores both the concrete backend that produced the session and the user's logical
choice of `auto` or an explicit engine. Recovery pins the concrete backend so an automatic fallback cannot reinterpret
saved operations. A later import-options change may select again only when the retained logical choice was `auto`.
Persistence contains no dataframe bytes, runtime session IDs, profiles, or statistics, and debounced presentation
state flushes before a webview disappears.

Queued presentation writes read the originating live session when their storage work begins. They cannot replace
an active transaction's candidate or its previously confirmed cleaning and filter state. Publication combines the
new result with current compatible selection, widths and horizontal position; a changed viewing query still resets
the row position to the returned page. Rollback retains the presentation accepted before publication. A completed
transaction's recovery marker does not prevent later successful saves from restoring durable recovery state.

A failed ordinary presentation save retains the latest live selection, widths and viewport, matching the webview.
The existing storage warning explains that these changes may not survive restart. Reopening restores the last
successfully saved state; a later successful save persists the current presentation and ends the degraded period.
This policy does not change guarded rollback of a page or cleaning publication.

A runtime crash rejects pending work and invalidates internal runtime identities. Recovery opens a private replacement
on the same source and backend, replays the confirmed cleaning and viewing sections independently, regenerates code
and draft metadata, and publishes only the complete correlated result. The source remains the authority; captured
pages are never replay input.

## Trust, source integrity, and export

Python and R execution, dependency installation, custom code, generated-code insertion, and data or script export
require a trusted workspace. Restricted Mode does not expose a hidden affirmative installation or execution path.
Dependency prompts identify the exact interpreter and requirements; only the literal modal confirmation may run pip.
Custom code is trusted arbitrary code in the selected environment, not a sandbox.

Open Wrangler never overwrites source data. Readers validate supported schemes, regular-file identity, and format
options before runtime startup. Lazy readers revalidate the source around each read. Transformations operate on
session-owned state, not the source variable or source file.

Data export and generated-script export require a separate destination. The public script command always uses VS Code's
Save dialog and chooses a Python or R suffix from the active session. Only the extension host chooses or commits the
user destination.

The host captures concrete source-file identities before opening a file or acquiring a live value and confirms them
before publishing the session. Explicit Python Interactive document entry retains its originating document even when
the interactive notebook is untitled. Reopening a file captures a fresh identity alongside the replacement runtime; reopening a live variable
retains its original source identities. Replacement publication and rollback move the runtime and its identities
together. These identities stay in host memory and never enter protocol messages or persisted state.

Each export also captures the current source-path mappings before code synchronization, option prompts or the Save
dialog. It refuses a destination that identifies a retained source, including a source renamed since opening, and
rejects mappings that change during the action. If a concrete source cannot be identified, the dataframe can still be
viewed, but export requires reopening it successfully. An in-memory source needs no file identity.

The host protects the destination through normalized path, authority, canonical identity and file-type checks, then
reserves and identity-pins an exclusive host-owned sibling temporary. The runtime
never receives the authority to choose or commit the final destination. For Python data export, it receives the
temporary path and pinned identity only after the host syncs and closes its descriptor. Python then opens, truncates,
writes, flushes, and closes its writer for that exact temporary. Native R streams chunks through the host writer, and
the host writes generated-script bytes itself.
Pandas and both eager and lazy Polars pass the validated binary writer to their native CSV and Parquet writers.
Holding an earlier descriptor does not authorize reopening an unchecked pathname: identity must be checked before
the writer truncates the file.
DuckDB Parquet export projects top-level HUGEINT and UHUGEINT fields through native DECIMAL(38,0), preserving
exact values within that type's range. Native overflow rejects the export before publication. Nested 128-bit integer
fields are refused by their native type metadata. Interval time components must contain whole milliseconds and fit
Parquet's unsigned 32-bit millisecond field; native checks still reject negative components. Export checks affected
interval leaves inside containers and returns the original values, without reconstructing them or scanning the table
separately.
On DuckDB 1.5.4, top-level TIMETZ values with nonzero offsets are converted to UTC before writing; already-UTC values
retain the native path. Its nested nonzero-offset values require explicit conversion. Newer writers retain native
UTC normalization for scalar and nested values. TIMETZ leaves in map keys are refused whenever that writer would
change their native identity, including the newer writer's normalization of `24:00+00` to `00:00+00`. Compatible keys
and other native fields retain their behavior. The host-owned temporary remains the publication boundary even if a failed native writer
produced partial bytes.

After the applicable writer closes, the host revalidates the temporary, source, destination, parent mapping, and
remote authority and performs one atomic rename. A runtime may use an additional private engine artifact internally,
but publication always terminates at the host-owned temporary. No path truncates, unlinks, follows, or replaces the
active source or a destination symlink, and failure cleans only the still-identified temporary.

## Webview and accessibility boundary

Webviews receive the minimum local resource roots, a restrictive content security policy, bundle-relative assets, and
scripts authorized by a per-document nonce. Runtime and user-derived content is data, never markup or executable
script. Incoming messages are exact-shape validated and accepted only from the current webview owner. The packaged
Codicon font resolves beside the production CSS, and its exact webview origin is allowed by `font-src`.

UI colors, borders, focus states, and typography use VS Code theme tokens. The grid and operation UI expose accessible
names, full-schema row and column coordinates, keyboard navigation, focus restoration, and light, dark, and
high-contrast behavior. Virtualization changes what is rendered, not the accessible schema or stable column identity.
Editable-field undo remains owned by the field; state-scoped workbench shortcuts are mirrored in the webview and
documented in the generated reference.

Pending grid navigation yields to a later focus choice, including headers and resize controls. Virtualizing the
original cell alone does not cancel navigation. A column-resize drag ends when the host restores view state, the
logical view changes, or its controls become disabled; its own width updates and viewport resizing retain the drag.

## Package and release identity

The extension identity is `Matt17BR.openwrangler`; its commands and settings use `openWrangler.*`, the custom editor is
`openWrangler.viewer`, the Python package is `openwrangler_runtime`, and notebook output uses
`application/vnd.openwrangler.viewer.v2+json`. The bundled runtime version in
`python/openwrangler_runtime/version.py` is PEP 440-equivalent to `package.json` and drives the initialize handshake.

A release candidate is exactly one `openwrangler.vsix`, `openwrangler.vsix.sha256`, and
`openwrangler.vsix.provenance.json` triple produced by the canonical packaging job. The provenance binds extension
identity and version, preview/stable status, release tag, exact source commit, VSIX size, and lowercase SHA-256. Every
installed-performance, editor, and publication consumer revalidates those same bytes and metadata; it does not rebuild
or substitute a candidate. Stable publication promotes the accepted bytes, and conflicting tags, registry bytes, or
metadata fail closed.

The [testing guide](testing.md) covers source and editor checks, the [release guide](releasing.md) covers publication,
and the [product roadmap](product-roadmap.md) records the bounded Cursor check and optional released-Jupyter workflow.

## Related authorities

- [Generated reference](reference.md) — commands, settings, operation parameters, and shortcuts.
- [Feature parity](feature-parity.md) — current engine status, completed slices, and open release gates.
- [Testing](testing.md) — required source, runtime, webview, editor, accessibility, package, and manual checks.
- [Releasing](releasing.md) — canonical packaging, candidate qualification, publication, and recovery.
- [Native R ADR](decisions/0001-native-r-runtime.md) — accepted native R ownership and release boundary.
