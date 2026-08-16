import { spawnSync } from "node:child_process";
import { accessSync, constants as fsConstants, realpathSync } from "node:fs";
import { delimiter, isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const root = resolve(import.meta.dirname, "..");
const FRAME_CONTRACT_TIMEOUT_MS = 120_000;
const KERNEL_AGENT_TIMEOUT_MS = 360_000;
const CATALOG_CONTRACT_TIMEOUT_MS = 120_000;
const SHORT_VITEST_PHASE_TIMEOUT_MS = 60_000;
const TRANSPORT_VITEST_PHASE_TIMEOUT_MS = 90_000;

// Rounded-up hosted R 4.4/4.5 measurements recorded on 2026-08-16. These are
// deterministic sharding weights only; phase deadlines remain unchanged.
const FRAME_CONTRACT_WORKLOAD_MS = 31_000;
const KERNEL_AGENT_WORKLOAD_MS = 348_000;
const CATALOG_CONTRACT_WORKLOAD_MS = 45_000;
const TYPESCRIPT_CONTRACT_WORKLOAD_MS = 11_000;
const KERNEL_TRANSPORT_WORKLOAD_MS = 56_000;
const PROCESS_TRANSPORT_WORKLOAD_MS = 40_000;
const INTERACTIVE_TRANSPORT_WORKLOAD_MS = 11_000;

export const R_CONTRACT_SHARDS = Object.freeze([
  Object.freeze({ id: "kernel-agent", phaseIds: Object.freeze(["kernel-agent"]) }),
  Object.freeze({
    id: "frame-transport",
    phaseIds: Object.freeze(["frame", "kernel-transport", "interactive-transport"])
  }),
  Object.freeze({
    id: "catalog-transport",
    phaseIds: Object.freeze(["catalog", "typescript", "process-transport"])
  })
]);

function resolveExecutable(command) {
  const candidates = isAbsolute(command)
    ? [command]
    : (process.env.PATH ?? "")
        .split(delimiter)
        .filter(Boolean)
        .flatMap((entry) =>
          process.platform === "win32"
            ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT")
                .split(";")
                .map((extension) => resolve(entry, `${command}${extension}`))
            : [resolve(entry, command)]
        );
  for (const candidate of candidates) {
    try {
      accessSync(candidate, fsConstants.X_OK);
      return realpathSync(candidate);
    } catch {
      // Keep searching the caller's PATH.
    }
  }
  throw new Error(`Could not find the requested Rscript executable: ${command}`);
}

function vitestPhase(id, label, files, timeoutMs, workloadMs, { environment, node, vitest }) {
  return Object.freeze({
    id,
    label,
    command: node,
    args: Object.freeze([vitest, "run", ...files, "--maxWorkers=1"]),
    environment,
    timeoutMs,
    workloadMs
  });
}

export function createRContractPhases({
  environment,
  node = process.execPath,
  r,
  rscript,
  vitest = "node_modules/vitest/vitest.mjs"
}) {
  const rEnvironment = Object.freeze({ ...environment, R: r, RSCRIPT: rscript });
  const vitestEnvironment = Object.freeze({ ...rEnvironment, OPEN_WRANGLER_R_CONTRACT_TESTS: "1" });
  return Object.freeze([
    Object.freeze({
      id: "frame",
      label: "native frame contract",
      command: rscript,
      args: Object.freeze(["--vanilla", "r/tests/frame_contract.R"]),
      environment: rEnvironment,
      timeoutMs: FRAME_CONTRACT_TIMEOUT_MS,
      workloadMs: FRAME_CONTRACT_WORKLOAD_MS
    }),
    Object.freeze({
      id: "kernel-agent",
      label: "native kernel-agent contract",
      command: rscript,
      args: Object.freeze(["--vanilla", "r/tests/kernel_agent.R"]),
      environment: rEnvironment,
      timeoutMs: KERNEL_AGENT_TIMEOUT_MS,
      workloadMs: KERNEL_AGENT_WORKLOAD_MS
    }),
    Object.freeze({
      id: "catalog",
      label: "complete native catalog contract",
      command: rscript,
      args: Object.freeze(["--vanilla", "r/tests/complete_catalog_contract.R"]),
      environment: rEnvironment,
      timeoutMs: CATALOG_CONTRACT_TIMEOUT_MS,
      workloadMs: CATALOG_CONTRACT_WORKLOAD_MS
    }),
    vitestPhase(
      "typescript",
      "TypeScript R frame and unit contracts",
      [
        "src/test/rFrameContract.unit.test.ts",
        "src/test/rFrameContract.cross.test.ts",
        "src/test/rKernelTransport.unit.test.ts"
      ],
      SHORT_VITEST_PHASE_TIMEOUT_MS,
      TYPESCRIPT_CONTRACT_WORKLOAD_MS,
      { environment: vitestEnvironment, node, vitest }
    ),
    vitestPhase(
      "kernel-transport",
      "real-R kernel transport contract",
      ["src/test/rKernelTransport.cross.test.ts"],
      TRANSPORT_VITEST_PHASE_TIMEOUT_MS,
      KERNEL_TRANSPORT_WORKLOAD_MS,
      { environment: vitestEnvironment, node, vitest }
    ),
    vitestPhase(
      "process-transport",
      "real-R process transport contract",
      ["src/test/rProcessTransport.cross.test.ts"],
      TRANSPORT_VITEST_PHASE_TIMEOUT_MS,
      PROCESS_TRANSPORT_WORKLOAD_MS,
      { environment: vitestEnvironment, node, vitest }
    ),
    vitestPhase(
      "interactive-transport",
      "real-R interactive transport contract",
      ["src/test/rInteractiveSessionTransport.cross.test.ts"],
      SHORT_VITEST_PHASE_TIMEOUT_MS,
      INTERACTIVE_TRANSPORT_WORKLOAD_MS,
      { environment: vitestEnvironment, node, vitest }
    )
  ]);
}

function validatedPhaseMap(phases) {
  if (!Array.isArray(phases) || phases.length === 0) {
    throw new Error("R contract phases must be a non-empty array.");
  }
  const phaseById = new Map();
  for (const phase of phases) {
    if (!phase || typeof phase.id !== "string" || phase.id.length === 0) {
      throw new Error("Every R contract phase must have a non-empty ID.");
    }
    if (phaseById.has(phase.id)) throw new Error(`Duplicate R contract phase ID: ${phase.id}`);
    if (
      !Number.isSafeInteger(phase.workloadMs) ||
      phase.workloadMs <= 0 ||
      !Number.isSafeInteger(phase.timeoutMs) ||
      phase.workloadMs > phase.timeoutMs
    ) {
      throw new Error(`R contract phase ${phase.id} has an invalid bounded workload measurement.`);
    }
    phaseById.set(phase.id, phase);
  }

  const shardedPhaseIds = new Set();
  const shardIds = new Set();
  for (const shard of R_CONTRACT_SHARDS) {
    if (!shard.id || shardIds.has(shard.id)) throw new Error(`Invalid or duplicate R contract shard ID: ${shard.id}`);
    shardIds.add(shard.id);
    if (!shard.phaseIds.length) throw new Error(`R contract shard ${shard.id} must not be empty.`);
    for (const phaseId of shard.phaseIds) {
      if (!phaseById.has(phaseId)) {
        throw new Error(`R contract shard ${shard.id} selects unknown phase ${phaseId}.`);
      }
      if (shardedPhaseIds.has(phaseId)) {
        throw new Error(`R contract phase ${phaseId} appears in more than one configured shard.`);
      }
      shardedPhaseIds.add(phaseId);
    }
  }
  if (shardedPhaseIds.size !== phaseById.size) {
    const missing = [...phaseById.keys()].filter((phaseId) => !shardedPhaseIds.has(phaseId));
    throw new Error(`R contract shards do not cover phases: ${missing.join(", ")}`);
  }
  return phaseById;
}

export function selectRContractPhases(phases, selections) {
  const phaseById = validatedPhaseMap(phases);
  if (!Array.isArray(selections)) throw new TypeError("R contract selections must be an array.");
  if (selections.length === 0) return phases;

  const shardById = new Map(R_CONTRACT_SHARDS.map((shard) => [shard.id, shard]));
  const selectedPhaseIds = new Set();
  const seenSelections = new Set();
  for (const selection of selections) {
    if (typeof selection !== "string") throw new TypeError("R contract selections must be strings.");
    const match = /^--(phase|shard)=(.*)$/u.exec(selection);
    if (!match) throw new Error(`Invalid R contract selection: ${selection}`);
    const [, kind, id] = match;
    if (id.length === 0) throw new Error(`R contract ${kind} selection must not be empty.`);
    const selectionKey = `${kind}:${id}`;
    if (seenSelections.has(selectionKey)) throw new Error(`Duplicate R contract selection: ${selection}`);
    seenSelections.add(selectionKey);

    const phaseIds = kind === "phase" ? (phaseById.has(id) ? [id] : undefined) : shardById.get(id)?.phaseIds;
    if (!phaseIds) throw new Error(`Unknown R contract ${kind}: ${id}`);
    for (const phaseId of phaseIds) {
      if (selectedPhaseIds.has(phaseId)) {
        throw new Error(`R contract phase ${phaseId} was selected more than once.`);
      }
      selectedPhaseIds.add(phaseId);
    }
  }
  if (selectedPhaseIds.size === 0) throw new Error("R contract selection must not be empty.");
  return Object.freeze(phases.filter((phase) => selectedPhaseIds.has(phase.id)));
}

function formattedSeconds(milliseconds) {
  return `${(milliseconds / 1000).toFixed(1)}s`;
}

export function runRContractPhase(
  phase,
  { now = () => performance.now(), spawn = spawnSync, writeLine = (line) => process.stdout.write(`${line}\n`) } = {}
) {
  const started = now();
  writeLine(`[r-contract] START ${phase.label}; timeout ${formattedSeconds(phase.timeoutMs)}`);
  const result = spawn(phase.command, phase.args, {
    cwd: root,
    encoding: "utf8",
    stdio: "inherit",
    timeout: phase.timeoutMs,
    env: phase.environment
  });
  const elapsed = Math.max(0, now() - started);
  if (result.error) {
    if (result.error.code === "ETIMEDOUT") {
      throw new Error(
        `[r-contract] TIMEOUT ${phase.label} after ${formattedSeconds(elapsed)}; phase limit ${formattedSeconds(phase.timeoutMs)}.`
      );
    }
    throw new Error(`[r-contract] ERROR ${phase.label} after ${formattedSeconds(elapsed)}: ${result.error.message}`, {
      cause: result.error
    });
  }
  if (result.status !== 0) {
    const outcome = result.status === null ? `signal ${result.signal ?? "unknown"}` : `exit ${result.status}`;
    throw new Error(`[r-contract] FAIL ${phase.label} after ${formattedSeconds(elapsed)} with ${outcome}.`);
  }
  writeLine(`[r-contract] PASS ${phase.label} in ${formattedSeconds(elapsed)}`);
}

export function runRContractPhases(phases, options) {
  for (const phase of phases) runRContractPhase(phase, options);
}

function main() {
  const rscript = resolveExecutable(process.env.RSCRIPT ?? "Rscript");
  const r = resolveExecutable(process.env.R ?? "R");
  const phases = createRContractPhases({ environment: process.env, r, rscript });
  runRContractPhases(selectRContractPhases(phases, process.argv.slice(2)));
}

function invokedDirectly() {
  if (!process.argv[1]) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
}

if (invokedDirectly()) main();
