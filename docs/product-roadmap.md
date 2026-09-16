# Product roadmap

[Feature parity](feature-parity.md) describes what works today and its limits. [Changelog](../CHANGELOG.md)
records delivered changes. This page records release priorities and proposals that need further review.

## Release priorities

[Open Wrangler 2.5.0](https://github.com/Matt17BR/openwrangler/milestone/15) delivered
[stable R notebook support](https://github.com/Matt17BR/openwrangler/issues/1381) for the
[defined ordinary-frame scope](feature-parity.md#first-stable-r-notebook-scope) in IRkernel notebooks
in desktop VS Code on Linux, macOS and Windows.

[Open Wrangler 2.6](https://github.com/Matt17BR/openwrangler/milestone/16) is the next selected release. It requires
an outcome for [DuckDB row consistency](https://github.com/Matt17BR/openwrangler/issues/1487).
The [macOS import-options focus](https://github.com/Matt17BR/openwrangler/issues/1482) issue is fixed on main.
Custom-backed [step inspection](https://github.com/Matt17BR/openwrangler/issues/1526) now reuses its input/output pair
in Pandas, Polars and native R.
The [Jupyter Variables failure](https://github.com/Matt17BR/openwrangler/issues/1498) remains open under the
[documented support limitation](feature-parity.md#sessions-and-generated-code).
The milestone links the required outcomes and records that release decision.

After these outcomes, freeze scope and qualify one immutable 2.6.0 candidate under [Releasing](releasing.md#release-candidate).
Qualification and publication remain separate; no release date or automatic publication is promised.
Explode List and Extract Struct Fields are implemented on main within their
[supported scope](feature-parity.md#cleaning-operations).

## Released-product comparison

The [released-product comparison](https://github.com/Matt17BR/openwrangler/issues/1519) uses released Open Wrangler 2.5.0
and Microsoft Data Wrangler through their public interfaces in an isolated local VS Code instance. It does not wait
for 2.6 or the redesign. The [dated report](performance/2026-09-16-released-products/review.md) records paired Pandas
and Polars routes, separate Open Wrangler engine observations, and output differences. Update the comparison when useful;
it is not a per-release obligation. The retired
[2.4.0 attempt](https://github.com/Matt17BR/openwrangler/issues/1419) remains incomplete; its automation is not being resumed.

## Selected work after 2.6

[Open Wrangler 3.0](https://github.com/Matt17BR/openwrangler/milestone/17) is planned for a distinctive, coherent workbench.
[Design selection](https://github.com/Matt17BR/openwrangler/issues/1397) compares two bounded directions for inspecting and
filtering, configuring and applying changes, and reviewing and exporting history. The milestone requires the selected
layout and interaction hierarchy to be implemented across the grid, profiles, operation settings, history/diff and code.
Real wide and narrow journeys, keyboard access, accessibility and representative responsiveness must support the choice.
Update README, gallery and store media to the delivered interface. Completing the design evaluation alone does not
complete the milestone. There is no date, automatic major-version bump or publication decision.

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
