# Data Wrangler 1.24.2 comparison review

## Method

Status: pending review after the real-product smoke.

The reviewer will compare the runner with
[`docs/performance-comparison.md`](../../performance-comparison.md) and confirm:

- four Pandas/Polars and CSV/Parquet workloads;
- one isolated session per product and workload;
- ten warm samples in every session;
- public inline, launch, grid, and all-column profiling boundaries;
- peak process-tree PSS for every measured workflow;
- exact candidate, editor, Python, fixture, and tool versions and hashes;
- median-only release limits, with p95 reported for context;
- resume by completed session without replacing measured results; and
- black-box handling of Data Wrangler.

Reviewer and date: pending.

## Smoke

Status: pending.

Before collection, check the two real Pandas/CSV smoke sessions—one per product—for the expected inline and launch
actions, full scrollable grid, first and final profile milestones, two completed samples per product, PSS coverage, and clean
shutdown. Smoke timings are not part of the published comparison.

Reviewer and date: pending.

## Results

Status: pending all eight sessions and 80 samples.

The final reviewer will record the report SHA-256 and independently recalculate observation counts, failures, minimum,
maximum, median, type-7 p95, peak PSS, and every median regression decision. The report must contain no private paths,
source values, raw logs, screenshots, DOM captures, or Microsoft package contents.

Reviewer, date, and report SHA-256: pending.
