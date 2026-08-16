# Product roadmap

Open Wrangler currently has one human owner, with Codex contributors delivering reviewed changes. This roadmap assumes
that operating model. Another maintainer or a particular adoption level is not a prerequisite for any item.

The project is in an active maintainability-first scope freeze. New engine, editor, and platform breadth waits until
the approachability gates below pass, unless the change fixes a safety defect or makes the existing product materially
simpler. Release and publication decisions remain separate from ordinary product development.

## Current supported scope

- Pandas and Polars are the core editing engines for files and supported Python notebook variables.
- Native R is a 1.99 preview and remains **Partial**. The accepted frame boundary is base `data.frame`, tibble, and
  `data.table`; [Native R status](https://github.com/Matt17BR/openwrangler/issues/87) records the exact notebook,
  document, platform, catalog, and stable-evidence limits.
- DuckDB is experimental and **Partial**. Supported file sessions edit and export without dataframe conversion, while
  notebook `DuckDBPyRelation` values are view-only. Open Wrangler does not browse `.duckdb` catalogs, schemas, tables,
  or arbitrary SQL results.
- PySpark support is local-notebook viewing only for supported 4.2 Classic and Connect batch DataFrames. It does not
  promise editing, export, streaming DataFrames, remote clusters, or authenticated clusters.
- VS Code and Cursor are release-tested desktop hosts. Support for other VS Code-based desktop editors is
  experimental. Browser and virtual-workspace hosts, including `vscode.dev`, are unsupported. The documented VS Code
  Remote SSH path has bounded release acceptance; broader web and remote-host coverage is deferred.

[Feature parity](feature-parity.md) is the release-facing capability ledger. The generated
[reference](reference.md) is authoritative for the current command, setting, operation, and protocol surface.

## Stable 2.0 gates

Stable 2.0 requires all of the following:

1. Pandas exports no longer silently lose a named index or MultiIndex. The user chooses explicit preservation or
   omission semantics, and the result is covered through runtime, host, and exported-file tests.
2. Every Native R row claimed as stable has direct runtime and executable generated-code evidence, bounded installed
   evidence for its advertised seams, and a reviewed current-candidate performance record.
3. No known release-blocking safety, runtime, or publication defect remains open.
4. Every approachability gate below has current, reviewable evidence.

Broader CSV delimiter and encoding controls and polished row-header presentation remain P1 fidelity work, but are not
independent stable-2.0 blockers once index export behavior is explicit and lossless by default.

## Approachability gates

The following gates are binding before stable 2.0 or automatic backend, platform, or editor expansion:

1. Contributors have one authoritative Tier A local command with recorded cold and warm timings.
2. Ordinary pull requests have a measured p95 below 10 minutes and use at least 50% fewer job or runner minutes than
   the recorded pre-freeze baseline.
3. The current seven required contexts are reduced to at most two through mechanical result fan-in.
4. The trailing 100 qualifying runs contain zero unexplained retries.
5. No new production file exceeds 1,000 lines, no new test file exceeds 1,500 lines, and existing hotspots show real
   reductions rather than wrapper-only movement.
6. The protocol schema is the sole hand-edited operation registry.
7. A normal change maps to one focused owning module and test selector without reconstructing private state or source
   layout in a mega-fixture.
8. Qualification is repeatable and nonpublishing; promotion is a separate one-shot operation over one immutable
   candidate.
9. The development dependency audit is clean, and supported Node, Python, and R test environments are declared and
   pinned where reproducibility requires it.
10. README, package, support, feature-parity, and Native R issue claims match the verified product.

These gates reduce product-delivery cost without weakening the engine-native, source-immutability, trust, protocol,
accessibility, or release-safety invariants in [AGENTS.md](../AGENTS.md).

Current implementation evidence closes prerequisites, not the complete approachability gate set:

- The fail-complete Tier A command and focused Native R selector primitives are landed in
  [the Tier A checkpoint](https://github.com/Matt17BR/openwrangler/commit/a9824237ee5af8e75254ec417690bc0bd0fc3d13)
  and [the selector checkpoint](https://github.com/Matt17BR/openwrangler/commit/3182911e5109b219aa50696eeef26d9374e5f14d).
  The A–D pull-request topology, required-context reduction, and ruleset outcomes remain open.
- The host-owned Atomic Export boundary is landed at
  [f9578df](https://github.com/Matt17BR/openwrangler/commit/f9578dfeded1ae9c72a90a1161ce5ef804e21d4b)
  with tree `32bf650546f7649db807bf4fa7dddf778e031655`. Configurable delimiter, quote, encoding, header,
  import-dialect default, and Pandas index options remain unimplemented P1 work.
- Operation-catalog consolidation remains open while two hand-maintained 28-entry lists still exist outside the
  canonical schema. Unlanded restructuring evidence does not satisfy the sole-registry gate.

This roadmap links durable checkpoints and dispositions without embedding volatile workflow timing or runner totals.

## Prioritized product work

P0 is reserved for safety, data-loss, runtime-corruption, publication, and product-delivery or maintainability defects
that block reliable development or release. It does not add another backend.

### P1: fidelity and daily use

| Slice                                   | Dependency                                                                     | Acceptance criteria                                                                                                                                                                                                                                                                                                                                                                                    | Disposition                                                                                                                                                  |
| --------------------------------------- | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Grid cell, row, and range copy          | Shared grid only                                                               | Pointer and keyboard selection copy displayed values as spreadsheet-safe TSV; row copy includes an exposed row label; unloaded or stale cells fail closed; fixed cell and byte limits, clipboard fallback, accessibility, and visual behavior are tested.                                                                                                                                              | Landed through [PR #545](https://github.com/Matt17BR/openwrangler/pull/545) from source review [PR #543](https://github.com/Matt17BR/openwrangler/pull/543). |
| Numeric sum in column statistics        | Integrated typed-summary protocol, runtime, and engine boundary                | Typed summaries represent exact wide integer and decimal sums where supported and normalize null, NaN, infinity, empty, and sampled states deliberately. Pandas, Polars, DuckDB, PySpark, and Native R remain engine-native. The pure shared boundary is Tier A; focused engine contracts are Tier B; one VS Code journey covers the common webview.                                                   | Active; the shared typed-summary boundary exists, while numeric sum remains unimplemented.                                                                   |
| Pandas index fidelity                   | Shared optional row-axis protocol and Pandas-owned runtime/presentation design | Named indexes and MultiIndex levels have explicit metadata and visible row labels without becoming ordinary columns. Paging, filtering, sorting, inspection, recovery, and export preserve their meaning. CSV and Parquet exports have explicit include/omit behavior, with no silent loss by default. Pandas-focused and shared optional-contract tests cover duplicate and non-string column labels. | Planned; silent export loss is a stable-2.0 blocker.                                                                                                         |
| Faithful configurable export            | Integrated host-owned atomic data-export boundary                              | CSV offers delimiter, quote, encoding, header, and index choices; relevant confirmed import dialect becomes the offered default without becoming immutable. Parquet exposes its applicable index behavior. Every destination still uses the single host-owned reservation, identity revalidation, and atomic publication path, and every supported editing engine retains native export tests.         | Atomic publication is landed; configurable format and index options remain planned. Do not add a second writer.                                              |
| Edit or delete an earlier cleaning step | Decomposed plan-transaction, recovery, and persistence owners                  | A user can select any committed step, edit it with its recorded input schema, or delete it. One transaction rewrites the selected prefix and replays the suffix with stable step IDs and lineage, rolls back completely on failure, persists only the confirmed result, and leaves the source immutable. Focused public-boundary tests cover every editing-capable engine.                             | Prerequisite owners are landed; the user-facing transaction remains planned. Reordering is not part of P1.                                                   |

Reordering committed steps has no product commitment yet. It requires separate evidence that lineage, operation
dependencies, and the user-visible conflict model are understandable; edit/delete must not smuggle in reorder
semantics.

### P2: deterministic reshape and validation

Deliver the smallest engine-native operations before adding multi-source behavior:

1. Multi-output split and regular-expression extraction, then explode or unnest.
2. Pivot longer and pivot wider, then transpose where native engines can preserve types and lineage.
3. Rank and bounded window functions, a typed formula expansion beyond binary arithmetic, and schema or data-quality
   assertions with explicit failure results.

Each operation needs live runtime and executable generated-code tests for every editing-capable engine. Joins and
merge remain deferred until a separate multi-source authority, lifecycle, persistence, and source-immutability design
is accepted.

### P3: portable cleaning recipes

Define a versioned public recipe format that can be exported and imported without workspace-private source or backend
keys. Import validates the document before execution, maps stable column intent onto a target schema explicitly,
previews incompatibilities, and never guesses through ambiguous names or types. Batch apply uses the same validation,
engine capability, generated-code, rollback, and source-immutability contracts as an interactive plan.

Natural-language or Copilot entry points follow deterministic reshape and recipe primitives. They may propose a
validated draft, but do not replace the public recipe, schema-mapping, preview, or confirmation boundaries.

### P4: DuckDB database browsing

Add bounded `.duckdb` catalog, schema, table, and view discovery before considering a general SQL entry point. The
design must preserve connection ownership, disable extension auto-install/autoload and external-file caching, keep
results engine-native, and make read-only versus editing/export capabilities explicit.

### P5: entry points and platform coverage

Evaluate debugger-variable opening, browser and code-server hosts, additional remote environments, localization,
non-dataframe lists and dictionaries, and multidimensional array or tensor viewing as separate slices. Each slice
needs an exact source-identity and lifecycle owner, bounded data transport, accessibility coverage, and a support claim
that matches its tested hosts. The existing bounded VS Code Remote SSH path is already implemented and is not reopened
by this priority.

## Audit disposition

| Finding                                 | Verified repository evidence                                                                                                                                                                                                | Decision and priority                                                                                                        | Owner or dependency                                                                                            | Implementation or durable link                                                                                                                                  | Verification / acceptance                                                                             |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| 1. Pandas index fidelity                | Pandas pages omit row labels, schema represents columns only, and current CSV/Parquet export requests omit the index.                                                                                                       | Confirmed fidelity defect; P1 and stable-2.0 blocker for silent export loss.                                                 | Pandas runtime plus shared optional row-axis contract; export behavior follows the atomic export owner.        | [P1 index slice](#p1-fidelity-and-daily-use)                                                                                                                    | Named index and MultiIndex presentation plus explicit lossless/omit export contracts.                 |
| 2. Grid clipboard usability             | The audited base had no cell, row, or range clipboard action; code copy was a separate surface.                                                                                                                             | Confirmed; P1.                                                                                                               | Shared DataGrid and browser clipboard boundary; no runtime dependency.                                         | [PR #545](https://github.com/Matt17BR/openwrangler/pull/545) ([source review #543](https://github.com/Matt17BR/openwrangler/pull/543))                          | Focused unit/component, accessibility, visual, full repository, and hosted checks.                    |
| 3. Cleaning history                     | Commands, toolbar state, and runtime transactions edit or undo only the latest committed step.                                                                                                                              | Confirmed; arbitrary earlier edit/delete is P1. Reorder is explicitly deferred.                                              | Decomposed plan-transaction, recovery, and persistence owners.                                                 | [P1 history slice](#p1-fidelity-and-daily-use)                                                                                                                  | Prefix rewrite, suffix replay, stable IDs/lineage, rollback, persistence, and immutable-source tests. |
| 4. Export fidelity                      | Atomic export is landed, but CSV and Parquet export still does not expose or inherit delimiter, quote, encoding, header, or index behavior.                                                                                 | Confirmed; remaining options are P1.                                                                                         | The landed single host-owned writer and native engine export chain.                                            | [Atomic checkpoint](https://github.com/Matt17BR/openwrangler/commit/f9578dfeded1ae9c72a90a1161ce5ef804e21d4b) and [P1 export slice](#p1-fidelity-and-daily-use) | Round-trip dialect/default tests, explicit option tests, atomic failure matrix, and index behavior.   |
| 5. Core transforms                      | The generated [reference](reference.md) lists no joins, reshape, explode, rank/window, regex extraction, or assertions. Split Text selects one indexed part; Formula is binary arithmetic.                                  | Confirmed; P2. Joins wait for multi-source ownership.                                                                        | Operation schema/catalog plus every editing-capable native engine.                                             | [P2](#p2-deterministic-reshape-and-validation)                                                                                                                  | Matching live and executable generated-code tests per engine, with lineage and type contracts.        |
| 6. Portable cleaning recipes            | Persisted plans are private workspace state keyed by source identity and backend; there is no public versioned import/export or batch apply.                                                                                | Confirmed; P3.                                                                                                               | Public recipe schema after deterministic P2 primitives.                                                        | [P3](#p3-portable-cleaning-recipes)                                                                                                                             | Versioning, schema mapping, validation, preview, rollback, and batch source-immutability acceptance.  |
| 7. Ecosystem gaps                       | Debugger variables, browser/code-server hosts, localization, multidimensional or non-dataframe viewing, and deterministic natural-language entry points are absent. The bounded VS Code Remote SSH path is already covered. | Partly confirmed; Remote SSH is already solved for its stated path. Remaining breadth is P5; natural language follows P2/P3. | Per-host source/lifecycle design; no broad expansion before approachability gates.                             | [P5](#p5-entry-points-and-platform-coverage)                                                                                                                    | Separate bounded acceptance and precise support claim for each slice.                                 |
| 8. Backend claims                       | R is Partial preview, DuckDB is experimental/Partial, and PySpark is local-notebook view-only; flat headline/package wording can obscure those limits.                                                                      | Confirmed positioning debt; correct now. Backend expansion remains P4/P5.                                                    | README, package metadata, feature parity, and [issue #87](https://github.com/Matt17BR/openwrangler/issues/87). | [Current supported scope](#current-supported-scope)                                                                                                             | Documentation/package checks and editorial review against current source and public status.           |
| 9. Feedback and roadmap discoverability | Issue #87 is current, and structured bug and feature forms are checked in. A product roadmap was missing.                                                                                                                   | Stale issue narrative is superseded; durable roadmap and forms solve discoverability.                                        | Repository docs and GitHub issue forms.                                                                        | This document and [issue #87](https://github.com/Matt17BR/openwrangler/issues/87)                                                                               | Links remain current; roadmap holds priorities and acceptance criteria rather than run histories.     |
| 10. Product-delivery cost               | Tier A and focused selector primitives are landed, but ordinary changes still select broad required contexts and the A–D topology and ruleset outcomes remain open.                                                         | Confirmed P0 maintainability/product-delivery risk. Safety boundaries remain binding.                                        | Maintainability owners and CI fan-in work.                                                                     | [Approachability gates](#approachability-gates)                                                                                                                 | All ten gates need measured evidence before stable 2.0 or automatic scope expansion.                  |

## Evidence and feedback policy

Roadmap entries state the user problem, priority, dependency, and acceptance boundary. They do not copy workflow run
histories. Time-bound release evidence belongs in one bounded manifest or dated report, with the roadmap linking that
source when a gate depends on it.

Use the repository's structured
[bug report](https://github.com/Matt17BR/openwrangler/issues/new?template=bug.yml) and
[feature request](https://github.com/Matt17BR/openwrangler/issues/new?template=feature.yml) forms for new evidence.
Keep [issue #87](https://github.com/Matt17BR/openwrangler/issues/87) as the short Native R status and stable-gate record
rather than duplicating its release-specific state here.
