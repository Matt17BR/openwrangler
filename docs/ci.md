# CI and release checks

Open Wrangler uses three test levels. The everyday pull-request checks should find ordinary mistakes quickly. Editor and registry checks run against a packaged VSIX before a release. Scheduled jobs watch external dependencies such as VS Code, Jupyter, Python, and security advisories.

## Pull requests

Draft pull requests run `Fast feedback`: formatting, linting, TypeScript, generated files, licenses, and workflow tests. A healthy draft reports `Draft feedback`, not a fake failure. The protected `validate` check is deliberately absent until the pull request is marked ready. The `ready_for_review` event starts the merge checks on the same commit.

Ready code changes run:

| Area             | Checks                                                                                        |
| ---------------- | --------------------------------------------------------------------------------------------- |
| Source           | TypeScript and Python tests, type checking, linting, coverage, generated-file checks          |
| UI               | production webview tests, visual baselines, and accessibility                                 |
| Runtime          | Python 3.10, 3.12, and 3.14; native Pandas, Polars, and DuckDB; R 4.4/4.5 transport contracts |
| VS Code          | minimum and current VS Code extension-host tests on Linux                                     |
| Native platforms | runtime and extension-host tests on macOS and Windows; Windows process-supervisor tests       |
| Package          | one VSIX build, package inspection, and a packaged VS Code journey on Linux                   |
| Security         | production dependency audits and CodeQL                                                       |
| Optional         | Remote SSH when the pull request has the `acceptance:remote-ssh` label                        |

The heavier jobs start only after two short preflight jobs pass. `Fast feedback` checks the source and generated
files, then `Contract tests` checks the Python, package, and workflow contracts. UI, coverage, engine, package, and
editor jobs keep the same checks, but they are skipped when either preflight already makes the pull request
unmergeable.

The R 4.4 and 4.5 jobs run the same native contract. Their explicit package set is resolved into a lockfile and
restored from a versioned cache, so an unchanged dependency set does not compile from scratch on every pull request.

Documentation-only changes run just the source checks. Changes limited to shipped documents such as the README also build the VSIX so the Marketplace package can be checked.

Ready pull requests limited to release infrastructure use a separate fail-closed tier. The pull request must change at
least one registered release script or focused release test exported by
`scripts/ci-path-classification.mjs`. It may additionally change only `CHANGELOG.md`, `README.md`, `docs/ci.md`,
`docs/media-gallery.md`, `docs/media-spec-v1.2.md`, `docs/releasing.md`, or `docs/testing.md`. Documentation by itself
cannot select this tier. An unlisted path, a classifier or shared workflow change, a product/runtime path, or one of
the registered shared script dependencies falls back to the complete matrix.
In particular, `.github/workflows/candidate-acceptance.yml` forces full CI until its semantic inspector owns an exact
per-job step inventory; `.github/workflows/release.yml` and `.github/workflows/stable-release.yml` likewise force full
CI while publication-permissioned jobs lack exact step inventories. Their inspectors and focused tests remain eligible
and run in the narrow job.
`.github/workflows/open-vsx-promotion.yml` also forces full CI until its inspector rejects unknown steps; its parser and
focused tests still run in the narrow job. `azure-pipelines-marketplace.yml` likewise forces full CI because changing
it together with its hash-owning inspector could otherwise bless a new baseline. No workflow or pipeline YAML is
eligible until an exact inventory is enforced independently of every allowlisted hash owner.

That focused tier still runs `Fast feedback`, a canonical VSIX build and inspection, the exact release transaction
and immutable-media tests, and real JavaScript/TypeScript CodeQL analysis. The required Python CodeQL, macOS/Windows
runtime, and Windows dependency-guard check names remain present through no-work carrier cells. Python, R, UI,
extension-host, and native editor execution remains reserved for a product change or the release-candidate boundary.
The focused job also executes the remote-Jupyter lock and editor-diagnostic artifact contracts because release
workflows depend on those boundaries; changing either test itself remains a full-matrix change.

The `validate` job reads the result of every required job. Missing, cancelled, failed, or unexpectedly skipped work keeps the pull request blocked. Cross-platform and CodeQL checks keep their stable names because the repository ruleset requires them directly.

Superseded pull-request runs are cancelled. Release jobs are never cancelled this way.

## Release candidates

Preview and stable release workflows build the VSIX once. Every acceptance job downloads and verifies that same artifact.

The release tier adds the expensive product checks that no longer run on every pull request:

- packaged VS Code on macOS and Windows;
- packaged Cursor on macOS and Windows;
- released Jupyter in fixed parallel Python, local-R-shard, and remote-R jobs: local and remote Python kernels in VS
  Code, local R in VS Code and Cursor, remote R in VS Code, and fresh focused Linux VS Code and Cursor invocations for
  value and categorical operations, the active R terminal, and R Markdown/Quarto;
- the native R contract in its own parallel sibling job;
- Remote SSH;
- installed performance in pinned VS Code and Cursor;
- the complete source, platform, package, accessibility, and security checks.

A release cannot publish until every candidate job passes. GitHub, Open VSX, and the Visual Studio Marketplace receive the accepted VSIX; none of them rebuild it.

The preview or stable release workflow invokes the shared candidate workflow exactly once through one non-matrix
caller. The reusable workflow owns its fixed internal parallel topology; callers cannot invent, omit, or duplicate a
lane through matrix input. Its output-free acceptance fan-in runs after all internal jobs and requires every literal
job result to be `success`. Publication independently and explicitly requires success from package production, that
candidate acceptance call, and Remote SSH.

Remote SSH starts from the packaged artifact alongside candidate acceptance instead of waiting behind it. That
overlap removes about three minutes from a successful release's wall time without removing any evidence: publication
still requires the package, the shared candidate call, and Remote SSH. If candidate acceptance fails, the already-running Remote SSH
job may finish anyway so its editor and namespace cleanup are not interrupted; the failed candidate still cannot
publish.

Python, remote R, the R 4.5.2 contract, and the two local-R shard cells are independent siblings. Every artifact
consumer verifies the same candidate VSIX; the R contract instead tests the exact source commit. The lifecycle shard
runs `core-operations`, then `kernel-restart`, then `interactive-terminal`, then `literate-documents`; the editing
shard runs `value-operations`, then `categorical-operations`. Dependency and editor setup happens once per shard, but
every phase immediately reverifies the exact candidate and starts a fresh VS Code-and-Cursor runner with new private
runtime, profile, result, progress, and log roots. Each runner is followed immediately by its own sealed
failure-evidence upload. A deferred shard-local raw-outcome check runs only after every phase assigned to that shard, so
an early failure cannot suppress later evidence or be overwritten by it. Core and value own 12 targeted operations
each, categorical owns two, and their representative Rename, native-frame, and exact 26-capability checks remain
intact. The dedicated restart phase owns Linux candidate kernel restart/reopen coverage under its own fresh phase
budget; the macOS and Windows candidate core invocations retain their existing embedded coverage.

The remote R sibling runs only the packaged VS Code Docker journey and retains its embedded restart/reopen journey and
`lowerText` (Lowercase) operation check; it does not install hosted R, local R packages, local kernel environments, or
native R/Quarto tooling. Internal
jobs and both shard matrix cells keep sibling cancellation disabled, so one failure cannot interrupt another owner's
editor or Docker cleanup. Every native editor phase retains its own 300-second hard deadline and 180-second inactivity
deadline without automatic retry. Explicit Linux core skips the embedded restart journey because `kernel-restart`
owns it in fresh Linux VS Code and Cursor processes. Explicit macOS and Windows core retain their embedded restart;
focused value and categorical selectors continue to skip it. Default/unset core retains that embedded journey, so the
manually dispatched Released Jupyter workflow remains an intentionally separate, backward-compatible,
non-authoritative diagnostic: its existing local-R core, value, categorical, and terminal phases are serial and use
their existing exact four-way fan-in. This routing removes only duplicate Linux scheduling and does not reduce
per-platform restart coverage. The manual workflow does not model or substitute for candidate acceptance.

Preview release run #72 reached the ordinary local-R 300-second deadline at numeric Round, lost Cursor's bounded
Multi-label Undo wait, and failed macOS Drop Columns Code Preview generation/diagnostics. Publication was skipped. Those
observations require a new exact-candidate Preview attempt; rerunning or reinterpreting that failed run cannot satisfy
the authoritative macOS or local-R gates.

Preview release [run #73](https://github.com/Matt17BR/openwrangler/actions/runs/31812029383) also published nothing.
macOS selected a generic wrapped `.ow_label` helper instead of the complete Drop Columns source-binding line. Linux
core reported correlated completion at about 299.5 seconds but missed outer 300-second process settlement before
Cursor core could start; the independent value invocation passed both editors in 6m34s total. The follow-up uses
unique exact logical-line selection and a balanced 12/12/2 core/value/categorical targeted split. The candidate
topology is redesigned into the two parallel local-R shards above; the 300-second hard deadline, 180-second inactivity
deadline, coverage, and no-retry rule remain unchanged. Run #73 is not release evidence.

Preview release [run #74](https://github.com/Matt17BR/openwrangler/actions/runs/31826709129) measured the redesigned
graph at 21m57s from release start versus run #73's 33m15s, a 34% reduction. The slower local-R shard took 15m19s
versus the former 31m15s serial lane, a 51% reduction. Total runner use increased from 119.75 to 130.78 minutes, or
9.2%. macOS was the measured bottleneck at 19m54s. Every raw
candidate lane except lifecycle core passed; core reached `restart:start` and then crossed the unchanged 300-second
outer deadline. Publication was skipped and no `v1.99.6` was created.

The dedicated `kernel-restart` phase is the next remediation: it removes restart/reopen only from explicit Linux core
and gives that journey its own verifier, private VS Code/Cursor run, sealed upload, 300-second hard deadline, and
180-second inactivity deadline before the lifecycle shard's deferred raw fan-in. Focused value and categorical
selectors remain restart-free, while explicit macOS and Windows core, default/unset core, and remote R retain their
existing restart coverage. It adds no retry or per-platform coverage reduction. Run #74 proves the prior topology's
measured wall-time reduction, not that this remediation passes or what its next hosted critical path will be; macOS
remains only the last observed bottleneck until a fresh candidate establishes otherwise.

Each release local-R shard uses the same commit-pinned dependency action, explicit package set, and
resolved-lock/binary-package policy as the pull-request contract matrix. GitHub scopes pull-request caches to their
merge refs, so a release dispatch cannot restore them. Later candidate dispatches may reuse a compatible cache created
on `main`; the first matching `main` dispatch performs a valid cold install. The R contract is a separate parallel
sibling rather than setup repeated inside either packaged-editor shard.

Remote R fixture preparation also keeps those bounds local to the work being proved. `Dockerfile.r.base` builds the
snapshot-pinned base, `Dockerfile.r` builds the R runtime from that exact owned image, and the existing
launch/readiness stage starts the server; each stage has an independent 300-second hard deadline and 180-second
inactivity deadline. Exact Docker engine, image, and owner receipts pass opaquely in process between stages. Cleanup
revalidates them while removing the container, runtime image, and base image in reverse order, and ownership
uncertainty still withholds failure evidence.

Cross-platform, CodeQL, and performance workflows also run on schedules so changes in external products are found
between releases. Released Jupyter is run manually when that integration needs to be checked. Dispatching the same
Released Jupyter target again cancels its older diagnostic run; a macOS, Windows, or Linux target does not cancel
either of the others. Release candidates are not replaced this way.

## Branches

The repository does not need permanent `develop`, `staging`, or maintenance branches. Reviewed changes merge to
`main`, and the release candidate VSIX is the staging artifact. A maintenance branch can be cut later if two
supported release lines genuinely need work at the same time.

This keeps promotion simple:

1. test the feature branch;
2. merge a ready pull request;
3. build and test one release candidate;
4. publish those exact bytes.

Routine Dependabot minor and patch updates are grouped once per ecosystem. Major and security updates remain separate.

## August 2026 review

A representative ready pull request before this change created 31 jobs across CI, cross-platform, and CodeQL. It used about 80 runner-minutes and finished in roughly 11 minutes because most jobs ran in parallel. The Python suite ran five times, extension-host tests ran four times, and packaged-editor journeys ran six times.

That was more than a merge check needed. macOS/Windows packaged VS Code, Cursor, and released-Jupyter journeys already run again against the exact release candidate. They now live at that release boundary. Native extension-host and Windows supervisor coverage were folded into the existing cross-platform jobs instead of paying for separate setup jobs.

The checks that catch ordinary code, runtime, UI, accessibility, packaging, and minimum-version regressions still block pull requests. The release workflow remains stricter than the pull-request workflow.

Useful comparisons:

- [VS Code Python workflows](https://github.com/microsoft/vscode-python/tree/main/.github/workflows)
- [VS Code Jupyter build and test workflow](https://github.com/microsoft/vscode-jupyter/blob/main/.github/workflows/build-test.yml)
- [Red Hat YAML extension CI](https://github.com/redhat-developer/vscode-yaml/blob/main/.github/workflows/CI.yaml)
- [GitHub concurrency documentation](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-workflow-concurrency)
- [GitHub reusable workflow documentation](https://docs.github.com/en/actions/reference/workflows-and-actions/reusing-workflow-configurations)
