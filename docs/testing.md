# Testing

Prefer the lowest-cost test that exercises the behavior. Keep a higher-level test only when it can catch a product,
package, runtime, or platform failure that a direct test cannot. Keep dedicated security and privacy tests for
credential redaction, no-follow identity checks, sealed artifacts, and exact output-path handoff. Do not keep fixture
or end-to-end tests merely to verify how another test runner, selector, or diagnostic path is wired.

## Direct source checks

While iterating, run the smallest relevant test:

```bash
npx --no-install vitest run src/test/configuration.unit.test.ts
node scripts/run-python.mjs -m pytest python/tests/test_engine_registry.py -q
node --test scripts/package-source-manifest.test.mjs
```

The ordinary source suites are:

```bash
npm run test:scripts
npm run test:ts
npm run test:python
```

`npm run test:scripts` runs the Node tests for release, packaging, licenses, dependency locks, and archives directly
with `node --test`.
The package owner checks in-place corruption and truncation after staging-name retirement, requiring byte mismatch
refusal and owned cleanup. Successful publication retains the verified receipt and exact source-manifest bindings.
The CI scope proof tests use real Git merges to cover exact commit binding, changed paths and modes, shallow history,
and bounded output. They distinguish documentation-only omissions from native R's additional Python-source scope,
and execute the required-result guards with failed proofs, malformed outputs, and skipped or canceled runtime execution.
The daily-preview tests execute the scheduled source check with controlled GitHub CLI responses, covering unchanged
and changed commits, missing history, manual dispatches, and lookup failures.

Use these checks for changed static boundaries:

```bash
npm run format:check
npm run lint
npm run lint:python
npm run typecheck
npm run typecheck:dependencies
npm run protocol:check
npm run reference:check
npm run docs:check
npm run check:remote-jupyter-lock
npm run check:r-dependency-lock
npm run license:check
```

`npm run check` runs those static checks sequentially, and `npm test` runs the three source suites sequentially.
`npm run check:pr` runs both commands for local and protected-main checks. The release-candidate workflow starts from
protected main after these checks pass and does not repeat the source suites.

For stable-channel source, `docs:check` permits incomplete capabilities in the source ledger while validating its
canonical rows, status and backend availability labels, and tracked evidence. The canonical artifact tests prove that
the same incomplete ledger still blocks stable qualification. Release requirements are in [Releasing](releasing.md).

`npm run test:extension-host` builds the development extension and runs persistence seed and verification in separate
editor processes sharing one private profile. Seed checks same-process close/reopen state and cleanup; verification
checks persistence after editor restart, rendered recovery, and the remaining file and notebook journeys.

The persistence store, response committer and coordinator persistence owners control storage ordering to exercise
presentation saves during publication, late queued saves, rollback and recovery. Coordinator tests also distinguish
live selection, widths and viewport from durable recovery state after sequential and overlapping failed saves. They
verify later successful saves, close/reopen, and unchanged warning and diagnostic behavior. The existing installed quick-sort
journey records bounded sort and owner state only on failure; its DOM observation stays pinned to the original
session and renderer and has a separate one-second diagnostic limit.

The App inspection owner checks that deletion confirmation belongs to the selected step. Switching targets requires
a fresh confirmation, while paging within that step preserves it; Cancel returns to the ordinary actions.

Installed Pandas journeys with duplicate or non-string column labels execute emitted value, row, structural,
By Example and Group By plans in fresh namespaces. They compare complete values, physical labels, dtypes and native
indexes, while retaining source, input, stable-reference and replay assertions.

R kernel-restart journeys open an editing session before committing the step whose restart behavior they check.
Their enclosing configuration owner restores the prior notebook setting on exit.

For Native R changes, run the full contract suite or the relevant group:

```bash
npm run test:r-contract
npm run test:r-contract:frame-and-interactive-transport
npm run test:r-contract:catalog-and-process-transport
node scripts/run-r-contract-tests.mjs --shard kernel-agent
npm run test:scripts:native
```

The grouped commands keep real-R process tests serial while separating frame and interactive-transport, catalog and
process-transport, and kernel-agent failures.
Nested Rscript contract programs use the existing warning assertion inside the child process, so an unexpected
warning fails even when the child handles a later error. Their fresh-process isolation and original assertions remain.

The full R command first runs the native process contracts. `test:scripts:native` selects Linux cancellation or
Windows Job Object behavior on the current platform; ordinary Source tests do not require this native owner.
Linux R phase supervision uses the selected repository Python's standard library and kernel pidfds. It requires
Python 3.10–3.14 with pidfd support, but no Python dataframe packages. The runner checks this capability before starting
a phase and verifies each target's exact phase marker and process identity before signaling through a pidfd.

The Linux contracts exercise actual child and detached-descendant exit for SIGINT, SIGTERM, deadlines, output limits,
closed output readers and escalation. An unverifiable live target leaves the overall phase unsettled even when other
verified targets can be stopped. macOS still reports unverified settlement when it lacks a safe signaling mechanism;
cancellation there remains unresolved. Parent SIGKILL or a runner crash is also outside this shutdown guarantee.
These limitations are tracked in [#955](https://github.com/Matt17BR/openwrangler/issues/955).

The runner handles default stdout and stderr errors through the existing failure and verified cleanup path.
A destination error or cancellation stops later phases without waiting for other pending output. Successful phases
drain their output after child settlement and before continuing, retaining normal reader backpressure. Destination
listeners remain owned until pending callbacks and queued errors settle. This does not bound process exit when a
reader stays open without consuming output.

The native-view source tests cover lifetime provider registrations, forwarded tree updates, and session-pinned code
insertion. They also check that unchanged validated generated text avoids another source-validation scan, while
changed and invalid text still reaches the validator. Lazy-owner tests distinguish pending, loaded and absent
notebook snapshots; the installed R terminal
journey checks that closing the terminal restores the idle R action. The existing App component tests retain
DOM-before-acknowledgement and mismatched-marker integration
coverage; timing and retirement behavior is owned by the renderer lifecycle tests. Native R Group By and Fill Missing
contracts execute generated code for midpoint edge cases alongside live execution. Their existing owners cover tiny
ties, the normal/subnormal boundary, finite extremes, source preservation and Undo. Direct frame tests also check
signed zero and bypassing user-defined S3 mean methods. Non-midpoint interpolation counterexamples stay
separate from the midpoint guarantee.
The existing native R Group By owner compares typed empty results across base dataframes, tibbles and data.tables.
It also executes complete generated programs in fresh R processes to check integer64 first/last outputs and exact
wide keys without a preloaded bit64 namespace, retaining source and result-publication assertions.
It also checks exact-sum helper admission and reuse across repeated Group By and coarse Round steps, with complete
generated execution isolated from caller arithmetic. Existing frame and kernel owners verify signed cancellation
across multiple integer batches; the profile owner covers the unchanged live consumer of those functions.
The existing R Fill, Group By, profiling and Custom Code owners register and restore numeric mean methods to check
built-in isolation and intentional user-code dispatch. Live results and complete generated programs must agree.
Profile controls cover small and chunked even medians, text lengths and unchanged fields; primitive checks retain
signed-zero and nonfinite median behavior that JSON cannot distinguish.
R interactive transport tests also execute the real dispatcher in a fresh Linux PTY with canonical input and in a
ready PTY. Portable R tests check one-expression parsing, exact long escaped values and full physical-line byte bounds.
Native R child fixtures retain the caller's temporary-directory settings. Private Spark notebook fixtures use
Python's selected temporary directory for native Spark storage too; Java's default may otherwise select a full
filesystem. Spark fixtures refuse temporary paths containing commas, which Spark interprets as separate roots.
The editor environment allowlist and native cleanup owners remain unchanged.

Grid clipboard, resize-lifecycle and App column-projection component tests own delayed page focus and interrupted
column drags. They distinguish newer focus from removal of a virtualized cell, and host restoration from a drag
publishing its own widths. Existing range-selection and column-reveal controls retain their focus behavior.

Native R response tests cover aggregate ASCII string expansion, exact scalar and explicit-array output, and Unicode
under normal and C locales. The real process owner verifies an oversized valid page returns a correlated error and
accepts a smaller page in the same process. Existing opening and mutation preflights retain their state assertions.

Panel tests hold Code Preview focus open while forcing another renderer synchronization, discarding the draft,
changing the reveal setting, deactivating, or disposing. Installed operation journeys acquire the exact acknowledged
receipt after layout settles and retain its session, revision, and DOM marker checks.
App draft-state tests own failed and cancelled preview feedback for new and edited operations. They assert an
accessible alert inside the submitting dialog, retained input and confirmed data, correction and resubmission, and
cleanup on operation or session changes. Host Undo errors remain a separate workspace-owned control.
The same App owner checks that removing an edited step closes its dialog and restores focus while failed Undo,
surviving edit targets and new-operation forms retain their input.
Operation Builder and Fill Missing controls check explicit repair of unavailable column selections, optional All
semantics, retained valid selection order and names, controlled grouping, and search recovery after schema changes.
The App owner checks that failed Undo retains selection and successful Undo cannot silently broaden a retained
Drop Missing form to all columns; unrelated form input survives repair.
Single-column cases cover removed targets after Undo, type-incompatible targets, explicit repair, retained input, same-ID
renames and eligible targets returning. The control owners distinguish a controlled empty value from an uncontrolled
form receiving its first available default.
The same UI owners check Redo after the last Undo, focus ownership, draft/projection gates and exact attempt
correlation before success or failure can settle a mutation. Panel controls verify that an empty-history refusal
also clears the snapshot used on remount. Native session and transaction owners check ordered re-execution,
branch clearing, draft retention, current viewing state, stable column binding, generated results and response
preflight rollback. R's kernel and bridge owners additionally check host/native step identity and fresh dynamic
output contracts. Runtime replacement is tested separately from failures that retain the original session.
The existing file reopen journey exercises the registered Redo command after the last Undo. Live Python Formula
and native R core-editing journeys use the visible button and compare the restored plan, schema, code and bounded
page before returning to their original final state. The Pandas By Example owner also executes the redone plan's
generated code with its existing value, dtype, label and index comparator.

`python/tests/test_generated_output_columns.py` owns static output-name agreement between public binding and
standalone generated Python across Pandas, Polars and DuckDB. It checks occupied outputs, harmless extra columns,
replacement of the selected source column, canonical Pandas labels, earlier steps and Custom Code, lazy metadata
inspection, private-connection Rename chains and long-name code capacity. DuckDB cases cover case-insensitive input
and intermediate collisions, categorical output pairs, and public Clone or Custom Code plans whose later Formula and
Select steps could otherwise conceal a wrong-column result. Case-only Rename and case-distinct Pandas/Polars outputs
remain valid. Existing Regex, Split and Pivot owners retain their stronger validation; session transaction tests retain
exact generated-size and pre-transform rollback checks.

Coordinator recovery controls stop later replay requests after trust changes. Python bridge and transport owners
retain cancellation correlation before dispatch, including synchronous listener registration, without losing
request leases or treating unstarted work as an ambiguous mutation.
Bridge and process transport owners exercise actual Writable error events after failed writes. They check request
rejection, authoritative Python cancellation responses, late retired-stream errors and exact process cleanup.
The existing Python server-protocol and kernel-agent owners check native panic error correlation, retained state,
follow-up requests and close. They distinguish the loaded native exception from caller interrupts and changed
public aliases, and retain optional-import, cancellation and request-registry cleanup controls.
The installed R Formula journey verifies a visible precision refusal, retains the input, and corrects that same form
before continuing its existing preview, apply and undo assertions.

The native R `text-fill-and-cast` kernel contract also executes mixed Fill plans and datetime replacements, checking
that generated code includes each required helper family once and omits unused families.
Mixed literal and regex Find and Replace steps check independent replacement state, one shared generated regex
function, complete live/generated results and source isolation despite conflicting caller functions.
Directional Fill plans include Custom Code, typed and empty columns, named elements, and keyed data tables. Preview,
apply, and inspection code must preserve complete live results and source frames despite conflicting caller names.

Native R frame export controls check exact C-locale CSV bytes across frame families, including Unicode headers,
factor labels, quoting, missing values and text beyond the page cell limit. Invalid off-page text and writer failures
must leave no artifact. The existing kernel export owner verifies the returned UTF-8 chunks and unchanged source.
Parquet timestamp controls distinguish correct physical microseconds from reader-only rounding, retain native
bytes for exact values, and refuse precision loss, non-finite values and range overflow. The kernel owner checks
an invalid value beyond the first validation slice, correlated refusal without an artifact, and successful correction,
generated execution, export and Undo while preserving the source.

The native R catalog also compares complete live and generated frames with named column elements across supported
frame families. Mixed cleaning and Custom Code plans verify that metadata differences cannot change later values.

Native R categorical owners check empty and all-missing duration columns with both source-column retention modes.
Public refusal preserves the session; standalone generated refusal preserves its prior result binding. A mixed
duration/text case checks Preview, Apply, generated values and Undo against the original source.
C-locale controls verify equivalent text encodings, first-seen signed-zero duration labels, and mixed One-hot and
Multi-label plans with character or factor input. They restore the locale and preserve exact source storage.

The existing Cast plan checks duration units, signs and missing values, then executes its complete generated program
on typed-empty and all-missing-duration inputs. Full-frame comparison includes output types, row names and source storage.

The existing scalar-categorical kernel case verifies that integer64 One-hot Encode omits unused arithmetic code,
retains primitive validation, and includes the arithmetic dependencies needed by a later Formula's right operand.

Native R frame tests own exact integer64 duplicate masks and bounded profile counts, including supported signed extrema mixed
with adjacent large values and missing keys. Data.table controls distinguish repeated column labels and retain
ordinary numeric rounding at settings 0 and 2.
The existing row kernel owner
checks single and composite keys through Preview, Apply, inspection, Undo/Redo and standalone generated execution,
including original row identities, frame metadata and integer64 helper admission.

DuckDB engine tests compare retained scalar and nested values, zero signs and native types for every duplicate keep mode
in live and generated results. Reused generated Drop Duplicates and Mark Duplicates programs must reject missing
selected keys, including case and suffix variants of internal ordinals, while retaining valid helper-named keys.
Session transactions own the corresponding preview/history and source-preservation assertions. The same DuckDB
engine owner covers complete generated programs that refuse an erroneous intermediate before a later projection,
preserve private-connection Rename plans, and leave empty plans unchanged. Session
transactions cover native errors outside the requested row or column window, retained state after refusal and
successful correction. Native complex-value and empty-result controls keep the result check compatible with valid frames.
Mark Duplicates controls require one source evaluation per retained validation query and later retrieval. Private
Rename, Select Columns and Drop Columns controls require no added result hash while preserving native values, types,
source identities and connection ownership. Their session cases cover Preview, Apply, generated output and Undo;
computed Formula and Custom errors must still refuse before a later Drop. Grouped Fill controls distinguish lazy plan
construction from refusal during live result validation or generated execution.
Generated Sort Rows controls compare all columns, native types and stable ties with nulls, including helper-name
collisions, case-insensitive keys, extra input columns and a preceding Rename. Missing ordinary or helper-named keys
must fail. A public CSV case compares Preview, Apply and the returned program while preserving the source bytes.
The Pivot Longer and Pivot Wider owners check requested outputs named like temporary columns, including case and
occupied-suffix collisions, native types, nulls and row order. Their public CSV cases compare visible metadata and
page cells through Preview, Apply, returned-code execution and Undo. Reused Pivot Wider programs must reject missing
value columns across each helper-name family while preserving valid private-connection results and caller catalogs.
Multi-label engine controls cover inputs named `label`, case variants and an unrelated same-named column in live and
generated code, retaining null/empty-label handling, output types, row order and private-connection ownership.
The engine owner also executes complete generated programs on private connections, checks caller catalog preservation
and earlier lazy results, and covers collision and cleanup failures. Custom Code cases retain its module namespace
while keeping generated query helpers private. The same controls run on the minimum and current DuckDB versions.

Polars engine and session transaction owners check hidden Custom expression errors, confirmed-state preservation and
successful correction. Complete generated programs refuse an invalid Custom result before a later step drops its
output. Native eager/lazy values, types, nulls and source preservation remain covered; the existing Custom Code owner
checks Series normalization and scalar refusal. Ordinary lazy plans retain deferred execution, and the large-notebook
journey keeps its bounded collection assertions through viewing, editing and export.
Floor, Ceiling and Round owners check exact Decimal coefficients, nulls and signed carry boundaries through eager
and lazy streaming results without changing caller configuration. Session transactions cover file-backed Preview,
Apply, returned-code execution, counts, stable row IDs and Undo with hidden or off-page values.

`python/tests/test_custom_code_scope.py` owns Pandas/Polars Custom result admission in live sessions and complete
generated programs, including retained conditional plans reused on another input and a later step that could hide
an invalid zero-column result. It preserves typed empty results, Series and first-column creation. The existing
plan-size owner checks the shared emitter's exact byte contribution; zero-column viewing and row-operation owners
retain their separate contracts.

Pandas duplicate owners cover nullable Arrow integer and temporal precision in live and generated row removal and
dataset counts. Their controls retain exact original values and indexes, ordering, directional Fill, time-of-day
nanoseconds and ordinary object missing-value distinctions. Present minimum temporal storage values remain distinct
from real nulls. Public Parquet sessions verify the same comparison through Preview, history and export.
Sparse integer profile controls preserve exact neighboring values, fill conventions and missing counts, including a
public Custom Code session whose dataset count must agree with Drop Duplicates.
Missing-cell totals are checked against per-column counts for multiple Sparse columns and mixed Dense/Sparse frames.

Native R frame and catalog owners cover constructor and subset forms of empty tables, operations and Custom Code
that return no rows, and malformed zero counts with nonempty columns. Generated input and output validation retain
the same structural assertions.

The existing R process export case also edits its zero-column source through first-column Custom Code, inspection,
Undo and Redo. Decoder tests distinguish an explicit empty schema from missing context on both inspection sides.
Native kernel owners compare live and generated first-column results and zero-column row reductions while retaining
the nonempty Custom Code output requirement and stale-reference and maximum-width refusals.

`python/tests/test_dense_rank.py` owns exact live/generated numeric ranks across the Python editing engines.
It covers ties, direction, missingness, native integer/decimal boundaries, source and index preservation, and
DuckDB's current input order. Existing session owners cover stable output identity, viewing-independent population,
preview/apply, Undo/Redo, retained history after refusal and export/reopen. Native R frame, kernel and process owners
cover its integer result contract, supported frame flavors, exact integer64 values and a rank-first generated plan.
Operation-builder and shared-validator owners check duplicate-label selection, direction, saved-step compatibility
and malformed public parameters through the existing form and admission paths.
The installed operation-group journey checks ranks after a cleaning sort and runtime replay in each Python engine.
The default comprehensive R notebook journey's core catalog submits the visible rank form and checks bounded pages
across its full input before Undo. The focused `core-operations` selector retains its separate Clone lifecycle scope.

`python/tests/test_mark_duplicates.py` owns live/generated Boolean membership across the Python editing engines,
including native key equality, empty and missing populations, exact retained values and source/index preservation.
Existing session owners cover hidden matching rows, output identity, history and export. Native R frame, kernel and
catalog owners check logical capture, selected integer64 keys and named/keyed frame metadata. Shared and operation-form
tests cover required selections, stale references, output names and saved-step editing through the existing owners.
The installed Python operation-group journey checks flags after a cleaning sort and replay. The existing Polars
first-use journey also previews and applies Mark Duplicates, checks a visible `False` cell, and undoes it before continuing
the export flow. The default comprehensive R notebook journey submits the form, checks a visible `TRUE` cell and bounded
original values and flags across both groups, and verifies Apply and Undo without changing the source notebook.

`python/tests/test_min_max_scale.py` compares live and generated scaling for finite extremes, subnormals, exact
integers, decimals, missing values, and source identity in each Python editing engine. Native R owns the corresponding
double and `integer64` cases in `r/tests/complete_catalog_contract.R`. Export replacement races belong in
`python/tests/test_configurable_export.py`, where native writers must leave replacement files unchanged.

Export owner tests use actual files to cover source renames and replacements before and during command awaits.
Coordinator tests cover source identity across initial open, runtime replacement, rollback and live-variable recovery,
including Python Interactive's originating document. Recovery and state-restorer owners check Close during replay,
stale viewing fallback, and detached execution settling before candidate cleanup in recovery and initial saved-view
restoration. Ordinary replay remains covered.
The existing atomic-file tests retain destination and temporary
identity checks; runtime writers retain their separate output-handle contracts.
The export-target owner also reserves a file through Node and passes its actual identity receipt to the Python pinned
writer, checking both writing the reserved file and refusal of a mismatched receipt on each platform.
DuckDB Parquet owners cover exact 128-bit integer conversion, native overflow, nested-type refusal, null/empty
inputs and unchanged ordinary fields. The file-session Group By journey exports both committed data and the
actual generated cleaning result, then checks native readback and source/session preservation. Temporal export
cases cover interval precision/capacity, nested containers and TIMETZ map lookup identity through native writers at
both dependency endpoints. They retain correct UTC and `24:00` cases where the selected writer supports them, and
check refusal after a valid row alongside source, session and pinned-target identity preservation.
The installed plain R journey checks descriptor-scrubbed, zero-byte private export artifacts and removal of their
owned process root when the session closes.
R notebook source-integrity checks also verify that no active export artifacts remain before the session closes.

`python/tests/test_round_number.py` executes live and generated Round across the Python editing engines, checking
negative and extreme precision, midpoint neighbors, exact integer and Decimal carries, output capacity, storage types,
masks, signed zero, and source identity. Arrow Decimal cases validate native readback and CSV/Parquet export; object
Decimal cases change the caller's context before execution. Native R's catalog owns its corresponding numeric cases
and executes them under altered display options.
DuckDB unsigned 128-bit controls exercise exact capacity refusal, valid neighbors, nulls and empty results. Session
transactions verify that a failed Round preview retains the previously committed plan and data.

Native R frame and catalog owners compare picker raw values with distinct source values before filtering them.
Adjacent doubles, finite extrema, signed zero and temporal payloads cross actual JSON preview and generated execution.
Rejected numeric previews must preserve the complete confirmed response. Direct numeric Fill and public text-only
replacement controls retain their separate boundaries.

Python protocol tests own the request-enum and present-null option matrix, including valid omission and clone controls.
Live protocol owners reject v2 traffic and retain correlated recovery with v3. Shared schema and response validators
check explicit unavailable duplicate counts and reject a sample size with that state; R host guards retain numeric
counts. Pandas statistics owners cover native composite-container refusals, including sets, exact missing counts,
filtered views, source preservation and unrelated error propagation. Both Dataset displays distinguish unavailable
from pending data.
The existing Polars statistics owners cover partial counts for lazy Object columns under default and streaming
affinity, retaining exact missing metrics, empty results, source/view ownership and scalar collection bounds. They
verify that this path avoids unique grouping while ordinary and eager statistics retain their behavior.
Kernel and standalone owners check representative `invalid_request` refusals before native dispatch and a valid
follow-up in the same process. Python protocol and kernel tests also check malformed viewing structures before native
query work, including correlated errors and retained session state. The native R viewing owner sends raw JSON to distinguish
objects from arrays, retains a draft after malformed page input, and compares valid Filter Rows output with generated
code. Python opaque operands and R nullable picker search keep their separate valid-input controls.
Python operand cases cover depth boundaries, finite wide integers, non-finite numbers and Unicode in values and
keys. The existing standalone protocol owner checks correlated refusal and a valid follow-up in the same process.

Floor and Ceiling cases in `python/tests/test_operation_edges.py` and `python/tests/test_duckdb_engine.py` compare
exact native integer/Decimal results, Arrow validity, scalar coercion and nested-type controls with generated code.
`python/tests/test_operations.py` owns Pandas integer-cast range and coercion checks;
`python/tests/test_session_transactions.py` verifies confirmed-state rollback after a rejected cast.

Python page-publication tests cover native materialization refusal, metadata and correlated-envelope failure,
source invalidation, request-scope exit, profile leases and exact row-count discovery. Spark continuation controls
retain the old view's anchors through a rejected replacement page, including a cached first block followed by a
native continuation. Accepted pages retain the existing page and complete-frame allowances.
Late background invalidation is serialized with page publication, including reentrant cleanup with a queued writer.

Formula's arithmetic limits and engine-specific behavior are defined in [Engine boundaries and
capabilities](architecture.md#engine-boundaries-and-capabilities). The owners below compare live and generated
execution, exact values and native types, missing operands, source preservation and expected refusals.

`python/tests/test_formula_literals.py` owns canonical integer text and file-session Preview, Apply, saved-plan replay
and standalone execution across Pandas, Polars and DuckDB. Text entry and request validation belong to
`operationBuilder.component.test.tsx`, `operationParams.unit.test.ts` and
`protocolRequestOperationValidation.unit.test.ts` under `src/test/`.

`python/tests/test_polars_engine.py` owns scalar capacity, integer and Boolean operand checks, eager/lazy behavior,
helper isolation and bounded validation. Its public-session cases cover hidden-row refusal and saved plans replayed
after a source type change. Its UInt128 column arithmetic cases distinguish correct execution on the current version
from refusal before publication on the minimum version. They also check recovery, scalar operations and generated
code.

`python/tests/test_operation_edges.py` owns checks for exact Pandas integer results, including Boolean companions,
Sparse storage and native power identities with missing operands. The same file owns Arrow integer modulo and eligible
integer/Decimal capacity repairs. These cases compare actual operand pairs, preserve missing values and retain correct
native results and existing refusals. Multiplication cases cover signed and unsigned result capacity, chunked and
null-paired operands, duplicate indexes, native type retention and custom-extension exclusion. Subtraction cases
also cover signed/unsigned operand order, negative results, scalar underflow and existing overflow diagnostics.
The existing public capacity journey checks signed-result Preview, Apply, complete generated code, Parquet readback,
Undo and Redo, plus refusal beyond the displayed page. Mixed Formula, By Example and Custom Code programs check helper
isolation without changing the other operations' behavior.

`python/tests/test_duckdb_engine.py` owns fixed-width integer promotion checks in both signed/unsigned operand orders
and protection from caller-defined macros. Its cases with volatile inputs distinguish metadata inspection from
readiness and later retrieval, checking the operand pair used by each evaluation. Complete generated programs must
refuse before a later projection can discard an erroneous Formula result. BIGNUM multiplication and modulo cases
cover both operand positions, the signed 128-bit bounds, unsigned counterparts, native identities, missing values
and the distinction between precision loss and an unavailable exactness check. They retain native result types and
compare complete generated programs under the same finite policy; they do not establish general BIGNUM editing.

`python/tests/test_session_transactions.py` owns Pandas and DuckDB refusal for rows beyond the previewed page,
preservation of confirmed state and Redo history, successful correction and replay. Its Arrow cases also verify
viewing, reported/replayed dtypes and exact Parquet readback. The Polars public-session cases remain in its engine
owner above.

Native R's `r/tests/kernel_agent.R` and `src/test/rKernelTransport.cross.test.ts` own literal precision and complete
generated execution, including the finite 309-digit endpoint. The kernel's missing-power
case compares the captured native vector, wire cell kinds and generated result.
`src/test/rKernelTransformBinding.unit.test.ts` and `src/test/rKernelMutationSchema.unit.test.ts` own exact text
retention and type prediction.

Typed-cell tests check timestamp text, fractions, offsets and exact instants for UTC, minute and second offsets,
including historical Berlin. They cover native timestamp units, nested values, ordinary datetime subclasses and
Parquet session pages, profiles and value choices while preserving source values. Search controls retain duration
representations, equivalent-value spellings and exclusion of unsupported numeric residents.

Typed-cell tests distinguish present Arrow temporal extrema from nulls in projected pages, profiles and value choices,
including dictionary null entries and chunk boundaries. Fill tests compare exact native donors and directional anchors
with standalone generated execution. A Pandas Parquet session checks filtering, Preview, Apply, Undo, Redo and retained
source bytes. Existing object missingness, timezone compatibility and unsupported Fill refusals remain covered.

Pandas engine tests load native Arrow dates from Parquet and check profiles, value selections, viewing and
standalone Filter Rows/Sort Rows. Empty, missing and distant dates retain native storage, indices and source bytes.

The Pandas filter owner checks native, nullable, Arrow and Sparse integer boundaries through actual value selections,
viewing and standalone cleaning code. Typed-cell tests cover logical Arrow dictionary profiles and queries, unsigned
indices, null codebook entries, multiple chunks and encoded source isolation. Operation-edge and Fill tests exercise
row removal and directional ordering on mixed dictionary/Sparse frames, including exact values in unselected columns.
The operation owner checks native output dtypes and existing refusals for dictionary casts through session preflight,
live execution and standalone code, including empty/all-null inputs and unsigned values beyond the signed target.
Fill tests cover dictionary targets, ordered donors and grouping keys, native Arrow dates, unchanged no-op storage
and complete-column literal validation. Mixed plans retain source arrays and exercise helper-name collisions.
Configurable-export tests use real pinned writers for scalar dictionary columns and indexes, compare physical CSV
and Parquet values with logical controls, reopen exported columns, and check unchanged source storage. Wide integer
index assertions inspect physical Parquet values separately from Pandas index reconstruction.
The index-fidelity owner reopens nullable integer indexes through file sessions and checks exact row labels, native
metadata, unaffected columns and index levels. Real file rewrites between the ordinary and supplemental reads must
refuse publication and close the descriptor, including equal-size changes with restored modification times.
Group By, Pivot and Fill owners compare Arrow/nullable floating keys and aggregates with native controls, including
NaN, nulls, signed zero, infinities, chunks and unrelated missing groups. Half-float Count and Sparse Sum controls
protect existing finite-value paths. Standalone grouped Fill includes only the floating key helper it needs.
Sparse Count regressions cover missing values, counts beyond narrow integer storage, shared exact aggregates and
columns also used as keys. Assertions retain native source values, Sparse positions, axes and attributes.
Group By, Pivot and Fill owners also check exact Sparse key partitions, restored labels, multi-key missing groups
and generated execution. Minimum-version fractional fills have explicit native-construction controls on current
Pandas. Ordinary integer, nullable, Arrow and object keys retain their output-type policy.
Mixed-object numeric regressions compare picker values with original source scalars before selecting them.
The typed-cell, grouped numeric, session-transaction and configurable-export owners cover finite NumPy extended
floating values that cannot round-trip through binary64. They check precision and range refusal, representable and
nonfinite controls, generated key preparation, confirmed-state rollback, safe projection, exact CSV and explicit
conversion. Tests use the platform's actual extended precision and skip unsupported native storage cases.

The existing filter, typed-cell, Group By, Pivot and Fill owners cover hash-colliding NumPy floats and wide integers,
exact ordering and counts, original representative types, joint Pivot identifier rows, missing values, and standalone
helper closure. Unhashable containers, custom numeric subclasses and ordinary native columns retain their existing
behavior. Filter UI and shared-protocol tests check exact typed text, restored selections and null/NaN choices.
Typed-cell tests also compare native Arrow `bool8` and UUID pages, profiles, selections and compatible cleaning
operations with logical native controls. Executed generated code must preserve source arrays and agree with live
results, including no-op Fill and direct copies. A one-row page with a large dictionary codebook verifies that
adding known scalar conversion does not decode unused string payloads.
Schema nullability controls distinguish null indices, referenced and unused null codebook entries, empty chunks
and different codebooks while forbidding payload decoding.
Configurable-export and index-fidelity owners exercise native `bool8` and UUID CSV/Parquet values, preserved and
omitted axes, equivalent Boolean labels, and external extension Parquet files. Ordinary conversion settings and
invalid metadata retain native behavior. Rewrites around schema and data reads must refuse publication and close
the source stream, including equal-size changes with restored modification times.
The index-fidelity owner also loads nullable integer data and integer-bearing list, struct and map fields. It checks
exact pages, complete profiles, value choices, Clone and standalone execution, physical export, Undo, empty and
missing containers, unchanged metadata and siblings, and a single combined data/index repair projection.
Container controls compare exact single-column duplicate counts and live/generated Drop and Mark results, including
repeated empty values and nondefault row indexes, while preserving original Arrow storage.
Object-UUID controls use actual file writers and public session preview/apply/undo. They check canonical picker
counts, null/NaN selections, stable physical rows, standalone sort/deduplication, direct-copy identity and unchanged
unrelated objects. The existing export owner checks canonical CSV/Parquet values and preserved or omitted axes.

Polars and DuckDB engine owners exercise misleading enum labels, nested types, fixed-size arrays, profiles, typed
selections and standalone Filter Rows. Typed-cell controls preserve Arrow scalar wrappers and Pandas Sparse behavior;
the existing Spark Classic/Connect owner covers native schema, bounded paging, filters, sorts and profiles.

The DuckDB engine owner checks literal selected-file imports for CSV, TSV, JSONL/NDJSON and Parquet beside matching
and escaped-looking siblings. It covers native rows and types, import options, ordinary and empty files, generated
cleaning, source preservation and explicit unsupported-path refusals. The existing Windows job selects these same
cases for actual local-drive coverage; lexical UNC/device checks do not claim network-share execution.

Polars file owners read actual JSONL/NDJSON files beside misleading encoded siblings and escaped-path directories.
They check selected rows, native lazy projection, standalone transformations and source replacement refusal. Unix
tests retain native reads after the Python stream closes and exhaust descriptors only inside isolated child
processes, where fallback buffering, empty-plan publication, panic diagnostics and leaked handles fail assertions.
Windows dispatch tests are separate from actual Windows local-drive verbatim reads, live/generated operations,
source-replacement refusal and explicit glob-path refusal.

`python/tests/test_generated_helpers.py` owns canonical helper selection, dependency references, and source-library
isolation. The existing DuckDB and Fill Missing Values tests execute the selected standalone programs. Polars Fill
coverage includes eager and lazy mixed plans, transitive dependencies, and Custom Code before and after filling.
Grouped median cases check native integer widths and Decimal precision on current and minimum Polars, including
empty and null-key groups, exact refusals, and streaming execution. Plan construction must not collect lazy input.
Integer-adapter tests synthesize public By Example programs with UInt128 operands, empty/null batches and multiple
chunks. Live and generated results retain Int128 and existing overflow refusals. Encoder edge tests cover native
explode behavior on both dependency endpoints, including empty and repeated labels.

Kernel response tests cover split markers and Unicode, exact byte limits, output outside the frame, malformed
responses and execution settlement after decoding fails. Bridge tests verify that cleanup waits for the original
execution and that valid noisy responses still publish their correlated state.
The existing decoder also checks fixed restart guidance for a correlated old-protocol envelope without admitting its
response. Saved-output and renderer-message owners retain metadata-v2 fixtures, immutable normalization to current
display metadata, repeated Open/inline receipt handoffs, original bounds and legacy-statistics validation.

Discovery and bridge tests exercise kernel replacement during pickers and initial bootstrap, including retirement
before a session opens. R command tests cover terminal replacement during previous-transport cleanup. FilterPanel
component tests own checkbox membership, saved scalar selections, unnamed-column navigation and staged-sort column
ownership. Sort controls cover schema changes, permanent retirement across Undo, unaffected rules, confirmed-model
resets, dirty empty orders and Clear/Discard behavior. The production browser suite owns rendered tab hover contrast.
Release-script tests distinguish interrupted fetches and response bodies from fatal package validation errors.
`scripts/daily-preview-artifact.test.mjs` executes the workflow's source-decision and package-attempt guards;
publication recovery remains governed by the [release process](releasing.md).

The shared `fixtures/view-literal-contract.json` owns filter spellings supported by Python and native R, including
short datetime fractions, compact timezone offsets and malformed-component refusals. Existing Python filter and Fill
owners compare exact instants with independently constructed values through live and standalone generated execution,
including Python 3.10. Python-specific extreme offsets remain in those owners because native R retains its parser's
offset limits. The existing Spark grid-query owner checks portable datetime selections without local conversion.
Persistence tests retain old bound Filter Rows steps while rejecting obsolete viewing payloads; Python filter and
native R catalog tests execute the historical infinity selections through live and generated code.

## Pull-request CI

The pull-request workflow requires five jobs:

- Source contracts: formatting, lint, types, generated protocol/reference output, documentation, dependency locks,
  licenses, the retained script contracts, and Vitest.
- Python runtime contracts: Ruff, Pyright, and Pytest.
- Native R frame, kernel, and transport contracts: the three R 4.5 selections above.
- Packaged VS Code smoke: one production VSIX opened in the declared minimum VS Code 1.106.0 and current stable VS
  Code.
- Windows filesystem and process contracts: Windows-only export, dependency, and shutdown behavior.

Branch protection requires all five jobs and the separate CodeQL gate to pass. A proved edit of existing Markdown
documentation lets the Python, native R, and Windows jobs report an explicit omission. Native R has a separate proof
for existing Python source and documentation edits; Python and Windows retain their documentation-only scope.
Source and packaged smoke still run. See [CI](ci.md) for the exact paths, commit binding, failure behavior and reduced
fresh R environment coverage.

## Failure-artifact allowlist

After editor and display ownership and private-root identity are verified, a failure artifact may contain only:

- Phase result and progress JSON.
- Selected `main.log`, `sharedprocess.log`, `renderer.log`, `notebook.rendering.log`, `exthost.log`, and Open Wrangler
  output-channel logs.
- A paths, types, and sizes-only profile manifest.
- Structured failure metadata.

The R collapse-frame journey records notebook display, toolbar selection submission and session-open completion
separately. Failure metadata reports the last stage reached when progress is read after shutdown; it does not identify
the await active at the exact deadline or measure its duration. These completed stages use the existing inactivity
watchdog; the absolute phase deadline is unchanged.

Jupyter output logs may be inspected only to derive a fixed failure category and are never copied. Raw profiles,
settings, workspace storage, databases, arbitrary extension logs, credentials, private keys, and user data are never
allowed. Collection and sealing use bounded no-follow, single-link, identity-pinned reads and repeat redaction. CI
uploads only the exact sealed path emitted through `GITHUB_OUTPUT`; it never uploads a staging directory or glob.

## Exact-artifact installed smoke

For a local or pull-request installed-editor smoke, build and verify one VSIX, then give that exact file first to the
declared minimum VS Code 1.106.0 and then to current stable VS Code:

```bash
npm ci --ignore-scripts
python -m pip install -e "python[dev]"
npm run clean
npm run build
npm run package:prepared -- --out openwrangler.vsix
npm run verify:vsix -- openwrangler.vsix
npm run build:test-extension
OPEN_WRANGLER_PACKAGED_EDITORS=vscode \
OPEN_WRANGLER_PACKAGED_MODE=platform-smoke \
OPEN_WRANGLER_TEST_SELECTOR=daily-core \
VSCODE_TEST_VERSION=1.106.0 \
node scripts/run-packaged-editor-tests.mjs openwrangler.vsix
OPEN_WRANGLER_PACKAGED_EDITORS=vscode \
OPEN_WRANGLER_PACKAGED_MODE=platform-smoke \
OPEN_WRANGLER_TEST_SELECTOR=daily-core \
VSCODE_TEST_VERSION=stable \
node scripts/run-packaged-editor-tests.mjs openwrangler.vsix
```

The broader platform smoke identifies the product's gallery row by its exact extension ID. It requires one visible
row and a loaded icon observed together within ten seconds. Failure details contain only fixed identity, counts and
image-state fields. The editor may choose its gallery or local icon URL; archive verification separately checks the
packaged icon. The test harness's similar display name cannot satisfy this check.

The broader platform smoke checks trusted-pickle publication, unchanged source bytes, worker cleanup, and opening
the converted Parquet file through the public command. The optional completion-notification action has a direct
command test; toast visibility is not the conversion-completion signal.

The smoke catches production-bundle, VSIX-installation, public CSV action, grid rendering, sort, and terminal cleanup
failures that source tests cannot observe. It must not rebuild or substitute the VSIX after verification.

## Focused Python notebook checks

Kernel bridge and variable-discovery tests cover notebook preflight byte, output and item limits, malformed UTF-8
expansion, exact document replacement, fixed errors and execution settlement after cancellation or a host deadline.
Actual generated Python controls check quiet and noisy notebook-open paths before runtime dispatch.

DuckDB engine tests verify temporary query-view cleanup after reads, metadata inspection, query failures and source
deletion, while preserving caller objects, source evaluation counts and primary errors. The engine and notebook
owners also cover repeated session closes and successful or refused captures on both supported DuckDB cohorts.

For Python notebook changes, the `python-notebooks` profile runs the existing released-Jupyter deny/allow journeys
against a supplied VSIX. It covers Pandas, Polars, DuckDB, kernel recovery, the Python editor action, and source-cell
discovery. The profile has been verified in VS Code on Linux.
The two Polars Formula Apply checks retain their original app identity and add bounded host and renderer state
to timeout diagnostics, without recording cell values, code or alert text.

```bash
OPEN_WRANGLER_PACKAGED_EDITORS=vscode \
OPEN_WRANGLER_PACKAGED_MODE=full \
OPEN_WRANGLER_REAL_JUPYTER_EXTENSION=1 \
OPEN_WRANGLER_PACKAGED_PYTHON_JUPYTER_PROFILE=python-notebooks \
OPEN_WRANGLER_TEST_PYTHON=/absolute/path/to/python \
VSCODE_TEST_VERSION=stable \
npm run test:packaged-editors:prepare -- openwrangler.vsix
```

The selected Python needs the supported interpreter, `venv`, and `ensurepip`; dataframe packages are installed at the
declared compatibility versions in a private environment. Java and Spark are unnecessary for this profile. The
command rebuilds the test harness and installs the supplied product VSIX without rebuilding it.

This profile excludes PySpark, remote/coexistence, native R, and generic file/seed verification. Incompatible remote
or coexistence options are rejected. Leave the profile unset to run the complete default Python lane, including
PySpark and generic verification. Qualification coverage is determined by the selected lane, not by a focused pass.

## Native R editor dependencies

The `r-jupyter` notebook journeys prepare their reviewed package subset in a fresh private R library. They omit
`languageserver`, `rmarkdown`, and `knitr`; interactive-terminal and literate-documents journeys retain all three.
Shared IRkernel, native-frame and Parquet fixtures keep their dependencies, including collapse and Rcpp.
Package pins remain in `scripts/jupyter-acceptance-environment.mjs`. Each selected root must resolve from the private
library at its reviewed version and load successfully before the exact private IRkernel readiness probe runs.

The focused interactive-terminal journey installs the pinned official R and R-syntax extensions. It omits the
Quarto extension and CLI; the literate-documents journey retains both, including private Pandoc configuration and
native Quarto media preview checks. Tooling pins remain in `scripts/r-editor-acceptance-tooling.mjs`, and its selected
extension records drive installation and expected versions. Both tooling scopes keep the same private R package
roots and IRkernel readiness checks.

`scripts/packaged-r-jupyter.test.mjs` checks actual prepared install/probe/record agreement, private environment
ownership and rejected inputs through the command seam without starting R. Changes to this selection also require a
fresh notebook core run and a full tooling/literate run against the same supplied VSIX; graph size alone does not
establish setup-time savings.

`src/test/releasedRTooling.unit.test.ts` checks the actual tooling assertions and focused journey routing, including
missing or mismatched extensions, commands and CLI configuration. Changes to terminal tooling selection also require
the focused terminal and full literate journeys against the same supplied VSIX. Fewer selected artifacts alone do
not establish setup-time savings.

## Release-candidate checks

The release-candidate workflow packages the protected-main source once and retains one canonical VSIX, checksum, and
provenance triple. It does not repeat protected-main source checks. The candidate job:

1. Audits the published Node and Python dependencies.
2. Runs pinned VS Code installed-performance against the canonical triple.
3. Reverifies the triple and runs pinned Cursor `platform-smoke` against the same VSIX.
4. Reverifies and uploads only the canonical triple for stable promotion.

Stable publication uses this verified VSIX and does not rebuild it.

## Change-focused editor checks

Run a manual editor scenario only when the change crosses that UI or integration boundary:

- File changes: open `fixtures/sample.csv`, exercise the changed view or cleaning action, and confirm the source bytes
  are unchanged.
- Notebook changes: use the exact visible notebook and selected kernel; verify the changed live-variable or saved
  output path without falling back to another notebook.
- R changes: exercise the affected `.R` or IRkernel path in its supported editor and confirm the source object remains
  unchanged.
- Webview changes: check keyboard operation, accessible names, focus restoration, and light, dark, and high-contrast
  themes for the changed control.

The released-Jupyter first-result journey enables Open Wrangler but leaves kernel consent unanswered until the first
raw dataframe result appears. It then checks that the result gains its action without another execution. Disabled
previews must not request automatic inspection; the notebook owner unit tests cover that separate behavior.
Native R notebook journeys keep discovery disabled during kernel probing and enable it before the setup cell whose
completion requests consent.

Do not retain a second end-to-end journey for behavior already covered by the exact-artifact smoke or a direct source
test. Do not retry deterministic failures; fix the product or remove a check that cannot identify a distinct failure.
