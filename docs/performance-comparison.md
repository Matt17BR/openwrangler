# Open Wrangler and Data Wrangler benchmark

This benchmark compares Open Wrangler with Microsoft Data Wrangler 1.24.2 through the controls a notebook user
actually clicks. Data Wrangler is installed from the Marketplace; the test does not inspect its package.

## Workloads

| Dataframe | Source  |          Shape |
| --------- | ------- | -------------: |
| Pandas    | CSV     |   100,000 × 50 |
| Polars    | CSV     |   100,000 × 50 |
| Pandas    | Parquet | 1,000,000 × 20 |
| Polars    | Parquet | 1,000,000 × 20 |

The fixtures are deterministic integer tables generated for the benchmark. They contain no user data. Both products
receive the same Pandas object in the Pandas runs and the same Polars object in the Polars runs.

One **session** is one isolated VS Code window for one product and workload. One **sample** is one pass through the
measured notebook workflow. The full benchmark uses eight sessions and records 80 samples.

## Measurements

The benchmark starts eight isolated, headless VS Code sessions: one for each product and workload. It selects the
pinned Python 3.12 kernel, loads the dataframe, and handles first-use permission. Setup is not timed.

Each session records the same visible workflow ten times:

1. Run the dataframe cell and wait for a usable inline preview.
2. Click **Open in Open Wrangler** or **Open in Data Wrangler** and wait for a usable, scrollable grid.
3. Open column profiling and wait until every column has a completed profile.
4. Close the viewer before the next sample.

The dataframe and kernel stay resident for all ten samples. The benchmark measures a ready kernel and resident
dataframe; it does not measure editor startup or disk reads. A session has a ten-minute hard limit and a separate
three-minute no-progress limit. After timing stops, the harness returns Open Wrangler to the first column so the next
sample starts from the same viewport.

For every sample the runner records:

- cell click to usable inline preview;
- launch click to usable full grid;
- profiling click to the first completed column;
- profiling click to completed profiles for every column; and
- highest sampled proportional set size (PSS) for the editor-owned process tree during that workflow.

The UI checks the full dataframe shape, expected columns, scrollability, completed profiles, and pointer-ready public
actions. A loading shell or a partial profile does not count as ready. PSS is sampled every 200 ms; a gap longer than
one second invalidates the session instead of understating memory use.

## Results and release decision

For each product and workload, report the ten raw values, failures, minimum, maximum, median, and type-7 p95. With ten
observations, p95 is close to the slowest run, so it is useful context rather than a release gate.

Open Wrangler blocks the release only when its median exceeds both parts of a limit below. Small timing differences
are treated as noise.

| Measure           | Relative allowance | Absolute allowance |
| ----------------- | -----------------: | -----------------: |
| Inline preview    |                20% |             250 ms |
| Workbench open    |                20% |             250 ms |
| First profile     |                20% |             500 ms |
| All profiles      |                20% |           2,000 ms |
| Observed peak PSS |                10% |            256 MiB |

A publishable report needs ten successful samples for every product and workload. A measured product error stays
in the results. A setup or harness error invalidates only that session. Re-running the same output directory replaces
that interrupted session, while successful sessions remain untouched. Measured actions are not retried inside a
session and slow values are not removed.

## Environment

Use one official VS Code build, one packaged Open Wrangler candidate, Data Wrangler 1.24.2, and CPython 3.12 with
pinned Pandas, Polars, PyArrow, Jupyter Core, and ipykernel versions. Run on a quiet machine connected to the same power
source for the full collection.

Every session gets a private user-data directory, extensions directory, notebook, and read-only fixture copy. The
runner records versions, fixture hashes, the candidate hash, editor identity, Python identity, machine details, and
the benchmark-tool hashes. It does not use the normal editor profile or desktop, retain Data Wrangler package bytes,
or record dataframe values.

## Running it

Build the candidate and fixed fixtures, then run:

```bash
npm run comparison:study -- \
  --candidate /absolute/path/openwrangler.vsix \
  --python /absolute/path/python3.12 \
  --editor /absolute/path/code \
  --editor-cli /absolute/path/code-cli \
  --csv /absolute/path/100000-50.csv \
  --parquet /absolute/path/1000000-20.parquet \
  --out /absolute/path/benchmark-output
```

The command writes one atomic result per session. Re-running it resumes at the first missing or interrupted session.
It does not replace a successful session.

Generate the checked report after all eight sessions finish:

```bash
npm run comparison:report -- \
  --study /absolute/path/benchmark-output \
  --out /absolute/path/openwrangler-data-wrangler-report.json
```

Use `npm run comparison:smoke` with the same arguments before a full collection. The
smoke runs two sessions—one per product—against the Pandas/CSV workload, with two samples in each. It catches broken selectors or permissions;
its timings are not release results. If the machine sleeps or the command stops, run it again with the same output
directory; only an interrupted session is repeated.

## Review

Before publication, a second reviewer checks the eight session IDs, ten samples per session, versions and hashes,
the recorded start and end events, recalculated summaries, median regression decisions, memory coverage, and failures. The
report must contain no private paths, source values, screenshots, logs, or proprietary package contents.

Record the method and calculation review in
[`docs/performance/data-wrangler-1.2.1/review.md`](performance/data-wrangler-1.2.1/review.md).
