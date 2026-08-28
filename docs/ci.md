# CI and release checks

Open Wrangler uses quick pull-request checks for source changes, scheduled checks for changing external platforms,
and installed-package checks before a release.

## Pull requests

Every pull request runs the same five jobs. Each job names one product boundary:

- **Source contracts (Node 24)** checks formatting, JavaScript/TypeScript lint and types, generated protocol and
  reference files, documentation, dependency locks, licenses, and the plain Vitest suite. Vitest owns component and
  ARIA behavior.
- **Python runtime contracts** runs Ruff, Pyright, and plain Pytest, including the PySpark 4.2 cases with Java 17.
  Ordinary pull-request CI does not add a coverage threshold or dependency audit.
- **Native R frame and transport contracts** installs the R 4.5 dependency lock and runs the native frame,
  catalog, and interactive/process transport shards. The exhaustive kernel-agent operation journey is not a
  pull-request gate.
- **Packaged VS Code smoke** builds and verifies one VSIX, compiles the installed-editor harness, and runs the exact
  `platform-smoke` / `daily-core` selector in stable VS Code. Its production build includes the webview bundles.
- **Windows filesystem and process contracts** runs only the Windows-specific export, dependency, and process-cleanup
  cases.

There is no path classifier. Documentation, dependency, and product changes all run these five owners, so a required
context never has to interpret an intentional skip. The workflow does not repeat on a push to `main`; an up-to-date
pull-request head already tested that tree.

`validate` is the single required CI result. It has no checkout, runtime setup, or custom parser. One inline shell
step requires all five job results to be `success`. The main-branch ruleset also requires the separate `CodeQL gate`,
so failing code cannot merge.

Pull requests, including drafts, run when they are opened, reopened, or receive new commits. A newer run for the same
pull request cancels its older run.

The full browser, screenshot, and Axe command remains available locally through `npm run test:webview-acceptance`,
but it is not an ordinary pull-request gate. The gallery-coupled Axe path has no separate hosted owner for now. A later
release-candidate simplification can choose one representative installed accessibility check if it finds a failure
that source Vitest and the packaged smoke do not cover.

Packaged-editor diagnostics are uploaded only when that job fails. Ordinary successful pull-request runs do not
retain build artifacts.

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

- **Source contracts**, **Python runtime contracts**, or **Native R frame and transport contracts** means the named
  source/runtime boundary regressed.
- **Packaged VS Code smoke** means the production build, VSIX contents, harness compilation, or installed
  `daily-core` journey failed.
- **Windows filesystem and process contracts** or **Cross-platform runtime** means a platform-specific behavior
  failed.
- **validate** means at least one of the five pull-request owners did not succeed.

Do not retry a deterministic failure to make it green. Fix the product or test, isolate an external outage, or simplify
a check that does not produce a useful failure. Release and editor failures may retain sanitized diagnostics; raw
profiles, workspace state, and credentials must not be uploaded.

All third-party workflow actions use reviewed commit revisions. Workflow permissions default to read-only and are
raised only by the job that publishes a release.
