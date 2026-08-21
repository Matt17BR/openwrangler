# Open Wrangler agent guide

This repository builds the open-source Open Wrangler extension, its bundled Python runtime, and the native R runtime for Open Wrangler 2. Read this file before changing code. Open Wrangler was built independently: use public documentation and observed product behavior as references, but never copy Microsoft Data Wrangler code or assets.

## Instruction discovery and routing

Codex loads `AGENTS.md` files from the repository root through the parent directories of the target path, in ancestor order. The root policy always applies. Read every scoped file reached by that path before acting. When a change crosses scopes, read each additional owning file named below before editing.

A rule is normative only in the file containing its `OW-RULE` marker. Refer to cross-scope rules by ID and path; never copy their normative text into another active prompt.

| Target path | Scoped owner | Primary responsibility |
| --- | --- | --- |
| `.github/**` | `.github/AGENTS.md` | Workflow, check, and publication transactions |
| `docs/**` | `docs/AGENTS.md` | Architecture, parity, testing, release, and public-writing truth |
| `python/**` | `python/AGENTS.md` | Python runtime and engine-native execution |
| `r/**` | `r/AGENTS.md` | Native R frame, notebook, and file-runtime boundaries |
| `scripts/**` | `scripts/AGENTS.md` | Repository gates, acceptance harnesses, packaging, and benchmarks |
| `src/extension/**` | `src/extension/AGENTS.md` | VS Code APIs, sessions, runtime lifecycle, commands, editors, and notebooks |
| `src/shared/**` | `src/shared/AGENTS.md` | Versioned protocol, schemas, operations, and host/webview contracts |
| `src/webviews/**` | `src/webviews/AGENTS.md` | React UI, renderer state, accessibility, and browser security |
| `src/test/**` | Every owner whose behavior the test exercises | Route each test to its implementation owner; extension-host and installed harness work also reads `scripts/AGENTS.md` |

Root-level public text such as `README.md` and `CHANGELOG.md` also requires `docs/AGENTS.md`. Changes that alter a protocol, operation, runtime, release gate, or installed behavior require both the implementation owner and the corresponding documentation or harness owner.

Every active instruction file ends with a path-bound SHA-256 completion marker. `node scripts/agent-instructions-context.mjs` validates actual ancestor discovery, rule ownership, budgets, and those markers. Keep migration notes, issue history, review receipts, and run evidence outside all active `AGENTS.md` files.

## Repository scope

Track only the extension, runtime, product assets and documentation, and ordinary build, test, benchmark, package,
and release tooling. Keep agent housekeeping outside the repository. Remove temporary development checkouts when
their branches are integrated or abandoned.

## Commit history

Give each commit one reviewable purpose. A product slice may include its directly related tests and required
documentation. Keep unrelated product changes, test-harness work, generated media, standalone documentation or
repository metadata, and version/release changes in separate commits. Merge feature and media pull requests before
preparing a release. The release commit contains only the version bump, changelog, release notes, and release
metadata. Use rebase merge when a pull request has several reviewable commits. Squash only when the pull request is
already one coherent commit.

## Base freshness and integration

A protected-main advance does not by itself require a reviewed branch to be replayed. First compare changed-path
ownership, overlapping hunks and behavior contracts, and the candidate's virtual merge tree against the new base.
Preserve a clean head, its reviews, and its successful checks when that audit finds no relevant collision.
This preserves review and qualification evidence; it does not make a behind head mergeable. The current ruleset
requires branches to be up to date, and no merge queue is enabled. Keep the reviewed head unchanged until its actual
landing slot. If it is then behind, update it once onto the exact protected-main head and qualify that changed
integration object.

When candidates truly overlap or form a dependency, record their landing order. The first lander keeps its reviewed
head; the second lander replays onto the exact landed tree and resolves the real overlap. An exact replay whose
per-commit `git range-diff` entries are all `=` transfers the existing reviews when its commit mapping, scope, and
semantics are unchanged. Rerun the gates affected by a changed base or an adaptation. Disjoint candidates may be
implemented, reviewed, published, and qualified concurrently. Serialize only protected-main writes and true stacks.
A separately reviewed workflow and settings change may replace that final update with a merge queue. Required checks
must then run on and bind the `merge_group` result SHA; successful pull-request head checks are not a substitute for
that merged-tree proof.

## Global invariants

<!-- OW-RULE:I02 -->
2. Viewing filters/sorts are separate from committed cleaning steps and never alter the source.

<!-- OW-RULE:I03 -->
3. User data is not overwritten. Exports target a separate destination and use atomic replacement.

<!-- OW-RULE:I04 -->
4. Python and R execution, dependency installation, custom code, and exports require a trusted workspace.

<!-- OW-RULE:I08 -->
8. `scratch.txt` and all other untracked user files are user-owned. Never edit, delete, stage, or package them.

<!-- OW-INSTRUCTIONS:EOF path="AGENTS.md" sha256="d120ef8af6a7e41a492b8fc2b2b6d20eff80f239e82aaf9dc7d8c7bd7c6a994d" -->
