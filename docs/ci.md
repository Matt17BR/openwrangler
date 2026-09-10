# CI and release checks

## Pull requests

Every pull request reports the same five required product checks:

- **Source contracts (Node 24)** runs formatting, lint, TypeScript source and dependency declaration checks, generated
  protocol/reference checks, documentation checks, dependency-lock checks, licenses, `npm run test:scripts`, and Vitest.
  It then builds the same checkout with Node 22.17.0 against the already-installed locked dependencies.
- **Python runtime contracts** runs Ruff, Pyright, and Pytest with the declared Python and PySpark dependencies.
- **Native R frame, kernel, and transport contracts** installs the R 4.5 lock on two Linux workers: one runs frame,
  catalog and transport checks, and the other runs the kernel-agent checks. It also requires the existing macOS and Windows
  installed R notebook journeys unless the change is proved independent of R.
- **Packaged VS Code smoke** builds and verifies one VSIX, then opens those exact bytes with the `platform-smoke` /
  `daily-core` selector in the declared minimum VS Code 1.106.0 and current stable VS Code.
  The job uses the base Python dependencies for CSV editing and saved-notebook rendering.
- **Windows filesystem and process contracts** runs Windows-specific export, dependency and shutdown cases, dependency
  journal creation races, trusted-pickle source identity and descendant cleanup, and the DuckDB owner's selected-file
  import cases against actual local-drive paths.

The Python runtime job reports the 20 slowest test phases, including fixture setup and teardown, to guide later
investigation.

Linux native R jobs explicitly select Python 3.12 for their standard-library pidfd signaling helper. Native cancellation
contracts run once, with the frame/catalog/transport shard; scheduled R 4.4 qualification includes them through the
full R command. Each shard retains serial execution within its own worker. Source keeps its existing Node-only test owner.
These Linux workers move the hosted image's unused `google-chrome.sources` file outside APT's source directory before
R installation. This keeps a Chrome repository outage from blocking R setup or its system dependencies. Required
repositories retain APT's signature and hash checks.

The native R cache stores lock-verified package archives. With the same platform, lock and installer, runner image
builds and R patch changes within the locked minor reuse the same key. Preparation records the actual image and R
version, and every run installs and verifies a fresh private library. GitHub scopes pull-request caches to that PR,
so reuse is limited to its later jobs, updates and reruns; the weekly R 4.4 job uses a separate lock.

Source contracts, packaged smoke, and the separate required CodeQL gate run for every change.
`scripts/ci-docs-only.mjs` may omit runtime execution when every change fits that runtime's scope below. All admitted
files must be regular and non-executable.

- Python may be omitted for additions or edits to `.R` files under `r/openwrangler_runtime/` or `r/tests/`; edits to
  existing `src/test/extensionHost/releasedRCoreEditing.ts` or `src/test/extensionHost/releasedRRowReduction.ts`; and
  edits to existing `README.md`, `CHANGELOG.md` or `docs/**/*.md` files. The two journey files retain all R and Windows
  execution. Other acceptance helpers, including the shared R operation picker, are outside this permission.
- R source and installed-editor execution may be omitted for additions or edits to `.py` files under
  `python/openwrangler_runtime/` or `python/tests/`, and edits to existing `README.md`, `CHANGELOG.md` or `docs/**/*.md`.
- Windows execution may be omitted only for edits to existing `README.md`, `CHANGELOG.md` or `docs/**/*.md` files.

Mixed Python/R changes require both runtimes. The Python job does not consume the allowed R files. The R checks do
not execute the allowed Python files; the selected installed R journeys use Python only for Jupyter client readiness
and exclude the mixed-language literate journey. The Python and Windows contract suites do not read CHANGELOG;
Source and packaged smoke retain its validation and package-content checks. Shared/host code, fixtures, scripts,
configuration, dependency locks and other paths outside these scopes require full execution. If a runtime's tests or selected runner begins consuming
an omitted input, update the proof and its tests in the same change.

This avoids unrelated runtime setup and execution during isolated engine or allowed R journey changes. An omission
is not a newly executed or transferred success; it can delay discovery of unrelated dependency or hosted-environment regressions.
Scheduled R 4.4 qualification does not replace R 4.5 coverage. Release qualification remains separate.

Each runtime has cancellable execution and a short required-result job. The latter reports success only for completed
execution or a proved omission with actually skipped execution. The R result also checks both installed workflow calls
and their selected platform job results. A proved R omission requires the source matrix and both installed workflow
calls to be skipped, with empty reusable outputs. Otherwise every result must succeed; missing, canceled or skipped selected jobs
cannot satisfy the check, even if a misconfigured workflow call otherwise reports success.

The installed jobs reuse `released-jupyter.yml` at the same commit as the caller. Manual dispatch remains available for
diagnosis; there is no second pull-request trigger. Their preparation, dependencies and artifact safeguards have one
owner. Parallel Linux shards repeat environment setup on separate workers, and installed qualification adds two
platform workers. Assess total wall time and runner cost together when changing this composition.

The proof binds the checkout's merge commit and both parents to the pull-request event. It reads a bounded,
NUL-delimited Git diff. Additions outside the permitted runtime source scopes, deletions, renames, mode changes,
other changes outside the allowed paths, empty diffs and unavailable or unrecognized evidence select full checks.
Changes to the proof or workflow also require full execution.
A failed proof job or malformed output fails the required result.
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
The macOS job supplies system ZeroMQ through Homebrew as described in that dependency section.
The focused terminal lane uses the pinned R extensions; Quarto extension and CLI qualification remains with the
literate-documents lane.

The `macos-r` and `windows-r` jobs first run the existing private R artifact filesystem tests in Node, before private
R dependencies or editor preparation. These exercise real file cleanup and refusal of replaced files and directories
on each platform without launching R or an editor.
The released-Jupyter jobs then run the canonical `kernel:numeric-portability` source case
before opening the editor. It checks the platform-sensitive arithmetic, selections and generated programs without
repeating the broad Linux operation and export suites. macOS uses the bounded `platform-lifecycle` journey; Windows
keeps its representative journey. See [Testing](testing.md#native-r-editor-dependencies) for their coverage and bounds.
These local R jobs install only Jupyter's Python client and its dependencies for the kernel-readiness probe. Python
dataframe engines and development tools remain with the jobs that execute them.

## Scheduled and release workflows

The weekly Polars runtime benchmark installs the core Python runtime dependencies and runs the full CSV/Parquet
measurement with strict thresholds.

The consolidated preview workflow owns both the automatic daily public train and the manual preview fallback:

- A small check compares protected `main` with the last successful scheduled run before any checkout, dependency
  installation, build, or editor test. An unchanged commit skips packaging and publication with a job-summary reason.
  Failed runs remain eligible on the next schedule, and manual dispatches always reach the existing preview flow.
- Each scheduled run derives its date from that workflow run's immutable UTC creation timestamp and its series from
  the latest canonical stable release tag reachable from the exact protected-main source commit in the full checkout.
  A pre-v2 stable tag retains the `1.99.YYYYMMDD` compatibility series. For v2 and later, the tag's `major.minor`
  selects the series: a source whose metadata has advanced to 2.1 still produces `2.0.YYYYMMDD` while `v2.0.z` is the
  latest stable tag, and switches to `2.1.YYYYMMDD` only after a stable `v2.1.z` tag exists. The run binds one
  deterministic direct child to that stable tag and commit, changes only the three version files, and qualifies one
  canonical VSIX/checksum/provenance bundle in exact stable VS Code with the existing `daily-core` selector. The
  accepted bytes are then published automatically as a GitHub prerelease. GitHub dispatches Open VSX, while the tag
  triggers Azure Marketplace.
- A manual run remains available only for the public `v1.99.7` fallback. It qualifies the same canonical bundle, and
  publication remains explicit through its `publish` input.
- Packaging admits only a workflow run's first attempt, before checkout or setup. Package failures require a new run;
  **Publish preview** remains retryable with the recorded package artifact ID and source/date/tag outputs. After its
  existing dependency setup, the package job also freezes the latest published preview's verified tag and commit for
  [daily change notes](releasing.md#daily-preview). Retries retain these outputs and exact notes rather than advancing
  to a newer publication. This adds no release asset and does not change artifact qualification or registry recovery.
- Release candidate trusts the required checks already attached to protected `main` rather than repeating the source
  suites. It validates stable metadata, packages once, audits published dependencies, runs pinned VS Code
  installed-performance, and then runs pinned Cursor platform-smoke against the same reverified canonical VSIX.
- Stable publication selects a successful candidate and promotes its already-recorded bytes. Candidate selection uses
  Node built-ins without installing or caching npm dependencies. The separate promotion job installs its publication
  tools and verifies the exact artifact; it does not rebuild the extension.

The workflows themselves are authoritative for their current inputs and schedules. See [Releasing](releasing.md) for
the operator sequence and failed-publication recovery. These release paths are not additional pull-request
source-test owners.

## Reading a red check

Start with the failing owner. Source, Python, R, installed-package, and Windows failures should each identify the
boundary that regressed.

Do not retry a deterministic failure to make it green. Fix the product or prerequisite, classify an external outage,
or remove a check that cannot name a distinct failure. Third-party workflow actions remain commit-pinned, and write
permission belongs only to publication jobs.
