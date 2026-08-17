# Pull-request topology measurement — 2026-08-17

This record compares two successful, exact-head, first-attempt pull-request cohorts. It is a bounded topology and
runner-time measurement, not a rolling service-level result.

## Exact cohorts

| Cohort                  | Exact head                                 | Workflow               |           Run | Attempt | Executed jobs | Summed runner seconds |
| ----------------------- | ------------------------------------------ | ---------------------- | ------------: | ------: | ------------: | --------------------: |
| Pre-selection           | `1f26cecd37b5716653173d6c4632e241b4741acc` | CI                     |   31980674025 |       1 |            15 |                 2,838 |
| Pre-selection           | `1f26cecd37b5716653173d6c4632e241b4741acc` | Cross-platform runtime |   31980673910 |       1 |             5 |                   975 |
| Pre-selection           | `1f26cecd37b5716653173d6c4632e241b4741acc` | CodeQL                 |   31980673883 |       1 |             3 |                   229 |
| Path-selected           | `e20a79ead0c6161d3c6f28a3f3a17473c4c9ffe1` | CI                     |   32025563199 |       1 |             8 |                 1,645 |
| Path-selected           | `e20a79ead0c6161d3c6f28a3f3a17473c4c9ffe1` | Cross-platform runtime | no PR trigger |       — |             0 |                     0 |
| Path-selected           | `e20a79ead0c6161d3c6f28a3f3a17473c4c9ffe1` | CodeQL                 |   32025563203 |       1 |             3 |                   235 |
| **Pre-selection total** |                                            |                        |               |         |        **23** |             **4,042** |
| **Path-selected total** |                                            |                        |               |         |        **11** |             **1,880** |

The exact comparison is a reduction of 12 executed jobs (52.2%) and 2,162 observed runner seconds (53.5%). Both
cohorts include the complete CI and CodeQL result gates. The earlier cohort also includes its then-required
pull-request Cross workflow; the path-selected workflow intentionally has no pull-request Cross trigger.

## Method

- Each row is bound to the workflow run's exact head, `pull_request` event, attempt number, and terminal success.
- Executed jobs are the expanded jobs returned for that run whose conclusion is not `skipped`, including classifier
  and result-gate jobs.
- Runner seconds are the sum of each non-skipped job's `completed_at - started_at` interval. They are observed
  occupancy, not rounded billing minutes, CPU time, or a causal estimate.
- A missing workflow is counted as zero only when the exact-head API has no run and the reviewed workflow has no
  pull-request trigger. It is not a skipped or substituted run.

## What remains open

The comparison proves the job-count and observed runner-time reductions for these two exact cohorts. It does not
prove the rolling p95, queue behavior, or first-attempt reliability target. The scheduling change in this tree lets
selected changed-area owners start immediately after classification beside the invariant core; that change is not
credited as a wall-time improvement until a fresh hosted exact-head run demonstrates the resulting dependency graph.
The p95 and reliability gates require their complete rolling populations rather than extrapolation from this pair.
