import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { accessSync, constants as fsConstants, realpathSync } from "node:fs";
import { Transform } from "node:stream";
import { delimiter, isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const root = resolve(import.meta.dirname, "..");
const FRAME_CONTRACT_TIMEOUT_MS = 120_000;
const KERNEL_AGENT_TIMEOUT_MS = 360_000;
const CATALOG_CONTRACT_TIMEOUT_MS = 120_000;
const SHORT_VITEST_PHASE_TIMEOUT_MS = 60_000;
const TRANSPORT_VITEST_PHASE_TIMEOUT_MS = 90_000;
const R_WARNING_CONTRACT_RUNNER = "r/tests/run_warning_strict.R";
const PROCESS_TERMINATION_GRACE_MS = 2_000;
const PROCESS_KILL_GRACE_MS = 5_000;
const WINDOWS_JOB_SETTLEMENT_MS = 15_000;
const WINDOWS_JOB_LAUNCH_FRAME_MAX_BYTES = 256 * 1024;
const WINDOWS_JOB_ATTESTATION_PREFIX = "OPEN_WRANGLER_WINDOWS_JOB_EMPTY:";
const WINDOWS_JOB_SUPERVISOR_PATH = resolve(root, "scripts/windows-job-supervisor.ps1");

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

export const R_CONTRACT_SHARD_ALIASES = Object.freeze([
  Object.freeze({
    id: "frame-and-interactive-transport",
    phaseIds: Object.freeze([...R_FRAME_CONTRACT_CASES.map(framePhaseId), "kernel-transport", "interactive-transport"])
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
    const allShards = [...R_CONTRACT_SHARDS, ...R_CONTRACT_SHARD_ALIASES];
    const shard = allShards.find(({ id }) => id === selection.id);
    if (!shard) {
      throw new Error(
        `Unknown R contract shard ${selection.id}; expected one of: ${allShards.map(({ id }) => id).join(", ")}.`
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

function sleep(milliseconds) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds));
}

function observeChild(child) {
  let settled = false;
  let state;
  let spawnError;
  const promise = new Promise((resolveExit) => {
    child.once("error", (error) => {
      spawnError ??= error;
    });
    child.once("close", (code, signal) => {
      settled = true;
      state = Object.freeze({ code, signal, error: spawnError });
      resolveExit(state);
    });
  });
  return Object.freeze({
    promise,
    isSettled: () => settled,
    state: () => state
  });
}

function deadlineResult(promise, timeoutMs) {
  return new Promise((resolveDeadline) => {
    const timer = setTimeout(() => resolveDeadline(Object.freeze({ timedOut: true })), timeoutMs);
    promise.then((value) => {
      clearTimeout(timer);
      resolveDeadline(Object.freeze({ timedOut: false, value }));
    });
  });
}

function processGroupRunning(pid, signalProcess = process.kill) {
  try {
    signalProcess(-pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    if (error?.code === "EPERM") return true;
    throw error;
  }
}

async function waitForPosixSettlement(pid, observer, timeoutMs, { isGroupRunning, sleepFor }) {
  const deadline = performance.now() + timeoutMs;
  do {
    if (!isGroupRunning(pid) && observer.isSettled()) return true;
    await sleepFor(Math.min(25, Math.max(1, deadline - performance.now())));
  } while (performance.now() < deadline);
  return !isGroupRunning(pid) && observer.isSettled();
}

async function settlePosixProcessTree(
  child,
  observer,
  {
    signalProcess = process.kill,
    isGroupRunning = (pid) => processGroupRunning(pid, signalProcess),
    sleepFor = sleep,
    terminationGraceMs = PROCESS_TERMINATION_GRACE_MS,
    killGraceMs = PROCESS_KILL_GRACE_MS
  } = {}
) {
  if (!Number.isSafeInteger(child.pid) || child.pid <= 0) {
    throw new Error("The R contract phase did not expose an owned POSIX process group.");
  }
  const signalGroup = (signal) => {
    try {
      signalProcess(-child.pid, signal);
    } catch (error) {
      if (error?.code !== "ESRCH") throw error;
    }
  };
  if (await waitForPosixSettlement(child.pid, observer, 1, { isGroupRunning, sleepFor })) return;
  signalGroup("SIGTERM");
  if (
    await waitForPosixSettlement(child.pid, observer, terminationGraceMs, {
      isGroupRunning,
      sleepFor
    })
  )
    return;
  signalGroup("SIGKILL");
  if (await waitForPosixSettlement(child.pid, observer, killGraceMs, { isGroupRunning, sleepFor })) return;
  throw new Error(`The R contract process group ${child.pid} remained live after bounded SIGTERM and SIGKILL.`);
}

function createWindowsJobStderrProtocol(stream, token, writeError) {
  const marker = Buffer.from(`${WINDOWS_JOB_ATTESTATION_PREFIX}${token}\n`, "ascii");
  let pending = Buffer.alloc(0);
  let markerCount = 0;
  let resolveAttestation;
  const attestation = new Promise((resolveValue) => {
    resolveAttestation = resolveValue;
  });
  const output = new Transform({
    transform(chunk, _encoding, callback) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const combined = pending.length === 0 ? buffer : Buffer.concat([pending, buffer]);
      let offset = 0;
      while (true) {
        const match = combined.indexOf(marker, offset);
        if (match < 0) break;
        if (match > offset) this.push(combined.subarray(offset, match));
        markerCount += 1;
        offset = match + marker.length;
      }
      const remaining = combined.subarray(offset);
      const publishLength = Math.max(0, remaining.length - (marker.length - 1));
      if (publishLength > 0) this.push(remaining.subarray(0, publishLength));
      pending = Buffer.from(remaining.subarray(publishLength));
      callback();
    },
    flush(callback) {
      if (pending.length > 0) this.push(pending);
      pending = Buffer.alloc(0);
      resolveAttestation(markerCount === 1);
      callback();
    }
  });
  output.on("data", writeError);
  output.once("error", () => resolveAttestation(false));
  stream.once("error", () => resolveAttestation(false));
  stream.pipe(output);
  return attestation;
}

function spawnWindowsJobPhase(phase, { spawnProcess, randomToken, writeError }) {
  const token = randomToken();
  const launchFrame = `${JSON.stringify({
    protocol: 1,
    command: "launch",
    executable: phase.command,
    args: phase.args,
    cwd: root,
    environment: phase.environment,
    attestationToken: token
  })}\n`;
  if (Buffer.byteLength(launchFrame, "utf8") > WINDOWS_JOB_LAUNCH_FRAME_MAX_BYTES) {
    throw new Error("The R contract Windows Job Object launch frame exceeds its fixed bound.");
  }
  const systemRoot = phase.environment.SYSTEMROOT ?? phase.environment.SystemRoot ?? phase.environment.WINDIR;
  if (typeof systemRoot !== "string" || systemRoot.length === 0) {
    throw new Error("The R contract Windows Job Object launch requires SYSTEMROOT.");
  }
  const child = spawnProcess(
    join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", WINDOWS_JOB_SUPERVISOR_PATH],
    {
      cwd: root,
      detached: false,
      env: phase.environment,
      windowsHide: true,
      stdio: ["pipe", "inherit", "pipe"]
    }
  );
  if (!child.stdin || typeof child.stdin.write !== "function" || !child.stderr) {
    throw new Error("The R contract Windows Job Object supervisor did not expose its control channels.");
  }
  let controlError;
  child.stdin.on("error", (error) => {
    controlError ??= error;
  });
  const attestation = createWindowsJobStderrProtocol(child.stderr, token, writeError);
  child.stdin.write(launchFrame, "utf8", (error) => {
    controlError ??= error;
  });
  return Object.freeze({
    child,
    attestation,
    terminate: () =>
      new Promise((resolveTermination, rejectTermination) => {
        if (controlError) {
          rejectTermination(controlError);
          return;
        }
        if (!child.stdin.writable) {
          rejectTermination(new Error("The Windows R contract Job Object control pipe closed before termination."));
          return;
        }
        child.stdin.write('{"protocol":1,"command":"terminate"}\n', "utf8", (error) => {
          if (error) rejectTermination(error);
          else resolveTermination();
        });
      })
  });
}

function combinePhaseAndCleanupFailure(primary, cleanup) {
  const failure = new AggregateError(
    [primary, cleanup],
    `${primary.message} Process-tree cleanup also failed: ${cleanup.message}`
  );
  failure.processTreeUnsettled = true;
  return failure;
}

async function requireWindowsSettlement(launch, observer, timeoutMs) {
  const exit = await deadlineResult(observer.promise, timeoutMs);
  if (exit.timedOut) throw new Error("The Windows R contract Job Object did not settle within its fixed deadline.");
  const attestation = await deadlineResult(launch.attestation, 250);
  if (attestation.timedOut || attestation.value !== true) {
    throw new Error("The Windows R contract Job Object did not provide one exact empty-tree attestation.");
  }
  return exit.value;
}

export function runRContractPhase(phase, options) {
  return runRContractPhaseAsync(phase, options);
}

async function runRContractPhaseAsync(
  phase,
  {
    now = () => performance.now(),
    spawnProcess = spawn,
    platform = process.platform,
    randomToken = randomUUID,
    writeError = (chunk) => process.stderr.write(chunk),
    writeLine = (line) => process.stdout.write(`${line}\n`),
    ...settlementOptions
  } = {}
) {
  const started = now();
  writeLine(`[r-contract] START ${phase.label}; timeout ${formattedSeconds(phase.timeoutMs)}`);
  const launch =
    platform === "win32"
      ? spawnWindowsJobPhase(phase, { spawnProcess, randomToken, writeError })
      : Object.freeze({
          child: spawnProcess(phase.command, phase.args, {
            cwd: root,
            detached: true,
            env: phase.environment,
            stdio: "inherit",
            windowsHide: true
          })
        });
  const observer = observeChild(launch.child);
  const deadline = await deadlineResult(observer.promise, phase.timeoutMs);
  const elapsed = Math.max(0, now() - started);
  if (deadline.timedOut) {
    const primary = new Error(
      `[r-contract] TIMEOUT ${phase.label} after ${formattedSeconds(elapsed)}; phase limit ${formattedSeconds(phase.timeoutMs)}.`
    );
    try {
      if (platform === "win32") {
        await launch.terminate();
        await requireWindowsSettlement(
          launch,
          observer,
          settlementOptions.windowsSettlementMs ?? WINDOWS_JOB_SETTLEMENT_MS
        );
      } else {
        await settlePosixProcessTree(launch.child, observer, settlementOptions);
      }
    } catch (cleanup) {
      throw combinePhaseAndCleanupFailure(primary, cleanup);
    }
    throw primary;
  }

  const result = deadline.value;
  let primary;
  if (result.error) {
    primary = new Error(
      `[r-contract] ERROR ${phase.label} after ${formattedSeconds(elapsed)}: ${result.error.message}`,
      {
        cause: result.error
      }
    );
  } else if (result.code !== 0) {
    const outcome = result.code === null ? `signal ${result.signal ?? "unknown"}` : `exit ${result.code}`;
    primary = new Error(`[r-contract] FAIL ${phase.label} after ${formattedSeconds(elapsed)} with ${outcome}.`);
  }

  try {
    if (platform === "win32") {
      await requireWindowsSettlement(launch, observer, 250);
    } else if (!Number.isSafeInteger(launch.child.pid) || launch.child.pid <= 0) {
      if (!primary) {
        const ownership = new Error(`[r-contract] ERROR ${phase.label}: the phase exposed no owned process group.`);
        ownership.processTreeUnsettled = true;
        throw ownership;
      }
    } else if (settlementOptions.isGroupRunning?.(launch.child.pid) ?? processGroupRunning(launch.child.pid)) {
      primary ??= new Error(`[r-contract] ERROR ${phase.label}: the phase exited with live descendants.`);
      await settlePosixProcessTree(launch.child, observer, settlementOptions);
    }
  } catch (cleanup) {
    throw combinePhaseAndCleanupFailure(
      primary ?? new Error(`[r-contract] ERROR ${phase.label}: process-tree settlement failed.`),
      cleanup
    );
  }
  if (primary) throw primary;
  writeLine(`[r-contract] PASS ${phase.label} in ${formattedSeconds(elapsed)}`);
}

export async function runRContractPhases(
  phases,
  { runPhase = runRContractPhase, writeLine = (line) => process.stdout.write(`${line}\n`), ...phaseOptions } = {}
) {
  const failures = [];
  for (const phase of phases) {
    try {
      await runPhase(phase, { ...phaseOptions, writeLine });
    } catch (error) {
      const normalized = error instanceof Error ? error : new Error(String(error));
      failures.push(normalized);
      writeLine(`[r-contract] RECORDED ${phase.id}: ${normalized.message}`);
      if (normalized.processTreeUnsettled === true) {
        throw new AggregateError(
          failures,
          `[r-contract] stopped after ${phase.id} because its process tree was not verified settled.`
        );
      }
    }
  }
  if (failures.length > 0) {
    throw new AggregateError(
      failures,
      `[r-contract] ${failures.length} of ${phases.length} selected phases failed after all selected phases settled.`
    );
  }
}

async function main() {
  const selection = parseRContractSelection(process.argv.slice(2));
  const rscript = resolveExecutable(process.env.RSCRIPT ?? "Rscript");
  const r = resolveExecutable(process.env.R ?? "R");
  const phases = createRContractPhases({ environment: process.env, r, rscript });
  await runRContractPhases(orderRContractPhases(selectRContractPhases(phases, selection), selection.seed));
}

function invokedDirectly() {
  if (!process.argv[1]) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
