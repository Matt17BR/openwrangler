# Open Wrangler and Data Wrangler performance study

## Status

This document preregisters the v1.2.1 comparison methodology. It intentionally contains no results yet. The final
report must bind every observation to the exact candidate VSIX, editor, extension, Python environment, fixtures, and
machine described below. Results produced with a different boundary or an unreviewed method are diagnostic only.

The study is a clean-room, black-box comparison. It may use public product documentation, public UI, official editor
APIs for neutral setup, and observable process state. It must never inspect, retain, or report Microsoft Data Wrangler
package contents or implementation details.

## Questions

For Pandas and Polars notebook dataframes backed by the same deterministic CSV and Parquet sources, compare:

1. time from executing the prepared dataframe expression to a stable, usable inline output and product launch action;
2. time from the public launch-action click to a stable, pointer-usable workbench grid;
3. time from the public profiling action to the first useful and final all-column profiles, plus elapsed time from the
   original workbench click; and
4. absolute and baseline-adjusted memory for the isolated editor process tree and its Python kernel/runtime.

The Pandas comparison uses the same Pandas dataframe in both products. The Polars comparison keeps Open Wrangler
native and passes the same real Polars variable to Data Wrangler. A Polars source proves the source engine, not the
implementation of either workbench. The report may describe Data Wrangler as converting through Pandas only when a
public conversion prompt, backend label, or generated-code surface proves it. Otherwise it records
`sourceEngine=polars, workbenchEngine=unverified`. If no equivalent Data Wrangler Polars action appears before the
capability deadline, the result is undetermined. It is not evidence that the feature is unsupported, and the cell
stays release-incomplete rather than being replaced with a different workload.

## Fixed environment

- Official Microsoft VS Code, one exact version and Linux x64 build for every run, launched with `--locale=en`.
- Open Wrangler: the exact v1.2.1 release-candidate VSIX and SHA-256.
- Microsoft Data Wrangler: exact Marketplace version 1.24.2.
- One current-user-owned CPython 3.12 executable with pinned Pandas, Polars, PyArrow, Jupyter Core, and ipykernel.
- Both arms load the same `openwrangler-study.notebook-comparison-driver@1.0.0` test extension. It runs the public
  notebook journey and contains no Open Wrangler product code. Its VSIX carries a copy of the audited journey graph
  and the lockfile version of Playwright Core, so it does not load test code or packages from the repository. The
  packager reads the completed ZIP and requires exactly its manifest, extension entrypoint, journey modules,
  Playwright files, and the two VSIX metadata files. The manifest records that complete archive inventory, every
  journey-module hash, and every Playwright file hash. Installation uses a private read-only copy of the verified
  archive. The runner checks the source files, archive, and installed-extension inventory before and after each
  trial. After a restart it reopens the same files and checks them again; it never rebuilds the driver in the middle
  of a study. The source-graph check enumerates literal imports, limits them to reviewed roots and packages, scans for
  direct product markers, and hashes the exact packaged files. It is a review aid, not a JavaScript sandbox. The
  reviewed repository, compiler, Node, VS Code, and named packages are trusted inputs. The rest of the common
  inventory is Python 2026.4.0,
  Jupyter 2025.9.1, Debugpy 2026.6.0, Pylance 2026.3.1, Python Environments 1.36.0, Jupyter Keymap 1.1.2, Jupyter
  Renderers 1.3.0, Jupyter Cell Tags 0.1.9, and Jupyter Slideshow 0.1.6. Each arm adds exactly one measured product.
  Inventory is checked before and after every trial. The Data Wrangler arm must not load or activate
  `Matt17BR.openwrangler`.
- Separate disposable user-data and extension directories per product. Public first-use consent and runtime selection
  are completed in a configured-only template using tiny synthetic data; no extension storage is fabricated. The
  sealed editor profile names its product and template receipt, and pins its private user-data and extension
  directories. Cold runs must match that product's configured-only template; warm runs must match its warmed
  template.
- Telemetry, updates, repository discovery, workspace recommendations, and unrelated extensions are disabled.
- Headless Ozone only. The harness may not fall back to the current desktop, normal profiles, or user workspaces.
- One manifest-pinned CPU affinity, AC-power state, CPU governor set, display geometry, and zoom for the whole run.
  A ten-second gate before each product trial must show at most 10% mean non-idle CPU, no one-second window above 25%, CPU pressure
  `some avg10` at or below 1%, memory pressure `full avg10` equal to zero, and no swap-in/out or thermal-throttle
  increment. The first gate runs before either product action. If the second gate cannot pass within five minutes, the
  already-recorded first result is retained but the whole pair is marked environment-invalid; both products rerun
  under a new block ID. The shared heavy-command lease forbids concurrent Open Wrangler build, test, capture, or
  benchmark work.

The existing feasibility smoke established that the public workflow works with CPython 3.12. Data Wrangler 1.24.2
remained in its public connecting state under the tested Python 3.14 environment, so mixing those environments would
not be a fair comparison.

## Data and notebook setup

The fixture generator creates synthetic, redistributable sources with stable sentinels and exact schemas:

- a 100,000-row by 50-column CSV; and
- a 1,000,000-row by 20-column Parquet file.

Before preparation records either fixture, it runs the checked-in generator in an empty private directory and requires
the supplied CSV and Parquet files to match those generated bytes exactly. A CSV with different line endings or a
Parquet file with different compression or row groups is rejected even when it contains the same values. The Polars
contract then streams every cell and verifies the generator's `value = row + column` rule, dimensions, ordered schema,
and types. Every trial checks the fixture ID and SHA-256, stable file identity, and three sentinel cells. Once the environment gate passes, the
runner makes one byte-for-byte copy in that trial's private directory. The original fixture is never passed to either
product. The notebook, cache preparation, and both workbenches see only the copy.

The copy is created through pinned, no-follow file descriptors with mode `0600`. Its receipt contains the SHA-256 and
file identity of both the original and the copy, and the two inodes must differ. The runner checks that receipt again
immediately before it authorizes the product action. After the measured process tree is empty, it checks the original
and copy once more, records the same path-free receipt in the trial provenance, and removes only the exact copied
inode. If any identity is uncertain, it leaves the file in place for review. A restart after a recorded product action
does not create another copy or rerun the trial.

A private notebook loads the copied source into one named Pandas or Polars dataframe in an untimed setup cell. The
measured expression cell only evaluates that already-resident variable, isolating notebook preview latency from
CSV/Parquet parsing. A separate diagnostic duration records source loading, but it is not folded into the preview
comparison. Shape, exact Python type/module, fixture ID/hash, and three deterministic sentinels are verified in an
ordinary visible notebook cell before timing and again after the workbench closes. No local work data, pickle,
external network dataset, or user path is permitted.

## Readiness boundaries

### Inline output

Start immediately before the public **Run Cell** action. Stop only when the cell has completed and its visible output
is stable across two animation frames, exposes `c00`, `c01`, and the first two deterministic rows, is not busy or
obstructed, and the product's public launch action is visible and pointer-usable.

This boundary is deliberately described as an inline _surface_, not necessarily an extension-owned renderer. If
Data Wrangler adds only its launch action to a host/Jupyter dataframe rendering, the report must say so; that timing
must not be marketed as Data Wrangler rendering a custom preview. A control profile containing Python and Jupyter but
neither product establishes the host renderer's behavior. If a Polars output has no product-owned inline path before
the deadline, that capability is undetermined rather than a timing of generic Polars HTML.

The untimed Polars capability check records the complete extension inventory, English UI locale, and exact official
VS Code build. CSV and Parquet each get their own receipt, using that fixture's `study_frame` shape, schema hash, and
sentinels. The capture samples the ready notebook output and both products' exact accessible launch-action names once
per second for 30 seconds. An
available action must be unique and pointer-usable twice in succession. If the Data Wrangler action stays absent for
the full window, the receipt records `capability-timeout`; it does not infer unsupported. A separate capture without
either measured product must keep both actions absent under the same host/Jupyter output. These normalized traces are
part of the manifest rather than a self-reported availability flag. A timed-out capability leaves its scheduled cell
pending and prevents release completion until a public action is observed or separate reviewed public evidence
establishes that the surface is unsupported.

### Workbench open

Start on pointer activation of **Open in Open Wrangler** or **Open in Data Wrangler**. These actions follow the
[public Data Wrangler workflow](https://code.visualstudio.com/docs/datascience/data-wrangler), not a private command.
Stop when the newly selected custom/webview editor contains the expected grid/table, ordered sentinel headers and
cells, a non-busy state, stable geometry across two animation frames, and no visible Quick Input, dialog, modal, or
pointer obstruction. The grid must also report the full source shape. A public wheel or **Page Down** interaction must
change the visible row window, and a horizontal wheel interaction must change the visible column window. The timer
stops after those interactions settle and the grid is still pointer-usable. Creating a frame, returning from the
kernel, or painting a loading shell is not readiness. The harness returns to the first row before profiling. Failure
to open and scroll the live 100,000- or 1,000,000-row dataframe is a correctness failure, not a fast result.

### Complete column profiles

Start at the first public action that exposes the profiling or summary UI. Drive each product's public column
navigation in canonical schema order. For every integer fixture column `cNN`, require the final type, missing count of
zero, minimum `NN`, and maximum `rowCount - 1 + NN`; loading placeholders do not count as final. Exact distinct
evidence is either the integer `rowCount`, an unqualified exact `100%` field, or both. A visible approximation or
sampling label can finish the timing. It counts toward correctness only when its displayed confidence or error interval
contains `rowCount`. Record a displayed approximate point without an interval as `approximate-unqualified`. Exclude it
from the distinct-count check and the semantic-equivalence claim. Exact type, missing count, minimum, and maximum are
still required. Stop after every column has supplied its final profile. Record the first useful `c00` profile and
complete traversal relative both to profile activation and to the original workbench-open click. The
activation-relative measurements are the primary comparison. The workbench-click measurements remain descriptive
context for background work completed while the grid opens or scrolls.

The profile action follows a fixed immediate policy. After the workbench is ready and the first rows are restored, the
child requests the profile boundary. The parent confirms that PSS sampling is still active and acknowledges it
synchronously; it does not wait for another sample or for a five-sample stability window. The next child operation is
the public profile pointer action. After the trial, the result derives the five samples immediately before that
recorded pointer milestone and applies the same ten-second and stability rules used by the other segment baselines. A
missing or unstable pre-action window invalidates the resource result; it never delays the user-visible interaction.

This is an end-to-end public-UI comparison, not a private request benchmark. The final report must disclose that
Open Wrangler profiles progressively/on demand and whether Data Wrangler was observed to profile eagerly. Histograms
are not a common correctness oracle because products may use different sampling and binning. If profiles are exact in
one product and sampled or approximate in the other, retain both timings and disclose the mismatch in that cell's
result. If a product has no public way to establish completion for every column, report the limitation instead of
inventing a private completion signal.

## Sampling design

- Cover four cells: Pandas x CSV, Polars x CSV, Pandas x Parquet, and Polars x Parquet.
- Build one configured-only template per product after public first-use/runtime selection on tiny synthetic data. Derive
  one warmed template from it by completing a tiny-data preview -> workbench -> profile journey. Neither template
  contains a target variable, target-source cache, measured tab, or retained workbench session.
- Collect ten planned paired warm blocks per cell. One natural chained trial records inline preview, workbench open,
  first profile, and all-column completion, yielding ten observations for every required journey without resetting
  state between dependent milestones.
- Each measured warm trial starts a fresh official VS Code process, clone of the exact warmed template, and fresh
  kernel. There is no per-trial warm-up. No target variable or measured workbench survives from another trial.
- Use a fixed published seed to counterbalance product order so each product runs first exactly five times per cell.
  Interleave cells by repetition so thermal and time drift cannot consistently favor one engine or dataset.
- Prove the private copy's pages resident immediately before notebook setup for the primary warm study, then load the
  target dataframe in the untimed setup cell. The manifest pins the cache-controller bytes and the exact CPython
  executable, version, hash, and file identity used to run it. Each cache proof repeats those toolchain receipts and
  the copy's file identity before and after preparation. The plan command derives the toolchain receipts from the
  supplied files; it never trusts a receipt copied into the specification. Cache preparation executes the retained
  controller, interpreter, and private source through inherited descriptors, so renaming a path after the files are
  opened cannot switch any of the three inputs. Record one AB and one BA descriptive cold-source block per cell using
  fresh clones of the configured-only template. Those cold blocks prove page eviction on the copy
  immediately before a measured cell that loads and evaluates the dataframe, so their `loadAndPreviewMs` is
  deliberately different from the primary preloaded-variable `inlinePreviewMs`. They do not enter the ten-sample
  warm distribution. “Cold” describes target source pages, target variable, process, and kernel. It does not mean OS
  boot, package installation, or never-activated extensions. Package installation and dependency provisioning remain
  outside timing.
- Use fixed editor dimensions, zoom, theme, viewport, row-page size, and visible notebook/output layout.
- Apply predeclared 45-second inline, 60-second workbench, and 135-second complete-profile deadlines. Their 240-second
  total reserves 60 seconds inside the native editor phase's 300-second ceiling for setup, accepted baseline windows,
  row restoration, source verification, result publication, and controlled cleanup. The first useful profile is a
  milestone, not a separate timeout.

Keep every planned trial, block, order, and outcome. Do not trim slow samples or retry after a product action.

If the first product fails before its action, keep that fragment and skip the unmatched second run. Do not add a
placeholder. Start both products again under a new block ID. If the second product fails before its action, keep both
fragments and start both products again under a new block ID.

A timeout or error after the action is a result and is never replaced. Timing and memory summaries use successful
fragments only. The report still shows failure and timeout counts.

The immutable schedule and provenance digest are written before the first trial. Manifest, fragment, finalization
intent, and result files use private mode-`0700` directories and mode-`0600` files. Publication writes and syncs a new
file, links it into place without replacing an existing target, syncs the directory, removes the exact temporary link,
and syncs the directory again. A retry completes an exact two-link crash state by its independently known SHA-256. It
leaves an unlinked or ambiguous one-link temporary untouched. Readers keep one verified directory descriptor open
across each listing and every file read. `plan` and result publication keep that lease from recovery through final
publication; `record` keeps it through recovery, schedule validation, and fragment publication. The named directory is
checked again before the command returns. CLI specification and fragment inputs are also read through bounded
no-follow descriptors and checked against their named entries before and after the read. A renamed parent, symlink, or
replaced directory entry fails the command instead of mixing two ledger generations.

Every trial publishes one fragment after cleanup and input revalidation. The fragment directory is checked against a
fixed file-count and total-byte budget before any fragment is parsed. The final result is rebuilt from those raw
fragments and must match their hashes before publication. Finalization first publishes a small intent whose filename
contains the intent SHA-256. The intent binds a real UTC finalization time to the manifest and ordered fragment hashes.
A retry finds exactly one such intent, validates it against the current ledger, and rebuilds the same result. No intent
or output digest is accepted merely because it appears inside the file being recovered.

The runner also records each trial before it opens the editor. Immediately before the first measured public action,
it records a second entry and waits for that entry to reach disk. A shutdown before that authorization is safe to
retry. A shutdown after authorization without a result stops the study for review; the runner will not repeat a
possibly completed action.

An interrupted study resumes only missing schedule entries. It cannot overwrite an outcome or mix another candidate,
fixture, editor, environment, or method revision. Pair-level reruns append new correlated block IDs and retain the
invalidated pair. Retry the interrupted `plan`, `record`, or `finalize` command before running `status`; this supplies
the expected digest needed to settle a linked publication. If the laptop shuts down, the retained fragments still
identify the next scheduled trial.

The public runner adds one preparation receipt and one command to that ledger. Every public `comparison:*` command
holds the shared heavy-command lease for its complete process tree. `comparison:prepare` records the actual
candidate, official editor installation, CPython environment and kernelspec, fixtures, checked-in fixture generator and
contract, cache controller, neutral driver, and four sealed editor-profile trees. It gets the profiles by completing
each product's public setup and a separate untimed inline-to-workbench-to-profile warm-up. Those warm-ups use the same
durable, ordered request/acknowledgement bridge as measured trials; preparation must independently observe every
exchange and match it to the editor receipt. Extension inventory checks
run against disposable copies, so asking the VS Code CLI for an inventory cannot alter a sealed template. Preparation
then uses three more disposable clones to capture Data Wrangler's Polars action for both fixtures and a thirty-second
neither-product control from the real Jupyter UI. It accepts only an exact, pointer-usable action on a ready,
unobstructed output and fails if either capability is absent or ambiguous. The capability/control captures are untimed
setup evidence, not any of the 96 study samples. Their manifest claims are rebuilt from the raw phase records rather
than trusted as copied summaries. The preparation receipt is checked again before and after each trial, including the
Python package, kernelspec, and private Jupyter directory state.

`comparison:study -- run-next` reads the durable ledger and chooses its first pending entry. It clones the correct
configured-only or warmed profile, installs the verified neutral driver into that clone, and derives the notebook,
source-copy, request, acknowledgement, Jupyter, and editor paths itself. A successful run publishes one fragment,
proves terminal cleanup, and deletes that clone. A thrown or ownership-uncertain run leaves the clone in place and
publishes nothing. The unrecorded diagnostic calls this same path with a private scratch ledger; it cannot become a
second, easier measurement implementation.

Median and p95 use Hyndman-Fan type-7 interpolation. For ten ordered values, p95 is
`x9 + 0.55 * (x10 - x9)`. The raw JSON binds each observation to its block ID and includes the schedule seed, cache
proof, correctness status, and milestone times. Invalid observations use one fixed reason class. They do not include
raw logs or private paths.

## Memory

Each editor starts under the pinned Linux study supervisor. The manifest binds that supervisor to the same CPython
executable, patch version, and SHA-256 used by the notebook. Before launch, the supervisor verifies Linux
[child-subreaper](https://man7.org/linux/man-pages/man2/pr_set_child_subreaper.2const.html),
[`pidfd_open`](https://man7.org/linux/man-pages/man2/pidfd_open.2.html), and
[`pidfd_send_signal`](https://man7.org/linux/man-pages/man2/pidfd_send_signal.2.html) support. It launches one editor in
a new session and retains each process identity it observes. The subreaper adopts orphaned descendants, including
double-forked children, so they remain visible through the parent links in a full numeric
[`/proc`](https://www.kernel.org/doc/html/latest/filesystems/proc.html) census. The cleanup record combines the
supervisor's history with identities sampled for PSS, so a short-lived child seen by only one side is still accounted
for. This is process accounting for the cooperative measured applications, not a security sandbox. An incomplete
census, a reused PID, or a live process outside the recorded ownership closure invalidates the run.

Sample that owned tree every 200 ms before and throughout every journey. Read each PID's
`/proc/<pid>/smaps_rollup`, pin its `/proc/<pid>/stat` start time before and after the read, and sum proportional set
size once to avoid double-counting shared pages. Retain RSS as a diagnostic only. Classify every PID exactly once as
editor main, renderer/GPU, extension host, configured kernel, Open Wrangler runtime, or other owned child; category
PSS must sum to total PSS. The sampler uses
[`process.hrtime.bigint()`](https://nodejs.org/api/process.html#processhrtimebigint) for one monotonic clock origin shared
by its retained samples and milestones. The exact configured kernel must be observed by pinned executable, kernel ID,
and process start time before preview readiness; every publicly expected Open Wrangler runtime child must be observed
or its absence explicitly proven for the live-kernel path. A setup failure before the first product action may stop
before a kernel exists, but it still records and rechecks the editor process.

For every journey report ("maximum observed" means the largest retained 200 ms sample, not a true instantaneous peak):

- the baseline immediately before the measured cell and each next action: the median of five consecutive 200 ms
  samples whose range is at most the greater of 64 MiB or 5% of that median;
- maximum observed sampled editor-tree PSS for inline, workbench, profiling, and the complete trial;
- maximum-observed-minus-segment-baseline PSS deltas for the same segments;
- the same baseline, maximum observed sample, and sampled delta for editor main, renderer/GPU, extension host, configured kernel,
  Open Wrangler runtime, and other owned-child categories, including explicit zero-valued categories;
- the sampling interval, missed-sample count, and process-count range.

Memory sampling begins before the action and ends two seconds after profile completion. The trial allows three seconds
in total for `inlineActionMs`, the gap from inline readiness to the workbench action, and the gap from workbench
readiness to the profile action. The fixed cap is 1,228 samples: the three journey
deadlines, that control allowance, two-second quiescence, 250 ms terminal overshoot, and the inclusive origin sample at
the 200 ms interval. Cleanup is outside the latency boundary. The supervisor must reap the editor tree and publish its
terminal receipt; three consecutive full censuses must then find no owned process. The runner also records the first
empty 200 ms poll and one consecutive empty confirmation. A process seen after the first empty poll invalidates the
cleanup proof. Cleanup signals, when needed, use pidfds after rechecking the saved process start time.
PID reuse is retained as invalid evidence even when cleanup succeeds. If ownership cannot be settled, the runner stops
without publishing a fragment and leaves its private root for diagnosis. A missing `smaps_rollup`, process-identity
ambiguity, surviving process, or sampling gap invalidates the resource observation; the study may not fall back
silently to a less comparable number. Once the editor has launched, the fragment always keeps the ownership launch
receipt and either a valid or explicitly invalid resource observation, even if setup fails before the product action.
An undetermined capability never launches and therefore produces no fragment. A failed pre-launch environment gate
may omit process evidence. A fresh delegated cgroup's
`memory.peak` may be secondary evidence only; it is never added to PSS or used as the headline because it can include
charged page cache.

The sampler reads each process's `smaps_rollup` one after another. Those process values are therefore close in time,
not simultaneous, and a short-lived memory spike between 200 ms samples may be missed. Public results must say
"maximum observed sampled PSS" rather than "peak PSS."

The inline segment starts at its accepted pre-cell baseline and ends at inline readiness. The workbench segment starts
at the accepted five-sample baseline immediately before the launch click and ends at the first stable, selected,
unobstructed grid. The profile segment uses the five samples immediately before the recorded profile action, derived
from the completed observation after the action has run, and ends after complete traversal plus the two-second
quiescence. The complete-trial segment starts at the pre-cell baseline and ends with that same quiescence. Inline and
workbench baselines must satisfy the range rule before their actions. A missing or unstable derived profile baseline
invalidates the resource result instead of delaying the profile click or selecting a hand-picked lower value.

## Predeclared regression gate

For every successful warm pair and journey define `d_i = OW_i - DW_i` and `r_i = OW_i / DW_i`. The study triggers
investigation when at least seven of ten `d_i` values are positive, `median(r_i) >= 1.20`, and `median(d_i)` reaches the
journey's absolute threshold. The same first-profile and complete-profile durations measured from the original workbench
click are descriptive context; they do not add another regression gate. The absolute thresholds are:

- inline output: 500 ms;
- workbench open: 750 ms;
- first useful profile: 750 ms; or
- complete profiling: 2,000 ms.

Interpolated p95 is always reported but does not independently gate a ten-observation study. A product timeout is
right-censored at its deadline and reported as `>= deadline`, never substituted into `d_i` or `r_i`. Any Open Wrangler
timeout or correctness failure paired with a successful Data Wrangler trial is release-blocking. A run with fewer than
ten successful timed pairs in a cell is retained but is not release-complete; after the root cause is resolved, that
whole cell receives a new preregistered run ID rather than replacement samples. Memory uses the same formulas with
`OW_i` and `DW_i` equal to complete-trial maximum observed sampled PSS minus the pre-cell baseline; it triggers under the same seven-of-ten
and 1.20 rules when `median(d_i)` also exceeds 256 MiB. For any non-negative memory deltas `a=OW_i` and `b=DW_i`, the
ratio is `1` when both are zero, positive infinity when only `b` is zero, and `a / b` otherwise. Absolute PSS,
per-segment deltas, and per-category summaries remain reported diagnostics. These are materiality thresholds, not
targets or permission to ignore obvious correctness, hangs, UI jank, or runaway memory.

When a threshold is crossed, profile Open Wrangler using its own public candidate and internal development tools,
land a justified fix, invalidate every affected candidate sample, and rerun the complete matrix. Microsoft package
contents remain out of bounds. Final copy follows the evidence and must not claim universal superiority.

## Clean-room boundary

Allowed inputs are official documentation, the exact public Marketplace install, normal mouse/keyboard interaction,
public accessibility roles/names and visible text/geometry/state, ordinary notebook code, synthetic fixtures, neutral
editor setup APIs, and same-user observable process state.

The harness must not open, hash, unpack, or retain Data Wrangler package contents; inspect DevTools sources or source
maps; use private commands, context keys, messages, or implementation selectors; retain DOM dumps, proprietary assets,
private logs, or work data; or infer an internal engine from process behavior. A separate untimed isolated Xvfb smoke
must prove that the same public controls and rendered states exist. Timed zero-window results are reproducible relative
evidence on the pinned reference machine, not a promise of identical desktop latency.

## Publication

The final checked-in evidence includes:

- this reviewed methodology and its review record;
- an immutable study manifest and exact reproduction command;
- path-free machine/environment and extension provenance;
- raw machine-readable observations, failure counts, and summary statistics;
- concise tables/charts with limitations; and
- the final Open Wrangler candidate's ordinary performance and release gates.

The comparison is complete only when those artifacts land, any material Open Wrangler regressions are addressed or
explicitly justified, and issue #91 is closed before v1.2.1 is published.
