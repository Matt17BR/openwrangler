# Data Wrangler 1.24.2 comparison review

## Method review

Status: pending independent approval after the paired real-product smoke.

The review compared the runner contract with [`docs/performance-comparison.md`](../../performance-comparison.md) and
checked the following points:

- four fixed Pandas/Polars and CSV/Parquet cells;
- ten paired warm runs per cell, with each product first five times;
- one AB and one BA cold pair per cell;
- public notebook, launch, grid, and profiling boundaries;
- fixed UI and whole-phase deadlines;
- one retained result for success, product failure, timeout, or harness failure;
- type-7 median and p95 plus paired differences;
- a fixed pre-action wait, continuous sampling, and highest observed absolute process-tree PSS;
- predeclared release limits for every median and p95;
- exact candidate, editor, Python, fixture, and harness versions/hashes;
- a fresh headless user profile and source copy per trial;
- resume by completed trial ID; and
- opaque handling of the Microsoft extension.

The runner is intentionally small. It uses the existing editor-acceptance launcher instead of a separate supervisor,
stores plain JSON files instead of a custom ledger, and has no preregistration or preparation framework. Two prepared
extension directories are reused to avoid repeated Marketplace downloads; user data, notebooks, sources, kernels, and
workbench processes remain isolated per trial. The runner removes those directories after all outcomes are retained.

This checklist describes the intended procedure. It does not approve collection or a speed claim until a reviewer
signs off after the smoke run.

## Smoke review

Status: pending.

Before the full run, review one real `pandas-csv` trial for:

- the expected inline and workbench actions;
- stable sentinel values and scrollable grid;
- first and final column-profile milestones;
- a non-empty PSS series around the measured window; and
- clean process/profile shutdown without touching the user's editor session.

Do not reuse the smoke timing in the full report.

## Final calculation review

Status: pending all 96 planned outcomes.

The final reviewer will record the report SHA-256 and independently recalculate:

- success, failure, timeout, and incomplete counts;
- every warm median and p95 using type 7;
- every paired Open Wrangler minus Data Wrangler distribution;
- cold results as a separate descriptive table;
- the pre-action and measured-window coverage plus highest observed absolute PSS for each successful trial; and
- every relative-plus-absolute release-limit decision.

The reviewer must also confirm that the published report contains no private paths, source values, raw logs,
screenshots, DOM captures, or Microsoft package contents.
