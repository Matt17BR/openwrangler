# CI and release checks

Open Wrangler uses three test levels. The everyday pull-request checks should find ordinary mistakes quickly. Editor and registry checks run against a packaged VSIX before a release. Scheduled jobs watch external dependencies such as VS Code, Jupyter, Python, and security advisories.

## Pull requests

The current PR workflow runs the invariant core for every pull-request head, including drafts. The core is the
complete portable, TypeScript, and Python 3.10 public-boundary inventory: `npm run check:pr`, the full development audit, and the
Python plus hashed-fixture audits. After classification, every selected changed-area owner starts independently beside
the invariant core instead of waiting for it. `validate` remains the sole CI outcome owner: it waits for the core and
every changed-area owner, then rejects a missing, failed, cancelled, or unexpectedly skipped selected job.

The sole classifier emits exactly four booleans:

- `r_contract_required` selects both R 4.5 owners. `R 4.5 kernel contract` runs the isolated kernel-agent shard;
  `R 4.5 protocol contracts` runs the two remaining shards sequentially and fail-complete.
- `canonical_editor_required` selects the canonical VSIX plus stable extension-host owner for extension, runtime,
  session, protocol, and package changes.
- `visual_accessibility_required` selects the production-bundle Playwright visual and axe owner for UI/media changes.
- `windows_unique_required` selects Windows publication, filesystem identity/reparse/hard-link, process supervision,
  dependency-install, and cleanup evidence.

Classifier/workflow/toolchain/result-owner/R-lock changes select the complete union. Missing or malformed classifier
output, an invalid path, and every unmatched substantive path also fail open to that union. Documentation cannot
classify a product, package, runtime, protocol, or workflow change away when it accompanies that change.

A successful pull-request run retains no ordinary artifact. Visual actual/diff evidence is uploaded for seven days
only on failure. Release workflows retain their separately reviewed artifact contracts.

The R dependency consumer validates one canonical per-minor Ubuntu 24.04 x86_64 lock before filesystem or network
mutation. It downloads only the dated binary archives recorded by byte size and SHA-256, installs verified local
archives into an empty private library with repository resolution disabled, verifies the exact package set and loaded
namespaces, and seals deterministic package/tree receipts. Cache keys bind the runner image, architecture, exact R
runtime/platform, lock digest, and installer digest, with no restore keys. The cache contains only the lock-pinned
archives. Both a hit and a miss authenticate the complete archive inventory, descriptor identities, sizes, and
SHA-256 values, then install those archives into a fresh empty private library before namespace verification. No
installed library, package/tree receipt, or executable package state is restored from cache.

Pull requests retain both selected R 4.5 owners without the temporary pull-request R 4.4 compatibility carrier.
Cross no longer has a pull-request trigger or classifier carriers; its manual dispatch and weekly schedule run the
macOS/Windows runtime matrix, Windows dependency guards, and the lock-backed R 4.4 qualification. CodeQL retains the
`Analyze (javascript-typescript)` and `Analyze (python)` jobs as two always-on analyzers and requires both exact results
through `CodeQL gate`.

All non-local workflow actions are pinned to reviewed 40-hex revisions. The recursive contract in
`scripts/ci-workflow.test.mjs` rejects a moving tag anywhere in `.github/workflows` and rejects a missing or malformed
changed-area classifier/result edge.

The ruleset requires only integration-bound `validate` and `CodeQL gate`. The exact attempt-1 comparison in
[the 2026-08-17 topology measurement](ci-topology-measurement-2026-08-17.md) records 23 to 11 executed jobs and
4,042 to 1,880 summed runner seconds between the pre-selection and path-selected cohorts. That is a 52.2% job-count
and 53.5% observed runner-time reduction. It is one controlled exact-head comparison, not a p95 or reliability claim;
the rolling wall-time and first-attempt reliability gates remain open.

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
The package producer first lets the lockfile-owned VSCE API create a raw archive in a private sibling (mode `0700` on
POSIX and the identity-pinned writable host contract on Windows), then publishes only its canonical files-only form:
bytewise UTF-8 order, STORE compression, fixed ZIP timestamps, exact `100644` ZIP modes, and unchanged entry bytes.
STORE remains compatible with ordinary VSIX readers; the accepted tradeoff is an approximately 5 MB artifact instead
of the current approximately 1.2 MB compressed package. Complete source and archive receipts plus a portable internal
manifest are revalidated before and after atomic no-clobber hard-link publication. The manifest is not an artifact or
provenance field. Disposable nonpublishing previews from protected `main` may exercise the path. A future release
candidate requires explicit review, a soak of those same bytes, and a separate one-shot promotion; no candidate job,
readiness rule, provenance contract, or publication topology changes with this foundation.

The release tier adds the expensive product checks that no longer run on every pull request:

- focused packaged VS Code `platform-smoke` OS compatibility on macOS and Windows, without native-R setup or
  execution, while one pinned Linux Cursor smoke owns generic fork compatibility;
- native-R platform acceptance in a separate macOS/Windows matrix, with fresh VS Code-only core, native-frame, and
  kernel-restart phases;
- released Jupyter in fixed parallel Python, Linux local-R-shard, and remote-R jobs: VS Code owns complete local and
  remote Python coverage while Cursor keeps one allowed Variables/renderer/page/close seam; local R runs in VS Code
  and Cursor, remote R in VS Code, and fresh focused Linux VS Code and Cursor invocations
  for core, native-frame, restart, the active R terminal, and R Markdown/Quarto, with the complete value and
  categorical catalogs owned once by Linux VS Code;
- native-R installed-artifact compatibility in the local and platform cells; protected pull-request CI owns the R 4.5
  source contracts, while scheduled/manual Cross owns the R 4.4 source qualification;
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
direct R 4.5 source contract remains in protected pull-request CI, while the direct R 4.4 source contract remains in
scheduled/manual Cross. Generic macOS/Windows platform cells own
only the packaged VS Code `platform-smoke` OS seam without rerunning the pull request's extension-host suite or
preparing R. Linux VS Code is the sole full generic packaged owner; one pinned Linux Cursor run owns the focused fork-
compatibility smoke rather than multiplying it across operating systems. Each `r_platform` cell prepares R once, then runs freshly
verified VS Code-only `core-operations`, `native-frames`, and `kernel-restart` invocations in that order. Its deferred
raw-outcome guard requires literal success from all three phases after their distinct immediate diagnostic uploads.

The Windows/Python 3.14 runtime cell runs the complete Python suite, including `test_dependency_guard.py`. The focused
Windows dependency-guard matrix therefore covers only Python 3.10 and 3.12; adding a separate 3.14 cell would execute
the identical test under the identical interpreter and operating system without adding a compatibility boundary.

Linux lifecycle runs `core-operations`, then `kernel-restart`, then `interactive-terminal`, then
`literate-documents`; Linux editing runs `native-frames`, then `value-operations`, then `categorical-operations`.
Dependency and editor setup happens once per shard, but every phase immediately reverifies the exact candidate and
starts a fresh runner for its explicit editor set with new private runtime, profile, result, progress, and log roots. Each runner
is followed immediately by its own sealed failure-evidence upload. A deferred shard-local raw-outcome check runs only
after every phase assigned to that shard, so an early failure cannot suppress later evidence or be overwritten by it.
Explicit candidate core keeps its existing job, phase, and selector but owns one full installed Clone Column lifecycle:
preview, apply, applied-step inspection, edit and reapply with the same step/output identities, then undo. Dedicated
local-source contracts now own the strict ordered 28-operation live/generated catalog and byte-exact clipboard/atomic
script exports of distinct executable operation-labelled buffers. Current source therefore exposes all 28 operations
but remains **Partial** until a fresh hosted candidate plus installed all-28 and performance evidence pass. The private
R transport is v14; public protocol v2 and every candidate job, selector, phase, 300-second hard deadline, 180-second
inactivity deadline, and no-retry boundary remain unchanged. Candidate core,
value, and categorical do not duplicate native-frame work: `native-frames` makes Linux VS Code the comprehensive
collapse, viewing, Rename, and Drop owner, while `kernel-restart` owns restart/reopen under a fresh phase budget.
Value and categorical ownership is unchanged, and Cursor, macOS, and Windows retain their representative
core/editor/platform and native-frame seams.

The Native R performance runner's unit contracts and report validators are portable script contracts owned by
`npm run test:scripts:portable`, which the unconditional PR workflow's `invariant-core` job runs through `check:pr`.
Those tests exercise
exact-candidate/source/executable binding, the 250,000×20 fixture and fixed 5/20 workload schedules, response
accounting, bounded path-free reporting, atomic output, resource proofs, and cleanup failures without running the
Linux-only benchmark against a mutable CI workspace. The hosted R 4.4/4.5 frame-contract process parses the tracked R
harness without adding a process. This infrastructure adds no workflow job, classifier category, candidate selector,
phase, editor deadline, upload, retry, or publication edge. The harness's 300-second process bound is lifecycle safety,
not a numeric performance gate. In particular, the v1 report has no accepted threshold profile and cannot claim a
release pass. A fresh exact-candidate performance run and the later stable record authoring/consumption change remain
separate release work.

The remote R sibling runs only the packaged VS Code Docker journey and retains its embedded restart/reopen journey and
`lowerText` (Lowercase) operation check; it does not install hosted R, local R packages, local kernel environments, or
native R/Quarto tooling. Internal
jobs, platform cells, and both local-R shard matrix cells keep sibling cancellation disabled, so one failure cannot
interrupt another owner's editor or Docker cleanup. Every native editor phase retains its own 300-second hard deadline
and 180-second inactivity deadline without automatic retry. Explicit candidate core skips embedded native-frame and
restart work on Linux, macOS, and Windows because the dedicated selectors own both. Linux executes those selectors in
VS Code and Cursor; macOS and Windows execute them in VS Code, preserving the candidate coverage previously embedded in
their platform core. Focused value and categorical selectors also omit native-frame work and remain restart-free.
Default/unset manual core retains its full catalog and embedded behavior, so the manually dispatched Released Jupyter workflow remains an
intentionally separate, backward-compatible, non-authoritative diagnostic: its existing local-R core, value,
categorical, and terminal phases are serial and use their existing exact four-way fan-in. Remote R likewise retains
its representative embedded behavior. The manual workflow does not model or substitute for candidate acceptance.
The 27th operation changes no candidate selector, job, phase, shard, deadline, inactivity bound, or retry policy.

Preview release run #72 reached the ordinary local-R 300-second deadline at numeric Round, lost Cursor's bounded
Multi-label Undo wait, and failed macOS Drop Columns Code Preview generation/diagnostics. Publication was skipped. Those
observations require a new exact-candidate Preview attempt; rerunning or reinterpreting that failed run cannot satisfy
the authoritative macOS or local-R gates.

Preview release [run #73](https://github.com/Matt17BR/openwrangler/actions/runs/31812029383) also published nothing.
macOS selected a generic wrapped `.ow_label` helper instead of the complete Drop Columns source-binding line. Linux
core reported correlated completion at about 299.5 seconds but missed outer 300-second process settlement before
Cursor core could start; the independent value invocation passed both editors in 6m34s total. The follow-up uses
unique exact logical-line selection and moved Formula into the independent value slice. The candidate topology was
redesigned into the two parallel local-R shards above; its later core journey is now the bounded Clone lifecycle rather
than an accumulated catalog. The 300-second hard deadline, 180-second inactivity deadline, and no-retry rule remain
unchanged. Run #73 is not release evidence.

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
gate. Ordinary `.qmd` candidate acceptance now invokes the Open Wrangler title action directly and owns only exact
session/source/code/cleanup product invariants; it neither dispatches nor observes third-party preview/render/tab/server
state. Linux media capture alone dispatches and boundedly settles one Quarto command, identifies the exact
`mainThreadWebview-quarto.previewView` `TabInputWebview`, proves stable HTML and visible preview, and performs bounded
cleanup. Post-draft generated-R acceptance requires exact hydration plus the matching host receipt, then waits for one
same-generation full geometry to remain stable across two animation-frame observations. No editor action is retried,
and the 300-second hard and 180-second inactivity deadlines are unchanged. These fixes have local contract evidence but
no hosted proof; only a fresh exact candidate can make them release evidence.

Preview release [run #78](https://github.com/Matt17BR/openwrangler/actions/runs/31854945486) from exact protected
`main` commit `add29a1e096bb8eb25f154dfcd1a7f0f3f6be7e0` authored canonical artifact `9238748514`, whose exact
1,132,638-byte VSIX has SHA-256 `45ff8cf81d682007039167b253e32053df79d7eff2e21f5bb9a33e238ebfe99c`;
checksum and provenance verification passed, as did installed-performance artifact `9238855519`. Three raw reds
blocked the fan-in. Cursor `platform-smoke` artifact `9238818316` is a product renderer-liveness failure: an attached
Open Wrangler webview contained no root, app, or grid while the host retained the exact hydrated receipt. The artifact
does not identify the physical retirement event that produced the mismatch. Native-R core artifact `9238867261` is indeterminate
`harness/runner` evidence: edited Clone apply followed a long accumulated catalog journey without decisive
dispatch/scheduler/final-state receipts. Literate artifact `9238988590` is a deterministic `harness/runner` failure:
the finder required external `quarto.previewView`, although VS Code exposes the tab as prefixed
`mainThreadWebview-quarto.previewView`; its later `ERR_CONNECTION_REFUSED` followed missed preview ownership and
cleanup rather than proving a product defect. Publication was skipped, so that run created no `v1.99.6` tag, GitHub
prerelease, Open VSX package, or Azure Marketplace package.

The locally frozen product correction flushes presentation state and sends one exact receipt-bound retirement on a
non-persisted `pagehide`; the host accepts only its current hydrated session/revision, invalidates renderer state, and
uses the existing bounded HTML reload without reopening the runtime. Persisted, stale, malformed, unhydrated,
disposed, and host-replacement receipts do nothing. Hard process death without a lifecycle event remains out of scope;
no heartbeat, timeout, retry, selector, job, or phase was added. The candidate-core and Quarto ownership corrections
above are likewise local and unhosted. Run #78 remains failed evidence, and only a fresh exact candidate can prove the
corrections.

Preview release [run #79](https://github.com/Matt17BR/openwrangler/actions/runs/31859989213) from exact protected
`main` commit `4ed4d8d4422040dd5f1bcaae274a41fd3fd9cef8` passed every candidate and Remote SSH owner and published
`v1.99.6` successfully. Canonical artifact `9240263388` contained the 109-entry VSIX with SHA-256
`5a9c6eb7531ccd521c20a08ab2fd3a7d99776ea10d5e48a5eb5756d03b553404`; installed-performance artifact
`9240376365` passed. The post-public media gate nevertheless needed 24 classified retries: five were genuine
Marketplace stale-version propagation, while 19 were GitHub exact-source Playwright DOM detachments incorrectly
treated as propagation. The release and registry publication remain successful, but those 19 observations are
`harness/runner` faults and must never make a green result by retrying.

The corrected CI contract checks GitHub exact source once, outside registry retries. One bounded same-page evaluation
may absorb an A-to-B image replacement, but B must then remain identical for two consecutive post-scroll frames. The
source observation, a navigation with no HTTP response, and escaped browser, DOM, evaluation, scroll, or
animation-frame errors are terminal. Exhaustion after a candidate disappears, keeps changing, remains CSS-hidden,
has invalid geometry, or produces a complete positive proof that fails to stabilize is also terminal. Only explicitly
classified Marketplace or Open VSX observations may use up to 40 fresh registry contexts: a stale version, README
content, or immutable image source; an initially missing or incomplete exact-alt image; or an actual non-OK HTTP
response. The one source check and registry attempts share the unchanged 30-minute deadline. This adds no timeout,
retry count, workflow job, phase, matrix cell, or topology. Stable v2 remains blocked on this verifier gate until the
correction lands on protected `main` and a fresh preview proves that public-media path.

Each release local-R shard and `r_platform` cell uses the same commit-pinned dependency action, explicit package set, and
resolved-lock/binary-package policy as the pull-request contract matrix. GitHub scopes pull-request caches to their
merge refs, so a release dispatch cannot restore them. Later candidate dispatches may reuse a compatible cache created
on `main`; the first matching `main` dispatch performs a valid cold install. The R 4.5 source contract stays in
protected pull-request CI and the R 4.4 source contract stays in scheduled/manual Cross rather than running inside or
beside either packaged-editor shard.

Remote R fixture preparation also keeps those bounds local to the work being proved. `Dockerfile.r.base` builds the
snapshot-pinned base, `Dockerfile.r` builds the R runtime from that exact owned image, and the existing
launch/readiness stage starts the server; each stage has an independent 300-second hard deadline and 180-second
inactivity deadline. Exact Docker engine, image, and owner receipts pass opaquely in process between stages. Cleanup
revalidates them while removing the container, runtime image, and base image in reverse order, and ownership
uncertainty still withholds failure evidence.

Cross-platform, CodeQL, and performance workflows also run on schedules so changes in external products are found
between releases. CodeQL additionally runs both configured languages on every push to protected `main`, which keeps
default-branch alerts current. Released Jupyter is run manually when that integration needs to be checked. Dispatching the same
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
