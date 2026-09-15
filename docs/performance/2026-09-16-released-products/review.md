# Released dataframe viewers, September 16, 2026

Open Wrangler (OW) 2.5.0 and Microsoft Data Wrangler (DW) 1.24.2 rendered the prepared Pandas and Polars inputs
in all 24 fixed attempts. Incomplete measurements are identified below.

## Observations

Times are seconds: **median [minimum, maximum]**, rounded to 0.1 seconds. Each stage has three valid timings
unless n/3 marks fewer; the denominator is three planned workflows. Single observations appear alone.
[Raw samples](samples.json) retain stage timestamps and superseded records, which this table excludes.

| Input, rows        | Product |   Open (responsive) |     Profile display |        Drop preview |  Apply (responsive) |
| ------------------ | ------- | ------------------: | ------------------: | ------------------: | ------------------: |
| Pandas, 100k       | OW      |      0.7 [0.7, 0.8] |      0.2 [0.1, 0.2] |      0.3 [0.2, 0.3] |      0.3 [0.2, 0.3] |
| Pandas, 100k       | DW      |      0.4 [0.4, 0.5] |      0.1 [0.1, 0.1] | 1.3 [0.9, 1.8], 2/3 | 0.2 [0.2, 0.2], 2/3 |
| Polars, 100k       | OW      |      0.7 [0.7, 0.8] |      0.1 [0.1, 0.1] |      0.2 [0.2, 0.2] |      0.3 [0.3, 0.3] |
| Polars input, 100k | DW      |      0.4 [0.4, 0.5] |      0.1 [0.1, 0.1] |      1.0 [0.9, 1.4] |      0.2 [0.2, 0.3] |
| Pandas, 1M         | OW      |      0.8 [0.8, 1.0] |      0.8 [0.8, 0.9] |      0.6 [0.5, 0.9] |      1.0 [1.0, 1.0] |
| Pandas, 1M         | DW      |      0.5 [0.5, 0.9] |      0.2 [0.2, 0.3] |      1.0 [1.0, 1.1] |            0.5, 1/3 |
| Polars, 1M         | OW      | 0.8 [0.8, 0.8], 2/3 | 0.2 [0.2, 0.2], 2/3 | 0.3 [0.2, 0.3], 2/3 |            0.2, 1/3 |
| Polars input, 1M   | DW      |      0.5 [0.5, 0.5] |      0.2 [0.2, 0.2] |      1.1 [0.9, 1.4] | 0.3 [0.3, 0.3], 2/3 |

DW's second Pandas 100k Preview and three 1M Apply attempts did not reach their measured completion conditions
before the 60-second workflow budget expired.
Apply was unattempted after the Preview timeout. Two OW Polars 1M endpoints were invalid: scrolling changed a
positional locator after opening or Apply, although public DOM inspection confirmed the intended selection.
Earlier stages remain valid; missing times are not imputed or replaced.

## Machine, inputs and procedure

VS Code 1.137.0 ran on Ubuntu 26.04, Intel Core Ultra 9 185H, with isolated storage and private Xvfb at
1280 by 900 using software rendering.
Python 3.12.14 used Pandas 3.0.5, Polars 1.44.1 and PyArrow 25.0.1. Raw samples include hardware/artifact details.

The 100k/1M inputs reuse the [September 14 fixture formulas](../2026-09-14-everyday-tasks/method.md#fixture-and-timing).
Eager variables retain native types: Pandas uses naive microsecond datetimes; Polars has Date and naive
microsecond Datetime. Exact schemas and untimed preparation are recorded in the samples.

Both use Jupyter Variables' public viewer chooser. OW keeps Polars native; DW accepts the Polars variable but
reports Pandas 3.0.5. Opening includes any implicit conversion; its separate cost was not measured.

Run 100k before 1M, Pandas before Polars; product order is OW/DW, DW/OW, OW/DW. Open fresh viewers without
plans, retaining the editor/kernel and caches. Failures required untimed closure, source checks and pauses.

Time opening through correct dimensions, an unbusy grid and new row selection. Select `amount` and await its
completed profile. Time Drop missing Preview through expected result count and enabled native Apply;
time Apply through committed status and new row selection. Between observations, undo OW to zero steps/original
row count, return to Viewing and close; close DW's viewer.

A temporary controller times actions and polls every 100 ms, including scheduling overhead; this is not a hard
error bound. One 60-second budget covers the workflow. Stage intervals exclude form configuration;
installation, startup, validation, exports and cleanup are outside the workflow. Failed observations are not replaced.

## Verified work and limits

Paired input cells, order and native types matched independent formulas at both sizes and after collection.
Untimed exports, once per product/input/size, had 90,000 and 900,000 rows with matching logical values and order.
OW Polars preserved every dtype. DW's Polars-input Parquet export changed Date to midnight Datetime(ms);
other recorded dtypes matched.

DW's Pandas export omitted the index; OW offers preserve/omit, and preservation was selected and verified.
These export observations do not locate internal conversions or establish in-memory index loss.

Released OW [Pandas](https://github.com/Matt17BR/openwrangler/blob/6e1c40799e0ae2d88cb30efd8348af1f01e635aa/python/openwrangler_runtime/engines/pandas_engine.py#L1140)
and [Polars](https://github.com/Matt17BR/openwrangler/blob/6e1c40799e0ae2d88cb30efd8348af1f01e635aa/python/openwrangler_runtime/engines/polars_engine.py#L713)
use the full selected column for these summaries and histogram counts. Ten values and 20 bins bound output.
DW adds quartiles, skew and kurtosis; its scan scope is undisclosed. Profiles may be cached while other columns
still profile. Matching fixture values does not establish equal work.

Setup failures and initial samples remain recorded. A disabled Apply wrapper invalidated the initial cleaning
timings; the corrected collector checks the native button. Three observations cannot establish cold-start speed,
tail latency, scaling or a general ranking.

## Other Open Wrangler routes

These OW-only opening/profile observations use the same timing convention. They are not cross-engine rankings.

| Engine        | Rows | Open (responsive) | Profile display |
| ------------- | ---: | ----------------: | --------------: |
| DuckDB 1.5.5  | 100k |    1.5 [0.8, 1.6] |  0.2 [0.2, 0.2] |
| DuckDB 1.5.5  |   1M |    1.9 [0.9, 2.1] |  0.6 [0.5, 0.8] |
| R 4.5.2       | 100k |    0.7 [0.7, 0.7] |  0.7 [0.7, 0.7] |
| R 4.5.2       |   1M |    0.7 [0.7, 0.7] |  0.8 [0.8, 0.9] |
| PySpark 4.2.0 | 100k |    0.8 [0.8, 0.8] |  0.7 [0.6, 0.8] |
| PySpark 4.2.0 |   1M |    0.8 [0.7, 0.8] |  1.5 [1.5, 1.5] |

Native inputs were verified before timing. DuckDB uses an ordered CSV relation without materialization; timing
starts at its direct Variables action. Spark uses an uncached range on local[2], two partitions and a 1 GiB driver;
timing starts at the OW chooser action. Its grid has an unknown total; the selected column profile reports the full row count.

R uses **Run R Document in Open Wrangler**, a Preview route. Each invocation starts a new process and evaluates
the eager input before the timed dataframe-picker action; these are not overall document-launch times. At 1M,
distinct and median are unavailable, and the distribution is labelled sampled. R1M and Spark follow an editor restart.

[Earlier runtime tasks](../2026-09-14-everyday-tasks/review.md) have different call boundaries; R also used different
hardware. They remain historical context.
