# Product roadmap

This roadmap records the supported product boundary, next priorities, and deferred work. [Feature
parity](feature-parity.md) is the capability ledger, and the generated [reference](reference.md) is authoritative for
commands, settings, operations, and protocol names.

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

## Release and priority boundary

Stable releases remain gated by the required Pandas and Polars rows in [feature parity](feature-parity.md) and the
[release contract](releasing.md). Native R Preview, experimental DuckDB work, and the limited PySpark viewer do not
expand that gate while their labels and limitations remain accurate.

Safety, data-loss prevention, runtime-corruption fixes, and publication correctness outrank broader backend coverage.

## Next priorities

### Deterministic transforms and validation

Add rank and bounded window operations, broaden typed formulas, and introduce schema or data-quality assertions with
explicit results. Transpose, explode, and unnest require engine-native type and lineage contracts. Joins and merge
remain deferred until multi-source identity, lifecycle, persistence, and source immutability have one accepted design.

Every new editing operation requires live-runtime and executable generated-code evidence on every editing-capable
engine. Cleaning-step reordering remains deferred pending evidence for lineage preservation, dependency handling, and
conflict behavior. Edit and delete do not imply a hidden move operation.

### Portable cleaning recipes

Define a versioned recipe format that can be explicitly exported and imported and contains no workspace-private source
or backend keys. Import must fail closed when column mapping is ambiguous, preview the mapping and incompatibilities,
and carry engine capability, source immutability, rollback, generated-code, and confirmation boundaries into batch
apply. Natural-language entry points may propose a validated draft, but cannot replace explicit mapping, preview, or
confirmation.

### DuckDB database browsing

Add bounded `.duckdb` catalog, schema, table, and view discovery before a general SQL entry point. Browsing must remain
engine-native. Preserve connection ownership, keep extension auto-install, autoload, and external-file caching
disabled, and state read-only versus editing and export behavior explicitly.

### Entry points and platform coverage

Evaluate debugger variables, remote environments, browser and code-server hosts, localization, non-dataframe
collections, and multidimensional arrays or tensors as separate slices. Each needs an exact source and lifecycle
owner, bounded transport, accessibility coverage, and a support claim that matches its tested hosts.
