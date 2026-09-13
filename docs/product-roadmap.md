# Product roadmap

[Feature parity](feature-parity.md) describes what works today and its limits. [Changelog](../CHANGELOG.md)
records delivered changes. This page links the work selected next and proposals that need further review.

## Current focus

Fix confirmed data-integrity and reliability problems, and simplify code or checks when their maintenance cost has a
concrete cause. [Current maintenance](https://github.com/Matt17BR/openwrangler/issues/905) tracks those findings,
including the remaining DuckDB CSV import and R source-test containment problems. The continuous maintenance tracker
is not a release milestone, and an open feature proposal is not an unresolved defect.

## Next selected outcome

The next stable target is [Open Wrangler 2.5.0](https://github.com/Matt17BR/openwrangler/milestone/15), following the [version policy](releasing.md#version-and-channel-policy).
Its selected product outcome is [stable R notebook support](https://github.com/Matt17BR/openwrangler/issues/1381) for the existing ordinary base `data.frame`,
tibble and `data.table` scope in IRkernel notebooks in desktop VS Code for Linux, macOS and Windows.

R remains **Preview**. Graduation needs the [defined reliability review and candidate evidence](feature-parity.md#first-stable-r-notebook-scope).
Terminal, managed-document and Cursor support keep their separate labels. The milestone has no promised date;
publication still requires the [release process](releasing.md). Other work joins this milestone only when it is
explicitly selected and can meet its acceptance criteria.

## Feature proposals

These are open, unscheduled proposals. User demand is not yet established; examples and practical constraints are
welcome in their issues. Start with useful single-source operations before taking on broader source ownership.

- [Conditional columns](https://github.com/Matt17BR/openwrangler/issues/1382): derive a typed value from one condition, such as flagging overdue invoices.
- [Explicit date parsing and typed date parts](https://github.com/Matt17BR/openwrangler/issues/1383): choose a parsing format and create date or numeric outputs.
- [Bounded explode and unnest](https://github.com/Matt17BR/openwrangler/issues/1384): expand one supported list or struct column with clear row and type rules.
- [Apply a cleaning plan to another input](https://github.com/Matt17BR/openwrangler/issues/1385): review column mapping for one compatible target.
- [Clean a DuckDB notebook relation](https://github.com/Matt17BR/openwrangler/issues/1386): extend today's viewer with native cleaning, code and export.
- [Browse a DuckDB database](https://github.com/Matt17BR/openwrangler/issues/1387): choose a read-only table or view without writing SQL.
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
