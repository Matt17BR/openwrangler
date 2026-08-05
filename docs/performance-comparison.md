# Open Wrangler and Data Wrangler performance test

This is a manual test of the notebook workflow in Open Wrangler and Microsoft Data Wrangler 1.24.2. It uses public
buttons and controls in a packaged VS Code installation. The test does not inspect or redistribute Data Wrangler.

The v1.2.1 test was useful for measuring a warm UI, but it was too small to say much about Pandas versus Polars. It
loaded the dataframe before timing and then reused the same window and kernel ten times. Small Pandas/Polars
differences in that report are normal run-to-run variation, not evidence that converting Polars to Pandas is free.
The [v1.2.1 review](performance/data-wrangler-1.2.1/review.md) remains available with the old method and raw outcome
counts.

## v1.2.3 study

The new test uses one synthetic 10,000,000 × 100 Parquet file. Its columns are split across floating-point and integer
data, low-cardinality categories, high-cardinality text, timestamps, dates, durations, and booleans. The generator
adds nulls and fixed profile markers. It writes 100,000-row groups with PyArrow and Zstandard compression, so
it never holds the complete fixture in memory.

The schema uses deterministic business-style names such as `net_revenue_usd`, `customer_segment`,
`account_display_name`, and `invoice_posted_at_utc`. Each column family has a known profile value: fixed numeric and
date bounds, a dominant category, a repeated text or two-day duration value, or both boolean values. The test waits
for those values in every profile instead of treating a generic column header as a completed summary. The rare
duration bounds stay in the fixture but are not used for readiness, because both products expose duration top values
rather than duration Min/Max statistics. The fixture manifest records the names and markers along with every column
type, the seed, file hash, size, compression settings, and row-group layout. No user data is read.

Generation stops before writing if Linux reports less than 40 GiB of available memory or the output filesystem has
less than 15 GiB free. The study repeats those checks immediately before every editor run and also requires the same
machine, AC power, and CPU governor used when the study began. A changed condition stops the command before another
run starts. These checks are conservative because a Pandas load can require much more memory than the compressed
source. The generator refuses to replace an existing file.

## What is measured

There are four groups: Pandas and Polars inputs in Open Wrangler and Data Wrangler. Each group has five repetitions.
Every repetition gets a new headless VS Code window, private profile, notebook, Python process, and Jupyter kernel.
That is 20 editor runs in total. A failed run still uses its assigned slot: it is kept in the raw report, is not
retried, and does not stop the remaining runs.

Each product run records:

1. Run Cell to a usable inline preview;
2. the viewer button to a usable, scrollable grid;
3. Run Cell to that usable grid, so input conversion and the complete launch path stay in one timing;
4. the profiling action to completed summaries for all 100 columns; and
5. peak process-tree PSS during the UI part of the run.

For each engine and repetition, one of the two product journeys is paired with a native `read_parquet` in a separate
Python process. That produces five Pandas reads and five Polars reads, or ten native reads in total. Those results are
grouped by engine, not attributed to either extension. The notebook kernel then loads the same dataframe before the UI
measurement, which matches the common case where a dataframe already exists and the user evaluates its name. Data
Wrangler accepts a Polars input through its Pandas conversion path. That conversion can happen between the inline and
launch milestones, so the Run Cell-to-grid measurement keeps the complete cost visible even if either shorter timing
cannot localize it. The native-load processes do not flush the operating-system file cache, so they measure a warm
source rather than cold-disk I/O.

The report gives the minimum, median, and maximum for each measurement. A run contributes to every measurement whose
end point it reached, so a later profiling timeout does not throw away a valid inline or grid time. A usable
comparison requires all 20 assigned runs to have been attempted, at least four complete runs in each five-run UI
group, and at least four of the five native loads for each engine. There are no replacement runs. Any failure needs a
written explanation and a second-person check before numbers are published. The detailed report keeps those
failures; a short README table may show the usable summaries without repeating the diagnostics.

Five values are enough for a practical manual comparison but not for a useful p95, so the report does not calculate
one. It is a release review, not a job in normal pull-request CI and not a scheduled task on a developer laptop.

The large run's hard editor limit is calculated from both pre-action deadlines, the inline, workbench, and profiling
deadlines, and another two minutes for editor startup and cleanup. With the current stage limits, that is 1,260
seconds. Completing each column writes a progress checkpoint; three minutes without a checkpoint still stops the
run. Normal editor acceptance tests keep their 300-second hard limit.

## Run the study

Create an empty directory on a filesystem with enough free space. Generate the fixture only when the machine is idle
and connected to power:

```bash
npm run comparison:large:fixture -- \
  --out /absolute/path/openwrangler-10m-100.parquet \
  --confirm-large-study
```

Build the candidate VSIX, then start the editor runs. The fixture and output directory must be on the same filesystem;
the runner uses read-only hard links instead of making twenty multi-gigabyte copies.

```bash
npm run comparison:large:study -- \
  --candidate /absolute/path/openwrangler.vsix \
  --python /absolute/path/python3.12 \
  --editor /absolute/path/code \
  --editor-cli /absolute/path/code-cli \
  --parquet /absolute/path/openwrangler-10m-100.parquet \
  --out /absolute/path/benchmark-output \
  --confirm-large-study
```

The command writes one result after each editor closes. If the machine sleeps or the command is stopped, run it again
with the same arguments. It removes the abandoned private trial directory, checks the fixture again, and resumes at
the first missing result. Use `--limit 1` for a single-run check before the full study; that result belongs in a
separate output directory and is not part of the final comparison.

Generate the final report after all 20 runs finish:

```bash
npm run comparison:large:report -- \
  --study /absolute/path/benchmark-output \
  --out /absolute/path/openwrangler-data-wrangler-large-report.json
```

The report command writes the detailed result and then checks the minimum counts above. Before publishing numbers, a
second person should explain every failed run, check the exact product, editor, Python, package, fixture, and tool
hashes, verify that product order alternates within each engine, recalculate the four UI groups, and recalculate the
two five-load engine-only groups from the raw trials.

## Fast regression tests

`npm run benchmark:runtime` remains the regular performance gate. It uses the existing 100k × 50 CSV and 1M × 20
Parquet fixtures to catch runtime and paging regressions without generating the large comparison file. Pull requests
also run the small unit tests for the generator, schedule, result validation, and report calculations. They never
create the 10-million-row fixture or start the 20 editor runs.
