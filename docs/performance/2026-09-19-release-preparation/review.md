# Opening files and native R profiles

Local measurements of Open Wrangler's 2.6 development package in desktop VS Code on September 19, 2026.
The measured package comes from source `8ed1a631d94ff17475a3264757b7904715f14210`, with VSIX SHA-256
`2b1292d5c682137fe71ba3c9f4c95df39e8a5645fa7c85b0a3ec7e59eb275395`.
It is a development VSIX, not a qualified release candidate. These observations do not qualify publication.

The [previous report's synthetic fixtures](../2026-09-17-release-preparation/review.md#environment-and-input-data)
contain 100,000 or one million rows and six columns. The current observations keep its public interaction boundaries.
Individual records identify the input hashes, fixed observation order, versions, power conditions and cleanup.

## CSV files

All six active validations and all 18 fixed observations passed. The table shows medians of three fixed observations
per route and size. All fixed attempts are retained; none was replaced. [Individual records and ranges](file-samples.json)
also include the earlier grid-visibility endpoint and subsequent column-switch check.

|      Rows | Route                 | Responsive grid | Three header profiles | Amount profile |
| --------: | :-------------------- | --------------: | --------------------: | -------------: |
|   100,000 | Open Wrangler, Pandas |          2.62 s |                2.61 s |         3.02 s |
|   100,000 | Open Wrangler, Polars |          1.85 s |                1.83 s |         2.24 s |
|   100,000 | Data Wrangler         |          3.57 s |                3.56 s |         4.02 s |
| 1 million | Open Wrangler, Pandas |          3.38 s |                3.36 s |         3.73 s |
| 1 million | Open Wrangler, Polars |          1.83 s |                2.53 s |         2.38 s |
| 1 million | Data Wrangler         |          4.11 s |                4.71 s |         4.60 s |

All three endpoints start immediately before submitting the selected file path, the final **Open** action.
Responsive grid ends after a new selection of ID 1 responds. The three header profiles are `id`, `amount` and
`category`, with checked counts, ranges and completed distributions. Amount profile ends when expected statistics
are available in the rendered selected-column summary, including any panel reveal or bottom-panel closing during
that interval. At 1280 by 900, some Data Wrangler statistics require scrolling; scrolling to those lower statistics
is excluded from this endpoint. The three measured header profiles are fully visible.
Amount can finish before all three headers. Profiles may compute during opening; these are display-availability
measurements. Other columns may still be profiling. See the [retained endpoint method](../2026-09-17-release-preparation/review.md#opening-csv-files-and-seeing-their-profiles).

Both Open Wrangler routes had lower medians at these endpoints than Data Wrangler in this cohort. The work differs:
Data Wrangler also displays quartiles, kurtosis and skew. Matching statistics on this periodic fixture do not prove
identical scan scope. Each observation used a fresh editor with the prepared profile; source hash checks warmed
file caches. Prior command and file-selection preparation was untimed. Fresh editor startup does not establish that
all runtime preparation begins after the Open clock or that storage is cold.

The first Data Wrangler 100,000-row validation exhausted its 60-second limit at **Select a runtime**. Its fresh
profile had not completed untimed runtime selection; this was not a grid result or evidence of a runtime defect.
No fixed sample had started. Public setup then selected Python 3.12.14 and confirmed Pandas 3.0.5 in a loaded
six-column file, including an untimed Data Wrangler opening. A separately named corrected validation passed.
The original failure and natural cleanup remain in the records: seven validation attempts, six active successes.
The collector and deadlines were unchanged. The file cohort ran on AC while charging from 42% to 51%, with
`powersave` and the `power` energy performance preference. All editors exited normally with code zero, no forced
cleanup or remaining owned processes; every measured source and the VSIX remained unchanged.

## Base R managed documents

Both validations and all six fixed observations completed. Medians below use the three original fixed observations
at each size; no attempt was replaced. [Individual R observations and ranges](r-samples.json) retain both endpoints.

|      Rows | Open through row selection | Select amount through profile display |
| --------: | -------------------------: | ------------------------------------: |
|   100,000 |                     1.39 s |                                1.35 s |
| 1 million |                     1.44 s |                                1.46 s |

Before each observation, **Run R Document** started a fresh R process, loaded the CSV and checked all six columns.
Opening starts at the `r_frame` picker choice and ends when selecting ID 1 responds. That interval excludes document
execution, CSV parsing and native input validation. The second interval includes selecting `amount` and revealing
its column profile, with the expected counts, numeric statistics and completed 20-bin distribution. The million-row
column profile does not report a median statistic. Statistics can compute during opening, so the second interval
measures display availability, not isolated profile computation. See the [retained method](../2026-09-17-release-preparation/review.md#opening-native-duckdb-r-and-spark-frames).

The selected-profile medians are longer than the previous R cohort's 1.05 and 0.94 seconds. Source and power
conditions changed between cohorts; this observation does not isolate a product regression or establish a speedup.
The current R cohort ran on AC while charging from 37% to 40%, with the `powersave` governor and `power` energy
performance preference. The previous R cohort ran on battery with `balance_power`.

No measured R attempt failed. During untimed setup, Escape left the Workspace Trust modal open and a sidebar click
timed out against it. Closing the named modal editor through its public button resolved that setup obstruction
before validation began. Public tab closure and **File > Exit** completed normally. The editor exited with code zero,
without forced cleanup or remaining owned processes; measured source files and the VSIX were unchanged.

This managed-document route does not exercise managed-file profile continuation or filter-membership reuse.
The separate large-file investigation and its correction are recorded in
[#1616](https://github.com/Matt17BR/openwrangler/issues/1616) and
[#1625](https://github.com/Matt17BR/openwrangler/pull/1625). Its private-input controls are not part of this public comparison.

## Earlier cohorts remain separate

The [paired Python notebook and cleaning results](../2026-09-17-release-preparation/review.md#opening-and-cleaning-notebook-dataframes)
and [DuckDB/Spark observations](../2026-09-17-release-preparation/review.md#opening-native-duckdb-r-and-spark-frames)
remain attributed to source `7a72f24fb019eed9d55673e1f53b870dc7ede12d`. They have not been refreshed here.
Their original failures, output differences, power conditions and raw observations remain in that report and its
[notebook records](../2026-09-17-release-preparation/notebook-samples.json).
The [earlier CSV-reader measurement](../2026-09-17-release-preparation/review.md#native-r-file-loading-cost) also keeps
its original source attribution and scope. None of those timings contributes to the tables in this report.

## Environment and interpretation

The host was Ubuntu 26.04.1 LTS on an Intel Core Ultra 9 185H with about 61 GiB RAM, running VS Code 1.137.0
(`645f29cc3176500b4b5762ba887cf2a7f0ffdf2c`) in a private 1280 by 900 software-rendered display.
The file cohort used Python 3.12.14, Pandas 3.0.5, Polars 1.44.1, PyArrow 25.0.1 and Data Wrangler 1.24.2.
The R route used R 4.5.2, jsonlite 2.0.0, rlang 1.3.0, Arrow 25.0.0 and clock 0.7.4; the raw records include other
installed native package versions. Installation and Workspace Trust were untimed. Microsoft extension package
contents were not inspected.

These narrow, periodic fixtures do not establish performance on wide tables, complex strings, different value
distributions or cold storage. The 100 ms polling interval is not an accuracy bound. Three observations per route
cannot establish tail latency or scaling. Read each endpoint with its setup, work and power conditions rather than
treating the figures as a general engine ranking.
