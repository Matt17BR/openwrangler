# Changelog

All notable changes to Open Wrangler are documented here. Stable releases follow Semantic Versioning. Preview builds remain unstable.

## [Unreleased]

### Changed

- Daily previews keep the `x.y.YYYYMMDD` format and take `x.y` from the latest reachable stable tag. Intended manual
  stable releases normally advance the minor version; major versions are reserved for substantially larger changes.
- Release candidates now audit the full Node lock, including development dependencies, before publication.

### Fixed

- The file picker now ignores unsupported values inserted manually into `openWrangler.enabledFileTypes`. A non-array
  value restores the defaults, while an empty array still disables every file type.

## [2.0.0] - 2026-08-29

### Security

- Contributor and release installs disable dependency lifecycle scripts. The lock contains no lifecycle-script
  packages, native keytar, or `prebuild-install` fallback. VSCE accepts only the configured file or PAT credential,
  and signing uses authenticated platform packages without downloading or compiling native code at runtime.
- The Data Wrangler comparison rejects path, symlink, and hard-link substitutions before decoding a request. It
  writes each result to a new file without overwriting an existing one.

### Changed

- A supported first dataframe result gains its Open Wrangler action when formatter setup finishes, without rerunning
  the cell ([#659](https://github.com/Matt17BR/openwrangler/issues/659)).
- Named Pandas `Index` and `MultiIndex` row labels appear in the grid. Exports can preserve or omit them
  ([#844](https://github.com/Matt17BR/openwrangler/issues/844)).
- Native R notebook sessions recover after an R-kernel restart by replaying confirmed state into a new runtime while
  keeping the same public session. The interrupted read or mutation is not retried
  ([#776](https://github.com/Matt17BR/openwrangler/issues/776)).
- A release candidate builds one VSIX from protected `main`. Pinned VS Code performance checks and Cursor smoke tests
  install those bytes, and only a passing candidate can be published.
- Native R remains Preview. The Data Wrangler comparison remains an optional report.
- Registry publication verifies the VSIX, checksum, provenance, channel, and downloaded package identity. README and
  gallery image hosting no longer blocks publication.
- The manual `v1.99.7` preview path checks one protected-`main` VSIX in stable VS Code before it can publish the same
  bytes to Open VSX and the Visual Studio Marketplace.
- Pandas row labels now accept dateutil's bundled timezone implementation on Windows as well as its normal system
  timezone implementation.
- Updated js-yaml to 5.3.0. Packaging copies the installed CommonJS file and includes its MIT notice.
- Unexpected workbench render, effect, and message-handler failures now show a keyboard-focused **Reload Open
  Wrangler** action instead of leaving a blank editor. Reloading rejoins the existing session synchronization flow.
- Selecting a grid column header now makes **Copy column** use the full filtered and sorted column. The copy includes
  the header and keeps the 100,000-cell and 4 MiB limits. The footer, column menu, and platform shortcut remain; the
  duplicate inline copy icon was removed.
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
- Existing-release recovery checks Marketplace bytes, metadata, and icons before authentication. A matching public
  version skips duplicate publication; conflicting bytes stop recovery.
- Product packaging now creates deterministic files-only VSIX archives with fixed entry order, storage mode,
  timestamps, permissions, and metadata. The approximately 5 MiB archive trades compression for reproducible bytes.
- Native R now exposes all 32 cleaning operations by adding **Custom Code** after **Transform by Example**. Custom Code
  accepts at most 64 KiB of UTF-8 R source, rejects NUL, blank/comment-only input, and parse failures, and requires a
  local non-active `result` with the same dataframe flavor and at least one column. It supports dynamic rows, columns,
  row names, and `data.table` keys. The operation runs trusted arbitrary R, not sandboxed code: deliberate filesystem,
  network, global-environment, or aliased-object side effects are outside the transaction. Native R remained
  **Partial** in this preview.
- Native R **Strip Text** now generates parse-safe R for default whitespace and explicit control/Unicode sets.
  **Clone Column** preserves element names and treats classed schema/dataframe-name metadata as plain data.
- Native R **Transform by Example** uses the same ordered program for live evaluation, replay, and generated R. It
  checks scalar values, UTF-8 text, program size, integer range, and signed zero before changing any supported frame.

## [1.99.6] - 2026-08-14

### Changed

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
  Linux use the same native-R document path, while Jupyter-owned Quarto Python chunks use their originating
  Interactive Window.
- Jupyter-owned Quarto Python execution now creates or reuses the source-routed Interactive Window, requires an
  explicitly identified Python kernel, restores the source, and runs the chunk once.
  Ambiguous kernel selection or provenance stops without retry.

## [1.99.5] - 2026-08-13

### Changed

- Release candidates and pull-request checks now use the same pinned R package set and lock policy.

### Fixed

- Visual Studio Marketplace recovery retries an anonymous GitHub request only when it fails before receiving an HTTP
  response. Invalid responses, files, credentials, and publication failures are not retried.

## [1.99.4] - 2026-08-13

### Changed

- Release tags now retain the README and image revision displayed by GitHub and the registries.

### Fixed

- GitHub, Visual Studio Marketplace, and Open VSX now use the same media revision for README images and gallery links.

## [1.99.3] - 2026-08-12

### Added

- R dataframes can scale integer, double, and `integer64` columns to the 0–1 range, in place or into a new column.
  Preview, apply, inspection, undo, and generated R produce the same result.
- True and False counts can filter a Boolean column from either its grid-header profile or the Column profiles panel.
- Active viewing filters stay visible above the grid as typed, individually removable chips. **Clear filters** keeps
  the current sort, while **Undo latest filter** restores only the most recent confirmed filter state and remains
  separate from cleaning-plan **Undo**.

### Changed

- Quarto and R Markdown front matter now uses the vendored js-yaml 5.2.3 CommonJS file. Parsing behavior is unchanged.
- The README now distinguishes the stable release, published previews, and current `main` source.
  `npm run package:dev` builds `openwrangler-dev.vsix` from the checkout.
- Operations reads vscode-R's dataframe list without sending an automatic terminal command. Opening a listed
  dataframe or choosing **Refresh** makes the explicit native connection.
- Column profiles uses one Counts/% setting in grid headers and the profile panel. **More values…** opens the longer
  value list when a compact profile omits categories.

### Fixed

- R/Quarto tooling retries initial network transport failures. HTTP, integrity, filesystem, extraction, version, and
  editor failures are not retried.
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
- Release publication creates its local tag before registry checks, so Open VSX cannot miss a tag already pushed to
  GitHub.
- Visual Studio Marketplace verification now checks whether Microsoft accepted an upload when `vsce publish` exits
  with an error.

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
- Open VSX publication now runs in the protected release job and requires an explicit success result from `ovsx`.
- Open VSX verification now uses the registry's namespace-publisher relationship instead of the removed
  `unrelatedPublisher` field.

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

- Registry recovery now verifies public packages and screenshots against their release tags. Packages from before the
  R runtime may omit its frame-contract file; current packages and Open Wrangler 2 may not.
- Benchmark result validation now checks the bytes it read, closing a file-replacement race.

## [1.2.1] - 2026-08-04

### Changed

- Pandas profiles no longer scan ordinary numeric, Boolean, date, and duration columns in Python only to count missing
  values. Profiling the 1 million × 20 Parquet fixture dropped from about 21 seconds to 6.5 seconds.
- Open Wrangler was faster than Data Wrangler 1.24.2 in the median notebook-preview, workbench-open, and full-profile
  measurements across Pandas, Polars, CSV, and Parquet. The
  [full report](https://github.com/Matt17BR/openwrangler/blob/main/docs/performance/data-wrangler-1.2.1/review.md)
  records p95, memory, outcomes, method, and versions.
- PySpark notebook sessions show the first page without indexing, counting, and caching the entire DataFrame. The
  total appears after the final page, and a changed page boundary asks the user to reopen the variable.
- Generated columns stay in view when Cursor opens Code Preview and resizes the grid.
- Editor failure reports have memory and time limits so malformed diagnostics cannot exhaust a developer machine.
- Stable and preview publication sends the same checksummed VSIX to GitHub, Open VSX, and the Visual Studio
  Marketplace. GitHub release notes come from the tagged commit.
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

- Stable-tag publication recognizes Git credential-store approval or rejection rewrites and removes only the
  identified credential file.

## [1.0.2] - 2026-07-28

### Added

- Added protected Open VSX and Visual Studio Marketplace publication from the GitHub Release VSIX. Both registries
  verify publisher, channel, checksum, metadata, and downloaded package contents without rebuilding.
- Introduced an original tiled open-top off-road mark for the extension gallery and Activity Bar.
- Added an accessible column-search combobox with type icons, name/type matching, duplicate-label disambiguation, and
  stable-identity navigation.

### Changed

- Open VSX publication allows up to fifteen minutes for registry propagation.
- Visual Studio Marketplace activation reports only the validated publishing-profile identifier; non-tag manual runs
  finish as explicit no-ops, and real promotions retain protected workload identity.
- Stable publication pushes a lightweight `v<package version>` tag before creating the GitHub Release. Annotated,
  conflicting, and ambiguous refs are rejected.
- Operations and Filters / Sorts use shorter descriptions, and draft code labels the selected engine consistently.

### Fixed

- VSCE can no longer rewrite issue references in the packaged README; its bytes must match the source README.

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
- Added stable release packaging that builds one VSIX with its checksum and provenance receipt. Publication checks the
  tag, source, versions, package inventory, channel, changelog, documentation, and archive, then publishes those same
  bytes without rebuilding.
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
- Added **Revalidate Runtime Dependencies** for an environment left uncertain by an interrupted guarded dependency
  change. It validates the retained recovery marker under the package-root lock and never installs, removes,
  overwrites, ignores, or expires packages or recovery state.

### Changed

- Stable documentation links directly to Visual Studio Marketplace and Open VSX while retaining checksummed GitHub
  Releases for manual and offline installation.
- Virtual-grid scrolling now retains its listener across profiling/loading rerenders and reconciles scrolls made while
  a page is busy.
- Name-addressed Pandas filtering, sorting, and distinct-value lookup reject duplicate labels and display collisions
  such as integer `7` versus string `"7"`. Stable-ID cleaning and ordinary paging remain available.
- Import-option actions commit their disabled state before native prompts and restore focus only when the originating
  webview still owns it.
- Preview tags are handled only by the preview workflow. Stable publication uses the checked candidate bytes without
  rebuilding them.
- Package verification rejects path collisions, non-portable archive names, malformed preview metadata, unexpected
  files, unsupported compression or encryption, CRC mismatches, and source/package inventory drift.
- Open VSX and Visual Studio Marketplace publication remained disabled until their publisher accounts and agreements
  were ready.
- VS Code and Cursor are first-class desktop targets. Other VS Code-based desktop IDEs are experimental; Open VSX
  discovery does not establish compatibility, and browser-hosted `vscode.dev` is outside the local-runtime scope.
- Manual notebook launches stay with the visible notebook through prompts and focus changes. Code insertion checks
  that document again before editing and reports an unprovable result as indeterminate without retrying it.
- The notebook renderer is self-contained in the VSIX. Pandas and Polars formatter registration preserves
  `text/plain` and explicit user HTML formatters while suppressing only the default dataframe HTML.
- Interpreter discovery stops on cancellation, trust loss, or disposal and accepts only fully qualified executables.
  The Python extension is optional. Each workspace root owns its runtime process, so a late response from one root
  cannot replace another root's session.
- Dependency installation names the requirements and interpreter in a confirmation dialog. It stops affected runtimes
  and only its affirmative button starts isolated pip without user packages. Only configured network and index
  settings are inherited. An interrupted change blocks runtime startup until the user runs **Revalidate Runtime
  Dependencies**. Successful probes are cached for the same interpreter and requirement set; failures are not cached.
- Excel accepts one sheet name or zero-based index. Delimited-file options reject Excel fields and unsupported
  multibyte delimiter or quote combinations before startup. Changing engines restores the plan, draft, view,
  generated code, and warnings.
- Cold opens have a longer startup deadline. Backend preparation happens before request dispatch, including optional
  PyArrow setup for affected Polars Excel environments. Normal shutdown waits for the owned process; forced recovery
  can kill only that process and waits before replacing it.
- Saved notebook output originally opened a read-only view over captured rows, with a separate action for a linked live
  variable. Static output still worked without the extension host. Python and TypeScript enforce the same row, column,
  cell, byte, text, depth, and node limits. Captured filters and sorts use the same typed values as live data, and lazy
  Polars collects only the displayed page.
- Notebook actions, cleanup, and code insertion stay with the originating document and kernel. Split focus or another
  document at the same URI cannot redirect them.
- The grid requests row and column windows while keeping full-schema filtering, sorting, accessibility coordinates,
  and generated code. Each returned value stays aligned with a stable column ID.
- File actions preserve local or VS Code remote URIs, handle suffixes case-insensitively, and reject untitled, virtual,
  missing, inaccessible, directory, special, disabled, and unsupported targets before startup.
- **Export Generated Script** always uses the Save dialog. It rejects the source itself, equivalent paths, links,
  directories, and another remote host, then writes through a flushed temporary file and atomic rename.
- The first grid appears before background profiling. Interactive reads may overtake profiles, while mutations,
  exports, and close remain exclusive. Late pages and failed profiles cannot replace the current view.
- Lazy file sessions detect replacement, resize, schema change, and deletion around every read. They clear stale
  caches, ask the user to reopen, and remain closable.
- A failed mutation restores the last confirmed plan, draft, data, code, view, profiles, selection, and focus.
- Webview messages reject the wrong origin or malformed protocol data before changing state. Runtime, persistence,
  notebook-output, and transport messages also reject malformed IDs, revisions, columns, paths, and view identities.
- Cleaning operations use stable column IDs. Pandas can therefore address duplicate and non-string labels by
  position, while Polars and DuckDB use validated native names.
- Categorical encoders avoid output-name collisions and ignore the specified null or blank categories. Text, numeric,
  datetime, grouping, and by-example behavior now matches generated code across supported engines, including nulls,
  decimals, wide nullable Pandas values, and checked 38-digit integer arithmetic.
- Draft diffs use the immediately preceding committed schema, while edited latest steps use their recorded input.
  Only one draft may be open; add/edit entry points remain disabled until Apply or Discard.
- The operation builder is modal, traps focus, hides its background from assistive technology, and restores the
  opener or a stable workbench fallback.
- Operations reject transformed dataframes with no visible columns, while immutable zero-column sources remain
  viewable where supported. Empty or duplicate column IDs and noncontiguous positions are rejected before display.
- Cancelling a request waits for that request's result instead of pretending running work stopped. Ambiguous notebook
  mutations, exports, and session opens are not retried automatically, and uncertain opens receive one cleanup
  attempt.
- Cleaning and viewing state are stored separately and tied to the confirmed backend, so fallback cannot replay a plan
  through another engine.
- Dependency probes enforce supported engine/format versions, including DuckDB `>=1.4.5,<1.6`. Dependency installation
  remains an explicit, trusted user action.
- Legacy `.xls` files use `xlrd>=2.0.1` in Pandas and Calamine/`fastexcel>=0.9` in Polars. The `utf8-lossy` option is
  a Pandas replacement-decoding policy; invalid bytes become U+FFFD and bypass engines that cannot represent it.
- Distinct values with equal frequency sort by display text across Pandas, Polars, and DuckDB.
- Webview bundles use relative asset URLs and a CSP that allows their origin, so the packaged Codicon font loads
  in VS Code and Cursor.
- Preview releases use Marketplace-compatible numeric versions with `preview: true` and publish the same checksummed
  VSIX to every registry.

## [0.2.0-alpha.1] - 2026-07-15

### Added

- Added the initial 1.0 milestone, release automation, contributor documentation, and original extension and Activity
  Bar icons.
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
- Added MIME-v2 notebook snapshots, permission-aware formatters, live variables, runtime transfer, kernel
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

- This version remained a preview and did not create a `1.0.0` tag. See the current feature-parity matrix for present
  support.

## [0.1.0] - 2026-06-01

- Initial Pandas/Polars viewing prototype.
