# Testing

Keep commands, prerequisites, fixtures, editor scenarios and responsibilities between test layers in this guide.
Detailed regression cases belong in their executable owners. Record exact boundaries here when they affect test
selection, qualification or safe execution.

Prefer the lowest-cost test that exercises the behavior. Keep a higher-level test only when it can catch a product,
package, runtime, or platform failure that a direct test cannot. Keep dedicated security and privacy tests for
credential redaction, no-follow identity checks, sealed artifacts, and exact output-path handoff. Do not keep fixture
or end-to-end tests merely to verify how another test runner, selector, or diagnostic path is wired.

Before adding operations to an installed journey, measure preparation, editor execution and cleanup separately and
review the remaining phase margin. Keep operation semantics in their source/generated-code owners when the installed
interaction adds no distinct coverage. Include execution and maintenance cost when proposing new test infrastructure.
Use the existing Playwright action timeout inside the longer harness guard; `Promise.race` alone can leave a pending
click able to dispatch after the caller times out.

Successful editor phases report elapsed time at result observation and after process shutdown, output closure and
result validation. Both use the phase's existing start clock, before launch. Outer dependency preparation, Docker work
and profile cleanup fall outside these measurements.

Run local released-Jupyter invocations one at a time on each host, waiting for cleanup before starting the next.
The [pinned Jupyter launcher](https://github.com/microsoft/vscode-jupyter/blob/fc61dfe2fd70a3d62d3ce0fef580757e7d64b81c/src/kernels/raw/launcher/kernelLauncher.node.ts)
checks ports before the kernel binds them and tracks selections only within one extension host. Separate profiles
therefore do not prevent concurrent invocations from choosing the same ports.

## Direct source checks

Complete [Clone and install](../CONTRIBUTING.md#clone-and-install), and use
[Python selection](../CONTRIBUTING.md#python-selection-for-repository-commands) for repository Python commands.
While iterating, run the smallest relevant owner:

```bash
npx --no-install vitest run src/test/configuration.unit.test.ts
node scripts/run-python.mjs -m pytest python/tests/test_engine_registry.py -q
node --test scripts/package-current-channel.test.mjs
```

The ordinary source suites are:

```bash
npm run test:scripts
npm run test:ts
npm run test:python
```

Vitest's DOM project runs `.test.tsx` files and the plain TypeScript clipboard, notebook-renderer and Code Preview
synchronization owners in jsdom. Other TypeScript owners run in Node. The projects share aliases and options in
[`vite.config.mts`](../vite.config.mts); only the DOM project loads the popover shim. The global four-worker limit
can be overridden with `--maxWorkers`. Keep browser-dependent owners in the DOM project. Native R cross-process
owners are selected by the R runner rather than the ordinary TypeScript suite.

Use these checks for changed static boundaries:

```bash
npm run format:check
npm run lint
npm run lint:python
npm run typecheck
npm run protocol:check
npm run reference:check
npm run docs:check
npm run brand:check
npm run check:remote-jupyter-lock
npm run check:r-dependency-lock
npm run license:check
```

`typecheck` checks the extension with Node module resolution, then the strict webview, shared and test program,
including dependency declarations. `npm run check` runs the static checks sequentially; `npm test` runs the three
source suites sequentially. `npm run check:pr` runs both. The release-candidate workflow starts from protected main
after these checks pass and does not repeat the source suites.

`test:scripts` runs the explicit Node test selection in [`package.json`](../package.json). The
[packaging owner](../scripts/package-current-channel.test.mjs) and
[archive owner](../scripts/vsix-archive.test.mjs) check source bindings, corruption refusal and owned cleanup.
The [R dependency-lock owner](../scripts/r-dependency-lock.test.mjs) checks the actual prepare CLI, cache identity,
archive validation and refusal before output publication with a controlled R receipt; it does not install packages.
The [CI proof owner](../scripts/ci-docs-only.test.mjs) uses real Git histories and executes the workflow guards.
Its exact scope and omission rules belong in [CI](ci.md#pull-requests), not individual test descriptions here.

The [daily-preview owner](../scripts/daily-preview-artifact.test.mjs) checks source decisions and actual change-note
ranges; the [publisher owner](../scripts/publish-github-stable-release.test.mjs) checks attribution, published-baseline
selection, frozen retry inputs and exact body/asset agreement. Publication retries must reuse the first attempt's
inputs rather than rediscovering release or PR metadata. Follow [Releasing](releasing.md) for artifact and publication
authority. `docs:check` permits incomplete capabilities in the stable-channel source ledger while validating its
canonical entries; the canonical artifact owners still refuse stable qualification with an incomplete required ledger.

For rendered webview UI, interactions, styles, browser fixtures, their generated content or screenshot changes, run
local browser acceptance. Install `python[dev]` through the setup above, then run:

```bash
npx --no-install playwright-core install chromium
npm run test:webview-acceptance
```

On supported Linux hosts missing browser libraries, first run
`npx --no-install playwright-core install-deps chromium`. The suite builds the webview, regenerates browser fixtures,
compares checked-in screenshots, and runs browser interaction and accessibility checks. It is local-only: `npm test`,
`check:pr`, hosted CI, scheduled workflows and release workflows do not invoke it. jsdom controls do not qualify native
layout or popup placement. The [Chromium interaction owner](../scripts/test-webview-accessibility.mjs) uses explicit
viewports and actual keyboard, pointer and focus behavior; Code Preview readiness observes the published editor and
visible code, because virtualized offscreen text need not exist in the DOM.

Use the existing owners to choose a focused source check:

- **Publication, recovery and persistence:** [response commitment](../src/test/sessionResponseCommitter.unit.test.ts),
  [coordinator persistence](../src/test/sessionCoordinator.persistence.unit.test.ts),
  [runtime restoration](../src/test/sessionRuntimeStateRestorer.unit.test.ts) and
  [panel publication](../src/test/webviewPanel.unit.test.ts) check confirmed state, queued or stale responses,
  failed saves, replay and exact session/renderer retirement. Initial saved-plan restoration stops further dispatch
  and fallback when its opening owner retires. Protocol admission and source lifetime rules remain in
  [Architecture](architecture.md#protocol-and-publication) and its linked runtime owners.
- **UI state and interactions:** [App draft state](../src/test/appDraftState.component.test.tsx),
  [operation forms](../src/test/operationBuilder.component.test.tsx),
  [progressive profiling](../src/test/appProgressiveProfiling.component.test.tsx) and
  [profiling lifecycle](../src/test/progressiveProfilingLifecycle.unit.test.tsx) check retained input, explicit repair,
  request correlation and effective-query cache ownership. [Grid clipboard](../src/test/gridClipboard.unit.test.ts)
  and [renderer lifecycle](../src/test/rendererPresentationLifecycle.unit.test.tsx) own focus and acknowledgement
  ordering. Browser acceptance supplies the native layout and interaction evidence.
- **Import and export boundaries:** [import detection](../src/test/importDetection.unit.test.ts) and
  [import options](../src/test/importOptions.unit.test.ts) own the bounded sample, decoding and dialect intent.
  [Native reader adaptation](../python/tests/test_empty_delimited_files.py) and the engine owners below check actual
  file rows, types, options and source bytes. [Pinned native exports](../python/tests/test_configurable_export.py) and
  [safe file export](../src/test/safeFileExport.unit.test.ts) use real files to check separate destinations, identity
  changes and cleanup. [R private artifacts](../src/test/rPrivateArtifactBoundary.unit.test.ts) check real reads,
  quarantine and zero-byte cleanup. Metadata identity checks do not detect every same-size content change.
- **Python engines and generated programs:** [Pandas](../python/tests/test_pandas_engine.py),
  [Polars](../python/tests/test_polars_engine.py) and [DuckDB](../python/tests/test_duckdb_engine.py) own native profiles,
  queries, source preservation and engine-specific evaluation bounds. [Operation edges](../python/tests/test_operation_edges.py),
  [Fill Missing](../python/tests/test_fill_missing.py) and the existing operation-specific owners compare complete
  live and generated results, types and indexes. [Session transactions](../python/tests/test_session_transactions.py)
  cover public Preview/Apply, history, refusal/correction, export and replay. Keep individual numeric, dtype and
  collision cases in those tests; supported behavior belongs in [engine boundaries](architecture.md#engine-boundaries-and-capabilities).
- **Generated source and Custom Code:** [helper selection](../python/tests/test_generated_helpers.py),
  [output columns](../python/tests/test_generated_output_columns.py),
  [Custom Code scope](../python/tests/test_custom_code_scope.py) and [session plans](../python/tests/test_session_plan.py)
  check complete executable programs, source-library and caller isolation, stable output binding, native result
  admission and emitted-byte limits. Adding an operation or helper requires live/generated agreement in every
  editing engine that supports it; a generated-text assertion alone is insufficient.
- **Notebook and process boundaries:** kernel, bridge and transport owners check correlated bounded framing,
  cancellation, execution settlement and cleanup of the original source owner. The
  [response-framing owner](../python/tests/test_response_framing.py) checks canonical bytes and size limits.
  Live protocol admission and saved-output normalization are separate contracts; legacy display compatibility does
  not admit an obsolete live runtime. See [notebook provenance](architecture.md#notebook-kernel-terminal-and-document-provenance)
  and [bounded transport](architecture.md#schemas-and-bounded-transport).

The existing kernel-runtime bootstrap owner executes generated Python to check fresh import, same-source reuse,
stale or partial imports, private-directory lifetime and refusal of substituted cache content. Bridge tests require
a bounded acknowledgment from the current attempt before dispatch, including missing, duplicate and mismatched
responses. Native Windows qualification must establish private-directory behavior; simulated version checks do not.
Installed restart probes observe the expected bundle's existing lease and package/agent origins without triggering
bootstrap. The bootstrap owner retains complete module-prefix validation.

Qualify changed native engine, reader and generated-code behavior on its minimum and current supported dependencies.
Keep native controls when versions differ: for example, newline-only Polars schemas may differ while preserving the
reader's actual rows. Extended-precision cases use the platform's real storage and may skip where it is unavailable.
Actual Windows local-drive tests do not qualify UNC/network shares; lexical checks or Linux skips are not Windows API
evidence. Spark Classic and Connect retain their own native bounded-viewing owners and prerequisites; local-engine
results do not qualify them. Support and release evidence remain governed by [feature parity](feature-parity.md).

The shared [`fixtures/view-literal-contract.json`](../fixtures/view-literal-contract.json) owns filter spellings
supported by Python and native R. Python-specific extreme offsets remain in Python owners because R retains its own
parser limits. Live and standalone comparisons use independently constructed native values rather than widening the
shared fixture to imply unsupported behavior.

For Native R changes, run the full contract suite or the relevant group:

```bash
npm run test:r-contract
npm run test:r-contract:frame-catalog-and-transport
node scripts/run-r-contract-tests.mjs --shard kernel-agent
npm run test:scripts:native
```

The [R runner](../scripts/run-r-contract-tests.mjs) separates frame/catalog/transport and kernel-agent checks. Each
group runs phases serially in fresh children. The full command first runs native process contracts.
[`test:scripts:native`](../scripts/run-r-contract-tests.native.test.mjs) selects Linux cancellation or Windows Job
Object behavior on the current platform; ordinary Source execution does not require this native owner. Nested Rscript
contracts fail on unexpected warnings even if they handle a later error. Preserve caller temporary-directory settings.

The [complete R catalog](../r/tests/complete_catalog_contract.R) compares native live and complete generated frames,
including source and metadata preservation. Numeric portability uses independent binary64 references and raw-bit
comparisons through interpreted and compiled programs. Frame, kernel, decoder and process owners separately check
primitive values, public mutations and correlated transport. Linux interactive transport controls use a real PTY;
portable parser controls retain one-expression and physical-line byte bounds. Operation semantics and arithmetic policy belong in
[the native R architecture contract](architecture.md#native-r); do not repeat the catalog in installed UI journeys.

Linux R phase supervision needs the selected repository Python 3.10–3.14 standard library and kernel pidfd support,
but no Python dataframe packages. Capability checks precede phase launch; signaling verifies the exact phase marker
and process identity. Native controls exercise SIGINT, SIGTERM, deadlines, output limits, closed readers, escalation
and detached descendants. An unverifiable live target leaves settlement unverified. macOS cancellation remains
unresolved in [#955](https://github.com/Matt17BR/openwrangler/issues/955); parent SIGKILL and runner crashes are outside
the shutdown guarantee.

Destination errors or cancellation stop later phases through verified cleanup. Successful phases drain output after
child settlement and before continuing, with normal backpressure. This does not bound exit when a reader remains
open without consuming output. Private Spark fixtures use the selected Python temporary directory for native Spark
storage and refuse comma-containing paths, which Spark treats as multiple roots. Keep the editor environment
allowlist and [failure-artifact rules](#failure-artifact-allowlist) intact.

`npm run test:extension-host` builds the development extension and runs persistence seed and verification in separate
editor processes sharing one private profile. Seed checks same-process close/reopen; verification checks persistence
after restart, rendered recovery and the remaining file/notebook interactions. Generic notebook verification uses a
fixture Jupyter API backed by real Python through the production bridge. Released Jupyter is qualified separately;
[`python-notebooks`](#focused-python-notebook-checks) is not the generic file-verification profile.

On POSIX, these runners keep temporary roots under the checkout's `tmp/ow`. The checkout and every temporary-path
ancestor must satisfy the [kernel temporary-directory rules](architecture.md#notebook-kernel-terminal-and-document-provenance).
Windows selects the original local user profile's `LOCALAPPDATA/Temp`, then places the isolated home, LocalAppData
and kernel Temp inside one disposable root there. Missing or non-local `LOCALAPPDATA` fails before editor startup;
the original profile must retain its normal per-user protections. A private child does not remove the ancestry
requirement. Existing process-settlement and root-identity checks govern cleanup, including files left by killed
fixture kernels.

The first generic Pandas notebook launch observes the unique new panel for its exact notebook and variable,
independently of focus. A terminal error from that panel's first open attempt fails the wait immediately with bounded
kind, code and recoverability diagnostics; an older panel or retry cannot satisfy it, and the reader cannot switch away
from a panel it has observed. Pending opens retain the existing 75-second deadline, and success must match the active
session to the observed panel's session.

The generic verification journey composes Formula then Custom Code in each editing engine, with Custom Code consuming
the Formula output. It compares Preview/Apply and complete code, then checks the plan, schema and bounded page after
runtime restart. It retains each engine's edited clipboard/export path, Pandas Save/cancel, source integrity and cleanup.
The separate Pandas duplicate/non-string structural journey composes Select, Clone, Drop and Rename, comparing full
values, physical labels, dtypes and indexes through generated replay and restart. Page replay comparisons exclude only
session-scoped row IDs. Individual operations and native arithmetic remain in their source/generated-code owners.

Ordinary installed R actions, picker acquisition, Explorer and editor-title file launches, and completed import-option
changes observe the exact session/revision and committed renderer receipt without forcing another panel publication.
[Picker source tests](../src/test/releasedROperationPicker.unit.test.ts)
check passive success, stale-receipt refusal and the shared ten-second acquisition budget; ordinary session acquisition
retains its existing thirty-second bound. Dedicated recovery injection, media setup and deliberately synthetic view
setup retain their explicit synchronization. A missing production publication must fail rather than be repaired by
the ordinary assertion path. Page assertions use the existing read-only request option so inspecting returned rows
does not replace the visible page or retire the renderer's view context. Requests that deliberately change the view
or exercise recovery keep their own mutation path.

The R value journey retains Find and Replace, Formula's visible precision refusal and correction, Format Datetime,
Capitalize and both dynamic Pivot forms. Repeated numeric and text catalog checks belong to native owners; remote
Lowercase remains a separate transport check. R restart scenarios open the editing session before committing the step
whose restart behavior they inspect and restore their prior notebook setting. Platform and other focused scenario
coverage remain described in [Native R editor dependencies](#native-r-editor-dependencies).

[Lazy activation tests](../src/test/lazyActivationOwners.unit.test.ts) own lifetime custom-editor, native-tree and Code
Preview registrations, exact resolution cancellation, rollback and once-only shutdown. The environment-gated test API
is acquired explicitly and refuses acquisition that outlives its activation owner. The existing daily-core journey
delays full API acquisition until its natural file title action, using a controlled profile without notebook or
visible-view demand; other journeys acquire the same API normally. This fixture does not assert that all activation
contexts have no demand-loaded owners.

The two pure acceptance-helper checks live in [Source](../src/test/acceptanceFixtures.unit.test.ts): bounded mismatch
diagnostics and direct-child temporary-directory ownership/cleanup. They no longer run during installed startup.
Source tests and the scenario descriptions above define ownership; actual installed qualification requires the
specified profile, platform and immutable artifact under the rules below.

## Pull-request CI

See [CI](ci.md#pull-requests) for required jobs, platform coverage and the proof that permits selected checks to be
omitted for independent changes. The local source equivalent is `npm run check:pr`; installed-editor checks use the
commands below.

## Failure-artifact allowlist

After editor and display ownership and private-root identity are verified, a failure artifact may contain only:

- Phase result and progress JSON.
- Selected `main.log`, `sharedprocess.log`, `renderer.log`, `notebook.rendering.log`, `exthost.log`, and Open Wrangler
  output-channel logs.
- A paths, types, and sizes-only profile manifest.
- Structured failure metadata.

The R collapse-frame journey records notebook display, toolbar selection submission and session-open completion
separately. Failure metadata reports the last stage reached when progress is read after shutdown. During the R editor
phase, the existing progress poll also logs changed, allowlisted fixture milestones with elapsed time from phase
launch. These include editing, the fixed collapse-frame opening stages, document execution and restart. Polling may miss
quick transitions; these observations are not a complete trace or exact operation durations. Windows retains its
metadata-only live progress reader. Fixed preparation, editor completion or failure, and profile-cleanup messages
distinguish setup and cleanup cost from editor execution. When needed, VS Code acquisition and private R dependency installation also report
their start and completion against the same preparation clock. Successful R installer processes also report bounded elapsed
records for core packages, supplemental packages and the macOS collapse source build. Each total includes downloads
and installation; it does not separate transfer from compilation. Other successful installer output is omitted.
These diagnostics preserve the existing inactivity and absolute phase deadlines.
If the public R-file command ends before its picker appears, the failed assertion includes up to eight visible
notifications from the existing bounded collector, each whitespace-normalized and capped at 1,000 characters. An
unavailable collection yields an empty list; the failure-artifact redaction rules still apply.

Jupyter output logs may be inspected only to derive a fixed failure category and are never copied. Raw profiles,
settings, workspace storage, databases, arbitrary extension logs, credentials, private keys, and user data are never
allowed. Collection and sealing use bounded no-follow, single-link, identity-pinned reads and repeat redaction. CI
uploads only the exact sealed path emitted through `GITHUB_OUTPUT`; it never uploads a staging directory or glob.

## Exact-artifact installed smoke

For a local or pull-request installed-editor smoke, build and verify one VSIX, then give that exact file first to the
declared minimum VS Code 1.106.0 and then to current stable VS Code:

```bash
npm ci --ignore-scripts
python -m pip install -e python
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

The broader platform smoke retains grouped median and linear interpolation as representative dynamic Fill forms,
including generated-code display, preview diffs, visible Apply/Undo, and source integrity. Uppercase retains visible
Discard and renderer restoration. Previous-value and most-common Fill variants remain covered by the
[form](../src/test/fillMissingFields.component.test.tsx) and
[native/generated-code](../python/tests/test_fill_missing.py) owners.

The broader platform smoke checks trusted-pickle publication, unchanged source bytes, worker cleanup, and opening
the converted Parquet file through the public command. The optional completion-notification action has a direct
command test; toast visibility is not the conversion-completion signal.
Windows CI also selects the two Windows-only cases in `python/tests/test_trusted_pickle_to_parquet.py`: Node/Win32
source identity agreement and actual helper Job Object containment of a spawned pickle descendant. Qualification
requires both cases to pass without skips.

The smoke catches production-bundle, VSIX-installation, public CSV action, grid rendering, sort, and terminal cleanup
failures that source tests cannot observe. It must not rebuild or substitute the VSIX after verification.

## Focused Python notebook checks

Kernel bridge and variable-discovery tests cover notebook preflight byte, output and item limits, malformed UTF-8
expansion, exact document replacement, fixed errors and execution settlement after cancellation or a host deadline.
Actual generated Python controls check quiet and noisy notebook-open paths before runtime dispatch.

The notebook formatter's wide-capture case retains a 501-column, 200-row source and uses a local 1,000-cell cap to
exercise full-width capture and row truncation. Dimension-budget tests retain production-limit checks and smaller
native boundary cases.

Released Pandas and DuckDB MIME checks inspect one completed cell execution. Missing MIME fails that execution;
later cell runs cannot satisfy the assertion. The remote readiness poller rejects authentication refusals and completed
invalid HTTP 200 responses promptly, while retaining bounded startup polling for transport interruptions and server errors.
Its direct source tests cover both expected kernelspecs, response bounds and cleanup.

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
npm run test:packaged-editors -- openwrangler.vsix
```

The selected Python needs the supported interpreter, `venv`, and `ensurepip`; dataframe packages are installed at the
declared compatibility versions in a private environment. Java and Spark are unnecessary for this profile. The
command rebuilds the test harness and installs the supplied product VSIX without rebuilding it.

This profile excludes PySpark, remote/coexistence, native R, and generic file/seed verification. Incompatible remote
or coexistence options are rejected. Leave the profile unset to run the complete default Python lane, including
PySpark and generic verification. Qualification coverage is determined by the selected lane, not by a focused pass.

## Native R editor dependencies

The `r-jupyter` notebook journeys prepare their reviewed package subset in a fresh private R library. They omit
`languageserver`, `rmarkdown`, and `knitr`; literate-documents journeys retain all three. The terminal journey disables
`r.lsp.enabled` in its private profile and omits `languageserver` and `knitr`. It retains the official R extension's
session watcher and nanoparquet for real Parquet export. It also omits rmarkdown, IRkernel, collapse and Rcpp because
the plain-R terminal fixtures do not render documents, start a Jupyter kernel or use collapse. This terminal sequence
does not exercise incidental language-server coexistence during discovery, replacement, editing and export; other
profiles retain the default LSP setting. The `value-operations`, `categorical-operations` and `pivot-wider` notebook
selectors also omit the collapse and Rcpp roots, collapse residents and their discovery assertions. They retain real
tibble/data.table residents and source-integrity checks. Default/core and other notebook profiles retain collapse,
including native flavor labels and unsupported grouped/indexed exclusions; literate preparation retains its structural
probe. Focused operation runs therefore do not repeat collapse coexistence coverage.
On macOS, selected collapse fixtures use the pinned source snapshot built with two make jobs.
Package pins remain in `scripts/jupyter-acceptance-environment.mjs`. Each selected root must resolve from the private
library at its reviewed version and load successfully before editor launch. Notebook and literate journeys also
require the exact private IRkernel readiness probe; terminal preparation creates no kernel or bootstrap receipt.
All editor purposes retain the exact native R executable and private library environment.

The hosted macOS R job installs Homebrew's current `zeromq` formula before private R preparation. IRkernel's
`pbdZMQ` dependency discovers that system library during its source build, avoiding bundled ZeroMQ compilation.
This system dependency follows Homebrew updates; the R package pins stay unchanged. Local preparation keeps
`pbdZMQ`'s default discovery and bundled fallback when no suitable system ZeroMQ is available.

The focused interactive-terminal journey installs the pinned official R and R-syntax extensions. It neither selects
a host Python interpreter nor installs the Jupyter extension; an inherited test Python override is cleared. It omits the
Quarto extension and CLI; the literate-documents journey retains both, including private Pandoc configuration and
native Quarto media preview checks. Tooling pins remain in `scripts/r-editor-acceptance-tooling.mjs`, and its selected
extension records drive installation and expected versions. The existing preparer selects dependencies by purpose,
including those three focused notebook selectors; omitting the purpose retains the full tooling subset.

The macOS and Windows R jobs first run `kernel:numeric-portability`, the same case included in the canonical
Linux kernel suite. It owns the platform-sensitive mean, decimal parsing, selection and generated-literal assertions
in `r/tests/kernel_agent_numeric_portability.R`. Broad operation, export, cold-process and dataframe-class matrices
remain in their existing source cases.

This focused case runs in one R process through the warning-strict wrapper, with a two-minute limit and bounded
output. Its synthetic fixtures and operations do not launch subprocesses; ordinary direct-child execution is sufficient
and does not qualify general process-tree cleanup. Preparation uses the existing private-library owner with pinned
jsonlite, bit64 and nanoparquet roots, including version and namespace checks. Any preparation or test failure retains
the private root; successful preparation and child exit permit its removal. The subsequent installed-editor journey
keeps its separate environment and lifetime. The separate R 4.4 qualification remains unchanged.

The macOS default is `platform-lifecycle`. It keeps a paging round trip, the Mark Duplicates form, compact
column reveal and focus, and Rename inspection, Edit, Undo/Redo, all-row exports, source
refusal, Save, clipboard and source-bound notebook insertion. Its editing sequence ends after verifying Rename Redo,
followed by source integrity checks and session disposal. The additional Undo after Redo runs in Linux
core to prepare for Drop Columns. The macOS profile also retains all three collapse-frame opens,
direct-document execution and kernel restart/recovery. The Linux core catalog retains the Dense Rank form,
Preview/Apply/Undo and three direct page samples for exact ranks, missing cells and row identities. The macOS profile
does not check the Dense Rank form and its native nullable integer result together. Both paths restore the first column
before Rename. The native kernel owner checks all original Mark Duplicates columns, and the real-process owner checks
complete page restoration after Undo for both operations. Requested code-insertion screenshots keep the same capture owner.
The Mark Duplicates Undo diagnostic combines session, scheduler and renderer snapshots with a bounded, passive
observation of that button's native input, relevant same-origin response categories and alert presence. It retains
no message payloads or alert text, and its listeners are removed after the action. An observed click establishes
input delivery, not host admission. The original click and 30-second wait remain unchanged; diagnostic reads and
cleanup have separate two-second limits.

The Linux comprehensive journey retains the broader operation catalog, final-page/last-column assertion, separate
native Viewing opens and both native-flavor operations. macOS omits the additional tibble Rename and keyed-data.table
Drop editing round; those class-specific semantics remain in the native R contracts, Linux comprehensive and Windows
representative journeys. Windows and Cursor retain their representative profiles. The editor phase has a 300-second
absolute deadline; preparation and cleanup add to total wall time.

`scripts/packaged-r-jupyter.test.mjs` checks actual prepared install/probe/record agreement, private environment
ownership and rejected inputs through the command seam without starting R. Package selection changes require fresh
supplied-VSIX execution of each distinct changed preparation and fixture path. Existing selectors may share one
representative when their package/probe inputs and setup/discovery behavior are identical, and their operation and
transport paths are unchanged; establish that from the executable owners. Also prove that unaffected profiles'
prepared install/probe inputs remain unchanged. Changes to shared pins or common notebook/literate selection require
notebook core and full tooling/literate qualification. Measure setup cost; graph size alone does not establish savings.

`src/test/releasedRTooling.unit.test.ts` checks the actual tooling assertions and focused journey routing, including
missing or mismatched extensions, commands and CLI configuration. Tooling selection changes require the affected
terminal or literate journeys against the same supplied VSIX, with both required for shared changes. Fewer selected
artifacts alone do not establish setup-time savings.

## Release-candidate checks

The release-candidate workflow packages the protected-main source once and retains one canonical VSIX, checksum, and
provenance triple. It does not repeat protected-main source checks. The candidate job:

1. Audits the published Node and Python dependencies.
2. Runs pinned VS Code installed-performance against the canonical triple.
3. Reverifies the triple and runs pinned Cursor `platform-smoke` against the same VSIX.
4. Reverifies and uploads only the canonical triple for stable promotion.

Stable publication uses this verified VSIX and does not rebuild it.

The optional [competitor comparison](performance-comparison.md) is archived; its `comparison:*` commands are no longer
available. Direct installed-performance, weekly runtime performance and Data Wrangler coexistence checks remain.

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
