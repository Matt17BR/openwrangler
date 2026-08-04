import { spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { chmodSync, lstatSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { tmpdir } from "node:os";
import { stopChildProcessGracefully } from "../processShutdown";

export const TRUSTED_PICKLE_CONVERSION_TIMEOUT_MS = 5 * 60_000;
export const TRUSTED_PICKLE_OUTPUT_LIMIT_BYTES = 64 * 1024;
export const TRUSTED_PICKLE_TREE_GRACE_MS = 500;
export const TRUSTED_PICKLE_TREE_CONFIRMATION_MS = 2_000;
const TRUSTED_PICKLE_TREE_POLL_MS = 25;

export class TrustedPickleConversionCancelledError extends Error {
  constructor() {
    super("Pickle conversion was cancelled.");
    this.name = "TrustedPickleConversionCancelledError";
  }
}

export class TrustedPickleConversionTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Pickle conversion did not finish within ${timeoutMs} ms.`);
    this.name = "TrustedPickleConversionTimeoutError";
  }
}

export class TrustedPickleWorkerLifecycle {
  private readonly active = new Map<Promise<void>, AbortController>();
  private shutdownPromise: Promise<void> | undefined;

  run(options: TrustedPickleWorkerOptions): Promise<void> {
    if (this.shutdownPromise) return Promise.reject(new TrustedPickleConversionCancelledError());
    const controller = new AbortController();
    const onAbort = (): void => controller.abort();
    if (options.signal?.aborted) controller.abort();
    else options.signal?.addEventListener("abort", onAbort, { once: true });
    const task = runTrustedPickleWorker({ ...options, signal: controller.signal });
    this.active.set(task, controller);
    void task.then(
      () => this.finish(task, options.signal, onAbort),
      () => this.finish(task, options.signal, onAbort)
    );
    return task;
  }

  shutdown(): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise;
    const tasks = [...this.active.keys()];
    for (const controller of this.active.values()) controller.abort();
    this.shutdownPromise = Promise.allSettled(tasks).then((results) => {
      const failures = results.flatMap((result) => {
        if (result.status === "fulfilled" || result.reason instanceof TrustedPickleConversionCancelledError) return [];
        return [result.reason];
      });
      if (failures.length === 1) throw failures[0];
      if (failures.length > 1) {
        throw new AggregateError(failures, "Open Wrangler could not stop all active pickle converters.");
      }
    });
    return this.shutdownPromise;
  }

  dispose(): void {
    void this.shutdown().catch(() => undefined);
  }

  private finish(task: Promise<void>, signal: AbortSignal | undefined, onAbort: () => void): void {
    this.active.delete(task);
    signal?.removeEventListener("abort", onAbort);
  }
}

export interface TrustedPickleWorkerOptions {
  readonly executable: string;
  readonly helperPath: string;
  readonly sourcePath: string;
  readonly destinationPath: string;
  readonly sourceFingerprint: TrustedPickleSourceFingerprint;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  readonly outputLimitBytes?: number;
  readonly spawnProcess?: typeof spawn;
  readonly createWorkingDirectory?: () => TrustedPickleWorkingDirectory;
  readonly platform?: NodeJS.Platform;
  readonly killProcess?: typeof process.kill;
  readonly treeGraceMs?: number;
  readonly treeConfirmationMs?: number;
}

export interface TrustedPickleSourceFingerprint {
  readonly dev: bigint;
  readonly ino: bigint;
  readonly size: bigint;
  readonly mtimeNs: bigint;
  readonly ctimeNs: bigint;
}

export interface TrustedPickleWorkingDirectory {
  readonly path: string;
  cleanup(): Error | undefined;
}

export async function runTrustedPickleWorker(options: TrustedPickleWorkerOptions): Promise<void> {
  assertAbsolutePath(options.executable, "Python executable");
  assertAbsolutePath(options.helperPath, "Pickle converter helper");
  assertAbsolutePath(options.sourcePath, "Pickle source");
  assertAbsolutePath(options.destinationPath, "Parquet destination");
  const fingerprintArguments = fingerprintArgs(options.sourceFingerprint);
  if (options.sourcePath.includes("\0") || options.destinationPath.includes("\0")) {
    throw new Error("Pickle conversion paths cannot contain NUL bytes.");
  }
  if (options.signal?.aborted) throw new TrustedPickleConversionCancelledError();

  const timeoutMs = options.timeoutMs ?? TRUSTED_PICKLE_CONVERSION_TIMEOUT_MS;
  const outputLimitBytes = options.outputLimitBytes ?? TRUSTED_PICKLE_OUTPUT_LIMIT_BYTES;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0)
    throw new Error("Pickle conversion needs a positive timeout.");
  if (!Number.isSafeInteger(outputLimitBytes) || outputLimitBytes <= 0) {
    throw new Error("Pickle conversion needs a positive output limit.");
  }

  const workingDirectory = (options.createWorkingDirectory ?? createTrustedPickleWorkingDirectory)();
  let failure: Error | undefined;
  try {
    await runOwnedWorker(options, workingDirectory.path, timeoutMs, outputLimitBytes, fingerprintArguments);
  } catch (error) {
    if (error instanceof TrustedPickleProcessTreeUnconfirmedError) throw error;
    failure = asError(error);
  }
  const cleanupError = workingDirectory.cleanup();
  if (failure && cleanupError) {
    throw new AggregateError(
      [failure, cleanupError],
      "Pickle conversion failed and its private working directory could not be cleaned up."
    );
  }
  if (failure) throw failure;
  if (cleanupError) throw cleanupError;
}

async function runOwnedWorker(
  options: TrustedPickleWorkerOptions,
  cwd: string,
  timeoutMs: number,
  outputLimitBytes: number,
  fingerprintArguments: readonly string[]
): Promise<void> {
  const platform = options.platform ?? process.platform;
  const spawnProcess = options.spawnProcess ?? spawn;
  const proc = spawnProcess(
    options.executable,
    ["-I", "-B", "-S", options.helperPath, options.sourcePath, options.destinationPath, ...fingerprintArguments],
    {
      cwd,
      env: trustedPickleWorkerEnvironment(cwd, process.env, platform),
      detached: platform !== "win32",
      shell: false,
      windowsHide: true
    }
  ) as ChildProcessWithoutNullStreams;
  let requestedFailure: Error | undefined;
  let outputBytes = 0;
  let treeStop: Promise<void> | undefined;
  let settleRequestedStop: (() => void) | undefined;
  const requestedStop = new Promise<void>((resolve) => {
    settleRequestedStop = resolve;
  });
  const stop = (reason: Error): void => {
    requestedFailure ??= reason;
    if (!treeStop) {
      treeStop = terminateOwnedProcessTree(proc, {
        platform,
        killProcess: options.killProcess ?? process.kill,
        graceMs: options.treeGraceMs ?? TRUSTED_PICKLE_TREE_GRACE_MS,
        confirmationMs: options.treeConfirmationMs ?? TRUSTED_PICKLE_TREE_CONFIRMATION_MS
      });
      void treeStop.then(settleRequestedStop, settleRequestedStop);
    }
  };
  const countOutput = (chunk: Buffer | string): void => {
    outputBytes += Buffer.isBuffer(chunk) ? chunk.byteLength : Buffer.byteLength(chunk);
    if (outputBytes > outputLimitBytes) {
      stop(new Error("The pickle converter exceeded its fixed diagnostic output limit."));
    }
  };
  proc.stdout.on("data", countOutput);
  proc.stderr.on("data", countOutput);
  const onAbort = (): void => stop(new TrustedPickleConversionCancelledError());
  options.signal?.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => stop(new TrustedPickleConversionTimeoutError(timeoutMs)), timeoutMs);
  timer.unref();

  type Completion =
    | { readonly kind: "close"; readonly code: number | null; readonly signal: NodeJS.Signals | null }
    | { readonly kind: "error"; readonly error: Error };
  let completion: Completion | undefined;
  let onError: ((error: Error) => void) | undefined;
  let onClose: ((code: number | null, signal: NodeJS.Signals | null) => void) | undefined;
  try {
    const mainCompletion = new Promise<Completion>((resolve) => {
      let settled = false;
      const finish = (result: Completion): void => {
        if (settled) return;
        settled = true;
        resolve(result);
      };
      onError = (error) => finish({ kind: "error", error });
      onClose = (code, signal) => finish({ kind: "close", code, signal });
      proc.once("error", onError);
      proc.once("close", onClose);
    });
    const first = await Promise.race([
      mainCompletion.then((result) => ({ kind: "completion" as const, result })),
      requestedStop.then(() => ({ kind: "stopped" as const }))
    ]);
    if (first.kind === "completion") {
      completion = first.result;
      treeStop ??=
        completion.kind === "error" && (!Number.isSafeInteger(proc.pid) || !proc.pid || proc.pid <= 0)
          ? Promise.resolve()
          : terminateOwnedProcessTree(proc, {
              platform,
              killProcess: options.killProcess ?? process.kill,
              graceMs: options.treeGraceMs ?? TRUSTED_PICKLE_TREE_GRACE_MS,
              confirmationMs: options.treeConfirmationMs ?? TRUSTED_PICKLE_TREE_CONFIRMATION_MS
            });
    }
    try {
      await treeStop;
    } catch (error) {
      throw new TrustedPickleProcessTreeUnconfirmedError(requestedFailure, asError(error));
    }
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", onAbort);
    proc.stdout.removeListener("data", countOutput);
    proc.stderr.removeListener("data", countOutput);
    if (onError) proc.removeListener("error", onError);
    if (onClose) proc.removeListener("close", onClose);
  }

  if (requestedFailure) throw requestedFailure;
  if (!completion || completion.kind === "error") {
    throw new Error("Open Wrangler could not start the trusted pickle converter.");
  }
  if (completion.code !== 0) {
    if (completion.code === 3) throw new Error("This pickle does not contain a Pandas DataFrame.");
    if (completion.code === 4) throw new Error("Open Wrangler could not convert this pickle to Parquet.");
    const exitDetail = completion.signal ? `signal ${completion.signal}` : `exit code ${completion.code ?? "unknown"}`;
    throw new Error(`The trusted pickle converter failed with ${exitDetail}.`);
  }
}

export class TrustedPickleProcessTreeUnconfirmedError extends Error {
  constructor(primary: Error | undefined, treeError: Error) {
    super(
      primary
        ? "Pickle conversion failed and Open Wrangler could not confirm that its process tree stopped."
        : "Open Wrangler could not confirm that the pickle-conversion process tree stopped.",
      { cause: primary ? new AggregateError([primary, treeError]) : treeError }
    );
    this.name = "TrustedPickleProcessTreeUnconfirmedError";
  }
}

interface TreeTerminationOptions {
  readonly platform: NodeJS.Platform;
  readonly killProcess: typeof process.kill;
  readonly graceMs: number;
  readonly confirmationMs: number;
}

async function terminateOwnedProcessTree(
  proc: ChildProcessWithoutNullStreams,
  options: TreeTerminationOptions
): Promise<void> {
  if (options.platform === "win32") {
    if (proc.exitCode !== null || proc.signalCode !== null) return;
    await stopChildProcessGracefully(proc, 0, options.confirmationMs);
    return;
  }
  const pid = proc.pid;
  if (!Number.isSafeInteger(pid) || !pid || pid <= 0) {
    if (proc.exitCode !== null || proc.signalCode !== null) return;
    throw new Error("The pickle converter did not expose an owned POSIX process group.");
  }
  if (!processGroupExists(pid, options.killProcess)) return;
  signalProcessGroup(pid, "SIGTERM", options.killProcess);
  if (await waitForProcessGroupExit(pid, options.graceMs, options.killProcess)) return;
  signalProcessGroup(pid, "SIGKILL", options.killProcess);
  if (await waitForProcessGroupExit(pid, options.confirmationMs, options.killProcess)) return;
  throw new Error("The pickle-conversion POSIX process group survived forced termination.");
}

function signalProcessGroup(pid: number, signal: NodeJS.Signals, killProcess: typeof process.kill): void {
  try {
    killProcess(-pid, signal);
  } catch (error) {
    if (!isNoSuchProcess(error)) throw error;
  }
}

function processGroupExists(pid: number, killProcess: typeof process.kill): boolean {
  try {
    killProcess(-pid, 0);
    return true;
  } catch (error) {
    if (isNoSuchProcess(error)) return false;
    return true;
  }
}

async function waitForProcessGroupExit(
  pid: number,
  timeoutMs: number,
  killProcess: typeof process.kill
): Promise<boolean> {
  const deadline = Date.now() + Math.max(0, timeoutMs);
  while (processGroupExists(pid, killProcess)) {
    if (Date.now() >= deadline) return false;
    await delay(Math.min(TRUSTED_PICKLE_TREE_POLL_MS, Math.max(1, deadline - Date.now())));
  }
  return true;
}

function delay(timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, timeoutMs);
    timer.unref();
  });
}

function isNoSuchProcess(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ESRCH";
}

export function trustedPickleWorkerEnvironment(
  cwd: string,
  source: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform
): NodeJS.ProcessEnv {
  const allowed =
    platform === "win32"
      ? new Set([
          "COMSPEC",
          "LANG",
          "LC_ALL",
          "LC_CTYPE",
          "NUMBER_OF_PROCESSORS",
          "PATH",
          "PATHEXT",
          "SYSTEMROOT",
          "TZ",
          "WINDIR"
        ])
      : new Set(["LANG", "LC_ALL", "LC_CTYPE", "PATH", "TZ"]);
  const environment: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined && allowed.has(platform === "win32" ? key.toLocaleUpperCase("en-US") : key)) {
      environment[key] = value;
    }
  }
  environment.HOME = cwd;
  environment.TMPDIR = cwd;
  environment.TEMP = cwd;
  environment.TMP = cwd;
  return environment;
}

function createTrustedPickleWorkingDirectory(): TrustedPickleWorkingDirectory {
  const path = mkdtempSync(join(tmpdir(), "openwrangler-pickle-"));
  try {
    chmodSync(path, 0o700);
  } catch (error) {
    try {
      rmSync(path, { recursive: true, force: false });
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        "Open Wrangler could not secure or clean its private pickle-conversion directory."
      );
    }
    throw error;
  }
  const details = lstatSync(path, { bigint: true });
  const canonicalPath = realpathSync(path);
  let cleaned = false;
  return {
    path,
    cleanup: () => {
      if (cleaned) return undefined;
      cleaned = true;
      try {
        const current = lstatSync(path, { bigint: true });
        if (
          current.isSymbolicLink() ||
          !current.isDirectory() ||
          current.dev !== details.dev ||
          current.ino !== details.ino ||
          realpathSync(path) !== canonicalPath
        ) {
          throw new Error("Open Wrangler's private pickle-conversion directory changed identity.");
        }
        rmSync(path, { recursive: true, force: false, maxRetries: 2, retryDelay: 25 });
        return undefined;
      } catch (error) {
        return asError(error);
      }
    }
  };
}

function fingerprintArgs(fingerprint: TrustedPickleSourceFingerprint): string[] {
  return [fingerprint.dev, fingerprint.ino, fingerprint.size, fingerprint.mtimeNs, fingerprint.ctimeNs].map((value) =>
    value.toString(10)
  );
}

function assertAbsolutePath(value: string, label: string): void {
  if (!isAbsolute(value) || value.includes("\0")) throw new Error(`${label} must be an absolute path.`);
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
