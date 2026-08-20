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

Configurable export is implemented within each engine's native support set. Broader cross-engine CSV codec and
quote-character parity and polished row-header presentation remain deferred, but are not independent stable-2.0
blockers. Unsupported export combinations fail before artifact creation.

## Approachability gates

The following gates are binding before stable 2.0 or automatic backend, platform, or editor expansion:

1. Contributors have one authoritative `npm run check:pr` local command with recorded cold and warm timings.
2. Ordinary pull requests have a measured p95 below 10 minutes and use at least 50% fewer job or runner minutes than
   the recorded pre-freeze baseline.
3. The active ruleset requires exactly two integration-bound contexts, `validate` and `CodeQL gate`, through
   mechanical result fan-in.
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

- The fail-complete default PR command and focused Native R selector primitives are landed in
  [the default PR checks checkpoint](https://github.com/Matt17BR/openwrangler/commit/a9824237ee5af8e75254ec417690bc0bd0fc3d13)
  and [the selector checkpoint](https://github.com/Matt17BR/openwrangler/commit/3182911e5109b219aa50696eeef26d9374e5f14d).
  The path-selected PR checks and two integration-bound ruleset outcomes are landed. One exact attempt-1 comparison
  records 23 to 11 executed jobs and 4,042 to 1,880 summed runner seconds; see
  [the dated topology measurement](ci-topology-measurement-2026-08-17.md). Rolling wall-time p95 and reliability
  evidence remain open.
- The host-owned Atomic Export boundary is landed at
  [f9578df](https://github.com/Matt17BR/openwrangler/commit/f9578dfeded1ae9c72a90a1161ce5ef804e21d4b)
  with tree `32bf650546f7649db807bf4fa7dddf778e031655`. CSV exports now offer engine-supported delimiter,
  quote, encoding, and header choices, with the confirmed import dialect offered as an editable default. Pandas CSV
  and Parquet require an explicit preserve or omit index choice through that same Atomic Export boundary.
- Operation-catalog consolidation is achieved: `protocol/openwrangler.v2.schema.json` is the sole hand-edited
  registry, and generation supplies the shared TypeScript and Python catalogs consumed by runtime and UI capability
  owners. The direct Native-R complete-catalog contract retains one independent, mutation-sensitive 32-operation
  oracle that must remain exactly equal to the generated kinds; it is executable test evidence, not a second runtime
  registry.
- The [dated maintainability measurement](maintainability-measurement-2026-08-18.md) records current-main new-file
  bounds, named hotspot movement, and the exact evidence backlog for all ten gates. New production and test files meet
  their size bounds, but several existing monoliths and the timing, rolling reliability, reproducibility, and artifact
  measurements remain open; no stable-2.0 or expansion credit follows from the partial result.

This roadmap links durable checkpoints and dispositions without embedding volatile workflow timing or runner totals.

## Prioritized product work

P0 is reserved for safety, data-loss, runtime-corruption, publication, and product-delivery or maintainability defects
that block reliable development or release. It does not add another backend.

### P1: fidelity and daily use

| Slice                                   | Dependency                                                                     | Acceptance criteria                                                                                                                                                                                                                                                                                                                                                                                     | Disposition                                                                                                                                                                                                                                                                                                                                       |
| --------------------------------------- | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Grid cell, row, and range copy          | Shared grid only                                                               | Pointer and keyboard selection copy displayed values as spreadsheet-safe TSV; row copy includes an exposed row label; unloaded or stale cells fail closed; fixed cell and byte limits, clipboard fallback, accessibility, and visual behavior are tested.                                                                                                                                               | Landed through [PR #545](https://github.com/Matt17BR/openwrangler/pull/545) from source review [PR #543](https://github.com/Matt17BR/openwrangler/pull/543).                                                                                                                                                                                      |
| Numeric sum in column statistics        | Integrated typed-summary protocol, runtime, and engine boundary                | Typed summaries represent exact wide integer and decimal sums where supported and normalize null, NaN, infinity, empty, and sampled states deliberately. Pandas, Polars, DuckDB, PySpark, and Native R remain engine-native. The pure shared boundary is covered by default PR checks; focused engine contracts own engine-specific evidence; one VS Code journey covers the common webview.            | Implemented with engine-native runtime/UI contracts and live shared-webview acceptance for Pandas and Native R.                                                                                                                                                                                                                                   |
| Pandas index fidelity                   | Shared optional row-axis protocol and Pandas-owned runtime/presentation design | Named indexes and MultiIndex levels have explicit metadata and visible row labels without becoming ordinary columns. Paging, filtering, sorting, inspection, recovery, and export preserve their meaning. CSV and Parquet exports have explicit preserve/omit behavior, with no silent loss by default. Pandas-focused and shared optional-contract tests cover duplicate and non-string column labels. | Implemented through the Pandas runtime, shared grid, Atomic Export path, and live notebook acceptance.                                                                                                                                                                                                                                            |
| Faithful configurable export            | Integrated host-owned atomic data-export boundary                              | CSV offers delimiter, quote, encoding, header, and index choices; relevant confirmed import dialect becomes the offered default without becoming immutable. Parquet exposes its applicable index behavior. Every destination still uses the single host-owned reservation, identity revalidation, and atomic publication path, and every supported editing engine retains native export tests.          | Implemented through one discriminated protocol request and the existing Atomic Export writer. Pandas supports its selected text encoding and Unicode syntax characters; Polars and DuckDB retain UTF-8 single-byte CSV syntax, Native R retains UTF-8 and double-quote serialization, and unsupported combinations fail before artifact creation. |
| Edit or delete an earlier cleaning step | Decomposed plan-transaction, recovery, and persistence owners                  | Editing uses the selected step's recorded input schema. One transaction rewrites the selected prefix and replays the suffix with stable step IDs and lineage, rolls back completely on failure, persists only the confirmed result, and leaves the source immutable. Focused public-boundary tests cover every editing-capable engine.                                                                  | Implemented through stable-ID webview and Activity Bar actions plus one host-owned private-runtime transaction. Pandas, Polars, DuckDB, and Native R cover selected-prefix preview, suffix replay, generated code, atomic failure, and source isolation.                                                                                          |

<!-- cleaning-history-capabilities:roadmap-p1:start -->

Any committed step can be inspected, edited, or deleted. Cleaning Undo removes the most recent committed step. Reordering committed steps has no product commitment.
<!-- cleaning-history-capabilities:roadmap-p1:end -->

A future
reorder design needs separate evidence that lineage, operation dependencies, and the user-visible conflict model are
understandable; edit/delete must not smuggle in reorder semantics.

### P2: deterministic reshape and validation

Deliver the smallest engine-native operations before adding multi-source behavior:

1. Multi-output literal split and bounded portable regular-expression extraction are implemented as distinct
   operations. Explode and unnest remain planned.
2. Pivot longer and deterministic fixed-output Pivot wider are implemented with exact scalar-type preservation and
   stable lineage. Transpose remains planned where native engines can preserve types and lineage.
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

| Finding                                 | Verified repository evidence                                                                                                                                                                                                                                                                                    | Decision and priority                                                                                                                                     | Owner or dependency                                                                                            | Implementation or durable link                                                                                                                                  | Verification / acceptance                                                                                                                 |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| 1. Pandas index fidelity                | Pandas sessions publish row-axis metadata and exact post-view labels separately from ordinary columns; CSV/Parquet export requires an explicit preserve/omit choice.                                                                                                                                            | Implemented P1 fidelity slice; retain the stable-2.0 gate through its runtime, host, exported-file, and live-editor tests.                                | Pandas runtime plus shared optional row-axis contract; export behavior follows the atomic export owner.        | [P1 index slice](#p1-fidelity-and-daily-use)                                                                                                                    | Named index and MultiIndex presentation plus explicit lossless/omit export contracts.                                                     |
| 2. Grid clipboard usability             | The audited base had no cell, row, or range clipboard action; code copy was a separate surface.                                                                                                                                                                                                                 | Confirmed; P1.                                                                                                                                            | Shared DataGrid and browser clipboard boundary; no runtime dependency.                                         | [PR #545](https://github.com/Matt17BR/openwrangler/pull/545) ([source review #543](https://github.com/Matt17BR/openwrangler/pull/543))                          | Focused unit/component, accessibility, visual, full repository, and hosted checks.                                                        |
| 3. Cleaning history                     | The stable-ID transaction uses the selected step's recorded input schema and one private candidate replay.                                                                                                                                                                                                      | Implemented P1 history slice through the reviewed capability boundary below.                                                                              | Host plan-rewrite transaction plus Python and Native R selected-prefix preview owners.                         | [P1 history slice](#p1-fidelity-and-daily-use)                                                                                                                  | Prefix rewrite, suffix replay, stable IDs/lineage, rollback, persistence, generated-code, Activity Bar, and immutable-source tests.       |
| 4. Export fidelity                      | CSV and Parquet now expose format-appropriate options through one discriminated request. Confirmed CSV import dialect becomes the offered default, while unsupported engine combinations fail before artifact creation.                                                                                         | Implemented P1 fidelity slice; retain its protocol, native-engine, atomic-publication, and installed-editor acceptance gates.                             | The landed single host-owned writer and native engine export chain.                                            | [Atomic checkpoint](https://github.com/Matt17BR/openwrangler/commit/f9578dfeded1ae9c72a90a1161ce5ef804e21d4b) and [P1 export slice](#p1-fidelity-and-daily-use) | Round-trip dialect/default tests, strict option validation, native-engine matrices, atomic failures, and live Pandas/R export acceptance. |
| 5. Core transforms                      | The generated [reference](reference.md) now includes fixed multi-output literal split, bounded portable regex-group extraction, deterministic Pivot longer, and deterministic fixed-output Pivot wider. It still lists no joins, explode/unnest, rank/window, or assertions; Formula remains binary arithmetic. | P2 in progress. Literal multi-output split, regex extraction, Pivot longer, and Pivot wider are implemented; joins still wait for multi-source ownership. | Operation schema/catalog plus every editing-capable native engine.                                             | [P2](#p2-deterministic-reshape-and-validation)                                                                                                                  | Matching live and executable generated-code tests per engine, with lineage and type contracts.                                            |
| 6. Portable cleaning recipes            | Persisted plans are private workspace state keyed by source identity and backend; there is no public versioned import/export or batch apply.                                                                                                                                                                    | Confirmed; P3.                                                                                                                                            | Public recipe schema after deterministic P2 primitives.                                                        | [P3](#p3-portable-cleaning-recipes)                                                                                                                             | Versioning, schema mapping, validation, preview, rollback, and batch source-immutability acceptance.                                      |
| 7. Ecosystem gaps                       | Debugger variables, browser/code-server hosts, localization, multidimensional or non-dataframe viewing, and deterministic natural-language entry points are absent. The bounded VS Code Remote SSH path is already covered.                                                                                     | Partly confirmed; Remote SSH is already solved for its stated path. Remaining breadth is P5; natural language follows P2/P3.                              | Per-host source/lifecycle design; no broad expansion before approachability gates.                             | [P5](#p5-entry-points-and-platform-coverage)                                                                                                                    | Separate bounded acceptance and precise support claim for each slice.                                                                     |
| 8. Backend claims                       | R is Partial preview, DuckDB is experimental/Partial, and PySpark is local-notebook view-only; flat headline/package wording can obscure those limits.                                                                                                                                                          | Confirmed positioning debt; correct now. Backend expansion remains P4/P5.                                                                                 | README, package metadata, feature parity, and [issue #87](https://github.com/Matt17BR/openwrangler/issues/87). | [Current supported scope](#current-supported-scope)                                                                                                             | Documentation/package checks and editorial review against current source and public status.                                               |
| 9. Feedback and roadmap discoverability | Issue #87 is current, and structured bug and feature forms are checked in. A product roadmap was missing.                                                                                                                                                                                                       | Stale issue narrative is superseded; durable roadmap and forms solve discoverability.                                                                     | Repository docs and GitHub issue forms.                                                                        | This document and [issue #87](https://github.com/Matt17BR/openwrangler/issues/87)                                                                               | Links remain current; roadmap holds priorities and acceptance criteria rather than run histories.                                         |
| 10. Product-delivery cost               | Path-selected checks and two bound gates are landed. Exact comparison: 23→11 jobs and 4,042→1,880 runner seconds; rolling p95 and reliability remain open.                                                                                                                                                      | Partly closed; safety boundaries and the rolling gates remain binding.                                                                                    | Maintainability owners and CI fan-in work.                                                                     | [Approachability gates](#approachability-gates) and [dated measurement](ci-topology-measurement-2026-08-17.md)                                                  | Remaining rolling gates need evidence before stable 2.0 or automatic scope expansion.                                                     |

<!-- cleaning-history-capabilities:roadmap-audit:start -->

Any committed step can be inspected, edited, or deleted. Cleaning Undo removes the most recent committed step. Reordering committed steps has no product commitment.
<!-- cleaning-history-capabilities:roadmap-audit:end -->

## Evidence and feedback policy

Roadmap entries state the user problem, priority, dependency, and acceptance boundary. They do not copy workflow run
histories. Time-bound release evidence belongs in one bounded manifest or dated report, with the roadmap linking that
source when a gate depends on it.

Use the repository's structured
[bug report](https://github.com/Matt17BR/openwrangler/issues/new?template=bug.yml) and
[feature request](https://github.com/Matt17BR/openwrangler/issues/new?template=feature.yml) forms for new evidence.
Keep [issue #87](https://github.com/Matt17BR/openwrangler/issues/87) as the short Native R status and stable-gate record
rather than duplicating its release-specific state here.
