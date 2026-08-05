# Open Wrangler and Data Wrangler performance test

This is a manual test of the notebook workflow in Open Wrangler and Microsoft Data Wrangler 1.24.2. It uses public
buttons and controls in a packaged VS Code installation. The test does not inspect or redistribute Data Wrangler.

The v1.2.1 test was useful for measuring a warm UI, but it was too small to say much about Pandas versus Polars. It
loaded the dataframe before timing and then reused the same window and kernel ten times. Small differences between
Pandas and Polars inputs in that report are normal run-to-run variation; they do not show how Data Wrangler handles a
Polars input. The [v1.2.1 review](performance/data-wrangler-1.2.1/review.md) remains available with the old method and
raw outcome counts.

## v1.2.3 study

The new test uses one synthetic 1,000,000 × 100 Parquet file. Its columns are split across floating-point and integer
data, low-cardinality categories, high-cardinality text, timestamps, dates, durations, and booleans. The generator
adds nulls and fixed profile markers. It writes 100,000-row groups with PyArrow and Zstandard compression, so
it never holds the complete fixture in memory.

The schema uses deterministic business-style names such as `net_revenue_usd`, `customer_segment`,
`account_display_name`, and `invoice_posted_at_utc`. Each column family has a known profile value: fixed numeric and
date bounds, a dominant category, a repeated text or two-day duration value, or both boolean values. The test waits
for those values in every profile instead of treating a generic column header as a completed summary. The rare
duration bounds stay in the fixture but are not used for readiness, because both products expose duration top values
rather than duration Min/Max statistics. The fixture manifest records the names and markers along with every column
type, the seed, file hash, actual byte size, compression settings, and row-group layout. The full generator rejects a
compressed result smaller than 400 MiB, so a highly compressible accidental fixture cannot enter the study. No user
data is read.

A 100,000 × 100 sizing run with the same generator produced a 50,381,441-byte Parquet file. A later 2,000,000-row
fixture was 1,007,388,294 bytes. With Python 3.14.4, the
Pandas 3.0.3 read call took 0.085 seconds (0.36 seconds for the process) and reached 523,088 KiB peak RSS; its
import-only process reached 108,336 KiB. The Polars 1.42.1 read call took 0.112 seconds (0.21 seconds for the process)
and reached 204,600 KiB peak RSS; its import-only process reached 39,884 KiB. Scaling the file bytes and RSS above the
import baseline by 10 puts the 1-million-row file near 480 MiB, with about 4.1 GiB peak RSS for Pandas and 1.6 GiB for
Polars. The 400 MiB floor leaves room for normal variation while still catching an accidentally compressible file.
These sizing runs chose the fixture size; they are not part of the product comparison.

Generation and every editor run require at least 36 GiB of currently available memory. This is a conservative guard
for running the study on a local workstation. The runner stops before launching an editor when the machine falls
below that floor instead of relying on swap. Generation also requires 6 GiB of free disk space, and it keeps the
finished fixture only if at least 4 GiB remains. A machine with a battery must
be on AC power. A battery-less host records `not-applicable`. A host without a cpufreq governor records `not-exposed`.
The runner checks the recorded machine, power, governor, memory, and disk both before and after every editor run. The
generator refuses to replace an existing file.

## What is measured

There are four groups: Pandas and Polars inputs in Open Wrangler and Data Wrangler. Each group has five repetitions.
Every repetition gets a new headless VS Code window, private profile, notebook, Python process, and Jupyter kernel.
That is 20 editor runs in total. A failed run still uses its assigned slot: it is kept in the raw report, is not
retried, and does not stop the remaining runs.

Each product run records:

1. Run Cell to a usable inline preview;
2. the viewer button to a usable, scrollable grid;
3. Run Cell to that usable grid, the only timing that spans all work between cell evaluation and grid readiness;
4. opening the column-summary UI, visiting all 100 columns, and verifying each visible summary; and
5. peak process-tree PSS during the UI part of the run.

The notebook setup cell loads the dataframe with Pandas or Polars before the UI measurement, which matches the common
case where a dataframe already exists and the user evaluates its name. The study does not inspect or isolate how Data
Wrangler handles a Polars input. Only Run Cell-to-grid spans the complete measured path and can include any conversion
performed before the grid is ready; it is not a conversion-only measurement. The inline and launch-action timings
cover narrower UI intervals.

The report gives the minimum, median, and maximum only when all five runs in a group finish. A group with four
successful runs is marked inconclusive, while its raw runs and any timings recorded before a failure stay in the
detailed report. The report still requires all 20 assigned runs to have been attempted, at least four complete runs
in each five-run UI group, and no replacement runs. Any failure needs a written explanation and a second person's
review before results are published. A short README table may show figures only for groups that finished five out of
five runs.

Five values are enough for a practical manual comparison but not for a useful p95, so the report does not calculate
one. It is a release review, not a job in normal pull-request CI and not a scheduled task on a developer laptop.

The large run's hard editor limit is calculated from both pre-action deadlines, the inline, workbench, and profiling
deadlines, and another two minutes for editor startup and cleanup. With the current stage limits, that is 1,260
seconds. Completing each column writes a progress checkpoint; three minutes without a checkpoint still stops the
run. Normal editor acceptance tests keep their 300-second hard limit.

## Run the study

Create an empty directory on a filesystem with enough free space. Generate the fixture only when the machine is idle;
connect a laptop to power first:

```bash
npm run comparison:large:fixture -- \
  --out /absolute/path/openwrangler-1m-100.parquet \
  --confirm-large-study
```

Build the candidate VSIX, then start the editor runs. The fixture and output directory must be on the same filesystem;
the runner uses read-only hard links instead of making twenty copies.

```bash
npm run comparison:large:study -- \
  --candidate /absolute/path/openwrangler.vsix \
  --python /absolute/path/python3.12 \
  --editor /absolute/path/code \
  --editor-cli /absolute/path/code-cli \
  --parquet /absolute/path/openwrangler-1m-100.parquet \
  --out /absolute/path/benchmark-output \
  --confirm-large-study
```

The command writes one result after each editor closes. If the machine sleeps or the command stops, run it again
with the same arguments. It removes the abandoned private trial directory, checks the fixture again, and resumes at
the first missing result. Start the final output with `--limit 1` and check that run's memory use before continuing.
Then use `--limit 3` to cover the other product and input combinations. Review those four grids and profile markers
before resuming the same output without `--limit`.

Generate the final report after all 20 runs finish:

```bash
npm run comparison:large:report -- \
  --study /absolute/path/benchmark-output \
  --out /absolute/path/openwrangler-data-wrangler-large-report.json
```

The report command first rejects results that do not match their scheduled product, input type, order, shape, timings,
or memory samples. It writes the detailed result and then checks the minimum counts above. Before publishing numbers,
a second person should explain every failed run and recalculate each five-out-of-five UI group from the raw results.
Four successful runs leave that group inconclusive. Record the commit used to build the candidate beside its SHA-256;
it must be the current protected `main` commit. The reviewer also checks the product, editor, Python, package, fixture
hash and actual byte size, tool hashes, and alternating product order within each input type.

## Fast regression tests

`npm run benchmark:runtime` remains the regular performance gate. It uses the existing 100k × 50 CSV and 1M × 20
Parquet fixtures to catch runtime and paging regressions without generating the large comparison file. Pull requests
also run the small unit tests for the generator, schedule, result validation, and report calculations. They never
create the 1-million-row fixture or start the 20 editor runs.
