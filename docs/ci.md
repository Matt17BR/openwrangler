# CI and release checks

Workflows are authoritative for current inputs, schedules and pinned versions. This page explains what each check
covers and when a pull request may skip part of it.

## Pull requests

Branch protection requires CodeQL and five product checks:

- **Source contracts (Node 24)** runs formatting, lint, type checks, generated protocol and reference checks,
  documentation checks, dependency-lock checks, licenses, `npm run test:scripts` and Vitest. It then builds the same
  checkout with Node 22.17.0 against the installed dependencies.
- **Python runtime contracts** runs Ruff, Pyright and Pytest, including native PySpark, with the declared Python
  dependencies, and reports the 20 slowest test phases.
- **Native R frame, kernel, and transport contracts** installs the R 4.5 lock on two Linux workers. One runs the
  frame, catalog, transport and native cancellation phases; the other runs the kernel-agent phases. The check also
  requires the macOS and Windows R jobs described under
  [macOS and Windows R jobs](#macos-and-windows-r-jobs).
- **Packaged VS Code smoke** builds and verifies one VSIX, then opens those exact bytes with the `platform-smoke` and
  `daily-core` selector in the minimum supported VS Code, 1.106.0, and in current stable VS Code.
- **Windows filesystem and process contracts** runs Windows export, dependency, shutdown and descendant-cleanup
  cases, the DuckDB file imports against real local-drive paths, and the isolated dependency-version and kernel
  bootstrap probes.

Drafts and ready pull requests run the same jobs, and a new commit cancels the older run. Successful jobs upload no
build output; the packaged smoke uploads bounded diagnostics only when it fails.

Setup details that affect failures:

- Java setup verifies the signatures of downloaded Temurin packages.
- The Linux R workers use Python 3.12 for the pidfd signaling helper. They move the hosted image's unused
  `google-chrome.sources` file out of APT's source directory, so a Chrome repository outage cannot block R setup.
- The R cache stores lock-verified package archives, keyed by platform, lock and installer. Every run installs and
  verifies a fresh private library. The lock includes dplyr, data.table and collapse for the selectable cleaning
  libraries, Arrow and clock for exact timestamps, and nanoparquet for Parquet metadata and zero-column export.
- The macOS and Windows R jobs reuse `released-jupyter.yml` at the caller's commit, so their preparation and failure
  artifacts have one owner.

### macOS and Windows R jobs

The `macos-r` and `windows-r` jobs first run the private R artifact filesystem tests in Node. macOS also runs the
native process cancellation owner, and Windows the supervisor owner, before any R dependencies are prepared. Unless
the source cases may be skipped, both jobs then run the `kernel:numeric-portability` and `kernel:csv-import` cases,
which check platform-sensitive arithmetic, text conversion, selections and generated programs. macOS then runs the
bounded `platform-lifecycle` notebook journey; Windows runs its representative journey and opens the three collapse
fixtures. [Native R editor dependencies](testing.md#native-r-editor-dependencies) defines the package selection and
the scope of each journey. These jobs install only Jupyter's Python client for the kernel-readiness probe.

### Skipping checks

`scripts/ci-docs-only.mjs` reads the merge commit's diff against its base and decides which work a pull request to
`main` may skip; `scripts/ci-docs-only.test.mjs` exercises it on real Git histories. Other runs, and a merge commit
that doesn't match the event, run every check. A skipped check gives no fresh result, so it can delay the discovery
of unrelated dependency, editor or hosted-environment failures.

Each changed file must belong to one of these groups; any other file requires every check. A pull request skips
only what all of its files allow.

- Documentation: `README.md`, `CHANGELOG.md`, `CONTRIBUTING.md`, `AGENTS.md`, `docs/**/*.md` and
  `docs/performance/**/*.json` never add a check. A diff of only these skips Python, R and the Windows filesystem
  and process job, and also ESLint, Node 24 type checking, Vitest, the installed-harness build and both VS Code
  launches.
- Screenshots and presentation tests: `docs/images/**/*.png`, top-level `src/test/*.component.test.tsx`,
  `scripts/ci-docs-only.test.mjs`, and the release, screenshot, media and accessibility scripts listed in
  `ci-docs-only.mjs` skip Python, R, and the Windows filesystem and process job. CI does not check image content,
  so screenshot changes still need [local browser acceptance](testing.md#direct-source-checks).
- Webview and panel host: `src/webviews/**` and the native-view, import-option and panel host files listed in
  `ci-docs-only.mjs` skip Python. When every other changed file is documentation, a top-level component test or
  another file in this group, they also skip the Linux R workers, the macOS and Windows R source cases, and the
  Windows filesystem and process job.
- Python: `python/openwrangler_runtime/**/*.py` and `python/tests/**/*.py` skip R, including the installed R
  journeys. When every changed file other than documentation modifies one of the Pandas and DuckDB engine and test
  files listed in `ci-docs-only.mjs`, CI also skips installing native Spark, and Pytest skips the native Spark tests.
- R and editor harness: `r/openwrangler_runtime/**/*.R`, `r/tests/**/*.R`,
  `src/test/progressiveProfilingLifecycle.unit.test.tsx`, top-level `src/test/extensionHost/*.ts`,
  `scripts/editor-acceptance.mjs` and `scripts/editor-acceptance-artifact.test.mjs` skip Python. When every changed
  file other than documentation modifies `r/tests/kernel_agent.R`, `r/tests/frame_contract.R` or
  `r/tests/complete_catalog_contract.R`, the macOS and Windows editor steps are skipped too.

Documentation files may be added or removed only when the whole diff is documentation. Other files qualify only
as modifications of regular, non-executable files, except that new Python and R runtime or test sources also qualify.
Any other addition or deletion, a rename, a mode change, an empty diff, unrecognized Git output, or a change to the
proof or a workflow requires every check. Required-document, generated-reference and release-document checks always run, and so do
Source, package verification and CodeQL. If a suite starts reading a file in a skippable group, or a file that
skips native Spark starts using Spark, update the proof and its tests in the same change.

GitHub treats a skipped required job as passing, so each runtime reports through a short result job that runs even
after a failed or cancelled dependency. It succeeds only when execution completed, or when the proof allowed the skip
and the execution really was skipped. Missing, contradictory, failed or cancelled results fail the check.

Dependabot rebasing is disabled. To integrate an update, a maintainer refreshes it onto current `main`, reviews the
dependency and lockfile changes, and merges it only when it is up to date and every required check passes. See
GitHub's [rebase strategy documentation](https://docs.github.com/en/code-security/reference/supply-chain-security/dependabot-options-reference#rebase-strategy).

## Local equivalents

Use focused commands while iterating. The complete source boundary is:

```bash
npm run check
npm test
```

The exact-artifact installed smoke and its environment are documented in [Testing](testing.md).

## Scheduled and release workflows

- `released-jupyter.yml` runs `linux-all` by default. For manual investigations, `linux-python` runs only the local
  Python notebook and generic file checks, and `linux-r` runs the R invocations in VS Code and Cursor without the
  Python file-input invocation. Their job names state what they omit, and neither qualifies a release. See
  [Focused Python notebook checks](testing.md#focused-python-notebook-checks).
- The weekly macOS and Windows runtime jobs build and verify one VSIX, run packaged VS Code in full mode, and run the
  full Python and native Windows source suites. A manual run may set `installed_only` to skip the full Python suite
  and the R 4.4, Windows dependency-guard and dependency-cohort jobs; the run is then named "Installed macOS/Windows
  investigation; full qualification omitted".
- The weekly dependency-cohort jobs install each exact qualification case from the dependency authority, grouped by
  Python version, verify every member's version, module origin and API behavior, then run the three-engine smoke once
  per group.
- The weekly R 4.4 job runs the full R suite with its own lock. It does not replace R 4.5 coverage.
- The weekly Polars benchmark runs the full CSV and Parquet measurement with strict thresholds.
- `preview-release.yml` compares protected `main` with the last successful scheduled run and skips publication when
  nothing changed. New source is packaged once and checked in stable VS Code with `daily-core` before publication.
  [Daily preview](releasing.md#daily-preview) owns versions, publication and recovery.
- `release-candidate.yml` checks protected-main source, audits dependencies, and checks one canonical artifact in
  pinned VS Code installed-performance and pinned Cursor platform-smoke. A Linux, macOS and Windows matrix then runs
  the default R notebook journey against that same artifact. See [Release candidate](releasing.md#release-candidate).
- `stable-release.yml` selects a successful candidate and promotes its recorded bytes without rebuilding, then
  dispatches Open VSX promotion. Workflow success does not prove that both registries completed; see
  [Stable publication](releasing.md#stable-publication).

## Reading a red check

Start with the failing owner. Source, Python, R, installed-package and Windows failures should each identify the
boundary that regressed.

Do not retry a deterministic failure to make it green. Fix the product or prerequisite, classify an external outage,
or remove a check that cannot name a distinct failure. Third-party workflow actions stay pinned to a commit, and only
publication jobs have write permission.
