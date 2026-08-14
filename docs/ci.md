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

## Failure-signal policy

Red is useful only when it has one narrow owner. Every blocking failure must classify as a product regression, a real
editor/runtime/platform compatibility regression, a violated package or release invariant, a deterministic
prerequisite failure, or an explicitly identified external-infrastructure outage. Interpreter, dependency, browser,
display, and private-profile prerequisites fail before an editor opens or a visual/product assertion begins. A phase
timeout with no product exception is a harness-budget defect, not evidence against the extension.

One comprehensive end-to-end owner proves each behavior. An additional editor, operating system, transport, or
registry lane must name the distinct compatibility seam it owns; otherwise the duplicate proof is removed. Pull
requests own source, coverage, workflow-contract, browser-baseline, and harness-adversarial suites. Release candidates
own the immutable VSIX, installed-editor compatibility, external integrations, performance, cleanup, provenance, and
publication invariants; they do not rerun source suites merely because release acceptance is stricter.

Automatic retries and larger timeouts are not flake policy. Fix, isolate, replace, or delete a nondeterministic check.
After a failed candidate, record only its first blocker, evidence owner, and one class: `product`, `release-invariant`,
`dependency/platform`, or `harness/runner`, together with GitHub's wall time and summed runner-minutes. In the rolling
last ten first-attempt candidate failures, at least nine must be product, genuine release-invariant, or real
dependency/platform signals. A second failure from the same `harness/runner` cause blocks another release attempt
until that gate is simplified or repaired; it must not grow another orchestration layer. This review uses the existing
run record and release notes, not a new metrics service.

## Release candidates

Preview and stable release workflows build the VSIX once. Every acceptance job downloads and verifies that same artifact.

The release tier adds the expensive product checks that no longer run on every pull request:

- focused packaged VS Code and Cursor `platform-smoke` compatibility on macOS and Windows, without native-R setup or
  execution;
- native-R platform acceptance in a separate macOS/Windows matrix, with fresh VS Code-only core, native-frame, and
  kernel-restart phases;
- released Jupyter in fixed parallel Python, Linux local-R-shard, and remote-R jobs: VS Code owns complete local and
  remote Python coverage while Cursor keeps one allowed Variables/renderer/page/close seam; local R runs in VS Code
  and Cursor, remote R in VS Code, and fresh focused Linux VS Code and Cursor invocations
  for core, native-frame, restart, the active R terminal, and R Markdown/Quarto, with the complete value and
  categorical catalogs owned once by Linux VS Code;
- native-R installed-artifact compatibility in the local and platform cells; protected pull-request CI remains the
  sole direct R-contract owner;
- Remote SSH;
- installed performance in pinned VS Code and Cursor, gated on first-grid timing, cache residency, scrolling,
  outstanding-work responsiveness, cancellation, and cleanup rather than whole-process-tree RSS sampling;
- one full generic packaged journey in Linux VS Code, a focused Linux Cursor `platform-smoke`, exact-artifact
  platform/package checks, live public-metadata and security audits, and the strict runtime benchmark;
  protected pull-request CI remains the sole owner of source, coverage, extension-host, browser-baseline, and
  accessibility suites.

Release prerequisites are explicit gates, not product evidence. Python resolution never searches PATH; browser work
uses the lockfile-pinned Playwright executable or one absolute override, private child-only profiles, and one bounded
preflight. A missing interpreter, dependency, browser, display, or profile capability therefore fails before editor or
visual assertions with a prerequisite classification instead of becoming a late acceptance timeout.

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

Python, remote R, the generic platform matrix, the native-R `r_platform` matrix, and the two Linux local-R shard cells
are independent siblings. Every candidate job proves the exact artifact or a live external release invariant; the
direct R 4.4/4.5 source contract remains solely in protected pull-request CI. Generic macOS/Windows platform cells own
only the packaged VS Code/Cursor `platform-smoke` compatibility seam without rerunning the pull request's extension-host
suite or preparing R. Linux VS Code is the sole full generic packaged owner; Linux Cursor runs the same focused smoke
rather than repeating that proof. Each `r_platform` cell prepares R once, then runs freshly
verified VS Code-only `core-operations`, `native-frames`, and `kernel-restart` invocations in that order. Its deferred
raw-outcome guard requires literal success from all three phases after their distinct immediate diagnostic uploads.

Linux lifecycle runs `core-operations`, then `kernel-restart`, then `interactive-terminal`, then
`literate-documents`; Linux editing runs `native-frames`, then `value-operations`, then `categorical-operations`.
Dependency and editor setup happens once per shard, but every phase immediately reverifies the exact candidate and
starts a fresh runner for its explicit editor set with new private runtime, profile, result, progress, and log roots. Each runner
is followed immediately by its own sealed failure-evidence upload. A deferred shard-local raw-outcome check runs only
after every phase assigned to that shard, so an early failure cannot suppress later evidence or be overwritten by it.
Core and value own 12 targeted operations each and categorical owns two. Candidate core, value, and categorical no
longer duplicate native-frame work: `native-frames` makes Linux VS Code the comprehensive collapse, viewing, Rename,
and Drop owner, while `kernel-restart` owns restart/reopen under a fresh phase budget. Cursor, macOS, and Windows retain
representative native-frame seams as well as representative core/editor/platform
seams, and the value/categorical phase runners therefore request only VS Code.

The remote R sibling runs only the packaged VS Code Docker journey and retains its embedded restart/reopen journey and
`lowerText` (Lowercase) operation check; it does not install hosted R, local R packages, local kernel environments, or
native R/Quarto tooling. Internal
jobs, platform cells, and both local-R shard matrix cells keep sibling cancellation disabled, so one failure cannot
interrupt another owner's editor or Docker cleanup. Every native editor phase retains its own 300-second hard deadline
and 180-second inactivity deadline without automatic retry. Explicit candidate core skips embedded native-frame and
restart work on Linux, macOS, and Windows because the dedicated selectors own both. Linux executes those selectors in
VS Code and Cursor; macOS and Windows execute them in VS Code, preserving the candidate coverage previously embedded in
their platform core. Focused value and categorical selectors also omit native-frame work and remain restart-free.
Default/unset core retains its embedded behavior, so the manually dispatched Released Jupyter workflow remains an
intentionally separate, backward-compatible, non-authoritative diagnostic: its existing local-R core, value,
categorical, and terminal phases are serial and use their existing exact four-way fan-in. Remote R likewise retains
its embedded behavior. The manual workflow does not model or substitute for candidate acceptance.

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

Preview release [run #75](https://github.com/Matt17BR/openwrangler/actions/runs/31834973654) from protected `main`
commit `917341a` finished in 21m18s and consumed 134.07 positive-duration runner-minutes. That was 39 seconds faster
and 3.29 runner-minutes more than #74, and 11m57s faster and 14.32 runner-minutes more than #73. Its sole raw candidate
failure was Linux lifecycle core: VS Code 1.133.0 crossed the 300-second outer deadline at about 300.012 seconds after
the last changed checkpoint `jupyter-r:orders_table:editing-renderer-ready`, with no product/runtime exception. The
dedicated Linux restart phase passed in both VS Code and Cursor, value and categorical editing passed, and both native-R
platform journeys passed with their then-embedded restart coverage. macOS nevertheless used about 289.66 of its
300-second native-editor budget. Publication was skipped, so no `v1.99.6` tag, prerelease, or registry package was
created.

Preview release [run #76](https://github.com/Matt17BR/openwrangler/actions/runs/31847608802) exercised that split from
exact protected `main` commit `ab6c5815`. It finished in 19m19s and consumed 95m20s of positive-duration runner time;
the first raw red arrived at 9m57s. Package production and canonical revalidation passed, and every raw lane was green
except installed performance's auxiliary `/proc` process-enumeration harness and Linux Cursor literate acceptance's
connected CodeMirror 0×0 layout race. Neither failure identified a numeric product regression, malformed package, or
release-invariant breach; both are classified `harness/runner` under the actionable-red policy. The fan-in still
failed, so publication was skipped and no `v1.99.6` tag, prerelease, or registry package was created.

The frozen remediation removes whole-editor-tree and runtime RSS sampling from installed performance while retaining
every timing, page-cache, responsiveness, cancellation, runtime/session cleanup, editor-ownership, and provenance
gate. The literate harness dispatches and boundedly settles one Quarto command, pins its exact tab/group/terminal,
proves ordinary preview cleanup and absence before the title action, and retains that preview only through media
capture. Post-draft generated-R acceptance requires exact hydration plus the matching host receipt, then waits for one
same-generation full geometry to remain stable across two animation-frame observations. No editor action is retried,
and the 300-second hard and 180-second inactivity deadlines are unchanged. These fixes have local contract evidence but
no hosted proof; only a fresh exact candidate can make them release evidence.

Each release local-R shard and `r_platform` cell uses the same commit-pinned dependency action, explicit package set, and
resolved-lock/binary-package policy as the pull-request contract matrix. GitHub scopes pull-request caches to their
merge refs, so a release dispatch cannot restore them. Later candidate dispatches may reuse a compatible cache created
on `main`; the first matching `main` dispatch performs a valid cold install. The source-only R contract stays in
protected pull-request CI rather than running inside or beside either packaged-editor shard.

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
