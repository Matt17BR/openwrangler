# Product roadmap

[Feature parity](feature-parity.md) describes what works today and its limits. [Changelog](../CHANGELOG.md)
records delivered changes. This page records release priorities and proposals that need further review.

## Release priorities

[Open Wrangler 2.5.0](https://github.com/Matt17BR/openwrangler/milestone/15) delivered
[stable R notebook support](https://github.com/Matt17BR/openwrangler/issues/1381) for the
[defined ordinary-frame scope](feature-parity.md#first-stable-r-notebook-scope) in IRkernel notebooks
in desktop VS Code on Linux, macOS and Windows.

[Open Wrangler 2.6](https://github.com/Matt17BR/openwrangler/milestone/16) is the next selected release. Main includes
the native capture correction for [DuckDB row consistency](https://github.com/Matt17BR/openwrangler/issues/1487),
including explicit notebook connection selection and its [capture costs](feature-parity.md#sessions-and-generated-code).
The [macOS import-options focus](https://github.com/Matt17BR/openwrangler/issues/1482) issue is fixed on main.
Custom-backed [step inspection](https://github.com/Matt17BR/openwrangler/issues/1526) now reuses its input/output pair
in Pandas, Polars, DuckDB and native R.
R profiles now provide [exact numeric histograms and low-cardinality categorical counts](https://github.com/Matt17BR/openwrangler/issues/1553)
beyond 100,000 rows, plus [exact numeric distinct counts through 10,000 distinct values](https://github.com/Matt17BR/openwrangler/issues/1558).
The [native R support guide](feature-parity.md#native-r-support) records remaining sampling and cardinality limits.
The [Jupyter Variables failure](https://github.com/Matt17BR/openwrangler/issues/1498) remains open under the
[documented support limitation](feature-parity.md#sessions-and-generated-code).

Before release, merge and verify [native R file options, plan reuse and Windows execution](https://github.com/Matt17BR/openwrangler/pull/1571),
the [bounded R List and Struct workflow](https://github.com/Matt17BR/openwrangler/issues/1565), and
[refreshed public media and performance results](https://github.com/Matt17BR/openwrangler/issues/1554).
Local R file support remains Preview. The milestone links the required outcomes and records the release decision.

After these outcomes, freeze scope and qualify one immutable 2.6.0 candidate under [Releasing](releasing.md#release-candidate).
Qualification and publication remain separate; no release date or automatic publication is promised.
Polars Explode List and Polars/DuckDB Extract Struct Fields are implemented on main within their
[supported scope](feature-parity.md#cleaning-operations); the R expansion is tracked above.

## Released-product comparison

The latest reviewed [dated report](performance/2026-09-16-released-products/review.md) compares released Open Wrangler 2.5.0
and Microsoft Data Wrangler through public interfaces in an isolated local VS Code instance. It records paired Pandas
and Polars routes, separate Open Wrangler engine observations, and output differences. Before 2.6 and every later
stable release, rerun the advertised comparison on the final integrated product and refresh public screenshots under
the [stable-release checklist](releasing.md#stable-release-media-and-comparison-checklist). Preserve earlier dated
reports and update this pointer when the new results are reviewed and merged. The retired
[2.4.0 attempt](https://github.com/Matt17BR/openwrangler/issues/1419) remains incomplete; its automation is not being resumed.

## Workbench design

[Open Wrangler 3.0](https://github.com/Matt17BR/openwrangler/milestone/17) records the workbench design direction.
[Design selection](https://github.com/Matt17BR/openwrangler/issues/1397) retains native navigation and cleaning history
beside the central grid, the column-profile drawer, modal operation settings and native Code Preview. Draft and
inspection actions stay beside their result. Compared alternatives added scrolling or obscured useful context without
demonstrating a task advantage. At narrow widths, open native sidebars and Code Preview reduce the data area and require
scrolling or panel resizing.

The selected corrections, wide and narrow workflow checks, keyboard/accessibility checks and refreshed media landed
in [#1539](https://github.com/Matt17BR/openwrangler/pull/1539) and are included in the current 2.6 source. They are no
longer pending work held until after 2.6. The design issue retains the observations and tradeoffs; any remaining 3.0
scope needs separate selection. The milestone does not authorize a major-version bump or publication.

## Feature proposals

These proposals remain outside the selected 2.6 scope and unscheduled. Further examples and practical constraints are
welcome in their issues. Start with useful single-source operations before taking on broader source ownership.

- [Apply a cleaning plan to another input](https://github.com/Matt17BR/openwrangler/issues/1385): matching-schema file reuse is implemented on main; column mapping and broader input support remain proposals. See the [current scope](feature-parity.md#reuse-a-file-cleaning-plan).
- [Clean a DuckDB notebook relation](https://github.com/Matt17BR/openwrangler/issues/1386): extend today's viewer with native cleaning, code and export.
- [Browse a DuckDB database](https://github.com/Matt17BR/openwrangler/issues/1387): base-table viewing supports multiple tables in one runtime; database views remain a proposal. See the [current limits](feature-parity.md#duckdb-experimental-file-support).
- [Join or append a second input](https://github.com/Matt17BR/openwrangler/issues/1388): a later proposal that first needs explicit source and row-growth rules.

Spark remains a bounded local-notebook viewer. Broader Spark support, additional backends and remote or browser hosts
need a concrete user job before selection. Historical ideas and their closure reasons remain in the
[archived product-expansion milestone](https://github.com/Matt17BR/openwrangler/milestone/13); they are not a promised backlog.

## Keeping plans useful

Each issue owns its proposed scope, exclusions, acceptance criteria and main cost. Milestones contain selected release
work. Keep useful deferred proposals open without a milestone; close rejected or superseded proposals with the reason.
Completed work links its implementation and relevant release evidence, then updates the capability guide or changelog.

Use existing engine, session and validation owners where they fit. New editing behavior needs matching live and
generated results, explicit support limits and source preservation. A new workflow, abstraction or test matrix needs a
demonstrated benefit; keeping the issue list empty or making modules smaller is not a product goal.
