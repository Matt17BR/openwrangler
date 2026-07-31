# Continuous-integration ownership

Open Wrangler keeps correctness, security, packaging, accessibility, and native-editor evidence blocking. The CI split exists to identify the failing boundary sooner; it does not remove a test, retry an editor phase, lower a threshold, or turn a production audit advisory.

## Pull-request check map

| Check                                    | Owner                        | Failure class                                                                                               | Artifact dependency              |
| ---------------------------------------- | ---------------------------- | ----------------------------------------------------------------------------------------------------------- | -------------------------------- |
| `Fast feedback`                          | source quality               | formatting, ESLint, TypeScript, generated protocol/reference/docs, licenses, workflow structure             | none                             |
| `Contract tests`                         | runtime and shared contracts | Python lint/types, brand and lock freshness, script, TypeScript, and Python tests                           | none                             |
| `Visual and accessibility`               | webview UI                   | runtime-backed deterministic screenshots, production CSS/fonts, axe acceptance                              | none                             |
| `Production dependency audits`           | supply chain                 | npm production advisories, Python/runtime-lock advisories                                                   | live advisory databases; no VSIX |
| `canonical-vsix`                         | packaging                    | clean production build, allowlist, checksum-bound artifact publication                                      | produces the one PR VSIX         |
| `Packaged VS Code (Linux)`               | Linux product acceptance     | checksum, packaged install, trusted/untrusted journeys, recovery, cleanup                                   | canonical VSIX                   |
| `coverage`                               | coverage                     | unchanged TypeScript/Python floors with the exact optional PySpark runtime                                  | none                             |
| `python-matrix`                          | Python compatibility         | complete Python 3.10 and 3.14 runtime suites                                                                | none                             |
| `PySpark 4.2 notebook viewing (Java 17)` | PySpark adapter              | exact-runtime native notebook viewing                                                                       | none                             |
| `extension-host`                         | supported VS Code range      | minimum and current Linux extension-host integration                                                        | none                             |
| `Native script contracts (Windows)`      | platform harness             | real Windows Job Object compilation, descendant containment, termination, and malformed-frame rejection     | none                             |
| `Native extension host`                  | native VS Code integration   | macOS/Windows stable extension-host integration                                                             | none                             |
| `Native editor`                          | packaged VS Code             | macOS/Windows checksum-bound installed-editor acceptance                                                    | canonical VSIX                   |
| `Cursor smoke`                           | packaged Cursor              | macOS/Windows install, activation, grid, icon, navigation, and cleanup                                      | canonical VSIX                   |
| `Remote SSH acceptance`                  | remote workspace             | opt-in, label-gated packaged Remote SSH journey                                                             | canonical VSIX                   |
| `validate`                               | required aggregate           | fails unless every blocking CI job succeeds; Remote SSH must succeed when selected and be skipped otherwise | all of the above                 |

The `validate` job retains the existing protected check name. It uses `always()` only so its result step executes after failed, cancelled, or skipped dependencies; `scripts/require-ci-results.mjs` then requires every blocking result to be exactly `success`. A skipped aggregate is never used as a success path. When `acceptance:remote-ssh` is present, Remote SSH is required to succeed; without the label it is required to be skipped.

Cross-platform runtime matrices and CodeQL remain separate workflows and separately protected evidence. The CI aggregate does not claim to summarize a workflow it cannot depend on.

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

## Baseline and targets

[CI run 30626586848](https://github.com/Matt17BR/openwrangler/actions/runs/30626586848) is the pre-split baseline for source `6ac322e2fb914e8f0420cf097623c715b30f1047`. Fast feedback completed 80 seconds after workflow creation. The monolithic Linux `validate` lane ran for 8 minutes 9 seconds after waiting for packaging. The Windows native lane reported its extension-host failure 10 minutes 6 seconds after workflow creation and skipped both packaged-editor consumers because that unrelated check preceded them.

The first reviewed target is to report a deterministic source failure within 3 minutes and a native script or extension-host failure within 6 minutes of workflow creation on a normally queued hosted runner, a 40% reduction from the Windows baseline. The split must also keep the aggregate critical path at or below the 10 minute 6 second baseline. Confirm these targets with repeated real pull-request runs before treating the CI organization issue as complete; hosted-runner queue time must be recorded separately from job execution time.

[CI run 30633059407](https://github.com/Matt17BR/openwrangler/actions/runs/30633059407) is the first complete green split run, at exact source `e04e5e4c4f66ce3a580a5a51d8b3b40df60cbc0f`. Its first jobs waited 55 seconds for a runner; `Fast feedback` then completed 1 minute 57 seconds after workflow creation, and the fail-closed `validate` aggregate completed after 7 minutes 51 seconds. That single run meets the source-feedback and aggregate critical-path targets, but it is not repeated timing evidence and contains no injected split-group failure. The native-script narrowing in this change also needs its own hosted Windows result. Repeated normally queued runs plus one deterministic injected failure per split owner therefore remain required before issue #125 is complete.

## Ruleset migration

After the first complete green split run, active ruleset `19028896` was migrated in one reviewed update with no bypass window. It removed redundant CI constituent contexts and the stale `extension-host (1.105.0)` name while retaining `validate`, the cross-platform runtime macOS/Windows checks, all three Windows dependency guards, and both CodeQL analyses under the same strict policy. The aggregate job ID and protected context stay unchanged by the native-script narrowing above, so no second ruleset transition is required. Any future required-context rename must still be applied atomically with its workflow change; never temporarily disable the protected gate.
