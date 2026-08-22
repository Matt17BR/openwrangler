import { execFile, spawn, type ChildProcess } from "node:child_process";
import * as path from "node:path";
import { performance } from "node:perf_hooks";

export const PYTHON_PROBE_MAX_OUTPUT_BYTES = 64 * 1024;
export const PYTHON_PROBE_MAX_TIMEOUT_MS = 30_000;
export const PYTHON_PROBE_TREE_SETTLEMENT_MS = 5_000;

export type PythonProbeProcessFailureCode = "ENOBUFS" | "EPROBE" | "EREADINESS" | "ETIMEDOUT" | "ETREE";

export class PythonProbeProcessError extends Error {
  public constructor(readonly code: PythonProbeProcessFailureCode) {
    super(code);
    this.name = "PythonProbeProcessError";
  }
}

export interface PythonProbeReadiness {
  readonly marker: string;
  readonly timeoutMs: number;
}

export interface PythonProbeTerminationRequest {
  readonly child: ChildProcess;
  readonly close: Promise<void>;
  readonly platform: NodeJS.Platform;
  readonly settlementTimeoutMs: number;
}

export type PythonProbeTreeTerminator = (request: PythonProbeTerminationRequest) => Promise<void>;

export interface RunOwnedPythonProbeOptions {
  readonly executable: string;
  readonly source: string;
  readonly timeoutMs: number;
  readonly readiness?: PythonProbeReadiness;
  readonly platform?: NodeJS.Platform;
  readonly spawnProcess?: typeof spawn;
  readonly terminateTree?: PythonProbeTreeTerminator;
}

export interface PythonProbeSpawnContract {
  readonly detached: boolean;
  readonly stdio: ["ignore", "pipe", "pipe"];
  readonly windowsHide: true;
}

export interface WindowsPythonProbeTreeKillCommand {
  readonly executable: string;
  readonly args: ["/PID", string, "/T", "/F"];
}

interface ProcessClose {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
}

interface TimerEvent {
  readonly promise: Promise<void>;
  readonly cancel: () => void;
}

export async function runOwnedPythonProbe(options: RunOwnedPythonProbeOptions): Promise<string> {
  validatePositiveBound(options.timeoutMs, PYTHON_PROBE_MAX_TIMEOUT_MS, "Python probe timeout");
  if (options.readiness) {
    validateReadiness(options.readiness);
  }

  const platform = options.platform ?? process.platform;
  const spawnProcess = options.spawnProcess ?? spawn;
  const terminateTree = options.terminateTree ?? terminateOwnedPythonProbeTree;
  let child: ChildProcess;
  try {
    child = spawnProcess(options.executable, ["-I", "-c", options.source], pythonProbeSpawnContract(platform));
  } catch {
    throw new PythonProbeProcessError("EPROBE");
  }

  const spawned = deferred<void>();
  const closed = deferred<ProcessClose>();
  const failed = deferred<void>();
  const overflowed = deferred<void>();
  const ready = deferred<void>();
  const stdout: Buffer[] = [];
  let stdoutBytes = 0;
  let stderrBytes = 0;
  let readinessOffset = 0;
  let readinessInvalid = false;
  const readinessBytes = options.readiness ? Buffer.from(options.readiness.marker, "utf8") : undefined;

  const onStdout = (value: unknown): void => {
    const chunk = bufferChunk(value);
    if (!chunk || stdoutBytes > PYTHON_PROBE_MAX_OUTPUT_BYTES - chunk.byteLength) {
      overflowed.resolve();
      return;
    }
    stdoutBytes += chunk.byteLength;
    stdout.push(chunk);
  };
  const onStderr = (value: unknown): void => {
    const chunk = bufferChunk(value);
    if (!chunk || stderrBytes > PYTHON_PROBE_MAX_OUTPUT_BYTES - chunk.byteLength) {
      overflowed.resolve();
      return;
    }
    stderrBytes += chunk.byteLength;
    if (!readinessBytes || readinessOffset === readinessBytes.byteLength || readinessInvalid) return;
    for (const byte of chunk) {
      if (readinessOffset === readinessBytes.byteLength) break;
      if (byte !== readinessBytes[readinessOffset]) {
        readinessInvalid = true;
        failed.resolve();
        return;
      }
      readinessOffset += 1;
      if (readinessOffset === readinessBytes.byteLength) ready.resolve();
    }
  };
  const onStreamError = (): void => failed.resolve();

  child.once("spawn", () => spawned.resolve());
  child.once("error", () => failed.resolve());
  child.once("close", (code, signal) => {
    closed.resolve({ code, signal });
  });
  child.stdout?.on("data", onStdout);
  child.stdout?.once("error", onStreamError);
  child.stderr?.on("data", onStderr);
  child.stderr?.once("error", onStreamError);

  const closeCompletion = closed.promise.then(() => undefined);
  const timers = new Set<TimerEvent>();
  const failure = async (code: PythonProbeProcessFailureCode): Promise<never> => {
    cancelTimers(timers);
    try {
      await terminateTree({
        child,
        close: closeCompletion,
        platform,
        settlementTimeoutMs: PYTHON_PROBE_TREE_SETTLEMENT_MS
      });
    } catch {
      throw new PythonProbeProcessError("ETREE");
    }
    throw new PythonProbeProcessError(code);
  };

  try {
    const spawnOutcome = await Promise.race([
      spawned.promise.then(() => "spawned" as const),
      failed.promise.then(() => "failed" as const),
      closed.promise.then(() => "closed" as const)
    ]);
    if (spawnOutcome !== "spawned" || child.pid === undefined || !child.stdout || !child.stderr) {
      return await failure("EPROBE");
    }

    if (options.readiness) {
      const readinessTimer = timerEvent(options.readiness.timeoutMs);
      timers.add(readinessTimer);
      const readinessOutcome = await Promise.race([
        ready.promise.then(() => "ready" as const),
        readinessTimer.promise.then(() => "timeout" as const),
        overflowed.promise.then(() => "overflow" as const),
        failed.promise.then(() => "failed" as const),
        closed.promise.then(() => "closed" as const)
      ]);
      readinessTimer.cancel();
      timers.delete(readinessTimer);
      if (readinessOutcome === "overflow") return await failure("ENOBUFS");
      if (readinessOutcome !== "ready" || readinessInvalid) return await failure("EREADINESS");
    }

    const executionTimer = timerEvent(options.timeoutMs);
    timers.add(executionTimer);
    const outcome = await Promise.race([
      closed.promise.then((value) => ({ kind: "closed" as const, value })),
      executionTimer.promise.then(() => ({ kind: "timeout" as const })),
      overflowed.promise.then(() => ({ kind: "overflow" as const })),
      failed.promise.then(() => ({ kind: "failed" as const }))
    ]);
    executionTimer.cancel();
    timers.delete(executionTimer);

    if (outcome.kind === "timeout") return await failure("ETIMEDOUT");
    if (outcome.kind === "overflow") return await failure("ENOBUFS");
    if (outcome.kind === "failed") return await failure("EPROBE");
    if (outcome.value.code !== 0 || outcome.value.signal !== null) {
      return await failure("EPROBE");
    }
    return Buffer.concat(stdout, stdoutBytes).toString("utf8");
  } finally {
    cancelTimers(timers);
    child.stdout?.removeListener("data", onStdout);
    child.stdout?.removeListener("error", onStreamError);
    child.stderr?.removeListener("data", onStderr);
    child.stderr?.removeListener("error", onStreamError);
  }
}

export async function terminateOwnedPythonProbeTree(request: PythonProbeTerminationRequest): Promise<void> {
  const pid = request.child.pid;
  if (pid === undefined || !Number.isSafeInteger(pid) || pid <= 0) {
    throw new Error("Python probe process identity is unavailable.");
  }
  const deadline = performance.now() + request.settlementTimeoutMs;
  if (request.platform === "win32") {
    const command = windowsPythonProbeTreeKillCommand(process.env.SystemRoot, pid);
    await runTaskkill(command, request.settlementTimeoutMs);
    await requireSettlement(request.close, () => processExists(pid), deadline);
    return;
  }

  try {
    process.kill(-pid, "SIGKILL");
  } catch (error) {
    if (!isNoSuchProcess(error)) throw error;
  }
  await requireSettlement(request.close, () => processGroupExists(pid), deadline);
}

export function pythonProbeSpawnContract(platform: NodeJS.Platform): PythonProbeSpawnContract {
  return {
    detached: platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true
  };
}

export function windowsPythonProbeTreeKillCommand(
  systemRoot: string | undefined,
  pid: number
): WindowsPythonProbeTreeKillCommand {
  if (!systemRoot || !path.win32.isAbsolute(systemRoot) || !Number.isSafeInteger(pid) || pid <= 0) {
    throw new Error("Windows Python probe process identity is unavailable.");
  }
  return {
    executable: path.win32.join(systemRoot, "System32", "taskkill.exe"),
    args: ["/PID", String(pid), "/T", "/F"]
  };
}

function validateReadiness(readiness: PythonProbeReadiness): void {
  validatePositiveBound(readiness.timeoutMs, PYTHON_PROBE_MAX_TIMEOUT_MS, "Python probe readiness timeout");
  if (!/^[\x20-\x7e]{1,255}\n$/u.test(readiness.marker)) {
    throw new Error("Python probe readiness needs one bounded ASCII line.");
  }
}

function validatePositiveBound(value: number, maximum: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
    throw new Error(`${label} must be a positive safe integer no larger than ${maximum}.`);
  }
}

function bufferChunk(value: unknown): Buffer | undefined {
  if (Buffer.isBuffer(value)) return value;
  if (typeof value === "string") return Buffer.from(value, "utf8");
  return undefined;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

function timerEvent(timeoutMs: number): TimerEvent {
  let timer: NodeJS.Timeout | undefined;
  const promise = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, timeoutMs);
  });
  return {
    promise,
    cancel: () => {
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
    }
  };
}

function cancelTimers(timers: Set<TimerEvent>): void {
  for (const timer of timers) timer.cancel();
  timers.clear();
}

async function requireSettlement(close: Promise<void>, remains: () => boolean, deadline: number): Promise<void> {
  const closeRemaining = deadline - performance.now();
  if (closeRemaining <= 0 || !(await settlesWithin(close, closeRemaining))) {
    throw new Error("Python probe leader settlement is uncertain.");
  }
  while (remains()) {
    const remaining = deadline - performance.now();
    if (remaining <= 0) throw new Error("Python probe process tree settlement is uncertain.");
    await delay(Math.min(10, remaining));
  }
}

function settlesWithin(value: Promise<void>, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    void value.then(() => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

function processGroupExists(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    if (isNoSuchProcess(error)) return false;
    throw error;
  }
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (isNoSuchProcess(error)) return false;
    throw error;
  }
}

function isNoSuchProcess(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ESRCH";
}

function delay(timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, timeoutMs);
  });
}

function runTaskkill(command: WindowsPythonProbeTreeKillCommand, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(
      command.executable,
      command.args,
      {
        encoding: "utf8",
        maxBuffer: PYTHON_PROBE_MAX_OUTPUT_BYTES,
        timeout: timeoutMs,
        windowsHide: true
      },
      (error) => {
        if (error) reject(new Error("Windows Python probe tree termination failed."));
        else resolve();
      }
    );
  });
}
