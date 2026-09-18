# Opening data, column profiles and cleaning

Local measurements of Open Wrangler's 2.6 development package and Microsoft Data Wrangler 1.24.2 in VS Code.
The CSV, paired Python notebook, DuckDB and Spark observations use the September 18 package from source
`7a72f24fb019eed9d55673e1f53b870dc7ede12d`, including
[PR #1599](https://github.com/Matt17BR/openwrangler/pull/1599). Its production source matches `231ed139`; the two
intervening differences are tests. The Base R rows were refreshed with `2796cc745d69f1cbaa2836ac5640bc17887cdc3a`
after the native R timestamp-display and process-bootstrap corrections.
The linked raw records identify each package checksum and retain earlier cohorts. These measurements precede release
qualification.

## Opening CSV files and seeing their profiles

Open Wrangler with Polars had the lowest median times in these file observations. A million-row CSV responded to
selection in 1.8 seconds with Polars, 3.5 seconds with Open Wrangler's Pandas engine and 4.2 seconds in Data Wrangler.
These are three observations per route and size on one laptop, not a general speed ranking.

| Visible result           |      Rows | Open Wrangler, Pandas | Open Wrangler, Polars | Data Wrangler |
| ------------------------ | --------: | --------------------: | --------------------: | ------------: |
| Responsive grid          |   100,000 |                 2.5 s |                 1.9 s |         3.7 s |
| Three column profiles    |   100,000 |                 2.5 s |                 1.9 s |         3.7 s |
| Amount column statistics |   100,000 |                 2.9 s |                 2.3 s |         4.2 s |
| Responsive grid          | 1 million |                 3.5 s |                 1.8 s |         4.2 s |
| Three column profiles    | 1 million |                 3.5 s |                 2.6 s |         4.5 s |
| Amount column statistics | 1 million |                 3.9 s |                 2.4 s |         4.7 s |

All six validations and 18 fixed attempts completed; none of the fixed attempts were replaced. Only the fixed attempts
contribute to the table. Every table row starts at the same final **Open** action.
The three header profiles are `id`, `amount` and `category`, with completed counts, numeric ranges and distributions.
Other headers can still be profiling. Selecting `amount` by its name and showing its native profile panel are included.
A selected profile can finish before all three header profiles. Statistics below a panel's fold require scrolling to
read; completion does not mean every statistic is simultaneously on screen.

Every attempt opened its first file in a fresh VS Code process. Installation, Trust and interpreter selection were
already complete. Backend settings were set before launch, and reading the CSV bytes before Open warmed the file
cache. Editor startup, file-dialog preparation and shutdown are excluded. No explicit runtime warmup was performed,
but the public observer cannot determine whether a product begins runtime preparation before final Open.

The [individual measurements](file-samples.json) retain times, ranges, input checks and the fixed product order.
All source-file and package checks passed, and every measured editor exited naturally without owned processes remaining.
The laptop was on AC, charging from 36% to 40%, with energy performance preference set to `power`. The earlier
September 18 file cohort ran on battery, and September 17 power conditions were not recorded. These observations do
not establish a controlled change in performance between cohorts. The earlier
[September 16 report](../2026-09-16-released-products/review.md) also used a different, warm-editor lifecycle.

<details>
<summary>File setup failures and measurement limits</summary>

The raw records retain both earlier complete file cohorts, the selective Pandas refresh and the old-package
diagnostic separately. The selective September 18 refresh and a single observation of the older package took longer
than the September 17 results. That diagnostic does not isolate the cause or establish whether a product regression
exists. The complete table above measures all three routes with the final integrated product under the recorded host
conditions; none of the earlier observations contributes to it.

During September 17 setup, one correctly selected Data Wrangler viewer remained at **Connecting to runtime** until the
60-second limit. Its cause remains unestablished. Another validation was interrupted before a result was recorded;
the signal's origin is unknown. Neither was replaced inside the fixed series or counted as a latency value.

Other excluded validations exposed collector errors: selecting a hidden old viewer, closing already-closed tabs,
changing the engine setting after editor startup, and failing to activate VS Code's Exit menu. The corrected observer
requires one newly selected viewer, checks the actual engine, sets configuration before launch and uses native keyboard
navigation to quit. Original validation and shutdown failures remain with their historical cohort.

These are display-availability observations. Profiles can compute during opening, and actionability waits can delay
when the observer notices a result. The 100 ms poll interval is not an accuracy bound. Data Wrangler exposes quartiles,
skew and kurtosis that are absent from Open Wrangler's summary. Matching values on this periodic fixture does not prove
equal computation or reveal Data Wrangler's scan scope. A return to an already viewed column measures cached display
availability; those intervals remain in the raw records and are not used to rank fresh profiling work.

</details>

## Opening and cleaning notebook dataframes

Data Wrangler opened the already-loaded notebook frames sooner in this collection. Open Wrangler completed all
12 fixed cleaning attempts; Data Wrangler completed 7 of 12. At one million rows, where all attempts completed, the Pandas
cleaning median was slightly slower in Open Wrangler and the Polars-input cleaning median was faster.

| Input  |      Rows | Open Wrangler open | Data Wrangler open | Open Wrangler cleaning |    Data Wrangler cleaning |
| ------ | --------: | -----------------: | -----------------: | ---------------------: | ------------------------: |
| Pandas |   100,000 |              1.8 s |              1.1 s |            1.0 s (3/3) |               2.0 s (1/3) |
| Polars |   100,000 |              1.8 s |              1.2 s |            1.0 s (3/3) | No completed result (0/3) |
| Pandas | 1 million |              1.8 s |              1.1 s |            2.2 s (3/3) |               2.0 s (3/3) |
| Polars | 1 million |              1.9 s |              1.5 s |            1.1 s (3/3) |               2.1 s (3/3) |

Opening ends when selecting a new row responds. All three opening endpoints completed in every table row. Cleaning
removes rows with missing `amount`, leaving 90,000 or 900,000 rows. Its clock runs continuously from requesting Preview
until the applied result responds to selection; choosing the operation and filling its form are excluded. Parentheses
show completed cleaning attempts out of the three planned. Values are medians of completed endpoints, except the
single Data Wrangler 100,000-row Pandas result. A missing endpoint is a failure, not a latency value. No attempt was replaced.

All five fixed failures occurred in Data Wrangler's 100,000-row cases: the first two Pandas attempts and all three
Polars attempts. Both corresponding validations also timed out. Each reached Apply, then remained at **Previewing**
with Apply and Discard disabled until the original 60-second workflow limit. The cause is unestablished. All four
Open Wrangler validations and both million-row Data Wrangler validations completed. The failure rate limits what the
completed cleaning times can tell us about the overall experience.

The notebook, kernel and source frames were resident before each attempt, so opening excludes CSV parsing. Open
Wrangler used each input's native engine. Data Wrangler accepted both input types and reported Pandas 3.0.5 in the
recorded public status bars. Any work after the product choice remains inside the opening clock. These observations
do not locate internal conversions.

Seven untimed cleaned exports matched every expected value, null and row order. No Data Wrangler Polars export at
100,000 rows was available because its validation and all three original fixed attempts failed. The Data Wrangler
Pandas export at that size came from original fixed attempt 3 after timing. The other six exports reused successful
validations. Open Wrangler's Pandas export preserved the index using its explicit option; Data Wrangler omitted it.
Open Wrangler preserved native Polars types; Data Wrangler's million-row Polars-input export changed Date to midnight
Datetime(ms). These are export-boundary observations. Both original frames passed full native checks before and after
collection at each size. The [individual records and ranges](notebook-samples.json) include checks, schemas and origins.
The checks ran before suspension; their records remain available, but the temporary export files no longer do.

The laptop began this session on battery at 6%, with AC disconnected and energy performance preference set to `power`.
Power conditions differ between collections, so changes in absolute times do not isolate a code effect. Public notebook
closure and **File > Exit** preceded wrapper cleanup. No owned processes remained, and source-file and package hashes
were unchanged. The wrapper's unconditional `editorForcedCleanup: true` flag does not establish an abnormal exit.

<details>
<summary>Earlier notebook collections and observation limits</summary>

The September 17 cohort, the interrupted September 18 refresh and a later setup-only attempt remain separate in the
individual records. None contributes to the table above. The September 17 cohort completed 23 of 24 cleaning attempts;
one Data Wrangler million-row Polars Apply endpoint timed out. Its eight exports passed native checks. An excluded
Open Wrangler validation revealed implicit pointer scrolling beneath a sticky header, so the observer was corrected
before that cohort's million-row fixed attempts. The retained records identify both collector versions.

The interrupted `87870b0f` refresh first reached the correct Open Wrangler 90,000-row applied result but timed out on
its final selection. A later click and an instrumented diagnostic succeeded; neither establishes the original cause.
A separate DOM control demonstrated stale-coordinate targeting. The amended observer used bounded no-scroll pointer
actions while preserving the cell identity assertion and the 60-second workflow limit. It retained 12 fixed 100,000-row
attempts, six validations and six verified exports before an independent App/DataGrid test reproduced the selection
restore defect in [#1598](https://github.com/Matt17BR/openwrangler/issues/1598). The defect justified stopping and
correcting the product, but does not establish the original installed timeout's cause. Unstarted attempts remain
identified as unstarted; the partial cohort has no comparison medians.

A subsequent `fa9611f1` setup stopped with Jupyter Variables showing **Loading variables** before any validation or
fixed measurement. Trust, Open Wrangler kernel access and native input checks had passed. The cause remains unknown.
The corrected-source collection above started separately after both product permissions and untimed initial openings
completed; it did not replace any historical attempt.

Selected-column profile intervals measure an interaction to display, possibly using statistics computed during
opening. They remain in the raw records and do not isolate fresh computation. The 100 ms poll interval is not an
accuracy bound. Products expose different statistics and may perform different work. Three observations per route
on one laptop do not establish tail latency, scaling or a general speed ranking.

</details>

## Opening native DuckDB, R and Spark frames

DuckDB and Spark retain four validations and 12 fixed observations from the earlier package. R was refreshed after
the final native changes, completing both validations and all six fixed observations. Each table entry is the median
of three original fixed attempts. Every attempt reached a responsive grid and the required amount profile; none was
replaced. These routes have different setup and execution costs, so the table does not rank engines.

| Open Wrangler route      |      Rows | Open through row selection | Select amount through profile display |
| ------------------------ | --------: | -------------------------: | ------------------------------------: |
| DuckDB notebook relation |   100,000 |                     2.64 s |                                0.37 s |
| DuckDB notebook relation | 1 million |                     2.91 s |                                0.37 s |
| Base R managed document  |   100,000 |                     1.44 s |                                1.05 s |
| Base R managed document  | 1 million |                     1.86 s |                                0.94 s |
| Local PySpark notebook   |   100,000 |                     1.72 s |                                1.53 s |
| Local PySpark notebook   | 1 million |                     1.71 s |                                2.88 s |

Opening ends after a pointer action selects ID 1 in the visible six-column grid. The selected amount profile must
show the expected row, null and NaN counts, 900 distinct present values, numeric statistics and a completed 20-bin
distribution. R correctly reports the million-row median as unavailable. Spark can display the initial grid before
the total row count is known; its profile endpoint requires the exact count. The second interval includes selecting
`amount` and revealing its panel. Statistics may already have computed during opening, so it does not measure fresh
profiling work. [Individual observations and ranges](notebook-samples.json) retain both endpoints.

- DuckDB used an uncached, ordered CSV relation in its original notebook connection. Timing began at Jupyter
  Variables' **Show variable snapshot in data viewer** button and included choosing `_duck_connection`. Native input
  checks had already read the CSV; relation evaluation and capture after that button action remained timed.
- Base R used a managed document. Before each observation, **Run R Document** started a fresh R process, loaded the
  CSV and checked all six columns. Timing began at the `r_frame` picker choice, excluding that setup and CSV parsing.
- Spark used an uncached lazy range with matching values, two local worker threads, two partitions, UTC and a 1 GiB
  driver setting. Timing began at **Open in Open Wrangler** in the viewer chooser. Session startup and native setup
  checks were excluded; the route did not parse a CSV. Engine work after that choice remained timed.

DuckDB and Spark setup checked the six-column formulas and native types. Their final checks repeated only row count
and amount sum before closing the owned connection or session. R checked all values, nulls, order and types before
each opening. Original CSV files, R documents and helper bytes were unchanged, as were the source cells in the
retained executed notebooks. These checks do not establish a final all-cell comparison of every native in-memory
frame. The separate Pandas/Polars comparison above performed that stronger before-and-after check.

The DuckDB/Spark collection ran on AC while charging from 22% to 34%, with energy performance preference `power`.
The final R refresh ran on battery from 69% to 68%, with AC disconnected, preference `balance_power` and the `powersave`
governor. Its power conditions, R dependencies and source differ from earlier collections. These observations do not
establish a controlled speedup or regression.
Both collections used private editor lifecycles separate from the paired Python notebooks. Public tab closure and
**File > Exit** preceded cleanup; exits were zero, no owned processes remained, and source files and packages were
unchanged. The final R editor needed no forced cleanup.

<details>
<summary>Earlier native correction and failures retained</summary>

The complete `21630ef0` R cohort remains separate in the raw records. Its medians were 1.08 and 1.09 seconds through
selection, and 0.45 and 0.58 seconds through the selected profile, at 100,000 and one million rows respectively.
It ran on AC at 99% with `balance_performance`. A later `a1ec175e` preparation stopped after a process-bootstrap
portability failure was reproduced, before any of its two validations or six fixed measurements started.

The complete earlier `7a72f24f` native cohort remains in the raw records. Its Base R medians were 1.91 and 1.92 seconds
through selection at 100,000 and one million rows, and 0.98 seconds through the selected profile at both sizes. Those
R observations no longer contribute to the table above; the DuckDB and Spark observations remain current.

The September 17 R million-row validation reached a responsive grid but exhausted its 60-second budget while the
selected profile remained unavailable. Its visible warning was **R kernel summary 0 has inconsistent value counts**.
The host rejected a valid large-profile representation with bounded exact distinct counts and omitted top values.
[The correction](https://github.com/Matt17BR/openwrangler/pull/1582) also repaired the required numeric object for
profiles without finite values. The original failed validation remains recorded. Continued R CPU use observed during
that earlier incident is still unexplained; successful corrected observations do not establish its cause.

The earlier corrected `87870b0f` package passed the million-row validation and three fixed observations. Their
medians were 1.80 seconds through responsive selection and 1.16 seconds from selecting amount through profile display.
Two nonfinite controls with 4 and 120,002 rows also showed the correct null and NaN counts, unavailable finite statistics
and no distribution. Each contained one null, one NaN and otherwise infinities. The UI does not expose a separate
infinity count. This correction series remains unchanged in the raw records and contributes nothing to the current table.

A separate September 17 DuckDB million-row fixed attempt also exceeded 60 seconds: its grid was visible, but the
requested row selection was not observed. A subsequent public click selected the same visible row promptly. That
diagnostic click is not a replacement measurement, and the original failure remains recorded with its cause unknown.
Neither native failure is pooled into the corrected R series or any table above.

</details>

## Native R file-loading cost

In a separate source-level check, Open Wrangler's native R reader loaded a 3-million-row, six-column UTF-8 CSV
(164.1 MB) in 17.9 seconds. The R 4.5.2 process reached 736 MiB peak resident memory. This was one observation with
the OS cache warmed by source hashing. Timing covered the reader call, excluding process startup, runtime loading,
initial garbage collection, frame admission, profiles, UI and result serialization or comparison. Memory includes
process setup through loading. The [reader record](r-csv-load.json) measures eager loading cost, not file-opening
latency or a demonstrated speedup. It uses source `3dee1310`; the measured CSV reader implementation is unchanged
by the later native R updates.

## Environment and input data

Measurements were collected on September 17 and 18, 2026, using VS Code 1.137.0 on Ubuntu 26.04.1, an Intel Core Ultra 9 185H
and about 61 GiB of RAM. The isolated editor used a private 1280 by 900 software-rendered display. Python was 3.12.14,
with Pandas 3.0.5, Polars 1.44.1 and PyArrow 25.0.1. Native observations used DuckDB 1.5.5, PySpark 4.2.0, and
R 4.5.2 with jsonlite 2.0.0 and rlang 1.2.0. The final R refresh used rlang 1.3.0, Arrow 25.0.0 and clock 0.7.4, with
the same R and jsonlite versions. Installation, Workspace Trust and interpreter selection were untimed.
All product interactions used public controls and rendered UI; Microsoft extension package contents were not inspected.

The synthetic CSV files contain 100,000 or 1 million rows and six columns, approximately 5.3 MB or 53.9 MB. IDs run
from zero to N minus one. Amount is ID modulo 1,000, missing every tenth row. Category cycles through three strings,
missing every seventeenth row; the Boolean alternates, missing every nineteenth row. Dates cycle through 366 days
from January 1, 2024, and timestamps through 86,400 seconds from midnight that day. Every serialized CSV value and its row order
were checked against these formulas; the route-specific native checks are described above. The amount column has 900 distinct present values, mean 500 and sum 450 times N.

Default CSV imports retain the date and timestamp fields as strings. Notebook inputs use native dates and datetimes.
These narrow, periodic fixtures do not establish performance on wide tables, complex strings, different distributions
or cold storage. Three observations cannot establish tail latency or scaling.
