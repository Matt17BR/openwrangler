# Runtime collection method

This describes the recorded September 14 collection behind [DuckDB](duckdb.json), [PySpark](pyspark.json)
and [native R](native-r.json). The formulas and call excerpts document the recorded collection;
the raw files retain the original samples.

## Fixture and timing

For each size `N = 100000, 1000000`, create six columns in this order, using zero-based `i = 0..N-1`:

- `id`: `i`.
- `amount`: null when `i % 10 == 0`; otherwise double-precision `i % 1000`.
- `category`: null when `i % 17 == 0`; otherwise `["Alpha", "Beta", "Gamma"][i % 3]`.
- `active`: null when `i % 19 == 0`; otherwise Boolean `i % 2 == 0`.
- `day`: date `2024-01-01` plus `i % 366` days.
- `event_at`: midnight `2024-01-01` plus `i % 86400` seconds.

DuckDB used a naive `TIMESTAMP`; Spark used timestamp instants from
`timestamp_seconds(1704067200 + id % 86400)` with SQL timezone UTC; R used `POSIXct` with timezone UTC.
Spark's collected Python timestamps use the Python process's local timezone. These choices share the
intended UTC-clock fields but do not establish identical timestamp text across engines. R's IDs were
ordinary integers; DuckDB and Spark used 64-bit integers. Both sizes fit exactly.

Run sizes in the order above, and tasks in the order page, filter/sort, profile, then Fill where supported.
For each task, record four trials, each with a fresh session or engine. Keep the first completed task
observation separately; report the median and range of the next three, rounded to integer milliseconds.
Python used `time.perf_counter_ns()` and R used `proc.time()[["elapsed"]]`. There was no retry or selection
of faster samples. Runtime processes remained running, and the two Spark sizes shared one JVM.

Fixture generation, opening, explicit garbage collection, verification and cleanup were outside the
timer. File caches were not cleared; generating the CSV warms the OS cache. These are runtime task
observations, excluding process startup and editor rendering. Fixed order, three samples, different
hardware and different call boundaries prevent engine rankings or scaling conclusions. Memory was not measured.

## DuckDB: an open CSV session

Use the frozen [SessionManager](https://github.com/Matt17BR/openwrangler/blob/85451b88224a3ecfc14e629f31de37bc43e00ab7/python/openwrangler_runtime/session.py)
and [DuckDB engine](https://github.com/Matt17BR/openwrangler/blob/85451b88224a3ecfc14e629f31de37bc43e00ab7/python/openwrangler_runtime/engines/duckdb_engine.py).
The collection used Python 3.12.14 and DuckDB 1.5.5 on Linux, Intel Core Ultra 9 185H, 22 logical CPUs
and about 61 GiB RAM. The existing connection defaults were unchanged: 22 threads and a 48.7 GiB memory limit.

Create the fixture natively with `duckdb.connect().sql(...)`, using `range(N) r(i)`, SQL `CASE` expressions
for the nulls and categories, `DATE '2024-01-01' + CAST(i%366 AS INTEGER)` and
`TIMESTAMP '2024-01-01' + (i%86400)*INTERVAL '1 second'`. Write it with
`relation.write_csv(path, header=True)` before timing. The recorded files were 5,294,554 and 53,945,240 bytes.

Create a new `SessionManager` and open that file before every trial:

```python
manager = SessionManager()
opened = manager.open_session(
    {"kind": "file", "label": path.name, "path": str(path)},
    backend="duckdb", mode="editing", column_limit=6,
    page_size=1 if task == "page_first_200" else 200,
)
sid = opened["metadata"]["sessionId"]
amount_id = opened["metadata"]["schema"][1]["id"]
empty = {"logic": "and", "filters": [], "sort": []}
view = {"logic": "and", "filters": [{"column": "amount", "type": "float",
        "logic": "and", "predicates": [{"operator": "gte", "value": 900}]}],
        "sort": [{"column": "id", "direction": "desc"}]}
```

Time one of the following task bodies, including construction of its filter or Fill dictionary.
Opening one row for the page task ensures its 200-row request
does not reuse the opening page's cache entry. Other tasks retain their 200-row opening outside timing.

```python
manager.get_page(sid, 0, 0, 200, empty, column_limit=6)
manager.get_page(sid, 0, 0, 200, view, column_limit=6)
manager.get_summary(sid, 0, empty, [amount_id])
# Fill is one timed body containing both calls:
step = {"id": "fill-zero", "kind": "fillMissingValues", "params": {
    "column": {"id": amount_id, "name": "amount"},
    "replacement": {"kind": "float", "value": "0"}}}
preview = manager.preview_step(sid, 0, step, 0, 200, column_limit=6)
manager.apply_draft(sid, preview["revision"], 0, 200, column_limit=6)
```

The timer includes SessionManager's source checks, native queries and Python response construction,
including both 200-row, six-column Fill responses. Native queries still read the CSV; an open session
does not mean the whole dataset was materialized. Stdio JSON transport and UI work are excluded.

## PySpark: an existing lazy frame

Use the frozen [PySpark engine](https://github.com/Matt17BR/openwrangler/blob/85451b88224a3ecfc14e629f31de37bc43e00ab7/python/openwrangler_runtime/engines/pyspark_engine.py).
The same local machine ran Python 3.12.14, PySpark 4.2.0 and Java 25.0.4. Create a Classic session with
`master("local[2]")`, two shuffle partitions, default parallelism two, a `1g` driver heap, SQL timezone UTC
and the Spark UI disabled. Use private local and warehouse directories. Session creation through
`spark.range(1).count()` took 4,711 ms separately and is excluded from task samples.

Construct `spark.range(N, numPartitions=2).selectExpr(...)` using the fixture formulas. Do not cache or
persist it. Create a fresh `PySparkEngine` per trial and validate its row-ID namespace and column
addressability before timing. With `ids = [f"c:{i}" for i in range(6)]`, the page task times all three calls:

```python
indexed = engine.ensure_row_ids(source, "everyday")
schema = engine.schema(indexed)
result = engine.page(indexed, 0, 200, column_projection=list(enumerate(ids)))
```

For the other tasks, prepare `indexed` before timing. Time `engine.apply_filter_model(indexed, view)`
followed by `engine.page(..., 0, 200, column_projection=list(enumerate(ids)))`, or time
`engine.summaries(indexed, [(1, ids[1])])`. The filter model is the Python `view` above.
These direct calls include native Spark work and bounded Python value conversion, but no SessionManager,
protocol or editor transport. Spark cleaning was unsupported and was not measured.

## Native R: an open agent session

The exact [completed collector](https://github.com/Matt17BR/openwrangler/blob/abe85a01233b7ede6a3b9e4da87e8e274f30f9ad/.github/experiments/everyday-native-r/measure.R)
and [native runtime](https://github.com/Matt17BR/openwrangler/tree/abe85a01233b7ede6a3b9e4da87e8e274f30f9ad/r/openwrangler_runtime)
belong to [run 34842617355](https://github.com/Matt17BR/openwrangler/actions/runs/34842617355).
It used R 4.5.3 on hosted Ubuntu 24.04, AMD EPYC 7763, four vCPUs and about 15.6 GiB RAM.
The recorded dependency lock matched installed packages. Data.table's default was two threads;
OMP, OpenBLAS, MKL and data.table thread environment overrides were unset.

Build an ordinary base `data.frame` with the formulas above. Each trial creates
`openwrangler_r_kernel_agent$new_agent(openwrangler_r_frame_contract, source_environment)` and opens
the frame with a one-row page before timing. Pre-encode the existing versioned JSON requests with
`jsonlite::toJSON(..., auto_unbox=TRUE, digits=17L, null="null", na="null")`.
Time `agent$dispatch_json(request)` for `getPage`, filtered `getPage`, or `getSummary` for `amount`.
Fill times `previewStep` at revision zero followed by `applyDraft` at revision one. The collector supplies
the exact native column references, filter payloads and six-column, 200-row page requests.

Dispatch includes request decoding, validation, source checks, computation and response JSON encoding.
Request encoding and response decoding are outside timing. Fill also includes first-edit isolation,
diff and generated-code construction, and both response pages. No mailbox, IRkernel or editor is timed.
At 1m rows, amount distributions sample up to 100k present values; exact distinct count, median and top
values are omitted. Counts and numeric totals remain exact. The 100k frame has 90k present amounts.

## Checks outside timing

All collections checked bounded page values, nulls, column identity, row order and numeric profile
counts, minimum, maximum and sum against the formulas. DuckDB additionally compared every source and
committed output cell with native `EXCEPT ALL` in both directions and checked full row order. Its first
Fill trial per size executed the complete generated program and checked its full output. CSV identity,
bytes and runtime source bytes remained unchanged.

Spark checked source schema, logical plan and native aggregate invariants, then verified that its
source remained usable after engine closure. R checked unchanged serialized source data each trial,
both Fill pages, the 20 changed cells in the preview window, zero remaining missing amounts across the
column, and revision advancement. Its first Fill trial per size compared the complete generated frame
with the expected frame; the live result used page and whole-column checks. Managers and engines were
closed after each trial. Native sessions and temporary resources were closed or removed at the end of
their owned lifetime; the Spark JVM persisted across both sizes.
