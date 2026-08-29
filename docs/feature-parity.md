# Feature parity matrix

This is the normative capability ledger for the current source. The comparison baseline is Microsoft Data Wrangler
1.24.2 exercised through its public VS Code UI; the method lives in the
[comparison specification](performance-comparison.md). The generated [interface reference](reference.md) is
authoritative for command, setting, protocol, MIME, and operation names. [Testing](testing.md) defines the direct and
installed evidence owners.

**Done** is the standing capability status: the surface is implemented and backed by accepted source or release
evidence. It is not a claim that the current release candidate has rerun every installed journey. **Partial** means
the capability is usable but lacks part of its declared acceptance or stable-release proof. **Planned** means it is
unavailable. **Out of scope** means it is deliberately unavailable for the stated release surface.

The Pandas and Polars rows below are required for stable releases. Their evidence cells name representative current
test, workflow, or documentation owners rather than immutable run receipts. Stable authoring checks the exact table,
statuses, and tracked-path token syntax; candidate qualification must rerun every applicable installed owner.

| Surface                                              | Pandas | Polars | Status | Required evidence                                                                                                                                                                                                       |
| ---------------------------------------------------- | -----: | -----: | ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CSV/TSV/Parquet/Excel/JSONL entry points             |    Yes |    Yes | Done   | Native readers, import options, and file-launch surfaces; test:python/tests/test_pandas_engine.py; test:python/tests/test_polars_engine.py; record:docs/testing.md                                                      |
| Notebook variable viewer and toolbar                 |    Yes |    Yes | Done   | Exact-notebook discovery, Python Interactive, and installed Jupyter owner; test:src/test/notebookPreviewCoordinator.unit.test.ts; record:docs/testing.md                                                                |
| Inline notebook renderer and full-view expansion     |    Yes |    Yes | Done   | Bounded MIME rendering and exact live-value expansion; test:src/test/notebookRenderer.unit.test.ts; record:docs/testing.md                                                                                              |
| Virtual grid, column sizing, navigation              |    Yes |    Yes | Done   | Projected virtualization, keyboard navigation, range copy, and column copy; test:src/test/webview.component.test.tsx; record:docs/testing.md                                                                            |
| Dataset summary and quick insights                   |    Yes |    Yes | Done   | Native profiles, exact sums, typed extrema, and accessible charts; test:src/test/numericSummary.component.test.tsx; record:docs/testing.md                                                                              |
| Basic and advanced viewing filters                   |    Yes |    Yes | Done   | Typed values, predicates, AND/OR composition, and filter history; test:python/tests/test_filter_logic.py; test:src/test/filterPanel.component.test.tsx                                                                  |
| Multi-column viewing sorts                           |    Yes |    Yes | Done   | Ordered priorities and stable native execution; test:python/tests/test_pandas_engine.py; test:python/tests/test_polars_engine.py                                                                                        |
| Editing mode and operation catalog                   |    Yes |    Yes | Done   | All 32 generated catalog operations and the installed picker; test:python/tests/test_operations.py; test:src/test/operations.unit.test.ts; record:docs/testing.md                                                       |
| Draft preview and data diff                          |    Yes |    Yes | Done   | Typed identity diff plus preview/apply rollback; test:src/test/dataGridDiff.component.test.tsx; record:docs/testing.md                                                                                                  |
| Cleaning-step history, edit, discard, undo           |    Yes |    Yes | Done   | Latest and earlier step edit/delete, suffix replay, discard, and undo; test:src/test/sessionCoordinator.planRewrite.unit.test.ts; record:docs/testing.md                                                                |
| Generated code preview and editing                   |    Yes |    Yes | Done   | Editable native code and runtime-equivalent execution; test:src/test/codePreviewSynchronization.unit.test.ts; record:docs/testing.md                                                                                    |
| Sort/filter cleaning steps                           |    Yes |    Yes | Done   | Stable-reference live and generated contracts; test:python/tests/test_operation_edges.py; record:docs/testing.md                                                                                                        |
| Select/drop/rename/clone/cast/formula/length         |    Yes |    Yes | Done   | Stable lineage, duplicate-label handling, and generated parity; test:python/tests/test_operation_edges.py; record:docs/testing.md                                                                                       |
| Drop missing/duplicate rows                          |    Yes |    Yes | Done   | All public row-reduction modes and generated parity; test:python/tests/test_operation_edges.py; record:docs/testing.md                                                                                                  |
| Fill missing values                                  |    Yes |    Yes | Done   | Typed global, fallback, directional, grouped, and interpolation methods; test:python/tests/test_operation_edges.py; record:docs/testing.md                                                                              |
| One-hot and multi-label binarization                 |    Yes |    Yes | Done   | Null, blank, collision, and generated-code parity; test:python/tests/test_operation_edges.py; record:docs/testing.md                                                                                                    |
| Find/replace/strip/split/case transforms             |    Yes |    Yes | Done   | Text transforms, multi-output split, and portable regex extraction; test:python/tests/test_operation_edges.py; record:docs/testing.md                                                                                   |
| Scale/round/floor/ceiling/datetime format            |    Yes |    Yes | Done   | Native numeric and datetime edge contracts; test:python/tests/test_operation_edges.py; record:docs/testing.md                                                                                                           |
| Group and aggregate                                  |    Yes |    Yes | Done   | Ordered groups and normalized numeric aggregation; test:python/tests/test_group_numeric_parity.py; record:docs/testing.md                                                                                               |
| Custom engine-native code                            |    Yes |    Yes | Done   | Trusted isolated input, output validation, and executable native code; test:python/tests/test_pandas_engine.py; test:python/tests/test_polars_engine.py                                                                 |
| String/datetime/new-column by example                |    Yes |    Yes | Done   | Bounded deterministic synthesis and native execution; test:python/tests/test_by_example.py; record:docs/testing.md                                                                                                      |
| Copy/script/notebook code export                     |    Yes |    Yes | Done   | Editable-buffer copy, source-safe script save, and exact notebook insertion; test:src/test/safeFileExport.unit.test.ts; test:src/test/notebookInsertion.unit.test.ts                                                    |
| CSV and Parquet data export                          |    Yes |    Yes | Done   | Configurable native serialization and host-owned publication; test:src/test/safePythonDataExport.unit.test.ts; record:docs/testing.md                                                                                   |
| Runtime selection, setup, change, clear              |    Yes |    Yes | Done   | Resource-scoped selection, dependency confirmation, engine change, and cleanup; test:src/test/runtimeCommands.unit.test.ts; record:docs/testing.md                                                                      |
| Original icons, native views, themes, accessibility  |    N/A |    N/A | Done   | Theme-token UI, keyboard semantics, and editor views; test:src/test/webview.component.test.tsx; record:docs/testing.md                                                                                                  |
| Runtime crash/reload/session replay                  |    Yes |    Yes | Done   | Backend-pinned recovery, persisted plan/view replay, and cleanup; test:src/test/sessionCoordinator.recovery.unit.test.ts; record:docs/testing.md                                                                        |
| Column-projected grid-block transport                |    Yes |    Yes | Done   | Bounded row/column windows with native projection pushdown; test:src/test/appColumnProjection.component.test.tsx; record:docs/testing.md                                                                                |
| Duplicate/non-string Pandas column operations        |    Yes |    N/A | Done   | Positional binding, stable IDs, index fidelity, and replay; test:python/tests/test_pandas_engine.py; test:python/tests/test_pandas_index_fidelity.py                                                                    |
| Restricted Mode and trust-gated execution            |    N/A |    N/A | Done   | Untrusted execution denial and trusted installed journey; test:src/test/packageManifest.unit.test.ts; record:docs/testing.md                                                                                            |
| Installed-editor first-usable-grid performance       |    Yes |    Yes | Done   | The strict runtime and current candidate harness are Polars-only; Pandas/Polars release measurement uses the versioned comparison; test:python/tests/test_performance_harness.py; record:docs/performance-comparison.md |
| Cross-platform first-class editor package acceptance |    N/A |    N/A | Done   | VS Code/Cursor acceptance and the separate bounded Remote SSH owner; workflow:.github/workflows/candidate-acceptance.yml; workflow:.github/workflows/release-candidate.yml; record:docs/testing.md                      |

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

Visual baselines and axe scans are local/manual evidence, not ordinary pull-request or candidate jobs, exhaustive
assistive-technology certification, or proof that every virtualized cell is simultaneously present in the DOM. The
standing installed-performance row likewise does not replace the missing versioned 2.0 comparison; current candidate
measurement exercises only the default Polars path in VS Code.

The catalog contains 32 operations: five row/order, seven column/type, ten categorical/text, five numeric/datetime,
two reshape, Group and aggregate, Transform by example, and Custom code. The exact names and parameters are in the
[generated catalog](reference.md#transformation-operations). Transpose, explode, and unnest are not hidden catalog
entries.

## Release rule

Stable 2.0 is not ready at this revision:

- Native R has 19 Partial preview rows. Stable authoring requires its separate complete 21-row canonical scope to be
  Done, including an ordinary `collapse::qDF()`, `qTBL()`, and `qDT()` row. R still lacks an exact-candidate all-32
  installed record, a reviewed threshold-bearing performance record wired into stable authoring, candidate-owned
  Cursor coverage for the advertised Linux seams, and an exact-candidate run of the standalone R contract suite.
- The [approachability gates](product-roadmap.md#approachability-gates) still lack complete rolling and maintainability
  evidence. Release-readiness tooling does not inspect their state, so their closure remains a required manual review.
- Stable documentation still needs the versioned 2.0 Data Wrangler comparison.
- The release-candidate Python Jupyter job supplies only VS Code to a `candidate-one-owner` profile that requires VS
  Code and Cursor, so the current candidate graph stops before that acceptance topology can qualify.

A stable 2.0 release requires every Pandas/Polars row and all 21 canonical stable Native R rows to be Done, every
[stable gate](product-roadmap.md#stable-20-gates) to be closed, no known release-blocking defect, and one exact
candidate to pass [qualification](releasing.md#release-candidate). Partial or Planned experimental rows do not block
2.0, but they cannot be presented as stable support.

## Native R preview

| Surface                                       | Availability                    | Status  | Current checks                                                                                                       | Release check   |
| --------------------------------------------- | ------------------------------- | ------- | -------------------------------------------------------------------------------------------------------------------- | --------------- |
| Native R frame paging and typed cells         | 1.99 preview                    | Partial | Projected frame contracts and representative installed pages; stable candidate breadth is incomplete                 | Preview release |
| Native R compound viewing filters             | 1.99 preview                    | Partial | Native predicate contracts and representative installed value paths                                                  | Preview release |
| Native R value search and selections          | 1.99 preview                    | Partial | Typed selection contracts and representative installed value paths                                                   | Preview release |
| Native R ordered viewing sorts                | 1.99 preview                    | Partial | Stable native sort contracts and representative editor paths                                                         | Preview release |
| Native R column and dataset profiles          | 1.99 preview                    | Partial | Exact and sampled profile contracts plus representative UI paths                                                     | Preview release |
| Base `data.frame`, tibble, and `data.table`   | 1.99 preview                    | Partial | Native discovery, paging, query, and profile contracts                                                               | Preview release |
| Exact IRkernel session transport              | 1.99 preview                    | Done    | Linux local VS Code/Cursor and remote VS Code; macOS/Windows VS Code gate                                            | Preview release |
| Exact active R-terminal transport             | 1.99 preview                    | Partial | Official-R-terminal discovery and callback contracts; candidate Cursor ownership is absent                           | Preview release |
| Cursor-owned `.Rmd` and `.qmd` R/Python chunk | 1.99 preview                    | Partial | Executor-aware exact-origin contracts; candidate Cursor ownership is absent                                          | Preview release |
| Owned `.R` source process                     | 1.99 preview                    | Partial | Real process contracts on macOS and Linux; Windows document execution is unavailable                                 | Preview release |
| Owned `.Rmd` and `.qmd` cell process          | 1.99 preview                    | Partial | Lexical-cell and process contracts on macOS and Linux; candidate Cursor ownership is absent                          | Preview release |
| Notebook workbench                            | 1.99 preview                    | Partial | Installed viewing/editing and stateful recovery; scalar installed restart coverage is incomplete                     | Preview release |
| R cleaning operations and generated code      | 32 operations                   | Partial | Exact live/generated source catalog; exhaustive installed execution and reviewed performance evidence are incomplete | Preview release |
| Copy or save generated R                      | 32 operations                   | Partial | Exact operation-labelled copy/save contract; exhaustive installed catalog evidence is incomplete                     | Preview release |
| Insert generated R into its IRkernel notebook | 1.99 preview                    | Partial | Exact-document insertion contracts and representative packaged execution                                             | Preview release |
| Insert generated R into its source `.R` file  | 1.99 preview                    | Partial | Exact-document insertion and packaged rerun on supported hosts                                                       | Preview release |
| Insert generated R into `.Rmd` and `.qmd`     | 1.99 preview                    | Partial | Exact-document insertion contracts; candidate Cursor ownership is absent                                             | Preview release |
| Cleaned-data export                           | R notebook/document CSV/Parquet | Partial | Native writers and host-owned publication; complete candidate destination coverage is incomplete                     | Preview release |
| Active R-terminal cleaned-data export         | 1.99 preview                    | Partial | Native streaming and host-owned publication; candidate Linux VS Code/Cursor CSV and Parquet coverage is incomplete   | Preview release |
| Quarto and R Markdown lexical R-cell run      | 1.99 preview                    | Partial | Exact lexical-cell routing; candidate Cursor R Markdown and R/Python Quarto coverage is absent                       | Preview release |

The accepted frame boundary is base `data.frame`, tibble, and `data.table`, including ordinary default
`collapse::qDF()`, `qTBL()`, and `qDT()` outputs through those same paths. Grouped `GRP_df`, `indexed_frame`,
unsupported attributes, and unsupported cell classes are rejected. Direct `.R`, `.Rmd`, and `.qmd` execution is
limited to macOS and Linux; IRkernel remains cross-platform. R Markdown and Quarto support runs selected lexical
cells, not document-render semantics. An active R terminal has no source document for generated-code insertion.
Large R profiles retain exact cheap statistics but sample histograms, categories, and duplicate populations with
explicit sample labels.

All 32 operations have a direct native live/generated/replay contract, but that source proof does not satisfy the
missing installed and performance gates. CSV export is UTF-8 with double-quote syntax. Parquet export additionally
requires `nanoparquet` 0.5.1 or newer in the selected R environment, and notebook export is available only from the
current local extension host. Fill interpolation does not accept `integer64` coordinates, and active `data.table`
keys restrict in-place changes. The [R boundary](decisions/0001-native-r-runtime.md) and
[release-candidate topology](architecture.md#release-candidate-acceptance-topology) define the intended stable
ownership; the current workflow gaps above keep the affected rows Partial.

## DuckDB experimental file support

DuckDB file sessions remain native and connection-scoped. They do not convert through Pandas, Polars, or Arrow, and
extension auto-install, autoload, and external-file caching stay disabled. The direct engine owner is
[test_duckdb_engine.py](../python/tests/test_duckdb_engine.py). These rows are not stable-2.0 blockers.

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
notebook-only, viewing-only, and nonblocking for stable 2.0. It uses the notebook's existing Spark session and never
converts through a local dataframe engine. Direct owners include
[test_pyspark_engine.py](../python/tests/test_pyspark_engine.py),
[test_pyspark_paging.py](../python/tests/test_pyspark_paging.py), and
[test_pyspark_profiles.py](../python/tests/test_pyspark_profiles.py).

| Surface                                        | Availability       | Status       | Current evidence                             | Boundary                                    |
| ---------------------------------------------- | ------------------ | ------------ | -------------------------------------------- | ------------------------------------------- |
| Local Classic DataFrame viewing                | Live notebook only | Done         | Direct stable/final-version path             | Installed prerelease denial is unearned     |
| Local Spark Connect DataFrame viewing          | Live notebook only | Done         | Direct and installed local Connect path      | Local Connect only                          |
| Progressive projected grid pages               | Viewing only       | Done         | Lookahead, boundary, and terminal-page tests | Sequential traversal                        |
| Basic/advanced filters and multi-column sorts  | Viewing only       | Done         | Native expressions and packaged queries      | Unique final key needed for repeatable ties |
| Summaries, statistics, and distinct values     | Viewing only       | Done         | Native fixed-size aggregate tests            | Header profiles start off                   |
| Session recovery and non-interrupting disposal | Viewing only       | Done         | Classic/Connect rebind and cleanup           | Running Spark work is not interrupted       |
| Released-Jupyter packaged acceptance           | One owner and seam | Partial      | Source topology expects VS Code and Cursor   | Current candidate supplies only VS Code     |
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

These dispositions do not block stable 2.0 unless a release starts advertising the capability.

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
| Browser, code-server, and virtual-workspace hosts                                         | Unsupported; the documented Remote SSH path is the bounded remote exception                           |
| Other VS Code desktop forks                                                               | Experimental; evidence for one fork does not establish a general compatibility claim                  |
| Localization and telemetry                                                                | Deferred product breadth                                                                              |
| Broader cross-engine CSV codec parity and polished row-header presentation                | Deferred and explicitly nonblocking in the product roadmap                                            |

The current priorities and deferral dependencies live in the [product roadmap](product-roadmap.md). Release-specific
evidence belongs in the candidate artifacts and versioned comparison report, not in this file.
