import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { accessSync, constants as fsConstants, readdirSync, readFileSync, realpathSync } from "node:fs";
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
const DEFAULT_R_CONTRACT_SEED = 20_260_820;
const POSIX_OWNER_ENVIRONMENT_KEY = "OPEN_WRANGLER_R_CONTRACT_OWNER";
const PROCESS_TERMINATION_GRACE_MS = 2_000;
const PROCESS_KILL_GRACE_MS = 5_000;
const POSIX_PROCESS_OBSERVATION_INTERVAL_MS = 10;
const POSIX_PROCESS_OBSERVATION_DEADLINE_MS = 250;
const R_CONTRACT_PHASE_OUTPUT_MAX_BYTES = 4 * 1024 * 1024;
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

export const R_KERNEL_AGENT_CASES = Object.freeze([
  "lifecycle-and-structure",
  "text-fill-and-cast",
  "rows-numeric-datetime-and-by-example",
  "group-pivot-and-export",
  "custom-code"
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
  Object.freeze({
    id: "kernel-agent",
    phaseIds: Object.freeze(R_KERNEL_AGENT_CASES.map((caseId) => `kernel:${caseId}`))
  }),
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
  const kernelPhases = R_KERNEL_AGENT_CASES.map((caseId) =>
    nativeRPhase(
      `kernel:${caseId}`,
      `native kernel-agent contract: ${caseId}`,
      "r/tests/kernel_agent.R",
      KERNEL_AGENT_TIMEOUT_MS,
      {
        environment: rEnvironment,
        phaseEnvironment: { OPEN_WRANGLER_R_KERNEL_CASE: caseId },
        rscript
      }
    )
  );
  return Object.freeze([
    ...framePhases,
    ...kernelPhases,
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
  const resolvedSelection = selection ?? { kind: "all" };
  const resolvedSeed = seed ?? (resolvedSelection.kind === "all" ? DEFAULT_R_CONTRACT_SEED : undefined);
  return Object.freeze({ ...resolvedSelection, ...(resolvedSeed === undefined ? {} : { seed: resolvedSeed }) });
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

function phaseDeadlineResult(promise, timeoutMs, terminationSignal, failurePromise) {
  return new Promise((resolveDeadline) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      terminationSignal?.removeEventListener("abort", onAbort);
      resolveDeadline(Object.freeze(value));
    };
    const onAbort = () => finish({ kind: "signal", signal: terminationSignal.reason });
    const timer = setTimeout(() => finish({ kind: "timeout" }), timeoutMs);
    promise.then((value) => finish({ kind: "exit", value }));
    failurePromise?.then((error) => finish({ kind: "failure", error }));
    if (terminationSignal?.aborted) onAbort();
    else terminationSignal?.addEventListener("abort", onAbort, { once: true });
  });
}

function parseLinuxProcessIdentity(pid, contents) {
  const close = contents.lastIndexOf(")");
  if (close < 0) throw new Error(`The Linux process identity for PID ${pid} was malformed.`);
  const fields = contents
    .slice(close + 2)
    .trim()
    .split(/\s+/u);
  if (fields.length < 20 || !/^[0-9]+$/u.test(fields[1]) || !/^[0-9]+$/u.test(fields[19])) {
    throw new Error(`The Linux process identity for PID ${pid} was incomplete.`);
  }
  return Object.freeze({
    pid,
    parentPid: Number(fields[1]),
    groupId: Number(fields[2]),
    state: fields[0],
    startIdentity: fields[19],
    identityResolution: "kernel-start-tick"
  });
}

function readLinuxProcessIdentity(pid) {
  try {
    return parseLinuxProcessIdentity(pid, readFileSync(`/proc/${pid}/stat`, "utf8"));
  } catch (error) {
    if (["ENOENT", "ESRCH"].includes(error?.code)) return undefined;
    throw new Error(`The observed Linux process ${pid} could not be verified: ${error.message}`, { cause: error });
  }
}

function linuxProcessHasOwner(pid, ownerToken) {
  const expected = `${POSIX_OWNER_ENVIRONMENT_KEY}=${ownerToken}`;
  try {
    return readFileSync(`/proc/${pid}/environ`, "utf8").split("\0").includes(expected);
  } catch (error) {
    if (["EACCES", "ENOENT", "EPERM", "ESRCH"].includes(error?.code)) return false;
    throw error;
  }
}

function parsePsProcessIdentity(line, ownerToken) {
  const match =
    /^\s*([1-9][0-9]*)\s+([0-9]+)\s+([0-9]+)\s+(\S+\s+\S+\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+([\s\S]*)$/u.exec(
      line
    );
  if (!match) return undefined;
  return Object.freeze({
    pid: Number(match[1]),
    parentPid: Number(match[2]),
    groupId: Number(match[3]),
    state: "?",
    startIdentity: match[4],
    command: match[5],
    ownerMarked: typeof ownerToken === "string" && match[5].includes(`${POSIX_OWNER_ENVIRONMENT_KEY}=${ownerToken}`),
    identityResolution: "second"
  });
}

export function readPsProcessIdentity(pid, { execute = execFileSync, ownerToken } = {}) {
  let output;
  try {
    output = execute("ps", ["eww", "-p", String(pid), "-o", "pid=,ppid=,pgid=,lstart=,command="], {
      encoding: "utf8",
      maxBuffer: 64 * 1024,
      timeout: POSIX_PROCESS_OBSERVATION_DEADLINE_MS,
      killSignal: "SIGKILL",
      stdio: ["ignore", "pipe", "ignore"]
    });
  } catch (error) {
    if (error?.status === 1) return undefined;
    throw new Error(`The observed POSIX process ${pid} could not be verified: ${error.message}`, { cause: error });
  }
  const identity = parsePsProcessIdentity(output.trimEnd(), ownerToken);
  if (!identity) throw new Error(`The observed POSIX process identity for PID ${pid} was malformed.`);
  return identity;
}

function readPosixProcessIdentity(pid, ownerToken) {
  return process.platform === "linux" ? readLinuxProcessIdentity(pid) : readPsProcessIdentity(pid, { ownerToken });
}

function listPosixProcessIdentities(ownerToken) {
  if (process.platform !== "linux") {
    const output = execFileSync("ps", ["eww", "-axo", "pid=,ppid=,pgid=,lstart=,command="], {
      encoding: "utf8",
      maxBuffer: 8 * 1024 * 1024,
      timeout: POSIX_PROCESS_OBSERVATION_DEADLINE_MS,
      killSignal: "SIGKILL",
      stdio: ["ignore", "pipe", "ignore"]
    });
    const marker = `${POSIX_OWNER_ENVIRONMENT_KEY}=${ownerToken}`;
    return output
      .split("\n")
      .map((line) => parsePsProcessIdentity(line, ownerToken))
      .filter(Boolean)
      .map((identity) => Object.freeze({ ...identity, ownerMarked: identity.command.includes(marker) }));
  }
  const identities = [];
  for (const name of readdirSync("/proc")) {
    if (!/^[1-9][0-9]*$/u.test(name)) continue;
    const pid = Number(name);
    try {
      const identity = readLinuxProcessIdentity(pid);
      if (identity) identities.push(Object.freeze({ ...identity, ownerMarked: linuxProcessHasOwner(pid, ownerToken) }));
    } catch (error) {
      if (!/could not be verified/u.test(error.message)) throw error;
    }
  }
  return identities;
}

function sameProcessIdentity(left, right) {
  return left?.pid === right?.pid && left?.startIdentity === right?.startIdentity;
}

function processIdentityKey(identity) {
  return `${identity.pid}:${identity.startIdentity}`;
}

export function createPosixProcessTracker(
  rootPid,
  ownerToken,
  {
    readProcessIdentity = readPosixProcessIdentity,
    listProcessIdentities = listPosixProcessIdentities,
    acquireSignalHandle = () => undefined,
    observationIntervalMs = POSIX_PROCESS_OBSERVATION_INTERVAL_MS
  } = {}
) {
  if (!Number.isSafeInteger(rootPid) || rootPid <= 0) {
    throw new Error("The R contract phase did not expose an owned POSIX process.");
  }
  const observed = new Map();
  const retiredIdentities = new Map();
  const releasedSignalHandles = new WeakSet();
  let failure;
  let resolveFailure;
  const failurePromise = new Promise((resolveValue) => {
    resolveFailure = resolveValue;
  });
  const latch = (error) => {
    if (failure) return;
    failure = new Error(`The R contract process tree became unverifiable: ${error.message}`, { cause: error });
    failure.processTreeUnsettled = true;
    resolveFailure(failure);
  };
  const releaseSignalHandle = (expected) => {
    const handle = expected.signalHandle;
    if (handle === undefined || releasedSignalHandles.has(handle)) return;
    releasedSignalHandles.add(handle);
    try {
      if (typeof handle.close === "function") handle.close();
    } catch (error) {
      latch(error);
      throw failure;
    }
  };
  const retire = (expected) => {
    releaseSignalHandle(expected);
    observed.delete(expected.pid);
    retiredIdentities.set(processIdentityKey(expected), expected);
  };
  const bindSignalHandle = (identity) => {
    try {
      const signalHandle = acquireSignalHandle(identity);
      if (
        signalHandle !== undefined &&
        (typeof signalHandle !== "object" || signalHandle === null || typeof signalHandle.signal !== "function")
      ) {
        throw new TypeError(`The held POSIX process identity for ${identity.pid} did not expose signal().`);
      }
      return Object.freeze({ ...identity, signalHandle });
    } catch (error) {
      latch(error);
      throw failure;
    }
  };
  const coarseIdentityStillOwned = (expected, current) => {
    if (expected.identityResolution !== "second" && current.identityResolution !== "second") return true;
    const markerOwned = expected.ownerMarked === true && current.ownerMarked === true;
    const lineageOwned =
      expected.parentPid === current.parentPid &&
      observed.has(expected.parentPid) &&
      current.parentPid !== expected.pid;
    return (
      expected.identityResolution === "second" &&
      current.identityResolution === "second" &&
      expected.parentPid === current.parentPid &&
      expected.groupId === current.groupId &&
      expected.command === current.command &&
      (markerOwned || lineageOwned)
    );
  };
  const verifiedIdentity = (expected) => {
    let current;
    try {
      current = readProcessIdentity(expected.pid, ownerToken);
    } catch (error) {
      latch(error);
      throw failure;
    }
    if (!current || current.state === "Z") return undefined;
    if (!sameProcessIdentity(expected, current)) return undefined;
    if (!coarseIdentityStillOwned(expected, current)) {
      latch(
        new Error(
          `process ${expected.pid} retained only an ambiguous second-resolution identity without its exact owned marker or lineage`
        )
      );
      throw failure;
    }
    return current;
  };
  const observe = () => {
    if (failure) throw failure;
    for (const expected of observed.values()) {
      if (!verifiedIdentity(expected)) {
        retire(expected);
      }
    }
    let snapshot;
    try {
      snapshot = listProcessIdentities(ownerToken);
    } catch (error) {
      latch(error);
      throw failure;
    }
    const pending = new Map(snapshot.map((identity) => [identity.pid, identity]));
    let root;
    try {
      root = readProcessIdentity(rootPid, ownerToken);
    } catch (error) {
      latch(error);
      throw failure;
    }
    if (root && root.state !== "Z") pending.set(rootPid, root);
    let changed = true;
    while (changed) {
      changed = false;
      for (const identity of pending.values()) {
        if (observed.has(identity.pid)) continue;
        const retired = retiredIdentities.get(processIdentityKey(identity));
        if (retired) {
          if (retired.identityResolution === "second" || identity.identityResolution === "second") {
            latch(
              new Error(
                `retired coarse process ${identity.pid} reappeared with the same ${identity.startIdentity} identity key`
              )
            );
            throw failure;
          }
          continue;
        }
        const belongs =
          sameProcessIdentity(identity, rootIdentity) ||
          identity.ownerMarked === true ||
          observed.has(identity.parentPid);
        if (!belongs) continue;
        let verified;
        try {
          verified = readProcessIdentity(identity.pid, ownerToken);
        } catch (error) {
          latch(error);
          throw failure;
        }
        if (!verified || verified.state === "Z" || !sameProcessIdentity(identity, verified)) continue;
        observed.set(identity.pid, bindSignalHandle(verified));
        changed = true;
      }
    }
    return observed.size;
  };
  let rootIdentity;
  try {
    rootIdentity = readProcessIdentity(rootPid, ownerToken);
    if (!rootIdentity || rootIdentity.state === "Z") {
      throw new Error(`The R contract root process ${rootPid} had no stable identity after spawn.`);
    }
    rootIdentity = bindSignalHandle(rootIdentity);
    observed.set(rootPid, rootIdentity);
    observe();
  } catch (error) {
    latch(error);
    // The latched failure is surfaced through the phase and settlement paths.
  }
  const interval = setInterval(() => {
    try {
      observe();
    } catch {
      clearInterval(interval);
    }
  }, observationIntervalMs);
  interval.unref?.();
  return Object.freeze({
    failure: failurePromise,
    assertHealthy: () => {
      if (failure) throw failure;
    },
    observe,
    isSettled: (observer) => {
      observe();
      return observed.size === 0 && observer.isSettled();
    },
    signal: (signal) => {
      observe();
      for (const expected of [...observed.values()].sort((left, right) => left.pid - right.pid)) {
        if (!verifiedIdentity(expected)) {
          retire(expected);
          continue;
        }
        if (expected.signalHandle === undefined) {
          latch(
            new Error(
              `process ${expected.pid} has no OS-held signal identity on this POSIX platform; refusing numeric PID signaling`
            )
          );
          throw failure;
        }
        try {
          expected.signalHandle.signal(signal);
        } catch (error) {
          if (error?.code !== "ESRCH") {
            latch(error);
            throw failure;
          }
          retire(expected);
        }
      }
    },
    stop: () => {
      clearInterval(interval);
      for (const expected of observed.values()) releaseSignalHandle(expected);
      observed.clear();
    }
  });
}

async function waitForPosixSettlement(tracker, observer, timeoutMs, { sleepFor }) {
  const deadline = performance.now() + timeoutMs;
  let quietObservations = 0;
  do {
    if (tracker.isSettled(observer)) {
      quietObservations += 1;
      if (quietObservations >= 2) return true;
    } else {
      quietObservations = 0;
    }
    await sleepFor(Math.min(10, Math.max(1, deadline - performance.now())));
  } while (performance.now() < deadline);
  return false;
}

async function settlePosixProcessTree(
  child,
  observer,
  tracker,
  {
    sleepFor = sleep,
    terminationGraceMs = PROCESS_TERMINATION_GRACE_MS,
    killGraceMs = PROCESS_KILL_GRACE_MS,
    firstSignal = "SIGTERM"
  } = {}
) {
  tracker.assertHealthy();
  if (await waitForPosixSettlement(tracker, observer, 1, { sleepFor })) return;
  tracker.signal(firstSignal);
  if (await waitForPosixSettlement(tracker, observer, terminationGraceMs, { sleepFor })) return;
  tracker.signal("SIGKILL");
  if (await waitForPosixSettlement(tracker, observer, killGraceMs, { sleepFor })) return;
  throw new Error(`The R contract process tree ${child.pid} remained live after bounded ${firstSignal} and SIGKILL.`);
}

function createPhaseOutputBudget(maximumBytes) {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes <= 0 || maximumBytes > R_CONTRACT_PHASE_OUTPUT_MAX_BYTES) {
    throw new RangeError(
      `The R contract phase output bound must be between 1 and ${R_CONTRACT_PHASE_OUTPUT_MAX_BYTES} bytes.`
    );
  }
  let bytes = 0;
  let failure;
  let resolveFailure;
  const failurePromise = new Promise((resolveValue) => {
    resolveFailure = resolveValue;
  });
  const reserve = (chunk, channel) => {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    if (failure) return undefined;
    if (bytes + buffer.length > maximumBytes) {
      failure = new Error(
        `The R contract phase exceeded its ${maximumBytes}-byte stdout/stderr bound while reading ${channel}.`
      );
      failure.stopAfterPhase = true;
      resolveFailure(failure);
      return undefined;
    }
    bytes += buffer.length;
    return buffer;
  };
  const consume = (chunk, channel, writer) => {
    const buffer = reserve(chunk, channel);
    if (!buffer) return;
    try {
      writer(buffer);
    } catch (error) {
      if (!failure) {
        failure = new Error(`The R contract ${channel} sink failed: ${error.message}`, { cause: error });
        failure.stopAfterPhase = true;
        resolveFailure(failure);
      }
    }
  };
  return Object.freeze({
    failure: failurePromise,
    reserve,
    consume,
    attach: (stream, channel, writer) => {
      if (!stream || typeof stream.on !== "function") return;
      stream.on("data", (chunk) => consume(chunk, channel, writer));
      stream.once("error", (error) => {
        if (!failure) {
          failure = new Error(`The R contract ${channel} stream failed: ${error.message}`, { cause: error });
          failure.stopAfterPhase = true;
          resolveFailure(failure);
        }
      });
    }
  });
}

function createWindowsJobStderrProtocol(stream, token, writeError, outputBudget) {
  const marker = Buffer.from(`${WINDOWS_JOB_ATTESTATION_PREFIX}${token}\n`, "ascii");
  let pending = Buffer.alloc(0);
  let markerCount = 0;
  let resolveAttestation;
  const attestation = new Promise((resolveValue) => {
    resolveAttestation = resolveValue;
  });
  const publishUserOutput = (output, buffer) => {
    if (buffer.length === 0) return;
    const reserved = outputBudget.reserve(buffer, "stderr");
    if (reserved) output.push(reserved);
  };
  const output = new Transform({
    transform(chunk, _encoding, callback) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const combined = pending.length === 0 ? buffer : Buffer.concat([pending, buffer]);
      let offset = 0;
      while (true) {
        const match = combined.indexOf(marker, offset);
        if (match < 0) break;
        if (match > offset) publishUserOutput(this, combined.subarray(offset, match));
        markerCount += 1;
        offset = match + marker.length;
      }
      const remaining = combined.subarray(offset);
      const publishLength = Math.max(0, remaining.length - (marker.length - 1));
      if (publishLength > 0) publishUserOutput(this, remaining.subarray(0, publishLength));
      pending = Buffer.from(remaining.subarray(publishLength));
      callback();
    },
    flush(callback) {
      publishUserOutput(this, pending);
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

function spawnWindowsJobPhase(phase, { spawnProcess, randomToken, writeError, writeOutput, outputBudget }) {
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
      stdio: ["pipe", "pipe", "pipe"]
    }
  );
  let launchError;
  let attestation = Promise.resolve(false);
  let controlError;
  if (
    !child.stdin ||
    typeof child.stdin.on !== "function" ||
    typeof child.stdin.write !== "function" ||
    !child.stdout ||
    typeof child.stdout.on !== "function" ||
    !child.stderr ||
    typeof child.stderr.pipe !== "function"
  ) {
    launchError = new Error("The R contract Windows Job Object supervisor did not expose its control channels.");
  } else {
    try {
      child.stdin.on("error", (error) => {
        controlError ??= error;
      });
      outputBudget.attach(child.stdout, "stdout", writeOutput);
      attestation = createWindowsJobStderrProtocol(child.stderr, token, writeError, outputBudget);
      child.stdin.write(launchFrame, "utf8", (error) => {
        controlError ??= error;
      });
    } catch (error) {
      launchError = new Error(`The R contract Windows Job Object control setup failed: ${error.message}`, {
        cause: error
      });
    }
  }
  const forceSupervisorExit = () => {
    if (typeof child.kill !== "function" || child.kill("SIGKILL") !== true) {
      throw new Error("The Windows R contract Job Object supervisor could not be terminated.");
    }
  };
  return Object.freeze({
    child,
    attestation,
    controlError: () => controlError,
    launchError,
    terminate: () => {
      if (launchError || controlError || !child.stdin?.writable) {
        forceSupervisorExit();
        return Promise.resolve();
      }
      return new Promise((resolveTermination, rejectTermination) => {
        child.stdin.write('{"protocol":1,"command":"terminate"}\n', "utf8", (error) => {
          if (!error) {
            resolveTermination();
            return;
          }
          try {
            forceSupervisorExit();
            resolveTermination();
          } catch (fallbackError) {
            rejectTermination(
              new AggregateError(
                [error, fallbackError],
                "The Windows R contract supervisor control and kill paths failed."
              )
            );
          }
        });
      });
    }
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
    terminationSignal,
    maximumOutputBytes = R_CONTRACT_PHASE_OUTPUT_MAX_BYTES,
    writeError = (chunk) => process.stderr.write(chunk),
    writeOutput = (chunk) => process.stdout.write(chunk),
    writeLine = (line) => process.stdout.write(`${line}\n`),
    ...settlementOptions
  } = {}
) {
  const started = now();
  writeLine(`[r-contract] START ${phase.label}; timeout ${formattedSeconds(phase.timeoutMs)}`);
  const ownerToken = randomToken();
  const outputBudget = createPhaseOutputBudget(maximumOutputBytes);
  const launch =
    platform === "win32"
      ? spawnWindowsJobPhase(phase, {
          spawnProcess,
          randomToken: () => ownerToken,
          writeError,
          writeOutput,
          outputBudget
        })
      : Object.freeze({
          child: spawnProcess(phase.command, phase.args, {
            cwd: root,
            detached: true,
            env: { ...phase.environment, [POSIX_OWNER_ENVIRONMENT_KEY]: ownerToken },
            stdio: ["ignore", "pipe", "pipe"],
            windowsHide: true
          })
        });
  if (platform !== "win32") {
    outputBudget.attach(launch.child.stdout, "stdout", writeOutput);
    outputBudget.attach(launch.child.stderr, "stderr", writeError);
  }
  const observer = observeChild(launch.child);
  const createProcessTracker = settlementOptions.createProcessTracker ?? createPosixProcessTracker;
  const tracker =
    platform === "win32"
      ? undefined
      : createProcessTracker(launch.child.pid, ownerToken, {
          readProcessIdentity: settlementOptions.readProcessIdentity,
          listProcessIdentities: settlementOptions.listProcessIdentities,
          acquireSignalHandle: settlementOptions.acquireSignalHandle,
          observationIntervalMs: settlementOptions.observationIntervalMs
        });
  const failurePromise = tracker ? Promise.race([outputBudget.failure, tracker.failure]) : outputBudget.failure;
  try {
    if (launch.launchError) {
      const primary = new Error(`[r-contract] ERROR ${phase.label}: ${launch.launchError.message}`, {
        cause: launch.launchError
      });
      try {
        await launch.terminate();
        await requireWindowsSettlement(
          launch,
          observer,
          settlementOptions.windowsSettlementMs ?? WINDOWS_JOB_SETTLEMENT_MS
        );
      } catch (cleanup) {
        throw combinePhaseAndCleanupFailure(primary, cleanup);
      }
      throw primary;
    }
    const deadline = await phaseDeadlineResult(observer.promise, phase.timeoutMs, terminationSignal, failurePromise);
    const elapsed = Math.max(0, now() - started);
    if (deadline.kind !== "exit") {
      const interruptedSignal = deadline.kind === "signal" ? deadline.signal : undefined;
      const primary =
        deadline.kind === "timeout"
          ? new Error(
              `[r-contract] TIMEOUT ${phase.label} after ${formattedSeconds(elapsed)}; phase limit ${formattedSeconds(phase.timeoutMs)}.`
            )
          : deadline.kind === "signal"
            ? new Error(`[r-contract] INTERRUPTED ${phase.label} by ${interruptedSignal}.`)
            : deadline.error;
      if (interruptedSignal !== undefined) primary.stopAfterPhase = true;
      try {
        if (platform === "win32") {
          await launch.terminate();
          await requireWindowsSettlement(
            launch,
            observer,
            settlementOptions.windowsSettlementMs ?? WINDOWS_JOB_SETTLEMENT_MS
          );
        } else {
          await settlePosixProcessTree(launch.child, observer, tracker, {
            ...settlementOptions,
            ...(interruptedSignal === undefined ? {} : { firstSignal: interruptedSignal })
          });
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
    if (platform === "win32" && launch.controlError()) {
      primary ??= new Error(`[r-contract] ERROR ${phase.label}: ${launch.controlError().message}`, {
        cause: launch.controlError()
      });
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
      } else if (!tracker.isSettled(observer)) {
        primary ??= new Error(`[r-contract] ERROR ${phase.label}: the phase exited with live descendants.`);
        await settlePosixProcessTree(launch.child, observer, tracker, settlementOptions);
      }
    } catch (cleanup) {
      throw combinePhaseAndCleanupFailure(
        primary ?? new Error(`[r-contract] ERROR ${phase.label}: process-tree settlement failed.`),
        cleanup
      );
    }
    if (primary) throw primary;
    writeLine(`[r-contract] PASS ${phase.label} in ${formattedSeconds(elapsed)}`);
  } finally {
    tracker?.stop();
  }
}

export async function runRContractPhases(
  phases,
  { runPhase = runRContractPhase, writeLine = (line) => process.stdout.write(`${line}\n`), ...phaseOptions } = {}
) {
  const failures = [];
  for (const phase of phases) {
    if (phaseOptions.terminationSignal?.aborted) {
      const interrupted = new Error(
        `[r-contract] INTERRUPTED before ${phase.id} by ${phaseOptions.terminationSignal.reason}.`
      );
      failures.push(interrupted);
      throw new AggregateError(
        failures,
        `[r-contract] stopped before ${phase.id} because the runner received an external termination signal.`
      );
    }
    try {
      await runPhase(phase, { ...phaseOptions, writeLine });
    } catch (error) {
      const normalized = error instanceof Error ? error : new Error(String(error));
      failures.push(normalized);
      writeLine(`[r-contract] RECORDED ${phase.id}: ${normalized.message}`);
      if (normalized.processTreeUnsettled === true || normalized.stopAfterPhase === true) {
        throw new AggregateError(
          failures,
          normalized.processTreeUnsettled === true
            ? `[r-contract] stopped after ${phase.id} because its process tree was not verified settled.`
            : `[r-contract] stopped after ${phase.id} because the runner received an external termination signal.`
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

export async function runRContractPhasesWithSignalForwarding(phases, options = {}) {
  const termination = new AbortController();
  const handlers = new Map(
    ["SIGINT", "SIGTERM"].map((signal) => [
      signal,
      () => {
        if (!termination.signal.aborted) termination.abort(signal);
      }
    ])
  );
  for (const [signal, handler] of handlers) process.on(signal, handler);
  try {
    await runRContractPhases(phases, { ...options, terminationSignal: termination.signal });
  } finally {
    for (const [signal, handler] of handlers) process.removeListener(signal, handler);
  }
}

async function main() {
  const selection = parseRContractSelection(process.argv.slice(2));
  const rscript = resolveExecutable(process.env.RSCRIPT ?? "Rscript");
  const r = resolveExecutable(process.env.R ?? "R");
  const phases = createRContractPhases({ environment: process.env, r, rscript });
  const selected = selectRContractPhases(phases, selection);
  const ordered = orderRContractPhases(selected, selection.seed);
  if (selection.seed !== undefined) {
    process.stdout.write(`[r-contract] ORDER seed ${selection.seed}: ${ordered.map(({ id }) => id).join(", ")}\n`);
  }
  await runRContractPhasesWithSignalForwarding(ordered);
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
