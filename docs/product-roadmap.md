# Product roadmap

[Feature parity](feature-parity.md) describes what works today and its limits. [Changelog](../CHANGELOG.md)
records delivered changes. This page records release priorities and proposals that need further review.

## Release priorities

[Open Wrangler 2.5.0](https://github.com/Matt17BR/openwrangler/milestone/15) delivered
[stable R notebook support](https://github.com/Matt17BR/openwrangler/issues/1381) for the
[defined ordinary-frame scope](feature-parity.md#first-stable-r-notebook-scope) in IRkernel notebooks
in desktop VS Code on Linux, macOS and Windows.

[Open Wrangler 2.6.0](https://github.com/Matt17BR/openwrangler/releases/tag/v2.6.0) was released on 19 September 2026. It includes
the native capture correction for [DuckDB row consistency](https://github.com/Matt17BR/openwrangler/issues/1487),
including explicit notebook connection selection and its [capture costs](feature-parity.md#sessions-and-generated-code).
The [macOS import-options focus](https://github.com/Matt17BR/openwrangler/issues/1482) issue is fixed.
Custom-backed [step inspection](https://github.com/Matt17BR/openwrangler/issues/1526) now reuses its input/output pair
in Pandas, Polars, DuckDB and native R.
R profiles now provide [exact numeric histograms and low-cardinality categorical counts](https://github.com/Matt17BR/openwrangler/issues/1553)
beyond 100,000 rows, plus [exact numeric distinct counts through 10,000 distinct values](https://github.com/Matt17BR/openwrangler/issues/1558).
The [native R support guide](feature-parity.md#native-r-support) records remaining sampling and cardinality limits.
The [Jupyter Variables failure](https://github.com/Matt17BR/openwrangler/issues/1498) remains open under the
[documented support limitation](feature-parity.md#sessions-and-generated-code).

The [native R file options, plan reuse and Windows execution](https://github.com/Matt17BR/openwrangler/pull/1571)
and [bounded R List and Struct workflow](https://github.com/Matt17BR/openwrangler/pull/1572) shipped in 2.6.
Local R file support remains Preview. The [completed milestone](https://github.com/Matt17BR/openwrangler/milestone/16)
records the delivered scope.

[R cleaning library selection](https://github.com/Matt17BR/openwrangler/issues/1583) is available in 2.6:
base R, dplyr, data.table and collapse drive built-in cleaning and matching generated code.

The [public media and performance refresh](https://github.com/Matt17BR/openwrangler/issues/1554) delivered reviewed
screenshots and comparison results. The
[large R file responsiveness corrections](https://github.com/Matt17BR/openwrangler/issues/1616) are verified and merged.
The final file and R measurements are recorded in the [latest comparison](#released-product-comparison);
the later corrections do not change the displayed public screenshot states.
The [operation support guide](feature-parity.md#cleaning-operations) records the engine-specific scope of
Explode List and Extract Struct Fields.

The [R viewing-performance investigation](https://github.com/Matt17BR/openwrangler/issues/1622) for
[Open Wrangler 2.7](https://github.com/Matt17BR/openwrangler/milestone/18) delivered measured improvements to shared
filtering, sorting and text profiles while retaining exact native semantics. Headers and drawers keep one complete
summary; the measured extra reductions did not establish a net benefit from partial results. The
[architecture decision](architecture.md#viewing-and-profiling) records the retained owners and costs.
These changes are unreleased.

## Released-product comparison

The latest reviewed [dated report](performance/2026-09-19-release-preparation/review.md) measures the final development
package prepared for Open Wrangler 2.6 and Microsoft Data Wrangler through public interfaces in an isolated local
VS Code instance. It records paired CSV routes and native R managed-document observations, with setup failures and
measurement limits. Earlier notebook, DuckDB and Spark results retain their original source attribution in the linked
prior report. The comparison preceded immutable release qualification. For every stable release, rerun the advertised comparison
on the final integrated product and refresh public screenshots under
the [stable-release checklist](releasing.md#stable-release-media-and-comparison-checklist). Preserve earlier dated
reports and update this pointer when the new results are reviewed and merged. The retired
[2.4.0 attempt](https://github.com/Matt17BR/openwrangler/issues/1419) remains incomplete; its automation is not being resumed.

## Workbench design

[The selected workbench improvements](https://github.com/Matt17BR/openwrangler/issues/1397) shipped in 2.6. They retain native navigation and cleaning history
beside the central grid, the column-profile drawer, modal operation settings and native Code Preview. Draft and
inspection actions stay beside their result. Compared alternatives added scrolling or obscured useful context without
demonstrating a task advantage. At narrow widths, open native sidebars and Code Preview reduce the data area and require
scrolling or panel resizing.

The corrections, wide and narrow workflow checks, keyboard/accessibility checks and earlier media landed in
[#1539](https://github.com/Matt17BR/openwrangler/pull/1539). The refreshed public images and reviewed captions landed in
[#1574](https://github.com/Matt17BR/openwrangler/pull/1574), completing the selected design issue. The issue retains the
observations and tradeoffs; it does not require another redesign or duplicate capture.

A materially different [future visual direction](https://github.com/Matt17BR/openwrangler/milestone/17) remains
unselected. The implemented improvements do not establish that direction or authorize a major-version bump.

## Feature proposals

These proposals remain unscheduled. Further examples and practical constraints are
welcome in their issues. Start with useful single-source operations before taking on broader source ownership.

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
