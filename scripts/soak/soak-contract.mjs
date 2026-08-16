import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdtemp, open } from "node:fs/promises";
import { join } from "node:path";
import { redactEditorAcceptanceJson } from "../editor-acceptance-evidence.mjs";

export const SOAK_RECEIPT_SCHEMA = "openwrangler-runtime-soak-v1";
export const SOAK_PRNG = "lcg32-numerical-recipes-v1";
export const SOAK_MAX_RECEIPT_BYTES = 16 * 1024;
export const SOAK_SCENARIOS = Object.freeze([
  "open_page_close",
  "invalid_protocol",
  "unknown_session",
  "crash_restart"
]);

const DEFAULT_OPTIONS = Object.freeze({
  seed: 1_592_639_710,
  iterations: 1_000,
  durationSeconds: 3_600,
  wallSeconds: 3_660
});
const MAX_ITERATIONS = 10_000_000;
const MAX_DURATION_SECONDS = 1_209_600;
const MAX_WALL_SECONDS = 1_210_200;
const MAX_COMPLETED_ITERATIONS = 100_000_000;
const FAILURE_SETTLEMENT_MAX_MS = 10_000;
const SHA256 = /^[a-f0-9]{64}$/u;
const GIT_OBJECT_ID = /^[a-f0-9]{40}$/u;
const VERSION =
  /^(?:unknown|(?:0|[1-9]\d{0,5})(?:\.(?:0|[1-9]\d{0,5})){0,3}(?:-(?:dev|insider|oss|preview)(?:\.[0-9]{1,10})?)?)$/u;
const RUN_ID = /^(?:[0-9]{1,20}|[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12})$/u;
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;

const FAILURE_CODES = Object.freeze([
  "deadline_exceeded",
  "interrupted",
  "runtime_start_failed",
  "runtime_exit",
  "protocol_timeout",
  "protocol_invalid",
  "scenario_failed",
  "cleanup_failed",
  "iteration_limit"
]);
const PHASES = Object.freeze(["prepare", "initialize", ...SOAK_SCENARIOS, "cleanup"]);

export class SoakContractError extends Error {
  constructor(message) {
    super(message);
    this.name = "SoakContractError";
  }
}

export class SoakRunError extends Error {
  constructor(code, phase) {
    super(`${code}:${phase}`);
    this.name = "SoakRunError";
    this.code = FAILURE_CODES.includes(code) ? code : "scenario_failed";
    this.phase = PHASES.includes(phase) ? phase : "prepare";
  }
}

function exactRecord(value, required, optional = []) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new SoakContractError("Soak receipt values must be plain objects.");
  }
  const allowed = new Set([...required, ...optional]);
  const keys = Object.keys(value);
  if (required.some((key) => !Object.hasOwn(value, key)) || keys.some((key) => !allowed.has(key))) {
    throw new SoakContractError("Soak receipt values contain missing or unsupported fields.");
  }
  return value;
}

function boundedInteger(value, minimum, maximum, label) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new SoakContractError(`${label} is outside its supported range.`);
  }
  return value;
}

function parseDecimal(value, minimum, maximum, label) {
  if (typeof value !== "string" || !/^(?:0|[1-9]\d*)$/u.test(value)) {
    throw new SoakContractError(`${label} must be a canonical decimal integer.`);
  }
  return boundedInteger(Number(value), minimum, maximum, label);
}

export function parseSoakArguments(args) {
  if (!Array.isArray(args)) throw new SoakContractError("Soak arguments must be an array.");
  if (args.length === 1 && args[0] === "--help") return Object.freeze({ help: true });
  const values = { ...DEFAULT_OPTIONS };
  const seen = new Set();
  const definitions = new Map([
    ["--seed", ["seed", 0, 0xffff_ffff]],
    ["--iterations", ["iterations", SOAK_SCENARIOS.length, MAX_ITERATIONS]],
    ["--duration-seconds", ["durationSeconds", 0, MAX_DURATION_SECONDS]],
    ["--wall-seconds", ["wallSeconds", 1, MAX_WALL_SECONDS]]
  ]);
  for (let index = 0; index < args.length; index += 2) {
    const option = args[index];
    const definition = definitions.get(option);
    if (!definition || index + 1 >= args.length || seen.has(option)) {
      throw new SoakContractError("Soak arguments contain an unsupported, missing, or repeated option.");
    }
    seen.add(option);
    const [field, minimum, maximum] = definition;
    values[field] = parseDecimal(args[index + 1], minimum, maximum, option);
  }
  if (values.wallSeconds <= values.durationSeconds) {
    throw new SoakContractError("--wall-seconds must be greater than --duration-seconds.");
  }
  return Object.freeze(values);
}

export function soakUsage() {
  return [
    "Usage: node scripts/soak/runtime-soak.mjs [options]",
    "  --seed <0..4294967295>",
    `  --iterations <${SOAK_SCENARIOS.length}..${MAX_ITERATIONS}>`,
    `  --duration-seconds <0..${MAX_DURATION_SECONDS}>`,
    `  --wall-seconds <1..${MAX_WALL_SECONDS}>`,
    "The run is local-only, has no retries, and creates no success artifact."
  ].join("\n");
}

export function sha256Hex(value) {
  return createHash("sha256").update(value).digest("hex");
}

export const SOAK_SCENARIO_SET_SHA256 = sha256Hex(
  JSON.stringify({ schema: "openwrangler-runtime-soak-scenarios-v1", scenarios: SOAK_SCENARIOS })
);

export function createScenarioSelector(seed) {
  let state = boundedInteger(seed, 0, 0xffff_ffff, "seed") >>> 0;
  let remaining = [];
  const random = () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state;
  };
  return Object.freeze({
    next() {
      if (remaining.length === 0) {
        remaining = [...SOAK_SCENARIOS];
        for (let index = remaining.length - 1; index > 0; index -= 1) {
          const replacement = random() % (index + 1);
          [remaining[index], remaining[replacement]] = [remaining[replacement], remaining[index]];
        }
      }
      return remaining.shift();
    }
  });
}

export function createRunIdentifiers() {
  return Object.freeze({ runId: randomUUID(), jobId: randomUUID() });
}

function validatedSubject(value) {
  const candidate = exactRecord(value, [
    "kind",
    "sourceCommit",
    "sourceTree",
    "executedInventorySha256",
    "packageManifestSha256",
    "dependencyLockSha256"
  ]);
  if (candidate.kind !== "source_tree") throw new SoakContractError("The soak subject kind is invalid.");
  if (typeof candidate.sourceCommit !== "string" || !GIT_OBJECT_ID.test(candidate.sourceCommit)) {
    throw new SoakContractError("The source commit is invalid.");
  }
  if (typeof candidate.sourceTree !== "string" || !GIT_OBJECT_ID.test(candidate.sourceTree)) {
    throw new SoakContractError("The source tree is invalid.");
  }
  for (const field of ["executedInventorySha256", "packageManifestSha256", "dependencyLockSha256"]) {
    if (typeof candidate[field] !== "string" || !SHA256.test(candidate[field])) {
      throw new SoakContractError("A source subject digest is invalid.");
    }
  }
  return Object.freeze({
    kind: "source_tree",
    sourceCommit: candidate.sourceCommit,
    sourceTree: candidate.sourceTree,
    executedInventorySha256: candidate.executedInventorySha256,
    packageManifestSha256: candidate.packageManifestSha256,
    dependencyLockSha256: candidate.dependencyLockSha256
  });
}

function validatedTools(value) {
  const candidate = exactRecord(value, [
    "platform",
    "nodeVersion",
    "pythonVersion",
    "runtimeVersion",
    "backend",
    "backendVersion"
  ]);
  if (!["linux", "macos", "windows", "other"].includes(candidate.platform)) {
    throw new SoakContractError("The soak platform is invalid.");
  }
  for (const field of ["nodeVersion", "pythonVersion", "runtimeVersion", "backendVersion"]) {
    if (typeof candidate[field] !== "string" || !VERSION.test(candidate[field])) {
      throw new SoakContractError("A soak tool version is invalid.");
    }
  }
  if (candidate.backend !== "pandas") throw new SoakContractError("The soak backend is invalid.");
  return Object.freeze({
    platform: candidate.platform,
    nodeVersion: candidate.nodeVersion,
    pythonVersion: candidate.pythonVersion,
    runtimeVersion: candidate.runtimeVersion,
    backend: "pandas",
    backendVersion: candidate.backendVersion
  });
}

function validatedCounters(value, completedIterations) {
  if (!Array.isArray(value) || value.length !== SOAK_SCENARIOS.length) {
    throw new SoakContractError("Soak branch counters must cover the exact scenario set.");
  }
  let total = 0;
  const counters = value.map((entry, index) => {
    const counter = exactRecord(entry, ["scenario", "count"]);
    if (counter.scenario !== SOAK_SCENARIOS[index]) {
      throw new SoakContractError("Soak branch counters are not in canonical order.");
    }
    const count = boundedInteger(counter.count, 0, MAX_COMPLETED_ITERATIONS, "scenario count");
    total += count;
    return Object.freeze({ scenario: counter.scenario, count });
  });
  if (total !== completedIterations) throw new SoakContractError("Soak branch counters are inconsistent.");
  return Object.freeze(counters);
}

function validatedRun(value) {
  const candidate = exactRecord(value, [
    "runId",
    "jobId",
    "prng",
    "seed",
    "scenarioSetSha256",
    "requestedIterations",
    "requestedDurationSeconds",
    "wallSeconds",
    "completedIterations",
    "startedAt",
    "endedAt",
    "elapsedMs",
    "branches"
  ]);
  if (typeof candidate.runId !== "string" || !RUN_ID.test(candidate.runId)) {
    throw new SoakContractError("The soak run ID is invalid.");
  }
  if (typeof candidate.jobId !== "string" || !RUN_ID.test(candidate.jobId)) {
    throw new SoakContractError("The soak job ID is invalid.");
  }
  if (candidate.prng !== SOAK_PRNG || candidate.scenarioSetSha256 !== SOAK_SCENARIO_SET_SHA256) {
    throw new SoakContractError("The soak scenario or PRNG contract is invalid.");
  }
  const seed = boundedInteger(candidate.seed, 0, 0xffff_ffff, "seed");
  const requestedIterations = boundedInteger(
    candidate.requestedIterations,
    SOAK_SCENARIOS.length,
    MAX_ITERATIONS,
    "requested iterations"
  );
  const requestedDurationSeconds = boundedInteger(
    candidate.requestedDurationSeconds,
    0,
    MAX_DURATION_SECONDS,
    "requested duration"
  );
  const wallSeconds = boundedInteger(candidate.wallSeconds, 1, MAX_WALL_SECONDS, "wall duration");
  if (wallSeconds <= requestedDurationSeconds) {
    throw new SoakContractError("The soak wall duration must exceed the requested duration.");
  }
  const completedIterations = boundedInteger(
    candidate.completedIterations,
    0,
    MAX_COMPLETED_ITERATIONS,
    "completed iterations"
  );
  if (
    typeof candidate.startedAt !== "string" ||
    !ISO_TIMESTAMP.test(candidate.startedAt) ||
    typeof candidate.endedAt !== "string" ||
    !ISO_TIMESTAMP.test(candidate.endedAt)
  ) {
    throw new SoakContractError("Soak timestamps are invalid.");
  }
  if (Date.parse(candidate.endedAt) < Date.parse(candidate.startedAt)) {
    throw new SoakContractError("The soak end timestamp precedes its start timestamp.");
  }
  const elapsedMs = boundedInteger(candidate.elapsedMs, 0, MAX_WALL_SECONDS * 1_000, "elapsed time");
  return Object.freeze({
    runId: candidate.runId,
    jobId: candidate.jobId,
    prng: SOAK_PRNG,
    seed,
    scenarioSetSha256: SOAK_SCENARIO_SET_SHA256,
    requestedIterations,
    requestedDurationSeconds,
    wallSeconds,
    completedIterations,
    startedAt: candidate.startedAt,
    endedAt: candidate.endedAt,
    elapsedMs,
    branches: validatedCounters(candidate.branches, completedIterations)
  });
}

function validatedFailure(value, completedIterations) {
  if (value === undefined) return undefined;
  const candidate = exactRecord(value, ["code", "phase", "iteration"]);
  if (!FAILURE_CODES.includes(candidate.code) || !PHASES.includes(candidate.phase)) {
    throw new SoakContractError("The soak failure classification is invalid.");
  }
  const maximumIteration = Math.min(MAX_COMPLETED_ITERATIONS, completedIterations + 1);
  const iteration = boundedInteger(candidate.iteration, 0, maximumIteration, "failure iteration");
  return Object.freeze({ code: candidate.code, phase: candidate.phase, iteration });
}

export function createSoakReceipt(value) {
  const candidate = exactRecord(value, ["outcome", "subject", "tools", "run"], ["failure"]);
  if (candidate.outcome !== "success" && candidate.outcome !== "failure") {
    throw new SoakContractError("The soak outcome is invalid.");
  }
  const run = validatedRun(candidate.run);
  const failure = validatedFailure(candidate.failure, run.completedIterations);
  if ((candidate.outcome === "failure") !== (failure !== undefined)) {
    throw new SoakContractError("The soak outcome and failure fields are inconsistent.");
  }
  if (
    candidate.outcome === "success" &&
    (run.completedIterations < run.requestedIterations || run.elapsedMs < run.requestedDurationSeconds * 1_000)
  ) {
    throw new SoakContractError("A successful soak did not satisfy its requested bounds.");
  }
  const maximumElapsedMs = run.wallSeconds * 1_000 + (failure ? FAILURE_SETTLEMENT_MAX_MS : 0);
  if (run.elapsedMs > maximumElapsedMs) {
    throw new SoakContractError("The soak elapsed time exceeds its fixed wall and settlement bound.");
  }
  const payload = Object.freeze({
    outcome: candidate.outcome,
    subject: validatedSubject(candidate.subject),
    tools: validatedTools(candidate.tools),
    run,
    ...(failure ? { failure } : {})
  });
  const payloadJson = JSON.stringify(payload);
  const envelope = Object.freeze({
    schema: SOAK_RECEIPT_SCHEMA,
    payloadSha256: sha256Hex(payloadJson),
    payload
  });
  const json = `${JSON.stringify(envelope)}\n`;
  const byteLength = Buffer.byteLength(json, "utf8");
  if (byteLength > SOAK_MAX_RECEIPT_BYTES) throw new SoakContractError("The soak receipt exceeds its byte limit.");
  return Object.freeze({ envelope, json, byteLength });
}

export async function writeFailureReceipt(receipt, parentDirectory) {
  if (receipt.envelope?.payload?.outcome !== "failure") {
    throw new SoakContractError("Only failure receipts may be retained.");
  }
  const redacted = redactEditorAcceptanceJson(receipt.json, [], SOAK_MAX_RECEIPT_BYTES);
  if (typeof redacted !== "string") throw new SoakContractError("The failure receipt did not pass redaction.");
  const resealed = redactEditorAcceptanceJson(redacted, [], SOAK_MAX_RECEIPT_BYTES);
  if (resealed !== redacted) throw new SoakContractError("The failure receipt was not stable under re-redaction.");
  const parsed = JSON.parse(redacted);
  const verified = createSoakReceipt(parsed.payload);
  if (verified.json.trim() !== redacted.trim()) {
    throw new SoakContractError("The failure receipt changed during schema revalidation.");
  }
  const root = await mkdtemp(join(parentDirectory, "openwrangler-soak-failure-"));
  const rootStat = await lstat(root);
  if (
    !rootStat.isDirectory() ||
    rootStat.isSymbolicLink() ||
    (process.platform !== "win32" && (rootStat.uid !== process.getuid() || (rootStat.mode & 0o077) !== 0))
  ) {
    throw new SoakContractError("The failure receipt directory is not privately owned.");
  }
  const path = join(root, "failure.json");
  const fileText = redacted.endsWith("\n") ? redacted : `${redacted}\n`;
  const byteLength = Buffer.byteLength(fileText, "utf8");
  if (byteLength > SOAK_MAX_RECEIPT_BYTES) {
    throw new SoakContractError("The retained failure receipt exceeds its byte limit.");
  }
  const handle = await open(path, "wx", 0o600);
  try {
    await handle.writeFile(fileText, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  return Object.freeze({ path, byteLength });
}

export function maximumCompletedIterations() {
  return MAX_COMPLETED_ITERATIONS;
}
