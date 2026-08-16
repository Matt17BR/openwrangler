import { spawnSync } from "node:child_process";
import { accessSync, constants as fsConstants, realpathSync } from "node:fs";
import { delimiter, isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const root = resolve(import.meta.dirname, "..");
const FRAME_CONTRACT_TIMEOUT_MS = 120_000;
const KERNEL_AGENT_TIMEOUT_MS = 480_000;
const CATALOG_CONTRACT_TIMEOUT_MS = 120_000;
const SHORT_VITEST_PHASE_TIMEOUT_MS = 60_000;
const KERNEL_TRANSPORT_VITEST_PHASE_TIMEOUT_MS = 120_000;
const TRANSPORT_VITEST_PHASE_TIMEOUT_MS = 90_000;

export const R_CONTRACT_SHARDS = Object.freeze([
  Object.freeze({ id: "kernel-agent", phaseIds: Object.freeze(["kernel-agent"]) }),
  Object.freeze({
    id: "frame-and-interactive-transport",
    phaseIds: Object.freeze(["frame", "kernel-transport", "interactive-transport"])
  }),
  Object.freeze({
    id: "catalog-and-process-transport",
    phaseIds: Object.freeze(["catalog", "typescript-frame", "process-transport"])
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

function vitestPhase(id, label, files, timeoutMs, { environment, node, vitest }) {
  return Object.freeze({
    id,
    label,
    command: node,
    args: Object.freeze([vitest, "run", ...files, "--maxWorkers=1"]),
    environment,
    timeoutMs
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
      timeoutMs: FRAME_CONTRACT_TIMEOUT_MS
    }),
    Object.freeze({
      id: "kernel-agent",
      label: "native kernel-agent contract",
      command: rscript,
      args: Object.freeze(["--vanilla", "r/tests/kernel_agent.R"]),
      environment: rEnvironment,
      timeoutMs: KERNEL_AGENT_TIMEOUT_MS
    }),
    Object.freeze({
      id: "catalog",
      label: "complete native catalog contract",
      command: rscript,
      args: Object.freeze(["--vanilla", "r/tests/complete_catalog_contract.R"]),
      environment: rEnvironment,
      timeoutMs: CATALOG_CONTRACT_TIMEOUT_MS
    }),
    vitestPhase(
      "typescript-frame",
      "TypeScript R frame and unit contracts",
      [
        "src/test/rFrameContract.unit.test.ts",
        "src/test/rFrameContract.cross.test.ts",
        "src/test/rKernelTransport.unit.test.ts"
      ],
      SHORT_VITEST_PHASE_TIMEOUT_MS,
      { environment: vitestEnvironment, node, vitest }
    ),
    vitestPhase(
      "kernel-transport",
      "real-R kernel transport contract",
      ["src/test/rKernelTransport.cross.test.ts"],
      KERNEL_TRANSPORT_VITEST_PHASE_TIMEOUT_MS,
      { environment: vitestEnvironment, node, vitest }
    ),
    vitestPhase(
      "process-transport",
      "real-R process transport contract",
      ["src/test/rProcessTransport.cross.test.ts"],
      TRANSPORT_VITEST_PHASE_TIMEOUT_MS,
      { environment: vitestEnvironment, node, vitest }
    ),
    vitestPhase(
      "interactive-transport",
      "real-R interactive transport contract",
      ["src/test/rInteractiveSessionTransport.cross.test.ts"],
      SHORT_VITEST_PHASE_TIMEOUT_MS,
      { environment: vitestEnvironment, node, vitest }
    )
  ]);
}

export function parseRContractSelection(arguments_) {
  if (!Array.isArray(arguments_)) throw new TypeError("R contract arguments must be an array.");
  if (arguments_.length === 0) return Object.freeze({ kind: "all" });
  if (arguments_.length !== 2 || (arguments_[0] !== "--phase" && arguments_[0] !== "--shard")) {
    throw new Error("Usage: run-r-contract-tests.mjs [--phase <phase-id> | --shard <shard-id>]");
  }
  const id = arguments_[1];
  if (typeof id !== "string" || id.length === 0) throw new Error("The R contract selection ID must be non-empty.");
  return Object.freeze({ kind: arguments_[0] === "--phase" ? "phase" : "shard", id });
}

export function selectRContractPhases(phases, selection) {
  if (!Array.isArray(phases) || phases.length === 0)
    throw new TypeError("R contract phases must be a non-empty array.");
  const phasesById = new Map();
  for (const phase of phases) {
    if (typeof phase?.id !== "string" || phase.id.length === 0) {
      throw new Error("Every R contract phase must have a non-empty ID.");
    }
    if (phasesById.has(phase.id)) throw new Error(`Duplicate R contract phase ID: ${phase.id}`);
    phasesById.set(phase.id, phase);
  }
  if (selection?.kind === "all") return Object.freeze([...phases]);
  if (selection?.kind === "phase") {
    const phase = phasesById.get(selection.id);
    if (!phase) {
      throw new Error(
        `Unknown R contract phase ${selection.id}; expected one of: ${[...phasesById.keys()].join(", ")}.`
      );
    }
    return Object.freeze([phase]);
  }
  if (selection?.kind === "shard") {
    const shard = R_CONTRACT_SHARDS.find(({ id }) => id === selection.id);
    if (!shard) {
      throw new Error(
        `Unknown R contract shard ${selection.id}; expected one of: ${R_CONTRACT_SHARDS.map(({ id }) => id).join(", ")}.`
      );
    }
    return Object.freeze(
      shard.phaseIds.map((phaseId) => {
        const phase = phasesById.get(phaseId);
        if (!phase) throw new Error(`R contract shard ${shard.id} references unknown phase ${phaseId}.`);
        return phase;
      })
    );
  }
  throw new Error("The R contract selection must be all, phase, or shard.");
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
  const selection = parseRContractSelection(process.argv.slice(2));
  const rscript = resolveExecutable(process.env.RSCRIPT ?? "Rscript");
  const r = resolveExecutable(process.env.R ?? "R");
  const phases = createRContractPhases({ environment: process.env, r, rscript });
  runRContractPhases(selectRContractPhases(phases, selection));
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
