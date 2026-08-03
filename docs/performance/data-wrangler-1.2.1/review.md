# Review record for the Open Wrangler 1.2.1 comparison method

## Review target

This record covers the comparison method at source commit
`a5ab47fff24274ca48fba9a0f3484ec941e5d7a3`. At that commit,
`docs/performance-comparison.md` has SHA-256
`ad210706b47b6fd682a02eff07bb11bff64364a538d8301897342cb088d0e364`.

The method was reviewed before any publishable measurement was collected. This record names the reviewed artifacts
and findings without attributing them to a person. A navigation link added to the method after this review does not
change a study rule. The final results review must record the final document and source hashes again.

## Scope

The review covered the four planned Pandas/Polars and CSV/Parquet cells, the fixed ten-pair warm schedule, the separate
cold-source runs, public notebook and workbench actions, profile completion, PSS sampling, result calculation, and the
predeclared regression thresholds. It also covered preparation, immutable input receipts, append-only trial records,
restart behavior, and process cleanup.

The study compares the same synthetic dataframe and Python environment in both products. It measures the notebook
output, opening the workbench, the first completed column profile, every-column profile completion, and observed
process memory. The review checked that median and p95 use the declared type-7 calculation and that failed, timed-out,
or unmatched trials cannot be turned into successful samples.

## Clean-room boundary

The runner may use Microsoft Data Wrangler's public Marketplace installation, visible UI, accessibility names and
roles, official VS Code APIs used for neutral setup, and ordinary process information exposed by Linux. It must not
open, copy, hash, unpack, list, or retain the proprietary extension's files. It may not inspect DevTools sources,
source maps, private commands, messages, selectors, logs, or storage.

The final evidence may contain only synthetic-data facts, normalized public observations, path-free provenance, and
bounded process measurements. It may identify the public Data Wrangler extension ID and version, but not its package
bytes or implementation. A Polars source does not prove which engine Data Wrangler uses internally; the report can
name that engine only when the public UI shows it.

## Findings resolved before measurement

Earlier review passes stopped the study for concrete problems rather than accepting partial evidence:

- Preparation initially traversed and hashed the installed Data Wrangler package. The replacement path excludes that
  subtree before any stat, open, hash, or traversal and reconstructs the permitted inventory from public CLI output
  and the pinned Marketplace version.
- Two disposable-root cleanup paths were not bound to the exact directories they had created. Cleanup now retains
  directory identities, moves an owned root into a private quarantine, rechecks the public name, parent, quarantine,
  and payload, and fails without deletion when ownership or containment is uncertain.
- The notebook driver initially relied on assumptions about Run Cell controls and action labels that did not match the
  current VS Code accessibility tree. It now opens the notebook through the VS Code notebook API, binds the measured
  cell by its public position, reads the real accessible action name, and rejects ambiguous or stale controls.
- Workbench readiness was too close to first paint in earlier iterations. The accepted boundary now requires the full
  source shape, stable and unobstructed pointer geometry, verified sentinel values, and completed vertical and
  horizontal scrolling before it records readiness.
- Profiling and memory boundaries needed to stay attached to the same user journey. The controller now records the
  public profile action, first useful profile, complete schema traversal, stable pre-action PSS windows, and final
  quiescence on one monotonic timeline.
- Warm-up and measured editor phases originally had gaps around notebook startup, kernel selection, request
  acknowledgement, and interrupted cleanup. The current path uses durable correlated requests, append-only intents
  and fragments, exact kernel and process identities, terminal process-tree checks, and fail-closed recovery after an
  interruption.

These fixes were exercised with focused contract tests, including forbidden-package-subtree traps, replaced-directory
and cleanup-race cases, malformed or stale control messages, current notebook controls, source identity changes,
process reuse, and restart recovery. Real headless preparation was used to find several of the action and lifecycle
problems before the study was allowed to proceed.

## Recheck outcome

The recheck confirmed that the written method and runner agree on:

- four engine/format cells, ten counterbalanced warm pairs per cell, and separate AB/BA cold pairs;
- the exact deterministic 100,000 by 50 CSV and 1,000,000 by 20 Parquet inputs;
- public Run Cell and launch actions, full-shape grid readiness, and complete column-profile traversal;
- type-7 median and p95, retained failures and right-censored timeouts, and the declared regression thresholds;
- total and per-process-category maximum observed sampled PSS, stable baselines, and baseline-adjusted deltas;
- source, candidate, interpreter, editor, fixture, profile, and process-lifecycle receipts; and
- the rule that a material Open Wrangler regression requires investigation and a fresh valid run after a fix.

The review therefore accepts the method and runner as the basis for collecting the study. It does not approve a
performance result or a release claim.

## Final review still required

No publishable measurement or result was available for this review. Attempts r1 through r16 were setup-only and are
invalidated. They must not be analyzed, cited, or combined with the final study.

After the fresh study completes, a second review must inspect the exact preregistration, candidate, manifest, every
retained fragment, and the finalized result. It must independently recalculate the summaries and regression decisions,
check engine and inline-surface attribution, account for failures and limitations, and confirm that the README,
changelog, release notes, and report say only what the evidence supports. Open Wrangler 1.2.1 must not be published
until that final review is recorded.
