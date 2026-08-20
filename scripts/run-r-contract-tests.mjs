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
const R_WARNING_CONTRACT_RUNNER = "r/tests/run_warning_strict.R";

export const R_FRAME_CONTRACT_CASES = Object.freeze([
  "decimal-ordering",
  "capture-and-export",
  "custom-code",
  "group-by",
  "column-operations",
  "by-example",
  "formula",
  "text",
  "numeric-and-datetime",
  "fill-missing",
  "cast-and-structure",
  "profiling",
  "interactive",
  "validation-and-categorical"
]);

const framePhaseId = (caseId) => `frame:${caseId}`;

export const R_CONTRACT_SHARDS = Object.freeze([
  Object.freeze({
    id: "frame-foundations",
    phaseIds: Object.freeze(
      ["decimal-ordering", "capture-and-export", "custom-code", "validation-and-categorical"].map(framePhaseId)
    )
  }),
  Object.freeze({
    id: "frame-transformations",
    phaseIds: Object.freeze(
      [
        "group-by",
        "column-operations",
        "by-example",
        "formula",
        "text",
        "numeric-and-datetime",
        "fill-missing",
        "cast-and-structure"
      ].map(framePhaseId)
    )
  }),
  Object.freeze({ id: "frame-query", phaseIds: Object.freeze(["profiling", "interactive"].map(framePhaseId)) }),
  Object.freeze({ id: "kernel-agent", phaseIds: Object.freeze(["kernel-agent"]) }),
  Object.freeze({
    id: "catalog-and-unit",
    phaseIds: Object.freeze(["catalog", "typescript-frame"])
  }),
  Object.freeze({
    id: "runtime-transport",
    phaseIds: Object.freeze(["kernel-transport", "process-transport", "interactive-transport"])
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

function nativeRPhase(id, label, testFile, timeoutMs, { environment, phaseEnvironment = {}, rscript }) {
  return Object.freeze({
    id,
    label,
    command: rscript,
    args: Object.freeze(["--vanilla", R_WARNING_CONTRACT_RUNNER]),
    environment: Object.freeze({
      ...environment,
      ...phaseEnvironment,
      OPEN_WRANGLER_R_CONTRACT_TEST: testFile
    }),
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
  const framePhases = R_FRAME_CONTRACT_CASES.map((caseId) =>
    nativeRPhase(
      framePhaseId(caseId),
      `native frame contract: ${caseId}`,
      caseId === "interactive" ? "r/tests/interactive_contract.R" : "r/tests/frame_contract.R",
      FRAME_CONTRACT_TIMEOUT_MS,
      {
        environment: rEnvironment,
        phaseEnvironment: { OPEN_WRANGLER_R_FRAME_CASE: caseId },
        rscript
      }
    )
  );
  return Object.freeze([
    ...framePhases,
    nativeRPhase("kernel-agent", "native kernel-agent contract", "r/tests/kernel_agent.R", KERNEL_AGENT_TIMEOUT_MS, {
      environment: rEnvironment,
      rscript
    }),
    nativeRPhase(
      "catalog",
      "complete native catalog contract",
      "r/tests/complete_catalog_contract.R",
      CATALOG_CONTRACT_TIMEOUT_MS,
      { environment: rEnvironment, rscript }
    ),
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
      TRANSPORT_VITEST_PHASE_TIMEOUT_MS,
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
  let selection;
  let seed;
  for (let index = 0; index < arguments_.length; index += 2) {
    const option = arguments_[index];
    const value = arguments_[index + 1];
    if (value === undefined) {
      throw new Error("Usage: run-r-contract-tests.mjs [--phase <phase-id> | --shard <shard-id>] [--seed <uint32>]");
    }
    if (option === "--seed") {
      if (seed !== undefined || !/^(0|[1-9][0-9]*)$/u.test(value)) {
        throw new Error("The R contract random-order seed must be one canonical unsigned 32-bit integer.");
      }
      const parsed = Number(value);
      if (!Number.isSafeInteger(parsed) || parsed > 0xffff_ffff) {
        throw new Error("The R contract random-order seed must be one canonical unsigned 32-bit integer.");
      }
      seed = parsed;
      continue;
    }
    if (option !== "--phase" && option !== "--shard") {
      throw new Error("Usage: run-r-contract-tests.mjs [--phase <phase-id> | --shard <shard-id>] [--seed <uint32>]");
    }
    if (selection !== undefined || typeof value !== "string" || value.length === 0) {
      throw new Error("The R contract selection must contain one non-empty phase or shard ID.");
    }
    selection = { kind: option === "--phase" ? "phase" : "shard", id: value };
  }
  return Object.freeze({ ...(selection ?? { kind: "all" }), ...(seed === undefined ? {} : { seed }) });
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

export function orderRContractPhases(phases, seed) {
  if (!Array.isArray(phases)) throw new TypeError("R contract phases must be an array.");
  const ordered = [...phases];
  if (seed === undefined) return Object.freeze(ordered);
  if (!Number.isInteger(seed) || seed < 0 || seed > 0xffff_ffff) {
    throw new RangeError("The R contract random-order seed must be an unsigned 32-bit integer.");
  }
  let state = seed >>> 0;
  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 0x1_0000_0000;
  };
  for (let index = ordered.length - 1; index > 0; index -= 1) {
    const other = Math.floor(next() * (index + 1));
    [ordered[index], ordered[other]] = [ordered[other], ordered[index]];
  }
  return Object.freeze(ordered);
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

export function runRContractPhases(
  phases,
  { runPhase = runRContractPhase, writeLine = (line) => process.stdout.write(`${line}\n`), ...phaseOptions } = {}
) {
  const failures = [];
  for (const phase of phases) {
    try {
      runPhase(phase, { ...phaseOptions, writeLine });
    } catch (error) {
      const normalized = error instanceof Error ? error : new Error(String(error));
      failures.push(normalized);
      writeLine(`[r-contract] RECORDED ${phase.id}: ${normalized.message}`);
    }
  }
  if (failures.length > 0) {
    throw new AggregateError(
      failures,
      `[r-contract] ${failures.length} of ${phases.length} selected phases failed after all selected phases settled.`
    );
  }
}

function main() {
  const selection = parseRContractSelection(process.argv.slice(2));
  const rscript = resolveExecutable(process.env.RSCRIPT ?? "Rscript");
  const r = resolveExecutable(process.env.R ?? "R");
  const phases = createRContractPhases({ environment: process.env, r, rscript });
  runRContractPhases(orderRContractPhases(selectRContractPhases(phases, selection), selection.seed));
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
