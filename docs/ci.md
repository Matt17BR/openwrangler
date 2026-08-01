# Continuous-integration ownership

Open Wrangler keeps correctness, security, packaging, accessibility, and native-editor evidence blocking. The CI split exists to identify the failing boundary sooner; it does not remove a test, retry an editor phase, lower a threshold, or turn a production audit advisory.

## Pull-request check map

| Check                               | Owner                        | Failure class                                                                                                 | Artifact dependency              |
| ----------------------------------- | ---------------------------- | ------------------------------------------------------------------------------------------------------------- | -------------------------------- |
| `CI change classification`          | PR scope                     | exact base/head path classification is missing, malformed, empty, mixed, or outside the narrow docs allowlist | none                             |
| `Fast feedback`                     | source quality               | formatting, ESLint, TypeScript, generated protocol/reference/docs, licenses, workflow structure               | none                             |
| `Contract tests`                    | tooling contracts            | Python lint/types, brand and lock freshness, portable script contracts                                        | none                             |
| `Visual and accessibility`          | webview UI                   | runtime-backed deterministic screenshots, production CSS/fonts, axe acceptance                                | none                             |
| `Production dependency audits`      | supply chain                 | npm production advisories, Python/runtime-lock advisories                                                     | live advisory databases; no VSIX |
| `canonical-vsix`                    | packaging                    | clean production build, allowlist, checksum-bound artifact publication                                        | produces the one PR VSIX         |
| `Packaged VS Code (Linux)`          | Linux product acceptance     | checksum, packaged install, trusted/untrusted journeys, recovery, cleanup                                     | canonical VSIX                   |
| `coverage`                          | runtime and shared contracts | complete instrumented TypeScript/Python suites and unchanged floors with the exact optional PySpark runtime   | none                             |
| `python-matrix`                     | Python compatibility         | complete Python 3.10 and 3.14 runtime suites                                                                  | none                             |
| `extension-host`                    | supported VS Code range      | minimum and current Linux extension-host integration                                                          | none                             |
| `Native script contracts (Windows)` | platform harness             | real Windows Job Object compilation, descendant containment, termination, and malformed-frame rejection       | none                             |
| `Native extension host`             | native VS Code integration   | macOS/Windows stable extension-host integration                                                               | none                             |
| `Native editor`                     | packaged VS Code             | macOS/Windows checksum-bound installed-editor acceptance                                                      | canonical VSIX                   |
| `Cursor smoke`                      | packaged Cursor              | macOS/Windows install, activation, grid, icon, navigation, and cleanup                                        | canonical VSIX                   |
| `VS Code with released Jupyter`     | notebook integration         | affected-path released Jupyter, local/remote kernels, renderer, restart, and cleanup                          | canonical VSIX                   |
| `Remote SSH acceptance`             | remote workspace             | opt-in, label-gated packaged Remote SSH journey                                                               | canonical VSIX                   |
| `validate`                          | required aggregate           | blocking jobs must succeed; conditional Jupyter/Remote SSH results must match their classifiers               | all of the above                 |

The `validate` job retains the existing protected check name. It uses `!cancelled()` so its result step executes after failed or skipped dependencies while a superseded pull-request head can stop without running an obsolete aggregate. `scripts/require-ci-results.mjs` requires classification and `Fast feedback` to succeed on every pull request. For an exact documentation-only pull request it then requires every product lane to be `skipped`; for every other pull request and every protected-branch push it requires those same lanes to be `success`. Missing, malformed, contradictory, cancelled, or unexpectedly successful/skipped results fail the aggregate on the current head. Released-Jupyter acceptance must succeed for every affected substantive pull request and must be skipped for documentation-only pull requests and protected-branch pushes. When `acceptance:remote-ssh` is present on a substantive pull request, Remote SSH is required to succeed; otherwise it is required to be skipped.

The shared classifier compares exact lowercase pull-request base and head commits using a NUL-delimited, rename-disabled Git diff and fatal UTF-8 decoding. The fast path is deliberately limited to non-packaged `docs/**`, root contributor/security/agent guides already excluded by `.vscodeignore`, and issue or pull-request templates. An empty diff, a mixed diff, an unknown path, or any package, build, workflow, asset, runtime, or test change selects the full matrix. `README.md`, `CHANGELOG.md`, `LICENSE`, and `THIRD_PARTY_NOTICES.md` remain substantive because they alter shipped VSIX bytes. Pushes, schedules, and manual runs always select the full workflow.

Only `Fast feedback` executes substantive work on a documentation-only pull request, so formatting, ESLint, strict TypeScript, generated protocol/reference/docs freshness, license inventory, and workflow contracts still run. Canonical packaging, runtime/coverage, visual, native editor, Cursor, and Jupyter lanes in the main CI workflow use one job-level condition and report explicit skipped job results to `validate`. Expanded names from its internal matrices are not protected contexts; the aggregate consumes the stable job IDs instead. This avoids hundreds of duplicated step predicates. The fail-closed aggregate accepts that skipped result set only alongside an exact successful documentation classification. On a missing or invalid classification, the condition defaults to running the full lane and the aggregate still fails the classifier.

Affected released-Jupyter acceptance downloads and revalidates the same run-scoped `openwrangler-vsix` artifact used by the other packaged PR consumers. The separate weekly/manual workflow remains an ecosystem-drift lane and self-packages only because it has no caller artifact.

Cross-platform runtime matrices and CodeQL remain separate workflows with directly protected expanded contexts. A hosted documentation-only probe proved that skipping a matrix at job level emits only a generic, unexpanded check name, which cannot satisfy protection configured for its cells. These matrices therefore always expand with their exact existing names. In documentation-only mode each cell runs only the classification gate and a tiny context carrier, then succeeds without checkout, toolchain setup, analysis, or tests. Substantive PRs and all non-PR events run every full cell. A failed or non-boolean classification also expands every cell, fails its first gate, and keeps all expensive steps dormant. The CI aggregate does not claim to summarize a workflow it cannot depend on.

Superseded pull-request runs are cancelled within the same ref-scoped concurrency group. Pushes to protected
`main`, scheduled ecosystem checks, manual release validation, and publication are never cancelled by that policy.
This avoids spending hosted-editor time on a commit that can no longer merge while preserving every durable evidence
run.

The visual lane installs the same bundled-runtime development extras used to generate its synthetic protocol
fixtures. This is intentional: the accepted scenes exercise native Pandas, Polars, and DuckDB responses rather than
static hand-authored JSON. Missing an engine dependency is therefore a visual-fixture setup failure, not permission
to fall back to reconstructed UI.

The workflow-structure contract has exactly one pull-request owner, `Fast feedback`; every remaining general or
Linux-owned `scripts/*.test.mjs` contract has exactly one owner, `Contract tests`; and the extracted compiled Job
Object supervisor smoke has exactly one owner, `Native script contracts (Windows)`. macOS no longer repeats the
general corpus; its native extension-host and packaged VS Code/Cursor jobs remain unchanged. The local
`npm run test:scripts` command remains the complete superset of all three groups. Its filesystem-derived regression
requires the workflow, portable, and native file sets to be pairwise disjoint and their union to equal the actual
`scripts/*.test.mjs` inventory, while the parsed workflow rejects a second CI owner for any group.

The coverage lane is the single authoritative owner of the complete TypeScript and Python suites. It installs and
verifies Java 17, PySpark 4.2, and compatible Pandas before running the full Python corpus, including the native
PySpark adapter contracts. `Contract tests` therefore does not repeat the plain TypeScript or Python commands, and
there is no second focused PySpark job that can report the same source result under another name. The stable Linux
release lane similarly runs script contracts once and then the instrumented suites once.

## Branch and promotion model

Open Wrangler does not add permanent `develop` or `staging` branches. Feature branches merge through the fail-closed
pull-request gate. Staging is the immutable, checksum-bound VSIX that release acceptance installs in VS Code and
Cursor; production promotion sends those exact accepted bytes to GitHub, Open VSX, and the Visual Studio Marketplace
without rebuilding them. The only additional long-lived line is the narrowly scoped v1 maintenance branch below.

The source policy reserves a protected `release/1.x` maintenance branch for stable v1 versions and `main` for the
`1.99.x` v2 preview line and later v2 releases. CI, CodeQL, and native cross-platform checks run for pull requests and
pushes on both protected branches. Stable metadata, tag publication, and Marketplace recovery derive their permitted
branch from the numeric version rather than trusting a caller-supplied ref. Until the live `release/1.x` branch and
its matching ruleset and publishing-environment policy are created, a v1 stable release is intentionally impossible;
an automatic Marketplace recovery run from the now-inactive `main` branch finishes as a no-op.

Create `release/1.x` once, from the final reviewed v1 commit after shared release infrastructure has landed, before
the first public `1.99.x` preview. A v1 fix starts from and merges into `release/1.x`. Forward-port the resulting exact
squash commit through a separate reviewed pull request to `main`, recording the maintenance pull request in its
description; resolve conflicts on that forward-port branch. Never merge the evolving v2 `main` line wholesale back
into v1. Shared release-infrastructure fixes normally land on `main` first and are then backported through a reviewed
maintenance pull request when v1 publication needs them. Marketplace pre-releases remain deliberate releases;
scheduled and nightly runs may retain artifacts and trend reports but never publish automatically.

The preview promotion boundary is candidate-first rather than tag-triggered. One manual run from protected `main`
packages a provenance-bound VSIX/checksum/provenance triple once. Complete Linux acceptance owns the full source and
instrumented suites exactly once; macOS/Windows native smoke, installed performance, released/remote Jupyter, and
Remote SSH consume the same artifact in parallel. A fail-closed fan-in gates an optional protected publication job.
The default `publish: false` path has no environment, secret, write permission, tag push, or registry mutation and
must not be cited as proof of those live boundaries. Stable publication, preview publication, and reusable Open VSX
promotion share the non-cancelling `openwrangler-release-publication` queue with `queue: max`, preventing a newer
pending version from displacing an older one. Both channels call Open VSX explicitly after GitHub because a release
created by `GITHUB_TOKEN` does not reliably fan out through a release event. The Microsoft Marketplace remains driven
by the real lightweight-tag push and consumes the same public canonical triple.

GitHub's future-only immutable-release setting is enabled. Both stable and preview workflows require
`immutable: true` before registry promotion; a missing or false response fails closed. The completed rollout first
merged the draft-first publisher with a migration expectation, then enabled the repository setting, and only then
made this source contract mandatory, so publication never crossed an incompatible intermediate state.

## 2026-08 pipeline audit

A typical substantive pull request used roughly 80 hosted runner-minutes: about 57 in the main CI workflow, 7 in
cross-platform runtime, 4 in CodeQL, and 10 to 14 in released-Jupyter acceptance. The distinct packaged VS Code,
Cursor, Jupyter, accessibility, performance, and publication gates have caught user-facing failures and remain.
The first reduction removes only same-source duplication, cancels obsolete PR heads, and preserves all externally
protected check names. Affected pull-request released-Jupyter acceptance now consumes the same canonical VSIX as
the other packaged jobs; its standalone workflow remains schedule/manual-only. Substantive pull requests retain every
broad compatibility matrix. Only exact non-packaged documentation changes use the bounded fast path described above.

The model follows proven upstream patterns rather than inventing a three-branch ceremony: VS Code Python keeps a
main development line plus release branches and separates stable from prerelease publication; VS Code Jupyter
cancels superseded work, schedules broader compatibility, and retains failure artifacts; GitLens keeps focused PR
quality and integration gates while running broader editor coverage separately; and pandas reserves expensive wheel
matrices for labels, schedules, manual dispatch, and releases. Open Wrangler remains stricter where its product needs
it: one checksum-bound VSIX must pass real VS Code, Cursor, notebook, performance, and registry gates before
publication.

### Post-v1.2 decision

The audit does **not** justify moving the current product gates out of ready pull requests. Open Wrangler's highest-risk
boundaries are the ones that ordinary unit tests cannot reproduce: installing the packaged VSIX, starting the bundled
runtime, opening the grid in two editors, talking to a released Jupyter extension, rendering the production webview,
and cleaning up native processes on three operating systems. Those checks have found user-visible defects, and the
current split runs them in parallel rather than putting them on one serial critical path.

[Pull request 189](https://github.com/Matt17BR/openwrangler/pull/189) is the first substantive exact-head sample after
the duplicate-work and canonical-Jupyter changes. All 27 reported contexts passed without a retry. Fast feedback took
1 minute 15 seconds, the longest affected product lane (released Jupyter) took 6 minutes 31 seconds, and the protected
aggregate completed roughly 8 minutes after workflow creation. That is an acceptable merge delay for a release-grade
desktop extension, even though the parallel jobs consume materially more hosted runner time.

A review of the preceding 100 workflow runs also did not support the impression that current `main` is randomly red.
The five failed CI runs were on the pre-consolidation v1.2 release branch or the two historical R draft branches. They
included real source/document contract failures, one packaged Cursor failure, and downstream aggregate failures; the
separate cross-platform workflow completed 24 of 24 non-cancelled runs successfully and CodeQL completed 26 of 26.
The older standalone released-Jupyter failures duplicated packaging and source checks; that duplication was removed in
PR 188. Historical failures remain useful evidence, but they are not a reason to retry or weaken a failing current job.

The development loop should therefore optimize _when_ the complete matrix is requested rather than silently test less:

1. Run the narrow tests owned by the changed boundary while iterating locally. Do not repeatedly run the full matrix,
   package, media capture, and native editors for each small commit.
2. Push durable checkpoints to the feature branch without opening a pull request when the work is not ready for the
   complete exact-head matrix. An open draft currently receives the same evidence as a ready pull request.
3. Open or update the ready pull request for one coherent slice, let superseded heads cancel, and require the complete
   protected result once before squash merge.
4. Run the broader scheduled ecosystem/performance checks and the complete candidate matrix again at the immutable VSIX
   promotion boundary. Publication always consumes those accepted bytes; it never rebuilds them.

This policy will be revisited after at least 20 post-consolidation substantive pull requests. A further split should be
evidence-led, for example a repeated external-service failure rate above 5 percent or a normally queued aggregate p95
above 12 minutes, rather than a reaction to a legitimate test exposing unfinished code. Documentation-only
classification is already a bounded fast path. Draft-only fast feedback and extracting the shared stable/preview
acceptance fan-out into a reusable workflow remain possible future savings, but neither should be introduced without
proving that required contexts still fail closed when the pull request becomes mergeable.

- [VS Code Python pull-request and build workflows](https://github.com/microsoft/vscode-python/tree/82940c942228f819121302657375c81b5d42d36a/.github/workflows)
- [VS Code Jupyter build and test workflow](https://github.com/microsoft/vscode-jupyter/blob/eb3597ff0739386d99382c2f68aa6c9c15041ed1/.github/workflows/build-test.yml)
- [GitLens continuous integration workflow](https://github.com/gitkraken/vscode-gitlens/blob/8adb9466d4d7b80b9e822924e82c4cc6710cf81c/.github/workflows/ci.yml)
- [pandas wheel workflow](https://github.com/pandas-dev/pandas/blob/4bf6394817fe69d81ec1599617c6571c841195aa/.github/workflows/wheels.yml)
- [VS Code pre-release extension guidance](https://code.visualstudio.com/api/working-with-extensions/publishing-extension#pre-release-extensions)

## Baseline and targets

[CI run 30626586848](https://github.com/Matt17BR/openwrangler/actions/runs/30626586848) is the pre-split baseline for source `6ac322e2fb914e8f0420cf097623c715b30f1047`. Fast feedback completed 80 seconds after workflow creation. The monolithic Linux `validate` lane ran for 8 minutes 9 seconds after waiting for packaging. The Windows native lane reported its extension-host failure 10 minutes 6 seconds after workflow creation and skipped both packaged-editor consumers because that unrelated check preceded them.

The first reviewed target is to report a deterministic source failure within 3 minutes and a native script or extension-host failure within 6 minutes of workflow creation on a normally queued hosted runner, a 40% reduction from the Windows baseline. The split must also keep the aggregate critical path at or below the 10 minute 6 second baseline. Confirm these targets with repeated real pull-request runs before treating the CI organization issue as complete; hosted-runner queue time must be recorded separately from job execution time.

[CI run 30633059407](https://github.com/Matt17BR/openwrangler/actions/runs/30633059407) is the first complete green split run, at exact source `e04e5e4c4f66ce3a580a5a51d8b3b40df60cbc0f`. Its first jobs waited 55 seconds for a runner; `Fast feedback` then completed 1 minute 57 seconds after workflow creation, and the fail-closed `validate` aggregate completed after 7 minutes 51 seconds.

Four later green final-design runs provide the repeated timing sample: [30647077916](https://github.com/Matt17BR/openwrangler/actions/runs/30647077916), [30666826312](https://github.com/Matt17BR/openwrangler/actions/runs/30666826312), [30668060953](https://github.com/Matt17BR/openwrangler/actions/runs/30668060953), and run [30669128333](https://github.com/Matt17BR/openwrangler/actions/runs/30669128333) at source `9efdb9a99bc27f2607c5ad403a3c1b80f6d17390`. Their median workflow-creation-to-completion times are 1 minute 17 seconds for `Fast feedback`, 1 minute 41 seconds for `Native script contracts (Windows)`, and 7 minutes 2 seconds for `validate`. Three runs began receiving runners within 2 to 3 seconds; run 30647077916 separately records a 3 minute 28 second initial queue. The complete fast and native lanes therefore finish inside their respective 3- and 6-minute actionable-failure targets, while the aggregate median remains below the 10 minute 6 second baseline.

Natural hosted failures in `Visual and accessibility` ([30653689546](https://github.com/Matt17BR/openwrangler/actions/runs/30653689546)), `python-matrix (3.14)` ([30634888557](https://github.com/Matt17BR/openwrangler/actions/runs/30634888557)), `Native script contracts (Windows)` ([30640655589](https://github.com/Matt17BR/openwrangler/actions/runs/30640655589)), and `Cursor smoke (windows-latest)` ([30645982019](https://github.com/Matt17BR/openwrangler/actions/runs/30645982019)) each remained isolated to their owning lane and made `validate` fail. The issue owner accepted this natural failure-and-repair evidence together with the exhaustive `scripts/ci-workflow.test.mjs` aggregate contract, which injects every missing, failed, cancelled, and skipped result for every blocking job and requires each case to fail, instead of manufacturing a hosted failure in every split owner.

Issue #125 closed after PR #179 merged, the post-merge `main` run published a green `validate`, and active ruleset `19028896` was rechecked with that context still required.

## Ruleset migration

After the first complete green split run, active ruleset `19028896` was migrated in one reviewed update with no bypass window. It removed redundant CI constituent contexts and the stale `extension-host (1.105.0)` name while retaining `validate`, the cross-platform runtime macOS/Windows checks, all three Windows dependency guards, and both CodeQL analyses under the same strict policy. The aggregate job ID and protected context stay unchanged by the native-script narrowing above, so no second ruleset transition is required. Any future required-context rename must still be applied atomically with its workflow change; never temporarily disable the protected gate.
