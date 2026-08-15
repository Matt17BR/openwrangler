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

function vitestPhase(label, files, timeoutMs, { environment, node, vitest }) {
  return Object.freeze({
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
      label: "native frame contract",
      command: rscript,
      args: Object.freeze(["--vanilla", "r/tests/frame_contract.R"]),
      environment: rEnvironment,
      timeoutMs: FRAME_CONTRACT_TIMEOUT_MS
    }),
    Object.freeze({
      label: "native kernel-agent contract",
      command: rscript,
      args: Object.freeze(["--vanilla", "r/tests/kernel_agent.R"]),
      environment: rEnvironment,
      timeoutMs: KERNEL_AGENT_TIMEOUT_MS
    }),
    Object.freeze({
      label: "complete native catalog contract",
      command: rscript,
      args: Object.freeze(["--vanilla", "r/tests/complete_catalog_contract.R"]),
      environment: rEnvironment,
      timeoutMs: CATALOG_CONTRACT_TIMEOUT_MS
    }),
    vitestPhase(
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
      "real-R kernel transport contract",
      ["src/test/rKernelTransport.cross.test.ts"],
      TRANSPORT_VITEST_PHASE_TIMEOUT_MS,
      { environment: vitestEnvironment, node, vitest }
    ),
    vitestPhase(
      "real-R process transport contract",
      ["src/test/rProcessTransport.cross.test.ts"],
      TRANSPORT_VITEST_PHASE_TIMEOUT_MS,
      { environment: vitestEnvironment, node, vitest }
    ),
    vitestPhase(
      "real-R interactive transport contract",
      ["src/test/rInteractiveSessionTransport.cross.test.ts"],
      SHORT_VITEST_PHASE_TIMEOUT_MS,
      { environment: vitestEnvironment, node, vitest }
    )
  ]);
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
  runRContractPhases(phases);
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
