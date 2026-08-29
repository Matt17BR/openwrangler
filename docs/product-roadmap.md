# Product roadmap

This roadmap records the supported product boundary and the next user-facing priorities. It does not duplicate CI
topology or transient release evidence. [Feature parity](feature-parity.md) is the capability ledger, and the
generated [reference](reference.md) is authoritative for commands, settings, operations, and protocol names.

## Current supported scope

- Pandas and Polars are the core editing engines for files and supported Python notebook variables.
- Native R is a channel-neutral **Preview**. Base `data.frame`, tibble, and `data.table` values use a native R runtime
  for the documented notebook, terminal, and document paths. Preview status does not block a stable Open Wrangler
  release or turn into stable support when included in one.
- DuckDB is experimental. Supported file sessions edit and export natively; notebook `DuckDBPyRelation` values are
  viewing-only. `.duckdb` catalog, schema, table, view, and arbitrary SQL browsing are not implemented.
- PySpark 4.2 support is local-notebook viewing only for supported Classic and Connect batch DataFrames. Open Wrangler
  does not provide Spark editing, export, provisioning, streaming, remote-cluster, or authentication support.
- VS Code and Cursor are the release-tested desktop hosts. Other desktop forks are experimental. Browser and virtual
  workspace hosts are unsupported, and Remote SSH is not part of current release qualification.

## Stable release boundary

A stable release requires:

1. Every required Pandas and Polars row in [feature parity](feature-parity.md) to be **Done**.
2. No known release-blocking safety, data-loss, runtime, packaging, or publication defect.
3. One immutable candidate to pass the direct [release-candidate flow](releasing.md#release-candidate) before the same
   bytes are promoted.

The following work is complete and is no longer a stable-release gate:

- [#659](https://github.com/Matt17BR/openwrangler/issues/659): the first supported notebook result upgrades
  automatically when formatter preparation completes; users do not need a fallback action or rerun.
- [#844](https://github.com/Matt17BR/openwrangler/issues/844): Pandas named-index and MultiIndex presentation, paging,
  recovery, and explicit preserve-or-omit export behavior are implemented.
- [#776](https://github.com/Matt17BR/openwrangler/issues/776): a verified Native R notebook session recovers after its
  kernel is replaced by replaying confirmed state into a fresh delegate.

Native R Preview, experimental DuckDB work, and the deliberately limited PySpark viewer do not block a stable release
when their labels and limitations remain accurate. The Data Wrangler comparison is optional historical evidence, not
a stable-release gate.

## Completed fidelity work

- The grid supports bounded cell, row, range, column, and spreadsheet-safe TSV copy.
- Typed summaries preserve supported wide-integer and decimal results across native engines.
- Pandas indexes remain separate from ordinary columns and have explicit CSV and Parquet export choices.
- CSV and Parquet exports expose engine-appropriate options and use the host-owned atomic publication path.
- Any committed cleaning step can be inspected, edited, or deleted with stable lineage and transactional replay.
- Multi-output literal split, portable regex extraction, Pivot longer, and fixed-output Pivot wider are implemented
  across editing-capable engines.

Cleaning-step reordering remains deferred. Edit and delete do not imply a hidden move operation.

## Next priorities

### Deterministic transforms and validation

Add rank and bounded window operations, broaden typed formulas, and introduce schema or data-quality assertions with
explicit results. Transpose, explode, and unnest require engine-native type and lineage contracts. Joins and merge
remain deferred until multi-source identity, lifecycle, persistence, and source immutability have one accepted design.

### Portable cleaning recipes

Define a versioned recipe format that contains no workspace-private source or backend keys. Import must validate and
map column intent explicitly, preview incompatibilities, and use the same engine capability, rollback, generated-code,
and source-immutability boundaries as an interactive plan. Natural-language entry points may propose a validated
draft only after this deterministic format exists.

### DuckDB database browsing

Add bounded `.duckdb` catalog, schema, table, and view discovery before a general SQL entry point. Preserve connection
ownership, keep extension auto-install, autoload, and external-file caching disabled, and state read-only versus
editing/export behavior explicitly.

### Entry points and platform coverage

Evaluate debugger variables, remote environments, browser and code-server hosts, localization, non-dataframe
collections, and multidimensional arrays or tensors as separate slices. Each needs an exact source and lifecycle
owner, bounded transport, accessibility coverage, and a support claim that matches its tested hosts.

## Feedback

Use the repository's structured
[bug report](https://github.com/Matt17BR/openwrangler/issues/new?template=bug.yml) and
[feature request](https://github.com/Matt17BR/openwrangler/issues/new?template=feature.yml) forms. New roadmap entries
should name the user problem, dependency, and acceptance boundary without copying workflow histories.
