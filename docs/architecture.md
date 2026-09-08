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

Python page reads stage the viewing query, shapes and bounded cache under the existing foreground-read lock. The
previous view remains authoritative until page construction, metadata, source validation and the owning engine's
request scope succeed. Public page responses are checked with their real correlation fields before committing the
candidate view. This preserves the separate page and complete-frame size limits. Failure preserves the previous
query, epoch and frame identities; a changed or lost source still invalidates cached data.
Cache invalidation uses the same reentrant state lock, so a late background failure cannot have its invalidated
blocks restored by a foreground candidate. It does not join request admission or wait for profiling leases.
Spark owns a page-only scope for its continuation anchors. A rejected candidate therefore cannot prevent the prior
view from continuing after a cached page, and background profile failure cannot roll back newer foreground paging.

Mutation state crosses the runtime and webview boundary atomically. Preview, apply, discard, undo, import replacement,
and recovery either publish a complete confirmed snapshot or restore the prior revision, plan, draft, metadata, page
cache, code, selected column, and profiling ownership. No layer constructs a plausible partial result after an
ambiguous response.

A failed or cancelled operation preview reports its error inside the dialog that submitted it, alongside the retained
inputs. The mutation snapshot owns that dialog context and operation kind; unrelated actions keep their workspace
errors. Error text and code settle together, and changing the operation, closing the dialog or replacing the session
clears its preview error.

## Runtime ownership

The standalone Python runtime is single-flight per Python-selection scope. A workspace folder, an exact external
resource, and the default resource have separate process, startup, pending, provisional, and confirmed-session state.
Requests and cancellations route through the exact owner. Restart invalidates that owner's pending start; closing its
last session stops its process after bounded stdin/EOF shutdown. A forced kill is reserved for recovery or an expired
shutdown bound.

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

The public catalog contains 32 cleaning operations. The 31 operations that address input columns accept only public
`{id, name}` references; Custom Code is the sole non-column-addressing operation. The runtime binds public references
against the exact input schema and lineage to private positions before execution. Unknown, stale, repeated where
disallowed, type/name-mismatched, colliding, or private row-identity references fail closed. The current catalog and
parameters are listed in the generated [transformation reference](reference.md#transformation-operations).

Viewing `FilterModel` and `SortRule` remain name-addressed, presentation-only queries. A committed Filter Rows or Sort
Rows step uses a separate transform filter/sort IR whose column operands are stable `{id, name}` references. The two
representations are never inferred from one another by name fallback.

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

### Pandas

Pandas executes viewing, all 32 cleaning operations, profiling, generated code, and supported exports in Pandas.
Duplicate and non-string labels are addressed positionally after binding. Object-dtype cells are recursively isolated
before trusted custom code, preview, rollback, or generated-code execution so nested user objects cannot mutate the
source. Typed null, NaN, decimal, datetime, and wide-integer behavior is normalized at the protocol boundary.
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

Other Formula arithmetic first keeps any successful native result unchanged. After eligible Arrow coercion failures,
UInt64 add, subtract, multiply and power may use an exact UInt64 scalar or convert a nonnegative signed 8–64-bit
companion column. After a failed native UInt64 add or subtract, an exact negative integer literal with magnitude
at most UInt64 maximum uses the opposite checked operation on its unsigned magnitude. Companions must use native
NumPy, built-in Pandas nullable or Arrow integer storage; Sparse and arbitrary extension types do not enter this repair.
Selected Decimal128 operands may widen to Decimal256 with the same precision and scale for add, subtract, multiply
and divide. Each repair makes one checked native call; overflow
and unsupported cases still refuse. Live and generated Formula share this behavior without changing By Example.
Negative column operands, negative multiply/power literals and the widest or negative-scale Decimal capacity gaps
remain tracked in [#979](https://github.com/Matt17BR/openwrangler/issues/979).

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

Eager and lazy Polars paths remain Polars-native and never call `to_pandas()`. Lazy file viewing projects before
collection and transports only bounded terminal results. One-hot encoding and multi-label binarization are explicit
cleaning exceptions: each materializes the complete lazy frame in Polars to derive its dynamic output columns. They do
not convert through another dataframe engine. Viewing, all 32 cleaning operations, profiling, generated code, and
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

CSV, TSV, JSONL, and Parquet file sessions support native viewing and all 32 cleaning operations in both live and
generated code. DuckDB file editing remains experimental. Excel and database browsing are not supported. A live
notebook `DuckDBPyRelation` is the sole relation-retention exception. Its exact user-owned relation is serialized on
its originating connection, is viewing-only, and is released without closing or mutating the user's relation.

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
R-terminal, and owned `Rscript` transports share the same native frame contract and current 32-operation catalog,
including generated R. The runtime never routes an R frame through Python. The public status remains Preview and
Partial because of the row-specific limitations recorded in the feature-parity matrix.

R frame validation accepts native compact zero-row metadata while independently checking column lengths. Live and
generated input/output validation apply the same rule, so native empty subsets do not become malformed frames.

Generated R follows the live operation's native column-metadata behavior at each step. It normalizes element names
on its already-isolated `data.table` result without making another full data copy; Clone and Custom Code retain their
explicit named-input behavior. This keeps later attribute-sensitive custom code consistent with the preview.

Generated Fill Missing Values code includes only the helper families used by the complete plan. Repeated and mixed
steps retain each required family once, including scalar datetime and numeric midpoint dependencies.
Directional Fill uses the same native missing-run and donor-selection function in live execution and standalone
generated code. Frame validation, stable sorting, key restrictions, and isolated publication remain with their
existing owners.

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
