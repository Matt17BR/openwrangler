# Data Wrangler 1.24.2 comparison review

## Method

Status: reviewed on 2026-08-04.

The collection used the earlier warm-session method now summarized in
[`docs/performance-comparison.md`](../../performance-comparison.md): Pandas and Polars inputs loaded from CSV and
Parquet, one isolated headless VS Code session per product and input, and ten timed samples per session. Each sample
used the public inline preview, launch, grid, and column-summary controls. The harness then visited every column and
waited for its visible summary. Process-tree PSS was sampled across the same measured window.

The primary run used:

- Open Wrangler 1.2.1 VSIX SHA-256
  `646711453e8e9f4240a420440d165cecdbdf6785938a3ab8672c8170205adb79`;
- Microsoft Data Wrangler 1.24.2 from the Visual Studio Marketplace;
- Visual Studio Code 1.131.0;
- CPython 3.12.13 with Pandas 2.3.3, Polars 1.35.2, and PyArrow 25.0.0; and
- an Intel Core Ultra 9 185H machine on AC power with the `powersave` governor.

The fixtures passed their exact shape, schema, sentinel-value, and SHA-256 checks. No user data was used. An
independent recalculation matched every count, median, type-7 p95, and PSS summary in the generated report.

## Smoke

Status: passed before collection.

The smoke ran two samples per product with a Pandas input loaded from CSV. It verified the expected inline and launch
actions, full scrollable grid, first and final summary milestones, continuous PSS coverage, and clean shutdown. Smoke
timings were discarded and are not included below.

## Results

Status: complete. Three Data Wrangler column-summary sweeps did not finish.

The primary report contains eight sessions and 80 attempted samples. Open Wrangler completed 40/40. Data Wrangler
completed 37/40: one column-summary action was not pointer-ready, and two full summary sweeps timed out. The timing and
PSS summaries below use successful samples only, so the three affected Data Wrangler rows have nine observations.
Values are **median / p95**; timings are milliseconds and PSS is MiB.

| Notebook input         | Product       | Success |    Inline preview |    Full workbench |   First summary |       Summary sweep |      Observed PSS |
| ---------------------- | ------------- | ------: | ----------------: | ----------------: | --------------: | ------------------: | ----------------: |
| Pandas input · CSV     | Open Wrangler |   10/10 |     341.9 / 374.5 |     597.6 / 804.1 |   192.4 / 210.6 |   5,577.2 / 5,895.5 | 2,460.9 / 2,518.5 |
| Pandas input · CSV     | Data Wrangler |    9/10 | 1,490.3 / 1,748.3 | 1,013.7 / 1,383.9 |   308.5 / 909.9 | 18,795.4 / 20,300.6 | 2,348.9 / 2,518.3 |
| Polars input · CSV     | Open Wrangler |   10/10 |     321.2 / 522.6 |     533.7 / 770.4 |   180.8 / 208.9 |   5,540.9 / 5,930.4 | 2,475.1 / 2,527.7 |
| Polars input · CSV     | Data Wrangler |    9/10 | 1,498.3 / 1,907.0 |   986.5 / 1,030.0 | 312.8 / 1,085.2 | 18,808.3 / 20,813.2 | 2,451.8 / 2,679.3 |
| Pandas input · Parquet | Open Wrangler |   10/10 |     239.8 / 288.4 |     666.2 / 930.9 |   478.5 / 536.2 |   7,641.2 / 8,150.7 | 2,769.1 / 2,993.0 |
| Pandas input · Parquet | Data Wrangler |   10/10 | 1,527.8 / 1,731.3 |   693.1 / 1,019.2 |   319.6 / 701.9 |   7,953.2 / 9,002.3 | 3,064.1 / 3,190.2 |
| Polars input · Parquet | Open Wrangler |   10/10 |     204.8 / 319.8 |     484.5 / 582.2 |   410.2 / 483.4 |   7,201.8 / 7,587.0 | 2,628.8 / 2,726.1 |
| Polars input · Parquet | Data Wrangler |    9/10 | 1,489.4 / 1,802.6 |     693.9 / 882.2 | 487.1 / 1,222.6 |   8,231.7 / 9,498.4 | 3,144.5 / 3,475.3 |

Primary report SHA-256:
`e45eb499fed50febb61fb0d32cfa9a20800d59b04c67edd20d2568e39aa34ff3`.

The small differences between the Pandas and Polars inputs do not show how Data Wrangler handles either input. Fixture
loading happened before timing, and this test did not isolate any internal conversion stage. The measured window
mostly covers the inline renderer, workbench launch, and summary UI, where fixed overhead and normal run-to-run
variation can be larger than those differences.

The three affected Data Wrangler sessions were collected once more without changing the timeout. The two CSV sessions
then completed 10/10. The Parquet session with a Polars input timed out again during the full summary sweep, this time on
sample 6. That confirmation was not substituted into the primary table: repeatedly collecting until the baseline
happens to pass would hide the observed instability. Confirmation report SHA-256:
`56b933c6db09255d3f3b8338830613950e604094fefc1d3a1db691017f1f7b4b`.

## Release decision

No Open Wrangler median exceeded the preset relative and absolute regression allowances. Data Wrangler took
4.4–7.3× as long to show the inline preview, 1.0–1.8× as long to open the full workbench, and about 3.4× as long to
visit and verify every CSV column summary. The Parquet summary sweep was close, with Open Wrangler slightly faster.
Open Wrangler used a little more PSS on the two CSV cases and less on both million-row Parquet cases, all within the
memory allowance.

The successful samples did not identify an Open Wrangler regression to fix. The preset completion rule required all
80 samples to finish, so the run did not satisfy that rule. The stable publication workflow has separate required
checks and does not run this optional comparison. Before the next collection, the project should decide whether the
benchmark should continue to depend on a third-party product completing every attempt.
