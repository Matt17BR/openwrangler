# Open Wrangler and Data Wrangler performance comparison

This is the method for the v1.2.1 comparison with Microsoft Data Wrangler 1.24.2. The study uses public product
surfaces and treats Data Wrangler as an opaque Marketplace extension. We do not inspect or retain its package.

The full report is not complete until all planned trials have run and the calculation review in
[`docs/performance/data-wrangler-1.2.1/review.md`](performance/data-wrangler-1.2.1/review.md) is signed off. A smoke run
only proves that the journey works; it is not performance evidence.

## What we measure

The study has four cells:

| Dataframe | Source  |          Shape |
| --------- | ------- | -------------: |
| Pandas    | CSV     |   100,000 × 50 |
| Polars    | CSV     |   100,000 × 50 |
| Pandas    | Parquet | 1,000,000 × 20 |
| Polars    | Parquet | 1,000,000 × 20 |

Both products receive the same Pandas object in the Pandas cells. Open Wrangler receives the real Polars dataframe in
the Polars cells. Data Wrangler receives that same variable through its public notebook action. We report only what
the UI proves about Data Wrangler's backend; we do not infer its implementation from timing.

Each trial follows one notebook journey:

1. run the tagged cell and wait for a stable inline preview with a usable launch action;
2. click **Open in Open Wrangler** or **Open in Data Wrangler** and wait for an unobstructed, scrollable grid;
3. open the public profiling surface and wait for the first useful profile;
4. visit columns in schema order and wait until all column summaries are final.

The recorded timings are:

- `inlinePreviewMs`: **Run Cell** click to the stable inline result;
- `workbenchOpenMs`: public launch-action click to the usable grid;
- `firstProfileMs`: profiling click to the first final column profile; and
- `completeProfileMs`: profiling click to final profiles for every column.

The driver checks public text, roles, geometry, busy state, deterministic headers and sentinel values. A loading shell,
hidden grid, blocked pointer, open Quick Input, or one-column profile does not satisfy the boundary.

## Data and notebook setup

Fixtures are synthetic integer tables with columns `c00` through `cNN`. Row zero contains `0, 1, 2, ...`; row one
contains `1, 2, 3, ...`. The CSV and Parquet files are hashed before the study and each trial receives a read-only copy
inside its private root. Before collection, the existing benchmark fixture contract scans the full schema, row count,
types, and value formula. The runner checks the original and copied hashes again for every trial. No user data is used.

Every trial first runs an untimed setup cell that creates a one-row dataframe. The host uses it to start the kernel,
activate the selected product, and settle first-use permission before timing. Open Wrangler requests permission while
it prepares notebook previews. For Data Wrangler, the host clicks the notebook toolbar's documented **View data**
action, waits for the bootstrap variable to appear, then closes the picker without opening a viewer. Warm trials also
load `study_frame` in the setup cell, so the measured cell only renders the resident variable. Cold trials leave the
source unopened until the measured cell loads and renders it. Setup and measured cells have separate exact tags:

```text
ow-comparison-setup:<cell-id>
ow-comparison-cell:<cell-id>
```

The neutral host uses that tag and the requested variable name. It does not use whichever notebook or editor happens
to be active.

After setup and permission handling, every trial waits a fixed 10 seconds before **Run Cell**. The PSS samples must
show that the process tree was stable during the last four seconds of that wait. The wait is never shortened or
extended to obtain a favorable sample.

Here, "cold" means the dataframe is not resident in the kernel before timing. The study does not flush the operating
system's filesystem cache, so cold results must not be presented as uncached-storage measurements.

## Schedule

For each cell, run ten warm pairs. Product order alternates so each product runs first five times. Cells are
interleaved by repetition rather than completing one workload before starting the next.

Then run two descriptive cold pairs per cell: one Open Wrangler/Data Wrangler order and one reversed order. Cold
results remain separate from the ten-sample warm distribution.

This produces 96 planned trials:

- 4 cells × 10 warm pairs × 2 products = 80 warm trials;
- 4 cells × 2 cold orders × 2 products = 16 cold trials.

The schedule is deterministic and every trial has a stable ID. The runner writes one result file per completed ID.
Restarting the same command skips those IDs and continues with the first missing trial; it never replaces a completed
failure, timeout, or slow sample.

## Environment

Use one official Microsoft VS Code build, one Open Wrangler v1.2.1 candidate VSIX, and CPython 3.12 with pinned
Pandas, Polars, PyArrow, Jupyter Core, and ipykernel versions. The manifest records the exact versions and SHA-256
digests for the editor executable and CLI, VS Code product metadata, Python executable, candidate, fixtures, method,
runner modules, dependency lock, fixture contract, and compiled host journey. Candidate and editor versions are read
from the VSIX and executables; they are not supplied as labels on the command line.

Data Wrangler is installed from the public Marketplace as `ms-toolsai.datawrangler@1.24.2`. Its ID and public version
are recorded. Its package bytes are neither hashed nor opened.

Every trial uses a new user-data directory, notebook, source copy, kernel, and headless zero-window workbench. The two
products have separate prepared extension directories, reused only to avoid reinstalling the same pinned extensions
96 times. The runner deletes those directories after the final trial. No trial uses the user's desktop, editor
profile, workspace, or credentials.

Use the same machine, power source, CPU policy, editor geometry, theme, zoom, and Python environment for the full run.
The manifest records OS, architecture, CPU model/count, RAM, power source, and CPU governor. Do not run other build,
editor, or benchmark jobs during collection.

## Timeouts and failures

The fixed UI deadlines are:

| Boundary                                                | Deadline |
| ------------------------------------------------------- | -------: |
| Everything before **Run Cell**, including the 10 s wait |     75 s |
| Inline preview                                          |     30 s |
| Workbench open                                          |     40 s |
| Complete profile                                        |    110 s |
| Editor phase                                            |    300 s |
| Neutral setup, editor phase, and teardown               |     40 m |

The pre-action deadline is one shared clock. Kernel selection, permission handling, setup, the fixed memory wait, and
finding **Run Cell** cannot each restart it. The four inner deadlines total 255 seconds, leaving 45 seconds for result
publication and cleanup inside the 300-second phase limit.

The 40-minute outer bound is not a product timing. It covers the first isolated installation of the pinned Jupyter,
Python, and product extensions as well as display startup and teardown. Each installer remains independently bounded;
later trials reuse the two verified product extension directories.

A product error or UI deadline is a trial outcome. Keep it in the report. Harness/setup failures are recorded
separately and invalidate the release study; fix the harness and start a fresh 96-trial directory. There is no outlier
trimming, automatic retry, or replacement run after a product action.

## Memory

On Linux, the parent launcher samples proportional set size (PSS) for the editor's owned process group and descendant
closure at 200 ms intervals. `/proc/<pid>/stat` start times guard against PID reuse. The sampler reads
`smaps_rollup` only for processes it can still prove belong to that launch.

The last 20 samples before **Run Cell** must span at least 3.4 seconds, have no gap above 500 ms, keep the same process
count, and end no more than 400 ms before the click. Their range must stay within both 64 MiB and 2.5% of the median.
The difference between the first-five and last-five medians must stay within both 32 MiB and 1.25%. A window that
misses any bound is a harness failure.

For each successful trial, report the highest observed absolute PSS between **Run Cell** and final profiling. Samples
must cover both ends of that window and may not have a gap above 500 ms. We do not publish a
baseline-adjusted figure: the diagnostic run showed that it could make the product with the lower absolute peak look
worse simply because its startup baseline was lower.

PSS includes the editor, extension host, renderer, kernel, and Open Wrangler runtime when present. It is not an
allocation profile of either extension. Each result retains only the bounded, path-free timestamp/PSS/process-count
series needed to recalculate the peak and settle check; it never retains PIDs or process arguments.

## Statistics

Warm results are the primary comparison. For every cell, product, timing, and memory measure, report:

- successful sample count;
- failures and timeouts;
- minimum and maximum;
- median; and
- p95.

Median and p95 use Hyndman-Fan type 7 interpolation, the default in R and NumPy. Paired summaries use Open Wrangler
minus Data Wrangler within each completed warm pair. Negative time or memory differences mean Open Wrangler used less.
Pairs with a failed or timed-out arm remain in the outcome table but do not enter the paired numeric distribution.

Ten samples are enough for a release comparison, not a universal performance claim. The report must name the machine,
versions, data shapes, success counts, and boundaries next to any headline result.

## Release limits

The final report requires all 96 trials to succeed and all ten warm pairs to be present for every workload. For each
warm median and p95, Open Wrangler is a material regression only when it exceeds both the relative and absolute
allowance below. One breach blocks the release; faster workloads do not cancel it out.

| Measure           | Relative allowance | Absolute allowance |
| ----------------- | -----------------: | -----------------: |
| Inline preview    |                20% |             250 ms |
| Workbench open    |                20% |             250 ms |
| First profile     |                20% |             500 ms |
| All profiles      |                20% |           2,000 ms |
| Absolute peak PSS |                10% |            256 MiB |

The first complete 96-trial run on 4 August 2026 was diagnostic. It found harness failures, an unsettled process tree,
and a Pandas/Parquet profiling regression. The candidate and method changed afterward, so that run is not v1.2.1
release evidence.

Both viewers showed the fixture's full shape in their public UI during that diagnostic. Their ARIA counts differed:
Open Wrangler reported N+1 rows and M+1 columns, while Data Wrangler reported 1,006 rows and M+1 columns. We retain
those values as accessibility metadata only. They do not prove how either product pages, samples, loads, or profiles
the data, and they do not alter the timing boundaries. Profiling time is the public end-to-end user experience, not a
claim that both opaque implementations perform the same internal work.

## Running the study

Build/package the candidate and generate the fixed fixtures first. Then run:

```bash
npm run comparison:study -- \
  --candidate /absolute/path/openwrangler.vsix \
  --python /absolute/path/python3.12 \
  --editor /absolute/path/code \
  --editor-cli /absolute/path/code-cli \
  --csv /absolute/path/study-100k-x-50.csv \
  --parquet /absolute/path/study-1m-x-20.parquet \
  --out /absolute/path/study-output
```

The command builds only the neutral extension-host test module, creates `manifest.json`, and appends results under
`trials/`. Re-run the same command after an interruption. The inputs must still match the manifest.

Generate the report after all 96 trials finish:

```bash
npm run comparison:report -- \
  --study /absolute/path/study-output \
  --out /absolute/path/openwrangler-data-wrangler-report.json
```

Before the full collection, run the first complete Pandas/CSV pair in a separate output directory:

```bash
npm run comparison:smoke -- \
  --candidate /absolute/path/openwrangler.vsix \
  --python /absolute/path/python3.12 \
  --editor /absolute/path/code \
  --editor-cli /absolute/path/code-cli \
  --csv /absolute/path/study-100k-x-50.csv \
  --parquet /absolute/path/study-1m-x-20.parquet \
  --out /absolute/path/smoke-output
```

This is two arms of one paired trial, not performance evidence. Delete its output after review and use a fresh
directory for the 96-trial collection.

## Review and publication

Before publishing results, a reviewer who did not write the runner checks:

- the four cells, schedule, boundaries, and timeouts against this document;
- exact versions and hashes in the manifest;
- 96 unique planned IDs and one retained outcome for every ID;
- type-7 median/p95 recalculation from raw trial files;
- paired differences and failure/timeout counts;
- the settle-window decision and highest observed absolute PSS calculation;
- every release-limit decision for both median and p95;
- the absence of private paths, source values, screenshots, logs, or proprietary package contents; and
- the wording of any performance claim against what the public UI evidence actually proves.

Record both the method review and final calculation review in
[`docs/performance/data-wrangler-1.2.1/review.md`](performance/data-wrangler-1.2.1/review.md).
