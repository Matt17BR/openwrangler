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

Mutation state crosses the runtime and webview boundary atomically. Preview, apply, discard, undo, import replacement,
and recovery either publish a complete confirmed snapshot or restore the prior revision, plan, draft, metadata, page
cache, code, selected column, and profiling ownership. No layer constructs a plausible partial result after an
ambiguous response.

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

### Pandas

Pandas executes viewing, all 32 cleaning operations, profiling, generated code, and supported exports in Pandas.
Duplicate and non-string labels are addressed positionally after binding. Object-dtype cells are recursively isolated
before trusted custom code, preview, rollback, or generated-code execution so nested user objects cannot mutate the
source. Typed null, NaN, decimal, datetime, and wide-integer behavior is normalized at the protocol boundary.

### Polars

Eager and lazy Polars paths remain Polars-native and never call `to_pandas()`. Lazy file viewing projects before
collection and transports only bounded terminal results. One-hot encoding and multi-label binarization are explicit
cleaning exceptions: each materializes the complete lazy frame in Polars to derive its dynamic output columns. They do
not convert through another dataframe engine. Viewing, all 32 cleaning operations, profiling, generated code, and
supported exports stay in Polars. PyArrow is optional and limited to native dependency preparation where the Polars
Excel reader requires it; it is not a transport conversion path.

### DuckDB

DuckDB file sessions retain a connection-free native SQL plan plus immutable column and type metadata. Each request
creates and closes its own hardened connection, and any `DuckDBPyRelation` is dereferenced before that connection
closes. DuckDB never converts through Pandas, Polars, or Arrow, and extension auto-install, autoload, and external-file
caching remain disabled.

CSV, TSV, JSONL, and Parquet file sessions have native viewing and the complete 32-operation live/generated catalog,
but DuckDB remains an experimental, partially qualified backend; Excel and database browsing are not claimed. A live
notebook `DuckDBPyRelation` is the sole relation-retention exception. Its exact user-owned relation is serialized on
its originating connection, is viewing-only, and is released without closing or mutating the user's relation.

### PySpark

Supported local final/stable PySpark 4.2.x Classic and Connect dataframes are live-notebook, viewing-only sources.
Open Wrangler does not clean them, generate cleaning code for them, or export them. Projection, filtering, sorting,
counting, and aggregation stay in Spark. The runtime never calls `toPandas()`, `toArrow()`, or an unbounded
`collect()`/iterator. A page must pass Spark-side transport-byte preflight before values are collected and then remain
inside the cell, strict-protocol-byte, complex-node, and nesting-depth limits. Only that bounded page/value sample or a
fixed-size aggregate result crosses into the kernel process.

### Native R

Native R sessions operate directly on R `data.frame`, tibble, and `data.table` frames. IRkernel, exact official
R-terminal, and owned `Rscript` transports share the same native frame contract and current 32-operation catalog,
including generated R. The runtime never routes an R frame through Python. The public status remains preview and
Partial until the installed and performance gates named in the feature-parity matrix are complete.

Notebook work stays in the selected IRkernel. An existing official R-terminal variable stays pinned to the exact
terminal and process that exposed it. Passive discovery reads bounded vscode-R metadata as an untrusted hint and
sends no R command. An explicit Open or Refresh action revalidates that terminal and process, then uses terminal
`sendText` to install or drive Open Wrangler's private dispatcher. Open Wrangler never writes vscode-R's files or
silently moves the session to another terminal. On macOS and Linux, trusted `.R`, `.Rmd`, and `.qmd` sources may use
an Open Wrangler-owned `Rscript` process. Windows does not claim this direct document-process path. Literate documents
resolve the owning executor before choosing R or Python; the fence label alone is not authority.

The accepted design and language boundary are recorded in
[ADR 0001: Native R runtime for Open Wrangler 2](decisions/0001-native-r-runtime.md). The generated reference and
feature-parity matrix, rather than the ADR's operation examples, are authoritative for the current catalog and
qualification status.

## Schemas and bounded transport

Every schema that crosses the runtime, host, or webview boundary has non-empty unique column IDs and positions exactly
`0..n-1`. Active, latest-step-input, and applied-step-inspection schemas are validated independently. Column names are
display data; IDs establish identity. A private row identity supports stable viewing but cannot be named by any public
operation and never appears in pages, generated public metadata, or exports.

Typed cells are strict-JSON-safe and preserve the distinctions needed by filtering, rendering, saved notebook output,
and engine-normalized transformations. Nested and scalar values pass bounded depth, node, text, and byte validation.
User-derived keys in extension and webview state are held in `Map` or `Set`, not dynamic object properties.

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

The host creates each live-kernel candidate session ID before dispatch and maps it to the exact kernel. A malformed,
cancelled, timed-out, stale, or mis-correlated open makes one bounded direct cleanup attempt for that candidate on the
same mapped kernel. Cleanup never looks up a replacement kernel by URI. Kernel replacement invalidates every session
owned by the old kernel; recovery may reopen only against the still-exact originating document and its newly selected
kernel.

Generated-code insertion repeats exact object, version, URI-uniqueness, and kernel preflight immediately before
dispatch. Success is reported only after the same notebook contains the uniquely marked inserted cell. Because the
stable VS Code edit API is URI-addressed, an accepted edit that cannot be proven against the original object is
indeterminate: Open Wrangler does not retry, roll it back, or claim success against a replacement document.

R terminal sessions apply the equivalent rule to the exact terminal object and process ID. R and Quarto document
commands retain the exact editor, document, version, URI, selection, parsed chunk, and resolved executor across every
activation, discovery, picker, execution, and focus-restoration await.

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

Open Wrangler never overwrites user data. Readers validate supported schemes, regular-file identity, and format
options before runtime startup. Lazy readers revalidate the source around each read. Transformations operate on
session-owned state, not the source variable or source file.

Data export and generated-script export require a new destination. The public script command always uses VS Code's
Save dialog and chooses a Python or R suffix from the active session. Only the extension host chooses or commits the
user destination. It protects every retained source and the destination through normalized path, authority, canonical
identity, and file-type checks, then reserves and identity-pins an exclusive host-owned sibling temporary. The runtime
never receives the authority to choose or commit the final destination. For Python data export, it receives the
temporary path and pinned identity only after the host syncs and closes its descriptor. Python then opens, truncates,
writes, flushes, and closes its writer for that exact temporary. Native R streams chunks through the host writer, and
the host writes generated-script bytes itself.

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

Current native-R candidate acceptance has three distinct parts rather than the older monolithic journey:

- cross-platform VS Code jobs on Linux, macOS, and Windows each run fresh `core-operations`, `native-frames`, and
  `kernel-restart` phases;
- two Linux VS Code shards split lifecycle work (`core-operations`, `kernel-restart`, `interactive-terminal`, and
  `literate-documents`) from editing work (`native-frames`, `value-operations`, and `categorical-operations`); and
- remote R Jupyter runs as its own phase in the Jupyter matrix.

Each phase consumes and reverifies the canonical candidate. Source checks, installed-editor isolation, failure-artifact
privacy, exact R versions, current workflow matrices, and release gates are maintained in [testing](testing.md),
[releasing](releasing.md), and the workflows themselves.

## Related authorities

- [Generated reference](reference.md) — commands, settings, operation parameters, and shortcuts.
- [Feature parity](feature-parity.md) — current engine status, completed slices, and open release gates.
- [Testing](testing.md) — required source, runtime, webview, editor, accessibility, package, and manual checks.
- [Releasing](releasing.md) — canonical packaging, candidate qualification, publication, and recovery.
- [Native R ADR](decisions/0001-native-r-runtime.md) — accepted native R ownership and release boundary.
