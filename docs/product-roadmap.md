# Product roadmap

[Feature parity](feature-parity.md) describes what works today and its limits. [Changelog](../CHANGELOG.md)
records delivered changes. This page records delivered release priorities and proposals that need further review.

## Release priorities

[Open Wrangler 2.5.0](https://github.com/Matt17BR/openwrangler/milestone/15) delivered
[stable R notebook support](https://github.com/Matt17BR/openwrangler/issues/1381) for the
[defined ordinary-frame scope](feature-parity.md#first-stable-r-notebook-scope) in IRkernel notebooks
in desktop VS Code on Linux, macOS and Windows.

No next release outcome is selected. Explode List and Extract Struct Fields are implemented on main within their
[supported scope](feature-parity.md#cleaning-operations). The proposals below remain open and unscheduled; selection
requires a reviewed scope, acceptance criteria and practical cost.

## Feature proposals

These are open, unscheduled proposals. User demand is not yet established; examples and practical constraints are
welcome in their issues. Start with useful single-source operations before taking on broader source ownership.

- [Apply a cleaning plan to another input](https://github.com/Matt17BR/openwrangler/issues/1385): matching-schema file reuse is implemented on main; column mapping and broader input support remain proposals. See the [current scope](feature-parity.md#reuse-a-file-cleaning-plan).
- [Clean a DuckDB notebook relation](https://github.com/Matt17BR/openwrangler/issues/1386): extend today's viewer with native cleaning, code and export.
- [Browse a DuckDB database](https://github.com/Matt17BR/openwrangler/issues/1387): choose a read-only table or view without writing SQL.
- [Join or append a second input](https://github.com/Matt17BR/openwrangler/issues/1388): a later proposal that first needs explicit source and row-growth rules.
- [Workbench interaction design](https://github.com/Matt17BR/openwrangler/issues/1397): compare simpler, distinct layouts for task clarity, visible data and keyboard access before choosing a redesign.

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
