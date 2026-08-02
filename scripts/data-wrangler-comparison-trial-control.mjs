import {
  DATA_WRANGLER_STUDY_BRIDGE_ABANDONMENT_PROTOCOL,
  createDataWranglerStudyBridgeResponder,
  validateDataWranglerStudyBridgeAcknowledgement,
  validateDataWranglerStudyBridgeRequest
} from "./data-wrangler-study-control-bridge.mjs";
import { LINUX_PSS_BASELINE_ACKNOWLEDGEMENT_PROTOCOL, collectLinuxPssObservation } from "./linux-pss-sampler.mjs";
import { digestStudyValue, validateDataWranglerStudyResourceObservation } from "./data-wrangler-comparison-study.mjs";

export const DATA_WRANGLER_COMPARISON_TRIAL_CONTROL_PROTOCOL = "openwrangler-data-wrangler-comparison-trial-control-v1";
export const DATA_WRANGLER_COMPARISON_TERMINAL_DELAY_MS = 2_000;
export const DATA_WRANGLER_COMPARISON_BASELINE_SAMPLE_COUNT = 5;

const NANOSECONDS_PER_MILLISECOND = 1_000_000n;
const TERMINAL_DELAY_NANOSECONDS = BigInt(DATA_WRANGLER_COMPARISON_TERMINAL_DELAY_MS) * NANOSECONDS_PER_MILLISECOND;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_BASELINE_TIMEOUT_MS = 10_000;
const DEFAULT_TERMINAL_TIMEOUT_MS = 10_000;
const DEFAULT_ABORT_SETTLEMENT_TIMEOUT_MS = 5_000;
const MINIMUM_BASELINE_RANGE_BYTES = 64 * 1024 * 1024;
const SHA256 = /^[0-9a-f]{64}$/u;
const NANOSECONDS = /^[1-9]\d{0,29}$/u;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const PHASE = /^[a-z0-9](?:[a-z0-9-]{0,126}[a-z0-9])?$/u;
const BOUNDED_NAME = /^[^\0\r\n]{1,512}$/u;
const FAILURE_TOKEN = /^[a-z][a-z0-9-]{0,63}$/u;
const WARM_SEQUENCE = Object.freeze([
  "source-verified",
  "measurement-ready",
  "sampling-origin",
  "inline-baseline",
  "workbench-baseline",
  "profile-baseline",
  "sampling-stop",
  "cleanup-census"
]);
const COLD_SEQUENCE = Object.freeze(["source-verified", "cold-cache-evicted", ...WARM_SEQUENCE.slice(1)]);

export class DataWranglerComparisonTrialControlError extends Error {
  constructor(code, message, options) {
    super(message, options);
    this.name = "DataWranglerComparisonTrialControlError";
    this.code = code;
  }
}

function fail(code, message, options) {
  throw new DataWranglerComparisonTrialControlError(code, message, options);
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value, keys, label) {
  if (!isRecord(value)) fail("malformed-evidence", `${label} must be an object.`);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    fail("malformed-evidence", `${label} has missing or unknown fields.`);
  }
}

function nanoseconds(value, label) {
  if (typeof value !== "string" || !NANOSECONDS.test(value)) {
    fail("clock-mismatch", `${label} must be one positive monotonic nanosecond timestamp.`);
  }
  return BigInt(value);
}

function safeNonNegativeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    fail("malformed-evidence", `${label} must be a non-negative safe integer.`);
  }
  return value;
}

function positiveTimeout(value, label) {
  if (!Number.isSafeInteger(value) || value < 1 || value > 300_000) {
    fail("invalid-dependency", `${label} must be between 1 and 300000 ms.`);
  }
  return value;
}

function assertAbortSignal(signal) {
  if (
    signal === null ||
    typeof signal !== "object" ||
    typeof signal.aborted !== "boolean" ||
    typeof signal.addEventListener !== "function" ||
    typeof signal.removeEventListener !== "function"
  ) {
    fail("invalid-dependency", "Measured-trial control requires an AbortSignal.");
  }
}

function abortError() {
  return new DataWranglerComparisonTrialControlError(
    "aborted",
    "Measured-trial control was aborted before its exact handshake completed."
  );
}

async function awaitBounded(
  promise,
  { timeoutMs, label, signal, additionalFailures = [], setTimer = setTimeout, clearTimer = clearTimeout }
) {
  if (signal?.aborted) throw abortError();
  let timer;
  let removeAbort = () => {};
  const timeout = new Promise((_, reject) => {
    timer = setTimer(
      () => reject(new DataWranglerComparisonTrialControlError("timeout", `${label} exceeded ${timeoutMs} ms.`)),
      timeoutMs
    );
  });
  const candidates = [Promise.resolve(promise), timeout, ...additionalFailures];
  if (signal !== undefined) {
    candidates.push(
      new Promise((_, reject) => {
        const onAbort = () => reject(abortError());
        signal.addEventListener("abort", onAbort, { once: true });
        removeAbort = () => signal.removeEventListener("abort", onAbort);
        if (signal.aborted) onAbort();
      })
    );
  }
  try {
    return await Promise.race(candidates);
  } finally {
    clearTimer(timer);
    removeAbort();
  }
}

function validateStableBaselineReceipt(value) {
  exactKeys(
    value,
    [
      "protocol",
      "sampleIndex",
      "sampleElapsedMs",
      "sampleScheduledMonotonicNanoseconds",
      "sampleStartedMonotonicNanoseconds",
      "sampleEndedMonotonicNanoseconds",
      "stableBaseline"
    ],
    "PSS rolling-baseline receipt"
  );
  if (value.protocol !== LINUX_PSS_BASELINE_ACKNOWLEDGEMENT_PROTOCOL) {
    fail("sampler-mismatch", "PSS rolling-baseline receipt uses the wrong protocol.");
  }
  safeNonNegativeInteger(value.sampleIndex, "PSS rolling-baseline sample index");
  if (
    typeof value.sampleElapsedMs !== "number" ||
    !Number.isFinite(value.sampleElapsedMs) ||
    value.sampleElapsedMs < 0
  ) {
    fail("malformed-evidence", "PSS rolling-baseline elapsed time is invalid.");
  }
  const scheduled = nanoseconds(value.sampleScheduledMonotonicNanoseconds, "PSS rolling-baseline scheduled timestamp");
  const started = nanoseconds(value.sampleStartedMonotonicNanoseconds, "PSS rolling-baseline started timestamp");
  const ended = nanoseconds(value.sampleEndedMonotonicNanoseconds, "PSS rolling-baseline ended timestamp");
  if (scheduled > started || started > ended) {
    fail("clock-mismatch", "PSS rolling-baseline sample timestamps are out of order.");
  }
  if (value.stableBaseline === null) return null;
  exactKeys(
    value.stableBaseline,
    [
      "sampleCount",
      "firstSampleIndex",
      "lastSampleIndex",
      "firstStartedMonotonicNanoseconds",
      "lastEndedMonotonicNanoseconds",
      "medianPssBytes",
      "rangePssBytes",
      "maximumRangePssBytes"
    ],
    "PSS stable-baseline receipt"
  );
  const stable = value.stableBaseline;
  if (
    stable.sampleCount !== DATA_WRANGLER_COMPARISON_BASELINE_SAMPLE_COUNT ||
    !Number.isSafeInteger(stable.firstSampleIndex) ||
    !Number.isSafeInteger(stable.lastSampleIndex) ||
    stable.firstSampleIndex < 0 ||
    stable.lastSampleIndex !== value.sampleIndex ||
    stable.lastSampleIndex - stable.firstSampleIndex + 1 !== DATA_WRANGLER_COMPARISON_BASELINE_SAMPLE_COUNT
  ) {
    fail("sampler-mismatch", "PSS stable baseline does not bind exactly five rolling samples.");
  }
  for (const [field, label] of [
    [stable.medianPssBytes, "median"],
    [stable.rangePssBytes, "range"]
  ]) {
    safeNonNegativeInteger(field, `PSS stable-baseline ${label}`);
  }
  if (
    typeof stable.maximumRangePssBytes !== "number" ||
    !Number.isFinite(stable.maximumRangePssBytes) ||
    stable.maximumRangePssBytes < 0 ||
    stable.rangePssBytes > stable.maximumRangePssBytes
  ) {
    fail("sampler-mismatch", "PSS stable-baseline range exceeds its finite non-negative stability bound.");
  }
  const firstStarted = nanoseconds(
    stable.firstStartedMonotonicNanoseconds,
    "PSS stable-baseline first-started timestamp"
  );
  const lastEnded = nanoseconds(stable.lastEndedMonotonicNanoseconds, "PSS stable-baseline last-ended timestamp");
  if (firstStarted > lastEnded || stable.lastEndedMonotonicNanoseconds !== value.sampleEndedMonotonicNanoseconds) {
    fail("sampler-mismatch", "PSS stable-baseline timestamps do not match the acknowledged sample.");
  }
  return Object.freeze(structuredClone(value));
}

function baselineQualifies(receipt, request) {
  return (
    receipt !== null &&
    nanoseconds(receipt.stableBaseline.lastEndedMonotonicNanoseconds, "PSS stable-baseline end") >=
      nanoseconds(request.monotonicNanoseconds, "Study baseline request")
  );
}

function validateAuthorizationReceipt(value, runId) {
  if (!isRecord(value) || !isRecord(value.intent) || !isRecord(value.publication)) {
    fail("authorization", "Product-action authorization did not return its durable journal receipt.");
  }
  if (
    value.intent.stage !== "action-authorized" ||
    value.intent.runId !== runId ||
    typeof value.intent.scheduleEntryId !== "string" ||
    !BOUNDED_NAME.test(value.intent.scheduleEntryId) ||
    typeof value.intent.effectiveBlockId !== "string" ||
    !BOUNDED_NAME.test(value.intent.effectiveBlockId) ||
    !SHA256.test(value.publication.sha256 ?? "") ||
    !["published", "recovered"].includes(value.publication.status) ||
    digestStudyValue(value.intent) !== value.publication.sha256
  ) {
    fail("authorization", "Product-action authorization did not durably bind this exact measured trial.");
  }
  return Object.freeze({
    runId: value.intent.runId,
    scheduleEntryId: value.intent.scheduleEntryId,
    effectiveBlockId: value.intent.effectiveBlockId,
    publicationSha256: value.publication.sha256,
    publicationStatus: value.publication.status
  });
}

function validateObservationAndBaselines(observation, terminalTarget, baselineReceipts) {
  try {
    validateDataWranglerStudyResourceObservation(observation);
  } catch (error) {
    fail("sampler-invalid", "PSS collector returned malformed resource evidence.", { cause: error });
  }
  if (
    observation.valid !== true ||
    observation.reasonClass !== null ||
    observation.missedSamples !== 0 ||
    !isRecord(observation.terminalBoundary)
  ) {
    fail("sampler-invalid", "PSS collector returned an invalid measured-trial observation.");
  }
  const terminal = observation.terminalBoundary;
  if (terminal.targetMonotonicNanoseconds !== terminalTarget.toString()) {
    fail("collector-mismatch", "PSS collector terminal boundary does not match sampling-stop plus two seconds.");
  }
  const terminalStarted = nanoseconds(
    terminal.firstEligibleSampleStartedMonotonicNanoseconds,
    "PSS terminal sample start"
  );
  const terminalScheduled = nanoseconds(
    terminal.firstEligibleSampleScheduledMonotonicNanoseconds,
    "PSS terminal sample schedule"
  );
  const terminalEnded = nanoseconds(terminal.firstEligibleSampleEndedMonotonicNanoseconds, "PSS terminal sample end");
  const lastSample = observation.samples.at(-1);
  if (
    terminalScheduled > terminalStarted ||
    terminalStarted < terminalTarget ||
    terminalEnded < terminalStarted ||
    !isRecord(lastSample) ||
    lastSample.scheduledMonotonicNanoseconds !== terminal.firstEligibleSampleScheduledMonotonicNanoseconds ||
    lastSample.startedMonotonicNanoseconds !== terminal.firstEligibleSampleStartedMonotonicNanoseconds ||
    lastSample.endedMonotonicNanoseconds !== terminal.firstEligibleSampleEndedMonotonicNanoseconds ||
    observation.samples
      .slice(0, -1)
      .some(
        (sample) =>
          !isRecord(sample) ||
          nanoseconds(sample.startedMonotonicNanoseconds, "PSS pre-terminal sample start") >= terminalTarget
      )
  ) {
    fail("collector-mismatch", "PSS collector did not stop on its first eligible terminal sample.");
  }
  for (const receipt of baselineReceipts) {
    const stable = receipt.stableBaseline;
    const first = observation.samples[stable.firstSampleIndex];
    const last = observation.samples[stable.lastSampleIndex];
    const window = observation.samples.slice(stable.firstSampleIndex, stable.lastSampleIndex + 1);
    if (
      window.length !== DATA_WRANGLER_COMPARISON_BASELINE_SAMPLE_COUNT ||
      window.some((sample) => !isRecord(sample))
    ) {
      fail("collector-mismatch", "A retained stable-baseline receipt does not identify five final PSS samples.");
    }
    const totals = window.map((sample) =>
      safeNonNegativeInteger(sample.totalPssBytes, "PSS stable-baseline sample total")
    );
    const sortedTotals = [...totals].sort((left, right) => left - right);
    const medianPssBytes = sortedTotals[2];
    const rangePssBytes = Math.max(...totals) - Math.min(...totals);
    const maximumRangePssBytes = Math.max(MINIMUM_BASELINE_RANGE_BYTES, medianPssBytes * 0.05);
    if (
      !isRecord(first) ||
      !isRecord(last) ||
      first.startedMonotonicNanoseconds !== stable.firstStartedMonotonicNanoseconds ||
      last.endedMonotonicNanoseconds !== stable.lastEndedMonotonicNanoseconds ||
      last.scheduledMonotonicNanoseconds !== receipt.sampleScheduledMonotonicNanoseconds ||
      last.startedMonotonicNanoseconds !== receipt.sampleStartedMonotonicNanoseconds ||
      last.endedMonotonicNanoseconds !== receipt.sampleEndedMonotonicNanoseconds ||
      stable.medianPssBytes !== medianPssBytes ||
      stable.rangePssBytes !== rangePssBytes ||
      stable.maximumRangePssBytes !== maximumRangePssBytes
    ) {
      fail("collector-mismatch", "A retained stable-baseline receipt does not match the final PSS observation.");
    }
  }
  return observation;
}

function validatePartialResourceObservation(observation) {
  try {
    validateDataWranglerStudyResourceObservation(observation);
  } catch (error) {
    fail("sampler-invalid", "PSS collector returned malformed partial resource evidence.", { cause: error });
  }
  return observation;
}

function boundedFailureKind(error) {
  const candidate = typeof error?.code === "string" ? error.code : "control-failure";
  return FAILURE_TOKEN.test(candidate) ? candidate : "control-failure";
}

function snapshotBaseline(value) {
  if (value === null) return null;
  return {
    request: value.request,
    acknowledgement: value.acknowledgement,
    receipt: value.receipt
  };
}

function sameBridgeEnvelope(left, right) {
  return (
    isRecord(left) &&
    isRecord(right) &&
    left.protocol === right.protocol &&
    left.runId === right.runId &&
    left.phase === right.phase &&
    left.sequence === right.sequence &&
    left.kind === right.kind &&
    left.monotonicNanoseconds === right.monotonicNanoseconds
  );
}

function deepFreeze(value, seen = new WeakSet()) {
  if (value === null || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
}

function immutableEvidenceClone(value) {
  let clone;
  try {
    clone = structuredClone(value);
  } catch (error) {
    fail("malformed-evidence", "Measured-trial control receipt is not cloneable evidence.", { cause: error });
  }
  return deepFreeze(clone);
}

function validateAbandonedRequest(value, { runId, phase, expectedSequence, expectedKind }) {
  exactKeys(value, ["request", "abandonment"], "Abandoned study bridge request");
  const request = validateDataWranglerStudyBridgeRequest(value.request);
  exactKeys(
    value.abandonment,
    ["protocol", "runId", "phase", "sequence", "kind", "requestMonotonicNanoseconds", "abandonedMonotonicNanoseconds"],
    "Study bridge abandonment receipt"
  );
  const abandonment = value.abandonment;
  if (
    abandonment.protocol !== DATA_WRANGLER_STUDY_BRIDGE_ABANDONMENT_PROTOCOL ||
    request.runId !== runId ||
    request.phase !== phase ||
    request.sequence !== expectedSequence ||
    request.kind !== expectedKind ||
    abandonment.runId !== request.runId ||
    abandonment.phase !== request.phase ||
    abandonment.sequence !== request.sequence ||
    abandonment.kind !== request.kind ||
    abandonment.requestMonotonicNanoseconds !== request.monotonicNanoseconds ||
    nanoseconds(abandonment.abandonedMonotonicNanoseconds, "Study bridge abandonment timestamp") <
      nanoseconds(request.monotonicNanoseconds, "Abandoned study bridge request timestamp")
  ) {
    fail("bridge-mismatch", "Study bridge abandonment does not bind the exact unacknowledged request.");
  }
  return { request, abandonment };
}

function expectedTrialSequence(cacheState) {
  return cacheState === "cold" ? COLD_SEQUENCE : WARM_SEQUENCE;
}

export function validateDataWranglerComparisonTrialControlReceipt(value) {
  exactKeys(
    value,
    [
      "protocol",
      "status",
      "runId",
      "phase",
      "cacheState",
      "failure",
      "completedExchanges",
      "pendingRequest",
      "abandonedRequest",
      "coldCacheProof",
      "baselines",
      "authorization",
      "samplingStop",
      "resourceObservation"
    ],
    "Measured-trial control receipt"
  );
  if (value.protocol !== DATA_WRANGLER_COMPARISON_TRIAL_CONTROL_PROTOCOL) {
    fail("malformed-evidence", "Measured-trial control receipt uses the wrong protocol.");
  }
  if (!UUID_V4.test(value.runId ?? "") || !PHASE.test(value.phase ?? "")) {
    fail("malformed-evidence", "Measured-trial control receipt has invalid correlation fields.");
  }
  if (!["warm", "cold"].includes(value.cacheState) || !["success", "failed"].includes(value.status)) {
    fail("malformed-evidence", "Measured-trial control receipt has an invalid state.");
  }
  if (value.status === "success") {
    if (value.failure !== null) fail("malformed-evidence", "Successful measured-trial receipt has a failure.");
  } else {
    exactKeys(value.failure, ["stage", "kind"], "Measured-trial control failure");
    if (!FAILURE_TOKEN.test(value.failure.stage) || !FAILURE_TOKEN.test(value.failure.kind)) {
      fail("malformed-evidence", "Measured-trial failure stage or kind exceeds its bound.");
    }
  }

  const sequence = expectedTrialSequence(value.cacheState);
  if (!Array.isArray(value.completedExchanges) || value.completedExchanges.length > sequence.length) {
    fail("malformed-evidence", "Measured-trial completed exchanges exceed the fixed sequence.");
  }
  let previousAcknowledgement = null;
  const exchanges = new Map();
  value.completedExchanges.forEach((candidate, index) => {
    exactKeys(candidate, ["request", "acknowledgement"], "Completed study bridge exchange");
    const request = validateDataWranglerStudyBridgeRequest(candidate.request);
    const acknowledgement = validateDataWranglerStudyBridgeAcknowledgement(candidate.acknowledgement);
    if (
      request.runId !== value.runId ||
      request.phase !== value.phase ||
      request.sequence !== index ||
      request.kind !== sequence[index] ||
      acknowledgement.runId !== request.runId ||
      acknowledgement.phase !== request.phase ||
      acknowledgement.sequence !== request.sequence ||
      acknowledgement.kind !== request.kind
    ) {
      fail("sequence-drift", "Measured-trial completed exchanges are stale or reordered.");
    }
    const requestedAt = nanoseconds(request.monotonicNanoseconds, "Completed study bridge request");
    const acknowledgedAt = nanoseconds(acknowledgement.monotonicNanoseconds, "Completed study bridge acknowledgement");
    if (acknowledgedAt < requestedAt || (previousAcknowledgement !== null && requestedAt < previousAcknowledgement)) {
      fail("clock-mismatch", "Measured-trial completed exchange timestamps are not monotonic.");
    }
    previousAcknowledgement = acknowledgedAt;
    exchanges.set(request.kind, { request, acknowledgement });
  });
  if (value.pendingRequest !== null) {
    fail("cleanup-uncertain", "A publishable measured-trial receipt cannot retain a live pending request.");
  }
  const nextKind = sequence[value.completedExchanges.length];
  const abandoned =
    value.abandonedRequest === null
      ? null
      : validateAbandonedRequest(value.abandonedRequest, {
          runId: value.runId,
          phase: value.phase,
          expectedSequence: value.completedExchanges.length,
          expectedKind: nextKind
        });
  if (
    abandoned !== null &&
    previousAcknowledgement !== null &&
    nanoseconds(abandoned.request.monotonicNanoseconds, "Abandoned study bridge request") < previousAcknowledgement
  ) {
    fail("clock-mismatch", "Abandoned study bridge request predates the previous acknowledgement.");
  }

  if (!isRecord(value.baselines)) {
    fail("malformed-evidence", "Measured-trial baselines must be an object.");
  }
  exactKeys(value.baselines, ["inline", "workbench", "profile"], "Measured-trial baselines");
  const baselineKinds = {
    inline: "inline-baseline",
    workbench: "workbench-baseline",
    profile: "profile-baseline"
  };
  for (const [name, kind] of Object.entries(baselineKinds)) {
    const baseline = value.baselines[name];
    const completed = exchanges.get(kind);
    const wasAbandoned = abandoned?.request.kind === kind;
    if (baseline === null) {
      if (completed !== undefined || wasAbandoned) {
        fail("malformed-evidence", `Measured-trial ${kind} evidence is missing.`);
      }
      continue;
    }
    exactKeys(baseline, ["request", "acknowledgement", "receipt"], `Measured-trial ${kind} evidence`);
    const request = validateDataWranglerStudyBridgeRequest(baseline.request);
    if (
      request.kind !== kind ||
      (!sameBridgeEnvelope(request, completed?.request) && !sameBridgeEnvelope(request, abandoned?.request))
    ) {
      fail("bridge-mismatch", `Measured-trial ${kind} request does not match its retained bridge evidence.`);
    }
    if (baseline.receipt === null) {
      if (completed !== undefined) fail("sampler-mismatch", `Acknowledged ${kind} has no stable-baseline receipt.`);
    } else {
      const receipt = validateStableBaselineReceipt(baseline.receipt);
      if (!baselineQualifies(receipt, request)) {
        fail("sampler-mismatch", `Measured-trial ${kind} baseline predates its request.`);
      }
      if (
        baseline.acknowledgement !== null &&
        nanoseconds(baseline.acknowledgement.monotonicNanoseconds, `${kind} acknowledgement`) <
          nanoseconds(receipt.sampleEndedMonotonicNanoseconds, `${kind} stable sample end`)
      ) {
        fail("clock-mismatch", `Measured-trial ${kind} acknowledgement predates its stable sample.`);
      }
    }
    if (completed === undefined) {
      if (baseline.acknowledgement !== null) {
        fail("bridge-mismatch", `Unacknowledged ${kind} unexpectedly contains an acknowledgement.`);
      }
    } else if (!sameBridgeEnvelope(baseline.acknowledgement, completed.acknowledgement)) {
      fail("bridge-mismatch", `Measured-trial ${kind} acknowledgement does not match its completed exchange.`);
    }
  }

  if (value.cacheState === "warm" && value.coldCacheProof !== null) {
    fail("malformed-evidence", "Warm measured-trial receipt cannot retain cold-cache proof.");
  }
  if (value.coldCacheProof !== null && !isRecord(value.coldCacheProof)) {
    fail("malformed-evidence", "Cold-cache proof must be an object.");
  }
  if (exchanges.has("cold-cache-evicted") && value.coldCacheProof === null) {
    fail("malformed-evidence", "Acknowledged cold-cache eviction has no retained proof.");
  }

  if (value.authorization !== null) {
    exactKeys(
      value.authorization,
      ["runId", "scheduleEntryId", "effectiveBlockId", "publicationSha256", "publicationStatus"],
      "Measured-trial authorization"
    );
    if (
      value.authorization.runId !== value.runId ||
      !BOUNDED_NAME.test(value.authorization.scheduleEntryId ?? "") ||
      !BOUNDED_NAME.test(value.authorization.effectiveBlockId ?? "") ||
      !SHA256.test(value.authorization.publicationSha256 ?? "") ||
      !["published", "recovered"].includes(value.authorization.publicationStatus) ||
      value.baselines.inline?.receipt === null ||
      value.baselines.inline === null
    ) {
      fail("authorization", "Measured-trial authorization is malformed or has no stable inline fence.");
    }
  }
  if (exchanges.has("inline-baseline") && value.authorization === null) {
    fail("authorization", "Acknowledged inline baseline has no durable action authorization.");
  }

  if (value.samplingStop !== null) {
    exactKeys(
      value.samplingStop,
      ["request", "acknowledgement", "terminalTargetMonotonicNanoseconds"],
      "Measured-trial sampling stop"
    );
    const request = validateDataWranglerStudyBridgeRequest(value.samplingStop.request);
    const completed = exchanges.get("sampling-stop");
    if (
      request.kind !== "sampling-stop" ||
      (!sameBridgeEnvelope(request, completed?.request) && !sameBridgeEnvelope(request, abandoned?.request)) ||
      nanoseconds(value.samplingStop.terminalTargetMonotonicNanoseconds, "PSS terminal target") !==
        nanoseconds(request.monotonicNanoseconds, "Sampling-stop request") + TERMINAL_DELAY_NANOSECONDS
    ) {
      fail("collector-mismatch", "Measured-trial sampling-stop evidence is not bound to its exact target.");
    }
    if (completed === undefined) {
      if (value.samplingStop.acknowledgement !== null) {
        fail("bridge-mismatch", "Unacknowledged sampling-stop evidence contains an acknowledgement.");
      }
    } else if (!sameBridgeEnvelope(value.samplingStop.acknowledgement, completed.acknowledgement)) {
      fail("bridge-mismatch", "Sampling-stop acknowledgement does not match its completed exchange.");
    }
  } else if (exchanges.has("sampling-stop") || abandoned?.request.kind === "sampling-stop") {
    fail("malformed-evidence", "Measured-trial sampling-stop evidence is missing.");
  }

  validatePartialResourceObservation(value.resourceObservation);
  if (value.status === "success") {
    if (
      value.completedExchanges.length !== sequence.length ||
      abandoned !== null ||
      value.samplingStop === null ||
      value.authorization === null
    ) {
      fail("malformed-evidence", "Successful measured-trial receipt does not contain the complete handshake.");
    }
    validateObservationAndBaselines(
      value.resourceObservation,
      BigInt(value.samplingStop.terminalTargetMonotonicNanoseconds),
      [value.baselines.inline.receipt, value.baselines.workbench.receipt, value.baselines.profile.receipt]
    );
  }
  return immutableEvidenceClone(value);
}

function createControlReceipt({ runId, phase, cacheState, state, status, failure }) {
  return validateDataWranglerComparisonTrialControlReceipt({
    protocol: DATA_WRANGLER_COMPARISON_TRIAL_CONTROL_PROTOCOL,
    status,
    runId,
    phase,
    cacheState,
    failure,
    completedExchanges: Object.freeze([...state.completedExchanges]),
    pendingRequest: state.pendingRequest,
    abandonedRequest: state.abandonedRequest,
    coldCacheProof: state.coldCacheProof,
    baselines: Object.freeze({
      inline: snapshotBaseline(state.baselines.inline),
      workbench: snapshotBaseline(state.baselines.workbench),
      profile: snapshotBaseline(state.baselines.profile)
    }),
    authorization: state.authorization,
    samplingStop: state.samplingStop,
    resourceObservation: state.resourceObservation
  });
}

function validateResponder(responder) {
  if (
    !isRecord(responder) ||
    typeof responder.waitForRequest !== "function" ||
    typeof responder.acknowledge !== "function" ||
    typeof responder.abandon !== "function"
  ) {
    fail("invalid-dependency", "Measured-trial control requires a responder with wait, acknowledge, and abandon.");
  }
  return responder;
}

export async function controlDataWranglerComparisonMeasuredTrial(
  {
    requestPath,
    acknowledgementPath,
    runId,
    phase,
    cacheState,
    sampler,
    authorizeAction,
    signal = new AbortController().signal
  } = {},
  {
    createResponder = createDataWranglerStudyBridgeResponder,
    collectObservation = collectLinuxPssObservation,
    evictColdCache,
    responderOptions,
    collectionOptions = {},
    requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
    cacheEvictionTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
    baselineTimeoutMs = DEFAULT_BASELINE_TIMEOUT_MS,
    terminalTimeoutMs = DEFAULT_TERMINAL_TIMEOUT_MS,
    abortSettlementTimeoutMs = DEFAULT_ABORT_SETTLEMENT_TIMEOUT_MS,
    setTimer = setTimeout,
    clearTimer = clearTimeout
  } = {}
) {
  if (!["warm", "cold"].includes(cacheState)) {
    fail("invalid-dependency", "Measured-trial cache state must be warm or cold.");
  }
  if (typeof createResponder !== "function" || typeof collectObservation !== "function") {
    fail("invalid-dependency", "Measured-trial responder and PSS collector factories must be functions.");
  }
  if (typeof authorizeAction !== "function") {
    fail("invalid-dependency", "Measured-trial control requires a synchronous authorizeAction callback.");
  }
  if (cacheState === "cold" && typeof evictColdCache !== "function") {
    fail("invalid-dependency", "A cold measured trial requires an injected cache-eviction operation.");
  }
  if (typeof setTimer !== "function" || typeof clearTimer !== "function") {
    fail("invalid-dependency", "Measured-trial timeout dependencies must be functions.");
  }
  assertAbortSignal(signal);
  positiveTimeout(requestTimeoutMs, "Study bridge request timeout");
  positiveTimeout(cacheEvictionTimeoutMs, "Cold-cache eviction timeout");
  positiveTimeout(baselineTimeoutMs, "Stable-baseline timeout");
  positiveTimeout(terminalTimeoutMs, "Terminal-sample timeout");
  positiveTimeout(abortSettlementTimeoutMs, "Collector abort-settlement timeout");
  if (signal.aborted) throw abortError();

  const responder = validateResponder(
    createResponder({ requestPath, acknowledgementPath, runId, phase }, responderOptions)
  );
  const collectorAbort = new AbortController();
  const propagateAbort = () => collectorAbort.abort(signal.reason);
  signal.addEventListener("abort", propagateAbort, { once: true });

  let sequence = 0;
  let previousAcknowledgementNanoseconds = null;
  let collectionPromise;
  let collectorInvoked = false;
  let collectorSettlementFailure;
  let collectionSettled = false;
  let collectionSettlement;
  let terminalTarget = null;
  let latestBaseline = null;
  let baselineWaiter = null;
  let authorizationPerformed = false;
  let acknowledgementUncertain = null;
  let pendingResponderRequest = null;
  let requestWaitUncertain = false;
  const state = {
    completedExchanges: [],
    pendingRequest: null,
    abandonedRequest: null,
    coldCacheProof: null,
    baselines: { inline: null, workbench: null, profile: null },
    authorization: null,
    samplingStop: null,
    resourceObservation: null
  };
  let failureStage = "initialization";

  const guarded = (promise, timeoutMs, label, additionalFailures = []) =>
    awaitBounded(promise, {
      timeoutMs,
      label,
      signal,
      additionalFailures,
      setTimer,
      clearTimer
    });

  const waitForRequest = async (kind, monitorCollector = false) => {
    failureStage = kind;
    const requestAbort = new AbortController();
    let timer;
    let removeAbort = () => {};
    const waitOutcome = Promise.resolve()
      .then(() => responder.waitForRequest(sequence, kind, requestAbort.signal))
      .then(
        (original) => ({ type: "request", original }),
        (error) => ({ type: "error", error })
      );
    const timeout = new Promise((resolveTimeout) => {
      timer = setTimer(
        () =>
          resolveTimeout({
            type: "interruption",
            error: new DataWranglerComparisonTrialControlError(
              "timeout",
              `Study bridge ${kind} request exceeded ${requestTimeoutMs} ms.`
            )
          }),
        requestTimeoutMs
      );
    });
    const aborted = new Promise((resolveAbort) => {
      const onAbort = () => resolveAbort({ type: "interruption", error: abortError() });
      signal.addEventListener("abort", onAbort, { once: true });
      removeAbort = () => signal.removeEventListener("abort", onAbort);
      if (signal.aborted) onAbort();
    });
    const candidates = [waitOutcome, timeout, aborted];
    if (monitorCollector && collectorSettlementFailure !== undefined) {
      candidates.push(collectorSettlementFailure.catch((error) => ({ type: "interruption", error })));
    }
    let original;
    let interruptionError;
    try {
      const outcome = await Promise.race(candidates);
      if (outcome.type === "request") {
        original = outcome.original;
      } else if (outcome.type === "error") {
        if (!["timeout", "aborted"].includes(outcome.error?.code)) requestWaitUncertain = true;
        throw outcome.error;
      } else {
        interruptionError = outcome.error;
        requestAbort.abort(interruptionError);
        let settlement;
        try {
          settlement = await awaitBounded(waitOutcome, {
            timeoutMs: abortSettlementTimeoutMs,
            label: `Study bridge ${kind} cancelled-request settlement`,
            setTimer,
            clearTimer
          });
        } catch (error) {
          requestWaitUncertain = true;
          fail("cleanup-uncertain", `Study bridge ${kind} request wait did not settle after cancellation.`, {
            cause: error
          });
        }
        if (settlement.type === "request") {
          original = settlement.original;
        } else {
          if (settlement.error?.code !== "aborted") requestWaitUncertain = true;
          throw interruptionError;
        }
      }
    } finally {
      clearTimer(timer);
      removeAbort();
      requestAbort.abort("parent-request-wait-settled");
    }
    pendingResponderRequest = original;
    requestWaitUncertain = true;
    const request = validateDataWranglerStudyBridgeRequest(original);
    if (request.sequence !== sequence || request.kind !== kind || request.runId !== runId || request.phase !== phase) {
      fail("sequence-drift", `Study bridge expected sequence ${sequence} kind ${kind}.`);
    }
    const requestTime = nanoseconds(request.monotonicNanoseconds, `Study bridge ${kind} request`);
    if (previousAcknowledgementNanoseconds !== null && requestTime < previousAcknowledgementNanoseconds) {
      fail("sequence-drift", `Study bridge ${kind} request predates the previous acknowledgement.`);
    }
    state.pendingRequest = request;
    requestWaitUncertain = false;
    if (interruptionError !== undefined) throw interruptionError;
    if (signal.aborted) throw abortError();
    return { original, request };
  };

  const assertCollectorActive = (label) => {
    if (signal.aborted) throw abortError();
    if (!collectionSettled) return;
    if (collectionSettlement?.status === "rejected") {
      fail("sampler-invalid", `PSS collector failed before ${label}.`, { cause: collectionSettlement.error });
    }
    fail("sampler-invalid", `PSS collector ended before ${label}.`);
  };

  const acknowledge = ({ original, request }, { monitorCollector = false, notBeforeNanoseconds = null } = {}) => {
    if (signal.aborted) throw abortError();
    if (monitorCollector) assertCollectorActive(`${request.kind} acknowledgement`);
    acknowledgementUncertain = request;
    const result = responder.acknowledge(original);
    if (result && typeof result.then === "function") {
      fail("invalid-dependency", "Study bridge acknowledgement must be published synchronously.");
    }
    const acknowledgement = validateDataWranglerStudyBridgeAcknowledgement(result);
    if (
      acknowledgement.sequence !== request.sequence ||
      acknowledgement.kind !== request.kind ||
      acknowledgement.runId !== request.runId ||
      acknowledgement.phase !== request.phase
    ) {
      fail("bridge-mismatch", "Study bridge acknowledgement does not match its exact request.");
    }
    const acknowledgementTime = nanoseconds(
      acknowledgement.monotonicNanoseconds,
      `Study bridge ${request.kind} acknowledgement`
    );
    if (acknowledgementTime < nanoseconds(request.monotonicNanoseconds, `Study bridge ${request.kind} request`)) {
      fail("clock-mismatch", `Study bridge ${request.kind} acknowledgement predates its request.`);
    }
    const baseline = {
      "inline-baseline": state.baselines.inline,
      "workbench-baseline": state.baselines.workbench,
      "profile-baseline": state.baselines.profile
    }[request.kind];
    if (
      baseline?.receipt !== null &&
      baseline?.receipt !== undefined &&
      acknowledgementTime <
        nanoseconds(baseline.receipt.sampleEndedMonotonicNanoseconds, `${request.kind} stable sample end`)
    ) {
      fail("clock-mismatch", `Study bridge ${request.kind} acknowledgement predates its stable sample.`);
    }
    if (notBeforeNanoseconds !== null && acknowledgementTime < notBeforeNanoseconds) {
      fail("clock-mismatch", `Study bridge ${request.kind} acknowledgement predates its retained evidence.`);
    }
    previousAcknowledgementNanoseconds = acknowledgementTime;
    sequence += 1;
    const completed = Object.freeze({ request, acknowledgement });
    state.completedExchanges.push(completed);
    state.pendingRequest = null;
    pendingResponderRequest = null;
    acknowledgementUncertain = null;
    return completed;
  };

  const exchange = async (kind, beforeAcknowledgement, monitorCollector = false) => {
    const pending = await waitForRequest(kind, monitorCollector);
    const evidence = beforeAcknowledgement === undefined ? undefined : await beforeAcknowledgement(pending.request);
    if (monitorCollector) {
      await Promise.resolve();
      assertCollectorActive(`${kind} acknowledgement`);
    }
    return { exchange: acknowledge(pending, { monitorCollector }), evidence };
  };

  const onSample = (value) => {
    let receipt;
    try {
      receipt = validateStableBaselineReceipt(value);
    } catch (error) {
      if (baselineWaiter !== null) baselineWaiter.reject(error);
      throw error;
    }
    if (receipt !== null) latestBaseline = receipt;
    if (baselineWaiter !== null && baselineQualifies(latestBaseline, baselineWaiter.request)) {
      const waiter = baselineWaiter;
      baselineWaiter = null;
      waiter.resolve(latestBaseline);
    }
  };

  const startCollector = () => {
    let result;
    collectorInvoked = true;
    try {
      result = collectObservation({
        ...collectionOptions,
        sampler,
        signal: collectorAbort.signal,
        intervalMs: 200,
        onSample,
        getTerminalBoundaryNanoseconds: () => terminalTarget
      });
    } catch (error) {
      fail("sampler-invalid", "PSS collector failed before sampling began.", { cause: error });
    }
    if (!result || typeof result.then !== "function") {
      fail("invalid-dependency", "PSS collector must return a promise.");
    }
    collectionPromise = Promise.resolve(result).then(
      (observation) => {
        collectionSettled = true;
        collectionSettlement = { status: "fulfilled", observation };
        if (baselineWaiter !== null) {
          baselineWaiter.reject(
            new DataWranglerComparisonTrialControlError(
              "sampler-invalid",
              "PSS collector ended before the requested stable baseline."
            )
          );
          baselineWaiter = null;
        }
        return observation;
      },
      (error) => {
        collectionSettled = true;
        collectionSettlement = { status: "rejected", error };
        if (baselineWaiter !== null) {
          baselineWaiter.reject(
            new DataWranglerComparisonTrialControlError("sampler-invalid", "PSS collector failed.", { cause: error })
          );
          baselineWaiter = null;
        }
        throw error;
      }
    );
    collectionPromise.catch(() => {});
    collectorSettlementFailure = collectionPromise.then(
      () => {
        throw new DataWranglerComparisonTrialControlError(
          "sampler-invalid",
          "PSS collector ended before the sampling-stop terminal boundary."
        );
      },
      (error) => {
        throw new DataWranglerComparisonTrialControlError("sampler-invalid", "PSS collector failed.", {
          cause: error
        });
      }
    );
    collectorSettlementFailure.catch(() => {});
  };

  const waitForStableBaseline = async (request) => {
    if (baselineWaiter !== null) fail("sequence-drift", "More than one stable-baseline request is pending.");
    if (baselineQualifies(latestBaseline, request)) return latestBaseline;
    if (collectionSettled) {
      fail("sampler-invalid", "PSS collector ended before the requested stable baseline.");
    }
    const promise = new Promise((resolveBaseline, rejectBaseline) => {
      baselineWaiter = { request, resolve: resolveBaseline, reject: rejectBaseline };
    });
    try {
      return await guarded(promise, baselineTimeoutMs, `${request.kind} stable baseline`, [collectorSettlementFailure]);
    } finally {
      baselineWaiter = null;
    }
  };

  let primaryError;
  try {
    failureStage = "sampling-start";
    startCollector();
    await Promise.resolve();
    assertCollectorActive("source verification");

    await exchange("source-verified", undefined, true);
    if (cacheState === "cold") {
      await exchange(
        "cold-cache-evicted",
        async (request) => {
          const proof = await guarded(
            Promise.resolve().then(() => evictColdCache({ request: structuredClone(request) })),
            cacheEvictionTimeoutMs,
            "Cold-cache eviction",
            [collectorSettlementFailure]
          );
          if (!isRecord(proof)) fail("cache-eviction", "Cold-cache eviction did not return its proof.");
          state.coldCacheProof = Object.freeze(structuredClone(proof));
        },
        true
      );
    }
    await exchange("measurement-ready", undefined, true);

    const samplingOriginPending = await waitForRequest("sampling-origin", true);
    await Promise.resolve();
    assertCollectorActive("sampling-origin acknowledgement");
    acknowledge(samplingOriginPending, { monitorCollector: true });

    const inline = await exchange(
      "inline-baseline",
      async (request) => {
        state.baselines.inline = { request, acknowledgement: null, receipt: null };
        const baseline = await waitForStableBaseline(request);
        state.baselines.inline.receipt = baseline;
        await Promise.resolve();
        assertCollectorActive("inline action authorization");
        if (signal.aborted) throw abortError();
        if (authorizationPerformed) fail("duplicate-authorization", "Product action was authorized more than once.");
        authorizationPerformed = true;
        const authorization = authorizeAction();
        if (authorization && typeof authorization.then === "function") {
          fail("authorization", "Product-action authorization must finish synchronously before acknowledgement.");
        }
        state.authorization = validateAuthorizationReceipt(authorization, runId);
      },
      true
    );
    state.baselines.inline.acknowledgement = inline.exchange.acknowledgement;
    const workbench = await exchange(
      "workbench-baseline",
      async (request) => {
        state.baselines.workbench = { request, acknowledgement: null, receipt: null };
        state.baselines.workbench.receipt = await waitForStableBaseline(request);
      },
      true
    );
    state.baselines.workbench.acknowledgement = workbench.exchange.acknowledgement;
    const profile = await exchange(
      "profile-baseline",
      async (request) => {
        state.baselines.profile = { request, acknowledgement: null, receipt: null };
        state.baselines.profile.receipt = await waitForStableBaseline(request);
      },
      true
    );
    state.baselines.profile.acknowledgement = profile.exchange.acknowledgement;

    const samplingStopPending = await waitForRequest("sampling-stop", true);
    terminalTarget =
      nanoseconds(samplingStopPending.request.monotonicNanoseconds, "Study sampling-stop request") +
      TERMINAL_DELAY_NANOSECONDS;
    state.samplingStop = {
      request: samplingStopPending.request,
      acknowledgement: null,
      terminalTargetMonotonicNanoseconds: terminalTarget.toString()
    };
    const observation = await guarded(collectionPromise, terminalTimeoutMs, "PSS first eligible terminal sample");
    validateObservationAndBaselines(observation, terminalTarget, [
      state.baselines.inline.receipt,
      state.baselines.workbench.receipt,
      state.baselines.profile.receipt
    ]);
    state.resourceObservation = observation;
    const terminalSampleEnded = nanoseconds(
      observation.terminalBoundary.firstEligibleSampleEndedMonotonicNanoseconds,
      "PSS terminal sample end"
    );
    const samplingStop = acknowledge(samplingStopPending, { notBeforeNanoseconds: terminalSampleEnded });
    state.samplingStop.acknowledgement = samplingStop.acknowledgement;

    await exchange("cleanup-census");
  } catch (error) {
    primaryError = error;
  }

  const settlementErrors = [];
  if (primaryError !== undefined && state.pendingRequest !== null && acknowledgementUncertain === null) {
    try {
      const abandonment = responder.abandon(pendingResponderRequest);
      if (abandonment && typeof abandonment.then === "function") {
        fail("invalid-dependency", "Study bridge abandonment must consume its request synchronously.");
      }
      state.abandonedRequest = Object.freeze({ request: state.pendingRequest, abandonment });
      state.pendingRequest = null;
      pendingResponderRequest = null;
    } catch (error) {
      settlementErrors.push(
        new DataWranglerComparisonTrialControlError(
          "cleanup-uncertain",
          "Measured-trial failure could not abandon its exact unacknowledged bridge request.",
          { cause: error }
        )
      );
    }
  }
  if (primaryError !== undefined && acknowledgementUncertain !== null) {
    settlementErrors.push(
      new DataWranglerComparisonTrialControlError(
        "acknowledgement-uncertain",
        `Study bridge ${acknowledgementUncertain.kind} acknowledgement publication is indeterminate.`
      )
    );
  }
  if (primaryError !== undefined && requestWaitUncertain) {
    settlementErrors.push(
      new DataWranglerComparisonTrialControlError(
        "cleanup-uncertain",
        "Study bridge request state is indeterminate after a failed wait or malformed request."
      )
    );
  }
  if (primaryError !== undefined && collectorInvoked && !collectorAbort.signal.aborted) {
    collectorAbort.abort(primaryError);
  }
  if (primaryError !== undefined && collectionPromise !== undefined) {
    if (!collectionSettled) {
      try {
        await awaitBounded(collectionPromise, {
          timeoutMs: abortSettlementTimeoutMs,
          label: "PSS collector abort settlement",
          setTimer,
          clearTimer
        });
      } catch (error) {
        settlementErrors.push(error);
      }
    }
    if (collectionSettlement?.status === "rejected") {
      settlementErrors.push(collectionSettlement.error);
    } else if (collectionSettlement?.status === "fulfilled") {
      try {
        state.resourceObservation = validatePartialResourceObservation(collectionSettlement.observation);
      } catch (error) {
        settlementErrors.push(error);
      }
    }
  }
  signal.removeEventListener("abort", propagateAbort);
  if (primaryError !== undefined && settlementErrors.length !== 0) {
    throw new AggregateError(
      [primaryError, ...settlementErrors],
      "Measured-trial control failed without a safe bridge or resource-evidence settlement."
    );
  }
  if (primaryError !== undefined) {
    if (collectionPromise === undefined || state.resourceObservation === null) throw primaryError;
    return createControlReceipt({
      runId,
      phase,
      cacheState,
      state,
      status: "failed",
      failure: Object.freeze({ stage: failureStage, kind: boundedFailureKind(primaryError) })
    });
  }
  return createControlReceipt({ runId, phase, cacheState, state, status: "success", failure: null });
}
