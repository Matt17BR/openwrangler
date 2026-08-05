# Changelog

All notable changes to Open Wrangler are documented here. The project follows Semantic Versioning while prerelease versions remain unstable.

## [Unreleased]

### Added

- Added **Fill missing values** for Pandas, Polars, and DuckDB. A draft can replace null and NaN cells in one
  column with its median or a value of the matching type, then preview, apply, edit, discard, replay, or undo it like
  any other cleaning step. Median fills return a floating-point column on every engine. Generated Python code
  produces the same result without converting the dataframe to another engine.

### Changed

- Open Wrangler now supports viewing local PySpark 4.2 Classic and Connect batch DataFrames from live notebooks in
  VS Code and Cursor. The Experimental badge has been removed for this scope. PySpark remains notebook-only and
  view-only; streaming DataFrames, files, cleaning, exports, saved output, remote or authenticated clusters, and Spark
  setup are not supported.
- PySpark column profiles now check and collect their ten displayed values in one Spark job. If the values are too
  large, Spark returns only their byte counts. Ordinary profiles no longer run the same grouped query twice.
- PySpark open errors now explain unsupported streaming or Variant data, conflicting or reserved column names, and
  objects missing standard DataFrame operations, with a suggested fix where available.
- PySpark sessions now label unsorted rows as **Source order** and explicitly sorted rows as **Sorted**. The ordering
  badge explains Spark's behavior for unsorted rows and tells users to add a unique final sort key for repeatable
  rows.
- PySpark Classic now gives each Open Wrangler request its own Spark job group and restores the notebook's previous
  job settings. Queued work is dropped when a view closes or changes; work already running is left alone so unrelated
  notebook jobs are not cancelled.
- Recreating a PySpark Classic variable after stopping its old Spark session now reopens the live notebook data
  instead of failing while Open Wrangler reads request properties from the stopped Spark context.
- Spark Connect now tells temporary endpoint failures apart from a server session or DataFrame that no longer exists.
  Both leave the confirmed grid in place. Lost server state also drops runtime page blocks so stale data is not served;
  Open Wrangler does not create a replacement Spark session or DataFrame. After rerunning the notebook cell, users can
  choose **Reconnect** to bind the same variable again; ordinary page retry remains available only for temporary
  endpoint failures.
- Future stable and preview releases now ship from `main`. Releases through v1.2.2 can still be recovered from their
  immutable tags, but the old v1 maintenance branch is no longer part of normal development or publishing.

## [1.2.2] - 2026-08-04

### Added

- Added **Convert Trusted Pickle to Parquet…** to the file menu for local `.pkl` and `.pickle` files. The command
  names the selected Python interpreter, requires confirmation before loading the pickle, accepts Pandas DataFrames,
  and saves the result as a separate Parquet file instead of overwriting the pickle.

### Changed

- Open VSX recovery now verifies public screenshots with the media rules from the exact release tag, rather than a
  different inventory from `main`.
- Registry recovery now checks historical v1 packages against the files shipped by their exact release tag. Packages
  from before the R runtime may omit its frame-contract file; current packages and Open Wrangler 2 releases may not.
- After a pull request is merged, pushes to `main` and `release/1.x` now run just `Fast feedback` instead of repeating
  the full matrix. Ready pull requests still run every required check, and release candidates run the complete matrix
  again against the package that may be published.
- Replaced a 1.5-second timer in the Windows dependency-lock test with a signal from the parent test process. Slow
  process startup can no longer make the validation subprocess miss the lock.
- Benchmark result validation now checks the bytes it actually read instead of checking the path first, closing a
  file-replacement race.

## [1.2.1] - 2026-08-04

### Changed

- Pandas profiles no longer scan ordinary numeric, boolean, date, and duration columns in Python just to count
  missing values. In the 1 million × 20 Parquet test, profiling all 20 columns dropped from about 21 seconds to 6.5
  seconds.
- Open Wrangler was faster than Data Wrangler 1.24.2 in the median notebook-preview, workbench-open, and full-profile
  measurements across Pandas, Polars, CSV, and Parquet. The
  [full report](https://github.com/Matt17BR/openwrangler/blob/main/docs/performance/data-wrangler-1.2.1/review.md)
  includes p95, memory, outcome counts, and exact versions.
- PySpark notebook sessions now show the first page without indexing, counting, and caching the entire DataFrame. The
  total appears after the final page, and a changed page boundary asks the user to reopen the variable.
- Generated columns stay in view when Cursor opens Code Preview and resizes the grid.
- README and gallery screenshots now use lossless 2× captures. Post-release checks catch missing or downscaled images
  on GitHub, the Visual Studio Marketplace, and Open VSX.
- Pull requests now cancel superseded work, use shorter paths for documentation and package-only changes, and avoid
  repeating the same full test suites. Product changes still run packaged VS Code and Cursor, notebook,
  visual/accessibility, performance, and platform checks against one checksummed VSIX.
- Editor failure reports now have fixed memory and time limits, preventing malformed or oversized diagnostics from
  exhausting a developer machine.
- Stable and preview publishing now sends one checksummed VSIX to GitHub, Open VSX, and the Visual Studio Marketplace.
  GitHub release notes come from the tagged commit, and public releases are verified before either registry receives
  them.
- Stable v1 fixes ship from `release/1.x`. Future Open Wrangler 2 previews use the reserved `1.99.x` versions on
  `main` before the project moves to 2.x.
- The Data Wrangler comparison now works with current ipykernel connection arguments, and its Python 3.12 fixture
  includes Polars.

## [1.2.0] - 2026-08-01

### Changed

- Terminal missing-dependency panels no longer inherit stale grid-loading state, so the confirmed dependency-install
  action remains usable after a failed open in Cursor while still excluding an in-progress import change or install.
  Packaged-editor failures now retain bounded button and persisted-replay state instead of an ambiguous timeout.
- Bounded local and CI JavaScript-test memory: portable Node contracts, ordinary/V8-coverage Vitest suites, and V8
  coverage remapping now run with at most four test files or workers, while the PNG-heavy README media verifier runs
  alone under a 1 GiB V8 heap ceiling. Pixel drift and large editor-fixture preservation failures report only the
  first differing coordinate or byte instead of constructing multi-million-byte assertion diffs, preventing a stale
  capture or changed fixture from exhausting the desktop process during packaging.
- Native Filters / Sorts priority actions now use opaque provider-owned handles instead of JavaScript class identity.
  Structurally cloned tree items therefore work in Cursor as well as VS Code, unrelated profiling and selection
  updates no longer churn the native sort tree, and stale, ambiguous, or unavailable actions explain why they were
  not applied instead of failing silently.
- Import-option Quick Picks and input fields now explicitly reclaim workbench keyboard focus after opening. This
  preserves the existing keyboard-only flow in VS Code and fixes Cursor 3.13.21 leaving focus inside the dataframe
  webview; experimental forks that omit the standard focus command retain their native Quick Input behavior.
- Updated the optional Data Wrangler comparison for its real first-use UI. It selects the exact notebook kernel,
  waits for temporary duplicate controls to settle, and stops on persistent ambiguity or connection failures. These
  early results were diagnostic only and were not used for performance claims.
- Local PySpark Classic and Connect variables now invalidate cached blocks when their dataframe is replaced or
  their Spark session stops. Recreating the same variable with the same schema lets the next current read reopen
  it on the exact originating notebook and kernel while preserving confirmed filters, ordered sorts, selection,
  widths, and viewport. A changed schema fails closed with reopen guidance; terminal cleanup faults retire only
  their exact kernel mapping and remain visible as diagnostics.

- Simplified column labels throughout the cleaning-step builder: unique names now appear without redundant
  positions, while duplicate and unnamed columns retain 1-based positions and stable identities so selections
  remain unambiguous and accessible.
- Pinned and auto-detected PySpark notebook launches now verify strict PySpark 4.2.x inside the bridge's exact
  selected kernel generation immediately before runtime open dispatch. Kernel switches and restarts invalidate and
  reprobe before session publication. Picker and opening-stage copy explicitly label the session viewing-only and
  warn that opening scans, indexes, and caches the complete DataFrame. Focused Classic and Connect tests prove real
  owned-cache eviction without stopping the user's session, and packaged-kernel fixtures now trap Pandas/Arrow
  conversions. External or authenticated Connect remains experimental and is not claimed by this evidence.
- Split pull-request quality/contracts, visual/accessibility, production audits, packaged VS Code, native script,
  native extension-host, and Cursor smoke into independently attributable jobs. The existing protected `validate`
  context is now a fail-closed aggregate, so failed, cancelled, absent, or unexpectedly skipped evidence cannot
  satisfy the merge gate.
- Packaged editor acceptance now validates its prepared Python environment before starting VS Code or Cursor, so
  unsupported Python versions and missing Pandas, Polars, DuckDB, or OpenPyXL fail during setup instead of after a
  long workbench launch.
- Notebook-kernel requests now use fresh never-cancel Jupyter tokens. Host deadlines and panel disposal detach and
  stale-ignore instead of sending a kernel-wide interrupt, because PySpark's default SIGINT handler can cancel
  unrelated Spark jobs even when Open Wrangler is opening or paging another dataframe engine. A detached live open
  queues one bounded close on its exact originating kernel; a correlated late response still retires that mapping.
  Kernel and standalone runtimes now produce `unknown_session` from a typed exception carrying the exact session ID
  rather than attempting to infer absence from an error message.
- Added honest, accessible progress while every live notebook variable connects to its kernel, prepares the
  bundled runtime, and opens the variable, including automatic backend detection. Pinned and auto-detected
  PySpark opens use dedicated final-stage copy explaining that their stable view scans, indexes, and caches the
  complete frame to establish row positions and an exact total.
- Rebuilt the README and product gallery around exact packaged-editor scenes: native Activity Bar views, the
  filter/sort and cleaning workflow, file entry points, Pandas inline output, native Polars and DuckDB notebook
  sessions, experimental PySpark, focused operation flows, and accessibility states. Captions now explain the
  demonstrated capability without presenting fixture sizes as dataframe limits.
- Added concise installed-editor performance evidence, user-facing roadmap language, and an exact media-inventory
  gate. Public scenes now declare their truthful provenance: editor-integration views come from the verified VSIX,
  while focused by-example and rich-type views come from the same source commit's production webview bundle.
- Expanded the public product tour with readable Activity Bar views, complete 417-column navigation, exact
  histogram interaction, compound-sort controls, real script and cleaned-data exports, and the live notebook
  variable picker. Every published asset preserves accepted source pixels without scaling or reconstruction.
- Added paired, pixel-exact Activity Bar details to the README and product gallery so first-time users can read the
  operation catalog, dataframe summary, ordered viewing state, and separate cleaning history without enlarging a
  full editor screenshot. The details are derived from the accepted packaged Explore and Workflow captures rather
  than reconstructed UI.
- Reframed the native Polars and DuckDB notebook evidence as full-content-width, pixel-exact details linked to the
  complete packaged-editor scenes, so engine badges, draft code, native filters, and ordered sorts remain legible.
  The rich DuckDB gallery detail now removes unused canvas without altering typed decimal, time-zone, list, or
  struct evidence.
- Replaced the generic uppercase by-example placeholder and gallery fixture with a structured account-code
  extraction, so the first example demonstrates deterministic split synthesis instead of duplicating a basic
  casing operation. The README now places example setup and unseen-row draft review side by side.
- Replaced the verbose workbench shape subtitle with the compact, standard `rows × columns` form while preserving
  its full accessible description and hover text. Column profiles now scroll vertically without exposing a
  misleading empty horizontal scrollbar.
- Raised the minimum supported VS Code version from 1.105 to 1.106, the first stable release whose custom-editor
  implementation renders an extension-supplied tab icon. This keeps the advertised branded Open Wrangler tab
  contract testable instead of silently accepting the generic file icon shown by 1.105.
- Made every numeric histogram bin use an equal-width, full-chart-height pointer and keyboard target while keeping
  its visible bar proportional to the count. Hovering or focusing even a two-pixel bar now highlights it
  immediately and shows the bin range and row count in a theme-aware tooltip.
- Consolidated applied-plan status, **Edit latest**, and **Undo** into one named cleaning-plan group in the primary
  toolbar, removing the permanent second cleaning bar. The group wraps as one responsive command row at narrow
  widths, 200% zoom, and forced colors while preserving visible labels, shortcuts, disabled explanations, and tab
  order.
- Restored keyboard focus to **Add step** only when an activated **Undo** button removes the final applied step,
  the webview still owns focus, and that exact button remains the focus origin; host actions, shortcuts, deliberate
  focus moves, background tabs, and failed or cancelled mutations do not reclaim focus. The advertised Undo
  shortcut follows the same rule when invoked from that exact button, but never when invoked elsewhere.
- Clarified the notebook guidance that a DuckDB relation remains native, while DuckDB's explicit `.df()` result is
  a real Pandas DataFrame and therefore opens with the Pandas backend.
- Updated the public roadmap to batch the remaining interaction polish, reproducible performance comparison,
  bounded VS Code-fork validation, and supported PySpark gates into one coherent v1.2 release instead of
  promising a continuous stream of patch packages.

### Fixed

- Kept the notebook-toolbar action and Cursor's pinned editor-title fallback mutually exclusive, so Cursor 3.13.21
  exposes one canonical **Open in Open Wrangler** action instead of rendering the same command on both surfaces.
- Installed the native dataframe runtime dependencies in the split visual/accessibility CI lane, so production-scene
  generation cannot fail before rendering DuckDB, Polars, Pandas, and notebook evidence or silently substitute
  reconstructed fixture data.
- Kept the native Activity Bar views bound to the exact visible dataframe when clicking a sidebar action moves
  keyboard focus out of the editor. Filter, sort, operation, and cleaning-step actions now reach that visible
  session, while hidden panels and stale sort identities still fail closed.
- Kept an authoritative restored grid row and horizontal offset when a custom-editor snapshot and saved view hydrate
  in the same render, and through a delayed workbench layout scroll collapse, while explicit wheel, pointer, touch,
  and keyboard navigation remain user-authoritative.
- Removed unused `Counter` imports from ordinary Pandas, Polars, and DuckDB generated plans while retaining the
  import for one-hot encoding and multi-label binarization collision checks.
- Preserved compatible viewing filters, selected values, predicates, searches, and ordered multi-sorts through
  cleaning-step preview, apply, latest-step edit, discard, reload, and undo. Structural or semantic-type-changing
  steps prune only rules that no longer resolve safely. An explicit in-draft edit remains authoritative through
  Discard or Apply; otherwise Discard restores the persisted pre-draft view. Latest-step replacement retains the
  original Undo receipt so immediate Undo returns to the pre-first-apply view when no later view edit intervened.
- Branded Open Wrangler workbench and custom-editor tabs with the theme-specific Open Wrangler action icon instead
  of inheriting a generic text or source-file glyph.
- Restored Pandas 3 `DataFrame` and `Series` discovery in the notebook toolbar picker while retaining the Pandas 2
  type aliases and rejecting classes that only spoof a Pandas module and type name.
- Reissued a generated-column reveal with a fresh identity after the renderer synchronization barrier, so a
  first attempt left dormant during Code Preview layout changes no longer strands the grid on the previous
  columns.

## [1.1.9] - 2026-07-31

### Fixed

- Preserved integer and decimal minimum/maximum values without IEEE-754 rounding in Pandas, eager and lazy
  Polars, DuckDB, experimental PySpark, and saved notebook previews. Column headers and **Column profiles** now
  prefer the lossless typed values while retaining the existing numeric statistics and histograms.
- Rejected partial, malformed, type-incompatible, non-finite, or reversed exact extrema at the protocol boundary.
  Existing protocol-v2 summaries without the additive fields remain valid.
- Kept Pandas Decimal profiling native through mean, median, and standard-deviation aggregation, converting only
  final approximate scalars. Decimal infinities now omit the lossless extrema pair in Pandas and saved snapshots
  without invalidating the remaining finite statistics or histogram.
- Bounded the visible exact extrema in **Column profiles** while preserving the full protocol-bounded value in
  accessible names and hover titles.
- Bounded viewing predicate and selected-value text to 65,536 Unicode code points before arbitrary-precision decimal
  coercion in the webview, TypeScript and Python protocol decoders, canonical schema, and saved notebook previews.

## [1.1.8] - 2026-07-31

### Fixed

- Recovered the confirmed dataframe session when a current renderer-owned **Header profiles** request is the
  first read after a standalone runtime exit. Summary and dataset-statistics reads now share one replacement
  runtime with a concurrent foreground recovery, while a cancelled or superseded profiling request is never
  reissued and mutations retain their no-retry guarantee.
- Preserved the last confirmed vertical grid position when macOS emits a synthetic scroll event during
  programmatic restoration or editor teardown. A real wheel, pointer, or touch scroll still replaces the saved
  viewport normally.
- Fetched the restored row block when an older editor initially hydrates the grid with a different page, so a
  persisted viewport can no longer remain stranded on stale rows.
- Adopted a confirmed file session before awaiting its configuration write, so invoking **Change Import Options**
  immediately after the grid opens can no longer cancel and reopen that same file under a second session.

### Changed

- Extended zero-window native acceptance to physical Explorer context-menu launch plus fresh-process rendered
  persistence and recovery. The release gate now verifies one exact **Open in Open Wrangler** action, prompt-free
  inferred CSV import, unchanged source bytes, committed cleaning state, sort priority, column presentation,
  nonzero viewport restoration, visible-row status, and renderer-triggered profile recovery.

## [1.1.7] - 2026-07-31

### Changed

- Moved row-block navigation below the scrolling table into a slim, non-sticky status bar with transparent
  Previous/Next Codicon buttons and one exact, always-visible row-range announcement. Narrow, 200%-zoom, high
  contrast, and forced-colors layouts keep the status and native disabled states legible; very large terminal
  ranges move below the actions in a calm second row instead of overflowing the grid.
- Renamed the selected-column drawer to **Column profiles** while preserving its filter tabs, focus, Escape, and
  stable internal relationships. The separate grid-header control is now the constant pressed **Header profiles**
  toggle; `openWrangler.insightsOnOpen` keeps its existing key and behavior.

### Fixed

- Kept appended draft-column navigation pending across longer Cursor Code Preview layout transitions, so the grid
  reveals the generated column instead of retaining the previous horizontal position.

## [1.1.6] - 2026-07-31

### Changed

- Replaced the tall inline draft pane with a compact **Draft review** strip that keeps the operation, exact
  diff, warnings, and one **Discard** / **Apply step** action pair visible while preserving the grid at narrow
  widths and 200% zoom.
- Removed duplicate generated-code blocks from draft review and applied-step inspection. Native **Code Preview**
  remains the authoritative editable surface for generated cleaning code.

## [1.1.5] - 2026-07-31

### Changed

- Made native DuckDB notebook restart/recovery part of the real packaged-Jupyter release gate. After the
  notebook recreates a filtered, ordered multi-sort relation in the replacement kernel, Open Wrangler rebinds
  it to the same public session, schema, and viewing state over a new private runtime; conversion traps remain
  armed, terminal cleanup leaves no runtime session behind, and the user's replacement relation and connection
  remain usable.

### Fixed

- Restored host-owned column widths and selection before applying a saved grid viewport. A browser that emits a
  synchronous scroll event during restoration can no longer combine the new viewport with stale presentation
  state and overwrite the confirmed layout.
- Recovered an active VS Code or Cursor dataframe tab when its webview never completes the initial ready
  handshake. The extension keeps the confirmed runtime session, reloads only the renderer once after a bounded
  grace period, and republishes the authoritative snapshot instead of leaving a blank grid.
- Replayed notebook sessions with the runtime-confirmed effective mode. A DuckDB relation opened while the
  notebook default requests Editing is correctly normalized to Viewing once, then recovers in Viewing after a
  kernel restart instead of rejecting its valid replacement session.
- Made same-source reload acceptance wait for VS Code to retire the prior session tab before opening the custom
  editor. Runtime cleanup can no longer race the public editor-input lifecycle on slower macOS hosts.

## [1.1.4] - 2026-07-30

### Added

- Added native DuckDB notebook previews and viewing-only live sessions. Open Wrangler retains the exact
  originating `DuckDBPyRelation` for paging, filtering, sorting, and profiling, releases only its own reference
  on close, and never converts through Pandas, Polars, or Arrow. Notebook relation cleaning, code insertion, and
  data export remain disabled.
- Added path-independent Microsoft Marketplace recovery on protected `main`. Exact single-parent changes to the
  reviewed Marketplace pipeline, verifier, archive, metadata, and locked-package closure retry the current
  package version only when its immutable numeric release tag already exists; ordinary changes, merge commits,
  and an absent tag finish as intake-only no-ops before authentication. Existing `v*` tag promotion and explicit
  manual backfill remain unchanged.

### Changed

- Restored the inline notebook **Open in Open Wrangler** action to the complete current live dataframe. The action
  stays bound to the exact visible originating notebook and kernel, reruns backend detection, and never opens or
  falls back to the bounded saved preview. Outputs without a canonical live-variable link remain readable inline
  and ask the user to run the cell again instead of showing a misleading open button.

### Fixed

- Made missing live variables and unavailable kernels explain the direct recovery: select or start the Python
  kernel, run the cell that defines the dataframe, and try **Open in Open Wrangler** again.
- Kept Microsoft Marketplace promotion resumable when GitHub's anonymous release-metadata API returns HTTP 403 on a shared Azure runner by treating that response as pending within the existing bounded poll. There is no alternate asset path: a successful metadata response must still pass every release-channel, inventory, URL, and size check before any asset download, and repeated 403 responses fail when the poll is exhausted.
- Made the column picker search and navigate the complete schema instead of stopping after the first 100
  matches. The list virtualizes wide schemas, keeps every result keyboard-reachable, and exposes its exact
  position and result count to assistive technology without rendering thousands of options at once.
- Preserved the exact grid row and horizontal position while native menus or Quick Input temporarily own
  workbench focus. Incidental layout scrolls on macOS can no longer overwrite the confirmed viewport.
- Registered a new workbench panel's activation listener before dispatching its session open. Fast Windows
  activation can no longer leave a successfully opened dataframe disconnected from the active-session UI.
- Made installed Cursor performance validation wait for the current webview to become synchronizable and adopt
  its automatic authoritative snapshot before using the one allowed fallback. A slow renderer can no longer
  consume that fallback before it is ready or have a newer generation invalidated by late test cleanup.

## [1.1.3] - 2026-07-30

### Added

- Added exact text-column Insights for empty strings and minimum, maximum, and mean character length across Pandas, Polars, DuckDB, PySpark, and saved notebook snapshots. Nulls stay separate, empty strings are measured without trimming, and Unicode length counts code points consistently across engines.

### Changed

- Kept text profiling engine-native. Lazy Polars, DuckDB, and PySpark return only fixed-size aggregate results; Pandas mixed-object and non-string categorical columns deliberately measure the same normalized display text shown in the grid.
- Preserved nonzero Pandas NaN counts in semantic text Insights while omitting the irrelevant zero-valued row, and rejected internally contradictory empty/length summaries at the protocol boundary.
- Removed the ambiguous secondary **Open saved snapshot** button from inline notebook outputs. The single
  inline **Open in Open Wrangler** action now always opens the captured result; the notebook toolbar remains
  the explicit route to a current live variable.

### Fixed

- Replaced the ultrawide Pandas notebook README capture with a standard-width packaged-editor view that keeps the
  real notebook toolbar, dataframe preview, horizontal scrolling, and labels legible at documentation width.
- Gave editor and notebook toolbar actions explicit light- and dark-theme SVG variants. The branded Activity Bar
  glyph remains `currentColor`, while externally loaded command icons can no longer resolve to black on dark
  editor surfaces.
- Reworded notebook portability around the user workflow: files and live variables page directly in the
  workbench, while only outputs saved into a notebook retain a bounded, truncation-labeled preview.
- Retried a requested virtual-column reveal for a bounded number of animation frames while the browser finishes laying out an expanded draft schema, including when renderer synchronization refreshes that schema mid-retry. Each reveal request now enters layout only once, preventing a far-right generated column from triggering React’s nested-update guard and blanking the editor. Newly generated columns remain discoverable in Windows Cursor instead of leaving the grid clamped to its previous horizontal extent.
- Kept a confirmed draft visible when an older page or renderer snapshot finishes late, and drained a renderer synchronization requested at the end of an existing synchronization instead of abandoning its authoritative replay.
- Committed each authoritative renderer replay before acknowledging it, retired webviews whose synchronization marker could not be delivered, and delayed automatic Code Preview reveal until the exact draft was physically rendered. The default **on first draft** behavior now reveals Code Preview only once per session; later drafts update the existing provider in place and respect a user closing the panel instead of repeatedly focusing it. Automatic reveal uses the native preserve-focus option, so Code Preview opens without taking keyboard focus, remounting the dataframe webview, or starting a redundant synchronization cycle. Recovery polling can no longer race a draft publication or leave packaged editor assertions attached to a hidden prior renderer.
- Made column-header sorts accumulate instead of erasing earlier keys: the newest choice becomes priority 1 while every other key remains as a lower-priority tie-breaker. Filters / Sorts now exposes concise move-up/down, direction, null-placement, remove, clear, apply, and discard controls for the complete ordered sort; the native Activity Bar mirrors priorities and offers immediate validated reorder/removal actions.
- Rejected stale native sort actions when a newer quick sort is still pending, reset uncommitted sort edits through **Clear column** and **Clear all**, and reject duplicate sort columns at every persisted/protocol boundary. Only priority 1 now owns the grid's `aria-sort`; lower-priority keys remain explicitly labeled. During applied-step inspection, Activity Bar filter/sort controls pause behind a clear return-to-current-view action.
- Gave column names their own full-width header row and moved compact type, sort, and menu controls onto the metadata row. The resize target now sits on the column edge instead of consuming title width, so realistic names remain readable at narrow widths and high zoom without losing keyboard access or visible sort priority.

## [1.1.2] - 2026-07-30

### Added

- Added a visible **Export** action to the dataframe workbench. The webview sends only a narrow no-argument intent; the extension host continues to own the destination picker, source protections, and atomic CSV or Parquet write.

### Changed

- Replaced the toy packaged platform smoke with a realistic 10,000-row × 15-column UTF-8-BOM, semicolon-delimited first-use journey. It now covers automatic import, typed column search, exact Insights, sorting, filtering and clear, preview/discard/apply, workbench export, reopen/replay/undo, and source-byte immutability in isolated VS Code and Cursor profiles.
- Reflowed toolbar and grid controls at narrower effective widths and added a packaged high-contrast, approximately 200%-zoom containment check so controls cannot silently clip.
- Refreshed the editor and README workbench captures from the exact packaged candidate over a 100,000-row × 15-column synthetic source. Zoomed evidence now records the complete physical workbench instead of cropping to the browser's zoomed CSS-pixel viewport.

### Fixed

- Kept **Change Import Options** keyboard-ready in Cursor when launched from the editor title, tab menu, or Command Palette by letting the native activation settle before opening the first picker.
- Replaced internal operation-kind labels such as `upperText` with the operation's human title in draft and preview UI.
- Automatically reveals the first column added by a draft preview, waits for its projected block to arrive, and reapplies the reveal after host view restoration instead of leaving the result off-screen in a wide dataframe.
- Consumes column-search navigation after it is handled, so a later in-place preview or restored view cannot unexpectedly jump back to an old horizontal target.
- Pins cleaned-data export to the exact originating dataframe and revision across the format and Save dialogs; switching tabs can no longer redirect an export to another open session.
- Made draft diffs distinguish changes to existing cells from values introduced by added columns, avoiding a misleading `0 changed cells` message for add-column operations.
- Removed the empty cleaning-plan bar after the only draft is discarded or the only applied step is undone, without racing the renderer update.

## [1.1.1] - 2026-07-30

### Added

- Added proactive Pandas and Polars notebook previews for trusted, visible notebooks with user-started kernels. When Microsoft Data Wrangler is installed, Open Wrangler asks which extension should own automatic dataframe rendering and exposes a command to change that choice for new or restarted kernels.
- Added bounded, typed notebook-variable discovery for Pandas, Polars, PySpark, and recognized DuckDB relations. Supported values open from a branded notebook action without typing a variable name; DuckDB relations remain visibly unavailable instead of being converted through another engine.
- Added 10, 20, 50, and 100-row paging across every captured column in the inline MIME-v2 renderer. A uniquely linked live variable now opens as the primary action, while the complete portable capture remains available through **Open saved snapshot**.
- Added exact finite-value histograms for Pandas, Polars, DuckDB, and PySpark. Native/lazy engines return only aggregate bin counts, and every bin exposes its interval and count by pointer hover, keyboard focus, and accessible name.
- Added `.ndjson` as an exact JSONL alias across file entry points and all supported file engines.

### Changed

- Limited automatic formatter preparation to exact visible notebook documents and made stable Jupyter lookup observation-only. Background API-opened notebooks cause no kernel lookup, while a visible notebook change bypasses pending retry backoff as soon as a user-started kernel becomes available.
- Expanded the responsive Insights drawer to use the available workbench width without clipping selected-column statistics or distributions.
- Labeled PySpark sessions explicitly as **Experimental** and **Viewing only** in the workbench instead of relying on documentation or engine context.
- Kept Python pickle files deliberately outside the file surface because deserialization can execute arbitrary code; unsupported `.pkl` and `.pickle` paths are rejected before any runtime reader is invoked.
- Updated the notebook, engine, safety, performance, and post-1.1 roadmap documentation to distinguish live paged sources from bounded saved snapshots and native file support from planned notebook support.

### Fixed

- Unified the notebook command's primary and compact labels as **Open in Open Wrangler**, so Cursor's pinned editor-title action and VS Code's global notebook toolbar expose the same accessible name. Released-Jupyter acceptance now resolves command ownership before validating that label and reports editor-title evidence separately.
- Corrected the packaged Jupyter acceptance double to match the stable API contract: `getKernel()` returns only a kernel already started by the user and never synthesizes one during discovery. Split-notebook acceptance now proves an action from notebook A cannot advance notebook B beyond B's independent proactive-preview baseline.
- Removed sampled-distribution labels from live numeric summaries and retained exact tails, inclusive maxima, deterministic constant/empty behavior, and complete population counts.

## [1.1.0] - 2026-07-29

### Added

- Added an experimental, viewing-only PySpark 4.2 live-notebook path for Classic and local Spark Connect DataFrames. Grid projection, filtering, sorting, counts, profiles, and bounded value/page collection stay native to Spark; the adapter never converts through a local dataframe engine, never performs an unbounded collection, and releases only its owned logical-plan references without stopping the user Spark session. Real packaged VS Code acceptance now covers Jupyter Variables launch, filtering, sorting, paging, profiling, deterministic Classic kernel restart and replay, local Connect, cleanup, and Restricted Mode denial. Editing, exports, saved-output formatting, external or authenticated Spark Connect servers, cancellation, and generated-code insertion remain outside this preview.

### Changed

- Rebuilt the README media around three product views: a realistic file-backed dataframe, an automatic Pandas
  notebook preview, and a live Polars draft with summaries, a diff, and generated code. The copy distinguishes saved
  previews from live variables, describes DuckDB's file support, and makes clear that benchmark fixture sizes are not
  hard row limits.
- Raised the gallery and README logo raster to 512 × 512 from its committed vector source while retaining the 128px fallback and monochrome Activity Bar icon. Static PNG delivery now stays sharp and predictable across GitHub, the Visual Studio Marketplace, and Open VSX.
- Shortened the isolated packaged-editor capture viewport and added deterministic real-Jupyter media checks for 100,000-row by 15-column Pandas and Polars dataframes. Captures reject transient hovers and notifications while keeping the required notebook context, type-aware statistics, and native code visible.
- Composed the packaged workbench and notebook evidence into fixed-size sRGB images for GitHub, the Visual Studio Marketplace, and Open VSX. The workbench requires exact revenue minimum, maximum, mean, and median values, while README copy distinguishes bounded saved snapshots from live paged sources and benchmark evidence from dataframe limits.
- Enlarged the existing vehicle mark inside its gallery and Activity Bar canvases, reducing transparent margins while preserving the same shapes, colors, and open-top dataframe motif. Brand generation now rejects regressions that make either icon render undersized.
- Added a real packaged VS Code and released-Jupyter PySpark Classic gallery capture over a deterministic 100,000-row by 15-column DataFrame. The media and README label PySpark experimental and viewing-only, without implying file, cleaning, export, code-insertion, or saved-output support.
- Added a separate native DuckDB file gallery generated from a real rich Parquet source with decimal, time-zone, list, and struct columns, while keeping notebook relations explicitly unsupported.
- Replaced the all-column Insights drawer with focused Column, Dataset, and Filters views. Column shows one stable selected identity with exact numeric min, max, mean, median, and standard deviation plus explicit datetime, boolean, categorical, null, NaN, and top-value details. Dataset statistics and filter values now run only while their matching view is active, so opening Insights no longer starts a whole-schema profiling queue.
- Updated the release guide to reflect the activated personal `Matt17BR` Marketplace workload identity, the automatic pipeline's proven `v1.0.3` handoff, and the still-pending non-blocking Open VSX namespace claim.
- Added a bounded, source-only pull-request `Fast feedback` lane that runs deterministic static checks alongside canonical packaging and labels each failure class separately. The existing full `validate` gate remains unchanged and authoritative, so this scheduling improvement does not lower, remove, or bypass any merge or release requirement.
- Made DuckDB rich Parquet pages deterministic across host time zones by pinning every owned and terminal connection to UTC. Dependency selection now requires the bounded-green `duckdb>=1.5.4,<1.6` range together with `pytz`; malformed JSONL remains an input diagnostic instead of being mislabeled as unavailable JSON support. Installed-editor acceptance now covers native DECIMAL, TIMESTAMPTZ, LIST, and STRUCT values plus source replacement and terminal cleanup. DuckDB remains a preview rather than a parity or first-class-engine claim.
- Kept PySpark insights explicit even when insights-on-open is enabled, rejected unsupported nested Spark profile types before indexing, and changed base-frame paging to a bounded dense-row-identity range. Opening still indexes and counts the complete frame, while filtered or sorted pages retain their correct Spark ordering path.
- Made PySpark map, nested-map, array, and struct statistics use native canonical orderable keys, so logical map equality no longer depends on insertion order or an unsupported raw-map sort. Variable-width pages now receive a Spark-side UTF-8 preflight before value collection plus independent cell-count, serialized-byte, complex-node, and nesting-depth limits. Oversized values fail without crossing into the notebook process or stopping the user's Spark session.
- Applied the same Spark-side and strict protocol bounds to summary and distinct-value results, removed private grouping keys from terminal collections, made equal complex-value displays deterministic, normalized nested signed zero for native grouping, and preserved nested Decimal values without float conversion. Nested struct field collisions now fail before indexing instead of losing one value during JSON decoding. Required PR and release coverage now installs and verifies PySpark 4.2.0, compatible Pandas, and Java 17 before enforcing the unchanged 78% Python floor.

### Fixed

- Made the released-Jupyter Variables acceptance action resolve its exact semantic row at one trusted keyboard activation instead of retaining a replaceable DOM handle or depending on cross-webview pointer hit testing. If Playwright loses only the activation acknowledgement, the test may accept the resulting zero-to-one Open Wrangler session as an authoritative receipt, but it never activates or reacquires after dispatch begins.
- Removed the unintended horizontal bar from the gallery windshield and its Activity Bar counterpart, keeping every generated icon surface aligned to the same refined open-top vehicle mark.
- Added post-publication checks that require Open VSX and the Visual Studio Marketplace to expose the canonical packaged gallery icon, including a valid Marketplace 72 pixel thumbnail that visually matches it.
- Updated the native editor harness for VS Code 1.131's removal of the legacy macOS `Electron` compatibility path. Packaged and extension-host acceptance now resolve the bundle's declared executable instead of relying on that removed alias.
- Made pinned private-Xvfb preparation resilient to transient Canonical download outages by rotating through ordered, manifest-pinned archive, security, and timestamped snapshot origins for two bounded rounds. The one authoritative size/SHA-256 and all no-redirect, exclusive-file, ownership, extraction, and no-editor-fallback checks remain unchanged.
- Replaced retained DuckDB relations with immutable, connection-free SQL and schema plans. Open, paging, transforms, custom code, and exports now release each request-local `DuckDBPyRelation` before closing its owner, so DuckDB 1.5 cannot retain a Windows Parquet handle through the relation's connection reference. The runtime stays native and never calls `DuckDBPyRelation.close()` or converts through another engine.

## [1.0.3] - 2026-07-28

### Fixed

- Recognized Git credential-store's exact atomic approval and rejection rewrites after a stable-tag push, then scrubbed and removed the replacement without weakening the private-directory, identity, content, link-count, or mode checks.
- Waited for Cursor's exact released-Jupyter Polars panel to hydrate and acknowledge its retained snapshot before acceptance sends a live preview, removing an editor-speed race without weakening live-panel coverage.

## [1.0.2] - 2026-07-28

### Added

- Added a protected, idempotent Open VSX promotion workflow for stable, preview, and historical GitHub Releases. It promotes the exact public GitHub assets without rebuilding and verifies the public publisher, checksum, channel metadata, and downloadable VSIX bytes.
- Added the source-controlled Microsoft Marketplace promotion path for every GitHub Release. It uses the personal `Matt17BR` workload identity, promotes the exact GitHub VSIX as stable or pre-release metadata, and verifies the public upload and package contents.
- Introduced an original tiled open-top off-road mark for the extension gallery and Activity Bar. Its rectangular body cells connect the Open Wrangler name to dataframe work without reusing another project's branding.
- Added an accessible column-search combobox with distinct datatype icons, name and type matching, duplicate-label disambiguation, and stable-identity navigation to the exact selected column.
- Replaced the README capture fixture with a deterministic, license-clean 10,000-row × 15-column regional-order dataset spanning identifiers, dates, categories, numeric ranges, booleans, nulls, and long text. The packaged-editor harness pins a 1920 × 1080 workbench viewport and rejects clipped featured columns, controls, draft actions, code, or numeric summary statistics before accepting media.

### Changed

- Extended the bounded Open VSX post-publication check from five to fifteen minutes, with matching final-job timeout room, after real registry propagation proved that accepted releases can remain temporarily unavailable.
- Made Microsoft Marketplace activation self-diagnosing and safe on first setup: the default manual `main` run with no release tag now completes as an explicit no-op, while a real promotion prints only the federated identity's validated Azure DevOps profile UUID immediately before VSCE verifies publisher access. The bounded probe never logs its token or profile response, and every other non-tag or unsafe intake still fails closed.
- Closed the stable-release trigger gap by atomically pushing exactly one lightweight `v<package version>` ref at the accepted `main` commit immediately before GitHub Release creation. The push uses a private, scrubbed credential file rather than an argument or logged URL, rejects annotated/conflicting/ambiguous refs, verifies the public ref afterward, and is idempotent only for the same lightweight tag. This real Git event starts the separate Azure Marketplace promotion, whose public verification now uses its maximum reviewed forty-attempt window.
- Configured the production `openwrangler-marketplace-publishing` Azure Pipelines environment with an Exclusive Lock while retaining the checked-in `lockBehavior: sequential`; there is no approval gate, so an accepted GitHub release can promote without another manual step.
- Rewrote the README around installation, first use, core capabilities, supported engines and formats, editor compatibility, roadmap, measured performance evidence, and three explained theme-aware product scenes. Removed internal release-process commentary, repeated screenshots, and redundant compatibility prose.
- Tightened the Operations and Filters / Sorts native views so categories retain useful descriptions, selection and current-view labels stay concise, and draft code consistently reads **Generated Polars code**.

### Fixed

- Prevented VSCE's issue-reference autolinker from rewriting the packaged README, and moved exact README byte parity into ordinary VSIX verification so canonical release staging is no longer the first place that drift is detected.

## [1.0.1] - 2026-07-28

### Changed

- Replaced manual Excel sheet-name/index entry with a searchable picker populated from the open workbook through its confirmed Pandas or Polars runtime. The initial open still selects the first sheet automatically; explicit **Change Import Options** remains read-only, cancellable, trust-gated, and safe for numeric-looking sheet names.
- Made ordinary file opens absorb one transient Python-environment selection event before any runtime request is dispatched; repeated selection churn still fails, and dispatched or mutating requests are never retried. When no Excel backend is ready, the error now names only the preferred backend and its exact requirements instead of merging Polars and Pandas alternatives. The initial error offers **Install required dependency**, retains the existing Workspace Trust and exact modal-confirmation gates, and reopens the file only after a confirmed successful install.
- Made primary CSV and TSV launches immediate: the local or remote extension host uses one bounded 64 KiB sample to detect comma, tab, semicolon, or pipe delimiters, UTF-8/BOM versus Windows-1252, standard versus structural single quotes, and likely headers, then fails soft to safe suffix defaults if the host cannot read the sample. **Change Import Options** remains available for explicit correction.
- Made column-header sorting an unambiguous one-click primary sort: choosing ascending or descending closes the menu and replaces prior quick sorts, while a visible accessible indicator clears the active rule. Deliberate multi-column sorting now stays in Filters / Sorts as an ordered, individually removable draft with direction toggles, clear-all, and explicit apply/discard actions; viewing filters and cleaning steps remain unchanged.
- Kept column summaries stable while progressive profiling results arrive and promoted the selected column to an expanded, visually marked first position, so exact numeric min/max/mean/median statistics remain visible instead of unexpectedly collapsing.
- Made cleaning-operation forms easier to author: multi-column choices use explicit accessible checklists instead of Ctrl/Cmd multi-selects; sort and aggregation rows can be moved or removed individually; and text, numeric, datetime, group-key, by-example, and aggregation selectors hide schema types that the chosen operation cannot safely consume.
- Collapsed the draft's inline generated-code fallback by default when the dedicated Code Preview panel already presents the editable code, reducing duplication while keeping the inline copy one click away.
- Made README screenshots reproducible product evidence: the isolated packaged-editor harness now opens a fresh 12-row, six-column synthetic file with no retained view or plan, captures a clean dark/light grid with the empty Code Preview panel closed, then creates a real numeric-round draft and captures its diff plus generated code in both themes.
- Tightened the README around the actual install, exploration, transformation, engine, and compatibility story; removed the blanket parity-complete claim so newly discovered real-world regressions are described and treated honestly.

### Fixed

- Restored keyboard focus to a visible control when closing Filters / Sorts after entering through a column menu; a closed menu item or the document body can no longer be mistaken for a valid return target. Required multi-column checklists now use explicit group guidance instead of an invalid `aria-required` fieldset attribute.
- Opened zero-byte, BOM-only, and whitespace-only CSV/TSV sources as explicit 0-row × 0-column datasets in Pandas, Polars, and DuckDB instead of surfacing raw parser failures. Non-empty malformed input still fails in its native reader, and opening never changes source bytes.
- Kept the installed dataframe surface on the declared VS Code foreground and editor-background tokens instead of inheriting a subtly different workbench color from the host webview.
- Treated Polars CSV, TSV, Parquet, and JSONL source paths as exact local filenames, so brackets, asterisks, question marks, and braces can no longer be expanded as glob patterns or silently select a different file.
- Kept every row reachable in multi-million-row grids by mapping the complete logical range onto a bounded Chromium-safe scroll canvas and rebasing the rendered row segment around the current viewport. Restored positions, keyboard navigation, and Previous/Next block actions now retain their exact logical target instead of being pulled back by browser scroll-height clamping.
- Made viewing filters disappear structurally when their final value or predicate is removed, so stale searches and empty selections cannot remain as hidden no-op filters or enable an empty **Filter rows** cleaning step. The Filters / Sorts drawer now keeps every active column filter visible with type-safe summaries and independent value/predicate removal, while the native Filters tree can clear a whole column filter; all removal paths preserve sibling conditions and viewing sorts.

## [1.0.0] - 2026-07-28

### Added

- Added exact numeric minimum and maximum values to column-header Insights and the Summary drawer, plus compact numeric, categorical, boolean, and datetime visuals whose meaning remains visible and accessible without relying on color.
- Added a stable-only release-readiness guard before canonical checksum creation or artifact upload. It first proves packaging left the exact tagged tracked source unchanged, then pins one owned regular staging-candidate identity, rejects symlinks and hard links, reads it once under before/after identity checks, and performs archive/content inspection plus SHA-256 derivation from that immutable snapshot. Only a fully ready candidate becomes an exclusive read-only `openwrangler.vsix` and matching checksum; the staging path is never uploaded. The content gate accepts exactly one active top-level primary Pandas/Polars table whose ordered rows are all Done with substantive completed evidence, pins `Matt17BR.openwrangler`, rejects duplicate-key JSON, requires complete source/package manifest equality with no empirically observed `vsce` transformation, verifies tag/Python-runtime/VSIX identity and channel agreement, requires a real unfenced dated changelog entry, and replaces README phrase matching with one exact positive stable release/install section in both source and packaged bytes. Fenced, commented, duplicated, reordered, invented, placeholder, renamed, or ambiguous candidates fail closed. The shared classifier binds `0.<odd-minor>.x` exclusively to the preview channel and prevents `1.0.0` from masquerading as a preview.
- Added the ordinary stable-release workflow. A manual validation-only run packages once from the exact protected `main` commit, uploads one canonical VSIX/checksum/provenance triple, and passes only its immutable artifact ID to native macOS/Windows, full Linux VS Code/Cursor, ordinary installed-performance, released/remote Jupyter, and Remote SSH consumers. Every consumer jointly revalidates source, package, tag, identity, version, digest, and size; an `always()` fan-in requires every result to be `success`. Optional GitHub publication remains default-off, reviewer-protected, write-scoped to one final job, and uses the accepted bytes without rebuilding. Preview tags now have an explicit odd-minor `v0` trigger, so a stable tag cannot start the preview-only workflow.
- Added a Linux-only real remote-Jupyter packaged phase backed by a digest-pinned, hash-locked, unprivileged Docker fixture. It uses the released Jupyter server collection and kernel picker, transfers the bundled runtime without a host mount, exercises Pandas/Polars/MIME/insertion/restart/replay, and fails closed when container, image, Docker-engine, command-completion, or cleanup ownership is uncertain. The weekly/manual workflow also runs for pull requests that change this harness; it is not a general required check or release evidence until the first green exact-artifact run.
- Added **Change Import Options** to configurable file grids, initial-load errors, the editor toolbar and tab menu, and the Command Palette. A successful change keeps the public session, cleaning plan, draft, and view; cancellation or failure leaves the confirmed session untouched.
- Added **Open in Open Wrangler** to supported-file editor toolbars and editor-tab context menus alongside the existing Explorer and Command Palette entry points, with actual workbench click acceptance in isolated VS Code and Cursor profiles. A declarative Cursor configuration default pins the canonical action because Cursor hides third-party title actions by default; explicit user settings still take precedence.
- Added selectable Cleaning Steps history: each applied step opens a paged input→output inspection with identity-aware cell/column highlighting and generated code through that step, while Original Data restores the exact confirmed view.
- Added a native, lazy DuckDB file backend for UTF-8 CSV/TSV, Parquet, and JSONL viewing, profiling, all 27 deterministic operations, executable code generation, draft/history workflows, and atomic CSV/Parquet export without conversion through Pandas, Polars, or Arrow.
- Added opt-in Pandas and DuckDB runtime benchmark modes with deterministic synthetic fixtures, native/lazy frame evidence, machine and package provenance, process-memory samples, and an explicit boundary separating runtime timings from editor first paint. Polars remains the strict release-performance gate.
- Added pull-request CodeQL analysis for JavaScript/TypeScript and Python, cross-platform pull-request runtime coverage, canonical single-artifact release validation, and repository rules protecting `main` and `v*` release tags.
- Added focused native-Windows dependency-guard coverage on Python 3.10, 3.12, and 3.14 while retaining the complete Windows 3.14 runtime suite and native installed-editor acceptance against the checksum-pinned canonical PR VSIX.
- Added an opt-in zero-window packaged-editor phase against the pinned released Python extension. It switches two instrumented environments A → B → A through the stable API and requires exact runtime rotation, Polars plan/data replay, immutable source bytes, and terminal cleanup.
- Added an opt-in packaged acceptance pair against `ms-toolsai.jupyter@2025.9.1`, with isolated consent-deny/allow profiles, real Variables and notebook entry points, Pandas/Polars DataFrame and Series coverage, host-visible MIME v2 emission and packaged renderer expansion, exact-origin insertion, restart/replay, and terminal cleanup. A weekly/manual VS Code workflow runs the same isolated, unfocused packaged path without becoming required pull-request CI; the complete local paths are recorded green in VS Code 1.130.0 and Cursor 3.13.10.
- Added an opt-in installed-editor performance harness whose preview path proves a clean exact HEAD, performs its own clean production/test build, derives prerelease packaging through the shared release-channel policy, and pins that channel, source commit, and exact VSIX checksum through every measurement. Its manifests, Python-helper output, generic editor results, and phase fragments use the same bounded duplicate-key-rejecting JSON parser. The mutable preview package output is sealed before complete archive verification; each editor installation revalidates that exact receipt at spawn and after exit; each phase fragment is byte-count/SHA-256-bound to the editor-host result; and the public candidate plus final report remain identity- and digest-bound through successful completion. Apart from its private Python path, it asserts and retains the shipped `auto`/Editing/insights/block-size defaults, native Polars selection, and visible insights control. Its zero-window VS Code and private-display Cursor phases retain ten first-grid timings with aligned synchronized Linux `mincore` page-residency proofs, cached/uncached scroll and renderer-heartbeat samples; drive production filter/sort controls; and launch bounded renderer-heartbeat plus foreground-page probes while filter, sort, and accepted profiling work remain outstanding. The phase also proves authoritative queued-profile cancellation, records path-free platform/storage/display provenance and bounded editor-tree/runtime RSS peaks, and requires terminal runtime/session cleanup. A surviving sampled process group is ownership uncertainty and prevents private-root access or removal. The page-cache-evicted case uses one non-retried `POSIX_FADV_DONTNEED` advisory and does not claim physical cold storage. Smoke fixtures remain explicitly non-gating.
- Added a hosted installed-performance evidence bridge that breaks the final two-row measurement dependency without weakening stable release readiness. Its evidence-only authoring mode requires exactly **Virtual grid, column sizing, navigation** and **Installed-editor first-usable-grid performance** to remain `Partial`, retains every other stable check, and requires a generated README that explicitly identifies a non-installable validation candidate instead of claiming stable parity. Stable and evidence narratives reject each other. A manual run accepts only a dedicated `release/1.0-evidence-*` branch, pins its event SHA, and proves it is a clean descendant of `main`; ordinary CI and released-Jupyter now derive VSCE's prerelease flag from validated package metadata so both preview and stable-intent branches package coherently. The bridge emits distinct non-promotable artifact and report protocols with an evidence gate that the ordinary stable gate rejects. The `ubuntu-24.04` benchmark acquires official VS Code 1.130.0 and Cursor 3.13.10 Linux x64 by pinned byte size and SHA-256 into one per-run private root, runs Cursor under an isolated `dbus-run-session`, and keeps the existing performance thresholds, zero-window/private-display isolation, and no-local-desktop-fallback rules unchanged. Downloaded editor packages are temporary test inputs and are never bundled, cached as release artifacts, uploaded, published, or redistributed. After a green report, both rows must be marked `Done` and a fresh ordinary all-rows-green stable candidate must be created; the evidence-only bytes can never be renamed or promoted.
- Unified the Python installed-performance fixture generator, extension host, and release report behind one complete typed manifest decoder, with a cross-language regression that feeds actual generator stdout through the host contract.
- Added reproducible repository-local Xvfb preparation for supported Ubuntu x64 acceptance hosts. It verifies pinned official package and executable identities, host dependencies, ELF architecture, private-cache publication, and concurrent reuse; the released-Jupyter workflow passes the resulting executable to the existing invisible private-display runner without installing a system package or touching the runner desktop.
- Added a short native macOS/Windows Cursor release gate. It acquires one official version by exact size and SHA-256, validates product and platform-signing identity, installs the caller's exact VSIX, checks the gallery/Activity Bar icons, native views, file action, grid, theme tokens, keyboard navigation, source immutability, and terminal cleanup, then removes the private installation.
- Added a label-gated hosted Remote SSH acceptance job for intentional release candidates. It reuses the checksum-pinned canonical PR VSIX, prepares the namespace primitive on an ephemeral Ubuntu VM, and runs the existing isolated official VS Code/Remote SSH gate without adding its large download and runtime cost to ordinary pull requests. The hosted setup removes group/other write access from the seven fixed runtime subtrees that GitHub's runner image makes writable and recursively verifies their root ownership and entry types. The harness copies its invoking Node executable into a private receipt-bound file and mounts it through the immutable launch descriptor, supporting setup-node toolcache layouts without a distro-level Node installation or unleased host path. Required remote-server extraction roots are created empty and mode `0700` before their identities are pinned; the phase opens, pages, and filters a remote CSV while preserving its bytes.
- Added **Revalidate Runtime Dependencies**, a trust-gated recovery command for an environment left uncertain by an interrupted guarded dependency change. It validates the exact retained marker under the package-root OS lock and never installs, removes, overwrites, ignores, or expires packages or recovery state. A POSIX status check can inspect an existing clean journal on a read-only package mount by falling back to `O_RDONLY` only after `EROFS`, while retaining its exclusive inode lock and leaving install/recovery paths write-required. Windows protects the journal and its leaves with an exact current-user/LocalSystem/Administrators DACL and pins the journal against replacement for the complete critical section.

### Changed

- Added direct Visual Studio Marketplace and Open VSX install links to the generated stable README while retaining checksummed GitHub Releases for manual and offline installation.
- Made installed-editor interaction p95 representative without relaxing any release limit: first-grid cases still retain ten samples, while release-sized cached/uncached grid and renderer-heartbeat series now retain exactly 40 interactions with no trimming or retry. Every grid sample must prove a real row transition, cached warmup returns to the opposite warmed row before the first measurement, and continuous scrolling trailing-debounces view-state persistence until interaction quiescence. The non-gating 5,000-row smoke retains ten interactions so its deterministic unseen-row targets remain inside the fixture.
- Corrected packaged split-notebook renderer provenance acceptance to use a real user click on notebook A only after notebook B is proven active. The gate retains exact A/B origin, kernel, insertion, and cleanup assertions, including that B never receives A's session. Timeout diagnostics expose only bounded safe classifications and counters.
- Split Linux stable exact-artifact acceptance into a zero-window VS Code invocation and a separate repository-pinned private-Xvfb Cursor invocation, with a fresh canonical artifact verification immediately before each. Cursor 3.13.10 reproducibly failed before harness activation on headless Ozone while the same VSIX passed the complete suite under Xvfb; the correction preserves the artifact, phases, assertions, deadlines, isolation, sealed diagnostics, and no-retry policy, and adds the same fixed Xvfb guidance to a matching post-launch, pre-harness inactivity timeout. The stable-workflow guard now also rejects inherited environment/shell defaults, conditional or non-fatal evidence gates, custom shells, unbound downloads/verifiers, and drift in every cross-platform, performance, Jupyter, Remote SSH, and fan-in contract. The complete parsed workflow is additionally bound by a bounded, cycle-safe canonical digest, so runner, command, action-input, ordered-step, evidence-upload, or human-facing dispatch drift cannot pass by falling between semantic checks. Each artifact-consuming evidence or publication step must immediately follow its own fresh canonical verification, preventing an intervening workspace rewrite from substituting the bytes under test.
- Excluded and cleaned local Python wheel-build residue so `python/build/` can never duplicate the bundled runtime inside a VSIX.
- Completed the Pandas/Polars 1.0 parity gate with one non-retried hosted installed-editor report from exact source `cfc30e4`. Official VS Code 1.130.0 and Cursor 3.13.10 passed the release-sized CSV/Parquet first-grid, cached/uncached virtual-scroll, outstanding filter/sort/profile responsiveness, authoritative cancellation, and terminal cleanup limits; the evidence-only VSIX remains non-promotable and the stable candidate is built afresh from the all-green source.
- Fixed Linux headless-editor geometry at a deterministic `1920×1080` Ozone virtual screen. The workbench remains zero-window and unfocused, while production-grid performance checks can no longer mistake Chromium's tiny default surface and clipped insight headers for a renderer timeout; Xvfb and explicit current-desktop runs remain unchanged.
- Corrected installed-editor cached/uncached grid timing so each sample starts immediately before the renderer assigns `scrollTop` and stays inside one renderer task. A sample now completes only after two consecutive animation frames expose the exact non-busy shape, target text, and a nonzero target cell intersecting both its scroller and viewport; timeout cleanup cancels the outstanding animation frame instead of retaining cross-CDP polling overhead.
- Stabilized virtual-grid scrolling across profiling and loading rerenders. The grid now retains one scroll listener, reconciles scrolls made while a page is busy through the latest callback, and skips identical viewport publications instead of reinstalling handlers and repeating React work.
- Made name-addressed Pandas viewing fail closed for duplicate raw labels and display collisions such as integer `7` versus string `"7"`. Filters, sorts, and distinct-value lookup now return one correlated `ambiguous_view_column` diagnostic instead of silently targeting the first match; the grid explains the ambiguity and disables only unsafe view controls while stable-ID cleaning and ordinary paging remain available.
- Import-options actions now blur their focused webview trigger and commit the disabled busy state before opening the native QuickPick, preventing a late React commit from reclaiming focus on the custom-editor iframe. Completion restores focus only while the webview still owns it and the action remains usable.
- Made the tag release workflow preview-only. A separate metadata job accepts only a matching preview tag and manifest before the build job can start; stable metadata fails there, all stable packaging/readiness branches are absent, and GitHub Release creation is fixed to prerelease. The complete build and validation job structures are exact allowlists with commit-pinned external actions, so extra jobs, secret-bearing publisher steps, write-capable validation mutations, and moving action substitutions fail documentation checks. Stable publication must promote the exact provenance-bound artifact set that passed stable acceptance instead of rebuilding production bytes.
- The isolated Remote SSH host now gives the pinned VS Code CLI a namespace-only `/usr/lib64/libstdc++.so.6` compatibility alias into Ubuntu's already validated read-only multiarch runtime and verifies the exact resolution in both bootstrap and the real phase. Result-wait failures report only a fixed last-observed startup or acceptance-action stage after verified process/display cleanup, namespace revalidation, and zero-capability capture. The classifier reads no log contents and never publishes paths, raw checkpoint text, user data, or caught errors; unsafe or ambiguous observations remain the generic failure.
- Removed the Remote SSH controller's writable dynamic-loader-cache step: the pinned Dropbear binary is now probed and launched directly through its pinned loader and explicit read-only library path. Its immutable runtime is mounted under private `/ow/ssh-runtime`, outside every host-backed mutable home, so an ancestor rename cannot shadow the executable or libraries. A shared loader-argument contract supplies a fixed, verified-absent `--argv0` named `dropbear` beneath the namespace's kernel-owned procfs for bootstrap, real-phase, and daemon launches, after explicitly validating the procfs filesystem identity. Dropbear 2025.89 consequently uses its supported plain-fork fallback instead of reopening and re-executing itself without the loader's one-shot search path; the acceptance-only daemon intentionally trades per-connection ASLR rerandomization for deterministic private-library resolution inside its ephemeral loopback and network namespace. Exact pinned TomCrypt and TomMath files remain independently leased over their read-only multiarch SONAME paths after the host runtime-directory mount. Bounded default-loader listings in bootstrap and the real phase require both SONAMEs to resolve through only the namespace's fixed `/lib -> /usr/lib` aliases to those exact mounts, rejecting glibc hardware-capability and other shadows before direct ELF probes or daemon launch. The namespace supplies a full Coreutils-compatible `printenv` and Procps `ps` instead of BusyBox's incompatible `ps`, and its already-pinned Bash owns `/bin/sh` so BusyBox's compiled applet lookup cannot shadow the exact `ps` mount; its SSH probe requires exact helper paths and working `getconf LONG_BIT`, `printenv HOME`, and `ps -p` behavior before editor launch. Before the cleanup embargo, the exact sealed Bubblewrap argument and descriptor-FD set runs a no-editor bootstrap that loads the controller imports and validates mounted descriptor leaves, critical executable modes, loopback and both Dropbear loader probes, namespace identities, host privacy, empty process/display state, and zero capabilities; the real spawn then seals the same inputs again. Bubblewrap must create the private namespace root with mode `0700`, and the copied virtual environment exposes a receipt-bound regular Python launcher instead of trusting its conventional symlink. Descriptor, namespace, and ownership uncertainty remain unrecoverable; later phase failures can expose only a fixed correlated stage after a second empty-child/display, five-namespace-isolation, host-privacy, and zero-capability boundary. Pre-result failures use randomized-temporary, flush, close, atomic no-overwrite publication, identified cleanup, and lease validation. Post-result cleanup or validation failures carry only the receipt from the first-observed lease after its final identity check and successful close; any earlier identity fault remains latched even if the named path is restored. Host validation binds the surviving named result to that receipt before surfacing a synthetic fixed controller failure. The underlying result is neither overwritten nor exposed as success. Raw process output remains suppressed and any uncertainty still withholds cleanup.
- Hardened installed-performance publication from source to final evidence. Guarded packaging now requires every VSCE source to be tracked or an exact generated output, derives compiled paths only from tracked production TypeScript, uses a fixed nine-file media registry, and pins every tracked and generated input's identity, size, and SHA-256 around `createVSIX`. The README uses absolute links so VSCE leaves its tracked bytes unchanged, and the sealed archive must match both the complete source inventory and every pinned digest. Ignored extras, restored source rewrites, altered bundles, and transient runtime files therefore fail even if a later scan looks clean; excluded user files remain untouched and outside the candidate. Final candidate/report validation now rechecks both receipts in one pinned joint window, and failed extension-host fragment publication removes only the still-identified temporary rather than a substituted path.
- Corrected installed-performance phase-fragment publication for filesystem ctime semantics and destination collisions. The publisher now commits with an atomic no-clobber hard link, allows ctime to advance only while that link is created and its temporary name is retired, pins the destination's resulting ctime through a no-follow descriptor read, verifies the exact destination bytes before minting the receipt, and removes only a still-identified link when validation fails. Cross-platform guard fixtures now canonicalize only their owned OS temporary roots, preserving strict alias rejection in production.
- Made the installed-performance test build guard its complete generated tree before compilation, stage declaration-shadowed CommonJS modules through no-follow descriptor-bound writes, and preflight plus revalidate the exact local module closure before editor acquisition and every phase, so an incomplete or substituted hosted harness fails locally instead of consuming release evidence.
- Retained hosted installed-performance reports for actionable numeric regressions without weakening the gate. Only a complete report whose validated verdict contains numeric threshold failures and no structural failure may emit a revalidated exact path/SHA-256/size receipt; absolute, home/drive/environment-relative, percent-encoded, and ambiguous path-shaped values all fail closed, and candidate revalidation occurs inside the report's final pinned descriptor snapshot before output. The workflow uploads that report alone under a distinct seven-day failure artifact. Passing evidence remains a separate 90-day artifact, while incomplete runs, mixed or structural verdicts, cleanup/ownership faults, candidate or report drift, unsafe paths, and output faults publish no failure artifact.
- Bound every progressive column summary to its stable column identity across the protocol, Pandas/Polars/DuckDB runtimes, saved snapshots, coordinator, native views, and webview. Duplicate and non-string Pandas labels are profiled positionally; missing, duplicate, unknown, or reordered summary results fail closed. The nonmodal Insights drawer now has deterministic focus entry, Escape close, exact opener restoration, and human positional disambiguation for duplicate labels.
- Upgraded the isolated remote-Jupyter fixture from Jupyter Server 2.17.0 to 2.20.0, regenerated its binary-wheel hash lock with a frozen resolver target and release horizon, and added canonical lock checks plus unsuppressed advisory audits to ordinary CI, releases, and the released-Jupyter workflow. The fixture remains outside the VSIX.
- Replaced release-document substring and line parsing with structural GitHub-flavored Markdown validation. Stable parity evidence now requires human completion text plus a tracked typed reference, the dated changelog entry requires a categorized substantive bullet, and source/packaged README channel and installation prose is owned by one exact generated region. Fenced, commented, raw-HTML, placeholder, future-action, untracked, duplicated, and contradictory decoys fail closed, while engine-specific preview descriptions remain available.
- Unified release-number channel classification across workflow metadata and direct stable readiness, so an odd-minor `0.x` preview number cannot enter the stable path even when its manifest incorrectly sets `preview: false`.
- Unified ordinary VSIX verification and stable readiness on one strict in-memory archive reader. Every entry is streamed through actual-size and CRC validation under fixed expansion budgets; encrypted, unsupported, non-regular, colliding, or missing inventory fails, and the gate now requires legal/OPC/runtime/bundle files plus every local asset referenced by the packaged manifest.
- Bound stable package metadata and release documentation to immutable blobs from the exact event commit instead of mutable worktree reads. Final VSIX/checksum publication now pins both parent and file identities, reopens and hashes both outputs before success, and cleans only still-owned outputs when publication fails.
- Replaced release-workflow substring-order assertions with parsed-YAML contracts for the exact build and release jobs, including channel conditions, command shells, failure behavior, event-commit environment, immutable build tail, pinned artifact download and write-capable release action, exact job permissions/runners, final checksum, and publication. Final artifact verification now also rechecks both timestamped receipts jointly after both content reads.
- Made manual notebook-toolbar launches retain exact public provenance when toolbar focus temporarily clears `activeNotebookEditor`. The command now reconciles any direct URI with the active `NotebookEditor` and `TabInputNotebook`, requires one matching open Jupyter document and notebook type, ignores Jupyter-private toolbar context, and preserves that exact object across the variable prompt. Packaged acceptance first proves the rendered labels belong uniquely to the installed canonical command, then pins one action before its single click, releases every inspected browser handle, never retries an indeterminate dispatch, and observes the resulting QuickInput plus natural overflow dismissal without post-click keyboard cleanup.
- Clarified editor support tiers: VS Code and Cursor remain first-class release targets, other VS Code-based desktop IDEs are experimental, Antigravity's documented VS Code base and Open VSX route are recorded without treating registry discovery as compatibility, and browser-hosted `vscode.dev` remains outside the local-runtime scope. The compact matrix and caution now stay identical across preview and stable generated README sections, while release docs distinguish Open VSX discovery from Microsoft's VS Code-only Marketplace route.
- Made the remote-Jupyter Docker availability probe read only the server version from `docker version`, avoiding unavailable or inconsistent optional server-platform fields on hosted engines. The bounded visible-ASCII server version is now an opaque identity that accepts vendor suffixes rather than a guessed semantic-version grammar; the immediate `docker info` probe still requires Linux and a supported x86-64 architecture, exact-matches that version, captures the context and engine ID before mutation, and revalidates all four identities later. Docker's optional human-readable platform label remains outside the engine-security properties, and both canonical `amd64` and hosted-runner `x86_64` reports are accepted.
- Accepted Docker's canonical `no-new-privileges=true` inspection value alongside the equivalent bare and deprecated colon forms, while continuing to reject false, malformed, absent, or additional security options. Remote-Jupyter container-isolation failures now retain only fixed failed-property labels rather than inspected Docker values, preserving fail-closed attestations while making future hosted-engine differences diagnosable from sanitized evidence.
- Made the remote-Jupyter fixture create writable configuration, data, runtime, work, and IPython roots before importing the server. It selects the four Jupyter/IPython paths through their supported environment variables and work through `ServerApp.root_dir`, preventing Jupyter Server 2.17 from falling back to the read-only container home while keeping the per-run token out of process metadata and environment state.
- Consolidated pull-request CI around one verified prerelease VSIX and an exact SHA-256 receipt. A small, full-rerun-safe preparation job lets Linux validation and native macOS/Windows consumers test those bytes in parallel; every required consumer fails explicitly if preparation did not succeed. Native jobs retain their script, extension-host, installed-editor, ownership, and failure-evidence gates; the cross-platform runtime matrix owns only its distinct Python OS/version coverage. Redundant package lifecycle and standalone license runs were removed. CI, cross-platform, and CodeQL now preserve running work while replacing only superseded pending runs for the same event and ref.
- Staggered routine npm, Python, and GitHub Actions Dependabot checks across separate UTC days, grouped compatible minor/patch version updates by ecosystem and dependency type, and bounded ordinary version-update pull requests without grouping or limiting security updates. After an exact-head overlap proved the required Linux/Python 3.10 job retained the real environment smoke and complete runtime suite, the duplicate cross-platform Ubuntu/Python 3.10 cell was retired; affected-path released-Jupyter acceptance now follows the Python dependency manifest it installs. Required and release-evidence pull-request jobs remain unconditional because GitHub treats a skipped job as a successful check; long-running work can push independently tested branches before opening its PR, and exact-head matrices are serialized before squash merges.
- Made the retained-evidence path-swap regression deterministic by replacing the source at the descriptor read boundary, then requiring exact race rejection and proving replacement content never survives.
- Stabilized the native dependency-install acceptance around VS Code's transient confirmation control. The harness now verifies one visible, enabled **Install** action, moves the pointer to a neutral workbench edge until unrelated Monaco hovers are gone, dispatches it once with Playwright's cancellable native timeout and no post-click navigation wait, then requires the modal, fake-pip start, sanitized launch, and natural-shutdown checkpoints in order.
- Made released-Jupyter restart acceptance order-independent without weakening runtime-transfer proof. The replacement process must have a new PID and empty user setup; runtime visibility may race ahead of the notebook probe only when that same process already exposes Open Wrangler's bootstrap root on its own `sys.path`.
- Aligned released-Jupyter Variables acceptance with its public active-notebook lifecycle: the exact captured notebook is shown and reasserted, a non-data warmup starts the selected kernel, the real Variables view opens before the defining cell runs, and that fresh completion drives its refresh. Direct viewer-argument launches likewise restore the exact notebook first, and failures now retain bounded panel/workbench state instead of a bare session timeout. The private Jupyter profiles suppress VS Code's unrelated extension-recommendation notifications so a first-run Python recommendation cannot intercept the real notebook-toolbar action. The view keeps a load-tolerant 120-second readiness bound inside the unchanged 180-second inactivity and 300-second phase deadlines, so a cold hosted kernel can finish listing variables without turning an indefinitely loading view into a pass.
- Kept the Xvfb bootstrap suite portable by running its Linux filesystem, ELF, mode, and publication fixtures only on Linux while retaining an always-run regression that production rejects non-Linux hosts before dependency, network, cache, or extraction work.
- Accepted both forms of notebook origin delivered by the released Jupyter Variables surface: an actual `fileName: vscode.Uri` and its canonical serialized VS Code URI envelope after the Variables webview round trip. The serialized form is revived only for `fileName` after exact key, descriptor, component, cache, Unicode, and UTF-8-bound validation; legacy fields remain real-URI-only. Malformed, conflicting, duplicate, closed, and replaced origins fail closed without an active-editor fallback, and Jupyter remains optional.
- Routed **Open Notebook Variable** through stable notebook-type and workspace-trust contexts: VS Code uses the notebook toolbar, or the editor title when its global notebook toolbar is disabled, while Cursor receives the same canonical command as a declaratively pinned editor-title action. Runtime validation still requires the released Jupyter API, exact notebook, kernel, and dataframe value; no Jupyter-private context key or compatibility command alias controls the surface.
- Hardened opt-in released-Jupyter acceptance with a run-owned dependency-only kernel environment, the contemporaneous `ipykernel 6.30.1` / Pandas 2.3.3 / Polars 1.35.2 compatibility baseline for Jupyter 2025.9.1, explicit private-kernelspec selection through the real workbench picker, bounded execution dispatch, pre-bootstrap/runtime-restart absence checks, fresh notebook-execution attestation, stable-API restart status observation, deterministic persisted-denial completion, and the real trusted Python-Jupyter toolbar predicates. Current dependency versions remain covered by the independent runtime and extension-host matrices rather than being substituted into an older third-party Variables implementation. The harness now resolves VS Code's same-origin nested renderer guest, requires positive preview/action geometry, uses the notebook action's rendered short title, and waits through the native overflow-menu activation guard before dispatching exactly once. Kernel timeout and cancellation invalidation is now scoped to the exact observed generation or still-current pre-observation epoch so a stale request cannot detach a concurrently recovered kernel.
- Made a caller-supplied released-Jupyter VSIX fail before editor discovery when its bounded manifest or native payload targets the wrong operating system, architecture, or Linux C library. Installation uses a private immutable snapshot whose filesystem receipt is revalidated before every editor CLI invocation.
- Built the notebook renderer as a dedicated self-contained module and made VSIX verification parse its packaged bytes, rejecting imports, dependency re-exports, invalid JavaScript, and a missing named `activate` export. Pandas and Polars formatter registration retains `text/plain`, suppresses only default dataframe HTML, and preserves explicit user per-type HTML formatters.
- Made generated notebook insertion a bounded exact-document observation with unique-marker proof. Rejected edits remain rejected, unprovable accepted edits become indeterminate without retry or rollback, and actionless result notifications no longer keep commands or extension-host shutdown alive.
- Bounded each standalone Python interpreter-resolution attempt to one 30-second aggregate budget, with a 10-second per-command ceiling reduced to the remaining time and at most 16 deterministically ranked Windows system candidates. Cancellation, supersession, Workspace Trust loss, and broker/bridge disposal now stop unresolved selection immediately, while exact-object publication guards prevent late activation or subprocess results from replacing a newer selection. A separate serial Linux/macOS/Windows smoke exercises real system discovery without retaining interpreter paths or subprocess diagnostics.
- Prevented actionless dependency notifications and hung status/validation helpers from retaining mutation barriers or keeping the extension host referenced during shutdown; helper processes are now exact-close tracked and idempotently unreferenced without signalling or killing them.
- Prevented delayed grid virtualization, page retry, operation-dialog, and insights-drawer focus restoration from reclaiming the custom-editor iframe after VS Code or Cursor transfers focus to a QuickInput or another workbench surface. Focus ownership is now checked when restoration is scheduled and again immediately before the DOM focus call.
- Made packaged notebook-renderer discovery observation-only and locally bounded. Cursor layout churn can no longer stall acceptance on Playwright pointer-actionability checks; the harness still requires the exact action to be visible, enabled, and functional while preserving the active-notebook provenance race, and retained diagnostics contain only capped structural state rather than rendered dataframe text.
- Moved dependency installation behind the bundled stdlib-only mutation guard. The selected interpreter now acquires a package-root OS lock, durably writes a UUID marker before READY, requires a correlated GO before invoking isolated pip, retains the lock throughout package writes, and clears only its exact marker after a separate lock-owning import/version validation. A host or machine interruption therefore leaves a durable block that a fresh VS Code or Cursor process observes before probes or runtime startup; live writers, malformed state, changed identities, failed validation, and stale tokens fail closed.
- Let native import prompts use the complete bounded workbench budget for natural focus transfer, and queue each transition-causing QuickInput's genuine key-down/key-up pair before awaiting either acknowledgement. This prevents an old prompt's focus restoration from overtaking key-up and stealing focus from its successor, without assigning focus, extending timeouts, or weakening keyboard-only acceptance.
- Hardened VSIX verification to reject exact, case-folded, Unicode-normalization, file/directory, and non-portable archive paths before extraction. Prerelease metadata is now read with strict structural XML parsing that rejects malformed documents, duplicate attributes, document types, ambiguous container arrays, wrong-parent or wrong-namespace lookalikes, and namespaced attribute substitutes; every preview CI package command now passes `--pre-release` explicitly.
- Made import options exact and format-specific: Excel now asks explicitly for either a nonblank sheet name or a zero-based sheet index, while delimited options reject unknown or mixed fields. Sequential import prompts remain open through incidental workbench or webview focus changes; Escape, explicit cancellation, and superseding actions still abort the wizard. Automatic backend selection skips engines that cannot represent a multibyte UTF-8 delimiter or quote character, and an incompatible pinned backend fails before environment probing or runtime startup. A successful engine change now republishes regenerated code plus the restored draft diff and warnings; terminal cleanup cannot start a missing runtime. One custom editor per URI now restores the last confirmed file configuration and resolved backend, including Parquet/JSONL without invented options. This recovers the same source-and-backend cleaning/view state even if later engine defaults change.
- Split runtime deadlines by lifecycle stage: dataframe-session opens now have a configurable 60-second cold engine/kernel budget in both standalone and notebook transports, while initialized-session requests retain the 30-second recovery deadline and explicit cleanup bounds still win. The standalone server prepares each selected backend's top-level native module on its process-owned stdin reader thread through a separately owned transient adapter before dispatching the real open, addressing the worker-thread initialization path implicated by the Windows mixed-engine deadlock. For Polars Excel sources, it also initializes discoverable optional PyArrow there before the worker enters Calamine because supported `fastexcel` releases either import that bridge directly or use it for eager output; missing PyArrow, `fastexcel` itself, and the source read remain worker-dispatched. Added fresh-process Polars-then-Pandas and Polars-Excel protocol regressions; packaged file-open acceptance uses the same cold-open budget plus a bounded coordinator-settle allowance and reports redacted runtime/session state on timeout.
- Made the extension-host missing-dependency fixture a directly executable no-pip virtual environment with an isolated `.pth` invocation recorder on every platform. Acceptance no longer relies on a shell wrapper that production correctly resolves through to its reported interpreter.
- Hardened native acceptance against filesystem and workbench timing discovered by the required macOS and Windows jobs. POSIX progress readers now discard and retry bounded transitional snapshots from an atomic checkpoint rename without accepting unstable bytes or weakening result-file checks; validated non-symlink Windows fixture directories remain direct children of the isolated editor temp root until Job Object emptiness makes outer cleanup safe; the live timeout regression drives a real child with a logical clock instead of a subsecond pre-spawn wall-clock assumption; and delimited-import prompts send focused keyboard input without coupling acceptance to the editor transition triggered by the final prompt.
- Separated native import-prompt visibility from keyboard-focus readiness. Packaged acceptance now waits boundedly for VS Code or Cursor to transfer focus naturally before QuickPick navigation or InputBox entry, never assigns focus itself, and retains only bounded structural diagnostics when that transfer does not happen.
- Shortened disposable macOS editor profile components and added a fail-closed pre-spawn check for VS Code's versioned main IPC socket. Stable VS Code 1.130's Node 24 runtime now rejects overlong Unix sockets instead of silently truncating them; Restricted Mode, seed/verify, and extension-host profiles all remain below the 103-byte platform boundary without leaving the checkout-owned isolated root.
- Packaged and installed the acceptance-only helper into each disposable editor profile instead of loading it as checkout code. Genuine Restricted Mode now runs without a development extension while still proving that the installed Open Wrangler VSIX cannot activate or start Python, including on native macOS.
- Made native webview discovery tolerate bounded slow Cursor attachment with the same 30-second liveness-aware polling used by notebook renderer acceptance, while retaining structural frame diagnostics rather than dataframe text on failure. Editor startup output is now fully credential-redacted before a final 8 KiB diagnostic tail is selected; private-key containers still fail closed without retaining source text.
- Made restored or delayed editor webviews use bounded visibility-aware pulls for retained authoritative state until a matching final synchronization marker commits, then acknowledge it from a post-commit effect. Pending grid presentation now flushes before that acknowledgement, while the host rejects and corrects replay-era writes until the exact marker arrives without blocking ordinary page-revision updates. Native import-option commands use a separately correlated renderer preparation action with one bounded host fallback; manual/native and concurrent-native intents coalesce, and even a busy renderer flushes pending view state before leaving preparation to the host, so dropped or stale messages cannot lose a failure, replay a runtime open, overwrite a newer confirmed view, or duplicate the transaction. Coalesced native commands now remain pending through the prepared prompt transaction, preventing VS Code or Cursor from restoring the custom-editor iframe over an open QuickInput.
- Made standalone Python runtime shutdown exit-confirmed: normal closes send EOF, forced recovery uses `SIGKILL`, replacement startup stays blocked until the exact prior child exits, and a late correlated exit can safely clear ownership uncertainty. Extension deactivation now awaits that bounded proof after draining sessions and preserves or aggregates shutdown failures in order.
- Routed saved notebook-output expansion through the normal coordinator and panel lifecycle. The primary action always opens captured full-width rows as an ephemeral, host-identified, read-only session with native views and correlated filtering, sorting, projection, and profiling without trusting saved state, starting Jupyter, persisting the session, or exposing mutation/export actions. A variable link adds a separate exact-origin live action; truncated captures are labeled before expansion and disposal closes the snapshot exactly once.
- Separated transient session panels from the file custom-editor view type, keyed panel cleanup to exact coordinator sessions, and made terminal close revision-advisory at the host boundary. File and live notebook-variable panels start their single host-owned open immediately, so a delayed Cursor webview-ready event cannot strand the launch; saved notebook-output panels remain lazy. A late renderer-ready event republishes the retained success or error and never retries a denied open. The notebook renderer now uses optional messaging plus an explicit renderer activation event, retaining a readable static preview when host messaging is unavailable.
- Removed the ineffective renderer-messaging toggle that could leave visible notebook actions disconnected. Desktop actions now always have a registered host channel, while saved output remains a static preview when no extension host is available.
- Bounded saved notebook outputs identically in Python and TypeScript by rows, columns, cells, UTF-8 bytes, field lengths, graph depth, and graph nodes. UTF-8 size validation now aborts incrementally instead of allocating an oversized serialized payload. Formatter capture performs no eager profiling, keeps Polars lazy until one bounded terminal page, rejects malformed typed cells and recursive payloads, and recomputes profiles from captured truth. Snapshot, live, and generated queries now share one strict typed-literal grammar, exact wide integer/decimal/time-zone/duration selections, engine-specific NaN sorting, missing-value rules, kind-aware mixed-object identity, and deterministic ASCII-folded literal search/contains.
- Isolated browser accessibility checks in private HOME/XDG roots and a disposable workspace-local profile/temp root, used Playwright's lockfile-pinned headless shell by default, and added per-harness progress plus bounded launch/navigation/axe deadlines so a renderer crash or exhausted shared system temp area fails promptly instead of hanging the validation job. POSIX runs expose that private temp directory through a short, disposable `/tmp` alias so Chrome cannot exceed the Unix singleton-socket path limit in deep CI checkouts.
- Bound every notebook launch and renderer action to the exact originating `NotebookDocument` supplied by VS Code. Split-editor focus changes, simultaneous same-URI document objects, and same-path close/reopen races can no longer redirect URI-addressed kernel access, session provenance, or integration checks. A saved output's explicit live action reruns backend detection against the current variable instead of pinning its historical backend. Generated-code insertion repeats exact-object/version/uniqueness checks immediately before its URI-addressed stable VS Code edit and reports success only after the original document contains its uniquely marked cell; an accepted but unprovable edit is reported as indeterminate and is never retried or rolled back. Timed-out, cancelled, malformed, stale, and mis-correlated opens retain the exact dispatched kernel only long enough for bounded candidate cleanup; terminal close never reacquires by URI against a replacement notebook.
- Moved Linux VS Code/Cursor acceptance to a private zero-window Chromium/Electron platform by default, preserving real workbench, CDP, dialog, and screenshot coverage without opening or focusing windows on the user's desktop. Headless and Xvfb runs receive one mode-0700 `tmp/ow/x-*` root for private home, runtime, config, cache, data, profiles, and inherited editor temporaries, avoiding shared-system-temp quota failures while keeping VS Code's Unix socket below Linux's path limit; the whole per-run root is removed in a nested `finally` only after editor/display ownership is verified. The private display disables unused GLX loading so host GPU drivers cannot crash Xvfb startup. Each POSIX editor launch owns a process group so timeout cleanup includes its extension-host and test-kernel descendants; visible runs require an explicit debug override, and Xvfb remains an explicit compatibility fallback.
- Classified native-editor failures by spawn, early exit, timeout, result protocol, explicit test, runner, and interruption state, with exact editor/version, phase, elapsed time, exit status, result, and progress context. Standalone, seed, and verify phases combine a 300-second hard deadline with a 180-second changed-checkpoint inactivity deadline and never retry automatically; supervisor preparation, receipt validation, spawn work, and the cancellable private debugging-port reservation all consume that same wall-clock budget. Exclusive atomic progress and result files are limited to 1 KiB and 1 MiB; run-specific progress paths and every payload must match the current phase's strict `protocol`/`runId`/`phase` envelope, so stale checkpoints cannot extend inactivity, while the first-observed result identity remains pinned through the final read. Windows writers additionally publish an empty run/phase-derived heartbeat, allowing live inactivity checks without opening mutable content; wrong-correlation writers update a different path. Progress readers discard and retry only verified atomic checkpoint replacement races, while in-place mutation and every result-file identity change still fail closed. Major extension-host checkpoints use bounded, exclusive, randomized, no-follow sibling temporaries, and publication errors fail acceptance. Phase stdout/stderr is captured under fixed bounds, discarded on success, and redacted before failure reporting; an exact early Cursor/headless-Ozone `SIGABRT` adds a fixed, metadata-only private-Xvfb remedy without admitting control-sequence output. Editor CLI, workbench, and private-display processes inherit only an explicit platform/isolation allowlist plus runner-owned test values. Late child errors cannot impersonate exit, while downloader, editor, and display ownership uncertainty remains sticky. POSIX launches own process groups. Windows compiles the checked-in C# supervisor once per private run root inside the same command or phase deadline, pins its executable and parent identity plus SHA-256, permanently rejects a root involved in an unverified bootstrap, and uses that exact executable to create every target suspended, assign it to a private kill-on-close Job Object with strict handle inheritance, and resume only after ownership succeeds; normal completion requires exactly one random supervisor attestation, absent from the target environment and emitted only after `ActiveProcessCount == 0`, and every settled path closes control stdin. Any ambiguous attestation permanently latches ownership uncertainty, the correlated control marker is removed before stderr limits or diagnostics are computed, and a Windows-owned launch without piped stderr fails before spawn. Native Windows CI exercises the compiled supervisor's compile-once contract, natural descendant containment, forced termination, and malformed framing. If any editor/display verification is lost, environment restoration is lexical only, no diagnostic artifact or workflow output path is published, and inherited private runtime, root, profile, result, progress, log, and staging paths remain untouched. Verified private and staging roots are atomically moved to unadvertised random siblings and revalidated against captured root and parent identities immediately before deletion, so a rebound pathname is retained rather than recursively removed. Once the Windows Job Object is proven empty, only a short-lived `EACCES`, `EBUSY`, or `EPERM` on that atomic quarantine move receives a fixed, receipt-revalidated retry schedule; source drift, a planted target, any other error, exhaustion, and recursive-delete faults remain terminal. Package discovery, display, installation, and phase failures otherwise retain only a redacted, bounded allowlist before verified profile deletion; cleanup-only and combined failures receive distinct `cleanup` evidence with the originating phase recorded. A prelaunch-pinned staging root and in-memory inventories bind every retained file through sealing; strict UTF-8 text is re-redacted into one exclusive random JSON artifact outside that staging root. Failed CI/release runs upload only the exact emitted artifact path for seven days; success and ownership uncertainty create none, and raw disposable profiles or secrets are never uploaded. Pull requests and releases now run real stable VS Code extension-host and packaged-artifact acceptance natively on macOS and Windows as well as Linux.
- Moved standalone extension-host acceptance from the repository workspace into a fresh copied fixture workspace under the per-run private root. Interrupted or terminated runs can no longer leave a stale temporary Python override in the source tree.
- Kept supervisor stdout/stderr draining through ownership verification and added split-marker/final-suffix backpressure regressions so transform flush cannot lose target diagnostics. The pull-request native-editor matrix now runs the complete script suite on macOS and Windows, making the real Windows-supervisor compile and lifecycle smoke a required guard.
- Kept Open VSX and Visual Studio Marketplace publication as the final release priority after parity and exact-artifact acceptance. Registry workflows remain disabled until the owner reserves `Matt17BR`, signs the required agreements, provisions protected Open VSX and Microsoft Entra publishing identities, and separately approves the verified live publication.
- Replaced full-width page transport with required two-dimensional grid windows across open, paging, draft, history, apply, discard, and undo flows. Returned values are aligned to stable column IDs; cache keys include the projection; Pandas projects positionally, lazy Polars projects before collection, and DuckDB uses explicit terminal columns while preserving private row identity. Horizontal paging stays in the confirmed logical view, reconciles diagonal scroll and mutation races, exposes an accessible cleaning-action busy state, preserves full-schema keyboard/ARIA coordinates, and identifies duplicate/reordered diff columns by stable ID. The host rejects same-revision schema changes before publishing projected values. Previously saved full-width MIME-v2 notebook outputs are migrated only when their row width exactly matches the saved schema; incomplete self-contained snapshots fail closed, and explicit notebook snapshots are capped at the protocol's 10,000-row page limit.
- Hardened file launches to prefer the menu-supplied URI, recover text/custom/diff editor resources, preserve exact VS Code remote URIs during Python environment resolution, accept supported extensions case-insensitively, and reject untitled, virtual, unsupported, disabled, missing, inaccessible, directory, or special-filesystem targets before runtime startup. Corrected custom-editor menu/keybinding predicates to use VS Code's `activeCustomEditorId` context key.
- Removed the public dependency-install confirmation bypass. The production command now ignores every caller argument and always displays the exact unresolved requirements and target interpreter in a modal before invoking Python. The environment-gated test API can only decline; no modal-free affirmative path exists. Installation is single-flight and revalidates the exact target through the moment immediately before pip. After successful pip, it invalidates the captured dependency-selection epoch so older probes cannot republish stale state, while preserving a genuinely newer interpreter selection.
- Made optional Python-extension environment selection resource-aware and reactive without adding a hard dependency. The stable API is activated and subscribed single-flight; workspace-folder, file, sibling-file, and unscoped events invalidate only affected selections, dependency state, install targets, and processes, while explicit `openWrangler.pythonPath` settings remain authoritative. Disposal is terminal, and stale resolutions or probes cannot fall through to another interpreter after shutdown. Bare command names now resolve only through fully qualified PATH entries and cannot be workspace-shadowed; a wrapper is pinned to the absolute `sys.executable` it reports without realpathing away a virtual environment. Windows fallback uses only the non-mutating `py -0p` installed-runtime listing with automatic installation disabled, then probes a direct supported executable. Dependency probes, pip, and runtime startup reject non-fully-qualified paths. Isolated probes ignore inherited Python homes, paths, user sites, launchers, Python-manager controls, and environment-manager markers while strictly capturing canonical `realpath(sys.prefix)` plus a usable string-safe filesystem identity, including Windows' 128-bit inode range. A confirmed pip mutation invalidates every current scope sharing that exact package root, including executable, symlink, junction, and `/proc` aliases, even if the initiating target became stale; dependency results are additionally partitioned by normalized executable and exact version within shared prefixes.
- Partitioned standalone Python processes by selection scope so different workspace roots remain isolated and concurrent while files in one root share a process. Confirmed sessions, provisional opens, pending requests, and cancellations retain exact slot ownership; duplicate, late, timed-out, cancelled, write-failed, or cross-slot candidate responses fail closed and restart only their owning slot. Multi-slot shutdown awaits every child and reports failures deterministically.
- Bounded inactive standalone Python scope bundles to 128 with a monotonic least-recently-used index that preserves deterministic runtime-slot order. Exact leases and request/session/cancellation/process ownership permit temporary live overflow and trim on release; exact synchronous eviction removes matching selection metadata and stale diagnostics without affecting a same-key replacement. A rejected stop remains retained until that exact child later exits.
- Made dependency probing single-flight across scopes only when package-root identity, normalized executable, Python version, and every ordered dependency descriptor match exactly. Scope invalidation, package mutation, and shutdown detach joined consumers and exact completed owners so late success or failure cannot publish over a same-key replacement. Successful results use an independent 128-entry least-recently-used cache with hit refresh; probe errors remain uncached and shutdown never cancels or awaits the probe subprocess.
- Made dependency installation an exactly owned lifecycle instead of a timed `execFile`: pip now runs directly without a shell or retained output, after every active or already-stopping runtime for that probed package environment has exited. Stopping-child ownership is registered before external cancellation-listener cleanup, so a cleanup fault cannot leak a live runtime past quiescence. The user approval carries its own target-scoped event epoch; after quiescence, a fresh interpreter resolution must match the approved normalized executable, exact version, and canonical package-root filesystem identity while Workspace Trust, requirements, lifecycle, and barrier ownership remain unchanged. Probes and starts stay blocked through mutation. Deactivation waits briefly for authoritative child close, then unreferences without ever signalling or killing pip; the same uncertainty is retained until late close, and disposed continuations cannot publish cache or UI state. Successful close releases the mutation barrier before posting its informational notification.
- Prevented inherited pip/Python environment settings from redirecting or faking a confirmed dependency install. The owned command is `python -I -m pip install --no-input --no-user`; all inherited `PIP_*` behavior is denied except an explicit index/proxy/certificate/cache/network allowlist, pip configuration is disabled, and owned no-input/no-user values are forced. Every interpreter runs from a private mode-0700 directory through exact close, preventing adjacent `pip.py` shadowing; cleanup removes only the empty owned directory and never recurses through a replaced path. Live runtimes likewise discard inherited Python homes, paths, user sites, launchers, and active-environment markers before loading only the bundled Open Wrangler runtime.
- Serialized the complete open-and-restore path per runtime delegate so new and recovering dataframes cannot race native engine initialization while rebuilding one replacement process; sessions backed by independent runtimes remain concurrent.
- Excluded downloaded `.vscode-test` editor distributions from repository status and static analysis while retaining VSIX allowlist enforcement, preventing local minimum/current editor checks from exhausting lint memory or contaminating packages.
- Made Python-script export source-safe and atomic. The public command no longer accepts an injected destination, opens VS Code's Save dialog after its prerequisites pass, pins the immutable open-request source and current local/remote host, and rejects normalized, platform-equivalent, symlink, hard-link, directory, virtual, and cross-remote targets. The writer anchors usable source, destination, and parent identities; detects concurrent source/destination changes; and publishes the edited buffer only through an exclusive flushed sibling temp whose type and identity are revalidated before one rename. Failure cleanup refuses to remove an unidentifiable or substituted temp and reports cleanup faults without masking the primary error.
- Revalidated the anchored destination after a failed atomic replace, so Windows rename contention is reported as a stable destination-change conflict while genuine permission failures and validation faults retain their original causes.
- Established the Open Wrangler identity across the VS Code package, bundled runtime, protocol schema, repository metadata, documentation, test harnesses, and release artifacts.
- Consolidated commands, settings, custom-editor state, and notebook rendering on the canonical `openWrangler.*` namespace and MIME v2 identifier.
- Removed the unused pre-release identity and compatibility paths instead of carrying aliases or migrations into the experimental package.
- Refreshed real installed-VSIX evidence from fixture-only VS Code and Cursor profiles without development-workspace diagnostics or test-host title chrome.
- Replaced shared engine singletons with ordered factories and session-owned adapters, including diagnostic cleanup on failed opens, explicit close, runtime shutdown, and transient notebook rendering. Extension deactivation now awaits terminal session cleanup across standalone and Jupyter runtimes, while normal Python-process stops use bounded stdin/EOF shutdown before force-kill fallback.
- Refreshed the product description to state the open-source dataframe-wrangling purpose directly and documented the project's independent inspiration from Microsoft Data Wrangler.
- Deferred all live-session profiling until after the exact first grid, added correlated progressive view queries with interactive-over-background scheduling, and bounded each session's page cache by entries and payload weight.
- Made opaque logical-view contexts authoritative across the webview, retained panel snapshot, and native Activity Bar state; superseded pages and pre-recovery runtime responses can no longer overwrite current metadata. Foreground failures, profiling diagnostics, queued-view cancellation, retryable pages, and per-profile retries are isolated from one another.
- Allowed foreground paging to execute beside an immutable profiling lease while keeping transformations, exports, and close exclusive with writer preference. Recovery now retires the replaced runtime session transactionally, and a shutdown that reaches its grace bound still closes a live-kernel session after active work settles.
- Removed the lazy-Polars all-column null scan from initial schema discovery, kept exact summary counts in native Polars aggregations, sampled deterministic valid numeric values for charts, and normalized Pandas/Polars null-versus-NaN counts.
- Made notebook-kernel requests use the same canonical protocol-v2 success, error, cancellation, and correlation envelopes as the standalone runtime so logical dataframe errors remain recoverable responses.
- Made lazy file sessions detect source replacement, resize, schema changes, and deletion before cached metadata can diverge from newly read rows; affected sessions now request an explicit reopen while remaining safely closable.
- Hardened performance evidence with atomic fixture-contract validation, honest first-sample versus warm-source metrics, native lazy-profile measurements, and cache/session cleanup assertions.
- Added canonical stdio protocol round-trip and instrumented active-profile overlap gates with a release-blocking 500ms cache-miss ceiling, and limited cancellation acknowledgements to work that was genuinely still queued so running results remain authoritative.
- Made the bundled Python runtime version a package-wide source of truth and added a documentation gate that rejects extension/runtime prerelease drift.
- Made every runtime mutation and matching webview transition transactional, including rollback of revisions, plans, drafts, cached blocks, confirmed view state, values, profiling ownership, and focus after late failures or cancellations.
- Hardened webview host-message intake with explicit same-origin rejection and kept column-derived diagnostic keys in `Map` storage instead of dynamic object properties.
- Made terminal runtime cleanup accept the caller's last confirmed revision after an ambiguous mutation, recursively isolated Pandas object cells before live/generated custom code, and aligned live/generated null-versus-NaN filters with saved notebook snapshots.
- Made orderly runtime shutdown drain every session after cleanup faults and return their deterministic aggregate to initiating, joining, and later callers.
- Added a release-blocking warm-dependency/cold-source stdio first-grid gate with per-file Linux cache-eviction evidence, and required the runtime version module in packaged-VSIX verification.
- Added strict nested protocol-v2 request/response validation and semantic correlation at webview, persistence, notebook-output, transport, and coordinator boundaries; transformation parameters are discriminated by operation kind, and malformed kinds, actions, runtime IDs, revisions, columns, export paths, and view IDs cannot publish state.
- Made select, drop, rename, clone, cast, formula, and text-length steps address columns with stable `{id, name}` references. The runtime binds them to private input positions before execution, rejects stale/mismatched identities, duplicate list selections, output collisions, and case-folded private-row references without a string fallback, keeps bound plans transactional, and makes Pandas runtime/generated code positional for duplicate labels. Edited dynamic/cross-kind steps retain their applied ID and derive globally unique output lineage deterministically from current output order, so replay publishes the same identities; Pandas MultiIndex structural outputs append without overwriting tuple-labelled columns, sentinels stay private, and DuckDB rejects case-fold ambiguity instead of targeting the wrong column.
- Extended the same stable-reference contract to cleaning sorts, copied cleaning filters, missing-row keys, and duplicate-row keys. The public transform IR is deliberately separate from name-addressed viewing state; ambiguous viewing names fail before preview, saved filters reopen without being replaced by unrelated viewing state, and replacement from the current view is explicit. Binding also rejects a transform filter whose declared semantic type is stale for its referenced input column, preventing Pandas/Polars/DuckDB predicate drift; NaN inclusion on a non-float column compiles to the same explicit-false condition on every engine. Pandas runtime and executable generated code now build masks and stable sort/dedup keys from exact positions, including duplicate and integer labels, while Polars and DuckDB receive bound native names. Omitted/all-column modes exclude the private row identity, and restart/replay retains the exact targets without leaking bound positions into saved steps.
- Extended stable `{id, name}` input references to one-hot and multi-label encoding; find/replace, strip, split, and casing; min-max, round, floor, and ceiling; and datetime formatting. Legacy name strings, stale/mismatched references, repeated one-hot targets, and private-row identities fail before adapter dispatch. Pandas runtime and executable generated code select duplicate and non-string labels positionally, replace an omitted/same-name output with `isetitem`, append explicit outputs without ambiguous assignment, and derive categorical prefixes from the referenced public name while retaining collision and private-namespace guards. One-hot encoding now accepts numeric, boolean, date, and text values, excludes blank/null/NaN categories consistently, and orders generated names globally across engines; multi-label encoding handles categorical nulls; and default stripping uses one explicit Unicode/control-whitespace contract. The operation editor preserves explicit empty multi-label prefixes separately from the default prefix and accepts protocol-valid empty find patterns without changing them during an edit; empty literal finds insert replacements at text boundaries identically in all three engines and their generated code. Packaged live-kernel acceptance applies representative one-hot, uppercase, round, and datetime-format steps to exact duplicate/integer-labelled columns, then replays the full plan after kernel replacement while proving the source variable remains unchanged and public steps never expose bound positions.
- Completed the stable-reference contract for all 26 column-addressed operations. Group keys and aggregation inputs now use exact references while allowing one source to feed multiple aggregations; by-example sources and every saved-program column leaf use exact references, and example inputs are ordered scalar arrays aligned to source selection order. Public/persisted plans never expose private positions or accept legacy name maps. Pandas grouping and by-example execution/generated code address duplicate and non-string labels positionally, while Polars and DuckDB retain verified native expressions. Grouped null and NaN keys/values now share one typed-null contract without erasing computed NaN; decimal means/medians normalize to a portable nullable float; and integer group sums/by-example arithmetic widen past 64 bits through a checked 38-digit envelope instead of wrapping. Exact final-result semantics cover order-independent cancellation, native Polars UInt128 and DuckDB UHUGEINT, a bounded five-limb Polars group aggregate, NumPy/Python integer boxing, and Pandas Decimal sums that preserve precision and scale independently of caller context. Nullable Pandas integers wider than 64 bits retain exact keys, extrema, generated code, typed pages, and Parquet output; NumPy/Pandas temporal scalars retain nanosecond typed-cell precision. Regex replacements remain literal and by-example casing is deterministic ASCII-only. Synthesis is bounded by source/example/AST limits, 64 warnings, 8 KiB per string, and 64 KiB total UTF-8 text; cheap structural guards run before recursive accounting, which is enforced again on the retained canonical step.
- Required every retained by-example step to carry its canonical synthesized program, preventing metadata or persistence replay from silently choosing a new candidate. The operation editor now rejects unsafe integer JSON tokens before native parsing can round them, while exact engine-native execution retains the 38-digit arithmetic envelope.
- Normalized semantic-string group minima and maxima through Pandas nullable strings in both live and generated paths, preserving typed-null behavior across supported Pandas 2.x and 3.x environments instead of relying on their differing object-string reducers.
- Expanded the real-kernel structural-operation acceptance to use Select Columns to reorder duplicate and non-string Pandas columns before cloning, casting, calculating formulas and text lengths, dropping, and renaming them. Every preview checks positional executable code and typed output; the applied plan must preserve public stable identities without private positions, replay after a real kernel replacement, leave the originating dataframe unchanged, and dispose without a retained session.
- Made distinct-value queries deterministic across Pandas, Polars, and DuckDB by sorting equal-frequency values by display text. This removes visual/profile flicker and stabilizes checked-in browser captures.
- Made Vite emit bundle-relative webview assets and explicitly allowed their origin through the main webview CSP, so the packaged Codicon font loads in VS Code, Cursor, and the browser harness instead of resolving against a broken `/codicon.ttf` root URL or being blocked; refreshed the visual baselines and added a duplicate/non-string/empty-label operation-dialog case.
- Kept draft diffs anchored to the immediately preceding committed schema after structural reorders, while replacement previews still use the latest step's recorded input. Add-operation and edit-latest entry points now remain disabled until the active draft is applied or discarded, the runtime rejects a second preview before adapter dispatch, and the no-argument Add Cleaning Step command opens the generic operation picker.
- Made the operation builder fully modal: its background becomes inert and hidden from assistive technology, keyboard focus wraps within the dialog, and close restores the exact opener or a stable workbench fallback.
- Rejected every transformed dataframe with no visible columns, including dynamic categorical and custom-code outputs, so runtime, generated-code, and export row counts cannot diverge on engines that cannot represent a positive-height zero-column frame. Immutable zero-column sources remain viewable where an engine supports them.
- Rejected runtime/kernel response schemas with empty or duplicate stable column IDs or noncontiguous positions before they can enter coordinator or webview state, including active, latest-step-input, and applied-step inspection schemas.
- Made standalone cancellation wait for the original request's authoritative result, prevented detached-cleanup timeouts from restarting a live shared runtime, and replaced non-authoritative close acknowledgements with one fresh bounded cleanup attempt plus diagnostics.
- Made Jupyter acquisition and bootstrap single-flight and generation-safe under concurrency, applied one deadline across acquisition through response parsing, and prohibited automatic mutation/export/session retries after ambiguous dispatch. A later request reconstructs the last confirmed session before continuing after an uncertain mutation.
- Assigned every live-kernel open a host-known candidate session identity and added bounded failure cleanup, preventing lost or malformed Jupyter output from leaving an unaddressable runtime session.
- Added explicit grid/drawer ownership for progressive summaries, complete confirmed-state rollback after foreground failures, stable-ID filter selection through renames, empty-schema guards, and scroll paging that preserves keyboard focus.
- Pinned persisted plans and recovery requests to the confirmed engine so automatic dependency fallback cannot replay a cleaning plan with different backend semantics.
- Replaced module-only dependency checks with version-aware engine/format probes; DuckDB is accepted only in the tested `>=1.4.5,<1.6` range and dependency installation remains an explicit user-confirmed action.
- Split engine shutdown interruption from request-level cancellation capabilities so DuckDB cleanup can interrupt terminal work without promising cancellation semantics the protocol cannot guarantee.
- Corrected legacy `.xls` support end to end: Pandas now probes and uses `xlrd>=2.0.1` instead of `openpyxl`, Polars explicitly uses its Calamine/`fastexcel>=0.9` reader, and real BIFF workbook acceptance covers both runtime engines plus extension dependency diagnostics.
- Defined `utf8-lossy` as a Pandas replacement-decoding policy: automatic file opens bypass Polars and DuckDB, invalid bytes become the Unicode replacement character, and the sentinel is never passed to Python as a codec name.
- Split workspace persistence into explicit cleaning and non-destructive viewing sections; filters/sorts, stable-ID widths and column selection, and vertical/horizontal position now restore by source and confirmed backend across reload and runtime recovery, with the active selection mirrored in native views.
- Moved preview releases to Marketplace-compatible numeric versions with `preview: true`; the release workflow now validates and publishes one checksummed VSIX byte-for-byte across its platform matrix.

## [0.2.0-alpha.1] - 2026-07-15

### Added

- Initial 1.0 parity milestone, contributor guardrails, CI, release automation, and documentation ownership.
- Original extension and Activity Bar icon sources.
- Strict TypeScript, Python, formatting, documentation, and VSIX-content checks.
- Protocol v2 JSON Schema, generated TypeScript contract, explicit Python validation, typed cell encodings, request cancellation, timeouts, and structured diagnostics.
- Stable extension-host session IDs with per-session serialization, concurrent dataframe sessions, cleanup, stale-revision rejection, and runtime replay.
- Python 3.10-3.14 environment resolution, engine/format dependency probes, and confirm-before-install runtime commands.
- Two-axis grid virtualization, resizable columns, roving keyboard navigation, column search, responsive insights drawer, and progressive profiling.
- Activity Bar Operations, Summary, Filters/Sorts, and Cleaning Steps views plus a bottom-panel Code Preview surface.
- CSV/TSV delimiter, encoding, quote, and header prompts; Excel sheet selection; configurable viewing behavior and file types.
- Advanced AND/OR viewing predicates with null/NaN operators and cross-engine tests.
- Light, dark, high-contrast, responsive-width, zoom, and wide-data browser acceptance baselines.
- Isolated VS Code extension-host acceptance and minimum/current editor CI coverage.
- A validated 27-operation transformation registry with native Pandas and Polars execution and standalone code generation.
- Revision-safe draft preview, typed page diffs, apply/discard/latest-step edit/undo, and runtime plan replay.
- A searchable VS Code-native operation builder, synchronized Cleaning Steps view, draft diff surface, and editable CodeMirror code panel.
- Workspace-scoped persistence and validated replay for applied steps, an optional draft, and independent viewing state.
- Editable-code clipboard/script export and atomic native Pandas/Polars cleaned-data export to CSV or Parquet.
- Deterministic by-example synthesis with ranked expression programs, ambiguity warnings, native engine execution, and generated code.
- Complete notebook MIME v2 snapshots, permission-aware kernel formatters, and originating-notebook code insertion.
- Generated command, setting, operation, protocol, and MIME references with byte-for-byte CI drift detection.
- Source reopening and Getting Started walkthrough commands.
- Private row lineage and deterministic column identities for accurate structural diffs across sorting, renaming, reordering, grouping, latest-step edits, and duplicate Pandas labels.
- Restart-aware Jupyter kernel lifecycle with bounded execution, active cancellation, one-shot recovery, and real Pandas/Polars formatter/transport acceptance.
- Isolated installed-VSIX acceptance for VS Code and Cursor, including a live packaged Polars session and source reopening.
- Playwright/axe WCAG scanning and pixel-diff visual acceptance across 22 production-bundle harnesses, including high-contrast light, Unicode, empty, loading, error, and recovery states.
- Strict release-size Polars benchmarks with JSON evidence, session-cleanup assertions, rendered cached/uncached scroll gates, and scheduled CI regression checks.
- Cross-engine file acceptance for quoted/headerless CSV, TSV, JSONL, Parquet, and named/indexed Excel sheets plus missing/malformed diagnostics.
- Native nested-Polars and Pandas/NumPy nullable typed-cell fixtures covering large integers, decimals, time zones, containers, binary, durations, NaN/infinity, zero-column frames, and long Unicode values.
- Cross-engine operation-edge acceptance for stable per-column null sorts, missing/duplicate modes, categorical collisions, Unicode casing, non-finite numerics, nullable ordered groups, and custom-code diagnostics.
- Two-process installed-VSIX acceptance in VS Code and Cursor for persisted Polars plans/view state, concurrent Pandas/Polars runtime recovery, source-safe export, and final process cleanup.
- Required TypeScript/Python coverage floors, bundled-production license policy checks, and Linux/macOS/Windows tag validation.
- State-scoped, accessible keyboard shortcuts for draft apply/discard and latest-step edit/undo, with production-bundle Playwright acceptance.
- Installed VS Code/Cursor input acceptance for CSV, TSV, JSONL, Parquet, and Excel plus native Pandas/Polars CSV and Parquet export verification.
- Installed VS Code/Cursor acceptance for representative steps from every operation group on Pandas and Polars, including preview/diff/code/apply, deterministic by-example confirmation, custom-code crash replay, immutable sources, and leak-free disposal.
- Installed VS Code/Cursor acceptance for native Pandas/Polars paging, advanced OR filters, multi-column sorts, progressive summaries, exact stats, searched values, view/plan separation, immutable sources, and leak-free disposal.
- Installed VS Code/Cursor acceptance for edited Code Preview clipboard/script output and explicit runtime change, dependency diagnostics, declined installation, and fallback clearing.
- Remote-compatible kernel runtime transfer plus installed VS Code/Cursor notebook acceptance for saved MIME v2 output, live Pandas/Polars variables, permission denial, kernel replacement/replay, and edited originating-notebook insertion.
- Real installed-VSIX workbench captures in VS Code and Cursor across dark, light, and high-contrast themes at 200% zoom, including the original Activity Bar/gallery identity and native views.

### Changed

- Package publisher changed from `local` to `Matt17BR`.
- File-only use no longer declares Jupyter as a hard extension dependency.
- Supported Python versions are 3.10 through 3.14.
- File-backed Polars CSV/TSV, Parquet, and JSONL inputs now stay lazy through viewing filters, sorts, projections, and page slices.
- GitHub workflows use the current Node 24-based official action majors.
- Custom-editor panels now enable their webview scripts and resources consistently, allowing file sessions to initialize through the contributed editor path.
- Column actions and resizing now provide zoom-safe touch targets plus keyboard resizing; loading, recovery, and generated-code regions expose explicit accessible status/focus semantics.
- Polars nested dtypes are classified by their outer container, Excel sheet indexes follow the public zero-based contract, and failed lazy-file opens no longer retain partial sessions.
- Transformation IR validation now rejects malformed option types, filter predicates, sorts, and group aliases before execution; runtime and generated Pandas/Polars code share deterministic null, category, group, numeric, and Unicode behavior.
- Standalone Python startup is single-flight, restart-safe, and automatically stops after the final session closes.
- Screenshot generation resolves hosted CI Python environments as well as local virtual environments.
- Successful code-copy and script-export notifications no longer hold command completion open while awaiting toast dismissal.
- Notebook kernels receive the packaged pure-Python runtime through the stable execution API and no longer require access to the local extension filesystem.
- Saved notebook snapshots no longer treat null numeric cells as zero, and their multi-column sorts honor explicit null placement independently of direction.
- Visual and accessibility acceptance use the lockfile-pinned Chromium revision, metric-compatible harness font tokens, and always-uploaded CI diffs instead of a moving system-browser/font fallback.
- Real-kernel acceptance uses a single bounded execution deadline with short message polls, tolerating cold shared-runner imports without hiding a hung kernel.
- Webview scrollbars and multi-select states now use VS Code theme tokens for consistent native contrast and deterministic rendering across editor and CI hosts.
- Editor compatibility jobs retry transient VS Code distribution downloads with a bounded backoff.
- Cross-platform checks use a Pandas Index for mixed column labels, platform-native path fixtures, and repository-enforced LF text checkouts, keeping Python 3.10 type analysis and Windows packaging deterministic.

### Release status

- That checkpoint recorded the then-known parity evidence, but it remained a preview and created no `1.0.0` tag. The current matrix is authoritative when later audits reopen incomplete behavior or acceptance gates.

## [0.1.0] - 2026-06-01

- Initial Pandas/Polars viewing prototype.
