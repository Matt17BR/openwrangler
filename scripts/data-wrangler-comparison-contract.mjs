function sampleCountWord(value) {
  const word = new Map([
    [2, "two"],
    [3, "three"],
    [6, "six"],
    [8, "eight"],
    [10, "ten"],
    [80, "eighty"]
  ]).get(value);
  if (word === undefined) throw new TypeError(`Unsupported comparison sample count ${value}.`);
  return word;
}

const RELEASE_SAMPLES_PER_SESSION = 10;

export const DATA_WRANGLER_COMPARISON_AUTHORITY = Object.freeze({
  protocols: Object.freeze({
    study: "openwrangler-data-wrangler-study-v3",
    report: "openwrangler-data-wrangler-study-report-v3"
  }),
  release: Object.freeze({
    sessions: 8,
    samplesPerSession: RELEASE_SAMPLES_PER_SESSION,
    totalSamples: 8 * RELEASE_SAMPLES_PER_SESSION,
    requiredSuccesses: Object.freeze({
      openWrangler: RELEASE_SAMPLES_PER_SESSION,
      dataWrangler: 6
    })
  }),
  smoke: Object.freeze({ samplesPerSession: 2 }),
  local: Object.freeze({ samplesPerSession: 3, requiredSuccesses: 2 }),
  outcomes: Object.freeze({
    immutableFailureKinds: Object.freeze(["product", "timeout"]),
    replaceableFailureKind: "harness"
  }),
  dispositions: Object.freeze(["pass", "fail", "inconclusive"]),
  decisionReasons: Object.freeze({
    nonReleaseProfile: "non-release-profile",
    incompleteCollection: "incomplete-collection",
    retryableHarnessSession: "retryable-harness-session",
    insufficientBaselineSuccesses: "insufficient-baseline-successes",
    openWranglerSampleFailure: "open-wrangler-sample-failure",
    materialMedianRegression: "material-median-regression"
  })
});

export function isRetryableComparisonSession(samples) {
  const unsuccessful = samples.filter(({ status }) => status !== "success");
  return (
    unsuccessful.length > 0 &&
    unsuccessful.every(
      ({ failure }) => failure?.kind === DATA_WRANGLER_COMPARISON_AUTHORITY.outcomes.replaceableFailureKind
    )
  );
}

export function renderComparisonReleaseStatisticsMethod() {
  const { samplesPerSession, requiredSuccesses } = DATA_WRANGLER_COMPARISON_AUTHORITY.release;
  return `${sampleCountWord(samplesPerSession)} planned warm samples per product and workload; Open Wrangler requires ${sampleCountWord(requiredSuccesses.openWrangler)} successes and Data Wrangler at least ${sampleCountWord(requiredSuccesses.dataWrangler)}; Hyndman-Fan type 7 min, max, median, and p95`;
}

export function renderComparisonAgentSamplePolicy() {
  const samples = sampleCountWord(DATA_WRANGLER_COMPARISON_AUTHORITY.release.samplesPerSession);
  return `Run one isolated session per product and Pandas/Polars CSV/Parquet workload, with ${samples} warm UI samples in each session.`;
}

export function renderComparisonAgentCompletionPolicy() {
  const { immutableFailureKinds, replaceableFailureKind } = DATA_WRANGLER_COMPARISON_AUTHORITY.outcomes;
  return `Measured ${immutableFailureKinds[0]} failures and ${immutableFailureKinds[1]}s are immutable; only ${replaceableFailureKind}-aborted sessions may be replaced.`;
}

export function renderComparisonDocumentationSampleSummary() {
  const { sessions, totalSamples } = DATA_WRANGLER_COMPARISON_AUTHORITY.release;
  return `The full benchmark uses ${sessions} sessions and records ${totalSamples} samples.`;
}

export function renderComparisonDocumentationCompletionSummary() {
  const { samplesPerSession, requiredSuccesses } = DATA_WRANGLER_COMPARISON_AUTHORITY.release;
  return `The release contract requires all ${samplesPerSession} Open Wrangler successes and at least ${requiredSuccesses.dataWrangler} Data Wrangler successes per workload.`;
}
