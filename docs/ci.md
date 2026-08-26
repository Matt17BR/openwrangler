# CI and release checks

Open Wrangler uses quick pull-request checks for source changes, scheduled checks for changing external platforms,
and installed-package checks before a release.

## Pull requests

Every pull request runs change detection and JavaScript/TypeScript checks on the supported Node 24 and Node 22
versions. Other jobs run only for files they own:

- **Python** runs Python lint and the Python coverage suite, including the PySpark cases with Java 17.
- **R** installs the R 4.5 dependencies once and runs all R source tests.
- **Package and editor** builds and verifies the VSIX, runs VS Code extension-host tests, and runs TypeScript coverage
  plus the portable script suite.
- **Web UI and accessibility** runs the production webview, visual, and accessibility tests in the pinned Chromium.
- **Windows** runs focused filesystem, dependency-install, process, and cleanup tests.

A Dependabot-configuration-only change runs only the shared JavaScript/TypeScript checks. A Python-test-only change
runs those shared checks and Python. Package and lockfile changes run every lane that consumes the changed build or
dependency metadata. Dependency-changing pull requests run the matching audit. Main and merge-queue runs repeat all
behavior lanes but do not repeat an audit that already passed on the pull request.

Unknown paths and changes to CI's own selection code run every lane. A missing or failed change-detection result also
prevents merge.

`validate` is the single required CI result. It waits for every possible lane, accepts jobs that were intentionally
skipped, and fails for selected jobs that failed, were cancelled, or returned a missing or unknown result. It also
rejects a job that ran despite not being selected. The main-branch ruleset requires both `validate` and `CodeQL gate`,
so failing code cannot merge.

Pull requests, including drafts, run on open, synchronize, reopen, base edit, and stack changes. A stacked pull request
uses the cumulative stack range when GitHub supplies complete stack metadata. Merge-queue candidates run all lanes on
the merged tree. Superseded pull-request and merge-group runs are cancelled.

Visual diffs and packaged-editor diagnostics are uploaded only when their job fails. Ordinary successful pull-request
runs do not retain build artifacts.

## Scheduled checks

Scheduled workflows cover dependencies that can change without a repository commit:

- **Daily preview** runs every day at 03:13 UTC. One job stamps a disposable version, builds and checks one VSIX,
  installs those exact packaged bytes in stable VS Code, and follows a short user path: open a CSV from its public
  editor action, render the grid, sort one column, and close the session and runtime. Only a passing VSIX is retained;
  it expires after 14 days and cannot be promoted. Failures retain only the usual sanitized editor diagnostics.
- **Cross-platform runtime** runs Mondays at 04:17 UTC. It covers macOS with Python 3.12, Windows with Python 3.14,
  focused Windows dependency behavior, supported Python dependency versions, and R 4.4.
- **Performance gates** run Tuesdays at 05:41 UTC for the Polars runtime. The larger PySpark profile is manual.
- **CodeQL** runs Tuesdays at 04:23 UTC in addition to pull requests and protected-main pushes.

**Released Jupyter acceptance** is manual. Use it when the released Jupyter integration or an operating-system-specific
R notebook path needs investigation.

## Release candidates

The **Release candidate** workflow starts manually from protected `main`. It builds one VSIX and records its checksum
and source revision. Every acceptance job downloads and verifies those same bytes; consumers do not rebuild the
extension.

Candidate acceptance covers installed VS Code and Cursor behavior, macOS and Windows compatibility, native R,
Jupyter, Remote SSH, and installed performance. The candidate result waits for all of those jobs. Any failure stops
promotion.

The daily preview is deliberately separate from a release candidate. A passing preview is useful early warning, but
it is not eligible for release.

## Publication

Stable publication is a separate manual action. It selects a successful, sufficiently aged release-candidate run,
downloads its recorded VSIX, and verifies the source revision and checksums again. Only the publication job receives
write permission.

The GitHub release is created first. Open VSX promotion consumes the GitHub release, and the tagged release starts the
Azure Marketplace pipeline. Each registry receives the accepted VSIX; none rebuilds or substitutes it.

## Reading a red check

Start with the failing job name:

- **JavaScript / TypeScript**, **Python**, or **R** usually means a source or unit-test regression.
- **Web UI and accessibility** means a browser, visual, or accessibility regression. Failed runs retain image diffs.
- **Package and editor** means the build, VSIX contents, extension host, or installed editor failed.
- **Windows** or **Cross-platform runtime** means a platform-specific behavior failed.
- **Changes** or **validate** means CI could not determine or account for the jobs that were required.

Do not retry a deterministic failure to make it green. Fix the product or test, isolate an external outage, or simplify
a check that does not produce a useful failure. Release and editor failures may retain sanitized diagnostics; raw
profiles, workspace state, and credentials must not be uploaded.

All third-party workflow actions use reviewed commit revisions. Workflow permissions default to read-only and are
raised only by the job that publishes a release.
