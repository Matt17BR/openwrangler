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
- `protocol/openwrangler.v4.schema.json` is the canonical coordinator-facing request and response schema. Its
  generator emits five checked-in artifacts: TypeScript protocol types, TypeScript operation catalog, TypeScript
  limits, Python operation catalog, and Python limits. It does not generate the full Python runtime protocol. Native R
  has a separate private transport v18 and frame contract v7, which `RKernelBridge` adapts to and from coordinator
  protocol v4.

Native tree views, Code Preview and file custom editors keep their original lazy provider registrations until shutdown.
Loading an owner supplies its delegate without unregistering a view or disposing its document while VS Code resolves it.
Walkthrough, Settings and Report Issue commands retain their lightweight owner when native views load.
Lazy variable providers show a pending snapshot only until their owner loads. A loaded owner's absent notebook
snapshot remains absent, allowing Data sources to offer the idle R action. Data sources owns file-opening and cached
Python/R discovery rows and their refresh subscriptions; Operations shows only the active dataframe's cleaning catalog.
An unread R terminal remains discoverable beside a notebook. The R snapshot states whether its idle action starts or
refreshes a terminal; its display name does not choose the action.
Editor and Code Preview resolution retain VS Code's exact cancellation token through loading and file preflight.
Canceled resolution leaves existing view ownership intact and does not start panel setup or publish late file errors.
Activation installs its lightweight gates before the first yield. Elapsed setup time does not invalidate successful
registration; lifecycle cancellation and actual initialization errors still shut down initialized owners.

Automatic Code Preview opening uses the exact view's `.open` command with focus preserved. Renderer synchronization
stays layout-pending while that command awaits the workbench container opening. Completion or failure publishes a
fresh marker for pending generated-column reveals. This boundary does not wait for Code Preview's editor to hydrate
or for later layout changes. Further renderer acknowledgements do not repeat the open action. Discarding the draft,
changing the reveal setting, or deactivating the panel does not settle an in-flight command.

The extension host is the authority at every boundary. A webview cannot select a different source, session, kernel,
terminal, or export destination by supplying an identifier the host did not issue and retain.
Open Source File captures the currently active session. With no active session or reopenable source, it reports
immediately.

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

File Auto selection chooses the first available backend in Polars, DuckDB, then Pandas order, restricted by the
file format and import options. Fresh Auto opens preflight the resource's Python selection and package availability
before creating a panel, reusing the existing environment/runtime preparation cache. If unconfigured discovery finds
no supported Python executable, or none of the compatible file engines has its required packages, the host tries R
for a supported native file. Broken configured Python paths, trust/cancellation/timeouts, malformed probes, unexpected resolver
errors and source validation failures do not authorize this fallback. A native R compatibility or missing-executable
refusal retains the ordinary Python dependency-repair panel. This happens before the native read; a read error does
not trigger another engine.

The Auto handoff captures the logical Python selection owner and rechecks it after resolving R. Another unresolved
failed lookup does not retire that owner; a newly resolved Python environment or actual selection invalidation does.
Cancelling one preflight detaches that caller while shared preparation settles for other callers. Confirmed R sessions
retain their concrete backend and logical Auto preference on restore; they do not repeat Python selection.
**Open Wrangler: Open File Path** reads the configured default and creates a fresh panel, including after a failed
open. Restoring a custom editor instead preserves its previously confirmed backend.

R selection opens local CSV, TSV, Parquet, JSONL/NDJSON or Excel files through an owned `Rscript` process on Linux, macOS or Windows. Choosing between R and a Python engine opens a separate panel with that engine's own saved plan, if any;
it does not translate the original panel's steps or discard its state. The host carries the exact file, session and
revision through the picker and cancels an unhanded runtime when that owner retires. R file import-options changes
also open a separate session because the native process is bound to its original source and options.

**Open DuckDB Table** resolves a local regular file, its resource-scoped Python interpreter and a bounded native
catalog of non-temporary tables and views before asking for one. Discovery closes its reader before the picker opens.
Tables and views share one catalog namespace, so the runtime resolves the selected kind at open. A table is queried in
place. A view is evaluated once into a temporary table in the viewer's own read-only connection; every later query
reads that snapshot, which spills to the reservation's private directory and disappears when the connection closes. The file source
retains only the exact `duckdbSchema` and `duckdbTable` import options, with both required and other import options
excluded. Each name contains 1 to 1024 Unicode scalar values without NUL; names are not trimmed. A real file path and
the DuckDB backend are required regardless of filename suffix. The picker admits at most 4096 entries and 65536 UTF-8
name bytes within a 256 KiB response. Trust, source identity, cancellation and the captured interpreter are rechecked
before dispatch. The original file identity is retained through queued preparation and confirmed before session
publication. A changed canonical path or device/inode identity refuses the selected table and closes only its
unpublished runtime; this check does not establish a content snapshot. Ordinary import reconfiguration, backend
switching and plan reuse exclude this viewing-only subtype.
The existing persistence key includes both names; runtime recovery reopens the exact selected table.
Discovery bounds each native name projection before transferring it to Python and disables disk spill, so a killed
metadata helper owns no temporary directory. Native catalog work can still exceed the accepted response size.

DuckDB table/schema, Excel worksheet and R variable pickers retain original names in their selected descriptors.
Names containing icon syntax, quotes, backslashes, C0 controls or edge whitespace use JSON string notation in the
picker, with `$(` encoded as `\u0024(`. Ordinary names remain unchanged. Native search uses the displayed text;
the notation does not escape every Unicode control or guarantee screen-reader pronunciation. Live-variable tree
labels remain raw. One host formatter owns this presentation, without changing source names or picker lifetimes.

Excel imports accept exactly one nonempty worksheet name or zero-based sheet index. Names are not trimmed, including
whitespace-only names. Discovery, picker selections, manual input and remembered file settings retain that exact
identity through runtime validation and native reading. Empty names and conflicting selectors remain invalid.

**Open Another File with This Plan** captures one confirmed, draft-free Pandas, Polars, DuckDB or native R file plan before
the picker opens. It excludes Custom Code and requires unique, non-empty original column names. The host retains
the validated original file schema through ordinary edits, refreshing it on source/runtime replacement. This receipt
is private and is not persisted. Target columns must have the same names, semantic types and raw types; observed
nullability, row counts and row labels may differ. An exact positional match keeps the captured steps unchanged.
Reordered input requires a bijection of unique, non-empty names. The host copies the plan and translates declared
source-column references to the target IDs, preserving names, derived IDs, literal values and parameter order.
The shared reference enumeration also serves saved-step editing; native replay still binds each step against its
current input schema. Target column order is preserved unless a cleaning step changes it. Generated code retains the
target's input-order requirements. Both files use the same concrete backend and
import options. Renamed, extra or missing columns and notebook inputs remain outside this command's scope.

The captured session, runtime owner and revision must remain current through replay and persistence staging;
switching active editors cannot retarget the action. Python retains its exact process and environment selection.
R retains its exact bridge session, transport mapping and kernel generation. The global file command captures the
active session's actual delegate; ordinary request authorization remains bound to each bridge. A target R file receives
its own source-pinned process through the existing factory and coordinator replay path. Source ownership never moves
to the selected target. The target's runtime owner is retained from confirmed open through final publication.
The origin's already-loaded data is not re-executed. The selected target follows ordinary eager-snapshot or lazy-file
fingerprint rules. Current and retained file identities prevent selecting
the origin or another open file session through a path, symlink or hard-link alias. Unverifiable identities are refused.
The target configuration's exact persistence key must be absent, including raw malformed or pending records; other
configuration keys are preserved. The existing store repeats that absence check inside its commit queue.

The existing restorer replays the complete plan privately, with one-row intermediate responses, and obtains the final
page before saving. Small responses do not bound native scans or temporary memory. The candidate becomes an ordinary
Editing session only after durable success. Failure closes only that candidate, after detached execution settles.
A failed native close cannot strand an unpublished R file process: coordinator idle retires that exact file delegate
once its pending and detached work settles. Notebook mappings keep their retryable close behavior.
The failure response is selected before terminal cleanup, preserving an already-observed cancellation or stale owner;
closing the failed candidate does not replace a schema, replay or storage diagnostic with a runtime-change error.
Cancellation, runtime retirement or file replacement during the final durable write can leave the copied plan saved
without publishing its runtime. Reopening that target uses ordinary saved-plan restoration. Subsequent exports protect the target's own
source through the normal destination checks; the originating file is not an additional execution input.

Delimited import detection reads at most 65,539 bytes once: a 64 KiB nominal prefix and up to three bytes to complete
its final UTF-8 scalar. A valid nominal prefix ignores later bytes; malformed interior bytes retain the existing
encoding fallback. This sample does not prove EOF or validate the full file.

CSV/TSV import options may include `lineEnding: "cr" | "lf"`; LF includes CRLF. Polars uses that hint in its native
scanner, while Pandas and DuckDB retain native line recognition. The selected quote-aware sample parser infers only
consistent, complete unquoted CR endings. It leaves LF/CRLF, mixed or unobserved endings unspecified; a final CR may
be a partial CRLF. Import Options can set the value explicitly. Polars still requires consistent record endings.
Omitted LF defaults preserve existing saved-state keys, including normal file reopen; changing an explicit value
uses the existing import replacement and persistence owners.

This file-only option stays in protocol v4 because file commands use the owned runtime bundled with the current
extension. Native R follows its [CSV and TSV reader contract](#csv-and-tsv-files).
Non-file and non-delimited sources reject the option, so it cannot reach a retained notebook runtime. A manually
mixed older decoder rejects the new key; this is not a compatibility promise for every historical v4 binary.

Import prompts belong to one host-owned request. An accepted native Quick Input stays visible until its successor
replaces it, avoiding editor-focus restoration between questions. Cancellation remains effective through the final
answer; completion, cancellation and failure dispose the request's inputs and listeners.

Changing Python file import options is a host-owned session swap. The coordinator quiesces accepted work, opens a private
candidate against the same immutable source, replays the confirmed plan, draft, and view, publishes the replacement
once, and then retires the prior runtime. Failure before publication leaves the prior confirmed session unchanged.
A failed final save rolls back only while the replacement still owns the live session. The public session identity
remains stable while the runtime identity may change. File reconfiguration, cleaning-plan rewrites and live
mode changes check host cancellation tokens through the pending persistence write, before synchronous publication.
Cancellation after that publication does not undo the replacement.

## Protocol and publication

Every coordinator-facing request and response uses protocol v4, passes strict decoding, and carries the identifiers
needed to correlate it to a request and session. Python bridges implement that boundary directly; `RKernelBridge`
validates and translates between it and native R's private transport and frame contracts. Public transform parameters
never contain private bound positions. Unknown fields, malformed unions, invalid limits, stale identities, and schema
inconsistencies fail before adapter dispatch or UI publication.
Older live protocols are rejected. An already-running Python notebook kernel may retain an imported v2 or v3 runtime after
an extension update; restart that kernel and rerun its cells before reopening the dataframe. Open Wrangler does not
replace imported modules or restart a user-owned kernel to change its protocol.

Dataset statistics require exact missing-cell, missing-row and per-column missing counts. The duplicate-row count
is either a nonnegative integer or explicit null when unavailable. Both
the workbench and native Summary view display that state as unavailable. Native R retains numeric duplicate counts.
The Dataset drawer owns requests for these statistics. Selecting an uncalculated statistic in native Summary opens
that drawer for the displayed session and revision; stale actions cannot target another dataframe. The same request
owner drives its pending indicator and explicit retry. Idle and failed requests do not keep a profiling indicator.

Python request enums, including nested cleaning parameters, require string values before membership checks. Present
`backend`, `mode` and `cloneFrom` options must satisfy their existing schemas; explicit null is not an omitted option.
Malformed values return the existing `invalid_request` classification. Omitted options retain their defaults.
Failures raised after decoding keep their existing `engine_error` or `runtime_error` classifications.

Python's standalone and notebook request handlers return a bounded, correlated `runtime_error` for a recognized
Polars `PanicException` after the operation unwinds. Recognition requires identical public and already-loaded native
exception exports; error handling does not import an optional engine. Missing or divergent exports retain ordinary
`Exception` handling. Caller interrupts, exits and other `BaseException` subclasses keep their existing propagation.
This does not retry the operation, restart the runtime or cover native process crashes.
If an admitted exception's message formatting also raises an admitted exception, the same error mapper returns a
fixed bounded message with its original classification and session fields. It omits traceback detail rather than
calling the failed formatter again. This preserves request settlement without limiting arbitrary formatter execution.

Histogram clicks use the shared view-filter builder. Integer bins translate their lower edge with ceiling, their
exclusive upper edge with ceiling, and the final inclusive edge with floor. Strict integer operand validation stays
unchanged. If any converted boundary is outside the safe integer range, selection is unavailable for that histogram:
its floating-point display bins cannot guarantee exact integer membership. Hover and keyboard descriptions remain
available; explicit column filters and exact value selections keep their existing limits.

Runtime work has three relevant classes:

- mutations and exports are exclusive;
- page and column-value reads may proceed alongside background or selected-column profiling; and
- background profiles use bounded capacity and are cancelled or drained during close.

The host admits at most one background profile, one interactive profile and one ordinary foreground request per
session. Interactive requests retain FIFO order, so reads cannot skip a queued mutation. Mutations, exports and close
wait for every active owner to settle, including cancelled profiles. Native R still executes one request at a time;
managed file profiles can yield between requests as described under [Viewing and profiling](#viewing-and-profiling).

Each logical view has an opaque context, and each request within it has a `viewRequestId`. Session revision or filter
equality is not enough to establish freshness. Pages, summaries, statistics, values, errors, and profiles update the
UI or retained panel state only while their request belongs to the active confirmed view. Cancellation is
authoritative only when the original correlated request returns. A cancellation acknowledgement may remove queued
work, but it cannot invent completion for running work or conceal a mutation that may have committed.
Cached filter choices exclude their own column's filter. A viewing change retains them only when that effective
query, including sort and AND/OR logic, is unchanged; Search explicitly reloads cleared choices. Sorting can change
the typed representative of equal values. Failed view changes restore choices from the original confirmed snapshot.
Header Filter, switching into the Filters tab and Show More start a fresh local form for their explicit default-value
request, including when the requested column is unchanged. Activating the already-selected tab retains the form's
column, inputs, staged sorts and current values request. Native Sort Edit navigation selects its column without
clearing search, predicate or staged-sort drafts, including when it targets a different column. It does not request
values. Passive metadata and viewing changes retain local form input.
Value Search and its Enter shortcut are unavailable while the current view cannot be profiled. During a pending
viewing query, search text remains editable; settlement does not queue or replay a search. The request owner
rechecks eligibility at dispatch.
Clipboard pages share the foreground queue with ordinary viewing requests. Before dispatch or recovery, and again
after awaited recovery or detached-execution settlement, the coordinator rejects cancelled clipboard pages and
those whose logical context is no longer current. This prevents a queued read for an older view from changing
runtime viewing state after a newer view has been confirmed. Contextless internal reads retain their existing
behavior; running reads still require correlated response validation and freshness checks.

Before Preview, Apply, Discard, Undo or Redo, the host supplies its accepted filter and view-change epoch through the
runtime envelope. The pair belongs to the enclosing request's exact session and revision; it is absent from webview
requests. The runtime reconciles its query within the existing mutation transaction before consuming history. A
successful page that the host later discards therefore cannot choose the view used by an edit. Matching queries reuse
their native frame; restoring a different accepted query may require filtering again. Editable-engine page reads and
background profiles retain their existing behavior.
Recovery and replacement replay create history receipts in the same epoch namespace as the published session. Each
replayed edit uses the candidate's current schema and filter. Returning to the same filter after a confirmed view
change does not erase that change or revive an obsolete draft restoration receipt during the live session.
Earlier-step rewrites and live mode changes capture the accepted filter after admitted requests have settled, so a
page confirmed while replacement waits is included in the new session's view. Mode changes retain the caller's
requested grid layout.
Before a rewritten plan's final page, the host removes filters and sorts whose columns disappeared or changed type.
Python follows unique, non-empty column names; native R follows column IDs, retaining its rename behavior. Unaffected
query rules keep their order and values. A draft's base filter, schema and view-change epoch share one host receipt,
so applying an earlier replacement can restore filters on columns created by its suffix. A newer accepted view uses
its own schema instead. Recovery rebuilds the receipt from the replayed committed schema and accepted base filter.
Durable state still stores only the draft's base filter, without its schema or intervening view epochs. A persisted
open uses the existing saved-filter restoration rules in a fresh epoch namespace.

Python and R kernel execution is not treated as safely interruptible. Timeout or cancellation stops publication and
triggers bounded cleanup; it does not claim that user-owned kernel work was interrupted. Idempotent summary and
dataset-statistics reads may recover once after a lost runtime when the view is still current, regardless of their
scheduling priority. Recovery rechecks that view before publishing or reissuing the read. Mutation retry rules do
not change, and concurrent recovery shares one replacement per runtime owner.
Recovery checks the originating session and source after opening its candidate and around each replayed request.
Close, cancellation or supersession stops subsequent replay, including fallback viewing requests. Already-started
execution retains its settlement barrier before candidate cleanup.
Initial saved-plan and view restoration checks coordinator availability, cancellation and the captured source around
each replayed request. Retirement stops further restoration and original-data fallback; detached execution settles
before the unpublished runtime is closed.
Cleaning replay failures identify the preview or apply request position, or the draft being restored, and include
up to 1,024 Unicode characters of a correlated runtime error message. Saved-plan failure and reset prompts retain
that context. Uncorrelated response content, traceback details and arbitrary thrown errors are not included.

Python page reads stage the viewing query, shapes and bounded cache under the existing foreground-read lock. The
previous view remains authoritative until page construction, metadata, source validation and the owning engine's
request scope succeed. Public page responses are checked with their real correlation fields before committing the
candidate view. This preserves the separate page and complete-frame size limits. Failure preserves the previous
query, epoch and frame identities; a changed or lost source still invalidates cached data.
For the original frame of an ordinary Polars or DuckDB file, a page request changing only sorts reuses the known
filtered count while still applying and validating the new query. Predicate changes and different displayed frames
recount. Notebook sources and DuckDB database tables retain their existing count behavior, including reevaluation
of computed database columns.
Python response sizing and encoding share a strict-JSON writer. It processes long strings in chunks of at most
16,384 characters, writing unescaped ASCII chunks directly and validating escaping and UTF-8 for other chunks.
It stops when a prefix exceeds the byte bound, without inspecting later chunks for other invalid data.
Cache invalidation uses the same reentrant state lock, so a late background failure cannot have its invalidated
blocks restored by a foreground candidate. It does not join request admission or wait for profiling leases.
Python live pages with a known total clamp the requested row position to that total before the native slice.
A request beyond the end returns an empty page at the exact end, with its requested limit and column projection.
Inspection applies this rule separately to its input and output. The host requires this exact position; unknown-total
continuations retain the requested position and their existing anchor checks. No extra row count is performed.
Before publication, Python rejects a returned page whose row range exceeds its known total. The existing recoverable
page error preserves the confirmed view and cache. This catches observed count/page disagreement, including volatile
DuckDB expressions, without another scan; it does not make separate evaluations a snapshot.
Spark owns a page-only scope for its continuation anchors. A rejected candidate therefore cannot prevent the prior
view from continuing after a cached page, and background profile failure cannot roll back newer foreground paging.
Spark page requests also carry the host's accepted filter and epoch. The runtime retains one accepted query with its
exact logical frame, known shape and ordered continuation anchors. A later request confirms the successful working
query before replacing it; a superseded working query cannot replace that checkpoint. Reading the accepted filter
reuses its exact frame even at row zero, preserving subsequent continuation after another query fails.

The first such request binds the current matching query to the supplied host epoch. This also covers a fresh runtime
whose accepted viewport was restored through contiguous pages. Each checkpoint belongs to its exact session, source
and revision, and source loss or disposal releases it. A successful page without host intent clears the checkpoint.
Spark retains at most 4096 working and 4096 accepted anchors,
with one unchanged eight-page, 16 MiB page cache. Capturing or restoring the checkpoint performs no Spark action and
does not persist or materialize a dataframe; ordinary page validation and traversal checks still apply.

Mutation state crosses the runtime and webview boundary atomically. Preview, apply, discard, undo, redo, import replacement,
and recovery either publish a complete confirmed snapshot or restore the prior revision, plan, draft, metadata, page
cache, code, selected column, and profiling ownership. No layer constructs a plausible partial result after an
ambiguous response.

A failed or cancelled operation preview reports its error inside the dialog that submitted it, alongside the retained
inputs. The mutation snapshot owns that dialog context and operation kind; unrelated actions keep their workspace
errors. Error text and code settle together, and changing the operation, closing the dialog or replacing the session
clears its preview error.
A successful accepted plan update closes an open saved-step editor, using the existing focus restoration. Reopening
the step obtains its current input schema; retaining the same step ID does not prove that schema survived a replay.
Failed updates and ordinary new-operation forms retain their input.
Native saved-step edits received during a page request wait for that page, then inspect the step only if the session
and revision still match. A newer action or explicit inspection cancellation retires the queued edit. Inspection
refusals are not retried automatically; edits received during a cleaning mutation use the existing wait message.

Retained multi-column forms submit unavailable selected IDs to the existing parameter validator instead of silently
dropping dependencies. An explicit repair action removes those selections; optional forms explain when clearing them
will select all columns. Toggling another checkbox preserves unavailable IDs, and a nonempty column search remains
clearable after the schema shrinks.
Removing a focused form row or clearing unavailable selections moves focus to its surviving labelled group before
removing the control. The shared fieldsets accept programmatic focus without adding a Tab stop. The action respects
focus held by another control or outside the webview.
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

The input loop releases its temporary request Future after registration. The executor and pending map own active
work; completion removes pending ownership so an idle reader does not retain the last failure's traceback or result.
Remaining exception cycles follow normal Python garbage collection.

At EOF, the Python server cancels queued work and uses one shared grace period to wait for session cleanup and
unfinished work.

Python and native R requests accept configured timeouts only within the settings' declared finite numeric range.
Invalid values use the corresponding default. R rounds configured values upward to whole milliseconds; its native
transports retain strict validation of explicit per-call deadlines. Explicit deadlines remain authoritative.
R discovery uses the validated opening setting, retaining the document resource or global terminal scope that
started it. Each discovery and session request keeps its own deadline. R export retains its separate 30-minute
default; it does not use the ordinary request setting.

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
open failure, close, shutdown, and notebook snapshot completion clean it up at most once. Pending opens retain their
exact engine for shutdown interruption before loading or cloning the source. Shutdown requests interruption from
eligible pending and published engines, then waits for the opening worker to clean up a failed candidate. Engine
creation that finishes after shutdown begins is refused before loading. Interruption is best-effort for already-active
native work; it does not prevent later queries from starting between interruption and the final publication check.
Running user cancellation remains unchanged. The standalone server
prepares native dependencies before dispatching session work; preparation does not authorize conversion through a
different dataframe engine.

Live notebook sessions instead belong to their exact kernel. R document-process sessions belong to their exact
Open Wrangler process, and interactive R sessions belong to their exact terminal. These owners never share a session
merely because another resource has the same URI, variable name, or display label.

## Engine boundaries and capabilities

Profiles, dataset statistics and value choices read the filtered rows in data order, so a viewing sort never changes
them; a committed Sort Rows step does. Equal top-value counts keep the first occurrence in that order in every engine,
and unused categories never count as top values. Value choices break equal counts by ascending label.
Profile and choice labels are the grid's cell text in every engine: datetimes use Python ISO text, single-precision
floats show their shortest round-trip digits, infinities read `Infinity`, and signed zeros share the label `0.0`.
Search matches those labels with ASCII case folding and accepts a space for the date-time `T`. Engines spell each
distinct value once when that is cheaper than spelling rows, grouping before the search in DuckDB and Polars.

Python CSV/TSV readers own whitespace, empty fields and record parsing. Pandas maps only its native `EmptyDataError`
to an empty dataframe; Polars disables the native empty-input exception. DuckDB validates the file and options in its
native reader before a four-byte check adapts a zero-byte or single-UTF-8-BOM file to the existing zero-column plan.
No shared whitespace scan discards native records. Other parse errors retain their normal refusal path.

Every cleaning operation except Custom Code addresses input columns through public `{id, name}` references. The runtime
binds public references against the exact input schema and lineage to private positions before execution. Unknown, stale, repeated where
disallowed, type/name-mismatched, colliding, or private row-identity references fail closed. The current catalog and
parameters are listed in the generated [transformation reference](reference.md#transformation-operations).

Session capabilities explicitly list supported operations. Polars editing sources, DuckDB file editing and native R
support Extract Struct Fields. Polars editing sources and native R support Explode List. Pandas and viewing-only
engines support neither operation. Older capability responses without this list cannot enable either operation.
The [native R contract](#native-r) defines R's finite flat-container types and materialization bounds.

Extract Struct Fields appends 1 to 64 named direct scalar fields from one genuine native Struct. It preserves the
parent, row order, row identities and native child types, including nulls inherited from a missing parent. Field and
output names are exact, unique within their lists, nonempty single-line Unicode of at most 1,024 UTF-8 bytes; dots,
wildcards and regular-expression-shaped names have no special meaning. Outputs must be fresh under the engine's
existing collision rules. Private row-identity prefixes remain forbidden for the source and outputs; a nested child
with a similar name cannot address the hidden top-level identity. Live and generated execution resolve current native
field names and scalar types, including on empty or all-null inputs. In Polars and DuckDB, text, integer, float, Decimal, Boolean, Date,
Datetime, Duration and Binary fields are supported. Child containers, Polars Object, Time and Null fields, and
unrecognized native types are refused. The append uses native expressions and adds no row-growth policy or input scan
for field admission. Ordinary result validation and transport bounds still apply.

Polars Explode List expands one current native List column by one level, preserving its exact child dtype and
source-row/child order. Sibling values repeat, and empty or null outer lists each keep one row with a null child value. Inner empty
lists and Struct children retain their native values. Fixed-size Array, text and Object columns are refused;
Object leaves inside the selected List's nested List, Array or Struct dtype are also refused before collection.
The live owner removes the inherited private row identity, and Session assigns fresh identities in the step's
namespace. The diff reports the original rows removed and the expanded rows added. Visible column lineage is retained.
The shared helper used by generated code preserves all caller columns
and rechecks the selected column's current dtype.

Lazy input is collected once within the Explode helper. The helper counts `max(list length, 1)` for each retained
row using UInt64 arithmetic and refuses output above 2,147,483,647 rows before constructing the expansion. This is
an output-capacity ceiling, not a memory bound; admission itself must retain the complete input. Eager input returns
an eager result. Lazy input returns lazy expansion over the retained frame, allowing later reads to project and slice
the output without rereading that input. Counts, pages and exports may each execute expansion again. A later Select
Columns step cannot prune the original admission scan. Preview retains the draft and Apply promotes it; replay can
evaluate earlier steps again. These rules do not promise one source evaluation for an entire Session request.

By Example date synthesis uses Python's current locale. Before live execution or code generation, Polars and DuckDB
check programs containing full or abbreviated month names (`%B` or `%b`) against every retained example using their
native date expression. A mismatch refuses the operation before draft publication. The check evaluates only the
bounded examples, never the source dataframe; DuckDB shares one owned connection across these checks when compiling
a plan. Successful generated programs retain their native expressions without embedding examples or changing locale.
Agreement on the examples does not establish the intended language for other rows, so users must still inspect Preview.

Conditional Column binds one source reference and its exact semantic type, then appends one fresh Text or Boolean
column without changing source columns or rows. Matching, nonmatching and missing results are required scalar values
of the declared output type or explicit null. Every result is validated, even when unused or the input is empty.
For ordinary predicates, native null/NaN inputs use the missing result. Nullary predicates (`isNull`, `isNotNull`,
`isNaN`, `isNotNaN`) evaluate every row using their existing distinctions; their missing result is unused.
Text results use the existing 65,536-code-point scalar bound; native R also retains its UTF-8 and aggregate output
bounds. No result-type inference or implicit coercion changes empty text, whitespace, false or null. Generated code
rechecks the actual input type and destination before producing the same declared output type, including empty output.
Saved Conditional Column steps whose values cannot be represented losslessly by the form remain executable but require
recreation to edit. The form does not stringify stored operand objects, change their types or remove line breaks from
saved operands, output names or results.

Generated Python defines one public function, `clean_data(df)`, with its selected imports and helpers local to that
function. DuckDB plans containing Custom Code require `clean_data(df, *, connection)`, where `connection` is the
exact connection that created the input relation. A retained notebook source named `clean_data` instead uses
`clean_data_1`. Preview, inspection and
history regeneration select that name from the same captured source metadata. Files and direct compiler calls keep
the default name. This preserves source bindings that the generated program would otherwise replace; it does not
change ordinary Python lookup when the caller shadows builtins.

Generated Pandas and Polars One-hot and Multi-label code rejects results with no visible columns, matching live
Preview. Empty-row inputs remain valid when a visible column survives. Polars uses the encoded frame directly when
dropping all original columns leaves no base columns, preserving indicator rows without adding private identities.
Pandas maps visible column positions once per One-hot, Drop Missing Rows, Drop Duplicates or Mark Duplicates
transformation and validates each selected reference against that map. One-hot validates each selected column's
output names before constructing its indicators. A refusal can
report the first colliding column; earlier selected columns may already have been evaluated.
Generated Pandas One-hot names use the live scalar formatting, so compiled plans bind to the same output columns.

Live and generated Custom Code share a compiler that places parsed user statements inside a fixed function template.
This preserves string values, comments and valid indentation. Python's parser owns line endings and syntax; user-code
syntax errors retain their original line numbers. Generated programs keep the entered code in a multiline source
literal, escaping backslashes and delimiter quotes. Execution uses fresh globals containing the engine alias,
builtins and the custom function itself. Explicit compiler flags retain postponed annotations independently of the
caller. Each invocation receives fresh globals; ordinary generated helpers remain unavailable there. Preflight counts
source escaping and the emitted helper and calls before full generation, and the complete program retains its
generated-code byte limit.

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
Series normalization, matching live result admission. Polars checks lazy schema metadata before capture and the actual
collected columns before returning the retained lazy result. The shared Custom invocation emitter owns capture,
these checks and their contribution to the generated-code size limit. Typed zero-row results remain valid. A Custom
function may build an empty-column intermediate or add the first column of an empty source, provided its final result
has a column.
Empty plans and zero-column viewing or row operations retain their existing behavior.

Viewing `FilterModel` and `SortRule` remain name-addressed, presentation-only queries. A committed Filter Rows or Sort
Rows step uses a separate transform filter/sort IR whose column operands are stable `{id, name}` references. The two
representations are never inferred from one another by name fallback.
Generated Python Filter Rows checks each referenced filter column's semantic type against its declared type before
evaluation, including filters with no active predicates. Equivalent physical integer types remain compatible.
DuckDB refuses missing filter and embedded-sort columns instead of omitting their rules. DuckDB and Polars also check
current sort comparability; Pandas retains its existing native cleaning-sort behavior. These checks apply to each
step's actual input and do not add automatic schema mapping or change permissive viewing-name handling.

Unsubmitted filter input belongs to its session and selected column ID. If that column disappears, both column
selectors show an unavailable target and retain the input until the user chooses another column or the same ID
returns. Missing-target controls cannot dispatch a predicate, value request or sort. A replacement session resets
this local input even if column names and IDs are reused. Explicit column navigation and same-ID renames retain
their existing behavior.

A locally staged sort order binds each rule to its unique column ID, name and semantic type. Schema changes
permanently retire rules whose owner disappeared, changed or became ineligible, preserving unaffected rule order.
The panel uses the current requested sort order directly when no local difference is staged. An authoritative sort-model
replacement resets local edits; the existing Clear-column action preserves its explicitly staged sibling rules.
The App identifies the current failed viewing request when restoring confirmed sorts. Only that failure preserves
newer staged rules, sort direction and null placement bound to the failed sort. Their bases move back to the confirmed
model; an explicit sort replacement, including a header action selecting those same confirmed sorts, still retires them.
This local reconciliation does not submit a query or change page rollback, Retry or filter history.
Confirmed viewing sorts retain their name/type reconciliation policy.

The Python decoder validates viewing record shapes, list fields and scalar enums before engine dispatch. Native R
also distinguishes JSON objects from arrays before list conversion and validates scalar logic and operators. Its
Filter Rows decoder preserves explicit null logic for rejection. Empty viewing lists and backend-specific operand
semantics remain valid under their existing contracts.

Python viewing operands follow the shared JSON depth and finite-number rules without coercing accepted integers
or opaque containers. Python also requires UTF-8-valid strings and keys for response publication; lone surrogates
are refused before native work even though the shared syntax guard accepts them. The primitive-string limit applies
only at the operand root, and request framing retains its existing byte bound.

Confirmed viewing-filter history preserves admitted operand objects and their own keys. History entries, Undo
targets and outgoing filter requests hold independent copies; Undo retains the current viewing sorts. JSON operand
objects keep their serialized shape rather than becoming lookup Maps.
A sort-only request can supersede pending filter Undo while retaining its target. A newer request with different
filters instead records an ordinary transition from the prior confirmed filters if it succeeds. Failure preserves
those filters and their history; a superseded Undo response cannot consume a history entry.

Viewing models may contain multiple filter entries for the same column. Individual value, flag and predicate edits
replace only their originating entry; the panel builder edits the first active entry or appends one when absent.
Other entries, global logic and sorts remain unchanged. Column Clear removes the whole same-name group. Filter lists
render each entry separately and count distinct filtered column names.

Native filter-removal actions carry their originating session and an immutable signature of the complete active
same-name filter group. The host checks that target before dispatch, and the renderer checks it against its current
desired filters before removal, including while a newer page request is pending. Unrelated filters and sorts do not
invalidate the target. Saved filters remain removable without a current schema column; identical restored groups
remain valid. The internal command rejects unbound column strings.

Polars Decimal and temporal filters adjust scalar comparison thresholds to the source scale without rounding the
requested boundary or converting source columns. Decimal coefficient and exponent handling is bounded by native
precision before integer construction. Membership omits operands that cannot equal a stored value. Pandas native
datetime and duration arrays apply that same membership rule before their existing timezone-aware comparison.
Each engine shares its scalar preparation between live filters and generated code; existing null flags remain separate.

Polars Enum equality compares text labels without casting an unknown label into the closed category domain.
An absent label matches no rows; inequality retains present rows. Selected-value filters omit labels outside that
domain and retain their explicit null flags. Source columns and ordered comparisons keep the declared Enum ordering.
In-range integer predicate operands and wholly valid integer selections resolve through the declared category labels,
avoiding deprecated numeric casts in live and generated filters. Membership preserves native Series inference first.
Other operands retain native cast behavior, including version-dependent refusals; source columns are not converted.

Pandas object duration counts and present-value filters share exact integer comparison keys, measured in attoseconds.
The existing unit registry supplies fixed NumPy scales and multipliers; source scalars and dtype remain unchanged.
The shared object classifier retains the duration type when missing scalars make native inference ambiguous.
Value counts restore the first original spelling through the existing representative map. Filtering prepares keys
once per selected column and compares every predicate against that preparation in live and generated code; missing
masks still inspect the original source. Native duration storage and pure Python/custom-only object columns retain
their existing paths. Mixed ordinary NumPy/Pandas duration columns refuse calendar/unitless or custom residents
whose comparison semantics cannot share those keys. Homogeneous NumPy and Pandas inputs retain native ticks in their
stored unit before scaling; mixed inputs preserve each scalar's stored unit.

Pandas duration membership on native NumPy or Arrow categorical columns constructs exact operands in the category's
stored unit and positive multiplier before native `isin`, in live and generated code. Zero-unit categories refuse
nonempty duration membership; empty selections and null switches remain available. Nonintegral and out-of-range
operands cannot match. NumPy's reserved NaT tick is excluded; Arrow's minimum int64 tick remains a present value. Category
values, ordering and codes remain unchanged. Other operand types and nonmembership predicates keep their native
paths, and the duration decoder retains its Python timedelta range and microsecond precision limits.

Sparse duration membership reuses that exact operand preparation for positive `s`, `ms`, `us` and `ns` unit
multipliers. Scalar preparation for pages, profiles, choices, membership and export rejects zero-unit Sparse storage
and actually used, nonmissing fills that cannot be represented exactly in their stored unit. It uses the existing
fixed-unit ratios, signed int64 range and NaT exclusion, without scanning rows or inspecting unused fills. Exact fills
use a temporary native SparseArray and Series sharing the stored values and sparse index. Pandas fills retain their
native ticks; Python timedelta components are read once through integer-index conversion before rational arithmetic.
Canonical native fills can change gap spelling while preserving physical values and selection tokens.
Live and generated code share this boundary; other operations retain their native limitations. Profiles, value choices
and nonempty membership conservatively refuse finer, calendar or unitless Sparse durations and multiplied coarse units.
Ordinary `W`, `D`, `h` and `m` storage retains its native paths.
Empty selections and null-only filters retain native behavior where the selected representation permits it. Fine-unit
page behavior remains native, including supported empty and all-missing pages.

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
native signed/unsigned 128-bit literal capacity. R requires an exactly representable ordinary numeric scalar. Its
shared finite parser supplies the candidate value, and a bounded binary64-to-integer comparison checks the retained
text before binding. This does not add an integer64 scalar type. Native arithmetic promotion and output limits still apply.
Legacy numeric plans retain their replay behavior. If an earlier numeric representation lost digits, the original
literal must be entered again; its original spelling cannot be reconstructed from the saved number.

Min-max Scale computes exact integer and decimal offsets before converting them to double-precision ratios.
Float32 and float64 ranges that overflow on subtraction use wider or scaled operands; ordinary ranges retain their
precision, including subnormal values. Live execution and standalone generated code use equivalent arithmetic in
the owning engine. Pandas and Polars each share one helper between live execution and generated programs.

Python linear interpolation preserves equal finite nonzero anchors after validating the coordinate weight.
At a binary64 weight of exactly one half, two zero or subnormal double anchors use their exact sum before the
final division. Other unequal anchor pairs retain the convex weighted expression; arbitrary floating
interpolation is not guaranteed to round exactly. Missing-value eligibility, coordinate checks and gap limits still apply.

Round accepts finite integer decimal precision, including negative values for rounding to tens and larger units.
Python engines round exact integers and Decimal values before floating conversion, using half-even ties. Ordinary
floating and text coercion keep their existing behavior. Precision outside a storage type's useful range produces the
corresponding unchanged value or signed zero without constructing an unbounded scale. Intermediate scaling must not
overflow a representable result or wrap an integer. Live and generated code preserve missing and non-finite values;
a floating result that exceeds its output type becomes signed infinity.

Pandas may retain large exact integers in object storage. Polars and DuckDB retain native numeric storage, widening
or reducing fractional scale when needed for a carry. Arrow Decimals keep their original dtype when possible;
otherwise they use the smallest compatible native width and scale. A nonnegative source scale stays nonnegative so
rounding does not remove existing Parquet export support. Results that need Decimal-to-Python conversion must stay
within Arrow's binding range; native coarse zeroing need not box logical values.
Polars, DuckDB and Arrow Decimal results beyond usable native capacity are rejected without a floating or object
fallback. Object Decimal arithmetic uses its own precision context and preserves the caller's.
Pandas checks stored Arrow values before taking its metadata-based zero shortcut. Decimal32/64 use native validation;
Decimal128/256 use native extrema viewed as zero-scale coefficients, converting only those two bounds to Python.
Understated precision therefore leads to exact rounding or an explicit refusal instead of an incorrect zero.
The coefficient check also preserves native zeroing at negative scales outside Arrow's logical-value formatting range.
Standalone generated code applies the same checks.
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
Decimal context. Polars Round uses one normal Python helper module for live execution and emits its source into
standalone generated programs. The physical coefficient mapping, also used by Min-max Scale, is
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

Convert Type accepts an optional `inputFormat` for a Datetime target: `DD/MM/YYYY`, `MM/DD/YYYY` or `YYYY-MM-DD`.
Across the editing engines, the option requires native text input and exact ten-character ASCII dates with positive
four-digit years. Invalid dates, extra text and values beyond native capacity become missing. Valid dates become
timezone-naive midnight in Python engines and UTC midnight in R. Historical range can differ by engine, version and
platform. Categorical/factor columns require conversion to Text first. Pandas admits StringDtype, Arrow string and
large-string storage, and object columns containing only text and missing values. Other physical types, including
fixed-width bytes and Arrow string-view storage, are refused. Live and generated code check the current input type,
including empty or all-missing columns. Omitting the option retains the engine's default conversion rules.

### Pandas

Pandas executes viewing, its supported cleaning operations, profiling, generated code and exports in Pandas.
Viewing filters and sorts compose row positions into a row view. Pages take only their rows and columns, statistics
that ignore row order read the selected rows in source order, and other reads materialize the view once. Arrow text
columns are combined into one chunk when a file opens. Text predicates evaluate each distinct value once, and text
sorts rank the dictionary instead of comparing every row.
Duplicate and non-string labels are addressed positionally after binding. Object-dtype cells are recursively isolated
before trusted custom code, preview, rollback, or generated-code execution so nested user objects cannot mutate the
source. Typed null, NaN, decimal, datetime, and wide-integer behavior is normalized at the protocol boundary.

Pandas literal Split limits tokenization to the selected field or requested output count in live and generated code.
It preserves the selected index, empty fields and null results, discarding one possible remainder.
The remainder can still contain a large tail; input conversion, copied source columns and outputs retain their existing costs.

Native NumPy int64 profile sums reuse the existing conservative overflow bound before summing without Python-value
boxing; unproven integer cases retain exact widening. Built-in nullable integer, Boolean and string arrays use native
missing masks in live and generated operations. Only float columns hold NaN values: StringDtype NaN sentinels,
missing category codes and NaN in object columns that do not infer as floating are null. Custom Series
and extension arrays retain scalar classification; nullable and Arrow floats retain separate valid NaN and null values.
Pandas reads Parquet float nulls into NumPy floats as NaN, so those columns report NaN where Polars and DuckDB
report null; the missing total is the same.
Ordinary object Series use exhaustive native inference to recognize strings with
no missing values, skipping scalar missing counts and numeric-key normalization. Mixed or missing object values and
Series subclasses retain their existing classification. Generated comparison keys use the same string admission.

Integer profiles retain exact extrema and sums when floating-point approximations overflow. Each approximate statistic
is attempted independently; unavailable statistics and histograms are omitted. Native value counting remains first.
If Pandas cannot build its count index for object-stored ordinary Python integers, native factorization supplies exact
counts with an object index; requested descending counts keep first-encounter ties. Successful native counts retain
their existing ordering. This repair does not change stored values or admit custom integer subclasses.

When native counting infers a temporal index from an object column, profiles and value choices refuse present,
nonzero NumPy temporal scalars with unit multipliers or picosecond, femtosecond or attosecond units. Successful
nanosecond-duration counts are exempt. This conservative representation policy prevents legacy Pandas from
publishing narrowed labels and selection tokens; it also excludes exact values such as `datetime64[1000ps]`.
Calendar and unitless NumPy durations are also refused when the inferred index would give them a fixed unit,
including zero-valued durations. NaT and successful fixed-unit zero values retain native results and ordering.
Native count failures remain failures.
Only object inputs whose count index became temporal enter the guard. Its existing scan admits restoring columns
containing only built-in Python timedeltas and missing values to Python timedelta count labels. Restoration allocates
Python values and an object index proportional to the distinct keys, which can include every row, without another
source scan. Profiles and choices retain source spelling, native counts and selection keys; row-text search still
runs before counting. Custom duration subclasses retain their native labels.
Current Pandas counts that retain an object index and native temporal columns bypass it. For these object columns,
search and viewing filters narrow the input before counting; refusal leaves paging, source data and session revision intact.

Value-choice ranking retains the leading `limit + 1` labeled candidates and the current input, instead of the full
label collection. Native counting and ordinary text search remain exhaustive over their inputs. All distinct labels
are evaluated before publication, so a late formatting failure still refuses the entire request.

Native NumPy `timedelta64` columns, categories with that native dtype, and dictionary strings search the counted labels.
Unused categories are dropped after the search, so they never fill search results.
Duration search uses the same scalar labels published in choices, including whole-day clocks and values outside the
nanosecond range. It retains the full native distinct-count state before searching, without a full-source label array.
Arrow-backed duration categories also search their counted display labels and native text for observed categories.
Raw aliases preserve original positive matches. A nonempty search uses
a mask across native category counts, then takes and formats only observed category values. Strings and the positional
lookup grow with observed categories, without expanding strings to every row or bounding them by the requested limit.
Unsearched choices skip this allocation. Non-text missing entries are not aliases; corrected display labels remain searchable.
Direct and dictionary-encoded Arrow duration columns search counted display labels and native raw text after the
existing dictionary decode. This preserves the corrected label for a valid minimum tick without accepting its
misleading native `NaT` spelling. Native counts and raw text grow with all distinct values before filtering, even for
an absent query; unsearched choices skip raw-text allocation. Supported Sparse durations also search counted labels.
Multiplied Sparse search retains native clock aliases from the distinct-count index, allocating strings proportional
to distinct values only for searched choices. Ordinary whole-day Sparse labels need no alias array. Count-first search
retains full native counts even for selective or absent queries. Object durations keep their row-text search behavior.
Multiplied fixed-unit Sparse pages and simple Sparse index labels iterate native NumPy values from the bounded slice;
supported count indexes use the same output owner. Source storage, fills and indexes remain unchanged.
Categorical timestamp and duration output reads stored values through category codes, preserving Arrow validity and
NumPy duration multipliers. Temporal-category null masks use missing codes, so valid Arrow extrema remain present.
Directional Fill repeats the native categorical anchor rather than assigning a boxed scalar that can change its value.

Datetime cells and nested values share one formatter. Pandas Timestamp nanoseconds are inserted into the time
fraction while preserving the complete native offset, including offset seconds. Profile and value-choice labels
reuse this formatter. Native datetime columns format the counted values with one vectorized wall-time pass; other
scalar labels retain native string conversion.
Other searches retain original per-row text matches and filter before counting, correcting affected timestamp and
present temporal-extremum text. Datetime searches also recognize a space in place of the ISO `T` separator and the midnight
clock omitted from native four-digit-year date-only text. These aliases use one transient string at a time without
converting values or changing precision. Their additional scan runs only when the search can match an added space
or midnight clock.
Numeric and dedicated string dtypes bypass the temporal search scan. Ordinary datetime objects retain their native formatting.

Native Arrow date32 and date64 columns retain date semantics for schemas, profiles, value selections and sorting,
including when loaded from Parquet.

Parquet reads repair nullable integer index levels and integer data that ordinary Pandas decoding would convert to
floating storage. Object columns containing integer children in lists, structs or maps use native Arrow arrays;
Struct columns containing nanosecond timestamps through Struct or List children also retain native Arrow storage,
including LargeList and fixed-size List children. Other data columns retain ordinary Pandas decoding. This prevents
ordinary Struct decoding from turning timestamp children into integers. Data and index repair share one supplemental projection through
the same open file. Its field names, physical types, row count and source fingerprint are checked before publication.
A changed source is refused; this guard does not persist beyond the read.

Profiles and duplicate comparisons use temporary exact Python values for these Arrow containers because native
Arrow lacks their count and duplicate kernels. Live and generated comparisons share that conversion policy;
stored arrays and export types remain unchanged. Temporary keys box the complete selected columns; large nested
payloads can substantially increase profiling time and memory. No comparison keys persist between requests.

For timestamp-containing Structs, output and comparison preparation refuses present minimum nanosecond timestamps
or durations that Python boxing would turn into `NaT`, including Map siblings. Native field and list kernels respect
parent validity and skip unrelated child types. Map inspection uses a List view of the same native buffers; it does
not widen import admission to Map-only timestamps. Page checks follow row and column projection; comparisons and text operations inspect their
selected operands. Live and generated text operations share a guarded string-conversion owner. CSV checks precede
writer opening; native Clone and Parquet export retain the stored types and ticks without this boxing restriction.
Other native boxing limits, including timezone-dependent endpoint overflow, retain their errors.

Dataset statistics reuse per-column missing counts for the total, including Sparse columns, without a second
aggregate scan. Duplicate counting tries the native path first. Its specific unhashable-value TypeErrors for list,
dict, set or NumPy-array values leave only the multi-column duplicate count unavailable; other failures propagate.
Ordinary object columns need no additional validation scan. Cleaning operations retain their separate rules.

Native Arrow `bool8` and UUID Parquet fields reopen as logical booleans and canonical strings. Only their canonical
unsupported Pandas dtype metadata is adapted; unrelated invalid metadata retains native refusal. Their schema, data
and supplemental index reads use the same descriptor and source-fingerprint guard described above.

Scalar Arrow dictionaries expose their logical value type while retaining the physical dtype in schema metadata.
Profiles and query keys use logical values, including null dictionary entries and repeated values across chunks.
Schema nullability checks native validity masks and referenced codebook entries without decoding value payloads.
String keys share decoded dictionary entries rather than expanding the text payload once per row. Row selection
retains encoded columns; it may normalize codebooks or widen their index type when native chunk unification requires
it. Source arrays remain unchanged.

Native Arrow `bool8` and UUID columns expose logical booleans and canonical strings for pages, queries, profiles
and selected cleaning operands; arbitrary Arrow extensions do not gain this conversion. Object-dtype UUIDs use
canonical text for queries, derived cleaning values and export while preserving other objects and missing
representations. UUID-specific inspection is limited to ambiguous object columns, and replacement arrays are
allocated only when UUID conversion is needed. Query results select original physical rows; row selection, unchanged
Fill targets and direct copies retain native storage.

Numeric, text, Convert Type and pivot operations prepare only selected dictionary operands under the existing
native conversion, arithmetic and output limits. Unrelated columns retain encoded storage. Page scalar and temporal
context is prepared after row and column projection; dictionary scalar iteration is bounded by the requested page.

Integer filters compare within the native storage range and handle out-of-range operands without floating conversion.
Sorting, duplicate detection and directional Fill share exact temporary row keys. Nullable Arrow integer, timestamp
and duration comparisons retain exact values, including nanosecond differences; temporal keys use integer storage
so present extrema remain distinct from nulls. Dataset duplicate counts use the same keys for these values and for
single-column Sparse integers. The keys preserve value ordering. Row selection takes Sparse integer and duration
columns positionally without fill-aware reindexing, retaining nonempty storage units, values and fill conventions,
including columns outside the query. Empty results keep native dtype conventions. Native indexes and other retained columns keep their native
representation, subject to the dictionary chunk-unification behavior above.

Arrow timestamp and duration null masks use native validity, including logical null entries in dictionaries.
Their NaN masks are false without boxing temporal scalars. Arrow duration filters compare integer storage against
exactly scaled portable operands, using divisibility and directed bounds instead of converting source units.
Live and generated filters share this behavior; source values and validity remain unchanged.
Pages, value choices and profile labels retain native context for present temporal extrema that Pandas boxes as `NaT`.
Page row labels use native companions from the requested index slice to recover those same present values.
Only valid values boxed as `NaT`, `NA` or `None` are replaced before the existing bounded label formatter; ordinary scalar and tuple
labels, categorical null spelling, row IDs and source index storage remain unchanged.
Duration output reads native ticks before Pandas can overflow during boxing. Page conversion is limited to the
projection and row slice; profile conversion follows the top-ten count limit. Choice ranking formats native count
labels while retaining only the bounded candidates and their original positions for token validation.
Dictionary durations in seconds, milliseconds and microseconds retain Python timedelta spelling where its range
permits it. Nanosecond labels stay unchanged; wider values retain native duration text and the existing selection range limit.
Profile extrema use native aggregation. Supported Fill methods retain native temporal donors and directional
anchors in live and generated code without changing source arrays.
Using the minimum nanosecond timestamp as a filter value remains unsupported under the existing microsecond input precision.

Pandas Convert Type and Format Datetime keep already typed Arrow dates and timestamps out of text parsing.
Converting a timestamp to datetime retains its exact unit, timezone and validity; dates convert natively to seconds
or milliseconds. Converting to date preserves the local calendar day. It floors integer ticks to seconds before
timezone conversion and checks date32 capacity, so timezone shifts and narrowing cannot wrap extreme dates.
Format Datetime uses Pandas/Python strftime syntax, including six-digit `%f` and seconds-only `%S`. Formatting floors
nanoseconds to microseconds, retaining dates before the epoch and the present minimum nanosecond timestamp.
Named Arrow timezones use standard-library ZoneInfo; fixed offsets use Pandas' existing timezone handling.
Unrepresentable typed values refuse the transformation. Text inputs retain the existing coercion of invalid dates
to missing. Live execution and standalone generated code share this preparation and preserve source values.

Directional Fill shares its complete-run, donor and assignment algorithm between live execution and standalone
generated code. Linear Fill likewise shares its ordered-gap and coordinate-weight arithmetic. Target, coordinate
and missing-value preparation remain with the engine, along with dtype and original row-order restoration.

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

Arrow-backed Formula preserves the values and types of successful native operations and earlier repairs, including
empty and all-null results. Integer repairs accept 8-64-bit native NumPy, built-in Pandas nullable or Arrow integer
columns; Sparse and arbitrary extension types are excluded.
Live execution and generated code use one repair implementation, called only after native arithmetic fails.
The generated repair stays local to the Formula result helper so it adds no notebook-global binding.

After native column-to-column power reports a capacity error, eligible signed integer bases and signed or
8-32-bit unsigned integer exponents widen to Int64 for checked native power. At least one operand must be
Arrow-backed. If checked Int64 power fails, safe UInt64 casts of those prepared operands may produce a checked
UInt64 result. The additional path requires nonnegative values throughout both selected columns, including values
paired with the other operand's null; it does not take magnitudes or infer per-row signs. Preparation failures,
negative exponents and remaining overflows retain the original refusal. UInt64 exponent columns retain their
existing repair path. Only selected operands and results gain temporary storage; the UInt64 attempt adds two native
casts and one checked power, with no extrema scan.

After native power fails, a signed Arrow integer column and an exact positive scalar exponent below 2^64 can use
checked UInt64 power. Even exponents take checked magnitudes after widening to Int64; odd exponents require
nonnegative values through a safe unsigned cast. These repaired results must fit UInt64. If that attempt also fails
for an odd exponent from 2^63+1 through 2^64-1, one native min/max scan may admit a column containing only -1, 0, 1
and null, with at least one -1. Those values are unchanged by the power and return as Int64. Other failed domains
retain the original refusal.
The added power path scans only the selected column and uses no per-row Python arithmetic.
Other exponent and operand families keep their existing paths.

After native subtraction fails, eligible integer operands use an exact Decimal128 intermediate. Integer literals
on this path range from Int64 minimum to UInt64 maximum. The result returns as UInt64 if it fits, otherwise Int64.
If neither type holds the complete result, temporary buffers are released and untouched operands continue through
the existing repair path so its refusal remains authoritative. The attempt allocates temporary Decimal buffers even
for some previously successful UInt64 repairs; successful initial native operations need no added conversion.

Remaining UInt64 add, subtract, multiply and power repairs may use exact UInt64 literals or convert nonnegative
signed companion columns in either column order.

The remaining UInt64-left add and subtract repairs accept negative integer literals of magnitude at most UInt64
maximum and signed columns of any sign. Addition allows either column order. These results must fit UInt64; nulls
remain null, and intermediates cannot overflow when the requested result fits. Signed 64-bit minimum remains
supported. Mixed-sign columns require two checked operations; other repairs require one.

After existing native and eligible repairs fail, signed integer addition may use an exact native Decimal128
intermediate; fixed-width integer multiplication uses Decimal256. Both require at least one Arrow column and return
Int64 if the complete result fits, or UInt64 otherwise. The added addition path accepts signed 8-64-bit columns and
an eligible signed companion column or exact Int64-range literal. Multiplication retains its signed/unsigned operand
rules. True overflow and columns needing both negative results and values above Int64 maximum retain the original
refusal. Only selected operands gain temporary storage. Boolean, Sparse, arbitrary extension, floating and Decimal
operands remain on their existing paths.

Selected Decimal128 operands may widen to Decimal256 for add, subtract, multiply and divide, retaining each operand's
precision and scale. Native arithmetic determines the result type.

When native multiplication refuses two Decimal128 `(38, 38)` columns, Formula returns exact Decimal256 `(76, 76)`
products. Either null operand produces null; empty inputs retain the output type. Source values, indexes and row order
are preserved. This path adds temporary Decimal256 buffers, positional row identifiers and two aggregate entries per
row. It does not extend other Decimal precision, scale or input-width combinations. The
[operation-edge tests](../python/tests/test_operation_edges.py) check live and generated results.

After a Decimal256 capacity failure, adding or subtracting the exact integer literal 0, or multiplying or dividing
by 1, preserves the column's values. Multiplication and division by -1 use native checked negation. These repairs also
accept native TypeError refusals for negative-scale
Decimal256 operands whose full declared capacity cannot fit the 76-digit scale-zero intermediate described below.
All retain the declared precision, scale and nulls. The identity result wraps the unchanged immutable Arrow storage
in an independent Pandas array, so assigning to the result cannot change the source. Live and generated Formula apply
the same policy; By Example remains unchanged.

After native add, subtract, multiply or divide fails on a selected negative-scale Arrow Decimal operand `(p, s)`,
Formula may rescale that operand exactly to Decimal256 `(p-s, 0)` when its full declared capacity fits 76 digits.
The other operand must be an Arrow Decimal column, an exact integer literal, or an eligible native/nullable
integer column of at most 64 bits. Object and custom extension companions do not enter this repair.
Only selected negative-scale operands gain temporary storage; source arrays and nulls remain unchanged.
Native arithmetic then determines the output precision, scale and division rounding, and still refuses results
outside its inferred capacity, including empty or all-null inputs. The new result need not retain the source's
negative scale. TypeError admission is limited to this rescaling and the exact Decimal256 scalar repairs above;
other operand errors retain their previous paths.
Other powers and Decimal capacity refusals retain their existing native behavior and the explicit repairs above.

Convert Type's integer target is nullable signed 64-bit storage. Unsigned or floating values outside that range and
present infinities are rejected before conversion; failed previews or applies preserve the confirmed session state.
Fill reads selected dictionary targets, donors and keys as logical values. Filled targets use native logical storage;
targets with no filled cells and unrelated encoded columns retain their dictionary representation. Decimal capacity
and timezone checks still apply to replacement literals when the target has no missing cells.
CSV and Parquet export prepare logical scalar dictionary, `bool8` and UUID columns in a temporary frame. Preserved
index levels use the same logical values; changed MultiIndex levels are rebuilt from actual row labels so equivalent
values coalesce. Parquet omits an unrequested index before native dtype inspection. Source arrays, index levels and
codes remain unchanged. Exported `bool8` and UUID fields use Boolean and string storage respectively.
CSV export prepares affected Arrow timestamps and durations as native string chunks, boxing at most 64,000 values
at a time. This preserves nanosecond timestamp endpoints, duration ticks and historical timezone offsets through
the native writer. Temporal categories with missing codes use the same text preparation; preserved index levels inspect only
used labels. Retained text storage grows with the affected values or categories. Arrow timestamps stored in seconds,
milliseconds or microseconds require UTC and local calendar years 1 through 9999; unsupported values are refused
before opening the writer. Empty exports and omitted indexes do not inspect unused temporal values. Parquet keeps
its native temporal storage and capacity limits. Timezone names outside Arrow's namespace use the timezone accepted
by Pandas, with exact UTC conversion for affected calendar boundaries.
CSV export refuses nonempty Pandas frames containing exported Sparse duration columns or preserved index levels with
unit multipliers, because native writing can change their physical values. Refusal precedes writer opening and preserves
the reserved destination. Empty positive-multiplier exports and omitted indexes retain their existing behavior; no
full-column conversion or alternate serializer is used.
Pandas Parquet export converts logical negative-scale Arrow Decimal columns and preserved index levels to exact
scale-zero Decimal128 or Decimal256 storage. The source keeps its arrays, index and attributes; the existing reader
reopens logical Decimal values as object storage. Scales below -76 are refused. Decimal32/64 require a declared
whole-digit range (`precision - scale`) of at most 76. Wider declared ranges are accepted for Decimal128/256 when
actual values fit the selected output precision, capped at 76 digits. Negative-scale Pandas Categorical storage remains unsupported.
Preparation validates affected native arrays and checks Decimal128/256 extrema before rescaling, since Arrow's safe
cast and full validation alone can miss overflow. Only the two extrema are widened at the same scale and boxed for
exact comparison; column conversion stays native. Preserved MultiIndexes inspect only used affected labels and use
the existing reconstruction. Omitted indexes and unrelated types gain no additional value scan. Refusals precede writer opening;
CSV and nonnegative-scale Decimal storage retain their existing behavior.
Group By treats input NaN as missing while retaining NaN computed from present aggregate operands. Group By, Pivot
and grouped Fill use the same missing-value and signed-zero equality for Arrow float32/float64 keys. Integer group
keys use native factorization codes and restore exact scalar labels; Sparse fill values retain native equality,
including fractional fills accepted by the minimum Pandas version. Sparse Count uses a temporary presence mask
for that aggregation alone; keys, source storage and other aggregates retain their own behavior.
Group By sums keep native NumPy int64 accumulation when a whole-column bound proves every group and intermediate
sum fits signed 64-bit storage. Empty int64 columns need no reductions. Other integer storage and inputs outside
that sufficient bound retain exact widening; output normalization is unchanged. Live and generated code share
the same admission helper.

Pandas Pivot Wider shares object identifier classification, names-domain validation, grouping, first-row restoration
and output assembly between live execution and standalone generated code. Apply reuses the identifier frame and key
states prepared by its own validation; separate preflight remains independent, and preparation does not persist between calls.
Prepared Arrow identifiers retain native validity, including present timestamp and duration values at the minimum
int64 tick. Floating identifiers retain the existing NaN, null and signed-zero normalization.
Object classification uses native inference first and refines ambiguous values with
the existing missing-value rules. Mixed scalar identifiers retain their native representatives; homogeneous lists and
structs remain refused. Categories, nullable integer storage, Boolean storage and the existing object fallback follow
the same allocation policy. Live and generated callers retain their own identifier admission and validation errors.
Generated integer helpers use the same `numbers.Integral` admission as live execution, excluding Boolean values and
actual NumPy duration instances, so integral object keys retain the same values and dtypes as live execution
without interpreting their class names as temporal types.
Shared cell normalization and Pandas operations recognize genuine Pandas `NA`/`NaT` by identity and genuine NumPy
datetime/duration `NaT` through native `isnat`. A matching class name does not make a value missing. Object-column null
counts, filters, fill donors and type inference use this same scalar rule. Generated Pandas queries and nullable-result
helpers share one null predicate. The shared boundary consults already-loaded Pandas and NumPy modules without
importing them for other engines; generated Pandas code uses its existing module bindings. NumPy scalar and temporal
handling checks actual native types;
Pandas `Timedelta` subclasses retain their stored unit through the native NumPy scalar, including values outside the
nanosecond range, while ordinary Python timedeltas keep their own value. None,
floating NaN, Decimal NaN and Arrow temporal validity retain their separate existing rules.
Missing masks for ordinary NumPy-backed Pandas Series use native array operations for integer, Boolean, float and
temporal storage. Live and generated masks keep floating NaN separate from temporal NaT. Profile and header counts
use the same native classifications, independent of the legacy `mode.use_inf_as_na` option. Existing object, extension
and subclass fallbacks retain their behavior. Header counts reuse each column mask for its total and positional row
aggregation, without retaining a full-frame Boolean matrix.
Grouped-key restoration uses the same native primitive for its floating-NaN mask. Its separate float-only policy excludes
Decimal NaN; live and generated code share that helper while preserving existing nonnative fallbacks.

### Polars

Fresh live notebook LazyFrames are collected once into a native DataFrame after namespace and column-addressability
validation, before row IDs are assigned. The actual collected schema is validated again because native callbacks can
disable their output-schema checks. A LazyFrame over that retained result preserves the native lazy type while
pages, projections, profiles and cleaning steps read the same rows. Cloned sessions share the retained source without
re-evaluating the caller's query. Eager notebook inputs keep their existing identity, ordinary file sources keep their
native lazy scans, and saved notebook MIME capture keeps its separate bounded query path.

Capture uses `pl.collect_all` with `engine="in-memory"`, including on minimum Polars under caller-configured streaming.
It evaluates and retains every result column and row; page and transport limits do not bound that work or memory.
Subsequent projection cannot avoid the original full capture. Native dtypes and Python Object references are preserved;
mutable Python objects are not deep-copied or protected from caller mutation.

Column references bind literal names, including `*` and names that resemble anchored regular expressions.
The native selection owner checks those names against the current input schema before constructing an exact
expression or immediate ordered selector. Ordinary names retain their existing native path. Generated selectors
resolve names against the input at that step; missing names refuse and existing operation-specific checks remain.
Internal lazy top-value payloads use a fixed value-field name; they retain the public column identity separately.
These rules do not change selectors written by the user in Custom Code.

Pages bound selected top-level `String` values to 65,537 Unicode code points before Python row boxing, on the
already projected and sliced resident frame. Values within the 65,536-code-point text limit remain exact; the extra
code point preserves the existing live-page and saved-notebook refusal for oversized text. When the installed Polars
provides native `bin.slice`, the same expression batch bounds selected top-level `Binary` values to 49,153 bytes.
Binary values within 49,152 bytes remain exact; one overflow byte preserves the existing base64 text-limit refusal.
Older supported Polars without this API still boxes and base64-encodes complete binary values before refusal.
These expressions add no source scan and run only for applicable selected columns. They do not bound native source
memory, aggregate page allocation or nested values.

Native Datetime and Duration columns retain their precision in pages, value choices and profile labels. Pages format
only the projected, sliced result after its source collection. Choice search and tie ordering use native temporal
text; exact ticks and labels are retained only for the limited choices. Profile labels are formatted after counting
or extrema aggregation, including the already collected lazy top-ten payload. These transformations add bounded
resident-frame work without another source scan or conversion through another dataframe engine.

Datetime cells and labels use Python ISO text with exact offset seconds: whole seconds omit the fraction, and other
values show six digits, or nine when nanoseconds remain. This does not replace native timezone offsets with Python's
timezone data. Duration text uses Polars' signed-unit format, including at the Int64 minimum. Datetime value search
accepts either `T` or a space between the date and time, and preserves searches for padded fractions such as `.123000`.
The shared duration raw conversion and typed-cell selection decoder retain the
existing microsecond filter precision and minute-offset limit: unsupported values remain visible but refuse
selection. Date columns retain their existing behavior.

List, Array and Struct output also prepares Datetime and Duration leaves before Python boxing, preserving their
precision and null structure. Original dtype metadata directs decoding; source arrays and native grouping are unchanged.
Array output temporarily uses a List expression to support the minimum Polars version. Only affected branches are
transformed, after the page slice or bounded profile aggregation. Work within each returned container grows with its
child values. Struct levels with selector-like temporal field names use temporary native field names during formatting,
then restore the original names and order while preserving parent nulls. This leaves source schemas unchanged.
Eager output consolidates affected container Series before expression evaluation, avoiding per-row
dispatch in minimum Polars. This can copy ordinary siblings within an affected Struct; lazy profile expressions keep
their existing aggregation path. Complex-value selection and comparisons remain unavailable; native List value-choice casting can still refuse.

CSV export retains native Necessary quoting, which preserves null and empty-string distinctions. Native primitive
formatters do not escape arbitrary delimiter or quote characters, so eager and lazy exports check the retained schema
after removing the private row identity. Either syntax character is refused when it occurs in the column type's
possible native output alphabet:

| Column type                    | Refused delimiter or quote characters |
| ------------------------------ | ------------------------------------- |
| Signed integer                 | `-0123456789`                         |
| Unsigned integer               | `0123456789`                          |
| Floating point                 | `-+.0123456789einfNaN`                |
| Decimal                        | `-.0123456789`                        |
| Boolean                        | characters in `truefalse`             |
| Date                           | `-+0123456789`                        |
| Time                           | `:.0123456789`                        |
| Datetime, including time zones | `-+T:.0123456789`                     |

This conservative type restriction also applies to zero-row, typed all-null and otherwise non-conflicting values.
It resolves schema metadata without scanning rows or executing a lazy plan, and refuses before opening or truncating
the export writer. Comma, tab, semicolon and pipe with ordinary quotes remain available. Null, String, Categorical
and Enum columns retain custom syntax through native escaping. Other unsupported CSV types retain their existing
native refusal. Export adds no numeric or temporal conversion and does not change caller formatting options.

Profiles and value choices keep temporary count fields distinct from the selected source field. Supported source
names remain valid in eager and lazy frames, independently of which columns a profile request selects.

Integer Group By sums return zero groups for empty input, with Int128 output in live and generated code.
A nonempty all-null group has sum zero; empty integer profiles also retain their exact zero sum.

Pivot Longer compares exact selected-column dtypes from the schema during preflight, live execution and generated
execution. Category mapping identity and Enum order must match. Compatibility checks use schema metadata;
row-count bounds and result validation retain their existing execution paths.
Pivot Wider without identifiers groups by the validated names column's presence. This preserves source
cardinality for empty input without a count scan or temporary source-column write.

Dataset statistics for nonempty LazyFrames with visible Object columns retain exact missing-value counts and report
the duplicate count as unavailable. This path streams only the existing missing-metrics query; it does not build a
unique query. Native streaming cannot compare these Object rows, while multi-column in-memory grouping can incur
quadratic equality work. Empty and zero-column results retain known zero counts. Eager statistics and streaming for
ordinary schemas retain their existing behavior. Object-column profiling remains unsupported, and eager Object
grouping retains its native cost risk.

Polars Formula keeps arithmetic native. On integer sources, integer-string operands use the smallest supported
integer capacity at least as wide as the source, refusing unsupported operands or results. Other integer formulas retain their inferred dtype
and reject overflow, lossy promotion or new nulls for present operands. Integer-result addition, subtraction and
multiplication also validate Boolean operands against the current input. Division, floating and Decimal arithmetic
retain native behavior; supported modulo preserves native null, sign and NaN results.

Live execution and generated code share integer-string operand preparation and the precision guard. Validation scans
selected operands and returns bounded aggregates to Python without a second scan for ordinary integer-string inputs.
This does not snapshot a LazyFrame; its external inputs must remain stable until collection. Detailed capacity, replay
and scan-bound cases belong to the
[native Formula tests](../python/tests/test_polars_engine.py) and [literal tests](../python/tests/test_formula_literals.py).

Two-column addition, subtraction or multiplication producing UInt128 requires a recognized stable Polars release from
1.36 onward. Earlier, prerelease and unrecognized versions refuse this combination, including lazy
plans. Scalar forms and other operations retain their existing behavior.

Polars Custom Code collects and retains a returned LazyFrame's full native result before accepting that Custom step.
Generated code does the same immediately after Custom Code,
before a later step can discard its output. The existing Custom operation owns this check; ordinary operations retain
their own type, capacity and preflight checks without an added full-width scan after every step. Visible-column and
identity validation still apply to all cleaning results.

The same in-memory collection and LazyFrame wrapper used for notebook admission preserve native types and stabilize
row identity within each accepted Custom result. Eager results retain their existing identity. Preview retains the
complete new result alongside the original and confirmed frames needed for rollback; Apply reuses that draft. Replay
or Redo executes Custom Code again and can produce a different retained result. Full results must fit available memory,
including any old and new results that coexist during a mutation. This has no page-sized memory guarantee.

Other lazy expression errors follow native evaluation. For example, Format Datetime can fail when present values are
formatted, while an all-null result succeeds or a later projection removes the unused expression. Empty generated plans
remain identity functions. Viewing keeps its projected reads and does not run Custom result validation.

Eager and lazy Polars paths remain Polars-native and never call `to_pandas()`. Lazy file viewing projects before
collection and transports only bounded terminal results. One-hot encoding and multi-label binarization are explicit
cleaning exceptions: each materializes the complete lazy frame in Polars to derive its dynamic output columns.
Explode List likewise retains the complete input for its growth check, while keeping lazy output lazy as described
above. These operations do not convert through another dataframe engine. Viewing, all catalog operations, profiling, generated code, and
supported exports stay in Polars. PyArrow is optional and limited to native dependency preparation where the Polars
Excel reader requires it; it is not a transport conversion path.

Excel opens the literal selected path through a binary stream, preventing a missing filename from expanding to
other workbooks. The reader refuses a fallback that would buffer the whole workbook in Python and closes its stream
on success or failure. Calamine still reopens the stream's filename natively; this does not capture an immutable
inode or workbook snapshot.

CSV and Parquet readers disable native glob expansion. On Unix, JSONL/NDJSON opens the selected path through a
builtin stream and gives Polars ownership of a duplicated native descriptor. If duplication falls back to a Python
buffer read, the reader returns no source bytes and refuses the temporary plan. The session still checks its source
fingerprint before and after reads. On Windows, JSONL/NDJSON forwards the normalized absolute path unchanged. The glob
check excludes only the structural `\\?\C:\` local-drive prefix; it still refuses `*`, `?`, or `[` in the remaining
path and unsupported verbatim prefixes because the supported scanner cannot disable glob expansion.
Those refused Windows Polars JSONL/NDJSON paths are outside the stable file-entry scope recorded in
[feature parity](feature-parity.md); [#986](https://github.com/Matt17BR/openwrangler/issues/986) retains the missing
literal-path capability. A user can explicitly select Pandas through the default-backend setting and a fresh
Open File Path command; that does not change existing sessions or normalize the engines' parser behavior.

Datetime formatting preserves native Date and Datetime columns, including time zones and nanosecond precision,
before formatting the result as text. Live execution and generated code parse text only for non-temporal inputs.
Convert Type retains a Datetime column's existing unit and timezone when the target is Datetime. Converting that
column to Date takes its local calendar day. Both paths read the selected column's current dtype at each step,
including in reused generated programs, and preserve lazy execution.
String-to-Datetime conversion parses whole year-month-day dates with optional `T` or space-separated time, using
microseconds. Invalid or unsupported text becomes null. Recognized timezone-bearing text refuses conversion when
evaluated; Custom Code can supply a timezone policy. Recognition covers numeric hour/minute offsets, `Z` and
seconds-bearing ` UTC`, but not offset seconds, minute-only ` UTC` or named-zone suffixes. Native lazy pruning still
applies; this adds no full-source admission scan. Other input and target types keep their existing coercion rules.
Grouped integer and Decimal medians retain the target dtype and reject unrepresentable midpoints only when a group
needs filling. Empty groups stay null, and constructing a grouped Fill plan does not collect a lazy frame.
Exact By Example arithmetic returns typed native batches when unsigned operands require the checked scalar path.
Multi-label discovery uses the available native explode API while retaining its existing null and empty-label rules.

Generated Fill Missing Values code includes only the helpers referenced by the complete cleaning plan and their
dependencies. Polars and DuckDB share the selector for their controlled helper declarations; each engine owns its
helper implementations. The emitted programs remain standalone.
Polars linear interpolation uses one helper module for live execution and standalone generation. Its coordinate
validation aggregate runs before the returned lazy plan; live and generated refusals retain their respective error
types.
Directional Fill uses the same native expression plan in live execution and standalone generation, including stable
calculation order, whole-gap limits and source-order restoration. Constructing that plan does not collect a lazy frame.

### DuckDB

DuckDB CSV, TSV, Parquet and JSONL sessions retain a connection-free native SQL plan plus immutable column and type metadata. Each request
creates and closes its own hardened connection, and any `DuckDBPyRelation` is dereferenced before that connection
closes. DuckDB never converts through Pandas, Polars, or Arrow, and extension auto-install, autoload, and external-file
caching remain disabled.

Parquet sources take their private row identity from DuckDB's `file_row_number`, unless the file already has a column
of that name. A window row number would serialize every later scan. When row IDs follow source order, viewing sorts
break ties by row ID; other sorts keep a window tie-break. Counts, profiles, statistics and value choices read the
filtered relation without its sort. Top-value ties use the row ID when it follows source order and a window position
otherwise.

DuckDB's sample deviation raises instead of overflowing, so the profile first omits doubles of magnitude 1e100 or more.
When only such finite values were omitted, it rescales the column by an exact power of two and keeps the deviation
unless its squared total overflows, matching Pandas and Polars.

File Custom Code is an explicit capture boundary. Its result must belong to the supplied `df` connection, have
addressable visible columns and use no reserved row-identity names. It is evaluated once, with a stored row ordinal,
into native storage. The private Custom context is rolled back without committing outstanding side effects, then
writes an owned DuckDB checkpoint before closing. Later reads attach that checkpoint read-only on fresh hardened
connections. Native types survive this boundary without a CSV, Parquet or Python-value conversion. A Custom change
to connection settings may prevent capture, but cannot change the context of a later reader.

Immutable plans retain their checkpoint and derived queries preserve that owner. The fresh Custom plan exposes
only user columns; Session projects the stored ordinal into its step namespace after normal result validation.
It does not renumber a replay or reorder later Sort Rows results by identity. Discarded plans release their storage
when their last references disappear; the engine's weak registry does not retain old drafts. Engine close removes
its remaining owned storage after active session reads finish. Mutation snapshots, inspection pairs and profile
leases keep their referenced frames alive. Preview, replay and inspection can retain multiple full results, so
page and transport limits do not bound capture work, memory or temporary disk use.

Database-table sessions retain one read-only connection in their engine and serialize each full query and fetch
scope. They reuse the same SQL-plan, page and profile owners. Native spill files belong to a private temporary
directory, removed after the last reserved reader closes; DuckDB's database-adjacent default is not used. External access is
disabled. SQL editing is unsupported. A table's stored defaults and computed columns retain native behavior, so
computed values may change between requests; only a view is read from a snapshot.
Catalog admission quotes validated schema and table names through the existing SQL-literal owner. It avoids
parameter binding that initializes optional Pandas, NumPy and PyArrow modules on a cold request worker.

Viewers of the same resolved database path share a private spill directory and native database resources, while each
engine retains its own connection, query lock and interruption tracking. A reservation includes pending opens; the last
release removes the directory after native connection closure. Joining compares the existing file fingerprint with the
first reservation, refusing a changed source instead of serving an older cached database. This adds no path-alias policy.
An incompatible connection created outside these viewers is still refused without disturbing its owner. Header statistics
retain their single-thread guard, which also affects the other readers of that database; resource budgets are not per viewer.
Ordinary database writers are excluded while any reader remains open. Close waits for that engine's active query/fetch scope
and releases its reservation once. Initial-open cancellation retains the existing late-result cleanup path; it does not
promise immediate native preemption. Main-file identity is checked before and after reads even without a known suffix.
Read-only recovery of a native WAL is supported without changing its bytes. Metadata checks are not a database snapshot
or protection against every same-size in-place change. Cleaning, code generation, export and cloning are unavailable.

DuckDB viewing counts, profiles, value-choice search, filter predicates, row identities and timestamp display
resolve their own calculations from the built-in catalog. Lowercase, Uppercase, Capitalize, Strip, Split, Find and
Replace, and Split Text into Columns also bind their native text functions, concatenation and list extraction in
live and generated code. Empty literal replacement uses the native list aggregate directly, avoiding caller-bound
functions inside DuckDB's array-to-string macro. Shared missing-value and interpolation finite checks use the same
native functions in live and generated code. Expressions in the caller's source relation retain their declared
function bindings; Open Wrangler does not change the caller's search path, macros or connection.

Page queries limit selected top-level `VARCHAR` values to 65,537 Unicode code points before Python fetch, in the
outer projection after `LIMIT`/`OFFSET`. The same projection bounds top-level `BLOB` values to 49,153 native bytes
before Python base64 conversion. Text within 65,536 code points and binary values within 49,152 bytes remain exact.
The extra code point or byte keeps oversized values invalid for the existing live-page and saved-notebook validators;
no shortened cell is published. Source values, filters, sorts, profiles and exports remain unchanged. This does not
bound native query memory, aggregate page allocation or nested values.

Top-level `TIMESTAMP_NS` cells use native text projection before Python can narrow their values. One SQL display
expression serves bounded pages, grouped choices and profile extrema; counts, grouping and ordering use the original
timestamps. Choice search uses the same display text and accepts either `T` or a space between the date and time.
Search evaluates that expression over candidate source rows; returned choices remain bounded.
The existing selection decoder admits exact microsecond values and refuses finer fractions and timestamp infinities.
Choices and profile entries explicitly mark those selections unavailable; grid-cell requests refuse without changing
the view. Source timestamps retain their native precision.

List, Array, Struct and Map output also projects TIMESTAMP_NS leaves before Python boxing. Native type metadata
directs this projection, including for file sessions. It preserves distinct temporal Map keys and their associated
values. Formatting follows the selected page slice or grouped, limited profile/choice result; original types, grouping
and source data are unchanged. Work within a returned container grows with its children.

Top-level Maps with scalar Union keys compare their native cardinality with the fetched dictionary size before
publishing a page, profile or choice. This refuses entry loss when Python merges distinct native keys. A separate
scalar projection reads cardinality after the existing slice or grouped limit; the Map keeps its existing carrier.
Declared compound Union members use native key/value lists and do not need this dictionary check, even when inactive.
Maps nested inside other containers remain outside this check. Union values can still lose temporal precision or
selected-member distinctions during fetch. Complex-value selection and comparisons remain unavailable.

SQL byte literals use native hexadecimal decoding in live and generated code. Text literals containing NUL
additionally decode those bytes as UTF-8. Both functions resolve from DuckDB's built-in catalog so caller macros
cannot change the values. Text encoding precedes SQL quote escaping, preserving the original text. Other text retains
its existing literal spelling. Identifier, file-path and portable-regex validation have separate owners.

File readers adapt paths to DuckDB's glob rules so imports use the selected file. Source identity, empty-file checks
and diagnostics retain the original path. On Unix, the adapter preserves the first absolute component, which DuckDB
treats literally, and escapes the remaining components. Windows paths on local drives use standard glob escaping.
Unix paths containing both backslashes and glob syntax, and Windows drive, share or device anchors containing glob
syntax, are refused because native expansion can select another file. Existing source fingerprint checks still
surround lazy reads; the adapter adds no dataframe scan or filesystem owner.

CSV and TSV readers disable native comment inference so literal `#` values cannot remove records or truncate fields.
They also set zero skipped records so preamble inference cannot discard nonempty input. The existing four-byte
empty/BOM read rejects an initial CR or LF after an optional UTF-8 BOM, for either header setting. This deliberately
excludes leading blank lines and an empty one-column first record: native zero-skip parsing can otherwise duplicate
the header or add a null row. Empty/BOM-only files retain their zero-column representation. Leading spaces, missing
first TSV fields and quoted embedded newlines remain supported. No additional parser or source scan is introduced.
Before replay, imports reject column names containing an ASCII apostrophe (`'`): the supported native CSV serializer
can corrupt these names in its frozen schema. The check uses existing snapshot metadata and retains the same binding
and cleanup owners. Standalone generated programs inherit this native limitation when given an externally loaded CSV
relation with affected names; JSONL and Parquet headers are unaffected.
DuckDB still owns the remaining dialect and type inference. The [file-support limitations](feature-parity.md#duckdb-experimental-file-support)
describe the supported input policy. Generated cleaning programs receive an already-loaded relation.

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

Convert Type to Datetime preserves an already typed timestamp's storage type, precision and instant semantics.
TIMESTAMPTZ retains its instant, not an original named timezone. Other inputs keep the native TIMESTAMP conversion.
The shared temporal cast expression reads current-step metadata and retains normal assignment and result validation.
Convert Type to Date floors native TIMESTAMP_NS values to their calendar day without first narrowing to microseconds.
Negative nanosecond values immediately before midnight therefore retain the preceding day. Live and generated code
select this expression from the current input type. Nulls, infinities and other source types keep their native Date cast.

Format Datetime preserves native date and timestamp inputs. Nanosecond timestamps use the microsecond formatter only
when their native epoch count is divisible by 1,000, preserving exact values that DuckDB's nanosecond formatter can
refuse near its lower bound. Finer values use the native nanosecond formatter and retain its range refusals. Other
non-temporal inputs keep the existing conversion to microsecond `TIMESTAMP`. A shared expression builder uses the
current column type in live and generated execution; it adds native remainder work for nanosecond columns without
another source scan. DuckDB format syntax applies, including nine-digit `%n`. Zoned timestamp formatting follows the
existing connection timezone: UTC for file sessions and the caller's timezone for standalone generated code. It does
not recover the original zone from a stored instant.

DuckDB evaluates computed cleaning results across every physical output column before publication, including errors
outside the requested page. The existing result-validation hook receives the operation kind from Session. Rename,
Select Columns and Drop Columns only project existing fields, so they skip the additional hash aggregate while keeping
visible-column, addressability and identity validation. An explicit validation call without operation context still
checks the whole result. One DuckDB-owned classification also controls generated checks.

Other operations, including Formula and Custom Code, retain the native aggregate before a later projection can remove
an erroneous output. The hash primitives resolve from DuckDB's built-in catalog; generated code evaluates on the input
relation's connection. The validation scalar is discarded. Custom capture retains its full result independently of
this check. This work
remains necessary to force lazy arithmetic guards, including mixed-integer precision checks.

Structural steps preserve native lazy input evaluation: an inherited expression error may surface on a later read,
and a Drop can remove an unused erroneous expression. They add no full-result validation scan or retained snapshot.
Computed-result checks can also be followed by a different outcome for volatile inputs. Empty plans remain no-ops.

Formula checks addition, subtraction, multiplication and modulo when both selected operands have native fixed-width
integer types, through 128 bits, and DuckDB promotes the result to DOUBLE. Each evaluated expression checks its actual
operand pair and result, refusing precision loss while retaining correct native values and types. Its own arithmetic
resolves from the built-in catalog, so caller macros cannot replace the guard's primitives. Metadata inspection does
not evaluate source values. The embedded check adds native work and may allocate hash state for distinct operand
pairs; it does not retain a frame or introduce a Python row loop. Live execution and generated code use one SQL
builder; generated helpers remain subject to the existing code-size limit.
Multiplication and modulo also check integer operand pairs containing BIGNUM. Each selected BIGNUM operand must fit
the signed 128-bit range before conversion to bounded decimal text and exact integer arithmetic. Fixed-width unsigned
counterparts retain their full range. Outside that bound, only a zero-product or unit-divisor identity that agrees
with the native zero result is accepted; null operands and modulo by zero retain native behavior. Other out-of-range
pairs refuse because exactness is unavailable, even when their native result happens to be exact. In-range precision
loss keeps the existing inexact-result error. This guard adds native evaluation and distinct-pair hash state; it does
not add a second full-result scan. BIGNUM remains unavailable in numeric form choices, but programmatic and generated
plans receive the same guard.

Other native result types, explicit floating or Decimal operands, division, power and By Example retain their existing
paths. BIGNUM addition and subtraction also retain native behavior.

CSV, TSV, JSONL, and Parquet file sessions support native viewing and the DuckDB operations in the
[cleaning support guide](feature-parity.md#cleaning-operations), with matching live and generated code. DuckDB file editing remains experimental; Excel is unsupported. Database tables retain the read-only
connection described above. Notebook relations remain viewing-only, including when a caller requests editing.
Opening requires an explicit choice of their originating global connection variable or DuckDB's default connection.
The host pins the notebook and kernel before this picker and retains the choice in the immutable source descriptor.
The runtime resolves the relation and selected connection together, verifies native affinity and captures rows once
with their ordinal. Private connections must be exposed as notebook variables; another connection to the same
database is not interchangeable. Subsequent viewing queries use the retained native result and compact SQL on that
exact connection. Closing a viewer releases its references without closing, committing or rolling back the caller's
connection. Closing the caller connection makes the viewer unavailable.

Native capture and query helpers use collision-checked temporary aliases and remove only the catalog identity they
created, after consuming the result. Notebook requests remain serialized. Native execution can invalidate an unread
stream or abort an active caller transaction. Such a failure publishes no candidate; Open Wrangler preserves the
original error and does not recover the caller's transaction. An aborted transaction can prevent alias cleanup until
the caller rolls it back, and native rollback does not clear DuckDB's Python registration-name bookkeeping.

Generated Custom plans use the same connection-affinity and native capture rules for each Custom result. Results
created on a different connection, including portable `duckdb.sql(...)` results, are refused in live and generated
execution; derive them from `df` instead. Ordinary plans retain their existing lazy interface. Capture-aware SQL
helpers and validation execute through the explicit connection, fetching before alias cleanup. Returned generated
results remain native DuckDB relations. Their later derivations can incur substantial DuckDB collection-formatting
overhead; internal compact SQL does not remove that external cost. Capture freezes one evaluation's values and
traversal, including volatile expressions, rather than promising the same values on a later replay or function call.

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

Native R sessions operate directly on R `data.frame`, tibble, and `data.table` frames. IRkernel, exact official
R-terminal, and owned `Rscript` transports share the same native frame contract and supported cleaning operations,
including generated R. The runtime never routes an R frame through Python.
[Feature parity](feature-parity.md#native-r-support) defines support and limitations for each entry path.

Owned R processes read their bootstrap from an exclusive, read-only file in the process's private directory.
Passing the file to `Rscript --vanilla` preserves source escapes across Unix launchers and leaves stdin available
for binary requests. The bootstrap stays outside the document directory and shares the process's cleanup owner.
The host rechecks cancellation and Workspace Trust after writing it, immediately before launch.

#### Cleaning library selection

An R session confirms one cleaning library: `base`, `dplyr`, `data.table` or `collapse`. The backend stays `r`;
the library and native frame flavor are independent. Public metadata carries `rLibrary`, and the code dialect is
`r.<library>`. The private native open request carries `library`; its correlated opening response must confirm the
same value. Ordinary responses, replay and recovery cannot change it. Non-R messages cannot carry an R library.
The resource-scoped `openWrangler.defaultRLibrary` supplies new opens; explicit selections and saved file choices
take precedence. Existing R file records without a library retain base behavior.

Non-base selections use the chosen library for supported dataframe selection, assignment, ordering, duplicate grouping,
aggregation and reshape operations, preserving source ownership. Base retains the existing R operations, including
the data.table helper for Pivot Wider. Exact scalar calculations and admission rules remain shared. Live execution
and standalone generated code use the same native helpers, including the selected package requirement. Package
calls use temporary unique column names where their public APIs cannot preserve duplicate or empty names; the
runtime restores public names, frame flavor, row labels and valid keys without overwriting changed vector types.
Imports, viewing profiles and exports retain their existing native implementations. Selecting a library does not
promise that every scalar calculation or reader is supplied by that package.

Changing the library of an open editor creates a separate Editing session from the exact captured runtime session
and revision. If native editing has already isolated an original frame, that frame supplies the copy. Otherwise, the
native clone verifies and isolates the session's retained source capture when it executes. An untouched direct open
can still retain a live binding; a session created by copying already retains an isolated snapshot.
Opening the picker does not freeze live values. The copy replays confirmed
applied steps, with explicit confirmation that Custom Code runs again. The original
keeps its draft, redo and viewing state. Applied-step inspection clears when focus moves to another editor, as it does
for ordinary editor changes. Ordinary grid and profile reads after capture do not invalidate the copy; pending mutations,
changed revisions, lost execution owners and unsettled runtime work still prevent it from publishing.
The candidate starts without a draft or redo history and remains private through replay and validation.
For files, an existing target-library editor, pending copy or saved plan prevents
replacement. Live copies check editors and pending copies within their captured bridge family; separately opened live
sessions remain independent, even when they read the same variable. Failure closes only the candidate; closing either published editor preserves the other's runtime ownership.
For files, **Open file separately** uses the existing file-opening path and that library's saved plan, if any.
As with file-plan copying, a completed durable save survives later cancellation even if the candidate is not published.
Native R reports missing or incompatible selected packages for the exact environment without silently changing
libraries. Failed local file opens offer the repair flow below; live notebooks and terminals retain manual guidance.

#### Local files

A file owner captures the exact local path, URI, import options and resource-scoped Rscript executable before launch.
It checks Workspace Trust, supported platform and format before creating its lazy bridge. Its private process holds
the loaded base `data.frame`; no notebook, document or terminal binding is fabricated. Recovery reuses the captured
descriptor and executable in a fresh process and rechecks trust. File sessions offer copy/save of generated R and
native exports, with no document insertion target. The private descriptor identifies the format and its exact options;
Excel retains either a sheet name or a zero-based sheet index. Live and generated loading use the same native helper.

A missing-package failure retains structured package requirements and the failed file's captured Rscript environment.
The error view offers **Install required packages**. That action confirms cleanup of the failed runtime, then probes
packages without reading the data file. Healthy opens do not run this extra probe. Core requirements use their shared
host/native owner; readers and cleaning libraries use the existing native helpers, including conditional clock admission.
The modal shows required packages, the captured Rscript path and R version, the target package library and CRAN
repository. Only **Install** authorizes package writes. Notification progress and a success message follow the same
panel flow as Python; successful validation retries the exact file in a fresh R process with its retained initial plan.
It does not migrate a live session or install into a notebook or existing R terminal.

Read-only probes and package installation use owned VS Code terminals with the captured environment. Only one R
repair can run per extension instance, including its probes, to prevent competing repairs from reading a library
while another repair writes it. Installation targets only the approved library. Closing or cancelling the panel, or
shutting down the coordinator, prevents new writes and reopening. Once installation has launched, panel cancellation
detaches its waiter without terminating package writes; its terminal and settlement remain owned until exit. Closing
that terminal or VS Code can still interrupt the process. This flow has no package journal or automatic resume guarantee.
Failure leaves the error view available for retry, with bounded diagnostics rather than uploaded terminal output.
Probe results and installer diagnostics use the existing private-artifact reader: the byte limit and single-link
file identity are checked on the opened descriptor and pathname before and after reading.

On Windows, the bundled PowerShell supervisor creates `Rscript` suspended, assigns it to a private Job Object with
kill-on-close, then resumes it. Only the selected stdin/stdout/stderr handles cross into the child. The host relays
bounded binary R requests through the supervisor; stdin closure, target exit or a failed pipe retires the entire job,
including descendants. A blocked child writer cannot block lease-loss detection. Cleanup removes the private root only
after the supervisor reports the exact job-empty token and closes. Forced supervisor termination without that receipt
preserves the root and reports unconfirmed cleanup. The supervisor compiles its bundled C# owner through Windows
PowerShell `Add-Type`, after loading its built-in Utility module directly from `$PSHOME` so inherited module search
paths do not delay startup. Policy or compilation failure stops opening with a diagnostic. An initial startup failure keeps
its cause through cleanup; only an established runtime publishes invalidation. This file path does not enable
Windows document or terminal execution. PowerShell’s temporary compiler runs before the R Job Object exists.
Abrupt helper termination during compilation does not establish compiler-child containment; the host reports
unconfirmed cleanup and retains the private root. The job-empty receipt covers the subsequently launched R tree.

#### CSV and TSV files

The native loader tokenizes CSV bytes with R's compiled regular-expression engine and uses
`type.convert(numerals = "no.loss")` for column types. Live and generated code use the same helper, captured import
options and frame column limit. It accepts strict UTF-8, explicit UTF-8-lossy replacement, UTF-16LE/BE, ISO-8859-1 and
Windows-1252. Delimiter and quote must be different single tab or printable ASCII characters. LF, CRLF and CR delimit
records and remain exact inside quoted fields. Quotes must enclose a whole field, with embedded quotes doubled.
Literal quotes in unquoted fields and text after a closing quote are refused.

Empty unquoted records are skipped. Before the first record, single unquoted fields containing only ASCII spaces or
tabs are also skipped; quoted empty fields, quoted whitespace and delimiter-only records remain data. Body whitespace
remains data or causes a row-width refusal. Headerless columns are named `V1`, `V2`, and so on. Header whitespace,
duplicate and empty names remain intact. Header-only inputs produce zero-row logical columns. Empty or padding-only
files, malformed row widths, unclosed quotes and NUL are refused. Invalid or incomplete selected-encoding text is
refused unless UTF-8-lossy replacement is explicitly selected. Parser warnings are errors; invalid-input diagnostics
exclude source text.
Windows-1252 decoding refuses its five undefined bytes consistently across platforms; ISO-8859-1 retains the
corresponding control characters.

Default strict UTF-8 reads the source directly without an extra conversion pass. Other encodings and explicit lossy
mode decode in 64 KiB chunks, retaining only an incomplete encoding suffix, into an owned temporary UTF-8 file.
This adds a decoding pass and temporary I/O. Normal completion and errors close and remove the temporary file.
Managed R processes place their native temporary directory beneath the exact owned process root, so forced process
cleanup also removes interrupted conversion files. Generated code uses its R temporary directory and the same
normal/error cleanup. Neither path modifies the source.

Empty fields and `NA`, including quoted forms, become missing. Text columns preserve field whitespace; native type inference
recognizes logical and numeric values, retains precision-losing integers as text and leaves dates as text. The complete
frame is loaded into R memory before the bounded page/capture path. First editing isolation, profiles and operations
can allocate additional complete vectors or frames. This is an eager native reader, without a page-sized memory
guarantee. Reopening, recovery and generated code reread the current file, matching ordinary eager-source behavior.
Source and destination identity checks still protect the input from exports.

#### Parquet, JSONL and Excel files

Parquet input uses Arrow 23.0.1.1 or newer for one data read. `nanoparquet` 0.5.1 or newer validates physical and
logical footer metadata before that read. It admits flat Boolean, text, floating-point, signed integer and Date
columns, with reader-preserved factor metadata. Integer64 input also requires `bit64`. Modern `INT` and
[legacy integer annotations](https://github.com/apache/parquet-format/blob/master/LogicalTypes.md#deprecated-integer-convertedtype)
accept 8, 16 and 32 bits only on physical INT32, and 64 bits only on physical INT64. Legacy annotations apply only when
the logical annotation is absent; a local TIMESTAMP never falls back to its legacy timestamp annotation.
Signed and unsigned INT64 retain exact `integer64` values within the signed R range, excluding its missing sentinel.
Arrow validity masks distinguish source nulls from present values that collide with R integer/date missing sentinels;
missing footer statistics no longer force refusal. Unsigned values outside the native signed range are refused.
Field refusals identify the column index, bounded escaped name, physical/logical/converted
annotations and the unsupported representation, with guidance to select a compatible engine or explicitly convert the field.
Decimal, binary, nested and INT96 fields remain unsupported. The INT96 guard prevents Arrow's nanosecond conversion
from silently wrapping dates outside that representation's range.
UTC-adjusted millisecond and microsecond timestamps retain the existing POSIXct path when their magnitude is below
2^51 ticks and they pass a tick round trip. Other millisecond/microsecond timestamps and all nanosecond timestamps
use `clock` 0.7.4 or newer: unadjusted values remain `clock_naive_time`, and adjusted values become `clock_sys_time`.
Arrow's decoded timezone presence must agree with the footer's UTC-adjusted flag; disagreements are refused in both
live and generated loading. This checks timestamp interpretation across the two reads, without making file loading
atomic against concurrent writes.
The reader splits Arrow's exact integer ticks into days, seconds and sub-second remainders for clock storage and
verifies nulls. It never first converts these values through POSIXct doubles or integer64 missing sentinels. Nanosecond timestamps
retain the full signed 64-bit range, including a present minimum value. Named timezone metadata is not restored;
adjusted values display in UTC. Clock millisecond/microsecond values must be within ISO calendar years 0000 to 9999,
matching the display and filter parser; direct notebook columns use the same bound. Reader-preserved durations retain
the below-2^51 tick bound and a consistent
seconds/milliseconds/microseconds/nanoseconds scale, checked against Arrow arrays without a second data read.
Text columns become ordinary character vectors once, because Arrow's lazy strings rebuild every value on each scan.

JSONL/NDJSON input uses `jsonlite` and admits flat object records with one scalar type per column. Missing keys and
JSON null become missing values; field order follows first occurrence. Blank lines are skipped. Numeric token text
is retained before decoding, preserving negative zero and exact integer64 values. Large integers require `bit64` and
cannot share a column with floating-point or negative-zero literals. Duplicate keys, nested or mixed scalar values, invalid Unicode,
NUL, overflowing numbers and underflow to zero are refused rather than silently changed.

Excel input uses `readxl` 1.4.5 or newer and the selected `.xls` or `.xlsx` worksheet. Per-cell reading checks every
value before assembling scalar columns, avoiding inference from only the first rows. Duplicate and empty headers
remain intact. Mixed cell types are refused. Dates load in UTC at millisecond precision. The reader uses stored
formula results without evaluating formulas; absent cached values, blank cells and ordinary error cells become
missing. Whitespace-only XLSX text also becomes missing; surrounding whitespace on nonempty text is retained.
These are native spreadsheet-reader semantics, not preservation of workbook formulas, formatting or error objects.
The existing worksheet picker obtains exact sheet names from the managed session's retained file descriptor through
its request queue. It keeps the existing 15-second deadline, 4096-name and 65536-byte limits, with source, revision,
trust and owner checks before and after discovery. Choosing a sheet opens a separate source-bound session. Only a
current recoverable native runtime or missing-package error permits manual sheet entry; stale or malformed metadata
is refused. The private native transport is version 18. The public protocol remains version 4 and adds the explicit
R cleaning-library selection and confirmation fields.

All formats load the complete native frame before serving bounded pages. Recovery and generated code reread the
source; exports keep the existing separate-destination and source-protection checks. Optional reader dependencies
are checked by the emitted loader itself, so live and generated failures give the same installation guidance.

#### Frame and source ownership

The producer and host independently validate canonical frame classes, column IDs, row names, typed values and
bounded metadata. Factors, ordered factors, Date, POSIXct, difftime and integer64 retain explicit native metadata.
Top-level clock naive/sys time columns have a separate `clock_datetime` kind with explicit millisecond, microsecond
or nanosecond precision. Their exact two-field record storage and class chain are validated; arbitrary vctrs records
and clock values nested inside List/Struct columns are not admitted. Public datetime cells carry signed decimal tick
strings and exact ISO display text. `rawType` records both precision and civil/instant meaning, so saved-plan
compatibility and filter reconciliation cannot reinterpret ticks after a type change. Sorting can retain its column
reference; filters on changed clock types are discarded.

Clock columns require a base data.frame or tibble. All four selected libraries can open, view, profile, filter, sort
and export these frames through the shared native owners. data.table and collapse sessions expose an empty cleaning
operation catalog while clock columns remain, with help directing users to the existing base/dplyr editing-copy path.
Their native step dispatcher also refuses before any mutation. The session keeps its selected library and existing
mode/export/copy contract; it does not silently execute another library's transformations. Actual data.table frames
containing clock records remain unsupported.
Base R and dplyr support structural cleaning, exact filtering/sorting and missing/duplicate handling.
Temporal formatting, casts, Fill, grouping, pivoting and By Example
do not acquire clock semantics implicitly; unsupported operations refuse before publication. Other operations remain
available when clock columns are not inputs or grouping/identifier keys.

Plain-double `NA`, `NaN` and both infinities remain distinct. Non-finite classed temporal values, fractional Dates,
reserved integer missing-value sentinels used as values, recursive containers, unsupported attributes and malformed names
are refused. Ordinary `collapse::qDF()`, `qTBL()` and `qDT()` outputs use the three supported frame paths;
`GRP_df` and `indexed_frame` do not.

Display text is independent of `OutDec`, the process time zone and the platform's `strftime`. It matches the
Python engines: doubles show Python's shortest round-trip repr, years before 1000 keep four digits, and datetimes use
Python ISO text without a zero fraction, with nanoseconds only when nonzero. POSIXct and UTC clock values are instants
and carry their offset in the display zone, including offset seconds for historical local mean time; a null or empty
zone displays in UTC while preserving that original metadata. Parquet timestamps keep their Arrow time zone when R
recognizes it. Durations show the shortest number and R's unit, such as `90 secs`. Missing, logical and infinite
cells keep R's `NA`, `TRUE`/`FALSE` and `Inf` tokens. Default POSIXct display and Convert Type to text round
fractional seconds to six decimal places before formatting the calendar portion; Convert Type uses UTC with `Z`.
Raw values and source metadata remain unchanged. Explicit Format Datetime keeps native R directives, including `%OS6`
truncation. One Hot keeps its existing double and truncated timestamp labels because they are persistent column names
in saved plans.
Explicit bounded row labels follow their source rows through sorting.
Aligned plain column-element names are inert metadata, not row or column identity. Compact zero-row frames and
zero-column sources retain their row count and labels; column lengths must still agree. Custom Code can create the
first column, and Drop Missing Rows or Drop Duplicates can retain an empty schema. Custom Code output must have a column;
Drop Columns must leave at least one visible column.
Mutation and inspection decoders distinguish a known empty schema from missing host context and retain exact schema,
row-identity and diff checks. Live and generated input/output validation accept the same native empty frames.

Standalone captures own an isolated snapshot, using `data.table::copy()` for data tables. Live viewing instead retains
the verified variable binding, reads its current values, and refuses changed shape, schema, class or row-name mode.
The first editing draft isolates the original through R serialization or `data.table::copy()`. Committed and draft
results remain separate, and targets use stable IDs plus captured names. Ordinary cleaning drops inert column-element
names according to native data-table copy semantics; the explicit retention exceptions are described below.

Ordinary list and `AsIs` list columns admit one flat prototype. A List contains atomic vectors of one native type
and exact metadata across rows: logical, integer, double, character, factor, Date, POSIXct, difftime or integer64.
Typed empty vectors establish that prototype; different typed empties are incompatible. An empty `list()` is present
but untyped, while an outer `NULL` is missing. A column containing only those two values has no invented element type.
A Struct contains plain named lists with the same unique, nonempty field names and scalar native types. Field order
may differ between rows and is aligned by the captured names. Missing or extra fields and `NULL` field values are
refused; a typed `NA` field or missing whole record is valid. Recursive containers, matrices, arbitrary child classes
and attributes hiding reference objects remain unsupported. Atomic child names retain their native values and appear
inside the public cell's raw representation, without adding fields to the public cell protocol.

Initial capture infers the prototype once. Later projected pages reuse it and validate the returned
cells, so changing an unseen cell is refused when that cell is requested. Editing and Custom Code validate every
nested cell against the captured prototype before isolation. Derived empty or all-missing columns retain their
captured prototype. Within each validation walk, identical atomic metadata may reuse one representative, while factor
codes, temporal values and name lengths remain checked. There is no persistent cache. Existing metadata, page and
cell limits bound serialization. Before native copying, the existing 64 MiB operation budget also charges nested
pointer slots, child headers, payloads, names and attributes, including each occurrence of an aliased child. This is
separate from JSON cell envelopes and does not impose a new whole-source cap on scalar siblings. Metadata capture and
projected viewing can remain available when a nested column is too large to copy.

Extract Struct Fields appends 1 to 64 captured scalar fields and retains the parent, row IDs and sibling column IDs.
Missing parents produce typed missing outputs. Explode List requires a known atomic element prototype, retains the
selected column ID and repeats sibling values in source-row and child order. Each missing or empty cell produces one
typed missing value. Expanded rows receive fresh IDs in the existing row domain. Both operations preserve the frame
class, native child metadata and valid scalar data-table keys. Explode checks the row domain, repeated sibling bytes
and materialized output against existing limits before allocating expansion indices or output vectors; Extract checks
its new columns and metadata. Scalar comparisons, sorting and duplicate operations require scalar selected columns.

Generated nested guards and expansion use an explicit finite set of deparsed native validators and helpers in a
private base environment. They enforce the same prototype, attribute and copy bounds before publishing a result.
Nested source plans and Custom Code include the guard helpers; Extract and Explode add their materialization helpers.
Scalar plans without Custom Code omit those helper sets. This does not add package-specific code dialects
or a recursive flattening engine.

#### Viewing and profiling

Viewing filters and sorts preserve source row IDs and stay outside the cleaning plan. Compound logic, typed predicates,
value selections, stable ties and per-key missing placement share the cleaning Filter Rows/Sort Rows rules. Filtering
may retain a compatible data-table key; explicit sorting clears the data-table key. `NA` and
`NaN` remain distinct. Null filter logic is invalid, not a default AND; picker search is a required nullable field.
Optional value-filter search must be text when present. Invalid viewing requests leave an existing draft usable.
Native R combines masks incrementally, avoiding lists of every condition and column mask while still evaluating every condition.
Date value selections and profile keys group positive and negative zero as the same epoch day without changing
source storage. POSIXct and difftime keys retain their existing signed-zero identities.
The shared integer64 ordering helper uses canonical decimal text from the verified native converter, then stable radix ordering
by sign, digit width and digits. It preserves exact values without per-row decimal normalization or comparison.
Live cache integrity and sort-cache freshness checks compare floating-point storage exactly and retain normal
attribute checks. This distinguishes integer64 values and missing sentinels that R's default `identical()` comparison
treats as equal.

Base R, dplyr, data.table and collapse share these viewing calculations. Library selection changes supported cleaning
verbs and generated code. The [performance review](https://github.com/Matt17BR/openwrangler/issues/1622) records the
measurements and alternatives behind the current decisions; opening a source with each library checks compatibility,
not comparative package speed.

| Calculation     | Current decision                                                                                                                                                                                                                                                                                                                        |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Filters         | Keep typed native masks and physical row positions. Direct numeric comparisons, incremental mask combination and bounded text-fold reuse remove measured work while preserving the common predicate rules.                                                                                                                              |
| Sorts           | Keep stable native radix, exact integer64 and vctrs clock ordering, with bounded managed-file order reuse. Alternative integer64 ranking calls either failed exact-range controls or required additional method ownership and copies. Existing selected-package cleaning adapters are unaffected.                                       |
| Column profiles | Keep the complete result shared by headers and drawers. Opening a drawer reuses its completed header summary without another request. [Drawer-only attribution](https://github.com/Matt17BR/openwrangler/issues/1622#issuecomment-5738658327) measured the extra reductions without demonstrating a net benefit from partial summaries. |

Exact mean uses bounded vectorized accumulation to preserve numerical cancellation, subnormal and rounding behavior.
Error-free extraction first reduces each chunk to a few exact partial sums; only those and any remainders too small for
extraction enter the limb accumulator.
Partial summaries would add completeness tracking, loading and upgrade states, cancellation and view restoration
rules, and could repeat shared scanning when the drawer opens.

These choices have costs: text-fold reuse can slow unique-text inputs and increase temporary heap use; sorted reuse
adds source-order recovery and can retain extra pending-profile vectors. Initial filters and sorts remain synchronous,
and sort changes reset UI profiling. The measurements do not establish that shared code is fastest for every input.

Each managed file agent can retain one filtered row selection, shared by established-session pages, profiles and
value queries. Reuse requires the same capture and resolved filter, after the usual source and schema validation.
The entry holds one integer position vector, in source order or the last requested sort order. Pages with the same
resolved sort rules reuse that order. Sort changes start from physical capture order so ties remain stable.
Unsorted pages, profiles and value queries recover source order without replacing the cached sort; that recovery
adds work and allocates another vector. Pending profiles may each retain a recovered vector until completion.
The positions, filter key and sort rules together may occupy at most 64 MiB. A filter miss releases the old entry
before scanning; oversized selections remain usable without retention. Once filter membership is retained, a failed
sort or over-budget sort metadata leaves that entry intact. This bound excludes the session-owned frame and
pending-profile vectors.
Empty page and profile filters release the entry. An auxiliary value lookup with no remaining filters bypasses the
cache, preserving the grid's existing selection and order; a nonempty lookup uses the usual replacement rules.
Source-reaching edits or replay, session close and agent disposal also release it before execution or cleanup can
fail. Initial opening, inspection and mutation responses do not populate it; later reads may reuse a published active draft.
The existing 32 MiB sort cache and live notebook, terminal and document behavior are unchanged. Initial and
uncached filtering and sorting still run synchronously. Reuse does not promise a net improvement for every query
sequence: changing sort also resets UI profiling, and each new profile may need source-order recovery.

R header profiles honor `openWrangler.insightsOnOpen`.
The existing post-mutation quiet period still gives immediate Undo and Redo priority over background profiles.

Managed file processes can advance large single-column summaries and Dataset statistics between page requests.
Eligibility comes from the process's retained file descriptor. Live notebooks, R terminals and managed documents
keep their synchronous execution path. The file runtime retains the exact frame, selected column and fixed filter
membership; it does not copy the whole frame or reuse a mutable page cache. Synchronous and yielding requests use
the same calculation owners. Small summaries, multi-column requests, filter setup and bounded result finalization
can still execute without yielding.

Each native session can retain two pending summary/statistics calculations. Their private begin, continue and close
messages carry a fresh calculation ID and session identity; continuation also checks the captured revision.
Completion, admitted-work failure, close and disposal release retained state. Invalid or duplicate requests cannot
remove another calculation. All sessions in the same process share mutation exclusion, including Custom Code
replay through Undo, Redo and step inspection. Host admission waits before queueing these exclusive requests, so
earlier profiles can finish and later profiles cannot starve a waiting edit. A profile keeps its original deadline and
checks the originating logical view before each advance and publication. Abandoned dispatched work retains its
settlement and exact-process cleanup owner; an unverified close retires that process.
Cleanup reserves its native queue position immediately. Its close-response deadline begins at dispatch, so it cannot
expire while an earlier valid page or export is running. Waiting for that predecessor retains the existing
authoritative-settlement rule; caller timeout alone does not prove that native work has ended.

List and Struct profiles report outer `NULL` counts only, with no distinct count, value distribution or chart.
Their filters support `isNull` and `isNotNull`; value selection and nested sorting are unavailable. Scalar siblings
retain ordinary filters, sorts and profiles. Dataset duplicate counts are unavailable while any nested column remains.
These outer counts do not re-infer leaf prototypes; page and editing boundaries retain their own validation.

Column and missing-value statistics scan in bounded chunks. Large column summaries and dataset missing-value scans
verify bit64 registrations once per uninterrupted advance and retain those native handles only within that advance.
Each chunk still undergoes type, attribute and value checks; a later advance verifies the registrations again.
Numeric histograms count every finite value into at most
20 bins; integer64 chart positions retain their double projection while typed extrema remain exact.
Integer64 extrema use the package's native range reduction without sorting every value. Integer and integer64 chunks
whose values stay below 2^53 in magnitude add exact double high and low parts, folded into decimal text once per 2^26
values. Wider integer64 chunks reduce bounded native quotient/remainder batches, combining only their totals in decimal
text. This preserves cancellation and sums beyond the integer64 range without per-row decimal arithmetic.
Text profiles and character comparison keys share UTF-8 normalization in batches of at most 65,536 present values.
ASCII-insensitive contains predicates and value search fold repeated normalized strings once per batch of at most
65,536 values, then restore their original positions. The full folded vector remains allocated. Duplicate lookup adds
work for unique text and can increase temporary heap use. Scalar searches keep the direct conversion path.
Factor comparison keys reuse normalized descriptor levels on a temporary projection; generated code normalizes the
current step's temporary factor levels before expanding its codes. Both retain native invalid-code refusal and leave
source levels, ordering and encodings unchanged. Live and generated Filter Rows and Conditional Column use normalized
text for comparisons, including Latin-1 and unmarked valid UTF-8 under the C locale, while preserving missing positions.
Small character profiles reuse their validated category keys for text statistics. Exceptional encodings or potentially
oversized values retain ordered scalar refusal and the original row labels.
After the chunked scan, one whole-view pass counts every present value by native identity, so distinct counts, top
values, categorical charts and numeric medians are exact at every size. Identities group exactly as displayed values:
signed zeros merge except in date-time and duration columns, missing values stay apart from NaN, and integer64 values
compare as exact doubles below 2^53 and as decimal text above it. Only the reported values are formatted. Dataset
duplicate counts are exact too: each column refines the candidate row groups in its own time-sliced advance and drops
rows that are already unique. Value discovery counts the whole view the same way and formats only candidates that can
reach the requested limit; a search formats each distinct value once. These passes allocate native hash tables
proportional to the view's rows and cannot be interrupted by IRkernel once dispatched. Numeric summaries with no
finite statistics retain an empty numeric object and omit the histogram. Dataset-statistics counts and their filtered
row total come from the same request.

Numeric filter operands and typed temporal payloads retain their finite native R value while binding. Ordinary integer, Date,
floating, datetime and duration predicates compare native values directly, without formatting source rows as text.
Integer and Date predicates still convert their bound operand keys numerically. Picker selections use the source value
instead of reparsing display text; datetime keys retain epoch seconds and duration keys retain the column's units.
Integer64 predicates admit the mathematical `INT64_MIN` bound even though bit64 reserves that storage for missing
values. Generated Filter Rows and Conditional Column resolve comparisons at that bound without constructing a bit64
missing operand. Exact clock timestamps retain their separate present `INT64_MIN` tick and comparison path.
The shared finite-number parser normalizes accepted decimal spellings for the existing jsonlite decoder; it keeps
native numeric inputs, signed zero and the existing grammar and range checks. Public scalar Fill still accepts
replacement text, binds double replacements once and emits that bound value through the existing numeric-literal
owner. Generated floating, datetime and duration Filter Rows uses that owner too. Manual datetime input retains its
timezone rules, and manual duration input still converts seconds to the column's units. Explicit Infinity tokens retain their separate rules,
and native floating columns refuse integer-cell selection tokens.

#### Export and transport

Cleaned-data export requires Editing mode with no outstanding draft; Apply or Discard first. The writer runs in the
same owning R process, including Arrow for Parquet. Document transport streams an identified private file;
notebook and terminal transports read offset-checked chunks from the exact native owner before the host's atomic save.
CSV and Parquet export refuse remaining List or Struct columns before creating an artifact. Extract the needed fields
and drop the parent, or Explode a typed List, to produce an exportable scalar frame.

Native R CSV export writes validated UTF-8 bytes with LF record separators, independent of the current locale.
It prepares character values and factor levels in a temporary frame. Duration columns use plain numeric storage in
that frame so fractional values retain a decimal point under caller `OutDec` settings; their stored-unit magnitudes,
source storage and other non-text columns remain unchanged. Duration storage is checked in slices of at most 65,536
values; NaN is refused before artifact creation because the numeric writer would otherwise turn it into missing.
Missing durations and existing infinity tokens remain unchanged. Invalid text is also refused before creating the
artifact; export does not apply the page cell-size limit.
All text and native-formatted Date, POSIXct and integer64 fields are quoted. R's native writer leaves ordinary
numeric and logical values unquoted, so CSV export conservatively restricts delimiters by column type. With any
non-missing values, integer columns refuse `-0123456789`, double and duration columns refuse `.0123456789e+-Inf`,
and logical columns refuse `TRUEFALSE` (each character is a separate delimiter). This includes combinations whose
current values do not contain the delimiter. Comma, tab, semicolon, pipe and other non-conflicting delimiters remain
available. Only matching type/delimiter combinations require a presence scan, in slices of at most 65,536 values;
zero-row and all-missing columns remain supported. Plain numeric NaN retains its empty CSV field, while duration
NaN retains the refusal above. A delimiter refusal precedes artifact creation and does not change source or session
state. Export does not convert ordinary numeric columns to text or change caller formatting options.
POSIXct columns retain native R text formatting, which rounds fractional seconds to six decimal places. Immediately
before writing, the exporter inspects that text in slices of at most 65,536 fields. Only fields ending in invalid
`:60` seconds are reformatted after carrying their original absolute time to the next whole second. The corrected
subset retains the column class and time zone, so date and DST transitions follow native R calendar rules; source
attributes and unaffected text remain unchanged. Formatting stays inside the writer's error handler and failed-artifact
cleanup. Native text can contain only a date at midnight and omits both the time-zone name and offset.
An explicit column time zone is used; a missing or empty zone uses the R process's
time zone, unlike the grid's UTC default. CSV therefore does not guarantee exact timestamp preservation or record
the zone needed to interpret the exported local time. The R CSV format choice displays these limits before export.
Clock columns instead export their exact ISO text, with `Z` for sys time and no offset for naive time.

Native R Parquet export uses Arrow and retains microseconds for POSIXct and nanoseconds for difftime.
Before writing, it scans both types in slices of at most 65,536 values and refuses NaN, infinity, signed 64-bit
overflow or precision loss. Duration values must round-trip between their declared units and seconds.
The check reconstructs seconds from the writer's integer ticks independently of reader rounding. Some reader-created
floating values therefore fail even if that reader previously reproduced them.
Duration output uses an explicit nanosecond type because Arrow's default whole-second conversion truncates fractions.
Refusal leaves the source and confirmed session unchanged and publishes no artifact.
Clock columns export exact decimal ticks through Arrow int64 to a timestamp array with the original precision and
civil/UTC meaning. A present minimum signed 64-bit tick stays distinct from missing. Temporary unique constructor
names preserve duplicate, empty and API-reserved user headers. Zero-column frames use the existing nanoparquet writer
to preserve their row count; Arrow's zero-column writer discards it. This exception does not change the data reader.

Native R charges metadata and cells against a 16 MiB page budget while constructing the page. Response encoding
stays inside the correlated request error boundary: oversized ASCII string expansion is refused before assembling
the escaped response, with a separate 17 MiB cap on the complete encoded response. These are payload bounds, not
an exact allocation ceiling.
Opening and editing still preflight the complete encoded reply before publishing session state.
Replies contain primitive JSON values, protocol records and arrays. Unsupported R classes or attributes and malformed
record keys are refused before publication; user column and nested-field names remain string values.

The host reads private R response and export files through bounded, single-link identity checks. Cleanup moves the
identified file into a private directory and verifies the same file before and after truncating it to zero bytes.
Directory identity uses device, inode, ownership and permissions; its link count can change with directory contents.
Replaced files or cleanup directories are refused and preserved. Interactive workspace notifications are the one
read-only exception: their producer atomically replaces the pathname. A changed read is still rejected, but a
validated single-link replacement on the same device and under the same file ownership, with the old descriptor
now unlinked, can use the existing bounded notification retry without blocking mailbox cleanup. The reader never
returns bytes from that retired descriptor. Observed unsafe types, links or ownership still preserve the mailbox,
and a later successful read cannot clear an earlier unsafe cleanup decision. These checks recognize a permitted
filesystem transition; they do not authenticate which same-user process performed the rename.

#### Cleaning and generated code

Native R pivots preserve retained column IDs and nullability from the confirmed input capture. Their output schema
must match the host's expected schema before publication; a fresh scan must not narrow retained nullability.

Drop Duplicates and dataset duplicate statistics share an exact integer64 comparison owner. All three frame flavors
use temporary decimal text keys, including for the two supported signed extrema. A data.table comparison remains a data.table
so other columns retain their native equality and configured numeric rounding. Original values and metadata remain
intact, and generated row reduction uses the same rule.
Repeated column labels become unique only in the isolated comparison table, so selected column identities cannot
collapse to the first matching name.

Generated Formula and By Example code encode finite double literals from their binary64 bytes as bounded
hexadecimal text, preserving the bound value across platforms. Subnormal and zero spellings use exponent -1022,
and the emitted conversion preserves signed zero when compiled. Integer literals retain integer storage;
public admission rules and generated-code limits remain unchanged.

Generated R preserves exact Unicode in paths, column names and text values. Strings that would require R Unicode
escapes use integer codepoint expressions, avoiding Windows supplementary-character corruption and R's escaped-literal limits.
Extract and Explode share this literal handling for column names and semantic metadata. Their generated schemas retain
every sibling's name, type, factor levels and nested prototypes.

Generated R follows the live operation's native column-metadata behavior at each step. It normalizes element names
on its already-isolated `data.table` result without making another full data copy; Clone, Dense Rank, Mark Duplicates
and Custom Code retain their explicit named-input behavior. This keeps later attribute-sensitive custom code consistent
with the preview.

Generated Fill Missing Values code includes only the helper families used by the complete plan. Repeated and mixed
steps retain each required family once, including scalar datetime and numeric midpoint dependencies.
Median and exact-midpoint interpolation share the native R midpoint owner. Unequal finite pairs use
`base::mean.default` directly, keeping user S3 methods out of the arithmetic; equal-value and non-finite behavior
remain explicit in that owner.
Linear interpolation emits its native subnormal arithmetic helper once and prepares anchor units in the existing
gap loop. Unequal zero/subnormal endpoints use integer multiples of the smallest positive double; the shared
TwoProduct calculation retains multiplication error until final nearest-even rounding. It uses the computed binary64
coordinate weight, not an exact rational ratio. Normal endpoints retain the existing arithmetic and precision limits.
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
functions once when needed, reusing unsigned addition if coarse Round also needs it. Ordinary integer and integer64
sums use bounded native batches; integer64 batches split exact values at 2^32 before decimal combination. Existing
result-range refusals remain unchanged.

Finite Mean Fill, ordinary integer/double Group By means, and numeric profile means share one exact binary64
sum/count owner. It accumulates at most 65,536 values per chunk into two fixed 134-word arrays, using the existing
frame row limit to bound their capacity. Final division rounds once to the nearest double, with ties to even.
Generated cleaning code emits the same functions once when needed. Profiles retain the existing variance calculation;
integer64 means keep their separate arithmetic and conversion rules. The fixed accumulator does not bound all
temporary allocations or eliminate the added scan and per-group work.
Built-in R means and profile medians bypass registered S3 mean methods. Live operations and their generated programs
agree; Custom Code retains the caller's ordinary R dispatch.
Profile medians select their middle value or pair with partial sorting and the same midpoint owner. Exact zero totals
return positive zero; negative results rounded to zero retain their sign. Duration profiles keep their declared-unit
conversion; integer64 conversion, text-length means and variance retain their separate arithmetic.

One-hot encoding derives indicators only from present categories with nonempty labels. Empty and all-missing
duration columns contribute no categories; if no selected column contributes an indicator, the operation refuses
before publishing a result. Other selected columns can still supply valid categories.
One-hot and Multi-label preserve row counts and row-name mode when replacing every original `data.table` column.
Sort Rows, Filter Rows, Drop Missing Rows and Drop Duplicates perform native row subsetting even when all rows remain.
Nonempty base results have explicit row names; tibble and data.table results have positional names. Empty derived
captures retain the input mode. The host predicts this from flavor and the validated full result count, independent
of viewing filters. Generated zero-column reductions perform the same subset as live execution.
Generated One-hot code normalizes text before choosing categories and comparing indicator values, matching live
execution across text encodings. It validates the complete input before formatting distinct category labels.
Multi-label encoding retains its per-row text preparation.

Convert Type to text retains a character output column for empty duration input in both live and generated execution.

Integer64 One-hot Encode retains all native primitive validations but includes arithmetic code only when a Formula
operand in the same plan needs it. Drop Duplicates retains its separate character-comparison binding.

Formula integer text must fit the shared finite 309-digit limit and equal the integer represented by an ordinary R
numeric scalar. Binding derives that integer from binary64 words using at most 35 base-10^9 limbs, rather than using
decimal formatting as an exactness oracle. R's non-missing integer range uses integer storage; other admitted literals
use double storage. `9007199254740993` is refused. This does not add integer64 scalar arithmetic.

Fill offers typed scalar, numeric median, double mean, most-common character/factor/logical value, and ordered same-type
fallback columns. Grouped automatic methods ignore `NA`/`NaN`; all-missing groups and most-common ties stay missing.
Directional Fill uses explicit stable sorting, restores original order and honors maximum missing-run length.
Linear Fill fills native double targets and requires a complete, finite, unique ordinary numeric/Date/POSIXct
coordinate; integer64 coordinates are refused. Native factor, temporal and integer64 storage is preserved. Active data-table keys cannot be modified in place.

Min-max scale preserves exact integer64 offsets until final double conversion; finite double ranges that overflow on
subtraction use halved operands, while ordinary ranges retain subnormal differences. Constant finite ranges become
zero; missing and non-finite values become missing. Round/Floor/Ceiling return doubles for ordinary numerics and exact
integer64 for integer64 inputs, preserving native missing and infinite values. Round uses ties-to-even. Precision
beyond 22 coarse decimal places uses exact decimal digits; precision at or below -309 produces signed zero from finite
doubles. Overflow may produce signed infinity for doubles; integer64 keeps its range refusal.

Integer Group By sums retain ordinary integer or integer64 output and refuse out-of-range exact results. Integer64 mean/median
add in decimal text before final double conversion. Dense Rank appends integer ranks within the existing frame row
bound: missing values stay missing, signed zeros tie and infinities remain present. Mark Duplicates appends a nonmissing
logical flag for every member of a selected-key duplicate group. Both preserve original rows and compatible keys.

Lowercase and Uppercase normalize and convert text in batches of at most 1,024 source rows. They share their
value kernel with generated code and retain R's locale-sensitive case rules. A batch with invalid or oversized text
replays in source order so an earlier output refusal still precedes a later input refusal. Generated failures use
the live error codes and source-row labels. Other text operations retain their own scalar rules.

Text operations accept character/factor input and preserve `NA`; transformed factors become character. Text Length
counts Unicode characters and appends integer output. Split uses a literal delimiter and yields `NA` for an absent
part. Strip uses whitespace or a literal character set. In-place text changes to a data-table key are refused; a new
output column preserves the key and row order. Convert Type retains column identity, supports native character,
integer, double, logical, Date and UTC POSIXct targets, and converts factors through labels. Failed parses become `NA`;
unit or integer64 precision loss is refused. Integer64-to-integer retains integer64 storage; a keyed column must be cloned.

Standalone generated plans run in a fresh `baseenv()`-parented implementation environment and validate the source
before copying. Formula, Format Datetime and categorical helpers avoid caller-defined operator or S3 dispatch.
Custom Code retains ordinary R dispatch and may call packages installed in its captured R environment. Its result may
change between admitted base `data.frame`, tibble and `data.table` classes, with the existing normalization of readr
frames. Output class, column, identity, metadata and allocation validation still precede publication. The original
source flavor remains immutable; the active result, committed state and retained step inputs carry their own flavors
through Preview, replacement, Apply, Discard, Undo, Redo and inspection. Built-in steps preserve their input flavor.
Generated code prepares data.table append primitives when a Custom Code result first needs them.
Publication rejects active bindings before/after evaluation and before
assignment; an original named `open_wrangler_result` is preserved and output uses `open_wrangler_result_2`.
Inspection replays only the selected prefix and transfers code/input/output separately; the host restores exact retained
schemas before publishing bounded pages. Redo revalidates the expected next step and fresh result instead of assuming
old output metadata remains valid.

#### Notebook, terminal and document execution

Notebook work stays in the selected IRkernel. Discovery, selection checks, runtime startup, requests and cleanup
run in fresh environments parented by `baseenv()`. Their implementation functions do not resolve through notebook
globals; `.GlobalEnv` remains the explicit owner of source variables and the shared runtime binding. User functions
and source values remain unchanged.

An existing official R-terminal variable stays pinned to the exact terminal and process that exposed it. Passive discovery reads bounded vscode-R metadata as an untrusted hint and
sends no R command. During startup, it waits within the existing readiness deadline for the selected terminal's
metadata, even if a previous terminal left a record behind. It never reads foreign workspace data. An explicit Open
or Refresh action cancels pending discovery, revalidates the terminal and process, then uses terminal
`sendText` to install or drive Open Wrangler's private dispatcher. When `r.bracketedPaste` is enabled, every dispatch,
including cleanup, uses bracketed-paste framing so terminals such as radian parse the complete expression together.
The setting remains off by default, matching vscode-R. A timeout or cancellation stops waiting for the response;
it does not establish that work in the user's R process has stopped. Open Wrangler never writes vscode-R's files or
silently moves the session to another terminal. On macOS and Linux, trusted `.R`, `.Rmd`, and `.qmd` sources may use
an Open Wrangler-owned `Rscript` process. Windows does not claim this direct document-process path. Literate documents
resolve the owning executor before choosing R or Python; the fence label alone is not authority.

Document execution captures the sole open text document, version and in-memory text before starting `Rscript --vanilla`
in its source directory. Plain R is evaluated once in a dedicated environment; console output stays separate from the
private request channel. The process owns its dataframe sessions and stops after the final panel closes. Its stdin error
listener remains through shutdown; write callbacks report request failure while the exit/stop owner controls cleanup.
Generated insertion rechecks the exact source document/version and complete resulting text. Notebook insertion confirms
one newly inserted R cell in the originating notebook. A terminal has no source document for insertion.

R Markdown/Quarto execution accepts top-level backtick-fenced R cells and bounded first-line YAML. Every source unit is
parsed before enabled cells run in order in one environment, so syntax cannot join across cells. Literal `eval=FALSE`
cells are skipped, including external references; enabled external references, alternate engines, ambiguous options,
indented cells, R-looking fences in opaque Markdown containers and unsupported YAML are refused before R starts.
Presentation options can contain nested calls. Changing knitr defaults cannot change lexical cell selection. Generated
R is appended as a top-level R cell; R Markdown insertion rejects lines knitr would interpret as a closing fence.
Open Wrangler does not attach to render processes or inspect private Quarto/vscode-R sockets or storage.

IRkernel and terminal variables default to Viewing; document sessions use the file start-mode setting. Terminal
startup discovery can use a matching exported workspace tree or bounded no-follow attach/workspace records. A PID,
terminal, path or file-identity change invalidates them. Non-attach records from the same process fall back immediately.
Explicit connection sends one bounded physical-line R expression and installs one callback/mailbox; Open Wrangler's own
requests suppress callback notification. Terminal changes invalidate the session rather than selecting a replacement.
Candidate kernel sessions are identified before dispatch. A failed/stale open retains one bounded close continuation on
the original operation/kernel; detachment does not discard cleanup ownership. Confirmed kernel loss uses the shared
coordinator recovery and never retries the failed user operation.

[ADR 0001: Native R runtime for Open Wrangler 2](decisions/0001-native-r-runtime.md) explains why Native R has its own
runtime and language boundary. The generated reference lists the current operations, and the feature-parity matrix
lists the current limitations.

## Schemas and bounded transport

Every schema that crosses the runtime, host, or webview boundary has non-empty unique column IDs and positions exactly
`0..n-1`. Active, latest-step-input, and applied-step-inspection schemas are validated independently. Column names are
display data; IDs establish identity. Python engines use a private row-identity column for viewing that cannot be named
by any public operation. Its values identify page rows; the column is excluded from visible columns, public schemas and exports.

Semantic column families follow the native outer type. Enum labels, nested child types and timezone metadata do not
change that family; fixed-size arrays remain containers. DuckDB schema, profiles, view validation and value selections
share its existing engine-specific classifier. Known scalar storage wrappers retain their explicit interpretation.

Viewing filters and sorts address columns by name and require a unique, non-empty name. Cell menus, column headers,
profile actions, and the filter panel share that eligibility check. Unnamed columns still support viewing, profiling,
selection, and copy; their name-based actions explain why they are unavailable.

Value choices and profile representatives distinguish exact selection from display text. In `ValueCount`, a typed
`selectionValue` is the admitted filter operand, explicit `null` means no exact selection is available, and an omitted
field retains raw-value compatibility. Native R value lists still require typed tokens at their narrower boundary.
Picker, summary and header actions honor availability without parsing labels.
Unavailable values keep their labels, counts and search behavior; existing saved selections remain removable.
Saved raw selections retain their JSON value identity. Matching text alone does not merge values of different types.
Pandas and Polars prepare profile tokens only for their already-bounded top values, with native temporal precision
retained. The existing filter decoder owns admission; this does not expand its precision or range.

Typed cells are strict-JSON-safe and preserve the distinctions needed by filtering, rendering, saved notebook output,
and engine-normalized transformations. Nested and scalar values pass bounded depth, node, text, and byte validation.
Python mapping output, including bounded Pandas row-index labels, refuses distinct keys with the same text
representation before publication; otherwise, key spelling and insertion order are preserved. This cannot recover
entries lost earlier by native engine boxing.
User-derived keys in extension and webview state are held in `Map` or `Set`, not dynamic object properties.

Python duration scalars use exact seconds at this boundary. Ordinary numeric seconds remain numeric when their
decimal representation preserves the value within the portable microsecond filter syntax; other values use exact
decimal text. Pandas Arrow temporal extrema use the same conversion with their native validity and units.
NumPy fixed units and their multipliers are evaluated with integer ticks. Calendar and unitless durations retain
their display text and cannot be selected as seconds. The duration filter decoder retains its microsecond precision
and Python timedelta range; finer values refuse selection rather than selecting a rounded neighbor. Live and
generated decoders use integer arithmetic independently of the notebook's Decimal precision.
Polars prepares native temporal columns before row boxing so this boundary receives their exact values.

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
The grid reports its rendered column range during layout. If a returned page needs a corrective column projection
for that range, cleaning controls remain unavailable between the two requests. Later scrolling or resizing can
start another projection and temporarily disable those controls again.

Profiles are progressive and bounded. The initial open does not profile all columns, background capacity is limited,
and values or aggregates cross the runtime boundary only as bounded samples or fixed-size results. Header profiles
request columns intersecting the measured data viewport, including partially visible columns. Unmeasured layouts and
offscreen rendering overscan submit no header demand. Summary and
dataset-statistics requests retry once after cancellation, capacity refusal or a bridge failure while their view and
demand remain current. Other errors are reported without an automatic retry. Fresh profiling demand can request them
again. A recoverable session error does not itself imply that repeating the request can succeed. Applied-step
inspection returns bounded pages and replays only the selected prefix without changing the live plan or revision.
If that prefix includes Custom Code, Python and native R retain one inspected input/output pair for the selected
step and revision. Later row and column windows reuse the pair, so they do not execute Custom Code again. The first
inspection can still differ from the original Apply. Ordinary prefixes remain uncached.

The retained pair contains full native frames and must fit memory; page limits do not bound its size. A successful
inspection of another step replaces it, and a revision change, source invalidation or session close releases it.
Runtime response construction must succeed before replacing the pair. Failed mutations preserve the previous valid
pair, except when its source has become invalid. Native R publishes after its own preflight; it has no acknowledgement
of a later host rejection. Step-info requests contain only metadata and do not replace the pair.
Ordinary viewing changes and returning to Current view do not release it. Replacement and mutation rollback can
temporarily retain both pairs. DuckDB plans retain their immutable Custom checkpoints; later inspection windows read
those same rows without re-executing the Custom result.

Native step-inspection and return-to-current-view rows carry their originating session and revision. Their commands
refuse stale or malformed handles before changing inspection. Public `selectStep` calls with a bare step ID still
address the active session; omitting the argument returns that session to its current view.

Saved notebook capture rejects source columns in the private row-identity namespace before constructing its schema
and page, using the same admission check as live sessions.
Automatic inline upgrades use this bounded snapshot owner directly, with a 256-column limit checked before requesting
the captured page. They do not create a temporary live Session, ask for a DuckDB connection or trigger a full notebook
capture.
Cancellation and the publication deadline retire an upgrade immediately; its work slot remains occupied until the
kernel execution settles. Provider selection pauses the publication deadline, which resumes after selection.
Opening a published preview retains its action owner while the user chooses a connection, without timing out that
choice. The captured notebook, cell result and kernel must still be valid afterward.
Saved notebook MIME v2 is one bounded static inline capture. Its caps are 10,000 rows, 2,048 columns, 100,000 cells,
16 MiB, 64 graph levels, and 1,000,000 graph nodes, with separate field-text limits. It is full-width and carries exact
`columnIds`. The inline renderer pages only captured rows and never treats them as a live session, cleaning source,
export source, or fallback. An Open action is offered only for a validated live link and opens the current live value
through its exact notebook and kernel.

Saved MIME-v2 producers retain metadata version 2. The saved-output normalizer accepts that version or its own
already-normalized current metadata, validates the original payload bounds and full saved-only contract, then returns
current display metadata. Legacy saved statistics still require numeric duplicate counts before being discarded.
Repeated normalization preserves the same display payload and receipt hash. This local adaptation does not admit
old live messages or turn a capture into a runtime session.

## Notebook, kernel, terminal, and document provenance

Notebook launch retains the exact open `NotebookDocument` captured at command or renderer-message receipt. Renderer
actions also retain the exact visible sender `NotebookEditor`. At asynchronous launch and execution boundaries, the
host checks that the captured document remains the sole open object for its URI. Python bridges observe the acquired
kernel generation and reject pending results when that generation is invalidated. The host never reacquires an origin
from `activeNotebookEditor`, a matching URI, or another split after work has started.

Python variable discovery retains its exact kernel and observes that kernel's generation through the picker or
cached variable list. Opening a selection rechecks that receipt and gives the new bridge its own observation until
the runtime session is confirmed. Refreshing the list cannot retire an already opened session, and a stale selection
cannot bootstrap or execute against a replacement kernel.

Host-injected Python helpers use a private execution dictionary. Discovery reads the original notebook namespace,
and cell-result inspection reads its IPython history. Helper imports, payloads and temporary results do not replace
or remove user bindings, including when bootstrap or a runtime request fails.

Python bootstrap imports the bundled source into a fresh private directory and retains that directory for the
loaded package lifetime. Reuse requires the exact source digest, the original private directory and matching
locations for every loaded runtime module. Older, partial or mixed runtime imports require a user-directed kernel
restart. The host requires one bounded acknowledgment for its current bootstrap attempt before sending a runtime
request. Failed qualification preserves existing modules, sessions, variables and result handles.

Explicit `show` can emit static MIME from an installed package without establishing its origin for live sessions.
Importing that package before host bootstrap still requires a restart. Recreate the dataframe without importing
`openwrangler_runtime`, then open it through the Open Wrangler notebook toolbar or variable command so the host
loads the verified bundle. Import and use `show` afterward. This order also works when automatic previews are
disabled or another provider is selected; it does not reload or adopt the previously imported package.

On POSIX, the canonical temporary-directory ancestry must be owned by root or the effective user; group- or
world-writable ancestors require sticky-directory protection. Windows notebook bootstrap requires a patched
CPython that creates private directories and the ordinary local per-user `LOCALAPPDATA/Temp` location, with its
OS-protected profile ancestry. Custom, shared, UNC and reparse-point temporary paths are refused. This policy does
not attest arbitrary Windows ACLs or protect a deliberately weakened user profile. The patch-version prerequisites
are listed in the [compatibility notes](../README.md#compatibility-and-limits). No existing cache is adopted or removed.

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
R changes its input mode. Long paths are split into bounded string expressions. Process and terminal paths and
reticulate chunk text share an R string emitter that preserves exact Unicode, including control characters next to
supplementary characters; NUL and unpaired surrogates are refused. JSON mailbox transport remains separate.
Paths must also be representable in the selected R process's filesystem encoding. Reticulate rejects source over the
existing 1 MiB R evaluation limit before quoting and checks the resulting wrapped code against that same limit.
R and Quarto document commands retain the exact editor, document, version, URI, selection, parsed chunk, and resolved
executor across every activation, discovery, picker, execution, and focus-restoration await.

## Persistence and recovery

Persisted state is keyed by both source identity and confirmed backend. The cleaning section contains validated
committed steps, at most one draft, and its confirmed base-view receipt. The viewing section independently contains
the confirmed filter/sort model and bounded presentation state such as stable-ID widths, selection, and viewport.
Opening in Viewing with saved steps or a draft returns `viewing_mode_unavailable` before replay and preserves saved
work. For editing-capable sources, the error identifies the start-mode setting and instructs the user to close the
panel and reopen the same dataframe in Editing. Viewing-only sources receive no unsupported mode-change guidance.
Malformed or stale viewing state falls back to an empty view without dropping valid cleaning. If cleaning replay
fails, the failed runtime closes and Open Wrangler asks before discarding saved steps and the draft to reopen original data.
Dismissal preserves the saved plan for a later retry. An accepted reset requires a valid original session, its exact
source and backend, and an available source-identity receipt. The existing persistence transaction checks that the
saved cleaning still matches the user's choice; newer saved work or retirement before commit prevents the reset.
Failed reset storage preserves the previous recovery record and closes the unpublished candidate. Once a reset
commits, later cancellation does not undo that explicit choice. Normal viewing and cleaning saves then resume.

Native R file sessions use this same source/backend/options persistence key and transaction. Non-base libraries add
the library to the key; base R keeps the existing key so older saved plans remain reachable. The saved state and
confirmed file configuration retain the library through reopening, plan reuse, import changes and recovery. Live R notebook,
document and terminal sessions remain excluded from workspace replay. R files retain the original input schema
before saved steps are restored. A failed replay closes its process; an accepted Reset obtains a distinct verified
delegate before reopening, rather than reusing the retired bridge. Stale or failed candidates close after their native
work settles. Recovery captures the original schema before replay; Reset captures the newly opened original schema.

Confirmed file configuration stores both the concrete backend that produced the session and the user's logical
choice of `auto` or an explicit engine. Recovery pins the concrete backend so an automatic fallback cannot reinterpret
saved operations. A later import-options change may select again only when the retained logical choice was `auto`.
If this configuration cannot be saved, the accepted session stays open and a warning explains that reopening may
use different import options or a different backend.
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

Accepting a recovered view starts a fresh profiling context, even when the source identity, public session ID,
revision and query are unchanged. The host offers the recovered page, metadata, presentation and settled request
outcome together; the renderer accepts them only while their captured session and foreground request remain current.
Accepted replacement clears retired profiles and refreshes rollback state without discarding the originating form or
its error. Native-command errors remain with their caller. A newer local request wins. The host retires its pending
replacement only when the renderer returns the exact offered view context through the existing acknowledgement
path; sending a message alone is insufficient. That receipt also saves the accepted grid placement. Once the complete
view is accepted, ordinary grid presentation updates can proceed while the separate hydration marker is pending.
Full-snapshot synchronization and import transitions retain their presentation lock.
Ordinary session, draft and cleaning-plan publications include their bounded grid view state in the same host
message as the result. Session snapshots also include matching draft presentation when available, excluding code.
The renderer validates these host-only fields separately from the unchanged native runtime response and installs
them together before enabling interaction. A malformed supplied field rejects the complete message. A successful
publication or Code Preview layout change needs only a synchronization marker; it does not replay the snapshot or
restore view state again. Startup, reload and explicit resynchronization still publish a complete snapshot.
An import or backend change with a ready renderer publishes its retained snapshot through final synchronization
before reporting idle. It does not send an earlier copy that would enable interaction before that restoration.
While presentation is locked, the host ignores renderer view-state writes without echoing a later restoration.
After acknowledging the exact current synchronization marker, the renderer sends its current bounded view state
when it differs from the last host-installed state, so changes whose earlier debounce reached the locked host
survive. An unchanged state is not echoed because it could overwrite a host update that follows the receipt. A layout marker preserves an outstanding
full-snapshot lock until its matching acknowledgement. Accepting a runtime replacement retires that old view and
releases its lock; a newer full-snapshot request still acquires its own lock.
Before capturing an authoritative snapshot, the host waits only for an already-committed page's exact panel publication,
including its final persistence write and retained page. It does not wait for pages still executing or awaiting their
first persistence write. Snapshot preparation blocks additional scoped pages, then retires uncommitted page and view
owners before capture. The snapshot carries a host-only offered view identity; scoped ordinary pages resume when that
exact identity returns through the existing view acknowledgement. An older queued receipt cannot reopen admission.
New projection and filter requests can proceed after that receipt, before the separate hydration marker. Native runtime
responses and ephemeral or unscoped page admission remain unchanged; persistence write and rollback rules are unchanged.
The coordinator retains one bounded produced-page reference, sharing its cells rather than copying them and deriving
metadata from its current session. Mutation, runtime replacement and snapshot retirement clear it. If a storage error
leaves that page active, snapshot preparation retains the active page while preserving the error; it does not run a query.
Mode changes disable the switch and workspace and suspend recovery acceptance from the local request through host
settlement. The requested target owns the busy state. A failed mode change can resume the pending replacement;
a successful reopen supplies the new authoritative session. The host releases its completed mode task before
publishing idle, so a following request can start even before that publication's promise settles.
A current page-bearing response supplies the snapshot directly. Recovery through a page-less request uses one bounded
read of the confirmed viewport after active work settles. Renderer synchronization waits for that publication instead
of replaying the retired snapshot or treating the pending replacement as a missing session.
Successful foreground paging keeps its current scroll intent; a changed query starts at the returned page.
A failed recovery read keeps any existing complete view and reports the originating failure or a host warning.
Automatic snapshot pulls do not repeat that read; a new user outcome can make another bounded attempt.

## Trust, source integrity, and export

Python and R execution, dependency installation, custom code, generated-code insertion, and data or script export
require a trusted workspace. Restricted Mode does not expose a hidden affirmative installation or execution path.
Dependency prompts identify the exact interpreter and requirements; only the literal modal confirmation may authorize
package writes. Python uses pip; [local R file repair](#local-files) uses the captured native R environment.
The failed-file panel action rechecks its retained source and backend, then binds the existing install lifecycle to
that exact missing target. Another file cannot redirect the action or make its install count as this file's success.
If dependencies are already available, the panel retries its normal open without installing. Closing the panel or
changing its open attempt invalidates pre-write authorization and reopening; an already authorized install retains
its process settlement ownership. Python also retains post-install environment validation after the panel closes;
R validates before reopening only while the original panel still owns the repair. The global install command still
uses the most recent missing Python target.
Missing-dependency errors identify the captured Python executable, version, selection source and requested engine.
The unmet requirements can be absent or incompatible packages. DuckDB file admission retains its full dependency set,
including fsspec for the reserved export writer and pytz for timezone-aware values. Although fsspec is not needed to
read a CSV, removing its open-time check alone would leave advertised exports without equivalent dependency recovery.
When DuckDB passes its check, the error explains why supporting packages are still required.
A failed engine change keeps its confirmed grid and offers the same install action in the error banner. The host
retains the requested engine with the source, session, revision and open-attempt generation, then rechecks that tuple
before retrying the existing file reconfiguration. A later plan revision can allow an already confirmed installation
to finish, but cannot receive the obsolete engine retry. Installing into a shared environment can stop its runtimes;
the existing confirmed-state recovery handles their next requests.
Custom code is trusted arbitrary code in the selected environment, not a sandbox.

Excel sheet discovery, DuckDB table discovery and trusted Pickle conversion hold a read lease on their captured Python
environment. Dependency installation cannot start while these helpers may still use its packages. Metadata helpers
retain the lease through process closure, including cancellation and failed execution. Their existing timeout and
output limit request forceful termination; early cancellation rejection also terminates a surviving helper through
the shared process-stop owner. An unconfirmed close keeps the lease held. This coordinates Open Wrangler's own package
writes; it cannot prevent another application from changing the environment.

Python dependency status inspects the selected environment without creating an absent installation journal.
It still locks and validates an existing journal, cleans owned abandoned temporary markers, and blocks use when
a retained mutation needs exact validation. Clean status is an observation at that time; the guard does not keep
a lock through later runtime use.

The standalone dependency guard owns the package-version and module-provenance checks used by both availability
and fresh post-install validation. Availability uses its read-only probe, returning one result per dependency in
request order after rechecking the captured interpreter. It neither inspects the installation journal nor runs pip.
After ten seconds the host requests probe termination and retains its flight until the process closes; a late result
cannot turn that timeout into success. Status and installation recovery keep their separate settlement rules.

Dependency availability and post-install validation accept hard-linked regular module files when the supported
version, distribution record and import origin agree. Checks revalidate named ancestor directory objects and the
final module file, refusing symlink or reparse traversal. Unrelated sibling files and directories may change without
invalidating module provenance. Module files retain the existing metadata and link-count checks during each read. These
checks establish installed-module provenance; they do not authenticate arbitrary package code.

Open Wrangler never overwrites source data. Readers validate supported schemes, regular-file identity, and format
options before runtime startup. Lazy readers revalidate the source around each read. Transformations operate on
session-owned state, not the source variable or source file.

Data export and generated-script export require a separate destination. The public script command always uses VS Code's
Save dialog and chooses a Python or R suffix from the active session. Only the extension host chooses or commits the
user destination.
CSV export reuses supported source import settings. Without a supported imported delimiter, TSV file sources default
to tab and other sources default to comma.

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
Python and R export owners attempt rollback once and propagate cleanup failures.

## Webview and accessibility boundary

Webviews receive the minimum local resource roots, a restrictive content security policy, bundle-relative assets, and
scripts authorized by a per-document nonce. Runtime and user-derived content is data, never markup or executable
script. Incoming messages are exact-shape validated and accepted only from the current webview owner. The packaged
Codicon font resolves beside the production CSS, and its exact webview origin is allowed by `font-src`.

UI colors, borders, focus states, and typography use VS Code theme tokens. The grid and operation UI expose accessible
names, full-schema row and column coordinates, keyboard navigation, focus restoration, and light, dark, and
high-contrast behavior. Virtualization changes what is rendered, not the accessible schema or stable column identity.
Editable-field undo remains owned by the field; state-scoped workbench shortcuts are mirrored in the webview and
documented in the generated reference. An open column-actions popup consumes Escape and restores focus to its labelled
summary before another Escape can reach the outer workbench shortcut.
The operation picker initially focuses search when browsing, or settings when an operation is already selected.
Subsequent form changes retain the user's focus choice; opening a preview does not reclaim focus from the host.
Delete confirmation keeps keyboard focus on Cancel; canceling returns it to Delete step. Completing a locally focused
Apply or Discard returns focus to Add step. Delayed cleaning-plan focus restoration stays bound to the same session
and revision and yields to newer focus, including focus outside the webview.
Code Preview keeps its labelled content in the tab order in both editable and read-only modes. Read-only buffers
support keyboard navigation and selection while the editor's mutation guards remain active.
Completed inspection scope travels with the private code message and appears above the editor, outside its document.
It uses the existing inspection snapshot and clears when a host update has no inspection scope or usable generated code.
No-code placeholders comment every source-label line; code actions still require generated code.
When a Viewing session has no generated code, Code Preview and code-action replies explain its cleaning availability.

Pending grid navigation yields to a later focus choice, including headers and resize controls. Virtualizing the
original cell alone does not cancel navigation. Pointer-down, key-down, wheel and click input within the workbench
retires the current column reveal before its handler runs, so later renderer synchronization cannot reclaim focus for it.
That handler may request a fresh reveal; programmatic focus restoration alone does not retire a reveal.
A column-resize drag ends when the host restores view state, the logical view changes, or its controls become disabled;
its own width updates and viewport resizing retain the drag.
Changing the logical view or restoring view state resets cell selection. If a surviving grid cell has keyboard focus,
focus follows the reset selection so Copy and keyboard navigation address the same cell. The reset does not acquire grid
focus from another control.

The grid's existing header measurement reserves space for its compact header, one row and the native scrollbar.
The profiles panel scrolls within the workspace's height; its contents do not determine that height.
It shares the layout with the grid instead of covering it. At narrow widths it sits below the grid, retaining the
measured header and row minimum; shorter editors use the existing outer scroll area.
The workbench can scroll vertically when wrapped controls need more space than a small editor provides. An owned
column reveal also exposes its header and current row in that outer viewport, preserving the grid's inner scroll
position. Selecting the current column again also restores focus to its cell. Later focus choices and window blur
retain precedence. Wide columns expose the available lane beside the sticky row labels; the grid does not require
the whole column to fit in a narrower pane.

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
and [CI](ci.md) records the bounded Cursor check and optional released-Jupyter workflow.

## Related authorities

- [Generated reference](reference.md): commands, settings, operation parameters, and shortcuts.
- [Feature parity](feature-parity.md): current engine status, completed slices, and open release gates.
- [Testing](testing.md): required source, runtime, webview, editor, accessibility, package, and manual checks.
- [Releasing](releasing.md): canonical packaging, candidate qualification, publication, and recovery.
- [Native R ADR](decisions/0001-native-r-runtime.md): accepted native R ownership and release boundary.
