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
measured notebook workflow. The full benchmark uses 8 sessions and records 80 samples.

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

For each product and workload, the report keeps all ten outcomes, including failures. Successful timings are summarized
with the minimum, maximum, median, and type-7 p95. The p95 remains descriptive; only the median is a release gate.

A numeric regression blocks the release only when Open Wrangler's median exceeds both parts of a limit below. Small
timing differences are treated as noise.

| Measure           | Relative allowance | Absolute allowance |
| ----------------- | -----------------: | -----------------: |
| Inline preview    |                20% |             250 ms |
| Workbench open    |                20% |             250 ms |
| First profile     |                20% |             500 ms |
| All profiles      |                20% |           2,000 ms |
| Observed peak PSS |                10% |            256 MiB |

The release contract requires all 10 Open Wrangler successes and at least 6 Data Wrangler successes per workload.
Six is the smallest strict majority of the ten baseline outcomes, preserving the protocol's predeclared majority rule.
Every generated report has one machine-readable release disposition:

- **Pass:** all eight sessions and 80 outcomes are present, all ten Open Wrangler samples succeeded in every workload,
  at least six Data Wrangler samples succeeded in every workload, and no material median regression was found.
- **Fail:** the collection is complete and comparable, but an Open Wrangler sample failed or timed out, or a material
  median regression was found.
- **Inconclusive:** a scheduled session is missing, a harness-aborted session still needs replacement, fewer than six
  Data Wrangler samples succeeded in any workload, or the report describes the two-sample smoke profile.

Measured Data Wrangler failures and timeouts stay in the primary results and never make a complete collection fail when
at least six baseline samples remain. They can make it inconclusive when fewer than six remain. Open Wrangler failures
and timeouts are also immutable and make a complete, comparable report fail. Measured actions are not retried inside a
session, and slow values are not removed.

Only a session whose unsuccessful outcomes are all classified as harness failures is replaceable. Re-running the same
output directory atomically replaces that interrupted session while terminal sessions remain untouched. A separate
retry or confirmation collection is a separate report; its outcomes must never be merged into or substituted for the
primary collection.

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

Pass the real executable files, not symlink launchers. On Linux, `realpath /usr/bin/code` gives the VS Code CLI file.
If a virtual environment symlinks `python`, create it with `python3.12 -m venv --copies` or use another regular
Python 3.12 executable that has the pinned packages installed.

The command writes one atomic result per session. Re-running it resumes at the first missing or interrupted session.
It does not replace a successful session.

Generate the checked report after all eight sessions finish:

```bash
npm run comparison:report -- \
  --study /absolute/path/benchmark-output \
  --out /path/to/repo/docs/performance/data-wrangler-2.0.0/report.json \
  --review /path/to/repo/docs/performance/data-wrangler-2.0.0/review.md
```

Create `review.md` first and put the manual method and review notes around this empty block:

```markdown
<!-- open-wrangler-comparison-results:start -->
<!-- open-wrangler-comparison-results:end -->
```

The command validates the report and its explicit disposition before it writes either file, then replaces only that
block.
`npm run docs:check` compares it with the sibling `report.json`, so an edited or out-of-date table fails the check.
If the review write is interrupted after `report.json` is saved, rerun the same command. It reuses the report only
when the raw evidence is identical. The 1.2.1 review predates this format and remains unchanged.

Use `npm run comparison:smoke` with the same arguments before a full collection. The
smoke runs two sessions—one per product—against the Pandas/CSV workload, with two samples in each. It catches broken selectors or permissions;
its timings are not release results. If the machine sleeps or the command stops, run it again with the same output
directory; only an interrupted session is repeated.

### Optional local mixed-data check

For a heavier check on a development build, run the manual local profile:

```bash
npm run comparison:local -- \
  --candidate /absolute/path/openwrangler.vsix \
  --python /absolute/path/python3.12 \
  --editor /absolute/path/code \
  --editor-cli /absolute/path/code-cli \
  --out /absolute/path/local-comparison-output \
  --confirm-local-comparison yes
```

This creates one temporary 1,000,000 × 100 Parquet file with numeric, boolean, text, date, timestamp, and null data.
The file is capped at 640 MiB while it is written. The command stops before generating it unless at least 16 GiB of
memory and 1.75 GiB of free space are available for the fixture and the private trial copy.

The run has four sessions: Open Wrangler and Data Wrangler with Pandas, then both products with Polars. Each session
records three passes through inline preview, viewer launch, complete column profiling, and process-tree PSS. It uses
the same editor driver as the release study, runs only on the current machine, and does not create cloud resources.
At least two passes must finish in each session. A failed pass stays in the raw results, so an occasional editor
timeout is visible without making the optional check unusable.
The temporary Parquet file is removed when the command finishes or reports an error. This profile is not part of CI
and does not replace the reviewed release study. If the process is interrupted, the next run removes the identified
fixture left by the dead process before it starts.

## Review

Before publication, a second reviewer checks the eight session IDs, ten samples per session, versions and hashes,
the recorded start and end events, recalculated summaries, median regression decisions, memory coverage, and failures. The
report must contain no private paths, source values, screenshots, logs, or proprietary package contents.

The retained [`1.2.1 comparison`](performance/data-wrangler-1.2.1/review.md) is historical evidence. It predates the
machine-readable report contract and does not describe current Open Wrangler performance.

A comparison becomes current completed evidence only when all of these conditions hold:

- its versioned `review.md` and sibling `report.json` are both tracked;
- the report passes the complete release-study schema and disposition checks;
- the report directory and provenance name the exact current Open Wrangler source version; and
- release readiness confirms that the report's candidate digest matches the VSIX being released.

Until those conditions hold, the README must identify its linked comparison as historical, state that it does not
describe current performance, and make no comparative performance claim. After a current report is complete, the
README may keep a short evidence-backed summary and a link to the dated review instead of copying the results table.
Create a new versioned directory when a release reruns the comparison with the VSIX that will be published, and
commit its `review.md` and `report.json` together.
