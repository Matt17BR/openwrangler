# Product roadmap

This roadmap describes current support and planned work. [Feature parity](feature-parity.md) shows which capabilities
are ready. The generated [reference](reference.md) lists commands, settings, operations, and protocol names.

## Current supported scope

- Pandas and Polars are the main editing engines for files and supported Python notebook variables.
- Native R remains **Preview** even when it is included in a stable Open Wrangler release. Base `data.frame`, tibble,
  and `data.table` values use R directly through the documented notebook, terminal, and document paths.
- DuckDB is experimental. File sessions support native editing and export; notebook `DuckDBPyRelation` values are
  view-only. Open Wrangler does not yet browse `.duckdb` catalogs, schemas, tables, views, or arbitrary SQL.
- PySpark 4.2 support is limited to local-notebook viewing of Classic and Connect batch DataFrames. Open Wrangler does
  not edit, export, install, or configure Spark. Streaming, remote clusters, and authenticated clusters are
  unsupported.
- Open Wrangler is release-qualified on desktop VS Code. Cursor receives a smaller Linux compatibility check covering
  representative grid, cleaning, export, and recovery flows, not the full VS Code test set. Compatibility with Cursor
  and other VS Code-based editors remains experimental. Browser and virtual workspace hosts are unsupported, and
  Remote SSH is not part of release testing.

## Release priorities

Stable releases require the Pandas and Polars rows named in [feature parity](feature-parity.md) and must follow the
[release process](releasing.md). Native R Preview, experimental DuckDB, and the PySpark viewer stay outside that gate
while their labels and limitations remain accurate.

Fixes for data loss, runtime corruption, and release publication take priority over adding another backend.

## Work toward 2.1.0

Before adding more features, current work focuses on:

- separating large UI, session, protocol, and runtime responsibilities so each can be tested directly;
- removing duplicate live and generated operation rules while keeping generated code standalone and readable; and
- improving Python type checking and making supported-version rules, dependency checks, test suites, release scripts,
  and public documentation easier to maintain.

Throughout this work, data safety, trust checks, accessibility, engine-native execution, and verified release artifacts
must remain intact. Open Wrangler 2.1.0 can ship when a substantial set of high-priority fixes meets the release
boundary above. Lower-priority cleanup can continue afterward.

## Later product work

### Deterministic transforms and validation

Add rank and window operations, more typed formulas, and schema or data-quality checks with clear results. Transpose,
explode, and unnest need engine-native type and lineage rules. Joins and merge remain deferred until source identity,
lifecycle, persistence, and immutability rules are defined.

Every new editing operation must work both live and in executable generated code for every editing engine. Cleaning
steps cannot be reordered until lineage, dependencies, and conflicts can be preserved. Editing and deleting a step do
not imply a hidden move operation.

### Portable cleaning recipes

Define a versioned recipe that users can export and import without workspace-private source or backend keys. Import
must reject ambiguous column mappings, show the proposed mapping and incompatibilities, and preserve engine support,
source immutability, rollback, generated code, and confirmation rules. Natural-language input may propose a draft; it
cannot skip mapping, preview, or confirmation.

### DuckDB database browsing

Add a browser for `.duckdb` catalogs, schemas, tables, and views before exposing general SQL. Keep queries in DuckDB,
preserve connection ownership, and leave extension auto-install, autoload, and external-file caching off. The UI must
state when a source is read-only and whether editing or export is available.

### Entry points and platform coverage

Evaluate debugger variables, remote environments, browser and code-server hosts, localization, non-dataframe
collections, and multidimensional arrays or tensors separately. Each addition needs a named source and lifecycle
owner, transport limits, accessibility coverage, and a support claim that matches the hosts actually tested.
