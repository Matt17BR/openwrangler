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

Run local released-Jupyter invocations one at a time on each host, waiting for cleanup before starting the next.
The [pinned Jupyter launcher](https://github.com/microsoft/vscode-jupyter/blob/fc61dfe2fd70a3d62d3ce0fef580757e7d64b81c/src/kernels/raw/launcher/kernelLauncher.node.ts)
checks ports before the kernel binds them and tracks selections only within one extension host. Separate profiles
therefore do not prevent concurrent invocations from choosing the same ports.

## Direct source checks

Complete [Clone and install](../CONTRIBUTING.md#clone-and-install) for Node dependencies. For Python checks, complete
[Python development setup](../CONTRIBUTING.md#python-development-setup) and use
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

`fixtures/generated-code-plans.json` is the shared plan fixture for generated cleaning code: an 8-row typed source
table, one realistic step for every operation in catalog order, and several multi-step plans. The CSV in
`fixtures/generated-code-lookup/` backs the Look up columns plan. `python/tests/generated_code_test_support.py` builds the
source natively for Pandas, Polars and DuckDB, binds and runs plans live as a session does, runs generated code, and
checks the generated-code shape rules. `python/tests/test_generated_code_plans.py` runs every plan live on each engine,
Polars eager and lazy, and compares the generated result. Engine and R library size, family parity and shape tests use
this fixture instead of their own plan data.

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

Remote Jupyter fixture dependencies are pinned in `scripts/remote-jupyter/requirements*.in`. Use the exact uv version
declared in `scripts/remote-jupyter-lock.mjs` and run `npm run lock:remote-jupyter` to regenerate both hashed locks.
Keep the shared resolution cutoff fixed when applying a targeted security update; the existing per-package cutoffs
admit only the required newer releases. Verify clean regeneration with `npm run lock:remote-jupyter:check` and audit
both environments with `npm run audit:remote-jupyter`. These fixtures are not bundled with the extension.

`test:scripts` runs the explicit Node test selection in [`package.json`](../package.json), including the packaging,
archive, R dependency-lock, CI proof and release-publication owners. The R dependency-lock owner uses a controlled R
receipt and does not install packages. [CI](ci.md#pull-requests) owns the skip rules the CI proof owner checks, and
[Releasing](releasing.md) owns artifact and publication authority. `docs:check` permits incomplete capabilities in
the stable-channel source ledger while validating its canonical entries; the canonical artifact owners still refuse
stable qualification with an incomplete required ledger.

### Browser acceptance

For rendered webview UI, interactions, styles, browser fixtures, their generated content or screenshot changes, run
local browser acceptance. Install `python[dev]` through
[Python development setup](../CONTRIBUTING.md#python-development-setup), then run:

```bash
npx --no-install playwright-core install chromium
npm run test:webview-acceptance
```

On supported Linux hosts missing browser libraries, first run
`npx --no-install playwright-core install-deps chromium`. The suite builds the webview, regenerates browser fixtures,
compares checked-in screenshots, and runs browser interaction and accessibility checks. It is local-only: `npm test`,
`check:pr`, hosted CI, scheduled workflows and release workflows do not invoke it. jsdom controls do not qualify native
layout or popup placement.

The [Chromium interaction owner](../scripts/test-webview-accessibility.mjs) uses explicit viewports and actual
keyboard, pointer and focus behavior for the grid, column menus, operation forms, filter panel, inspection, mode help
and dependency recovery. Keep these constraints when changing browser checks:

- Code Preview readiness observes the published editor and visible code, because virtualized offscreen text need not
  exist in the DOM.
- Column menus must be placed without CSS anchor positioning and must change the screenshot pixels beneath them.
  VS Code 1.139's Chromium 150 lays out anchor-positioned menus without painting them, while the pinned Chromium
  paints them, so hit tests in the pinned browser cannot detect the problem.
- Screenshots that show profiles wait for completed profiles in every visible or partially visible column. A
  virtual-time advance alone does not establish that asynchronous profile batches have rendered. Find screenshots step
  through the real controls from DOM observation rather than timers.
- Screenshot verification reports all visual mismatches after capturing the remaining images. Browser, readiness and
  invalid-image errors still stop the run immediately; any mismatch fails verification before accessibility checks run.

### Shared contract fixtures

The shared [`fixtures/view-literal-contract.json`](../fixtures/view-literal-contract.json) owns filter spellings
supported by Python and native R. Python-specific extreme offsets remain in Python owners because R retains its own
parser limits. Live and standalone comparisons use independently constructed native values rather than widening the
shared fixture to imply unsupported behavior.

The shared [`fixtures/convert-type-contract.json`](../fixtures/convert-type-contract.json) owns the Convert Type
source and target matrix and its value cases. `src/test/convertType.unit.test.ts`,
`python/tests/test_convert_type_contract.py` and the native-R frame and kernel contracts check every case in live and
generated execution.

The shared [`fixtures/duration-text-contract.json`](../fixtures/duration-text-contract.json) owns duration text,
including negative, sub-microsecond and missing values. `python/tests/test_duration_text_contract.py` checks the grid
and CSV export of Pandas, Polars and DuckDB, which holds whole microseconds; the native-R capture-and-export contract
checks every difftime unit.

The shared [`fixtures/replace-portability-contract.json`](../fixtures/replace-portability-contract.json) decides which
Replace steps replay on both Python and R. `src/test/findReplaceStep.unit.test.ts`,
`python/tests/test_replace_matches.py` and the native-R catalog contract each check every case.

### Test owners

Use these owners to choose a focused source check:

- **Applied-step inspection:** [Python inspection](../python/tests/test_step_inspection.py) and
  [native R transport](../src/test/rKernelTransport.cross.test.ts).
- **Value and profile actions:** [filter panel](../src/test/filterPanel.component.test.tsx),
  [filter summaries](../src/test/filterSummary.component.test.tsx) and the response validator. Native value
  production belongs in the typed-cell and engine owners.
- **Publication, recovery and persistence:** [response commitment](../src/test/sessionResponseCommitter.unit.test.ts),
  [coordinator persistence](../src/test/sessionCoordinator.persistence.unit.test.ts),
  [runtime restoration](../src/test/sessionRuntimeStateRestorer.unit.test.ts),
  [panel publication](../src/test/webviewPanel.unit.test.ts),
  [plan rewrites](../src/test/sessionCoordinator.planRewrite.unit.test.ts),
  [persistence store](../src/test/sessionPersistenceStore.unit.test.ts) and
  [file commands](../src/test/fileOpen.unit.test.ts). Native R plan reuse also runs through the real managed-process
  owner. See [protocol and publication](architecture.md#protocol-and-publication) for the live contract.
- **UI state and interactions:** [App draft state](../src/test/appDraftState.component.test.tsx),
  [operation forms](../src/test/operationBuilder.component.test.tsx),
  [progressive profiling](../src/test/appProgressiveProfiling.component.test.tsx),
  [profiling lifecycle](../src/test/progressiveProfilingLifecycle.unit.test.tsx),
  [grid clipboard](../src/test/gridClipboard.unit.test.ts) and
  [renderer lifecycle](../src/test/rendererPresentationLifecycle.unit.test.tsx). Browser acceptance supplies native
  layout and interaction evidence.
- **Python dependency admission:** [native package provenance](../src/test/pythonDependencyPep440.unit.test.ts),
  [guard checks](../python/tests/test_dependency_guard_exact_version.py),
  [process ownership](../src/test/dependencyInstaller.unit.test.ts) and
  [probe caching](../src/test/pythonDependencyState.unit.test.ts).
- **R file dependency repair:** [kernel dependency checks](../src/test/rKernelTransport.unit.test.ts),
  [managed process](../src/test/rProcessTransport.cross.test.ts), [bridge](../src/test/rKernelBridge.unit.test.ts),
  [coordinator](../src/test/sessionCoordinator.unit.test.ts) and
  [dependency process](../src/test/rDependencyProcess.unit.test.ts) controls. Verify actual installation separately in
  a disposable library, never a user's library; source checks and manual-availability recovery alone do not establish
  successful installation.
- **Import and export:** [import detection](../src/test/importDetection.unit.test.ts),
  [import options](../src/test/importOptions.unit.test.ts),
  [engine switching](../src/test/sessionCoordinator.engineSwitch.unit.test.ts),
  [native reader adaptation](../python/tests/test_empty_delimited_files.py),
  [pinned exports](../python/tests/test_configurable_export.py),
  [safe file export](../src/test/safeFileExport.unit.test.ts),
  [R private artifacts](../src/test/rPrivateArtifactBoundary.unit.test.ts) and
  [Windows export pins](../python/tests/test_export_target.py). Native R exports belong in the
  [frame owner's](../r/tests/frame_contract.R) `capture-and-export` case and the
  [kernel owner's](../r/tests/kernel_agent.R) `group-pivot-and-export` case, CSV and TSV loading in its `csv-import`
  case, and Parquet, JSONL and Excel in `lifecycle-and-structure`. Metadata identity does not detect every same-size
  content change. Symlink cases attempt real symlinks; a recognized Windows setup refusal is a skip, not passing
  protection evidence.
- **Python engines:** [Pandas](../python/tests/test_pandas_engine.py), [Polars](../python/tests/test_polars_engine.py)
  and [DuckDB](../python/tests/test_duckdb_engine.py) own native profiles, queries, captures, exact types, source
  preservation and evaluation bounds. [Profile consistency](../python/tests/test_profile_consistency.py),
  [session binding](../python/tests/test_session_column_binding.py),
  [operation edges](../python/tests/test_operation_edges.py), [Fill Missing](../python/tests/test_fill_missing.py),
  [session transactions](../python/tests/test_session_transactions.py),
  [typed cells](../python/tests/test_typed_cells.py) and [filter logic](../python/tests/test_filter_logic.py) compare
  behavior across engines and with generated code. New operations also need shared request and form checks for bounds
  and engine availability; supported behavior belongs in
  [engine boundaries](architecture.md#engine-boundaries-and-capabilities). Keep unsafe native fixtures out of these
  tests: inspect dtype metadata on safe frames instead of constructing unsupported Object-containing Polars lists,
  whose cleanup can panic, and use contiguous slices for expected missing Sparse durations, because native fill-aware
  row taking can corrupt multiplied `NaT` values on supported older NumPy.
- **Generated source and Custom Code:** [helper selection](../python/tests/test_generated_helpers.py),
  [output columns](../python/tests/test_generated_output_columns.py),
  [Custom Code scope](../python/tests/test_custom_code_scope.py) and [session plans](../python/tests/test_session_plan.py).
  An operation or helper change requires live/generated agreement in every editing engine that supports it;
  generated-text assertions alone are insufficient.
- **Notebook and process boundaries:** kernel, bridge and transport owners;
  [R discovery](../src/test/rNotebookVariableDiscovery.unit.test.ts),
  [response framing](../python/tests/test_response_framing.py) and the real
  [stdio server](../python/tests/test_server_protocol.py). The native R cases run only in the R runner's kernel phase.
  The kernel-runtime bootstrap owner executes generated Python for fresh import, reuse and substituted cache content;
  native Windows qualification must establish private-directory behavior. Live protocol admission and saved-output
  compatibility are separate contracts; see
  [notebook provenance](architecture.md#notebook-kernel-terminal-and-document-provenance) and
  [bounded transport](architecture.md#schemas-and-bounded-transport).
- **Spark:** the [lazy-index and close unit](../python/tests/test_pyspark_engine.py), native
  [paging](../python/tests/test_pyspark_paging.py) and
  [session lifecycle](../python/tests/test_pyspark_session_lifecycle.py) owners keep Classic and Connect checks.
- **Activation and file selection:** [lazy activation](../src/test/lazyActivationOwners.unit.test.ts) owns
  registrations, cancellation and shutdown. The file-command, custom-editor, Python resolver, PythonBridge and
  coordinator owners cover fresh-file Auto selection. The pure acceptance helpers run in
  [Source](../src/test/acceptanceFixtures.unit.test.ts), not during installed startup.

Qualify changed native engine, reader and generated-code behavior on its minimum and current supported dependencies.
Keep native controls when versions differ: for example, newline-only Polars schemas may differ while preserving the
reader's actual rows. Extended-precision cases use the platform's real storage and may skip where it is unavailable.
Actual Windows local-drive tests do not qualify UNC/network shares; lexical checks or Linux skips are not Windows API
evidence. Spark Classic and Connect retain their own native bounded-viewing owners and prerequisites; local-engine
results do not qualify them. Support and release evidence remain governed by [feature parity](feature-parity.md).

The runtime benchmark's three backend smoke checks take nine page samples, enough to exceed the eight-entry cache, and
five fresh opens per format; their timings are diagnostics. Ordinary and strict runs take 20 page samples. Strict runs
require a same-session page sent during an active header-statistics call to return within 500 ms.
[Session concurrency tests](../python/tests/test_session_concurrency.py) prove page progress during a held profile,
and the [fixture owner tests](../python/tests/test_installed_editor_fixtures.py) cover the shared benchmark fixture.

### Native R

For Native R changes, run the full contract suite or the relevant group:

```bash
npm run test:r-contract
npm run test:r-contract:frame-catalog-and-transport
node scripts/run-r-contract-tests.mjs --shard kernel-agent
npm run test:scripts:native
```

The [R runner](../scripts/run-r-contract-tests.mjs) separates frame/catalog/transport and kernel-agent checks. Each
group runs phases serially in fresh children. The full command first runs native process contracts.
[`test:scripts:native`](../scripts/run-r-contract-tests.native.test.mjs) selects native Linux/macOS cancellation or Windows Job
Object behavior on the current platform; ordinary Source execution does not require this native owner. Nested Rscript
contracts fail on unexpected warnings even if they handle a later error. Preserve caller temporary-directory settings.

Prerequisites and limits:

- Linux R phase supervision needs the selected repository Python 3.10 to 3.14 standard library and kernel pidfd
  support, but no Python dataframe packages.
- On macOS, the runner compiles one private native helper per invocation using `/usr/bin/xcrun clang`, so the Xcode
  Command Line Tools must be installed.
- Windows Job Object containment and termination, and the bundled supervisor's framing checks, need actual Windows; a
  skipped Linux run establishes no Windows behavior. The supervisor lives at
  `r/openwrangler_runtime/windows-job-supervisor.ps1` and is shared with native R file sessions.
- Discovery relies on inherited markers and observed ancestry, so it cannot contain an entirely unobserved,
  marker-stripped chain. Parent SIGKILL and runner crashes are an accepted source-test limitation, recorded in
  [#955](https://github.com/Matt17BR/openwrangler/issues/955).
- Private Spark fixtures use the selected Python temporary directory and refuse comma-containing paths, which Spark
  treats as multiple roots.

The [complete R catalog](../r/tests/complete_catalog_contract.R) compares native live and complete generated frames,
including source and metadata preservation, for base R, dplyr, data.table and collapse. Every supported catalog
operation needs live/generated agreement in each library, with expected values and unchanged source, and generated
programs must resolve their own emitted helpers and dependencies. Do not repeat unrelated large fixtures or installed
catalog journeys once for every library, and measure the added catalog cost against the existing phase deadline.
Numeric portability uses independent binary64 references and raw-bit comparisons. Installed evidence must exercise
the visible library choice; source mocks alone do not prove that the selected package executes.

The [frame](../r/tests/frame_contract.R), [kernel](../r/tests/kernel_agent.R),
[kernel viewing](../r/tests/kernel_agent_viewing.R), [kernel transport](../src/test/rKernelTransport.cross.test.ts),
[process transport](../src/test/rProcessTransport.unit.test.ts) and
[interactive transport](../src/test/rInteractiveSessionTransport.unit.test.ts) owners check primitive values, public
mutations and correlated transport. Generated programs in the transport suite run in a second clean process, so
runtime helpers cannot satisfy their dependencies. Measure queued-page latency, setup, finalization, total work and
retained memory separately; a chunk budget alone does not prove responsiveness. These source controls and the plain-R
installed journey do not qualify radian's parser or terminal interaction. Operation semantics and arithmetic policy
belong in [the native R architecture contract](architecture.md#native-r).

### Extension-host and installed journeys

`npm run test:extension-host` builds the development extension and runs persistence seed and verification in separate
editor processes sharing one private profile. Seed checks same-process close/reopen; verification checks persistence
after restart, rendered recovery and the remaining file/notebook interactions. Generic notebook verification uses a
fixture Jupyter API backed by real Python through the production bridge. Released Jupyter is qualified separately;
[`python-notebooks`](#focused-python-notebook-checks) is not the generic file-verification profile.

On POSIX, these runners use the inherited system temporary directory when its canonical ancestry satisfies the
[kernel temporary-directory rules](architecture.md#notebook-kernel-terminal-and-document-provenance), otherwise a
protected `/tmp`. If neither parent is safe, preparation fails before editor startup. Windows selects the original
local user profile's `LOCALAPPDATA/Temp` and places the isolated home, LocalAppData and kernel Temp inside one
disposable root there; a missing or non-local `LOCALAPPDATA` fails before editor startup. Runner roots remain private
and independent of checkout permissions. The packaged file-input fixture directory stays under the outer root until
editor processes and captured output have settled, so a failed verifier cannot remove a source its viewer still uses.

Installed journeys follow these synchronization rules:

- Installed R actions, file launches, import-option changes and gallery Apply/Undo observe the exact session,
  revision and committed renderer receipt instead of forcing another panel publication. A missing production publication must fail rather than be repaired by the assertion path.
- Once acquired, Add and Edit operation dialogs keep their physical node, frame, session and revision, so a
  replacement dialog or changed revision cannot satisfy the old locator.
- Page assertions use the read-only request option, so inspecting returned rows does not replace the visible page or
  retire the renderer's view context.
- [Picker source tests](../src/test/releasedROperationPicker.unit.test.ts) check the shared ten-second acquisition
  budget; ordinary session acquisition keeps its thirty-second bound.
- Released-Jupyter Variables actions check that the manifest routes the variable's type to
  `openWrangler.launchDataViewer`, then invoke that command with the flat variable object Jupyter passes to
  contributed viewers. They do not drive Jupyter's own Variables webview.

The generic verification journey composes Formula then Custom Code in each editing engine and checks the plan, schema
and page after runtime restart; a separate Pandas journey composes Select, Clone, Drop and Rename over duplicate and
non-string labels. Generic viewing-query verification and dependency recovery each use a private copy of the sample
CSV, so neither inherits the seeded cleaning history. The local Linux VS Code Clone lifecycle switches a live R tab to
dplyr and back, and switches a Python · Polars CSV tab to R · base and back, so the installed editor covers each
engine-switch direction. The daily-core journey also applies a Rename and uses **Open Another File with This Plan**
through the real file picker. The R value journey keeps Find and Replace, Formula's precision refusal, Format
Datetime, Capitalize and both dynamic Pivot forms; repeated numeric and text checks belong to native owners.

The `r-jupyter` and `data-wrangler-coexistence` modes skip the generic smoke profile's fixture and extension
installation. They retain editor-version discovery, the shared harness package and exact installed-version checks.

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

R dependency repair may report bounded package-check and installation failures. Do not add complete installer or
terminal output, private package-library contents or user data to failure uploads.

The runner's progress poll logs fixed, allowlisted milestones with elapsed time from phase launch, such as the R
collapse-frame opening stages, document execution and restart, each generic viewing-query request, and preparation,
installation and cleanup stages. Failure metadata reports the last collapse-frame stage reached. Polling can miss
quick transitions, so these are sampled milestones, not exact durations. A new stage resets the 180-second
inactivity deadline; the 300-second absolute deadline still bounds the phase.

Failure diagnostics add only these bounded observations:

- The damaged-file Import options check appends its last 32 focus events, with fixed fields and no DOM text, values,
  URLs or class names.
- If the public R-file command ends before its picker appears, the failure includes up to eight visible
  notifications, each whitespace-normalized and capped at 1,000 characters.
- The Mark Duplicates Undo diagnostic records session, scheduler and renderer snapshots, the button's native input,
  response categories and alert presence, without message payloads or alert text.
- Returned Apply errors write a known error code or `other`, recoverability, the requested revision and whether the
  response session matched to the Open Wrangler output channel. The Polars Formula Apply checks add bounded host and
  renderer state to timeouts, without cell values, generated code or alert text.

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

The smoke catches production-bundle, VSIX-installation, public CSV action, side bar reveal, grid rendering, sort, and
terminal cleanup failures that source tests cannot observe. It must not rebuild or substitute the VSIX after
verification.

Both the daily-core and broader platform smokes finish with the
[default-editor journey](../src/test/extensionHost/packagedDefaultEditors.ts). With no `workbench.editorAssociations`
in any scope, `.parquet`, `.xlsx` and `.xls` files open in an `openWrangler.viewer` tab with a session, while `.csv`
opens in the text editor, and so does Parquet after the journey sets `"*.parquet": "default"`.
[Manifest tests](../src/test/packageManifest.unit.test.ts) pin each pattern's editor and priority. The broader platform
smoke also checks the gallery row by exact extension ID with a loaded icon, representative dynamic Fill forms,
Uppercase Discard, and trusted-pickle conversion to Parquet. Windows CI also selects the two Windows-only cases in
`python/tests/test_trusted_pickle_to_parquet.py`, which must pass without skips.

For Linux public file-gallery captures, use the same verified VSIX and compiled harness with
`OPEN_WRANGLER_PACKAGED_MODE=platform-smoke`, `OPEN_WRANGLER_TEST_SELECTOR=public-media` and
`OPEN_WRANGLER_CAPTURE_EDITOR_SCREENSHOTS` set to an absolute output directory. This runs the existing file-launch
and gallery journeys without the unrelated functional and dependency-installation journeys. It does not replace
platform smoke or release qualification. Browser acceptance owns light-theme rendering.

## Focused Python notebook checks

For Python notebook changes, the `python-notebooks` profile runs the existing released-Jupyter deny/allow journeys
against a supplied VSIX. It covers Pandas, Polars, DuckDB, kernel recovery, the Python editor action, and source-cell
discovery. The profile has been verified in VS Code on Linux.

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

For hosted Python and file-input investigations, manually select `linux-python` in the released-Jupyter workflow.
It first runs `python-notebooks`, then runs full mode with released Jupyter disabled and the profile unset, keeping
restricted-trust, seed and generic verification, including the database picker. Both use the same VSIX; failure in
the first stops the second. Spark provisioning and remote Jupyter are omitted. See
[CI](ci.md#scheduled-and-release-workflows) for selection and qualification boundaries.

## Native R editor dependencies

For a hosted R investigation, manually select `linux-r` in the released-Jupyter workflow. It retains all four R
invocations and skips the generic Python/file-input editor invocation. See [CI](ci.md#scheduled-and-release-workflows)
for the unchanged setup and qualification requirements.

Every journey prepares its reviewed package subset in a fresh private R library, and each selected root must resolve
from that library at its reviewed version and load before editor launch. Package pins live in
`scripts/jupyter-acceptance-environment.mjs` and editor tooling pins in `scripts/r-editor-acceptance-tooling.mjs`.
Editor libraries include Arrow and clock, and Windows notebook and core preparation add readxl and nanoparquet for
their file inputs. These are installed in the private library, not bundled in the VSIX; CSV-only product use does
not require Arrow or clock. The selections differ by journey:

- Notebook journeys omit `languageserver`, `rmarkdown` and `knitr`; the literate-documents journey keeps all three,
  plus the Quarto extension and CLI. Notebook and literate journeys also require the private IRkernel readiness probe.
- The terminal journey disables `r.lsp.enabled`, installs only the official R and R-syntax extensions, and omits the
  Jupyter extension, `languageserver`, `knitr`, `rmarkdown`, IRkernel, collapse and Rcpp. It keeps Arrow for real
  Parquet export. It does not exercise language-server coexistence; other profiles keep the default LSP setting.
- The `value-operations`, `categorical-operations` and `pivot-wider` selectors omit collapse and Rcpp. Default/core and
  other notebook profiles keep collapse, including native flavor labels for grouped and indexed collapse frames.
- Local Linux VS Code default/core preparation also includes dplyr for its library-switch check.

Platform preparation:

- On macOS, selected collapse fixtures use the exact CRAN 2.1.8 binary for R 4.5.2 on `aarch64-apple-darwin20`, with
  its pinned size and SHA-256 verified before installation. Other macOS R versions and platforms build the pinned
  2.1.7 source. The hosted macOS job installs Homebrew's `zeromq` so IRkernel's `pbdZMQ` build finds a system
  library.
- On Ubuntu 24.04 and 26.04, preparation selects the matching Noble or Resolute snapshot and sends the R version and
  architecture in its HTTP user agent, so the package server supplies binaries where it has them; see
  [Posit's binary configuration guide](https://docs.posit.co/rspm/admin/serving-binaries/). Other distributions use
  the dated source repositories. Source builds allow two make jobs per package, and installation stays sequential.
- Artifact acquisition refuses an existing destination and verifies the file it created. A replaced file or
  directory withholds cleanup.

The macOS and Windows R jobs first run `kernel:numeric-portability` and `kernel:csv-import` serially in separate
warning-strict R processes, each with a two-minute limit and bounded output, subject to the
[renderer source omission](ci.md#pull-requests). They share one private library with pinned jsonlite and bit64. Any
preparation or test failure retains the private root. Broad operation, export, cold-process and dataframe-class
matrices remain in the Linux source cases.

The platform journeys differ in scope:

- The macOS default, `platform-lifecycle`, keeps a paging round trip, the Mark Duplicates form, compact column reveal
  and focus, Rename inspection, Edit, Undo/Redo, all-row exports, source refusal, Save, clipboard and source-bound
  notebook insertion, all three collapse-frame opens, direct-document execution and kernel restart.
- The macOS managed-document stage and the Windows file stage open the same 240-row CSV through the public file
  command with temporary R selection. They check header statistics, Rename Preview/Apply, the generated file read,
  all-row CSV export and source-destination refusal, then restore the setting and check cleanup. The Windows branch
  also checks Undo/Redo, persisted reopening, a failed Custom preview, a CP1252 CSV through the public import
  controls, and the Parquet, JSONL, XLSX and BIFF fixtures. The Windows desktop VS Code default also opens the
  three ordinary collapse fixtures.
- The ordinary Linux comprehensive journey keeps the broader operation catalog, the final-page and last-column
  checks, separate native Viewing opens, and a tibble Rename and keyed data.table Drop, each followed by Discard. On
  Linux VS Code, the optional `native-frames` selector runs both operations on both flavors.

The editor phase has a 300-second absolute deadline; preparation and cleanup add to total wall time.

`scripts/packaged-r-jupyter.test.mjs` checks prepared install/probe/record agreement, private environment ownership and
rejected inputs through the command seam without starting R. Package selection changes require fresh supplied-VSIX
execution of each distinct changed preparation and fixture path. Existing selectors may share one representative when
their package/probe inputs, setup and discovery behavior, and operation and transport paths are identical; establish
that from the executable owners. Also prove that unaffected profiles' prepared install/probe inputs remain unchanged.
Changes to shared pins or common notebook/literate selection require notebook core and full tooling/literate
qualification.

`src/test/releasedRTooling.unit.test.ts` checks the tooling assertions and focused journey routing. Tooling selection
changes require the affected terminal or literate journeys against the same supplied VSIX, with both required for
shared changes. Measure setup cost; fewer selected packages or artifacts alone do not establish savings.

## Release-candidate checks

The release-candidate workflow packages the protected-main source once and retains one canonical VSIX, checksum, and
provenance triple. It does not repeat protected-main source checks. The candidate job:

1. Audits the published Node and Python dependencies.
2. Runs pinned VS Code installed-performance against the canonical triple.
3. Runs pinned Cursor `platform-smoke` against the same VSIX.
4. Uploads only the canonical triple for stable promotion.

A dependent three-platform R matrix downloads that same-run triple, verifies it against the exact checkout, builds
only the test harness and runs default `r-jupyter` in desktop VS Code once per platform. No focused selector replaces
the default. The matrix adds no source suite, Java, Spark or development dataframe environment. The runner logs the
validated editor version and prepared R package versions.

All three results are required. Failure diagnostics use only the runner's exact sealed artifact path; a successful
workflow still uploads exactly one canonical triple. Stable publication checks the whole first-attempt candidate run
and uses that VSIX without rebuilding.

These candidate checks complement the native/source evidence and reliability review required by
[Releasing](releasing.md#release-candidate) for the [stable R notebook scope](feature-parity.md#first-stable-r-notebook-scope).
Keep original failures, package identity, source-preservation assertions and existing time and
cleanup bounds; do not add an installed copy of the complete native operation catalog.

The weekly [runtime performance workflow](../.github/workflows/performance.yml) checks Polars runtime performance.
The installed `data-wrangler-coexistence` journey checks notebook preview-provider choices with both extensions
active; it does not measure comparative performance.

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
raw dataframe result appears. It then checks that the result gains its action without another execution. Native R
notebook journeys keep discovery disabled during kernel probing and enable it before the setup cell whose completion
requests consent.

Do not retain a second end-to-end journey for behavior already covered by the exact-artifact smoke or a direct source
test. Do not retry deterministic failures; fix the product or remove a check that cannot identify a distinct failure.
