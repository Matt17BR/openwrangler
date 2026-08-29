# Changelog

All notable changes to Open Wrangler are documented here. Stable releases follow Semantic Versioning. Preview builds remain unstable.

## [Unreleased]

## [2.0.0] - 2026-08-29

### Security

- Dependency lifecycle scripts are disabled for contributor, CI, candidate, packaging, promotion, and release installs.
  The lock contains no lifecycle-script packages, native keytar, or `prebuild-install` fallback. VSCE credentials fail
  closed to the existing file/PAT path, and signing resolves only authenticated optional platform packages without
  dynamic download or native compilation.
- The Data Wrangler comparison harness reads requests through one bounded descriptor and rejects same-size path,
  symlink, and hard-link substitutions before decoding. Results use exclusive no-overwrite publication and
  identity-aware cleanup. CodeQL also analyzes every push to protected `main`.

### Changed

- Supported first-result output upgrades automatically after formatter setup
  ([#659](https://github.com/Matt17BR/openwrangler/issues/659)). Named Pandas `Index` and `MultiIndex` row labels
  display in the grid, with explicit preserve-or-omit export choices
  ([#844](https://github.com/Matt17BR/openwrangler/issues/844)). Verified Native R sessions recover after an R-kernel
  restart without retrying the triggering read or mutation
  ([#776](https://github.com/Matt17BR/openwrangler/issues/776)).
- Stable candidate qualification packages protected-main source once and runs pinned VS Code installed-performance
  and Cursor platform-smoke against those same bytes. Only that canonical artifact is eligible for promotion. Native
  R remains a channel-neutral, nonblocking Preview, and the Data Wrangler comparison remains optional historical
  evidence.
- Native-R notebook sessions can recover after a correlated kernel change by preparing a fresh private delegate,
  replaying confirmed state, and keeping the public session. The failed read or mutation is not retried, and stale or
  cancelled recovery cannot replace current state.
- Registry promotion now verifies the canonical VSIX, checksum, provenance, channel, and downloaded package identity.
  README and gallery image hosting no longer blocks publication.
- Manual `v1.99.7` preview publication qualifies one canonical protected-main artifact in stable VS Code before an
  explicit run may publish the same bytes to Open VSX and the Visual Studio Marketplace.
- Pandas row labels now accept dateutil's bundled timezone implementation on Windows as well as its normal system
  timezone implementation.
- Updated js-yaml to 5.3.0. Packaging verifies and copies the installed CommonJS file and includes its MIT notice
  without hard-coding one release's file size and checksum in several places.
- Unexpected workbench render, effect, and message-handler failures now show a keyboard-focused **Reload Open
  Wrangler** action instead of leaving a blank editor. Reloading rejoins the existing session synchronization flow.
- Selecting a grid column header now prepares its complete filtered and sorted data column for **Copy column**.
  Copied columns include the header and retain the existing 100,000-cell and 4 MiB limits. The redundant inline copy
  icon was removed; the footer, column-actions menu, and platform shortcut remain.
- The grid now selects rectangular ranges by mouse or pen drag without native text selection. Shift-modified pointer
  and keyboard selection extend the anchor; Ctrl/Cmd+click starts a new rectangle because non-contiguous selections
  are not supported.
- Development, CI, and packaging use Node.js 24.19.0 with npm 11.17.0. Supported Node versions are
  `^22.22.0 || ^24.0.0`, excluding Node 23. The extension-host floor remains VS Code `^1.106.0` with
  `@types/vscode` 1.106.0 and `@types/node` 22.20.1; the lock retains Nano ID 3.3.18.
- Supported live dataframes can return from Editing to Viewing while the cleaning plan is empty and no draft is open.
  The mode control explains what Viewing preserves and why PySpark, live DuckDB relations, and saved notebook
  snapshots do not offer cleaning.

## [1.99.7] - 2026-08-28

### Added

- **Pivot wider** reshapes one exact text/factor key and one scalar value column into 2–64 fixed ordered outputs.
  Every non-null key must be declared, duplicate identifier/key rows fail without aggregation, missing combinations
  become typed nulls, and Pandas, Polars, DuckDB, and Native R preserve engine-native values and generated code.
- **Pivot longer** reshapes 2–64 ordered, exactly compatible scalar columns into stable label/value outputs. It keeps
  unselected columns, emits selected-column-major rows, preserves native scalar metadata without common-type
  coercion, and runs natively in Pandas, Polars, DuckDB, and Native R; PySpark remains viewing-only.
- **Extract regex group** retains its source column and creates one stable output from the selected capture group in
  the first leftmost match. Pandas, Polars, DuckDB, and Native R share one bounded portable pattern contract and
  engine-native live and generated execution; PySpark remains viewing-only.
- **Split text into columns** retains its source column and creates 2–64 ordered output columns from one non-empty
  literal delimiter. Null and missing parts stay null, participating empty parts stay empty, and extra parts are
  ignored across Pandas, Polars, DuckDB, and Native R; PySpark remains viewing-only.

### Changed

- Active R-terminal discovery reconciles vscode-R's read-only workspace metadata every two seconds without polling the
  R process or sending terminal code. **Refresh** remains available.
- Existing-release recovery checks complete public Marketplace bytes, metadata, and icons before authentication.
  An exact public version skips duplicate publication; conflicting bytes still fail.
- Product packaging now creates deterministic files-only VSIX archives with fixed entry order, storage mode,
  timestamps, permissions, and metadata. The approximately 5 MiB archive trades compression for reproducible bytes.
- Native R now exposes all 32 cleaning operations by adding **Custom Code** after **Transform by Example**. Custom Code
  accepts at most 64 KiB of UTF-8 R source, rejects NUL, blank/comment-only input, and parse failures, and requires a
  local non-active `result` with the same dataframe flavor and at least one column. It supports dynamic rows, columns,
  row names, and `data.table` keys. The operation runs trusted arbitrary R, not sandboxed code: deliberate filesystem,
  network, global-environment, or aliased-object side effects are outside the transaction. Exhaustive installed
  execution and a reviewed performance record remained outstanding, so Native R stayed **Partial**.
- Native R **Strip Text** now generates parse-safe R for default whitespace and explicit control/Unicode sets.
  **Clone Column** preserves element names and treats classed schema/dataframe-name metadata as plain data.
- Native R **Transform by Example** uses ordered stable column references and one canonical program for live
  evaluation, retained replay, and generated R. Scalar, UTF-8, program-size, integer-envelope, and signed-zero checks
  run before publication across base, tibble, `data.table`, and ordinary `collapse` frames.
- Preview [run #79](https://github.com/Matt17BR/openwrangler/actions/runs/31859989213) from protected `main` commit
  `4ed4d8d4422040dd5f1bcaae274a41fd3fd9cef8` passed candidate and Remote SSH qualification and published `v1.99.6`
  to GitHub and both registries. The public-media verifier was corrected to distinguish registry propagation from
  source-rendering failures; stable v2 remained blocked until that correction landed and a fresh preview proved it.

## [1.99.6] - 2026-08-14

### Changed

- Preview runs #72 through [#78](https://github.com/Matt17BR/openwrangler/actions/runs/31854945486) exposed separate
  native-R, Quarto, renderer-lifecycle, and acceptance-harness failures. Each run published nothing: no `v1.99.6` tag,
  GitHub prerelease, Visual Studio Marketplace package, or Open VSX package was created. These runs remain failed
  evidence; run #79 later published `v1.99.6`; its verifier observations prompted the later correction recorded under
  1.99.7.
- A synchronized renderer now flushes presentation state before reporting graceful retirement. The host reloads the
  current renderer without reopening or closing its runtime session. Abrupt renderer-process death that emits no
  lifecycle event remains outside this fix.
- A visible editor whose renderer disappears after **Change Import Options** now recovers its confirmed session even
  when Cursor reported the final host message as delivered. Recovery does not reopen the source or repeat the import
  transaction.
- Native R editing added Formula and Format Datetime for supported frames, including generated R. Formula accepts
  exact numeric columns or a finite scalar. Format Datetime accepts `Date` and `POSIXct` columns and respects the
  declared time zone, falling back to UTC. Generated scripts preserve a source already named
  `open_wrangler_result` by publishing the cleaned frame as `open_wrangler_result_2`.
- Native R editing also added One-hot encode and Multi-label binarize. Missing, `NaN`, blank, and unused-factor
  categories do not create indicators; generated integer columns have deterministic names, and source columns can be
  retained or dropped.
- Native R supported 26 of the then-current 28 cleaning operations. **Transform by Example** and **Custom Code** were
  unavailable.
- On Linux, active R-terminal sessions can export the committed result as CSV and, with `nanoparquet` 0.5.1 or newer,
  Parquet through the public picker and Save dialog. Packaged VS Code and Cursor R Markdown and Quarto sessions on
  Linux use the same native-R document path, while Jupyter-owned Quarto Python chunks use the exact originating
  Interactive Window.
- Jupyter-owned Quarto Python execution now creates or reuses the source-routed Interactive Window, requires an
  explicit or canonically identified Python kernel, restores the source, and dispatches the real chunk once.
  Ambiguous kernel selection or provenance stops without retry.
- Stable 2.x artifact authoring binds the immutable source commit, linked performance report, and candidate VSIX
  digest before publishing canonical output.
- At this release, stable major-version-2 readiness required an all-green Native R matrix covering base, tibble,
  `data.table`, and ordinary `collapse` frames, the then-current 28-operation catalog, editor/document/export
  journeys, a reviewed R performance record, and VS Code/Cursor candidate acceptance. Preview documentation could
  still report **Partial** support.

## [1.99.5] - 2026-08-13

### Changed

- Release-candidate R environments now use the same commit-pinned dependency action, explicit package set, and
  resolved-lock/binary-package policy as pull-request checks.

### Fixed

- Visual Studio Marketplace recovery now reuses its bounded public-release poll when an anonymous GitHub metadata or
  asset request fails before returning an HTTP response. Response-body, release-validation, filesystem,
  authentication, and publication failures remain single-attempt boundaries.

## [1.99.4] - 2026-08-13

### Changed

- Preview and stable release candidates now verify their exact README source, media ancestry, and every declared image
  byte before creating a tag. Open VSX recovery and Visual Studio Marketplace publication restore the exact release
  lockfile and run the same check from the exact release commit before registry authentication.

### Fixed

- GitHub, Visual Studio Marketplace, and Open VSX now use one reviewed, immutable media revision for every README
  product image and full-size gallery link.

## [1.99.3] - 2026-08-12

### Added

- R dataframes can scale integer, double, and `integer64` columns to the 0–1 range, in place or into a new column.
  Preview, apply, inspection, undo, and generated R produce the same result.
- True and False counts can filter a Boolean column from either its grid-header profile or the Column profiles panel.
- Active viewing filters stay visible above the grid as typed, individually removable chips. **Clear filters** keeps
  the current sort, while **Undo latest filter** restores only the most recent confirmed filter state and remains
  separate from cleaning-plan **Undo**.

### Changed

- Quarto and R Markdown front matter now uses js-yaml 5.2.3 through one vendored CommonJS runtime asset. Historical
  registry checks allow 1.99.0–1.99.2 packages to predate that asset; 1.99.3 and later packages require it. Parsing
  behavior is unchanged.
- The README now distinguishes the stable release, published previews, and current `main` source.
  `npm run package:dev` builds `openwrangler-dev.vsix` from the checkout without running the release matrix.
- Operations reads vscode-R's dataframe list without sending an automatic terminal command. Opening a listed
  dataframe or choosing **Refresh** makes the explicit native connection.
- Column profiles uses one Counts/% setting in grid headers and the profile panel. **More values…** opens the longer
  value list when a compact profile omits categories.

### Fixed

- R/Quarto tooling retries only initial transport failures, with bounded waits inside the existing per-artifact
  budget. HTTP, integrity, filesystem, extraction, version, and editor failures remain single-attempt.
- Short editor layouts hide header distributions when needed to expose a complete data row. Missing, Distinct, and
  numeric Min/Max values remain visible, and distributions return when space permits.
- R chunks launched from Quarto or R Markdown resolve relative paths from the document folder and restore the active
  R terminal's previous working directory, including after failure.
- Quarto and R Markdown cells reuse the R session Open Wrangler already tracks. If none exists, Open Wrangler starts
  one through the R extension and waits until execution finishes before discovering dataframes.
- A dataframe produced by the first Python notebook execution gains **Open in Open Wrangler** when automatic formatter
  setup was not ready. The action opens that exact result from the same notebook and kernel without rerunning the cell.
- Grid cells expose **Keep only this value** and **Exclude this value** through hover, context menu, and keyboard.
  Filters use typed values, distinguishing large integers, booleans, nulls, NaN, and similarly formatted text.
- Notebook expressions such as `frame.head()` and `frame.tail()` retain a live link to their exact result. Saved
  outputs without a live link remain readable but do not offer an unusable open action.
- **Open in Open Wrangler** routes `.qmd` and `.Rmd` cells by the exact cursor-owned fence and document executor.
  R-backed chunks stay in a pinned R terminal; Jupyter-owned Python chunks use an Interactive Window. Ambiguous
  metadata or replaced terminals fail, and the user chooses when both R and Python sessions are available.
- Large R dataframes retain column and dataset profiles beyond the former row/cell limits. Cheap statistics remain
  exact; sampled distributions and unavailable counts are labeled.
- Filters now opens on multi-million-row R dataframes with a labeled 100,000-row initial sample. Search scans in
  chunks for exact match counts and asks for a narrower term when distinct-match state would exceed its bound.
- R dataframes open when an atomic or classed column has an ordinary aligned `names` attribute. Malformed names
  metadata and unrelated attributes are still rejected.
- Python Interactive windows expose **Open in Open Wrangler** in the VS Code toolbar and Cursor editor title. The
  action lists dataframes from that exact live kernel, and Operations refreshes from the same window.

## [1.99.2] - 2026-08-10

### Added

- Operations lists dataframes from the active IRkernel notebook, including base data frames, tibbles, data tables, and
  ordinary frames created by `collapse::qDF()`, `qTBL()`, and `qDT()`.
- R can group by one or more columns and calculate sum, mean, median, minimum, maximum, count, distinct count, first,
  or last. Results retain the input's base data frame, tibble, or `data.table` flavor.
- Live notebook variables opened in Viewing mode have a **Switch to Editing** button that preserves filters, sorts,
  column widths, selection, and scroll position.
- Operations can list and open dataframes from a selected official VS Code R terminal. **Show R dataframes**,
  **Refresh R dataframes**, and **Start R and show dataframes…** manage that session explicitly.
- VS Code R notebooks now cover macOS and Windows. macOS VS Code also supports the `.R`, `.Rmd`, and `.qmd` document
  paths. Explicit local Windows document actions remain hidden; the stable title action can open from an active R
  terminal. Cursor remained Linux-only, and remote R-document execution remained experimental.
- Local R notebook and R document sessions can export committed results as Parquet with `nanoparquet` 0.5.1 or newer.
  R writes the file directly, and the extension streams it through the same atomic Save path used by CSV.
- Fill Missing Values previews report the exact remaining missing count for the complete cleaned dataframe.
- Fill Missing Values can use previous or next values after explicit sorting, with an optional maximum gap. The
  explicit sort is stored in the cleaning step and does not reuse viewing sorts.
- Missing numeric, text, categorical, and Boolean values can use a statistic calculated within grouping columns.
  All-missing groups and tied most-common values remain missing.
- Floating-point columns can interpolate missing runs along a numeric, date, or datetime coordinate. Leading,
  trailing, and over-limit gaps remain missing.

### Changed

- Extension and repository tags now describe support for desktop VS Code forks instead of repeating the product name.
- Clickable grid headers, column-search results, and filter values use consistent pointer, hover, and keyboard focus.
- Numeric histograms use one full-chart control. Pointer movement selects a bin; arrow keys navigate and Enter or
  Space applies the filter. Category targets remain usable at reduced zoom.
- Fill Missing Values groups its methods into column statistics, grouped statistics, ordered data, fallback columns,
  and manual replacement, and labels the selected column type.
- Generated R lays out Group and aggregate calls across multiple lines.

### Fixed

- Sort-priority actions remain accessible from each Filters / Sorts row's context menu in narrow sidebars.
- Applying a profile filter preserves the selected column, and the profile shows the active filter and **Clear**
  action while results reload.
- **Open in Open Wrangler** is visible immediately for supported `.R`, `.Rmd`, and `.qmd` tabs and can reuse the
  dataframe list already shown in Operations.
- R Markdown and Quarto keep commas inside nested chunk options, skip valid `eval=FALSE` external-content cells, and
  explain when no R cells are present.
- **Show R dataframes…** reads the selected terminal on its first invocation.
- The `.py` editor action handles an unconfigured Interactive Window, preserves source/cursor state, and waits for the
  exact new cell. Indeterminate dispatch stops instead of rerunning.
- Discarding the only Python draft or undoing the only applied step clears Code Preview.
- Notebook, Python Interactive, R-file, and active-R pickers let Quick Input return focus before opening the dataframe.
- Consecutive non-cancellable cleaning actions no longer wait behind profiling restarted after the prior step.
  The selected Column profile can also run beside an active header profile.
- Active-R dataframes opened in Viewing mode now offer **Switch to Editing**.
- **Open in Open Wrangler** appears immediately in trusted `.py` editors and runs either the ordinary file or the
  current `# %%` cell.
- The operation search icon stays inside its field, and Getting Started distinguishes editable DuckDB files from
  viewing-only notebook relations.
- Editing the latest R Group and aggregate step preserves compatible filters and sorts; undo removes rules that no
  longer exist in the restored schema.
- Release publication creates the exact local tag before registry checks, preventing Open VSX promotion from missing
  a tag already pushed to GitHub.
- Visual Studio Marketplace verification now determines whether a nonzero `vsce publish` result actually failed when
  Microsoft accepted the upload before the CLI returned.

## [1.99.1] - 2026-08-07

### Added

- Fill Missing Values can now take an ordered list of fallback columns. For each missing target cell, Open Wrangler
  uses the first present value in the same row and leaves the cell missing when no fallback has a value.
- Floating-point columns can now fill missing values with their mean in Pandas, Polars, DuckDB, and R. The calculation
  ignores nulls and NaNs and is not affected by viewing filters or sorts.
- R notebook sessions opened in Editing mode can now export their committed cleaning result as CSV. R writes the
  file in the selected IRkernel, and the extension transfers it in bounded chunks into the normal atomic Save path.

### Changed

- Corrected the R gallery and Marketplace description so they match the current missing-value, notebook-export,
  R Markdown, and Quarto behavior.

### Fixed

- Cursor no longer reloads a new editor immediately when it rejects a message before the webview is ready. The
  first webview gets the normal startup grace period instead of being replaced while it is still attaching.
- A stalled editor now gets a second webview reload before giving up. The dataframe session stays open; the file is
  not reopened and the runtime is not restarted.
- A renderer's initial `ready` message no longer disables recovery before the UI acknowledges the exact snapshot or
  error it received. This prevents an intermittent blank Cursor editor during dependency setup.
- Open VSX publication now runs inside the protected release job, where the publishing token is available. The
  workflow also requires explicit success output from `ovsx`; an empty token prompt can no longer look successful.
- Open VSX verification now follows the registry's current verified namespace-publisher relationship instead of
  requiring the removed `unrelatedPublisher` field.

## [1.99.0] - 2026-08-07

### Added

- Added native R support for base `data.frame`, tibble, and `data.table` variables in IRkernel notebooks. On
  macOS and Linux, Open Wrangler can also run trusted `.R` files and supported R cells from `.Rmd` and `.qmd`
  documents in its own R process.
- Added 20 R cleaning operations with data and code previews, apply/discard, history, latest-step editing, and undo.
  Generated R can be copied, saved, or inserted into the notebook or document that opened the dataframe.
- Added CSV export for local R document sessions opened in Editing mode. R notebook export and R Parquet export are
  not included in this preview.
- Added support for ordinary frames returned by `collapse::qDF()`, `qTBL()`, and `qDT()` without making
  `collapse` a runtime dependency.
- Added type-aware missing-value replacement for Pandas, Polars, DuckDB, and R. Numeric columns can use their median,
  text-like and boolean columns can use their most common value, and supported columns accept a typed value entered
  by the user.

### Changed

- PySpark opens its first page without counting or caching the whole DataFrame. Profiles use fewer Spark jobs, source
  order is labelled clearly, and stopped or replaced sessions can reconnect without hiding the last confirmed grid.
- README and gallery screenshots now keep their aspect ratio on the Visual Studio Marketplace and stop growing past
  960 CSS pixels on Open VSX. The original high-resolution PNGs are unchanged.
- Added a full-resolution R editing screenshot to the README and product gallery.
- Renamed **Export Python Script** to **Export Generated Script**. Python uses the `.clean.py` default, while R uses
  `.clean.R`.
- Preview releases now run the R 4.5.2 contract tests and install the candidate VSIX in VS Code and Cursor for the R
  notebook and document tests before publishing.

### Fixed

- Cursor now reloads an editor whose first session message stalls, without opening the dataframe or runtime session
  a second time.
- **Add step** and **Edit latest** now wait for an in-progress grid request instead of dropping a click. Operation
  forms also keep their entered values when Cursor repeats the same renderer snapshot.
- Large R step inspections now fetch code and data blocks separately instead of combining two valid pages into one
  oversized kernel response.
- The grid now shows a final partial page when the browser has reached its maximum scroll position.
- R process responses are read through validated file descriptors, so replacing a response path cannot change the
  bytes Open Wrangler accepts.

### Security

- Updated the nested `js-yaml` copies used by development and packaging tools to 4.3.1.

## [1.2.2] - 2026-08-04

### Added

- Added **Convert Trusted Pickle to Parquet…** for local `.pkl` and `.pickle` files. The command names the selected
  interpreter, requires confirmation before loading executable pickle content, accepts Pandas DataFrames, and saves a
  separate Parquet file without overwriting the source.

### Changed

- Open VSX and historical-registry recovery now verify public packages and screenshots against their exact release
  tags. Packages from before the R runtime may omit its frame-contract file; current packages and Open Wrangler 2 may
  not.
- Benchmark result validation now checks the bytes it read rather than checking the path first, closing a
  file-replacement race.

## [1.2.1] - 2026-08-04

### Changed

- Pandas profiles no longer scan ordinary numeric, Boolean, date, and duration columns in Python only to count missing
  values. Profiling the 1 million × 20 Parquet fixture dropped from about 21 seconds to 6.5 seconds.
- Open Wrangler was faster than Data Wrangler 1.24.2 in the median notebook-preview, workbench-open, and full-profile
  measurements across Pandas, Polars, CSV, and Parquet. The
  [full report](https://github.com/Matt17BR/openwrangler/blob/main/docs/performance/data-wrangler-1.2.1/review.md)
  records p95, memory, outcomes, method, and exact versions.
- PySpark notebook sessions show the first page without indexing, counting, and caching the entire DataFrame. The
  total appears after the final page, and a changed page boundary asks the user to reopen the variable.
- Generated columns stay in view when Cursor opens Code Preview and resizes the grid.
- Editor failure reports have fixed memory and time limits, preventing malformed or oversized diagnostics from
  exhausting a developer machine.
- Stable and preview publication sends one checksummed VSIX to GitHub, Open VSX, and the Visual Studio Marketplace.
  GitHub release notes come from the tagged commit, and the public release is verified before registry publication.
- Stable v1 fixes ship from `release/1.x`. Open Wrangler 2 previews use reserved `1.99.x` versions on `main` before
  the project moves to 2.x.
- The Data Wrangler comparison works with current ipykernel connection arguments, and its Python 3.12 fixture includes
  Polars.

## [1.2.0] - 2026-08-01

### Changed

- Missing-dependency panels no longer inherit stale grid-loading state, so the confirmed dependency-install action
  remains usable after a failed Cursor open while an import change or install still stays exclusive.
- Filters / Sorts priority actions use provider-owned handles, so cloned tree items work in Cursor and stale or
  ambiguous actions explain why they were not applied.
- Import-option Quick Picks and inputs reclaim workbench keyboard focus after opening, fixing Cursor 3.13.21 while
  preserving the keyboard-only flow in VS Code.
- Local PySpark Classic and Connect variables invalidate cached blocks when their dataframe is replaced or their Spark
  session stops. Recreating the variable with the same schema reopens it on the originating notebook/kernel and
  preserves view state; a changed schema asks the user to reopen.
- Unique column labels no longer show redundant positions. Duplicate and unnamed columns retain 1-based positions and
  stable identities.
- PySpark notebook launches require PySpark 4.2.x in the selected kernel. The picker and opening progress label these
  sessions **Viewing only** and explain that opening scans, indexes, and caches the complete DataFrame. External or
  authenticated Connect remains experimental.
- Notebook-kernel requests no longer send kernel-wide interrupts on host timeout or panel disposal, because PySpark's
  SIGINT handler can cancel unrelated Spark jobs. Detached opens receive bounded cleanup on their originating kernel.
- Live notebook opens show progress while connecting to the kernel, preparing the runtime, and opening the variable.
  PySpark's final stage states that it scans, indexes, and caches the complete frame to establish row positions and an
  exact total.
- The workbench uses compact `rows × columns` shape text, and Column profiles scrolls vertically without an empty
  horizontal scrollbar.
- The minimum supported VS Code version is 1.106, the first stable release whose custom-editor API displays an
  extension-supplied tab icon.
- Numeric histogram bins have equal-width, full-chart-height pointer and keyboard targets while their visible bars
  remain proportional. Hover and focus show the range and row count.
- Applied-plan status, **Edit latest**, and **Undo** share one named cleaning-plan toolbar group that remains usable at
  narrow widths, 200% zoom, and forced colors.
- Activating **Undo** from its exact button restores focus to **Add step** only when it removes the final step and the
  webview still owns focus.
- Documentation now distinguishes a native DuckDB relation from an explicit `.df()` result, which is a Pandas
  DataFrame.

### Fixed

- Cursor 3.13.21 shows one canonical **Open in Open Wrangler** action instead of duplicating it in notebook toolbar
  and editor-title surfaces.
- Native Activity Bar actions remain bound to the exact visible dataframe when sidebar focus leaves the editor.
- Restored grid rows and horizontal offsets survive simultaneous custom-editor/view hydration and delayed workbench
  layout changes; explicit user scrolling remains authoritative.
- Ordinary generated Pandas, Polars, and DuckDB plans omit unused `Counter` imports while categorical encoders retain
  them for collision checks.
- Compatible filters, selections, predicates, searches, and ordered sorts survive preview, apply, latest-step edit,
  discard, reload, and undo. Schema-changing steps remove only rules that no longer resolve safely.
- Workbench and custom-editor tabs use the theme-specific Open Wrangler icon.
- Pandas 3 `DataFrame` and `Series` discovery is restored while retaining Pandas 2 aliases and rejecting spoofed
  module/type names.
- Generated-column reveal retries with a fresh identity after renderer synchronization so Code Preview layout changes
  do not leave the grid on the previous columns.

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

- A current renderer-owned **Header profiles** request can recover the confirmed session after a standalone runtime
  exit. Concurrent summary, statistics, and foreground reads share one replacement runtime; cancelled or superseded
  profiling is not reissued, and mutations remain non-retryable.
- macOS synthetic scroll events during viewport restoration or editor teardown no longer overwrite the last confirmed
  grid position. Real wheel, pointer, and touch scrolling remains authoritative.
- Restored viewports fetch their current row block instead of remaining on rows from an older editor page.
- **Change Import Options** adopts a confirmed file session before its configuration write finishes, preventing an
  immediate invocation from cancelling and reopening that source under a second session.

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

### Fixed

- Column widths and selection restore before a saved viewport, preventing synchronous browser scroll events from
  combining the new viewport with stale presentation state.
- A VS Code or Cursor tab whose webview never completes its initial handshake reloads only the renderer and republishes
  the confirmed runtime snapshot instead of leaving a blank grid.
- Notebook recovery uses the runtime-confirmed mode. A viewing-only DuckDB relation therefore recovers in Viewing
  after a kernel restart even when notebook defaults request Editing.
- Same-source reload waits for VS Code to retire the prior session tab before opening the custom editor, avoiding
  cleanup races on slower macOS hosts.

## [1.1.4] - 2026-07-30

### Added

- Added native DuckDB notebook previews and viewing-only live sessions. Open Wrangler retains the originating
  `DuckDBPyRelation` for paging, filtering, sorting, and profiling, releases only its reference on close, and never
  converts through Pandas, Polars, or Arrow. Cleaning, code insertion, and export remain disabled.
- Added Visual Studio Marketplace recovery for an existing numeric release tag on protected `main`. Ordinary changes,
  merge commits, and missing tags finish before authentication; existing `v*` promotion and manual backfill remain.

### Changed

- Inline notebook **Open in Open Wrangler** now opens the complete current live dataframe from the exact visible
  notebook and kernel. Outputs without a canonical live link remain readable and ask the user to rerun the cell.

### Fixed

- Missing variables and unavailable kernels now give direct recovery steps: select or start Python, rerun the defining
  cell, and try **Open in Open Wrangler** again.
- Visual Studio Marketplace promotion treats a transient anonymous GitHub HTTP 403 as pending within its bounded poll.
- Column search covers the complete schema with a virtualized, keyboard-accessible result list.
- Native menus and Quick Input no longer overwrite the confirmed grid row and horizontal position on macOS.
- New workbench panels register activation before opening their session, preventing fast Windows activation from
  disconnecting a successfully opened dataframe.

## [1.1.3] - 2026-07-30

### Added

- Added exact empty-string and minimum, maximum, and mean text-length statistics across Pandas, Polars, DuckDB,
  PySpark, and saved notebook snapshots. Nulls remain separate and Unicode length counts code points.

### Changed

- Text profiling remains engine-native. Lazy Polars, DuckDB, and PySpark return fixed-size aggregates; Pandas
  mixed-object and non-string categorical columns measure the normalized grid text.
- Pandas semantic text profiles retain nonzero NaN counts and reject contradictory empty/length summaries.
- Inline notebook output now has one **Open in Open Wrangler** action for the captured result; the notebook toolbar is
  the explicit route to a current live variable.

### Fixed

- Editor and notebook commands use explicit light/dark SVG variants so icons remain visible on dark surfaces.
- Generated-column reveal waits for the expanded draft schema without repeatedly entering layout, preventing
  far-right columns from blanking the editor or remaining unreachable in Windows Cursor.
- Late pages or renderer snapshots no longer hide a confirmed draft, and queued renderer synchronization completes.
- Code Preview reveals once for the first draft, updates in place afterward, preserves focus, and respects manual
  closure instead of repeatedly remounting the dataframe webview.
- Column-header sorts now accumulate as an ordered multi-sort. Filters / Sorts exposes reorder, direction,
  null-placement, remove, clear, apply, and discard actions; stale native sort actions are rejected.
- Column names use a full-width header row, with compact type, sort, menu, and resize controls below so names remain
  readable at narrow widths and high zoom.

## [1.1.2] - 2026-07-30

### Added

- Added a visible **Export** action to the dataframe workbench. The extension host owns the destination picker, source
  protections, and atomic CSV or Parquet write.

### Changed

- Toolbar and grid controls reflow at narrow widths and approximately 200% zoom without clipping.

### Fixed

- **Change Import Options** remains keyboard-ready in Cursor when launched from editor title, tab menu, or Command
  Palette.
- Draft and preview UI uses operation titles instead of internal kind names.
- A draft that adds columns reveals its first result and preserves that navigation through renderer synchronization.
- Column-search navigation is consumed after use so later previews and restored views cannot repeat an old jump.
- Export remains pinned to the originating dataframe and revision across format and Save dialogs.
- Draft diffs distinguish changed existing cells from values introduced in added columns.
- The empty cleaning-plan bar disappears after the only draft is discarded or the only step is undone.

## [1.1.1] - 2026-07-30

### Added

- Added proactive Pandas and Polars previews for trusted, visible notebooks with user-started kernels. When Microsoft
  Data Wrangler is installed, the user chooses which extension owns automatic dataframe rendering.
- Added bounded notebook-variable discovery for Pandas, Polars, PySpark, and recognized DuckDB relations. Supported
  values open through a notebook action without a typed name; DuckDB relations remain visibly unavailable.
- Added 10, 20, 50, and 100-row paging across every captured notebook column. A uniquely linked live variable can open
  directly while the portable saved capture remains available.
- Added exact finite-value histograms for Pandas, Polars, DuckDB, and PySpark with pointer, keyboard, and accessible
  interval/count labels.
- Added `.ndjson` as an exact JSONL alias across file entry points and supported file engines.

### Changed

- Automatic formatter preparation is limited to exact visible notebooks. Background API-opened notebooks do not
  trigger kernel lookup.
- The responsive Insights drawer uses available workbench width without clipping statistics or distributions.
- PySpark sessions are labeled **Experimental** and **Viewing only** in the workbench.
- Python pickle files remain outside the normal file surface because deserialization can execute arbitrary code;
  unsupported `.pkl` and `.pickle` paths are rejected before runtime reading.

### Fixed

- Notebook and Cursor editor-title surfaces use the same **Open in Open Wrangler** command label.
- Live numeric summaries omit sampled-distribution labels while retaining exact tails, inclusive maxima, deterministic
  constant/empty behavior, and complete population counts.

## [1.1.0] - 2026-07-29

### Added

- Added an experimental, viewing-only PySpark 4.2 live-notebook path for Classic and local Spark Connect DataFrames.
  Projection, filtering, sorting, counts, profiles, and bounded page/value collection stay native to Spark; Open
  Wrangler never converts through a local dataframe engine or stops the user's Spark session. Editing, exports,
  saved-output formatting, external/authenticated Connect, cancellation, and generated-code insertion are not
  supported.

### Changed

- Replaced the all-column Insights drawer with focused Column, Dataset, and Filters views. Column shows one selected
  identity with numeric and typed statistics; dataset statistics and filter values run only while their view is open.
- DuckDB file sessions use UTC for deterministic rich Parquet values and require `duckdb>=1.5.4,<1.6` with `pytz`.
  JSONL parser errors remain input diagnostics. DuckDB remains a preview rather than a parity or first-class claim.
- PySpark profiles reject unsupported nested types before indexing. Base-frame opening still indexes and counts the
  complete frame, while filtered and sorted pages retain native Spark ordering.
- PySpark map, array, and struct statistics use canonical native keys. Pages, summaries, and distinct values enforce
  Spark-side transport preflight plus cell, byte, node, and depth limits before any bounded result crosses into the
  notebook process. Decimal values retain exact representation and nested schema collisions fail before indexing.

### Fixed

- DuckDB file plans no longer retain request-local relations after their owning connection closes, preventing DuckDB
  1.5 from holding Windows Parquet handles. The backend remains native and never converts through another engine or
  calls `DuckDBPyRelation.close()` for cleanup.

## [1.0.3] - 2026-07-28

### Fixed

- Stable-tag publication recognizes Git credential-store's atomic approval/rejection rewrites, then scrubs the
  identified replacement while retaining directory, identity, content, link-count, and mode checks.

## [1.0.2] - 2026-07-28

### Added

- Added protected, idempotent Open VSX and Visual Studio Marketplace promotion from exact public GitHub release bytes.
  Both paths verify publisher, channel, checksum, metadata, and downloadable package contents without rebuilding.
- Introduced an original tiled open-top off-road mark for the extension gallery and Activity Bar.
- Added an accessible column-search combobox with type icons, name/type matching, duplicate-label disambiguation, and
  stable-identity navigation.

### Changed

- Open VSX public verification allows up to fifteen minutes for registry propagation.
- Visual Studio Marketplace activation reports only the validated publishing-profile identifier; non-tag manual runs
  finish as explicit no-ops, and real promotions retain protected workload identity.
- Stable publication pushes one verified lightweight `v<package version>` tag before GitHub Release creation. It
  rejects annotated, conflicting, and ambiguous refs and is idempotent only for the same commit.
- Operations and Filters / Sorts use shorter descriptions, and draft code labels the selected engine consistently.

### Fixed

- VSCE can no longer rewrite issue references in the packaged README; ordinary package verification requires source
  and packaged README bytes to match.

## [1.0.1] - 2026-07-28

### Changed

- Excel import uses a searchable sheet picker populated by the confirmed Pandas or Polars runtime. Initial open still
  selects the first sheet, and numeric-looking names remain distinguishable from zero-based indexes.
- File opens absorb one transient Python-environment selection before dispatch. Missing Excel dependencies name the
  preferred backend and offer the trust- and confirmation-gated **Install required dependency** action.
- CSV and TSV opens sample up to 64 KiB locally or remotely to detect common delimiters, UTF-8/BOM or Windows-1252,
  quote style, and likely headers, falling back to safe suffix defaults.
- Column headers apply one primary sort. Deliberate multi-column sorting stays in Filters / Sorts as an ordered draft
  with direction, clear, apply, and discard actions.
- Column summaries remain stable as profiling arrives and keep the selected column expanded first.
- Cleaning-operation forms use accessible checklists and individually movable/removable sort and aggregation rows;
  selectors hide schema types the operation cannot consume safely.
- Draft generated code collapses by default when Code Preview already shows the editable source.

### Fixed

- Closing Filters / Sorts restores focus to a visible control, and required checklists use valid group guidance.
- Empty CSV/TSV files open as explicit 0-row × 0-column datasets in Pandas, Polars, and DuckDB; malformed non-empty
  input still fails in its native reader.
- The installed dataframe surface uses declared VS Code foreground/background tokens.
- Polars treats CSV, TSV, Parquet, and JSONL paths literally rather than expanding glob characters.
- Multi-million-row grids map their logical range onto a bounded browser scroll canvas while preserving restored
  positions, keyboard navigation, and Previous/Next targets.
- Removing the last value or predicate removes its filter structurally. Filters / Sorts keeps remaining conditions and
  sorts visible and independently removable.

## [1.0.0] - 2026-07-28

### Added

- Added exact numeric minimum and maximum values to column-header Insights and the Summary drawer, with accessible
  numeric, categorical, Boolean, and datetime visuals.
- Added stable release readiness before artifact upload. It verifies the tagged tracked source, package inventory,
  extension/runtime versions, release channel, dated changelog entry, stable documentation, and one canonical
  `openwrangler.vsix` plus checksum. Symlinks, hard links, duplicate JSON keys, ambiguous documentation, source drift,
  and archive/content mismatches fail before publication.
- Added an ordinary stable-release workflow that packages once from protected `main` and passes the same canonical
  VSIX, checksum, and provenance to macOS, Windows, Linux VS Code/Cursor, installed-performance, Jupyter, and Remote SSH
  qualification. GitHub publication is explicit, protected, and uses the accepted bytes without rebuilding.
- Added Linux remote-Jupyter qualification against an unprivileged, dependency-locked fixture. This remained a
  release-validation path rather than a general remote-Jupyter support claim until a green exact-artifact run.
- Added **Change Import Options** to file grids, initial-load errors, editor actions, and the Command Palette. Success
  preserves the public session, cleaning plan, draft, and view; cancellation or failure leaves confirmed state intact.
- Added **Open in Open Wrangler** to supported-file editor toolbars and tab menus alongside Explorer and Command
  Palette entry points. Cursor receives a default pinned action that explicit user settings can override.
- Added selectable Cleaning Steps history with paged input/output inspection, stable cell and column highlighting,
  generated code through the chosen step, and **Original Data** restoration.
- Added a native lazy DuckDB backend for CSV/TSV, Parquet, and JSONL files, including viewing, profiling, all 27
  deterministic operations, generated code, draft/history, and CSV/Parquet export without converting through Pandas,
  Polars, or Arrow.
- Added opt-in Pandas and DuckDB runtime benchmarks. Polars remained the strict release-performance gate, and runtime
  timing stayed separate from editor first paint.
- Added JavaScript/TypeScript and Python CodeQL analysis, cross-platform runtime checks, canonical single-artifact
  release validation, and repository rules protecting `main` and `v*` tags.
- Added **Revalidate Runtime Dependencies** for an environment left uncertain by an interrupted guarded dependency
  change. It validates the retained recovery marker under the package-root lock and never installs, removes,
  overwrites, ignores, or expires packages or recovery state.

### Changed

- Stable documentation links directly to Visual Studio Marketplace and Open VSX while retaining checksummed GitHub
  Releases for manual and offline installation.
- The 1.0 release recorded the then-current Pandas/Polars gate as complete after installed-editor performance
  qualification. Evidence-only candidate bytes were not promotable; stable bytes were built again from all-green
  source.
- Virtual-grid scrolling now retains its listener across profiling/loading rerenders and reconciles scrolls made while
  a page is busy.
- Name-addressed Pandas filtering, sorting, and distinct-value lookup reject duplicate labels and display collisions
  such as integer `7` versus string `"7"`. Stable-ID cleaning and ordinary paging remain available.
- Import-option actions commit their disabled state before native prompts and restore focus only when the originating
  webview still owns it.
- Preview tags are handled only by the preview workflow. Stable publication promotes a provenance-bound artifact that
  passed stable acceptance instead of rebuilding production bytes.
- Package verification rejects path collisions, non-portable archive names, malformed prerelease metadata, unexpected
  files, unsupported compression/encryption, CRC mismatches, and source/package inventory drift.
- At this release, Open VSX and Visual Studio Marketplace publication remained disabled until the publisher namespaces,
  agreements, and protected identities were provisioned and separately approved.
- VS Code and Cursor are first-class desktop targets. Other VS Code-based desktop IDEs are experimental; Open VSX
  discovery does not establish compatibility, and browser-hosted `vscode.dev` is outside the local-runtime scope.
- Manual notebook-toolbar launches remain bound to the exact visible notebook through prompts and focus changes.
  Generated-code insertion rechecks that same document immediately before editing and reports an accepted but
  unprovable edit as indeterminate without retry or rollback.
- The notebook renderer is self-contained in the VSIX. Pandas and Polars formatter registration preserves
  `text/plain` and explicit user HTML formatters while suppressing only the default dataframe HTML.
- Interpreter discovery is bounded and stops on cancellation, supersession, trust loss, or disposal. Executables must
  resolve to fully qualified paths; bare names cannot be shadowed by the workspace.
- Dependency installation always presents a modal naming the exact requirements and interpreter. The public command
  accepts no confirmation argument, and the test API can decline only.
- Dependency changes use a package-root OS lock and durable recovery marker. An interrupted write blocks future probes
  and runtime starts until explicit revalidation, while stale targets and changed package identities fail.
- Pip runs directly as `python -I -m pip install --no-input --no-user` after runtimes using that package environment
  stop. Inherited Python and pip settings cannot redirect the install except for the explicit network/index
  allowlist, and deactivation does not kill an uncertain pip process.
- Python selection is resource-aware without making the Python extension mandatory. Different workspace roots own
  separate standalone processes; files in one root may share a process. Late, cross-scope, or ambiguous responses
  cannot replace another scope's session.
- Dependency probes share work only for the same package-root identity, executable, Python version, and ordered
  requirements. Successful results use a bounded cache; failures are not cached.
- Import options are exact and format-specific. Excel uses one nonblank sheet name or safe zero-based index;
  delimited options reject Excel fields, and unsupported multibyte delimiter/quote combinations fail before runtime
  startup. A successful engine change restores the confirmed plan, draft, view, generated code, and warnings.
- Cold dataframe opens use a longer initialization budget than initialized-session requests. Standalone startup
  prepares the selected backend before worker dispatch, including optional PyArrow preparation for Polars Excel where
  supported `fastexcel` versions require it.
- Normal standalone shutdown sends EOF and waits for exit; forced recovery may kill only its owned child. Replacement
  startup waits until the prior process has exited.
- Saved notebook output originally expanded as an ephemeral read-only session over the captured rows, with a separate
  action for an exact linked live variable. Static output remained usable when extension-host messaging was absent.
- Saved outputs are bounded identically in Python and TypeScript by rows, columns, cells, UTF-8 bytes, field lengths,
  graph depth, and graph nodes. Capture performs no eager profiling, keeps lazy Polars lazy until one terminal page,
  and shares typed-literal filtering/sorting rules with live and generated paths.
- Notebook launches, renderer actions, runtime cleanup, and code insertion remain bound to the exact originating
  `NotebookDocument` and dispatched kernel. Split focus or same-URI replacement cannot redirect them.
- Grid transport uses two-dimensional row/column windows for open, paging, preview, history, apply, discard, and undo.
  Responses align values to stable column IDs, caches include projection, and horizontal paging preserves full-schema
  filtering, sorting, ARIA coordinates, and generated code.
- File actions preserve exact local or VS Code remote URIs, accept supported suffixes case-insensitively, and reject
  untitled, virtual, missing, inaccessible, directory, special, disabled, or unsupported targets before runtime start.
- Generated-script export always uses VS Code's Save dialog, remains pinned to the immutable source and current
  local/remote host, rejects equivalent paths, symlinks, hard links, directories, and cross-remote destinations, and
  publishes through an exclusive flushed sibling temporary plus atomic rename.
- The package, runtime, protocol, commands, settings, editor state, and notebook renderer use the canonical
  `openWrangler.*` namespace and MIME v2 identity; unused prerelease aliases were removed.
- Engine registries now contain factories rather than shared adapters. Each live or transient session owns its engine
  and cleanup, and extension deactivation waits for terminal session cleanup.
- Initial live-session profiling starts after the first grid. Interactive view work can overtake background profiles,
  pages may run beside immutable profiling leases, and mutations, exports, and close remain exclusive.
- Logical-view context plus request identity controls freshness across webview, retained panel, and Activity Bar state.
  Superseded pages, failed profiles, and pre-recovery responses cannot overwrite the current view.
- Lazy file sessions detect source replacement, resize, schema change, and deletion before and after reads. Stale
  sessions invalidate cached blocks, request reopen, and remain safely closable.
- The bundled Python runtime version is the package-wide version source and must stay equivalent to the extension
  version.
- Runtime and webview mutations publish atomically or restore revisions, plans, drafts, caches, view state, profiling
  ownership, values, and focus to the last confirmed snapshot.
- Webview messages reject wrong-origin and malformed protocol data before state publication. User-derived column keys
  use `Map` storage rather than dynamic object properties.
- Runtime, persistence, notebook-output, transport, and coordinator messages use strict protocol-v2 validation,
  correlation, and discriminated operation parameters. Malformed requests, IDs, revisions, columns, paths, or view
  identities cannot publish state.
- Structural operations, cleaning sorts/filters, missing/duplicate keys, text/categorical/numeric/datetime operations,
  group keys, aggregations, and by-example programs now use stable `{id, name}` column references. Pandas addresses
  duplicate and non-string labels positionally; Polars and DuckDB receive verified native names.
- Categorical encoders avoid generated-name collisions and ignore the specified null/blank categories. Empty literal
  text finds, Unicode stripping, numeric operations, datetime formatting, and generated code agree across supported
  engines.
- Group and by-example execution normalizes null/NaN behavior, decimal results, semantic strings, wide nullable Pandas
  values, and checked 38-digit integer arithmetic. By-example programs are canonical and bounded before retention.
- Draft diffs use the immediately preceding committed schema, while edited latest steps use their recorded input.
  Only one draft may be open; add/edit entry points remain disabled until Apply or Discard.
- The operation builder is modal, traps focus, hides its background from assistive technology, and restores the exact
  opener or a stable workbench fallback.
- Operations reject transformed dataframes with no visible columns, while immutable zero-column sources remain
  viewable where supported. Runtime/kernel schemas with empty or duplicate column IDs or noncontiguous positions are
  rejected before entering host or webview state.
- Cancellation waits for the original request's correlated result; cleanup acknowledgements cannot fabricate
  completion for running work. Uncertain live-kernel opens receive a host-known candidate session ID and one bounded
  cleanup attempt.
- Jupyter acquisition and bootstrap share concurrent work for one kernel generation. Ambiguous mutations, exports,
  and session opens are not retried automatically.
- Persisted cleaning and viewing state is separated and pinned to the confirmed backend so fallback cannot replay a
  plan through different engine semantics.
- Dependency probes enforce supported engine/format versions, including DuckDB `>=1.4.5,<1.6`. Dependency installation
  remains an explicit, trusted user action.
- Legacy `.xls` files use `xlrd>=2.0.1` in Pandas and Calamine/`fastexcel>=0.9` in Polars. The `utf8-lossy` option is
  a Pandas replacement-decoding policy; invalid bytes become U+FFFD and bypass engines that cannot represent it.
- Distinct values with equal frequency sort by display text across Pandas, Polars, and DuckDB.
- Webview bundles use relative asset URLs and a CSP that allows their exact origin, so the packaged Codicon font loads
  in VS Code and Cursor.
- Preview releases use Marketplace-compatible numeric versions with `preview: true` and publish one checksummed VSIX
  byte-for-byte across their platform qualification.

## [0.2.0-alpha.1] - 2026-07-15

### Added

- Added the initial 1.0 milestone, contributor guardrails, CI/release automation, documentation ownership, and original
  extension/Activity Bar icons.
- Added protocol-v2 schemas, generated TypeScript contracts, Python validation, typed cells, correlated cancellation,
  timeouts, and structured diagnostics.
- Added concurrent session IDs, per-session serialization, stale-revision rejection, cleanup, and runtime replay.
- Added Python 3.10–3.14 environment resolution, engine/format probes, and confirmation before dependency install.
- Added two-axis grid virtualization, resizable columns, keyboard navigation, column search, responsive Insights, and
  progressive profiles.
- Added native Operations, Summary, Filters / Sorts, and Cleaning Steps views plus Code Preview.
- Added CSV/TSV delimiter, encoding, quote, and header options; Excel sheet selection; configurable file types and
  viewing behavior; and advanced AND/OR filters with null/NaN operators.
- Added a 27-operation Pandas/Polars registry with native execution and generated code.
- Added revision-safe preview, typed diffs, apply/discard, latest-step edit, undo, plan replay, and a searchable native
  operation builder.
- Added workspace-scoped cleaning/draft/view persistence, editable code copy/script export, and atomic Pandas/Polars
  CSV/Parquet export.
- Added deterministic Transform by Example synthesis with ambiguity warnings and matching live/generated execution.
- Added complete MIME-v2 notebook snapshots, permission-aware formatters, live variables, runtime transfer, kernel
  restart/replay, and exact-origin code insertion.
- Added generated command, setting, operation, protocol, and MIME reference documentation.
- Added source reopening and Getting Started commands.
- Added private row lineage and stable column identities for structural diffs, duplicate Pandas labels, grouping,
  reorder, rename, and latest-step edits.
- Added accessibility and visual coverage for light, dark, high-contrast, zoomed, responsive, Unicode, empty, loading,
  error, and recovery states.
- Added release-size Polars performance checks and cross-engine file/operation edge coverage.

### Changed

- Package publisher changed from `local` to `Matt17BR`.
- File-only use no longer declares Jupyter as a hard dependency.
- Supported Python versions are 3.10 through 3.14.
- File-backed Polars CSV/TSV, Parquet, and JSONL inputs remain lazy through filters, sorts, projections, and pages.
- Custom-editor panels now initialize consistently through the contributed editor path.
- Column actions and resizing provide zoom-safe touch targets and keyboard resizing; loading, recovery, and generated
  code expose accessible status and focus.
- Polars nested dtypes use their outer container, Excel sheet indexes are zero-based, and failed lazy opens retain no
  partial session.
- Transformation validation rejects malformed options, filters, sorts, and aliases before execution. Pandas/Polars
  runtime and generated code agree on null, category, group, numeric, and Unicode behavior.
- Standalone Python startup is single-flight, restart-safe, and stops after its final session closes.
- Code-copy and script-export notifications no longer keep commands open while waiting for a toast to close.
- Notebook kernels receive the packaged pure-Python runtime through the stable API without reading the extension
  filesystem.
- Saved notebook snapshots no longer treat null numeric cells as zero, and multi-column sorts honor explicit null
  placement.
- Webview scrollbars and multi-select states use VS Code theme tokens.

### Release status

- That checkpoint recorded the then-known parity evidence, but it remained a preview and created no `1.0.0` tag. The
  current matrix is authoritative when later audits reopen incomplete behavior or acceptance gates.

## [0.1.0] - 2026-06-01

- Initial Pandas/Polars viewing prototype.
