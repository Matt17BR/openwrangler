# Feature parity matrix

This is the normative capability ledger for the current source. The generated [interface reference](reference.md) is
authoritative for command, setting, protocol, MIME, and operation names. The optional
[Data Wrangler comparison](performance-comparison.md) is retained as historical product evidence, not as a
stable-release gate.

**Done** is the standing capability status: the surface is implemented and backed by its current source or installed
owner. **Partial** means the capability is usable but remains deliberately limited or lacks evidence for part of its
claim. **Planned** means it is unavailable. **Out of scope** means it is deliberately unavailable for the stated
surface.

The Pandas and Polars rows below are required for stable releases.

| Surface                                             | Pandas | Polars | Status | Required evidence                                                                                                                                                                              |
| --------------------------------------------------- | -----: | -----: | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CSV/TSV/Parquet/Excel/JSONL entry points            |    Yes |    Yes | Done   | Native readers, import options, and file-launch surfaces; test:python/tests/test_pandas_engine.py; test:python/tests/test_polars_engine.py; record:docs/testing.md                             |
| Notebook variable viewer and toolbar                |    Yes |    Yes | Done   | Exact-notebook discovery, Python Interactive, and installed Jupyter owner; test:src/test/notebookPreviewCoordinator.unit.test.ts; record:docs/testing.md                                       |
| Inline notebook renderer and full-view expansion    |    Yes |    Yes | Done   | Bounded MIME rendering and exact live-value expansion; test:src/test/notebookRenderer.unit.test.ts; record:docs/testing.md                                                                     |
| Virtual grid, column sizing, navigation             |    Yes |    Yes | Done   | Projected virtualization, keyboard navigation, range copy, and column copy; test:src/test/webview.component.test.tsx; record:docs/testing.md                                                   |
| Dataset summary and quick insights                  |    Yes |    Yes | Done   | Native profiles, exact sums, typed extrema, and accessible charts; test:src/test/numericSummary.component.test.tsx; record:docs/testing.md                                                     |
| Basic and advanced viewing filters                  |    Yes |    Yes | Done   | Typed values, predicates, AND/OR composition, and filter history; test:python/tests/test_filter_logic.py; test:src/test/filterPanel.component.test.tsx                                         |
| Multi-column viewing sorts                          |    Yes |    Yes | Done   | Ordered priorities and stable native execution; test:python/tests/test_pandas_engine.py; test:python/tests/test_polars_engine.py                                                               |
| Editing mode and operation catalog                  |    Yes |    Yes | Done   | All 32 generated catalog operations and the installed picker; test:python/tests/test_operations.py; test:src/test/operations.unit.test.ts; record:docs/testing.md                              |
| Draft preview and data diff                         |    Yes |    Yes | Done   | Typed identity diff plus preview/apply rollback; test:src/test/dataGridDiff.component.test.tsx; record:docs/testing.md                                                                         |
| Cleaning-step history, edit, discard, undo          |    Yes |    Yes | Done   | Latest and earlier step edit/delete, suffix replay, discard, and undo; test:src/test/sessionCoordinator.planRewrite.unit.test.ts; record:docs/testing.md                                       |
| Generated code preview and editing                  |    Yes |    Yes | Done   | Editable native code and runtime-equivalent execution; test:src/test/codePreviewSynchronization.unit.test.ts; record:docs/testing.md                                                           |
| Sort/filter cleaning steps                          |    Yes |    Yes | Done   | Stable-reference live and generated contracts; test:python/tests/test_operation_edges.py; record:docs/testing.md                                                                               |
| Select/drop/rename/clone/cast/formula/length        |    Yes |    Yes | Done   | Stable lineage, duplicate-label handling, and generated parity; test:python/tests/test_operation_edges.py; record:docs/testing.md                                                              |
| Drop missing/duplicate rows                         |    Yes |    Yes | Done   | All public row-reduction modes and generated parity; test:python/tests/test_operation_edges.py; record:docs/testing.md                                                                         |
| Fill missing values                                 |    Yes |    Yes | Done   | Typed global, fallback, directional, grouped, and interpolation methods; test:python/tests/test_operation_edges.py; record:docs/testing.md                                                     |
| One-hot and multi-label binarization                |    Yes |    Yes | Done   | Null, blank, collision, and generated-code parity; test:python/tests/test_operation_edges.py; record:docs/testing.md                                                                           |
| Find/replace/strip/split/case transforms            |    Yes |    Yes | Done   | Text transforms, multi-output split, and portable regex extraction; test:python/tests/test_operation_edges.py; record:docs/testing.md                                                          |
| Scale/round/floor/ceiling/datetime format           |    Yes |    Yes | Done   | Native numeric and datetime edge contracts; test:python/tests/test_operation_edges.py; record:docs/testing.md                                                                                  |
| Group and aggregate                                 |    Yes |    Yes | Done   | Ordered groups and normalized numeric aggregation; test:python/tests/test_group_numeric_parity.py; record:docs/testing.md                                                                      |
| Custom engine-native code                           |    Yes |    Yes | Done   | Trusted isolated input, output validation, and executable native code; test:python/tests/test_pandas_engine.py; test:python/tests/test_polars_engine.py                                        |
| String/datetime/new-column by example               |    Yes |    Yes | Done   | Bounded deterministic synthesis and native execution; test:python/tests/test_by_example.py; record:docs/testing.md                                                                             |
| Copy/script/notebook code export                    |    Yes |    Yes | Done   | Editable-buffer copy, source-safe script save, and exact notebook insertion; test:src/test/safeFileExport.unit.test.ts; test:src/test/notebookInsertion.unit.test.ts                           |
| CSV and Parquet data export                         |    Yes |    Yes | Done   | Configurable native serialization and host-owned publication; test:src/test/safePythonDataExport.unit.test.ts; record:docs/testing.md                                                          |
| Runtime selection, setup, change, clear             |    Yes |    Yes | Done   | Resource-scoped selection, dependency confirmation, engine change, and cleanup; test:src/test/runtimeCommands.unit.test.ts; record:docs/testing.md                                             |
| Original icons, native views, themes, accessibility |    N/A |    N/A | Done   | Theme-token UI, keyboard semantics, and editor views; test:src/test/webview.component.test.tsx; record:docs/testing.md                                                                         |
| Runtime crash/reload/session replay                 |    Yes |    Yes | Done   | Backend-pinned recovery, persisted plan/view replay, and cleanup; test:src/test/sessionCoordinator.recovery.unit.test.ts; record:docs/testing.md                                               |
| Column-projected grid-block transport               |    Yes |    Yes | Done   | Bounded row/column windows with native projection pushdown; test:src/test/appColumnProjection.component.test.tsx; record:docs/testing.md                                                       |
| Duplicate/non-string Pandas column operations       |    Yes |    N/A | Done   | Positional binding, stable IDs, index fidelity, and replay; test:python/tests/test_pandas_engine.py; test:python/tests/test_pandas_index_fidelity.py                                           |
| Restricted Mode and trust-gated execution           |    N/A |    N/A | Done   | Untrusted execution denial and trusted installed journey; test:src/test/packageManifest.unit.test.ts; record:docs/testing.md                                                                   |
| Installed-editor first-usable-grid performance      |    Yes |    Yes | Done   | Pinned VS Code installed-performance consumes the canonical candidate; test:python/tests/test_performance_harness.py; workflow:.github/workflows/release-candidate.yml; record:docs/testing.md |
| VS Code package acceptance and compatibility seam   |    N/A |    N/A | Done   | Canonical candidate in pinned VS Code installed-performance and bounded Linux Cursor platform smoke; workflow:.github/workflows/release-candidate.yml; record:docs/testing.md                  |

Open Wrangler targets desktop VS Code and editors based on it. Release-candidate performance is qualified in pinned
VS Code. Bounded Linux Cursor platform smoke is one concrete compatibility example. It covers representative grid,
cleaning, export, and recovery flows, but not the full VS Code qualification matrix.

File inputs include `.xls` and `.xlsx` workbooks plus `.jsonl` and `.ndjson` aliases. Pandas supports duplicate and
non-string labels and exposes named index or MultiIndex row labels independently of ordinary columns. Column
operations bind those inputs by stable identity and position, but name-addressed viewing filters and sorts fail closed
when duplicate or display-colliding labels are ambiguous. Pandas CSV and Parquet exports require an explicit
preserve-or-omit index choice. Polars uses native string column names; ordinary lazy operations stay lazy, while
one-hot encoding, multi-label encoding, and custom code may materialize. Pandas accepts its supported text encodings
and Unicode CSV syntax; Polars CSV export remains UTF-8 with single-byte delimiter and quote syntax. Excel accepts
exactly one sheet name or zero-based sheet index; delimited syntax characters are one Unicode scalar each. Import
options may therefore make Pandas the only compatible backend. Direct pickle opening is unavailable; the trusted
Pandas-only conversion command writes a separate Parquet file.

Python live entry points include the notebook toolbar, Jupyter Variables, linked MIME output, and `.py` or `# %%`
execution through Python Interactive. MIME v2 is a static capture, not session or export data: it is capped at 10,000
rows, 2,048 columns, 100,000 cells, 16 MiB, 64 graph levels, and 1,000,000 graph nodes, and pages at 10, 20, 50, or
100 rows. Its full-view action opens only the exact current live value in the originating notebook and kernel.
Cleaned-data export requires no draft and writes the committed plan, never the viewing filters or sorts, to a local
file destination through the shared publication boundary.

Visual baselines and axe scans are not exhaustive assistive-technology certification or proof that every virtualized
cell is simultaneously present in the DOM.

The catalog contains 32 operations: five row/order, seven column/type, ten categorical/text, five numeric/datetime,
two reshape, Group and aggregate, Transform by example, and Custom code. The exact names and parameters are in the
[generated catalog](reference.md#transformation-operations). Transpose, explode, and unnest are not hidden catalog
entries.

## Release rule

A stable release requires every required Pandas and Polars row above to be **Done**, no known release-blocking defect,
and one exact candidate to pass the [qualification flow](releasing.md#release-candidate). Preview,
experimental, Partial, Planned, and Out-of-scope rows do not block stable publication when their public labels and
limits remain accurate.

## Native R preview

Native R keeps the **Preview** label in every release channel. These rows describe the current capability and its
limits; none is a stable-release gate.

| Surface                                       | Availability                    | Status  | Current owner                                                       |
| --------------------------------------------- | ------------------------------- | ------- | ------------------------------------------------------------------- |
| Native R frame paging and typed cells         | Preview                         | Partial | Projected native frame contracts and representative installed pages |
| Native R compound viewing filters             | Preview                         | Partial | Native predicate contracts and installed value paths                |
| Native R value search and selections          | Preview                         | Partial | Typed selection and bounded search contracts                        |
| Native R ordered viewing sorts                | Preview                         | Partial | Native stable-sort contracts and editor paths                       |
| Native R column and dataset profiles          | Preview                         | Partial | Exact and sampled native profile contracts                          |
| Base `data.frame`, tibble, and `data.table`   | Preview                         | Partial | Native discovery, paging, query, and profile contracts              |
| Exact IRkernel session transport              | Preview                         | Done    | Exact-kernel ownership and supported desktop-host journeys          |
| Exact active R-terminal transport             | Preview                         | Partial | Official-R-terminal discovery and callback contracts                |
| Cursor-owned `.Rmd` and `.qmd` R/Python chunk | Preview                         | Partial | Executor-aware exact-origin contracts                               |
| Owned `.R` source process                     | macOS and Linux Preview         | Partial | Owned-process lifecycle contracts                                   |
| Owned `.Rmd` and `.qmd` cell process          | macOS and Linux Preview         | Partial | Lexical-cell and owned-process contracts                            |
| Notebook workbench                            | Preview                         | Partial | Installed viewing/editing and verified kernel-restart recovery      |
| R cleaning operations and generated code      | Generated catalog               | Partial | Exact native live, generated-code, and replay contracts             |
| Copy or save generated R                      | Generated catalog               | Partial | Editable-buffer copy and atomic script-save contracts               |
| Insert generated R into its IRkernel notebook | Preview                         | Partial | Exact-document insertion contracts                                  |
| Insert generated R into its source `.R` file  | macOS and Linux Preview         | Partial | Exact-document insertion and supported-host rerun                   |
| Insert generated R into `.Rmd` and `.qmd`     | macOS and Linux Preview         | Partial | Exact-document insertion contracts                                  |
| Cleaned-data export                           | R notebook/document CSV/Parquet | Partial | Native writers and host-owned atomic publication                    |
| Active R-terminal cleaned-data export         | Preview                         | Partial | Native streaming and host-owned atomic publication                  |
| Quarto and R Markdown lexical R-cell run      | Preview                         | Partial | Exact lexical-cell routing contracts                                |

The accepted frame boundary is base `data.frame`, tibble, and `data.table`, including ordinary default
`collapse::qDF()`, `qTBL()`, and `qDT()` outputs through those same paths. Grouped `GRP_df`, `indexed_frame`,
unsupported attributes, and unsupported cell classes are rejected. Direct `.R`, `.Rmd`, and `.qmd` execution is
limited to macOS and Linux; IRkernel remains cross-platform. R Markdown and Quarto support runs selected lexical
cells, not document-render semantics. An active R terminal has no source document for generated-code insertion.
Large R profiles retain exact cheap statistics but sample histograms, categories, and duplicate populations with
explicit sample labels.

The complete current operation set has direct native live, generated-code, and replay contracts. The exact names and
parameters live in the [generated reference](reference.md#transformation-operations). CSV export is UTF-8 with
double-quote syntax. Parquet export additionally requires `nanoparquet` 0.5.1 or newer in the selected R environment,
and notebook export is available only from the current local extension host. Fill interpolation does not accept
`integer64` coordinates, and active `data.table` keys restrict in-place changes. The durable ownership boundary lives
in the [Native R ADR](decisions/0001-native-r-runtime.md).

## DuckDB experimental file support

DuckDB file sessions remain native and connection-scoped. They do not convert through Pandas, Polars, or Arrow, and
extension auto-install, autoload, and external-file caching stay disabled.

| Surface                                      | Availability       | Status  | Current evidence                               | Limit or missing proof                              |
| -------------------------------------------- | ------------------ | ------- | ---------------------------------------------- | --------------------------------------------------- |
| CSV and TSV file sessions                    | Yes                | Partial | Native lazy reader and packaged import slices  | Complete import-option and cross-platform matrix    |
| Parquet file sessions                        | Yes                | Partial | Native typed pages and source invalidation     | Large-scale and repeated cross-platform matrix      |
| JSONL file sessions                          | Yes                | Partial | Native malformed-input and packaged import     | Installed malformed/import-state interaction matrix |
| Excel file sessions                          | No                 | Planned | Explicit unsupported diagnostic                | Use Pandas or Polars                                |
| `.duckdb` database/catalog/table browsing    | No                 | Planned | Source kind is not registered                  | Separate connection, discovery, and security design |
| Notebook variables and inline MIME rendering | Viewing only       | Partial | Native relation package slices                 | No cleaning, code insertion, or data export         |
| Grid pages, typed cells, filters, and sorts  | Yes                | Partial | Native rich-type and query contracts           | Large-scale mixed-data and cross-platform matrix    |
| Summaries, statistics, and distinct values   | Yes                | Partial | Native fixed-size profile contracts            | Repeated large-data resource evidence               |
| Complete 32-operation catalog                | File sessions only | Partial | Exact direct live/generated catalog equality   | Complete installed catalog and semantic-edge matrix |
| Draft preview, diff, apply, and history      | File sessions only | Partial | Runtime and representative packaged lifecycle  | Complete edit/discard/undo interaction matrix       |
| Executable generated DuckDB code             | File sessions only | Partial | Direct equality and packaged copy/script slice | Edited-code execution acceptance                    |
| CSV and Parquet cleaned-data export          | File sessions only | Partial | Native export and publication failure tests    | Cross-platform installed destination matrix         |
| Runtime crash/reload/session replay          | Yes                | Partial | Backend-keyed replay and injected recovery     | Repeated cross-platform failure matrix              |
| Runtime performance benchmark                | Diagnostic         | Partial | Direct and stdio smoke                         | No strict DuckDB release threshold                  |

DuckDB file imports support CSV, TSV, Parquet, and JSONL. A multibyte quote character is incompatible and fails
before runtime startup. CSV export is UTF-8 with single-byte delimiter and quote syntax. DuckDB rejects schemas whose
identifiers differ only by case. Notebook `DuckDBPyRelation` values retain the user's relation for serialized viewing
only; closing releases Open Wrangler's reference and never closes the user's connection.

## PySpark live-notebook viewing

Only stable/final PySpark 4.2.x local Classic and local Connect batch DataFrames are supported. PySpark is
notebook-only and viewing-only. It uses the notebook's existing Spark session and never converts through a local
dataframe engine.

| Surface                                        | Availability       | Status       | Current evidence                             | Boundary                                    |
| ---------------------------------------------- | ------------------ | ------------ | -------------------------------------------- | ------------------------------------------- |
| Local Classic DataFrame viewing                | Live notebook only | Done         | Direct stable/final-version path             | Installed prerelease denial is unearned     |
| Local Spark Connect DataFrame viewing          | Live notebook only | Done         | Direct and installed local Connect path      | Local Connect only                          |
| Progressive projected grid pages               | Viewing only       | Done         | Lookahead, boundary, and terminal-page tests | Sequential traversal                        |
| Basic/advanced filters and multi-column sorts  | Viewing only       | Done         | Native expressions and packaged queries      | Unique final key needed for repeatable ties |
| Summaries, statistics, and distinct values     | Viewing only       | Done         | Native fixed-size aggregate tests            | Header profiles start off                   |
| Session recovery and non-interrupting disposal | Viewing only       | Done         | Classic/Connect rebind and cleanup           | Running Spark work is not interrupted       |
| Cleaning operations and history                | No                 | Out of scope | Editing capability is absent                 | No distributed transformation plan          |
| Script/notebook/data export                    | No                 | Out of scope | Export capability is absent                  | No Spark export contract                    |
| Saved-output MIME formatter                    | No                 | Out of scope | Saved-output capability is absent            | Live variables only                         |
| File sessions and automatic backend selection  | No                 | Out of scope | File capability is absent                    | Notebook variables only                     |
| Streaming, external, or authenticated clusters | No                 | Out of scope | Local batch contract only                    | No authentication or provisioning           |

The first page does not count, globally index, cache, or persist the whole dataframe. Paging advances sequentially;
only a short terminal page establishes an exact total. Spark does not promise source order, and repeatable sorted ties
need a unique final key. Queued or stale work is dropped, but running notebook work is detached and ignored rather
than interrupted. Persistence, Spark provisioning, cluster authentication, and lifecycle ownership remain outside
the contract.

## Deferred and unsupported scope

These dispositions do not block stable publication unless a release starts advertising the capability.

| Surface                                                                                   | Current disposition                                                                                   |
| ----------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Cleaning-step reorder                                                                     | Deferred; edit and delete earlier steps are supported, but no move primitive exists                   |
| Transpose, explode, and unnest                                                            | Planned after the implemented deterministic split, regex, and pivot operations                        |
| Rank/window operations, broader formulas, and assertions                                  | Planned operation work                                                                                |
| Joins and merge                                                                           | Deferred until multi-source identity, lifecycle, persistence, and source-immutability have one design |
| Portable cleaning recipes and batch apply                                                 | Planned after the deterministic operation primitives                                                  |
| Natural-language and Copilot operations                                                   | Deferred until deterministic operations and portable recipe validation exist                          |
| DuckDB Excel and database browsing                                                        | Planned experimental expansion; not part of current support                                           |
| Debugger variables and non-dataframe list, dictionary, array, tensor, or scalar renderers | Deferred entry-point and data-model work                                                              |
| Browser, code-server, virtual-workspace, and Remote SSH hosts                             | Not release-qualified; the desktop target is VS Code and editors based on it                          |
| VS Code-based desktop editors                                                             | Bounded Linux Cursor platform smoke is representative; broader compatibility remains experimental     |
| Localization and telemetry                                                                | Deferred product breadth                                                                              |
| Broader cross-engine CSV codec parity and polished row-header presentation                | Deferred and explicitly nonblocking in the product roadmap                                            |

The current priorities and deferral dependencies live in the [product roadmap](product-roadmap.md).
