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

Warm trials load `study_frame` in an untimed setup cell. The measured cell only renders the resident variable. Cold
trials load and render the file in the measured cell. Warm setup and measured cells have separate exact tags:

```text
ow-comparison-setup:<cell-id>
ow-comparison-cell:<cell-id>
```

The neutral host uses that tag and the requested variable name. It does not use whichever notebook or editor happens
to be active.

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

| Boundary           | Deadline |
| ------------------ | -------: |
| Inline preview     |     45 s |
| Workbench open     |     60 s |
| Complete profile   |    135 s |
| Whole driver phase |    300 s |

A product error or UI deadline is a trial outcome. Keep it in the report. Harness/setup failures are also recorded,
but they must be fixed before the study can support a release claim. There is no outlier trimming, automatic retry,
or replacement run after a product action.

## Memory

On Linux, the parent launcher samples proportional set size (PSS) for the owned editor process and its descendants at
200 ms intervals. `/proc/<pid>/stat` start times guard against PID reuse. The sampler reads `smaps_rollup` only for
the root and descendants it has identified.

For each successful trial, report:

- median PSS immediately before the **Run Cell** action;
- peak absolute PSS between **Run Cell** and final profiling; and
- baseline-adjusted peak PSS (`peak - baseline`, floored at zero).

PSS is a process-tree measure and includes the editor, extension host, renderer, kernel, and Open Wrangler runtime when
present. It is not an allocation profile of either extension. Each result retains only the bounded, path-free
timestamp/PSS/process-count series needed to recalculate the summary; it never retains PIDs or process arguments.

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
- absolute and adjusted PSS calculations;
- the absence of private paths, source values, screenshots, logs, or proprietary package contents; and
- the wording of any performance claim against what the public UI evidence actually proves.

Record both the method review and final calculation review in
[`docs/performance/data-wrangler-1.2.1/review.md`](performance/data-wrangler-1.2.1/review.md).
