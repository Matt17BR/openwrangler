# CI and release checks

## Pull requests

Every pull request reports the same five required product checks:

- **Source contracts (Node 24)** runs formatting, lint, TypeScript source and dependency declaration checks, generated
  protocol/reference checks, documentation checks, dependency-lock checks, licenses, `npm run test:scripts`, and Vitest.
  Lint, Node 24 type checking and Vitest follow the documentation-only scope below.
  It then builds the same checkout with Node 22.17.0 against the already-installed locked dependencies.
- **Python runtime contracts** runs Ruff, Pyright, and Pytest with the declared Python dependencies. Native PySpark
  checks follow the narrow local-engine omission below.
- **Native R frame, kernel, and transport contracts** installs the R 4.5 lock on two Linux workers: one runs frame,
  catalog and transport checks, and the other runs the kernel-agent checks, subject to the source omission below.
  It also requires the existing macOS and Windows jobs unless the change is proved independent of R.
  Their numeric source checks follow the source omission; their installed notebook journeys follow the
  narrower source-test omission below.
- **Packaged VS Code smoke** builds and verifies one VSIX, then opens those exact bytes with the `platform-smoke` /
  `daily-core` selector in the declared minimum VS Code 1.106.0 and current stable VS Code, subject to the
  documentation-only omission below.
  The job uses the base Python dependencies for CSV editing and saved-notebook rendering.
- **Windows filesystem and process contracts** runs Windows-specific export, dependency and shutdown cases, dependency
  journal creation races, dependency fixture cleanup, trusted-pickle source identity and descendant cleanup, and the
  DuckDB owner's selected-file imports and database-reader lifetime against actual local-drive paths.

The Windows worker also runs the real isolated dependency version and module-origin probe, including copied and
hard-linked files. Its kernel bootstrap owner checks the complete bundled-source origin fixtures and native
temporary-path refusal with the selected Python.

The Python runtime job reports the 20 slowest test phases, including fixture setup and teardown, to guide later
investigation.

Java setup in CI, performance and released-Jupyter checks explicitly requires signature verification for downloaded
Temurin packages. Verification failures stop setup; runner-provided JDKs retain the action's existing tool-cache path.

Linux native R jobs explicitly select Python 3.12 for their standard-library pidfd signaling helper. Native cancellation
contracts run once, with the frame/catalog/transport shard; scheduled R 4.4 qualification includes them through the
full R command. Each shard retains serial execution within its own worker. Source keeps its existing Node-only test owner.
The Rscript-only kernel-agent worker skips npm dependency installation while retaining Node setup and the same R
preparation. The frame/catalog/transport worker still installs npm dependencies for its Vitest and native cancellation tests.
These Linux workers move the hosted image's unused `google-chrome.sources` file outside APT's source directory before
R installation. This keeps a Chrome repository outage from blocking R setup or its system dependencies. Required
repositories retain APT's signature and hash checks.

The native R cache stores lock-verified package archives. With the same platform, lock and installer, runner image
builds and R patch changes within the locked minor reuse the same key. Preparation records the actual image and R
version, and every run installs and verifies a fresh private library. GitHub scopes pull-request caches to that PR,
so reuse is limited to its later jobs, updates and reruns; the weekly R 4.4 job uses a separate lock.

Source contracts, package validation, and the separate required CodeQL gate run for every change. Source and the
package job run the same scope proof against their own checkouts. Only `docs_only=true` omits ESLint, Node 24 type
checking, Vitest, installed-editor harness compilation and the minimum/stable VS Code launches, with explicit summaries
of the omitted checks. All other steps remain required, including the supported-Node build, Python setup and
package/source verification. When editor execution is required, its harness is compiled once before both launches;
compilation failure stops execution.
The allowed documentary files are not inputs to ESLint, TypeScript checking, Vitest or the selected installed journey.
README and CHANGELOG remain shipped content, so packaging still validates their exact source bytes. Formatting,
documentation, reference and script checks retain their document validation; these checks do not establish the
accuracy of every prose claim or reported measurement. Files under `docs/**`, including static performance-report JSON,
are excluded from the VSIX and are not runtime inputs.
CONTRIBUTING and AGENTS are excluded from the VSIX. Retained formatting and documentation checks cover them;
runtime and installed-editor tests do not execute their contributor or agent instructions.
On code changes, lint and type checking run after the direct script contracts, so their failures are reported later.

The scope-only job uses Node and Git without installing npm dependencies or restoring the npm cache.
`scripts/ci-docs-only.mjs` permits the omissions below. All admitted files must be regular and non-executable.
Unless explicitly allowed below, omissions require modifications to existing files; additions, deletions, moves
and mode changes require full checks. The runtime-source exceptions allow additions only.
The allowed Markdown paths are `README.md`, `CHANGELOG.md`, `CONTRIBUTING.md`, `AGENTS.md` and `docs/**/*.md`.
Modifications to existing Markdown files qualify on their own or with the permitted source edits below.
Markdown additions and removals, and JSON additions, modifications and removals under `docs/performance/**`, qualify
only when the entire diff consists of these documentary files; any source or other companion change requires full checks.
Such documentation-only changes may omit Python, R and Windows execution. Literal moves between allowed documentary
paths qualify as removals and additions or modifications. Moving code into documentation still requires full checks:
the proof reads both the source removal and destination change without rename detection.
Required-document, generated-reference and release-document checks still run and reject missing required files.

- Python may be omitted for additions or edits to `.R` files under `r/openwrangler_runtime/` or `r/tests/`; edits to
  existing top-level `src/test/extensionHost/*.ts`, `scripts/editor-acceptance.mjs` or
  `scripts/editor-acceptance-artifact.test.mjs` files; and modifications to allowed Markdown files.
  The installed-harness edits retain all R and Windows execution. Nested harness files
  and other scripts are outside this permission.
- The Python worker may also be omitted for modifications to existing files under `src/webviews/` and the existing
  `src/test/progressiveProfilingLifecycle.unit.test.tsx` owner, optionally with the allowed component-test and Markdown
  edits. Platform R jobs, Source and packaged smoke remain required; their numeric source step follows the next scope.
- Python, R and Windows execution may be omitted for modifications to existing `docs/images/**/*.png` files, alone or
  with edits eligible for those omissions. These images are excluded from the VSIX and are not inputs to the omitted
  suites. Such diffs keep `docs_only=false`, retaining Source, CodeQL, Linux package verification and both minimum/stable
  VS Code launches. Other image paths remain outside this permission. Screenshot changes still require
  [local browser acceptance](testing.md#direct-source-checks); this omission does not qualify their visual content.
- The Linux R workers, platform R numeric and CSV source step and Windows filesystem and process job may also be
  omitted for modifications to existing `src/webviews/` files, optionally with the allowed component-test and Markdown edits. This additional omission does
  not extend to the lifecycle unit test, installed harness, scripts or runtime source.
  Both platform R jobs still run their cleanup, package and installed-editor checks.
- The same Python, Linux R source, platform numeric and CSV source and Windows source omissions apply to modifications
  of the existing `src/extension/nativeViews.ts`, `src/extension/nativeViewsExportOptions.ts`,
  `src/test/nativeViewStateCommands.unit.test.ts`, `src/test/nativeViewExportCommands.unit.test.ts`,
  `src/extension/files/importOptions.ts`, `src/test/importOptions.unit.test.ts` and
  `src/test/webviewPanel.unit.test.ts` files, alone or with other edits eligible for those omissions. Other host
  files remain outside this permission. Source still runs both TypeScript programs, its full Vitest suite and the Node
  script checks; package verification and installed VS Code and R journeys remain required.
- R source and installed-editor execution may be omitted for additions or edits to `.py` files under
  `python/openwrangler_runtime/` or `python/tests/`, and modifications to allowed Markdown files.
- Native Spark may be omitted for modifications to one or more of the existing
  `python/openwrangler_runtime/engines/_pandas_arrow_formula_helpers.py`, `pandas_engine.py` and `duckdb_engine.py`
  files, or `python/tests/test_operation_edges.py`, `test_operations.py`, `test_session_transactions.py`, `test_duckdb_engine.py`,
  `test_split_text_columns.py`, `test_pandas_engine.py` and `test_filter_logic.py`, optionally with the allowed Markdown
  edits. Each owner qualifies independently.
  Documentation-only changes do not set this omission flag. Other inputs keep native Spark execution required.
- Only the macOS and Windows editor steps may be omitted when at least one of the existing
  `r/tests/kernel_agent.R` or `r/tests/frame_contract.R` files is modified, optionally with the allowed Markdown edits.
  Both Linux shards and platform source, artifact-cleanup, package and harness checks remain required.
  Any other edited file requires editor execution.
- Python, R and Windows execution may be omitted for edits to existing top-level `src/test/*.component.test.tsx`
  files, optionally with the allowed Markdown edits. Source still runs these component tests; the native and installed
  harnesses do not consume them. Nested tests, unit/cross tests and shared fixtures are outside
  this permission.
- Python, R and Windows execution may also be omitted for edits to the existing release-policy scripts and tests,
  `scripts/capture-screenshots.mjs`, `scripts/capture-screenshots-readiness.mjs`, `scripts/compose-readme-media.mjs` and
  `scripts/ci-docs-only.test.mjs`, enumerated in
  [`ci-docs-only.mjs`](../scripts/ci-docs-only.mjs). These edits keep `docs_only=false`, so Source runs Vitest, the Node
  script owners and the Node 22 build, and packaged smoke retains both Linux VS Code launches.
- ESLint, Node 24 type checking, Vitest and the minimum/stable VS Code launches may be omitted only for the allowed
  documentation-only changes.

Mixed Python/R changes require both runtimes. The Python job does not consume the allowed R or installed-harness files.
The R checks do not execute the allowed Python files; the selected installed R journeys use Python only for Jupyter client readiness
and exclude the mixed-language literate journey. The Python and Windows contract suites do not read CHANGELOG;
Source and packaged smoke retain its validation and package-content checks. Shared code, other host code, fixtures,
configuration and dependency locks require full execution, as do scripts and other paths outside these scopes. If an
affected test suite or selected runner begins consuming an omitted input, update the proof and its tests in the same change.

The Python worker does not load webview source, the admitted lifecycle test or the listed host files. Its Node
decoder checks use shared contracts, which remain outside this permission. Its import-option tests construct their own
requests without executing host defaults, detection or prompts. This omission includes the worker's Python
statics and all Pytest cases, including native Spark; it gives no fresh Python execution result. The installed R journeys
do load the webview and exercise real profiles, so they remain required. Local browser acceptance still applies to rendered UI changes.

The Linux R phases load native R assets and the selected Node transport owners, without loading renderer source or the
listed host files.
The kernel-transport phase also runs native notebook discovery, selection and dependency checks with the same selected R executable.
Native Vitest phases report completed test names and durations, so a phase timeout retains more than a file summary.
Their separate `r_runtime_omittable` result permits the Linux matrix and each platform's numeric and CSV source step to be
skipped. The platform step loads native R assets and its source-test helpers, without loading renderer source or the
listed host files.
Its `omit_source` Boolean workflow input defaults to false, so manual dispatch retains this execution. Skipping it
also omits its separate private source-library preparation. Platform setup, artifact cleanup, macOS process
cancellation, packaging and installed-editor checks remain required. Together with `python_omittable`, the proof
also permits omission of the Windows filesystem and process job, whose selected Python and Node owners do not load
renderer source or the listed host files. Its bootstrap tests do load the installed-notebook fixtures, which remain
outside this additional omission. R runtime and source-test changes retain
Windows source execution. Omission summaries report no fresh source execution for the skipped jobs.

The `native_spark_omittable` proof changes only the Python worker's Spark installation requirement. Pandas stays
below version 3, Java remains installed, and the same Ruff, Pyright and full Pytest commands run. Without Spark,
the existing optional-import gates skip native Classic/Connect frame, transport, profile, lifecycle and decoder-type
checks; fake Spark and shared-runtime controls still run. The admitted engines, helper and test owners currently
exercise local dataframe behavior. Engine implementations load lazily, and automatic detection returns recognized
Spark frames before reaching DuckDB or Pandas. Missing Spark or unsupported values can still reach those later
detectors; the retained registry and fallback tests cover that behavior without native Spark. Polars detection runs
before Spark, so its production owner remains outside this permission. Changes that introduce a Spark dependency
or test into admitted owners must revise their omission eligibility
in the same change. This gives up fresh native Spark and environment evidence; retained local-engine checks do not
establish Spark equivalence. Missing or malformed proof values stop dependency setup, and pip failures fail the job.

The allowed release scripts govern version and publication decisions. Their version classifier is also consumed by macOS and
Windows packaging; it uses string, integer and UTC-date operations covered by the retained Node and Linux package
checks. Omitting the native jobs gives up fresh macOS and Windows packaging, R and environment observations. The
remaining Linux checks do not establish platform equivalence.
Source's documentation and canonical-artifact tests cover the admitted release-document validators, including their
Git, VSIX and release-channel checks. These validators and their test owner are excluded from the VSIX and are not
consumed by Python, native R or installed-editor execution.
The registry source and artifact test owners also qualify: Source runs their temporary Git, synthetic VSIX and
injected publication cases. Their packaged R/Python entries are bytes under validation, never executed; the runtime
and editor jobs do not load these tests. Their production modules remain outside this additional permission.

The CI proof test uses Node, temporary Git histories and controlled workflow guards. Source executes it for every
change; the native and installed suites do not load it. The production proof script remains outside this permission.

The two capture scripts generate real Python-backed browser fixtures, but the omitted native suites do not consume
these generators. Their required [local browser acceptance](testing.md) still owns fixture execution, images and
interactions; retained Source and Linux package checks do not replace it. The compositor reads and crops existing PNGs
offline. It and its outputs are excluded from the VSIX and are not consumed by native or installed-editor checks.
Composition verification and visual review remain local; CI does not run the compositor or establish image accuracy.
Media-only omissions give up fresh Python/Spark, R, macOS and Windows packaging, editor and environment observations,
and Windows filesystem and process checks. Retained Linux checks do not establish platform equivalence.
Shared browser and preflight helpers, including `scripts/public-media-contract.mjs`, remain outside this permission.

These omissions reduce unrelated work for documentation changes, webview edits, private component tests, isolated engine changes,
release-policy edits, CI proof test edits, local screenshot-tool edits and the allowed installed-harness edits.
They provide no fresh or transferred test result and can delay discovery of unrelated dependency, editor installation
or hosted-environment regressions.
Scheduled R 4.4 qualification does not replace R 4.5 coverage. Release qualification remains separate.

Each runtime has cancellable execution and a short required-result job. The latter reports success only for completed
execution or a proved omission with actually skipped execution. Windows source omission requires both
`r_runtime_omittable` and `python_omittable` and a skipped worker; otherwise both flags must be valid and its execution
must succeed. The R result also checks both installed workflow calls and their selected platform job results.
A proved whole-R omission requires the source matrix and both installed workflow
calls to be skipped, with empty reusable outputs. A proved source omission requires a skipped source matrix and
successful calls and selected results for both platform jobs. Without either omission, all results must succeed.
Missing, contradictory, failed or cancelled results cannot satisfy the check, even if a misconfigured workflow call
otherwise reports success.

The separate `r_editor_omittable` result leaves both platform jobs running. Its Boolean workflow input defaults to false;
manual dispatch retains editor execution. An omitted editor step reports no fresh editor result. These two R test files
are excluded from the VSIX and installed harness, but the platform numeric and CSV source cases load `kernel_agent.R`,
so its source execution remains required. This omission can delay discovery of unrelated Jupyter or hosted-environment
failures; source and package checks do not replace the editor journey.

The installed jobs reuse `released-jupyter.yml` at the same commit as the caller. Manual dispatch remains available for
diagnosis; there is no second pull-request trigger. Their preparation, dependencies and artifact safeguards have one
owner. Parallel Linux shards repeat environment setup on separate workers, and installed qualification adds two
platform workers. Assess total wall time and runner cost together when changing this composition.

The proof binds the checkout's merge commit and both parents to the pull-request event. It reads a bounded,
NUL-delimited Git diff. Additions outside the permitted documentary or runtime source scopes, deletions outside the documentation-only
rule, code renames, mode changes, other changes outside the allowed paths, empty diffs and unavailable or unrecognized
evidence select full checks.
Changes to the production proof or workflow also require full execution.
A failed proof job or malformed output fails the required result.
Source and package jobs also fail if their local proof fails or returns a malformed omission value.
Execution jobs remain cancellable. Their result jobs run even after a failed or canceled dependency, so skipped or
canceled execution cannot satisfy a required check when full runtime checks were needed.
Branch protection continues to require all five product checks and CodeQL.

Drafts and ready pull requests use the same jobs. A new commit cancels the older run for that pull request. Successful
pull-request jobs do not upload build output. The packaged smoke may upload its bounded diagnostics only after that
job fails.

Dependabot automatic rebasing is disabled for each ecosystem. When selecting an update for integration, a maintainer
refreshes it onto current `main` and reviews the dependency and lockfile changes. The branch must be up to date and
pass all five product checks and CodeQL before merging. Update schedules, grouping, and security update creation
remain unchanged.

Pull requests already open when rebasing is disabled may continue to rebase until 30 days after they were created.
See GitHub's [rebase strategy documentation](https://docs.github.com/en/code-security/reference/supply-chain-security/dependabot-options-reference#rebase-strategy).

## Local equivalents

Use focused commands while iterating. The complete source boundary is:

```bash
npm run check
npm test
```

The exact-artifact installed smoke and its environment are documented once in [Testing](testing.md).

Released-Jupyter R editor runs use the [notebook/tooling package selection](testing.md#native-r-editor-dependencies)
resolved by their existing journey. Private package-version checks precede editor launch; notebook and literate
journeys also require IRkernel readiness. The terminal journey retains native R executable and private library checks
without creating an unrelated kernel or requiring host Python and the Jupyter extension.
The macOS job supplies system ZeroMQ through Homebrew and uses the qualified collapse binary for its selected R tuple,
as described in that dependency section.
The focused terminal lane uses the pinned R extensions; Quarto extension and CLI qualification remains with the
literate-documents lane.

The `macos-r` and `windows-r` jobs run the existing private R artifact filesystem tests in Node, before private
R dependencies or editor preparation. These exercise real file cleanup and refusal of replaced files and directories
on each platform without launching R or an editor. The macOS job also runs the existing native process cancellation
owner through default helper preparation, before private R dependency installation or editor preparation.
Windows runs the existing supervisor native owner before dependency preparation, including production binary R input
and PowerShell source startup. Its installed file stage checks native formats, import restoration and private-process
recovery through the existing notebook journey; [Testing](testing.md#native-r-editor-dependencies) defines its scope.
Unless the source omission applies, the released-Jupyter jobs then run the canonical `kernel:numeric-portability`
and `kernel:csv-import` source cases with the same private jsonlite and bit64 dependencies before opening the editor.
Parquet dependencies remain with the separate export and editor owners.
These cases check platform-sensitive arithmetic, text conversion, selections and generated programs without
repeating the broad Linux operation and export suites. macOS uses the bounded `platform-lifecycle` journey; Windows
keeps its representative journey and opens the three ordinary collapse fixtures. Cursor, remote and focused profiles
are unchanged. See [Testing](testing.md#native-r-editor-dependencies) for their coverage and bounds.
These local R jobs install only Jupyter's Python client and its dependencies for the kernel-readiness probe. Python
dataframe engines and development tools remain with the jobs that execute them.
The Windows R job does not restore or save a pip cache with setup-python, avoiding the larger cache shared with
Windows runtime contracts for this small dependency set. Its package installation still depends on the package index.

## Scheduled and release workflows

The released-Jupyter workflow also offers `linux-python` for manually triggered Python and file-input investigations.
It runs the existing local Python notebook and generic file checks in two sequential VS Code invocations against the
same VSIX. Its job name states that Spark, remote Jupyter and R are omitted. A failure stops the sequence and uses
the existing failure-diagnostic handling. This target provides no full Python source-suite, Spark, remote Jupyter or R
qualification. It omits Java setup, UV installation and lock regeneration/audit for the unused remote-server
environments. The local notebook environment keeps its separate pinned dependencies and version checks.
The default `linux-all` target, pull-request callers and release qualification remain unchanged.
See [Testing](testing.md#focused-python-notebook-checks) for the selected phases and repeated setup cost.

For manual R investigations, `linux-r` runs the existing core/remote, value, categorical and active-terminal
invocations in VS Code and Cursor. It skips only the generic Python/file-input editor invocation, and its job name
states that omission. All environment setup, builds, package checks and R failure reporting remain in place.
This selection provides no Python/file-input editor result and does not replace full source suites, platform checks
or broader R qualification. The default `linux-all` target and release requirements remain unchanged.

The weekly/manual macOS and Windows runtime jobs build and verify one VSIX, then run the existing packaged VS Code
full mode. This replaces their development-extension seed/verify run, retaining those phases and adding package
installation and restricted-trust checks. Scheduled and default manual runs retain the full Python and native Windows
source suites. These jobs do not opt into released Jupyter, R or other optional editor integrations. Failed editor runs
retain only the existing sealed diagnostic artifact when its safety checks permit publication.

Manual runs may explicitly set `installed_only` to investigate the installed macOS and Windows behavior. It replaces
the former `omit_python_source` input and skips the full Python test step and the separate R 4.4, Windows
dependency-guard and exact Python dependency-cohort jobs.
Environment setup and smoke checks, package and installed verification, native Windows checks and failure artifacts
remain enabled. The run is named “Installed macOS/Windows investigation; full qualification omitted”. It provides no
fresh full-Python, R-lock or dependency-cohort qualification. Dependencies still resolve through the declared ranges;
an earlier source result does not qualify the newly resolved environment. Scheduled and default manual runs remain full.

The weekly cross-platform workflow groups the dependency authority's exact qualification cases by Python version
and ordinal within each dependency. Each declared tuple appears once, including intermediate versions and the
Python 3.10 IPython compatibility case. The current groups install ten and five exact requirements on Python 3.12,
and one on Python 3.10, alongside `python[dev]`. Other packages resolve through the declared ranges.
Each group verifies every member's version, module origin and API behavior, then runs the three-engine runtime smoke
once. Joint groups reduce repeated setup and check selected versions together. They give up some combinations with
one old dependency and otherwise current packages, and separate job outcomes for each dependency. A failed member
is named in the probe output. The other cross-platform and native R jobs remain separate.

The weekly Polars runtime benchmark installs the core Python runtime dependencies and runs the full CSV/Parquet
measurement with strict thresholds.

Scheduled previews and stable releases use separate workflows:

- `preview-release.yml` checks protected `main` against the last successful scheduled run before checkout or dependency
  setup. Unchanged source skips publication. A failed run does not advance that baseline. New source is packaged once
  and checked in stable VS Code with `daily-core` before publication. Packaging is first-attempt-only, and only its job
  reads PR metadata to freeze change notes. [Daily preview](releasing.md#daily-preview) owns version derivation,
  publication and recovery.
- `release-candidate.yml` uses protected-main source checks, audits dependencies, and checks one canonical artifact in
  pinned VS Code installed-performance and pinned Cursor platform-smoke. A required Linux/macOS/Windows matrix then
  runs the default R notebook journey against that same supplied artifact, with only the test harness built locally.
  It retains private R preparation and exact failure-artifact ownership without repeating source suites or packaging.
  [Release candidate](releasing.md#release-candidate) owns dispatch prerequisites, failed-candidate handling and the
  qualification still required for stable R support.
- `stable-release.yml` selects a successful candidate using Node built-ins, then installs publication tools in a separate
  job and promotes the recorded bytes without rebuilding. It dispatches shared Open VSX promotion; workflow success does
  not establish completion of both registries. [Stable publication](releasing.md#stable-publication) owns completion
  checks and recovery.

Workflows are authoritative for current inputs and schedules. These release paths add no pull-request source suites.

## Reading a red check

Start with the failing owner. Source, Python, R, installed-package, and Windows failures should each identify the
boundary that regressed.

Do not retry a deterministic failure to make it green. Fix the product or prerequisite, classify an external outage,
or remove a check that cannot name a distinct failure. Third-party workflow actions remain commit-pinned, and write
permission belongs only to publication jobs.
