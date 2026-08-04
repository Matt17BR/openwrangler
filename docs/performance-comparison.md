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
adds nulls and occasional numeric outliers. It writes 100,000-row groups with PyArrow and Zstandard compression, so
it never holds the complete fixture in memory.

The column names stay `c00` through `c99` because both products must receive the same simple schema. The fixture
manifest records the role and Arrow type of every column, plus its seed, file hash, size, compression settings, and
row-group layout. No user data is read.

Generation stops before writing if Linux reports less than 40 GiB of available memory or the output filesystem has
less than 15 GiB free. Those checks are intentionally conservative: the file is several gigabytes and a Pandas load
can require much more memory than the compressed source. The generator refuses to replace an existing file.

## What is measured

There are four groups: Pandas and Polars inputs in Open Wrangler and Data Wrangler. Each group has five repetitions.
Every repetition gets a new headless VS Code window, private profile, notebook, Python process, and Jupyter kernel.
That is 20 editor runs in total. A failed run is kept in the raw report and is not silently retried.

Each run records:

1. a native `read_parquet` in a separate new Python process;
2. Run Cell to a usable inline preview;
3. the viewer button to a usable, scrollable grid;
4. the profiling action to completed summaries for all 100 columns; and
5. the first, highest, and increase in process-tree PSS during the UI part of the run.

The native read is timed separately so disk and decoder work are not mixed into renderer time. The notebook kernel
then loads the same dataframe before the UI measurement. This matches the common case where a dataframe already
exists in a notebook and the user evaluates its name. Data Wrangler accepts a Polars input through its Pandas
conversion path; the report keeps that input labelled Polars so the conversion cost stays visible. Each load uses a
new Python process, but the test does not flush the operating-system file cache, so these are warm-source loads rather
than cold-disk timings.

The report gives the minimum, median, and maximum for each measurement. Five values are enough for a practical
manual comparison, but not for a useful p95, so the new report does not calculate one. It is a release review, not a
job in normal pull-request CI and not a scheduled task on a developer laptop.

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
with the same arguments. It resumes at the first missing result. Use `--limit 1` for a single-run check before the
full study; that result belongs in a separate output directory and is not part of the final comparison.

Generate the final report after all 20 runs finish:

```bash
npm run comparison:large:report -- \
  --study /absolute/path/benchmark-output \
  --out /absolute/path/openwrangler-data-wrangler-large-report.json
```

The report command writes the diagnostic result and then fails if any product/engine group lacks five successful
runs. Before publishing numbers, a second person should check the exact product, editor, Python, package, fixture,
and tool hashes and recalculate the four groups from the raw trials.

## Fast regression tests

`npm run benchmark:runtime` remains the regular performance gate. It uses the existing 100k × 50 CSV and 1M × 20
Parquet fixtures to catch runtime and paging regressions without generating the large comparison file. Pull requests
also run the small unit tests for the generator, schedule, result validation, and report calculations. They never
create the 10-million-row fixture or start the 20 editor runs.
