# Open Wrangler runtime tasks, September 14, 2026

These measurements cover fetching rows, filtering and sorting, profiling, and filling missing values
in DuckDB, PySpark Classic and native R. They use synthetic data with six columns: ID, nullable amount,
text, Boolean, date and timestamp. Pages contain 200 rows.

Values are milliseconds: **median [minimum, maximum]** of three calls after one separately recorded
warmup. Different call boundaries and hardware make these task examples unsuitable for engine rankings.
The hosted R profile uses sampled distributions at one million rows; numeric totals remain exact.

| Task                                               | Rows |         DuckDB |   PySpark Classic | Native R (hosted) |
| -------------------------------------------------- | ---: | -------------: | ----------------: | ----------------: |
| Fetch 200 rows from an open dataframe              | 100k |    31 [31, 32] |    143 [141, 164] |    510 [440, 724] |
| Fetch 200 rows from an open dataframe              |   1m |    45 [40, 48] |       91 [77, 99] |    369 [367, 370] |
| Filter amount ≥ 900, sort ID descending, fetch 200 | 100k |   92 [82, 105] |    121 [115, 149] |    392 [383, 568] |
| Filter amount ≥ 900, sort ID descending, fetch 200 |   1m | 409 [396, 422] |      97 [82, 102] |    404 [396, 460] |
| Profile amount                                     | 100k |    68 [67, 71] |    529 [432, 630] |    362 [336, 489] |
| Profile amount                                     |   1m | 463 [462, 476] | 1161 [1045, 1180] |    503 [482, 646] |
| Fill missing amount with zero: Preview + Apply     | 100k | 172 [171, 180] |       Unsupported | 1729 [1653, 2777] |
| Fill missing amount with zero: Preview + Apply     |   1m | 647 [625, 659] |       Unsupported | 2358 [2261, 2380] |

DuckDB times `SessionManager` calls after CSV opening. The page task opens one row first to avoid caching
the timed 200-row page; native queries still read the CSV. Spark times direct engine calls on an existing
uncached lazy frame. R times native `dispatch_json` on an open base data.frame, including response JSON
encoding. Setup and editor transport are excluded; R request encoding and response decoding are also
outside timing. These calls do not measure complete notebook or rendered UI workflows.

At one million rows, R samples up to 100,000 present values for distributions and omits exact distinct
count, median and top values. Counts and numeric totals remain exact. Timestamp storage also differs:
DuckDB is naive; Spark and R represent instants. The [collection procedure](method.md) describes the
fixture, concrete calls and boundaries.

The [Python source](https://github.com/Matt17BR/openwrangler/tree/85451b88224a3ecfc14e629f31de37bc43e00ab7/python/openwrangler_runtime)
used Python 3.12.14, DuckDB 1.5.5 and PySpark 4.2.0/Java 25.0.4 on an Intel Core Ultra 9 185H with 61 GiB
RAM. DuckDB retained 22 default threads; Spark used two. The
[R source](https://github.com/Matt17BR/openwrangler/tree/abe85a01233b7ede6a3b9e4da87e8e274f30f9ad/r/openwrangler_runtime)
ran R 4.5.3 on hosted Ubuntu 24.04, AMD EPYC 7763, four vCPUs and 15.6 GiB RAM. Data.table retained its
default two threads; that setting does not describe every R operation. Sizes ran 100,000 before one
million rows, so lower later timings do not establish scaling.

Source preservation, expected outputs and cleanup passed. DuckDB's complete live and generated Fill
results matched the oracle. R's generated frame matched completely; its live result passed page and
whole-column checks. [DuckDB raw samples](duckdb.json), [Spark raw samples](pyspark.json) and
[R raw samples](native-r.json) retain first observations and full precision. R originals are also attached
to [run 34842617355](https://github.com/Matt17BR/openwrangler/actions/runs/34842617355).
