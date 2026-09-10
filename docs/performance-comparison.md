# Archived Data Wrangler comparison

The optional competitor benchmark is archived. Maintaining a separate installer, notebook driver, fixture generator,
reporting protocol and recovery flow no longer serves a current development or release requirement. Its commands and
dedicated test harness have been removed from the current source tree.

The [reviewed Open Wrangler 1.2.1 results](performance/data-wrangler-1.2.1/review.md) remain historical evidence.
They do not establish the performance of a current release. The complete
[runner and method at the archival commit](https://github.com/Matt17BR/openwrangler/tree/6b8cd775b68f31dcfa72fb41a6a1be63e03c3dc4)
remain available in Git history; the
[original instructions](https://github.com/Matt17BR/openwrangler/blob/6b8cd775b68f31dcfa72fb41a6a1be63e03c3dc4/docs/performance-comparison.md)
include the optional mixed-data profile and reporting rules. Those commands require that historical checkout.
A new comparison would need a fresh decision about its scope, third-party dependencies and maintenance cost.

Current candidates retain the direct Open Wrangler installed-performance checks described in
[Testing](testing.md#release-candidate-checks). The weekly runtime performance checks and installed Data Wrangler
coexistence journey also remain; they do not depend on the archived comparison driver.

## Historical method

The benchmark compared Open Wrangler with Microsoft Data Wrangler 1.24.2 through public notebook controls.
Data Wrangler was installed from the Marketplace without inspecting or retaining its package contents.
Both products received the same engine-native dataframe for each workload:

| Dataframe | Source  |          Shape |
| --------- | ------- | -------------: |
| Pandas    | CSV     |   100,000 × 50 |
| Polars    | CSV     |   100,000 × 50 |
| Pandas    | Parquet | 1,000,000 × 20 |
| Polars    | Parquet | 1,000,000 × 20 |

The deterministic integer fixtures contained no user data. Each product/workload pair used an isolated headless
VS Code session and a pinned Python 3.12 kernel. Ten measured samples in each of eight sessions produced 80 outcomes.
The kernel and dataframe remained resident, so timings excluded editor startup and disk reads.

Each sample measured cell execution to a usable inline preview, launch to a usable full grid, and profiling to the
first and all completed columns. Readiness required the expected dataframe shape, columns, scrollability and usable
public controls. Process-tree proportional set size was sampled every 200 ms during the same workflow; gaps longer
than one second invalidated the memory observation.

Reports retained failed and timed-out samples alongside successful timings. They recorded versions, fixture and
candidate hashes, editor and Python identities, and machine details. Measured actions were not retried or removed
because they were slow. Review checked the collection and summaries without retaining user values or proprietary
package contents.

The 1.2.1 review predates later changes to the runner's completion policy. Its original verdict and limitations
remain in the dated review; the later policy does not change that result retroactively.
