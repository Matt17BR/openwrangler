# Continuous-integration ownership

Open Wrangler keeps correctness, security, packaging, accessibility, and native-editor evidence blocking. The CI split exists to identify the failing boundary sooner; it does not remove a test, retry an editor phase, lower a threshold, or turn a production audit advisory.

## Pull-request check map

| Check                               | Owner                        | Failure class                                                                                               | Artifact dependency              |
| ----------------------------------- | ---------------------------- | ----------------------------------------------------------------------------------------------------------- | -------------------------------- |
| `Fast feedback`                     | source quality               | formatting, ESLint, TypeScript, generated protocol/reference/docs, licenses, workflow structure             | none                             |
| `Contract tests`                    | tooling contracts            | Python lint/types, brand and lock freshness, portable script contracts                                      | none                             |
| `Visual and accessibility`          | webview UI                   | runtime-backed deterministic screenshots, production CSS/fonts, axe acceptance                              | none                             |
| `Production dependency audits`      | supply chain                 | npm production advisories, Python/runtime-lock advisories                                                   | live advisory databases; no VSIX |
| `canonical-vsix`                    | packaging                    | clean production build, allowlist, checksum-bound artifact publication                                      | produces the one PR VSIX         |
| `Packaged VS Code (Linux)`          | Linux product acceptance     | checksum, packaged install, trusted/untrusted journeys, recovery, cleanup                                   | canonical VSIX                   |
| `coverage`                          | runtime and shared contracts | complete instrumented TypeScript/Python suites and unchanged floors with the exact optional PySpark runtime | none                             |
| `python-matrix`                     | Python compatibility         | complete Python 3.10 and 3.14 runtime suites                                                                | none                             |
| `extension-host`                    | supported VS Code range      | minimum and current Linux extension-host integration                                                        | none                             |
| `Native script contracts (Windows)` | platform harness             | real Windows Job Object compilation, descendant containment, termination, and malformed-frame rejection     | none                             |
| `Native extension host`             | native VS Code integration   | macOS/Windows stable extension-host integration                                                             | none                             |
| `Native editor`                     | packaged VS Code             | macOS/Windows checksum-bound installed-editor acceptance                                                    | canonical VSIX                   |
| `Cursor smoke`                      | packaged Cursor              | macOS/Windows install, activation, grid, icon, navigation, and cleanup                                      | canonical VSIX                   |
| `Remote SSH acceptance`             | remote workspace             | opt-in, label-gated packaged Remote SSH journey                                                             | canonical VSIX                   |
| `validate`                          | required aggregate           | fails unless every blocking CI job succeeds; Remote SSH must succeed when selected and be skipped otherwise | all of the above                 |

The `validate` job retains the existing protected check name. It uses `always()` only so its result step executes after failed, cancelled, or skipped dependencies; `scripts/require-ci-results.mjs` then requires every blocking result to be exactly `success`. A skipped aggregate is never used as a success path. When `acceptance:remote-ssh` is present, Remote SSH is required to succeed; without the label it is required to be skipped.

Cross-platform runtime matrices and CodeQL remain separate workflows and separately protected evidence. The CI aggregate does not claim to summarize a workflow it cannot depend on.

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

Open Wrangler uses a protected, always-releasable `main` rather than permanent `develop` and `staging` branches.
Feature branches merge through the fail-closed pull-request gate. Staging is the immutable, checksum-bound VSIX that
release acceptance installs in VS Code and Cursor; production promotion sends those exact accepted bytes to GitHub,
Open VSX, and the Visual Studio Marketplace without rebuilding them. A second long-lived branch would add merge
drift without making that artifact boundary safer.

Before public v2 previews begin, create a protected `release/1.x` maintenance branch from the last supported v1
commit and let `main` become the v2 integration line. The preview workflow must then accept only reviewed preview
tags from `main`, while a provenance-bound maintenance workflow may ship v1 fixes from `release/1.x`. Marketplace
pre-release versions remain deliberate releases; scheduled/nightly runs may retain artifacts and trend reports but
must never publish automatically. This transition is required before the first R/Quarto preview, not for ordinary
v1 maintenance today.

## 2026-08 pipeline audit

A typical substantive pull request used roughly 80 hosted runner-minutes: about 57 in the main CI workflow, 7 in
cross-platform runtime, 4 in CodeQL, and 10 to 14 in released-Jupyter acceptance. The distinct packaged VS Code,
Cursor, Jupyter, accessibility, performance, and publication gates have caught user-facing failures and remain.
The first reduction removes only same-source duplication, cancels obsolete PR heads, and preserves all externally
protected check names. Further consolidation should make released-Jupyter consume the PR's canonical VSIX before
moving any broad compatibility matrix away from pull requests.

The model follows proven upstream patterns rather than inventing a three-branch ceremony: VS Code Python keeps a
main development line plus release branches and separates stable from prerelease publication; VS Code Jupyter
cancels superseded work, schedules broader compatibility, and retains failure artifacts; GitLens keeps focused PR
quality and integration gates while running broader editor coverage separately; and pandas reserves expensive wheel
matrices for labels, schedules, manual dispatch, and releases. Open Wrangler remains stricter where its product needs
it: one checksum-bound VSIX must pass real VS Code, Cursor, notebook, performance, and registry gates before
publication.

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
