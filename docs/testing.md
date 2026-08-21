# Testing

## Release qualification ownership

Daily previews are disposable protected-`main` artifacts, retained for 14 days and checked with the authoritative
pull-request command plus one representative installed VS Code journey. They create no tag or public channel.

Manual release-candidate qualification packages once and retains one canonical VSIX/checksum/provenance triple for 21
days. The reusable acceptance workflow consumes only its numeric artifact ID. VS Code owns the semantic editor,
Python/Jupyter, R, and installed-performance journeys; Cursor owns one pinned Linux
lifecycle/renderer-replacement/narrow-grid/reveal-state seam. R 4.4 and 4.5 compatibility, Remote SSH, and the bounded
performance report remain release evidence. Every phase has its existing 300-second hard and 180-second inactivity
deadlines, produces diagnostics only on failure, and has no retry. The manifest fan-in fails on any missing, skipped,
cancelled, or failed owner.

Stable promotion runs no product test, build, or package command. Tests mutate its candidate-run selection, 168–336h
soak bounds, newer-same-tag rejection, historical-source checkout, cross-run numeric artifact downloads, manifest and
performance digests, write permission boundary, exact-byte reverification, and public conflict checks. Historical
preview workflow inspectors remain unit-test fixtures for 1.99.x recovery only and are not current release entry
points.

## Automated layers

Use `npm run check:pr` as the authoritative local gate for an ordinary change. It runs the complete static
`check` branch and ordinary `test` branch concurrently, caps top-level parallelism at two, labels both branches, and
waits for both to report even when one fails. Do not run another memory-intensive command alongside it. The
repository cannot coordinate separate clones or worktrees, so cross-worktree resource isolation remains an operator
responsibility. Use a narrower focused command while iterating, and reserve the complete editor/platform/release
matrix for release candidates or changes that cross those boundaries.

- `npm run check:pr` is the fail-complete default PR command. It preserves every invariant in `npm run check` and
  `npm test`; concurrency changes wall time, not the test inventory. The two-branch ceiling is the local resource
  budget, and `--continue-on-error` plus `--print-label` prefixes every interleaved output line so one early failure
  cannot hide or obscure the other result.

- `npm run check:install-policy` owns all 28 lockfile install invocations across 26 contributor, CI, candidate,
  package, promotion, and release owners in 11 GitHub and Azure automation files. `.npmrc` disables lifecycle scripts by default and every
  executable owner repeats `npm ci --ignore-scripts`; the checker rejects plain installs, lifecycle re-enablement,
  rebuilds, dynamic installs, package-manager aliases, and unowned install sites. Its install-script allowlist is
  empty. The lock must contain no `hasInstallScript` entry, native `keytar`, or `prebuild-install`. Script-free
  local shims make VSCE fall back to its file/PAT credential path and make Vite/Pyright use portable filesystem
  watching. The script-free signing bridge resolves only one of the nine exact `@vscode/vsce-sign-*` optional
  packages already authenticated by the lock; a missing or unsupported platform fails without npm, HTTP, direct
  download, or native compilation. Mutation tests cover every owner and package, override, flag, command, platform,
  and shim boundary.

- `npm run check:r-dependency-lock` strictly validates both native-R lock registries without network or filesystem
  mutation. `node scripts/r-dependency-lock.mjs generate ... --check true` is the explicit networked byte-regeneration
  operation; it must reproduce the dated archive graph exactly. The workflow `prepare` command validates the lock and
  exact R runtime before cache or network mutation. The cache contains only the lock-pinned package archives. On a
  cache miss, `install --cache-hit false` downloads the bounded archive set; on a cache hit,
  `install --cache-hit true` independently revalidates the complete archive inventory, descriptor identities, sizes,
  and SHA-256 values before any package code can run. Both paths install only those authenticated local archives into
  a fresh empty private library, then verify every namespace and seal a new exact package and file-tree receipt.
  Installed libraries and receipts are never restored from cache. Neither path has a repository fallback or retry.

- `npm run typecheck` checks the extension and webview projects independently.
- `npm run lint` and `npm run lint:python` enforce TypeScript/JavaScript and Python quality.
- Selected earlier-step editing tests bind one exact committed step ID and revision, open its operation form against
  the inspection input schema, and route both the webview and Activity Bar through one host rewrite transaction. The
  transaction clones the exact confirmed runtime capture, replays the complete candidate plan in order, requires
  unchanged suffix IDs plus valid generated code, backend, mode, source, and metadata, restores the authoritative
  confirmed view, and publishes only after an ignored-on-load persistence record protects the private candidate.
  Lazy-file replacement, eager-file or live-variable rebinding, rejected suffix references, stale lifecycle state,
  malformed responses, or candidate cleanup leave the confirmed plan, draft, view, revision, code, caches, and source
  unchanged. Focused Pandas, Polars, DuckDB, and Native R owners cover selected-prefix preview, exact-source cloning,
  executable replacement-plus-suffix generated code, and no-op diff parity. Host tests cover suffix replay, backend
  drift, a view change after preview, deletion, failed persistence rollback, and at-most-once cleanup. The installed
  extension-host custom-editor journey replaces and then deletes the first step while retaining a later stable-ID
  suffix, verifies the rebuilt grid and generated code, restores the original persisted plan, and proves byte-exact
  source preservation. Reordering is not supported and has no request or command.
- `npm run test:r-contract` sources the production R module, runs native R assertions, and then sends real base
  `data.frame`, tibble, and `data.table` pages through the strict private transport-v14 TypeScript decoder. The R assertions cover snapshot
  isolation, `data.table` by-reference mutation, duplicate and non-syntactic names, factors, ordered factors, dates,
  time zones, durations, exact `bit64::integer64` values, `NA`/`NaN`/infinity, unsupported semantics, factor-level and
  page bounds, aligned element names on atomic and classed columns across base, tibble, data-table, and `collapse`
  frames, rejection of malformed names metadata, and rejection before an oversized page is fully allocated, including
  JSON escape amplification. The gate treats every warning as a contract failure while leaving startup messages
  separate. A test that intentionally exercises a warning must capture exactly one condition and assert its complete
  class and message. Generated R code executes under the same warning policy. The assertions also cover
  stable-reference compound filters and multi-column sorts, AND/OR logic, typed predicates and selections,
  value search, per-key direction and missing-value placement, exact integer64 ordering, duplicate-name references,
  filtered and sorted pagination, source immutability, malformed or stale rules, and source row IDs in logical view
  order. Row-origin regressions require zero per-row origin storage for a contiguous live capture, reject extra or
  active bindings, unlocked fields, duplicate mappings, and inconsistent sequential state over a mapped capture, and
  compare exact page bytes plus numeric, temporal, factor, and `integer64` profile structures with the materialized
  identity representation. Hostile live readers that replace and relock origin state, the descriptor/domain pair, or
  their own reader binding, inject duplicate cached positions into the current read, or retain a replacement initial
  frame for the next read must fail as invalid captures. Filter Rows and Sort Rows tests cover stable source-row
  identities, current-view
  conversion, `NA` versus `NaN`, compound sort priority, stable ties, missing-value placement, history, diffs, and
  data-table key behavior.
  Drop Missing Rows tests cover the Any and All modes, `NA` and `NaN`, empty results, explicit row names, zero-column
  frames, and stable source-row identities. Drop Duplicates tests cover first/last/none retention, selected-column and
  whole-row comparison, source order, stable row identities, and R's treatment of `NA` and `NaN`. Both cover duplicate and
  non-syntactic names, base data frames, tibbles, keyed data tables, stale references, source isolation, and executable
  generated R. Fill Missing Values tests cover `NA` and `NaN`, typed replacements, exact integer and `integer64`
  medians, scaled floating-point means, ordered same-row fallback priority, stable previous/next fills, whole-run gap
  limits, grouped median/mean/mode fills, missing grouping keys, linear interpolation by numeric, Date, and POSIXct
  coordinates, restored row order, unresolved boundary and over-limit runs, factor levels and no-op levels, dates,
  DST gaps, current-source timezones, the 8 KiB R text limit, exact remaining-missing counts, nullable metadata, key
  safety, and executable generated R. The shared protocol and webview tests require the count only on fill previews,
  reject impossible values, announce it to assistive technology, restore it with a draft, and clear it after the draft
  ends. Rename, Drop,
  Select, Clone, Convert type, Text Length, Lowercase, Uppercase, Find and replace, and Transform by example tests resolve duplicate and
  non-syntactic names by stable identity, preserve base, tibble, and keyed `data.table` semantics, and prove that
  drafts and generated R leave the source unchanged.
  Drop tests cover retained IDs after a position shift, data-table key changes, and drop-all rejection. Select tests
  cover user ordering, retained IDs, key-prefix changes, and mixed plans. Clone tests cover a stable derived ID,
  duplicate-name preservation, later targeting of the copy, and data-table key retention. Text Length tests cover
  character and factor inputs, Unicode character counts, `NA` preservation, integer output, stable derived identity,
  output collisions, unsupported inputs, and mixed plans. Convert type tests cover all six public targets, factors by
  label, failed parses as typed `NA`, integer truncation and range limits, UTC datetimes, stable in-place identity,
  unsupported or ambiguous source/target pairs, and keyed-data-table rejection. Lowercase and Uppercase tests cover
  in-place and derived output, factors, `NA`, invalid encodings, changed-cell diffs, source isolation, and keyed data-table guards.
  Min-max scale cases cover integer, double, and `integer64` input, constant and non-finite ranges, the full non-missing
  `integer64` range, adjacent wide values, nullable output, stable derived identity, and keyed-data-table rejection.
  Round, Floor, and Ceiling cases must cover ordinary integer and double inputs, exact `integer64`, `NA`, `NaN`,
  `Inf`, `-Inf`, R's ties-to-even rounding, derived output, and keyed-data-table rejection for in-place changes.
  Find and replace tests cover literal and regular-expression matching, blank patterns, factors, Unicode text, and the
  same output and key rules. The kernel-agent cases cover preview, apply,
  discard, applied-step inspection, selected earlier-step prefix preview, latest-step replacement, undo, stale
  revisions, unsupported operations, and an encoding failure before state publication. The date, datetime, and duration cases
  are read from `fixtures/view-literal-contract.json`; signed-zero tests
  require one emitted selection to match both `-0` and `+0`. Ambient `OutDec` and `TZ` settings must not change a cell,
  including POSIXct columns with null or empty-string timezone metadata. The TypeScript decoder rejects the reserved R
  integer and bit64 integer64 NA sentinels when they are mislabeled as ordinary values. Profile tests cover stable
  column references, `NA` versus
  `NaN` and infinity, exact integer64 extrema, factors, Unicode text lengths, logical counts, Date/POSIXct ranges,
  difftime statistics, numeric histograms, common-value limits, empty and all-missing columns, duplicate rows, and
  source immutability. They also check filtered profiles and dataset statistics, extreme finite histogram ranges, the
  64-column request limit, exact chunked cheap statistics above the former 1,000,000-row and 5,000,000-cell refusals,
  deterministic 100,000-value histogram/category samples, 150,001-row period-2/3/5/7 regressions that exercise both
  distribution and duplicate sampling without changing the user's R random state, omitted non-exact medians and
  distinct counts, exact boolean counts, exact missing statistics, and duplicate samples bounded by both rows and
  cells. Protocol, bridge, native-view, and React tests require explicit sample labels, `Distinct n/a`, sampled
  percentage denominators, and strict count relationships. Dataset-statistics responses include the filtered row count
  and optional duplicate-row sample size from the correlated request; the R encoder, TypeScript decoder, and bridge
  each reject impossible counts. Initial filter-value discovery covers a 4,000,001-row frame through a labeled
  100,000-row sample. Non-empty searches above the former 1,000,000-row limit scan in chunks and return exact matching
  counts through both the frame contract and kernel agent. A low-result-limit regression retains an exact winner at
  the 10,000-distinct-match boundary and rejects the next distinct match before retained state can grow without bound.
  The cross-language cases run only when
  `OPEN_WRANGLER_R_CONTRACT_TESTS=1`; the command sets it itself. The runner gives the direct frame, kernel-agent, and
  catalog contracts explicit 120-, 360-, and 120-second bounds. It divides the real-R Vitest work into named frame/unit,
  kernel-transport, process-transport, and interactive-transport phases with 60- or 90-second bounds. This preserves
  serial real-R ownership and the exact test inventory while removing the former aggregate 120-second deadline that
  sat within eight seconds of ordinary hosted execution. Every phase prints start, pass, elapsed-time, and exact
  timeout/failure receipts; there are no retries. The existing frame-contract process also parses the exact tracked
  `scripts/r-performance-harness.R` and requires a nonempty expression on both hosted R versions; this adds no fourth
  direct R subprocess. These runner bounds do not change editor phase, editor inactivity, or runtime-operation
  deadlines. The current PR workflow starts two selected R 4.5 owners after classification and beside the invariant
  core: the kernel-agent shard and a fail-complete serial pair containing the remaining protocol shards. The temporary R 4.4 pull-request carrier is retired; the
  manual and scheduled Cross workflow owns the exact `python-runtime-dependency-cohorts` job that installs and exercises
  every declared dependency/Python qualification pair, plus the lock-backed R 4.4 qualification. Every R owner consumes
  its exact dated lock through the strict private-library path above. The contract also
  runs the native kernel agent through open, filtered and sorted
  pages, profiles, dataset statistics, column
  values, the Filter, Sort, Drop Missing Rows, Fill Missing Values, Drop Duplicates, Rename, Drop, Select, Clone,
  Convert type, Formula, Text Length, One-hot encode, Multi-label binarize, Lowercase, Uppercase, Find and replace,
  Capitalize, Strip text, Split text, Min-max scale, Round, Floor, Ceiling, Format Datetime, Group and aggregate, and
  Transform by example lifecycles, variable replacement, native CSV export, malformed requests, and close
  cases. The export
  checks a pending draft and stale revision, full committed rows despite an active view, duplicate names and R types,
  repeated offset reads, explicit close, and session-close cleanup.
  The R tests check the fixed diagnostics for unsupported frames,
  missing packages, oversized pages, over-wide profile requests, explicit value scans, and stale columns. Focused TypeScript tests cover the embedded
  remote-kernel bootstrap, response decoder, sole-open notebook checks, exact-kernel paging and profiling, restart
  handling, late close completion, repeated disposal, and delayed
  candidate cleanup without interrupting Jupyter. They also cancel and time out page requests, then prove that the next
  request waits for the original execution to finish. They also stream a multi-chunk CSV from the exact kernel and
  close its private artifact after success or a detached request. The R contract requests enough bytes to trigger
  jsonlite's normal line wrapping and checks that the wire value is still canonical base64. Variable-discovery tests
  cover exact base `data.frame`, tibble, and `data.table` class vectors, active and delayed bindings, missing
  `jsonlite` or `rlang`, malformed output, and notebook/kernel replacement. Host and webview tests cover the native
  picker, coordinator route, R runtime identity,
  Filter, Sort, Drop Missing Rows, Fill Missing Values, Drop Duplicates, Rename, Drop, Select, Clone, Convert type,
  Formula, Text Length, One-hot encode, Multi-label binarize, Lowercase, Uppercase, Find and replace, Capitalize,
  Strip text, Split text, Min-max scale, Round, Floor, Ceiling, Format Datetime, Group and aggregate, and Transform by example
  capabilities, generated-code commands, bounded two-dimensional pages, and enabled viewing filters, sorts,
  profiles, and value selection. The
  production-browser accessibility journey covers explicit row labels,
  keyboard tab/menu use, and
  focus restoration. The R 4.4 and 4.5 contract lanes pass, and the local packaged IRkernel journey passes in isolated
  VS Code and Cursor profiles with R 4.5.2. The remote IRkernel journey passes in VS Code. The same packaged path now
  chooses `score = 1200` from R's typed value results, adds `group = B` as a second-column predicate, and checks the
  single matching row, its stable source ID and row name, the filtered column and dataset profiles, Clear all, and the
  existing multi-sort controls. A serialized copy of the source frame must still match before and after that journey,
  and the private runtime binding must be gone after close. The exact hosted result is recorded below. CI does not
  install R in packaging, Python, browser, or ordinary editor jobs. The packaged R journey starts IRkernel through a
  small run-owned bootstrap that puts its private library first without depending on the runner's R startup files.

  A local read-only scale acceptance on 2026-08-11 generated a 4,000,017-row × 8-column base frame entirely in memory,
  profiled one numeric and one string column, and calculated dataset statistics in 25.414 seconds. Exact cheap and
  missing statistics remained complete, both distributions contained their 100,000-value sample, and duplicate rows
  carried a 100,000-row sample receipt. This generated-data result is evidence for the former refusal case, not a
  performance threshold or substitute for the focused R 4.4/4.5 matrix.

  Explicit candidate `core-operations` uses its existing phase and job positions for one full installed Clone Column
  lifecycle: preview, apply, applied-step inspection, edit and reapply with the same step/output identities, and undo.
  Every candidate core cell runs that same Clone lifecycle. Linux VS Code retains all-block grid depth; macOS and
  Windows VS Code retain representative single-round-trip grid, profile, filtering, Clear all,
  compound-sort, and Viewing-to-Editing seams within the same 300-second phase limit. Explicit candidate core disables
  native-frame and embedded-restart work on every platform. The focused native-frame selector gives Linux
  VS Code comprehensive collapse/viewing/Rename/Drop ownership; macOS and Windows retain the representative
  tibble-Rename and keyed-data-table-Drop seams. Separate fresh Linux value and categorical profiles retain the base
  grid and Rename lifecycle but omit native frames; VS Code owns value's unchanged targeted operations and
  categorical's exact two visible One-hot encode and Multi-label binarize journeys. Cursor instead retains one
  distinct generic lifecycle/responsive-grid/reveal-state seam. Every applicable local invocation
  continues to validate the advertised installed operation registry. The dedicated direct R catalog contract executes
  the exact ordered 32-operation live/generated catalog, and the dedicated TypeScript export contract binds the same
  bridge/public order to byte-exact clipboard and atomic `.R` saves for distinct executable operation-labelled
  buffers. Fresh installed all-32 candidate/performance evidence remains outstanding. A fresh
  Linux installed-tooling invocation
  separately owns the official R terminal and Operations sidebar. It seeds named-column base, tibble, and data-table
  frames in that exact terminal, waits for them to appear in Operations without Refresh, and opens and profiles the
  base frame. Linux plain `.R` moves to the separate VS Code literate-document invocation;
  macOS retains it in the core VS Code invocation, and Windows skips R documents. The initial
  picker still checks base, tibble, `data.table`, and supported `collapse` frames. Focused R runtime and webview tests
  cover the full R operation catalog and document matrix; the bounded installed-editor passes check the integration
  seams without repeating that matrix. The profile does not raise either the 300-second hard deadline or the
  180-second inactivity deadline, and it does not retry a failed phase.

- `npm run test:scripts` runs the focused cross-platform contracts for editor environment isolation, private home/config/runtime trees, fresh correlated phase outcomes, progress-aware deadlines, classified failures, sanitized evidence retention, POSIX process-group cleanup, the Windows Job Object supervisor and parent lease, genuine Restricted Mode launches, the explicit visible-debug opt-out, pinned private-Xvfb preparation and lifecycle, Remote SSH child-error latching, exact Xvfb socket/lock identity receipts, candidate provenance, exact staged-file receipts, bounded staged-tree manifests, fail-fast Jupyter VSIX target/native-payload compatibility, the container-isolated remote-Jupyter runner, and structural release readiness. Release-document fixtures include fenced, commented, raw-HTML, duplicate, placeholder, future-action, untracked-reference, empty-changelog, and contradictory-README decoys. The checked-in Native R preview table has an exact 20-row topology while allowing truthful Partial rows. Synthetic stable-major-2-or-newer fixtures require a dedicated top-level section containing only the distinct exact 23-row all-Done Native R scope, the exact completion sentence, explicit ordinary `collapse::qDF()`/`qTBL()`/`qDT()` coverage, the complete 32-operation catalog, the R performance record, exact row-specific tracked evidence, and both source and immutable-candidate enforcement. The active-terminal and Cursor literate rows claim only their Linux candidate coverage, and the two all-32 rows require dedicated complete-catalog tests rather than treating the prior-27 suites plus focused Custom Code, multi-output split, public regex extraction, Pivot longer, and Pivot wider contracts as sufficient. Deleting, duplicating, reordering, hiding, deferring, or weakening any row, availability, status, evidence reference, or release-gate cell must fail; stable 1.x recovery remains outside this content gate. Crafted VSIX fixtures cover omitted legal files, symlink-mode entries, missing manifest-referenced assets, oversized expansion, encrypted flags, and CRC corruption through the same streaming validator used by both package verification and stable readiness. Descriptor-bound VSIX file fixtures reject hard links, symbolic links, empty or sparse oversized inputs, and named-path inode swaps around the read. Pinned Cursor and Remote SSH acquisition additionally read product metadata, package metadata, runtime files, and licenses through bounded no-follow descriptors whose named path, containment, identity, and complete snapshot must remain stable; their adversarial fixtures cover replacement, in-place mutation, and hard links. Cursor network bytes enter only a random mode-`0600` quarantine descriptor and cannot be published until exact status, one unambiguous length, SHA-256, descriptor identity, and named-path identity all agree; a rejected status, header, or body is explicitly disposed. Stable-publication fixtures also require immutable Git-commit source reads and reject content or parent-identity changes in either final output, including a same-size first-output mutation while the second output is read. Parsed-YAML fixtures bind the complete dispatch and job graph through a bounded, cycle-safe canonical digest in addition to semantic validation; they move or duplicate readiness/upload steps, remove the event-commit binding, alter shell/failure/condition controls, add workflow/job execution overrides or permission escalation, insert post-readiness mutations, weaken commands, change runners or action inputs, remove required evidence, add broad uploads, expose publisher credentials, remove the locked CLI guard, add a preview registry flag, or place mutations between canonical verification and a publisher boundary. None may satisfy the canonical stable workflow. Stable-tag fixtures require the exact protected `origin/main` source, require canonical version binding, one non-force atomic single-ref push, a private credential that never enters arguments or child environment, cleanup after success or failure, exact recognition and scrubbing of Git credential-store's atomic approval and rejection rewrites, rejection of any other replacement, and exact lightweight post-push verification; conflicting, annotated, ambiguous, stale, dirty, wildcard, force, and delete forms fail. GitHub publication tests accept absent, exact partial, and exact complete releases while rejecting conflicting tags, metadata, assets, digests, and bytes. Publisher unit tests retain the migration-false compatibility case, while the checked-in stable and preview workflows require exact `immutable: true`; false or missing state blocks registry promotion. Open VSX tests require the exact stable identity, publisher login, public checksum, and downloaded VSIX; retry is bounded to missing or transient post-publish metadata, and the default contract proves all ninety-one attempts in the fifteen-minute window. Marketplace tests separately enforce the pipeline's explicit maximum reviewed forty-attempt public-verification bound. Stable-candidate fixtures additionally require the complete pinned ordered step allowlists, reject every removal plus inserted/replaced/mutable actions, exercise the producer's real package-source composition, accept only the expected post-write directory-link-count transition while every owned file receipt stays fixed, and prove stable consume mode cannot fall back to a moving editor download. Platform-specific cases are skipped only where the host cannot provide the primitive under test.
  Historical 1.99.x recovery fixtures also require the retired preview and stable README sections to retain the same editor-support matrix.
  This local command remains the complete superset of the four disjoint CI groups below.
- `npm run test:scripts:workflow` runs `scripts/ci-workflow.test.mjs` beside the candidate workflow contract in the
  unconditional invariant core. It owns the sole four-output classifier, exact result fan-in, changed-area owner topology,
  CodeQL gate, immutable recursive action pins, and both R lock consumers.
- `npm run test:scripts:portable` runs the remaining general or Linux-owned `scripts/*.test.mjs`, including GitHub
  publication and R-lock adversarial contracts, with at most four Node test files active at once, then invokes the
  isolated media contract below. It is owned directly by the invariant core alongside the non-TypeScript
  `check:invariants` boundary.
  Failure-evidence credential patterns receive at most 8 KiB per logical line. Longer lines containing a quote,
  URI user-info marker, or credential marker are omitted fail-closed; longer marker-free lines bypass the complex
  patterns. The maximum admitted 16 MiB hostile quoted and assignment cases also run in a child process capped to a
  64 MiB V8 heap and an eight-second outer deadline, so a regression fails the test rather than exhausting the host.
- `npm run test:scripts:media` runs the PNG-heavy README-media contract alone, with one test file and a 1 GiB V8 heap ceiling. Pixel mismatches report only the first differing coordinate/channel rather than asking Node to render a multi-million-byte assertion diff. The invariant core reaches it through `test:scripts:portable`.
- `npm run test:scripts:native` runs only `scripts/windows-job-supervisor.native.test.mjs`: compile the checked-in supervisor, prove natural-exit descendant containment and bounded termination, reject malformed frames, and revalidate the compiled executable before launch. It is intentionally absent from macOS because the equivalent macOS path and lifecycle seams are portable contracts, while real macOS behavior remains covered by the unchanged native extension-host and packaged-editor jobs. The workflow regression enumerates the live `scripts/*.test.mjs` directory and requires these four groups to be pairwise disjoint with an exact complete union.

The comparison harness and its focused fixtures remain portable/script evidence inside the invariant core. They do
not select a fifth classifier output or launch the benchmark. Actual comparisons remain manual or release-owned.

- `npm run test:ts` covers shared models, extension helpers, reducers, and React behavior, including bounded automatic import detection, regular-file launch validation, exact resource-scoped `vscode-remote` URI propagation into Python environment selection, atomic final-marker renderer replay, pre-ack presentation-write rejection, pending-grid flush ordering, recovery-pull suppression after the exact synchronization acknowledgement, failed marker delivery, a rejected pre-ready publication that preserves the initial webview through its startup grace period, at most two bounded active-panel renderer reloads with no hidden-panel or reload-loop churn, post-ack Code Preview reveal, page-revision write continuity, bounded visibility-aware pulls that continue through partial replays, stale acknowledgements, retained import failures, coalesced manual/native and concurrent-native import intents, busy-renderer view-state flushing, exactly-once native-action fallback, and command lifetime through the complete renderer-prepared import transaction. Native primary-launch acceptance treats any delimiter, encoding, header, or quote Quick Input as a failure; prompt interaction is reserved for explicit **Change Import Options** scenarios. Ordinary and V8-coverage Vitest runs share a four-worker ceiling from `vite.config.ts`; V8 coverage remapping has the same independent four-worker ceiling, and the real Python-environment smoke remains isolated at one worker. Individual Vitest cases retain a 15-second hard bound so concurrent jsdom/React initialization remains deterministic on hosted Windows runners without making hangs unbounded.
  Focused grid tests cover typed cell include/exclude actions, null and NaN behavior, duplicate labels, unavailable
  projected cells, keyboard context menus, focus restoration, and superseded filter requests.
  Code Preview lifecycle coverage requires one preserve-focus reveal for the first acknowledged draft in a session, no second reveal after discard and another draft, and no extra renderer synchronization or webview HTML assignment around that reveal. Packaged acceptance must observe the visible Code Preview with native generated code, wait for the grid's naturally published generated-column selection, and bind the current acknowledged renderer without requesting another synchronization.
  Generated-column navigation retains its logical target through that renderer publication barrier but always receives a fresh reveal request identity afterward, including when the first DataGrid attempt remained pending and dormant during the Code Preview layout transition. A focused component regression withholds the first completion, delivers the matching barrier, requires the new identity, and then consumes only that retry.
  Sorting interaction coverage requires header actions to close their menu, promote the newest column to priority 1 without losing the remaining tie-breakers, avoid duplicate rules when that column was already sorted, expose `aria-sort` only on priority 1, label every lower-priority key, keep a clear action for every active key, and leave the cleaning plan untouched. Filters / Sorts tests separately require ordered multi-sort drafts, explicit apply/discard, move-up/down priority changes, independent direction and null placement, individual removal, clear-all/clear-column cleanup of uncommitted edits, and preservation of the active filter model. Native Activity Bar tests require literal priority labels, row-click navigation into the Filters drawer, real view transactions for inline reorder/removal, inspection-safe passive controls, structurally cloned standard TreeItem fields in VS Code forks, provider-handle stability across unrelated profile or selection updates, and rejection of stale or malformed tree-node payloads including an A → B → A sort-model transition. The physical editor journey additionally proves that opening the Activity Bar retains the exact hydrated dataframe session; a failed reorder records the host dispatch status, active and retained sort models, plus bounded tree state instead of collapsing into an opaque timeout. Protocol and persistence tests reject repeated viewing-sort columns before they can produce ambiguous priority. Production browser acceptance also measures the complete 140-pixel summary-family headers at normal and 200% zoom: each realistic name must retain at least 72% of the cell width, fit without truncation, and stay above the compact type/action rail.
  Progressive-summary interaction coverage starts with more than six columns, explicitly opens one disclosure, adds a later profile response, and requires that disclosure to remain open. Selecting a numeric grid column must promote and expand its summary with exact min/max/mean/median values and the same exact histogram shown in **Column profiles**. One Counts/% setting controls both compact grid headers and the selected-column panel, can be changed from either surface, and remains available before a profile is opened. Exact count and percentage stay in the tooltip and accessible name in either mode. Truncated categorical and string profiles expose **More values…** and request the existing bounded 100-value browser. The numeric profile's one full-chart pointer and keyboard target reports the active bin's interval, exact row count, and percentage through an immediate theme-aware tooltip and accessible name, even when the proportional visible bar is only two pixels tall. Production-browser interaction enters the transparent lane above a two-pixel bar, requires an immediate visible highlight and tooltip, preserves the focused bin after pointer exit, advances through bins in keyboard order, and maps resting/active bars to `CanvasText`/`Highlight` in forced-color mode without duplicating the accessible name as a description.
  Operation-builder coverage uses the real accessible checkbox lists without keyboard modifiers, preserves explicit selection order, moves and removes individual sort/aggregation rows without losing retained values, and verifies schema-type filtering for text, numeric, datetime, group-key, by-example, and per-calculation aggregation inputs. Fill-missing tests choose the column before the method, offer median only for numeric columns and most common only for text or boolean columns, restrict interpolation to floating-point targets and safe coordinate types, retain stable references while methods change, restore saved steps, keep an empty text value, and normalize `.5`, `1.`, and `+1` before protocol validation.
- `npm run test:python-environment-smoke` runs real system-interpreter discovery alone, with one worker and no override or Python-extension API. It must return a fully qualified supported `source: system` interpreter inside the 30-second aggregate resolution bound. The invariant core owns the Linux/Python 3.10 smoke; scheduled/manual Cross retains macOS/Python 3.12 and Windows/Python 3.14 evidence outside pull requests. Failures retain only stable classification, stage, process-count, and candidate-limit metadata, never interpreter paths, subprocess output, causes, or inherited environment values.
- `npm run test:python` covers the Pandas/Polars parity engines plus the file-backed DuckDB preview, transformations, code generation, exports, and runtime dispatch. Fill-missing coverage runs the live and generated Pandas, Polars, and DuckDB paths, including null versus float or Decimal NaN, exact wide-integer and 38-digit decimal medians, unique most-common text and boolean values, grouped median/mean/mode with multiple keys and unresolved ties, previous/next fills, linear interpolation by irregular numeric and date-time coordinates, high-offset coordinate distances, typed empty frames, categorical and enum no-ops, high-magnitude finite floats, decimal-scale rejection, matching and mismatched datetime timezones, DuckDB UUID text fills, duplicate or non-string Pandas labels, type binding, and the normal draft/apply/undo lifecycle. Spark-dependent PySpark cases skip only when their optional runtime is absent from an ordinary developer environment. Required CI coverage installs and verifies exact PySpark 4.2 Connect extras, compatible Pandas, and Java 17 before running the complete instrumented Python corpus, so those cases cannot disappear behind that local-only skip.
- Focused Spark Connect tests use PySpark's structured conditions and gRPC status instead of matching error text. They cover temporary endpoint failure, lost server session or DataFrame state, exact session/view correlation, cache handling, and preservation of the last confirmed host view. Message-only lookalikes and unrelated reattach conditions must remain ordinary engine errors. Request cancellation stays disabled.
- `npm run test:extension-host` launches the real custom editor in an isolated VS Code profile and a copied private workspace, then uses separate zero-window seed/verify editor processes to validate workspace-state replay and injected runtime recovery in the rendered grid. The fresh verify process physically proves the committed output column, two-sort priority, selected column, distinctive width, nonzero row/column viewport, and visible-row status; a renderer-originated **Header profiles** request then restarts the runtime and must preserve that complete state. Actual Explorer-row, editor-title, and editor-tab file-launch clicks run through a private Electron debugging port. Each context action must appear exactly once, open the exact copied source without import prompts, render its grid, and leave its bytes unchanged. Multi-megabyte fixture-preservation checks compare exact bytes with bounded size/first-difference diagnostics; they never pass complete buffers to Node's assertion formatter. Runtime-selection commands may write workspace configuration only inside that per-run copy, so an interrupted editor phase cannot leave a stale disposable interpreter configured in the repository. A same-URI session-to-custom-editor reload waits for the prior public tab model to become empty before dispatch, then requires the exact fresh `TabInputCustom`; runtime cleanup alone is not treated as editor-input disposal. Stable VS Code defaults to native context menus on macOS, which are outside the renderer debugging protocol, so the disposable profile selects VS Code's built-in custom menu style for these physical assertions.
  Its `numericSummaryJourney.ts` owner opens a dedicated two-row Pandas CSV through the public file command, selects
  `wide_integer`, `all_missing`, and `infinity` through the real **Column** combobox, and opens the real **Column
  profiles and filters** drawer. The shared accessible assertion requires the `Sum` term/value to remain an exact
  `<dt>`/following `<dd>` pair: the wide-integer result is lossless `18014398509481988`, the all-missing result is
  normalized to `0`, and included infinity is `n/a`. The source stays byte-identical and the exact session and
  standalone runtime must close. The released native-R core journey reuses that assertion on the existing complete
  1,205-row `score` session and requires `Sum 726,615`, while its surrounding kernel binding, serialized-source, and
  terminal-close checks retain source and lifecycle ownership. The ordinary `npm run test:extension-host` verify
  phase owns the Pandas case; the existing released `jupyter-r` core phase owns the Native-R case.
- `npm run test:packaged-editors -- openwrangler.vsix` installs the release artifact into isolated VS Code/Cursor profiles and runs zero-window Restricted Mode, seed, and verify acceptance from a separately packaged and installed acceptance-only helper, so checkout code cannot shadow the product. It can additionally run the opt-in real Python-environment phase or released-Jupyter allow/deny pair documented below. The Restricted Mode phase uses no development extension, a fresh trust-enabled user-data profile, suppresses only the startup prompt, omits `--disable-workspace-trust`, proves `workspace.isTrusted === false`, and verifies the installed package cannot activate, create a dataframe tab, expose its coordinator, or start a runtime. Its verify process exercises the installed file-launch toolbar plus physical Explorer-row and tab context-menu contributions, and repeats the rendered fresh-process persistence/recovery assertions against the installed package. Native webview discovery has a fixed 30-second bound, checks workbench/CDP liveness, ignores only proven retired targets (including a Code Preview iframe replaced during provider refresh), and reports structural frame diagnostics without retaining dataframe text. Cursor hides third-party editor-title actions by default, so manifest and installed-editor tests require the package's declarative `cursor.general.pinnedTitleActions` default and prove the primary icon is visible without writing a setting into the disposable profile.
- `OPEN_WRANGLER_REMOTE_INSPECTION_PYTHON=/absolute/prepared/python OPEN_WRANGLER_REMOTE_PYTHON=/absolute/prepared/python OPEN_WRANGLER_EDITOR_DISPLAY=xvfb npm run test:remote-workspace -- /absolute/openwrangler.vsix <lowercase-sha256> <byte-size>` runs the pinned official VS Code/Remote SSH acceptance in private user, PID, network, IPC, and UTS namespaces. Both Python variables are mandatory absolute executable authorities with no PATH fallback: the inspection interpreter reads bounded tar manifests, while the source interpreter supplies the dependency-complete environment copied into the remote fixture. They may identify the same prepared interpreter. The trusted build caller must calculate and pass the candidate SHA-256 and byte size independently. The runner rejects a missing, malformed, oversized, or mismatched expectation; revalidates the exact source/staged candidate and pinned Remote SSH VSIX immediately before each install/use and after the editor phase; and carries the candidate size/hash plus the Remote SSH version/size/hash through the correlated namespace attestation. Host preflight and the isolated phase both require the exact Linux `CapInh`, `CapPrm`, `CapEff`, `CapBnd`, and `CapAmb` sets to be present once and zero, and the final attestation binds that all-zero capability object. The child treats the first strict correlated harness result as authoritative while retaining its no-follow descriptor through editor/SSH/Xvfb shutdown, offline-log validation, capability revalidation, and final path/byte identity checks. Both a success and a bounded explicit test failure exit zero only after publishing one exact terminal attestation containing the result outcome, size, and SHA-256; timeouts, malformed results, cleanup uncertainty, drift, or diagnostic stderr fail without a usable terminal envelope. The host reacquires that exact result, keeps it leased while it revalidates every staged input, immutable registry, host guard, candidate, and pinned Remote SSH receipt, and only then reports a redacted test failure or permits cleanup. The host derives the phase loader from a parser-verified, fixed three-module static ESM closure; only known `node:` builtins and its exact local modules are permitted, while dynamic, CommonJS, bare-package, decorated, nested, absolute, and parent imports fail closed. It stages those three files plus Xvfb into an exact root-only manifest, then revalidates the source graph, staged graph, byte/identity receipts, and manifest at the synchronous spawn boundary and after the process tree stops. One exact launch registry classifies mutable homes/output, host-only identity guards, and every phase-visible authority input: the descriptor and phase helpers, a private exact-file copy of the invoking Node runtime, Xvfb, VS Code client/remote CLI/server, installed local and remote extensions, copied Python, Dropbear, SSH/account configuration, compiled test module with Playwright, and workspace fixture/settings. The staged Node copy has its own byte/mode receipt and immutable descriptor mount, independent of its original toolcache or system path. Physical authority and setup trees live outside the mutable remote home; required extraction roots are precreated empty with mode `0700`, while that home contains only runtime/cache/data/config/state/temp roots and an empty server-state skeleton before launch. The phase opens the remote `remote.csv` through the resource-scoped private Python/Polars runtime, pages and filters it to Milan/42, proves the source bytes unchanged, and requires zero retained sessions and a stopped runtime before fixture cleanup. The selected private Python environment is copied without filtering or recovering its dependency journal: an existing journal is source-receipted before and after the real copy, only the copied journal directory is descriptor-pinned and restored to mode `0700`, and every retained leaf must remain byte- and identity-exact. A receipt-bound copy of the product dependency guard then runs through the copied interpreter with one bounded stdin frame; only its exact clean status is accepted before fixture creation or editor launch, while dirty, busy, malformed, changed, or recoverable state fails closed. At the synchronous process-spawn boundary the runner revalidates the registry, opens retained no-follow leases, and gives Bubblewrap only inherited descriptor numbers. Mutable roots are mounted with `--bind-fd` first; every authority root or file is then overlaid into its expected remote-home location with `--ro-bind-fd`. No host private-root pathname, physical setup tree, or broad writable `/ow` bind enters the Bubblewrap argument vector. Immutable manifests and receipts are checked again after the owned process tree stops. Verified cleanup first moves both the private root and the host-only sentinel to absent randomized siblings under their pinned parents, then revalidates the quarantined identities immediately before deleting them; a rebound parent, public path, or quarantine is retained untouched and fails cleanup.
- The Remote SSH extension-host scenario does not treat coordinator session publication as renderer readiness. It bounded-waits for the exact panel's open operation and current session/revision synchronization marker to receive its renderer acknowledgement, then requests and asserts one fresh host-to-renderer synchronization exactly once. This closes the panel-publication race without retrying an editor phase, a Remote SSH attempt, or a failed synchronization.
- Before Remote SSH downloads or launches an editor, a bounded CommonJS closure reconciliation walks the
  compiler-emitted literal `require` graph from the exact compiled product and Remote acceptance entrypoints. It
  rejects nonliteral direct `require`, dynamic `import`, absolute, escaping, unresolved, and unapproved static
  bare-package edges; exact external specifiers are limited to host-provided `vscode` and the staged
  `playwright-core` test dependency. The one existing `createRequire` result may only inspect an already-loaded
  extension through its compiled `.resolve(...)` and `.cache[...]` shape. This is a generated static-dependency
  inventory, not a sandbox for arbitrary reviewed extension behavior. The product's js-yaml edge must resolve to the
  exact local vendored runtime, proving that top-level Remote extension-host loading does not depend on repository or
  workspace `node_modules` state.
- Platform-smoke profiling keeps header profiles queued while **Column profiles** opens. The selected column's existing
  request must move to interactive priority and start beside an active passive profile without changing its correlation
  ID or repeating work. Unrelated header profiles stay queued, and mutations remain blocked until profiling settles.
- Platform-smoke XLSX recovery closes any visible bottom panel left by the earlier file workflow before opening the
  workbook, while leaving the sidebar in place so the grid keeps its ordinary editor width. It acknowledges and hides
  the exact install-success toast, binds to Cursor's current acknowledged renderer, and activates a fully exposed body
  cell with one freshly hit-tested, receipt-bearing pointer click. ArrowRight must reveal and focus its logical neighbor
  even when a narrow editor initially clips that next column. Once the click is dispatched, a renderer change fails the
  check rather than repeating the action. The journey never forces focus or asks the host to publish another renderer.
- `OPEN_WRANGLER_PACKAGED_MODE=platform-smoke` selects the short first-use journey for exactly one requested VS Code or Cursor installation. It installs and activates the caller's exact VSIX, renders the gallery icon, and opens a deterministic 10,000-row × 15-column UTF-8-BOM, semicolon-delimited `[Live] regional orders 2024-2025.csv` from the editor-title action without an import prompt. The workbench journey exercises newest-first multi-column sorting, visible priority, independent key removal and clear, then clicks the engine badge and uses the real Quick Pick to switch the same file from Polars to Pandas and back. The switch must keep the public session, source, selected column, widths, viewport, and source bytes. The journey continues with typed column search and visible type icons, exact numeric **Column profiles**, native exact text null/empty/Unicode-length profiles, a numeric filter and **Clear all**, and a text fill that selects **Most common value**, previews the native Polars result, and discards it. It then previews an Uppercase draft with a human operation label, honest added-column/value diff, automatic reveal of the new column, and native Polars code. The reveal check waits for the grid's natural selected-column publication before binding its acknowledged renderer; it never asks the host to publish a test-only snapshot that could restore the preceding viewport. Backend switching, selection, filtering, and workbench-layout checks likewise bind their next UI action to the renderer that acknowledged the current host receipt. A retained Cursor iframe cannot satisfy the check just because it shows the same session. The journey then discards and rebuilds the draft, applies it, exports cleaned CSV through the real workbench picker and Save dialog, closes and reopens the source, and verifies plan replay. The recovered plan edits that applied step through the real dialog, proves the saved fields hydrate, previews one stable-ID replacement, discards it back to the exact committed result, edits and applies it again without appending a step, exports the replacement schema, closes and reopens once more, verifies replacement code and persistence, undoes the step, and requires the source bytes to remain unchanged throughout. It then opens a generated 64-row XLSX through a disposable Python environment where only `openpyxl>=3.1.5` is unavailable, activates the real error-panel action and literal public confirmation, runs one private offline fake-pip marker, and requires the same tab to become a keyboard-usable Pandas grid without changing one workbook byte. After the panel acknowledges the recovered session, the test follows the current renderer receipt if Cursor replaces its iframe; it does not ask the host for another synchronization. Theme and native-view checks still cover the Activity Bar and all four views; the high-contrast capture at approximately 200% zoom additionally rejects toolbar or grid-status overflow, a clipped visible-row range, and clipped direct controls. When `OPEN_WRANGLER_CAPTURE_EDITOR_SCREENSHOTS` is set, this phase also captures the title action, tab context menu, and clean file-workflow hero from the installed package. With the released-Jupyter opt-in enabled, its allow phase captures the automatic Pandas MIME preview plus 1440 × 900 native Polars and DuckDB relation workbenches. The gated PySpark phase adds its matching 1440 × 900 Classic DataFrame workbench only when its prerequisites run. This journey is the fast local check before the complete release matrix and uses isolated profiles with no visible editor window. The hosted Cursor job ignores any preinstalled copy and verifies the pinned download's version, size, SHA-256, product commit, and platform signature. The downloaded editor stays inside the job's private temporary directory and is never committed, packaged, cached, or redistributed.
- Packaged README notebook evidence uses a dedicated 1280 × 600 Pandas capture from an actual 1280-pixel editor viewport, rather than cropping an ultrawide workbench after capture. Brand rendering loads the light/dark command SVGs as external images on their intended editor surfaces and checks their contrast; native captures then verify the same manifest-selected action assets in the real file and notebook toolbars. The tab-menu source capture closes the sidebar before opening the menu. The import-options capture fails on every unexpected notification, permits only VS Code's exact file-watcher warning as environmental noise, clears that warning without dismissing the real prompt, and reasserts its natural keyboard focus. After a capture-only theme change, the journey must rediscover the exact live session grid, observe a current host handshake, force presentation-state synchronization, and rediscover the synchronized renderer generation; this covers Cursor's webview reload without retrying the editor phase or weakening any native-data assertion. Code Preview acceptance requires one visible native panel and one live generated-code editor rather than counting duplicated title text, because Cursor mirrors the same view name in its panel and view headers.
- `npm run test:webview-acceptance` renders the production bundles in Chrome, compares every screenshot with its checked-in baseline, and runs WCAG 2.0/2.1/2.2 axe rules through Playwright.
- `npm run reference:check` regenerates command, setting, operation, protocol, and MIME reference content in memory and fails on drift.
- `npm run docs:check` enforces required documentation and release/version alignment, including the PEP 440 runtime version in `python/openwrangler_runtime/version.py` against `package.json`.
- `npm run check:remote-jupyter-lock` validates the remote-server fixture's canonical exact pins, complete sorted hash closure, and Jupyter Server security floor without network access. `npm run audit:python` audits both the active development environment and that lock against the live advisory database without suppressions; this gate is network-dependent by design so later disclosures fail an unchanged commit.
- Release metadata tests still bind numeric versions to the historical stable/preview channel policy, and the preview artifact author/validator remains covered for recovery. Current automation instead treats the daily build as disposable, requires the manual release-candidate workflow to package once without publication, and allows stable promotion only from the exact soaked candidate run and manifest. Mutation tests reject a second package, any candidate write permission, preview-channel input, artifact-name download, missing fan-in owner, rerun, changed or expired artifact, source drift, newer same-tag candidate, stable rebuild, and public conflict-verification drift.
  The shared candidate-workflow inspector requires a fixed internal graph and `fail-fast: false` on the two-cell local-R
  shard matrix; mutation tests prove that an unknown shard or sibling cancellation blocks the candidate. The only steps
  allowed to use `continue-on-error` are named diagnostic producers, and each must be followed immediately by its upload
  while the shard's explicit raw-outcome failure is deferred until all assigned phases finish.
  Protected pull-request CI owns the direct R 4.5 contracts; scheduled/manual Cross owns direct R 4.4 evidence. The
  release-candidate workflow additionally installs the exact candidate VSIX against both R 4.4 and R 4.5 platform
  seams before any later stable promotion can select it.
- Microsoft Marketplace tests parse and pin the complete Azure Pipeline, require its WIF service connection and
  protected environment, and reject PATs, rebuilds, mutable artifact paths, channel omissions, and intervening
  commands. Before AzureCLI, one anonymous single-attempt exact-byte probe either proves the complete existing public
  payload and skips both authentication and duplicate publication, or records only a pending observation and proceeds
  through the unchanged WIF publish plus bounded public verifier. Conflicting public bytes fail immediately. The
  trigger accepts path-independent `v*` tags and unbatched `main` events with no YAML path filter.
  Intake tests cover automatic stable and preview tags, exact single-parent recovery changes, absent-tag no-ops,
  manual immutable-tag recovery through v1.2.2, an automatic no-op for those versions, `main` ancestry for later
  releases, exact tag and manifest identity, and checkout drift. Download and public-registry tests require the
  GitHub inventory, checksum, channel, metadata, and normalized
  VSIX entries to match.
- `npm run test:coverage` enforces TypeScript/webview and Python regression floors and produces HTML/JSON/XML reports.
- `npm run license:check` verifies every bundled production dependency against the approved SPDX policy and third-party notice groups.
- `npm run verify:vsix -- <file>` rejects development, user, secret, test, and source-map content before packaged files are read. Archive names must be portable: absolute paths, backslashes, dot/empty segments, Windows-invalid names, non-NFC spellings, and case-folded or file/directory collisions fail closed. The verifier parses `extension.vsixmanifest` as strict XML; malformed XML, duplicate attributes, document types, ambiguous container arrays, and wrong-namespace lookalikes fail closed. It recognizes only one exact `PackageManifest > Metadata > Properties > Property` chain in the canonical VSIX namespace with unnamespaced `Id="Microsoft.VisualStudio.Code.PreRelease"` and `Value="true"` when the packaged `package.json` has `preview: true`; stable packages forbid that property.

The platform-smoke fill sequence also previews a previous-value revenue fill, then previews, applies, and undoes a
median calculated separately by market and segment.

## CI gate ownership

Every required context has one primary evidence owner. [CI and release checks](ci.md) maps the pull-request, scheduled,
and release tiers. `validate` runs after every selected PR workflow owner and is the sole parser of their exact
results. Cross runs only on manual dispatch and schedule, retaining its macOS/Windows runtime, Windows dependency
guards, and R 4.4 qualification. CodeQL retains both analyzer names and one result gate; neither workflow invents
another classifier. Draft and ready heads use the same pull-request evidence mapping, and superseded PR heads alone
are cancelled.

`package.json`, `package-lock.json`, toolchain, workflow, classifier, validation, and lock-owner changes self-select the
complete four-flag union. There is no narrow dependency-lock or release-infrastructure classifier mode in the current PR workflow.

Remote SSH setup never makes a writable dynamic-loader cache available to the editor or candidate: the private Dropbear binary is probed and launched through its pinned loader plus an explicit read-only library path. The immutable Dropbear runtime is mounted under private `/ow/ssh-runtime`, outside every host-backed mutable home, so a same-UID host rename cannot substitute the executable or libraries through a mutable ancestor. Every Dropbear server loader call supplies one fixed `--argv0` path named `dropbear` beneath the namespace's kernel-owned procfs and first proves that path absent with `lstat`; only `ENOENT` is accepted, and the namespace preflight verifies procfs by filesystem magic before any loader call. Dropbear 2025.89 therefore takes its supported plain-fork fallback instead of reopening and re-executing itself without the loader's one-shot private search path. This intentionally gives up per-connection ASLR rerandomization only for the ephemeral, loopback-only, network-isolated acceptance daemon. Exact pinned TomCrypt and TomMath files remain independently leased over their read-only multiarch SONAME paths after the host runtime-directory mount, so default-loader validation never resolves either dependency from host library bytes. Both bootstrap and real phases use the pinned loader's bounded `--list` output to require each SONAME to resolve through only the namespace's fixed `/lib -> /usr/lib` aliases to that independently leased multiarch file, including in the presence of higher-priority glibc hardware-capability directories, and then execute the Dropbear ELF directly before daemon launch. A missing or shadowed default-loader dependency therefore fails before an SSH connection. Bubblewrap support must include descriptor-bound mounts and explicit next-object permissions; the namespace root is created as mode `0700`. A copied virtual environment's conventional Python symlink is resolved once into a new receipt-bound, mode-`0700`, single-link regular launcher, and that launcher must still report the copied environment as `sys.prefix`. Before the launch embargo begins, the exact sealed Bubblewrap argument and descriptor-FD set runs a bounded no-editor bootstrap that loads the controller imports and validates the mounted descriptor leaves, critical executable modes, loopback and both Dropbear loader probes, private namespace identities, host isolation, empty child/display state, and zero capabilities; the real spawn repeats the seal. Structurally or physically invalid descriptors and any namespace inconsistency remain unrecoverable and publish nothing. After descriptor and namespace validation, an isolated controller failure may publish only a fixed stage code for setup, display, SSH, editor launch, result wait, an allowlisted acceptance action, cleanup, or terminal validation, and only after a second child shutdown, empty-display proof, complete namespace/host-isolation proof including all five namespace identities, and zero-capability check. Before a harness result exists, recovery additionally requires randomized exclusive no-follow temporary write, flush, close, no-overwrite atomic publication, identified-temp cleanup, and result-lease validation. If cleanup or terminal validation fails after a harness result exists, recovery may carry forward only the receipt from its first-observed result lease after the lease's final identity check and successful close; any earlier lease fault latches permanently even if the named path is restored. The host then requires the surviving named result to match that receipt before reporting a synthetic fixed controller failure. It never overwrites or exposes the underlying result as success. Raw editor, SSH, daemon, path, URL, and caught-error text never enters either form. Malformed, late, or replaced results, residue, ownership drift, lease faults, and publication faults retain the no-attestation/no-cleanup fail-closed path.

The Remote SSH host contract requires both multiarch SONAME mountpoints to exist as root-owned regular files or direct, single-hop relative symlinks to root-owned, non-writable regular files immediately inside `/usr/lib/x86_64-linux-gnu`; the hosted job installs `libtomcrypt1` and `libtommath1` explicitly before validating them. Nested or mismatched symlink targets fail before Bubblewrap can resolve the destination. The separately leased pinned files overmount those safe host leaves; host library bytes never become Dropbear authority. The namespace also exposes a full Coreutils-compatible `printenv` and Procps `ps`, never BusyBox's option-limited `ps`; its POSIX shell is the already-pinned Bash rather than BusyBox `sh`, whose compiled applet lookup would shadow the exact `ps` mount. The pre-editor SSH probe requires the exact helper paths plus working `getconf LONG_BIT`, `printenv HOME`, and `ps -p` behavior before Remote SSH may launch.

The pinned VS Code CLI checks its GNU C++ runtime through `/usr/lib64/libstdc++.so.6`, while Ubuntu stores that library in its read-only multiarch runtime. The namespace provides only a relative compatibility symlink into the already validated `/usr/lib/x86_64-linux-gnu` mount. Both the no-editor bootstrap and real phase require that alias to resolve to a versioned `libstdc++.so.6.*` file inside that mount before Remote SSH can start; no additional host executable, loader cache, or writable library path is introduced.

Remote-workspace acceptance pins Python only in the precreated resource-scoped workspace settings. Its extension-host preflight must not rewrite the read-only local user settings at runtime; other editor phases may retain their isolated global test override.

The remote scenario and public **Open in Open Wrangler** command both open CSV/TSV through the same bounded automatic detector and must reach the grid without delimiter, encoding, header, or quote Quick Input. Native packaged-editor acceptance treats any such prompt during a primary launch as a failure. Prompt navigation, confirmation, and cancellation belong only to the explicit **Change Import Options** advanced/recovery journey; the zero-window Remote SSH phase exercises the automatic path and does not pretend to drive that separate UI. Both paths converge on the same coordinator, engine-native runtime, grid, filter, source-immutability, and terminal-cleanup contracts.

If the editor reaches the result wait but never publishes a terminal result, diagnostics remain metadata-only. After the editor, SSH daemon, and display are proven stopped, the phase revalidates its private namespaces and zero capabilities, then reduces either the fixed private log topology or one strictly allowlisted correlated checkpoint to a fixed controller stage. A checkpoint can distinguish only harness bootstrap, activation, packaged preflight, scenario setup, file open, filter, session cleanup, or completed-harness publication; its raw text never crosses the controller boundary. Log contents are never read, and raw paths, names, user data, or caught errors are never emitted or persisted by the diagnostic. Unsafe, duplicated, malformed, unknown, or over-budget observations keep the generic result-wait failure.

The selected `canonical-editor` owner performs both TypeScript typechecks and the complete TypeScript unit/component
inventory, then performs one clean production build, packages and verifies the VSIX, and runs the stable extension-host
acceptance against the same checkout. Release workflows still create and distribute their
own receipt-bound candidate artifact; the current PR workflow does not alter that authority. Remote SSH remains a release/candidate
boundary rather than a default PR job. Scheduled/manual Cross owns its existing macOS/Windows seams without a
pull-request trigger. CI and CodeQL cancel only superseded pull-request heads; scheduled and default-branch evidence
is never cancelled, and a failed phase is never retried automatically. Protected-main pushes run the
invariant core and both always-on CodeQL analyzers. The manually dispatched Released Jupyter and performance workflows
remain outside pull-request CI with unchanged product semantics and newly immutable action references.

Release candidates invoke the shared acceptance workflow once from a non-matrix caller. Fixed Python, remote-R,
generic-platform, R 4.4/4.5 platform, performance, and two local-R shard owners consume the same artifact ID in
parallel. Candidate R phases omit duplicated embedded native-frame/restart work when a dedicated selector owns it.
Local and platform R run in VS Code only; Cursor is limited to the single generic Linux lifecycle seam. Every phase
freshly revalidates the candidate, retains the 300-second hard and 180-second inactivity deadlines, emits only
failure diagnostics, and is never retried.

The manual release-candidate workflow is the final acceptance matrix. It packages once from a first-attempt
protected-main dispatch and seals success plus installed-performance identity in the bounded manifest. Stable promotion
is not another matrix: after 168–336 hours it selects one candidate run, checks out that historical source, downloads
the exact candidate, manifest, and performance artifact IDs, and verifies their binding before public mutation. The
promotion job contains no build, package, editor, runtime, Remote SSH, R, Jupyter, or benchmark command.

For stable major 2 and later, the canonical artifact author passes the linked `report.json` bytes from that same
immutable source snapshot and the already-owned candidate VSIX SHA-256 into readiness. Its end-to-end fixture proves
the matching report can publish one canonical triple and that a different candidate digest produces no output
directory.

Marketplace intake exports the exact release commit, version, and channel. Its deployment must materialize that
commit as a clean, contained, detached `release-source` worktree from the full-history automation checkout. For
`1.99.4` and later it restores that exact checkout's lockfile and runs its browser-free immutable-media verifier only
after canonical artifact verification and before the AzureCLI authentication boundary; older releases predate the
mode and retain their historical recovery path. The pipeline inspector pins the complete command and environment contract;
mutation tests reject a moving source, missing root/identity/cleanliness checks, output drift, and every reordering
across canonical verification, source materialization, media preflight, existing-public probing, authentication, and
public verification.

The separate `.github/workflows/open-vsx-promotion.yml` remains a protected recovery publisher for an already-public exact GitHub release; the current stable promotion performs its fail-closed Open VSX preflight, same-byte upload, and public verification directly after GitHub publication. Both paths forbid rebuilds and conflicting public bytes. Remote SSH emits no success artifact and remains an unconditional release-candidate owner; its raw private workspace is never uploaded.

Marketplace recovery downloader tests distinguish a direct synchronous fetch throw from a returned promise that
rejects before an HTTP response. Only the latter re-enters the existing bounded release poll. Metadata and asset
recovery cases prove the complete anonymous read transaction restarts without creating partial output; exhaustion
proves the exact attempt/wait count and one fixed diagnostic without the rejected URL or cause. Accepted-response body,
metadata, inventory, URL, and size failures remain single-attempt and occur before canonical output creation.
Filesystem failures are also never retried and may retain only their partial output in the disposable recovery
workspace. Existing tests independently pin the downloader's narrow pending-versus-fatal HTTP status policy.

[GitHub reports a conditionally skipped job as a successful check](https://docs.github.com/en/pull-requests/reference/status-checks), including when that check is required. The current PR workflow therefore keeps every selected pull-request owner behind the sole `validate` result parser, which distinguishes exact selected success from an intentional skip and rejects missing, failed, cancelled, or unexpectedly skipped results. Draft and ready pull requests share the same CI trigger; readiness is not a classifier output. Cross is scheduled/manual only, and both CodeQL language analyzers remain always-on behind `CodeQL gate`. When multiple ready branches share one base, finish and merge one matrix before updating and starting the next. Routine Dependabot version updates are staggered on separate UTC days and group compatible minor and patch updates by ecosystem; major and security updates remain separate.

Standalone backend preparation is a release-blocking engine-lifecycle contract. Tests require a separately owned transient adapter, cleanup on success and failure, propagation of the exact source descriptor, explicit-backend selection or the automatic Polars file default without guessing an unresolved notebook variable, and a structured engine error when preparation fails. Server transport tests prove preparation runs on the process-owned stdin reader thread before the real open is dispatched to a worker. Polars preparation tests require discoverable PyArrow to be preloaded only for Excel sources across the supported `fastexcel` range, while CSV, notebook, and PyArrow-absent environments remain unchanged. A fresh subprocess must then open a real Polars CSV and a real Pandas TSV in the same server, return both correlated sessions within the open bound, close both, and exit on EOF; Windows runtime CI is the authority for the cold native-import order.

`python/tests/test_runtime_imports.py` owns the implementation-import boundary. A fresh standalone `initialize` must
leave all four implementation modules absent from `sys.modules`. Explicit creation of each built-in backend must load
only that implementation, retain the public adapter-class imports used by existing tests, and return a fresh factory
instance. Automatic notebook detection is the named exception: it loads candidates sequentially in registry order.
`python/tests/test_runtime_startup.py` runs the bounded diagnostic probe with two fresh Polars children; ordinary
measurement uses nine samples, one excluded warm-up, and a 20-second per-child timeout:

```bash
python python/benchmarks/runtime_startup.py --backend polars --samples 9 --warmups 1 --timeout-seconds 20
```

The probe records median and nearest-rank p95 time plus current and peak RSS after package initialize and after the
first selected backend is ready. Its clock starts inside each fresh interpreter, so interpreter launch and disk-cold
cache behavior are outside the result. It also fails if initialize loads an implementation or explicit selection
loads anything besides the chosen backend. This is focused startup evidence, not an editor first-paint or release
threshold.

On 2026-08-16, an alternating 30-pair same-host run compared exact parent `9481c499` with the lazy-import working
tree on CPython 3.14.4 and Polars 1.43.2. Median initialize time changed from 31.327 ms to 27.959 ms (10.7% lower),
and current RSS changed from 21,151,744 to 19,730,432 bytes (6.7% lower). The median package-import-through-first-
prepared-Polars boundary changed from 90.637 ms to 88.124 ms (2.8% lower), while RSS after preparation changed from
46,680,064 to 45,608,960 bytes (2.3% lower). The isolated preparation stage grew from 56.999 ms to 59.651 ms because
it now owns the deferred implementation import; the complete first-selected-backend boundary did not regress.

`python/benchmarks/eager_numeric_profile.py` is the bounded eager numeric-summary probe. It accepts only Pandas or
Polars, 2,000,000–5,000,000 rows, one to five fresh child-process samples, and a 1–300-second per-child timeout. Each
child builds one native integer frame before measuring a complete summary, validates exact count, distinct, top-value,
typed-extrema, and 20-bin outcomes, and reports median elapsed time plus incremental current and peak RSS. A candidate
run can consume a matching baseline report; it exits nonzero if either median elapsed time or median incremental peak
RSS regresses. Run the same command from the baseline and candidate checkouts, adding `--baseline-report` to the latter:

```bash
PYTHONPATH=python .venv/bin/python python/benchmarks/eager_numeric_profile.py \
  --backend pandas --rows 2000000 --samples 3 --timeout-seconds 120
PYTHONPATH=python .venv/bin/python python/benchmarks/eager_numeric_profile.py \
  --backend polars --rows 2000000 --samples 3 --timeout-seconds 120
```

On 2026-08-16, same-host CPython 3.14.4 measurements compared rebased Lane B frontier
`49c8053af42799865d8917fdfb0ff039fdc15f7d` with eager-profile implementation
`0a21a5766be547490d4fc7cf7abce4fbb4f79bec`. For Pandas 3.0.3, median elapsed time fell from 856.037 ms to
170.694 ms (80.1% lower) and incremental peak RSS fell from 180,133,888 to 43,388,928 bytes (75.9% lower). For
Polars 1.42.1, median elapsed time fell from 911.523 ms to 151.679 ms (83.4% lower) and incremental peak RSS fell
from 196,968,448 to 46,419,968 bytes (76.4% lower). These are focused runtime diagnostics, not editor or release
thresholds.

`python/benchmarks/eager_mixed_text_profile.py` applies the same fresh-process bounds to one Pandas categorical
column whose numeric categories use the grid's mixed-display text fallback. The probe validates missing, distinct,
top-value, categorical-chart, and Unicode-code-point length outcomes before reporting elapsed time and incremental
current and peak RSS. A matching baseline report makes time and peak-RSS regressions fail the run. The direct test
also requires categorical text reduction to normalize each observed category once rather than once per row:

```bash
PYTHONPATH=python .venv/bin/python python/benchmarks/eager_mixed_text_profile.py \
  --rows 2000000 --samples 3 --timeout-seconds 120
```

This is a focused Pandas runtime diagnostic. It does not measure editor rendering and has no release threshold.

Custom Code output isolation is a real-stdio transport contract, not only an adapter unit test. One standalone subprocess must open editing sessions for Pandas, Polars, and DuckDB, run simultaneous custom previews that emit forged protocol-looking lines plus oversized no-newline text through `print()`, text writes, buffered writes, and stderr, and receive exactly the three correlated preview envelopes. Focused failures must return bounded redacted engine diagnostics without exposing the seeded credentials. Discard must restore the original source frame, a later correlated page must succeed for every engine, and close plus EOF must leave no malformed host-visible protocol line. Direct engine tests separately preserve normal stdout/stderr behavior for executable generated code.

Runtime-selection acceptance must use a dependency-isolated interpreter that is directly executable by Node without a command shell and records every probe invocation. Every platform creates a no-pip virtual environment and installs only an isolated `.pth` invocation recorder in that environment; a shell wrapper is invalid because production resolution must pin through it to the interpreter reported by `sys.executable`. The fixture must prove exact Polars, DuckDB, lossy-Pandas, and legacy-Excel missing-dependency diagnostics, no runtime process or generation change after declining the real modal, an unchanged invocation log, and restoration of the configured fallback interpreter. Focused bridge tests additionally inject a superseded pre-dispatch selection, require one successful fresh-selection retry, require repeated churn to fail boundedly, and prove that an already-dispatched open is never reissued; session-bound mutations remain outside this retry path. Automatic Excel failure must retain and display only the preferred backend's exact requirements; panel and React tests require the structured **Install required dependency** action to be visible and enabled after the terminal error regardless of stale generic grid-loading state, disable it during an import change or dependency request, prove decline remains retryable, and permit a reopen only after the existing zero-argument command returns confirmed success. Native-editor failure evidence records bounded button enabled/busy state and persisted-replay state so a renderer race cannot collapse into an unclassified timeout.

Resource-scoped Python-selection tests must exercise the released stable event API, exact resource forwarding, one activation/subscription, absent/failed/malformed optional integrations, terminal disposal, and explicit-override precedence. A virtual monotonic clock and process seam must cover the one 30-second aggregate budget across activation, selected-environment lookup, launcher discovery, every probe, and a reported-executable re-probe; each process receives at most 10 seconds and no more than the remaining aggregate budget. Windows fixtures must prove case-insensitive deduplication, supported minor-version ordering, normal-before-free-threaded ABI ordering, path tie-breaking, and a 16-candidate cap before executable checks. Terminal cases must include exact-deadline races, deliberately late completion, request cancellation, same-scope joiners, broker/bridge disposal, trust loss, invalidation, supersession, and shutdown; late success and rejection must not publish into or remove a same-key replacement. Cancellation after a confirmed resolution must leave it cached, while cancellation during shared unresolved selection gives the owner the existing not-started result and makes joiners stale. Deterministic barriers must additionally cover workspace-folder sharing, independent multi-root process slots even under one executable, external-resource scopes, same-folder sibling events, unscoped events, stale resolution/probe continuations, and same-executable pip invalidation. Runtime routing tests must prove exact confirmed-session and pending-cancellation ownership, cleanup-only provisional routing, targeted timeouts/restarts, cross-slot duplicate rejection, late-response fail-closed behavior, and deterministic multi-slot shutdown errors. The serial real-platform smoke is deliberately outside the parallel Vitest path and may expose only its bounded metadata allowlist. The opt-in packaged phase pins the released Python extension and uses executable-specific exclusive markers so A → B → A must produce one process generation per switch, replay the exact committed plan/data, preserve the source, and end with no session or runtime.

Dependency-probe tests must prove that independent resource scopes sharing one exact package-root identity, normalized executable, Python version, and ordered full dependency descriptors launch one probe. A difference in any descriptor field, including when `installSpec` is unchanged, must not coalesce. Invalidation must detach all joined consumers, permit a same-key replacement, and prevent an old success or rejection from deleting, caching, or publishing over that replacement, including the post-resolution/pre-consumer boundary. Package mutation detaches every in-flight and completed key under the package-root prefix; shutdown detaches without waiting for or cancelling probes, and late completions publish no cache or install target. Errors remain uncached and retryable. The successful-result cache must retain at most 128 entries independently of scope retention, refresh a hit, evict the untouched least-recently-used entry on the 129th completion, and preserve missing-requirement order.

Dependency-mutation recovery is release-blocking. Helper tests must exercise strict frames and schemas, marker-before-READY ordering, exact GO authorization, pre-GO parent loss, post-GO interruption, executable/root replacement, symlink/reparse and permission rejection, partial/corrupt/unreadable state, stale-token cleanup refusal, import and distribution-version validation, nonzero pip, timeouts, and exact-token removal under the same OS lock. Two independent processes must race an initially absent journal repeatedly and prove that only one can arm a mutation. POSIX tests must also prove that status can lock and inspect an existing clean journal through a read-only mount only after `O_RDWR` returns `EROFS`, using an `O_RDONLY` exclusive lock without changing the leaf; an absent lock, install, and recovery validation remain write-required and fail closed. Bridge tests must prove status runs before cached probes or runtime startup; aliases of one package root block together; dirty, busy, malformed, changed, and unconfirmed states fail closed; install and recovery are mutually exclusive; retained uncertainty is bounded without becoming authoritative; selection/trust/identity/token changes at every awaited boundary invalidate the action; and stale completion cannot clear a newer marker. Owned one-shot status and validation tests must cover exact-close removal, shared status-flight ownership, explicit and timeout unref idempotence, shutdown during ordinary status, recovery validation, and post-install validation, no signal/kill, cleanup after a late close, surfaced unref faults, and no post-disposal success. Never-resolving actionless-notification doubles must prove install/recovery single-flights and mutation barriers settle without waiting for a toast. The public recovery command accepts no arguments, names no UUID, requires the literal modal action, and has only a deterministic decline in the environment-gated test API. Real extension-host/package acceptance must use a disposable no-network environment, abruptly terminate a disposable guard parent to simulate extension-host-like interruption, present the retained marker to a bridge with no prior marker state, prove it blocks a source before dependency probing/runtime startup, prove the still-live writer keeps validation busy, decline once, then allow that writer to exit and complete exact revalidation. This is simulated abrupt termination; CI must not claim literal power-loss durability. Native Windows tests must prove atomic protected journal creation, the exact token-user/LocalSystem/Administrators owner and ACE contract for the journal and every leaf, no-delete handle pinning, and fail-closed handling of inherited, broadened, malformed, or changed existing ACLs without repair or deletion. The cross-platform workflow owns the complete runtime suite on Windows/Python 3.14, which includes the dependency guard, plus focused dependency-guard cells on CPython 3.10 and 3.12. The separate native Windows job owns the real supervisor/script contracts and consumes the one checksum-pinned PR VSIX for installed-editor acceptance.

Runtime-scope retention tests must create more than 128 distinct external-resource scopes with independently keyed dependency probes and prove aggregate least-recently-used eviction across slots, selections, epochs, recency, and diagnostics while the independent completed-probe LRU remains bounded. They must cover recency refresh without changing runtime-slot iteration order, the exact actionable missing-dependency pin, local/global request and cancellation backlinks, deferred resolution and probing under pressure, temporary all-leased overflow followed by immediate release-time trimming, idempotent exact-object leases, and an orphan unresolved selection that fails closed. Same-key recreation tests must prove stale lease, resolution, and probe continuations cannot mutate or publish into the replacement. Reopen-during-stop and rejected-stop tests must retain the exact slot and child until correlated exit confirmation; shutdown must still observe the original stop failure.

Import-option tests are release-blocking at every boundary. JSON Schema, TypeScript, Python, and confirmed-configuration decoders must reject unknown keys, the removed `sheet` alias, mixed Excel/delimited fields, simultaneous `sheetName`/`sheetIndex`, blank names and encodings, non-safe or non-integral indices, and delimiters/quotes that are not exactly one Unicode scalar value. Lone high and low surrogates are direct negative fixtures, while a supplementary scalar encoded as a UTF-16 surrogate pair remains valid. Real `.xlsx` and BIFF `.xls` fixtures must open by nonnumeric and numeric-looking sheet name plus zero-based sheet index in both Pandas and Polars; Polars may translate that public index internally but may not expose a one-based contract. The explicit Excel reconfiguration flow must list actual ordered worksheet names through the exact live selected interpreter/backend, preserve numeric-looking names as names, reject malformed, duplicate, or oversized helper output, honor cancellation and runtime/trust replacement, and never prompt during the automatic first-sheet open. Automatic routing must prove that a multibyte UTF-8 delimiter skips Polars but can select DuckDB or Pandas, a multibyte quote selects only Pandas, and an incompatible pinned backend returns `unsupported_import_options` before interpreter resolution, dependency probing, or process startup. Coordinator tests must cover one stable public identity/revision, pinned and automatic backends, exact plan/draft/view replay, regenerated engine-native code and draft diff/warnings/before-schema, rejected concurrent work, close/cancellation/transport/malformed/replay races, post-swap runtime/public revision translation, exact rollback, candidate and retired cleanup, first/fallback terminal cleanup without runtime startup, cleanup diagnostics without restart, and `onIdle` only after per-delegate cleanup settles. Panel and React tests must exercise the toolbar/command intent from a live grid and an initial-load error, prefilled prompts, the synchronous pending-view-state flush, operation-form close and busy/disabled interlock, rejection of runtime and late view-state work after the host transaction begins, retained confirmed data on failure, revision-correlated presentation replacement, late-response suppression, and disposal. Extension-host and packaged VS Code/Cursor acceptance must repeat those flows with non-default delimited input, sheet name/index, malformed files, cancellation, Restricted Mode, byte-identical sources, zero retained sessions, and a stopped runtime; do not mark this slice packaged-green until that evidence is recorded in `docs/feature-parity.md`.

Delimited-reader regressions must also open zero-byte and BOM/whitespace-only CSV/TSV sources as native 0-row × 0-column sessions in Pandas, Polars, and DuckDB, verify empty pages/statistics and unchanged source identity, and retain one non-empty malformed quoted-field failure for every engine. The webview must label the resulting state as an empty dataset rather than showing a parser error or an unlabeled blank grid.

VSIX-content unit tests must use an otherwise valid allowlist and prove that exact, case-folded, file/directory, and file/descendant archive-path collisions are rejected independently of missing entries. Absolute paths, backslashes, empty or dot segments, Windows-invalid names, malformed Unicode, and non-NFC spellings must fail before allowlisting. Preview-metadata tests cover a missing, duplicated, false-valued, wrong-parent, duplicate-container, wrong-namespace, namespaced-attribute, text-only, or noncanonical prerelease property; malformed XML, duplicate attributes, document types, and malformed/non-boolean packaged preview metadata must fail closed. Stable metadata must reject the prerelease property entirely. The release gate then runs the same verifier against the exact artifact before editor installation.

By-example contract regressions must distinguish synthesis-only preview requests from retained runtime metadata and persistence: an omitted program is valid only before synthesis and must be rejected everywhere replay could otherwise choose a new candidate. Operation-builder tests feed unsafe positive, negative, and exponent-form integer tokens as raw JSON and prove they are rejected before native parsing, while the same digits inside JSON strings remain valid. Modal tests require inert/assistive-technology-hidden background content, forward and reverse focus wrapping, Escape close, and focus restoration to the exact opener or a stable fallback.

Coverage is a regression guard, not a substitute for scenario acceptance. TypeScript/webview floors are 60% statements, 55% branches, 60% functions, and 65% lines; Python runtime coverage must remain at or above 78%. The required PR coverage job and every release path that runs `npm run test:coverage` provision Temurin Java 17, exact `pyspark[connect]==4.2.0`, and Pandas `>=2.2,<3.0` before enforcing that unchanged floor. A failed PR coverage job retains any available reports for seven days; a successful job retains no coverage artifact. Workflow contracts require every same-run canonical-VSIX cache consumer to fail closed on a miss, bind restored bytes to the producer job's exact digest and size, and repeat the package inventory check. They also prohibit release and stable-performance workflows from substituting that pull-request cache for their canonical artifact-ID, checksum, and provenance contract.

Protocol fixtures and engine-operation cases must run through both TypeScript and Python decoders. Transport tests must reject unknown request/response variants, extra fields, malformed preview/inspection/export/close requests, operation-kind/parameter mismatches, malformed nested metadata/pages, stale envelope IDs, mismatched request/response kinds, plan actions, runtime IDs, revisions, step IDs/indexes/page offsets, columns, export destinations, and view correlations before any coordinator state is published. Inspection pages accept at most 10,000 rows, and their diff reports truncation whenever rows exist before or after the returned block, including a nonzero final block. Applied-step tests cover Pandas, Polars, and DuckDB prefix replay, paging, duplicate IDs, supersession, idempotent transport recovery, mutation/session clearing, active-panel synchronization, and exact restoration of confirmed filters and grid state; React tests also require accessible before/after diff labels and disabled inspection-time view controls. Webview tests prove that only same-origin validated host messages and its explicit outbound intent allowlist are accepted, a recreated panel cannot retain an ephemeral inspection, and panel disposal clears active UI selection before bounded asynchronous cleanup completes. Polars tests monkeypatch `DataFrame.to_pandas` to fail. DuckDB tests make relation-to-Pandas, relation-to-Polars, and relation-to-Arrow APIs fail. Cross-engine operation tests compare normalized semantic output and separately validate engine-native generated code.

Multi-output literal split has one separate `splitTextColumns` contract; legacy indexed `splitText` bytes and meaning
remain unchanged. Decoder, UI, live-engine, generated-code, and Native-R catalog tests require 2–64 ordered unique
output names, a non-empty literal delimiter, retained source data, null propagation, empty-part preservation,
missing-part nulls, deterministic truncation of extra parts, stable step/output-ordinal identities, and atomic
collision/private-name rejection before dispatch. Pandas, Polars, DuckDB, and Native R execute natively; PySpark
remains viewing-only. The installed platform-smoke owner opens the distinct form through the shared webview, checks
ordered stable output identities and a missing-part null in the live Polars preview, applies, undoes, and retains the
exact source bytes. Native R's complete-catalog owner independently executes the live, generated, and replayed form.

Public regex extraction has one separate `extractRegexGroup` contract; legacy indexed `splitText`, multi-output
literal `splitTextColumns`, find/replace regex mode, and the private by-example regex AST retain their existing bytes
and meaning. Shared fixtures bind a single-line, valid-Unicode-scalar portable subset, one variable-width quantifier,
at most nine captures, first-leftmost matching, group 0 as the full match, and a fixed group selector. Null input,
no match, and an unmatched optional group yield null; a participating empty group yields an empty string. Source
values are bounded to exactly 8,192 Unicode scalar values and 8,192 UTF-8 bytes before regex dispatch, while patterns
are bounded to 4,096 scalar values and 16,384 UTF-8 bytes. Output names are single-line, valid scalar text bounded to
1,024 UTF-8 bytes. Decoder and engine tests reject NUL, CR/LF, lone surrogates, unsupported dialect constructs,
resource-dangerous quantifier combinations, invalid group selectors, type mismatches, private names, and output
collisions before dispatch. Live and executable generated Pandas, Polars, DuckDB, and Native R share those vectors;
DuckDB collision checks are case-insensitive and PySpark remains viewing-only. The installed editor journey uses the
shared operation form for Pandas and Native R. Both backends cover invalid-pattern rejection, preview/apply/undo,
source retention, null/no-match/empty-capture behavior, stable step/output identity, generated code, and clean
session/source disposal; Pandas additionally closes and reopens the persisted step before undo.

Pivot longer has one separate `pivotLonger` contract. `src/test/pivotLonger.unit.test.ts`,
`python/tests/test_pivot_longer.py`, `src/test/rKernelBridge.unit.test.ts`, and
`r/tests/kernel_agent_pivot_longer.R` own the 2–64 ordered stable references, portable output-name collision rule,
row-multiplication preflight, exact scalar/class metadata, selected-column-major order, positional output rows, fresh
private row identities, and live/generated parity. Pandas category, Polars Enum/Categorical, Native R factor,
`POSIXct`, `difftime`, and `integer64` cases prohibit common-type coercion. Native R additionally covers poisoned S3
concatenation, explicit row names, tibble/data.table flavor, cleared keys, and source immutability. The bridge spy
owner proves overflow, metadata drift, and output collisions fail before R transport dispatch. The shared packaged
journey in `src/test/extensionHost/pivotLongerJourney.ts` drives the production form, exact stable output IDs,
selected-column-major pages, generated code, apply, and undo in the packaged Python and Native R flows. PySpark stays
viewing-only.

Pivot wider has one separate `pivotWider` contract. `src/test/pivotWider.unit.test.ts`,
`python/tests/test_pivot_wider.py`, `src/test/rKernelBridge.unit.test.ts`, and
`r/tests/kernel_agent_pivot_wider.R` own its exact names/value references, ordered 2–64 typed keys and outputs,
portable output-name collision rules, full-domain and duplicate-pair rejection, first-occurrence identifier-group
order, missing-combination typed nulls, stable retained/output lineage, positional output rows, and live/generated
parity. Pandas, eager/lazy Polars, DuckDB, and Native R preserve the value column's exact scalar/class metadata
without common-type coercion. Native R additionally covers factor, `POSIXct`, `difftime`, `integer64`, cleared
data.table keys, source flavor, and immutable input. Host spy owners prove row/schema/output failures reject before R
transport. The shared packaged journey in `src/test/extensionHost/pivotWiderJourney.ts` drives renderer recreation,
saved-form hydration, ordered outputs, stable output IDs, preview paging, generated code, apply, non-latest edit and
delete with ordered suffix replay, committed-boundary undo, and source restoration in packaged Python and Native R
flows. Their enclosing packaged owners close every editor and require zero retained sessions plus a stopped runtime.
PySpark stays viewing-only. Transpose, explode, and unnest are not implied by this evidence.

Two-dimensional grid-window tests are release-blocking. Every open/page/preview/inspection/apply/discard/undo request must reject a missing, negative, zero, or greater-than-256 column window. Every returned page must carry unique stable column IDs in the requested schema order and exactly one value per returned column in every row; unknown, reordered, duplicated, over-wide, or cardinality-mismatched blocks fail before publishing state. Runtime tests cover first/middle/final projections, zero-column frames, filters and sorts whose columns are not transported, duplicate/non-string positional Pandas selection, Polars projection before lazy collection, explicit DuckDB terminal selection, private row identity, projection-specific cache hits/eviction/invalidation, and unchanged full-width code/export results. React and coordinator tests cover aligned horizontal demand, deduplication, stale response rejection, projection-preserving row paging/retry/mutations/inspection, stable-ID diff lookup across schema reordering, full-schema ARIA indices, and far-column keyboard focus. The strict runtime benchmark requests the shipped 16-column block size and records that resolved count, cache weight, and p95 page latency; it does not measure an individual serialized response's byte size or editor paint. Packaged VS Code and Cursor acceptance makes direct extension-host protocol requests against a 300-column source, verifies exact far-column values, and bounds the returned identities and row vectors. Unlike the native editor workbench, the separate production-bundle Playwright harness starts from a projected page, scrolls to the final column, requires an exact row-and-column-keyed response, renders its known value, and rejects an unbounded or identity-misaligned block.

Pandas index-fidelity tests are release-blocking. `python/tests/test_pandas_index_fidelity.py` owns named index and
MultiIndex metadata, exact post-filter/sort labels, duplicate and non-string ordinary columns, row-axis bounds,
preview/apply/inspection/undo, source immutability, and explicit preserve/omit CSV and Parquet output. Protocol,
coordinator, native-view, and React owners must reject malformed cardinality and backend combinations, require the
explicit Pandas export choice before dispatch, preserve the exact request through the single Atomic Export writer,
and keep row labels separate from ordinary grid columns. The packaged owner
`src/test/extensionHost/pandasIndexFidelityJourney.ts`, called from the existing notebook flow, must open a real named
MultiIndex Pandas variable, verify accessible shared-webview row headers and full-schema coordinates, prove filtered
and sorted label order, inspect and undo a positional-index replacement, export one preserved CSV and one omitted
Parquet file through the real workbench choices, re-read those files, prove the live source unchanged, and close the
exact session without retaining coordinator state.

Configurable-export tests keep one format-discriminated `ExportOptions` object through the schema, TypeScript and
Python decoders, coordinator, engine, and existing Atomic Export transaction. CSV requires delimiter, quote,
encoding, and header fields; Parquet rejects those CSV-only fields. Pandas accepts its selected text codec and
Unicode syntax characters, Polars and DuckDB require UTF-8 with single-byte syntax characters, and Native R requires
UTF-8 plus the double-quote character while accepting a Unicode delimiter. Unsupported engine combinations must fail
before target reservation or artifact creation. The live Pandas index journey selects semicolon, single quote,
UTF-16LE, no header, and preserved index, then checks exact bytes and source/session cleanup. The active Native-R
terminal journey selects a Unicode section-sign delimiter and no header through the same workbench helper, verifies
all 240 exported rows, and retains the source, view, session, and atomic-publication cleanup checks.
The installed `platform-smoke` file journey accepts the confirmed semicolon import dialect as its export default,
checks that exact delimiter before and after persisted-plan replay, and still proves byte-identical source data.

Installed-editor performance acceptance uses private release-sized fixtures, strict versioned and path-free evidence, all untrimmed timing samples, descriptor-bound candidate and result receipts, exact packaged defaults, native Polars, and synchronized Linux page-residency proofs. It never enters ordinary pull-request CI, touches a normal editor profile, or launches on the user’s desktop. The preview-development, stable-release, and numeric-gate contracts are defined in [Performance](#performance).

Engine lifecycle tests must prove that the registry creates distinct adapters per session, closes rejected detection candidates, transfers ownership only for a match, and preserves adapter factory/detection diagnostics. Failure injection covers reader, shape/schema, initial page, source-version validation, and response-metadata construction; every failure must close the acquired adapter and retain no session. Preview/apply/discard/undo fault injection must prove atomic rollback of frame, plan, draft, revision, lineage, and page cache after a late page/diff/code/source failure. Cleanup hooks run at most once, a repeated explicit close is rejected, concurrent runtime shutdown callers join safely, cleanup failure is reported for an explicit close, and cleanup never masks an earlier open or notebook-render failure. Close must wait for foreground work and active profile leases, accept the caller's last confirmed revision after an ambiguous runtime mutation, cancel queued profiles, reject later work, remain terminal after transport failure, and never replay a closing session. Cancelled and wrong-session close acknowledgements receive one fresh bounded cleanup attempt; candidate, retired, saved-plan fallback, and late-open cleanup use the same correlation checks and fallback diagnostic sink. A detached cleanup timeout may not restart a shared standalone process. Shutdown must wait for pending opens and tracked detached cleanup within its bound, reject late registration, respect its grace bound, and retain a delayed kernel close after that bound until active work settles. Scheduler tests must prove exclusive mutation ordering, read-only same-session page/profile overlap, writer preference over newly arriving profiles, cross-session concurrency, explicit priority overrides, queued-view cancellation, stale logical-view/runtime-generation isolation, and no persistence/native-view churn for ordinary same-view paging. Persistence tests require the exact v4 cleaning/view split, source-and-confirmed-backend keys, rejection of unknown or malformed cleaning state, independent tolerance of a missing or malformed view, stable-ID width/selection pruning, restoration of the block containing the first visible row, clamping after a smaller result, final presentation flush on page hide/unload/unmount, and recovery without reinterpretation by another engine. They must prove that stale viewing state falls back to an empty view while preserving valid steps and a valid draft, and that only cleaning replay failure reopens the immutable original. Selection changes must refresh the active native snapshot, while scroll/width-only changes must not churn native views. Standalone process tests require stdin/EOF first, exit-cancelled fallback, idempotent stop, replacement-start gating through exact process exit, a latched failure when post-kill exit cannot be confirmed, reserved interactive worker capacity, authoritative results for already-running cancellation targets, and force-kill only after the ordinary request bound or a broken stream. Timeout-selection tests require the same 60-second session-open and 30-second initialized-request defaults in standalone and notebook transports, independently configured values, and explicit per-call precedence for bounded cleanup. A fresh subprocess must open a real Polars CSV and then a real Pandas TSV in one server process, and a second fresh subprocess must open a real Polars Excel workbook after discoverable PyArrow initialization on the owner thread; missing PyArrow keeps the newer native capsule path, while `fastexcel` and the Calamine read remain on the dispatched worker. Each regression returns correlated session envelopes within the session-open bound, closes its sessions, and exits cleanly on EOF. Windows runtime CI is the release guard for both cold native-import orders. Notebook lifecycle tests must prove single-flight acquisition/bootstrap, generation-conditional invalidation, an end-to-end acquisition-through-parsing reporting deadline, hung-acquisition detachment, fresh never-cancel Jupyter tokens for bootstrap and every request, no mutation/export/open/close retry after dispatch, stale-ignore after host detachment, and at most one retry for explicitly idempotent reads. Coordinator tests must prove ambiguous mutations are not reissued and the next request first reconstructs the last confirmed runtime state. Notebook snapshots must enforce source capabilities and close transient adapters on success and failure, and the stdio server must drain all sessions when input ends. Capability snapshots cover Pandas editing, eager Polars notebook values, lazy Polars file and live-notebook values, file-only lazy DuckDB sources without request-cancellation claims, viewing mode, notebook insertion, and a synthetic read-only/no-export engine.

Live-kernel open coverage must prove that the host supplies a non-empty candidate session identity, the runtime reserves and echoes it, and a failed, logically detached, timed-out, malformed, or mis-correlated open queues bounded exact-kernel cleanup for that known ID so lost output cannot orphan a session. Cleanup for a dispatched open may begin only after that exact open execution settles; `unknown_session` before settlement is never authoritative. The host bound must never cancel the Jupyter execution token, and a late correlated close must still retire the mapping. Coordinator concurrency tests must distinguish typed host detachment from transport loss, park all later same-session work behind the exact settlement promise, avoid automatic read replay or reissue, restore an indeterminate mutation only after settlement, and leave a pre-dispatch cancellation free of recovery side effects.

Standalone bridge shutdown tests must keep replacement startup blocked until the exact child exits, retain that block after the bounded confirmation failure, and clear it only after a later correlated exit. Overlapping stops must remain pending until every owned child's bounded result settles and aggregate multiple failures in registration order. Awaited shutdown is idempotent and disposes its configuration listener and output once; fault injection must prove listener failure cannot skip child shutdown and output failure cannot mask an exit-confirmation failure. Multiple bridge cleanup failures retain listener-to-process-to-output order, and synchronous `dispose()` starts and safely observes the same promise. Deactivation tests require coordinator-before-bridge ordering, bridge cleanup after coordinator failure, identity-preserving single failures, and an ordered aggregate when both layers fail.

Orderly runtime-shutdown coverage must prove that every registered session is drained after one cleanup fault, that multiple faults are reported in session-registration order, and that the initiating, concurrently joining, and later callers receive the same terminal error without running cleanup twice.

Value-operation edge coverage must additionally prove numeric, boolean, date, and text one-hot inputs share one global generated-name order; blank, null, and NaN categories are excluded consistently; categorical-null multi-label inputs remain valid; live/generated default stripping uses the canonical Unicode/control-whitespace set; and an empty literal find inserts the replacement at every text boundary on every engine. Operation-builder regressions must distinguish omitted/default multi-label prefixes from explicit empty prefixes and round-trip protocol-valid empty find patterns during saved-step editing.

Operation-edge fixtures must exercise runtime and executable generated code for per-column sort null placement and stable ties, independent null/NaN predicates and value filters, including explicit-false non-float NaN inclusion; missing-row any/all modes, duplicate keep last/none, categorical null/blank labels and output collisions, constant/non-finite numeric transforms, nullable group keys and every aggregate, portable by-example candidates, nested Pandas object isolation around custom code, and custom-code failures. Integer fixtures must cover both signs at the exact 38-digit success/overflow boundaries, order-independent cancellation, multiply-by-zero, and null propagation for group sum plus by-example addition, subtraction, and multiplication in all three engines. Native-width cases include Polars UInt128/Int128, DuckDB UHUGEINT/HUGEINT/BIGNUM, Pandas NumPy object integers, and the bounded Polars limb aggregate; overflow must be actionable rather than wrap or panic. Wide nullable Pandas group keys and extrema, Decimal sums under restricted caller contexts (including scale, all-null, and Decimal NaN), decimal mean/median float normalization, nanosecond NumPy/Pandas datetime and duration cells, typed page cells, generated code, and the no-`to_pandas()` invariant remain direct cross-engine regressions. The supported-Python matrix must force a missing object-string group through min/max on both Pandas 2.x and 3.x so live and generated reducers cannot drift with Pandas inference defaults. All 31 ID-backed operations, comprising nine structural, four row/order, sixteen categorical/text/numeric/datetime, group-by, and by-example, must reject legacy strings plus missing, extra, unknown, stale, name/type-mismatched, malformed private, or disallowed repeated identities before adapter execution. Group tests must allow one exact input to feed multiple uniquely aliased aggregations, collapse null and NaN into one missing group, and reject unsupported key/aggregate types before dispatch. By-example tests must prove ordered source selection and aligned scalar arrays, nested program-leaf binding, deterministic saved-program revalidation, literal regex replacement, ASCII-only casing, type/program compatibility, and the exact 16-source/64-example/256-node/depth-64/64-concat/8-KiB-string/64-KiB-total-UTF-8 limits before synthesis and after canonicalization. Binding tests prove public `{id, name}` versus private positions, output/private namespace guards, and exact duplicate/non-string Pandas targeting. Session tests cover preview, apply, inspection, replay, latest-step editing, undo, immutable sources, no leaked positions, and atomic rejection across all three engines.

Custom Code scope fixtures run against Pandas, Polars, and DuckDB. They reject future and wildcard imports,
`global`, `nonlocal`, outer `return`, outer `yield`, and invalid multiline syntax through the operation validator and
both engine seams. Hidden yields in decorators, defaults, keyword defaults, annotations, and lambda defaults are outer
yields; nested generator bodies remain accepted. Accepted fixtures cover ordinary and explicit imports, multiline
control flow, closures, and nested `return` and `yield`; each generated script executes and must match live output.
Generated fixtures compile with inherited future flags disabled and a module-valued ambient `__builtins__`. They prove
explicitly postponed annotations, normalization to the builtins dictionary, exact ordered fresh globals, module-scope
private-name and `__class__` behavior, canonical function name and qualified name, no ambient NumPy, DuckDB helper,
or plan-dependent Polars helper leakage, cross-step namespace
isolation, Pandas/Polars Series normalization, and scalar-result rejection. Complexity fixtures require deep unary
source and parser-memory pressure within the public byte limit to return the stable Custom Code error. Terminal and
interior LF, CR, CRLF, vertical-tab, form-feed, file/group/record, next-line, and Unicode line/paragraph separators must
match the streaming generated-size model. A 5,000-step small-body plan must cross the complete per-step scaffold bound
and fail before adapter generation or transformation can allocate a program beyond 4 MiB. Session tests reject
incompatible code before creating a new draft or replacing an applied step, with the revision, plan, committed frame,
lineage, and draft state unchanged.

File-source tests must cover quoted/delimited and headerless CSV, a non-UTF-8 Pandas CSV, invalid UTF-8 replacement decoding, TSV, JSONL, Parquet, modern `.xlsx`, and a real legacy BIFF `.xls` workbook by sheet name and zero-based sheet index in both Pandas/Polars parity engines. `utf8-lossy` acceptance must prove the sentinel never reaches a Python codec lookup, automatic selection probes only Pandas even when Polars and DuckDB are absent, invalid bytes become `�`, and a missing Pandas dependency remains a structured pre-start diagnostic. Dependency tests must prove the matching parser contract: DuckDB requests ordered `duckdb>=1.5.4,<1.6`, exact `fsspec==2026.7.0`, and `pytz` requirements; missing or non-exact fsspec fails before runtime startup. Pandas `.xlsx` requests `openpyxl>=3.1.5`, Pandas `.xls` requests `xlrd>=2.0.1` and never `openpyxl`, and Polars Excel requests `fastexcel>=0.9`. Environment probes must canonicalize real symlink/junction and Linux `/proc` aliases to one absolute package root plus the same filesystem device/inode identity, accept the full Windows 128-bit inode range, reject malformed or unsafe identity payloads, and distinguish a same-path replacement. Command-resolution tests must prove a bare override cannot be shadowed by the workspace or empty/relative `PATH` entries, a wrapper is pinned to its reported fully qualified interpreter without realpathing away a virtual environment, and current-drive-rooted Windows paths are rejected by dependency probing, installation, and runtime startup. The Windows discovery seam may invoke `py.exe` only as `-0p` with automatic installation disabled; strict empty, malformed, legacy, free-threaded, drive, and UNC listings must either yield direct supported `.exe` paths or no interpreter probes. The public install command must ignore caller arguments, show a modal with exact requirements/interpreter, require the literal affirmative action, preserve retryable diagnostics on decline, serialize concurrent attempts and, after every matching runtime has quiesced, freshly revalidate trust, lifecycle, current interpreter, canonical root identity, requirements, event authorization, and exact barrier ownership immediately before pip. A trust, configuration, Python-environment, executable, path, or filesystem-identity change during that wait must launch no child. After successful pip, tests must prove the captured dependency epoch is invalidated so older probes fail closed, while a genuinely newer interpreter selection is preserved. The environment-gated test API's dependency-install decision may only decline and may never confirm installation or become a sticky production override. Pip-process tests must reject inherited alternate-interpreter, destination, config-file, extra-requirement, and auxiliary output-path overrides case-insensitively while retaining network and cache configuration, and the already-pinned absolute interpreter must run from a private mode-0700 directory rather than a home directory containing `pip.py`; that directory remains owned until exact close and is then removed. Packaged-editor affirmative acceptance requires exactly one visible and enabled **Install** action, moves the pointer to a neutral workbench edge until any unrelated Monaco hover is gone, dispatches the real control once with Playwright's own cancellable timeout and no post-click navigation wait, then requires the real modal to close against a private no-network fake-pip interpreter and proves exact arguments, disabled pip configuration, and sanitized environment. The first-use and full verify paths additionally require the same XLSX error tab and renderer to become a live, keyboard-usable Pandas grid after the successful reprobe while the workbook stays byte-identical; the terminal lifecycle case separately proves bridge shutdown waits for its exact child to exit naturally without reporting post-disposal success. Tests must invalidate stale targets after an `openWrangler.pythonPath` override change or successful later probe and reject stale continuations across every awaited selection boundary. File tests must reject missing and malformed inputs as structured engine errors, prove failed opens retain no session, and assert Polars CSV/TSV/JSONL/Parquet sources remain lazy. Literal-path regressions must cover brackets that would otherwise select a matching sibling, plus asterisks, question marks, and braces, across all four lazy Polars formats; they also prove native `glob=False`, the encoded-file-URI compatibility path, page access, close, and immutable source bytes. The DuckDB preview separately covers native lazy CSV/TSV/Parquet/JSONL reads, reports malformed JSONL as an input/open error even when its path resembles an extension diagnostic, and rejects Excel and non-UTF-8 CSV with an actionable diagnostic; `.duckdb` database browsing is not a file-source claim. Native DuckDB rich-Parquet fixtures preserve exact DECIMAL values, normalize TIMESTAMPTZ through UTC-owned connections, retain LIST and STRUCT values as strict JSON, and exercise the same page, summary, filter, sort, and export paths without conversion. DuckDB export tests require one request-owned non-cacheable fsspec writer URI, exactly two metadata probes and one binary write open, no inherited path/read/remove capability, no conversion, deterministic unregister, relation release before unregister, and outer-owned descriptor close even when the first native write fails. A relation-lifetime spy must prove that open, page, custom transformation, apply, and export retain only connection-free `DuckDBSqlPlan` frames, dereference every request-local native relation before closing its owner, and never call `DuckDBPyRelation.close()`. A deterministic overlap test holds a completed summary connection while a concurrent page finishes, then requires every tracked connection to be released before atomic replacement. The Windows installed-editor checkpoint must replace the rich Parquet source immediately after a typed page and all correlated foreground and background reads quiesce, then receive the intended recoverable reopen diagnostic. Lazy-file tests atomically grow, shrink, replace, delete, and change the schema during and after open; every later data-reading request, including a cache hit and export, must reject the changed fingerprint while close still succeeds. Eager Pandas files and notebook variables remain in-memory snapshots and do not receive a file fingerprint. Typed-cell fixtures cover NumPy/Pandas nullable scalars and strict JSON, while nested Polars fixtures cover unsigned large integers, decimals, time zones, lists, structs, binary, categoricals, durations, null/NaN/infinity, and long Unicode text without a Pandas conversion. Pandas MultiIndex-column fixtures must prove the tuple-form sentinel stays excluded from shape, schema, pages, and exports. Pandas/Polars source frames remain page-safe with zero visible columns; no transformation may create that state because Polars/DuckDB generated functions and exports cannot preserve a positive-height zero-column frame. Equivalent DuckDB zero-column source acceptance remains pending where DuckDB cannot represent such a relation.

Persistence tests must assert that only serializable replay state is stored, unknown fields and malformed operation kinds or parameters are rejected through the shared discriminated-step guard, import options participate in source identity, and runtime/public session identifiers never enter workspace state. The bounded `openWrangler.confirmedFileConfigurations.v2` registry must strictly reject malformed/mixed-format entries, unknown resolved backends or logical backend preferences, wrong versions, lone-surrogate delimiters/quotes, import options on Parquet/JSONL, and missing options on CSV/TSV/Excel; key configurations only by canonical file URI; prune oldest entries; and write only after a correlated successful file open/reconfiguration. Custom-editor tests allow one editor per document and prove recreation pins the last confirmed concrete backend, including option-free Parquet/JSONL, and reaches the identical source-plus-backend cleaning/view key despite later engine-availability or default-setting changes. Separate automatic and explicit cases must prove that the logical `backendPreference` survives recreation: crash recovery stays on the confirmed concrete backend, automatic import reconfiguration may choose another compatible backend, and explicit reconfiguration remains pinned. A deferred-Memento race must prove an authoritative replacement source/revision/snapshot is adopted before persistence, the next queued change targets that revision/source, and only stale UI publication is suppressed. Saved MIME-v2 outputs pass their own bounded payload validation before the inline renderer displays them and never enter workspace persistence. Packaged release acceptance applies a plan and view sort in one process, reopens the same source in a fresh process, and verifies the restored transformed grid in both VS Code and Cursor.

Notebook tests must exercise complete and truncated MIME v2 captures, malformed versions, proactive Pandas/Polars formatter preparation after kernel permission, exact source-document retention, and insertion of the edited generated code. Provider-coordinator tests prove that trusted exact Jupyter notebooks prepare before any Open Wrangler command, transient retries remain bound to that document, kernel invalidation prepares the replacement generation, and close/disposal stops later work. With Microsoft Data Wrangler installed, the default `ask` state registers nothing until the modal choice resolves; Open Wrangler, Data Wrangler, disabled, dismissal, persisted preference, setting changes, and the new/restarted-kernel boundary remain deterministic.

The renderer's **Open in Open Wrangler** action is live-only. A canonical linked output must open the complete current variable through the exact visible sender `NotebookEditor`, exact originating `NotebookDocument`, exact selected kernel, and normal backend detection. It may never open captured rows as a workbench session. An unassigned Pandas or Polars expression receives one unpredictable kernel-local handle without exposing that handle in the UI; the released-editor journey executes `orders_preview_df.tail(3)` once, clicks the physical action once, and proves the new session contains exactly that three-row live result. Expired and malformed handles fail without falling back to user globals or the saved capture. An older unlinked output remains readable inline and exposes no open button or false rerun instruction. A linked-but-missing variable or unavailable kernel must produce actionable run-cell/kernel recovery instead of opening captured rows. Toolbar and Jupyter Variables tests independently execute bounded discovery through the exact selected kernel and present canonical Pandas, Polars, PySpark, and recognized DuckDB relation variables. Pinned and auto-detected PySpark launches must run an isolated type-and-version probe inside the authoritative bridge generation immediately before runtime open dispatch; strict 4.2.x proceeds, while missing, malformed, 4.1, 4.3, and 4.20 versions fail with actionable guidance and zero created session. A silent A→B kernel switch and an observed restart must invalidate and reprobe B before dispatch. Probe tests preserve colliding user globals and prove module `__getattr__` is never invoked. The picker and opening stage must say **Viewing only**. Opening must publish an exact schema and one bounded page without counting, globally indexing, or caching the complete DataFrame. Free-form names, malformed or spoofed discovery, non-Python kernels, focus changes, closed documents, and duplicate same-URI documents fail without opening or retargeting a session.

Producer/consumer contract tests pin the 10,000-row, 2,048-column, 100,000-cell, 16-MiB, field-text, 64-depth, and 1,000,000-node capture caps; cover exact boundaries, deeply nested cells, repeated/cyclic containers, strict typed-cell coherence, and UTF-8/code-point accounting; and reject oversized output incrementally. Every v2 page must carry exact full-width `columnIds`; missing or partial schemas fail closed. Polars `LazyFrame` capture proves no normalization or full-frame collection and one bounded terminal page with no eager profiles. Renderer component/browser tests page captured rows at 10, 20, 50, and 100 rows per page, keep Previous/Next inside the capture, expose every captured column horizontally, retain honest truncation labels, and preserve readability without host messaging.

The parallel live-session contract opens a one-million-row scan-backed Polars `LazyFrame` from a notebook binding. It
requires lazy metadata and retained lazy original/committed/draft frames; exercises the projected initial page,
filtering, sorting, column summaries, dataset profiles, a lazy-preserving text edit, apply, native Parquet export, and
close; and proves the notebook object's schema and logical plan do not change. Traps on `LazyFrame.collect`,
`polars.collect_all`, `Series.to_list`, and Pandas conversion reject an unbounded terminal result or engine crossing.
Separate explicit-preview cases require One-hot encode and Multi-label binarize to remain lazy through open, then
record their data-dependent eager draft and `lazy: false` metadata only after the user requests that operation.

Two-notebook renderer acceptance keeps A and B visible with B active, activates A's physical linked action once, and proves only A's current live value and kernel are used. No active-editor, URI-match, other-split, capture, or snapshot fallback is accepted. Deferred activation, kernel lookup, bootstrap, dispatch, and response fixtures replace or close the exact origin at every boundary; malformed output, transport failure, cancellation, timeout, wrong identity, duplicate identity, and stale-generation success must clean each dispatched candidate once on its exact original kernel. Before enabling preview formatters, the released-editor journey executes a Pandas tail expression once, confirms that its plain Jupyter result contains neither Open Wrangler MIME nor the removed rerun instruction, and clicks the physical cell-status action. The resulting session must contain that exact three-row value from the same kernel while the cell's execution order and output remain unchanged. Released-editor acceptance then repeats proactive formatting, provider choice, typed toolbar discovery, linked inline live opening over a dataframe larger than its saved capture, unlinked inline guidance, recovery, denial, paging, and originating-notebook insertion in packaged VS Code and Cursor. The inactive split-notebook race uses one ordinary physical pointer activation with bounded geometry and an authoritative A-bound live-session receipt; it never uses a synthetic DOM click, forced locator action, or a retry after indeterminate dispatch.

`fixtures/view-literal-contract.json` continues to drive integer, float, decimal, boolean, date, datetime, duration, null/NaN, exact-wide-value, regex, and portable ASCII-folded search behavior through live engines, generated code, and the retained snapshot contract. Renderer browser tests preserve the selected page size across rerenders and retain honest truncation labels without internal-state banners. Variable-viewer, manual-launch, discovery, provider, insertion, and renderer tests all repeat exact-document identity checks around every await. Duplicate same-URI documents, pre-dispatch replacement, version changes, accepted-but-unprovable URI edits, wrong returned identities, and late stale results fail closed and clean every known candidate on its original kernel. Real-kernel tests render Pandas and Polars, recover after restart, and terminate the kernel; the remote-compatible stable-API double transfers only validated packaged runtime sources and retains no session after denial.

For proactive notebook preparation, “trusted exact Jupyter notebook” means the exact visible `NotebookDocument` with a user-started kernel. Stable `getKernel()` lookup must never synthesize a kernel; an API-opened background notebook must cause zero lookup; becoming visible must start preparation; and a real visible-notebook change must bypass pending retry backoff. Hiding or closing the document disposes its formatter-preparation bridge, while split-notebook acceptance compares each visible notebook against its own pre-action kernel baseline so an action from A can never advance B.

Export tests must cover the Pandas/Polars parity engines, the DuckDB file preview, and both supported formats. Runtime
tests must prove committed-plan output, exclusion of view filters, pending-draft rejection, source-path rejection,
host-target identity validation, target-replacement detection, and engine-native writes to the reserved file. Polars
must never convert to Pandas, and DuckDB must disable its own temporary-file replacement. Focused host tests must run
the Python bridges through the shared atomic transaction and inject destination symlink/replacement, destination-parent
replacement, temporary-target replacement, source hard-link alias, runtime failure, commit failure, and owned-temp
cleanup. Every failure must preserve the source and prior destination and remove only the still-identified owned temp;
success must report the user's final destination rather than the internal target. The Native R bridge must retain the
same host publication and rollback invariant even though its runtime streams bytes instead of writing the reserved
path. Cleaned-data export must pin the exact originating public session and revision before any Quick Pick or Save
dialog, revalidate trust, draft state, and format capability after every await, and prove that changing the active
dataframe cannot retarget the export. DuckDB's installed-editor cross-platform destination matrix remains pending.
Code export acceptance must verify the edited CodeMirror buffer, not only the original generated string. The public
script command must ignore caller arguments, invoke the real Save dialog after trust/active-code checks, recheck trust
after the dialog, pin the immutable open-request source and current local or matching remote host, and cover success
plus cancellation and source selection. The script-writer matrix must exercise exact/normalized/platform-case/symlink/
hard-link aliases, destination and parent substitution, directories/virtual/cross-remote targets, exclusive-name
collision, concurrency, temp identity, and injected open/write/sync/close/revalidation/replace/cleanup failures while
preserving the source and prior destination and removing only its still-identified temp.

Identity tests must prove stable row tokens through filtering, sorting, projections, and value changes; deterministic new generations for group/custom results; globally unique column lineage through renames, reorders, drops, dynamic/cross-kind latest-step edits, and duplicate labels; and identity exclusion from schema, summaries, duplicate counts, custom code, generated code, and exports. `test_column_binding.py` covers strict public-to-private resolution, including recursive by-example leaves and group type rules; `test_lineage.py` covers exact duplicate-label structural/group identities plus deterministic edited-output replay; and `test_session_column_binding.py` covers Pandas, Polars, and DuckDB preview, apply, replay, inspection, latest-step edit, undo, group/by-example binding, stale/private-reference rejection, public/private separation, and rollback. `test_session_transactions.py` includes the bound plan and bound draft in every late-failure snapshot. Adapter and generated-code tests separately prove positional Pandas behavior and safe flat-column appends to MultiIndex frames. Stable-reference implementation alone does not close the broader duplicate/non-string matrix: the exact built VSIX must first reorder a live mixed-label Pandas frame, then preview and apply select, clone, cast, formula, text-length, drop, and rename steps against the shifted identities in both VS Code and Cursor. It must verify positional executable code, exact typed values, deterministic output IDs obtained from runtime metadata, position-free public steps, immutable source data, kernel-replacement replay, and terminal cleanup.

Response-boundary fixtures must reject empty or duplicate column IDs and duplicate, reordered, or gapped positions in active metadata, latest-step input metadata, and applied-step inspection schemas. A valid schema's positions are exactly `0..n-1`; each schema validates independently before any coordinator or webview state update.

By-example tests must exercise every candidate family, deterministic tie ordering, ambiguity warnings, failure diagnostics, persisted-program revalidation, native execution, and generated-code equivalence in Pandas, Polars, and DuckDB. A synthesized step is not accepted without draft/diff confirmation and apply/discard coverage.

## PySpark live-notebook viewer acceptance

The request-ownership cases check that overlapping Classic requests see different groups and restore their own caller properties, nested and failed scopes restore caller state, unrelated tags and scheduler pools are untouched, and terminal close does not enter Spark ownership. Connect actions keep their existing tags and operation-specific interrupt behavior. Neither path changes the process signal handler.

The CI coverage lane installs exact `pyspark[connect]==4.2.0`, Pandas `>=2.2,<3.0`, and Temurin Java 17, verifies those runtimes, and then runs the complete instrumented Python suite. That full-suite coverage is the authoritative pull-request PySpark runtime evidence. Use the following two-file command only for focused local iteration:

```bash
python -m pytest -q python/tests/test_pyspark_engine.py python/tests/test_engine_registry.py
```

`test_pyspark_engine.py` parametrizes the same native viewing contract across a real classic `local[2]` Spark session and Spark Connect's local `remote("local[2]")` mode. It exercises DataFrame detection, schema and typed cells, progressive projected pages, basic/advanced filters, multi-column sorts, summaries, statistics, bounded distinct values, cleanup without stopping the user's Spark session, and exact open errors for streaming frames, conflicting or reserved names, missing DataFrame operations, and unsupported Variant columns. The Variant case also passes through the kernel dispatcher and must return its request ID without retaining the candidate session. A Classic million-row/32-partition regression proves that the first block creates no persistent RDD and does not schedule every source partition. Page tests require one-row lookahead, honest unknown totals, contiguous anchors even after terminal exact-total promotion, and rejection of an observed boundary change without claiming deterministic unordered traversal. Component and packaged-editor checks cover both PySpark ordering labels, the keyboard-accessible unique-final-key help, the **Viewing only** and PySpark badges, absence of an Experimental badge, and containment of every session badge. Coordinator and component tests require recovery to rebuild a nonzero viewport through adjacent blocks, start from zero even when the replacement's first page already knows its total, cap reconstruction at 16 page requests with a viewport-only reset beyond that cap, preserve the confirmed filter/sort/widths/selection, and convert Spark scrollbar jumps into adjacent demand. Replacement tests stop or rebind the exact live source before a cached-window request and require correlated invalidation before any stale block can return. Focused fake-kernel host tests capture representative discovery, bootstrap, open, page, and close executions and prove that each receives a fresh never-cancel token, that post-dispatch UI disposal and host deadlines do not interrupt the kernel, that a late correlated session open is closed once on its exact originating kernel, and that a terminal cleanup error retires only its exact session mapping. Queued or superseded requests must be discarded before dispatch. There is intentionally no **Cancel opening** action for work already running: Jupyter token cancellation sends a kernel interrupt, and PySpark's default SIGINT handler may call `SparkContext.cancelAllJobs()` for unrelated user work. Nested struct fields that duplicate or collide without case must fail before paging because their JSON object representation would lose data. Reordered maps and nested maps must share one native canonical profile key in both modes, equal nested signed-zero values must not split groups, and their displayed representative must be deterministic. String, binary, array, map, and struct pages carry guarded values and exact row lengths through one bounded terminal action; a row over its conservative share of the 8 MiB allowance is replaced by null inside Spark and rejected before the actual oversized value crosses into Python. Separate tests enforce exact page/profile protocol-byte boundaries, complex-value node and nesting limits, exact nested decimal decoding, and terminal profile projections that exclude private group keys. Conversion methods such as `toPandas`, `toArrow`, `mapInPandas`, and `mapInArrow` are replaced with hard failures; page/value bounds and fixed-size aggregate results are asserted directly.

The summary action regression observes every real terminal collection. The ten-column mixed fixture requires four
fixed-metric batches, three guarded top-value batches, and one nonconstant numeric histogram batch. It therefore
completes in exactly eight actions; one numeric column remains exactly three actions. A separate
batched-versus-single-column fixture compares both Python objects and canonical compact UTF-8 bytes across wide
integers, decimals, float null/NaN/infinity values, Unicode text, booleans, dates, timestamps, binary values, arrays,
maps, structs, and day-time intervals. Oversized batched values must remain null in the terminal projection before the
recoverable error. Classic physical-plan assertions require the top-value batch to contain one bounded explode and
the histogram batch to contain one native aggregate, with no union of independently scanned branches. Column-value
discovery retains its exact one-action regression.

The opt-in released-Jupyter matrix adds a separate `jupyter-pyspark` packaged phase with its own isolated profile and 300-second editor deadline. Before provisioning that phase, the runner reports the bounded Java version selected from its isolated `PATH` and requires Java 17 or newer for PySpark 4.2. It installs the exact candidate VSIX and released Jupyter extension, selects the private kernel through the real picker, pins both Spark's driver and worker Python to that exact kernel executable, creates real local Classic and Connect DataFrames, and opens each through Jupyter's public Variables action. Both sessions must hydrate and synchronize a real webview, return deterministic filtered and sorted pages, and profile all three columns in schema order before stopping and recreating their user SparkSession plus same-named variable in the same kernel. Re-requesting the previously cached page must preserve the public Open Wrangler identity and confirmed view while returning values found only in the replacement frame. A separate Classic case restarts the exact notebook kernel, proves that its PID changed, recreates the user's DataFrame, requests the original public Open Wrangler session ID, verifies that the filtered page recovers, and then proves that closing Open Wrangler leaves the replacement SparkSession usable. The ordinary Restricted Mode phase dispatches the declared PySpark Variables command and proves that it cannot activate Open Wrangler, create a coordinator, or start a runtime. Release candidates assign this complete phase to VS Code as the single comprehensive owner. Cursor's candidate ownership is the separate generic lifecycle/responsive-grid/reveal-state seam; it does not duplicate released-Jupyter or PySpark phases.

For a local profiling check, run:

```bash
npm run benchmark:pyspark-profile -- --json-out tmp/performance/pyspark-profile.json
```

To collect the same report away from a developer laptop, manually dispatch the `Performance gates` workflow with
`Run the 1M-row PySpark profiling measurement` selected. That job is opt-in: pull requests and the weekly schedule do
not run it. It uses the normal public Linux runner, Java 17, Python 3.12, and PySpark 4.2, then uploads the JSON report.

This command does not run in pull requests. By default, it creates the same ten-column dataframe in local Classic and
Connect, using 1,000,000 rows and 32 source partitions. The data includes skewed text, nulls, NaN, numeric extrema, a
UTC timestamp, decimals, binary values, arrays, maps, and structs. After one untimed warm-up for each mode, the command
records three selected-numeric-column samples and three all-column samples. The JSON report includes all timings,
their median and maximum, Spark and machine versions, the dataframe size and partition count, conversion guards, and
cleanup results. There is no pass/fail time limit yet. Run it on an idle machine and review the numbers before using
them in a release claim. `--rows` and `--partitions` may be changed for diagnosis; the report records both values.

Run [30975727813](https://github.com/Matt17BR/openwrangler/actions/runs/30975727813) tested commit
`2f2c3545ef049a2ddf23e338451bef0e91834316`. It used the
standard 1,000,000-row, 10-column, 32-partition fixture, three warm samples, and the public four-CPU, 16 GiB Linux
runner with Java 17, Python 3.12, and PySpark 4.2. Classic and Connect conversion guards and cleanup passed.

| Mode    | Selected-column median | All-column median |
| ------- | ---------------------- | ----------------- |
| Classic | 3,329.058 ms           | 34,682.290 ms     |
| Connect | 2,966.619 ms           | 33,285.935 ms     |

Compared with the preceding exact-main run, all-column medians fell by 8.1% in Classic and 13.0% in Connect. The
selected-column changes, +3.8% and -6.2%, are too small to separate from runner variation with only three samples.
The uploaded JSON artifact has SHA-256
`a02bacc2a5f11fe0a06e24ef3cbd68c5aedd312ffe3624086e1c7ad1cfbf2ade`.
These measurements are used to spot regressions; they are not a pass/fail speed target.

External or authenticated Connect servers, cluster provisioning, and running-request cancellation are not supported.
PySpark remains absent from the extension's production dependencies and is never installed into a user's kernel by
Open Wrangler. The acceptance runner installs it only into a run-owned private test kernelspec.

## DuckDB preview acceptance

The Pandas/Polars suites remain the Data Wrangler parity baseline. DuckDB acceptance is additive and file-backed; it must not be used to weaken, replace, or relabel either parity engine's evidence.

Recorded on 2026-07-16, the engine-specific command was:

```bash
.venv/bin/python -m pytest -q python/tests/test_duckdb_engine.py
```

It passed 5 tests covering lazy and hardened CSV/TSV/Parquet/JSONL reads, explicit Excel and encoding diagnostics, typed pages, filters/sorts, summaries/statistics/values, concurrent page/profile reads, all 27 runtime operations, standalone executable generated-code equality, CSV/Parquet exports, cleanup, and a `SessionManager` preview/apply/profile/export/close flow. Relation conversion methods for Pandas, Polars, and Arrow are replaced with hard failures during native-path tests.

The focused integration command was:

```bash
.venv/bin/python -m pytest -q python/tests/test_duckdb_engine.py python/tests/test_engine_registry.py python/tests/test_engine_lifecycle.py python/tests/test_typed_cells.py python/tests/test_performance_backends.py
```

It passed 41 tests. The complete Python regression command also passed 236 tests in 11.59 seconds:

```bash
.venv/bin/python -m pytest -q python/tests
```

These runtime results are complemented by the installed-package acceptance below: DuckDB CSV/TSV/JSONL/Parquet inputs, view queries, progressive profiles, representative operation groups, generated/edited code, exports, backend-specific persistence, injected restart/replay, multiple simultaneous sessions, disposal, themes/accessibility, dependency decline, and source safety pass in isolated VS Code and Cursor profiles. Focused notebook tests additionally require a connection-private in-memory relation, exact-origin paging/profiling, MIME-v2 capture, deterministic reference release, and hard failures for Pandas/Polars/Arrow conversions plus every editing/export entry point. Before DuckDB can move beyond preview, add its full semantic edge matrix, installed VS Code/Cursor Jupyter evidence, large mixed/nested fixtures, cross-platform CI evidence, and repeated full-size performance reports. Excel and `.duckdb` database/catalog/table browsing remain deferred and must not appear in a supported-fixture checklist.

## Visual and accessibility coverage

`npx playwright-core install chromium` installs the browser revision pinned by the lockfile. Install `python[dev]` into the selected Python environment before running this layer; the synthetic scenes are produced through real Pandas, Polars, and DuckDB runtime responses and deliberately have no static-data fallback. `npm run build && npm run capture:screenshots` updates the browser baselines from those protocol responses and the production webview bundle using that pinned Chromium unless `CHROME_BIN` is explicitly set. The fixture subprocess pins `PYTHONPATH` to this checkout's bundled runtime source, so another checkout's editable installation cannot silently produce incompatible protocol evidence. The harness supplies metric-compatible Liberation Sans/Mono values through the standard VS Code font tokens, disables optional shaping, and supplies standard scrollbar and list-selection tokens so Linux distribution fallbacks cannot shift geometry or native widget colors. The production stylesheet must reference `codicon.ttf` bundle-relatively, the harness must load that exact font rather than a system fallback, and the extension-host unit/VSIX gates must prove the webview CSP permits its origin through `font-src`. `npm run test:webview-acceptance` writes separate actual images under `tmp/`, fails above a 1% anti-aliasing-tolerant pixel delta, and never overwrites the baselines. On failure, CI retains available actual and diff directories for seven days; a successful visual run creates no artifact. Coverage includes light, dark, high contrast dark/light, 800/1280/1920px widths, and 80/100/150/200% zoom. The wide fixture contains 1,000 rows by 40 columns and supplies five independent 200-row blocks.

The composite webview gate first resolves one absolute prepared Python 3.10–3.14 interpreter and probes its fixed
visual dependency profile, then performs one classified 30-second browser launch-and-capture prerequisite before any
brand, media, screenshot, or accessibility assertion. Browser resolution permits only an absolute `CHROME_BIN` or the
lockfile-pinned Playwright browser; there is no PATH or system-browser fallback and no retry. Every preflight, capture,
axe scan, brand render, and responsive README render uses Playwright's public persistent-context API with its own
mode-0700 workspace profile/root, child-only HOME/XDG/TMP values, and the existing short POSIX temp alias. The parent
environment never changes, each capture remains sequential and uses 2,500ms of virtual settling, and nested cleanup
removes the alias before the root on setup, launch, assertion, and teardown failure.

The three summary-bearing by-example preview scenes additionally wait within the unchanged 30-second capture timeout
for exactly their expected completed header profiles. They reject profiling placeholders or harness errors before the
screenshot. Their page clock is paused before navigation, the virtual-time jump releases initial hydration once, and
the semantic wait resumes the clock for the resulting profile response and render. The pause handshake fixes wall time
at zero before suspension and then restores ordinary paused system-time behavior, so real time elapsed between clock
installation and suspension cannot request a backwards clock move. This path shares the capture's
remaining monotonic deadline. Scenes without that explicit readiness rule, including loading and error baselines, use
the same deadline accounting without semantic clock or readiness work.

Compact draft-review acceptance uses real Polars preview responses rather than hand-authored UI state.
`draft-preview.html` / `draft-preview-dark-1280.png` and
`draft-preview-dark-800.html` / `draft-preview-dark-800.png` require one **Draft review** region with the human
operation title, exact ordered diff labels, no warning for the unambiguous formula draft, and exactly one enabled
**Discard** / **Apply step** action pair. `by-example-preview.html` /
`by-example-preview-dark-1280.png` and `by-example-preview-dark-zoom-200.html` /
`by-example-preview-dark-zoom-200.png` repeat the contract with two structured account-code examples and ten
previewed split results at normal and 200% zoom, with no ambiguity warning for the uniquely synthesized program.
Every case rejects document or toolbar overflow, requires the review and live grid to remain visible, and keeps
horizontal grid overflow inside its scroller. Fixtures with confirmed filters also keep their typed, removable
**Viewing filters** row above the grid; inspection leaves that row visible while disabling its actions. Draft review
and applied-step inspection must not render
`.draftCode` or a `Generated Python code preview`; native **Code Preview** is the sole authoritative editable
generated-code surface.

Applied-plan acceptance requires one named **Cleaning plan** group inside the primary toolbar and no permanent
second cleaning bar. The production-bundle matrix injects a real applied step at 1280, 620, and 320 CSS pixels,
effective 200% zoom, and forced colors; it rejects document, toolbar, group, or child overflow, requires the grid
to remain visible, runs whole-page axe scans in the ordinary states and a focused forced-colors scan of the group,
and preserves the exact tab order **Add step**, **Edit latest**, **Undo**, **Export**. Component tests additionally
prove that activating the focused **Undo** button returns focus
to **Add step** only when it removes the final step, the webview still owns focus when the correlated response
arrives, and that exact button remains the focus origin (including a browser clearing focus only because the
pending button became disabled). A deliberate focus move, backgrounded webview, failed or cancelled mutation, host
action, or shortcut invoked elsewhere must not reclaim focus; the advertised shortcut invoked from the exact Undo
button follows the same restoration rule as activation.

The browser acceptance records keyboard cell navigation and resizing, Page Up/Down behavior across a live viewport resize under a throttled renderer, scroll-driven roving focus, far-column focus restoration, bounded row/column DOM counts, responsive drawer layout, advanced predicate interaction, the complete operation catalog, draft/diff presentation, applied-step input/output inspection, by-example input/warning states, editable CodeMirror code preview, and apply/discard/edit/undo shortcuts. Filter lifecycle components additionally require the above-grid active-filter row and the drawer's multi-column overview, ambiguity-safe typed value summaries, keyboard-focusable independent predicate/value removal, structural cleanup after the final condition, no-op **Filter rows** suppression, sort-preserving **Clear filters**, and a bounded confirmation-only filter undo distinct from cleaning **Undo**; the native Filters tree removes a whole column through the same host/webview action boundary. Its applied-step fixture is generated from real runtime `apply_draft` and `inspect_step` responses rather than hand-authored inspection data. It verifies accessible added-column/cell semantics, disabled inspection-time view controls, and that Escape leaves inspection without fetching or changing the confirmed view. A dedicated operation-dialog baseline supplies equal labels, a stringified non-string label, and an empty label; it must show positional duplicate disambiguation and a readable `(empty name)` option. The summary-family fixture is produced by a real Pandas runtime frame with duplicate numeric/categorical labels plus boolean and datetime columns. Its 800px and 200%-zoom baselines require exact numeric min/max, a full-width exact numeric histogram, focusable interval/count bins, visible non-color chart meaning, human positional duplicate disambiguation, and schema-stable ordering. The focused `summary-extrema-dark-800.png` baseline uses one integer wider than JavaScript's safe range and one high-precision Decimal: the compact header keeps the full values in title and accessible text while constraining visual width, and **Column profiles** shows the ordinary exact values without rounding. A separate non-screenshot axe harness supplies 65,536-character exact endpoints and requires 96-character middle-elided visible text, bounded row height, and the complete values in title and accessible text. The same typed-extrema vectors run through Pandas, eager and lazy Polars, DuckDB, PySpark Classic/Connect, saved snapshots, and protocol validation; Pandas and snapshot infinity regressions require the exact pair to be omitted together while finite approximate output remains valid. Native-engine conversion traps remain armed, and implementation review requires database and distributed adapters to reuse the scalar extrema returned by the existing fixed-size aggregate. The text fixture uses `[null, "", "A", "é", "e\u0301", "😀"]` and requires null count 1, empty count 1, minimum length 0, maximum length 2, and mean length 1; the same vector runs through Pandas, eager and lazy Polars, DuckDB, PySpark, saved snapshots, protocol validation, and the visible selected-column panel. A separate explicitly sampled protocol fixture keeps the sampled label scoped to its distribution. Axe interaction opens the nonmodal **Column profiles** drawer, requires focus on its Close control, traverses Column, Dataset, and Filters with roving Arrow, Home, and End keys, scans every view, closes with Escape, and verifies exact focus return to the originating toggle. The grid-status checks require transparent Previous/Next Codicon buttons with native disabled states, an exact `Rows 1\u2013200 of 1,000` or `No rows` polite atomic **Visible rows** status (where the escape renders as a U+2013 en dash), a non-sticky direct position below the table scroller, a constant pressed **Header profiles** control, no clipping at 320px or 200% zoom, and explicit forced-colors borders, focus, disabled, and pressed-state treatment. A production-bundle regression at 435×300 CSS pixels requires responsive compaction to preserve exact header statistics and the pressed preference while hiding only distributions, transfer focus from a disappearing distribution control to **Header profiles**, leave one complete body row pointer- and keyboard-reachable, restore distributions when the current layout fits, honor a later explicit preference-off choice, and remain axe-clean. Component regressions restore a stable-ID width and selection together with vertical and horizontal position, publish presentation updates without runtime page mutations, keep a new draft's before-state anchored to the immediately previous committed schema after a structural reorder, retain the recorded input schema for a replacement draft, disable toolbar/host add and edit-latest entry points while a draft is active, open the generic picker for a no-argument host Add Cleaning Step action, and prove the drawer owns only the selected stable column. Selection transfers that ownership, Dataset and Filters requests cancel when their view is left, and grid owners still release on hide, horizontal virtualization, and unmount only after the final owner releases. Duplicate-label regressions deliver profiles out of order and require grid headers, retained host state, native Summary state, and the drawer to remain associated and ordered by stable column ID. Failed/cancelled pages and mutations must restore metadata, summaries, values, filter, code, focus, confirmed logical context, filter history, and still-visible profiling work. Dedicated baselines cover applied-step diffs, long/Unicode values, empty data, loading, malformed-file errors, and runtime recovery. Playwright injects axe into every generated editor, notebook, and Code Preview harness and fails on every non-minor WCAG violation. It uses the lockfile-pinned headless shell with private HOME/XDG roots plus a disposable workspace-local browser profile and temp root, reports each harness before scanning it, and bounds browser launch, navigation, selectors, and each axe run so a renderer failure or exhausted shared system temp area cannot hang CI indefinitely. On POSIX, the private browser temp directory is exposed through a mode-0700, short-lived `/tmp/ow-a11y-*` symlink so Chrome's process-singleton socket remains below the Unix path limit; nested cleanup removes both the alias and workspace root. `CHROME_BIN` remains an explicit diagnostic override rather than an automatic system-browser fallback.

Grid clipboard component acceptance selects and extends cells through pointer and keyboard paths, then exercises
**Copy cell**, **Copy row**, **Copy range**, **Copy column**, and Ctrl/Cmd+C against the platform clipboard boundary.
Header pointer and Ctrl/Cmd+Space paths prepare a whole filtered and sorted column through sequential one-column page
requests without replacing the visible page. The pure owner
requires full displayed values, TSV quoting for tabs, quotes, and newlines, schema-ordered loaded row columns, exposed
row labels, string formula neutralization after leading whitespace/control/BOM, typed-negative preservation, view
scoping, and 100,000-cell/4 MiB UTF-8 caps budgeted by field before joining rows. Rejections carry no data; projected
rows identify loaded-only copies, and stale/unloaded ranges fail without DOM reconstruction or unbounded requests.
Chromium acceptance proves exact hostile and typed-negative column text, keyboard and pointer selection, sequential
projection, exact-cap success, oversized zero-write rejection, focus restoration, and redacted adapter failures.

A 100,000,000-row terminal fixture additionally retains the exact
`Rows 99,999,801\u2013100,000,000 of 100,000,000` status on one visual line at 320 and 400 CSS pixels, including
effective 400-pixel width at 200% zoom. Its second status row must preserve **Header profiles** and both block
controls with zero status-bar, application, or document overflow.

Released notebook-action discovery resolves a unique manifest command ID before it validates the exact **Open in Open Wrangler** accessible name. The standard notebook-toolbar contribution and Cursor editor-title fallback have mutually exclusive context predicates. Diagnostics require exactly one visible action across both surfaces, record bounded label evidence, and separate native editor-title action state from notebook-toolbar state, so a duplicate or host-specific title mismatch is reported directly instead of as a missing Jupyter contribution.

## First-class editor release checklist

VS Code and Cursor run the complete release-blocking checklist below. Other VS Code-based desktop IDEs are experimental: after an editor's extension-registry discovery and install path is confirmed, a bounded isolated-profile smoke may cover installation, activation, one supported file open, and terminal cleanup without duplicating this long matrix. [Antigravity documents both its VS Code base and Open VSX extension downloads](https://antigravity.google/docs/editor?app=antigravity). The Visual Studio Marketplace is not treated as a fork-distribution channel. Record editor/version/registry evidence in [issue #86](https://github.com/Matt17BR/openwrangler/issues/86); a passing fork smoke never substitutes for VS Code or Cursor. Browser-hosted `vscode.dev` is not a supported runtime target.

### Experimental Antigravity smoke

On 2026-08-01, Open Wrangler 1.2.0 passed one bounded, non-release-blocking Antigravity Linux x64 smoke:

- The official Linux x64 archive from `https://antigravity.google/download/linux` had SHA-256
  `5232a4048ff4fa15685d9a981ba4fba573e297f3efc9b76f638e794baf775725`. The installed editor reported app/API
  version 1.107.0, commit `15487b3041e65228cae24980a3f796c905ef582c`, and x64 architecture.
- The shipped product configuration selected Open VSX. An isolated CLI installed and listed
  `Matt17BR.openwrangler@1.2.0` from that registry.
- The hardened editor harness used zero-window headless mode, private roots, and a synthetic 3-row by 3-column
  semicolon CSV. The public `openWrangler.openFile` command activated the installed extension, automatically
  detected semicolon, UTF-8, double-quote, and header settings, and opened the exact schema through native Polars.
- The source digest was unchanged. Disposing the editor left zero Open Wrangler sessions, no running standalone
  runtime, and no surviving editor process; the downloaded archive and private test roots were removed.

This evidence covers only that Linux x64 editor/version, Open VSX installation, and one supported file journey. It
does not cover macOS, Windows, notebooks, the complete operation/export matrix, or future Antigravity releases, and
does not promote Antigravity to a first-class release target.

Cursor 3.11 hides third-party editor-title actions by default. The packaged run therefore proves that Open Wrangler's declarative configuration default promotes its canonical file action from overflow to the primary toolbar without writing a value into the disposable profile; explicit user settings remain authoritative. A disposable third-party CSV custom editor also proves the same title action routes its tab URI correctly, matching Edit CSV-style integrations rather than testing only ordinary text editors.

Use isolated `--user-data-dir` and `--extensions-dir` directories. Never install a development VSIX into the user's normal profile during automated checks.

1. Install the packaged VSIX and confirm the gallery and Activity Bar icons.
2. Open every supported fixture through Explorer, the **Open in Open Wrangler** editor-title icon and editor-tab context menu, Command Palette, and custom-editor selection. From both a live configurable grid and an initial import error, run **Change Import Options** with non-default CSV/TSV settings and the searchable Excel worksheet picker (plus the name/index fallback when discovery is unavailable); cancel and retry once. Verify stable session state after success, exact rollback after failure/cancellation, uppercase extensions, no source mutation, zero retained candidate/retired sessions, no duplicate title or tab-menu action inside Open Wrangler, and no action on unsupported files.
   For a generated harmless Pandas DataFrame pickle, use **Convert Trusted Pickle to Parquet…** once in VS Code and
   once in Cursor. Verify that decline and Save-dialog cancellation start no conversion worker and never load the
   pickle, ordinary pickle open stays unavailable, the warning names the source and exact interpreter, the source
   digest does not change, an existing destination survives every failure, no sibling temporary file remains, and the
   completed Parquet file opens normally.
3. Exercise column navigation, resizing, keyboard grid navigation, **Header profiles**, **Column profiles**, filters, and multi-sort.
4. Apply one operation from every operation group; preview, discard, apply, edit, undo, and inspect generated code.
5. Export code to clipboard, script, and notebook; export data to CSV and Parquet. For CSV, accept one confirmed import dialect and configure one supported backend-specific delimiter, quote, encoding, and header combination; verify the exact resulting bytes. Reject or cancel one unsupported combination before any destination artifact appears. For scripts, select a new path through the real Save dialog, cancel a second dialog, and attempt exact, normalized, symlink, and hard-link source aliases. Verify sources and prior destinations are unchanged and no sibling temp remains.
6. Open live Pandas and Polars notebook variables plus a viewing-only DuckDB relation; exercise inline and
   expanded output, then keep a filtered, ordered multi-sort DuckDB view open while restarting the kernel.
   In a fresh profile, execute one supported Python dataframe cell before Open Wrangler's formatter is ready. Use
   the cell's **Open in Open Wrangler** action once and verify that the exact live result opens without changing the
   cell's execution order. Rebind its normal variable name before the panel finishes and confirm the executed object
   still opens. Confirm that `display(frame)`, printed output, Styler, and unrelated HTML do not expose the action.
   Keep another notebook visible during the click and confirm it is never used. Open a second split while lookup is
   pending and confirm the launch stops. Select a replacement kernel with matching input and output history, then
   restart the original kernel and reuse the old execution number; neither old action may open the unrelated result.
   Recreate the relation in the exact replacement process before recovery, prove the public session, schema,
   filter/sort model, widths, selection, and viewport survive while its private runtime identity changes, and
   require both the coordinator and replacement kernel manager to reach zero sessions after close. DuckDB must
   retain its user-owned replacement relation and connection, never call Pandas/Polars/Arrow conversion APIs,
   and expose no cleaning, code-insertion, or data-export capability.
7. Test missing Python, missing engine packages, denied kernel permission, untrusted workspace, malformed files, runtime crash, reload, multiple panels, and disposal.
8. Repeat core flows in light, dark, and high-contrast themes and at 200% zoom.

Record the editor versions and evidence link in `docs/feature-parity.md` before a release.

Dependency-install lifecycle tests must use an owned fake child, never a real pip invocation. They cover exact isolated/no-user/no-shell argv, deny-by-default case-insensitive `PIP_*` handling, the controlled Python environment, a private mode-0700 working directory for the fully qualified interpreter, non-recursive cleanup, synchronous spawn failure, pre- and post-spawn errors, `exit` versus authoritative `close`, zero/nonzero/signalled close, command and shutdown bounds, idempotent unref, and a hard prohibition on `kill`. Real interpreter regressions prove that hostile `PYTHONHOME`, `PYTHONPATH`, user-site modules, launcher/manager overrides, and an all-zero filesystem identity cannot affect environment or dependency probing. Bridge races cover shutdown during the modal and deferred progress callback, active close before and after the five-second shutdown bound, nonzero close during shutdown, repeated shutdown identity, no post-disposal UI/cache publication, active/pending/already-stopping same-environment runtimes, filesystem aliases, shared-prefix interpreter/version cache separation, different-environment independence, failed quiescence plus late exact exit/retry, target-scoped selection/configuration changes after quiescence, and probe/start rejection while the mutation barrier is held. The packaged affirmative-path fixture must create a directly executable no-pip virtual environment and place only its fake `pip` package inside that environment; a launcher wrapper is invalid because production pins through it to `sys.executable`. Never install into a user-selected environment during acceptance.

Previous packaged runs cover the implemented Pandas/Polars flows, but the checklist is not a complete 1.0 release record until every **Partial** row in `docs/feature-parity.md` has its named installed-editor evidence. The applicable DuckDB file, view, operation, code, export, recovery, disposal, dependency, and visual steps pass from the allowlisted VSIX in both editors. Focused native DuckDB notebook tests cover exact-connection ownership, viewing queries, saved MIME-v2 output, deterministic cleanup, conversion prohibitions, exact-kernel cleanup after DuckDB-typed timeout and cancellation, and the coordinator transition from requested Editing to runtime-confirmed Viewing before unknown-session replay. The installed released-Jupyter allow phase opens the exact 100,000-row connection-private relation, pages to its end, filters, multi-sorts, profiles, restores its confirmed view, explicitly requests the complete unfiltered relation, then keeps the reconfirmed view open across a real kernel restart. The replacement setup re-arms conversion traps before recovery; the phase requires the same public session and full viewing state over a new private runtime, closes all recovered sessions, checks both coordinator and kernel-manager emptiness, and proves the replacement user relation and connection remain usable. The independent deny profile retries a DuckDB-typed open after persisted Jupyter permission denial. DuckDB rows remain **Partial** until their remaining engine-specific edge, large-data, repeated-performance, and cross-platform gates are recorded; Excel remains explicitly deferred rather than silently skipped.

On Linux, both native-editor commands default to Chromium/Electron's zero-window headless Ozone platform with `DISPLAY`, `WAYLAND_DISPLAY`, editor IPC sockets, keyring/SSH-agent variables, and desktop-session markers removed. Headless launches fix the invisible virtual screen with `--ozone-override-screen-size=1920,1080`; the packaged file-workbench capture pins and attests a 1920 × 860 CSS viewport, while the Pandas notebook README capture uses its own 1280 × 700 viewport and 1280 × 600 output. Native Polars, DuckDB relation, and gated PySpark notebook workbench scenes instead pin an exact 1440 × 900 CSS viewport and output so the gallery remains readable at ordinary laptop proportions. The screen flag is never applied to Xvfb/current modes, and Chromium's ignored `--window-size` switch is not a substitute. Each run receives one private mode-0700 `tmp/ow/x-*` root containing its runtime, home, config, cache, data, profiles, and every inherited editor temporary path instead of using the shared system temp filesystem; the runner removes that entire root in a nested `finally` only after editor/display ownership is verified. Short runtime component names also keep VS Code's Unix-domain socket below Linux's path limit. `--force-disable-user-env` blocks login-shell resolution, and launch flags disable updates, telemetry, crash reporting, and persistent secret storage. Editor CLI, workbench, and private Xvfb processes receive only a minimal explicit platform/isolation allowlist plus runner-owned test overrides; unknown Open Wrangler controls, credentials, authenticated proxies, Git configuration injection, Kubernetes configuration, Python/Node loader controls, and SSH-agent routes are not inherited, while credential-shaped values are rejected even for allowlisted keys. Cursor's GTK startup still requires a functioning session-bus address even with headless Ozone, so the runner retains that single host address while removing the services and state routes above. The full workbench, webviews, dialogs, CDP interaction, and screenshots remain active, but VS Code and Cursor cannot appear on or steal focus from the user's desktop or attach CLI calls to a live editor. Set `OPEN_WRANGLER_EDITOR_DISPLAY=current` only for an intentional visible debugging run. If an editor build cannot initialize GTK on headless Ozone, as observed with Cursor 3.11.19 and 3.12.29 on the reference Linux host, prepare the pinned repository-local Xvfb below or provide another absolute executable, then set `OPEN_WRANGLER_EDITOR_DISPLAY=xvfb`. Cursor 3.13.10 instead launched its workbench and renderer before aborting or stalling ahead of harness activation on the hosted and reference paths. This compatibility mode creates its own invisible display inside the same private run root and disables the unused GLX server extension so host GPU drivers cannot crash display startup. An exact early Cursor `SIGABRT`, or a post-launch inactivity timeout still at `runner-spawn`, adds this fixed Xvfb remedy to sanitized failure evidence without admitting control-sequence output. Stable exact-artifact validation deliberately keeps the full VS Code gate on zero-window headless Ozone and runs the focused Cursor `platform-smoke` separately on the repository-pinned private Xvfb; both consume the freshly reverified same VSIX and retain the same 300/180-second deadlines and fail-closed isolation. There is no automatic fallback or retry to Xvfb or the current desktop.

`npm run prepare:xvfb` prepares the manifest-selected Xvfb executable for supported Ubuntu x64 hosts without installing a system package. It verifies the ordered manifest-pinned Canonical origins (`archive.ubuntu.com`, `security.ubuntu.com`, then the timestamped `snapshot.ubuntu.com` fallback), one authoritative package size/digest, required host packages, the exact `xserver-common` version, executable size/digest, regular-file identity, executable mode, and ELF architecture before printing the absolute path. Only typed transient transport failures before or during body streaming and HTTP 408/425/429/500/502/503/504 may advance to the next origin, for at most two deterministic rounds with one abort-aware one-second wait between rounds under a shared 60-second deadline. Every attempt owns a fresh exclusive no-follow file and receipt, and every acquired rejected response body is canceled or released before the next origin. Redirects, URL drift, encoding, content-length, content, digest, filesystem, dependency, extraction, ELF, and identity failures remain immediate. Preparation never changes the pinned bytes, runs the editor more than once, installs or selects system Xvfb, or falls back to headless/current-display execution. Downloads and extraction stay in the ignored mode-0700 repository cache at `tmp/tooling/xvfb`; incomplete, linked, mismatched, or concurrently replaced entries fail closed. The command does not start a display. Pass its result only to the existing private-display runner:

```bash
xvfb="$(npm run --silent prepare:xvfb)" &&
OPEN_WRANGLER_EDITOR_DISPLAY=xvfb \
OPEN_WRANGLER_XVFB_EXECUTABLE="$xvfb" \
npm run test:packaged-editors -- openwrangler.vsix
```

Set `OPEN_WRANGLER_CAPTURE_EDITOR_SCREENSHOTS` to an absolute output directory when running packaged-editor acceptance to capture the real isolated workbench through its private Chromium debugging port. The runner copies only acceptance fixtures into a disposable workspace, records the supported-file title icon and open tab context menu, then opens the packaged custom editor and native Activity Bar views. README file evidence uses a freshly generated, license-clean 100,000-row × 15-column synthetic order dataset with deterministic categories, numeric ranges, booleans, dates, missing values, and long text; no external or private source file is read. The 100,000-row fixture is illustrative, not a product limit. The faster first-use journey retains its independent 10,000-row fixture. The product capture now starts from the exact 100,000-row source's native Explorer context menu, asserts one canonical **Open in Open Wrangler** action and an unclipped row/menu, and activates that physical action rather than bypassing the entry point. The Explore scene proves the populated Operations, Summary, Filters / Sorts, and Cleaning Steps views beside the revenue Min, Max, Mean, Median, Distribution, and Counts controls. A matching realistic high-contrast scene reuses that populated layout and asserts real high-contrast theme tokens. The Workflow scene proves ordered viewing sorts, applied market normalization, a separate projected-revenue formula draft, Apply / Discard, and complete generated Polars code for both transformations. After the two steps are committed, the harness edits the latest formula from 500 to 750, proves that applying the replacement retains its stable identity and two-step plan, captures the executed result, undoes exactly that latest step, captures the retained uppercase-only plan, and rebuilds the original 500 formula before exports continue. Source bytes, view, filters, sorts, and cleaning plan are asserted at each transition. The full schema remains horizontally scrollable, but renderer geometry checks reject a partial featured or next column, clipped header/stat/cell text, an overflowing or clipped grid status bar, overflowing toolbar controls, or unrelated transient menus, dialogs, notifications, and hovers. Captures with a live grid measure and remove only a bottom partial-row intersection, reassert complete rows, then restore the standard 1440 × 900 product viewport. Dedicated interaction capture keeps Counts / % visible, moves the one full-chart histogram control to a sparse bin, and requires its row-and-percentage tooltip; the sort scene reveals the inline reorder/remove controls for an ordered two-key sort. The browser-harness gallery separately creates a deterministic 100,000-row native DuckDB Parquet source with DECIMAL, TIMESTAMPTZ, LIST, and STRUCT columns instead of presenting a toy-sized frame. When the released-Jupyter extension is explicitly supplied, both the full and `platform-smoke` packaged modes capture real deterministic 100,000-row notebook fixtures. They retain the readable 1280 × 600 automatic Pandas MIME preview, capture the real notebook variable picker with DuckDB, Pandas, and Polars type labels, and add exact 1440 × 900 native workbench scenes for Polars and a live `DuckDBPyRelation`; the existing PySpark gate adds its matching 1440 × 900 scene when its prerequisites run. The Pandas scene uses a complete current 100,000-row × 12-column variable and rejects horizontal overflow, partial columns or cells, and a clipped Open action. Released-Jupyter insertion additionally captures the exact originating notebook after the real insertion command adds one engine-generated, uniquely marked Pandas cleaning-code cell while a different notebook is active; it proves every existing cell and the decoy are unchanged, returns to the exact origin, and rejects an incomplete or horizontally clipped generated cell. Polars must show Editing and Polars badges, computed draft rows, an added-column diff, and complete generated Polars code. DuckDB must show Viewing and DuckDB badges, the filtered 25,000-row view of its 100,000-row relation, a real native filter, ordered two-key sort, visible profiles, and no cleaning, export, or notebook-insertion controls. PySpark must come from Jupyter's real Variables action, show its exact schema plus an honest `rows not counted` state for the 100,000-row fixture, show Viewing only and PySpark badges with no Experimental badge, and expose no cleaning or export controls. The Pandas image must label its 200-row saved capture and 20-row inline display honestly. All notebook captures reject unrelated dialogs, notifications, private paths, internal acceptance workspace labels, partially visible columns, and clipped required titles, badges, or content; the variable-picker scene is the one deliberate transient menu. The README presents Explore, Activity Bar details, complete schema search, focused profile/sort interaction, Workflow, exports, the notebook picker, Pandas, and engine-native Polars/DuckDB scenes; the full gallery retains every engine, entry point, advanced transformation, and Cursor scene. The harness also retains the earlier responsive high-contrast capture at VS Code zoom level 4 (approximately 200%), omits the native test-host title strip from the separate file-workbench evidence, and retries one transient Electron capture failure. At non-default zoom, it converts the browser's zoomed CSS-pixel viewport through the current device-pixel ratio so the saved image contains the complete physical workbench rather than a cropped left edge. It temporarily disables and restores OS color-scheme/high-contrast detection so each requested theme is active, and passes Cursor's isolated-process `--skip-onboarding` flag so its login overlay cannot obscure the workbench.

The same packaged scene run captures the explicit **Import options** Quick Pick on the automatically inferred
delimiter, a complete virtualized 417-column search, the exact sparse-bin tooltip, editable compound-sort priority,
an applied Benelux value filter created from the market header profile beside its native Filters / Sorts state, and real
export outcomes. The filter scene captures the automatically opened Column tab with `Filter: Benelux` and Clear,
asserts the exact filtered row count and visible values, rejects partial grid rows or clipped controls, dynamically
removes only the measured visible height of a bottom partial row, then clears the condition through that Column-profile
action and restores the standard 1440 × 900 viewport before the journey continues. The export
journey applies the two-step plan, saves and opens `orders.clean.py`, exports
`orders.cleaned.csv`, reopens the cleaned data in Open Wrangler, and reveals both files in the disposable workspace.
It verifies 100,000 output rows, both generated columns, and byte-identical source data. The wide-schema fixture
uses realistic numeric, text, date, and boolean fields, remains inside the clean disposable workspace, reaches item
417 of 417, rejects the retired 100-result cap, and rejects clipped results or temporary paths. These images may
enter the gallery only after VS Code and Cursor both capture them from the same verified candidate VSIX.

The released-Jupyter variable-picker capture uses a fixed 1440 × 900 viewport and rejects every partially visible
option row or clipped label, type description, and detail. The independent PySpark picker scene filters to
`spark_classic_frame`, verifies the complete **Viewing only**, **First page loads without counting rows**, and
**PySpark 4.2.x required** detail, captures exactly one visible match, and dismisses the picker without selecting or
opening that variable.

These images are release evidence for the exact VSIX supplied to that packaged-editor run. Capture them only after the candidate source is integrated and packaged; never carry an older commit's images forward as if they represented the current UI. The capture is optional and never mutates baselines automatically.

`npm run compose:readme-media` derives the declared media inventory from accepted packaged-editor and
production-webview sources under `docs/images/readme/v1.2`. Dedicated public capture renders public product media
at 2× physical density while retaining the unchanged logical viewport; ordinary visual baselines remain 1×. Full
scenes preserve every source pixel; Activity Bar,
histogram, sort-control, notebook, by-example, entry-point, and rich DuckDB details preserve exact source-pixel
rectangles without scaling or reconstruction. The gallery-only by-example setup keeps
the complete operation dialog and both mappings' values and outputs; its real 12-row JSON textarea remains
scrollable, so the README links to that scene instead of presenting it as a fully expanded form. The README
preview keeps the complete draft status, Apply / Discard controls, and all ten rows.
A standard sRGB PNG chunk is added only
when needed. `npm run verify:readme-media` requires pixel-exact decoded output for every copy or crop; the browser
visual lane runs that check before README media can change. The rich DuckDB Parquet image and focused UI states
still come from the lockfile-pinned Chromium capture harness and the same production webview bundle.
The same contract requires a width-only screenshot presentation capped at 960 CSS pixels, lossless PNG plus sRGB
output, no resize path, a 2 MiB per-file ceiling, and a 32 MiB complete-inventory ceiling. After a release README
change, `npm run verify:readme-responsive-render` renders the actual README and gallery markup at 760px and 1400px
inside the existing visual lane. It checks every screenshot's cap, aspect ratio, source density, full-size link, and
document-level horizontal overflow before publication. After a release README
reaches GitHub, Visual
Studio Marketplace, and Open VSX, check out its exact source and run this one-attempt diagnostic:

```bash
RELEASE_SOURCE_SHA="0123456789abcdef0123456789abcdef01234567" # replace with the released source commit
RELEASE_VERSION="1.2.1" # replace with the released semantic version, without v
npm run verify:public-media-surfaces -- --source-sha "$RELEASE_SOURCE_SHA" --version "$RELEASE_VERSION"
```

The check rejects a mutable GitHub branch, source/version mismatch, undeclared media series, missing or orphaned
inventory entries, stale registry versions or README content, and any displayed image whose rendered `src` or
`currentSrc` is not the exact immutable raw URL in the reviewed README. Before reading a PNG, traversal caps the
inventory at 64 entries, depth 4, 240 UTF-8 bytes per relative path, 2 MiB per file, and 32 MiB in total. All 48
declared PNGs then require valid chunk CRCs, one ordered IHDR/sRGB/IDAT/IEND structure, a successful full decode,
reviewed natural dimensions, sRGB, and immutable remote equality. All 20 README images are checked at DPR 2 on each
of the three public surfaces. They must stay within their declared width, rendered container, and viewport, preserve their
natural aspect ratio within one CSS pixel of height rounding, and retain at least two natural pixels per rendered CSS
pixel. The hero, histogram, PySpark workbench, and R editing scene repeat those checks near 760px and 1400px viewport
widths.

Before any preview or stable tag, GitHub Release, or registry write, the package job runs the same verifier with
`--prepublish`. That mode performs local inventory, exact-source, version, and all 48 immutable remote-byte checks,
requires the README media commit to be a reachable ancestor of the exact release source in the selected full-history
checkout, then exits without launching Chromium or reading registry pages. The Open VSX recovery workflow applies
the same mode starting with `1.99.4`, restoring and executing the exact release checkout's lockfile and verifier before
token authentication or registry mutation. Older releases predate this capability and do not inherit a future
inventory. A README commit
pin that lags any checked-in media change, names a missing object, or comes from a divergent branch is therefore a
deterministic prepublication failure.

Rendered versioned verification begins with `1.2.1`; older recovery runs skip browser installation and public-media
verification. Browser-free recovery prepublication begins independently with `1.99.4`; those releases install the
browser through the restored release-local Playwright, while earlier exact releases retain their historical
current-automation browser pairing. For protected versions, the workflow runs the verifier from the exact release checkout with
`--wait-for-propagation`, so each release uses its own reviewed media inventory.
The registry retry controller is injected and directly tested: a deterministic error stops after one attempt, each
eligible typed registry observation exhausts the exact attempt/delay count, and every retry owns and closes a distinct
context. GitHub exact-source rendering owns one context and runs once outside that retry loop. Each image is scrolled
and measured inside one bounded same-page `page.evaluate` stability wait. Replacing candidate A with B must cause a
fresh query and candidate reset; B succeeds only after two identical post-scroll animation frames, without another
attempt or context. The source observation, a navigation with no HTTP response, and escaped browser, DOM, evaluation,
scroll, or animation-frame errors are terminal. Exhaustion after any candidate disappears, keeps changing, remains
CSS-hidden, has invalid geometry, or produces a complete positive proof that fails to stabilize must also produce no
retry context. Marketplace and Open VSX retries are limited to an explicitly stale version, README content, or
immutable image source; an initially missing or incomplete exact-alt image; or an actual non-OK HTTP response. The one
source check and up to forty fresh registry contexts at thirty-second intervals share the existing thirty-minute total
deadline. Each fetch remains bounded to sixty seconds, each render attempt to three minutes, per-page/image work to
explicit Playwright defaults, and context cleanup to ten seconds. Local, inventory, immutable-byte, malformed-image,
and dimension validation likewise run once or fail immediately.

Stable and preview callers both load the reusable promotion workflow from `main`. Registry rendering is
post-publication evidence: it can fail the promotion workflow but cannot undo already-public GitHub or registry
writes, and it is not a pull-request browser gate.

Before candidate discovery, editor download, display startup, or editor launch, packaged and extension-host runs
resolve exactly one prepared Python 3.10–3.14 interpreter from the authoritative absolute override, setup-python's
absolute `pythonLocation`, an absolute `VIRTUAL_ENV`, or the exact checkout `.venv`, in that order. Repository and
visual commands use `OPEN_WRANGLER_PYTHON`; packaged editors use `OPEN_WRANGLER_TEST_PYTHON`. An invalid higher-priority
source fails immediately and never falls through to PATH, `python3`, or `python`. One fixed dependency profile is
probed for the requested mode, and failures report either `OW_ACCEPTANCE_PYTHON_INTERPRETER` or
`OW_ACCEPTANCE_PYTHON_DEPENDENCIES` before product assertions begin.

The packaged harness auto-detects local VS Code and Cursor installations; an explicitly requested editor is a required gate, and custom executable/CLI paths use the corresponding `OPEN_WRANGLER_*_EXECUTABLE` and `OPEN_WRANGLER_*_CLI` variables. Set `OPEN_WRANGLER_PACKAGED_EDITORS=vscode` in Linux CI. Its first process commits distinct Polars and DuckDB plans plus viewing queries against the same source. Its second process proves that source-and-backend persistence replays each plan independently, opens concurrent Pandas, Polars, and DuckDB sessions, injects one runtime restart, verifies every session recovers through one replacement process, exports CSV and Parquet without changing either source, and confirms final session/process cleanup. It opens real CSV, TSV, JSONL, Parquet, and Excel inputs through the contributed custom editor with explicit supported-engine selection; DuckDB covers every supported file format while Excel remains Pandas/Polars. The DuckDB Parquet entry is generated natively with DECIMAL, TIMESTAMPTZ, LIST, and STRUCT values. That installed-editor flow verifies exact typed cells and UTC normalization, atomically replaces the disposable source, requires the next read to return the recoverable source-version diagnostic, and still closes without a retained session or runtime. It also routes a generated Parquet URI through the canonical file command, then uses Playwright against the real Electron workbench to click the editor-title icon and exact editor-tab context-menu item for a Polars CSV whose literal filename contains `[Live]`, checking automatic import, exact source routing, source immutability, duplicate-action suppression, terminal cleanup, and the theme-specific Open Wrangler tab icon instead of a generic file glyph. A disposable third-party CSV custom editor drives the same title action and must reach the grid through automatic detection without any delimiter, encoding, header, or quote Quick Input; a separate explicit **Change Import Options** action owns the prompt interaction and cancellation matrix. Acceptance-only view-state injection uses a deliberately scrollable fixture, then performs a fresh complete panel replay and waits for its exact post-commit acknowledgement before a native import action, so cancellation assertions compare synchronized coordinator and renderer state without depending on editor geometry or racing a stale grid. Independent Pandas, Polars, and DuckDB viewing sessions run typed paging, advanced OR filtering, multi-column sorting, progressive summaries, exact stats, and searched values without creating cleaning steps. Before the live Pandas operation matrix, two columns with the same display label must return distinct ID-addressed summaries and exact statistics; after the real kernel replacement, both summaries are requested again and must remain attached to those IDs with the replayed values. Independent editing sessions run representative row/order, column, text, numeric, by-example, custom-code, and aggregation steps through preview/diff/code/apply; custom code is replayed after an injected runtime restart, and DuckDB code is scanned for foreign-engine/conversion APIs. A live packaged Pandas notebook frame with duplicate numeric, categorical, and datetime labels plus integer label `7` drives stable-reference one-hot, uppercase, round, datetime-format, sort, filter, missing-row, and duplicate-row steps. One pristine copy is first reordered by Select Columns, then drives Clone Column, Cast Column, Formula, Text Length, Drop Columns, and Rename Column against identities whose positions changed; every preview and apply verifies positional code, deterministic metadata-derived output IDs, exact typed values, position-free public state, immutable source data, real kernel-replacement replay, and zero-session cleanup. A separate pristine copy drives by-example against the exact non-string-labelled column followed by group-by using that key and the exact second duplicate aggregation. Every preview proves the selected target and positional generated code; public drafts and plans remain position-free. Real kernel replacements replay all three plans to the same typed results, deep source equality holds before and after replacement, and close leaves zero coordinator sessions. With notebooks A and B visible and B active, renderer discovery observes only A's exact visible, enabled action under bounded per-target deadlines; it never scrolls, focuses, clicks, or waits for pointer actionability, and retained timeout evidence contains structural counts/states rather than renderer text or cell values. The separately dispatched DOM action keeps B active, requires A's sentinel Polars value `101`, proves B never acquires a kernel, and inserts edited code only into A. The real custom editor also selects a persisted applied step through the public command, validates its input/output diff and prefix code without changing the confirmed revision/view, then selects Original Data and verifies exact metadata, filter/sort, width, selection, viewport, and full-plan code restoration. The edited Code Preview buffer must flow through the real clipboard and script commands. In disposable profiles, `files.simpleDialog.enable` exposes VS Code/Cursor's built-in Save QuickPick to CDP without touching normal user profiles or extension defaults: acceptance passes a hostile URI to the zero-argument public script command, proves the command remains pending, selects a separate destination, and cancels a second dialog. A public-command filesystem test returns a real `.py` hard-link source alias from the Save-dialog boundary and proves rejection; the environment-gated API independently covers every engine and exact-source rejection without adding a public bypass. Atomic-writer tests inject exclusive-name collisions plus open, write, sync, close, source/destination/temp revalidation, replace, and cleanup faults; normalized, parent-symlink, direct-symlink, hard-link, platform-case, virtual, cross-remote, directory, substituted-temp, and concurrent-destination cases prove source/prior-destination preservation and bounded temp cleanup without deleting a foreign entry. Runtime-command acceptance selects a supported but dependency-isolated interpreter, verifies exact Polars, ordered DuckDB plus `pytz`, Pandas `.xls`, and lossy-UTF-8 diagnostics before spawn, invokes the public install command with a hostile truthy argument, and inspects/dismisses the real VS Code/Cursor modal. Desktop editors default to a native OS message box that is outside CDP, so the disposable profile is preseeded with VS Code's built-in custom dialog style; this changes only presentation, not the public command or modal API. The test proves the isolated-environment invocation log/runtime/configuration are unchanged, clears the override, and restores the configured fallback even after failure. The non-CDP development pass uses only the environment-gated decline path and deterministic script destination; neither exposes an affirmative install control or public export seam. The harness also verifies the publisher/gallery icon, Activity Bar icon, keybindings, notebook MIME v2 registration, all public commands, the walkthrough, custom-editor/source navigation, and Pandas/Polars notebook cell insertion.

Real Python-extension selection is a separate opt-in packaged phase. Set `OPEN_WRANGLER_REAL_PYTHON_EXTENSION=1`; the harness installs the explicitly pinned stable `ms-python.python@2026.4.0`, verifies that exact installed version, and uses a fresh private user-data profile with `python.useEnvironmentsExtension=false` so an A/B rollout cannot change the API under test. For an editor whose gallery cannot serve that package, set `OPEN_WRANGLER_PYTHON_EXTENSION_VSIX` to an absolute, regular, non-symlink VSIX for exactly version `2026.4.0`; the installed-extension check still rejects every other version. The phase creates two disposable workspace-selected environments backed by the already-provisioned test dependencies, proves each selected executable launches the bundled runtime, commits a Polars step, switches A → B → A through the released stable API, and requires one recovered runtime plus the same plan/data after each switch. All files, extension state, environment settings, and processes remain under the per-run private root.

Released-Jupyter integration is a separate opt-in packaged matrix. Set `OPEN_WRANGLER_REAL_JUPYTER_EXTENSION=1`; the harness installs and verifies `ms-toolsai.jupyter@2025.9.1` as the compatibility gate. It probes the selected absolute `OPEN_WRANGLER_TEST_PYTHON`, creates a run-owned virtual environment, and installs the contemporaneous `ipykernel 6.30.1`, Pandas 2.3.3, Polars 1.35.2, and PySpark 4.2.0 compatibility versions. All dependencies except PySpark use exact binary-wheel requirements. PySpark's official source archive is the only exception because that release publishes no wheel; the runner uses its exact PyPI URL and SHA-256, installs it without dependencies after the exact binary Connect dependencies, and re-probes every top-level compatibility version. Both installs disable pip's persistent download cache so the isolated acceptance root does not retain duplicate package archives. Current dependency versions remain covered by the independent runtime and extension-host matrices; the released-UI gate does not feed future major versions into an older third-party Variables implementation. The clean interpreter must not resolve `openwrangler_runtime`; only the released-Jupyter phases receive it, while ordinary file acceptance retains the selected project interpreter. Optional extension-pack members are not required. An optional absolute, regular, non-symlink `OPEN_WRANGLER_JUPYTER_EXTENSION_VSIX` may supply that exact version when the selected editor gallery cannot. Before editor discovery, download, or display startup, the harness copies that file through a no-follow descriptor into a private immutable snapshot, parses the snapshot under fixed archive, entry, manifest, and native-payload bounds, and rejects a manifest target, binary architecture, or Linux C-library payload that does not match the host. The snapshot's filesystem receipt is revalidated immediately before every editor CLI install, so validation and installation use the same bytes. The deny, allow, and PySpark cases use different user-data profiles, copied workspaces, and private Jupyter data, runtime, configuration, search-path, and IPython roots. They exercise Jupyter's real consent dialog, Variables table action, Open Wrangler notebook toolbar, Pandas and Polars DataFrame/Series launches, local PySpark Classic and Connect launches, host-visible MIME v2 output, exact-origin code insertion, and kernel restart with plan replay. Before the Polars draft preview and, for every editor assigned the PySpark phase, each PySpark query sequence, that editor must acknowledge hydration and explicit synchronization of the exact live session panel; coordinator-only readiness is insufficient. Installed performance uses the same exact renderer acknowledgement, with one synchronization attempt allowed to settle before any retry so a slower renderer cannot have its authoritative marker repeatedly invalidated. Immediately before the URI-less Variables command, the harness shows and reasserts the exact captured notebook; a non-data probe first warms and attests the selected kernel without Open Wrangler, then the view opens before the defining cell executes so that fresh completion drives Jupyter's public refresh lifecycle. Direct viewer-argument cases likewise restore that exact notebook before dispatch, while still passing and validating the explicit origin. A manual toolbar launch must reconcile any direct URI with the public active `NotebookEditor` and `TabInputNotebook`, require the exact Jupyter notebook type, reject disagreements and duplicate documents, ignore private toolbar context fields, and retain the captured object across its input prompt. Before using a rendered label where VS Code omits DOM command metadata, the harness proves that label belongs to exactly one installed command and that its owner is `openWrangler.openNotebookVariable`; it then pins one visible, enabled action, releases every inspected menu/action handle, reasserts the active notebook tab before dispatch and after the QuickInput appears, and issues one forced CDP pointer click outside retryable discovery. Bypassing Playwright's actionability wait is required for Cursor's non-focusable editor-title anchor; target ownership and state are established before dispatch. A settled click observes natural overflow dismissal without issuing post-click Escape. If Playwright loses that one click's acknowledgement, only the resulting QuickInput may authoritatively prove dispatch; the harness never retries the action. Variables-table dispatch instead retains an exact semantic locator so Jupyter may replace its row before one trusted keyboard activation without making the target stale. The harness proves that exact button is visible, enabled, and focusable, then sends Enter once through the real action instead of relying on cross-webview pointer coordinates. The action starts from zero Open Wrangler tabs and is never activated or reacquired again after dispatch begins. If Playwright loses the activation acknowledgement, only the resulting zero-to-one Open Wrangler tab transition may prove dispatch; a missing receipt preserves both failures and remains release-blocking. The disposable Jupyter profiles set VS Code's documented `extensions.ignoreRecommendations` preference so unrelated first-run extension recommendations cannot intercept a notebook-toolbar activation; this does not install, disable, or replace an extension under test. The focused bridge suite covers both an actual `fileName: vscode.Uri` and every canonical serialized envelope emitted after the released Variables webview round trip, including optional URI caches. It also rejects malformed descriptors, prototypes, symbols, keys, cache values, Unicode, byte bounds, conflicting origins, duplicate documents, closure, and replacement without invoking accessors or falling back to the active editor. Before execution the harness drives VS Code's real kernel picker through the suggested-kernel or `Select Another Kernel...` → `Jupyter Kernel...` path and selects the private `Python 3.12 (Open Wrangler)` kernelspec; execution dispatch itself is bounded so an unresolved picker cannot consume the outer inactivity deadline. Cell execution requires a fresh execution-summary event, restart waits for an observed non-idle state and a returned idle kernel, and the pre-bootstrap and post-restart probes both require the bundled runtime to be absent. Every phase ends with zero retained sessions or kernel descendants. The matrix runs through the normal isolated workbench CDP path and never uses a development Jupyter double.

Release candidates additionally set
`OPEN_WRANGLER_PACKAGED_PYTHON_JUPYTER_PROFILE=candidate-one-owner`. In that integration-only invocation, VS Code is
the single comprehensive owner of the Jupyter deny, complete allow, PySpark, and remote-kernel journeys. The profile deliberately omits generic restricted-workspace, Python-environment,
seed, verify, and ordinary packaged setup paths because the Linux packaged-editor job already owns those exact
artifact checks. An unset profile, including manual packaged and Released Jupyter runs, preserves the complete prior
phase set for every requested editor.

After a forced renderer synchronization, editor interaction binds to the host-acknowledged synchronization ID. This prevents a retained Cursor frame from receiving the next action.

In Cursor's remote-kernel phase, the harness restores the captured notebook once if focus moved before waiting for the Variables row action. It does not reopen the Variables view or repeat the action. Timeout output includes only bounded loading state and element counts; it excludes webview URLs and table text.

The current PR workflow keeps released-Jupyter qualification inside the canonical package-and-editor owner.
That owner builds and verifies one VSIX, then runs the extension-host journey from the exact checkout. The standalone
Released Jupyter workflow remains the explicit compatibility path described below. Documentation-only changes may skip
the conditional owner; classifier failure, malformed output, control-plane changes, and unmatched substantive paths
select it conservatively. The fail-closed `validate` aggregate distinguishes required success from an intentional skip.
Protected-branch pushes run the unconditional invariant core; CodeQL retains its separate two-analyzer push gate.

The standalone Released Jupyter workflow is manual and self-packages its selected source because it has no caller
artifact. Its local-R default core, value, categorical, and terminal runners remain serial with fresh verification,
immediate upload adjacency, and an exact four-way raw-outcome fan-in. Default/unset core retains its embedded behavior.
It is diagnostic rather than authoritative release evidence.

Preview and stable release workflows instead call the shared candidate workflow exactly once without a caller matrix.
That workflow owns fixed Python, remote-R, generic-platform, `r_platform`, and performance jobs plus the two
Linux local-R shard cells. Generic macOS/Windows platform cells perform no R setup or native-R tail. Each `r_platform`
cell prepares R once and orders freshly verified VS Code-only `core-operations`, `native-frames`, and `kernel-restart`
phases. Linux lifecycle orders `core-operations`, `kernel-restart`, `interactive-terminal`, and `literate-documents`;
editing orders `native-frames`, `value-operations`, and `categorical-operations`. Every candidate editor invocation
repeats artifact verification immediately before it starts, uses a fresh private invocation root, and is followed by
only its own sealed failure-evidence upload. Each cell's exact failure check is deferred until every assigned phase has
run. Explicit candidate core omits native-frame and restart work on Linux, macOS, and Windows because the dedicated
selectors own it; focused value and categorical selectors also omit native frames and remain restart-free.
Default/unset manual core retains the full catalog, while the remote R journey retains representative embedded
behavior, so no platform loses coverage.

The remote R job retains the common Node and absolute hosted Python setup needed by the packaged harness, but performs
no hosted pip install or local R setup before the existing VS Code Docker journey; its independent Lowercase check
remains unchanged. Each native phase keeps the 300-second hard deadline and 180-second inactivity deadline enforced by
the packaged-editor harness, and no phase is retried. Each local-R shard and `r_platform` cell uses the pinned
dependency action and explicit hard-dependency set once. A candidate dispatch may restore only a compatible cache
created by an earlier dispatch on `main`; pull-request merge-ref caches do not cross that boundary, so the first
matching `main` dispatch performs the normal install. Cold dependency installation has a separate 20-minute setup-only
bound so a source fallback cannot consume an unbounded orchestration
process; this does not raise the editor-phase or inactivity deadlines, and no installed library is reused after
cleanup.

The packaged Classic and Connect PySpark fixtures arm class-level `toPandas`, `toArrow`, `mapInPandas`, and
`mapInArrow` traps before Open Wrangler launches. Any accidental dataframe conversion must therefore fail inside
the real selected kernel. The Classic fixture also opens a Variant column through Jupyter's Variables action, checks
the specific Spark conversion advice, and requires zero retained sessions after the rejected open. Classic then
replaces its user Spark session twice in one kernel: an identical
schema must restore the exact confirmed view, while a renamed column must return the recoverable instruction to
reopen the variable, leave the public metadata and view unchanged, close only the rejected runtime candidate, and
keep the replacement user Spark session usable. The following real kernel restart recreates the original schema
and must still recover that same public session before terminal cleanup reaches zero runtime sessions. Focused
runtime cleanup tests must also prove that the adapter never persists the indexed logical plan in either mode,
releases its owned plan and paging-boundary references idempotently, and leaves the user Spark session usable.

Set `OPEN_WRANGLER_REAL_DATA_WRANGLER=1` together with the released-Jupyter opt-in to add a coexistence gate against the exact Marketplace baseline `ms-toolsai.datawrangler@1.24.2`. The runner installs that package into a separate private extensions directory, verifies only its public extension ID/version and activation state, and never opens or inspects its package source or assets. VS Code receives two additional disposable user-data profiles. The first selects **Use Open Wrangler** from the real conflict modal and is relaunched; the second selects **Keep Data Wrangler** and is relaunched. The four bounded phases must prove the selected global preference survives the editor restart, the modal is not repeated, and a newly started or restarted Python kernel contains Open Wrangler's MIME v2 output only for the Open Wrangler choice. The Data Wrangler choice requires the real extension to remain active beside a successful native Jupyter dataframe output while Open Wrangler's MIME and kernel-consent prompt stay absent. It may never depend on a copied implementation detail or a private MIME identifier. The proprietary extension is not launched in Cursor; the real-provider coexistence gate remains VS Code-only under its [Marketplace license](https://marketplace.visualstudio.com/items/ms-toolsai.datawrangler/license), while Open Wrangler's provider coordination remains covered independently in Cursor.

Use `OPEN_WRANGLER_PACKAGED_MODE=data-wrangler-coexistence` with exactly `OPEN_WRANGLER_PACKAGED_EDITORS=vscode` to run only those four real-provider phases. This deliberately excludes the ordinary Pandas/Polars/PySpark Jupyter matrix so a coexistence regression is isolated from unrelated engine acceptance while retaining the same zero-window editor, private interpreter, pinned extensions, bounded phases, and sealed diagnostics.

Variables discovery may rescan after a Jupyter row replacement or after a scanned non-workbench child target is proven retired. It must not classify a detached workbench main frame, a disconnected browser, or an otherwise-unrecognized error from a still-live target as retryable, and it never retries the one-shot Open Wrangler action after activation begins.

Python real-kernel tests require Pandas and Polars to emit MIME v2 with a `text/plain` fallback, suppress their default HTML representation, and preserve an explicit user per-type HTML formatter. The packaged released-Jupyter phase additionally requires a bare Pandas expression to publish a valid host-visible MIME-v2 item, then drives its real packaged renderer action. Its released Variables table receives a 120-second readiness bound for cold hosted kernels; this remains below the independent 180-second inactivity and 300-second phase deadlines, and an indefinitely loading table still fails with bounded structural diagnostics. A local packaged run on 2026-07-26 passed both released-Jupyter phases and the complete ordinary packaged phases in VS Code 1.130.0 and Cursor 3.13.10. The allow flow used Jupyter's actual Variables action, exact-origin code insertion, freshly emitted MIME-v2 output, Open Wrangler's notebook action, Pandas and Polars DataFrame/Series sessions, a viewing-to-editing mode change, kernel restart with plan replay, and terminal cleanup with zero retained sessions or kernel descendants. Renderer evidence came from the same-origin nested guest's 716×107 preview and enabled 157×23 action; the outer 732×0 custom-output host placeholder was not treated as renderer evidence.

Generated-code insertion tests cover Python and R cells, the 10-second observation bound, event-driven exact-document success, sole-open-document ownership, exact language and unique-marker proof, rejected and indeterminate edits, and suppression of queued dispatch behind an unresolved indeterminate edit. VSIX tests parse the exact packaged `media/notebookRenderer.js` bytes and reject an empty or invalid bundle, static or dynamic imports, dependency re-exports, and a missing named `activate` export.

R notebook acceptance opens real `data.frame`, tibble, and data.table variables through IRkernel. It checks that the
active notebook's base, tibble, data.table, `collapse::qDF()`, `qTBL()`, and `qDT()` variables appear in Operations,
that unsupported grouped/indexed collapse objects do not, and that an Operations row opens through the exact kernel.
The focused literate-document journey closes the exact R terminal it created before moving to Python Quarto.
Every candidate path uses R 4.5.2. Linux runs fresh core, native-frame, restart, active-terminal, and complete
literate-document journeys in VS Code; VS Code also owns the complete value and categorical catalogs and
the remote-R journey. Separate macOS and Windows native-R cells run fresh VS Code-only core, native-frame, and restart
phases, while the generic cross-platform jobs perform no R setup or execution. macOS core retains the plain `.R`
journey, Windows skips direct documents, and no candidate job repeats the complete Python source suite or direct R
contract owned by protected pull-request CI.
The allow phase also starts with a private cell-marked Python file and no Interactive Window. It clicks the visible
**Open in Open Wrangler** editor action once, selects the pinned kernel if Jupyter asks, and checks that only the
`# %%` cell under the cursor runs and opens its native Polars dataframe with the expected values. The resulting cell
must point back to that source file at line zero. The source file must stay byte-for-byte unchanged, and closing the
panel must leave no Open Wrangler session behind. The same phase then keeps the exact Interactive window active,
checks that Operations lists the dataframe from that kernel, and opens it again through the native Interactive toolbar
in VS Code or the editor-title action in Cursor without rerunning a cell or creating another Interactive window.
It then opens a fresh Python file and uses Jupyter's ordinary **Run Cell** command. With that source editor still
active, Operations must find the new Pandas dataframe automatically. Opening it from the Interactive action must reuse
the same kernel and completed cell; the later source cell must not run, and neither file may change.

The PR workflow's R 4.5 owners and scheduled/manual Cross R 4.4 owner receive `readr` and `dplyr` plus their
complete hard-dependency closure from the two dated lock registries because the suite opens actual readr and grouped
tibbles rather than hand-built stand-ins.
R 4.4 and R 4.5 are tested qualification environments, not a declared public support range; the release-candidate
R 4.5.2 fixture below remains separate evidence.
The local kernel installs missing packages into a temporary library. Linux uses
`https://p3m.dev/cran/__linux__/noble/2026-03-10`; macOS and Windows use
`https://p3m.dev/cran/2026-03-10`. The test records and checks these versions: IRkernel 1.3.2, jsonlite 2.0.0, rlang
1.1.7, Rcpp 1.1.1, tibble 3.3.1, and data.table 1.18.2.1. Rcpp is installed before collapse. Collapse 2.1.7 and
nanoparquet 0.5.1 come from the matching reviewed `2026-06-01` snapshot. macOS builds collapse from source; Linux
and Windows use the snapshot's binary package. The Linux document journey also installs languageserver 0.3.17,
rmarkdown 2.30, and knitr 1.51 in that private library. IRkernel starts with that library already present in
`.libPaths()`. Before the dataframe fixture runs, one small cell confirms that the selected controller can execute R;
this separates kernel startup failures from fixture failures. Notebook errors are reduced to a short fixed category
such as a parse error, failed kernel start, connection timeout, stopped kernel, cancellation, or missing pinned
package. Raw messages and stacks are not kept. The manual **Released Jupyter acceptance** workflow has `macos-r` and
`windows-r` targets for rerunning one platform without starting a release or the Linux/Python matrix.
Before the editor starts, the runner also launches that exact private kernelspec, executes one base-R marker, and
shuts it down. The kernelspec calls a run-owned R bootstrap that puts the private package library first and then enters
IRkernel. The preflight uses the same private Jupyter directories, R paths, and space-containing working-directory shape
as the editor launch. If the Windows editor launch fails after preflight, a bounded fixed-token receipt reports the last
bootstrap point reached without keeping R output, notebook code, or dataframe values.
The preflight runs the same 1,205-row,
25-column collapse conversions, grouping, and indexing used by the notebook journey, so a platform-specific native
failure is reported before the editor launches. The journey covers projected paging, row labels,
compound filters and sorts, typed value selection, column and dataset profiles, kernel restart, source preservation,
and cleanup. Before a quick sort, the harness waits for the filter drawer to close and reacquires the column menu
after the grid reflows. It focuses the exact session's menu and sort action, activates each with Enter, and reacquires
the menu between those keyboard actions. The base dataframe starts in Viewing mode, keeps
its exact notebook, public session, and compound sort
through the visible **Switch to Editing** action, then continues through the cleaning journey on that same session.
They also check that header profiles start off; the journey does not turn them on. The temporary R
library is deleted with the run.

The active-terminal tests first exercise the read-only vscode-R metadata adapter. A renamed shell is rejected. An
existing session uses the exact-PID workspace tree from vscode-R's already-loaded module without invoking its loader.
During startup, the adapter checks both that tree and the matching attach files until one is ready. PID, path, link,
malformed JSON, and marker changes fail closed. An overwritten or foreign attach record falls back after a 500 ms
stability check. The startup regression lets an overwritten record become an exact-PID exported workspace during that
grace. Disabled vscode-R workspace watching uses the explicit fallback instead of reporting an empty session.
Automatic listing sends no terminal text. A listed frame is connected only after its explicit
Open action rechecks the exact process. The explicit Refresh command is the fallback when watcher metadata is absent.

Native private transport-v14 tests cover `data.frame`, tibble, and `data.table` discovery, request framing, cleanup, and terminal
invalidation. One R task callback writes bounded dataframe descriptors to every attached private mailbox. The real-R
contract attaches two transports to one process, checks that user expressions update both, and checks that Open
Wrangler requests do not trigger another update. It also verifies `.Last.value`, notification replacement retries,
and stale callback removal. Packaged acceptance waits for vscode-R metadata to populate Operations with no Open
Wrangler mailbox, then opens a frame and requires exactly one explicit native bootstrap.
Command-routing tests also require the stable R title action to use that selected terminal, and the packaged document
journey checks the document fallback when no official R terminal is active.

[Run 31062443212](https://github.com/Matt17BR/openwrangler/actions/runs/31062443212) passed from commit
`67422557e2377f5fe806e3b4892b261dd48d9d6a` on 2026-08-06. It covered local R 4.5.2 in VS Code and Cursor, plus the
containerized R kernel in VS Code. The journey checked typed value selection, a compound filter, filtered profiles,
Clear all, sort priority, restart and reopen, source preservation, and final cleanup. It does not cover cleaning,
generated R code, notebook insertion, exports, Quarto, R Markdown, or plain `.R` files.

The released IRkernel journey also moves one exact live session from Viewing to Editing, back to Viewing, and into
Editing again before cleaning. It requires the same public session, source object, notebook origin, compound viewing
sort, selected column, widths, and viewport through every private-runtime replacement.

The current 1.99-source test set includes Filter Rows, Sort Rows, Drop Missing Rows, Fill Missing Values, Drop
Duplicates, Rename Column, Drop Columns, Select Columns, Clone Column, Convert type, Formula, Text Length, One-hot
encode, Multi-label binarize, Lowercase, Uppercase, Find and replace, Capitalize, Strip text, Split text, Min-max
scale, Round, Floor, Ceiling, Format Datetime, Group and aggregate, Transform by example, and Custom code in
Editing mode. They
exercise draft preview, executable generated R, mixed plans, apply, discard, inspection, latest-step editing, undo,
revision errors, exact-kernel correlation, stable retained-column identities, and source isolation for base data
frames, tibbles, and keyed data tables. Filter and Sort cover stable source-row identities, current-view conversion,
compound priority, missing placement, `NA` versus `NaN`, and row-aware diffs. Clone Column proves stable derived
identity and later editing of the copy; Text Length proves Unicode character counts, `NA` preservation, integer output,
and stable lineage.
Formula covers all six operators, exact scalar and stable-reference operands, ordinary integer/double and `integer64`
types, `NA` propagation, native R handling of existing `NaN` and infinities, deterministic output identity,
overflow/new-non-finite rejection, and live/generated equality. One-hot encode covers all supported R scalar kinds,
multiple stable input references with duplicate names, missing/`NaN`/blank/unused-factor exclusion, canonical labels,
global UTF-8 output ordering, and retain/drop behavior. Multi-label binarize covers character and factor inputs,
literal no-trim splitting, repeated and blank tokens, Unicode labels, omitted and explicit-empty prefixes, and
retain/drop behavior. Both categorical operations prove value-dependent stable output identities, base-integer
nonnullable 0/1 columns, empty-output rejection and collision bounds, keyed-data-table preservation, and source isolation.
Their live frame helpers cover base, tibble, `data.table`, and ordinary `collapse` frames. Generated-plan coverage
proves both operations on base frames, One-hot encode on tibble and ordinary `collapse` frames, and Multi-label
binarize on `data.table`, with exact live/generated equality in each exercised family. Format Datetime covers
`Date` and `POSIXct`, timezone
and daylight-saving behavior, bounded UTF-8 output,
the 64 MiB aggregate character-output budget with chunked formatting, in-place and derived columns, and the
keyed-data-table replacement guard. Formula, Format Datetime, and categorical generated-plan regressions also prove
that their shared source preflight and operation helpers cannot be intercepted by caller-defined operators or S3
methods.
Transform-by-example cases prove deterministic synthesis and ranking, canonical retained-program publication, and
equal live/generated evaluation for text, regex, numeric, temporal, duration, factor, and null programs. They cover
ordered stable source references and aligned arrays, stale/type-mismatched references, strict JSON scalars, signed
zero, unsafe whole numbers, exact `-(10^38 - 1)` through `10^38 - 1` arithmetic, and the shared 16-source,
64-example, 256-node, depth-64, 64-concat, 8-KiB-value, and 64-KiB-total UTF-8 limits before synthesis and after
canonicalization. The frame helper runs in bounded chunks and preserves source bytes, flavor, keys, aligned element
names, semantic attributes, and stable output identity across base `data.frame`, tibble, `data.table`, and ordinary
`collapse::qDF()`, `qTBL()`, and `qDT()`. Kernel-agent and real-R cross-language coverage runs preview, apply,
latest-step edit, replay, inspection, and undo, then executes the emitted generated R against the unchanged source.
Custom Code cases reject invalid UTF-8, NUL, blank/comment-only text, parse failures, missing or active `result`,
cross-flavor/zero-column output, private names, and the 64-KiB code, 4-MiB generated-code, and 64-MiB result budgets
before publication. Six-flavor fixtures cover dynamic row/schema/row-name/key output, duplicate-name FIFO lineage,
fresh column and row identities, active-view reconciliation, full-replacement diff truncation, source/result
shielding, the documented ambient-side-effect boundary, suppressed output/messages/warnings, recovery after evaluation failure, and live/generated equality followed
by a later step. Tests also make the trust boundary explicit: deterministic code/input/environment reproduce the same
frame, while intentional filesystem, network, global-environment, and alias side effects are not rollback claims.
Malformed row names and unequal ordinary column lengths fail in live capture and generated replay, unsupported frame
subclasses and frames wider than 2,048 columns fail before a step runs, bounded
factor metadata cannot amplify generated preflight, delayed source promises cannot install an active result setter,
a source named `open_wrangler_result` remains unchanged while its cleaned result publishes as
`open_wrangler_result_2`, and a rejected replay leaves its source unchanged. Dedicated base
frame lifecycles run Formula and Format Datetime through preview, apply, discard, inspection, and undo. Cross-flavor fixtures cover
mixed-plan replay and source isolation for base, tibble, `data.table`, and ordinary `collapse` frames.
Lowercase, Uppercase, and Capitalize cover factor-to-character conversion, native R casing, `NA`, in-place and derived
output, and key safety. Find and replace covers literal and regular-expression matching with the same output and key
rules. Strip text covers the default whitespace and selected edge characters. Split text covers literal delimiters,
empty parts, out-of-range `NA`, and required derived output.
Min-max scale covers double output for integer, double, and `integer64` input, constants, all-non-finite columns,
the full non-missing `integer64` range, adjacent wide values, stable lineage, generated R, and the in-place
keyed-data-table guard.
Round, Floor, and Ceiling cover double output for ordinary integer and double input, exact `integer64` output, `NA`, `NaN`, both
infinities, R's ties-to-even rule, derived output, and the in-place keyed-data-table guard for Round, Floor, and
Ceiling.
Convert type covers all six target types, failed parses, factors, temporal values, `integer64`, key safety, executable
generated R, and exact typed diffs. Drop Missing Rows covers the Any and All modes and treats both `NA` and `NaN` as
missing. Drop Duplicates covers first/last/none retention and selected-column or whole-row comparison. Both keep source
order, stable row IDs, explicit row names, dataframe flavor, and compatible data-table keys. A large-cell inspection
regression checks two pages that are valid separately but exceed the kernel response limit when combined. The
dedicated complete-catalog contract uses a fresh session per exact ordered operation and executes the resulting
production-generated R, including saved-step replay. The dedicated TypeScript export contract independently requires
the bridge and public catalog to retain that exact order, then verifies each distinct executable operation-labelled
buffer is copied and atomically saved byte for byte. Fresh hosted candidate and installed all-32/performance evidence
are still outstanding.
Explicit candidate
`core-operations` retains its existing phase but runs one full installed Clone Column lifecycle: preview, apply,
applied-step inspection, edit and reapply with the same step/output identities, and undo. The `value-operations`
targeted slice remains exactly Find and replace, Formula, Format Datetime, Min-max
scale, Round, Floor, Ceiling, Capitalize, Lowercase, Uppercase, Strip text, and Split text. The
`categorical-operations` targeted slice owns exactly One-hot encode and Multi-label binarize. Candidate core, value,
and categorical omit the former shared native-frame scaffold. The `native-frames` selector owns the frame picker,
collapse/viewing coverage, native tibble Rename, and keyed-data-table Drop at the original comprehensive or
representative depth. Explicit candidate core omits embedded restart/reopen on Linux, macOS, and Windows because the
dedicated `kernel-restart` selector owns it. Linux runs both dedicated selectors in VS Code; macOS and
Windows run them in VS Code. Focused native, value, categorical, and Pivot wider selectors remain restart-free. Default/unset
manual core retains the full catalog and the remote R journey retains its representative embedded behavior, so there
is no per-platform reduction. The focused value and categorical journeys assert boundary values, stable output IDs,
complete generated-R source specification, preview,
apply, and undo in VS Code. The focused `pivot-wider` selector runs the same installed form, renderer recreation and
saved hydration, non-latest edit/delete with suffix replay, generated code and output identities, committed-boundary
Undo, immutable source restoration, and enclosing session/runtime cleanup in one fresh Native R session without
replacing or weakening the broader `value-operations` path. Cursor's candidate ownership is the separate generic lifecycle/responsive-grid/reveal-state
compatibility seam, not an R selector.
Categorical Undo keeps one authoritative one-shot dispatch receipt and waits up to 75 seconds for the queued
mutation's terminal completion; after dispatch begins it never reacquires the control or retries the command. The
separate remote R Docker path continues to exercise `lowerText` (Lowercase).
Group and aggregate has direct frame, kernel-agent, protocol, and host-bridge coverage for all nine aggregations,
first-seen group order, missing keys, type preservation, overflow, generated code, inspection, replacement, and undo.
Separate kernel-agent cases run it on a tibble and a keyed data table. They check the live result, generated R,
unchanged inputs, cleared result keys, and key restoration after undo.
The R tests cover exact integer64 cancellation, odd-count medians, and same-sign boundary pairs for live and generated
mean and median. Sum tests retain ordinary integer and integer64 output and reject overflow before publication because
base R and `bit64` have no exact 38-digit integer type. The bridge tests also cover explicit row names becoming
positional after grouping and returning after discard or undo. Filter-only and sort-only views containing an
aggregation result plus a group key survive latest-step replacement and apply. Undo retains the group-key rule and
drops the aggregation-output rule by stable ID, even when its alias matches a source column name and type. The
kernel-agent test checks that replacement-diff truncation does not materialize the pre-group frame and exports a
committed grouped result through native R Parquet. The packaged Formula journey uses the visible form to add a finite
scalar to an exact numeric column, checks its stable derived identity and exact values, applies the draft, and undoes
it. The packaged Format Datetime journey formats a real `Date` column through its visible form, checks the exact
appended text values and lineage, applies the draft, and undoes it. The packaged Group and aggregate journey selects a key, sums a
numeric column, checks the two exact grouped totals and generated R, applies the draft, and undoes it back to the
source schema. Min-max scale, Round, Floor, and Ceiling use their visible forms and check derived values from positive and negative
fractional inputs. The packaged sequence uses Column search to bring each result into the virtualized grid before checking it,
including after undoing a step that added a far-right column.
Generated-R assertions acquire one exact bounded receipt for the complete CodeMirror document, then reveal and
measure the operation line without mistaking a line outside the rendered viewport for missing generated code. Rename
records the post-draft host code receipt, requires exact session/revision hydration, and rechecks the acknowledged host
receipt before acquiring the current renderer. The pinned document, content node, and `.cm-scroller` must remain one
connected generation while initially empty layout settles: renderer viewport and preview bounds must become finite,
positive, and stable; scroller bounds must additionally be fully contained in that viewport; and `scrollHeight` and
`clientHeight` must become finite, positive, and identical across two animation-frame observations while `scrollTop`
remains finite, non-negative, and stable. A receipt or generation change fails
immediately; an unchanged 0×0 layout exhausts only its existing bound with receipt-and-geometry diagnostics. Reveal
changes only that exact scroller's `scrollTop`;
success requires two stable, fully visible measurements from the same generation, and terminal diagnostics retain only
bounded receipt/geometry/generation state rather than generated source. No focus, resize, reload, or editor-action
retry is permitted.
Across the base-data-frame sequence it covers preview, apply, inspection, discard, latest-step editing, and undo;
Convert type is applied and undone. Drop Missing Rows and Drop Duplicates each cover preview, apply, returning from
step inspection, and undo. It copies and saves generated Rename code through the `.R` Save dialog, inserts the exact
code as one `r` cell in the originating notebook, leaves every existing cell unchanged, and checks the source objects
again after editing. Separate tibble and keyed-data-table sessions preview and discard Rename and Drop Columns; direct
R tests also check class and key behavior for both dataframe types.

The notebook journey also applies Rename to a 1,205-row, 25-column frame, adds a viewing filter and two sort keys,
and exports CSV and Parquet through the public command and real Save dialog. The saved CSV contains every committed
row, not just the filtered view, and the Parquet file must have complete `PAR1` markers. The test checks the renamed
CSV header, representative values, unchanged notebook bytes and view state, and zero remaining host or kernel export
artifacts. A local packaged run on 2026-08-07 passed the earlier CSV-only journey in VS Code
1.132.0 and Cursor 3.14.7 on the pinned private Xvfb display.

On macOS, the core local R editor launch also tests plain `.R` without starting another editor process. On Linux,
the focused literate invocation covers plain `.R`, `.Rmd`, and `.qmd` in VS Code. Cursor's candidate seam does not
repeat R document semantics. Windows skips that document coverage. For local Windows files, the package manifest hides the explicit **Run R Document** Explorer and
tab-menu actions. The stable title action remains available so an active official R terminal can supply its
dataframes. Remote-resource actions and the Command Palette stay available because the client
cannot identify the extension-host platform through static menu keys. The existing `process.platform` check rejects
a Windows extension host. Remote R-document execution is experimental and is not part of this release matrix.
The fixture reads a relative CSV, creates a base data frame, tibble, and keyed data table, and runs through the public
**Run R Document in Open Wrangler…** command and real variable picker. The plain-R test checks an editing session, paging, an exact
numeric profile, a filter, two sort keys, Rename preview/apply/undo, and generated R. It keeps a different `.R` editor
active while inserting the generated code, proving that only the captured unsaved source document changes. Both files
on disk remain byte-for-byte unchanged. After applying Rename, the test also runs the public zero-argument data-export
command for CSV and Parquet and completes the real Save dialog for each. It compares the full 240-row CSV with the
expected cleaned result and checks the Parquet file markers. It checks that the open source stays clean, the process
export directory is empty, and the private process root disappears when the session closes. Parquet is advertised
only when the exact R process has nanoparquet 0.5.1 or newer.
The modified in-memory source is then run again and its generated result is opened before the final panel and R process are closed. The phase uses the
exact Rscript and temporary R library that already belong to the IRkernel test, including `jsonlite`, `rlang`, and
`nanoparquet`.

Each journey installs packages into the environment that owns its dataframe. IRkernel uses its selected kernel
library, the active-terminal journey uses the selected terminal's library, and document runs use the library visible
to the resolved `Rscript`. A package found only in another R installation does not satisfy the check.

The R Markdown and Quarto fixtures each contain first-line YAML, prose, and top-level backtick-fenced `{r}` cells that
read a relative CSV. The R Markdown parser fixture also contains a non-R cell and a disabled R cell. The journey opens
the dataframe, checks its full schema and page, applies Rename, inserts generated R as a new fenced cell, and proves
the source file on disk is unchanged.
The Quarto title-action portion puts the cursor in the exact dataframe-producing chunk and invokes the stable editor
action. It verifies the Quarto and R integrations before asking for a terminal, then evaluates and discovers through
one correlated request bound to the exact active R terminal. The chunk reads its relative CSV from the Quarto
document directory, and the journey verifies that the terminal returns to its original working directory after both
successful and failed evaluation. Focused TypeScript tests separately route
explicit-Jupyter and implicit/explicit-knitr Quarto Python chunks,
reticulate R Markdown Python chunks, and R chunks. They cover backtick and supported tilde fences, chunk labels, `#|`
options, disabled chunks, required-integration guidance before session acquisition, conflicting executor metadata,
associated Python sessions, explicit R/Python session choice, and editor/version/cursor/exact-terminal changes across
cleanup and discovery awaits. Executor tests also cover bounded YAML parsing, duplicate/alias/case-variant metadata,
and faux fences inside display math, raw TeX, and raw HTML.
An R-owned Python path must not fabricate an Interactive Window cell, and the primary action must never fall back to
an all-document run.
The separate owned-process parser tests cover horizontal rules, display math, closed raw-TeX blocks, numeric labels,
nested option calls, and disabled external chunk references. They reject R-looking fences inside opaque containers, indented or tilde R
fences, enabled alternate engines or external references (including Quarto's hyphenated option keys), malformed options, cross-cell syntax joining, and R
Markdown fence-length mismatches. Raw-string chunk options and special infix operators in options are rejected instead
of being partially parsed. Open Wrangler
still evaluates these cells in its own managed R process; Quarto rendering is a separate editor action.

On Linux x64, only the focused `interactive-terminal` and `literate-documents` invocations install exact official
releases of R Syntax 0.1.4, R 2.8.8, and Quarto 1.135.0. Selector-free core, focused `value-operations`, focused
`categorical-operations`, focused `native-frames`, focused `kernel-restart`, and remote-only invocations neither
prepare nor install that native editor tooling. The runner downloads each VSIX from the Visual Studio Marketplace and
Quarto CLI 1.10.18 from its
official GitHub release, then verifies the pinned byte count and SHA-256 before installation. The profile points the
R extension at the test R executable and private package library. R Markdown uses the Pandoc bundled with that Quarto
CLI, and the Quarto extension uses the same private installation. No extension or package is installed into the
user's editor profile or R library.

Each of those four downloads retains one aggregate 10-minute budget. Only rejection of the initial transport promise
before a response exists can start another attempt: there are at most three attempts, with cancellable fixed
2-second and 4-second waits charged to that same budget. Non-success HTTP status, absent or streaming body, size,
SHA-256, filesystem, verified offline override, extraction, version, and editor failures are never retried. Non-success
response bodies are disposed before the fixed failure is surfaced. Every download-attempt checkpoint and download
error identifies no more than the public artifact key, pinned filename, and bounded attempt number, never a request or
redirect URL, headers, or raw transport cause. Focused script tests cover one- and two-rejection recovery, exhaustion,
aggregate-deadline expiry during fetch and backoff, no-retry response/body/integrity/filesystem paths, override bypass,
fixed diagnostics, and timer cleanup. This acquisition retry happens before any native editor starts and does not
change its 300-second hard deadline, 180-second inactivity deadline, or no-automatic-retry rule.

The packaged journey activates all three extensions, checks their exact versions and public current-cell/selection
commands, and confirms that `.Rmd` and `.qmd` have the expected editor language modes. Ordinary candidate `.qmd`
acceptance invokes **Open in Open Wrangler** directly with the exact cursor in its R chunk. It owns the resulting
product title action, session/source identity, generated code/insertion, and cleanup; it does not dispatch, discover,
wait for, or clean up Quarto's third-party preview, render server, tab, terminal, or HTML. Linux screenshot mode alone
dispatches `quarto.preview` exactly once, retains and settles that promise inside the existing render bound, and pins
the first `vscode.TabInputWebview` whose exact `viewType` is
`mainThreadWebview-quarto.previewView`, along with its tab group and newly owned `Quarto Preview` terminal. Media
capture requires two identical rendered-HTML observations and the visible preview, then performs bounded exact cleanup.
It never focuses, resizes, reloads, retries, or dispatches a second preview action. Open Wrangler asks Quarto to run
only the selected chunk and presents dataframes from the official R session.
The R Markdown fixture still exercises the explicit owned-process command. A second `.qmd` declares `jupyter: python3`.
The title action runs only the cursor-owned Python chunk through a private kernelspec, opens its live Pandas
dataframe, leaves the later sentinel chunk untouched, and keeps the source bytes unchanged. Screenshot mode also
requires Quarto's internal preview to be visible. Offline runs may
supply the same verified artifacts through `OPEN_WRANGLER_R_SYNTAX_EXTENSION_VSIX`,
`OPEN_WRANGLER_R_EXTENSION_VSIX`, `OPEN_WRANGLER_QUARTO_EXTENSION_VSIX`, and
`OPEN_WRANGLER_QUARTO_CLI_ARCHIVE`.

A focused packaged Linux run at `a64ce66` passed the complete literate-document journey in VS Code 1.132.0. The
current candidate gate repeats that journey in one fresh VS Code phase. The Python Quarto check accepts
Jupyter's marked one-cell Interactive scaffold or its user-cell-free canonically auto-selected Python form, then
requires exactly one executed cell
associated with the source URI and the selected chunk. Jupyter may expose that cell with `languageId: quarto`; its
source line and Python kernel ownership identify it. The later sentinel chunk must remain absent, and opening the
result must reuse that exact session with one user-code dispatch rather than rerunning or retargeting it. On a fresh
run, Open Wrangler sends one empty selection to create the source-routed Interactive Window without user code, waits
for that exact sole-open window's marked Jupyter system cell or canonical auto-selected Python metadata, and explicitly
reveals that same captured notebook when Cursor has not published a stable visible editor. The public kernel-picker
command returns no selection value, so the
focused contract accepts an already auto-selected scaffold only when its canonical nested Jupyter metadata explicitly
and consistently names Python; otherwise a metadata-free scaffold must acquire that metadata after the picker closes.
Cancellation, R or conflicting metadata, missing metadata, replacement objects, and scaffold/source races fail before
user-code dispatch. After one bounded event-loop turn and another exact-object/scaffold check, Open Wrangler restores and
revalidates the source before dispatching the real chunk exactly once. Publication and completion stay pinned to that
notebook through the remaining two-minute operation deadline; missing publication fails without a retry. Focused unit
tests bind the auto-selected two-command and picker-selected three-command sequences, delayed metadata confirmation,
flat or conflicting metadata rejection, confirmation-loss races, stable-editor reveal, and no-retry cases.
Packaged acceptance independently requires one exact Interactive Window, one successful source-associated cell, an
absent later sentinel, unchanged source bytes, and the live Pandas session.

The focused `literate-documents` selector creates a separate core compatibility environment below the verified
per-run temporary root. It pins Jupyter Client 8.9.1, IPykernel 6.30.1, Pandas 2.3.3, Polars 1.35.2, and DuckDB 1.5.4
without installing PySpark, registers that exact interpreter in the prepared R environment's private Jupyter data
directory, and passes the same interpreter to the native editor phase. Before an editor starts, a direct
`jupyter_client` probe launches that exact kernelspec, executes a fixed Pandas marker, and shuts the kernel down. Its
launcher, kernel, and bounded cleanup remain inside the runner-owned process tree or Windows Job. Creation,
registration, probing, and readiness publish distinct setup checkpoints; core and focused `value-operations`,
`categorical-operations`, `native-frames`, `kernel-restart`, and `interactive-terminal` journeys continue to use the
selected host interpreter. The release failure that exposed this missing boundary had inherited hosted IPykernel 7.x
while the reviewed compatibility
lane pinned 6.30.1. That proves
unreviewed dependency drift entered the focused gate, not that IPykernel 7.x caused the Interactive Window stall. The
correction adds no editor retry and does not extend either the operation or native-phase deadline.

`collapse` is not a runtime dependency. Packaged R/Jupyter acceptance installs collapse 2.1.7 in its private test
library. It creates real `qDF()`, `qTBL()`, and `qDT()` objects, checks their picker labels, opens each one, and confirms
that grouped and indexed objects stay out of the picker. The R contract tests cover the same class boundary directly.
A setup failure records only a fixed stage name; R errors and notebook output stay out of the retained diagnostic.
macOS builds collapse from its pinned source package, while Linux and Windows use the pinned binary. Setup loads
every pinned namespace and exercises all three supported constructors before the editor starts.

Across the core notebook and focused literate invocations, local screenshot mode captures the supported IRkernel dataframe list in
Operations, a generated 2,400-row orders dataframe in the viewing workbench, a Group and aggregate draft after
switching that same session to Editing mode, the generated R inserted into its notebook, and the dataframe picker
over a real Quarto document beside its rendered HTML preview.
The viewing image shows two filters, two
ordered sorts, and exact revenue statistics. The editing image groups the orders by market and channel and shows the
native R code preview beside the draft, cleaning history, and Apply/Discard controls.
The Operations scene uses a 1440 × 900 logical viewport. The workbench starts at the same size and trims its height to 874
logical pixels so the grid ends on a complete row. Both are captured at 2× physical density. Capture fails if setup
cells or private markers are visible, if a grid row or column is clipped, or if the source R object changes. The
accepted files are
`docs/images/editor-acceptance/vscode-notebook-r-operations-dark.png` and
`docs/images/editor-acceptance/vscode-notebook-r-dark.png`,
`docs/images/editor-acceptance/vscode-notebook-r-editing-dark.png`, and
`docs/images/editor-acceptance/vscode-notebook-r-code-insertion-dark.png`, plus
`docs/images/editor-acceptance/vscode-r-quarto-variable-picker-dark.png`; the gallery uses lossless crops at
`docs/images/editor-acceptance/vscode-notebook-r-operations-detail-dark.png` and
`docs/images/editor-acceptance/vscode-notebook-r-code-insertion-detail-dark.png`, while the README Quarto crop is
composed from the accepted full source. `npm run compose:readme-media` refreshes all three derived R crops after a
new accepted capture.

The manual **Released Jupyter acceptance** workflow cancels an older run of the same selected target when a newer
diagnostic run is dispatched; its Linux, macOS, and Windows targets do not cancel one another. It has a `macos-r` lane
for the packaged VS Code and local IRkernel notebook plus Open Wrangler's direct plain `.R` journey. Use it while
diagnosing macOS-only R failures;
the default `linux-all` lane keeps the broader VS Code, Cursor, Python, active R terminal, and remote-Jupyter
coverage. Its local R sequence freshly verifies the built VSIX, runs the default/unset core invocation and its immediate
diagnostic upload, reverifies and runs the separate value invocation with its immediate upload, reverifies and runs
categorical with its immediate upload, then reverifies and runs active-terminal with its immediate upload. Default
core retains its embedded kernel restart/reopen coverage. One exact four-way raw-outcome local-R failure fan-in follows
all four, so an earlier failure cannot suppress or be overwritten by later evidence; only the active-terminal
invocation installs the pinned R and Quarto tooling. This manually dispatched Released Jupyter path remains serial,
backward-compatible, and non-authoritative. Release-candidate acceptance instead uses the fixed two-shard topology
described below and adds separately verified native-frame, kernel-restart, and literate-document phases there.

Failed-run narratives are not release contracts. Historical workflow behavior remains covered by the bounded fixture
and inspectors; current candidate failures are preserved in their immutable workflow logs and failure-only artifacts.
Documentation records only the stable ownership, timeout, no-retry, artifact, and promotion policies above.

```bash
npm run build:test-extension &&
OPEN_WRANGLER_PACKAGED_MODE=r-jupyter \
OPEN_WRANGLER_PACKAGED_EDITORS=vscode \
OPEN_WRANGLER_REAL_JUPYTER_EXTENSION=1 \
OPEN_WRANGLER_REAL_REMOTE_JUPYTER=0 \
OPEN_WRANGLER_TEST_PYTHON=/absolute/path/to/python \
OPEN_WRANGLER_TEST_RSCRIPT=/absolute/path/to/Rscript \
OPEN_WRANGLER_CAPTURE_EDITOR_SCREENSHOTS="$PWD/docs/images/editor-acceptance" \
dbus-run-session -- node scripts/run-packaged-editor-tests.mjs /absolute/path/to/openwrangler.vsix
```

```bash
OPEN_WRANGLER_PACKAGED_MODE=r-jupyter \
OPEN_WRANGLER_REAL_JUPYTER_EXTENSION=1 \
OPEN_WRANGLER_REAL_REMOTE_JUPYTER=1 \
OPEN_WRANGLER_PACKAGED_EDITORS=vscode,cursor \
OPEN_WRANGLER_TEST_PYTHON=/absolute/path/to/python \
OPEN_WRANGLER_TEST_RSCRIPT=/absolute/path/to/Rscript \
npm run test:packaged-editors -- /absolute/path/to/openwrangler.vsix
```

For a focused local rerun, add `OPEN_WRANGLER_PACKAGED_R_JOURNEY=core-operations`,
`OPEN_WRANGLER_PACKAGED_R_JOURNEY=native-frames`,
`OPEN_WRANGLER_PACKAGED_R_JOURNEY=kernel-restart`,
`OPEN_WRANGLER_PACKAGED_R_JOURNEY=value-operations`,
`OPEN_WRANGLER_PACKAGED_R_JOURNEY=pivot-wider`,
`OPEN_WRANGLER_PACKAGED_R_JOURNEY=categorical-operations`,
`OPEN_WRANGLER_PACKAGED_R_JOURNEY=interactive-terminal`, or
`OPEN_WRANGLER_PACKAGED_R_JOURNEY=literate-documents` to the `r-jupyter` command and keep
`OPEN_WRANGLER_REAL_REMOTE_JUPYTER=0`. With explicit `core-operations`, the candidate gate assigns seven fresh phases to
two parallel local-R shard cells. Lifecycle runs `core-operations`, `kernel-restart`, `interactive-terminal`, then
`literate-documents`; editing runs `native-frames`, `value-operations`, then `categorical-operations`. Each shard performs
dependency/editor setup once, but every phase freshly verifies the exact candidate, starts a fresh private runner,
and immediately publishes any sealed failure evidence before its shard-local deferred raw-outcome check. Every local
R phase runs in the single comprehensive VS Code owner. Separately, generic macOS/Windows platform cells perform no R setup or native-R
tail. Parallel
`r_platform` cells prepare R once per OS, then run freshly verified VS Code-only `core-operations`, `native-frames`, and
`kernel-restart` invocations in order; three distinct immediate uploads precede each cell's literal three-outcome
guard, and the final candidate fan-in requires `R_PLATFORM_RESULT=success`.

The manual Released Jupyter gate remains its existing serial default-core, value, categorical,
interactive-terminal diagnostic path; its default/unset core keeps the full catalog and embedded restart journey.
Explicit candidate `core-operations` instead runs one complete installed Clone Column lifecycle—preview, apply,
applied-step inspection, edit/reapply with the same step and output identity, and undo—inside the existing core phase.
The value selector remains exactly Find and
replace, Formula, Format Datetime, Min-max scale, Round, Floor, Ceiling, Capitalize, Lowercase, Uppercase, Strip text,
and Split text. The categorical selector checks exact One-hot encode and Multi-label binarize preview, apply,
generated code, and one-shot undo behavior without native R/Quarto editor tooling. Installed selectors validate the
advertised operation registry. Dedicated local-source contracts own the strict ordered 32-operation live/generated
catalog and exact clipboard/atomic script export of distinct executable operation-labelled buffers; candidate
selectors prove only the installed editor seams and do not repeat that catalog through Cursor or performance. This addition changes no selector, job,
phase,
shard, 300-second hard deadline, 180-second inactivity
deadline, or retry rule. Candidate core, value, and categorical omit the former native-frame scaffold. `native-frames` owns the frame picker,
collapse/viewing sessions, native tibble Rename, and keyed-data-table Drop at comprehensive Linux VS Code depth and
representative macOS/Windows VS Code depth. macOS and Windows core remain representative.
Explicit candidate core skips both that work and embedded restart on
Linux, macOS, and Windows; `kernel-restart` owns restart/reopen under a fresh phase budget. Focused native, value, and
categorical selectors remain restart-free. Every R candidate catalog and document journey runs in VS Code only;
Cursor retains one separate generic lifecycle/responsive-grid/reveal-state seam. The remote R journey
retains its representative embedded behavior, so the split does not reduce coverage on any platform. Interactive
checks active R terminal discovery,
replacement, editing, CSV
and Parquet export through the real Save-dialog flow, and cleanup. Literate checks the packaged R Markdown document
action and Open Wrangler's R/Python Quarto title actions, dataframe opening, editing, code insertion, and cleanup in
VS Code. Ordinary candidate acceptance owns no
third-party Quarto preview semantics. Linux media capture alone owns the exact prefixed preview tab, bounded render,
visible capture, and cleanup. All six focused selectors
still verify the VSIX, editor, and R packages; only the interactive and literate selectors install and verify the
pinned native R and Quarto extensions. On Linux, the literate selector begins with the plain `.R` journey that formerly
ran in the core notebook phase. A separate runner-only selector,
`OPEN_WRANGLER_PACKAGED_R_JOURNEY=remote-r-jupyter`, requires Linux, exactly VS Code, and
`OPEN_WRANGLER_REAL_REMOTE_JUPYTER=1`. It runs only the five existing remote R Docker phases and does not prepare
hosted R, a local R or Python kernel environment, Cursor, or native R/Quarto tooling. It retains the remote
`lowerText` (Lowercase) operation even though the local value selector owns that check locally. The six focused local
selectors cannot
be combined with remote Jupyter. To refresh the complete R media set, run screenshot mode once without a selector for notebook images
and once with `OPEN_WRANGLER_PACKAGED_R_JOURNEY=literate-documents` for the Quarto picker.

On Linux, `OPEN_WRANGLER_REAL_REMOTE_JUPYTER=1` adds a container-isolated remote-server phase. The default mode uses the Python fixture; `r-jupyter` uses the R fixture. The hosted workflow runs both remote journeys only in VS Code.

The Python fixture starts from a digest-pinned Python 3.12 image. Its complete hash-locked `requirements.txt` installs Jupyter Server 2.20.0, IPykernel 6.30.1, Pandas 2.3.3, Polars 1.35.2, and DuckDB 1.5.4 with their Python dependencies. It repeats the Pandas/Polars/DuckDB runtime-transfer, renderer, insertion, restart, replay, and cleanup checks.

The R fixture builds two run-owned images. `Dockerfile.r.base` starts from digest-pinned Rocker R 4.5.2, applies
Ubuntu snapshot `20260311T000000Z`, and installs the hash-locked Jupyter host foundation from
`requirements.r.txt`. `Dockerfile.r` then consumes that exact base-image receipt, installs the pinned R packages and
kernelspec, adds the server helpers, and produces the final fixture image. Existing R packages stay on the March P3M
snapshot; Collapse 2.1.7 and nanoparquet 0.5.1 come from the reviewed June snapshot.
The runtime image checks all seven versions before installing its kernelspec. Its Python closure contains Jupyter
Server 2.20.0 and only the dependencies needed to host it; it does not install Pandas, Polars, DuckDB, or IPykernel.
The journey covers native R discovery, paging, sorting, profiles, restart, runtime transfer, and cleanup.

Both containers are unprivileged and read-only, with private tmpfs storage, no host mounts, a random loopback-only port, dropped capabilities, no-new-privileges, and explicit resource limits. The per-run credential enters only through bounded stdin to a private file and reaches the editor through an owned mode-0400 descriptor. Before importing Jupyter, the server creates private work, configuration, data, runtime, and IPython directories. Container identity is checked before and after the journey, and cleanup removes only the labelled container and owned image set in reverse acquisition order. If Docker identity or ownership becomes uncertain, the test publishes no evidence path and leaves its private root in place. This is a container test, not a claim about WAN TLS, JupyterHub, SSH, or arbitrary hosted providers.

The two input files and hash locks—`requirements.in`/`requirements.txt` for Python and `requirements.r.in`/`requirements.r.txt` for R—are test inputs, not extension dependencies. Both pin Jupyter Server 2.20.0. Regenerate them only with exact `uv 0.11.32` through `npm run lock:remote-jupyter`. The script fixes CPython 3.12, `x86_64-manylinux_2_28`, PyPI's primary index, binary wheels, and the `2026-07-27T00:00:00Z` release cutoff, then validates both candidates before replacing either lock. Each changed lock is replaced atomically. `npm run lock:remote-jupyter:check` repeats that resolution and compares the bytes; `npm run audit:remote-jupyter` scans both committed closures against current advisories. Review every changed pin and hash. Do not add an audit ignore just to make the gate pass.

On a supported Linux host, run the released-Jupyter phases in both editors on a prepared private Xvfb display:

```bash
xvfb="$(npm run --silent prepare:xvfb)" &&
OPEN_WRANGLER_PACKAGED_EDITORS=vscode,cursor \
OPEN_WRANGLER_EDITOR_DISPLAY=xvfb \
OPEN_WRANGLER_XVFB_EXECUTABLE="$xvfb" \
OPEN_WRANGLER_REAL_JUPYTER_EXTENSION=1 \
OPEN_WRANGLER_REAL_REMOTE_JUPYTER=1 \
OPEN_WRANGLER_TEST_PYTHON=/absolute/path/to/python \
npm run test:packaged-editors -- openwrangler.vsix
```

On Linux, run VS Code without creating a window or touching the current desktop:

```bash
OPEN_WRANGLER_PACKAGED_EDITORS=vscode \
OPEN_WRANGLER_EDITOR_DISPLAY=headless \
OPEN_WRANGLER_REAL_PYTHON_EXTENSION=1 \
npm run test:packaged-editors -- openwrangler.vsix
```

Cursor uses the same isolated profiles but currently requires the explicit invisible Xvfb compatibility mode on this reference host:

```bash
OPEN_WRANGLER_PACKAGED_EDITORS=cursor \
OPEN_WRANGLER_EDITOR_DISPLAY=xvfb \
OPEN_WRANGLER_XVFB_EXECUTABLE=/absolute/path/to/Xvfb \
OPEN_WRANGLER_REAL_PYTHON_EXTENSION=1 \
OPEN_WRANGLER_PYTHON_EXTENSION_VSIX=/absolute/path/to/ms-python.python-2026.4.0.vsix \
npm run test:packaged-editors -- openwrangler.vsix
```

Xvfb here is a deterministic test compositor, not a claim that production Linux desktops use X11. VS Code's default
hosted path uses Chromium's zero-window headless Ozone backend and tests extension behavior without any desktop. The
pinned Cursor build reproducibly exits before harness activation on that backend, so its isolated Xvfb path is the
smallest reliable compatibility display and never touches the caller's X11, Xwayland, or Wayland session. A native
Wayland compositor would primarily retest Electron/window-manager integration; it is not a blocking Open Wrangler lane
unless a supported extension interaction is shown to differ there. An explicit local `current` run remains the
appropriate diagnostic for a real Wayland desktop.

A quick local VS Code journey uses the same invisible, disposable runner:

```bash
OPEN_WRANGLER_PACKAGED_EDITORS=vscode \
OPEN_WRANGLER_PACKAGED_MODE=platform-smoke \
npm run test:packaged-editors -- openwrangler.vsix
```

The manual compatibility matrix can run the bounded pinned-Cursor contract with:

```bash
OPEN_WRANGLER_PACKAGED_EDITORS=cursor \
OPEN_WRANGLER_PACKAGED_MODE=platform-smoke \
npm run test:packaged-editors -- openwrangler.vsix
```

Editor directories, shared state, generated fixtures, extensions, and ordinary results are temporary. Every native editor phase, including the standalone extension-host pass and packaged restricted, platform-smoke, Python-environment, Jupyter deny/allow/PySpark/remote, seed, and verify passes, has a 300-second hard deadline and a separate 180-second inactivity deadline measured from the latest changed durable checkpoint; operation-specific interactions keep their tighter limits. The Python container path registers distinct `jupyter-remote-setup`, `jupyter-remote`, and `jupyter-remote-cleanup` result, run, and progress identities. Remote R adds distinct `jupyter-r-remote-base-build`, `jupyter-r-remote-runtime-build`, `jupyter-r-remote-setup`, `jupyter-r-remote`, and `jupyter-r-remote-cleanup` identities. Python fixture setup retains one checked-monotonic 300-second hard budget and 180-second inactivity budget threaded into every Docker command and readiness operation. For R, `Dockerfile.r.base`, `Dockerfile.r`, and the existing container launch/readiness work each receive an independent checked-monotonic 300-second hard budget and 180-second inactivity budget. Boundaries pass only opaque in-process receipts for the exact Docker engine, image identities, and distinct owner labels; every receiving stage revalidates them before mutation. A Docker command may emit a changing checkpoint at most every 60 seconds only while its owned CLI child remains attached, and a checkpoint failure forces verified process-group shutdown before the command rejects. Cleanup retains the independent shared 15-second deadline, removes the container, runtime image, and base image in reverse acquisition order, and publishes a completion checkpoint only while editor, Docker CLI, engine, container, and image ownership remain verified. Any uncertain command completion, identity handoff, or cleanup withholds the evidence path and leaves the private root in place. Timeout regressions use an injected logical clock after proving that a real child process was spawned and live, so slow pre-spawn filesystem work on Windows cannot turn a cleanup assertion into a subsecond scheduling test. The runner writes its first checkpoint before spawn, and the generated harness records its start before loading the test module. Result and progress payloads use exclusive, randomized same-directory temporary files plus atomic rename, and each progress path is unique to its `runId` and phase. A result or checkpoint is valid only when its exact `protocol`, random `runId`, and `phase` match the current invocation; a stale or mis-correlated checkpoint cannot extend the inactivity deadline. The reader pins the first-observed path identity and rejects replacement before or during its final descriptor read. On POSIX, readers require one no-follow, single-link regular-file descriptor and reject oversized, linked, special, changing, or invalid-UTF-8 files without blocking. A progress read may discard and retry only a bounded regular snapshot consistent with a transitional atomic publication: a different inode, a zero-link displaced path, or the same identity/mode/link/size/mtime with only ctime movement. It never accepts bytes from that snapshot; same-inode mode, size, or mtime mutation still fails, and result reads never enable this retry path. Windows cannot provide equivalent `O_NOFOLLOW`/`O_NONBLOCK` behavior through Node, so each validated writer also atomically replaces an empty heartbeat whose path is derived from the exact run and phase. A live phase polls only that bounded regular-file metadata; it opens neither the progress envelope nor result contents until job-empty attestation. Wrong-run and wrong-phase writers update different heartbeat paths and cannot extend inactivity. Progress remains capped at 1 KiB including its newline, the heartbeat at zero bytes, and result JSON at 1 MiB. Editor stdout/stderr is drained into a bounded collector and discarded after success. On failure, the complete bounded value is redacted before at most its final 8 KiB is retained; private-key containers fail closed and retain no source text. A late `ChildProcess` error is diagnostic only after spawn and cannot settle an editor, downloader, or display lifecycle as if an exit occurred. A valid result already present still wins an exit race, but it is not trusted or parsed before verified tree shutdown. Failures are classified as `spawn-failure`, `premature-exit`, `outer-timeout` (with `phase` or `inactivity` as the timeout kind), `result-protocol-failure`, `explicit-test-failure`, `runner-failure`, or `interrupted`. Every classified error records the editor name/key/version, phase, elapsed time, exit code or signal, result path, and last checkpoint. Package validation, editor discovery/download, Python resolution, display startup, and extension installation use a synthetic `setup` phase with durable checkpoints, so a failure before the first workbench still produces a classified bundle. Cleanup-only and combined failures use a separate `cleanup` phase whose `cleanupOfPhase` field records the originating `setup`, `restricted`, `platform-smoke`, `python-environment`, `jupyter-deny`, `jupyter-allow`, `jupyter-pyspark`, `jupyter-remote`, `jupyter-r-remote-base-build`, `jupyter-r-remote-runtime-build`, `jupyter-r-remote-setup`, `jupyter-r-remote`, `seed`, or `verify` phase. POSIX fixture roots are removed immediately with bounded recursive-delete retries. On Windows, VS Code may keep a directory handle until workbench exit even after the custom editor and Python runtime are closed, so only non-symlink real directories validated as direct children of the isolated editor temp root are deferred to outer cleanup after Job Object emptiness is attested. A runtime or descendant handle that outlives the editor still blocks that attestation or final private-root removal and remains release-blocking. The runner does not retry a failed editor phase automatically; an intentional rerun starts from a new isolated profile so a flaky first result cannot be hidden.

Major extension-host checkpoints use the same bounded, exclusive, randomized sibling pattern with a no-follow descriptor and pinned identity; a publication or identified-temp cleanup error fails the test instead of becoming a best-effort diagnostic. Fragment cleanup first revalidates the captured regular-file device and inode, with a substitution regression requiring the replacement to remain untouched. The correlated Windows supervisor marker is removed before stderr byte accounting, returned output, or failure diagnostics, and a Windows-owned launch whose stderr is not piped is rejected before spawn. Stdout/stderr listeners remain attached and draining until ownership verification finishes. Regressions split the marker and target's final stderr suffix across chunks while applying backpressure, so stream transforms cannot drop a flush or suffix between process exit and job-empty verification.

Before deleting a failed run's private root, the packaged runner may retain sanitized, allowlisted text evidence only after every owned editor/display tree is proven empty. Before any editor launch it creates a random private staging root (mode 0700 on POSIX), pins its device, inode, mode, canonical path, and emptiness, and rejects planted entries or replacement. Each retained target receives an in-memory inventory receipt. Sealing revalidates the staging root and every target inventory, opens each strict-UTF-8 source through one no-follow, single-link descriptor, rechecks identity, re-runs credential redaction, and writes one exclusive random JSON artifact outside the staging root. GitHub runs place that artifact in a fresh randomized parent below `RUNNER_TEMP` (mode 0700 on POSIX); local runs fall back to `tmp/editor-acceptance-artifacts/`. The artifact parent is pinned by identity and canonical path throughout creation. Any detected pre-close failure scrubs the file to zero bytes through its still-owned descriptor and flushes that scrub before close, even if a parent rename made pathname cleanup impossible. If close reports an error after the descriptor is already closed, the runner removes only the still identity-matching path under its pinned parent. A completed artifact receives one frozen in-memory receipt containing its exact path, parent identity, full post-close file snapshot, byte size, and SHA-256 digest; the runner reopens it without following links, rechecks identity and digest, and repeats that validation immediately before writing `evidence_path` to `GITHUB_OUTPUT`.

The artifact can contain phase result/progress JSON, selected `main.log`, `sharedprocess.log`, `renderer.log`, `notebook.rendering.log`, `exthost.log`, and Open Wrangler output-channel logs. During an isolated Jupyter acceptance failure, the runner may inspect the newest Jupyter output log from that phase only long enough to derive a fixed failure category such as `kernel-exited` or `kernel-start-timeout`; the log itself is never copied, so its notebook code, paths, and dataframe values cannot enter the artifact through this diagnostic. The artifact can also contain a paths/types/sizes-only profile manifest and structured failure metadata. The runner reads logs from the user-data directory owned by the failed phase; it does not scan normal editor profiles. Known JSON evidence is strict-parsed in full within its file budget, 64 levels, and 100,000 entries, redacted by key and value, and serialized again during collection and sealing; oversized, malformed, or duplicate-key JSON is omitted. Logs continue through the bounded text redactor. The artifact never contains the raw profile, settings, workspace storage, databases, or arbitrary extension logs. Every inspected source is capped at 16 MiB, at most 64 candidates and 64 MiB are scanned in total, and the complete admitted text is checked for private-key material before any bounded tail is retained. Collection rejects symlinks, hard links, detected path swaps, special files, non-UTF-8 text, private-key material, and redaction failures; sealing independently rejects planted or changed entries and caps receipts, source bytes, files, and the final artifact. The path-swap regression synchronously replaces the source at its first descriptor read, then requires an exact race rejection and no copied replacement content; it does not depend on child-process scheduling. Original-host, repository, profile, copied/skipped/manifest paths, URI credentials, signed query values, quoted fields, nested escape encodings, terminal controls, private-key containers, and structured credential-like values are redacted or omitted. Collected evidence remains capped at 24 log files, 512 KiB per log, 8 MiB total log text, 4,000 manifest entries, and 128 KiB of structured failure metadata with at most eight levels and 256 entries. If downloader, editor, or display ownership cannot be verified, that uncertainty propagates: the runner restores environment values lexically, publishes no artifact or workflow output path, and does not canonicalize, stat, open, read, traverse, or remove any inherited private runtime, root, profile, result, progress, log, or staging path. CI and release pass only the exact emitted path to the immediately following pinned `actions/upload-artifact` step and retain failure evidence for seven days; they never upload the staging directory recursively. This contract is enforced for pull-request, preview, and stable workflows by the producer step identity, exact path and readiness output, adjacency, pinned action revision, and retention period. Human-facing step labels are deliberately not contract identities and may be clarified without weakening the evidence boundary.

`actions/upload-artifact` accepts a pathname, not an open descriptor or file-identity receipt, so it cannot preserve inode binding across workflow-step boundaries. The security boundary therefore treats the GitHub runner and the pinned upload action as trusted after editor/display ownership has been attested empty; arbitrary same-UID interference after that attestation is outside the supported threat model. A parent or file replacement after the final receipt check but before the action opens the pathname is the unavoidable narrow window at that boundary. The random private parent, receipt validation, exact non-glob path, and immediate handoff narrow the interval, but must not be described as race-free against a hostile runner. Cleanup-only and combined run/cleanup failures retain distinct attempts with the originating phase before verified private-root removal; a successful run removes its empty staging root and creates no artifact. A local failure prints the exact repository-relative artifact path and deliberately retains that one private parent for inspection; later runs never sweep historical local bundles or other untracked files, so the caller removes it when finished. CI relies on its disposable `RUNNER_TEMP` lifecycle after upload. Standalone extension-host failures surface the same bounded, redacted diagnostic to the caller but do not create an upload artifact.

Every success or failure path waits for or terminates only its exact spawned editor tree before private-root cleanup. A removable root is first moved atomically from its public name to an unadvertised random sibling, then its captured root and parent identities are revalidated twice before recursive deletion; a rebound public or quarantine path is retained untouched and fails cleanup. After Windows proves the Job Object empty, that one quarantine rename may retry `EACCES`, `EBUSY`, or `EPERM` on a fixed 250/500/1,000/2,000/4,000/8,000 ms schedule to tolerate a short-lived sharing lock. The runner revalidates the complete source receipt and the quarantine target's absence before and after every wait; identity drift, a planted target, another error, wait failure, or exhaustion fails closed. This is cleanup of an already verified-empty tree, never an automatic editor-phase retry, and recursive deletion itself is not retried. Cursor acquisition revalidates the published artifact's named path and canonical identity after its descriptor hash and again at the synchronous spawn boundary for DMG attachment, Authenticode verification, and the private installer. Windows Authenticode verification invokes `WinVerifyTrust` without UI, forces URL retrieval to the local cache, disables revocation networking, and rejects MD2/MD4. While the verified provider state remains open, the runner extracts that same signature's primary X.509 leaf, then requires its exact simple name and DER SHA-256 certificate pin before closing the state. This defense follows the independently pinned artifact byte length and SHA-256; it deliberately avoids a live revocation dependency so a CA endpoint cannot hang or nondeterministically block isolated CI. Its private Windows uninstaller is itself a process launch, so ownership uncertainty skips that cleanup without reading the acquisition and retains the complete private root. On POSIX, the editor, extension host, and test kernels share a dedicated process group. On Windows, a fixed-deadline bootstrap compiles the checked-in C# supervisor once into the run's private root, pins its parent and executable identity plus SHA-256, and launches that exact executable for every command. Supervisor preparation consumes the same command or phase deadline, and a root involved in an unverified bootstrap is permanently ineligible for reuse. The supervisor creates the editor suspended, assigns it to a private kill-on-close Job Object, restricts inherited handles to its own stdio, and resumes it only after ownership succeeds. The runner generates a random attestation token outside the target environment; the supervisor may emit it exactly once and only after querying `ActiveProcessCount == 0`. Missing, duplicate, malformed, or late attestations fail closed. The supervisor keeps a parent control lease on stdin, handles graceful termination requests, and reports normal completion only after that attestation; the runner closes control stdin on every settled path, while premature lease loss closes the job. A forced supervisor termination or any ambiguous completion permanently marks ownership unverified, even if a later exit or error event arrives, so phase contents and private-root cleanup remain prohibited. Neither path discovers or signals editor processes from normal profiles.

Attestation uncertainty is permanently latched: a later matching marker, exit, close, or error cannot upgrade an ambiguous launch to verified ownership. The native Windows smoke exercises the compiled C# supervisor, proves its compile-once contract, natural-exit descendant containment, and explicit termination, and rejects malformed launch framing.

The PR workflow runs one canonical stable VS Code extension-host owner on isolated Linux. Scheduled/manual
Cross retains the stable macOS and Windows extension-host cells, and its Windows owner retains the native
process-supervisor and dependency-guard contracts. Minimum-editor and broader packaged VS Code/Cursor evidence remain
release qualification; the current PR workflow does not claim that those lanes moved into the canonical pull-request owner.

The Windows cross-platform cell runs `npm run test:scripts:native`, so the real Windows supervisor is checked without adding another setup job or repeating the portable script suite. Phase deadlines include supervisor preparation, receipt validation, process spawn, and the cancellable private debugging-port reservation; a stalled reservation aborts and closes its unreferenced server before the phase can launch an editor. Windows CLI-only setup never invokes a `.cmd` file or command shell: it requires the wrapper to identify the editor's own `bin` directory, resolves exactly one regular contained `resources/app/out/cli.js` from either the legacy root or one 10-hex version directory, and launches the verified editor executable with that path prepended. Only this CLI child receives the fixed `ELECTRON_RUN_AS_NODE=1`; workbench launches continue to strip inherited Electron mode flags.

Recorded first-class editor-platform evidence, 2026-07-27:

| Candidate                                                                                                                 | Native desktop evidence                                                                                                                                                                                                                                                                                                                                | Remote-workspace evidence                                                                                                                                                                                                                                               | Result                                                                                                                             |
| ------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| PR head `32706d60`; 70 entries; 605,541 bytes; SHA-256 `66b62609899286ab3590f900588cf9afee9afe293b52bb4f1372ae7420397715` | [CI 30277495429](https://github.com/Matt17BR/openwrangler/actions/runs/30277495429): full stable VS Code package acceptance plus Cursor 3.13.10 bounded smoke on macOS 26.4 arm64 with the universal artifact and Windows Server 2025 x64 with the x64 artifact; same-head minimum/current extension hosts and production axe/visual validation green. | One [Ubuntu 24.04 Linux-x64 job](https://github.com/Matt17BR/openwrangler/actions/runs/30277495429/job/90016714005) with official VS Code 1.130.0 and Remote SSH 0.124.0 opened, paged, and filtered a remote Polars CSV while retaining authority and source identity. | Exact candidate's single attempt green; source unchanged; zero sessions/runtime; verified cleanup; no failure-diagnostic artifact. |

This evidence closes the two first-class editor-platform rows only. The macOS/Windows Cursor jobs are bounded platform smokes backed by the deeper recorded Linux suite; the Remote SSH fixture covers one pinned loopback mechanism, not every remote host/provider. Virtual-grid and installed first-usable-grid timing remain open performance gates.

Packaged notebook acceptance opens the real MIME-v2 renderer, explicitly reveals its output cell, exercises 10/20/50/100-row inline paging and every captured column, and checks same-group switching plus the split-editor provenance race. Action discovery accepts only one settled `iframe#active-frame`, rejects any wrapper that still owns a pending guest or multiple retained active guests, and never clicks a merely visible pending/retained representation. With notebook B active, the harness re-reveals notebook A's output after the split layout settles, then one activation on A's visible linked action must open A's complete current live variable, use only A's exact kernel, and return the live value rather than the captured row. Before crossing the click boundary, Playwright scrolls the retained exact element into the outer workbench viewport under the shared deadline and the harness rechecks that it is connected, enabled, visible, and owns its center. A failed scroll is therefore a proven pre-dispatch failure eligible for the same single exact-target reacquisition as a retired element. The harness then sends one trusted Playwright click with Playwright's native timeout. The forced option bypasses only Cursor's intermittent motion heuristic after that exact-element check; it does not dispatch a DOM event or use sampled coordinates. If the pinned button retires or fails readiness before that click boundary, the harness may find the exact button once more. The trusted click is never retried. Its exact live session is the authoritative receipt, and bounded activation-stage, button-ready, click-boundary, receipt, and pre-cleanup diagnostics distinguish a retired pre-click target from an indeterminate dispatch. A synthetic click, active-editor fallback, snapshot session, or request to B is not release evidence. The released-Jupyter fixture repeats this over a 100,000-row dataframe whose saved capture is deliberately smaller. Before restart acceptance injects widths, selection, and viewport, the real renderer must hydrate and acknowledge its default state; it must then acknowledge the injected state so a late default update cannot invalidate the recovery assertion. Renderer component acceptance covers the unlinked case: the inline table remains readable, there is no open button, and the rerun hint appears without a host message. Timeout diagnostics retain only bounded origin classifications, coordinator state, and A/B kernel counters, never dataframe values.

Released-Jupyter product media uses the same public notebook state that the extension sees. Before capture, the
fixture's setup, restart-probe, and runtime-transfer cells are selected and collapsed through built-in notebook
commands, then the public dataframe cell is revealed and required to intersect the editor's visible range. The
variable-picker scene first reacquires the exact `orders_preview_df` renderer action and scrolls that real output
into view; visible workbench text is checked for private fixture markers before and after the native picker opens.
Generated-code insertion is proven through the exact `NotebookDocument`: one uniquely marked cell must be added,
its engine-generated source and metadata must match, every surrounding cell must remain unchanged, and the public
visible range must contain the inserted cell before its screenshot is accepted. Private Monaco DOM structure is
not part of that proof. Public media crops may remove empty canvas or already-collapsed private cells, but never
mask or reconstruct notebook UI.

A delivered post-reconfiguration marker that is never acknowledged must trigger the same bounded renderer reload and
replay the committed session without reopening the runtime or repeating the import transaction.

Component coverage must flush pending presentation state before publishing exactly one `rendererRetiring` receipt on
a non-persisted `pagehide`, and must publish nothing for a persisted transition, stale marker, or marker that was never
acknowledged. Panel coverage accepts only the exact current hydrated session/revision receipt, clears readiness and
synchronization, and proves one existing bounded HTML recovery followed by fresh hydration without another
`openSession` or an early `closeSession`. Malformed, unhydrated, superseded/host-replacement, and post-disposal
receipts remain inert. This is graceful page lifecycle coverage, not a heartbeat: a hard renderer-process death that
emits no `pagehide` remains out of scope.

Packaged **Change Import Options** acceptance exercises the same real path. It retires the synchronized document via
non-persisted `pagehide`, then only observes automatic receipt invalidation and the existing bounded replacement. The
same session, runtime generation, and view must survive; the journey may not call `synchronizePanelForSession`, focus
the panel, request a reload, or reopen the source or runtime.

Explicit **Change Import Options** acceptance publishes checkpoints around every delimiter, encoding, header, and quote interaction, selects QuickPick rows through focus-checked keyboard navigation, and requires sequential prompts to ignore incidental focus loss without weakening Escape or cancellation. A primary CSV/TSV launch fails if any import prompt appears. Pointer and title/tab/Command Palette paths must flush presentation state, enter the busy interlock, and keep the product command pending through the exact renderer-prepared transaction so the custom editor cannot reclaim focus over an open Quick Input. After the final prompt closes, acceptance restores focus once, requires the exact titled session and physical grid, and waits for one fresh synchronization before later interaction. Grid restoration must publish the authoritative widths and selection before assigning either scroll axis; a synchronous browser scroll event may adjust the physical viewport but must never merge that viewport with the previous presentation. No mutation, prompt, or renderer action is retried after an indeterminate dispatch, and terminal cleanup leaves no coordinator session.

Same-group notebook switches may retry discovery only for a proven-retired renderer target and still fail immediately for a closed workbench, disconnected browser, or error from a live target. Grid discovery orders bounded candidates, prioritizes the newest Open Wrangler target, and requires the exact session marker after hydration. Native prompt acceptance never assigns focus with Playwright: after the product reclaims the workbench Quick Input through the standard focus command, acceptance waits for that transfer, sends complete key-down/key-up pairs between chained Quick Inputs, keeps separate Node-owned deadlines for each interaction and diagnostics collection, and records only structural diagnostics without user values. A late renderer-ready event may republish retained state but never reopen a source or retry a failed or denied launch. Panel cleanup uses the exact session identity, accepts the last confirmed revision for terminal close, and never depends on the active editor.

The main/release runtime matrix must pass on Linux/Python 3.10, macOS/Python 3.12, and Windows/Python 3.14. Test fixtures must build filesystem expectations with the host path implementation, mixed-label Pandas fixtures use an object `Index` so supported Python/Pandas type environments agree on the constructor contract, and `.gitattributes` keeps text checkouts LF-normalized while exempting binary release/test assets.

Release-workflow contract tests parse behavior rather than pinning complete YAML. Candidate tests require first-attempt
protected-main dispatch, one package producer and canonical triple, one non-matrix reusable acceptance caller, an
independent Remote SSH owner, and an always-evaluated success-only manifest fan-in. They prove every consumer uses
the numeric artifact ID, candidate jobs remain read-only, VS Code owns semantic acceptance, Cursor runs exactly one
generic Linux lifecycle seam, R 4.4 and 4.5 platform evidence remains present, performance emits one digest-bound
report, and no current candidate path publishes.

Stable tests require a two-job selector/promoter graph. They reject a rerun, soak outside 168–336 hours, missing or
expired artifacts, newer successful same-tag candidate, dispatch-source checkout, cross-run/artifact-ID drift, manifest
or performance mismatch, write permission outside the protected promotion job, any rebuild/repackage, missing canonical
reverification, and weakened tag/GitHub/Open-VSX/public-media conflict checks. Failed-run histories are intentionally
absent from stable documentation; workflow logs and failure-only artifacts retain that operational evidence.

Pull-request classification is covered by `npm run test:scripts:workflow`. The current PR workflow has no draft-only context or legacy
release-infrastructure/package/full-matrix classifier mode: the sole classifier emits exactly
`r_contract_required`, `canonical_editor_required`, `visual_accessibility_required`, and `windows_unique_required`.
Control-plane changes, malformed or missing output, unmatched substantive paths, and non-pull-request events select
the complete four-owner union. Documentation-only changes may select no conditional owner, while the unconditional
`invariant-core` still runs the complete non-TypeScript static, portable-script, Python 3.10, audit, schema,
documentation, and license boundary. The selected canonical owner runs both TypeScript typechecks and the complete
TypeScript unit/component inventory; every tracked
TypeScript product, protocol, fixture, package, or configuration path selects that owner. Protected-main pushes run
the complete `npm run check:pr` source gate. The selected R owners are the two lock-backed R 4.5 pull-request jobs. Cross has no pull-request trigger; its
manual dispatch and weekly schedule retain the macOS/Windows runtime matrix, Windows dependency guards, and lock-backed
R 4.4 qualification. Missing, failed, cancelled, or unexpectedly skipped selected results block the sole `validate`
owner. CodeQL independently runs the always-on JavaScript/TypeScript and Python analyzers and requires both through
`CodeQL gate`. Every external workflow action occurrence and both local reusable-workflow targets are an exact reviewed
inventory. The topology contract makes no job-count, compute, or wall-time claim before separate hosted measurement.
Remote SSH remains opt-in through the
`acceptance:remote-ssh` label.

Pushes to protected `main` run complete JavaScript/TypeScript and Python CodeQL analysis so the Security tab is
refreshed from the default branch. A successful `Analyze` job is only execution evidence: security acceptance queries
the code-scanning API and requires zero open high or critical CodeQL alerts on the analyzed `main` commit.

The installed-performance manifest boundary is the complete Python-produced object, not a reduced extension-host projection: generator, license, redistribution, file-name, format, shape, Int64-column, sentinel-row, byte-size, and SHA-256 fields are all exact. The extension host and release report execute one shared decoder, and a Python regression feeds the generator's actual smoke-manifest stdout through that decoder.

Guarded installed-performance packaging tests require every VSCE source to be tracked or an exact generated output, reject both a packageable untracked runtime module and an ignored `media` extra while leaving excluded user files outside every read, and pin each tracked and generated input's identity, size, and SHA-256 around packaging. The exact generated set includes only the reviewed `dist/extension/vendor/js-yaml.js` extension-host vendor asset in addition to compiled and media outputs. The sealed archive must match the pinned source inventory and every source-byte digest; the shared archive verifier separately requires that vendor path's 122,488-byte `f1499c20ab232a283f6f9f85aeecc99dceab175e8dd4005bd3d764848f3e5965` receipt and rejects its omission, mutation, or any sibling vendor filename. The R-runtime and vendored-js-yaml requirements are independent: current authoring defaults both on, while historical registry tests derive each from an exact regular-file tag-tree marker, allow R-bearing 1.99.0–1.99.2 packages without the later vendor marker, and reject 1.99.3-or-newer and 2.x-or-newer sources that drop it. Marketplace and Open VSX tests require the derived policy to survive every handoff. A historical package that does include the vendor pathname must still match the reviewed receipt. License tests require the upstream js-yaml LICENSE hash and full Vitaly Puzrin MIT notice while keeping the package development-only. Regressions substitute a tracked or generated input and add an otherwise allowlisted runtime entry only to the simulated `createVSIX` result; all fail even when a later pathname scan would look clean. Product packaging disables VSCE's GitHub issue autolinker, ordinary VSIX verification rejects source-to-package README drift, and README links stay absolute so relative-link rewriting cannot create an undocumented transformation. Final-publication tests mutate the candidate while the report receipt is read and require the joint validation to fail.

`package-current-channel`, reproducible-VSIX, and portable package-source-manifest unit tests own the ordinary product
packaging transaction without running a real package build. They require exact stable/preview VSCE options; files-only
canonical STORE archives with bytewise UTF-8 order, fixed timestamps, and exact `100644` ZIP modes; source/archive
digest parity; and an internal manifest covering every package source plus the two VSCE-owned metadata entries.
Adversarial cases
cover exact POSIX permissions and Windows' writable-bit host-mode behavior, source mutation and restoration under a
new identity, raw-file replacement and hard links, existing regular, symbolic-link, and hard-link destinations, a
package-source destination, aliased or replaced parents, write and link failures, an ambiguous link that completed
before reporting failure, staging-name retirement failure, public-name substitution, a surviving final hard link, and
private cleanup failure. Success must reopen the exact public inode, prove canonicalization is idempotent, repeat
archive/source/manifest binding, and leave one public name with link count one. On failure, cleanup removes the exact
produced public inode only while it remains attributable. A substituted or otherwise unknown path is retained and
reported as cleanup uncertainty, and tests prove that it is never mistaken for the produced output. The in-memory
manifest is neither packaged nor published. These tests add no candidate selector, workflow lane, readiness rule,
provenance field, or release evidence claim.

## Data Wrangler comparison

The comparison method is in [`docs/performance-comparison.md`](performance-comparison.md). Its commands are:

- `npm run comparison:smoke` for both products on one Pandas/CSV workload;
- `npm run comparison:study` for the eight-session benchmark; and
- `npm run comparison:report` for `report.json` and the generated results block in its sibling `review.md`.

The benchmark covers Pandas and Polars with the 100k × 50 CSV and 1M × 20 Parquet fixtures. A session is one isolated
headless VS Code window for one product and workload; a sample is one timed pass through the notebook workflow. The full
study has eight sessions and 40 samples. Each sample uses the public Run Cell, launch, usable-grid, and
all-column-profile controls. Linux PSS sampling covers the same measured window, requires at least two observations,
and rejects a gap longer than one second.

Ordinary pull-request CI runs the focused harness contracts, not the real-product smoke or study. The two-session,
two-sample-per-product
smoke and eight-session study run against the release candidate and produce release-only evidence.

The report keeps all five outcomes, including failures, and summarizes successful timings with the minimum, maximum,
and median. Its p95 field remains for report compatibility, but it is not a five-sample headline or release gate.
Release evidence requires all five Open Wrangler samples and at least three of five Data Wrangler samples for every
workload.

The 1.2.1 results remain the published comparison during the 1.99 preview series. Before 2.0 is released, rerun the
full study with the candidate VSIX, review the raw results, and update the README and a new dated report. A stable
major or minor release needs a report from that exact release. Patch releases may keep the latest reviewed report
from the same major/minor line; the runtime and installed-editor regression benchmarks still run for every release.
For generated reviews, `npm run docs:check` follows the link in the README and compares the marked results with the
sibling JSON. Stable 2.x readiness also requires both files to be tracked. The historical 1.2.1 review has no sibling
JSON and is not rewritten by this check. The documentation check recalculates outcomes and summaries from the raw
samples. The stable release gate then reads the report from the release commit and matches an exact-version report to
the candidate VSIX checksum.

Every session owns a mode-0700 root, user-data profile, notebook, read-only fixture copy, and process tree. Product
extension directories are prepared once per arm to avoid repeated Marketplace downloads. One JSON result is written
per completed session, so collection can resume without discarding completed sessions.

Run the focused pure checks while changing the harness:

```bash
node --test \
  scripts/data-wrangler-comparison-study.test.mjs \
  scripts/data-wrangler-comparison-install.test.mjs \
  scripts/data-wrangler-comparison-neutral-driver.test.mjs \
  scripts/data-wrangler-comparison-report.test.mjs \
  scripts/linux-pss-sampler.test.mjs
```

Before collection, build the real candidate and run `npm run comparison:smoke` in a separate output directory. Both
product sessions must prove headless isolation, public actions, a scrollable sentinel-matched grid, two completed
samples each,
PSS coverage, and terminal cleanup. Delete its output afterward; it is not performance evidence. Use the
same candidate, editor, Python environment, machine policy, and fixtures for the full run, with no concurrent build or
editor work.

The independent review checklist lives in
[`docs/performance/data-wrangler-1.2.1/review.md`](performance/data-wrangler-1.2.1/review.md). Method review must finish
before collection. Final publication waits for all eight session results and an independent recalculation of counts,
summaries, median regression decisions, and PSS.

## Performance fixtures

The non-promotional Native R performance harness runs against one exact packaged candidate:

```bash
mkdir -p tmp/performance
EXPECTED_SHA=<exact-40-hex-source-commit> \
RELEASE_TAG=<exact-provenance-tag> \
npm run benchmark:r -- \
  --candidate-in openwrangler.vsix \
  --candidate-checksum openwrangler.vsix.sha256 \
  --candidate-provenance openwrangler.vsix.provenance.json \
  --out tmp/performance/native-r-report.json
```

All four named arguments and both environment bindings are mandatory. The runner accepts only the canonical candidate
basenames, rejects repeated, unknown, or implicit options, and accepts exactly one supported preview, stable, or
evidence-only provenance protocol. The provenance commit and tag must equal `EXPECTED_SHA` and `RELEASE_TAG`;
the current checkout must be that exact commit with no tracked changes. The runner jointly binds the tracked harness
blob and bytes, VSIX bytes, lowercase checksum, bounded provenance, packaged manifest version, source commit, release
tag, and normalized artifact kind before extracting the packaged `frame_contract.R` and `kernel_agent.R` into one
private mode-0700 root. `RSCRIPT` may choose the executable for the run, but its filesystem value is never written to
the report.

Before measurement, one separately accounted, bounded `Rscript --vanilla` probe runs with the caller's explicit,
canonical HOME to resolve the effective R library directories. It pins and revalidates at most 64 canonical directory
identities, then gives all seven measured children a private HOME plus explicit `R_LIBS`, `R_LIBS_USER`, and
`R_LIBS_SITE` authority. No library path enters the public report: it retains only the discovery protocol, directory
count, and explicit-directory verification. The probe's `/proc/<pid>/status` VmRSS is parent-sampled every 5 ms and
published under `libraryProbeMethod`, `libraryProbeSamplingIntervalMs`, and `libraryProbeMaxObservedRssKiB`, alongside
its natural-exit and process-group cleanup proof.

The SHA-256-bound fixture is a 250,000-row × 20-column mixed base data frame with integer, floating-point, text,
logical, factor, ordered-factor, Date, POSIXct, difftime, and exact `integer64` columns plus deterministic missing,
`NaN`, infinity, Unicode, and duplicate-label cases. Pages are 200 rows × 16 columns; twenty scheduled windows rotate
through deterministic row offsets, using column offset 0 for samples 1–10 and offset 4 for samples 11–20. At each of
the direct packaged-frame and real
Node-to-owned-`Rscript` kernel boundaries, the report retains five fresh capture/open samples, then twenty projected
pages, twenty compound-filtered pages, one separately named first uncached stable multi-key sort, twenty cached sorted
pages, and twenty eight-column mixed-type summaries. Untimed semantic controls verify exact dataset statistics, the
production sampled/chunked summary path on 1,000,001 rows, and a keyed `data.table` whose frame class/key, row and
column identities, and serialized source bytes stay unchanged. The same proof retains supported S3 column metadata:
factor and ordered-factor levels/classes, POSIXct timezone, difftime units, and the `integer64` class.

The direct measurements run inside one owned `Rscript`. Each kernel fresh/open sample launches a new
`Rscript --vanilla`, sources the two extracted candidate assets, creates the real kernel agent, exchanges one
correlated newline-delimited `openSession` request/response, closes and disposes the session, and exits naturally. A
sixth child owns the measured page/filter/sort/summary work and the untimed controls. Kernel time uses Node's monotonic
clock: fresh samples cover process spawn through the correlated open response, while later samples start after the
stdin write completes and end only after strict parsing plus semantic validation of the correlated stdout response.
The kernel schedule contains exactly 86 measured and 13 control responses, 99 correlated responses in total, six
ready frames, and eight closed sessions. Process accounting is separate: the library probe, direct child, five fresh
kernel children, and workload child make exactly eight naturally settled owned `Rscript` processes. Reported p95 uses
nearest rank over every retained raw sample. No sample is trimmed, deleted, replaced, or retried.

`benchmark:r` is a Linux reference runner, not a portable benchmark command. The direct child records
`/proc/self/status` VmHWM after every stage; the Node parent samples each kernel child's `/proc/<pid>/status` VmRSS at
5 ms intervals and retains all five fresh maxima, the workload maximum, and per-request observations. Only the report
and runner unit contracts are portable. The per-process 300-second deadline is a lifecycle-safety bound, not a
performance threshold, and does not change any editor phase or inactivity deadline. These timings cover native-R
runtime and owned stdin/stdout request boundaries, not IRkernel, VS Code, Cursor, webview, editor first paint,
filesystem-cold reads, or cross-language comparison.

The `openwrangler-native-r-performance-report-v1` envelope is bounded to 1 MiB and retains candidate identity plus
path-free Linux, CPU, memory, R, and Node provenance. It records the Node version and the exact Node and `Rscript`
executable byte sizes and SHA-256 digests, never their paths. Package fields are exactly `jsonlite`, `dataTable` (for
`data.table`), `rlang`, `bit64`, `tibble`, `nanoparquet`, and `collapse`; the first four must be installed and the last
three may be null. CPU-model slash and backslash separators are normalized to spaces (so names such as `w/ Radeon`
remain usable) before the common public-string path scrub. The report contains deterministic synthetic sentinels but
no source or user cell values, username, hostname, environment dump, candidate/output/temporary path, or arbitrary
process log.

The output parent must already exist, resolve canonically without a symlink, be owned by the current user, and keep the
same identity through publication. The output may not replace a candidate input, the commit-bound harness, another
tracked source, or a file inside the private measurement root. Publication uses an exclusive mode-0600 sibling
temporary, flush and sync, identity checks, one atomic rename, and post-read receipt validation. All eight sessions
must close, every owned process group must disappear, and the exact private-root inventory must be removed; cleanup
removes only still-identified paths, and a failure is never rerun automatically.

The v1 schema can say only whether a measurement is structurally valid: `releaseGate` is fixed false because no
reviewed Native R threshold profile exists, and its validator rejects any release-success claim. Running this command
therefore does not supply the still-outstanding exact-candidate performance record or advance Native R beyond
**Partial**. Stable candidate authoring and readiness consumption, including the stable-source/candidate circularity,
belong to the next reviewed performance-evidence change.

`npm run benchmark:runtime` is the canonical strict native-Polars release benchmark. It creates deterministic 100k×50 CSV and 1M×20 Parquet fixtures under ignored `tmp/performance`. Before timing, it validates exact dimensions, ordered Int64 schema, and deterministic sentinel values in every column; an invalid or partial fixture is atomically regenerated. Validation reads the source, so the harness then requires Linux to accept a per-file `posix_fadvise(POSIX_FADV_DONTNEED)` eviction before the first direct open and again immediately before the canonical stdio open. The stdio cold-source open is the release-gated first-usable-grid boundary at 3s/5s; missing eviction proof fails strict mode. Every timed open requests the first 16 columns, matching the shipped default; timed cache-miss pages rotate across real horizontal blocks, including nonzero offsets. `projectedGridColumns` records the resolved width, while the report records every sampled column offset and validates the returned stable IDs. `pageCache.maxBytes` is the maximum total retained cache weight observed during the run, not the byte size of one response. The report separately retains the first direct open and the median of later fresh-manager opens against a warm OS source cache (`warmSourceReopenMedianMs`). Direct `SessionManager` cache timing is explicitly named `directRuntimeCachedPageP95Ms` and `directRuntimeCacheMissPageP95Ms`; it is not presented as editor or transport latency. A second measurement spawns the real standalone Python runtime with the selected backend already imported, sends canonical protocol-v2 newline-delimited JSON envelopes over stdin, parses stdout envelopes, and records `stdioTransport.cacheMissPageP95Ms`. Its isolated benchmark bootstrap leaves canonical stdin/stdout behavior unchanged and wraps only the selected engine's production `header_stats` call, emitting entry and exit timestamps on stderr from Python's process-wide monotonic clock. The interactive cache-miss page is sent only after the entry event, and strict mode requires its completed write timestamp to fall inside that measured call interval; the report retains both signed timing margins around the send. A completed-before-send or otherwise unproven interval is an inconclusive release failure rather than a pass.

Direct invocation accepts `--backend polars`, `--backend pandas`, or `--backend duckdb`. Every report names the selected backend and records backend package versions, Python/Open Wrangler runtime versions, machine and source provenance, native frame types, lazy-frame evidence, and sampled RSS/peak-RSS boundaries for the driver and standalone process. It also states that the measurements cover direct Python runtime and protocol-v2 stdio work, not VS Code, Cursor, webview, or editor first paint. Pandas and DuckDB runs are diagnostic only: `benchmarkMetadata.releaseLimitsApplyToBackend` remains `polars`, `selectedBackendIsReleaseGated` is false, and non-Polars `--strict` runs deliberately fail instead of producing a misleading release pass. The focused smoke form is:

```bash
.venv/bin/python python/benchmarks/runtime_performance.py --smoke --backend duckdb --json-out tmp/performance/duckdb-smoke.json
```

For a proven active interval, strict mode compares the response-completion gap with half the lower-tail uncontented cache-miss baseline. This demonstrates substantial response overlap even when CPU contention makes callbacks co-complete; a gap consistent with a page starting only after statistics finishes sets `sameSessionContentionObserved=true` and fails release. Unit coverage fixes both sides of the threshold, completed-before-send and not-yet-started intervals, and the malformed event ordering. The smoke subprocess covers the real bootstrap event framing without applying release-size timing gates.

For the strict Polars report, the CSV/Parquet cold-source stdio first-grid limits and warm-source reopen limits are both 3s/5s. Direct cached pages are gated at 100ms; direct cache misses, ordinary stdio cache-miss round trips, and same-session stats-contended pages are all release-blocking at 500ms. The active-call proof and overlap requirement are independently release-blocking, so a fast machine cannot skip the concurrency scenario or hide serialized session work behind the numeric ceiling. Every backend report records deferred visible profiling, exact counts, native-frame retention, bounded cache weight/entries, and zero retained sessions, but only Polars is compared with release limits. The scheduled Linux `Performance gates` workflow repeats the strict Polars benchmark and uploads its report.

The Playwright wide-grid acceptance independently measures rendered scrolling against the same 100ms cached and 500ms uncached p95 limits. Its generated host accepts only exact row-and-column-keyed fixture pages, checks ordered IDs and row cardinality before dispatch, and records the bounded response that supplies the final known column value. This is production webview-bundle evidence in the pinned browser, not VS Code/Cursor workbench paint timing. Repeated extension-host and installed-package runs verify process/session cleanup; a benchmark is not accepted if `SessionManager.sessions` retains an entry after close.

The opt-in Linux installed-editor benchmark has a local self-package path and one canonical release-candidate intake path. Candidate qualification invokes the canonical intake with explicit VS Code ownership and uploads one bounded JSON report whose bytes and SHA-256 are sealed into the qualification manifest. Stable promotion downloads and verifies that exact report; it never reruns the benchmark or rebuilds the VSIX. Historical preview/stable intake modes remain unit-tested only for recovery compatibility.

The hosted job runs on `ubuntu-24.04`. It downloads the evidence set by exact run-scoped artifact ID, verifies the exact lowercase checksum and bounded provenance, and builds only `build:test-extension`; it never rebuilds the production VSIX. A bounded pre-compiler tree guard rejects a linked or noncanonical `dist-test` before TypeScript can write through it. Cross-platform guard fixtures first resolve their owned OS temporary directories to the same canonical spelling, while explicit alias/junction regressions still prove that production inputs fail closed. The build then stages the fixed, declaration-shadowed CommonJS runtime asset set byte-for-byte through no-follow descriptors. A bounded no-editor Node preflight stubs only `vscode`, loads the exact compiled installed-performance entrypoint, requires its `run` export, and descriptor-revalidates the entrypoint, its four compiled local helpers, and every runtime asset after the child exits. That initial preflight finishes before the run acquires official VS Code 1.130.0 Linux x64 (`356,926,919` bytes, SHA-256 `7d6ad3d3a78ac4551c14631f78d7e03c85282ab505c3ce8b1bc04e01fafe88ea`) into the run's mode-0700 private root; the same complete preflight then repeats immediately before every VS Code phase. Exact size and SHA-256 validation precedes extraction and launch. VS Code uses zero-window headless Ozone. The run may not reuse a preinstalled editor, moving download channel, normal profile, current desktop, or implicit local-display fallback. The downloaded package and extracted editor tree are temporary test inputs only: they are deleted with the owned private root and are never bundled, cached as release outputs, uploaded, published, or redistributed. Cursor performance remains historical evidence only; current candidate qualification owns one separate pinned compatibility seam.

The report retains the intended channel with the exact source commit, candidate checksum, and provenance digest. Candidate bytes and bounded phase JSON are opened no-follow before inspection, read only through pinned descriptors, and revalidated through descriptor and path identities after the read; a symlink, replacement, same-inode rewrite, or identity drift fails without consuming substituted bytes. Each extension-host phase fragment is committed with an atomic no-clobber sibling hard link, then retires only the still-identified temporary name; ctime may advance across those two link-count transitions, but the resulting destination ctime is pinned through a no-follow descriptor read and exact byte comparison before its receipt is minted. A raced destination is retained untouched. After VS Code finishes, the runner reopens the exact private VSIX snapshot, revalidates its frozen identity, hashes every byte through that descriptor, and requires the original size and SHA-256 before building a report. Final report publication likewise pins its exclusive temporary through write, close, pre-rename validation, and post-rename validation; cleanup removes only that identified inode and is withheld if the path was substituted.

Four independent phases retain ten page-cache-evicted and resident first-usable-grid samples for the release-sized CSV and Parquet fixtures, including every aligned `fdatasync`/advisory/`mincore` proof. A fifth Parquet phase drives the production virtual grid through cached and previously unseen row blocks and uses the real column menu and filter drawer for typed filter and sort operations. Release-sized cached scrolling uses exactly 200 observed row transitions. Uncached-grid and renderer-heartbeat p95 each use 40 interactions; the non-gating 5,000-row smoke retains ten interactions so all deterministic unseen-row targets fit its fixture. Before a CDP measurement begins, the harness gives the panel ten seconds to complete its normal production hydration, then waits within the same overall deadline until the exact panel reports that its renderer is ready for the current host snapshot. Its single fallback first adopts any matching automatic synchronization already in flight and publishes at most one replacement only after that exact acknowledgement fails; a renderer that never becomes ready consumes no fallback, and a newer automatic generation is never invalidated. The harness then observes that same generation through the overall deadline rather than repeatedly replacing a slow renderer snapshot. After priming both cached blocks and restoring the first row, the harness performs exactly ten untimed alternating row transitions in VS Code before starting a fresh, identically ordered measurement window. This fixed warmup isolates steady-state cached scrolling from renderer/compositor startup; the separate first-grid phases continue to measure initial-grid startup. Warmup durations are neither report samples nor candidates for trimming, retry, or replacement. The first measured target therefore cannot be a no-op, and every timed scroll must prove that its requested row transition occurred. Each cached/uncached scroll sample is one renderer-local evaluation: its clock starts immediately before `scrollTop` assignment and settles only after two consecutive animation frames expose the exact non-busy ARIA shape, exact target text, and a nonzero target cell intersecting its scroller and viewport. Its physical target offset is derived from the production row height and bounded-canvas constants plus the live scroller height, so compressed million-row grids and ordinary grids measure the same requested logical row. The bounded timeout cancels any scheduled frame; CDP round trips are outside the measured interval. Production view-state writes are trailing-debounced during continuous scrolling, so only the latest presentation state is persisted after the interaction settles instead of adding workspace-storage work to every scroll. While each filter and sort UI operation is demonstrably outstanding, it starts a renderer animation-frame heartbeat and an interactive page request concurrently. The profiling probe retains the exact session, view-request ID, request kind, and scheduler lane for both the accepted active `getSummary` and queued `getDatasetStats` before probing responsiveness or cancelling the queued request. An unresolved request that has not entered the active lane is not accepted as profiling evidence.

The installed-editor numeric gates remain exact: first usable grid stays below 3 seconds for the 100k×50 CSV and 5 seconds for the 1M×20 Parquet; cached scrolling fails at 16 or more samples taking at least 100ms out of 200; renderer heartbeats stay below 100ms; and uncached and foreground pages stay below 500ms. The cutoff uses a 5%-slow reference rate; for independent transitions, the binomial chance of seeing 16 or more is 4.44%. Uncached and heartbeat p95 use nearest rank over all 40 samples. No sample is trimmed, retried, or replaced. The hosted route does not loosen thresholds or reinterpret a failed gate. Queued cancellation must still come from the original request's correlated `cancelled` response. Every sample is retained, and a structurally valid report is atomically published before a failed numeric verdict is returned. The report also records medians, p95, maxima, the selected editor's public product/API-compatibility version, and path-free display, OS, CPU, memory, filesystem, and block-device provenance. Whole-editor-process-tree and runtime RSS are intentionally absent from the installed-editor report: mutable `/proc` sampling describes harness/Electron topology rather than a product or release invariant. Process-tree ownership uncertainty, unsupported cache proof, residual post-eviction pages, terminal runtime/session cleanup, or an over-limit outstanding-operation probe remains a failure. The release report is `openwrangler-installed-performance-report-v10`, the historical evidence-only form is `openwrangler-installed-performance-evidence-report-v5`, and the non-gating smoke envelope is `openwrangler-installed-performance-run-v6`. The direct-runtime benchmark above continues to own its bounded-process RSS evidence, while the Data Wrangler comparison study retains its independent Linux process-tree PSS sampler.

After the selected editor run and verified private-root cleanup complete, a failure consisting only of validated numeric thresholds may expose the report receipt through `evidence_ready`, `evidence_path`, `evidence_sha256`, and `evidence_size`. The runner revalidates the candidate set and the single-link report immediately before publishing those outputs. The workflow then uploads that exact non-glob report path under the distinct `stable-release-installed-performance-numeric-failure` name for seven days. Structural verdicts, incomplete runs, cleanup or process-ownership uncertainty, mixed structural/numeric failures, candidate drift, report drift, unsafe runner paths, and output-publication faults emit no failure-evidence output and therefore upload nothing. A passing report follows the separate 90-day success upload and never uses the failure artifact name.

Every stable candidate uses the canonical stable provenance protocol and runs the normal exact-artifact acceptance. The focused preview-only `--smoke --editors vscode` form remains a harness-debugging aid and never counts as release evidence.

The retired bridge's accepted report is [run 30320866354](https://github.com/Matt17BR/openwrangler/actions/runs/30320866354), artifact `openwrangler-installed-performance` (`8674099196`), from exact source `cfc30e4fdb77711f9007b598bb9ad099dfcf5ca6`. The strict report validator accepted its 92,583-byte `openwrangler-installed-performance-evidence-report-v1` payload with SHA-256 `46d7519df26890c44e5168be7d417da5c52713450cba4f5579e3b7673e3fcdee`, both required editors, every fixed limit, verified cache proofs, responsive outstanding work, authoritative queued-profile cancellation, bounded resource samples, and terminal cleanup. VS Code 1.130.0 recorded CSV/Parquet cold first-grid p95 of 1,086.365/1,466.276 ms and cached/uncached grid p95 of 63.8/131.1 ms; Cursor 3.13.10 recorded 1,907.449/1,715.429 ms and 96.8/148.2 ms. All are below the 3,000/5,000 ms first-grid and 100/500 ms grid limits. This one non-retried historical run closed the two named matrix rows; its candidate bytes are not release inputs.

As the first post-closure ordinary-path preflight, exact all-green source `f78fcc16d1025524a405597cdfb0d5fba4999651` produced a 70-entry, 609,224-byte stable VSIX in [CI run 30321625440](https://github.com/Matt17BR/openwrangler/actions/runs/30321625440), SHA-256 `6262aee7a5787a6b4f89e2b3658e4385375b3fe6fa2c7b4ef20bc11729ec65f5`. The strict ordinary `release:readiness` path accepted those same bytes and published a read-only byte-identical candidate plus checksum. This is a non-publishing preflight, not the final release artifact; subsequent release-workflow changes require a fresh exact-head candidate.
